// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IWETH9} from "../src/interfaces/IWETH9.sol";
import {TidewellRouter, TidewellRouterFactory} from "../src/TidewellRouter.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

library StateLibraryView {
    using PoolIdLibrary for PoolKey;

    function slot0(IPoolManager pm, PoolKey memory k) internal view returns (uint160 sqrtP, int24 tick, uint24 a, uint24 b) {
        return StateLibrary.getSlot0(pm, k.toId());
    }
}
import {Fixture} from "./utils/Fixture.sol";

contract TidewellRouterTest is Fixture {
    PoolKey internal key;
    address internal team = makeAddr("team");
    TidewellRouterFactory internal factory;

    function setUp() public {
        deployCore();
        key = nativeKey();
        initPool(key);
        seedLiquidity(key, 1e21);
        seedLiquidity(key, 9e21); // ~316 ETH of depth: a route is not the whole pool
        factory = new TidewellRouterFactory(manager, IWETH9(address(weth)));
    }

    // ---------------------------------------------------------------- helpers

    function cadenceConfig() internal view returns (TidewellRouter.Config memory cfg) {
        cfg.key = key;
        cfg.tickLower = TickMath.minUsableTick(SPACING);
        cfg.tickUpper = TickMath.maxUsableTick(SPACING);
        cfg.mode = TidewellRouter.Mode.Cadence;
        cfg.cadenceSeconds = 1 days;
        cfg.maxSlippageBps = 300;
        cfg.maxTwapDeviationTicks = 200;
        cfg.minRouteWeth = 0.01 ether;
    }

    function milestoneConfig(uint256[] memory ms) internal view returns (TidewellRouter.Config memory cfg) {
        cfg = cadenceConfig();
        cfg.mode = TidewellRouter.Mode.Milestone;
        cfg.cadenceSeconds = 0;
        cfg.milestonesWeth = ms;
    }

    function deploy(TidewellRouter.Config memory cfg) internal returns (TidewellRouter r) {
        vm.prank(team);
        r = factory.createRouter(cfg, keeper);
    }

    /// Seven observations five minutes apart: a full 30-minute window.
    function buildTwap(TidewellRouter r) internal {
        for (uint256 i; i < 7; i++) {
            vm.warp(block.timestamp + 5 minutes);
            vm.prank(keeper);
            r.poke();
        }
    }

    function payFees(TidewellRouter r, uint256 amount) internal {
        (bool ok,) = address(r).call{value: amount}("");
        require(ok);
    }

    function route(TidewellRouter r) internal returns (uint128) {
        vm.prank(keeper);
        return r.route(block.timestamp);
    }

    // ----------------------------------------------------------------- routes

    function test_route_addsLiquidityNothingCanRemove() public {
        TidewellRouter r = deploy(cadenceConfig());
        assertEq(r.owner(), team);
        payFees(r, 10 ether);
        buildTwap(r);

        uint128 liquidity = route(r);
        assertGt(liquidity, 0);
        assertEq(r.routedLiquidity(), liquidity);
        // Nearly all of it went in; what is left waits for the next route.
        assertLt(r.unroutedWeth(), 0.5 ether);

        // Pausing and withdrawing takes the unrouted remainder only.
        vm.startPrank(team);
        r.pause();
        r.withdrawUnrouted(team);
        vm.stopPrank();
        assertEq(r.routedLiquidity(), liquidity);
        assertEq(r.unroutedWeth(), 0);
    }

    function test_route_onlyTheKeeper_andOnlyTheOwnerRotatesIt() public {
        TidewellRouter r = deploy(cadenceConfig());
        payFees(r, 1 ether);
        buildTwap(r);
        vm.expectRevert(TidewellRouter.NotKeeper.selector);
        r.route(block.timestamp);

        vm.prank(keeper);
        vm.expectRevert(TidewellRouter.NotOwner.selector);
        r.setKeeper(keeper);

        address next = makeAddr("next");
        vm.prank(team);
        r.setKeeper(next);
        vm.prank(next);
        assertGt(r.route(block.timestamp), 0);
    }

    function test_cadence_waitsItsInterval() public {
        TidewellRouter r = deploy(cadenceConfig());
        payFees(r, 1 ether);
        buildTwap(r);
        route(r);

        payFees(r, 1 ether);
        vm.warp(block.timestamp + 12 hours);
        buildTwap(r);
        vm.prank(keeper);
        vm.expectRevert(TidewellRouter.NotDue.selector);
        r.route(block.timestamp);

        vm.warp(block.timestamp + 12 hours);
        buildTwap(r);
        route(r);
    }

    function test_route_needsAThirtyMinuteHistory() public {
        TidewellRouter r = deploy(cadenceConfig());
        payFees(r, 1 ether);
        vm.prank(keeper);
        vm.expectRevert(TidewellRouter.TwapUnavailable.selector);
        r.route(block.timestamp);

        // Two samples thirty minutes apart are not an average anyone should
        // trust: one of them could be the manipulated one.
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(keeper);
        r.poke();
        vm.prank(keeper);
        vm.expectRevert(TidewellRouter.TwapUnavailable.selector);
        r.route(block.timestamp);
    }

    /// §3.5: routing at spot when TWAP deviates more than the guard reverts.
    function test_route_spotFarFromTwapReverts() public {
        TidewellRouter r = deploy(cadenceConfig());
        payFees(r, 1 ether);
        buildTwap(r);
        // Someone pushes the price just before the keeper's call.
        trade(key, false, 5_000 ether);
        vm.prank(keeper);
        vm.expectPartialRevert(TidewellRouter.TwapDeviation.selector);
        r.route(block.timestamp);
    }

    function test_route_swapWorseThanTheAverageAllowsReverts() public {
        TidewellRouter.Config memory cfg = cadenceConfig();
        cfg.maxSlippageBps = 10; // tighter than the pool's own 0.30% fee
        TidewellRouter r = deploy(cfg);
        payFees(r, 1 ether);
        buildTwap(r);
        vm.prank(keeper);
        vm.expectPartialRevert(TidewellRouter.Slippage.selector);
        r.route(block.timestamp);
    }

    function test_route_spendsAtMostItsSliceAndLeavesTheRest() public {
        TidewellRouter.Config memory cfg = cadenceConfig();
        cfg.maxRouteWeth = 1 ether;
        TidewellRouter r = deploy(cfg);
        payFees(r, 5 ether);
        buildTwap(r);
        route(r);
        // One slice routed; the other four wait for the next cadence.
        assertApproxEqAbs(r.unroutedWeth(), 4 ether, 0.05 ether);
        assertGe(r.unroutedWeth(), 4 ether);
    }

    function test_twap_isTheHeldTickWhenNothingMoves() public {
        TidewellRouter r = deploy(cadenceConfig());
        buildTwap(r);
        int24 twap = r.twapTick();
        assertApproxEqAbs(int256(twap), int256(START_TICK), 1);
    }

    // -------------------------------------------- the review's TWAP attack

    function test_poke_onlyTheKeeper() public {
        TidewellRouter r = deploy(cadenceConfig());
        vm.warp(block.timestamp + 5 minutes);
        vm.expectRevert(TidewellRouter.NotKeeper.selector);
        r.poke();
    }

    /// Pre-audit finding 1: swap, poke, swap back in one transaction wrote any
    /// price into the average. With keeper-only observations the attacker's
    /// poke reverts, and the price they pushed and pulled back is never seen.
    function test_sameTransactionManipulation_cannotWriteTheAverage() public {
        TidewellRouter r = deploy(cadenceConfig());
        payFees(r, 1 ether);
        int24 lo = type(int24).max;
        int24 hi = type(int24).min;
        int24 pushed;
        for (uint256 i; i < 7; i++) {
            vm.warp(block.timestamp + 5 minutes);
            trade(key, false, 50_000 ether); // push
            (, pushed,,) = StateLibraryView.slot0(manager, key);
            vm.expectRevert(TidewellRouter.NotKeeper.selector);
            r.poke();
            trade(key, true, 49 ether); // and pull back
            vm.prank(keeper);
            r.poke();
            int24 seen = r.lastTick();
            if (seen < lo) lo = seen;
            if (seen > hi) hi = seen;
        }
        int24 twap = r.twapTick();
        // The average is made only of what the keeper saw after each pull
        // back; the pushed price, thousands of ticks away, is in none of it.
        assertGe(twap, lo - 1);
        assertLe(twap, hi + 1);
        assertGt(int256(pushed) - int256(twap), 2000);
    }

    /// A compromised keeper can walk the recorded price, never jump it.
    function test_observations_areTruncated() public {
        TidewellRouter r = deploy(cadenceConfig());
        int24 before = r.lastTick();
        trade(key, false, 200_000 ether); // a move of thousands of ticks
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(keeper);
        r.poke();
        assertEq(int256(r.lastTick()) - int256(before), 200); // the configured step
    }

    /// Pre-audit finding 5: after a long gap the average must cover exactly
    /// the last 30 minutes, not stretch back over the stale stretch.
    function test_twap_coversExactlyTheLastThirtyMinutes() public {
        TidewellRouter r = deploy(cadenceConfig());
        buildTwap(r);
        vm.warp(block.timestamp + 2 hours); // keeper down
        // A real move, held — smaller than one truncation step, so the first
        // observation after the gap records it whole.
        trade(key, false, 2_000 ether);
        (, int24 moved,,) = StateLibraryView.slot0(manager, key);
        assertLt(int256(moved) - int256(r.lastTick()), 200);
        assertGt(int256(moved) - int256(r.lastTick()), 50);
        buildTwap(r);
        // Exactly the last 30 minutes: the stale two hours count for nothing.
        assertEq(r.twapTick(), moved);
    }

    /// The window's start falling inside a long gap: the average is the old
    /// tick for the 4 minutes of the window before the first fresh sample and
    /// the new one after — not the old tick over two and a half hours.
    function test_twap_interpolatesAWindowStartInsideAGap() public {
        TidewellRouter r = deploy(cadenceConfig());
        buildTwap(r);
        int24 old = r.lastTick();
        vm.warp(block.timestamp + 2 hours);
        trade(key, false, 2_000 ether);
        (, int24 moved,,) = StateLibraryView.slot0(manager, key);
        for (uint256 i; i < 6; i++) {
            vm.warp(block.timestamp + 5 minutes);
            vm.prank(keeper);
            r.poke();
        }
        vm.warp(block.timestamp + 1 minutes); // window starts 4 minutes before the first fresh poke
        int256 expected = (int256(old) * 4 + int256(moved) * 26) / 30;
        assertEq(int256(r.twapTick()), expected);
    }

    function test_swapHookPools_areRefused() public {
        TidewellRouter.Config memory cfg = cadenceConfig();
        cfg.key.hooks = IHooks(address(uint160(1 << 7))); // BEFORE_SWAP
        vm.expectRevert(TidewellRouter.UnsupportedPool.selector);
        factory.createRouter(cfg, keeper);
        cfg.key.hooks = IHooks(address(uint160(1 << 6))); // AFTER_SWAP
        vm.expectRevert(TidewellRouter.UnsupportedPool.selector);
        factory.createRouter(cfg, keeper);
    }

    // ------------------------------------------------------------- milestones

    /// §3.5: milestones out of order revert at config time, not at route time.
    function test_milestones_outOfOrderRevertAtConfig() public {
        uint256[] memory ms = new uint256[](3);
        ms[0] = 1e30;
        ms[1] = 3e30;
        ms[2] = 2e30;
        TidewellRouter.Config memory cfg = milestoneConfig(ms);
        vm.prank(team);
        vm.expectRevert(abi.encodeWithSelector(TidewellRouter.MilestonesNotAscending.selector, 2));
        factory.createRouter(cfg, keeper);

        ms[2] = 3e30; // equal is not ascending either
        vm.prank(team);
        vm.expectRevert(abi.encodeWithSelector(TidewellRouter.MilestonesNotAscending.selector, 2));
        factory.createRouter(milestoneConfig(ms), keeper);
    }

    /// §3.5: a milestone fires at most once.
    function test_milestone_firesAtMostOnce() public {
        // Rough FDV now: supply × 0.001 WETH.
        uint256 fdvNow = token.totalSupply() / 1000;
        uint256[] memory ms = new uint256[](2);
        ms[0] = fdvNow / 2; // already passed
        ms[1] = fdvNow * 100; // far away
        TidewellRouter r = deploy(milestoneConfig(ms));
        payFees(r, 1 ether);
        buildTwap(r);
        assertApproxEqRel(r.fdvWeth(), fdvNow, 0.01e18);

        vm.expectEmit(false, false, false, false, address(r));
        emit TidewellRouter.MilestoneFired(0, 0);
        route(r);
        assertEq(r.nextMilestone(), 1);

        payFees(r, 1 ether);
        vm.warp(block.timestamp + 1 days);
        buildTwap(r);
        vm.prank(keeper);
        vm.expectPartialRevert(TidewellRouter.NoMilestoneReached.selector);
        r.route(block.timestamp);
        assertEq(r.nextMilestone(), 1);
    }

    // ------------------------------------------------------------------ pause

    function test_pause_stopsRoutes_withdrawOnlyWhilePaused() public {
        TidewellRouter r = deploy(cadenceConfig());
        payFees(r, 2 ether);
        buildTwap(r);

        vm.prank(team);
        vm.expectRevert(TidewellRouter.NotPaused.selector);
        r.withdrawUnrouted(team);

        vm.prank(team);
        r.pause();
        vm.prank(keeper);
        vm.expectRevert(TidewellRouter.IsPaused.selector);
        r.route(block.timestamp);

        vm.prank(keeper);
        vm.expectRevert(TidewellRouter.NotOwner.selector);
        r.withdrawUnrouted(keeper);

        vm.prank(team);
        r.withdrawUnrouted(team);
        assertEq(weth.balanceOf(team), 2 ether);
    }

    // ----------------------------------------------------------- construction

    function test_constructor_rejectsBadConfigs() public {
        TidewellRouter.Config memory cfg = cadenceConfig();

        cfg.maxSlippageBps = 0;
        vm.expectRevert(TidewellRouter.BadConfig.selector);
        factory.createRouter(cfg, keeper);

        cfg = cadenceConfig();
        cfg.maxSlippageBps = 1001;
        vm.expectRevert(TidewellRouter.BadConfig.selector);
        factory.createRouter(cfg, keeper);

        cfg = cadenceConfig();
        cfg.cadenceSeconds = 30 minutes;
        vm.expectRevert(TidewellRouter.BadConfig.selector);
        factory.createRouter(cfg, keeper);

        cfg = cadenceConfig();
        cfg.tickLower = 1; // not a multiple of the spacing
        vm.expectRevert(TidewellRouter.BadRange.selector);
        factory.createRouter(cfg, keeper);

        // No ETH side.
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        (address x, address y) =
            address(other) < address(token) ? (address(other), address(token)) : (address(token), address(other));
        cfg = cadenceConfig();
        cfg.key = PoolKey(Currency.wrap(x), Currency.wrap(y), FEE, SPACING, IHooks(address(0)));
        vm.expectRevert(TidewellRouter.UnsupportedPool.selector);
        factory.createRouter(cfg, keeper);

        // A hook allowed to rewrite liquidity deltas.
        cfg = cadenceConfig();
        cfg.key.hooks = IHooks(address(uint160(0x2)));
        vm.expectRevert(TidewellRouter.UnsupportedPool.selector);
        factory.createRouter(cfg, keeper);
    }
}

