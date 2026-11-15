// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IWETH9} from "../../src/interfaces/IWETH9.sol";
import {TidewellVault} from "../../src/TidewellVault.sol";
import {TidewellZap} from "../../src/TidewellZap.sol";
import {TidewellShaper} from "../../src/TidewellShaper.sol";
import {PeripheryBase} from "../../src/base/PeripheryBase.sol";
import {TidewellRouter, TidewellRouterFactory} from "../../src/TidewellRouter.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IERC721Min {
    function ownerOf(uint256) external view returns (address);
}

/// @notice A dress rehearsal on a fork of Robinhood Chain mainnet: Tidewell's
///         contracts against the real PoolManager, PositionManager, Permit2,
///         WETH and the chain's deepest ETH/USDG pool. Nothing is broadcast.
///         Skipped unless FORK_RPC is set:
///           FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/fork/*
contract RehearsalTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager internal constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPositionManager internal constant POSM = IPositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    IAllowanceTransfer internal constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IWETH9 internal constant WETH = IWETH9(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    PoolKey internal key;
    TidewellVault internal vault;
    TidewellZap internal zap;
    TidewellShaper internal shaper;
    PoolSwapTest internal trader;
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");
    address internal user = makeAddr("user");
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        // Native ETH / USDG, 0.05%: the deepest hookless ETH/USDG pool.
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 500, 10, IHooks(address(0)));
        vault = new TidewellVault(PM, key, address(this), treasury, 2000, 1000);
        zap = new TidewellZap(PM, POSM, PERMIT2, WETH);
        shaper = new TidewellShaper(PM, POSM, PERMIT2, WETH);
        trader = new PoolSwapTest(PM);
        vm.deal(user, 100 ether);
        vm.deal(address(this), 1000 ether);
    }

    /// The trader's ETH comes back here from the pool.
    receive() external payable {}

    function _trade(bool ethIn, uint256 amount) internal {
        if (!ethIn) IERC20Min(USDG).approve(address(trader), type(uint256).max);
        trader.swap{value: ethIn ? amount : 0}(
            key,
            SwapParams({
                zeroForOne: ethIn,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: ethIn ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function test_rehearsal_stakeEarnClaimWithdraw() public {
        if (!forked) return vm.skip(true);

        vm.prank(user);
        uint128 shares = zap.zapStake{value: 1 ether}(vault, address(0), 1 ether, 0.4995 ether, 1, block.timestamp);
        assertGt(shares, 0);
        assertEq(uint256(vault.positionLiquidity()), uint256(shares));

        // Real traffic: ETH -> USDG -> ETH through the real pool.
        for (uint256 i; i < 5; i++) {
            _trade(true, 20 ether);
            _trade(false, IERC20Min(USDG).balanceOf(address(this)));
        }

        // Fees from real trades, owed to the user in both tokens, with the
        // protocol's 10% beside them.
        (uint256 c0, uint256 c1) = vault.claimable(user);
        assertGt(c0, 0, "ETH fees from the real pool");
        assertGt(c1, 0, "USDG fees from the real pool");

        uint256 ethBefore = user.balance;
        vm.prank(user);
        (uint256 out0, uint256 out1, uint256 f0, uint256 f1) = vault.exit(0, 0, user, block.timestamp);
        assertApproxEqAbs(f0, c0, 1);
        assertApproxEqAbs(f1, c1, 1);
        assertGt(out0 + out1, 0);
        assertEq(user.balance - ethBefore, out0 + f0);
        assertEq(IERC20Min(USDG).balanceOf(user), out1 + f1);

        (uint256 p0, uint256 p1) = vault.payProtocolFees();
        assertEq(treasury.balance, p0);
        assertEq(IERC20Min(USDG).balanceOf(treasury), p1);
        assertApproxEqRel(p0 * 9, f0, 0.001e18);
        assertEq(vault.totalSupply(), 0);
    }

    function test_rehearsal_shapedMintThroughTheRealPositionManager() public {
        if (!forked) return vm.skip(true);
        (uint160 sqrtP, int24 tick,,) = PM.getSlot0(key.toId());
        int24 base = (tick / 10) * 10;
        PeripheryBase.Bin[] memory bins = new PeripheryBase.Bin[](5);
        for (uint256 i; i < 5; i++) {
            int24 lower = base + int24(int256(i) - 2) * 100;
            bins[i] = PeripheryBase.Bin(lower, lower + 100, 2000);
        }
        vm.prank(user);
        uint256 first = shaper.mintShaped{value: 1 ether}(
            key, bins, address(0), 1 ether, 0.5 ether, sqrtP * 99 / 100, sqrtP * 101 / 100, block.timestamp
        );
        for (uint256 i; i < 5; i++) {
            assertEq(IERC721Min(address(POSM)).ownerOf(first + i), user);
            assertGt(POSM.getPositionLiquidity(first + i), 0);
        }
        assertEq(address(shaper).balance, 0);
        assertEq(IERC20Min(USDG).balanceOf(address(shaper)), 0);
    }

    function test_rehearsal_routerRoutesFeesIntoPermanentDepth() public {
        if (!forked) return vm.skip(true);
        TidewellRouterFactory factory = new TidewellRouterFactory(PM, WETH);
        TidewellRouter.Config memory cfg;
        cfg.key = key;
        cfg.tickLower = TickMath.minUsableTick(10);
        cfg.tickUpper = TickMath.maxUsableTick(10);
        cfg.mode = TidewellRouter.Mode.Cadence;
        cfg.cadenceSeconds = 1 days;
        cfg.maxSlippageBps = 100;
        cfg.maxTwapDeviationTicks = 100;
        cfg.minRouteWeth = 0.01 ether;
        TidewellRouter r = factory.createRouter(cfg, keeper);

        (bool ok,) = address(r).call{value: 1 ether}("");
        assertTrue(ok);
        for (uint256 i; i < 7; i++) {
            vm.warp(block.timestamp + 5 minutes);
            vm.prank(keeper);
            r.poke();
        }
        vm.prank(keeper);
        uint128 liquidity = r.route(block.timestamp);
        assertGt(liquidity, 0);
        assertEq(r.routedLiquidity(), liquidity);
        assertLt(r.unroutedWeth(), 0.05 ether);
    }
}
