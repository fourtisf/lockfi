# Threat model and known limitations

## Actors and what each can do

| Actor | Can | Cannot |
|---|---|---|
| **Staker** | Deposit (to any recipient), withdraw their own shares at any time, claim their own rewards. | Touch anyone else's shares or rewards. |
| **Vault owner** (intended: a multisig) | Set keeper, set treasury, set the protocol fee up to the cap fixed at deploy, close/reopen *new* deposits, transfer ownership (two-step). | Withdraw staker liquidity or rewards; raise the cap; pause withdraw or claim; upgrade (no proxy, no delegatecall). |
| **Keeper** (hot wallet with gas only) | Routers only: record TWAP observations (`poke`) and trigger `route`. Vaults have no keeper. | Receive any funds. Its worst case is a stale or (if compromised) slowly walked router TWAP — bounded per observation by the truncation and at route time by the deviation and slippage guards — or not routing at all. |
| **Treasury** | Receives the protocol fee. | Anything else. |
| **Router owner** (token team) | Rotate the keeper, pause/unpause, withdraw *unrouted* funds while paused. | Change the destination pool, range, mode, cadence, milestones, guards; remove routed liquidity. |
| **Traders / MEV** | Move pool prices around a harvest or route. | Make a harvest sell below the keeper's minimum, or a route trade beyond the TWAP guard and slippage bound. |

## Design decisions worth scrutiny

1. **Shares are liquidity units.** No exchange rate, so no inflation or
   first-depositor attack. The vault's position liquidity equals
   `totalSupply` (invariant-tested), and shares change before the position
   in every call.
2. **Fees are credited at collection, per share.** Any position change in v4
   returns every accrued fee; the vault always collects first (a zero-delta
   `modifyLiquidity`), credits it to the shares as they stood, and only then
   changes shares and liquidity in the same call, during which fee growth
   cannot move. Per-account amounts are kept ×2^128 so claim frequency does
   not matter.
3. **Fees are PoolManager claims.** Collected fees are minted as ERC-6909
   claims to the vault and paid by burn + take to the claimant. The vault
   never holds or forwards the tokens; `_payOut` checks the claims cover the
   payment.
4. **Withdraw never depends on fees.** It changes the position and pays
   principal only; fees stay claimable.
5. **Hooks.** Vaults accept hookless pools only. Routers refuse liquidity-
   delta hooks and every swap hook.
6. **The router's TWAP is its own and the keeper's alone.** `poke()` is
   keeper-only and no-ops within 60 s; each observation moves at most
   `maxTwapDeviationTicks` (≤ 10,000) from the last; a TWAP needs ≥ 6
   observations and covers exactly 30 minutes by interpolation.

## Known limitations

- **Router TWAP trusts the keeper's timing.** A compromised keeper can walk
  the recorded price by at most `maxTwapDeviationTicks` per minute and still
  needs the real spot within the guard at route time. Mitigation: a dedicated
  keeper key the owner can rotate.
- **Router milestones are FDV in WETH** (`totalSupply × TWAP price`), not
  circulating market cap and not USD. The UI converts at configuration time.
- **Unsupported tokens.** Fee-on-transfer tokens make deposits revert
  (settlement mismatch). Vaults are deployed only for pools the owner chooses.
- **Fees are paid in the pool's tokens**, including a memecoin side where the
  pool has one; there is no conversion to WETH by design (no swap, no price
  to manipulate).
- **Zap trusts the vault address it is given.** It approves its own,
  in-transaction balance to that address. The site passes only vaults from
  `config/deployments.json`.
- **Rounding dust** below one wei per collection stays in the vault's claims.
- **Deadlines are timestamps** (~100 ms blocks). Permit2 approvals from the
  periphery expire at `block.timestamp` (about ten blocks) and are spendable
  only with the periphery contract as the PositionManager's locker.
- **ArbOS gas.** The block header reports 2^50 gas; the real per-transaction
  cap is 32M. A 60-bin shaped mint measured 8.1M.

## Not in this audit

The off-chain keeper (`server/keeper/`) and the site. They cannot move funds
except through the functions above. Vaults need no keeper at all; a stopped
keeper only pauses router routes, which the site reports.
