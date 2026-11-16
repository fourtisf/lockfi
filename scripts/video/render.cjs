// Render the composition frame by frame and encode it.
//   node render.cjs video <out.mp4> [fps]       every frame, piped into ffmpeg
//   node render.cjs stills <dir> t1 t2 ...       PNG stills at those seconds
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const COMP = path.join(__dirname, 'comp');
const PORT = Number(process.env.PORT ?? 8777);
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };

const server = http.createServer((req, res) => {
  const p = path.join(COMP, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!p.startsWith(COMP) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.waitForFunction(() => window.READY || window.FAILED, null, { timeout: 60_000 });
  const failed = await page.evaluate(() => window.FAILED);
  if (failed) throw new Error(failed);
  const stage = page.locator('#stage');
  const mode = process.argv[2];

  if (mode === 'stills') {
    const dir = process.argv[3];
    fs.mkdirSync(dir, { recursive: true });
    for (const t of process.argv.slice(4).map(Number)) {
      await page.evaluate((x) => window.render(x), t);
      await stage.screenshot({ path: path.join(dir, `t${String(t.toFixed(1)).padStart(5, '0')}.png`) });
    }
  } else {
    const out = process.argv[3];
    const fps = Number(process.argv[4] ?? 30);
    const total = await page.evaluate(() => window.TOTAL);
    const frames = Math.round(total * fps);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-maxrate', '14M', '-bufsize', '28M', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-r', String(fps), '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const started = Date.now();
    for (let i = 0; i < frames; i++) {
      await page.evaluate((x) => window.render(x), i / fps);
      const buf = await stage.screenshot({ type: 'jpeg', quality: 96 });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % 150 === 0) console.log(`frame ${i}/${frames}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
    console.log(`encoded ${frames} frames to ${out} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  server.close();
})().catch((e) => { console.error('RENDER ERROR', e); process.exit(1); });
