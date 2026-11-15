# Tidewell (formerly Balast) — engineering handoff

> **Renamed.** The product is **Tidewell** (§19). Sections written before the
> rename say *Balast*; read it as Tidewell. §19 also supersedes §5's palette
> and type, and §18 where they differ.

Liquidity layer for Robinhood Chain. Users deposit into a token pool and collect a
proportional share of swap fees, paid in WETH. Two products: **Stakes** (passive,
one-token deposit, fees streamed over 7 days) and **Positions** (active, shaped
concentrated liquidity minted straight to the user's wallet). A third surface,
**Router**, lets token teams convert creator fees into permanent pool depth.

`depth.html` is the approved design prototype and the source of truth for layout,
copy, colour and interaction. Port its logic; do not redesign it. Where this doc
and the prototype disagree, this doc wins.

Read this file in full before writing any code. Build P0 only, then stop and report.

---

## 1. What is not negotiable

**Balast never takes custody.** Position NFTs are minted to the user's wallet.
Staked positions sit in a vault contract that only the depositing wallet can
withdraw from. There is no admin withdraw path, no pause that traps funds, no
upgradeable proxy on the vault.

**Rewards come from real swap fees only.** No token emissions, ever. If volume
slows, displayed yield slows with it. Never display a projected or subsidised APR.

**Fee yield is the headline metric, not volume.** Volume is trivially washed; fee
yield is what an LP actually earns. Every ranking defaults to fee yield.

**Displayed yield is trailing, never forward.** Label it `fee yield, trailing 7d`
everywhere. Never write "APY", never annualise a single day.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 14 App Router, TypeScript | matches existing Fourtis projects |
| API | Fastify | same |
| DB | PostgreSQL + Prisma | same |
| Cache / streams | Redis | pending-harvest buffer, websocket fan-out |
| Indexer | viem + own log poller | Robinhood Chain has ~100ms blocks; see §4 |
| Contracts | Foundry, Solidity 0.8.26 | v4 hooks tooling is Foundry-first |
| Deploy | Hostinger VPS, PM2, Nginx | same as the rest of the stack |

Chain: **Robinhood Chain, chainId 4663**, EVM L2 (Arbitrum Orbit), native gas ETH.
Sequencer is first-come-first-served with ~100ms blocks, so **use timestamps, not
block numbers, for transaction deadlines**.

Known addresses to seed config (verify each on the explorer before mainnet):

```
WETH (aeWETH proxy)  0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
UniversalRouter      0x8876789976dEcBfCbBbe364623C63652db8C0904
PoolManager (v4)     0x8366a39CC670B4001A1121B8F6A443A643e40951
V4Quoter             0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94
StateView            0xF3334192D15450CdD385c8B70e03f9A6bD9E673b
Permit2              0x000000000022D473030F116dDEE9F6B43aC78BA3
Multicall3           0xcA11bde05977b3631167028862bE2a173976CA11
```

Day-one stablecoin on this chain is **USDG**, not USDC. There is no Aave deployment.

---

## 3. Contracts

Four contracts. Keep them small and separately auditable.

### 3.1 `BalastZap`

Single-token entry. Takes ETH or one side of a pair, swaps the correct fraction,
mints the position, returns dust.

```
function zapMint(
  PoolKey  calldata key,
  int24    tickLower,
  int24    tickUpper,
  uint256  amountIn,
  address  tokenIn,
  uint256  minLiquidity,
  uint256  deadline
) external payable returns (uint256 tokenId);
```

- Swap fraction is computed off-chain and passed in; the contract enforces
  `minLiquidity` so a bad quote reverts rather than executing badly.
- Deadline is a **timestamp**.
- Dust below one wei-equivalent of gas is left in the contract; anything above is
  returned to the caller. Never silently keep dust.

### 3.2 `BalastShaper`

Builds a shaped position across N bins in one transaction. Uniswap v4 has ticks,
not bins, so a "bin" is one tick-range sub-position with its own weight.

```
struct Bin { int24 lower; int24 upper; uint128 weightBps; }
function mintShaped(PoolKey calldata key, Bin[] calldata bins, ...) external payable;
```

- `sum(weightBps) == 10_000` enforced on-chain.
- Max 60 bins per transaction — past that, gas and calldata make it worse than two
  transactions. Reject with a clear revert, do not silently truncate.
- Three shapes in the UI (spot / curve / bid-ask) are **weight generators in the
  frontend**, not contract modes. Keep the contract shape-agnostic so new shapes
  ship without a contract change.

### 3.3 `BalastVault`

One vault per pool. Holds staked LP, harvests fees, streams rewards.

Reward accounting is the Synthetix `StakingRewards` pattern, not a claim-on-demand
pool. The 7-day drip is what stops a wallet from depositing right before a harvest,
claiming, and leaving.

```
rewardRate        = pendingWeth / 7 days
rewardPerToken   += (now - lastUpdate) * rewardRate * 1e18 / totalSupply
earned(account)   = balance * (rewardPerToken - userPaid) / 1e18 + rewards[account]
```

- `notifyReward(uint256 amount)` extends the stream: leftover from the current
  window is folded into the new rate. Standard Synthetix `notifyRewardAmount` logic.
- `withdraw()` is always available, no lockup, no exit fee, no timelock.
- Protocol fee is taken **at harvest, from fees earned** — never from principal:

```
protocolFeeBps = 1000   // 10% of harvested fees
max allowed    = 2000   // hard cap in the constructor, cannot be raised
```

  The cap is constructor-immutable. A governance setter that can raise it to 100%
  is the single most common rug in this product category; do not ship one.

### 3.4 `BalastRouter`

For token teams: converts an accruing fee stream into pool liquidity.

- Trigger modes: `CADENCE` (every N seconds) or `MILESTONE` (at market-cap steps,
  each fires once, in ascending order).
- Pricing uses a **30-minute TWAP**, not spot, or the keeper call is a free sandwich.
- Slippage guard on every route; revert rather than route at a bad price.
- Keeper only *triggers*. Funds never leave the contract to the keeper. The keeper
  address is rotatable; the destination pool is not.
- `pause()` stops future routes and lets the owner withdraw **unrouted** fees only.
  Already-routed liquidity is not recoverable by anyone — say so in the UI.

### 3.5 Invariants for the test suite

- Vault: `sum(balances) == totalSupply`, always.
- Vault: a user who never claims and withdraws at time T receives exactly the same
  WETH as a user who claimed every hour. (Drip must not leak.)
- Vault: `protocolFeeBps` can never exceed the constructor cap.
- Vault: withdraw path works when `rewardRate == 0` and when the reward token
  balance is zero.
- Shaper: `sum(weightBps) != 10_000` reverts.
- Shaper: a 60-bin mint fits under the block gas limit.
- Zap: a quote that degrades between build and execution reverts, never partially
  fills.
- Router: a milestone fires at most once; milestones out of order revert at config
  time, not at route time.
- Router: routing at spot price when TWAP deviates more than the guard reverts.

---

## 4. Indexer

All pool data comes from on-chain events. No third-party price API in the critical
path — logos and token metadata may come from external sources, numbers may not.

**Sources**
- `PoolManager` v4: `Initialize`, `Swap`, `ModifyLiquidity`.
- v3 `UniswapV3Pool`: `Swap`, `Mint`, `Burn` — some older pools on this chain are v3.
- Launchpad hooks (Pons, Bags, Bottom.fun) emit their own swap events *before*
  graduation. Pre-graduation liquidity is not stakeable; index it for the listing
  but mark `stakeable: false`.

**Pipeline**
1. Poller reads logs in ranges, writes raw rows, tracks `last_indexed_block` per
   contract. Reorg depth on an Orbit L2 is shallow but non-zero: re-scan the last
   32 blocks each pass and upsert by `(txHash, logIndex)`.
2. Fee attribution per pool per hour into `pool_fee_hourly`. Fee yield is
   `fees_7d / tvl_now * 365/7 * 100` — compute it in SQL, never in the component.
3. Prices: derive from pool reserves and `sqrtPriceX96`, anchored to WETH, then to
   USD via the WETH/USDG pool. One anchor, one path, no averaging across venues.
4. Websocket pushes deltas to the client. The prototype's 3.2s tick is simulating
   this; in production, push on actual events and debounce to ~1s per pool.

**Schema sketch**

```
pools(id, address, chain_id, token0, token1, fee_tier, tick_spacing,
      hooks, protocol, created_block, stakeable)
tokens(address, symbol, name, decimals, logo_url, launchpad, first_seen)
pool_fee_hourly(pool_id, hour, fees_token0, fees_token1, fees_usd, volume_usd, swaps)
pool_state(pool_id, tvl_usd, price_usd, mc_usd, updated_at)     -- latest snapshot
vaults(pool_id, address, total_staked, reward_rate, period_finish, stakers)
stakes(wallet, vault_id, shares, claimed_weth, updated_at)
positions(token_id, wallet, pool_id, tick_lower, tick_upper, liquidity, shape, status)
router_configs(token, fee_source, mode, cadence_s, milestones_json, paused)
router_routes(config_id, tx_hash, weth_in, liquidity_added, twap_price, routed_at)
```

Rule: components read from a `DataProvider` interface. P0 ships a `SimProvider`
reproducing the prototype's generated data; P1 swaps in the live one. No component
imports data directly, so the swap is one file.

---

## 5. Design system

Take these from `depth.html` into `globals.css` as custom properties. Never
hardcode a colour in a component.

```css
--bg:      #050807;   /* page */
--panel:   #080D0B;   /* cards, table surface */
--panel-2: #0B120F;   /* row hover */
--raise:   #0E1714;   /* inset tracks, segmented control active */

--bd:      rgba(61,214,140,.12);   /* green-tinted border, pills and inputs */
--bd-2:    rgba(61,214,140,.26);   /* focus, active outline */
--bd-n:    rgba(255,255,255,.06);  /* neutral hairline, table rows and cards */

--fg:   #E6F2EC;  --fg-2: #8FA79B;  --fg-3: #5E7268;  --fg-4: #3D4D45;

--ac:     #3DD68C;  /* the one accent */
--ac-2:   #6FE8AC;
--ac-dim: rgba(61,214,140,.10);
--red:    #E5484D;  /* negative change only */
```

**Colour rule.** Green is the only accent and it means one of three things: brand,
a positive number, or an active control. Red means exactly one thing: a negative
number. Nothing else is coloured. Earlier iterations of this design failed because
colour was sprayed across the whole surface.

**Type.** JetBrains Mono throughout, Inter as the fallback stack only.
- Column headers, field labels, eyebrows: `10px / 600 / letter-spacing .16em / uppercase`
- Numbers: `font-variant-numeric: tabular-nums`, always
- Row values: 13px / 500. Token ticker: 14px / 700.
- Big figures (vault APR, stat cards): 24–38px / 700

**Components.** Card radius 14px, control radius 8–10px, pills 99px. Row hover is a
background lift to `--panel-2` plus a 2px green bar on the left edge. Transitions
150ms for hover, 450ms `cubic-bezier(.2,.7,.3,1)` for row reordering.

**Layout.** Fixed 232px labelled sidebar collapsing to a 64px icon rail below
1180px. Sticky top bar, 69px, holds search + the four global stats + wallet.
Columns drop by priority as width shrinks: `Vol 24h` and `Depth` at 1780px, `Age`
at 1560px. A table must never overflow its card.

---

## 6. Pages

### `/pools` — the listing
Featured pool card with 6 metrics and a full-bleed area chart; two smaller cards
(Most traded, Highest fee yield); then two live boards, Trending (sorted by volume)
and Established (sorted by fee yield), each with All / ETH / USDG quote filters.

Live behaviour, all visible in the prototype:
- values update in place, flashing green or red for ~1.1s on change
- rows reorder with a FLIP transform, never a jump
- row 1 carries a leader highlight
- a `Stake` button fades in on row hover and opens the drawer without navigating

### `/stakes`
Vault grid: trailing-7d fee yield as the headline figure, staked total, fees 24h,
staker count, next harvest countdown. Below it, the user's own stakes with a
7-day stream progress bar, claimable amount, and Claim / Compound.

### `/positions`
The shape builder. Left panel: token, deposit amount, shape (spot / curve /
bid-ask), range as ± percent, bin count. Right panel: live bin chart with the
current price marked, plus range, estimated fee yield, split at mint, fee tier.
Mint is one transaction and the NFT goes to the user.

### `/router`
Token-team surface. Fee source, trigger mode, destination range, then a plain
timeline of what will happen and a depth projection. Copy must state that routed
liquidity is permanent.

### `/portfolio`
Net value, fees earned, price impact vs holding, daily fee heatmap, position list
with in-range / out-of-range status and a rebalance prompt.

---

## 7. Honest-numbers rules

These are product rules, not style preferences. Breaking one makes the site
dishonest and it is the fastest way to lose LPs.

- Fee yield on a pool younger than 7 days is labelled `est.` and carries the pool
  age next to it. A 1-day-old pool showing 1200% is arithmetic, not an opportunity.
- Never display a yield figure computed from fewer than 24 hours of data. Show `—`.
- `Price impact on holdings` in the portfolio is the honest name for impermanent
  loss. Show it as a negative number next to fees earned, not buried.
- Out-of-range positions earn nothing. Say exactly that, in the row, in red.
- The protocol fee (10% of fees earned) is disclosed in the stake drawer before the
  user signs, not in a docs page.
- If the indexer is behind, show the lag in the top bar. Never render stale numbers
  as if they were live.

---

## 8. Build phases

**P0 — shell and simulated data.** Next.js scaffold, design tokens, all five pages
rendering against `SimProvider` with the prototype's generated data, including the
live tick, flash and FLIP reorder. Deploy. Nothing below changes a component.

**P1 — indexer.** Log poller, pool and token discovery, fee attribution, price
derivation, websocket. `/pools`, `/stakes`, `/portfolio` read real data. Still no
contracts.

**P2 — contracts on testnet.** `BalastZap`, `BalastShaper`, `BalastVault` with the
full invariant suite. `/positions` mints for real; `/stakes` stakes for real.

**P3 — keeper.** Harvest scheduler, WETH conversion, `notifyReward`. Monitoring and
alerting on missed harvests: a keeper that dies silently is a vault paying zero
while displaying a yield.

**P4 — router.** `BalastRouter` plus the token-team onboarding flow.

**P5 — audit, then mainnet.** No mainnet deployment of the vault before an external
audit. This is the one phase that cannot be compressed.

---

## 9. Acceptance criteria for the hard parts

**P1 is done when** re-running the indexer from block zero on a fresh database
produces byte-identical `pool_fee_hourly` rows to the incremental run, and a forced
32-block reorg replay changes no row count.

**P2 is done when** the vault invariant suite passes under fuzzing with 10k runs,
including: random deposit / withdraw / claim orderings across 50 wallets never
leave the vault unable to pay `sum(earned)`.

**P3 is done when** killing the keeper for 48 hours and restarting it distributes
exactly the fees accrued in that window, with no double-payment and no loss, and
the UI showed the harvest lag the whole time.

---

## 10. Open decisions for ALFA, not for the developer

- **Protocol fee rate.** 10% is in the spec and the prototype. Meteora runs ~10%
  and returns 90% to LPs. Going higher looks fine on a spreadsheet and loses the
  supply side. Confirm before the constructor is deployed, because the cap is
  immutable.
- **Minimum pool age before a pool appears in Established.** 7 days is assumed.
- **Whether Balast seeds its own liquidity in launch pools.** Affects whether the
  displayed TVL is honest as "user liquidity" or needs a separate line.
- **Domain and token.** ~~`Depth` is the working name.~~ ~~**Decided: the product is `Balast`, on `balast.xyz`.**~~ **Decided: the product is `Tidewell`** (§19). The Tidewell domain and the token are still open.

---

## 11. Kickoff prompt for Claude Code

Paste this to start:

> Read `CLAUDE.md` in full before writing any code. Build P0 only, then stop and
> report.
>
> Scaffold a Next.js 14 App Router project in TypeScript for Balast, a liquidity
> platform on Robinhood Chain (chainId 4663). Put the design tokens from §5 into
> `globals.css` and build the five pages from `depth.html`: `/pools`, `/stakes`,
> `/positions`, `/router`, `/portfolio`, plus the fixed labelled sidebar and the
> sticky top bar with global stats.
>
> All data comes from a `DataProvider` interface with a `SimProvider`
> implementation that reproduces the prototype's generated pools, vaults and
> positions, including the 3.2 second market tick. No component may import data
> directly — everything goes through the provider so P1 swaps one file. Read
> `DATA_SOURCE` from env; `live` throws "not implemented" for now.
>
> Port these interactions exactly as they behave in the prototype: value flash on
> change (green up, red down, ~1.1s), FLIP row reordering on rank change, leader
> row highlight, Stake button revealed on row hover opening the drawer, the shape
> builder's live bin chart responding to shape / range / bin count, and the
> responsive column dropping from §5.
>
> Rules: no hardcoded colours, tokens only. Green means brand, positive or active;
> red means negative; nothing else is coloured. Every number uses tabular-nums.
> Yield is labelled trailing 7d and never annualised from one day. Responsive to
> 360px with no horizontal table overflow at any width. Respect
> `prefers-reduced-motion` — that disables the flash and FLIP, it does not disable
> the data updates. Visible keyboard focus on every control, and the drawer traps
> focus and closes on Escape.
>
> When P0 runs and deploys, stop and list what you need from me for P1: RPC
> endpoint, starting block, and the pool addresses you want to index first.

---

## 12. P0 implementation notes

Added by the P0 build. Everything above this line is ALFA's handoff and is
unchanged; this section records where the implementation had to make a call, so
the next phase is not left guessing.

### Deviations from the prototype

The prototype contradicts itself or this document in four places. Per the rule
at the top of this file, this document won.

1. **Yield basis.** `depth.html` computes `fee*365/tvl` — 24h fees annualised,
   which §1 forbids. Implemented as `fees_window / tvl_now * 365/7 * 100`, with
   the window capped at the pool's own age, and the three states from §7
   (`—` under 24h, `est.` plus age under 7d, plain above).
2. **Bin-chart legend.** The prototype's legend and its fill code disagree on
   which side of the price is the token side. The code was taken as correct and
   the legend corrected to match it.
3. **Fee heatmap colour.** The prototype fills the portfolio heatmap with
   `rgba(124,140,255)` — a purple, which breaks the colour rule in §5. It is
   green, and the caption reads "brighter = more" because that is what it draws.
4. **Standalone totals.** The prototype's top-bar TVL ($4.91M) and featured
   fees ($318K) contradict the sum of its own pool rows ($15.1M and $108K).
   Every figure that can be summed from the pools is now summed from them, so
   the header cannot disagree with the table beneath it.

### The simulated clock

`SimProvider` advances **six hours of chain time per 3.2s tick**
(`SIM_HOURS_PER_TICK`). A trailing-7d figure is deliberately slow-moving: with
a real-time clock, measured over four minutes, the boards never reordered once,
so the FLIP reorder that §8 requires in P0 was not observable. Six hours a tick
rolls the window in about ninety seconds of watching. Only the simulated clock
is compressed; the displayed metric and its arithmetic are unchanged.

**This needs ALFA's sign-off**, because it is the one place P0 does not behave
like the approved prototype.

### Decisions taken on §10's assumptions

- **Established shows pools with 7+ days of fees.** §10 lists this as assumed;
  it is implemented and labelled `7d+` in the board header. Consequence: young
  pools appear only in Trending, so the `est.` and `—` states are visible in
  the stake drawer and the vault cards rather than on the boards.
- **Protocol fee is 10%**, with the cap constant at 2000 bps in `lib/chain.ts`.
  Still needs confirming before the constructor is deployed — the cap is
  immutable.

### One open product question

`/positions` shows an **Est. fee yield** for a range the user has not entered
yet: this pool's trailing-7d yield scaled by how tightly the range concentrates
it, capped at 6×. It is labelled `est. · from N% trailing` so the basis is on
screen, but it is still a forward-looking number, which sits awkwardly against
§1's "never display a projected APR". Options are to keep it as is, cap it
harder, or drop the figure and show only the concentration multiple. **ALFA's
call.**

### Not in P0

No indexer, no contracts, no keeper, no wallet connector — the wallet button is
a placeholder until P2. `lib/chain.ts` holds the §2 addresses, all of them still
unverified on the explorer. Deploy configuration (`ecosystem.config.js`,
`deploy/nginx.conf`) is committed, but nothing has been deployed: that needs
credentials for the VPS.


---

## 13. Naming and domain

**The product is `Balast`. The domain is `balast.xyz`.** §10 left this open; it
is now settled, and this section records what moved and what did not.

`Depth` was too generic to own: every short `depth.*` on a mainstream TLD is
registered and in use — `.com` `.org` `.io` `.so` `.xyz` `.fi` `.trade`
`.exchange` `.network` `.finance` `.ai` `.co` all checked and all taken.
`Ballast` was chosen for its meaning — weight carried low in a hull that gives
a vessel stability, which is what this product sells: stability from real fees,
not from emissions — and registered in its Indonesian spelling.

**The word "depth" stays wherever it is the domain term rather than the brand.**
Pool depth, market depth, the `Depth` column in the Established board,
`permanent depth` in the router copy, the `*DepthUsd` fields, `.depth-bar`,
`reorgDepth`, and `design/depth.html` are all unchanged. Only the brand moved.

The four contracts in §3 are renamed `BalastZap`, `BalastShaper`,
`BalastVault`, `BalastRouter`. None is deployed, so this costs nothing now and
would have cost an audit later.

### Still open

- **The token.** §1 forbids emissions, so a token cannot be a reward. That
  leaves governance or fee-share, and fee-share creates pressure on the one
  number §3.3 made immutable to protect LPs. Recommendation: ship without one.
- **`ballast.xyz`** — the English spelling on the same TLD — is registered and
  parked for sale by a third party. For a front-end that asks people to connect
  a wallet, a confusable domain someone else controls is a phishing domain
  pointed at our users. `ballast.fi` and `balast.fi` were both still free at the
  time of writing; registering them and 301'ing to the apex closes most of the
  exposure. `deploy/nginx.conf` carries the redirect stanza, commented out.
- **The mark reads as the letter M.** It was chosen while the product was called
  Depth, and it is now a mismatch for a B name. Recorded in `brand/README.md`.

---

## 14. P1 implementation notes

Added by the P1 build. §12 and §13 are unchanged. This section records what the
indexer can know, what it refuses to guess, and the two things it needs from
ALFA before it can index the real chain.

### What ALFA has to supply

**`USDG_ADDRESS`. The indexer will not start without it.** §2 names USDG as the
day-one stablecoin and §4.3 allows exactly one path to a USD figure: the
WETH/USDG pool prices WETH, and everything else prices through WETH. The
address is not in the handoff. With it unset every USD figure on the site would
be zero, so the process stops with that explanation rather than running and
reporting zeros.

**`START_BLOCK`.** The PoolManager's deployment block. Left at 0 the first sync
scans from genesis, which on ~100ms blocks is a very long time. Worse, a
`START_BLOCK` set *above* a pool's creation block means the indexer sees that
pool's outflows without the mint that funded them — see *unknown depth* below.

**`LAUNCHPAD_HOOKS`.** §4 says pre-graduation launchpad liquidity is listed but
not stakeable, and names Pons, Bags and Bottom.fun. Their hook addresses are
not in the handoff, so the variable is empty and every pool is currently
classified stakeable. That is the safe direction for a listing and the **wrong**
direction for a vault: P2 must not deploy a vault against a pool discovered
while this was blank.

The chain's own details were verifiable and are configured: chainId 4663 is
confirmed, and the four public RPC endpoints in `.env.example` come from the
`ethereum-lists/chains` registry. The §2 contract addresses in `lib/chain.ts`
are still unverified on the explorer.

### Rebuilt, never incremented

Every aggregate table is recomputed from the raw rows rather than added to.
This is the single decision the rest of P1 hangs off, and it is what makes §9's
acceptance criterion reachable at all: §4.1 requires re-scanning the last 32
blocks every pass, and an incremented total would double-count every one of
those rows. A rebuild over rows keyed `(tx_hash, log_index)` gives the same
answer however many times the same logs arrive, in what order, or in what
range sizes.

The consequence is a staging chain, because rebuilding everything from the raw
tables on each pass is a full scan:

```
swap_events, liquidity_events     raw, append-only, keyed by log coordinates
  -> weth_usd_hourly              the one USD anchor
  -> pool_flow_hourly             signed token flow, which gives reserves
  -> pool_fee_hourly              fees and volume per pool per hour
  -> pool_state                   latest price, reserves, TVL
```

`pool_flow_hourly` is not in §4's schema sketch and exists for a measured
reason. On v4 the PoolManager holds every pool's tokens in one balance, so
reserves can only be derived by summing the pool's own signed event amounts.
Summing the raw tables directly took 5-9 seconds a pass on a four-thousand-swap
fixture; staging it hourly brought a full sync to under a second.

**§9 is proven, not asserted.** `server/indexer/replay.test.ts` runs a
deterministic fixture chain of ABI-encoded logs through the real decoder, the
real ingest and the real SQL against a real Postgres, and compares every
numeric column **as text** — comparing Postgres `numeric` through a JavaScript
float would hide exactly the drift the criterion exists to catch. A block-zero
run and an incremental run produce identical rows; a forced 32-block reorg
replay changes not one row, let alone the count; ten replays of a 500-block
window change nothing.

### v4 emits no amounts for a liquidity change

`ModifyLiquidity` carries a liquidity delta, a tick range and no token amounts,
and those amounts are what a TVL figure is made of. They are computed at ingest
from the delta, the range and the pool's price — and the price used is the one
carried forward from the most recent `Swap` at or before that log's position in
the `(block, logIndex)` order, loaded from the database rather than held in
memory. That is deliberate: it makes the derived amounts a pure function of the
log prefix, so a restart mid-chain resumes with exactly the state a full replay
would have reached. Held in memory, the two runs would disagree and §9 would be
unprovable.

The tick maths is the TickMath constant table, ported exactly, with a test
comparing every constant against `sqrt(1.0001^t) * 2^96` computed
independently — a mistyped hex digit fails there rather than as a wrong TVL on
the site.

### What P1 does not know, and says so

- **Market cap.** Needs a circulating supply, which is not in the log stream.
  It is zero and the column shows an em dash. The prototype's MC figures were
  generated; there is no honest live equivalent without a token-supply source,
  and §4 bars a third-party API from the critical path.
- **Chain share.** The featured card's figure needs the chain's total
  liquidity to compare against. The PoolManager *is* the chain's v4 liquidity,
  so our share of what we index is 100% and meaningless. Zero until there is
  something real to divide by.
- **Vaults, stakes, positions, harvest payouts.** All need contracts, which are
  P2. The tables exist and are empty, the snapshot reports them empty, and the
  components already had empty states for it. Nothing is invented to fill the
  page.
- **Unknown depth.** A pool whose reserves sum negative means we never saw its
  funding mint — `START_BLOCK` was above its creation block. Its depth is
  *unknown*, not zero. Zero is recorded, and the deliberate consequence is that
  the yield shows as an em dash (§7) rather than a number divided by a divisor
  we know is wrong. The poller logs how many events it dropped for pools it
  does not know, so the cause is findable.
- **An absurd price.** Nothing stops someone initialising a pool at a tick that
  derives a price near 1e24 USD. Such a figure is discarded and the pool left
  unpriced, rather than clamped — a clamped value renders as a real TVL of ten
  quintillion dollars. It is also why it is discarded rather than allowed to
  overflow: an overflow throws inside the aggregation and stops the pass for
  *every* pool.

### Two honest-numbers rules P1 had to add

Neither is in §7, and both follow from it.

**The trailing window ends at the last block indexed, not at wall-clock now.**
If the indexer is an hour behind, wall clock counts that hour as zero fees and
quietly deflates every yield on the board. So the window is measured back from
chain time and the lag is reported separately, which is what the top bar shows.

**`LiveProvider` holds nothing rather than something invented.** If the API is
down or no block has been indexed, the snapshot stays null and the UI says
*waiting for the indexer*. It never falls back to `SimProvider`. A site that
silently swaps generated numbers in when the indexer dies is the exact
dishonesty §7 is about, and it is the failure mode §8's P3 criterion warns of
one phase early.

That null state is the one place P1 touched a component. The `DataProvider`
interface has allowed `getSnapshot()` to return null since P0 — "null if none
has arrived yet (live, pre-connect)" — but `SimProvider` is synchronous and
never did, so `MarketProvider` never handled it. It does now. No page changed.

### Still open

- **The §12 questions are still open.** The six-hours-per-tick simulator clock
  needs sign-off, and `/positions`'s forward-looking *Est. fee yield* still
  needs a decision. P1 changed neither.
- **`/stakes`, `/positions` and `/portfolio` have real but empty data.** §8
  lists `/stakes` and `/portfolio` as reading real data in P1, but both are
  about vault contracts that do not exist until P2. They read real data in the
  sense that they read the indexer and honestly report nothing in it.
- **Protocol fee at 10%, cap at 2000 bps.** Unchanged from §12, and the cap is
  still constructor-immutable, so it still needs confirming before P2 deploys.

---

## 15. P1 follow-up: the gaps §14 recorded, closed

Added after an audit of the P1 build. §14 is unchanged; this records what was
wrong with it and what is now true instead. Four of the six items were defects
in my own work rather than missing inputs.

### Market cap: §14 was wrong, and it mattered

§14 said market cap "needs a circulating supply, which is not in the log
stream". True but incomplete: `totalSupply()` is an ERC20 read, it is on chain,
and `server/chain/abi.ts` already declared it. The figure was available and I
left it at zero.

It mattered beyond a blank column. **§3.4's `MILESTONE` trigger mode fires at
market-cap steps**, so with the figure at zero `BalastRouter` could not work in
that mode at all — a P4 blocker created by being too conservative in P1.

It is now derived, with one honesty consequence carried through: total supply
includes locked, vested and treasury-held tokens, and none of that is
distinguishable on chain. That makes the figure **fully diluted value, not
market cap**, and presenting FDV as market cap overstates every token with a
vesting schedule, always in the flattering direction. So:

- `pool_state.mc_usd` is `totalSupply x price` of the traded side.
- `Pool.marketCapIsFdv` says which figure it is.
- The row marks it `fdv`, and the cell's title explains what is included.
- A token that will not report a supply shows an em dash, not a guess.
- Supply is re-read on a cadence, oldest first, a few tokens per pass — a
  mintable token's supply changes, and a stale supply is wrong in the
  flattering direction again.

**This is the one place P1's follow-up touched a component.** §8 says the
phases after P0 do not change components; §7 says a displayed number must be
labelled for what it is. Where those conflict §7 wins, because §7 is a product
rule and §8 is about implementation sequencing. The change is a qualifier and a
tooltip. **ALFA should know the MC column now reads as FDV** — if the intent
was circulating market cap, that needs a supply source, and §4 bars a
third-party API from the critical path.

### v3 pools were undiscoverable

`V3_FACTORY_ABI` existed and nothing listened for `PoolCreated`, so v3 pools
had to be hand-listed in `V3_POOLS`. §4 says some older pools on this chain are
v3, so the hand-list would have silently omitted every pool nobody thought to
add. The factory is now followed, discovered pools are reloaded from the
database on restart, and `V3_FACTORY` needs an address from ALFA.

Finding it surfaced a second bug that the test caught rather than production.
A v3 pool announced at block 20 whose `Mint` lands at block 30 has both in
blocks already read past — its own address was not in the log filter when they
were fetched — and the 32-block re-scan cannot reach back far enough. That mint
is the pool's entire starting liquidity: miss it and the reserves sum negative
and the depth is unknown for good. A newly discovered v3 pool is now backfilled
from its own creation block in the same pass.

### The API was unprotected, and health said nothing useful

`/api/snapshot` is the expensive query and it sat on a public endpoint in front
of one Postgres; one loop would have taken the site down. It is rate limited
now, generously — the front end polls every 20s behind the websocket and a
dozen tabs behind one NAT must not be throttled. The websocket is exempt,
because after a restart every client reconnects at once and those are exactly
the clients that most need to get back on.

`/api/health` returned 200 whenever the API answered, which is useless as an
alert: the indexer could be dead for a day and the endpoint would say ok. It
**returns 503 when the indexer is stalled or has never started**, so any uptime
check watching a status code catches it. `deploy/monitor.sh` runs from cron and
checks the same thing plus PM2, alerting on a change of state rather than every
five minutes for two days.

This is §8's P3 criterion arriving a phase early. It names the failure
precisely — "a keeper that dies silently is a vault paying zero while
displaying a yield" — and the indexer has exactly that shape now.

### Operational gaps that would have bitten

- **Log rotation.** Three processes, six log files, no rotation. The first
  symptom of a full disk is writes failing everywhere.
- **Backups.** `deploy/backup.sh`, nightly, 14 days. §9's determinism means
  the database can be rebuilt from chain, but that is a full re-sync from
  `START_BLOCK` — hours of climbing lag. The dumps are local, which protects
  against a bad migration and not against losing the box; getting them off the
  machine needs credentials, so `BACKUP_SYNC_CMD` is left for whoever has them.
- **Boot survival.** `bootstrap.sh` now verifies `pm2-balast` is actually
  enabled and says so loudly if not. Without that unit a reboot leaves nginx
  serving 502s.

### Verifying the addresses

`npm run verify:chain` checks every §2 address holds code, that the
PoolManager has emitted the v4 events we subscribe to — **decoded, not
counted** — and that WETH and USDG answer as ERC20s with the decimals the
price maths assumes. Run it before the first sync.

The check is worth the script because the failure is invisible: a wrong
`poolManager` starts cleanly, subscribes to an address that emits nothing, and
reports a lag that climbs forever. A site that looks like it works and has
nothing in it.

An earlier version of that script checked the event name against the ABI
instead of against the log, so it reported every event as found the moment any
log appeared — it would have passed a wrong address that happened to emit
something else. It decodes now.

### Token logos

`logo_url` existed and was never populated. §4 permits external sources for
logos and metadata and forbids them for numbers, so `server/indexer/logos.ts`
is the only file in `server/` that talks to anything but a node or the
database, and it reads `logoURI` and nothing else — not price, not supply, and
not decimals, which are an input to every price. A failure is silent and
total: no list, an unreachable host or malformed JSON leaves every badge on its
derived colour and changes not one number. It is opt-in via `TOKEN_LIST_URL`,
because there is no canonical list for this chain and guessing at one would be
worse than no logos.

### What is still not built, and is not a defect

P2's contracts, P3's keeper and P4's router are phases, not gaps. §8 orders
them and §8's P5 puts an external audit in front of any mainnet vault
deployment. Nothing in this section brings them closer.

The §12 questions are also still open: the six-hours-per-tick simulator clock
needs sign-off, and `/positions`'s forward-looking *Est. fee yield* needs a
keep, cap or drop. P1 and this follow-up changed neither.

---

## 16. The deploy bug that `.env` never being read caused

Recorded because it broke a real deploy and because the shape of the mistake
is worth keeping.

`deploy/bootstrap.sh` writes `/var/www/balast/.env` with the generated
database password and a slot for `USDG_ADDRESS`. **Nothing read it.** Node
does not read `.env` files — Next.js does, which is why the web process worked
— and PM2 does not either. The secrets deliberately do not go into
`ecosystem.config.js`, because that is in the repository. So the file was
written, nothing opened it, and `balast-api` and `balast-indexer` both died on
`DATABASE_URL is required` while pointing at a file sitting right there.

`ecosystem.config.js` even carried a comment saying ".env holds DATABASE_URL",
which was true and useless: it described where the value was, not how it would
arrive.

Fixed with `server/load-env.ts`, imported as the first line of every server
entry point. Three properties that matter:

- **The real environment always wins.** A variable already set by PM2, a
  shell, or CI is never overwritten, so `RATE_LIMIT_MAX=1 npm run api` does
  what it looks like it does.
- **The path resolves from the module, not from `cwd`.** PM2 sets a cwd, cron
  does not, and a deploy script may run from anywhere.
- **It is imported first in each entry point**, not only from `env.ts`,
  because several modules read `process.env` at their own top level and module
  evaluation order would otherwise decide whether they saw the file.

The parser is twenty lines rather than a dependency, and it keeps a `#` inside
a quoted value — the generated database password plausibly contains one, and
truncating it there produces an authentication failure that looks nothing like
its cause.

### And a second fault the same command exposed

`npm run verify:chain` failed on `DATABASE_URL is required` — a variable it
never uses. It imported `server/env.ts`, which validates every variable at
import, and the script's entire purpose is to check the chain **before** the
database matters.

The RPC endpoint list now lives in `server/chain/endpoints.ts`, which has no
database requirement; `env.ts` re-exports it so there is still one definition,
and `chain/client.ts` depends on it rather than on `env`. The verify script
imports neither `env` nor the database.

Eager validation at import is still the right default for the API and the
indexer — a typo'd variable should stop the process at boot rather than
produce an indexer quietly following the wrong chain. The lesson is narrower:
a module that validates everything should not be on the import path of
something that needs one thing.

### The test that guards the guard

`vitest.setup.ts` asserts `DATABASE_URL` is still the test database after the
loader has run. The suites truncate every table, and a developer with a real
`DATABASE_URL` in their `.env` must never have it win. The loader's
non-overwriting rule is what makes that safe today; the assertion is what
keeps it safe if the rule ever changes.

---

## 17. Deploy faults, and every token having a mark

Two deploy faults worth recording because of their shape, and the answer to
"every token must have a logo".

### A diagnostic that invented a failure

`doctor.sh` parsed `pm2 jlist` with grep, matching `"name":"x","pm2_env":{`.
PM2 puts `namespace`, `version`, `mode`, `pm_id` and `monit` between those two
keys, so the pattern never matched and the doctor reported **every process as
not running while the site was up and serving**. A tool that invents a failure
is worse than one that misses a real one: it sends you looking in the wrong
place. It parses the JSON with a JSON parser now.

### A repair tool that refused to repair

The doctor's `next` line pointed at `bootstrap.sh` when `.env` was missing.
`bootstrap.sh` then exited with "reset the password yourself", because the
database role already existed from an earlier run and the password was no
longer known anywhere. The one command meant to fix the box refused to fix the
most likely way it breaks.

It rotates the role's password and writes a fresh `.env` now. Rotating is safe
precisely BECAUSE the old password is lost — nothing can still be using it.

### Every token has a mark; some have logos

`lib/token-mark.ts` derives a badge from the token's own address: a
fixed-weight disc whose hue is unique to that address, carrying the ticker's
first two characters. Deterministic, so the server and the browser render the
same thing and a token never looks like a different token after a reload.

Saturation and lightness are fixed rather than derived. Deriving them
eventually produces a near-black token invisible on a near-black page, or one
close enough to the accent green that §5's colour rule stops meaning anything.

The ink is chosen per hue, and that is not fussiness: **yellow at this
lightness is far brighter than blue at the same lightness**, so no single ink
stays legible across the wheel. Measured, a fixed dark ink bottoms out at
1.72:1. Per-hue selection holds 4.26:1 across all 360 hues, and there is a
test that re-derives that number rather than trusting this paragraph.

That test caught a real bug in the first version: the ink luminances were
hardcoded, and wrong — 0.0106 against a true 0.0044 — which flipped the ink
choice on part of the wheel and quietly cost 0.3 of contrast. They are
computed from the hex now. A constant that has to agree with another constant
is a constant that will eventually disagree with it.

**Real logos** still come only from a token list, per §4. The change that
makes that usable: `TOKEN_LIST_URL` now accepts a local path, and
`config/tokens.json` ships with the repository. Robinhood Chain has no public
token list, so waiting for one meant no token would ever have a real logo;
now whoever knows the tokens can add them today, in the same Uniswap
token-list shape, and switching to a public list later is one line. Only
`logoURI` is read — not price, not supply, and not decimals, which are an
input to every price.

A listed logo that changes now replaces the recorded one, rather than only
filling a blank. A corrected logo should reach the site without anyone
truncating a table to make it happen.

### The hardcoded database port

`bootstrap.sh` created the role and database over postgres's **unix socket**,
which finds the default cluster whatever port it listens on, and then wrote a
`DATABASE_URL` with a hardcoded `5432`. Where those disagree the database
exists and the URL cannot reach it, and the error — `P1001: Can't reach
database server` — reads exactly like postgres being down.

This is not an edge case on a shared box. Debian puts a second cluster on
5433 when 5432 is taken, and this VPS already ran PostgreSQL for other sites.

Detecting the port turned out to be its own small problem: `psql` cannot
answer it, because its socket is named `.s.PGSQL.<port>` and it defaults to
5432 — asking the cluster its port over the socket requires already knowing
the port. `deploy/pg-port.sh` asks the system instead, in order of
authority: Debian's cluster registry, then the socket files, then a TCP
listener. Every socket `psql` call in bootstrap now passes `-p` for the same
reason.

Bootstrap also corrects the port in an existing `.env` rather than leaving it,
because the port is a fact about the machine and not a preference — verified
against a password containing `#` and `&`, where only the port changes.

### A verdict that ranked the wrong failure

The doctor ranked failures by dependency order alone, so with the database
unreachable AND `USDG_ADDRESS` empty it told the operator to go look up a
token address. Those are independent: an empty `USDG_ADDRESS` stops the
indexer and nothing else, while an unreachable database stops everything.

There are two tiers now. `first` is for a failure the rest of the box cannot
work around; `also` is for one that blocks only itself. The verdict prints
`next` and then `then`.

The database check also says **which** failure it is, rather than "cannot
connect": cluster down, wrong port in `.env`, `listen_addresses` refusing
127.0.0.1, or bad credentials. The generic message sent someone to check
whether postgres was running — and it was, on another port.

### An API that died instead of explaining

`start()` threw on a missing `USDG_ADDRESS` and refused to listen. On the real
box that produced 24 restarts, no explanation anywhere, and a front end that
could not even ask what was wrong — while the page it served said only
"waiting for the indexer", which was true and useless.

That is backwards. The API is the one process in a position to say what is
missing, and a configuration error should be loudly visible rather than fatal.
It starts now, and reports:

- `/api/health` → 503 with `status: "misconfigured"` and a message naming
  both the variable and the two commands that set it.
- `/api/snapshot` → 503 with the same reason rather than a bare "no data".

**Misconfiguration outranks `never-indexed`** in that status, deliberately: a
chain with no indexed blocks is the SYMPTOM of an indexer that cannot start,
and reporting the symptom sends whoever is looking to the wrong place.

The indexer still refuses to start without the anchor, and that stays right —
it would otherwise write rows priced at zero. PM2's `errored` state is the
visible signal there.

`components/providers/AwaitingIndexer.tsx` asks `/api/health` and shows the
reason under the honest-empty message. The waiting page now tells an operator
what to fix instead of leaving them to guess, which is the difference between
a blank wall and a diagnosis.

### The anchor finds itself

`USDG_ADDRESS` was the one value nothing could proceed without, and the only
one no machine could supply — §2 names USDG but not its address. So the
indexer refused to start, the API refused to start, and the site sat on a "not
configured" page waiting for a step only a person could take. For hours.

That was the wrong shape for the problem. **The indexer already reads every
token's symbol off its own contract while discovering pools.** The answer was
in its own tables the whole time.

`server/indexer/anchor.ts` looks: the token calling itself USDG that trades
against WETH, ranked by swaps. `USDG_ADDRESS` still overrides it, and a
*malformed* override is still refused — somebody meant to pin a specific token
and mistyped it, and quietly pricing the whole site off a different one cannot
be detected from anywhere downstream.

Where it will not guess: with two tokens claiming the symbol it picks the one
with real depth, **says which and why**, and reports both. `/api/health`
carries `usdgSource` and `usdgNote`, because the anchor is the single most
consequential value in the system — a wrong one makes every dollar figure
wrong — and it has to be auditable from outside the box.

The ordering works because of a decision made much earlier for a different
reason. Aggregates are REBUILT, never incremented (§14), so the indexer can
write raw rows with no anchor at all, discover it several passes later, and
the next rebuild prices everything retroactively. No second scan of the chain.
There is a test proving the early hours — indexed before any anchor was
known — end up carrying USD figures, and another proving the result is
identical to having configured the address up front.

`START_BLOCK` and `V3_FACTORY` remain genuinely optional rather than
discovered: the first is a performance choice, the second cannot be inferred
from logs the factory itself emits.

### The crash loop: a price computed and thrown away

With the anchor discovering itself the indexer finally reached the real chain
— and then stopped on every pass with "No price known for pool … the batch is
missing its Initialize", retrying the same range forever and indexing nothing.

Three of my own mistakes in a line:

1. `planIngest` computes `plan.states`, which carries the price from
   `Initialize`. **Nothing ever wrote it.** The field was built and never
   persisted.
2. `loadPriceState`'s fallback read `pool_state.sqrt_price_x96`, which
   `rebuildPoolState` takes from the pool's LAST SWAP — so a pool that has not
   traded yet has zero there and was filtered out by the `> 0` condition.
3. And skipping the aggregation when no anchor exists left `pool_state` empty
   regardless.

So a `ModifyLiquidity` for a pool created in an earlier pass had no price, and
v4 emits no token amounts on that event, so it could not be valued.

**The Initialize price now lives on the pool row** (`init_sqrt_price_x96`,
`init_tick`) — an immutable fact from the log, which makes the state loaded
from the database exactly what an in-memory replay would have had. §9 still
holds; there is a test for that alongside the fix.

The second half matters as much: it **threw**. One pool's reserves being
unvalued is a far smaller loss than every pool's data being frozen, and §7
already renders unknown depth as an em dash. Such an event is now recorded on
the plan and logged, and the pass completes.

### Starting from genesis

Left at `START_BLOCK=0` the indexer scans from block zero. On this chain that
is 62 million blocks of mostly nothing — some thirty thousand passes before
reaching anything worth indexing, and the observed run was at block 7,872
after several minutes.

`eth_getCode` is empty before a contract exists and non-empty after, which is
monotonic, so `server/chain/deployment.ts` bisects for the PoolManager's
deployment block in about 26 calls and starts there.

It needs an archive node, and a pruned one answers old blocks with empty —
which would look exactly like "deployed at head" and set a `START_BLOCK` above
every pool's creation, so each pool's funding mint would be missed and its
depth would read as unknown for good. That case is detected and the search
abandoned rather than trusted.

Writing the test for it found a real bug: the genesis probe sat outside the
bisection's try/catch, so a pruned node would have thrown at indexer startup
instead of falling back.

### Thirty-four hours of empty blocks

With the crash loop fixed the indexer ran, and the next problem was arithmetic:
block 47,000 of 62,644,703, at 2,000 blocks a pass. Some thirty thousand round
trips — about thirty-four hours — before reaching anything worth indexing.

The deployment-block bisection was supposed to skip that, and it correctly
refused to: **all four public endpoints are pruned**, so `eth_getCode` cannot
answer for an old block. It said so and fell back rather than guessing, which
is right — a `START_BLOCK` above a pool's creation means never seeing the mint
that funded it.

So the fix is on the other side: the range adapts. Empty ranges double toward
a ceiling, busy ones halve back, and once the indexer is following head it
returns to the floor, where a narrow window keeps latency low.

The ceiling is learned rather than configured. Endpoints cap `eth_getLogs`
differently and none announce it, so the poller starts optimistic, and the
first refusal — "query returned more than N results", "block range too large"
— halves the width and records a ceiling it stays under. The cursor does not
move on a refusal, so nothing is skipped.

The property this could not cost is §9. A window that changes size mid-sync is
a harder version of the block-zero-versus-incremental comparison that
criterion is built on, so there is a test producing byte-identical
`pool_fee_hourly` rows from an adaptive run and a fixed-window one.

The indexer also logs every pass while backfilling now, with percentage and
blocks remaining. It previously logged only passes that found something, and
on a chain that is mostly empty an hour of silence is indistinguishable from a
hang.

---

## 18. Visual refresh: direction A ("Terminal+")

ALFA reviewed three redesign directions as rendered mockups and chose **A**:
the same dark ground and single green accent, with the hierarchy, legibility
and phone layout rebuilt. This section supersedes the parts of §5 and §6 it
names. Where it is silent, §5 and §6 still hold, and §1 and §7 are untouched:
they are product rules, not styling.

### What changed in the design system (§5)

- **Type.** Inter carries words: labels, headings, buttons, prose. JetBrains
  Mono carries numbers and tickers, always tabular. Labels are sentence case.
  §5's `10px / 600 / .16em / uppercase` label style is gone: at that size it
  cost legibility on every surface it touched.
- **Contrast.** Every text token is at least 4.5:1 on `--panel`. `--fg-3` is
  `#7F9489` (5.9:1) and `--fg-4` is `#71857A` (4.9:1); the old `#3D4D45` is
  now `--fg-5`, decoration only, never text. It had been used for footer links,
  ranks, hashes and placeholders at 2.2:1.
- **Borders are neutral by default.** `--bd` was green-tinted, which put the
  accent on every input and pill. The colour rule is unchanged; it is now also
  easier to keep.
- **Neutral marks where the colour rule said so all along.** Sparklines encode
  shape, not gain or loss, so they wear neutral ink rather than going red when
  the 24h price move was negative. The bin chart's current-price marker was red,
  which §5 reserves for negative numbers; it is a neutral dashed line. Toasts
  are neutral: green read as success, and in P0 nothing ever succeeds.
- **Layout.** 232px labelled rail; 64px icon rail at 1180px and below; at 640px
  and below the rail is replaced by a bottom tab bar. The top bar is 64px and
  holds search, TVL, Fees 24h, Volume 24h and ETH. The boards sit side by side
  only where each gets about 560px, so they stack below 1400px. Columns drop
  by priority: MC at 1640px, Age at 1740px, Vol 24h / Depth at 1900px.

### What changed on the pages (§6)

- **Stake is a column, not a hover reveal.** §6 had the button fade in on row
  hover. A phone has no hover, and the revealed button was drawn on top of the
  sparkline. It is always present, quiet until its row is hovered.
- **The featured card's chart has its own band.** The prototype ran it
  full-bleed behind the six metrics, through the numbers. The headline is fees
  paid to LPs (§1: fee yield is the headline, not volume). Chain share is gone:
  §14 already established it is meaningless against our own index.
- **`featured.history` has a defined unit**: fees per 12h bucket over the
  trailing 7 days, 14 points, in both providers. The live API already sent
  that; the simulator sent a full day's fees per point.
- **The pools page explains its numbers.** The "Own a share of the depth" card
  is replaced by the rules that make the numbers honest — trailing 7d, `est.`,
  `—`, the 10% fee from fees only, zero emissions. Start earning moved to the
  page header.
- **Page headers are the page name plus one sentence.** The marketing
  headlines survive as that sentence.
- **Phones get their own order**: your stakes come before the vault catalogue,
  and the bin chart before the controls that drive it.

### Honesty fixes that shipped with it

Each was a §7 problem found while reviewing the UI, not a style choice.

- **The simulator said "Live".** The top bar showed a pulsing green *Live*
  over generated numbers. It says **Simulated** now, the rail says so in a
  sentence, and the simulated indexer lag still shows (`Simulated · 42s behind`)
  so §7's lag state stays visible in P0.
- **Actions reported successes that never happened.** Mint, Stake, Claim,
  Compound and Enable router each toasted a confirmation ("Position minted to
  your wallet · 1 tx") with no wallet and no contract. They all go through
  `act()` now: "… is a preview — no transaction was sent." Connect wallet no
  longer puts a made-up address in the top bar.
- **The portfolio contradicted itself**, the same failure §12 fixed for the top
  bar. Net value, fees earned and claimable were constants that disagreed with
  the rows beneath them, and the heatmap summed to a third figure. All are
  derived from the rows, the heatmap sums to fees earned, and a test holds that
  true across ticks. "Best week so far" was a fixed string; it is computed
  (`lib/portfolio.ts`) and says "−24.8% vs the week before" when that is the
  truth. Net change takes its sign and colour from the number.
- **Out-of-range rows lost their warning on phones.** A rule hiding token
  subtitles in the boards also hid "out of range — earning nothing" in the
  portfolio below 520px. §7 requires it in the row.
- **The drawer's fee disclosure and its estimate both hardcoded 10%.** Both
  read `PROTOCOL_FEE_BPS` now, so the disclosure cannot drift from the maths.
- **"New" meant under 10 days**, while Established admits pools at 7, so one
  pool could be both. It means under 7 days, in grey.
- **The footer linked an audit that does not exist.** Removed until P5.
- **Router copy said it "takes custody" of the fee stream**, in a product whose
  first rule is that Balast never takes custody. The contract *holds* it.

### Still open

The §12 questions are unchanged: the six-hours-per-tick simulator clock needs
sign-off, and `/positions`' forward-looking *Est. fee yield* still needs a keep,
cap or drop.

---

## 19. Tidewell: the rename, the identity, and the new Stakes page

ALFA asked for the product to stop being Balast — a different name, a
different brand, and feature pages that look different. Four names were
proposed as brand boards with a working Stakes page each (Holdfast, Plumb,
Slipway, Tidewell); **ALFA chose Tidewell.**

### The name

*A well that fills with every tide.* Yield comes from real trading volume: it
rises when the market moves and slows when it slows, which is §1 in one line.
The tagline is **Fees rise with the tide.**

- **Known neighbours.** A web search found no DeFi project called Tidewell,
  but two close ones: TideFi (a DEX on its own chain) and Tidal Finance (DeFi
  cover). Neither is a liquidity layer; the confusion risk is real but small.
- **The domain is `tidewell.live`.** ALFA found every mainstream TLD for the
  name taken and registered `.live`, knowing it scores worse than `.xyz` on
  phishing reputation (it ranked 12th by phishing score in CyberCrime Info
  Center's Aug–Oct 2025 data). The mitigations are on ALFA's side of the
  registrar: buy `tidewall.live` (the wall-for-well misspelling, already made
  once), DNSSEC, a CAA record, DMARC `p=reject`. `balast.xyz` 301s to the same
  path. The social card and X headers print the address.
- **Contracts.** §3's four contracts are `TidewellZap`, `TidewellShaper`,
  `TidewellVault`, `TidewellRouter`. None is deployed, so this is free.
- **What kept the old name, deliberately.** PM2 process names
  (`balast-web`, `balast-api`, `balast-indexer`), `/var/www/balast`, the
  database role and name, `balast_test`, the Redis channel and every path in
  `deploy/`. Those are identifiers a running deploy depends on, not branding;
  renaming them is an operations change with a migration, to be done on the
  box when ALFA chooses, not a find-and-replace.
- **`BRAND` in `lib/site.ts`** is the one place the name is printed from:
  metadata, the lockup, the footer, the drawer's fee line, page titles.

### The identity (supersedes §5's palette and type, and §18 where they differ)

- **Light, not dark.** Ground `#ECF2F2`, white cards with a soft shadow, ink
  `#0C1E24`. Every text token is at least 4.5:1 on white *and* on the ground;
  the lowest, `--fg-3` `#566C74`, is 5.5:1 and 4.9:1.
- **The colour rule, split three ways.** The brand teal `#0B6E86` means
  identity and action — the logo, primary buttons, the active control, a single
  chart series. Green `#0A7D4A` means a positive number and nothing else. Red
  `#C23B2E` means a negative number and nothing else. §5 gave one green all
  three meanings, so a button and a gain looked alike; that is the change.
- **Type.** Sora for display, Manrope for words, IBM Plex Mono for every number
  and ticker. Figures in prose stay proportional — Manrope's tabular 1 reads as
  "1 1" — while every data figure is mono, and mono is tabular.
- **The mark.** A ring around water clipped to a wave: the well, filled to the
  tide line. Geometry in `components/shell/Logo.tsx`; every file in `brand/`,
  `app/icon.svg` and `public/og-card.png` is generated from the same numbers by
  `npm run brand`.
- **Top navigation, not a rail.** The bar holds the lockup, the five
  destinations, search, the data-status chip and the wallet; a market strip
  under it carries TVL, Fees 24h, Volume 24h and ETH, and in the simulator says
  in words that the numbers are generated. Below 1024px the destinations move
  to a bottom tab bar.
- **Columns drop by the board's width, not the window's** — container queries,
  because the same board is 680px side by side and 1300px stacked. §5's
  priority order is unchanged: Vol 24h / Depth first, then Age, then MC, then
  the sparkline and Stake column.
- **Heatmap reads darker = more**, the honest caption on a light ground.

### The Stakes page

Rebuilt rather than restyled, because ALFA asked for features that look
different and the old page made you compare vaults in one place and stake in
another.

- **Your earnings first**: claimable now (with Claim all), your fees over the
  last 7 days against the week before, what you have staked, and the next
  harvest among your vaults. All of it read from the portfolio, so it cannot
  disagree with `/portfolio`.
- **Vaults as a ranked list**, by fee yield (§1), each with its last seven days
  of fees as daily bars — the live API's 14 half-day buckets folded into days
  (`dailyFromHalfDays`) — plus staked, stakers and next harvest. The `est.` and
  `—` states of §7 render exactly as everywhere else.
- **Stake beside the list, not in a drawer.** Choose a vault and the panel
  shows the deposit, the quick 25/50/75/Max chips, your share, estimated weekly
  fees from the trailing window, the 10% fee and "Lockup: None" before anything
  is signed, and the harvest → stream → claim cycle in three steps. Below 980px
  there is no room for it, and choosing a vault opens the drawer instead.
- **One sum for both forms.** The drawer and the panel quote through
  `lib/stake.ts` (`stakeQuote`, `depositProblem`, `PREVIEW_BALANCE_ETH`), so
  they cannot disagree, and the fee they deduct is `PROTOCOL_FEE_BPS`, the same
  constant the disclosure prints.

### The premium cut, and the logo on the website

- **Two cuts of one mark.** The flat mark is for interfaces, favicons and one
  colour. The **premium** cut — a gradient ring, a swell behind the tide, water
  that darkens with depth and a highlight on the crest — is for hero use: the
  app icon, decks, the press. Same silhouette, so it reads as the same logo at
  any size. Both come out of `npm run brand`, which now has a third step,
  `scripts/build-brand-kit.py`.
- **What the website serves.** `app/icon.svg` (favicon), `app/apple-icon.png`
  (iOS home screen), `app/manifest.ts` with `public/icons/` (add to home
  screen), `public/og-card.png` (link previews), and **`/brand`**: every logo
  as SVG and high-resolution PNG, plus `tidewell-brand-kit.zip` with all of
  `brand/`. The footer links to it. An e2e test fetches every file the page
  offers.

### The Signature edition

For profile pictures, headers and launch images only: the mark as a polished
porthole — a metal ring with a specular sweep and a soft halo, water lit from
above and shadowed at depth, a glowing crest and a crescent of reflected light
on the glass, over a deep-water ground with a bloom and fine grain. Two
finishes, **glass** (the brand teal) and **gold** (an edition). Generated with
everything else by `npm run brand`, offered on `/brand`, and sized under X's
upload limits (avatar about 1 MB of 2 MB, header up to 2.6 MB of 5 MB). The
grain does not compress, so the 3000px headers and the showcases are left out
of the ZIP and downloaded one by one.

### Deploying it

`deploy/deploy.sh` hardcoded `BRANCH=claude/new-session-c0aptv`, so the box
could only ever deploy that branch. It now deploys `DEPLOY_BRANCH` when given,
otherwise whatever branch the checkout is on. The server still has the old
script, so the first switch is by hand (see the README's deploy section);
every deploy after that follows the branch the box is on.

### Moving the box to the new domain

`deploy/switch-domain.sh` is the one-time move, in the only order that works:
check the new name resolves to this box, answer its ACME challenge over plain
HTTP beside the running site, get the certificate, and only then install the
TLS config — restoring the old one if `nginx -t` rejects it. `deploy.sh`
gained the matching guard: it will not install an nginx config that names a
certificate the box does not have, because that config passes nothing at the
time and takes the site down at the next nginx restart. Both configs were run
under a real nginx with throwaway certificates and every redirect probed.

### The first deploy on an empty server

The tidewell.live VPS is a fresh box — no `balast` user, nothing in
`/var/www` — so it takes `bootstrap.sh`, not `deploy.sh`. Four things in that
path were wrong for a first run and are fixed:

- **DNS is checked before anything is installed.** The certificate was the
  last step, so a wrong record surfaced after ten minutes of installs on a
  half-configured box. The A records for the apex and `www` must be exactly
  this server — a registrar's parking record left beside ours is refused — and
  an AAAA record pointing elsewhere is refused too, because Let's Encrypt tries
  IPv6 first.
- **What the site shows is chosen, not assumed.** `DATA_SOURCE` is inlined by
  `next.config.mjs` at build time, so editing `.env` and restarting changed
  nothing, and `ecosystem.config.js` carried a `DATA_SOURCE: 'live'` that did
  nothing at all while looking authoritative. It is gone. `bootstrap.sh` takes
  `DATA_SOURCE=sim|live` (default `live`) and `deploy/data-source.sh` switches
  later and rebuilds. On a fresh box `live` honestly says "waiting for the
  indexer" until the first sync reaches head; `sim` is labelled Simulated on
  every page. The indexer syncs in either mode.
- **Two diagnostics still said the indexer refuses to start without
  `USDG_ADDRESS`.** Untrue since §17's anchor discovery. `bootstrap.sh` ended
  on that warning and `doctor.sh` reported it as BAD — the same invented
  failure §17 recorded once already. Blank is now reported as normal.
- **`pm2` as root shows an empty list**, because the processes belong to
  `balast`. Every instruction printed or documented now says
  `runuser -u balast -- pm2 …`.

### Live mode, looked at before anyone switched to it

ALFA asked for real data instead of the simulator. Before handing over the
switch, every page was rendered in live mode against snapshots shaped exactly
like `server/api/snapshot.ts` returns them today — real pools, and no vault,
stake, position, payout or wallet, because none of those exist before P2 —
in four states: caught up, days behind, blocks indexed but no pool found yet,
and nothing indexed. Live mode had never been looked at with nothing in it,
and it was not honest:

- **The boards and Stakes said "No match — try a ticker"** to people who had
  not searched. Every empty list now names its real cause: nothing indexed
  yet, no vault deployed yet, no wallet connected, a filter, or a search.
  Established's empty state says pools join at 7 days.
- **The Pools and Positions pages crashed** with no pools indexed —
  `reduce()` with no seed, and `pools[0].token`. That is the first state a
  box syncing from genesis reaches. Both render an explanation now.
- **Zero had a direction.** `$0` in green, `+$0 · +0.0%`, `−$0` in red,
  `▲ +0.0%`. Zero is neither a gain nor a loss, judged at the precision it is
  shown: `signOf`, `tone`, `signedUsd` in `lib/format.ts`, with tests.
- **A wallet balance nobody had.** Every form offered `Max 4.18` from a
  constant. `Portfolio.walletBalanceEth` carries it now — the simulator's
  preview balance, `null` from the live API — and with no wallet there is no
  Max, no balance check against an invented number, and Mint says it needs a
  wallet instead of quoting gas.
- **A stake form for pools with no vault**, live and simulated alike (the
  simulator has vaults for six of ten pools). The drawer says the vault is
  not deployed yet and the Stake button stays disabled.
- **Router claims with nothing behind them.** "Verified deployer" was printed
  unconditionally; it is `RouterPlan.deployerVerified`, false from the live
  API. The projected-depth curve is a fixed shape and rose while its own
  labels said start and end were equal; with no fee stream it is replaced by
  a sentence, and so are "0.00 WETH → +$0" and "0.0% to 0.0%".
- **"3542400s behind"** in the top bar — a first sync is days behind for
  hours, and raw seconds pushed a phone's page sideways. `lagLabel` reads
  `41d`. The market strip's ETH shows an em dash before the USD anchor is
  found, not `$0.00`.

`deploy/data-source.sh live` now prints `deploy/indexer-status.mjs` before it
switches: how much of the chain is read, how far behind, pools and swaps
found, whether the USD anchor is known, and the pace measured from the
indexer's own progress lines — gain over head, since head moves too — so the
catch-up estimate is arithmetic on what happened, and a pace that is not
gaining says so instead of promising an ETA. `data-source.sh status` prints it
on its own.

The first deploy after that printed `curl: (22) … error: 503 — API not
answering yet` in red, under three processes all `online`. `deploy.sh` checked
health with `curl -f`, and `/api/health` answers 503 on purpose whenever the
indexer is behind or has no USD anchor — so on a box still on its first sync,
every deploy reported a dead API that was up. The third diagnostic in this
file to invent a failure. It waits for the port and prints the status report
instead.

### Native ETH: why the live site waited on the anchor

Switched to live, the site sat on "Looking for the USD anchor". One cause the
code could not rule out, and could fix: **the indexer only recognised WETH.**
Uniswap v4 names native ETH as the zero address, and most v4 ETH pairs hold
ETH itself. Such a pool was read as a token at `0x0000…` with a placeholder
symbol, matched no quote rule, and was dropped from the site — and if the
chain's ETH/USDG pool is one of them, the anchor could never be found however
long the indexer ran.

`events.ts` records a v4 pool's native side as WETH as it decodes the
Initialize (`pricedCurrencies`): same asset, 1:1, 18 decimals, so no price or
amount changes; positions are kept because sqrtPriceX96 is token1 per token0;
and an ETH/WETH pool is left alone rather than becoming WETH/WETH. It is a
pure function of the log, so §9 holds. Pools stored before the fix are
rewritten once per indexer run (`adoptNativeEthPools`), with no re-sync —
aggregates are rebuilt from raw rows, so the next pass prices them.
`find:tokens` counts native ETH the same way. `native.test.ts` proves a chain
of native-ETH pools finds its anchor and prices ETH at $2,500 and PONS at
$0.5937, and fails five of seven assertions with the mapping switched off.

Whether the real ETH/USDG pool is native was not verifiable from here — the
chain's RPC is not reachable from the build sandbox. If the anchor is still
missing once the indexer has caught up, the next suspect is that USDG trades
only on v3 here, which needs `V3_FACTORY`.

### Every token a logo: from the services that have them

The native-ETH fix worked: the live site found its anchor and listed 143 real
pools. ALFA then asked for a logo on every token. `config/tokens.json` was the
only source and it was empty — and `bootstrap.sh` never set `TOKEN_LIST_URL`,
so the box never read it at all. It is the default now.

`server/indexer/logo-sources.ts` fills every token the list does not cover,
by **address**, from GeckoTerminal (CoinGecko images), then DexScreener (images
a project registered), then Blockscout (the chain's explorer). The response
shapes were read off the live APIs for real tokens on this chain before any
parsing was written, and those real bodies are the test fixtures:

- GeckoTerminal: `data[].attributes.image_url`, null when it has none; 200
  `{"data":[]}` for a token it does not know; **429 after a short burst**.
- DexScreener: `[].info.imageUrl`, which belongs to the pair's `baseToken`
  only — so asked about WETH, the quote in every pair, the answer is none,
  not a memecoin's face.
- Blockscout: `icon_url`; refuses any request without a User-Agent (403), and
  answers 403 `{"message":"Not found"}` for a token it does not know, which is
  an answer, not an error.

Rules: image URLs only (§4); a curated logo always wins and is never replaced;
`tokens.logo_source` says where each came from; a token no source knows is
asked again in a day, one a source failed on (rate limit, timeout) in half an
hour, so a 429 delays a logo instead of losing it. It runs in the background
at most every 30 seconds, ~30 tokens a sweep, busiest first, never awaited by
a pass. Opt-in on `Poller`, so no test reaches the network. `TokenBadge` falls
back to the monogram when a logo fails to load, rather than a broken image.

Run end to end against the real services: **12 of 19 real tokens got a logo**
(9 GeckoTerminal, 3 DexScreener). The seven without were all copycats — other
contracts calling themselves CASHCAT, SPCX, TSLA and USDe. Matching by
address is what keeps them on a derived mark; matching by symbol would have
dressed every one of them as the real token, on a site that will one day ask
people to deposit into them. "Every token has a logo" therefore means every
token with a real one; the rest have a mark unique to their address, and that
difference is information.

### Stock tokens wore Robinhood's feather

With logos live, ALFA pointed at AAPL: the Robinhood feather, not Apple's
logo. Every source agreed with the feather because they all copy one file —
Robinhood's own CDN serves byte-identical art (md5 `7458db13…`) for AAPL, NVDA
and SPCX. No source keyed by address will ever say Apple.

So the company logos are built, reviewed and served by us:

- **The official list is on chain.** Robinhood's stock-token factory
  `0x4783C67b…C046` emits `Deployed(bytes32 indexed uid, address stock, string
  name, string symbol)` — 212 of them. That event is the registry: the
  "SPCX … Robinhood Token" at `0x9507…` that sits on the boards is not in it,
  and is not Robinhood's. `scripts/build-stock-logos.py` reads it through the
  public RPC in 10M-block chunks (the RPC's limit).
- **Logos by ticker, from Financial Modeling Prep**, chosen over Parqet after
  rendering both side by side: Parqet maps SPCX to the AXS ETF issuer, FMP to
  SpaceX. Each is trimmed, fitted inside the circle whatever its aspect, put
  on white (dark ink for a white logo), and written to
  `public/tokens/<SYMBOL>.png` — about 1 MB for 207, served from our origin, so
  no third-party host at runtime and no visitor's address sent to one.
- **Every logo was looked at against the token's own name.** Four failed and
  are excluded in the script with the reason — FLY (Fly Leasing, an earlier
  holder of the ticker, not Firefly Aerospace), OKLO (its SPAC's logo), RVI (an
  unrelated image for Robinhood Ventures Fund I), TSEM (a photo of a building).
  Those keep the feather, which is at least the issuer's real mark.
- `config/tokens.json` carries the 207 by **address**, so `logos.ts` applies
  them as curated logos, which always win over GeckoTerminal's feather on the
  indexer's next pass. `isSafeLogoUrl` accepts exactly `/tokens/<flat-name>`
  besides http(s). `token-list.test.ts` fails on a missing file, a duplicate or
  malformed address, an orphaned logo, or AAPL not being Apple.

Memecoins with no logo anywhere — ROJAK, WHITE, DegenHood on the boards — are
not fixable from here: no source has one, and inventing one is the copycat
problem again. They keep their address-derived mark and are re-checked daily.

### The waiting card on every first visit

Every visit to the live site opened on "Waiting for the indexer — No indexed
blocks yet" and swapped to the real boards a moment later, with "The indexer
is 11160833s behind, past the 300s stall threshold" under it. Three faults:

- **The server rendered without data.** `LiveProvider` fetches from the
  browser, so the server's render always had a null snapshot and painted the
  card. `lib/data/initial-snapshot.ts` now fetches `/api/snapshot` from the
  API on the same machine while the root layout renders, bounded at 3s, and
  `MarketProvider` takes it as `initial` — the page arrives filled (0.12s with
  the API up, measured; the board is there with JavaScript off). The provider
  singleton is never seeded on the server, where it is shared by every
  request. API down or slow, the page renders as before and the browser
  fetches. Live pages are dynamic now (`ƒ`); the simulator stays static.
- **The card claimed there was nothing.** "No indexed blocks yet" was its
  text for every state but two, including a snapshot merely on its way. Only
  `never-indexed` says that now; the rest read "Loading live data".
- **Behind was reported as stalled.** A first sync reading months-old blocks
  as fast as the RPC allows is behind and working. `/api/health` now reports
  `catching-up` (200) for that, and `stalled` (503) only for an indexer that
  is not moving — no progress written for the threshold, or a block number
  unchanged in it while behind, which is what an RPC stuck on an old head
  looks like. Lags print as `129d`, not seconds. `monitor.sh` does not alert
  on `catching-up`.

### Still a loading card, and twenty CASHCATs

After the first-paint fix the site still opened on "Loading live data" —
the new card, so the new code — and the board listed CASHCAT twenty times.

**The snapshot was rebuilt on demand, constantly.** `/api/snapshot` was cached
for one second and rebuilt by whoever asked next, and every websocket forced
its own rebuild on every indexer tick — which, during a first sync, is nearly
every pass. With a few hundred pools a build takes seconds, so the database
rebuilt without pause and the web server's 3s render budget ran out. Now it
is stale-while-revalidate: the last finished snapshot is answered at once; a
tick marks it stale and ONE rebuild runs, its result pushed to every socket;
builds are spaced by at least the debounce and at least the last build's own
duration; a snapshot older than 15s is refreshed even without a tick (ticks
can be lost, and the lag figure is computed at build time); start warms it.
The web server also remembers the last good snapshot for up to 10 minutes
and serves it if the API is slow or restarting — safe only because the live
snapshot is public and identical for every visitor; P2's wallets will make
the portfolio per-visitor, and it must be stripped before that cache.
`deploy.sh` warms both caches before it returns.

**One row per token.** Every CASHCAT row had the same logo — the same token,
by address — in a different pool: v4 lets anyone open another pool for a
token at another fee tier or hook, and each pool has its own price, so the
same token showed five market caps. `lib/pools.ts` `tokenRows` makes the
boards one row per token, shown through its **deepest** pool, whole — every
figure from that one pool, so no yield is re-derived outside SQL (§4) — with
a "+N pools" pill. Deepest because a thin pool's price is the easiest to
push. The drawer lists all of the token's pools, deepest first, and any can
be opened. Grouped by address, so a copycat with the same name keeps its
own row; `pools.test.ts` holds that.

### A crawling indexer, 0.0% everywhere, and logos from the launchpads

ALFA: every token must have a logo — from DexScreener, CoinMarketCap,
CoinGecko, the launchpads, anywhere — and the 24h column must move.

**The indexer was crawling.** The site sat about 130 days behind for a day.
Three steps whose cost grows with the WHOLE dataset ran on every pass:
`rebuildPoolState` (every pool's last swap, every flow hour),
`classifyPools` (one UPDATE per pool) and `refreshSupplies`. A first sync is
thousands of passes, so each got slower as the tables grew. While
backfilling they now run at most once a minute, and every pass once caught
up; all three are recomputed from the tables, so §9's replay proof is
unchanged. `classifyPools` is set-based. Progress lines carry the pass time.

**0.0% was "unknown", displayed as "flat".** The 24h move compared with the
price at the last trade before 24h ago, and a pool with no such trade —
most new pools — got null, which the row mapping turned into 0. The
reference is now that price, or failing it the first trade inside the
window, valued at that hour's WETH/USD from `weth_usd_hourly`. Neither:
null, rendered as an em dash, and left out of the featured average.
`Pool.change24hPct` is `number | null`.

**Logos the launchpads put on chain.** Most rows are launchpad memecoins no
aggregator has a logo for. Their launchpads do, on chain, set at launch:
Pons tokens (`PonsV2LauncherToken`) answer `logo()`, Doppler tokens
(`DopplerERC20V1Factory`, used by Bankr) answer `tokenURI()` with IPFS
metadata whose `image` is the logo. `server/indexer/launchpad-logos.ts`
reads them first, before any aggregator — the token's own declaration,
which nobody else can add. What the real tokens showed set the rules:

- **IPFS cannot be handed to a browser.** ipfs.io, dweb.link and w3s.link
  answer 429 (ipfs.io is moving to a service worker); Filebase answers in
  0.4s, Pinata in 4-6s. So the indexer fetches each image once, through
  those two, and stores it: table `token_logos`, served at
  `/api/logo/:address` with a day's cache, `nosniff` and a sandboxing CSP,
  exempt from the rate limit (a board is dozens of badges), and an nginx
  location without `/api/`'s no-store.
- **Declared is not an image.** shockR's "image" is an Imgur HTML page;
  FITMONEY's metadata has none. Only bytes that are PNG, JPEG, GIF or WebP by
  their magic numbers are kept — never SVG, which from our origin could
  carry script.
- **PONS's logo is 7806px square, 2.4 MB.** Everything is shrunk with
  `sharp` to a 128px WebP: PONS to 2.6 KB, PINO 1.4 KB, 8CEN 1.3 KB.
- **The URL is a stranger's.** Creator links are fetched https-only, never
  to a loopback, private or link-local address, without redirects, capped
  at 5 MB and 12s. Gateways are ours and trusted further.

Run against the real chain and gateway: PINO, PONS and 8CEN stored, shockR,
FITMONEY and WETH correctly not. The migration makes every logo-less token
due again at deploy, so the new source does not wait out yesterday's
one-day retry.

**Impostors of Robinhood stock tokens get no logo.** The board showed the
fake "SPCX … Robinhood Token" (`0x9507…`) wearing Robinhood's feather — a
logo source carried it, because a copy's creator can register any image,
and matching by address cannot help when the address is the copy's own.
`config/robinhood-stocks.json` (all 212 tokens from the factory's
`Deployed` events, written by `build-stock-logos.py`) is the registry: a
token claiming the name ("Robinhood Token") or an official ticker of three
letters or more, and not in it, has its logo removed and is never looked
up. Short tickers (F, V, ON) are ordinary words and are not matched; a logo
a person curated is never removed. The curated list is also re-read every
five minutes now: AMD's company logo sat unapplied because the list was
only read on passes that found a new pool.

### Market cap on request, a guard that blocked itself, logos behind a page

ALFA asked for the boards sorted by highest market cap, and for logos on the
tokens still showing a monogram.

**Sorting by MC is a choice, not the default.** Each board keeps its §6
ranking (Trending by volume, Established by fee yield — §1) and gains a
`Volume | MC` / `Fee yield | MC` control, remembered per board in the
browser. Market cap here is supply × the pool's price, so a pool holding
five dollars sets a price five dollars can move — the live board once showed
a token at $2.27 trillion off exactly that. `byMarketCap` (`lib/pools.ts`)
ranks pools with at least `MC_RANK_MIN_DEPTH_USD` ($1K) of depth first;
thinner ones follow, their figure shown muted with a title saying why, and
tokens with no supply read come last. Where a narrow board would drop the MC
column, sorting by MC keeps it and drops the board's own metric instead — a
ranking by a figure nobody can see is not one.

**`deploy.sh` had not installed `nginx.conf` since its guard was added.** The guard
grepped `ssl_certificate` out of the file without skipping comments, so the
header prose ("ssl_certificate points at…") and the commented-out
`tidewall.live` stanza read as directives, and every deploy refused with
"missing: points, tidewall.live/…". The fourth diagnostic in this file to
invent a failure. The box therefore still ran the config `bootstrap.sh`
installed, without the `/api/logo/` location. Comments are stripped now, and
a config `nginx -t` rejects is replaced by the one it displaced rather than
left on disk for the next restart.

**Logos: what the monograms on the board actually were.** Checked token by
token against the chain, GeckoTerminal, DexScreener and Blockscout:

- **shockR** declares an image — an Imgur *page* saved to IPFS, which the
  sniffer rightly refused. The page carries `og:image`, the picture the
  creator uploaded. `launchpad-logos.ts` now follows a declared page to the
  image it names (`og:image`, then `twitter:image`, then
  `<link rel="image_src">`), one hop, under the same stranger-link rules.
- **SHERWOOD** on the board is one of dozens of contracts calling
  themselves Sherwood. The one with a logo everywhere (`0xD4DC…`, a Pons
  token) was created on 2026-08-10, after the indexer's current head. Its
  logo arrives when the sync reaches it; the copy keeps its mark. Its −100.0%
  is the shape of a pump and rug inside the window — $177K traded on a $30K
  token four hours old — not a pricing fault found in the arithmetic.
- **FITMONEY, RHDF** are Bankr launches whose metadata has no `image` at
  all; **CASHKITTEN** is a plain ERC-20. No source has a logo for any of
  them. They keep the address-derived mark: there is nothing true to show.

The sweep also ran in the wrong order and too slowly to see. It took the
never-looked-at tokens by all-time swaps, so a token four hours old and third
on Trending waited behind hundreds of quiet old ones, at 30 tokens every
30s. It now orders by the last 24 hours of indexed volume, every 15s.

### Highest FDV first, by default

ALFA asked again, after the toggle shipped, for the boards to open sorted by
FDV from highest to lowest. **That is now the default on both boards — ALFA's
call, over §1's "every ranking defaults to fee yield".** Each board's own
order (volume, fee yield) is the other half of the same control, and a
viewer who picks it keeps it.

The $1K depth floor went with it. On the live board it sent most memecoins
below the line — SHERWOOD, FITMONEY, RHDF, shockR, 8CEN all muted — so
"highest to lowest" stopped reading as one. The rule is a ratio now
(`MC_MAX_DEPTH_MULTIPLE`, 10,000×): a valuation more than ten thousand times
its pool's whole depth, or with depth unknown, follows the others. $20K on a
$300 pool is 67× and ranks; the $2.27T on $5 was 450 billion× and does not.

A migration makes every logo-less token due again, so tokens the launchpad
source had already answered "none" for — shockR among them — are asked again
with the page-following it gained, instead of waiting out a day.

### A day stuck at block 4,408,335

ALFA's status report read `up to block 4,408,335 · 130 days behind · pace not
measurable yet` at 14:05 and again at 15:05. Nothing had moved, probably for
a day; the "crawling indexer" fixed earlier was this, misdiagnosed.

**The cause, reproduced against the real chain.** At block 4,407,933 a launch
(`0x03ca8967…`, a hook pool against native ETH) was swapped 6,158 times in
1,000 blocks by bots. The configured window is 2,000 blocks; 2,000 blocks
there held more than the endpoint's 10,000-log cap, so `eth_getLogs` was
refused. The refusal handler halves the window — and floored the halving at
the configured 2,000. Every pass: refused at 2,000, "range now 2000", retry.
PM2 showed `online`, and each refused pass printed a progress line for a
block that did not move.

- **Refusals may now narrow below the configured window**, down to twice the
  32-block re-scan, which still moves the cursor. Ordinary narrowing stops at
  the learned ceiling rather than snapping back above it.
- **A log-count refusal is not a permanent cap.** "logs matched by query
  exceeds limit" is a fact about one stretch of chain, so after three calm
  passes the ceiling doubles again; only a refusal naming a block span (and
  no endpoint naming the count) caps the window for good. Classified on every
  endpoint's answer — the first line of the error is just "failed on all 4
  endpoints". `BUSY_LOGS` is 5,000, half the cap; at 2,000 it halved through
  every busy stretch to a few hundred blocks.
- **A refused pass prints no progress line**, and `indexer-status.mjs` now
  says `STUCK at block N` when several recent lines share one block, prints
  the last error, and says the indexer may be hung when it is behind with no
  progress lines at all — instead of "not measurable yet", which is what it
  printed for a day.

**Then the pass was slower than the chain.** Through that stretch nearly every
block carries a log, each needed its own `getBlock`, and the public endpoint
answers 429 after a few batches: 500 blocks took 45 seconds. Three changes:

- `getBlock` calls go as JSON-RPC batches of 100 (one HTTP request; the
  endpoint answers 100 in the time of one), a 429 is waited out and retried
  instead of failing the pass, and a batch an endpoint refuses falls back to
  groups of ten.
- **Timestamps from anchors** (`block-times.ts`): exact times only at every
  64th block. Arbitrum timestamps never go backwards, so when both anchors
  share a clock hour every block between does too — `pool_fee_hourly` stays
  exact — and within five minutes the block's time is interpolated, a pure
  function of its number, so §9's replays agree. Anything else is fetched
  itself. 2,481 blocks with logs cost 127 requests instead of 2,481.
- New tokens' metadata is read ten at a time, batched, not one by one.

Measured against the real chain from the sandbox (one reachable endpoint,
already rate-limiting it): the stuck stretch went from refused forever to
1.5 seconds a pass, the window regrew from 500 to 8,000 blocks after it.

**What it showed about the chain.** Head is now block 114.8 million, not the
62 million the comments elsewhere in this file assume, and sampled every 15
million blocks the PoolManager emits 650–5,500 logs per 1,000 blocks — about
**two hundred million events** from here to head. Indexing all of them
through public endpoints is days, and tens of gigabytes of `swap_events`. The
site's numbers need far less: trailing 7 days of swaps, plus every pool's
Initialize and liquidity history for depth. That decision is ALFA's and is
open below.

### Realtime: swaps for eight days, structure for the rest

ALFA's answer to the open question below: "data harus realtime" — the site
must show today. The indexer had moved 58,000 blocks after the fix above,
with 110 million to go.

**`SWAP_WINDOW_DAYS` (default 8).** A range whose last block is older than
that behind head is read for pool structure only — `eth_getLogs` filtered to
v4 `Initialize` and `ModifyLiquidity` and v3 `PoolCreated`, `Mint` and
`Burn` (`STRUCTURE_TOPICS`), about one log in three hundred. The window
itself is read in full, exactly as before. Every figure on the site looks
back at most seven days; the eighth is margin for the pass that straddles
the edge. 0 restores reading every swap, which §9's criterion is stated
against, and every replay test runs that way.

**TVL from positions, not from summed flows** (`rebuildPoolState`). Depth
used to be every signed swap and liquidity amount since a pool's creation,
summed — so knowing a pool's depth required its entire swap history. It is
now what the pool's liquidity holds at its latest price: each range's net
liquidity, turned into token amounts with the concentrated-liquidity
formulas. That needs every liquidity event and one price, and no history of
trades. A range with negative net liquidity is a removal without its deposit:
depth unknown, zero, em dash, as before. Double precision, because TVL is a
display figure and nothing exact is derived from it. `window.test.ts` holds
that a windowed sync produces the same pools, the same liquidity, the same
`pool_state` and byte-identical fee hours inside the window as a full read.

**Tokens recorded, not read.** Structure passes met five or six hundred new
pools per 50,000 blocks — over a million launches across the chain, most of
which never traded again — and reading four facts off each was most of a
pass (50 s). They are recorded with decimals −1 and read the first time a
swap touches their pool (`hydrateTokens`); nothing values, prices, looks up
a logo for or reads the supply of a token whose decimals are unknown.
Structure events are dated by interpolating between the pass's two ends:
what they date — a pool's creation months ago — needs days, not seconds.

**Only live pools on the boards and in the snapshot.** A pool nobody traded
shows 0.0%, $0, $0 — true, and ALFA's screenshot was a wall of it. Trending
lists what traded in the last 24 hours, Established what earned fees in the
last 7 days with 7 days of record, and the snapshot values only pools that
traded in the window (`pools_live`), because valuing a million dead launches
on every snapshot would take minutes. Filtered per pool before grouping, so a
token's row is its deepest active pool.

Measured on the real chain from block 4,466,000: structure passes at 50,000
blocks in about 2.5 seconds, against 52 seconds before lazy tokens. Roughly
an hour and a half to cross the rest of history, then the eight-day window in
full — **while it crosses history the boards are nearly empty**, because the
cursor's chain time is months ago and nothing in its trailing window was
read; they fill as the window phase reaches today.

The status report also prints the log's last lines when it finds no progress
lines, instead of only saying so.

### $1.76 trillion, and 0.0% everywhere: the first hour of the window

The first deploy of the swap window showed TVL $1,759,545,824,659, Fees 24h
$0, Volume 24h $0, and 0.0% on every row. One cause behind all three: the
cursor had moved into the structure phase, so liquidity ran months ahead of
the last swap the indexer had read.

- **TVL** valued positions opened in those months at prices from before
  them. The position maths was checked against summed flows on real pools
  and agrees; the inputs came from two different moments. `rebuildPoolState`
  now counts liquidity only up to the last swap read (the *horizon*), and a
  pool whose positions imply more of a token than its total supply has depth
  unknown — a backstop for hook bookkeeping and anything else that is not a
  pool's real holdings.
- **24h figures** were measured back from the cursor, a day in which no swap
  had been read: "a day nobody was looking at, reported as a day nobody
  traded". The snapshot's moment is now the last swap read, so during the
  structure phase the site shows its last real day, labelled by the lag in
  the top bar, and moves forward when the window phase begins.

And it was slower on the box than measured here (about 5,000 blocks a
second). Every pass loaded every pool's id, fee tier and last price — on a
chain heading for a million launches, a full scan per pass that grows with
each one. `loadKnownPools`, `loadPriceState` and `loadFeeTiers` now load only
the pools a pass's events touch. Structure passes also skip aggregation
entirely (nothing they write changes a figure), publish a snapshot tick at
most every 30 seconds instead of every pass, and widen until half the
endpoint's log cap rather than a quarter, up to ten times the configured
maximum. Measured on the real chain: 37,000 blocks a second, flat.

`indexer-status.mjs` looks for the log where PM2 actually writes it: on the
box `/var/log/balast/indexer.out.log` did not exist, and the report said "no
progress lines" while the indexer was moving.

### The Tide header

ALFA asked for a premium X header. `x-header-tide-{glass,gold}` is the inside
of the well at banner scale: the tide running across it is the mark's own
tide line — the same cubic, stretched to a 396px period — with the swell
behind it half a period out of phase, the sea tilted so the tide rises left
to right, and the light behind the lockup lying on the water as broken
glints. Generated by `build-brand.py` like every other file, rendered at 1500
and 3000 (2.3 MB, under X's 5 MB), and offered on `/brand`. The lockup is
centred and nothing that must be read is in the lower left, where the avatar
sits, or within 60px of the top and bottom, which phones crop — checked
against a mock of the X profile at desktop and phone widths. Unlike the other
headers it carries no address, at ALFA's request: the profile's link field
does that job.
`build-brand-png.mjs` takes name filters now (`… x-header-tide`), so one
asset renders without re-rendering sixty.

### Still open

- **Defensive registrations**: `tidewall.live` first; the stanza for it is in
  `deploy/nginx.conf`, commented out.
- **The token**: unchanged from §13 — the recommendation is still to ship
  without one.
- **The §12 questions**: the six-hours-per-tick simulator clock needs sign-off,
  and `/positions`' forward-looking *Est. fee yield* still needs a keep, cap or
  drop.
