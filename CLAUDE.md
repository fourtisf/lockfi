# Balast — engineering handoff

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
- **Domain and token.** ~~`Depth` is the working name.~~ **Decided: the product is `Balast`, on `balast.xyz`.** The token is still open — see §12.

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

## 18. The anchor that was already indexed

Recorded because the site sat on **"looking for the USD anchor"** on every
page while the pool it was looking for was in its own tables.

### Uniswap v4 has no WETH

A v4 pool's currencies are a `PoolKey`, not a token pair, and a pool that
trades ether holds it **natively**: `currency0` is `address(0)`, not the
wrapper. §2 gives aeWETH's address and §4.3 says everything prices through
ether, so every currency comparison in the indexer was written against that
one address — the anchor search, `findAnchorPool`, the USD `CASE` in each of
the three aggregation steps, and the snapshot's listing filter.

So an ETH/USDG pool — the likeliest anchor this chain has — was indexed,
counted, and invisible to all four. The failure then cascaded exactly as it
was designed to: no anchor means `buildSnapshot` returns null (§14: hold
nothing rather than invent something), and null means all five pages show the
waiting panel. One unmatched address blanked the site.

The consequence was never limited to the anchor. Every ETH-quoted pool on
this chain was excluded from the listing by the same comparison, so pinning
`USDG_ADDRESS` by hand would have produced a working anchor and a still-empty
board.

`lib/chain.ts` now owns both spellings, and `isEtherSql` is the one SQL
comparison, exported for the same reason `tradedSide` is: the places that
answer "which side is ether" disagreed once already. Treating the two as one
asset is a statement about the wrapper rather than a convenience — aeWETH
mints one token per ether deposited, so pricing a native pool through the
wrapped anchor is exact, not an approximation. They stay separate rows in
`tokens`: different addresses hold different balances, and merging them would
make a pool's reserves unreconstructable from its own events.

Ether is also now **read** rather than probed. There is no contract at
`address(0)`, so `readToken` failed all four calls and fell back to a
truncated-address symbol and — the part that would have hidden this — to 18
decimals, which happens to be right. It answers from `CHAIN.nativeCurrency`
instead, with no supply, because ether's is not an ERC20 read and a fully
diluted value for it would be invented (§7). It is also excluded from the
supply-refresh queue, which is ordered nulls-first: left in, it would have
held one of the few slots a pass has, for ever.

`server/indexer/native-eth.test.ts` is the proof. It builds the same fixture
chain out of native-ether pools and runs the real poller, the real SQL and
the real snapshot over it; against the pre-fix comparison four of its six
assertions fail, starting with the anchor. The older suites could not have
caught this: their fixture is built from wrapped pools, so it proved the
wrapped path and assumed the native one did not exist.

### The waiting page could not tell waiting from stuck

"Looking for the USD anchor" is the same sentence in two situations that call
for opposite actions. A first sync that has not reached the pools yet needs
someone to wait. A sync that is caught up and found no ETH/USDG pool needs
someone to look at the addresses, and waiting is the one thing that cannot
help it. The page said the sentence and not the fact that separates them.

`/api/health` now carries the chain head, blocks behind, percentage and a
`syncing` flag, and the waiting page draws them. The head is recorded on the
cursor by the poller each pass (`indexer_cursors.head_block`, one migration),
so answering costs no RPC call and the endpoint cannot itself be the thing
that is stuck. `deploy/doctor.sh` learned the same distinction — it had no
case for `no-anchor` or `misconfigured` at all, and reported the one state
the box was actually in as "unexpected health body".

### A hardcoded pair of decimals, used by nothing

`PriceAnchors` carried `wethDecimals: 18` and `usdgDecimals: 6`. Every ratio
in the aggregation reads decimals from the `tokens` rows of the pool it is
pricing, which is the only place they are true, so these two were dead — and
a dead field that looks authoritative is one somebody eventually believes.
Had anything read them, a USDG with 18 decimals would have put every dollar
figure on the site out by twelve orders of magnitude. Removed.

### What this does not settle

Whether this chain's pools are native, wrapped, or both is now irrelevant to
the code — all three work — but the §2 addresses are **still unverified on
the explorer**, and a wrong `poolManager` produces the same blank site with a
different cause. `npm run verify:chain` answers that, and `npm run
find:tokens` lists what the chain actually trades (native ether included, now
that it is named rather than printed as an unknown address).

Unchanged and still open: `V3_FACTORY` and `LAUNCHPAD_HOOKS` (§14), the
six-hours-per-tick simulator clock and `/positions`'s forward-looking *Est.
fee yield* (§12), and the protocol fee's immutable cap before P2 deploys.

### Postscript: the deploy that deployed the wrong branch, and two tools that lied

The first deploy after §18 changed nothing on the site, and the reason is
worth keeping. `deploy.sh` on the box hardcoded the previous session's
branch, so `bash deploy.sh` fetched, built and reloaded that branch and
reported success. The version of `deploy.sh` that reads `BRANCH` from the
environment only helps once it is on disk — so the first deploy of any new
branch is a manual `git checkout` followed by `deploy.sh`, and the doc says
so now rather than assuming.

The same box then showed what the first sync actually looks like: block
3,079,887 of ~62.6 million, chain time seventy days behind head, 665 pools
and 44k swaps already in the tables. That is the `syncing` case §18 added
the progress bar for, and it means the anchor may simply not have been
reached yet — waiting is correct, and the native-ether fix is what makes the
wait end when it is.

Two operator tools then invented failures. `verify:chain` and `find:tokens`
each asked every endpoint for 5,000 blocks of logs, were refused by all four
— the caps differ and none are announced — gave up on the first refusal, and
reported "no events in the last 0 blocks" as a fact about the PoolManager
address. `verify:chain` also still failed on an unset `USDG_ADDRESS`, a
value the indexer had been discovering for itself since §17, and told the
operator not to start the sync. `deploy/doctor.sh` did the same. A
diagnostic that reports its own limitation as the patient's fault is the
worst kind (§17), and both did.

`server/chain/logs.ts` is now the one backwards walk, and it narrows on a
refusal the way the poller does — the same range, retried at half the width,
nothing skipped — with a test against a capped fake endpoint. Both scripts
use it, and a walk that is refused even at the floor is reported as an
endpoint problem, never as an address problem.

And a scan from head can only ever see pools *created* in the window it
scans; the anchor pool was created once, months ago. `npm run tokens:indexed`
reads the indexer's own tables instead — every token it has met, ranked the
way the anchor search ranks — and prints exactly the resolution the indexer
and the API would make. It touches no endpoint, so it works when every public
RPC is refusing, which on this chain is the normal state.

### The first real snapshot: TVL $0 everywhere, and a page that crashed on it

The branch reached the box, the anchor resolved, and the site rendered for
the first time against real data — with `TOTAL FEES $805`, `TVL $0`, and
`/pools` on the error boundary: *Reduce of empty array with no initial
value*. Three faults, each only visible with a late anchor.

**Flow was skipped along with the priced tables.** `pool_flow_hourly` is
token amounts, not dollars, and needs no anchor; but the poller skipped the
whole aggregation while the anchor was unknown. On the real chain that was
the first few million blocks. When the anchor finally resolved, the bounded
rebuild staged flow for the discovering pass's hours only, so every pool's
reserves were its recent swaps minus the mint that funded it: negative,
therefore *unknown depth* (§14), therefore TVL $0 on every row and in the
top bar. Flow is staged every pass now, anchor or not.

**"Retroactive" was bounded.** §17 says the pass that discovers USDG prices
history; the rebuild it ran was scoped to that pass's hours, so it did not.
A change of anchor — including none to found, and including a restart — now
runs one unbounded rebuild of every priced table. Once per anchor, and the
restart case is deliberate: it makes a repair on a live box a redeploy, not
a migration.

Neither was catchable by the existing fixtures, whose anchor pool is created
at block 1 — the anchor is known from the first pass and nothing is ever
skipped. `server/indexer/late-anchor.test.ts` creates it two thirds of the
way through the chain, syncs in windows small enough that several passes
complete before it exists, and asserts two things: every pool's depth is
known, and the rows match — as text — a sync that had the address configured
from the start. Against the old poller the first fails with exactly the box's
symptom (`expected 0 to be greater than 0`) and the flow table is missing
half its hours.

**The page crashed on an honest empty.** `MiniCards` ranked pools with
`reduce` and no initial value: an empty list throws, and the "highest fee
yield" card filters to pools with seven days of fees, which on a young chain
is none. A card that should have said "not yet" took the whole page to the
error boundary. Both rankings go through a `maxBy` that returns null, and
null renders a quiet card with the reason.

Smaller: the top bar read `5937929s behind`, which is honest and unreadable;
it reads `68d 17h behind` now (§7 wants the lag shown, not encoded).

### "Stalled" was measured on the wrong clock

With the site finally rendering, the deploy summary's last line read
`STALLED, 5876521s of chain time behind` — for an indexer that was writing
a pass every second. Health judged a stall by **chain lag**: how old the
newest indexed block is. During a first sync that is seventy days, by
definition, while nothing is wrong; and the monitor would have alerted the
whole forty hours, which is how a monitor gets muted.

Liveness is a different clock: wall seconds since the poller last wrote the
cursor (`idleSeconds`). `stalled` is that clock past the threshold — the
process is dead or stuck — and nothing else. Chain lag stays what it was,
the honest figure in the top bar (§7), and two states carry it without
paging anyone: `syncing` (writing, far from head — the first sync, with its
percentage) and `behind` (writing, near head in blocks, but the newest block
is older than the threshold — catching up). Both answer **200** with
`ok: false`; 503 is reserved for states a person has to act on. A pass that
finds head has not moved still touches the cursor, so a quiet chain cannot
read as a dead poller.

`pm2-logrotate` in the process list is deliberate (§15, log rotation): a
first sync logs every pass for forty hours, and without rotation the first
symptom of that is a full disk.

### The first board: dust, `0000…0000`, and three figures that claimed too much

With the boards rendering, the listing showed what a young chain's
PoolManager actually contains, and four things needed saying.

**The listing bar.** 2,343 pools, most of them launchpad dust with a few
dollars of depth, sorted by volume — the pools anyone would stake into were
buried. `LISTING_MIN_FDV_USD` (env, default $1M, `set-env.sh` to tune) is
the bar for a pool's token to be listed. Below it a pool stays indexed and
counted in `/api/health`, and reappears the moment it crosses. The
ether/USDG market is exempt: ether has no supply to read, so its FDV is zero
by construction (§15), not by size. The bar is applied in the snapshot query,
so the header still sums the pools it shows (§12). **This is ALFA's number**;
$1M is a first guess at "big", not a measurement.

**`0000…0000 / Unknown token` as the most-traded market.** That row is ether.
It was written by the version of `readToken` that did not know address(0)
(§18), and `tokens` rows are written once and left alone — right for a
contract's facts, wrong for a row that was wrong. `repairNativeToken` asserts
the constants on every start.

**Three claims about unknowns.** `$0 MC` for ether, where §15 says an em
dash; `▲ +0.0%` in green for a pool with no price a day ago — the anchor was
younger than a day in chain time, so *every* row said it — where the honest
figure is a dash in no colour; and the top bar clipping `$3,801,09x` to
`$3,801,09`, a number that is simply wrong. `change24hPct` is nullable now
and rendered as a dash, the headline average is weighted over the pools
whose change is known, and headline figures go compact past $1M.

**The panel said "no indexed blocks" over a line saying which block.** The
first page load can arrive before the first snapshot does; with the indexer
priced and syncing, the copy now says the snapshot is loading rather than
that nothing has been indexed.

**Logos.** Every token has its derived mark; real logos come only from a
token list (§4, §17). Robinhood Chain has none, and this session cannot
verify whether any aggregator carries the chain, so nothing is wired to a
guessed URL. With the bar in place the listed set is small enough to curate:
`config/tokens.json`, Uniswap token-list shape, `logoURI` only, picked up on
the indexer's next pass.

### One row per token, and a fixture that had been lying about NVDA

The first filtered board listed CASHCAT twice and the ether market twice.
A token on this chain routinely has several pools — fee tiers, hooked
variants — and the query returned one row per pool. The board is a token
listing (§6, and every row of the prototype), so a token's row is now its
deepest pool: the one the Stake button opens and the one a yield figure
honestly describes. Shallower pools stay indexed and unlisted, and the
header sums the rows it shows (§12).

Writing the test for it found a fixture bug that had been there since P1.
The fixture derives a log's tx hash from `(block, logIndex)`, rows are keyed
by exactly that (§4.1), and every pool's seed logs sat at indices 0 and 1 of
its init block — so two pools created in block 1 collided, and the second
pool's funding mint was silently dropped. **NVDA/WETH in the default chain
has had unknown depth all along**, and the suites tolerated it because the
yield-state assertions accept `insufficient` where they should not have had
to. Seed logs sit at index 1000+ now, above anything a block's swap counter
reaches. Nothing in the indexer changed; the fixture simply stopped
contradicting the chain it stands in for.

The `0000…0000 / Unknown token` row on that board is the ether market,
still carrying the row an earlier `readToken` wrote. `repairNativeToken`
runs on the indexer's first pass after a restart and logs when it does; the
pass is preceded by the deployment-block bisection and the full rebuild, so
the label lags a deploy by a minute or two.

### "Loading the snapshot" on every refresh, and logos from outside

**Every refresh waited on the expensive query.** Two things multiplied.
The API answered `/api/snapshot` from its cache only when the cache was
younger than the stream debounce — one second — and every websocket client
forced its own rebuild on every indexer tick, which during a first sync is
every second. So the query that prices, sums and sparklines every pool ran
continuously, page loads queued behind it, and the panel sat on screen for
as long as the queue was. And the query did all of that work for every pool
before applying the listing bar: 2,600 pools of correlated lookups for a
board of fifty.

The bar is a `listed` CTE now, in front of every per-pool CTE. And the
snapshot is served **stale-while-revalidate**: the last build is answered
immediately, a rebuild starts in the background at most once per
`SNAPSHOT_MIN_REBUILD_MS` (five seconds), and a socket is pushed only when
the revision changed. The first request after a start is the only one that
waits. A few seconds of staleness is invisible next to the lag the top bar
already shows (§7).

**Logos.** §4 permits them from outside, and the list in `config/tokens.json`
was never going to cover a launchpad chain. `server/indexer/logo-sources.ts`
asks CoinGecko, DexScreener and (with `CMC_API_KEY`) CoinMarketCap for one
image URL per token and nothing else — not price, not supply, not decimals.
One token every `LOGO_LOOKUP_MS`, listed tokens first, a miss not asked
again for a week (`logo_checked_at`, one migration), a source that does not
know this chain disabling itself and saying so once. CoinGecko's platform id
is discovered from its platform list by chainId 4663 rather than guessed.

**What is not verified:** the session that wrote this could not reach any
of those services, so the parsers are written to the documented shapes and
treat anything else as "not found". Whether CoinGecko or DexScreener has
this chain at all is a fact the indexer will discover on the first pass and
log. The token list remains the override, and the derived mark remains what
renders when nothing else does. Launchpad sources (Pons, Bags, Bottom.fun)
need an endpoint from someone who knows them — each is one function here.

### Depth, and a second typeface on the table

ALFA looked at the first real board and asked for something that reads as
premium. Two answers, one shipped and one offered.

**Shipped: materials.** Every surface is now lit from above — a one-pixel
highlight on the top edge, a faint gradient down the first third, a shadow
that falls away below — and the page has a soft vignette behind it. Token
badges have a sheen and an inner shadow, so a derived mark reads as a coin
rather than a sticker; the top bar is glass; the brand button has a gradient
and a glow. All of it is neutral light on neutral surfaces: the colour rule
(§5) is untouched, and green still means brand, positive, or active. Badges
paint their colour with `backgroundColor` now, because the `background`
shorthand wiped the sheen.

**Offered, not shipped: Inter for UI text.** §5 says JetBrains Mono
throughout, and the mono-everywhere look is the "terminal" in the terminal
aesthetic. `html.sans` is an opt-in class that sets labels, names and copy
in Inter and keeps every figure in tabular mono so columns still line up.
Both were rendered locally at the width ALFA actually sees — 1280 CSS px,
which is a 1920 display at 150% — and sent as screenshots. Enabling it is
one class on `<html>`; it stays off until ALFA picks.

Verified with Playwright against the built site and simulated data. On the
live site the largest difference is not CSS at all: monogram badges and
flat sparklines are what a first sync looks like, and real logos are what
change the feel most. See the logo-sources note above for where those come
from and what is still unverified.


---

## 19. The Journal: a light design system, chosen over §5

Added when ALFA looked at the first real board and asked for something that
reads as premium. §5's dark terminal was the approved prototype; ALFA chose
a different direction from a set of sketches (`design/directions/`, artboard
**B3 · Journal**), and this section records what that changed and what it
deliberately did not.

### What moved

**Paper, not a terminal.** Warm off-white page, white cards, ink-dark text,
one green. The tokens in `app/globals.css` are the whole palette; the names
§5 introduced (`--bg`, `--panel`, `--fg`, `--ac`, `--red`, and so on) are
kept so that no component changed a variable name, only its value. Every
foreground colour was measured against the paper rather than picked by eye:
`--fg-3`, the quietest text that carries a label, is 4.4:1; the accent is
4.3:1 on paper and 4.8:1 on white; `--fg-4` is decorative only.

**Three typefaces, each with one job.** Instrument Serif for headlines and
the rank numerals, DM Sans for everything read, IBM Plex Mono for everything
counted. The `.num` class now sets the mono face as well as tabular figures,
so a number is a number wherever it appears. §5's "JetBrains Mono
throughout" is the one rule of §5 this replaces outright.

**Navigation across the top.** The fixed sidebar and the 64px icon rail are
gone; `components/shell/TopNav.tsx` holds the brand, the five pages, search,
the freshness chip and the wallet. Below 900px it takes two rows, stops
being sticky, and the links row scrolls inside itself — the page never
scrolls sideways, which the shell test still asserts at 360px.

**A masthead on every page.** `components/shell/Masthead.tsx`: eyebrow,
serif headline, a line of copy, and the four global figures as a labelled
facts column on the right — Positions, Value locked, Paid to LPs all time,
ETH — over one heavy rule. §5 put those four figures in the top bar as
unlabelled pills; here they have room for their names. On `/pools` the
headline *is* the day's numbers: how many markets are listed and what they
paid in fees over the last 24 hours, both summed from the rows beneath it
(§12), and the dateline is chain time — now less the indexer's lag — because
a dateline is a claim about when (§7).

**One leaderboard, two rankings.** The prototype's Trending and Established
boards are one list with a facet: *By volume* ranks everything, *By fee
yield* ranks only pools with seven days of history (§10's assumption, kept).
The rows are an ordered list rather than a table — a leaderboard is exactly
what `<ol>` means — with a large serif rank, a 40px mark, the symbol over a
line of FDV, depth and name, the day's fees, a 24h pill and a wide fee
sparkline. The FLIP reorder, the value flash, the leader highlight and the
Stake button on hover are unchanged in behaviour and re-asserted by the
same e2e tests against the new elements. The featured card and the two
mini cards are gone; their figures are in the masthead.

**The column priorities changed with the columns.** §5's drop order (Vol
24h and Depth at 1780px, Age at 1560px) described a nine-column table.
The row now loses the sparkline below 900px, tightens below 640px, and
loses the rank numeral below 420px — the order says the rank. Depth moved
into the row's second line rather than out of the row.

**Token marks on paper.** `lib/token-mark.ts` draws a pastel disc with a
dark ink of the same hue, and the test walks all 360 hues: 5.06:1 at worst.
The badge no longer uses the provider's `logoColor` for a monogram — that
colour is a stored value derived by the previous palette, so a live row can
carry a disc the current ink was never measured against. It stays as the
backdrop under a real logo, where it does no harm.

### What did not move

The colour rule. Green still means brand, a positive number or an active
control, and red still means a negative number and nothing else; the pills,
segmented controls and the bin chart were rebuilt inside that rule. Every
honest-numbers rule in §7, with their tests. The `DataProvider` boundary —
no component reads data any differently. The waiting page, the drawer and
its focus trap, `prefers-reduced-motion`, and no horizontal overflow at
360px.

### Open, for ALFA

- **The default ranking is by volume**, as the chosen artboard shows. §1
  says every ranking defaults to fee yield. On the live chain the fee-yield
  facet is empty until a listed pool has seven days of fees, so a fee-yield
  default would open on an empty board for the first week; after that it
  is one click away. If §1's default is what is wanted, it is one line.
- **The favicon and the OG card** still carry the dark mark on black. They
  are brand assets, not the page, and were left alone until the mark itself
  is settled (§13).
- The §12 questions — the simulator's six-hours-per-tick clock and
  `/positions`'s *Est. fee yield* — and the §14 inputs remain open.

### First look at the live Journal: empties, logos, and where the project talks

ALFA looked at the deployed page and asked three things: why so much is
still empty, why the tokens still have no logos, and for X, Telegram and a
"CA · coming soon" line.

**What is empty, and why it stays honest.** Positions, vaults, stakes and
the portfolio are empty because the contracts that create them are P2 (§8);
nothing on the site invents them. What was wrong was how the pages said so:
an empty vault grid read "No vault matches — try a ticker", the portfolio
read "$0 · +0.0% all time" and "Best week so far", and the router promised
"Est. first route: 0.00 WETH → +$0 depth" and drew a rising projection from
nothing. Each of those is a claim about a history that does not exist (§7).
They now say what is true: no vaults yet and why, nothing staked yet, no
positions yet, dashes with a caption where a figure would be a claim, and a
projection only once a fee source is accruing. The ether row said "no supply
read", which is operator-speak for a fact about ether — it has no contract
and no supply — and now says "native asset".

**Logos: the chain's own explorer, asked first.** The three aggregators in
`logo-sources.ts` were written blind (§18) and there was still no way to
tell, from the box, what they answered. Two changes:

- `blockscout()` asks the explorer the ethereum-lists/chains registry names
  for chainId 4663 — `robinhoodchain.blockscout.com`, `EXPLORER_URL` in
  `lib/chain.ts`, `EXPLORER_API_URL` to override — for `/api/v2/tokens/{addr}`
  and reads `icon_url`, nothing else. It is native to this chain, so it is
  first in `LOGO_SOURCES`. A token the explorer has no icon for falls
  through to the aggregators as before.
- `npm run logos:probe` asks every configured source about the top listed
  tokens (or the addresses given) and prints, per source, the HTTP status
  it saw and the URL it yielded — or the error. It writes nothing. This is
  the answer to "why no logos" that the poller's log could not give.

Two consequences carried through. A miss is silent for a week
(`logo_checked_at`), which is right for a source that said no and wrong for
a source that did not exist when the question was asked — so the poller now
clears the mark for every logo-less token on restart, and a deploy becomes
the moment the new source gets its turn, one token per `LOGO_LOOKUP_MS`.
And ether, which no aggregator can be asked about by address, is in
`config/tokens.json` with an image this site serves itself
(`public/tokens/eth.svg`); that file is now the default `TOKEN_LIST_URL`,
so a box that never set the variable still gets ether right.

None of this could be verified from the session that wrote it: the sandbox
reaches GitHub and Google Fonts and nothing else. The explorer URL is the
registry's and the API shape is Blockscout's documented one; the probe
exists precisely so the first run on the box says what is true.

**X, Telegram, and the contract address.** `lib/site.ts` reads
`NEXT_PUBLIC_X_URL`, `NEXT_PUBLIC_TELEGRAM_URL` and `NEXT_PUBLIC_TOKEN_CA`
at build time. The icons sit in the navigation and, labelled, in the
footer; an unset one is an unlinked icon that says "coming soon" on hover
rather than a link to nowhere. The contract address is a fifth row in the
masthead facts on every page and a line in the footer, reading
"CA · coming soon" until it is set — with a tooltip saying that any address
circulating before it appears there is not ours, because a site that asks
people to connect a wallet should say so. Set them with `deploy/set-env.sh`
and deploy; Next.js inlines them when it builds.

### What the first probe said, and what it changed

`npm run logos:probe` ran on the box and answered the question. Three
things, two of them mine:

- **The explorer answered 403 in seventy milliseconds** — every token, every
  time. That is an edge rule refusing the client, not an answer about the
  token: Node's `fetch` identifies itself as `node`, which is what such rules
  look for. Every request now carries a named agent
  (`Mozilla/5.0 (compatible; Balast/1.0; +https://balast.xyz)`), and there is
  a test that it does. If the explorer still refuses, it is refusing servers
  as a matter of policy and the probe will show it.
- **CoinGecko: one 404 on the platform list, then 429 on everything.** The
  source asked for the platform list on every token because a failed answer
  was treated as transient, and the public tier allows a handful of calls a
  minute. A failed platform fetch now waits ten minutes; a 429 pauses the
  source for ninety seconds. One refusal costs one token, not the board.
- **DexScreener answered 200 and yielded nothing**, which is a shape
  question the old probe could not answer. The probe now prints every
  request's status, content type and the first line of the body, so the
  next run says whether the chain is unknown to it or the image is simply
  missing.

And the probe's own choice of tokens showed a fourth thing: it asked about
GLTCHT, USDG and bbqUSDGturbo — the largest FDVs in the table, which on a
launchpad chain are dust with absurd supplies — while ETH, VIRTUAL and Index
sat on the board without logos. The poller asked in the same order.
`logoCandidates()` now ranks by the pools' 24h volume, the board's own
order, and the probe uses the same function, so what it prints is exactly
what the poller asks about next.

### The stalled indexer, and logos that no longer wait on it

`logos:status` on the box answered the question the probe could not:
**"0 asked about — indexer cursor last written 9344s ago."** Every source
was answering, and no token was asked, because the lookup ran inside the
indexer's pass and the indexer had not finished a pass in two and a half
hours. Two faults, both structural.

**A restart cost a full rebuild, and deploys came faster than rebuilds.**
§18 made the unbounded rebuild of every priced table run on a change of
anchor *and on every restart* — "a cheap way to make a repair a no-op".
Cheap on a fixture. On the real tables, after 4.4 million blocks, it takes
longer than the gap between two deploys, and every deploy restarted it from
the beginning: a day of deploys was a day in which no pass wrote the cursor,
health said `stalled`, and nothing downstream moved. The anchor the tables
were last rebuilt for is now remembered (`indexer_state`, one migration),
so a restart with the same anchor does the bounded rebuild every pass does.
`npm run aggregates:rebuild` forgets the marker when a change to the
aggregation SQL needs the full one. The full rebuild also logs each step's
time, because a silent hour is indistinguishable from a hang.

**Logos are a process of their own.** `balast-logos` (`server/logos/main.ts`,
in the PM2 list, the doctor and the monitor) reads the token list, asks the
sources about one token every `LOGO_LOOKUP_MS`, records what it finds and
nudges the API. It re-asks every logo-less token on start, board first. The
poller no longer knows logos exist. A decoration must never wait on a block,
and it did.

Unverified from here, as before: whether the indexer on the box is stuck in
that rebuild or dead for another reason is in `pm2 logs balast-indexer`,
which the deploy summary and the doctor both point at.

### Two more sources: tokenised stocks, and GeckoTerminal

With logos flowing (Index and VIRTUAL were the first), the board showed
what the aggregators do not carry: Robinhood's tokenised stocks and the
launchpad coins.

**Tokenised stocks are knowable from the ticker.** "AMD • Robinhood Token"
names its kind, and a ticker is unique on its exchange, so the `tickers`
source maps such a token's symbol to a public repository of ticker icons
(nvstly/icons on GitHub, one PNG per ticker, verified for the board's
stocks; SPY, GLD, SLV and SPCX are not there). Only a token whose name says
"Robinhood Token" is looked up this way — a launchpad coin calling itself
GME must not wear GameStop's mark. Those icons are drawn for a dark theme,
so the badge paints them on an ink coin, inset.

**GeckoTerminal** for the rest: keyless, and the aggregator that reads what
launchpads publish. Its id for this chain is discovered from its network
list by name (`GECKOTERMINAL_NETWORK` pins it), a chain it does not list
disables the source once and audibly, and "missing.png" is read as none.
Unverified from here — the sandbox cannot reach it — and written to the
documented shape, as the others were; the probe says what it answers.

The default order is explorer, tickers, geckoterminal, dexscreener,
coingecko, coinmarketcap: chain-native first, the rate-limited one last.

### The token's own word: on-chain metadata

With the aggregators answering, the board still had launchpad coins none
of them carried (VLAD, MARIAN). One source is left that needs nobody to
have listed the token: its own contract. Launchpads that follow ERC-7572
publish `contractURI()`, home-grown ones `metadataURI()`, `image()`,
`imageUrl()` or `logoURI()` — a URI pointing at JSON with an `image`, or
at the image itself. The `onchain` source tries each (one `eth_call`; a
contract without the function reverts), resolves `ipfs://` through a
gateway (`IPFS_GATEWAY`), decodes an inline `data:` JSON in place, and
records only an https image URL.

It fetches metadata only over https and never from a bare IP or localhost.
A contract can name any host it likes and this process runs on the box next
to the API; the test pins that refusal. Whether this chain's launchpads
publish anything the source can read is, as with the others, a fact the
probe reports.

### An empty disc is not a logo

Four rows on the board — SPCX, AMD, TSLA, NVDA — showed a saturated disc
with nothing in it: a logo URL had been recorded, and the browser could
not fetch it. A source had named an image that answers only to its own
site, or over http, or with an html page. Three rules now stand between a
source's answer and the board:

- **A logo is recorded only once it has been seen to load** from the box:
  one GET, 2xx, and an image content type when the server states one. A
  source whose image does not load is logged and the next source gets its
  turn; the check is tested against a 404 and against `text/html`.
- **https only.** An http image on an https page is blocked by the browser
  silently, which is exactly the empty disc.
- **The badge falls back to the monogram** when the image errors, or is
  found complete with no pixels after mount — an image that fails before
  React attaches never fires the error event, so both are checked. Under a
  logo with a transparent background sits the pastel mark, not the stored
  brand colour from the old palette.

On start the logo process checks every logo already on record and forgets
the ones that do not load, so the tokens are asked about again under the
new rules.

### Logos served from here

The empty discs became monograms, and AMD and TSLA — whose ticker icons
exist and load — stayed monograms. That is the same fault one step later: a
URL on record that loads from the box and not from a browser, so the load
check passes, the source that would have worked never gets its turn, and
the page shows nothing. Two clients, two answers, and no way to reconcile
them from either side.

