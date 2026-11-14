# Tidewell

Liquidity layer for Robinhood Chain (chainId 4663). Users deposit into a token
pool and collect a proportional share of swap fees, paid in WETH.

Formerly **Balast**; renamed in CLAUDE.md §19. The infrastructure keeps its
old identifiers on purpose — the PM2 processes, `/var/www/balast`, the database
role and the `balast_test` test database are names a running deploy depends
on, not branding.

`CLAUDE.md` is the engineering handoff and the source of truth. `design/depth.html`
is the approved design prototype. Where the two disagree, `CLAUDE.md` wins.

**This repository contains P0 and P1: the shell, and the indexer that replaces
its simulated data with real chain data.** No contracts, no keeper, no wallet
connector — those are P2 and P3. See *Build phases* in `CLAUDE.md` §8.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000, simulated data
npm run build && npm start
```

Three processes in production, and P1 adds the last two:

| Process | What it is |
|---|---|
| `npm start` | the Next.js front end |
| `npm run api` | Fastify: `/api/snapshot` and the `/api/stream` websocket |
| `npm run indexer` | the log poller |

## Run it against the real chain

```bash
cp .env.example .env
# Set DATABASE_URL, and USDG_ADDRESS — the indexer refuses to start without it.
# Each server entry point reads .env itself (server/load-env.ts): Node does
# not read one, and neither does PM2, so nothing else would.
npm run db:migrate
npm run indexer      # in one terminal
npm run api          # in another
DATA_SOURCE=live npm run dev
```

Nothing has to be looked up by hand. The USD anchor — the WETH/USDG pool that
prices everything (§4.3) — is **discovered**: the indexer already reads every
token's symbol off-chain while finding pools, so it looks for the one called
USDG trading against WETH. `/api/health` reports which token it chose and why.

Set `USDG_ADDRESS` only to override that, for instance to pin one token when
two claim the symbol. A malformed value is refused rather than quietly
discovered past — pricing the site off the wrong token cannot be detected from
anywhere downstream.

## Check it

```bash
npm run typecheck
npm run lint
npm test             # unit + the §9 acceptance criterion (needs Postgres)
npm run test:e2e     # browser — flash, FLIP, focus trap, overflow, the §7 rules
```

`npm test` covers the honest-numbers rules (`lib/yield.ts`), the bin weights
(`lib/shapes.ts` — they must sum to exactly 10,000 or `TidewellShaper` reverts),
`SimProvider`'s determinism, the tick and price maths, and P1's whole pipeline.

### Running the P1 tests

The P1 suite drives a real Postgres through the real SQL, because §9's
criterion is about what the database actually contains. Point it at a
throwaway database:

```bash
export TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5433/balast_test?schema=public"
npm test
```

The name must contain `balast_test` or the suite refuses to start — it
truncates every table on each run. CI brings up a `postgres:16` service for
this; skipping it would leave the one test that proves the indexer replays
deterministically running only on whichever laptop happened to have a
database.

`npm run test:e2e` builds the app, starts it and drives Chromium. It asserts
the things a unit test cannot see: values flashing on change, rows animating to
a new rank, the drawer trapping focus and restoring it on Escape, no horizontal
overflow at 360 / 760 / 1180 / 1600px, and that the word "APY" appears nowhere.

## What P0 ships

Five pages against a simulated data source, with the prototype's live behaviour:

| Route | What it is |
|---|---|
| `/pools` | Featured pool, most-traded and highest-yield cards, two live boards (Trending by volume, Established by fee yield), live fee payouts |
| `/stakes` | Vault grid with trailing-7d fee yield, staked total, fees 24h, stakers, next harvest; your stakes with the 7-day stream |
| `/positions` | The shape builder: token, deposit, shape, range, bin count, live bin chart |
| `/router` | Token-team surface: fee source, trigger mode, destination, timeline, depth projection |
| `/portfolio` | Net value, fees earned, price impact on holdings, daily fee heatmap, position list |

Ported interactions: value flash on change (green up, red down, ~1.1s), FLIP row
reordering on rank change, leader row highlight, `Stake` revealed on row hover,
the bin chart responding to shape / range / bin count, and the responsive column
drops from §5.

## Data

Every component reads through the `DataProvider` interface in
`lib/data/types.ts`. Nothing imports data directly, so P1 is one file.

```
DATA_SOURCE=sim   # lib/data/sim-provider.ts, the prototype's generated market
DATA_SOURCE=live  # lib/data/live-provider.ts, the indexer through the API
```

`SimProvider` is deterministic on its first snapshot (seeded PRNG, ages stored as
hours rather than derived from the clock) so the server and the browser render
the same first paint. It ticks the market every 3.2s and the payout feed every
2.6s, exactly as the prototype does. One tick stands in for an hour of chain time.

Derived figures — fee yield above all — are never computed in a component. In
`sim` they are computed in the provider; in `live` they arrive settled from SQL
(§4.2). Both go through the same classification in `lib/yield.ts`, and there is
a test asserting the SQL and that function agree, so the boards and the
simulator cannot drift apart.

`LiveProvider` will hold nothing rather than something invented. If the API is
down or the indexer has not written a block, the snapshot stays null and the UI
says *waiting for the indexer* — it never falls back to simulated numbers.

That page also asks `/api/health` and shows **why**. "Waiting for the indexer"
on its own is true and useless; the answer is usually a configuration value
that has not been set, and the page names it.

### What the indexer does

```
PoolManager v4 + v3 pools  --Initialize, Swap, ModifyLiquidity/Mint/Burn-->
  swap_events, liquidity_events     raw rows, keyed (tx_hash, log_index)
    -> weth_usd_hourly              the one USD anchor (WETH/USDG)
    -> pool_flow_hourly             signed token flow, which gives reserves
    -> pool_fee_hourly              fees and volume per pool per hour
    -> pool_state                   latest price, reserves, TVL