/// @notice The WETH-pool branches (token as currency0 and as currency1): FDV
///         and a route, in both orders. Ported from the pre-audit review,
///         which found the suite only exercised native-ETH pools.
contract TidewellRouterWethTest is Fixture {
    function _run(bool tokenFirst) internal {
        deployCore();
        while ((address(token) < address(weth)) != tokenFirst) token = new MockERC20("Token", "TKN", 18);
        token.mint(address(this), 1e36);
        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(lpRouter), type(uint256).max);
        PoolKey memory key = wethKey();
        initPool(key);
        seedLiquidity(key, 1e22);
        TidewellRouterFactory f = new TidewellRouterFactory(manager, IWETH9(address(weth)));
        TidewellRouter.Config memory c;
        c.key = key;
        c.tickLower = TickMath.minUsableTick(SPACING);
        c.tickUpper = TickMath.maxUsableTick(SPACING);
        c.mode = TidewellRouter.Mode.Cadence;
        c.cadenceSeconds = 1 days;
        c.maxSlippageBps = 300;
        c.maxTwapDeviationTicks = 200;
        c.minRouteWeth = 0.01 ether;
        TidewellRouter r = f.createRouter(c, keeper);
        assertEq(r.tokenIs0(), tokenFirst);

        (bool ok,) = address(r).call{value: 10 ether}("");
        require(ok);
        for (uint256 i; i < 7; i++) {
            vm.warp(block.timestamp + 5 minutes);
            vm.prank(keeper);
            r.poke();
        }
        assertApproxEqRel(r.fdvWeth(), token.totalSupply() / 1000, 0.01e18, "fdv ~ supply x 0.001 WETH");
        vm.prank(keeper);
        assertGt(r.route(block.timestamp), 0);
        assertLt(r.unroutedWeth(), 0.5 ether);
    }

    function test_wethPool_tokenIsCurrency0() public {
        _run(true);
    }

    function test_wethPool_tokenIsCurrency1() public {
        _run(false);
    }
}
