#!/usr/bin/env node
//
// What the indexer has done, in words, and what the site shows because of it.
//
//   node /var/www/balast/deploy/indexer-status.mjs
//   bash /var/www/balast/deploy/data-source.sh status     # the same
//
// For whoever is deciding whether the site should show real numbers yet. It
// reads two things the box already has — the API's /api/health and the
// indexer's own progress lines — and needs nothing installed beyond node.
//
// The pace is measured, not assumed: two progress lines some minutes apart
// give how fast the indexer is gaining on head. Head moves too (~10 blocks a
// second on this chain), so the rate is the gain over head, and a pace that is
// not gaining says so rather than printing an ETA that never arrives.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001';
/**
 * Where PM2 writes the indexer's output. The ecosystem file names the first;
 * a process started before that line existed keeps PM2's own default, and on
 * the live box the first did not exist at all — the report said "no progress
 * lines" while the indexer was moving 5,000 blocks a second. The freshest
 * non-empty candidate wins.
 */
/** Where PM2 itself says the indexer's output goes, if PM2 will say. */
function pm2LogPath() {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const run = asRoot
    ? spawnSync('runuser', ['-u', 'balast', '--', 'pm2', 'jlist'], { encoding: 'utf8', timeout: 10_000 })
    : spawnSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10_000 });
  try {
    const list = JSON.parse(run.stdout || '[]');
    const indexer = list.find((p) => p.name === 'balast-indexer');
    return indexer?.pm2_env?.pm_out_log_path ?? null;
  } catch {
    return null;
  }
}

const LOG_CANDIDATES = [
  process.env.INDEXER_LOG,
  pm2LogPath(),
  '/var/log/balast/indexer.out.log',
  '/home/balast/.pm2/logs/balast-indexer-out.log',
  '/root/.pm2/logs/balast-indexer-out.log',
].filter(Boolean);
const LOG =
  LOG_CANDIDATES.map((p) => {
    try {
      const st = statSync(p);
      return st.size > 0 ? { p, t: st.mtimeMs } : null;
    } catch {
      return null;
    }
  })
    .filter(Boolean)
    .sort((a, b) => b.t - a.t)[0]?.p ?? LOG_CANDIDATES[0];
/** Read only the tail: the log rotates at 20 MB and the last lines are what matter. */
const TAIL_BYTES = 512 * 1024;
/** Measure the pace over about this much wall time. */
const PACE_WINDOW_MS = 15 * 60 * 1000;

