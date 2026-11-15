// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IWETH9} from "../src/interfaces/IWETH9.sol";
import {TidewellVault} from "../src/TidewellVault.sol";
import {Fixture} from "./utils/Fixture.sol";

contract TidewellVaultTest is Fixture {
    PoolKey internal key;
    TidewellVault internal vault;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        deployCore();
        key = nativeKey();
        initPool(key);
        seedLiquidity(key, 1e21);
        vault = newVault(key);
        fund(alice, address(vault), 1000 ether, 1e27);
        fund(bob, address(vault), 1000 ether, 1e27);
    }

    // ---------------------------------------------------------------- helpers

    function stake(address who, uint256 eth) internal returns (uint128 liquidity) {
        vm.prank(who);
        (liquidity,,) = vault.deposit{value: eth}(eth, eth * 1100, 0, 0, who, block.timestamp);
    }

    /// @dev Trading in both directions, so fees accrue on both sides.
    function churn(uint256 rounds) internal {
        for (uint256 i; i < rounds; i++) {
            trade(key, true, 5 ether); // ETH -> TKN
            trade(key, false, 5000 ether); // TKN -> ETH
        }
    }

    function harvest() internal returns (uint256 reward, uint256 cut) {
        vm.prank(keeper);
        (reward, cut) = vault.harvest(0, block.timestamp);
    }

    // ----------------------------------------------------------- construction

    function test_constructor_rejectsUnsupportedPools() public {
        PoolKey memory hooked = key;
        hooked.hooks = IHooks(address(0x1234));
        vm.expectRevert(TidewellVault.UnsupportedPool.selector);
        new TidewellVault(manager, IWETH9(address(weth)), hooked, owner, keeper, treasury, 2000, 1000);

        // ETH/WETH: both sides are ETH.
        (address a, address b) = (address(0), address(weth));
        PoolKey memory ethWeth = PoolKey(Currency.wrap(a), Currency.wrap(b), FEE, SPACING, IHooks(address(0)));
        manager.initialize(ethWeth, 79228162514264337593543950336);
        vm.expectRevert(TidewellVault.UnsupportedPool.selector);
        new TidewellVault(manager, IWETH9(address(weth)), ethWeth, owner, keeper, treasury, 2000, 1000);

        // Two tokens, no ETH side: rewards could not be paid in WETH.
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        (address x, address y) =
            address(other) < address(token) ? (address(other), address(token)) : (address(token), address(other));
        PoolKey memory noEth = PoolKey(Currency.wrap(x), Currency.wrap(y), FEE, SPACING, IHooks(address(0)));
        manager.initialize(noEth, 79228162514264337593543950336);
        vm.expectRevert(TidewellVault.UnsupportedPool.selector);
        new TidewellVault(manager, IWETH9(address(weth)), noEth, owner, keeper, treasury, 2000, 1000);
    }

    function test_constructor_capIsBoundedAndFeeUnderCap() public {
        vm.expectRevert(TidewellVault.CapAboveMaximum.selector);
        new TidewellVault(manager, IWETH9(address(weth)), key, owner, keeper, treasury, 2001, 1000);
        vm.expectRevert(TidewellVault.FeeAboveCap.selector);
        new TidewellVault(manager, IWETH9(address(weth)), key, owner, keeper, treasury, 1000, 1001);
    }

    function test_constructor_requiresInitializedPool() public {
        PoolKey memory fresh = key;
        fresh.fee = 500;
        fresh.tickSpacing = 10;
        vm.expectRevert(TidewellVault.PoolNotInitialized.selector);
        new TidewellVault(manager, IWETH9(address(weth)), fresh, owner, keeper, treasury, 2000, 1000);
    }

    // ---------------------------------------------------------------- deposit

    function test_deposit_sharesAreLiquidity_andUnusedEthIsRefunded() public {
        uint256 ethBefore = alice.balance;
        uint256 tknBefore = token.balanceOf(alice);
        vm.prank(alice);
        // Ask for more ETH than 1,000 TKN can pair with: the excess comes back.
        (uint128 liquidity, uint256 used0, uint256 used1) =
            vault.deposit{value: 3 ether}(3 ether, 1000 ether, 0, 0, alice, block.timestamp);

        assertGt(liquidity, 0);
        assertEq(vault.balanceOf(alice), liquidity);
        assertEq(vault.totalSupply(), liquidity);
        assertEq(vault.positionLiquidity(), liquidity);
        assertLt(used0, 3 ether);
        assertEq(alice.balance, ethBefore - used0);
        assertEq(token.balanceOf(alice), tknBefore - used1);
        assertEq(address(vault).balance, 0);
    }

    function test_deposit_wrongValueAndExpiredDeadlineRevert() public {
        vm.prank(alice);
        vm.expectRevert(TidewellVault.WrongValue.selector);
        vault.deposit{value: 1 ether}(2 ether, 2000 ether, 0, 0, alice, block.timestamp);

        vm.prank(alice);
        vm.expectRevert(TidewellVault.Expired.selector);
        vault.deposit{value: 1 ether}(1 ether, 2000 ether, 0, 0, alice, block.timestamp - 1);
    }

    function test_deposit_slippageMinimumsRevert() public {
        vm.prank(alice);
        vm.expectRevert(TidewellVault.Slippage.selector);
        vault.deposit{value: 1 ether}(1 ether, 2000 ether, 1 ether, 1999 ether, alice, block.timestamp);
    }

    function test_deposit_feesEarnedBeforeYouJoinAreNotYours() public {
        stake(alice, 10 ether);
        churn(5);
        // Bob's deposit touches the position, which collects every fee it has
        // earned. Those are held for the next harvest, not handed to Bob.
        uint128 bobShares = stake(bob, 10 ether);
        assertGt(vault.pendingEthFees() + vault.pendingTokenFees(), 0);

        uint256 ethBefore = bob.balance;
        uint256 tknBefore = token.balanceOf(bob);
        vm.prank(bob);
        (uint256 out0, uint256 out1) = vault.withdraw(bobShares, 0, 0, bob, block.timestamp);
        // Principal only: what he put in, less rounding in the pool's favour.
        assertApproxEqAbs(out0, 10 ether, 2);
        assertEq(bob.balance, ethBefore + out0);
        assertEq(token.balanceOf(bob), tknBefore + out1);
    }

    // --------------------------------------------------------------- withdraw

    function test_withdraw_worksWithNoRewardsEverAndNoWeth() public {
        uint128 shares = stake(alice, 5 ether);
        assertEq(vault.rewardRate(), 0);
        assertEq(weth.balanceOf(address(vault)), 0);
        vm.prank(alice);
        (uint256 out0,) = vault.withdraw(shares, 0, 0, alice, block.timestamp);
        assertApproxEqAbs(out0, 5 ether, 2);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.positionLiquidity(), 0);
    }

    function test_withdraw_worksWithDepositsClosed() public {
        uint128 shares = stake(alice, 5 ether);
        vm.prank(owner);
        vault.setDepositsOpen(false);

        vm.prank(bob);
        vm.expectRevert(TidewellVault.DepositsClosed.selector);
        vault.deposit{value: 1 ether}(1 ether, 2000 ether, 0, 0, bob, block.timestamp);

        vm.prank(alice);
        vault.withdraw(shares, 0, 0, alice, block.timestamp);
        assertEq(vault.balanceOf(alice), 0);
    }

    function test_withdraw_cannotTakeMoreThanYourShares() public {
        uint128 shares = stake(alice, 5 ether);
        stake(bob, 5 ether);
        vm.prank(alice);
        vm.expectRevert(TidewellVault.InsufficientShares.selector);
        vault.withdraw(shares + 1, 0, 0, alice, block.timestamp);
    }

    // ---------------------------------------------------------------- harvest

    function test_harvest_tenPercentToTreasury_restStreamsOverSevenDays() public {
        stake(alice, 10 ether);
        churn(10);

        (uint256 reward, uint256 cut) = harvest();
        assertGt(reward, 0);
        // The protocol's share is 10% of the fees, exactly (§3.3, §7).
        assertEq(cut, (reward + cut) * 1000 / 10_000);
        assertEq(weth.balanceOf(treasury), cut);
        assertEq(vault.periodFinish(), block.timestamp + 7 days);

        // Half way: half the stream, give or take rounding.
        vm.warp(block.timestamp + 3.5 days);
        assertApproxEqRel(vault.earned(alice), reward / 2, 1e15);

        // At the end: all of it, less at most dust held back by rounding.
        vm.warp(block.timestamp + 3.5 days);
        uint256 earned = vault.earned(alice);
        assertLe(earned, reward);
        assertApproxEqAbs(earned, reward, 7 days);

        vm.prank(alice);
        uint256 paid = vault.claim(alice);
        assertEq(paid, earned);
        assertEq(weth.balanceOf(alice), paid);
    }

    function test_harvest_onlyTheKeeper() public {
        stake(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(TidewellVault.NotKeeper.selector);
        vault.harvest(0, block.timestamp);
    }

    function test_harvest_minimumFromTokenSaleIsEnforced() public {
        stake(alice, 10 ether);
        churn(5);
        vm.prank(keeper);
        vm.expectRevert(TidewellVault.Slippage.selector);
        vault.harvest(1000 ether, block.timestamp);
    }

    function test_harvest_withNothingStakedOrEarnedIsHarmless() public {
        (uint256 reward, uint256 cut) = harvest();
        assertEq(reward + cut, 0);
    }

    function test_rewards_streamedWhileNobodyIsStakedAreQueuedNotLost() public {
        uint128 shares = stake(alice, 10 ether);
        churn(10);
        (uint256 reward,) = harvest();

        // Alice leaves a day in; six days of stream have nobody to go to.
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        vault.exit(0, 0, alice, block.timestamp);
        uint256 alicePaid = weth.balanceOf(alice);
        vm.warp(block.timestamp + 6 days);

        // Bob arrives and the next harvest folds the queued WETH in.
        stake(bob, 10 ether);
        churn(1);
        (uint256 reward2,) = harvest();
        vm.warp(block.timestamp + 7 days);
        uint256 bobEarned = vault.earned(bob);

        // Everything notified reaches a staker, less rounding dust.
        assertApproxEqAbs(alicePaid + bobEarned, reward + reward2, 2 * 7 days);
        assertGt(bobEarned, reward2);
        shares; // silence
    }

    // ------------------------------------------------------- the §3.5 invariant

    /// @notice A staker who never claims and withdraws at T receives exactly
    ///         the same WETH as one who claimed every hour.
    function test_claimingEveryHour_paysExactlyWhatNeverClaimingPays() public {
        stake(alice, 10 ether);
        stake(bob, 10 ether);
        assertEq(vault.balanceOf(alice), vault.balanceOf(bob));
        churn(10);
        harvest();

        for (uint256 h = 1; h <= 24 * 7; h++) {
            vm.warp(block.timestamp + 1 hours);
            vm.prank(bob);
            vault.claim(bob);
            if (h == 60) {
                churn(3); // a second harvest mid-stream
                harvest();
            }
        }
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        vault.exit(0, 0, alice, block.timestamp);
        vm.prank(bob);
        vault.exit(0, 0, bob, block.timestamp);

        assertGt(weth.balanceOf(alice), 0);
        assertEq(weth.balanceOf(alice), weth.balanceOf(bob));
    }

    // ------------------------------------------------------------------ owner

    function test_protocolFee_canNeverExceedTheCap() public {
        vm.startPrank(owner);
        vault.setProtocolFee(2000);
        vm.expectRevert(TidewellVault.FeeAboveCap.selector);
        vault.setProtocolFee(2001);
        vault.setProtocolFee(0);
        vm.stopPrank();

        TidewellVault capped = new TidewellVault(manager, IWETH9(address(weth)), key, owner, keeper, treasury, 1500, 1000);
        vm.prank(owner);
        vm.expectRevert(TidewellVault.FeeAboveCap.selector);
        capped.setProtocolFee(1600);
    }

    function test_owner_onlyOwnerAndTwoStepTransfer() public {
        vm.prank(alice);
        vm.expectRevert(TidewellVault.NotOwner.selector);
        vault.setKeeper(alice);
        vm.prank(alice);
        vm.expectRevert(TidewellVault.NotOwner.selector);
        vault.setProtocolFee(0);

        vm.prank(owner);
        vault.transferOwnership(alice);
        assertEq(vault.owner(), owner);
        vm.prank(bob);
        vm.expectRevert(TidewellVault.NotOwner.selector);
        vault.acceptOwnership();
        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
    }

    function test_receive_rejectsStrayEth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }
}