So there is one client now. `GET /api/logo/{address}` fetches the URL on
record the way the logo process did when it checked it, holds the bytes in
memory for a day, and answers 404 for anything that is not an image; the
badge asks that route and nothing else. "The box can load it" and "the page
shows it" are the same test. Only URLs on record are fetched — it is not an
open proxy — and the route is outside the rate limit, because a hundred
badges on one page load is normal, not a loop. `logos:status` now lists
the board's rows with the URL on record and whether it loads from the box;
`logos:probe` prints the URL on record beside each token.

### The issuer's bird, and a wallet dialog

**Every tokenised stock wore Robinhood's feather.** The explorer answers
with the issuer's mark for every one of its stock tokens — and it was asked
first, so NVDA, TSLA and AMD were the same bird. `tickers` now outranks the
explorer for a "Robinhood Token", and on start the logo process replaces
whatever such a token has on record with its ticker icon when one exists
and loads. The ETFs have no ticker icon in the repository and keep the
feather: Robinhood's mark on Robinhood's token is not wrong, just not what
a person wanted to see. SpaceX is the next subsection.

**Connect wallet is a dialog now** (`components/shell/WalletModal.tsx`,
`lib/wallet.ts`). EIP-6963: every installed extension announces itself with
a name, an icon and a provider, so the dialog lists what the person has —
MetaMask, Rabby, Coinbase Wallet — rather than one button that grabs
`window.ethereum` and hopes. Connecting asks for an account, then for
Robinhood Chain (switch, or add and switch; declining the switch is not an
error, nothing here signs), and remembers the wallet so a reload reconnects
quietly through `eth_accounts`. Connected, the button shows the address and
the dialog offers copy, explorer and disconnect. It traps focus and closes
on Escape like the drawer.

The list is a floor, not a filter: MetaMask, Rabby, Coinbase Wallet,
Phantom, OKX, Trust and Brave are always shown — installed ones with
Connect, the rest with an Install link — and any other wallet that announces
itself is added. WalletConnect, for a phone by QR, appears once
`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set (a free project id from
cloud.reown.com); its provider is loaded only when chosen, because it is a
large one, and a session survives a reload. Until P2 nothing is signed from
any of them.

### A mark of our own, and wallets wearing theirs

**SPCX still wore the feather** after the ticker icons landed, and it
always would have: SpaceX is on no exchange, so no ticker repository
carries it, the `tickers` source answered null, and the explorer's answer
stood. The fix is the same shape as ether's (§19, *First look*): a mark
this site serves itself. `OWN_STOCK_MARKS` in `logo-sources.ts` maps a
"Robinhood Token" ticker to a file under `public/tokens/`, reached as an
absolute https URL on the canonical site so the same load check, the same
https rule and the same logo proxy apply as to any other source's answer.
The `tickers` source answers it before asking the repository, and
`upgradeStockLogos` replaces the feather with it on the logo process's
next start — once: a mark that is already on record is skipped rather
than rewritten and counted on every restart, which the query alone would
have done, since the URL is not under the repository's base. The SVG is
inset (`viewBox -4 -4 32 32`) because the badge is a circle and the
wordmark's ends sat outside it at full width.

Adding another private company is one line in that map and one file; the
token's address is not needed, which is why this is not an entry in
`config/tokens.json`.

**Every wallet in the dialog has its logo.** A wallet that is installed
announces its icon (EIP-6963); one that is not announces nothing, so its
row showed a letter on a coloured disc, and so did WalletConnect's. Each
entry on the known list now carries `icon`, a file under `public/wallets/`
(the marks RainbowKit ships, MIT), and `walletIcon()` picks the announced
icon when there is one and the known mark otherwise — an extension that
announces an empty icon gets the same fallback. A test asserts every file
exists, because a missing one is a broken image on the one dialog that
asks people to trust the site.

### Banners for X

Seven images under `brand/social/`, each an artboard in the Journal system:
`social.css` copies the tokens from `app/globals.css` rather than restyling
them, the brand lockup is the navigation's (ink mark, serif wordmark), the
masthead's eyebrow, serif headline with one italic green phrase, lede,
heavy rule and footer line are the site's, and the illustrations are the
site's own components drawn at banner scale: the leaderboard's serif rank
numerals, the masthead's facts column, the stake stream bar, the bin chart
in its bid-ask shape with the token side in the accent and the ether side
in the soft tint. Six are 1600 × 900 for a post (introduction, Stakes,
Positions, Router, honest numbers, contract address) and one is the
1500 × 500 profile header. `npm run brand:social` renders them at 2× with
Playwright, waiting for the three faces to load.

Two rules carried over from the site. **No number a reader could take as a
yield.** The stream shows a day of seven and the bin chart shows weights,
not dollars; §7 applies to a banner as much as to a row. **No handle.**
The owner asked that neither an X nor a Telegram handle be written on
them, so the only address on any banner is `balast.xyz`, and the
contract-address banner says what the site's masthead says: there is no
token yet, and any address circulating before it appears there is not
ours.

### X, and no Telegram

The account is **@Balastdotfi**. `lib/site.ts` carries the link as the
default rather than waiting on an environment variable, so a plain deploy
shows it; `NEXT_PUBLIC_X_URL` still overrides it. `X_HANDLE` is derived
from the link for the page's card metadata, so the two cannot disagree.
Telegram was removed at the owner's request: the icon, the variable and
the second row of the footer. `brand/social/COPY.md` holds the posts that
go with the banners, one per image, each under 280 characters and written
inside §7: no yield figure, no "APY", nothing the contracts cannot keep
yet, and the contract-address warning pinned before anything else goes out.

### The X link that read HANDLE_ANDA, and a logo on paper

**The live site linked to `x.com/HANDLE_ANDA`.** The code carried the real
account as the default and read `NEXT_PUBLIC_X_URL` over it; the box's
`.env` held a placeholder typed in by hand, and the placeholder won. A fact
this public is now a constant in `lib/site.ts`, the variable is gone from
`.env.example`, and nothing reads it — a stale value in `.env` can no
longer reach the page. `X_HANDLE` is still derived from the constant.

**The brand on paper.** Every file in `brand/` was the prototype's mark on
black, so the avatar on X and the link preview disagreed with the paper
site behind them. `brand/journal/` is the same mark and the navigation's
pairing — ink mark, "Balast" in Instrument Serif — drawn as outlines by
`scripts/build-brand-journal.py`: full-bleed paper icons for avatars (ink,
brand green, and paper-on-ink for dark grounds), a squircle, three lockups,
and a 1200 × 630 card on paper that now serves as `/og-card.png`. The paper
is the page's own: `--bg` lit faintly from the centre, `--raise` at the
corners. In the lockup the mark's ink stands 1.1 × the cap height, centred
on it, a touch larger than the navigation sets it, because a logo on its
own carries its weight in the mark. The three faces are fetched from the
google/fonts repository into an ignored `.fonts` folder on first run.

**The favicon is paper too.** The owner pointed at the tab, still showing
the green mark on black beside a paper site, and asked for the paper icon.
`app/icon.svg` — the file Next.js serves as `/icon.svg`, so also the icon
WalletConnect shows a phone — is now written by the same script: the
full-bleed cut on flat paper, because a gradient is invisible at 16px. It
was checked at 16 and 32px on a light and a dark tab strip; the ink mark
carries it on both. The dark favicon files stay in `brand/` for anyone who
wants them.

---

## 20. Mainnet through Uniswap, not through contracts of our own

ALFA's call, in four words: *lempar semua ke Uniswap*. No contract of
Balast's own goes to mainnet; every on-chain action runs through Uniswap
v4's deployed, audited contracts, and Balast's surface is the calldata it
builds and the honesty of what it shows. This section records what that
means product by product, what is built, and what it does not cover.

### The addresses are verified now

Uniswap's own registry — `sdks/sdk-core/src/addresses.ts` and
`universal-router-sdk/src/utils/constants.ts` in github.com/Uniswap/sdks —
lists Robinhood Chain (chainId 4663). Every v4 address in §2 matches it
byte for byte: PoolManager, StateView, V4Quoter, and the Universal Router
(v2.1.1, created at block 18127). It also supplied the two the handoff did
not have: the **PositionManager**, `0x58daec3116aae6D93017bAAea7749052E8a04fA7`,
and the **v3 factory**, `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, which
§14 had been waiting on and the indexer now follows by default.

### Positions: built, through PositionManager

`/positions` mints for real. The shape builder's inputs — a deposit in the
quote, a range as a percentage around the token's price, a bin count and
a shape — become one `modifyLiquidities` transaction: one `MINT_POSITION`
per bin, each with the liquidity its weight of the deposit buys at the
live price, then `SETTLE_PAIR` to pay for all of them and, for an ether
pool, `SWEEP` to return the unspent ether. Each bin is a position NFT in
the person's wallet; Balast holds nothing at any point.

The pieces, all in `lib/v4/`:

- **Tick and liquidity maths.** `tick-math.ts` moved here from the
  indexer (which still imports it), and `liquidity.ts` sizes a bin by
  value: at sqrt price P one unit of liquidity in a range is worth
  `amount1 + amount0·P²` in currency1, linear in liquidity, so the
  liquidity for a share of the deposit is one division. Every amount that
  reaches a transaction is bigint from the sqrt price the chain reported.
- **The encoder.** `actions.ts` carries the action ids from
  `Actions.sol` and the parameter layouts from `PositionManager
  ._handleAction`. Its test builds the same actions with Uniswap's own
  `V4Planner` and asserts the bytes are identical, and `poolId` is
  asserted against the SDK's `Pool.getPoolId`. The SDK is a dev
  dependency only: it carries ethers v5 and would double the page.
- **The plan.** `mint.ts` maps the token's percent range onto pool ticks
  (mirrored when the token is currency1, whose price is the pool's
  inverse), splits the range into whole tick spacings as evenly as the
  arithmetic allows, reverses the shape's weights when the pool runs the
  other way, and caps every position at its own share plus one percent.
- **The flow.** `flow.ts` reads slot0 from StateView, balances from the
  tokens, and the two allowances PositionManager's `_pay` needs — the
  token's to Permit2 and Permit2's to PositionManager — then
  `eth_estimateGas` runs the exact calldata against the node before the
  wallet is asked to sign. A mint that would revert is refused before any
  signature, with the reason in words.

Two honest limits, both on screen. **The deposit is two-sided for now.**
A bin that straddles the price needs both currencies, and without a swap
the wallet has to hold both; the builder shows exactly how much of each
the plan takes and refuses if the wallet is short, naming the shortfall.
The single-token zap — a Universal Router swap of the token side in the
same transaction — is the next slice. **The price is the chain's, not the
indexer's.** The builder polls slot0 every twelve seconds and plans
against it; the indexer, which can be days behind (§7), supplies only the
trailing-yield estimate, labelled as before.

Nothing sends from simulated data: a pool with no on-chain key gets the
old button and a toast that says so.

### Stakes: what the model makes of them, for ALFA

