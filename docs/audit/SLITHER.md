# Slither, triaged

`slither 0.11.6` over `contracts/src` (dependencies, tests and scripts
filtered): 102 detectors, 68 results. Every High and Medium result was read
against the code. One led to a change; none is exploitable.

| Detector | Where | Verdict |
|---|---|---|
| arbitrary-send-erc20 (High) | `Settlement.pay` | False positive. `payer` is the vault's own `msg.sender` for that deposit, encoded by the vault into its own `unlock`; the callback only runs inside the vault's unlock (the PoolManager calls back whoever unlocked it, and the vault checks `msg.sender == poolManager`). No path pulls from anyone else's approval. The periphery always pays from `address(this)`. |
| weak-prng (High) ×2 | `_notifyReward`, `twapTick` | False positive: `%` is a remainder (rounding carried forward; round-toward-negative-infinity), not randomness. |
| reentrancy-eth (High) | `TidewellVault.harvest`, `TidewellRouter.route` | Both `nonReentrant`; external calls go to the PoolManager and WETH (immutables). |
| reentrancy-no-eth (Medium) | `TidewellVault.deposit` | Not exploitable (guarded), but shares were written after the PoolManager call, so for the duration of the call the position was larger than `totalSupply`. **Changed**: shares are now written before the call (checks-effects-interactions); a failed slippage check reverts both. |
| reentrancy-no-eth (Medium) | `_harvestInside`, `exit` | Inside the vault's own unlock / sequential guarded calls. |
| divide-before-multiply (Medium) ×2 | `_claim`, `_notifyReward` | Intended: the remainder below one wei is kept (`rewardsScaled`), and the leftover of the current stream is folded in exactly as Synthetix does, with the new remainder queued. |
| incorrect-equality (Medium) ×5 | zero checks | Intended. |
| uninitialized-local (Medium) ×6 | accumulators | Intended zero defaults. |
| unused-return (Medium) ×16 | `getSlot0`, `settle`, `modifyLiquidity` | Only the needed fields are used; `settle` returns the amount already known. |
| missing-zero-check (Low) | keeper setters, `transferOwnership` | A zero keeper only stops harvests until the owner sets one; `transferOwnership(0)` cancels a pending transfer. No funds at risk. The router's `token` cannot be zero (currency0 < currency1). |
| timestamp, reentrancy-events/benign (Low) | — | Timestamps are the design (§2 deadlines, 7-day stream, TWAP); events after guarded calls. |

## Fuzzing beyond the invariant suite

`contracts/test/TidewellFuzz.t.sol`, 2,000 runs each:

- deposit then withdraw, two users in either order: nobody gets back more of
  either token than they put in;
- a late arrival who deposits after fees accrued and leaves at once ends with
  no more of either token than they started with, and the fees stay for the
  stakers;
- `zapStake` with random amounts and swap fractions ends holding nothing;
- `mintShaped` with 1–60 random bins of random widths and weights ends
  holding nothing.

Checked that these are not passing vacuously: across 200 sampled inputs,
200 of 200 zaps and 200 of 200 shaped mints succeeded.
