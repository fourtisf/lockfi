# Tidewell contracts — audit package

Prepared for an external audit (CLAUDE.md §8, P5: *"No mainnet deployment of
the vault before an external audit. This is the one phase that cannot be
compressed."*). Pin the exact commit hash when the engagement starts; the
scope below is that commit.

## Scope

| File | What it is | Holds funds? |
|---|---|---|
| `contracts/src/TidewellVault.sol` | One vault per Uniswap v4 pool. Stakers' liquidity in one full-range position; harvested fees converted to WETH and streamed over 7 days (Synthetix `StakingRewards`). | **Yes** — stakers' liquidity and WETH rewards. |
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

| Property (CLAUDE.md) | Test |
|---|---|
| §3.5 `sum(balances) == totalSupply`, always | `invariant_sharesSumToTotalSupply` |
| Position liquidity equals shares outstanding | `invariant_positionIsTotalSupply` |
| §3.5 `protocolFeeBps` never above the constructor cap; cap ≤ 2000 | `invariant_feeNeverAboveCap`, `test_protocolFee_canNeverExceedTheCap`, `test_constructor_capIsBoundedAndFeeUnderCap` |
| §9 the vault can always pay `sum(earned)` (50 wallets, random orderings, 10,000 runs × 64 calls) | `invariant_canAlwaysPayEverythingEarned`, `invariant_rewardAccountingCloses`, `afterInvariant` (every staker exits and is paid exactly `earned`) |
| §3.5 never-claim == claim-every-hour, exactly | `test_claimingEveryHour_paysExactlyWhatNeverClaimingPays` |
| §3.5 withdraw works with `rewardRate == 0` and zero WETH balance | `test_withdraw_worksWithNoRewardsEverAndNoWeth` |
| Withdraw works with deposits closed | `test_withdraw_worksWithDepositsClosed` |
| Fees earned before a deposit are not the depositor's | `test_deposit_feesEarnedBeforeYouJoinAreNotYours` |
| Rewards streamed while nobody is staked are not lost | `test_rewards_streamedWhileNobodyIsStakedAreQueuedNotLost` |
| §9 P3: one harvest after 48 h collects exactly the accrued fees; no double count | `test_keeperOutage48h_oneHarvestCollectsExactlyWhatAccrued` |
| §3.5 Shaper: weights must sum to 10,000 | `test_mintShaped_weightsMustSumTo10000` |
| §3.5 Shaper: 60 bins fit one transaction (8.1M gas against ArbOS's 32M per-tx cap) | `test_mintShaped_sixtyBinsFitInOneTransaction` |
| Shaper: 61 bins revert, never truncated | `test_mintShaped_moreThan60BinsIsRefusedNotTruncated` |
| §3.5 Zap: a degraded quote reverts, never partially fills | `test_zapStake_degradedQuoteReverts` |
| §3.5 Router: milestones out of order revert at config time | `test_milestones_outOfOrderRevertAtConfig` |
| §3.5 Router: a milestone fires at most once | `test_milestone_firesAtMostOnce` |
| §3.5 Router: spot beyond the TWAP guard reverts | `test_route_spotFarFromTwapReverts` |
| Router: swap below TWAP − slippage reverts | `test_route_swapWorseThanTheAverageAllowsReverts` |
| Router: pause stops routes; only unrouted funds withdrawable; routed liquidity untouched | `test_pause_stopsRoutes_withdrawOnlyWhilePaused`, `test_route_addsLiquidityNothingCanRemove` |

See `SECURITY.md` for the threat model and known limitations.

## Deployment gate

`contracts/script/Deploy.s.sol` refuses chainId 4663 unless
`TIDEWELL_AUDIT_REPORT` names the report, and `scripts/apply-deployment.mjs`
refuses to publish a 4663 deployment into `config/deployments.json` without
one. Rehearsals run on an anvil fork with `--chain-id 31337`, so there is no
override switch that could be flipped for the real chain.