Under "everything to Uniswap" a Stake is a position the person holds —
one full-range mint into the pool, fees accruing in the position, a
`DECREASE_LIQUIDITY` of zero to collect them, `BURN_POSITION` to leave.
Three things §3.3 promised do not survive that: the seven-day stream
(a vault's behaviour), the anti-snipe property the stream gave, and the
protocol fee taken at harvest. **Without a vault there is no protocol
revenue.** That is a product decision, not an engineering one, and
`/stakes` is unchanged until ALFA makes it: keep the honest empties, or
rebuild the page as self-custodied full-range positions with the
consequence above written on it.

### Router: cannot be delegated

A fee stream routed into permanent depth on a TWAP is logic no Uniswap
contract performs. `BalastRouter` stays P4 and stays a contract, with the
audit that implies; the page keeps its copy and its honest empty.

### Portfolio: next

PositionManager is an ERC721. The indexer will follow its `Transfer`
logs into the `positions` table and read each token's key and liquidity,
so `/portfolio` can show what a wallet holds with in-range status and
collected fees. Not built in this slice.

### What "fully audited" does and does not mean here

Uniswap's contracts are audited; Balast deploys none. What Balast can
still get wrong is the calldata, and that is guarded three ways: the
encoder is byte-compared with Uniswap's SDK, every plan is dry-run by the
node before signing, and each position's take is capped at its own
share. What this session could not do is run a fork test against the
real chain — the sandbox reaches no RPC — so **the first mint on the live
site should be a small one**, watched on the explorer, before anything is
announced. A pool with a hook can refuse outside liquidity; the dry run
catches that and says so, and `LAUNCHPAD_HOOKS` (§14) still needs
setting so such pools are not offered at all.

### The backfill that ran at the speed of the chain

The board on the box read *68d 2h behind* one night and *68d 15h behind*
the next noon: thirteen hours of wall time, thirteen hours of lag gained,
no net progress at all. The indexer was processing chain time at roughly
the rate the chain produced it, so nothing launched in the last two months
— every Pons token the owner asked for among them — had ever been read.

The pass was doing four things that scale with the size of the tables or
the busyness of the chain rather than with the window:

- **One `getBlock` per block that carried a log**, sixteen at a time. On a
  launchpad chain most blocks carry a log, so a 2000-block window was
  hundreds of sequential round trips to a public endpoint. `eth_getLogs`
  is now called raw, because a recent node stamps `blockTimestamp` on
  every log and viem's formatter drops it; what is still missing is
  fetched fifty blocks to one JSON-RPC batch, and an endpoint that refuses
  a batch is found out once and asked one call at a time from then on.
- **`rebuildPoolState` for every pool, every pass** — a `DISTINCT ON` over
  every pool's whole swap history and a sum over all its flow. It is
  scoped to the pools the window touched, with every pool redone once the
  pass reaches head and every sixtieth pass while it is far from it,
  because untouched pools still carry the anchor's price.
- **`classifyPools` walking every pool with a query each, every pass.**
  Once per run for every pool; after that, only the pools a pass found.
- **Four RPC calls per new token**, one token at a time. Missing tokens go
  through Multicall3 fifty at a time, with the old per-token path as the
  fallback when a multicall itself fails. `loadPriceState` is scoped to
  the batch's pools, and supplies are re-read every twentieth pass rather
  than every pass while backfilling.

None of it changes a row. §9's adaptive-versus-fixed comparison still
holds byte for byte, and the late-anchor and native-ether suites pass
unchanged.

**Every pass now says where its time went** — `logs`, `times`, `tokens`,
`ingest`, `rebuild`, and blocks per second — in the log line, and the last
pass is kept in `indexer_state` and shown by `/api/health` under
`indexed.lastPass`. The number to watch is blocks per second: at 2000-block
windows the chain makes ~10 blocks a second, so anything under that is a
backfill that will never finish, and the stage that dominates the line is
where to look next.

What this does not solve: a launchpad's **pre-graduation** trading happens
through its hook, not through plain pool swaps, and the indexer only
decodes what it knows. `LAUNCHPAD_HOOKS` (§14) still needs the hook
addresses; post-graduation pools appear on their own once the backfill
reaches them.

### The original logos: the issuer's own icon outranks the ticker repository

The board showed SPCX in Robinhood's own style — the SpaceX mark on the
issuer's lime — beside AMD and TSLA wearing white-on-ink icons from the
ticker repository. The owner asked for the originals. The history: the
explorer once answered one feather for every stock token, so the ticker
icon was made to outrank it (§19); the explorer has since begun serving
real per-stock icons, and the override was now hiding them.

Three changes, all in `logo-sources.ts` and the logo process's start:

- **The explorer refuses a generic icon.** `isGenericLogo` says an icon
  is the issuer's, not the token's, when it is on a remembered list or
  already on record for two other tokens. A picture shared by many tokens
  describes none of them. The explorer is asked first again
  (`LOGO_SOURCES` default), and the process logs a line if a box's `.env`
  still pins the old order.
- **Shared icons are forgotten on start.** `forgetSharedLogos` clears any
  URL three or more tokens carry (own-site marks exempt: ether and its
  wrapper share one file), remembers it under `generic_logo_urls` in
  `indexer_state`, and lets the tokens be asked again under the new rule.
- **Stocks are reconciled, not upgraded.** `reconcileStockLogos` replaces
  `upgradeStockLogos`: for every "Robinhood Token", the explorer's own
  specific icon if it has one, else the ticker icon, else this site's mark
  — whatever is on record, so a ticker icon gives way to an original that
  has since appeared. Tested for all three outcomes and for the no-change
  second run.

Unchanged: a token no source knows (GUH on that board) keeps its derived
mark, and `npm run logos:probe -- GUH` is how to see which sources were
asked and what they answered.

### Volume on the row, and a launchpad's own page as a source

**The board ranked by a number it did not show.** Every row now carries
the day's volume beside the day's fees — `vol · 24h`, then `fees · 24h` —
in both facets. Fees stay the headline (§1: they are what an LP earns;
volume is what produced them), so below 640px it is the volume column
that drops, after the sparkline. Verified at 1280, 800 and 390 with no
horizontal overflow.

**Pons.** The owner asked for the launchpad's tokens. Two facts first:
PONS graduated 63 days ago and the indexer is 68 days behind, so nothing
from that launchpad has been read yet — they arrive when the backfill
does, and the throughput work above is what makes that hours rather than
never. Graduated tokens trade in ordinary v4 pools and need nothing
special; pre-graduation trading goes through the launchpad's hook, which
still needs its address (`LAUNCHPAD_HOOKS`, §14).

What could be built now is the launchpad as a source. `launchpadPage`
asks a launchpad's own site for the token's page — `{base}/{address}`,
Pons at `ponsfamily.com/launchpad` — and reads the token image out of the
page's data: an `image`-like field in the JSON the app ships with the page,
escaped or not, and `og:image` only when it names an image file, because
on such sites `og:image` is as often a generated share card as the logo.
A source that answers is the launchpad the token came from, so the token
row records `launchpad` (metadata, which §4 allows from outside). `pons`
sits in `LOGO_SOURCES` after `onchain`; `PONS_LAUNCHPAD_URL` moves it.
Unverified from here, as every source was: the sandbox reaches no
launchpad, the parser accepts the common shapes, and `npm run logos:probe`
prints what the real page answers.

### The stall, read off the log: a floor the refusal could not pass

The first log after the throughput deploy said it in one line, repeated:
`endpoint refused 2000 blocks (getLogs(4408256-4410255) failed on all 4
endpoints) — range now 2000`. Every endpoint refused a 2000-block window
at that stretch of the chain, the refusal path narrowed to
`max(floor, width / 2)`, and the floor was 2000. So the same range was
asked for on every pass, refused on every pass, and the cursor sat at
block 4,408,287 — at two blocks a second, which is the re-scan of the
last 32 moving nowhere. The throughput work was right and beside the
point: no pass ever got past the fetch.

The floor (`INDEXER_BLOCK_RANGE`) is a preference for following head. A
refused width is a fact about the endpoint, and the window now narrows
past the floor on a refusal, to a hard minimum of 64 blocks — twice the
reorg depth, so a pass still advances — and never widens above what the
endpoints have shown they accept. The log line carries the endpoint's own
reason now rather than only the label, and a refused pass reports the
time the refused fetch took. There is a test that a cap below the floor
still lets a sync finish.

### The feather under a URL per token

The reconciliation above made the explorer's icon win for the stocks —
and every stock came back wearing the feather, SPCX included. What had
looked like a SpaceX icon in Robinhood's style was Robinhood's mark; and
the explorer serves it under a **different URL for every token**, so the
generic check, which compared URLs, saw nothing shared.

The bytes are what is compared now. `imageDigest` hashes the picture a
URL serves; the start-up audit that already fetches every recorded logo
keeps the hashes; `forgetSharedLogos` groups tokens by hash, forgets any
picture three or more wear, and remembers the hash as generic; and the
explorer source digests a candidate icon and refuses one whose bytes are
on that list. With that in place the reconciliation lands where it was
meant to: a stock the explorer has a real picture for wears it, AMD and
TSLA fall to their ticker icons, and SPCX to this site's own SpaceX mark.

GUH remains a monogram: no source answers for it. The Pons source is
asked from this deploy on; failing that, the token's address and an
image URL in `config/tokens.json` is the one honest way to give it one.


### Several windows a pass

With the floor fixed the box moved, and the first log said how fast:
`window 250`, five to nine seconds a pass, 27–45 blocks a second. Of a
seven-second pass the fetch was under two; the rest was the anchor query,
the aggregate rebuild, the cursor write — cost that does not scale with
the window at all. A 250-block window paid the whole of it for 250 blocks.

So a pass fetches **several windows at once** now (`INDEXER_CONCURRENCY`,
default 6): contiguous windows of the current width, one `eth_getLogs`
each, sent together, and the fixed cost paid once for all of them. The
log line says so — `window 1,500 = 6×250` — and blocks per second is the
figure to read. The windows are settled independently: the ones that
arrived ahead of the first refusal are ingested and the cursor moves to
the end of them, so a refused burst costs the refused windows and not
the pass. A later window that also arrived is fetched again next pass
rather than ingested out of order; the cursor is one number and it never
skips.

A refusal now says which of two things it is. A 429 or a timeout with
several windows in flight is the burst being too much: the concurrency
halves and the window stays, because narrowing the window for a rate
limit is learning the wrong lesson and keeping it. A rate limit with one
window in flight changes nothing, and the main loop waits a beat before
asking again. Anything else — "more than N results", "range too large" —
is the width, and narrows it as before. The busy threshold that halves a
dense window is judged per window, since the endpoint's cap is on one
request rather than on the pass.

And the ceiling is no longer only ever lowered. The 250 the box sat at
was learned in a dense stretch of the chain — "more than N results" — and
is far too low for the empty stretch after it, and a ceiling that can
only come down would have held the sync at 250 blocks a window for the
remaining fifty-eight million. After forty clean passes the poller asks
for more: first the concurrency back toward its configured value, then
the window's ceiling toward `INDEXER_MAX_BLOCK_RANGE`, only while the
window is pinned at it. A probe that is accepted is followed by another
next pass, so climbing back is a run of doublings rather than one every
forty passes; a probe that is refused costs one pass in forty and resets
the count. The tests cover both directions, and the §9 comparison is run
again in its hardest form yet: six windows a pass against one, with a
rate limit partway that truncates a pass to the windows that arrived,
byte for byte.

Two smaller things from the same log. The anchor line was printed every
pass, because the note it was compared against carries the anchor pool's
swap count, which changes every pass while syncing; it is compared on the
address now. And the v3 backfill — a newly discovered pool's own logs
from its creation block — was time the pass line did not account for; it
is a stage of its own in the line when it happened.

### The deploy that could not fetch

The deploy after the change above stopped on its first line: `error:
insufficient permission for adding an object to repository database
.git/objects`, then `fatal: unpack-objects failed`, and the box stayed on
the previous commit while the operator read a log that looked like
nothing had changed. The cause is §18's own instruction: the first deploy
of a new branch is a manual `git checkout`, and it was run as root, so the
object directories git wrote are root's — and every later fetch runs as
the app user, which cannot write into them.

`deploy.sh` now repairs ownership before it fetches: anything under the
tree not owned by the app user is chowned, and the count is printed with
the likely reason. Only what is wrong, not the whole tree, because
`node_modules` is large and chowning a tree that is already right is a
slow no-op. `doctor.sh` names the same fault ahead of its own fetch, which
had been swallowing it. The repair only helps once the new script is on
disk, so this one time the operator runs the chown by hand first — the
same shape as the wrong-branch deploy in §18, and the same lesson: a fix
in `deploy.sh` reaches the box one deploy after the fault.

### Depth, and a market cap from the chain

ALFA looked at a row reading `FDV $302.8K · depth $95.0K` and asked what
depth meant against so small an FDV, and for a market cap.

**Depth is the pool, FDV is the token.** Depth is the pool's liquidity
valued in dollars, both sides — what a swap trades against and what a
stake is a share of. FDV is the token's whole supply at its price. They
are independent, and for a launchpad token a depth that is a third of the
FDV is ordinary: a large part of the supply sits in the pool that
launched it. A depth of `—` is unknown depth (§14): the pool's own events
do not reconcile to a positive reserve, which on a young chain usually
means a hook doing its own accounting — and `LAUNCHPAD_HOOKS` (§14) is
still the missing input that would let the indexer say so.

**Market cap.** §15 recorded why the figure was FDV: a contract reports
its total supply and nothing about who holds it. That was too
conservative. A contract also answers `balanceOf`, and three holders are
tokens that cannot circulate by construction: the zero address, the
`dEaD` address, and the token contract itself. Total supply less those
is a circulating figure from on-chain reads alone, which §4 allows. It
is read in the same multicall as the supply (`tokens.non_circulating`,
one migration), and `pool_state.circ_mc_usd` is that figure at the
traded side's price beside the FDV. The row reads `MC` and shows `FDV`
next to it only when the two differ by more than a percent, because for
a token with nothing burned they are one number; a token whose holdings
have not been read yet shows the FDV alone, labelled; ether stays
`native asset`. The tooltip says what circulating means here and what it
cannot know: vesting and treasury holdings are indistinguishable on
chain, so the figure can overstate, never understate.

The supply refresh changed shape to make the backlog short. It reads
fifty tokens a pass through Multicall3 rather than five one call at a
time, every fifth pass while backfilling, ordered so that tokens with a
supply and no holdings read come first and the largest pools' tokens
among them — the board gains its market caps within minutes of the
deploy, the rest of the table over the following hour.

Smaller, from the same screenshot: a 24h change that rounds to `0.0%`
was drawn as `▼ −0.0%` in red — a negative sign on a number that is not
negative, and red means one thing here (§5). It is `0.0%` in the neutral
colour now.

Still ALFA's: the default ranking. The row that prompted the question
was third by volume with fees of $54, under a row with sixteen times the
fees; §1 says fee yield is the headline and volume is trivially washed.
`By fees · 24h` as the default facet is one line, offered and not
changed.

### "Liquidity", by ALFA's word, and the refresh in the board's order

ALFA looked at the first board with market caps on it and asked two
things: for the rows still reading `FDV` to read `MC`, and whether depth
meant liquidity — and if so, to call it that.

**Liquidity.** Yes: the figure is the pool's liquidity in dollars, both
sides. §13 kept "depth" as the domain term when the brand moved; the
owner has now chosen the plainer word for the page, so every user-facing
line says *liquidity* — the row, the drawer, the router's copy and
projection, the two mastheads. Identifiers are unchanged (`tvlUsd`,
`*DepthUsd`, `reorgDepth`, `design/depth.html`), and so are the banners
under `brand/social/`, which are rendered images and carry the old word
until they are rendered again.

**The rows that still read FDV** were the tokens whose non-circulating
holdings had not been read yet — the migration's backlog, drained fifty
tokens a refresh. VIRTUAL had flipped and world had not, and the reason
was the order: the backlog was worked largest-FDV-first, which on a
launchpad chain is dust with absurd supplies (§19 found the same for
logos). The refresh now takes the board's own order — the pools' 24h
volume, the same ranking `logoCandidates()` uses — so the listed rows
are the first fifty read, and the label flips on the board within a
refresh of the deploy. The `FDV` state remains for a token whose
holdings are genuinely unread, because labelling the whole supply as
market cap is the overstatement §15 refused; it is now a state that
lasts a minute rather than an hour.

### Ranked by market cap, by the owner's call

ALFA's words: *kita harus ambil dari MC paling gede biar project gede* —
the board should lead with the largest projects. So the default facet is
**By market cap**; volume and fee yield stay as the second and third.
This sets aside §1's "every ranking defaults to fee yield" and §19's
open question on the volume default, and it is the owner's decision to
set aside.

The key is the market cap, or the fully diluted figure while a token's
holdings are still unread, which is the same magnitude and the row says
which. A token with neither — ether above all, whose market cap is not a
figure this site can derive (§18) — follows the ranked rows, deepest
first. So the ETH market sits after the ranked tokens under this facet,
which is honest and will look odd; the ETH filter and the volume facet
both put it back in front.

A market-cap ranking has a failure mode the volume ranking did not: a
market cap is circulating supply times a price, and a price from a pool
with a few dollars in it supports nothing. On a launchpad chain such a
token can carry a supply that makes its "market cap" the largest on the
board. So there is a **liquidity floor** on the listing now
(`LISTING_MIN_LIQUIDITY_USD`, default $10,000, `set-env.sh` to tune)
beside the FDV bar — applied only to a *known* liquidity, so a pool
whose depth the indexer cannot reconstruct (§14) is still listed with
its dash, and the ether/USDG market is exempt as before. Like the FDV
bar, **this is ALFA's number**: $10K is a first guess at "a real pool",
not a measurement, and the first board under this ranking is what says
whether it is high enough.

Asked in the same message: what *fees · 24h* is. It is the swap fees
traders paid in that pool over the last 24 hours of chain time — the
pool's volume times its fee tier — and it is the pool's income, which
the LPs own. That is why §1 makes it the headline: volume is what
traders did, fees are what LPs earned.

### The first board by market cap: trillions, $0, and no liquidity

The failure mode the previous section named arrived on the first board:
catAI at `FDV $2,481.99B`, GLTCHT at `$1,759.51B`, sato at `$360.81M` —
each with `vol · 24h $0`, `fees · 24h $0`, `liquidity —`, and no logo.
The liquidity floor did not catch them because their liquidity was
*unknown* rather than small, and unknown was exempt so that GUH and Index
(hooked pools with real trading) stayed listed. The exemption was too
wide: a pool with unknown liquidity, a supply, and no trade at all is a
dead pool, and on a launchpad chain a dead pool with an absurd supply is
the largest "market cap" on the board.

Unknown liquidity is now forgiven only for a pool that has traded in the
yield window (seven days of chain time). A dead pool with unknown
liquidity is unlisted whatever its supply; GUH and Index, which trade,
stay. The test builds exactly that board — a token with a trillion
supply, a pool the indexer cannot reconstruct, no fee hours — asserts it
is unlisted, adds one trade, and asserts it appears with its liquidity
still honestly unknown.

Two questions asked in the same message, answered on the board rather
than in this file: `vol · 24h` is the dollar value of the swaps traded in
that pool over the last 24 hours of chain time, and `$0` means nobody
traded there — which is why such a row has no fees and no logo either:
no source lists a token nobody trades, and the logo process asks about
the board's rows by volume, so a $0 row is asked about last.

### The empties, and the sign Uniswap v4 puts on a swap

ALFA looked at the board ranked by market cap — USDe first with
`liquidity —`, WIF and BRODIE the same, the drawer reading `Pool
liquidity $0` and `Your share of pool 100.00%` — and asked for the empty
data to be filled in. Most of it had one cause, and it was mine.

**Uniswap v4's Swap event carries the trader's deltas, not the pool's.**
v4-core `Pool.sol` builds the emitted `swapDelta` from
`amountSpecified - amountSpecifiedRemaining`, which for an exact input is
negative, and `amountCalculated`, the positive output. v3's Swap is the
other way round: the pool's deltas, input positive. The decoder stored v4
rows as emitted, and everything downstream reads the pool's signs: the
reserves are the sum of the rows, the fee side is the positive one, the
volume is the positive one. So for every v4 pool the swaps were summed
backwards — each trade *removed* its input from the reserves and *added*
its output — and reserves fell with volume until they went negative,
which is unknown depth (§14), which is `liquidity —` on exactly the pools
that trade. The fee was attributed to the token the trader received. The
pools with a known liquidity were the v3 pools and the v4 pools that had
barely traded.

The fixture had been encoding v4 swaps with the pool's signs, so the
suites — §9's replay proof included — proved the indexer against a
convention the chain does not use. `swapLog` now takes the pool's signs
and encodes the trader's, as the PoolManager does; the decoder negates
v4 on the way in, so there is one convention in the tables and nothing
below the decoder changed. `server/indexer/v4-sign.test.ts` decodes a
log built the chain's way and asserts the pool's signs come out.

**The rows already on the box** were written wrong and are repaired by
a migration rather than a re-sync, which would have cost the days the
first sync took. It flips the v4 rows, re-derives the fee side, and
recomputes the fee from the true input: exactly for a static-fee pool,
whose swap fee is the pool's; by proportion for a dynamic-fee pool
(flag `0x800000`), whose per-swap fee the row does not keep — within a
wei of a fresh sync, and said so here rather than left to be discovered
by §9's comparison. v3 rows are untouched. The migration then forgets
the rebuilt-anchor marker, so the indexer's first pass after the deploy
rebuilds every priced table from the corrected rows — a full rebuild,
during which no pass completes (§19); the site shows the last snapshot
until it does. The test runs the migration's own statements against
rows stored the old way and asserts all three cases.

**The drawer** said `$0` for an unknown liquidity and `100.00%` for a
share of it — dividing by zero and calling the result a fact (§7). Both
are dashes now, the weekly estimate with them, and the `Max 4.18` beside
the amount, a prototype figure nothing on the live site backs, is gone.

What stays empty after this, honestly: fee yield until a pool has seven
days of fees in the window; the market cap for the tokens whose holdings
have not been read yet, which the refresh reaches in the board's order;
and the Stakes, Positions and Portfolio pages, which are the §20
decisions and not the indexer's.

### A dollar is not a project

ALFA asked why USDe and syrupUSDG were on the board at all. Ranked by
market cap they led it: a stablecoin's market cap is how much of it was
minted or bridged, which says nothing about a project, and on this
ranking it sits above every project there is.

Stablecoins get no row of their own now. The rule is the symbol —
`isStablecoinSymbol` in `lib/chain.ts`: `USD` anywhere in it, which
catches USDC, USDT, USDe and syrupUSDG, plus the few dollars that do not
carry the letters (DAI, FRAX, GHO, LUSD, MIM, TUSD, PYUSD) and the euro
pair — applied in the listing CTE on the traded side, with the same rule
as SQL kept beside it. USDG remains the quote that prices the whole
site; its pools stay indexed; the ether market is untouched.
`LISTING_STABLECOINS=true` lists them again. The test builds a
USDe/WETH pool with a $327M figure and asserts it is unlisted by
default, listed on request, and that the ether market stays either way.

### The stake that did nothing, a fee that did not exist, and the address

ALFA's message had four parts: SPCX wearing the feather again, fees and
volume that looked too small to be real, no contract address anywhere,
and *make it mainnet*.

**SPCX.** The explorer answers the issuer's feather for a private company
in that company's colour, under bytes unique to the token, so the
shared-icon rule could not call it generic and the explorer's answer
stood for a third time. A mark curated in `OWN_STOCK_MARKS` exists
because no source has the real one, so it now outranks every source in
the reconciliation. Tested against an explorer that answers a unique
icon.

**Fees and volume.** Three things, one of them the section before this:
the figures are chain time, sixty-eight days ago, while the sync catches
up; the v4 sign fault shrank every v4 pool's volume to the trader's
output side, and the deploy carrying the fix had not run; and a row like
WIF, `$44` of volume against `$43` of fees, is a pool whose hook takes
about 98% of every trade as its "fee" — a launchpad curve, not a market
anyone should add liquidity to.

**Which is why hooked pools are not offered any more.** `isStakeable`
used to say a hook we did not recognise was stakeable, the safe
direction for a listing (§14) and the wrong one the moment staking is
real (§20). A pool with a hook is offered only when the hook is on
`STAKEABLE_HOOKS`, an allowlist someone has to fill after looking; the
drawer says so, and names the hook. `LAUNCHPAD_HOOKS` still names the
launchpad on the row.

**The drawer lied twice.** Its Stake button showed a toast — *Staked ·
fees start streaming next harvest* — and did nothing, which on mainnet
is a fabrication; and it disclosed a *10% of fees earned* that no
contract takes, because under §20 there is no vault. Now: **Stake full
range** hands the pool to the builder with `?pool=…&range=full`, where
the real flow mints one full-range position through PositionManager to
the wallet after the node has dry-run it; the disclosure §7 asks for is
made and is honest — *Balast fee: none, every fee is yours; custody:
your wallet, as an NFT; lockup: none*; and the amount field with its
prototype `Max 4.18` is gone, since the builder reads the wallet.
**Without a vault there is no protocol revenue**, which §20 recorded as
ALFA's decision to make and which *make it mainnet* makes: this is what
mainnet through Uniswap means, and the drawer now says it to the person
about to sign.

**Full range in the builder.** `planMint` takes `fullRange`: the lowest
to the highest usable tick for the pool's spacing, one position, the
shape and bin inputs ignored; the builder has the tick box, hides the
shape, range and bin fields under it, estimates at the pool's own yield
with no concentration, and reads `?pool=` and `?range=full` from the
URL inside a Suspense boundary. Tested: one position from −887,220 to
887,220 at spacing 60, both sides taken.

**The contract address** is in the drawer under the header, in full,
with Copy and an explorer link; ether says it has no contract. A site
that asks people to trust a token should show them which token.

### The NFT, and where the volume comes from

ALFA asked two things off the drawer and the board: what *your wallet, as
an NFT* means, and why NVDA's and WIF's volume is tiny against their
market caps when DexScreener shows something else — where does the
volume come from.

**The NFT.** Uniswap represents every liquidity position as an ERC-721
token minted by the PositionManager: the NFT *is* the position — its
range, its liquidity, the fees it has earned — and whoever holds it is
the only one who can withdraw. Staking here mints that NFT to the
person's wallet; Balast holds nothing. The drawer says so in those words
now, with a *Balast holds: nothing* line beside custody.

**The volume** is the sum of the swaps in that pool over the 24 hours of
chain time before the last block indexed, valued in dollars, from the
chain and nothing else (§4). Three reasons it disagreed with DexScreener:

- **Sixty-eight days.** The last block indexed was July's; DexScreener
  shows today. Until the sync reaches head, every figure on the board is
  a day in July, and the top bar says so.
- **The v4 sign fault** (above) shrank every v4 pool's volume to the
  trader's output side. Fixed, awaiting its deploy.
- **The wrong pool.** DexScreener's WIF is a Uniswap **v3** pool with
  $111K in it. Balast's WIF row was a hooked v4 pool with $44 of trades,
  because the v3 pool was not in the tables at all: the factory was
  configured with the cursor millions of blocks in (§20), and every
  `PoolCreated` before that block was never read, so every older v3 pool
  — the pools §4 said existed — was invisible. The token's row is its
  deepest pool, and the deepest pool was missing.

**The factory's history is read now.** On its first pass a poller with a
factory walks the factory's `PoolCreated` logs from the start block to
the block the factory has been followed from (`v3_history_block` in
`indexer_state`, advanced by every pass since), writes the pools it
names, then walks those pools' own logs from creation to the cursor, all
of them in one adaptive window at a time; progress is remembered so a
restart resumes; the cursor is touched between windows so liveness stays
honest; and the priced tables are rebuilt in full once it has read
anything. On the box this is one long first pass — the factory's four
and a half million blocks, then the pools' — and the log says where it
is every twenty windows. The test gives a poller the factory late,
after another has synced without it, and asserts the pool appears, its
swaps and state with it, nothing is read twice on the next start, and
the fee rows equal a poller's that followed the factory throughout.

### Buys and sells, from the chain; and what the NFT is not

ALFA asked for the volume to be DexScreener's buy and sell volume, asked
again what the fee is, and asked whether a person without an NFT can
stake at all.

**Buys and sells are on the drawer now, and they are the chain's.** A
swap that pays the quote (ether or USDG) and takes the token is a buy;
the reverse is a sell. The side the fee was taken in — the input side,
which the v4 sign fix made right — says which, so the split comes from
the same rows as the volume: buys plus sells is the volume, and the two
counts are the trade count, and there is a test that says so for every
pool. `pool_fee_hourly` carries `buys`, `sells`, `buy_volume_usd` and
`sell_volume_usd` (one migration, filled by the next full rebuild); the
snapshot sums them over the day; the drawer shows both figures, both
counts and a bar. The bar is accent and neutral, not green and red:
red means a negative number and a sell is not one (§5).

**Not DexScreener's figures.** §4 bars a third-party number from the
critical path, and the reason is the whole product: every figure on
this site can be checked against the chain, and a figure taken from an
aggregator cannot. The disagreement ALFA saw had three causes, none of
them the source: the sync is in July, the v4 signs were wrong, and the
pool it compared was one Balast had not indexed — all three above, all
three fixed or in hand. Once the sync reaches the same day, the split
here and the split there are the same swaps counted the same way.

**The fee, once more, on the page.** Under *Fees 24h* the drawer now
says the pool's own tier — *1% of every trade, paid to the pool* — so the
figure explains itself: every trade pays that fraction into the pool,
and the pool's liquidity providers own it. Under *Volume 24h* it says
the trade count.

**The NFT is not a ticket.** Nobody needs one to start: the stake
*creates* it. The transaction mints the position as an NFT into the
wallet, and the NFT is how the wallet owns the position from then on.
The drawer says so in that sentence.

### "Stalled" over an indexer that was busy

The deploy summary after the v4-sign repair read `indexer: STALLED —
nothing written for 16818s`, with every process online and zero restarts.
Health judges liveness by the cursor's write time (§18), which is right for
a pass — a pass ends by writing the cursor — and wrong for the two stages a
first pass can spend hours in without one: the full rebuild of every priced
table, which the repair migrations force by forgetting the anchor marker,
and the v3 factory's history walk, which touched the cursor only every
twenty windows. Both are expected work after exactly this deploy, and the
monitor would have paged through all of it — the failure §18 describes as
how a monitor gets muted.

A stage that writes no block is now recorded (`server/indexer/working.ts`,
one `indexer_state` row): its name, where it is — `fees`, or `block
1,200,000 of 4,470,000` — when it started, and a heartbeat every ten
seconds from a timer while it runs. A large SQL statement is I/O to Node,
so the timer fires while it executes. Health reads the record and answers
**`working`** while the heartbeat is fresh: 200, `ok: false`, the stage and
its duration in the message and under `working`. A process killed
mid-stage stops beating, and past the threshold both clocks are stale and
the verdict is `stalled` as before; the record is also cleared on every
start so a leftover is never read as current. The deploy summary, the
doctor, the monitor, the waiting page and `logos:status` all know the
state. `stalled` still means what it did — dead or stuck — and nothing
else.

What this does not explain is the 16,818s itself: the summary is printed
seconds after the restart, so that idle belongs to the *previous* process,
and nothing in the code it ran is a known stage of that length. The log is
the only evidence; `pm2 logs balast-indexer --lines 100` from before the
restart says whether it was refused by every endpoint on every pass (the
one case that neither writes nor touches the cursor and is not a stage),
mid-rebuild, or something new.

### Twelve thousand nine hundred addresses in every request

The first log with the heartbeat in it said where the time went. Phase
one of the factory's history found **12,893 v3 pools**; phase two, their
own logs from block 9,490 to the cursor, had reached block 23,489 after
ten minutes — fourteen blocks a second, ninety hours to the cursor — and
the last remembered pass before the deploy had taken seventeen seconds to
be refused for a thousand-block window. One cause: every `eth_getLogs`
listed every followed pool's address, twelve thousand nine hundred of
them, a request the size of a small file that the endpoints answered
slowly when they answered at all. And the list only grows; on a chain
where a launchpad creates a v3 pool per token it would have reached the
main loop next and stayed there.

**The fetch is by signature now.** The indexer decodes seven events —
v4 `Initialize`, `Swap`, `ModifyLiquidity`; v3 `Swap`, `Mint`, `Burn`;
the factory's `PoolCreated` — and `FOLLOWED_TOPICS` in `server/chain/abi.ts`
is their selectors, checked in a test against the canonical Uniswap values
so a typo in an ABI string cannot pass every fixture and decode nothing on
the real chain. A pass asks for those topics and no address, and keeps
the logs whose contract it follows: the PoolManager, the factory, and
the v3 pools it knows — including one the factory names in the same
batch, since the logs are in chain order and a pool is created before it
is used. Anything else of the same signature, another DEX's v3 pool say,
is counted as `foreign` on the pass line and dropped. The history walk's
second phase does the same with the pending pools' addresses.

Two consequences. The per-pass **backfill** of a newly discovered v3
pool's own logs (§15) is gone: it existed because the pool's address was
not in the filter when its range was fetched, and there is no address in
the filter now. `server/indexer/v3.test.ts` builds a chain with a foreign
v3 pool beside the followed one and asserts the followed pool is whole in
one pass, the foreign one leaves no row, and every request named no
contract. And a response can now carry logs the poller does not want; a
chain with a busy v3 fork on it would narrow the window through the same
result caps as before, which is the trade for a request that stays small.

**A refused single window narrows, whatever the endpoint called it.** The
previous rule kept the width on a lone 429 — the endpoint asking for a
moment — and the box showed the other reading: a thousand-block window
refused every second for hours, the cursor never moving. Some endpoints
answer 429 to a heavy query, and from one window there is no telling
which. So a single refused window halves the width to the minimum, and
the main loop waits longer each time a whole pass is refused — doubling
from the poll interval to a minute (`refusedInARow` on the pass) — rather
than asking again in the same breath. The burst rule is unchanged: a 429
with several windows in flight still halves the concurrency and keeps the
width. A test refuses every window over 500 blocks with a 429 and
asserts the sync finishes, three refusals in a row and then none.

### The row shows volume and its buys and sells; the fee figure leaves it

ALFA's words on the first board after the history walk: *fee hapus dan vol
itu hitung buy sale aja* — take the fee figure off the row, and show the
volume as what it is made of. So the row now carries `vol · 24h` and, in
the column the fee figure held, the day's buys and sells with a bar for the
buy share — the same swaps split by which side paid, so the two always sum
to the volume beside them (there is a test for that in the snapshot
suite). The row's sparkline draws volume too, from a second series in the
same fourteen buckets, so nothing on the row is a fee figure in disguise.
Below 640px the split drops and the total stays.

This sets aside §1's "fee yield is the headline" **for the row only**, and
it is the owner's decision to set aside. Fees remain where they are what
is being said: the masthead's headline sums the fees the listed pools paid
in 24 hours, the drawer's *Fees 24h* line names the tier they came from,
and the *By fee yield* facet still ranks on them. Removing those too is one
line each, offered and not changed.

**Why NVDA's liquidity read $25.5K**, asked in the same message. The
liquidity figure is the pool's own reserves valued in dollars, and the
board that prompted the question was built before two things landed: the
v4 sign repair (§20), under which every v4 pool's reserves had been summed
backwards, and the 12,893 v3 pools the factory's history added, whose
tables had not yet been rebuilt. The rebuild runs after the history walk;
until it completes, the liquidity on the board is the old arithmetic. If
the figure stays thin after it, that is the pool's depth on this chain — a
token's market cap is its supply at a price, and says nothing about how
much sits in the pool.

The first live board with the split on it read `$0 buy · $0 sell` beside
`$459.7K vol`: the four columns arrived by migration with a default of zero
and are filled by the next rebuild, which had not run — each restart since
went into the history walk first. A split of zero beside a volume that is
not is a split that has not been computed, and the row draws it as a dash
with an empty bar until it has; a day with no trades shows `$0` and an
empty bar, not a half-full one.

### Live volume from DexScreener: the owner's exception to §4

Asked what API the volume came from, told none, and told why the figures
were weeks old, ALFA decided: *iya tapi harusnya vol-nya realtime pakai API
DexScreener aja*. §4 bars a third-party number from the critical path and
that concern was raised twice; the owner reaffirmed, and this records the
decision and its limits.

**What comes from DexScreener** (`server/api/market.ts`): for every token
on the board, the day's volume, its buys and sells as trade counts, the
24h price change, and the pair it came from — one request per thirty
tokens against `/latest/dex/tokens/{addresses}`, on a cadence
(`DEXSCREENER_REFRESH_MS`, 30s), held in the API's memory. The pair chosen
for a token is the pool on the row when DexScreener lists it — v3's pool
address, v4's pool id — else the deepest. A quote older than fifteen
minutes is dropped rather than shown as live; a 429 or a failure keeps
the last quotes and backs off, doubling to ten minutes. A refresh that
changed a quote rebuilds the snapshot and wakes every socket, so the row
moves on the aggregator's cadence even while the indexer is in a long
stage and publishes no tick.

**What stays the chain's**: everything that prices the site. The anchor,
the reserves and liquidity, the fees, the yield, the market cap, the
sparkline's history. `Pool.market` sits beside the chain's fields, never
in place of them, so the snapshot still carries the figure that can be
checked against the chain and a test asserts both are present.

**How the page says which is which**: the row's cap reads `vol · 24h ·
live` over a DexScreener figure and `vol · 24h · chain` when DexScreener
has no fresh quote for the token, with the source and the quote's age in
the tooltip; the split column shows trades by side (DexScreener's feed
does not split the dollars) under `buys` and `sells`, or the chain's
dollar split as before; the 24h pill follows the same source as the
volume beside it; the drawer's caption says *via DexScreener*, and a line
under its split says what is live and what is the chain's. Simulated data
has no feed and looks as it did.

**Unverified from here**: the sandbox cannot reach DexScreener. The parser
follows the documented response shape and reads anything else as no quote.
Two things say what is true on the box: `/api/health` carries `market` —
how many of the board's tokens are quoted, the last refresh, the last
error, and the chain ids seen — and `npm run market:probe -- 0xTOKEN`
prints the raw answer for a token. DexScreener's id for this chain is not
known; unset, every chain's pairs are accepted and the ids seen are
listed, and `DEXSCREENER_CHAIN` should then be set to the right one.
`DEXSCREENER_MARKET=false` turns the feed off and the board back to the
chain's figures alone.

The first probe on the box answered: DexScreener's id for this chain is
**`robinhood`**, now the default; the feed quoted 32 of the board's 76
tokens on its first refresh with no error; and the answer listed pairs on
`ramses` beside `uniswap` — a v3 fork trading here, whose pools emit the
same `Swap` signature and are what the poller now counts as `foreign`.
Whether Balast should index them is a product question, not a defect;
§4 names Uniswap and the launchpads.

**32 of 76, and NVDA among the unquoted.** The first board with the feed
on it showed NVDA at `vol · 24h · chain` while DexScreener's own page for
it read $21M on a v3 NVDA/USDG pair. Two things, one of them mine. The
feed had asked thirty tokens to a request and no error came back, which
is the shape of an answer capped in pairs: the tokens at the back of a
long batch get nothing and look unknown. Batches are ten now, a token
that came back without a pair is asked for alone before it counts as
unknown, and one DexScreener still answers nothing for is not asked again
for ten minutes; `/api/health` reports `unknown` beside `quoted`. Tested
against a fake that answers only the first three tokens of any
multi-token request. The other thing is the chain side: the row's pool
was NVDA/WETH at $25K because the v3 NVDA/USDG pool the history walk
found — the one DexScreener shows, with $7.1M in it — had not been
rebuilt into `pool_state` yet; the deepest-pool rule moves the row there
once it has.

---

## 21. Where the volume and the market cap come from

ALFA looked at the first board with the live feed on it — NVDA at `$17.9K`
of volume beside a DexScreener tab reading millions, WIF, BRODIE and
COOKWARE at `liquidity —`, half the rows labelled `FDV` — and asked the
right question: *vol sama market cap ini ambil dari sumber mana masih
banyak yg tidak valid perbaiki cari data api yang valid*. Which source are
these from, and find a valid one.

The answer is in three parts, and two of the three were my own defects
rather than a bad source.

### A row is a token; the quote was a pool's

§19 made the board a token listing — one row per token, its deepest pool —
and §20's feed then read the day off **one** pair: the row's pool when
DexScreener listed it, else the deepest. A token on this chain routinely has
several pools (fee tiers, hooked variants, a v3 pool beside a v4 one), so
NVDA's row showed the day of a shallow v4 pair while the token's own page
summed several. The figure was not wrong about that pair; it was answering a
question nobody had asked.

`aggregate` in `server/api/market-sources.ts` sums the token's pairs now, and
what it sums is exactly what a quantity is:

- **Summed** — the day's volume, its buys and sells, liquidity. A token's day
  is all of its pairs' days.
- **Read off the deepest pair** — price, 24h change, market cap, FDV. None of
  those is a quantity to add up; a market cap summed over three pools is three
  times the token's.
- **Never across chains.** A token address exists elsewhere too, and a sum
  over two chains belongs to no market. With no chain configured the deepest
  pair's chain decides and the rest are dropped; `/api/health` lists every id
  seen so the right one can be pinned.

### The market cap was a live supply at a two-month-old price

§15 derives the market cap on chain — circulating supply × price — and that
price is `pool_state`'s, which is the price **at the last indexed block**.
With the sync sixty-eight days behind, a correct supply was being multiplied
by July's price on every row. Nothing about it looked stale.

So the live figure is preferred when there is one, and the chain's is the
fallback, and both are labelled. Liquidity goes the other way round on
purpose: the chain's figure is the pool's own reserves, it is the pool the
Stake button opens and the one the yield is computed against, so a live
figure never displaces it. It fills the **dash** instead — unknown depth
(§14), which is what half that board was — from the aggregator's figure for
that same pair, or failing that the token's across its pools, which is a
different question and says so.

`lib/market-figures.ts` makes each of these choices **once**. The row, the
drawer and the ranking all read it, because the previous arrangement had the
ranking sorting on the chain's market cap while the row displayed the live
one: a board ordered by a number nobody could see. §12's rule that the header
cannot disagree with the table is the same rule one level down.

### A second source, because the first knew 32 of 76

DexScreener quoted 32 of the board's 76 tokens on the box. The other 44 rows
fell back to chain figures two months old — correct, labelled, and not what
anybody wanted to read. **GeckoTerminal** is asked for what DexScreener does
not answer: keyless, CoinGecko's DEX side, and the aggregator that reads what
launchpads publish, which is most of this chain. Its id for this chain is
discovered from its own network list by name (`GECKOTERMINAL_NETWORK` pins
it), exactly as the logo source already did.

It answers token-level totals directly — volume, reserve, FDV, market cap —
and the deepest of its included top pools gives the 24h change. It does not
split a day into buys and sells, and a partial count summed over its top
pools beside a whole-token volume would be a figure that does not add up, so
those rows show the **chain's** dollar split instead. The unit travels with
the figure rather than being assumed: one source splits trades, the other
dollars, and the row says which.

A refusal now backs off **the source that refused**, not the feed. One 429
used to freeze every row on the board.

### Two bugs found while writing the tests

- **The second source went unasked for fifteen minutes at a time.** After
  each source the feed dropped tokens that "have a quote" — and a token last
  answered by GeckoTerminal still held a fresh one when DexScreener's turn
  came round again, so GeckoTerminal was skipped until that quote went stale.
  A row updating every fifteen minutes on a feed that refreshes every thirty
  seconds. It is per-refresh now, and there is a test that fails against the
  old line.
- **A missing `txns` block read as zero trades.** DexScreener omitting the
  split is "this source did not say", not "nobody traded". It is null, and
  the row falls through to the chain's.

### What is still the chain's, and why that matters

Everything that prices the site: the anchor, the reserves, the fees, the
yield, the sparkline, and the listing bar's own thresholds. §4 bars a
third-party number from the critical path and this does not change that —
the exception is the owner's and it is bounded to the figures a person
compares against an aggregator. Every figure Balast makes a claim on is
still derived from logs and still checkable against the chain.

The deeper cause of the disagreement ALFA saw is unchanged and not a source
problem: **the sync is sixty-eight days behind**, and until it reaches head
every chain figure on the board is a day in July. The live feed is a patch
over that window, not a replacement for it.

### Unverified from here

The sandbox that wrote this reaches neither DexScreener nor GeckoTerminal —
the egress policy refuses both, as it refused every aggregator in §19. Both
parsers follow the documented response shapes and read anything else as "no
quote", which is the same discipline the logo sources were written under and
the same one that made them work on the first real run.

Two things say what is true on the box:

- `npm run market:probe -- 0xTOKEN …` asks **both** sources, prints every
  request and status, every pair behind the sum, and the quote each would
  build — so a figure on a row can be traced to the pairs it came from.
- `/api/health` carries `market.sources`: per source, how many of the
  board's tokens it quotes, its last error and its backoff.

If GeckoTerminal does not list this chain it disables itself, once and
audibly, and the board is exactly as it was.

### Still open

Unchanged: the §12 questions (the simulator's six-hours-per-tick clock,
`/positions`'s forward-looking *Est. fee yield*), `LAUNCHPAD_HOOKS` and
`STAKEABLE_HOOKS` (§14, §20), the listing bar's two numbers
(`LISTING_MIN_FDV_USD`, `LISTING_MIN_LIQUIDITY_USD` — still ALFA's guesses,
not measurements), and the protocol fee's immutable cap before P2 deploys.

### The first board after that deploy: every row read `chain`

Three faults, all mine, all visible in one screenshot.

**A miss was keyed by the token, not by the source that missed.** The singles
pass exists because a long DexScreener batch comes back capped in pairs, so a
token it does list can get nothing (§20); a token still unanswered when asked
alone is remembered and not asked alone again for ten minutes. With a second
source that remembering broke: `take()` cleared the mark whenever **any**
source answered, so a token GeckoTerminal knows and DexScreener does not had
its mark wiped on every refresh and was asked alone again on the next one, for
ever. On that board it was forty-odd extra single requests every thirty
seconds — which earns a 429, which backs DexScreener off for ten minutes,
which is a board with no live figure anywhere on it. The key is
`source|address` now. The test runs six refreshes over two tokens and asserts
two single requests; against the previous commit it makes twelve.

`/api/health`'s `unknown` changed with it: it was "missed recently", which
after the fix would have counted a token one source missed and the other
quoted. It is the set of tokens the last completed refresh could not place at
all.

**A restart left the board on `chain` for a minute.** Quotes were held until
the whole cycle ended, and a cycle is dozens of sequential requests across two
sources. `take()` publishes as each batch lands. The API coalesces those onto
the rebuild floor (`SNAPSHOT_MIN_REBUILD_MS`) — `rebuild()` only de-duplicates
calls that overlap, so a dozen batches would otherwise have run the expensive
query a dozen times back to back. The old trailing publish went with it: it
woke every socket a second time for a snapshot already sent.

**The waiting panel asserted "no indexed blocks yet" on every refresh.** Every
page load starts with no snapshot — the live provider is a fetch and a socket
— so the panel renders for a moment on a perfectly healthy site, and it spent
that moment making a claim about the chain before `/api/health` had been
asked, over a board that had been showing eighty markets a second earlier.
It draws nothing for the first 900ms now, and when it speaks with no answer
yet it says it is asking. An unanswered question is not evidence of an empty
chain, and §7 is exactly as much about the empty states as about the figures.

One thing this does not change: the buy/sell columns read `— BUY / — SELL`
because `pool_fee_hourly`'s four split columns arrived by migration and are
filled by the next full rebuild, which has not run — every restart since has
gone into the v3 factory's history walk first (§20). That is the dash working
as designed, not a fault.

### `followed: 0`: the feed was never told what to quote

`/api/health` on the box, with no error anywhere:

```
"enabled": true, "followed": 0, "quoted": 0,
"lastRefreshAt": null, "lastError": null, "chains": []
```

Not a refusal, not a parse — the feed had never run. `follow()`, the only way
it learns which tokens the board shows, runs inside a **successful**
`buildSnapshot`, and a snapshot was built only when a page asked for one or
the indexer published a tick. The indexer was 26 minutes into the v3 factory's
history walk, which writes no block and so publishes no tick; nobody had
loaded the page since the restart. So nothing ever called `follow()`, the feed
had nothing to do, and it did it perfectly.

The whole board was demand-started, and that is the wrong shape for a process
that is supposed to be quoting a market. `buildServer` now builds one snapshot
on start and retries every fifteen seconds until one succeeds — then stops,
because one success bootstraps the rest: the feed has its list and its own
timer, and its updates keep the snapshot rebuilding. An idle box is not polled
for ever (§19).

`server/api/self-start.test.ts` syncs a chain, starts a server, and never
requests `/api/snapshot`. Without the warm-up it fails with the box's own
symptom, `expected 0 to be greater than 0`.

**And the warm-up exposed a real fault in the cache.** `snapshot()` served
whatever was cached if it was younger than the rebuild floor — including a
cached *nothing*. The warm-up caches a null the instant the process starts, so
every request for the next five seconds answered 503 over a database that by
then had data. A suite caught it, which is the only reason it is not on the
box: `rate limiting > counts each client separately` began expecting 200 and
getting 503. Stale-while-revalidate trades freshness for latency and there is
no freshness to trade when the last build was empty, so a cached null now
rebuilds — cheaply, since `buildSnapshot` returns null at the cursor and
anchor checks, before any expensive query.

**A status of zeroes now says why.** `market.note` names the case: the feed is
disabled, or it has not been given the board, or it has the board and has not
refreshed yet, or every source answered and placed nothing (with the probe
command to run). Three zeroes and a null error sent me looking at DexScreener,
which was not involved.

### SPCX's feather again, and a `$0` that was thirty-four cents

The first board with every row quoted showed three things.

**SPCX still wore the issuer's feather**, for a fourth time, and the reason
was the fix from §20 checking the wrong thing. `reconcileStockLogos` adopts a
mark from `OWN_STOCK_MARKS` only `if (url !== stock.logo_url && await
imageLoads(fetch, url))` — and that URL is `https://balast.xyz/tokens/spcx.svg`,
so the box had to fetch its own public hostname, out through DNS and nginx and
back, to be allowed to use a file sitting on its own disk. When that failed
the update was skipped with **no log line at all**.

The load check (§19) exists to refuse somebody else's URL that does not work
from a browser. It was never the right question for our own files.
`isOwnSiteUrl` now marks them, and they are exempt from it in both places
that applied it; a mark that will not fetch is logged and used anyway, because
a box that cannot reach itself must not leave the issuer's mark on the row.

The same assumption was in the browser path. The badge loads every recorded
logo through `/api/logo/{address}`, which fetches the recorded URL from the
box — so for an own mark the API fetched our own public hostname and handed
the bytes back, and a box that cannot reach itself showed a monogram for a
file in its own `public/`. An own mark is now served same-origin, as a path,
with no proxy; ether's already was, as a special case, and this generalises it.

`lib/own-marks.test.ts` is the check that does belong to these files: every
path in `OWN_STOCK_MARKS`, and every own-site `logoURI` in
`config/tokens.json`, names a file that exists. It runs before a deploy rather
than after one.

**`liquidity $0` next to `FDV $17.79M`.** `usd()` rounds to whole dollars, so
an aggregator reporting thirty-four cents printed a hard zero — which reads as
a measurement of an empty pool rather than as a source with effectively
nothing for the pair, over a chain figure that was unknown anyway. A live
liquidity under a dollar is not a figure: it is a dash, which is what §14 says
unknown looks like. The chain's own figure is untouched by this.

**A token no source has a logo for keeps its monogram**, which is BRODIE on
that board and is working as designed (§19). Which sources were asked and what
they answered is `npm run logos:probe -- <address>`; that is the only thing
that can tell the difference between "nobody lists it" and "a source is
refusing us".

### What the probe said about BRODIE, and the 429 it exposed

`npm run logos:probe -- BRODIE` on the box, for
`0x7Ec3F8DD0837310Ebb6ec4d7dc478090249Ee399`:

| source | answer |
|---|---|
| explorer | 200, knows the token — `"name":"Robinhood Dog"`, `"icon_url":null` |
| tickers | no request: the name is not a "Robinhood Token", so not a stock |
| onchain | the contract publishes no metadata URI |
| pons | 200, an app shell with no image in it |
| geckoterminal | **429, rate limited** |
| dexscreener | 200, `"pairs":null` — it does not list the token |
| coingecko | **429, rate limited** |
| coinmarketcap | disabled, no `CMC_API_KEY` |

So BRODIE's monogram is honest — six sources were asked and none has a
picture. But **two of the eight never got to answer**, and that is a fault,
not a fact about the token.

Both 429s were on a *discovery* call: GeckoTerminal's `/networks` list and
CoinGecko's `/asset_platforms`. `GECKOTERMINAL_NETWORK` was unset, so every
process using the source walks that list — up to twenty requests — to learn an
id that does not change. Since §21 there are **two** such processes: the logo
process and the API's market feed. On a keyless tier of a few dozen calls a
minute, the two of them walking it is the 429.

The id is `robinhood`, and the box proved it rather than anyone guessing: the
market feed quoted twenty-six tokens through GeckoTerminal and reported that
id under `market.chains`. It is the default in `lib/chain.ts` now, for exactly
the reason DexScreener's is (§20). An empty `GECKOTERMINAL_NETWORK` still
restores discovery, and `.env.example` says so, because "unset in the file"
and "absent" are not the same thing here.

Worth re-probing after that lands: GeckoTerminal may well have BRODIE and was
never able to say. If it does not either, the honest answer is the one §20
already gave — the address and an image URL in `config/tokens.json`.

One other thing the explorer's answer shows: BRODIE has **13 holders** and no
trades today, at rank 05 with an FDV of $17.79M. It is listed because it
traded inside the yield window, which on a sync 68 days behind means it traded
in July. That is the listing bar working on data that is two months old, not a
bug — but it is what the bar will need revisiting for once the sync reaches
head.

---

## 22. A full read of the code before mainnet: what was wrong, what is missing

ALFA asked for the whole codebase read as a senior engineer would read it
before calling mainnet live: every bug found, and every feature that is
missing. This section is that report. The fixes below are committed with
it; the rest is for ALFA to decide.

Two limits on what this session could check. It could not reach the box or
the chain: the sandbox's egress refuses `balast.xyz` and every RPC endpoint,
so *whether mainnet is live right now* is a question for `deploy/doctor.sh`
and `/api/health` on the box, not for this file. And nothing was sent on
chain: the mint path is verified by its tests, its byte-comparison against
Uniswap's SDK, and the node's dry run, as §20 says — the first real mint
should still be a small one, watched on the explorer.

What was run here, on a fresh Postgres: `typecheck`, `lint`, the full suite
(31 files and 324 tests on the checkout this session started from; 34 files
and 358 tests on `origin/main` with this commit's additions, all green), the
production build, and the 34 Playwright end-to-end tests against that
build. All pass.

### Bugs fixed in this commit

**The builder reset itself on every snapshot push (live mode).** The mint
flow memoised the pool's key on the `pool.key` *object*, and the snapshot
query builds a fresh object for every pool on every rebuild — every five
seconds on a live box. So every effect in the flow re-ran on every push:
the price fell back to "Reading the pool…", the allowance reads and the
dry run ran again, and the balances were re-read. In the simulator the key
is absent and nothing showed it. The key is memoised on its *contents* now.

**A mint's result was wiped by its own success.** After the receipt the
flow bumps a counter so the price and balances are re-read, and the effect
that re-read them also cleared the result — so "N positions minted · View
the transaction" never survived the render that would have shown it. Only
the toast did. The result is cleared when the pool changes, and never by a
refresh.

**No wrong-chain state.** The dialog asks the wallet to switch on connect,
and a person may decline and stay connected — `ensureChain` says as much
— or switch away afterwards. The flow then read StateView through the
wallet's provider on whatever network it was on, which answered "no data",
which the page called "Pool unreadable"; a send would have been refused by
viem with a chain-mismatch error nobody should have to read. `useMintFlow`
reads `eth_chainId`, follows `chainChanged`, and has a `wrong-chain` step:
the button reads *Switch to Robinhood Chain*, the price is read from the
public RPC meanwhile, and nothing is sent until the wallet is on 4663.
`lib/wallet.ts` gained `currentChainId` and `onChainChanged`, both tested.

**`/positions` crashed on an empty listing.** The builder planned against
`pools[0]`, which throws when the listing bar leaves nothing listed, and on
a listing with no verified pool it silently offered an unverified one that
its own select could not show. It now says which of the two it is and
offers nothing.

**Every pair label was `/ WETH`.** The drawer, the vault cards, the stakes
table, the position list and the payout feed all hardcoded the prototype's
one quote. On the live board the tokenised stocks trade against USDG, and
a v4 ether pool holds ether natively. `quoteLabel()` in `lib/format.ts`
answers from the pool's key: `USDG`, `ETH` for a native pool, `WETH` for
the wrapper and for every v3 pool.

**The rate limit could be escaped by anyone who typed a header.** nginx
*appends* the real peer to `X-Forwarded-For`, so the client's own entry is
first and nginx's is last — and the key was the first entry. One loop with
a made-up address per request had a fresh budget per request. The key is
`X-Real-IP` (which only nginx sets), else the last hop, else the socket;
two tests pin it.

**Every open page froze after an API restart.** The snapshot's revision
counter started at zero with the process, and the live provider discards
any snapshot whose revision is not above the one it holds (so the poll and
the socket cannot make the board jump backwards). After a deploy, a page
already open kept the old, higher number and discarded every push and
every poll until the new count climbed past it — at one rebuild per five
seconds, hours of a board frozen on the previous process's last numbers,
the lag figure included, which is exactly the state §7 forbids. The
revision starts at the clock now, and a test asserts it survives a restart.

**`deploy/monitor.sh` reported every process offline.** The same grep over
`pm2 jlist` that §17 removed from `doctor.sh` was still here: it never
matched, every process read as `missing`, and the monitor alerted
"pm2-offline" on every run and never once said "ok". It parses the JSON
now, as the doctor does.

**A stage's heartbeat could outlive the stage.** `withWork` heartbeats on a
timer while a long stage runs and deletes the record when it ends; a beat
still in flight at that moment landed *after* the delete and put the record
back, with a fresh heartbeat. `/api/health` would then read `working` for a
stage that had already ended, for up to the stall threshold — five minutes
of a wrong status after every full rebuild. The suite caught it as a
leftover row that made the next test's insert collide; the beat is awaited
before the clear now.

**Copy that promised a product that does not exist.** Under §20 a stake is
a full-range position in the wallet: no vault, no seven-day stream, no
WETH conversion, no Balast fee. The `/stakes` masthead still said "Stake
once. Fees stream for 7 days … your share arrives as WETH over a rolling
week"; the `/pools` call-to-action and the page metadata said "collect
swap fees in WETH, streamed to your wallet"; the vault grid's empty state
said staking "opens when the vault contracts deploy" — beside a drawer
that stakes for real; the wallet dialog told a connected person "nothing
on this site asks you to sign yet"; and the router's *Enable router*
button toasted "Router enabled" for a contract that is P4. Each now says
what is true.

### What is missing, in order of how much it matters

1. **A portfolio of real positions.** After a mint there is nowhere on the
   site to see it: the indexer does not follow PositionManager's `Transfer`
   and `ModifyLiquidity`, so `/portfolio` is empty and the masthead's
   *Positions* count stays at zero for ever. §20 called this "next"; it is
   the first thing a person looks for after signing.
2. **Collect fees, decrease, burn.** `encodeDecrease`, `encodeBurn` and
   `encodeTakePair` exist and are byte-tested against the SDK, and nothing
   in the UI uses them. A position minted here can only be managed on
   Uniswap's own interface. Minting is a one-way door on this site.
3. **The single-token zap.** Every mint is two-sided; the builder says so.
   A Universal Router swap of the token side in the same transaction is
   the design in §3.1, and the address is already in `lib/chain.ts`.
4. **Transaction history.** A mint, an approval or a failure is forgotten
   on reload; there is no pending-transaction state across pages.
5. **`STAKEABLE_HOOKS` is empty**, so on a launchpad chain nearly every
   pool's button reads *View* rather than *Stake*. This is the safe default
   and it is still an input only a person can supply (§14, §20).
6. **A Content-Security-Policy.** nginx sends the other security headers
   and not this one; for a page that asks people to connect a wallet it is
   the header that matters most. It needs testing on the box, because
   `next/font` inlines styles and WalletConnect's modal loads remote assets.
7. **The footer's Contracts / Audit / Docs / Status links go to `#`.** An
   *Audit* link to nowhere on a site that asks for a wallet reads badly.
8. **Slippage is fixed at 1%** and the deposit defaults to 2.5 of the quote.
   Neither is exposed; the second makes the drawer's *Stake* hand-off open
   on "above your balance" for most wallets.

### Known drift the indexer carries, not fixed here

- **Reserves include collected fees.** v4 emits no event when an LP takes
  accrued fees (it is a `modifyLiquidity` with delta zero) and v3's
  `Collect` is not indexed, so the summed flow overstates a pool's reserves
  by everything ever collected. TVL drifts upward with age; yield, being
  fees over that TVL, is understated. Conservative, but it grows.
- **A reorged-out log is never removed.** The 32-block re-scan upserts, so
  a row from an orphaned block stays. Negligible on a sequenced Orbit
  chain; worth knowing.
- **The anchor price is one swap an hour.** `weth_usd_hourly` takes the
  last anchor swap in the hour, so one trade at hour end sets the ether
  price every fee in every pool is valued at.
- **`rebuildPoolState` runs unscoped on every caught-up pass.** Once the
  indexer follows head, every pass — every second — walks every pool's
  last swap and sums all of `pool_flow_hourly`, though the anchor price it
  exists to refresh changes at most hourly. Fine on the fixture, worth
  measuring on the real tables once the sync reaches head.
- **`/api/health` counts `swap_events` with `COUNT(*)`** on every call; on
  a table of millions that is a sequential scan per waiting-page poll.

### The §12 questions are still open

The six-hours-per-tick simulator clock, `/positions`'s forward-looking
*Est. fee yield*, `LAUNCHPAD_HOOKS` and `STAKEABLE_HOOKS`, the listing
bar's two thresholds, and the protocol fee's immutable cap before any
vault is deployed. None of them changed here.

---

## 23. "Perbaiki semuanya": what §22 listed, built or deferred

ALFA's answer to §22 was two words: fix everything. This section records
what is now built, what changed underneath it, and the three items that
are deferred with the reason for each. As with §22, nothing here could be
sent on chain from the session that wrote it — the sandbox reaches no RPC
and not the box — so the first collect and the first withdrawal on the
live site should be small ones, watched on the explorer, as §20 said of
the first mint.

### A portfolio of real positions

**The indexer follows PositionManager.** A position is an ERC-721 token
(§20), and two logs describe it: PositionManager's `Transfer`, which says
who holds it, and the PoolManager's `ModifyLiquidity` with `sender =
PositionManager` and `salt = bytes32(tokenId)`, which says which pool,
which range and how much. The second was already being read and its salt
thrown away; `liquidity_events.salt` keeps it now. The first is fetched by
address, the one exception to §20's by-signature rule: `Transfer`'s
selector is every ERC-20's too, so asked by signature alone it would
return every token transfer on the chain, and asked at the one address it
is a handful of logs a window. It rides beside each window in a request
of its own, so a pass sends two requests per window; the burst rule (§20)
halves the concurrency on a rate limit as before.

`position_transfers` is a raw table keyed by log coordinates, and
`positions` is **rebuilt from both, never incremented**: the holder is the
latest transfer's `to`, the range and liquidity are the sum of the salted
events, the principal is the sum of their amounts, and a token sent to the
zero address is `burned`. `server/indexer/positions.test.ts` mints a
position to one wallet, moves it to another, halves it and burns it, and
asserts the table at each step — and that the block-zero and incremental
replays agree (§9).

**The history that the main loop never saw.** On the box the cursor was
millions of blocks in when this code arrived, so every position minted
before it — through Uniswap's own interface, by anyone — had no transfer
row, and its liquidity rows had no salt. The first pass after the deploy
walks PositionManager's history from the start block to the cursor
(`position_history_block`, advanced by every pass since), writes the
transfers, gives the existing liquidity rows their salt and nothing else,
and rebuilds `positions` once. The same shape as the v3 factory's history
(§20), for the same reason; a `working` stage with a heartbeat, so health
says what it is doing. There is a test that wipes exactly what a synced
box lacks and asserts one pass restores it.

**`/api/portfolio/:wallet`** values each position by the same tick maths
the indexer uses and through the same one path to dollars (§4.3), says
whether it is in range and for how long it has not been, and puts *price
impact on holdings* beside it as what it is: the position's value today
against what its net principal would be worth today. *Fees earned* is
null. A position's collections are not indexed — v4 collects inside a
`ModifyLiquidity` of delta zero whose event carries no amounts — and a
figure for them would be invented (§7).

**Uncollected fees are read from the chain by the page.** Fees are state,
not events: the pool's fee-growth accumulators inside the range, less the
value the position last settled at, times its liquidity, over 2^128 —
`lib/v4/fees.ts`, the same arithmetic as v4-core's `Position.update`,
wrap included, with a test. `useLiveFees` reads them through StateView in
one multicall every thirty seconds and values them at the same prices the
portfolio used, so the two figures on a row are in the same dollars. The
live provider carries the wallet's portfolio beside the shared snapshot,
re-read on the poll and on request.

The page: Net value, Uncollected fees, Price impact on holdings, In range;
a row per position with its range (`Full range`, or `−12% / +12%` around
the token's price), its status in red when out of range, its value, its
uncollected fees in both currencies, and **Collect fees** and **Withdraw**.
The masthead's *Positions* is the count of open ones. A position whose
pool is below the listing bar still renders: the token rides on the
position.

### Collect and withdraw

`lib/v4/manage.ts`: a collect is `DECREASE_LIQUIDITY` by zero, which
settles the fees, then `TAKE_PAIR` to the owner; a withdrawal is
`BURN_POSITION` then `TAKE_PAIR`. Both are byte-compared with Uniswap's
`V4Planner` in the test. `usePositionActions` sends them with the mint's
guards: the wallet has to be on this chain, the node dry-runs the exact
calldata before any signature, and a withdrawal's minimums come from the
chain's own liquidity at the chain's price read a moment before, less one
percent — not from the indexer's figures, which during a sync are weeks
old and would either revert every withdrawal after a rally or guard
nothing after a fall. The receipt is awaited, the portfolio re-read, and
the row says what happened with a link to the transaction.

### Transaction history

`lib/tx-history.ts` keeps a short list per wallet in the browser: hash,
kind, a label in words, and whether it was mined. Approvals, mints,
collections and withdrawals record themselves as they are sent and mark
themselves on the receipt; a transaction cut off by a reload is asked
about through the public RPC until it is. The *Activity* card on
`/portfolio` shows it and says what it is — a convenience, per browser,
with the explorer as the record.

### Slippage, and the deposit that opened on "above your balance"

The builder offers 0.5, 1 and 3 percent, default 1, passed through to the
plan's `amountMax`. The deposit defaults to a tenth of an ether or a
hundred dollars, by the pool's quote, instead of 2.5 of whichever it was.

### The drifts §22 recorded in the indexer

- **Reserves are principal.** `pool_state` now values the flow less every
  fee the pool has earned (`pool_fee_hourly`'s exact integer sums per
  token). Fees sit in the pool until collected, and collecting emits
  nothing the indexer reads, so the figure grew with every fee ever
  earned and the yield, being fees over it, was understated. Exact for a
  static-fee pool; for a dynamic-fee pool it inherits the fee row's
  proportion (§20). Asserted in the positions suite against the SQL.
- **The anchor hour is a volume-weighted mean** of its swaps, each
  weighted by its USDG side, rather than the last swap in the hour — so a
  dust trade at the hour's end no longer sets the ether price every fee
  in every pool is valued at. Postgres numeric sums are exact, so the
  mean is order-independent and §9 still holds.
- **The unscoped pool-state rebuild runs when the anchor hour changes**,
  once the indexer follows head, and on the cadence for the supply
  refresh — not every second. An untouched pool's dollar figures depend on
  nothing else that moves.
- **`/api/health`'s swap count is kept for thirty seconds.** A
  `COUNT(*)` over millions of swap rows per waiting-page poll was a
  sequential scan per poll, for a figure that is context. The pools
  count is a small table and stays exact on every call — the first
  version cached both, and the health suite caught it answering a stale
  zero for a database that had just been synced.

### Smaller

The footer's four links go somewhere: Contracts to PositionManager on the
explorer, Audit to Uniswap's v4-periphery audits, Docs to the v4
contracts overview, Status to `/api/health`. `deploy/nginx.conf` sends a
`Content-Security-Policy-Report-Only` — Next.js inlines its hydration
scripts and `next/font` its styles, WalletConnect's modal has its own
hosts, a wallet's icon is a `data:` URI, and the comment says what to
watch in the console for a few days before renaming the header to
enforce. The masthead's *Positions* tooltip says what the count is. The
rate-limit fakes in `adaptive.test.ts` answer the address-scoped request
without counting it, since they model the endpoint's answer to the window.

### Deferred, and why

1. **The single-token zap.** A Universal Router swap of the token side in
   the same transaction, §3.1's design, with the address already in
   `lib/chain.ts`. Not built here because it cannot be fork-tested from
   this sandbox and its failure mode is not a revert: a wrong swap path
   or a wrong minimum loses money. It should follow the first watched
   mint, not precede it. The builder still says the deposit is two-sided.
2. **Removing reorged-out rows.** The 32-block re-scan upserts, so a row
   from an orphaned block stays. Deleting rows absent from a re-scan
   would delete real rows whenever an endpoint answers a window partially
   — which on this chain they do — and needs a per-window "complete
   answer" guarantee the sources do not give. On a sequenced Orbit chain
   the drift is negligible and it is recorded rather than risked.
3. **A history of collected fees.** Not in the log stream (above). The
   uncollected figure is live and exact; the collected one would be a
   guess. Indexing v4's `BalanceDelta` would need a trace, not a log.

Still ALFA's, unchanged: `STAKEABLE_HOOKS` and `LAUNCHPAD_HOOKS` (§14,
§20), the listing bar's two thresholds, the §12 questions, and the
protocol fee's immutable cap before any vault is deployed.

### Verified here

On a fresh Postgres: `typecheck`, `lint`, the full suite — 38 files and
375 tests, the positions, history-walk, fees, manage and tx-history
suites among them — the production build, and the 34 Playwright
end-to-end tests against that build. All green.

---

## 24. The ETH price, live; and a cursor stamped 1 January 1970

ALFA's screenshot of the board: the masthead's ETH at `$1,784.27` beside a
top bar reading `Indexer 20718d 7h behind` and a dateline of *Thursday 1
January*. The ask was one line — *harga eth is wrong, fixkan, saya ingin
harga mengikuti real time* — and the screenshot held a second fault the
ask did not name.

### The ETH price follows the market now

The masthead's figure was the chain's anchor price at the last indexed
block (§4.3), which during a sync is weeks old; an honestly derived price
that is weeks old is still the wrong number to headline. Under the
owner's exception to §4 (§20, §21) the market feed now asks for the
wrapper — aeWETH, one token per ether (§18) — beside the board's tokens,
and `global.ethPriceUsd` is the wrapper's live quote when there is a
fresh one, the chain's anchor price otherwise. The masthead row says
which, `live` or `chain`, with the source and the quote's age in the
tooltip.

Two things that came with it. The feed asks for ether **as** the wrapper
— no aggregator can be asked about address(0), so the ether market's row
had never had a live quote at all; it wears the wrapper's now. And what
prices every dollar figure on the site is unchanged: the anchor series,
from the chain. This decides what one row reads, and the row says so.

### A timestamp that was not a time

`20718d` is the distance from 1 January 1970 to the day of the
screenshot: the cursor's chain time was the epoch. Some endpoint had
answered a block with a zeroed timestamp, and the pass believed it — the
cursor, and every row of that pass, was stamped 1970, so the hourly
tables gained rows in an hour no trailing window would ever reach, and
the top bar, the dateline and every "last 24 hours" on the site measured
from the wrong end of time.

`server/chain/block-time.ts` refuses such a stamp where it arrives:
inside the RPC failover, so an endpoint that answers nonsense is an
endpoint to move on from; a log's own `blockTimestamp` that is not a time
is ignored and the block is timed by `getBlock` like an unstamped one;
and the cursor write is the last line of defence, refusing to record a
pass whose end block has no sane time. The floor is 2020 — generous on
purpose.

What was already written is repaired on the indexer's next start
(`server/indexer/repair-times.ts`): rows before the floor are deleted,
the aggregate hours before it with them, the cursor is moved back to the
block before the earliest of them so the next pass reads that range
again with real times, the cursor's own time is restored from the newest
row still in the tables, and the full rebuild is forced. On a healthy
box it finds nothing and changes nothing. The suite gives a synced
database exactly the box's state and asserts one pass of a new process
leaves the tables equal, as text, to a clean sync's (§9).

**What this does not say** is which endpoint answered zero, or when. The
refusal now names the block and the call in the indexer's log, so the
next time it happens the log says.

### Verified here

`typecheck`, `lint`, the full suite (41 files, 387 tests, the
block-time, repair and snapshot-cache suites among them), the production
build and the 34 Playwright tests. Unverified, as always from this sandbox: the
aggregators' answer for the wrapper on this chain. `/api/health`'s
`market` section says whether the wrapper is quoted, and
`npm run market:probe -- 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
prints what each source answers for it.

### The loading panel after a deploy

The deploy carrying the above landed, every process came up, and the site
showed the loading panel — *asking the API what state the indexer is in* —
while `/api/health` reported `followed: 0` and *none has been built since
this process started*. ALFA's answer: *hapus loading gini, harusnya
langsung website saja*. Take the loading away; the site should just be
there.

The cause is structural, and it is the same one on both ends. The API
starts with nothing and builds its first snapshot on demand — the
expensive query, run right after a deploy, when the indexer is usually
mid-repair or mid-rebuild after the same deploy and the build can come
back empty until the cursor or the anchor is put right. And the browser
starts every load with nothing and waits for the API. Two cold starts,
one behind the other, over tables that had a perfectly good board in
them a minute earlier.

**The API keeps its last board** (`server/api/snapshot-store.ts`): each
successful build is written to `indexer_state`, at most once every thirty
seconds, and a starting process serves it from its very first request
while its own first build runs. A build that comes back empty no longer
replaces a good board with nothing; the last one stays up. Both are
**aged**, not passed off as fresh: the snapshot carries `builtAt` now, and
what is served has the time since added to its lag, so the top bar says
exactly how old the numbers are (§7). Past a day it is let go, and the
loading panel is the honest state again. The revision handed to a kept
snapshot comes from the same counter as the builds, so the first real
build is newer and the page takes it.

**The browser keeps its last board** (`lib/data/snapshot-cache.ts`): the
live provider stores each snapshot it accepts in `localStorage`, at most
once every ten seconds and without the wallet's positions, and restores
it on the next load with the same ageing — after the first paint and
outside hydration, so the server-rendered null state and the client
agree. Its revision is zeroed, so whatever the API answers first replaces
it. A private window or a full store is not an error.

Neither is a fallback to invented numbers (§14): both are the last real
board, labelled with its age, and both give way to the first fresh one.
`server/api/server.test.ts` proves the API half — a new process with no
cursor at all serves the kept snapshot, aged, from its first request and
its second; `lib/data/snapshot-cache.test.ts` the browser half.

### The repair that rewound four million blocks

The deploy summary after the repair landed: *first sync running (0.43% of
the chain): block 305284 of 69494974*. The cursor had been past four
million. ALFA: *mengapa masih error, apa masalahnya*.

The repair above did what it said — and what it said was wrong. It
**deleted** every row stamped before the floor and moved the cursor back
to the block before the earliest of them, so that the poller would read
that range again. The earliest such row was at block 305,285: the v3
factory's history walk (§20) had timed rows across the whole chain, so a
zeroed answer during it left 1970 rows all the way back. The re-read is
four million blocks at the poller's forty a second — a day and more — to
recover rows that were never wrong about anything but their clock. And
with the cursor at block 305,284, every window the board measures back
from the cursor's time (§14) ended in the chain's first weeks: the board
showed near nothing over tables that still held everything.

Two changes, and the first is why the site is whole again while the
re-read runs.

**"Now" is the newest row indexed** (`server/indexer/as-of.ts`), or the
cursor's time when that is later, which on a healthy box it always is.
The snapshot and the portfolio measure their windows from it, so a
cursor moved back for any reason leaves the board where it was; the
cursor still says only where reading resumes. The top bar's lag is the
data's age, as §7 wants; `/api/health`'s progress is the cursor's.

**The repair re-times rows in place.** The rows carry their block
numbers, and a block's time is one `getBlock` away — so the repair now
asks the node for the bad blocks' timestamps (`LogSource.timeBlocks`,
batched as the pass's own reads are), writes them onto the rows, and
deletes nothing and moves nothing. A block the node will not answer for
is logged and tried again on the next start. The suite gives a synced
database the box's state and asserts the pass that follows starts at the
re-scan behind the cursor, not at the bad rows; that every row is kept
and every one is timed as the chain times it; and that the tables equal
a clean sync's.

What this cannot undo is the deletion the first version already did on
the box. Those rows come back only as the re-read reaches their blocks,
and the re-read runs at the poller's pace behind the board; the board
does not wait for it. Nothing else was lost: the rows behind the cursor
that carried real times were never touched, and the cursor's own time
was restored from them.

### Seven tokens at the same market cap, and a day's volume of zero

The board after the re-read began, ranks 9 to 15: `!!!!!`, RVH, `f`,
RTH, BACKD, RC, UNICLAW — each at `MC $38.88M`, most at `liquidity
$38.88M`, every one at `vol · 24h · live $0`. ALFA: *token-token masih
pada shit dan pada 0 vol, perbaiki asap*.

The figures are the aggregator's, and they are not wrong about what
they measure. A launchpad token nobody has bought holds its whole supply
in the pool that launched it, at the curve's floor price; the aggregator
multiplies the one by the other and reports a market cap, and values the
pool's tokens and reports a liquidity — the same number, since the pool
*is* the supply. Seven fresh launches at the same floor are seven
identical figures. What the figures are not is a project: nobody has
paid any of it, which the `$0` beside them says.

So the market-cap ranking has two tiers now (`rankByCap` in
`lib/market-figures.ts`): every token with volume today, by cap; then
every token without, by cap. A quiet day still shows — at the end of the
board, not the top of it — and the subtitle says so. The volume facet
was already in that order, and the yield facet requires seven days of
fees, which a token nobody trades never has. Hiding the zero-volume rows
outright is one filter, offered and not made: a real token can have a
quiet day, and a board that hides it says less than one that ranks it
last.

### The top of the board: a $210M cap on $1.1K of volume

The board after that deploy, ranks 1 to 6: VIRTUAL; a CASHCAT with chain
figures only and a 24h change of `+14380.4%`; SMK2 at `MC $210.03M` on
`$1.1K` of volume, four buys and four sells; the real CASHCAT, with the
logo, the live quote and `$20.73M` of volume, at rank 4; Analyst at `MC
$81.30M` on one dollar of chain volume; then Index. ALFA: *saya ingin
yang top-top ini difilter dari top MC serta vol, dan pastikan vol
valid* — the top should be the top by market cap *and* volume, and the
volume has to be a real one.

Volume above zero was too low a bar. A market cap is a supply at a
price, and a price from four trades supports nothing; and a chain figure
during a sync is a day weeks ago — CASHCAT's `$232.3K · chain` and
Analyst's `$1 · chain` are July's — which is not a claim about today.
"Valid" here means measured today, by a source that is watching the
market now: a live quote.

So the market-cap ranking has three tiers (`rankTier` in
`lib/market-figures.ts`), and the cap orders each:

0. a live quote with volume today of at least `RANK_MIN_VOLUME_USD`
   ($10,000) — a market somebody is in, measured today;
1. some volume, but under the bar or only the chain's figure;
2. none.

The volume facet ranks live figures ahead of the chain's for the same
reason. The subtitle under the board says which tier the top is, and the
bar is **ALFA's number** like the listing bar's (§19): a first guess at
"a market somebody is in", not a measurement. Tested against exactly
that board.

Two things this does not do. It does not tell the two CASHCATs apart by
name — they are two tokens with one symbol, and the row shows each
token's own address in the drawer, which is the only honest
disambiguation. And it does not hide anything: the thin and the stale
follow the projects, and a quiet day is visible rather than gone.

### A liquidity figure that was the token's own supply, priced by itself

ALFA, on the same board a rank lower: *masih ada projct puluhan mc tpi vol 0
ini bug harus d perbaiki say aingin data real*. Rows 29 to 35 — Analyst at
`MC $81.30M · liquidity — · $1 vol`, then UNICLAW, PRILO and hoot at an
**identical** `MC $38.88M · liquidity $38.88M` on $133, $4 and nothing. The
tiering above had moved them off the top; the objection was to the figures
themselves, and it was right. This one is a defect, not a threshold.

**`tvl_usd` values both sides of a pool, and the token side's price is
derived from the pool's own ratio.** So for a pool holding most of a token's
supply — which is every launchpad curve pool on this chain — the token side's
dollar value *is* that token's fully diluted value, and the liquidity figure
comes out equal to the market cap beside it. Three identical numbers across
three tokens is the signature: one launchpad template, one standard supply,
one launch tick. Whatever is actually in those pools, it is not $38.88M.

That is also why §19's liquidity floor never caught them. The floor was the
right idea measured on the wrong quantity: a both-sides figure that a pool
can inflate by holding its own token cannot say whether anyone has put money
in. Raising the number would not have helped — the figure scales with the
supply, not with the pool.

**The quote side is the one figure here that is not circular.** Ether and
USDG are priced outside the pool (§4.3), so the quote-side reserves are the
dollars a swap can actually take out, and `pool_state.quote_tvl_usd` (one
migration) records them beside the total. A row now has to show real money
one of two ways — `LISTING_MIN_BACKING_USD`, default $2,000:

- **quote-side reserves** at or above it: dollars sitting in the pool; or
- **volume through the pool** at or above it over the yield window: dollars
  that moved. This is what keeps a hooked pool whose reserves the indexer
  cannot reconstruct (§14) on the board, GUH and Index among them.

Neither, and the pool is indexed, counted in `/api/health`, and unlisted
until either crosses. The ether/USDG market is exempt as always. The old
`LISTING_MIN_LIQUIDITY_USD` keeps its meaning and applies to a known
both-sides liquidity; the forgiveness §21 gave unknown depth for *any*
volume above zero is now this backing test, because a dollar of trading in a
week was what put Analyst on the board.

**The column is nullable, and that is the point.** NULL means the pool-state
rebuild has not reached that pool yet; zero means it has and the pool holds
no quote. Read as zero, a default would have unlisted **every pool on the
box** for as long as the rebuild took — §14's rule, that unknown is never a
measurement, applied to our own arithmetic. The migration forgets the anchor
marker, so the first pass after the deploy fills the column and the board
changes then, not before.

The drawer says the figure out loud: under a chain liquidity it now reads
*both sides · $X of it in ETH*, so a person about to stake can see what the
pool is really a share of.

`server/api/snapshot.test.ts` builds that exact row — a whole supply in the
pool, $84 of ether, $133 of trading — and asserts it is unlisted, then funds
it and asserts it returns with both figures on it; and asserts an unmeasured
quote side lists, where a measured zero does not. `quote_tvl_usd` joins the
§9 comparison in `dumpPoolState`, since it is a derived aggregate like the
rest.

**Still ALFA's number.** $2,000 is a first guess at "somebody has put real
money here", like the other two bars. What it cannot fix is the sync: the
chain figures on that board are a day in July (§21), and a token busy today
but quiet then is judged on the quiet day until the backfill reaches head.

### The rows that read `chain`: a pair counts whichever side the token is on

ALFA, on the next board: *beberapa token masih tidak baca real volnya
fixkan*. Rows 39 to 44 read `vol · 24h · chain` — YSMN, WISHBONE, MYSTERY,
WTF, NVR — while HOOD and STONKS beside them read `live`. A chain figure
during this sync is a day in July, so those rows were showing a day two
months old while their neighbours showed today.

Four faults, and the first is the one that would have hidden the others.

**A pair was only counted when the token was its base.** `aggregate` filtered
`p.baseToken === address`, and which side a source calls the base is the
source's own decision: for a Uniswap pool it follows the currencies' address
order, not which one anybody would call the token. So for roughly half the
board — every token whose address sorts below its quote's — every pair came
back the other way round and was dropped, the token looked unlisted, and the
row fell back to the chain. A pair now counts whichever side our token is on,
and what may be read from it narrows with the side: `priceUsd`, `fdv` and
`marketCap` describe the BASE token, so a pair our token is the quote of
contributes its volume, its trade split and its liquidity, and never a price
or a cap. Taking those would have put another token's market cap on the row.

**And ether had no price of its own.** Ether is the quote of nearly every
pair here and the base of almost none, so under the old rule the wrapper —
which is how the masthead's ETH price is asked for (§24) — could be priced
only from the rare pair it is the base of. A source prices the base twice,
in dollars and in the quote, and one over the other is the quote's price in
dollars exactly. `MarketPair.quotePriceUsd` carries it, and a token that is
only ever a quote is priced from it.

Ether is also the one exception to the rule above, for the same reason it
needed that price: it is the chain's quote asset rather than a token with
markets of its own. A source answers with a page of the pairs it quotes, so
summing them would report most of the chain's day as ether's own total. Where
ether is the base of something, those are its markets; everywhere else it
takes only the price. An ordinary token counts both sides.

**GeckoTerminal is asked by the pool for what its token index does not
carry.** It indexes pools and derives its token pages from them, so a
launchpad token missing from `/tokens/multi` can still have its pool in
`/pools/multi` — and a pool answer carries a trade split the token answer
does not. One extra request per batch, only when something was missed, and
its failure is a note rather than a refusal: how this chain's v4 pools are
addressed there could not be checked from here, and a refusal would back the
whole source off every refresh over a fallback, losing the coverage it has.

**The singles budget was shared between the sources.** A token a batch came
back empty for is asked about alone, because a long batch's answer can be
capped in pairs (§20), and there were forty such asks per refresh. Shared,
the first source's misses spent all forty and the second — asked precisely
because the first does not list these tokens — got none. The source most
likely to have the answer was the one that never got to ask.

The budget belongs to the source now, because it is a rate-limit budget:
DexScreener answers hundreds of calls a minute and keeps its forty;
GeckoTerminal is keyless at a few dozen a minute, its batch answers per
token rather than capped, and what its token index lacks is asked for by the
pool inside the same batch — so it takes four, for the edge case of a token
with no pool recorded. A generous budget there would spend the whole
minute's allowance on retries and earn the 429 that leaves every row reading
`chain`, which is the fault this section is about arriving by another road.

**A source that cannot ask now says so.** GeckoTerminal with no network id
answered no quotes, no error and no reason, which is the status §21 already
called out as sending whoever reads it to the wrong place. `SourceAnswer.note`
carries the explanation into `/api/health` without backing the source off,
because a source that could not ask has not been refused. And `market.unknownTokens`
lists, by ticker, the board's tokens no source placed — a count alone cannot
tell "no aggregator lists these" from "our feed is not asking", and those
need opposite actions. `npm run market:probe -- <ticker>` then answers it in
one command, and passes the token's deepest pool so it exercises the
by-pool lookup the board depends on. `deploy/doctor.sh` prints the same
line — how many of the board's tokens are quoted, and which ones no source
has — because a board reading `chain` is a board showing a day as old as
the sync, and nothing else on the box said so.

What none of this changes: a token genuinely absent from both aggregators
keeps the chain's figure, labelled as the chain's, and that figure is as old
as the sync. The backfill reaching head is the only thing that fixes it for
every token rather than for the ones an aggregator happens to carry.

---

## 25. Today, from the chain: a second reader at the head

ALFA, on a board where every row read `chain`: *vol masih kecil atau tidak
real buat realtime data*. The volume is small, or not real; make it real time.
The top bar said `Indexer 73d 19h behind`, and it had said `73d 18h` the day
before — so the backfill was not gaining on the chain, and every figure on the
board was a day in July.

Three sections of this document have now tried to patch over that with an
aggregator (§20, §21, §24), and each time the answer was the same shape: the
tokens DexScreener and GeckoTerminal happen to list get today's figure and
the rest keep a two-month-old one. On a launchpad chain that is most of the
board. The patch was never going to cover it.

### Why the backfill cannot simply be made faster

It reads in order from `START_BLOCK` because a pool's reserves are the sum of
its whole event history, and a sum with a hole in it is not a smaller number,
it is a wrong one (§14). Everything else follows from that: the liquidity
figure, the fee yield's divisor, and §9's proof that a replay produces
byte-identical rows. Reading the recent blocks first and the old ones later
would make every one of those wrong, quietly, in the flattering direction.

So the answer is not to reorder the backfill. It is to read the other end of
the chain separately, and to keep it sealed off from everything the backfill
owns.

### What the head reader is

`server/indexer/head.ts` follows the last `HEAD_WINDOW_HOURS` of blocks
(default 24), decodes the same swap logs with the same decoders, and writes
them to `recent_swaps` — a table nothing else in the pipeline reads. It runs
in the indexer process, before each backfill pass; once its window is whole it
costs a handful of blocks a pass, and its failure is its own, because a site
with an honest old figure beats a site with none.

`server/api/recent.ts` turns those rows into the day. The arithmetic mirrors
`rebuildFeeHourly` line for line — volume is the side that entered the pool at
its USD price, a token is priced from whichever side of its pool is the quote,
ether through the anchor and USDG at a dollar, a buy is the swap whose input
was the quote — so a pool's figure now and the same pool's figure once the
backfill arrives are one number reached two ways. The anchor price comes from
the anchor pool's own recent swaps, so the query needs nothing from the
indexer's aggregates, which is exactly what lets it be current while they are
weeks behind.

**What it is not allowed to touch** is the point. Reserves, liquidity, the fee
yield, the sparkline and the market cap are sums over a pool's whole history,
and a window of recent blocks with a gap behind it cannot contribute to them.
`server/indexer/head.test.ts` snapshots `swap_events`, `pool_flow_hourly`,
`pool_fee_hourly` and `pool_state` as text around a head pass and asserts not
one value moved. That test is the design.

### What the board shows now

`Pool.now` sits beside `Pool.market`, and `lib/market-figures.ts` makes the
choice once, as it does for every other figure: **the chain's own head first,
an aggregator second, the backfill's indexed day last**. The head's figure is
this pool's own swaps, derived the way the rest of the site derives
everything, and current; an aggregator's is the token across its pairs and
comes from outside (§4). The row's cap says which of the three in one word —
`now`, `live` or `chain` — because they are weeks apart and the reader should
not have to guess. The split is the head's dollars, which sum to the volume
beside them; the aggregator's trade counts never could.

The ranking follows the same rule: `isCurrent` is what decides the tier, and
both the head's figure and an aggregator's describe today where the
backfill's, during a first sync, does not.

The masthead's ETH price gains a third basis for the same reason, `chain-now`:
the anchor pool's price at the head, which is the site's own derivation over
blocks minutes old rather than an aggregator's quote or a price from July.

`/api/health` carries `head` — how many swaps it holds and how old the newest
is — and `deploy/doctor.sh` prints it before the market feed's line, because
"every row reads chain" is answered there first.

### What this does not fix

The liquidity figure, the fee yield and the market cap are still the
backfill's, and still as old as it is. They are sums over a history, and
nothing short of the backfill reaching head makes them current. The top bar's
lag still describes that, honestly, and should be read as being about those
figures rather than about the day's volume beside them.

`HEAD_WINDOW_HOURS=0` turns the reader off and the board goes back to the
backfill's day, labelled as such.

### Unverified from here

The sandbox reaches no RPC endpoint, so the reader has been proven against the
fixture chain and not against Robinhood Chain. The first thing to look at on
the box is `/api/health`'s `head`: a `swaps` of zero means it has written
nothing, and `pm2 logs balast-indexer` carries a `head` line per pass saying
how far from head it still is.

---

## 26. A token has more than one market

ALFA, on `/positions` with VIRTUAL / USDG selected and `Balance 0` beside the
deposit box: *mengapa tidak ada pilihan paired dengan / ETH*. Why is there no
option for the ether pair.

Because the page had never been sent one. §19 made the board a token listing
and §20 made a token's row its deepest pool, and `onePoolPerToken` did that by
**dropping** the others from the snapshot entirely. So the client held exactly
one pool per token, and the builder's select could only ever offer that one.
A wallet holding ether was shown a token's USDG market, a balance of zero, and
no way to reach the ether market that had been indexed all along.

That is right for the board and wrong for the builder, and the difference is
what each is for. The board answers "which tokens are worth looking at", and
one row per token is what makes it readable — and what makes the masthead's
totals sum to the rows beneath them (§12). The builder answers "which market
do I want to be in", and there the pair is most of the question: the quote
currency decides whether a wallet can enter at all, and the fee tier decides
what the position earns.

So the snapshot carries both. `pools` is the board, unchanged, and every total
is still summed from it alone. `otherPools` is the rest of a listed token's
pools — a different quote, a different fee tier — on the board's own listing
terms, in no total, and with their sparklines stripped, since nothing draws
one for them and fourteen buckets apiece over a few hundred pools is payload
the page polls for nothing.

The builder reads both, and its select names the fee tier only where a token
offers more than one pool, so the common case stays a pair and nothing else.
The entries are sorted by ticker, which is how a person looks for one.

`server/api/one-per-token.test.ts` had proved a token appears once on the
board; it now also proves the other pool survives, carries its key and its
fee tier, is absent from the board, and duplicates nothing that would make a
total count twice.

### And then the picker was every pool on the chain

Sending the other markets fixed the data and made the control worse. The
select became one flat, alphabetical list of every pool Balast lists:
`TENOV / WETH · 1%`, `TENOV / WETH · 3%`, `TENOV / USDG · 6.9%`, `TISM /
WETH`, `TSLA / ETH · 5%`, and somewhere further down the one the person came
for. ALFA, exactly: *kan tokennya udah VIRTUAL, harusnya ada paired-nya ETH,
bukan malah referensi token lain.*

Which is right. There are two questions and the control was asking one
compound one. The **token** is what a person arrives with. The **market** —
the quote currency and the fee tier — is what they choose once they have it,
and it is a real choice: the currency decides whether their wallet can enter
at all, and the tier decides what the position earns.

So the token select names tokens and nothing else, and a second control, the
same segmented pills as Slippage beside it, lists that token's markets. It
shows even when there is one, so what you are in is on screen rather than
implied, with a line saying it is the only one that clears the listing bar.
Picking a token selects its deepest market, which is the pool the board's own
row is.

Two things fell out of it. A ticker is not unique here — there are two
CASHCATs (§24) — so a repeated symbol carries the last four characters of its
own address, which is the only honest way to tell them apart. And moving
between a token's USDG market and its ether one used to carry the deposit
figure across: a hundred is a sensible first deposit in USDG and a hundred
ether is not, so the amount re-defaults when the currency changes and the
builder no longer opens on "above your balance" (§22's fault, by another
door). A figure the person typed themselves is theirs and is kept.

**What this does not do** is offer a pool below the listing bar. A pool with
no real money behind it (§24's backing test) stays unlisted everywhere,
including here, because minting into one is not a thing to offer. So a token
whose ether market is dust still shows only its USDG market — and a token
with no ether pool on this chain shows only what exists. Those two look the
same from the page, and telling them apart is `npm run market:probe` and the
explorer.

---

## 27. Two shapes that looked alike, and a pair bought with the wrong ether

ALFA asked two things off the builder: what the difference between *Curve*
and *Bid-ask* actually is — *sama ajaa?* — and that a pair be entered with
Robinhood Chain's own ether rather than with WETH. The first turned out to
be a question the page could not answer because the page did not know; the
second was a defect that had the builder fabricating a balance on mainnet.

### Curve and bid-ask are opposites, and nothing said so in a number

They were never the same. `shapeWeights` gives curve a bell,
`exp(-4x²)`, and bid-ask a trough, `0.15 + x²`. What the page lacked was
the one figure that makes the difference mean something: **only the bin
holding the current price earns a fee**, so what separates the shapes is
how much liquidity each puts there.

`densityAtPrice` computes it — the weight of the bin the price sits in,
times the bin count, so an even spread is 1 by construction. Over a
symmetric range at 24 bins, curve is **2.27×** an even spread and bid-ask
is **0.31×**: a factor of seven between them, on screen, in the builder's
own units.

That figure now also **scales the estimate**, in place of two constants
the builder had been multiplying by — 1.35 for curve and 0.8 for bid-ask.
Both were invented, and the bid-ask one was wrong by more than two and a
half times, in the flattering direction: it claimed the shape holding the
least where it counts gave up only a fifth of the yield. With the real
density, bid-ask's estimate now comes out **below** the pool's own
trailing figure, which is the honest answer — it is a ladder of orders,
not a fee position, and the hint says so.

The shape hints were rewritten to say what each does to the money rather
than to praise it, and the cap on the combined multiple stays at 6× (§12).

Two colour-rule violations sat in the same panel: the bin chart's
current-price line, its legend swatch and the `now` label were all painted
`--red`, which §5 reserves for a negative number and nothing else. They
are ink. And the simulated split line said `ETH` whatever the pool's quote
was — the last of the hardcoded quotes §22 went through.

### A v3 pool cannot be minted into, and the builder pretended otherwise

The screenshot that came with the question showed `VIRTUAL` with a market
pill reading `WETH · 0.3%` and a deposit field reading **`Max 4.18`**.
That figure is `MAX_DEPOSIT_ETH`, the prototype's stand-in balance, and it
renders when a pool has no `key`.

A pool has no key when it is simulated — or when it is a **Uniswap v3
pool**, which the live listing is full of (§20's history walk found 12,893
of them). The builder treated the two alike, so on the live site choosing
a token's v3 market dropped the whole flow into its simulated branch: a
balance it had never read, a wallet it had never asked, and a `Mint
position` button whose entire effect was a toast saying nothing had been
minted. On mainnet that is not an empty state, it is a fabrication, and it
is exactly what §7 exists to stop.

`lib/markets.ts` now holds the two rules, with their tests:

- **`isMintable`** — a pool is offered only if it is stakeable *and*, on
  live data, has a v4 key. Balast deploys no contract of its own and mints
  through v4's PositionManager (§20); a v3 pool stays listed, traded and
  charted, and is not offered here.
- **`byEntryCurrency`** — ALFA's rule. A market quoted in **native ether**
  goes in front of one quoted in the wrapper, whatever their depth, and
  everything after keeps depth order. A native market spends the balance
  the wallet already shows; a wrapped one needs an ERC-20 the wallet
  probably does not hold. So the builder opens on the native market.

Nothing is dropped silently. A token whose v3 markets were filtered out
says so under the market pills, naming their quotes and why they are not
offered. A link naming a pool the builder cannot offer — a bookmark, or a
pool that has since fallen below the listing bar — says so rather than
opening on some other token, which is what it used to do.

The drawer's hand-off had the same hole: the board's row is the token's
*deepest* pool, and the deepest can be the v3 one, so `Stake full range`
was pushing a pool id the builder would silently swap out. It resolves the
same target now — the token's best mintable market, native ether first —
and when that is not the row you clicked, the drawer says which pool it
will open and that its liquidity and fees are its own. A token with no
mintable market at all gets a third reason in its "not offered" note,
distinct from the hook and the launchpad ones.

### And ether that is already wrapped

Filtering to v4 does not make every ether market native: a v4 pool may be
quoted in aeWETH. Refusing those would hide real liquidity, and telling
someone to go and wrap on another site is not an answer either.

So the flow wraps. When the market's quote is the wrapper and the wallet
is short of it but holds the ether, the button becomes **`Wrap 0.1 ETH to
WETH`** and the mint follows it — one `deposit()`, one token per ether,
no price and nothing to slip (§18). It is estimated against the node
first, like every other call here, so a wrapper that will not take a
direct deposit reverts before a signature is asked for rather than after.
A gas reserve is held back so wrapping never leaves the wallet unable to
pay for the mint. The deposit line shows the ether balance beside the
wrapped one, because a `Balance 0` next to a wallet full of ether reads as
"you cannot do this".

`WRAP_CALLDATA` is asserted against the canonical WETH9 selector
(`0xd0e30db0`) in the test, and the wrap is recorded in the browser's
transaction list (§23) like the approvals and the mint.

### Verified here

On a fresh Postgres: `typecheck`, `lint`, the full suite — 43 files and
431 tests, with `lib/markets.test.ts`, the density cases in
`lib/shapes.test.ts`, the quote-side cases in `lib/format.test.ts` and the
wrap cases in `lib/v4/flow.test.ts` — the production build, and 36
Playwright end-to-end tests against that build, one of them new: the
density line and the estimate moving with the shape rather than with a
constant. All green.

**Unverified from here**, as always: the sandbox reaches no RPC, so the
wrap has never been sent. It is one `deposit()` on the address §20
verified against Uniswap's registry, and it is dry-run before signing —
but the first wrap on the live site should be a small one, watched on the
explorer, exactly as §20 said of the first mint.

### Still open

Unchanged: the §12 questions, `LAUNCHPAD_HOOKS` and `STAKEABLE_HOOKS`
(§14, §20), the listing bar's three thresholds, and the protocol fee's
immutable cap before any vault is deployed. `/positions`'s *Est. fee
yield* is still a forward-looking figure §1 sits awkwardly against — but
it is now scaled by arithmetic on the person's own inputs rather than by
a constant somebody guessed, which is the least a projected number owes
the reader.

### One name for one asset: an ether pair is ETH

ALFA, on reading the above: *maksud saya jangan weth pairednya tpi eth* —
the pair itself should be ETH, not WETH. Wrapping the person's ether for a
wrapped pool answered "what do I pay with"; it did not answer what the pair
is called, and that was the question.

**`quoteLabel` now returns `ETH` for every ether pair**, whether the pool
holds ether natively, as aeWETH, or is a v3 pool (which has no native-ether
pool at all, so its ether pair is always the wrapper). It is one line, and
it changes every pair label on the site at once, because it is the one
function that names a pair — the board, the drawer, the builder, the vault
cards, the stakes table, the portfolio and the transaction labels.

This is a statement about the wrapper rather than a convenience, and §18
had already made it for pricing: aeWETH mints one token per ether deposited
and burns one per ether withdrawn, so one aeWETH **is** one ether, and
pricing a native pool through the wrapped anchor is exact rather than an
approximation. Two names for one asset put a currency on the page that
nobody holds a separate opinion about and asked a reader to tell apart a
difference that exists only inside a contract.

What the wrapper does change is what a wallet must hold, and that is
answered where it matters rather than by renaming the asset on every row:

- `quoteIsWrappedEther` is the one place that asks, and the builder uses it
  to wrap the shortfall as part of the mint and to say that it did.
- **The deposit shows one balance.** A wrapped market used to show its
  wrapped balance alone — a zero beside a wallet full of ether, which reads
  as "you cannot do this". `quoteSpendable` is the wrapped balance plus the
  ether that could be wrapped for it, less the gas the mint still has to
  pay; the tooltip carries the split, and the same figure is what the
  "above your balance" message names.
- **A clash is marked, and only a clash.** A token with both a native and a
  wrapped pool at the same fee tier would show one label twice, so the
  wrapper carries `· wrapped` in that case. Naming it everywhere would put
  the distinction back on every row, which is the thing the one name
  removed.

The `weth()` formatter is `ether()` and prints `ETH`, and the hardcoded
`WETH` in the vault, stake, portfolio, payout and router copy went with
it — a site that names the pair ETH and the fees WETH contradicts itself.
`e2e/forms.spec.ts` asserts no `WETH` appears on the board or in the
builder, so the two names cannot drift back apart.

One thing the same screenshot showed: **`0.1 USDG · Max 4.18`**. The
simulated wallet is 4.18 ether and was printed against whatever unit the
market used, so over a USDG market it claimed the wallet held four dollars.
The prototype had one quote and never met this; the stand-in is stated in
the market's own quote now, and the end-to-end test reads the figure off
the field rather than assuming a number.

**Verified**: typecheck, lint, 432 unit tests, the production build and 37
Playwright tests, all green, and the builder checked by screenshot at
1280px on both an ether and a USDG market.

### Twelve pills for one token: the compound question, again

ALFA, on CASHCAT in the builder: *market pair eth aja berbeda2 fixkan*.
The screenshot showed twelve markets — `ETH · 2%`, `ETH · 0.5%`,
`ETH · 0.46%`, `ETH · 0.66%`, `ETH · 0.96%`, `ETH · 3%`, and six more in
USDG.

**The tiers are real.** `pools.fee_tier` is written only from the pool's
own `Initialize` log, which carries the fee named in its `PoolKey`, and
Uniswap v4 lets that be any value a hook chooses — it is not restricted to
v3's four tiers. On a launchpad chain a token accumulates pools at
whatever fee whoever created them picked. Nothing was miscomputed; there
is no dynamic-fee flag leaking through, and `feeTierLabel` was right.

What was wrong is that the control asked one compound question — the same
fault §26 fixed for token-and-market, one level down. **Which currency do
I pay with** has two or three answers and decides whether the wallet can
enter at all. **Which of that currency's pools** decides what the position
earns, and it cannot be answered from a percentage alone: `ETH · 0.46%`
against `ETH · 0.66%` is not a choice, it is noise.

So there are two controls. **Market** names currencies and nothing else —
`ETH`, `USDG` — and picking one selects that currency's deepest pool.
**Fee tier** appears only when that currency has more than one pool, lists
them deepest first, and carries **the pool's own liquidity on each
option**, because that is the figure the choice turns on. Twelve
undifferentiated pills become two plus six, and the six are ranked and
readable.

`lib/markets.ts` holds it: `quoteGroups` groups and orders (the ether
group leads, per §27; everything else by its deepest pool), `orderMarkets`
flattens it so `[0]` is still what the builder opens on, and
`poolLiquidityUsd` is deliberately **the pool's figure and never the
token's** — an aggregator's token-wide liquidity is the same number for
every pool of that token, so ranking pools by it ranks nothing. An unknown
depth is null and sorts last, never zero (§14).

### The drawer was substituting a pool nobody asked for

Found while changing the ordering. §27 gave the drawer's Stake button a
`stakeTarget` — the token's best mintable market — and sorted the
candidates with the row's own pool merely one of them. With ether ordered
ahead of a deeper USDG market, clicking Stake on a USDG row could open the
ether pool instead. The row's own pool is now taken whenever it can be
minted into, and the fallback applies only when it cannot; and that note's
copy asserted the reason was always a Uniswap v3 pool, when an unverified
hook is the other way to get there. It names whichever it is.

### The simulator had never sent a token's other markets

`otherPools` has been in the snapshot since §26 and `SimProvider` never
filled it, so every token in the prototype had exactly one market and the
whole path — the market control, the fee-tier control, the deposit
re-defaulting when the currency changes — was unreachable in a browser and
untestable end to end. The live board was where each was first seen, which
is how all three of these faults reached it.

The simulator now gives its two deepest pools a second currency and a
spread of tiers, in no total (§12), shaped like the case that broke the
control. `e2e/forms.spec.ts` asserts the market pills carry no percentage,
that exactly one is selected, and that every fee-tier option carries a
liquidity figure or an honest dash.

**Verified**: typecheck, lint, 438 unit tests, the production build and 39
Playwright tests, all green, plus the builder checked by screenshot at
1280px — `Market: ETH | USDG`, `Fee tier: 0.3% $6.20M · 1% $1.40M ·
0.05% $421.5K`, and the tier list changing with the currency.

### A range of 3.4e38, and a yield that called itself an estimate of itself

ALFA, on the live builder with CASHCAT full range: *skrg mala ngaco ini
bikin orang bingung*. The right-hand panel read

```
RANGE   0 – 337,815,857,900,711,430,000,000,000,000,000,000,000 ETH
```

over four wrapped lines. A full-range position runs to the lowest and
highest ticks the spacing allows, which as a price is 0 and about 1e38, so
the number is arithmetically correct and completely useless: it means
*every price*, and printed literally it reads as a fault. It is `0 → ∞`
now, and the legend beside it — *Token side / ETH side / Current price* —
no longer renders either, because it reads a bin chart that a full-range
position does not draw.

**The yield was an estimate of itself.** Full range concentrates nothing,
so `estYield` was exactly the pool's trailing figure — and the cell showed
`1445%` under `est. · from 1445% trailing`, which reads as a projection
stacked on a projection. In that mode it is labelled the way the board and
the drawer label it (§7): *Fee yield*, with the pool's own qualifier —
`trailing 7d`, or `est.` and the age for a pool younger than a week.
Nothing about the figure changed; what changed is that it no longer claims
to be a forecast it never was.

Two smaller things from the same screenshot. The summary's fee tier read
`2.00%` beside a pill reading `2%` — one screen, one number, two
spellings; both use `feeTierLabel` now. And the market hint said *"Both
sides of the deposit are taken in it"*, which is false: the amount is
counted in the quote, and the mint takes some of each currency, which is
what the `You deposit` line beneath it had been saying all along.

The tier pills reading `0.46% —` are honest and were not explained. A dash
is unknown depth (§14) — the indexer cannot reconstruct that pool's
liquidity from its own events, and the pool is listed because it has
traded. The hint says so when any tier shows one.

**Verified**: typecheck, lint, 438 unit tests, the production build and 40
Playwright tests — one new, asserting the range reads `0 → ∞` and the
yield stops calling itself an estimate when the full-range box is ticked.

### The yield, on Uniswap's basis — ALFA's call, and §1 set aside

ALFA, on the same panel: *masih sama aja saya ingin data yeild-nya real
seperti uniswap*. Two things in one screenshot, and the first is why the
second was still on screen.

**The range and the est-yield fixes above were committed, not deployed.**
Nothing on the box had changed. What *had* deployed was the fee-tier
control, and it showed the next fault.

### Four pools at an identical $5.42M

`0.46% $5.42M`, `0.66% $5.42M`, `0.96% $5.42M`, `3% $5.42M` — one figure
on four pools, ranked above the 2% pool whose real depth the chain gives
as $325.4K. Mine, one commit old, and the function's own doc comment had
warned against it: an aggregator's quote is fetched **once per token** and
attached to every pool of it, so `market.liquidityUsd` is the token summed
over its pairs and `market.poolLiquidityUsd` is the single pair the source
picked. Neither distinguishes one pool of a token from another, which is
the only thing `poolLiquidityUsd` exists to do. The field name is what made
it look like a pool's figure. It is the chain's `tvl_usd` and nothing else
now, with a dash where that is unknown (§14).

### The yield is 24h fees, annualised

`1445%` is honest arithmetic — `fees over a 7-day window ÷ liquidity ×
365/7` — and **every input was 74 days old**: July's fees over July's
liquidity, with nothing on the panel saying which day that was.

The alternative was put to ALFA, because Uniswap's basis is precisely what
§1 calls non-negotiable-forbidden (*never annualise a single day*), and
ALFA chose it. **§1's "displayed yield is trailing" is set aside; this
section is that decision.** What replaced it:

`shownYield` in `lib/market-figures.ts` — the file §21 made for exactly
this — prefers **`now24h`**: the fees the pool actually took in the last 24
hours of chain time, annualised, over the pool's own liquidity. The
numerator is the head reader's (§25), so it is current while the backfill
is months behind, and it is each swap's **real fee amount** at its token's
price — `rebuildFeeHourly`'s own expression, never volume × tier, because a
dynamic-fee pool's per-swap fee is not its key's fee and a hook on this
chain can take most of a trade (§20). `recent_swaps` already carried
`fee_amount`; the head query simply had not summed it.

Everything else in §1 and §7 stands, and two rules needed defending
explicitly:

- **Never a figure from under 24 hours of data.** A pool three hours old
  has three hours of fees in the head window, and annualising them as a day
  is the "1-day-old pool showing 1200%" §7 exists to stop. Below 24h the
  figure falls back to the indexer's, which says `insufficient` — an em
  dash, now with *not enough data yet* beside it rather than only in a
  tooltip.
- **A pool under a week carries its age.** The liquidity the figure divides
  by has as little history as the fees above it. `young` is true when
  either the age or the indexer's own `estimate` basis says so, so the
  qualifier cannot be dropped because one field disagreed with the other.
- **Nothing is ever called APY or APR**, and a figure from one day is never
  labelled a trailing seven. The basis travels with the figure:
  `fee yield · 24h, annualised` or `fee yield, trailing 7d`, on the board,
  the drawer, the vault cards and the builder, which all read the one
  function. And where the figure *is* the indexer's, it now carries how old
  it is — `74d 2h old` — which is §7's own lag rule applied to the number
  that most reads as live.

The board's fee-yield facet ranks on the figure it displays, which it had
stopped doing the moment the two could differ (§21's lesson, again).

### Two regressions caught before they shipped

**The board froze.** `SimProvider` had never filled `now`, so adding it
exercised the `now` path for the first time — and the market tick updated
only the indexed fields, so `shownVolume`, `shownChange`, `shownSplit` and
the yield all read a `now` that never moved. The tick updates it. This is
the `otherPools` lesson a second time: a path the simulator cannot reach is
a path first seen on the live board.

**The caption said what the label said.** `yieldCaption` returned the basis,
which every surface already prints under the number, so each row carried
`fees 24h · annualised` inline over the volume column to its left. It
returns only the qualifiers now — `est.` and an age, a staleness — and null
when there are none, which is what the board had before and why no row used
to carry one.

`ChainNow.at` became nullable for the simulator, which reads no clock by
design so a snapshot cannot drift between two renders; a time is a claim
about when, and the simulator is in no position to make one.

**Verified**: typecheck, lint, 447 unit tests, the production build and 40
Playwright tests, all green, and the board and builder checked by
screenshot at 1280px.

**Still ALFA's, and worth revisiting**: one day is a noisy basis — a quiet
day or a busy one moves the figure a long way, which is what §1 was
protecting against. The tooltip says so on every figure. If the noise reads
badly once the backfill nears head, the trailing-7d figure is one line
away and both are already computed.

---

## 28. The ether pair was a v3 pool, and v3 was never the obstacle

ALFA, for the third time, on VIRTUAL: *mengapa pairnya cmn usdg ga ada
paired with eth robinhood*. The page answered its own question — *VIRTUAL
also trades in 1 Uniswap v3 pool (ETH). Balast mints through Uniswap v4,
so it is listed but not offered here* — and the answer was wrong about
why.

**Uniswap's v3 NonfungiblePositionManager is deployed on this chain**, at
`0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`, from the same registry entry
that §20 verified every other address against (`ROBINHOOD_ADDRESSES` in
`sdks/sdk-core/src/addresses.ts`, chainId 4663, which the registry also
confirms is `ROBINHOOD` and a supported chain). So a token's ether market
being a v3 pool was never a fact about Robinhood Chain. It was a gap in
what Balast had built, and it had been answering three rounds of questions
on ALFA's behalf.

`/positions` mints into v3 pools now. `lib/v3/mint.ts` plans one, and
everything above the encoding is shared with the v4 planner — the same
range ticks, the same tick-spacing split, the same shape weights, the same
liquidity maths — so a shape means the same thing in either venue. What
differs is the call, and each difference is a place to get it wrong:

- v3 `mint` takes **desired amounts and minimums**, not a liquidity figure.
  Each bin's own amounts become its own caps, as the v4 plan caps each
  position.
- Several bins are several `mint` calls through the periphery's own
  `multicall`.
- A v3 pool holds **wrapped** ether, never native — and the manager is
  payable and wraps what it is sent, so the person still pays in ETH, which
  is what ALFA asked for in §27. `refundETH` is the last call in the batch
  and is not optional: without it the unspent ether stays in the manager.
  The wrapped balance is spent when it covers the mint, since that costs no
  ether and needs no wrapping; ether pays when it does not.

### The arithmetic is Uniswap's, not something close to it

Two numbers reach a v3 `mint` and the first draft had both subtly wrong.

**`amountDesired` rounds up.** It is what the manager may pull to reach the
target liquidity; the indexer's `amountsForLiquidity` rounds down, because
it exists to sum a pool's reserves. Off by one wei, and silently short.

**`amountMin` is not a flat percentage off the desired.** The guard has to
be *what would this liquidity need if the price moved against it by the
tolerance*, which Uniswap computes by pricing the same position at both
ends of the tolerance and taking the smaller amount from each end. At 3%
the honest figure came out well **below** `desired × 0.97` — so a flat
figure would have reverted mints that were perfectly fine, and, in other
configurations, guarded less than it claimed.

So `lib/v3/amounts.ts` ports `mintAmounts`, `maxLiquidityForAmounts` (the
**imprecise** form, which is the one the v3 periphery itself uses — core's
more precise form would plan a position the router cannot create),
`ratiosAfterSlippage` and `mintAmountsWithSlippage`, exactly.

**`lib/v3/mint.test.ts` compares the encoded bytes with Uniswap's own SDK**
building the same position, and asserts the desired and minimum amounts
against `Position.mintAmounts` and `Position.mintAmountsWithSlippage`. That
is §20's discipline, and it is what makes an un-fork-tested money path
defensible: the first draft's two faults both failed there, as bytes that
did not match, rather than as a bad fill on chain. The SDK stays a dev
dependency — it carries ethers v5 and JSBI and would double the page.

### What else moved

- **Every live pool has a `key` now**, v3 included; `protocol` is what the
  flow branches on. `isMintable` is back to meaning what it says.
- **`useMintFlow` has a venue.** The price comes from the pool's own
  `slot0()` rather than StateView; the approval goes **straight to the
  manager**, since v3's periphery does not use Permit2; the dry run and the
  send target the other manager. The §27 wrap step does not apply to v3 at
  all — its manager wraps inside the mint, so a separate transaction would
  only cost a signature.
- **A tier pill says what separates two pools at the same tier.** A v3 and
  a v4 pool at 0.3% in the same currency are entirely different pools, so
  the protocol is named; the wrapper is named only when two v4 pools differ
  in how they hold ether, as before.
- The copy that told people a v3 pair was listed but not offerable is gone
  from the builder and the drawer. What is left there is the one reason
  that still stands: a hook Balast has not verified (§20).

### Unverified from here, and it matters more than usual

The sandbox reaches no RPC, so **no v3 mint has been sent**. What stands
behind it is the byte-comparison with Uniswap's SDK, the node's dry run
before any signature, and the per-position caps. As §20 said of the first
v4 mint and §27 of the first wrap: **the first v3 mint on the live site
should be a small one, watched on the explorer.** It is the first path here
that pays a pool in ether through a wrapping manager, so the thing to check
on the explorer is that the refund came back.

**Verified**: typecheck, lint, 455 unit tests — the seven new v3 cases
among them — the production build and 40 Playwright tests. All green.

---

## 29. An audit of the path to Uniswap, before mainnet

ALFA asked for the whole codebase audited as a senior engineer would before
calling mainnet live, and for every liquidity action to go through Uniswap.
The second is already true, and this section starts by saying exactly how;
the rest is what the audit found wrong and fixed.

### Where the money goes

Balast deploys no contract. Every transaction the site can send goes to one
of Uniswap's own contracts on this chain, each checked byte for byte
against Uniswap's registry (§20, §28), or is an approval for one of them:

| Action | Contract | Built by |
|---|---|---|
| Mint, v4 pool | v4 PositionManager `0x58da…4FA7` | `lib/v4/mint.ts` |
| Mint, v3 pool | v3 NonfungiblePositionManager `0x7399…E0D3` | `lib/v3/mint.ts` |
| Collect / withdraw, v4 | v4 PositionManager | `lib/v4/manage.ts` |
| Collect / withdraw, v3 | v3 NonfungiblePositionManager | `lib/v3/manage.ts` (new) |
| Approve for v4 | the token → Permit2 → PositionManager | `lib/v4/flow.ts` |
| Approve for v3 | the token → the v3 manager | `lib/v3/flow.ts` |
| Wrap ether for a v4 pool quoted in aeWETH | aeWETH `deposit()` | `lib/v4/flow.ts` |

Every encoder is compared as bytes with Uniswap's own SDK building the same
call, every transaction is run by the node (`eth_estimateGas`) before the
wallet is asked to sign, and the position NFT is minted to the person's
wallet. No live action claims success without a receipt: the one pair of
buttons that did — *Claim* and *Compound* on `/stakes` — only render on
simulated data, and now say so.

### v3 positions were a one-way door

§28 made `/positions` mint into v3 pools. Nothing else followed it: the
indexer follows only v4's PositionManager, so a v3 position minted here
never appeared in the portfolio, and if it had, `usePositionActions`
refused it ("manage it on Uniswap"). The site could put money into a v3
pool and could not show it or take it back out — exactly the fault §22
recorded for v4 and §23 closed.

**The portfolio reads v3 positions from the chain.** v3's manager is an
ERC721Enumerable, so what a wallet holds there is `balanceOf`,
`tokenOfOwnerByIndex` and `positions` — current state, three multicalls,
no history to index (`lib/v3/positions.ts`). The API reads them through
the same RPC failover as everything else, bounded at eight seconds, and
matches each to the pool the indexer knows by its two tokens and fee, so
it is valued through the same one path to dollars (§4.3) as a v4
position. Three honest limits, each on the page:

- **Principal is not known**, because the funding history is not indexed,
  so a v3 position has no *price impact on holdings*. The card says
  `N of M positions measured`, and a dash when none are — never a $0 that
  reads as "no loss".
- **A pool the indexer has not met** cannot be valued or named, so its
  position is counted (`v3.unindexed`) and left out, and the page says to
  manage it on Uniswap.
- **A node that does not answer** costs the v3 rows and never the v4 ones;
  the page says v3 could not be read. The endpoint's own error goes to the
  log, not the page — a paid endpoint's URL carries its key.

`PORTFOLIO_V3=false` turns the v3 half off. (Superseded by §30: the whole
portfolio is read from the chain now, and the variable is `PORTFOLIO_CHAIN`.)

**Uncollected fees** are read the way Uniswap's own interface reads them:
an `eth_call` of `collect(max, max)` from the owner, which returns what a
collect would pay now and changes nothing. A failed v3 read no longer takes
the v4 readings with it, or the other way round.

**Collect and withdraw** (`lib/v3/manage.ts`) are laid out as the SDK's
`collectCallParameters` and `removeCallParameters` lay them out — the test
compares the bytes — with the withdrawal's minimums from Uniswap's own
`burnAmountsWithSlippage`, ported and compared at prices below, inside and
above the range. For an ether pair the wrapped side is collected into the
manager, unwrapped, and sent as ETH (§27) — **but only after the manager's
own `WETH9()` is read and matches aeWETH.** Were it anything else,
`unwrapWETH9` would unwrap nothing and the wrapped side would sit in the
manager where anyone could sweep it; on a mismatch or an unanswered read
both sides are collected straight to the owner instead. Uniswap's SDK
names aeWETH as this chain's WETH9, so the check is expected to pass; it
exists because the failure would be silent.

v3 and v4 number their NFTs independently, so a token id alone is not a
position's identity: `lib/position-ref.ts` keys fee readings, busy rows and
React keys by manager and id.

### Faults in the mint path

- **A wrap one wei short.** For a v4 pool quoted in aeWETH, the flow
  wrapped exactly the planned quote amount — but the pool rounds each
  position's amount up by a wei, so Permit2 was asked for slightly more
  than the wallet held, the dry run refused, and the page had no step left
  to offer. `wrapShortfall` wraps at least the planned amount plus a wei a
  position and up to the slippage cap as far as the spare ether allows,
  and has tests for the edges, including a cap below the floor.
- **A v3 pay-in-ETH decision made against the wrong figure.** Whether the
  wrapped side is paid in ether was decided against the deposit rather than
  what the plan actually pulls, and the balance shown summed the wrapped
  balance and the ether — but v3's manager pays a side from one or the
  other, never both, so a wallet with half of each passed the check and
  failed the dry run. The decision is made against the plan's own amount,
  the spendable figure is the larger of the two, and the plan no longer
  changes (with a fresh dry run) on every balance re-read.
- **A v4 dynamic-fee pool's tier read "838.86%".** Its key carries the
  `0x800000` flag instead of a tier. `feeTierBpsFromPips` makes it null, and
  it reads *dynamic* on the board, the builder and the drawer.

### Also fixed

- A position in a pool with no indexed price read `$0` and "out of range —
  earning nothing" in red, with a rebalance prompt. A v3 pool is announced
  without a price and gets one at its first swap; until then the row says
  the range status is not known and the value is a dash, and neither is
  counted as earning nothing.

### Verified here

On a fresh Postgres: `typecheck`, `lint`, the full suite (46 files, 471
tests — the v3 manage, portfolio-v3 and wrap suites among them), the
production build and the 40 Playwright tests. An independent review pass
over the diff checked the collect/withdraw layout against v3-periphery's
`PeripheryPayments` and found the edges fixed above.

**Unverified from here**, as always: the sandbox reaches no RPC, so no v3
collect or withdrawal has been sent. **The first one on the live site
should be a small position, watched on the explorer** — and the thing to
check is that the ether side arrived as ETH and nothing was left in the
manager.

### Still open

Unchanged: `STAKEABLE_HOOKS` and `LAUNCHPAD_HOOKS` (§14, §20), the listing
bar's thresholds, the §12 questions, and the single-token zap (§23). The
single-token zap is still the one Uniswap-routed action that is not built:
every mint is two-sided until it is.

---

## 30. Withdrawal, and every position being withdrawable

ALFA, after §29: *pastikan withdraw atau udh close posisi juga working semua
dana pastikan safe* — make sure withdrawing and closing a position works, and
that every fund is safe. This section is the answer, and it starts with a
fault §29 did not see.

### A position not on the page cannot be withdrawn here

The portfolio took its v4 positions from the indexer, and the indexer is as
far behind as its backfill — seventy-odd days on the box (§25). So **every
v4 position minted in that gap was missing from the page**, including every
one minted through this site: the mint succeeded, the NFT was in the wallet,
and Balast offered no way to take the money back out. And the other way
round: a position withdrawn in that gap (here, in another tab, or on
Uniswap's own site) stayed on the page with Withdraw still offered, because
the indexer had not yet read the burn. §29 fixed v3 by reading it from the
chain; v4 had the same fault in a worse form.

**The portfolio now lists what the chain confirms the wallet holds**
(`server/api/portfolio.ts`). The indexer is a source of candidates and of
dollar prices, and no longer the source of truth about ownership:

- **v3** is enumerated on its position manager (§29).
- **v4**'s PositionManager is not enumerable, so its candidates come from
  three places — the indexer's `positions` table (every token it last saw
  the wallet holding, emptied or not); a background scan
  (`server/api/v4-scanner.ts`) of `ownerOf` over the last 50,000 ids up to
  `nextTokenId`, new ids every 30s and the whole window again every ten
  minutes — deliberately not starting at the indexer's highest id, since an
  old position sent to this wallet since the indexer's last block would be
  in neither place; and the ids this browser
  saw minted, remembered from each mint's receipt (`lib/tx-history.ts`) and
  sent as `?v4=` so a position is on the page the moment its receipt is in.
  **Every candidate is then confirmed on chain** (`lib/v4/positions.ts`):
  `ownerOf`, `getPoolAndPositionInfo` and `getPositionLiquidity`. A burned
  or sent-away token, or an empty one, is not shown. A hint can only ever
  add a question, never an answer.
- **The pool's price is read live** (`slot0`, through StateView for v4), so
  in-range and the two amounts are today's rather than the backfill's. Dollar
  prices remain the indexer's, through the one path §4.3 allows. The "out of
  range since" figure is given only when the status is the indexer's, since a
  date from its swaps against a live tick would be weeks wrong.
- **A pool the indexer has never met** is described from the chain — its
  key, and its tokens' symbol and decimals from the indexer's table or the
  token's own contract, a v3 pool's address from the factory — and is
  listed and withdrawable. Its value is priced through another pool of the
  same token if there is one, and is a dash if not.
- **The principal** (price impact on holdings) is kept only while the
  indexer's record of the position matches the chain's liquidity.
- **When the node does not answer**, each half fails on its own: a v3
  read that times out costs the v3 rows and never the v4 ones, and the
  other way round. Without v4 the indexer's record is listed, marked
  unchecked; without v3 nothing can be listed for it; without live prices
  the in-range status is the indexer's. The page says which of these
  happened. Withdraw still dry-runs on the chain first, so an unchecked row
  cannot send anything the chain would not accept.
- **A scan that has not finished** — no pass yet, a failed pass, a quiet
  one, or more ids than its window — is reported as a possibly incomplete
  list, rather than a complete one.

The packed `PositionInfo` is decoded by hand, since no Uniswap SDK
function exists to compare it against. So the decode is checked twice on
every read: its pool-id bits must match the key returned beside it, and
StateView must report the same liquidity at the decoded range. A position
that fails either check is counted in `unreadable` and not shown, and the
page says how many. The layout is v4-periphery's own
`PositionInfoLibrary.sol` (tickLower at bit 8, tickUpper at bit 32, pool id
in the top 200 bits), and the decode was confirmed against the real
contract below.

`/api/health` carries `portfolioScan` — the scan's window, whether it is
partial, and its last error. `PORTFOLIO_CHAIN=false` turns all of it off.

### The withdrawal itself

- **v4 minimums are Uniswap's price-tolerance guard**, the same
  `burnAmountsWithSlippage` the v3 withdrawal uses, rather than a flat 1% off
  today's amounts. Near the edge of a range one side shrinks far faster than
  the price moves, so the flat cut refused ordinary withdrawals. v4's
  `BURN_POSITION` checks the minimums against the principal only, fees
  excluded, so a hook that tried to skim the principal on the way out would
  make the burn revert rather than pay less.
- **A position the chain says is empty** is refused before any signature.
- **A double-click cannot open two wallet prompts** for one position.
- **After any failure the list is re-read**, so a row for a position already
  withdrawn goes away rather than lingering.
- **Messages the flows write are shown as written** (`ShownError`). Every
  one of them — *already empty*, *reverted on chain* — was being replaced
  by "could not be prepared".
- **Reverts are said in words.** Uniswap's contracts revert with custom
  errors that the site's ABIs do not declare. A node's answer therefore
  carries the four-byte selector and not the name, so matching on the name
  never matched a real revert. The messages are matched on selectors now:
  *the price moved more than the tolerance*, *this wallet no longer holds
  this position*, *expired*. A loose `amount.*exceed` pattern, which read
  "transfer amount exceeds balance" as a price move, is gone; a balance
  says it is a balance.
- **A pool of two tokens with neither dollar nor ether** no longer prices
  its second token at the first one's price; that side is unknown and the
  value is a dash.

### Proven against Uniswap's own contracts

`npm run check:lp` (`server/scripts/lp-local.ts`) deploys Uniswap's published
bytecode on a local chain with chain id 4663: v3-core and v3-periphery from
this repository's `node_modules`, v4-core and v4-periphery from their npm
packages, and Permit2 at its canonical address. It then drives them only
through the functions the pages call: plan, dry run, send, receipt. Nothing
is mocked below the RPC. After every step it checks where each wei went.
63 checks, all passing:

- **v3**: a 5-bin mint paid in ETH, with the unspent ether refunded; fees
  from real swaps, read by a simulated collect; a collect paying out
  exactly those fees, the ether side as ETH and no WETH arriving; every
  position withdrawn, in range and out of range, each at or above its
  minimums and its NFT burned; and the manager holding **zero** ETH, WETH
  and token after every step.
- **v4**: a 5-bin native-ETH mint through Permit2, with the rest swept
  back. The id scan finds all five positions, and every decoded range and
  liquidity matches what was minted. A collect pays exactly the fees
  StateView reported. A withdrawal planned before a large trade moved the
  price is **refused by the dry run, and the page says why in words**, with
  the position untouched. Every position is then withdrawn and burned, and
  PositionManager holds **zero** after every step.
- **Wrapped-ether v4 pool**: wrap to the planned amount plus rounding, then
  mint — the §29 one-wei fix, on real contracts.
- **The API's own chain reader** against the same node: v3 enumeration, v4
  confirmation, both pools' prices, the factory lookup (including a pool
  that does not exist), and token metadata (including an address that will
  not state its decimals).

### What this does not prove

The run is Uniswap's bytecode on a local chain, not Robinhood Chain. It
proves the calldata and the flows. It cannot prove the addresses in
`lib/chain.ts` — those were matched against Uniswap's registry (§20, §28)
— or how the public endpoints behave. **The first withdrawal on the live
site should still be a small one, watched on the explorer.**

A v4 position whose id is more than 50,000 below the newest, and which
reached this wallet after the indexer's last block, is found only once the
indexer reaches the transfer. The page says when the scan does not cover
every id. A v4 NFT sent *to* this wallet inside the window is seen at the
next full rescan, within ten minutes. The scan costs about a hundred
multicalls every ten minutes on the public endpoints. The portfolio
endpoint is rate limited like every other endpoint, but a wallet holding
thousands of NFTs costs its requests proportionally more.

Two independent review passes over this change found the faults listed
above, all fixed before commit. The second found three more ways a held
position could fall off the page — a v3 timeout discarding the v4
answer, a position emptied and refilled since the indexer's last block, an
unfinished scan reported as complete — and each now has a test.

### The scan that never finished once

The first deploy of §30, from `/api/health` on the box:

```
"portfolioScan": { "from": null, "lastScanAt": null,
                   "lastError": "nextTokenId failed on all 4 endpoints:" }
```

Two faults of mine, one hiding the other. **The error kept only its first
line**, which is the sentence the RPC failover writes *before* listing each
endpoint's own reason — so the one thing that would say why (a 429, a
timeout, a revert) was cut off, and "failed on all 4 endpoints" with no
reasons sends whoever reads it nowhere. And **a pass was all or nothing**:
about a hundred multicalls over the same public endpoints the indexer is
already pressing, thrown away whole on any single refusal, so under a rate
limit it could fail for ever without keeping anything it had read.

The scan now keeps its progress chunk by chunk (`CHUNKS_PER_PASS` requests
of `CHUNK` ids a pass, ten of five hundred): new ids first, then the next
part of a sweep across the window, resumed where the last pass stopped.
The error keeps every endpoint's reason, with each URL cut to its host so
a paid endpoint's key never reaches `/api/health`, and the API's log gets
a `v4 scan:` line whenever the reason changes. `deploy/doctor.sh` reports
the scan too — off, failing (with the reason), mid-sweep, or complete.

`PORTFOLIO_CHAIN=false` is not the remedy for a failing scan. It turns off
the chain reads altogether, and the portfolio goes back to the indexer's
record, which is weeks behind — exactly what §30 was written to stop.

### Two addresses with the right bytes and the wrong case

With the scan's whole reason finally on screen, the box said it:
`rpc.mainnet.chain.robinhood.com: Address "0x58daEc31…" is invalid`. The
v4 PositionManager and the v3 factory in `lib/chain.ts` were typed with
correct bytes and a mixed case whose EIP-55 checksum does not validate. The
indexer never noticed, because it lowercases both. viem does not lowercase:
it refuses such an address in `readContract`, `estimateGas`,
`sendTransaction` and every ABI encoding of an address argument. So on the
live site **every v4 action failed before it reached the chain** — the
Permit2 approval (PositionManager is its spender argument), the mint's dry
run, collect and withdraw — along with this scan and the v3 factory lookup.
No funds were ever at risk, since nothing could be sent, but nothing v4
worked either.

Nothing had caught it. The unit tests use fake clients, and
`npm run check:lp` replaces these addresses with freshly deployed ones.
`lib/chain.test.ts` now asserts that every address in `CONTRACTS` is valid
and checksummed. The scan's error also turns `"` into `'`, because viem
quotes the address and the quote cut the doctor's reading of it short.

### Three million position ids, and a doctor that warned about the normal

With the addresses fixed the scan ran — `first sweep running (id 3,098,729
of 3,147,729)` — and showed the size of the thing: **v4's PositionManager
has minted over three million NFTs on this chain**, about forty thousand a
day. The scan's 50,000-id window is a day or two of that. The indexer, which
knows the older ones, is weeks behind. So a position minted a week ago on
another device — or through Uniswap's own site, or sent to this wallet — was
on neither list, and therefore not withdrawable here.

**The explorer is asked for the rest** (`server/api/explorer-positions.ts`):
Blockscout's `/api/v2/addresses/{address}/nft?type=ERC-721` lists the NFTs a
wallet holds, and those under PositionManager are v4 positions. It is a list
of candidates, not a number: every id it names is confirmed on chain before
it is shown (§30), so a wrong or stale answer can only fail to add a row.
Answers are kept per wallet for thirty seconds. The page's *may be missing*
note now appears only when neither the explorer nor a complete scan vouches
for the list. `/api/health` carries `portfolioExplorer`, and
`PORTFOLIO_EXPLORER=false` turns it off. The response shape is Blockscout's
documented one, unverified from here, as the logo source was; if the
explorer refuses, the doctor says so.

**Four of the doctor's warnings were not faults**, and a warning that means
nothing trains its reader to ignore the one that does:

- `START_BLOCK is 0` — genesis is the only start that misses no pool's
  funding mint on pruned endpoints (§17), and a sync under way resumes from
  its cursor anyway. `ok`.
- `V3_FACTORY unset — v3 pools will only be those hand-listed` — false
  since §20, when Uniswap's factory became the default. `ok`, reworded.
- `first sweep running` — expected for minutes after every restart. `ok`.
- `No tokens followed yet` — the first snapshot being built after a
  restart. `ok` for the API's first ten minutes, which `/api/health` now
  reports as `api.uptimeSeconds`. A warning after that, with the log line
  to read.

And `deploy.sh`'s summary asked the API once, the instant PM2 had restarted
it, and printed *the API did not answer* on every healthy deploy. It now
waits up to a minute. The doctor also read the scan's `lastError` from the
next object in the body whenever the scan's own was null. Each object is cut
at its closing brace now.

---

## 31. A yield of 1897%: today's fees over July's liquidity

ALFA, on the builder with VIRTUAL / ETH at full range: *fee yield mengapa
terlalu besar, estimasi ngaco ini*. The figure read `1897% · 24h`. Then,
on VIRTUAL / USDG: the token's contract address should be on the page,
copyable.

### Why 1897%

§27 put the yield on Uniswap's basis: the fees a pool took in the last 24
hours, annualised, over the pool's liquidity. The numerator was right. It
comes from the head reader (§25), so it is today's fees. The denominator
was `pool.tvlUsd`, which is the indexer's. The indexer was seventy-four days
behind, so that figure is the pool's liquidity in July. Pools on this chain
have grown several times over since then. A quotient whose top and bottom
were measured two months apart is not a yield. The formula was not the
fault; the dates were.

### What the yield divides by now

The rule is that today's fees are divided only by a liquidity figure that
is also current. `Pool.liveLiquidity` carries that figure and says where it
came from:

- **v3 pools: the chain.** A v3 pool is its own contract and holds its own
  tokens, so its reserves right now are two `balanceOf` calls.
  `server/api/live-reserves.ts` reads every listed v3 pool once a minute,
  in one multicall, and prices both sides at today's prices:
  - the token at the head reader's price;
  - ether at the live price or the head's price;
  - USDG at a dollar.

  The balance includes fees not yet collected, which is how Uniswap's own
  analytics count it. That makes the yield a shade conservative and never
  flattering. A reading older than five minutes is not used. A pool the
  node did not answer for has no reading, and never a zero.
- **v4 pools: an aggregator's figure, but only for this exact pool.** A v4
  pool holds nothing of its own, because the PoolManager holds every
  pool's tokens together. So the chain has no two-call answer for it.
  An aggregator's liquidity is used only when the pair it describes
  (`MarketQuote.poolLiquidityPool`) is this pool's own id. That guard
  exists because §27 found four pools of one token each wearing the
  token's figure.
- **Neither, and the yield is the indexer's trailing figure.** It is
  labelled with its age, as before. It is never today's fees over an old
  denominator.

`lib/market-figures.ts` still makes the choice once, for the board, the
drawer, the vault cards and the builder. `ShownYield.liquiditySource` says
which source was used, and the tooltip names it.

### The axis was July's too

The builder turned the range's percentages into prices using `pool.priceUsd`,
which is the indexer's price. For VIRTUAL / USDG the chart read *current
price 0.75289* over an axis of `$0.4595 – $0.6217`: a range around a price
from two months ago, drawn under today's. The builder now uses the price it
plans against, which is the pool's own `slot0`, read live (§20). When no
wallet flow is reading, it falls back to the head reader's price, and only
then to the indexer's.

### The contract address, under the token

Under the token select, the builder now shows the token's address in full,
with **Copy** and **Explorer** beside it. Ether shows *native asset*,
because it has no contract. It is the same rule the drawer already follows
(§20): a site that asks people to put money into a token should show them
which token. That matters most on a chain with two CASHCATs (§24).

### What this does not fix

- The indexer is still behind. The liquidity *column* on the board is still
  the indexer's figure, labelled as such.
- A v4 pool that no aggregator lists as its own pair still shows the
  trailing figure, with its age.
- `/api/health` reports the reader under `poolReserves`: how many pools it
  follows, how many it has read, and its last error. `LIVE_RESERVES=false`
  turns it off.

Unverified from here, as always: the sandbox reaches no RPC, so the reader
has run against a fake and not against the chain. The first `poolReserves`
on the box says whether it answers.

### Verified here

`typecheck`, `lint`, the full suite (51 files, 513 tests, with the
live-reserves cases and a test that today's fees are never divided by a
liquidity as old as the indexer), the production build, and 41 Playwright
tests, one of them new: the address copies.

### `poolReserves: {"pools":0,"read":0}` right after a deploy

The first `/api/health` after that deploy read `"poolReserves":{"pools":0,
"read":0,"lastReadAt":null,"lastError":null}`, 23 seconds after the API
started. That is not a fault. The reader learns which v3 pools to follow from
the first snapshot build, and that build had not finished yet.

Two things were wrong around it, though. First, a reading that landed was not
used until something else rebuilt the snapshot. `LiveReserves` now takes an
`onUpdate` callback, and the API wires it to the same coalesced rebuild a
market refresh triggers. So today's liquidity reaches the fee yield within
seconds of being read. Second, the doctor said nothing about the reader. It
now prints one line for it:

- how many pools have been read;
- when it is waiting for the first snapshot;
- when it is off;
- the endpoint's error, if there is one.

The operator no longer has to grep `/api/health` for it.

---

## 32. The builder's estimate: this position's share of today's fees

ALFA, on VIRTUAL / USDG at ±15%: *curve dan spot masih tidak masuk akal
yieldnya*. Spot read `285%`, curve `643%`, both `est. · from 143% · 24h`.

### Why those figures meant nothing

The pool's own 143% was sound: $1.6K of fees over $418K, measured today.
What sat on top of it was not. The builder multiplied it by
`(0.6 / span) × density` and capped the result at 6×.

- **The 0.6 was invented.** At ±15% the span is 0.3, so every shape was
  simply doubled.
- **The density then multiplied curve by another 2.27.**
- **The method was blind to the one thing that decides a concentrated
  position's income:** how much liquidity other LPs already hold at the
  price. A pool whose LPs are all tightly concentrated pays a new position
  far less than one full of full-range liquidity. The heuristic could not
  see the difference.

§12 had already called this estimate ALFA's open question. The answer is to
stop estimating it.

### What it is now

A swap's fee is split across the liquidity active at the price it trades
through, in proportion to each position's liquidity there. So the new
figure is:

```
your share   = your liquidity at the price / (pool's active liquidity + yours)
per day      = share × fees this pool took in the last 24 hours
fee yield    = per day × 365 / what you deposit
```

The inputs:

- **Pool's active liquidity:** read from the chain on the same cadence as
  the price, via v3 `liquidity()` or v4 StateView `getLiquidity`.
- **Your liquidity:** the plan's own positions, only the one(s) whose ticks
  hold the current price, following Uniswap's rule
  (`tickLower ≤ tick < tickUpper`).
- **Fees:** from the head reader (§25).
- **Deposit:** the plan's two amounts at today's prices.

Everything is in the chain's own units, and the figure is
`lib/fee-estimate.ts`.

**Curve and spot now differ by exactly what they put at the price, and
nothing else.** Full range uses the same formula. So a full-range position
in a pool of concentrated LPs now reads below the pool's average, which is
true, rather than at it.

The page shows the share (`est. · 1.2% of fees at the price`), and the hint
spells out the arithmetic in dollars:

- today's fees;
- the share you would take;
- dollars a day on your deposit.

A reader can therefore check every step. When an input is missing, the
caption says which one, instead of a figure:

- `no fees measured today`
- `not enough data yet`
- `reading the pool`
- `pool liquidity unreadable`
- `enter a deposit`

What it still assumes, and says: today's fees repeat, the price stays in the
bin it is in, and nobody else adds liquidity there. A position whose bins
miss the price reads 0%.

The simulator has no chain to read, so on simulated data the old estimate
stays. It is never shown on a live pool.

### Verified

- **Unit tests** (`lib/fee-estimate.test.ts`):
  - the share arithmetic;
  - curve over spot being exactly the ratio of their liquidity at the price;
  - 0% outside the range, including a tick on a bin's upper edge;
  - null for each missing input.
- **Real contracts:** `npm run check:lp` now asserts, against Uniswap's
  real bytecode, that the pool's active liquidity rises by exactly the
  liquidity the estimate counts as yours. For v4 this holds exactly. For v3
  it holds to within 2 wei, because the manager re-derives liquidity from
  rounded-up amounts. 65 checks pass.
- **Suites and build:** full suite (518 tests), production build, and 41
  Playwright tests.

Unverified from here: the reads against Robinhood Chain itself.

### `365%` read as 365% a day

The first screenshot of the new estimate read `365%` with the caption
`est. · 0.10% of fees at the price`. ALFA's reply: *300% dalam sehari tidak
mungkin*. They were right to doubt a figure like that, but the figure was a
yearly rate. The hint said as much: $3 a day on $276 deposited, annualised,
which is about 1% a day. The word *annualised* sat in a paragraph under the
number, and the number is what gets read.

The unit is now on the figure itself: the label reads
`Est. fee yield · per year` and the value `365% / yr`. The caption leads
with the daily figure, `≈ $3.00 a day (1.0%)`, because a dollar a day is
something a person can check against their own deposit. The hint gives the
day and the year side by side.

---

## 33. One token in, and what "mainnet" means here

ALFA read §22's list of what the site lacked and answered: *perbaiki semuanya
dan saya ingin mainnet beneran* — fix all of it, and make it real mainnet. The
next screenshot asked the question the list had put first: VIRTUAL / ETH,
`Approve VIRTUAL` greyed out, *needs 91.2179 VIRTUAL; the wallet holds 0* —
*jadi kalau mau naro LP harus hold tokennya?* Until this section, yes.

### The zap: swap, then mint, both through Uniswap

A position holds two tokens; a wallet usually holds one. `lib/zap.ts` closes
the gap in two transactions, each dry-run before the wallet opens:

1. **Swap** part of what the wallet holds for the side it lacks, **in the same
   pool** the position goes into — v3 through SwapRouter02
   (`multicall(deadline, …)`, paid in ETH with `refundETH` when the side is
   the wrapper), v4 through the Universal Router (`V4_SWAP`:
   `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`). The size comes from the
   venue's quoter (QuoterV2, V4Quoter) — a first quote at the fee-grossed
   value of what is wanted, then up to three corrections, since impact is
   convex. The minimum out is the last quote less the builder's slippage. A
   swap that would lose more than 5% to fee and impact is not offered, and
   says so.
2. **Mint**, planned again at the price the swap left and **fitted** to what
   the wallet now holds (`fitBps`). The swap's cost is paid in the swapped
   side, so the plan shrinks by exactly that instead of asking for tokens the
   wallet does not have. Fitting is bounded: 2% on its own (a deposit typed a
   hair above the balance), 15% right after a zap, and the page says
   *Fitted to your balance: N% of the deposit typed* whenever it happens.

Why two transactions and not one: one would need a contract of ours to hold
the swapped tokens between the swap and the mint, and §20 is that there is
none. The cost is a signature; the gain is that nothing sits in a contract
Balast wrote, even for one call.

Two addresses joined `CONTRACTS`, both from the same registry entry §20 used
(`ROBINHOOD_ADDRESSES` in sdk-core): SwapRouter02 `0xCaf6…5cb2` and QuoterV2
`0x33e8…A9E7`. The Universal Router on this chain is v2.1.1, whose single
swap carries `minHopPriceX36`; it is encoded at zero (the minimum out is the
guard). A v4 pool quoted in aeWETH gets no zap — its ether would be wrapped,
swapped and wrapped again, those pools are few, and the builder still says to
hold both there.

**Proven, as far as this sandbox can.** `lib/zap.test.ts` compares the v4
swap with the SDK's V4Planner at both router layouts and the v3 swap and
quote with the routers' published ABIs. `npm run check:lp` now deploys
SwapRouter02, QuoterV2, V4Quoter and the Universal Router from their
published bytecode and runs three zaps through the site's own functions —
ETH→token on v3, ETH→token on v4, token→ETH on v4 through Permit2 — checking
the amount in equals the quote, the amount out equals the quoter's answer,
the routers hold nothing afterwards, and the fitted mint lands; plus a swap
whose price moved past the minimum refused by the node with the reason in
words. 104 checks, all passing. The local router is npm's 2.1.0 (the v2.0
layout); the 2.1.1 layout is covered by the byte test, not by a local run.

### Also in this section

- **`/stakes` lists what can be staked into.** No vault exists (§20), so the
  grid that listed vaults now lists every token's best mintable market,
  ranked by the fee yield it shows, each with *Stake full range*. *Your
  stakes* points at the Portfolio, which reads them from the chain (§30),
  instead of saying the site cannot.
- **The router says it is later.** Its nav link carries a `later` tag and
  the button reads *Router opens later*, disabled, with the reason: it is the
  one piece Uniswap cannot do for us, and it ships only after an audit.
- **Out of range is counted in the navigation**, in red, beside Portfolio —
  §7's rule that a position earning nothing says so, applied one level up.
- **Rebalance** on an out-of-range position withdraws it and opens the
  builder on the same pool and width, centred on today's price
  (`?min=&max=`). The new mint is a second transaction signed there.
- **`/learn`**: twelve answers before anyone signs — custody, the NFT as a
  receipt, one-token deposits, full range against shapes, what the yield is
  and is not, the three ways to lose money, out of range, hooks, where the
  numbers come from, and "start small".
- **`deploy/MAINNET.md`**: the operator's checklist. The inputs only a person
  can supply (a paid RPC endpoint above all — the backfill has been ~74 days
  behind on public ones; the WalletConnect id; `STAKEABLE_HOOKS`), then the
  first real transactions at 0.005 ETH, each with what to check on the
  explorer.

### Unverified from here

The sandbox reaches no RPC, so no zap has been sent on Robinhood Chain.
The first one should be the small one in `deploy/MAINNET.md`, watched on the
explorer: the router must hold nothing afterwards, and the NFT must be in the
wallet.

### Still ALFA's

Unchanged: `STAKEABLE_HOOKS` and `LAUNCHPAD_HOOKS`, the listing bar's
thresholds, the §12 questions, and — if a vault is ever wanted again — the
protocol fee and its immutable cap. Balast takes no fee today.

---

## 34. Free RPC, and why mainnet does not need anything else

ALFA, on §33's checklist that put a paid RPC first: *pake rpc free intinya
mainnet should be works*. Keep the free endpoints; mainnet has to work on
them. It does, and this section records why, and what changed to make the
free path sturdier.

**Nothing a person signs goes through the site's RPC.** The zap's swap, the
mint, collect, withdraw and every approval are built in the browser and sent
through the person's own wallet connection (§20). The site's endpoints feed
the indexer, the API's reads and the page's reads when there is no wallet.

What changed:

- **The page reads through all four free endpoints.** `publicTransport()` in
  `lib/v4/client.ts` is a viem `fallback` over `PUBLIC_RPC_URLS` (now in
  `lib/chain.ts`, the one list the server's `endpoints.ts` also defaults to).
  With a wallet connected the wallet's own connection is tried first and the
  free endpoints after it, so a rate-limited wallet RPC no longer reads as
  *Pool unreadable*. A revert is thrown straight back, not retried elsewhere.
  The wallet is given all four when it adds the chain.
- **The server's processes start on different endpoints** (`RPC_START`,
  `rpcStartIndex` in `server/chain/endpoints.ts`): the indexer on the first,
  the API on the second, the logo process on the third. Free endpoints
  rate-limit per IP and every process shares the box's IP, so with all of
  them starting on the first, the backfill — which asks as fast as it is
  allowed — spent that endpoint's allowance and a wallet's portfolio read
  queued behind it for a 429. Failover still walks the whole list.
- **`deploy/MAINNET.md` no longer lists a paid endpoint as required.** It is
  optional and only makes the backfill faster.

What free RPC still limits, unchanged and labelled: the backfill's pace, so
the board's history figures (liquidity, trailing yield, market cap) are as old
as the top bar says. Today's volume and the price are the head reader's and
the aggregators', and current either way. A pool created since the backfill's
cursor is not listed until the backfill reaches it — the one real cost of free
RPC for the product, and the next thing worth building if it matters: the head
reader discovering new pools from today's swaps.

---

## 35. The position, under the builder; and ETH into a pool that holds aeWETH

ALFA, on VIRTUAL / ETH with the Mint button greyed: *saya sudah mint,
harusnya ada fitur kasih lihat lagi running atau apa dan bisa withdraw kapan
saja*. Two things in the screenshot.

**The position lived on another page.** A mint ended on a toast and a link to
the transaction; the position itself, with its status and its Withdraw, was
on `/portfolio`, which nothing on the builder pointed at. The builder now
shows **Your {TOKEN} positions** under itself (`MyTokenPositions`): the
Portfolio's own list (`PositionList` with a `tokenAddress` filter) — in range
or out of range, value, uncollected fees read from the chain, **Collect fees**
and **Withdraw** with the same dry runs — for the token being built. The mint's
result line says it is listed there. A position minted here is on the page as
soon as its receipt is in (§30).

**The zap skipped exactly this pool.** VIRTUAL / ETH on v4 holds its ether as
aeWETH, and §33 left such pools out of the zap, so a wallet holding only ETH
was told to hold VIRTUAL. It is supported now, without an approval: the
Universal Router is sent the ETH, wraps it into its own aeWETH (`WRAP_ETH` to
`ADDRESS_THIS`), and the swap settles that from the router's balance
(`SETTLE` with the router as payer) — the wrap and the settle are the same
amount, so nothing is left in the router. `encodeV4Swap({ wrapEtherIn })`,
byte-compared with the SDK's V4Planner; the order on the page is swap, then
the wrap the mint needs, then the mint. `check:lp` runs it against
Universal Router bytecode from a wallet holding only ETH: exact ETH spent,
the quoter's answer received, no aeWETH stranded in the wallet or the
router, three positions minted. 112 checks, all passing.

Unverified from here, as before: the chain itself. The first one should be
small and watched.

---

## 36. Price impact and fees earned, for a position the chain holds

ALFA's first real position — VIRTUAL / ETH, v3 #1284575, full range, minted
through the site — sat on `/portfolio` with *Price impact on holdings: — · 0 of
1 positions measured*, *Uncollected fees $0*, and *No fee history yet*:
*price impact dan no fee harusnya di fixkan*.

**The principal is the position's own logs now.** A v3 position's funding was
never indexed (§29), so the portfolio had no principal to compare against.
The v3 manager emits it, indexed by token id: `IncreaseLiquidity` in,
`DecreaseLiquidity` out, `Collect` paid. `server/api/v3-history.ts` asks the
explorer only *which transactions* carry those logs (its logs API, one query
per event) and reads every amount from those transactions' receipts on chain
— §4's rule, an outside source may locate but never count. The sums are then
**checked**: the liquidity they add up to must equal the liquidity the chain
says the position holds. A history the explorer served incompletely fails
that check and is not used; the page keeps its dash rather than show a
principal that is wrong. Principal = Σincrease − Σdecrease; fees already
collected = Σcollect − Σdecrease. A v4 position's principal is still the
indexer's record when current (v4 emits no amounts for a mint or a collect).

**Valued at today's prices.** The portfolio priced everything at the
indexer's last block (74 days old on the box). It now takes the pool's own
live `slot0` for the token and today's ether price from the snapshot (§24,
not when that price is itself the chain's old one), so *net value* and *price
impact* are about today; the card says `at today's pool prices` when every
position was, and `at the last indexed block` when not.

**Fees earned.** The second card is *Fees earned*: collected so far plus
uncollected now, per position and in total, with the uncollected part
beneath it. A v4 position's collected half is not knowable (no amounts in its
collect), so its figure is its uncollected fees and says so. Small figures
read `$0.37` or `<$0.01` (`usdFine`), not a `$0` that means none.

**The daily grid is measured, not reconstructed.** A past day's fees would
need the pool's fee growth at that day's block, which only an archive node
serves and the free endpoints are not. So the page records each position's
earned figure once a day, in raw units, in this browser
(`lib/fee-samples.ts`), and a day's fees are the growth since the previous
recorded day, valued at today's prices — so a price move is never counted as
fees, and a fall (a withdrawal) never as negative fees. The grid starts the
first day the browser saw the position and says so; the list beside it gives
each position's earned figure since its mint and the average per day.

Verified: 545 unit tests (the history's sums and its refusal of an
incomplete list, the explorer query, today's pricing, the daily arithmetic),
the build and 41 Playwright tests. Unverified from here: the explorer's logs
API on this chain — if it refuses, the dash stays, and nothing wrong is shown.

### "$0" was a measurement rounded away

The first portfolio with a history on it read *Price impact on holdings: $0*
under a caption saying the figure was measured — ALFA: *price impact holding
juga harusnya ada*. It was measured. The page rounded any figure under half a
dollar to `$0`, a rule written for the simulator's thousand-dollar positions.
On a $27 full-range position minted the same day, at nearly the same price,
the honest figure is cents.

Live, it is shown to the cent now (`lib/price-impact.ts`): `−$0.03`, or
`−<$0.01`, in red when negative. The caption gives its share of what holding
the principal would be worth (`−0.11% vs holding the principal, at the same
prices`), because a percentage reads the same on a $27 position and a $27,000
one. Each position's row carries its own figure under its fees, or says its
principal is not known. A positive figure carries a plus and no colour: it is
a cent of the pool's own rounding, not a gain from holding liquidity. The
simulator keeps its whole-dollar display.

### A dash on one load, `$0` on the next, and a position that vanished after Collect

Two screenshots a minute apart. The first: *Price impact on holdings —, 0 of
1 positions measured*, over a row saying *principal not known* — the same
position that had read as measured an hour earlier — and *Fees earned by
day: $0 over 1 day* beside fees plainly on the row. The second, taken after
pressing **Collect fees**: *no positions yet*, and *Uniswap v3 positions
could not be read from the chain just now*. ALFA: *price impact mala kosong*
and *pilih collect fee mengapa jadi ilang*.

Everything behind both was a read on a free endpoint that sometimes does not
answer, and a page that treated "did not answer" as "does not exist".

- **A v3 history that checked out is kept.** `V3HistoryReader` asked the
  explorer on every portfolio request and showed a dash whenever the answer
  was slow. Now a verified history is kept in memory and in `indexer_state`
  (`v3_position_histories`, so a deploy does not lose it), served while it
  describes the same liquidity, and re-read in the background after a
  minute; a failed re-read keeps the last good one. A new transaction for the
  position — a collect sent since — forces a fresh read.
- **The browser's own transactions find the history.** `?v3tx=tokenId:hash`
  sends the mint, collect and withdraw hashes this browser recorded
  (`v3TxHints`), so a position minted here is measured even when the
  explorer does not answer. They are candidates like the explorer's: only
  the v3 manager's logs for that id are summed, and the sum must equal the
  chain's liquidity. Summed from hints alone, the principal is proven but
  fees already collected elsewhere could be missing, so that figure is not
  claimed (`collectedKnown`).
- **A v3 read that does not answer lists the last one that did.** The API
  keeps each wallet's last v3 read for thirty minutes and serves it on a
  failure, marked `v3Unchecked`; the browser does the same across an API
  restart. The page says the rows are as of the last read. Collect and
  Withdraw still dry-run on the chain first, so a stale row cannot send
  anything the chain would refuse.
- **The first day of the grid counts.** Earned is everything since the mint,
  so a position's first recorded day counts from zero; a position the
  browser first saw after its mint day carries its earlier fees on that day,
  and the caption says so.
- **Small figures keep their digits.** `usdFine` prints a figure under a
  cent to two significant digits (`$0.0041`), and the price impact's
  percentage the same (`−0.0034%`), rather than `<$0.01`.

### Closed positions in the totals, UTC, and a Withdraw that asks twice

Three asks off the same page. *Jamnya ubah pakai UTC aja*: every time the
activity list, the fee list and the dateline print is UTC now and says so —
the chain and the explorer keep UTC, so the list reads the same as the
transaction it links to.

*Position kenapa cuma 1, harusnya semuanya ditotalin*: the one open position
was right — VIRTUAL #1284575 had been withdrawn — but the totals forgot
everything a withdrawn position had earned. **Withdrawn v3 positions are
listed as closed** (`ClosedPosition`, a *Closed* list under the open ones)
and counted in *Fees earned* and *Price impact on holdings*, which say
`incl. N closed`. The browser names them (`?v3closed=tokenId@poolId`, from
its own withdraw records); the server reads each one's logs as a history
that must add up to **zero** liquidity, and lists it only when the receipts
show the mint went into that pool (the pool's own `Mint` log with the
manager as owner) and that this wallet sent them. `V3History` carries the
gross amounts now (`in`, `out`), because a closed position's net is zero;
its realised price impact is what came out as principal against what went
in, at today's prices, the same basis as the open rows. v4 positions are
not included: a v4 collect emits no amounts, so a closed v4 position's fees
cannot be read back.

*Saya tidak pernah withdraw VIRTUAL*: the Activity list showed a confirmed
withdrawal of it, in the same minute as the CASHCAT zap. Nothing on the site
sends a withdrawal on its own — only the Withdraw and Rebalance buttons call
it, and every transaction needs the wallet's signature — so it was a click
and a confirmation among the several prompts a zap asks for. The money went
to the wallet, not anywhere else; the explorer link on that row shows it.
But a one-click button that closes a position was too easy to hit. **Withdraw
and Rebalance now ask on the page first** — *Yes, close the position* or
*Keep it open*, with a line saying what closing does and that Collect fees
is the one that keeps it open — and the question lapses after eight seconds.

### "No positions yet" on every reload

ALFA, on a refreshed `/portfolio` showing dashes and *No positions yet* over a
wallet holding a CASHCAT position: *mengapa setelah di refresh jadi ngelag
baca datanya*. The wallet's read goes to the chain on every load and can take
many seconds on the free endpoints; until it answered, the page drew the
snapshot's empty portfolio, which says *no positions yet* — a claim about a
wallet nobody had looked at yet (§7).

- **The last read is kept per wallet** (`lib/data/portfolio-cache.ts`, a
  week at most) and shown at once on the next load, marked `kept` with the
  time it was read. The first fresh answer replaces it.
- **A read that has not answered says so.** `Portfolio.status` is `loading`
  until the first answer and `error` when it failed with nothing kept; the
  cards read *reading from the chain…* and the list *Reading your
  positions…*, never *no positions yet*.
- **The closed positions' history is asked for at the start** of the
  server's read, beside the others, rather than after every other read.

### The dateline's date, and an X that read as a close button

ALFA, on the live board: remove the date — *THE BALAST LEDGER · FRIDAY 10
JULY* — and put X at the top. The date was chain time, honest and weeks old
during the sync, and read as a fault; the eyebrow is *The Balast ledger* now,
and the top bar's indexer chip still says how old the numbers are (§7).

The navigation already had X — as two crossed strokes, which beside the
links reads exactly like a close button. It is X's own mark now, filled,
with the handle beside it (`@Balastdotfi`, from `X_HANDLE`) in a pill.
Below 640px the handle drops and the mark stays; below 440px the pill
leaves the top bar so the wallet button keeps its row, and X stays in the
footer.

### $BLST, and the address on the site

The owner launched the token on Pons as **$BLST** —
`0xe8f7E3d2D4B9733E13aBb173F4c1BDDBEAFbEE83` — and asked for it on the
site. `TOKEN_CA` in `lib/site.ts` is that address as a **constant**, not the
`NEXT_PUBLIC_TOKEN_CA` it used to read: the masthead says any other
address is not ours, and a blank or stale value in the box's `.env` would
have made that sentence point at "coming soon" or at the wrong token. The
X link was moved to a constant for the same reason (§19). `lib/site.test.ts`
asserts the address stays valid and checksummed.

The masthead shows it short with copy, the tooltip carries it in full; the
footer reads `$BLST · CA 0xe8f7…EE83`. The p10 banner still says there is
no token and should not be posted. §13's recommendation to ship without a
token was the doc's; the launch is the owner's decision, and nothing on the
site says the token earns anything — Balast takes no fee, so there is
nothing for it to earn.

---

## 37. Night: a premium dark redesign, and the name held in one place

ALFA asked for the whole look changed, as a senior team would ship it, and
for a new name. A reference board went out first (names and three premium
directions). ALFA's answer: *startup premium dark*, and the name later.

### What moved

**Dark, not paper.** The Journal (§19) is replaced. The page is near-black
(`--bg #07080B`), cards are lifted by a highlight on their top edge rather
than a shadow, and one soft accent glow sits behind the top of every page.
The token names are unchanged, so components changed values, not variables.

**The colour rule changes, by the owner's choice.** §5 and §19 made green
the only accent. Now:

- **Periwinkle (`--ac #7C8CFF`) is the brand and whatever is active**: the
  selected nav item, the primary button, focus, the leader row, sparklines.
- **Green (`--pos`) means a rising number and nothing else**: a 24h gain, a
  fee yield, fees paid out.
- **Red (`--red`) still means a falling number and nothing else.**

Nothing else is coloured. `e2e/honest-numbers.spec.ts` asserts the new red.

**Two faces.** Instrument Sans for everything read, set heavy and tight for
headlines. JetBrains Mono for everything counted. No serif any more.

**A left rail, not a top bar.** `Sidebar` in `components/shell/TopNav.tsx`
holds the brand, the six pages with icons, X and the network. Below 1180px
it narrows to a 76px icon rail: the labels stay in the document, and a red
dot stands in for the out-of-range count. Below 900px it becomes a strip
across the top whose links scroll inside themselves. `TopBar` holds search,
the indexer chip and the wallet, and is sticky and frosted.

**The masthead** is a pill eyebrow, a heavy sans headline, and the global
figures as a row of five tiles instead of a column beside it. **The
leaderboard** is one card with a header and a mono rank. **Drawers and
dialogs** blur what is behind them.

### The name

`BRAND` in `lib/site.ts` is now the only place the chrome reads the name
from: the rail, the footer, the X link's label, and the page titles (the
layout's `title.template`, so pages set only `'Pools'`, `'Stakes'`, and so
on). Renaming the chrome is that one line plus `DOMAIN`. Copy inside the
pages, the logo mark and the brand assets still say Balast and move with
the same rename.

Three things the rename cannot change and ALFA should weigh: **$BLST's**
on-chain name and ticker are fixed in the contract; the **@Balastdotfi**
handle can be renamed but old links break; and **balast.xyz** should
301 to whatever domain replaces it. "Bolster" was recommended because it
contains B-L-S-T in order, so the ticker still fits.

### Unchanged

Every figure, its source and every honest-numbers rule (§7); the
`DataProvider` boundary; mint, collect and withdraw through Uniswap; the
drawer's focus trap; `prefers-reduced-motion`; and no horizontal scroll
at 360px.

**Verified**: typecheck, lint, 562 unit tests, the production build and
all 41 Playwright tests, plus screenshots at 1440, 1024 and 390px.

### A second pass: a table, not a list of sentences

ALFA's verdict on the first Night deploy: *ui ux masih still bad*. No
specifics, so the page was read the way a first-time visitor reads it, and
five things stood out.

- **The board had no column headers.** Market cap and liquidity rode in a
  grey line under the ticker, truncated on most rows, so the two figures a
  person compares were the two they could not read. The leaderboard is a
  real table now: a header row (`.lb-cols`) and one column each for market
  cap, liquidity, volume, buys/sells, 24h and the 7-day chart, on one grid
  (`--lb-grid`). Below 1320px the chart goes (its narrow column stays for
  the Stake button), below 900px the buys/sells, below 640px market cap and
  liquidity, with the market cap taking the name's place under the ticker,
  and below 420px the rank. The totals test reads the liquidity column
  (`[data-col="liq"]`) now.
- **The headline took the first screen.** Headlines are 26–38px and one
  line of copy. Only `/pools` carries the figure tiles (`Masthead facts`);
  the other pages were repeating five numbers that had nothing to do with
  them. The tiles are Value locked, Fees 24h (summed from the rows, §12),
  Paid to LPs, Open positions and ETH.
- **The contract address moved to the top bar**, as a `$BLST 0xe8f7…EE83`
  chip that copies on click, on every page.
- **Figures are sans with tabular digits.** Mono read as a terminal. Instrument
  Sans has true tabular figures (checked: `1111`, `8888` and `0000` measure
  the same), so columns still line up. Addresses and hashes keep the mono,
  because there each character is read one by one.
- **Token marks are dark coins.** Pastel discs looked like stickers on a
  dark page. The disc is the hue at 40% saturation and 20% lightness, the ink
  the same hue at 70/80. The test re-derives the contrast: 7.12:1 at worst,
  at hue 240.

The source of the day's volume (`now`, `live`, `chain`) is a small tag
under the figure, not a sentence. The board's subtitle is one short line.

**Verified**: typecheck, lint, the unit tests, the production build and all
41 Playwright tests, plus screenshots at 1440, 1280 and 390px.

---

## 38. A trading screen: DexScreener and pump.fun as the reference

After two rounds of Night (§37) and a board of three sketched directions,
ALFA's verdict was still *tampilannya looking bad*. Guessing again would
have cost a fourth round, so the question changed: which crypto site does
ALFA already think looks right? The answer was **DexScreener / pump.fun**,
viewed mostly on a **laptop**. This section is that style, desktop first.

### What moved

- **Monochrome, so the numbers are the colour.** The accent is white
  (`--ac #EDEEF1`): the primary button, the active nav item, the charts.
  Green (`--pos`) and red (`--red`) are the only colours on the page.
  Surfaces are neutral near-blacks with solid hairlines, as on a trading
  screen.
- **Buys are green and sells are red**, in the buys/sells column and its
  bar. That sets aside §5's "red means only a negative number" for this one
  cell, because it is the convention every DexScreener user reads by. It
  is the owner's reference, so it is the owner's call.
- **The Pools page is a screen, not a page.** A one-line title and lede, the
  global figures as one strip of five cells, then the table. (Four
  pump.fun-style cards for the largest tokens sat between them for one
  commit; the owner had them removed.)
- **The table reads left to right like DexScreener's**: rank, token with its
  pair (`PONS / ETH`), price, age, buys/sells, volume, 24h, liquidity, market
  cap, 7-day chart. Rows are 54px. Columns drop in that spirit as the width
  shrinks: age and the chart at 1400px, buys/sells at 1100px, the Stake
  column at 900px, price and liquidity at 760px, market cap at 640px (it
  moves under the ticker), the rank at 420px.
- **A price column.** `shownPrice` in `lib/market-figures.ts` takes the
  price from the same source as the volume and change beside it.
  `tokenPrice` in `lib/format.ts` writes it the way trading screens do: a
  fraction of a cent keeps its digits, as `$0.0₅123` for 0.00000123. A
  missing price is a dash.
- **Compact chrome.** A 56px top bar, 36px controls and 8px radii
  throughout.
- **The left side is a 64px icon rail** on every desktop width, as on
  DexScreener, at the owner's request. The page names stay in the links
  (read by screen readers, and shown beside the icon on hover or keyboard
  focus), and the out-of-range count becomes a red dot. Below 900px the
  rail becomes the strip across the top, as before.

### Unchanged

Every figure and its source; the honest-numbers rules (§7) apart from the
buys/sells colours above; the `DataProvider` boundary; everything that
sends a transaction.

**Verified**: typecheck, lint, the unit tests (new `tokenPrice` cases),
the production build and all 41 Playwright tests, plus screenshots at
1440 and 1280px.

---

## 39. LockFi, on lockfi.org

The owner renamed the product **LockFi** and registered **lockfi.org** on
Hostinger, with an A record to the box (31.97.66.123) and `www` as a CNAME.
The name was the owner's pick after several rounds of candidates. The mark
is the **pin arch**, picked from six studies: a padlock's shackle and its
tumbler pins drawn as one bar chart, tallest in the middle. That is the
curve the position builder draws, so the logo is a lock made of liquidity.

### What moved

- **The name.** `BRAND` in `lib/site.ts` is `LockFi`, and every page's
  user-facing copy says LockFi. The PM2 processes are `lockfi-web`,
  `lockfi-api`, `lockfi-indexer` and `lockfi-logos`, at the owner's request.
  `deploy.sh` removes the old `balast-*` processes before it starts the new
  names, since two web servers cannot share :3000 and two indexers must not
  write one cursor. Identifiers, comments, the package name, the server paths
  (`/var/www/balast`, the `balast` user and database, `/var/log/balast`), the
  browser storage keys and this document's history are unchanged. None is
  user-facing. Renaming the storage keys would wipe every visitor's
  transaction history and remembered wallet, and renaming the paths would be
  a migration on a live box for nothing.
- **The domain.** `DOMAIN` is `lockfi.org`. `balast.xyz` and both `www`
  hosts answer with a 301 to it, path kept, so every link shared under the
  old name still works. `LEGACY_SITE_URLS` and `ownSitePath` keep a logo
  URL recorded under balast.xyz reading as one of the site's own files.
  Without that, ether's and SPCX's own marks would have become "somebody
  else's URL" overnight and gone through the load check and the proxy
  (§21).
- **The mark.** `components/shell/Logo.tsx` holds the geometry, one colour
  only. `npm run brand:lockfi` (`scripts/build-brand-lockfi.mjs`) writes the
  favicon (`app/icon.svg`), the home-screen icon (`app/apple-icon.png`), the
  link preview card (`public/og-card.png`) and `brand/lockfi/`. The
  wordmark is Instrument Sans, fetched once into an ignored `.fonts` folder
  and embedded while rendering. The old `brand/` files stay as history.

### Deploy

`deploy.sh` now gets the lockfi.org certificate itself, on the first run
that needs it. It checks the DNS points at the box, answers the ACME
challenge from a temporary port-80 server, and removes that server again
whatever certbot says. Then it installs `deploy/nginx.conf` (lockfi.org) and,
only where balast.xyz's certificate exists, `deploy/nginx-legacy.conf` (the
redirect). Before any nginx change it copies the working config. If
`nginx -t` rejects the new one, the copy is put back and the site keeps
serving. The script used to leave a rejected config installed for the next
reload to fail on, which on a shared server takes every site down.

If the DNS has not reached the box yet, the deploy finishes, nginx is left
alone, and it says so. Deploying again later completes the move.

### Still open

- **`lockfi.com` is not ours.** It is parked for sale by a third party, and
  it is what a person typing the name reaches first. For a site that asks
  for a wallet that is a phishing gap, as `ballast.xyz` was (§13).
- **$BLST is gone from the site.** The owner had the token and its contract
  address removed: the top bar's chip, the footer line, `TOKEN_CA` and its
  test. LockFi has no token, which `/learn` already said.
- **The X handle** is being renamed by the owner. `SOCIAL.x` in
  `lib/site.ts` is the one line to change when the new handle arrives.
- The banners in `brand/social/` still say Balast and should not be posted.

---

## 40. LockFi's own look: signal blue, and a DLMM builder

The owner, on the first LockFi deploy: *ubah tampilan ini dan tampilan fitur2
lainya, intinya jangan sama kaya balast*. The site still looked like the last
Balast version. Asked for a reference, the owner picked **Meteora's DLMM
screen** for the feature pages and **signal blue** as the brand colour.

### Colour

`--ac` is `#3B82F6`: the brand, the active control, the bin chart's token side,
charts. A filled control (the primary button, the Stake button, the logo tile)
uses `--ac-fill` `#2563EB`, one shade darker, so white text on it holds 5.2:1
where `#3B82F6` would be 3.7:1. `--ac-3` `#93C5FD` is the accent as text on
the dark page. Green is still a rising number and a buy; red a falling number
and a sell. The pool header and the portfolio strip carry a faint blue wash
from the left, the only decoration.

The favicon, the home-screen icon and the link preview card are the pin arch
in white on the blue tile (`npm run brand:lockfi`; `brand/lockfi/icon-blue*`
is the primary icon, the dark and light ones stay).

### `/positions`, as a DLMM screen

Top to bottom, in one column: the **pool header** (token picker set as a large
title, the pair, the contract address with Copy and Explorer, and a strip of
price, liquidity, volume 24h, fees 24h and fee tier); the **market bar**
(currency, then that currency's fee tiers with each pool's liquidity); the
**bin chart** full width; then **Strategy** (full-range toggle, shape, range,
bins) beside **Deposit** (amount, slippage, the range / yield / split summary,
the Mint button and the status line). The long explanation of the estimate
moved into a *How the estimate is worked out* disclosure under the button.
Nothing in the flow, the figures or the ids the tests use changed.

### Everywhere else

- Page headers are plain titles in LockFi's voice: *Build a position*,
  *Stake a pool*, *Your portfolio*, *Fees into liquidity*, *How LockFi works*.
- **Stakes** (the live list, `StakeList`) is a pool board: a header strip of
  pools, liquidity, volume and fees summed from its rows (§12), then rows with
  v3/v4 and tier chips, liquidity, volume 24h, fees 24h, fee yield, and a blue
  *Stake* button. The simulated vault cards are unchanged.
- **Portfolio**'s four figures are one strip instead of four cards.

**Verified**: typecheck, lint, 566 unit tests, the production build and all
41 Playwright tests, plus screenshots at 1440px.

---

## 41. The fee tier, explained where it is chosen; and a black logo

ALFA, on CASHCAT / ETH with the 0.5% pool selected: *apa maksudnya fee
tier*, then *harusnya dijelasin biar ga bingung, dan logonya kenapa biru, saya
mau hitam premium*.

### The fee tier says what it is

The selected pool had $0 of volume that day, beside a 1% pool holding $8.49M,
and nothing on the page said why that mattered. §40's redesign had dropped
the one sentence that did. The tier pills are now small cards, one per pool:
the tier, the pool's **liquidity**, and the **fees it paid its LPs in the
last 24 hours** (the head reader's per-pool figure, §25; a dash where
unmeasured). The tier that paid the most is marked **Most active**, in green,
because that is a positive number. Under the cards, a short paragraph says
it plainly:

- every trade pays this percentage to the pool's liquidity providers;
- each tier is a separate pool with its own traders, and you earn only from
  the one you pick;
- a higher percentage earns nothing if nobody trades there.

The group keeps its accessible name, *Fee tier*, and each card still
carries a `$` figure or a dash, so the tests that guard §27's rule pass
unchanged.

### The logo tile is black

The owner wanted the logo in premium black, not blue. The tile is a
graphite-to-black gradient with a light top edge and a hairline ring, so it
still reads on a black page and on a dark tab strip. The sidebar tile, the
favicon, the home-screen icon and the link card's tile all use it
(`blackIconSvg` in `scripts/build-brand-lockfi.mjs`;
`brand/lockfi/icon-black*` is the primary icon, and the blue icons are
removed). **Signal blue stays for buttons and active controls**; only the
logo changed.

**Verified**: typecheck, lint, 566 unit tests, the production build and all
41 Playwright tests, plus a screenshot of the tier cards at 1440px.

---

## 42. The introduction banners, in LockFi's own look

The owner asked for premium banners to introduce LockFi on X, drawn from
scratch and matching the site. `npm run brand:social`
(`scripts/build-lockfi-social.mjs`) writes them to `brand/lockfi/social/` at
2×: six 1600 × 900 posts (introduction, pools, shapes, one token in, custody,
honest numbers) and the 1500 × 500 profile header. `COPY.md` beside them holds
the bio and the post for each image, all under 280 characters.

Each banner uses the site's tokens, Instrument Sans, and the black logo tile.
The visuals are the site's own components drawn at banner size: the bin chart
with the price line, the pool board, the Stake drawer's disclosure, a position
row with Collect fees and Withdraw.

Every figure is left out. The board's cells are bars rather than digits, so
nothing on an image can be read as a price, a volume or a yield (§7). No
handle is written on an image, because the X account is being renamed.
LockFi has no token, and banner 6 says so. The old Balast renderer is now
`brand:social:balast`, and its images should not be posted.

---

## 43. @lockfiorg, and "CA · coming soon"

The owner renamed the X account to **@lockfiorg** and asked for the site to
say the contract address is coming. The owner also asked for the logo to be
black, not blue. It already was in the code (§41); the live site was simply
running a build from before that commit. Deploying fixes it.

- `SOCIAL.x` in `lib/site.ts` is `https://x.com/lockfiorg`, and `X_HANDLE`
  is derived from it, so the navigation, the footer and the card metadata
  all read `@lockfiorg`. `lib/site.test.ts` pins both.
- `TOKEN_CA` in `lib/site.ts` is `null`. While it is, the top bar carries a
  **CA · coming soon** chip on every page (hidden below 640px) and the footer
  carries the same line. When it is set to the real address, the chip shows
  the short address and copies the full one, and the footer prints it. It is
  a constant, not an environment variable, for the reason §19 recorded: a
  stale value in the box's `.env` must never point the site at the wrong
  token. The test asserts a set value is valid and checksummed.
- `/learn`, banner 6, the bio and post 6 in `brand/lockfi/social/COPY.md`
  said "no token", which contradicts "coming soon". Each now says the
  address appears on lockfi.org first, and any address circulating before
  that is not ours.

### The X Article

`brand/lockfi/social/ARTICLE.md` is a long-form introduction for an X
Article, about 1,800 words, with a title and two alternatives. The article
places the six post banners inline and uses `x-article-cover.png` as its
cover, at the 5:2 ratio X asks for (1500 × 600, the `x-article-cover` job
in the same script). `article.html` is the same text laid out for copying
into X's editor with the headings, bold and lists intact. The article
follows the same rules as the banners: no yield figure, no "APY", the risks
stated plainly, and "CA coming soon" with the warning that goes with it.

---

## 44. A product ad, filmed from the real site

The owner asked for a premium startup-style ad video made from the product
itself. `npm run brand:ad` (`scripts/build-lockfi-ad.mjs`) writes
`brand/lockfi/video/lockfi-ad.mp4`: 1920 × 1080, 30 fps, 50 seconds, H.264
with AAC audio, the format X accepts.

**It films the live site, not mock-ups.** Three browser windows load
`/pools`, `/positions` and `/portfolio` from a running build (simulated
data, `AD_SITE` to point elsewhere). A script drives them: it hovers a row,
opens the stake drawer, switches shapes from Spot to Curve to Bid-ask, and
hovers Mint position. Meanwhile a camera frames each moment, with a logo
intro, kinetic text, captions and an end card around them. Time is stepped
frame by frame with Playwright's clock, and every CSS animation is seeked to
match. So the live tick, the value flash and the row reordering play at
their real speed however long a frame takes to capture, and a render is
repeatable.

**Two honesty rules carry into the film** (§7):

- The site runs on simulated data, so every product scene carries *Product
  preview · illustrative figures*.
- Every fee-yield figure is blurred. A yield on screen in an ad reads as a
  promised return.

The simulator's legacy "stake · streaming" portfolio rows are hidden in the
film, because they describe the vault LockFi does not have (§20).

**The music is synthesized** by `scripts/build-lockfi-ad-audio.py`
(numpy/scipy): a pad, a pulse under the product scenes, risers into each
change of scene, and impacts on the logo and the end card, at the film's own
cue times. It is normalised to -16 LUFS. It is a placeholder that needs no
licence; for paid distribution a licensed track is better. The silent cut and
the WAV are rebuilt by the same command and ignored by git.

Needs a full ffmpeg (libx264, aac, loudnorm). The sandbox used the one
`pip install imageio-ffmpeg` ships; `FFMPEG` points at another.
`AD_STILLS=<dir>` saves one still a second instead of encoding, which is how
each scene was checked before the full render.

### Every demo token has its logo

The owner saw initials instead of logos in the film. The demo data had never
carried any logos; on the live site logos come from the logo process (§19),
which the simulator does not run. `SEED_POOLS` entries now carry `logoUrl`,
a file under `public/tokens/demo/` served same-origin, as the site's own
marks are (§21):

- **NVDA, GOOGL, AAPL, TSLA** wear their companies' ticker icons, from the
  same nvstly/icons repository the live `tickers` source uses. They are
  padded and set on a neutral dark coin, because on the per-address coin
  colour a green NVDA disappeared into olive.
- **SPY and GLD** have no icon in that repository. They wear generic marks
  (a rising chart, gold bars), not the issuer's brand.
- **MOONCAT, HOODR, LAURA and TWINE** exist only in the demo, so they wear
  marks drawn for it.
- **PONS is a real project and wears its own logo.** The sandbox cannot
  reach ponsfamily.com, so the owner supplied the image. It is cropped to
  the badge's circle. Inventing a real token's mark would have put a picture
  on it that is not its own.

`lib/own-marks.test.ts` asserts every demo logo names a file that exists.

---

## 45. Ask LockFi AI, through Dualyne

ALFA asked whether to add AI and pointed at Dualyne (`fourtisf/dualyne`), their
own AI gateway: an OpenAI-compatible API at `api.dualyne.com/v1` in front of
OpenRouter, with keys prefixed `dly_live_`. So LockFi is a client of it and
copies none of its code. `server/api/ask.ts` sends one non-streaming chat
completion to whatever `AI_BASE_URL` names. The default is Dualyne's gateway
with `claude-swift` (its Claude Haiku mapping). OpenRouter works by changing
two variables.

**What it is for.** It explains what is on the screen: what a fee tier means,
what a shape does to the fees, what out of range costs, and what this pool's
risks are. It sits in the Stake drawer (with the pool), in the builder (with
the pool and the person's plan) and on `/learn` (general). It answers in
English only, at ALFA's request, whatever language the question is in, and the
panel's suggestions and placeholder are English too.

**What keeps it inside §7:**

- **The facts are the server's.** The browser sends a pool id, and the API
  reads that pool's figures from its own snapshot. Each figure goes in with
  its source and age (`poolFacts`), through the same `shownYield` and
  `shownLiquidity` helpers the page uses. A browser cannot hand the model a
  number to repeat as though LockFi had measured it. The builder's plan comes
  from the browser and is labelled as the person's own inputs.
- **The rules forbid a forecast**: no price prediction, no advice to buy, no
  "APY" or "APR". Anything not in the facts is "I don't know". The question is
  treated as a question, never as an instruction.
- **`scrubAnswer` replaces APY and APR** in the answer whatever the model
  writes, because a prompt is a request, not a guarantee. It also strips the
  markdown the panel would print literally.
- The line under the panel says it explains figures, never predicts prices,
  and is not financial advice. The panel names its provider from the base
  URL (`via Dualyne`), so it never claims Dualyne when it is something else.

**Cost is bounded twice**: `AI_PER_MINUTE` per client (6) on the route, and
`AI_DAILY_LIMIT` answers per UTC day across everyone (1,000). A failed call
does not spend the day. The provider's own error goes to the log, not the
page.

**Off until `AI_API_KEY` is set, and invisible while off.** `GET /api/ask` says
whether it is on, and the panel renders nothing otherwise. On simulated data it
does not even ask, because there is no API and Next.js's 404 for the route
never finishes (it held the a11y suite's `networkidle` for 90s). For a demo or
a test, `localStorage['lockfi:ask'] = 'on'` shows it anyway.
`/api/health` → `ai` gives whether it is on, the provider, the model and
today's count.

**Verified**: 13 unit tests in `server/api/ask.test.ts`, 3 route tests in
`server/api/server.test.ts` (off, answering, per-minute limit) and
5 Playwright tests in `e2e/ask.spec.ts`. The full suite is 585 unit and
46 end-to-end tests, all green. **Unverified from here**: the sandbox cannot
reach `api.dualyne.com`, so no real answer has come back yet, and whether
`claude-swift` is enabled for the key's tier is Dualyne's to say. The first
question on the box answers both. A refused key reads as "could not answer"
on the page and as `ask: The AI provider refused LockFi's key (401)` in
`pm2 logs lockfi-api`.

### OpenRouter as the default

ALFA then asked to use OpenRouter directly: the one-key, many-models platform
Dualyne itself runs on. The defaults are now `AI_BASE_URL=https://openrouter.ai/api/v1`
and `AI_MODEL=anthropic/claude-haiku-4.5`, the same model Dualyne's
`claude-swift` maps to. So a single `sk-or-v1-…` key in `AI_API_KEY` turns the
assistant on. Dualyne's gateway is still
two variables away. Nothing else changed: the facts, the rules, the scrub and
the limits sit in front of any provider. `AI_MODEL` can name any OpenRouter
model, but anything larger than Haiku costs more per answer, and
`AI_DAILY_LIMIT` counts answers, not dollars.

### Live, and the provider's name off the panel

The first live answer on lockfi.org (CASHCAT / ETH) quoted the pool's own
figures with their basis and age: the market cap "from LockFi's indexer, 77
days old", and the fee yield "trailing 7 days". That is §7 working through
the model. ALFA then asked for the `via OpenRouter` label to be removed. The
panel no longer names its provider. `/api/health` → `ai.provider` still does,
for the operator.

### A page of its own in the rail

ALFA asked for the assistant in the navigation. `/ask` (`app/ask/page.tsx`,
`components/ask/AskWorkspace.tsx`) is the last item in the rail, with a
sparkle icon. It is a full-page conversation with an **About** select: LockFi
in general, or any pool on the board. Choosing a pool starts a fresh
conversation about it, and the server supplies that pool's figures exactly as
it does for the drawer. Unlike the drawer and the builder, where silence is
right, the page says *not switched on here yet* when the assistant is off,
because there it is the whole page. `e2e/shell.spec.ts` now covers `/ask`
(no console error, no sideways scroll at any width), and `e2e/ask.spec.ts`
covers the page, general and per pool.

### An ad for the AI

`npm run brand:ad:ai` (`scripts/build-lockfi-ai-ad.mjs`) writes
`brand/lockfi/video/lockfi-ai-ad.mp4`: 1920 × 1080, 30 fps, 40 seconds, the
same engine as §44's ad. The film shows:

- the intro, *Now with LockFi AI*;
- *Found a token you like? Before you stake, just ask.*;
- the board, then a pool's Stake drawer with the AI panel: *What are the
  risks of staking here?*, the reading state, then the answer revealed line
  by line;
- the Ask AI page: a pool picked in **About**, then *What does this fee tier
  mean?*;
- *Any pool. Plain answers. No predictions.*;
- the end card, *Ask before you stake*, `lockfi.org/ask`.

Three things differ from §44's film:

- **The stage is served from the site's own origin** (`/__ad-stage`,
  intercepted). A third-party frame is refused `localStorage`, and the
  assistant's preview switch lives there.
- **The simulator has no API**, so `/api/ask` is answered by the script.
  There are two sample answers, matched by question and released at fixed
  film times. They are written inside the assistant's own rules: no
  forecast, no APY, and the risks stated. The footnote reads *illustrative
  figures · sample answers*.
- **The score takes its cues from the environment** (`AD_PULSE`,
  `AD_RISERS`, `AD_BOOMS` in `build-lockfi-ad-audio.py`). The defaults are
  §44's film.


### Ask AI on a position

ALFA picked the portfolio as the next place for the assistant. Every position
row has an **Ask AI** button beside Collect fees and Withdraw. It opens the
panel under that row, one row at a time, with questions that depend on what
the position is doing:

- *Why is this position earning nothing?* when it is out of range;
- *How does this position earn fees?* when it is in range;
- *Why is the range status not known?* when the pool has no price yet.

The button shows only while the assistant is on. `useAskStatus` asks once per
page load and shares the answer, so a portfolio of twenty positions is one
request, not twenty.

**The position's figures come from the browser, and this is the one place
they do.** Everywhere else the facts are the server's own snapshot (§45). A
wallet's positions are read per wallet from the chain and are not in the
snapshot, and re-reading them for every question would cost seconds of public
RPC each time. The trade is safe for one reason: the answer goes back only to
the browser that sent the figures. Two things hold it in place:

- `parsePosition` accepts a digit-only token id, a short pair label, clamped
  numbers and three known statuses, and nothing else. A malformed position
  is dropped whole, not passed on in part.
- The prompt labels these as *the page's figures, read from their wallet;
  not the market's*.

The pool's facts still come from the snapshot by the position's pool id. A
pool below the listing bar is said to be off the board.

One rule was added for this: the assistant never tells a person whether to
withdraw, rebalance, collect or wait. It explains what each action does and
costs, and leaves the choice to them.

**Verified**: 2 new server tests (the position read and refused, the prompt's
labels and rule) and 2 Playwright tests (asking from a row sends the
position; no button while the assistant is off). The full suites are 587 unit
and 50 end-to-end tests, all green.

### An ad for Ask AI on the portfolio

`npm run brand:ad:portfolio` (`scripts/build-lockfi-portfolio-ai-ad.mjs`)
writes `brand/lockfi/video/lockfi-portfolio-ai-ad.mp4`: 34 seconds, the same
engine as the AI ad. It does not open on the logo the other films share,
at ALFA's request. It opens on its own scene: a MOONCAT / ETH position card
whose price line leaves the shaded band of its range, and the status turns
from *In range · earning fees* to *Out of range · earning nothing* at the
moment it crosses. Then *Why is my position earning nothing?* is typed into
a chat bar and sent, and *Don't guess. Just ask.* follows. After that, one
narrow, tall window of `/portfolio` shows the out-of-range
MOONCAT position: its **Ask AI** button, *Why is this position earning
nothing?*, and a sample answer that explains waiting, rebalancing and
withdrawing without choosing. It closes on *Your positions. Plain answers.
Your decision.* and `lockfi.org/portfolio`. The footnote reads *illustrative
figures · sample answer*.


### A launch film for the token

The owner asked for a video saying the LockFi token is live, with its
utility, and that LockFi is a real product. `npm run brand:ad:token`
(`scripts/build-lockfi-token-ad.mjs`) writes
`brand/lockfi/video/lockfi-token-ad.mp4`: 38 seconds on the same engine as
the other ads. It opens on a spinning coin with a *Live* pill, which no
earlier film uses. Then it films the real site: the markets board, the
shape builder minting through Uniswap, and Ask AI on an out-of-range
position. It closes on *The LockFi token is live.*

Two things it deliberately does not say:

- **No token utility.** None is built. LockFi takes no fee (§20), so the
  token has nothing to earn or share, and a film claiming staking rewards
  or fee share would promise what the contracts cannot deliver (§1, §7).
  The film says what is true: the product is live, it runs on Uniswap, and
  it has no custody.
- **No contract address.** At the owner's request the address goes in the
  X post, not the video. The end card says *Contract address in the post ·
  verify it on lockfi.org*, and the top bar's CA chip is hidden in every
  frame. **Set `TOKEN_CA` in `lib/site.ts` and deploy before posting.**
  Until then the site says *CA · coming soon* and warns that any address
  circulating before it appears there is not ours, which would contradict
  the post.

---

## 46. Telegram, back beside X

The owner opened the Telegram group, **t.me/lockfiorg**, and asked for it on
the site. §19 had removed Telegram at the owner's request when there was no
group; now there is one. `SOCIAL.telegram` in `lib/site.ts` is a constant for
the same reason as the X link (§19): a stale `.env` value must never point the
page somewhere else. `Community` renders both channels, each with its own
filled mark: in the rail as two stacked icons (labelled on the strip below
900px), and in the footer as `X` and `Telegram`. `lib/site.test.ts` pins the
link.

The footer had carried a quiet fault since §19: it passed `className="foot"`
to the links, and `.foot` is the footer's own class, so the links inherited
its top border, margin and padding and sat on a line of their own under a
stray rule. The class is `foot-soc` now, and the links sit in the footer's
row.

---

## 47. An introduction film for the Router

`npm run brand:ad:router` (`scripts/build-lockfi-router-ad.mjs`) writes
`brand/lockfi/video/lockfi-router-ad.mp4`: 36 seconds on the same engine as
the other films, with an opening of its own. Creator fees flow into the
router, split in half (one half swapped on a 30-minute TWAP), and fill a
pool, which then carries a *Permanent* lock. The film then shows the real
`/router` page: the trigger switched to market-cap milestones, the
destination range, the timeline, and the note that routed liquidity is
permanent. It closes on *LockFi Router · Coming soon*.

**The router is not live, and the film says so.** It needs a contract of its
own and ships only after an external audit (§20, §33). So the end card
reads *Coming soon* and *Launches after an external audit · preview only*,
and the footnote on every product scene reads *the router is not live yet ·
illustrative figures*. The simulator's figures on the page (the accrued fees,
the projection, the *Verified deployer* pill) are illustrative, like
everything else the films show.

---

## 48. The Router, live: LockFi's own contract

ALFA, on the router page: *ok buat live*. Three decisions came with it, each
the owner's: **no external audit and no cap** (put to ALFA with a capped beta
as the recommended option; ALFA chose to go live in full), **a 1% LockFi fee**,
and **a keeper on the server**. This is the first contract of LockFi's own
on mainnet, so §20's "no contract of our own" no longer holds for the Router.
It still holds for everything else.

