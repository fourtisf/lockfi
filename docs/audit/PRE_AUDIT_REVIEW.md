# Pre-audit review: findings and what changed

An independent internal review of the four contracts, before any external
audit, with each serious finding proven by a test against the code as it then
was. This records what was found, what changed, and how the change is tested.
The external auditor should treat it as a list of places to look hardest, not
as assurance.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | Router TWAP writable by anyone: `poke()` was public, so swap → poke → swap back in one transaction recorded any price. Proven: TWAP dragged 2,342 ticks from an unmoved spot for 1.58 ETH; a 25 ETH route in a 0.05% pool bought 21.3% worse and the attacker netted +2.53 ETH. | **Fixed.** `poke()` is keeper-only; each observation moves at most `maxTwapDeviationTicks` from the last (truncated oracle); `maxTwapDeviationTicks ≤ 10,000`. All five of the reviewer's proof tests now revert with `NotKeeper`. Tests: `test_poke_onlyTheKeeper`, `test_sameTransactionManipulation_cannotWriteTheAverage`, `test_observations_areTruncated`. |
| 2 | Medium | Vault fees pooled and streamed for 7 days to whoever held shares *after* a harvest: a deposit 9× Alice's just before a harvest took 90.4% of fees she alone earned; exiting right after a harvest forfeited one's own fees (an exit fee in effect). | **Fixed by redesign** (ALFA's choice, CLAUDE.md §20): fees are credited per share at collection — every deposit, withdraw, claim and poke first collects what the position earned and credits it to the shares as they stood — and are claimable any time in the pool's two tokens, after withdrawing too. Tests: `test_fees_cannotBeSnipedByALateLargeDeposit` (the review's scenario: 0 to the late whale), `test_fees_surviveWithdrawingEverything`, `testFuzz_lateWhale_getsNothingEarnedBeforeIt`, `test_fees_splitByShareAndTime`. |
| 3 | Medium | Harvest sold token-side fees with only a keeper-supplied minimum: a compromised keeper could sandwich it (proven: +0.31 ETH on 0.63 ETH of fees). | **Removed with the harvest.** No swap remains in the vault; fees are paid in the tokens they were earned in. |
| 4 | Low | Withdraw pulled accrued fees into the vault's own address, so a token issuer freezing that address blocked every withdraw. | **Fixed.** Fees are held as PoolManager ERC-6909 claims and paid PoolManager → claimant; the vault never holds or receives the tokens. Test: `test_frozenVaultAddress_doesNotBlockWithdrawOrClaim` (a freezable token, frozen vault, withdraw and claim succeed). |
| 5 | Low | TWAP not bounded to 30 minutes: the average ran from the newest observation at or before the window start, possibly hours old. | **Fixed.** The cumulative at the window start is interpolated between the observations either side (exact: the tick is constant between observations). Test: `test_twap_coversExactlyTheLastThirtyMinutes`. |
| 6 | Low | Router accepted hooks that run on swaps. | **Fixed.** Pools whose hook has before/after-swap or swap-delta permissions are refused, as are liquidity-delta hooks. Test: `test_swapHookPools_areRefused`. |

## Informational items, and what was done

- **Shaper has no minimum-liquidity check**; the post-swap price band bounds
  execution. Unchanged; noted.
- **Zap trusts the vault address it is given**; third parties cannot be hurt.
  The site passes only vaults in `config/deployments.json`. Unchanged; noted.
- **Owner can raise the protocol fee to the cap at once.** It now applies only
  to fees collected afterwards (`setProtocolFee` collects first, so earned fees
  are cut at the old rate); the site reads the live value before signing.
- **Rounding dust is stranded** — in the redesign the per-share division loses
  less than one wei per collection in total (supply < 2^128); it stays in the
  vault's claims and is never paid.
- **Comment mismatches** (vault `receive`, Permit2 "this block", router
  `route`/`due`, router fee recycling) — corrected.
- **Test gaps** — WETH-pool router branches now tested both ways; attacker
  tests for the TWAP added; a freezable-token test added. The invariant
  handler now also deposits on behalf of other wallets and pays the protocol.

## Verified sound by the reviewer, and still so after the changes

No admin or keeper path to principal; withdraw never gated; fees-vs-principal
separation (`callerDelta − feesAccrued`, and in the redesign every liquidity
change follows a fresh collection in the same call); settlement order
(sync → transfer → settle; native settles with nothing synced); reentrancy
guards on every entry point; the router has no path to remove liquidity, the
keeper never receives funds, milestones are checked ascending and fire once;
Permit2 handling in the periphery; nothing left behind by Zap or Shaper.
