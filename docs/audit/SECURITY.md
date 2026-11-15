# Threat model and known limitations

## Actors and what each can do

| Actor | Can | Cannot |
|---|---|---|
| **Staker** | Deposit (to any recipient), withdraw their own shares at any time, claim their own rewards. | Touch anyone else's shares or rewards. |
| **Vault owner** (intended: a multisig) | Set keeper, set treasury, set the protocol fee up to the cap fixed at deploy, close/reopen *new* deposits, transfer ownership (two-step). | Withdraw staker liquidity or rewards; raise the cap; pause withdraw or claim; upgrade (no proxy, no delegatecall). |
| **Keeper** (hot wallet with gas only) | Trigger `harvest(minEthFromTokens, deadline)`; trigger router `route`. Chooses timing and the minimum swap output. | Receive any funds. Its worst case is a bad `minEthFromTokens` (see below) or not harvesting at all (stakers' principal is unaffected; rewards wait). |
| **Treasury** | Receives the protocol fee. | Anything else. |
| **Router owner** (token team) | Rotate the keeper, pause/unpause, withdraw *unrouted* funds while paused. | Change the destination pool, range, mode, cadence, milestones, guards; remove routed liquidity. |
| **Traders / MEV** | Move pool prices around a harvest or route. | Make a harvest sell below the keeper's minimum, or a route trade beyond the TWAP guard and slippage bound. |

## Design decisions worth scrutiny

1. **Shares are liquidity units.** No exchange rate, so no inflation or
   first-depositor attack. The vault's position liquidity equals
   `totalSupply` (invariant-tested).
2. **Fees collected by any position change are held, not handed out.** A v4
   `modifyLiquidity` returns every accrued fee; the vault records them as
   `pendingEthFees` / `pendingTokenFees` and only `harvest` turns them into
   rewards.
3. **Exact reward accrual.** Per-account rewards are kept scaled by 1e18 so
   claiming often does not lose rounding against claiming once; the
   remainder of `reward / 7 days` and anything streamed while
   `totalSupply == 0` go to `queuedRewards` and into the next stream.
   `rewardsReserved` tracks every WETH committed and unpaid; `_notifyReward`
   reverts if the WETH balance falls below it.
4. **Withdraw never depends on rewards or pending fees.** It changes the
   position and pays principal only.
5. **Hooks.** Vaults accept hookless pools only. Routers accept hooked pools
   except hooks with `AFTER_ADD_LIQUIDITY_RETURNS_DELTA` or
   `AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA` permission bits.
6. **The router's TWAP is its own.** v4 pools carry no oracle. `poke()`
   (anyone; no-op within 60 s of the last) records a tick accumulator; a TWAP
   needs ≥ 6 observations spanning 30 minutes. The accumulator holds the tick
   seen at each poke until the next, so a price held at a poke weighs for
   that interval.

## Known limitations

- **Harvest swap pricing is the keeper's.** `minEthFromTokens` comes from the
  keeper's trailing price (the indexer's own swaps, median over 30 minutes).
  A compromised or careless keeper could pass 0 and expose one harvest's
  token-side fees to a sandwich. Bound: one harvest's token fees, never
  principal. Mitigation: dedicated keeper key, owner can rotate it.
- **Self-fee on harvest.** The harvest sells token fees in the same pool the
  vault provides liquidity to; part of that swap's fee returns to the vault's
  own position and is collected by the next harvest (shown in
  `test_keeperOutage48h…`).
- **Router TWAP granularity** depends on poke frequency; a manipulated price
  held across a poke contributes for the interval to the next poke. Bounded
  by `maxTwapDeviationTicks` and `maxSlippageBps` (≤ 10%).
- **Router milestones are FDV in WETH** (`totalSupply × TWAP price`), not
  circulating market cap and not USD. The UI converts at configuration time.
- **Unsupported tokens.** Fee-on-transfer tokens make deposits revert
  (settlement mismatch). Rebasing tokens can make `harvest` revert; withdraw
  is unaffected. Vaults are deployed only for pools chosen by the owner.
- **Zap trusts the vault address it is given.** It approves its own,
  in-transaction balance to that address. The site passes only vaults from
  `config/deployments.json`.
- **Rounding dust** from `rewardPerToken` division stays in the vault,
  counted in `rewardsReserved`; it is never paid out and never lost to
  insolvency.
- **Deadlines are timestamps** (~100 ms blocks). Permit2 approvals from the
  periphery expire at `block.timestamp` and are spendable only with the
  periphery contract as the PositionManager's locker.
- **ArbOS gas.** The block header reports 2^50 gas; the real per-transaction
  cap is 32M. A 60-bin shaped mint measured 8.1M.

## Not in this audit

The off-chain keeper (`server/keeper/`) and the site. They cannot move funds
except through the functions above, but a keeper that stops is a vault whose
rewards stop: the site shows harvest lag (CLAUDE.md §8, P3).