### The contract

`contracts/LockFiRouter.sol` and `contracts/LockFiRouterFactory.sol`, solc
0.8.26 with via-IR for Cancun (Uniswap v4 needs Cancun's transient storage, so
the chain has it). `npm run router:compile` writes the ABIs to
`lib/router/abi.json`, and the factory's creation bytecode to
`lib/router/factory-bytecode.json`, which only the deploy page loads.
Uniswap's math libraries (MIT) are vendored in `contracts/vendor/`.

- **One router per token**, created by the team from the factory, into a
  Uniswap v4 pool (quote: native ETH or WETH) or a v3 pool (quote: WETH).
  The pool is fixed at creation.
- **A route**, which the keeper sends on the cadence or the team sends at
  any time, runs these steps:
  1. takes the LockFi fee from the ETH that arrived since the last route;
  2. collects the fees the router's own liquidity has earned (no LockFi fee
     on those);
  3. swaps the constant-product optimal amount of ETH for the token in that
     same pool, refusing a price below the caller's minimum;
  4. adds both sides as liquidity owned by the router at the pool itself: v4
     through `PoolManager.modifyLiquidity` in an unlock, v3 through the pool's
     `mint`. There is no NFT and no PositionManager.
- **Permanent by construction.** The router has no call that lowers a
  position's liquidity. Its only state-changing calls are `route`, `collect`,
  `setPaused`, `setTeam`, `withdrawUnrouted` and the three pool callbacks, and
  the test asserts that exact list. The team can pause and withdraw only what
  has not been routed.