```

Every table is **rebuilt by aggregation, never incremented**. That is the whole
reason §9's criterion is reachable: an increment is order-dependent and
double-counts on replay, so re-scanning the last 32 blocks every pass (§4.1)
would corrupt the totals. Re-aggregating rows keyed by their log coordinates
gives the same answer however many times the same logs arrive.

Each pass rebuilds only the hours its block range touched, but rebuilds them
from every row in those hours — so the result is identical to a full rebuild,
which is exactly what the test compares.

**Market cap is fully diluted value, and says so.** `totalSupply()` is an
on-chain read, so the figure is available — but total supply includes locked,
vested and treasury-held tokens, and none of that is distinguishable on chain.
That makes it FDV, not market cap, and presenting FDV as market cap overstates
every token with a vesting schedule. So the figure is marked `fdv`, and a
token that will not report a supply shows an em dash rather than a guess.

**A pool with neither WETH nor USDG on one side** cannot be priced through the
one allowed path, so it is not listed at all rather than listed at zero.

**v3 pools are discovered through the factory.** v4 announces every pool on
one PoolManager; v3 announces it on the factory and then emits from the pool's
own address. Set `V3_FACTORY` or v3 pools are only the ones hand-listed in
`V3_POOLS` — and §4 says some older pools on this chain are v3, so a
hand-list omits real pools. A newly discovered v3 pool is backfilled from its
own creation block, because its first mint is its entire starting liquidity and
the 32-block re-scan cannot reach back far enough to find it.

## Rules the code enforces

These are product rules, not preferences (§1, §7). They live in
`lib/yield.ts` and are applied by the provider:

- Fee yield is **trailing 7 days**, labelled `fee yield, trailing 7d`. Never
  "APY", never "APR", never a forward or subsidised figure.
- A pool with fewer than 24h of data shows `—`, not a number.
- A pool younger than 7 days is labelled `est.` and carries its age.
- Pre-graduation launchpad liquidity is listed but not stakeable.
- Out-of-range positions say, in the row, in red, that they earn nothing.
- The 10% protocol fee is disclosed in the stake drawer, before signing.
- Indexer lag is shown in the top bar whenever the indexer is behind head.
- The trailing window ends at the **last block indexed**, not at wall-clock
  now. Using wall clock would count an hour the indexer had not reached as zero
  fees and quietly deflate every yield on the board; instead the window is
  honest and the lag is reported next to it.
- A pool whose derived depth is unknown — reserves that sum negative, because
  `START_BLOCK` was above its creation block and we never saw its funding mint
  — shows no yield figure at all, rather than a number divided by a divisor we
  know is wrong.
- A derived price outside a sane bound leaves the pool **unpriced**, not
  clamped. A clamp would render as a real TVL of ten quintillion dollars.
- A market cap derived from `totalSupply()` is **fully diluted value** and is
  labelled `fdv`. Calling FDV market cap overstates every token with a vesting
  schedule, always in the flattering direction.
- Token logos may come from an external list; numbers never may (§4). The
  logo fetcher reads `logoURI` and nothing else — not price, not supply, and
  not decimals, which are an input to every price and stay an on-chain read.
- Every token has a **mark** whether or not it has a logo: a disc whose hue is
  derived from its own address, carrying the ticker's first two characters.
  Deterministic, so a token never looks like a different token after a reload,
  and the ink is picked per hue because yellow at this lightness is far
  brighter than blue at the same lightness. Measured at 4.26:1 across the
  whole wheel, with a test that re-derives it.

### Giving tokens real logos

Robinhood Chain has no public token list, so `TOKEN_LIST_URL` accepts a local
path and `config/tokens.json` ships with the repository:

```json
{ "tokens": [
  { "chainId": 4663, "address": "0x...", "logoURI": "https://.../weth.png" }
] }
```

Add entries, and the indexer picks them up on its next pass. A token that is
not listed keeps its derived mark. Switching to a public list when one exists
is one line in `.env`.

## Deploy

```bash
# first time, as root, on a box whose DNS already points here
bash deploy/bootstrap.sh

