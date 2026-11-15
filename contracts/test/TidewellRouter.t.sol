// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IWETH9} from "../src/interfaces/IWETH9.sol";
import {TidewellRouter, TidewellRouterFactory} from "../src/TidewellRouter.sol";
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