- **The fee** is set at factory deployment. It is 1%, and the factory refuses
  more than 2%. There is no setter. The factory owner can name a new keeper
  or treasury, and nothing else.
- **Guards:**
  - swap output below the caller's minimum rate: revert;
  - a v4 hook that asks the router to pay more than the swap's input, or
    more than the amounts the liquidity was sized against: revert;
  - callbacks from anything but the router's own pool, or outside a route:
    revert.
- **Two faults fixed before they shipped:**
  - `collect()` is permissionless and first reset the fee mark to the whole
    balance, so anyone could have called it to wave through the LockFi fee
    on new ETH. It now marks only what it collected.
  - A route swapped a flat half, which after the swap's own price impact
    left about 4% of the token unused. The optimal-swap formula brings that
    to about 0.001%.

### The keeper

`server/keeper/main.ts`, the PM2 process `lockfi-keeper` on endpoint 3. The
decision logic is `lib/router/plan.ts`, which the local test also runs. It
routes a router when all of these hold:

- the router is due;
- at least `KEEPER_MIN_ROUTE_ETH` (0.002) of new ETH is waiting;
- the pool's price is within `KEEPER_MAX_DEVIATION_BPS` (300) of its own
  30-minute average.

The keeper samples that average itself, every minute, because v4 pools have no
on-chain oracle. It sends the route with a minimum 1% under Uniswap's own
quote. After a restart it waits one full window before routing. It never
receives funds, and without a key or a factory it says so once and waits
instead of crash-looping.