# every time after: deploys the branch the box is on
bash /var/www/balast/deploy/deploy.sh

# deploy a different branch from now on
DEPLOY_BRANCH=<branch> bash /var/www/balast/deploy/deploy.sh

# when something is wrong and you want one answer rather than a stack trace
bash /var/www/balast/deploy/doctor.sh
```

**Moving the box to tidewell.live** — the DNS A record must point at it first.
`switch-domain.sh` checks that, obtains the certificate over HTTP beside the
running site, and only then installs the TLS config (and puts the old one back
if nginx rejects it). `deploy.sh` never installs an nginx config whose
certificate is missing.

```bash
bash /var/www/balast/deploy/switch-domain.sh
```

**Moving a box that still has the old `deploy.sh`** (which hardcoded
`claude/new-session-c0aptv`) onto another branch takes one manual checkout,
after which the new script takes over:

```bash
cd /var/www/balast
runuser -u balast -- git fetch origin <branch>
runuser -u balast -- git checkout -B <branch> origin/<branch>
bash deploy/deploy.sh
```

`doctor.sh` checks code, configuration, database, migrations, the three PM2
processes, the API's own health, nginx, the certificate and disk — in
dependency order — and ends with **one** next command. The order matters: a
missing `DATABASE_URL` makes every layer below it look broken too, so it names
the first real failure rather than the loudest one. It is read-only.

`deploy.sh` pulls and then `exec`s the pulled copy of itself. That is not
ceremony: bash reads a script by byte offset, so a `git checkout` that rewrites
the file mid-run leaves execution continuing at the same offset into a
different file. It ran a spliced mixture of two versions once, and the symptom
was a migration step failing on a bug that had already been fixed.

`bootstrap.sh` installs Node, Postgres, Redis and nginx, creates the role and
database, writes `/var/www/balast/.env` with a generated database password,
runs the migrations, starts the three PM2 processes and obtains the
certificate. It is safe to re-run: it skips what exists and never regenerates
the password or overwrites `.env`.

It will finish with `USDG_ADDRESS` still blank and tell you so. Set it, then
`pm2 restart balast-indexer --update-env`.

The pieces:

| File | What it is |
|---|---|
| `ecosystem.config.js` | PM2: `balast-web`, `balast-api`, `balast-indexer` |
| `deploy/nginx.conf` | TLS, security headers, `/api/` (never cached), `/api/stream` (websocket, 1h timeout), immutable `/_next/static` |
| `deploy/nginx-bootstrap.conf` | HTTP-only first pass, so certbot has something to answer with |
| `deploy/upgrade-map.conf` | the `$connection_upgrade` map — only install it if nothing else on the box defines one |
| `.nvmrc` | Node version, also used by CI |

Two things that bit us on a shared box, recorded so they don't again. Do not
remove `/etc/nginx/sites-enabled/default` and do not leave a **dangling**
symlink there: the include is a wildcard, so a missing file is fine but a
broken link fails `nginx -t` and blocks reloads for every site on the machine.
And check for an existing `$connection_upgrade` before installing the map — a
duplicate `map` fails the same test.

Watching it work:

```bash
pm2 logs balast-indexer
curl -s localhost:3001/api/health
```

`/api/health` **returns 503 when the indexer is stalled or has never started**,
so any uptime check that watches a status code catches it with no extra
plumbing. `status` is the field to read: `ok`, `stalled`, or `never-indexed`.

`deploy/monitor.sh` runs from cron every five minutes and checks the same
thing plus whether the PM2 processes are online. It alerts on a *change* of
state, so a stalled indexer sends one message rather than one every five
minutes for two days. Point it at a person by putting `ALERT_CMD` in
`/etc/default/balast`:

```bash
echo 'ALERT_CMD="curl -sS -X POST -d @- https://your-webhook"' >> /etc/default/balast
```

This exists because §8's P3 criterion names the failure exactly — "a keeper
that dies silently is a vault paying zero while displaying a yield" — and it
applies to the indexer a phase early. The lag figure in the top bar is for
someone who is looking at the page; this is for the hours when nobody is.

`deploy/backup.sh` dumps the database nightly to `/var/backups/balast`, keeping
14 days. §9's determinism means the database can be rebuilt from the chain, but
that is a full re-sync from `START_BLOCK` — hours of climbing lag. The dumps are
**local only**: they protect against a bad migration, not against losing the
box. Getting them off the machine needs credentials, so `BACKUP_SYNC_CMD` is
left for whoever has them.

### Before the first sync

```bash
npm run find:tokens     # what does this chain actually trade?
npm run verify:chain    # are the §2 addresses right?
```

Neither needs a database — deliberately, since the whole point is to check the
chain before the database matters.

`find:tokens` scans the PoolManager's `Initialize` events, reads each token's
symbol and decimals off its own contract, and ranks them by how many pools
reference them. It finds `USDG_ADDRESS` for you, confirms WETH appears where
expected, and reports the earliest `Initialize` it saw as a lower bound for
`START_BLOCK`. If two tokens both call themselves USDG it lists both rather
than choosing: the wrong anchor makes every USD figure on the site wrong in a
way nothing downstream can detect.

Set what it finds without opening an editor:

```bash
./deploy/set-env.sh USDG_ADDRESS 0x...
./deploy/set-env.sh START_BLOCK 4821337
./deploy/set-env.sh                      # show current values, secrets masked
runuser -u balast -- pm2 restart balast-indexer balast-api --update-env
```

It replaces the line or appends it, validates anything ending `_ADDRESS`, and
leaves the rest of the file byte-identical — including the generated database
password, which a substitution over a secrets file can silently mangle.

All seven addresses in §2 are marked unverified in `lib/chain.ts`. This checks
each one holds code, that the PoolManager has actually emitted the v4 events we
subscribe to (decoded, not just counted), and that WETH and USDG answer as
ERC20s with the decimals the price maths assumes.

Run it. If `poolManager` is wrong the indexer starts cleanly, subscribes to an
address that emits nothing, and reports a lag that climbs forever — a
working-looking site with an empty table and no error anywhere.

The domain is **tidewell.live**, set in `lib/site.ts` and `deploy/nginx.conf`.
`www` 301s to the apex so there is one canonical host, and the old
**balast.xyz** 301s to the same path on the new domain, so links already shared
keep working.

**Open gap:** `ballast.xyz` — the English spelling on the same TLD — is
registered and parked for sale by a third party. For a front-end that asks
people to connect a wallet, an unowned confusable is a phishing domain someone
else controls. `ballast.fi` and `balast.fi` are both still free; registering
them and 301'ing to the apex closes most of it. `deploy/nginx.conf` has the
redirect stanza ready, commented out.

## Design

All tokens live in `app/globals.css`. No component hardcodes a colour. The
brand teal means identity and action; green means a positive number and
nothing else; red means a negative number and nothing else (§19). Token logo
colours arrive as token metadata, which is data rather than a palette decision.
Brand assets are generated: `npm run brand` (see `brand/README.md`).

`prefers-reduced-motion` disables the flash and the FLIP transform. It does not
disable the data updates.

## Layout

```
app/                  routes + globals.css (the whole design system)
                      error.tsx / loading.tsx / not-found.tsx
