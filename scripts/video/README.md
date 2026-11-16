# The "Tidewell is live" video

`brand/video/tidewell-is-live.mp4`: 66 seconds, 1920×1080, 30 fps, H.264 with AAC
audio, made for X. An intro, then the four steps of adding liquidity (connect,
stake, earn, claim and withdraw), then an outro with the audit disclaimer.

Every UI frame in it is a crop of a real screenshot of the live build, driving
the real deployed contracts on a **fork** of Robinhood Chain mainnet. Nothing is
sent to mainnet. The fees come from simulated trading through the real ETH / USDG
0.05% pool: about one week of that pool's real volume ($17.4M), so the fees a
1 ETH stake earns in the video match the vault's real trailing rate. The outro
and the step 3 caption both say the trading is simulated.

## Rebuilding it

The pieces, in order. Paths are relative to this directory.

1. **A fork at head**, with anvil (`@foundry-rs/anvil` from npm works):

   ```bash
   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545 --auto-impersonate --no-rate-limit
   ```

   Restart it if the recording fails with "historical state … is not available":
   the public RPC is pruned, so a fork's starting block ages out after a while.

2. **A snapshot and the stand-in API.** Save `https://tidewell.live/api/snapshot`
   to a file, then serve it (vault figures stay as read; the wallet's history is
   read from the fork):

   ```bash
   node video-api.mjs snapshot.json <fork block>
   ```

3. **The live build pointed at it**, from the repository root:

   ```bash
   DATA_SOURCE=live NEXT_PUBLIC_API_BASE=http://127.0.0.1:3901 npx next build
   ```

   ```bash
   API_INTERNAL_URL=http://127.0.0.1:3901 npx next start -p 3300
   ```

4. **Fund a fresh wallet and record.** Use a fresh address: anvil's default
   account 0 is EIP-7702-delegated to a sweeper on this chain (CLAUDE.md §20).

   ```bash
   node fund.mjs 0x7e57000000000000000000000000000000f1de03
   ```

   ```bash
   node capture.cjs rec 0x7e57000000000000000000000000000000f1de03
   ```

   `capture.cjs` stakes 1 ETH through the page, runs `trade.mjs` three times
   (about 0.6, 1.8 and 4.6 days of the pool's volume), reads the page after
   each, then claims and withdraws everything from the portfolio. It writes
   2× full-page screenshots and `rec/manifest.json` with the boxes of
   everything the camera and cursor point at, and the wallet's balances at
   each step.

5. **Cut, render, score, mux:**

   ```bash
   python3 cut.py rec comp
   ```

   ```bash
   node render.cjs video video-only.mp4 30
   ```

   ```bash
   python3 audio.py music.wav
   ```

   ```bash
   ffmpeg -i video-only.mp4 -i music.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart ../../brand/video/tidewell-is-live.mp4
   ```

   `cut.py` also copies the site's fonts from `.next/static/media` (so run a
   build first) and the Signature mark. `node render.cjs stills <dir> 3.6 26.5`
   renders single frames for checking.

## What the composition does

`comp/index.html` holds the whole timeline as one `render(t)` function: the
same `t` always draws the same frame, so the renderer can step through it at
any frame rate. UI pieces are real crops, padded with the page's own ground
colour. The cursor, highlights, captions, the traded-volume counter and the
"+$0.12" gains are drawn over them. The gains are the differences between
the Fees earned figures the page printed, and the withdrawal figures come
from the page's own activity list.

The WETH badge's logo is CoinGecko's, which the build sandbox could not
reach, so `harness.cjs` answers that one image with `eth-logo.png`, a plain
ETH diamond. The soundtrack is synthesised by `audio.py`: nothing licensed,
nothing sampled.
