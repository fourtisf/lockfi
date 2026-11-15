# Tidewell contracts — audit package

Prepared for an external audit (CLAUDE.md §8, P5: *"No mainnet deployment of
the vault before an external audit. This is the one phase that cannot be
compressed."*). Pin the exact commit hash when the engagement starts; the
scope below is that commit.

## Scope

| File | What it is | Holds funds? |
|---|---|---|
| `contracts/src/TidewellVault.sol` | One vault per hookless Uniswap v4 pool. Stakers' liquidity in one full-range position; fees credited per share at collection and claimable any time in the pool's two tokens, held as PoolManager ERC-6909 claims. | **Yes** — stakers' liquidity and their fees (as claims). |
| `contracts/src/TidewellRouter.sol` | `TidewellRouter`: a token team's fee stream turned into permanent liquidity; own 30-minute TWAP. `TidewellRouterFactory`: deploys routers. | Yes — unrouted fees, and the permanent position. |
| `contracts/src/TidewellZap.sol` | One-token stake into a vault, or one-token mint of a v4 position. | Only within a transaction. |
| `contracts/src/TidewellShaper.sol` | Up to 60 weighted positions minted to the caller in one transaction. | Only within a transaction. |
| `contracts/src/base/PeripheryBase.sol` | Shared input, swap, mint and sweep logic for Zap and Shaper. | — |
| `contracts/src/libraries/Settlement.sol` | Paying and collecting PoolManager deltas. | — |
| `contracts/src/interfaces/IWETH9.sol` | WETH interface. | — |

Out of scope: Uniswap v4-core, v4-periphery (PositionManager), Permit2,
solmate — used as deployed on Robinhood Chain (addresses in `lib/chain.ts`,
verified on chain: the UniversalRouter's `V4_POSITION_MANAGER()` returns the
PositionManager, whose `poolManager()`, `permit2()` and `WETH9()` match).

Compiler: solc 0.8.26, `evm_version = cancun`, optimizer 200 runs, no via-IR.
Chain: Robinhood Chain (chainId 4663), Arbitrum Orbit, ~100 ms blocks,
first-come-first-served sequencer.

## Build and test

```bash
cd contracts
git submodule update --init --recursive
forge build
forge test                                  # unit + invariant (256 runs)
FOUNDRY_PROFILE=p2 forge test --match-contract Invariant   # §9: 10,000 runs
FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/fork/*'
```

The fork tests are a dress rehearsal against the real PoolManager,
PositionManager, Permit2, WETH and the chain's deepest hookless ETH/USDG pool.
Nothing is broadcast.

## What the tests establish

| Property | Test |
|---|---|
| §3.5 `sum(balances) == totalSupply`, always | `invariant_sharesSumToTotalSupply` |
| Position liquidity equals shares outstanding | `invariant_positionIsTotalSupply` |
| §3.5 `protocolFeeBps` never above the constructor cap; cap ≤ 2000 | `invariant_feeNeverAboveCap`, `test_protocolFee_canNeverExceedTheCap_andAppliesFromNowOn` |
| §9 the vault can always pay every fee owed, both tokens (50 wallets, random orderings, 10,000 runs × 64 calls) | `invariant_canAlwaysPayEverythingOwed`, `afterInvariant` (everyone exits and is paid exactly what `owed` said) |
| Nothing stranded beyond dust | `invariant_noValueStrandedBeyondDust` |
| Fees belong to the shares that earned them: no sniping, no forfeiture | `test_fees_cannotBeSnipedByALateLargeDeposit`, `test_fees_surviveWithdrawingEverything`, `test_fees_splitByShareAndTime`, `testFuzz_lateWhale_getsNothingEarnedBeforeIt` |
| §3.5 claiming often pays exactly what claiming once pays | `test_claimingEveryHour_paysExactlyWhatNeverClaimingPays` |
| §9 P3: after 48 h untouched, one claim collects exactly the accrued fees; no double payment | `test_48hUntouched_oneClaimCollectsExactlyWhatAccrued` |
| Protocol fee exactly 10% of fees, paid to the treasury | `test_protocolFee_isTenPercentOfFees_paidToTheTreasury` |
| Withdraw always available (deposits closed, no fees) and principal-only | `test_withdraw_returnsPrincipal_andIsAlwaysAvailable`, `test_withdraw_principalExcludesFees` |
| A frozen vault address blocks nothing | `test_frozenVaultAddress_doesNotBlockWithdrawOrClaim` |
| §3.5 Shaper: weights sum to 10,000; 61 bins revert; 60 bins fit (8.1M gas vs ArbOS's 32M per-tx cap) | `test_mintShaped_weightsMustSumTo10000`, `test_mintShaped_moreThan60BinsIsRefusedNotTruncated`, `test_mintShaped_sixtyBinsFitInOneTransaction` |
| §3.5 Zap: a degraded quote reverts, never partially fills | `test_zapStake_degradedQuoteReverts` |
| §3.5 Router: milestones out of order revert at config; fire at most once; spot beyond the TWAP guard reverts | `test_milestones_outOfOrderRevertAtConfig`, `test_milestone_firesAtMostOnce`, `test_route_spotFarFromTwapReverts` |
| Router: TWAP only the keeper can write, truncated, exactly 30 minutes | `test_poke_onlyTheKeeper`, `test_sameTransactionManipulation_cannotWriteTheAverage`, `test_observations_areTruncated`, `test_twap_coversExactlyTheLastThirtyMinutes` |
| Router: pause stops routes; only unrouted funds withdrawable; routed liquidity untouched | `test_pause_stopsRoutes_withdrawOnlyWhilePaused`, `test_route_addsLiquidityNothingCanRemove` |

The pre-audit review's findings and fixes are in `PRE_AUDIT_REVIEW.md`; the
static analysis triage in `SLITHER.md`; mutation testing (planted bugs the
suite must catch) is summarised in `SLITHER.md` too.

See `SECURITY.md` for the threat model and known limitations.

## Deployment gate, and the decision to launch before this audit

`contracts/script/Deploy.s.sol` refuses chainId 4663 unless
`TIDEWELL_AUDIT_REPORT` names the report or the owner states
`TIDEWELL_UNAUDITED_MAINNET=I_ACCEPT_THE_RISK`; `scripts/apply-deployment.mjs`
applies the same rule before publishing to `config/deployments.json`.

**The owner chose to launch on mainnet before this audit, without a deposit
cap** (CLAUDE.md §20). Contracts deployed that way are recorded
`audited: false` and the site says so beside every signing button. An audit
of this code therefore reviews contracts that may already hold funds; the
owner can close new deposits (`setDepositsOpen(false)`) on a finding, and
withdraw and claim stay open by construction.