components/
  providers/          MarketProvider (DataProvider → React), UiProvider
  shell/              top bar + market strip, tab bar, stake drawer, footer
  pools/ stakes/ positions/ router/ portfolio/
  ui/                 badges, sparklines, flashing cell, toast
hooks/                useFlip, useFlash, useReducedMotion
lib/
  chain.ts            chainId 4663 and the §2 addresses (all unverified)
  data/               types.ts (the interface), sim-provider, live-provider, seed
  yield.ts            the honest-numbers rules
  shapes.ts           spot / curve / bid-ask weight generators
  format.ts rng.ts
  *.test.ts           unit tests, run by `npm test`
server/               P1 — nothing here is imported by a component
  env.ts db.ts        config read once, one Prisma client per process
  chain/              abi, viem client with failover, price and tick maths
  indexer/            events, ingest (pure), aggregate (SQL), poller,
                      discovery, logos (the only file that leaves the chain)
  api/                Fastify server, the snapshot query, the tick bus
  scripts/            verify-chain.ts — run before the first sync
  test/               the deterministic fixture chain and db helpers
prisma/schema.prisma  the §4 schema, plus the raw-row tables §9 needs
e2e/                  browser tests, run by `npm run test:e2e`
deploy/               bootstrap.sh, deploy.sh, monitor.sh, backup.sh, nginx
design/depth.html     the approved prototype
```

## Where the implementation made a call

`CLAUDE.md` §12 records P0's deviations from the prototype, the compressed
simulator clock (and why it needs sign-off), the §10 assumptions that were
implemented, and the one open product question on `/positions`. §14 records
P1's: what the indexer cannot know, what it refuses to guess, and what it
needs from ALFA before it can index the real chain.