const PROGRESS = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) blocks (\d+)-(\d+) of (\d+) \(([\d.]+)%/;

/** 42 seconds / 15 minutes / 3 hours / 41 days. */
export function span(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} seconds`;
  if (s < 90 * 60) return `${Math.round(s / 60)} minutes`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
}

const n = (v) => Number(v).toLocaleString('en-US');

function tail(path) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

/** Progress lines, oldest first: { at, to, head, pct }. */
export function progressLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = PROGRESS.exec(line);
    if (m) out.push({ at: Date.parse(m[1]), to: Number(m[3]), head: Number(m[4]), pct: Number(m[5]) });
  }
  return out;
}

/**
 * Blocks a second gained on head, and seconds left at that pace — or null
 * when there is not enough history to measure, or the pace is not gaining.
 */
export function pace(lines) {
  if (lines.length < 2) return null;
  const last = lines[lines.length - 1];
  const first = lines.find((l) => last.at - l.at <= PACE_WINDOW_MS) ?? lines[0];
  const seconds = (last.at - first.at) / 1000;
  if (seconds < 30) return null;
  const gained = last.to - first.to - (last.head - first.head);
  const rate = gained / seconds;
  const behind = last.head - last.to;
  return { rate, etaSeconds: rate > 0 ? behind / rate : null };
}

/**
 * True when the indexer is running but not moving: several progress lines in
 * the last ten minutes, all at the same block. This is what a range retried
 * forever looks like — the shape the indexer sat in for a day at block
 * 4,408,335 while PM2 showed it online and this report said "not measurable".
 */
export function stuck(lines, now = Date.now()) {
  const recent = lines.filter((l) => now - l.at <= 10 * 60 * 1000);
  return recent.length >= 3 && recent.every((l) => l.to === recent[0].to);
}

/** The last line the indexer wrote about something going wrong. */
export function lastTrouble(text) {
  const hits = text.split('\n').filter((l) => /pass failed|endpoint refused|stalled/i.test(l));
  return hits.length ? hits[hits.length - 1].trim().slice(0, 220) : null;
}

async function health() {
  try {
    const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(8000) });
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The pace without a log: read the cursor twice, fifteen seconds apart. Head
 * moves about ten blocks a second, so the gain over head is what counts.
 */
async function measured(first) {
  await new Promise((r) => setTimeout(r, 15_000));
  const second = await health();
  if (!second?.indexed || !first?.indexed) return false;
  const moved = Number(second.indexed.lastBlock) - Number(first.indexed.lastBlock);
  if (!(moved > 0)) return false;
  // Chain time recovered per second of wall time: the lag shrinking.
  const gained = (first.indexed.lagSeconds ?? 0) + 15 - (second.indexed.lagSeconds ?? 0);
  const eta = gained > 15 ? ` — about ${span((second.indexed.lagSeconds * 15) / (gained - 15))} to reach today at this rate` : '';
  console.log(`  pace       ${n(Math.round(moved / 15))} blocks a second (measured over 15s)${eta}`);
  return true;
}

const usd = (v) =>
  v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B`
  : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;

/**
 * The deepest pools the site is showing, and what they add up to. A TVL in
 * the trillions was on the live site for hours with nothing on the box to say
 * which pool made it; this names it, with the address to look up.
 */
export function deepest(snapshot, count = 3) {
  const pools = Array.isArray(snapshot?.pools) ? snapshot.pools : [];
  const total = pools.reduce((a, p) => a + (Number(p.tvlUsd) || 0), 0);
  const top = [...pools]
    .filter((p) => Number(p.tvlUsd) > 0)
    .sort((a, b) => Number(b.tvlUsd) - Number(a.tvlUsd))
    .slice(0, count);
  return { total, count: pools.length, top };
}

async function depthReport() {
  try {
    const response = await fetch(`${API}/api/snapshot`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return;
    const { total, count, top } = deepest(await response.json());
    if (!count) return;
    console.log(`  TVL        ${usd(total)} across ${n(count)} pools shown`);
    for (const p of top) {
      const share = total > 0 ? ` (${((p.tvlUsd / total) * 100).toFixed(0)}%)` : '';
      console.log(`             ${usd(p.tvlUsd)}${share}  ${p.token?.symbol ?? '?'}/${p.quote}  ${p.address}`);
    }
  } catch {
    // A report, not a check: a slow snapshot is reported elsewhere.
  }
}

async function main() {
  const h = await health();
  const text = tail(LOG);
  const lines = progressLines(text);
  const last = lines[lines.length - 1] ?? null;
  const p = pace(lines);

  console.log('Indexer');
  if (!h) {
    console.log(`  the API is not answering at ${API}`);
    console.log('  check:  runuser -u balast -- pm2 status');
    process.exitCode = 1;
    return;
  }
  if (h.status === 'misconfigured') {
    console.log(`  misconfigured: ${h.message}`);
    process.exitCode = 1;
    return;
  }
  if (last) {
    console.log(`  read       ${last.pct.toFixed(2)}% of the chain (block ${n(last.to)} of ${n(last.head)})`);
  } else if (h.indexed) {
    console.log(`  read       up to block ${n(h.indexed.lastBlock)}`);
  }
  console.log(
    h.indexed
      ? `  behind     ${span(h.indexed.lagSeconds)} of chain time`
      : '  behind     has not written a block yet',
  );
  console.log(`  found      ${n(h.pools)} pools, ${n(h.swaps)} swaps`);
  console.log(
    h.usdg
      ? `  USD price  anchored to USDG ${h.usdg}`
      : '  USD price  not anchored yet: dollar figures read $0 until the WETH/USDG pool is found',
  );
  const trouble = lastTrouble(text);
  if (stuck(lines) || h.status === 'stalled') {
    console.log(`  pace       STUCK at block ${n(last?.to ?? h.indexed?.lastBlock ?? 0)}: running, but not moving forward`);
    if (h.message) console.log(`             ${h.message}`);
    if (trouble) console.log(`  last error ${trouble}`);
    console.log('  see:       runuser -u balast -- pm2 logs balast-indexer --lines 40 --nostream');
    process.exitCode = 1;
  } else if (h.indexed && h.indexed.lagSeconds < 120) {
    console.log('  pace       caught up, following the chain');
  } else if (p && p.etaSeconds !== null) {
    console.log(`  pace       catching up, about ${span(p.etaSeconds)} to go at the current rate`);
  } else if (p) {
    console.log('  pace       NOT gaining on the chain — see: runuser -u balast -- pm2 logs balast-indexer');
  } else if (lines.length === 0 && h.indexed && h.indexed.lagSeconds > 3600 && (await measured(h))) {
    // Printed by measured(): the pace from two readings of the indexer's own
    // cursor, which needs no log at all.
  } else if (lines.length === 0 && h.indexed && h.indexed.lagSeconds > 3600) {
    // Behind, and not one progress line in the log: the indexer is not
    // reporting passes at all. Not "not measurable yet" — that is what this
    // printed for a day while nothing moved.
    console.log(`  pace       no progress lines in ${LOG} — the indexer may be hung`);
    if (trouble) console.log(`  last error ${trouble}`);
    // Show what IS there: a report that says "no lines" without the lines
    // sends whoever reads it to run another command to find out why.
    const recentLines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-6);
    if (recentLines.length) {
      console.log('  log tail');
      for (const l of recentLines) console.log(`             ${l.slice(0, 200)}`);
    } else {
      console.log(`  log tail   (the file is empty or missing)`);
    }
    console.log('  see:       runuser -u balast -- pm2 logs balast-indexer --lines 40 --nostream');
  } else {
    console.log('  pace       not measurable yet (needs a few minutes of progress lines)');
  }

  await depthReport();

  console.log('');
  console.log('With DATA_SOURCE=live the site shows');
  if (!h.indexed) {
    console.log('  "Waiting for the indexer", until it writes its first block.');
  } else if (h.pools === 0) {
    console.log('  "No pools indexed yet" on the boards, until the indexer reaches the first pool.');
  } else if (h.indexed.lagSeconds > 3600) {
    console.log(`  real pools, marked "Indexer ${span(h.indexed.lagSeconds)} behind" in the top bar until it catches up.`);
  } else {
    console.log('  real pools, current.');
  }
  console.log('  Stakes, Portfolio and Router stay empty until the contracts ship: there is no vault to stake into yet.');
}

// Run when executed, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) await main();