### The page

`/router` is live once `ROUTER_FACTORY` in `lib/chain.ts` is set. Until then,
and always on simulated data, it shows the preview, and the navigation's
"later" tag follows the same constant. Live, it has three parts:

- **Create a router:** the token, the pool (only pools with ETH on the other
  side and no unchecked hook), a schedule of 6h, 12h, 24h or weekly, and full
  range or ±20%.
- **Your routers:** Route now, Pause or Resume, and Withdraw unrouted.
- **All routers**, every figure read from the contracts.

The page says, in its own card, that the contract is **not audited**, and
that routed liquidity is permanent. Market-cap milestones are not in this
version.

`/router/deploy` (not in the navigation, not indexed) deploys the factory from
the owner's own wallet. No private key goes to the server for it. The steps
are in `deploy/MAINNET.md` §6.

### Verified

`npm run check:router` runs against Uniswap's own bytecode on a local chain
(v4 PoolManager, the v3 factory and pools, V4Quoter, QuoterV2): 48 checks,
all passing. They cover:

- v4 with native ETH, full range;
- v4 with WETH, ±20%;
- v3 with WETH, ±20%;
- the treasury receiving exactly 1%, with none on earned fees;
- the router's liquidity only ever rising, across routes, a stranger's
  collect, and pause-and-withdraw;
- the keeper waiting out a pushed price;
- a minimum above the pool's price reverting;
- every authorisation refusal.

Also: 594 unit tests, 50 end-to-end tests, and the production build.

**Not verified:**

- a malicious v4 hook (the guard is in the contract but untested against a
  real one);
- anything on Robinhood Chain itself, since the sandbox reaches no RPC;
- whether a launchpad lets a team set a contract as its creator-fee
  recipient. If not, the team sends the ETH to the router itself.

The first router should be LockFi's own, with a small amount, watched on the
explorer.