/// @notice The same vault on WETH pools, with WETH sorting on either side.
contract TidewellVaultWethTest is Fixture {
    function _run(PoolKey memory key) internal {
        initPool(key);
        seedLiquidity(key, 1e21);
        TidewellVault vault = newVault(key);
        address alice = makeAddr("alice");
        fund(alice, address(vault), 0, 1e27);
        vm.deal(alice, 100 ether);
        vm.prank(alice);
        weth.deposit{value: 100 ether}();

        bool ethIs0 = Currency.unwrap(key.currency0) == address(weth);
        (uint256 d0, uint256 d1) = ethIs0 ? (uint256(10 ether), uint256(11_000 ether)) : (uint256(11_000 ether), uint256(10 ether));
        vm.prank(alice);
        (uint128 shares,,) = vault.deposit(d0, d1, 0, 0, alice, block.timestamp);
        assertEq(vault.positionLiquidity(), shares);

        for (uint256 i; i < 5; i++) {
            trade(key, ethIs0, 5 ether);
            trade(key, !ethIs0, 5000 ether);
        }
        vm.prank(keeper);
        (uint256 reward, uint256 cut) = vault.harvest(0, block.timestamp);
        assertGt(reward, 0);
        assertEq(weth.balanceOf(treasury), cut);

        vm.warp(block.timestamp + 7 days);
        uint256 before = weth.balanceOf(alice);
        vm.prank(alice);
        vault.exit(0, 0, alice, block.timestamp);
        assertGt(weth.balanceOf(alice), before);
        assertEq(vault.totalSupply(), 0);
        // Everything left is reserved dust or nothing.
        assertGe(weth.balanceOf(address(vault)), vault.rewardsReserved());
    }

    function test_wethPool() public {
        deployCore();
        _run(wethKey());
    }

    function test_wethPool_otherOrder() public {
        deployCore();
        // Redeploy the token until it sorts on the other side of WETH.
        bool wethFirst = address(weth) < address(token);
        while ((address(weth) < address(token)) == wethFirst) {
            token = new MockERC20("Token", "TKN", 18);
        }
        token.mint(address(this), 1e36);
        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(lpRouter), type(uint256).max);
        _run(wethKey());
    }
}
