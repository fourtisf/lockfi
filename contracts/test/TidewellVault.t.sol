// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint128} from "v4-core/libraries/FixedPoint128.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {TidewellVault} from "../src/TidewellVault.sol";
import {Fixture} from "./utils/Fixture.sol";

/// @dev A token whose issuer can freeze an address, as USDG's can.
contract FreezableToken is MockERC20 {
    mapping(address => bool) public frozen;

    constructor() MockERC20("Frozen", "FRZ", 18) {}

    function freeze(address a) external {
        frozen[a] = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!frozen[msg.sender] && !frozen[to], "frozen");
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(!frozen[from] && !frozen[to], "frozen");
        return super.transferFrom(from, to, amount);
    }
}

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
        fund(alice, address(vault), 10_000 ether, 1e30);
        fund(bob, address(vault), 10_000 ether, 1e30);
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

    function claimAll(address who) internal returns (uint256 a0, uint256 a1) {
        vm.prank(who);
        (a0, a1) = vault.claim(who);
    }

    /// @dev What the vault's position has earned and not yet collected, from
    ///      the PoolManager's own fee growth.
    function uncollected() internal view returns (uint256 f0, uint256 f1) {
        IPoolManager pm = IPoolManager(address(manager));
        (uint128 liq, uint256 last0, uint256 last1) = StateLibrary.getPositionInfo(
            pm, vault.poolId(), address(vault), vault.tickLower(), vault.tickUpper(), bytes32(0)
        );
        (uint256 now0, uint256 now1) =
            StateLibrary.getFeeGrowthInside(pm, vault.poolId(), vault.tickLower(), vault.tickUpper());
        f0 = FullMath.mulDiv(now0 - last0, liq, FixedPoint128.Q128);
        f1 = FullMath.mulDiv(now1 - last1, liq, FixedPoint128.Q128);
    }

    function claimsHeld(Currency c) internal view returns (uint256) {
        return manager.balanceOf(address(vault), c.toId());
    }

    // ----------------------------------------------------------- construction

    function test_constructor_rejectsHookedPools_andBoundsTheFee() public {
        PoolKey memory hooked = key;
        hooked.hooks = IHooks(address(0x1234));
        vm.expectRevert(TidewellVault.UnsupportedPool.selector);
        new TidewellVault(manager, hooked, owner, treasury, 2000, 1000);

        vm.expectRevert(TidewellVault.CapAboveMaximum.selector);
        new TidewellVault(manager, key, owner, treasury, 2001, 1000);
        vm.expectRevert(TidewellVault.FeeAboveCap.selector);
        new TidewellVault(manager, key, owner, treasury, 1000, 1001);

        PoolKey memory fresh = key;
        fresh.fee = 500;
        fresh.tickSpacing = 10;
        vm.expectRevert(TidewellVault.PoolNotInitialized.selector);
        new TidewellVault(manager, fresh, owner, treasury, 2000, 1000);
    }

    // ---------------------------------------------------------------- deposit

    function test_deposit_sharesAreLiquidity_andUnusedEthIsRefunded() public {
        uint256 ethBefore = alice.balance;
        uint256 tknBefore = token.balanceOf(alice);
        vm.prank(alice);
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

    function test_deposit_guards() public {
        vm.startPrank(alice);
        vm.expectRevert(TidewellVault.WrongValue.selector);
        vault.deposit{value: 1 ether}(2 ether, 2000 ether, 0, 0, alice, block.timestamp);
        vm.expectRevert(TidewellVault.Expired.selector);
        vault.deposit{value: 1 ether}(1 ether, 2000 ether, 0, 0, alice, block.timestamp - 1);
        vm.expectRevert(TidewellVault.Slippage.selector);
        vault.deposit{value: 1 ether}(1 ether, 2000 ether, 1 ether, 1999 ether, alice, block.timestamp);
        vm.stopPrank();
    }

    function test_deposit_forSomeoneElse_creditsThemNotThePayer() public {
        vm.prank(alice);
        (uint128 l,,) = vault.deposit{value: 1 ether}(1 ether, 2000 ether, 0, 0, bob, block.timestamp);
        assertEq(vault.balanceOf(bob), l);
        assertEq(vault.balanceOf(alice), 0);
    }

    // ------------------------------------------- fees belong to who earned them

    /// The review's sniping scenario: Alice alone earns every fee; Bob deposits
    /// nine times her stake just before anyone collects. Bob gets none of it.
    function test_fees_cannotBeSnipedByALateLargeDeposit() public {
        stake(alice, 10 ether);
        churn(10);
        (uint256 f0, uint256 f1) = uncollected();
        stake(bob, 90 ether); // collects first, credited to Alice's shares only

        (uint256 b0, uint256 b1) = claimAll(bob);
        assertEq(b0 + b1, 0, "Bob earned nothing he can claim");
        (uint256 a0, uint256 a1) = claimAll(alice);
        // Alice gets everything her stake earned, less the 10% protocol fee.
        assertApproxEqAbs(a0, f0 - f0 / 10, 2);
        assertApproxEqAbs(a1, f1 - f1 / 10, 2);
    }

    /// The review's forfeiture scenario: leaving does not lose what you earned.
    function test_fees_surviveWithdrawingEverything() public {
        stake(alice, 10 ether);
        stake(bob, 10 ether);
        churn(10);
        vm.prank(alice);
        (,, uint256 fa0, uint256 fa1) = vault.exit(0, 0, alice, block.timestamp);
        assertGt(fa0, 0);
        assertGt(fa1, 0);

        // A month later Bob's half is still there for him, and equal to hers.
        vm.warp(block.timestamp + 30 days);
        (uint256 b0, uint256 b1) = claimAll(bob);
        assertApproxEqAbs(b0, fa0, 1);
        assertApproxEqAbs(b1, fa1, 1);
    }

    function test_fees_splitByShareAndTime() public {
        uint128 sa = stake(alice, 10 ether);
        churn(5); // Alice alone
        (uint256 alone0, uint256 alone1) = uncollected();
        uint128 sb = stake(bob, 10 ether);
        churn(5);
        (uint256 a0, uint256 a1) = claimAll(alice);
        (uint256 b0, uint256 b1) = claimAll(bob);
        // Alice: everything the vault earned while she was alone (less 10%),
        // plus Bob's share of what came after scaled by her shares to his.
        assertApproxEqAbs(a0, alone0 - alone0 / 10 + b0 * sa / sb, 3);
        assertApproxEqAbs(a1, alone1 - alone1 / 10 + b1 * sa / sb, 3);
    }

    /// §3.5, restated for per-share fees: claiming every hour pays exactly
    /// what never claiming pays.
    function test_claimingEveryHour_paysExactlyWhatNeverClaimingPays() public {
        stake(alice, 10 ether);
        stake(bob, 10 ether);
        uint256 bob0;
        uint256 bob1;
        for (uint256 h; h < 72; h++) {
            vm.warp(block.timestamp + 1 hours);
            churn(1);
            (uint256 c0, uint256 c1) = claimAll(bob);
            bob0 += c0;
            bob1 += c1;
        }
        (uint256 a0, uint256 a1) = claimAll(alice);
        (uint256 d0, uint256 d1) = claimAll(bob);
        bob0 += d0;
        bob1 += d1;
        assertGt(a0, 0);
        assertEq(a0, bob0);
        assertEq(a1, bob1);
    }

    /// The protocol's share is exactly 10% of what was collected.
    function test_protocolFee_isTenPercentOfFees_paidToTheTreasury() public {
        stake(alice, 10 ether);
        churn(10);
        (uint256 f0, uint256 f1) = uncollected();
        vault.poke();
        assertEq(vault.protocolOwed0(), f0 * 1000 / 10_000);
        assertEq(vault.protocolOwed1(), f1 * 1000 / 10_000);

        uint256 eth = treasury.balance;
        (uint256 p0, uint256 p1) = vault.payProtocolFees();
        assertEq(treasury.balance - eth, p0);
        assertEq(token.balanceOf(treasury), p1);
        assertEq(vault.protocolOwed0() + vault.protocolOwed1(), 0);
    }

    function test_claimable_matchesWhatClaimPays() public {
        stake(alice, 10 ether);
        churn(7);
        (uint256 v0, uint256 v1) = vault.claimable(alice);
        (uint256 a0, uint256 a1) = claimAll(alice);
        assertApproxEqAbs(a0, v0, 1);
        assertApproxEqAbs(a1, v1, 1);
        (uint256 again0, uint256 again1) = claimAll(alice);
        assertEq(again0 + again1, 0);
    }

    /// §9's P3 criterion needs no keeper now: after 48 hours in which nobody
    /// touched the vault, one claim collects exactly what the position earned
    /// in that window (the staker's 90%), measured from the PoolManager.
    function test_48hUntouched_oneClaimCollectsExactlyWhatAccrued() public {
        stake(alice, 10 ether);
        churn(2);
        claimAll(alice);
        for (uint256 h; h < 48; h++) {
            vm.warp(block.timestamp + 1 hours);
            churn(1);
        }
        (uint256 f0, uint256 f1) = uncollected();
        (uint256 a0, uint256 a1) = claimAll(alice);
        assertApproxEqAbs(a0, f0 - f0 * 1000 / 10_000, 1);
        assertApproxEqAbs(a1, f1 - f1 * 1000 / 10_000, 1);
        (uint256 again0, uint256 again1) = claimAll(alice);
        assertEq(again0 + again1, 0, "no double payment");
    }

    // --------------------------------------------------------------- withdraw

    function test_withdraw_returnsPrincipal_andIsAlwaysAvailable() public {
        uint128 shares = stake(alice, 5 ether);
        vm.prank(owner);
        vault.setDepositsOpen(false);
        vm.prank(bob);
        vm.expectRevert(TidewellVault.DepositsClosed.selector);
        vault.deposit{value: 1 ether}(1 ether, 2000 ether, 0, 0, bob, block.timestamp);

        vm.prank(alice);
        (uint256 out0,) = vault.withdraw(shares, 0, 0, alice, block.timestamp);
        assertApproxEqAbs(out0, 5 ether, 2);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.positionLiquidity(), 0);
    }

    function test_withdraw_cannotTakeMoreThanYourShares() public {
        uint128 shares = stake(alice, 5 ether);
        stake(bob, 5 ether);
        vm.prank(alice);
        vm.expectRevert(TidewellVault.InsufficientShares.selector);
        vault.withdraw(shares + 1, 0, 0, alice, block.timestamp);
    }

    function test_withdraw_principalExcludesFees() public {
        stake(alice, 10 ether);
        churn(5);
        uint128 bobShares = stake(bob, 10 ether);
        vm.prank(bob);
        (uint256 out0,) = vault.withdraw(bobShares, 0, 0, bob, block.timestamp);
        assertApproxEqAbs(out0, 10 ether, 2);
    }

    /// Review finding 4: a token issuer freezing the vault's address must not
    /// block withdrawals or claims. The vault never holds the tokens.
    function test_frozenVaultAddress_doesNotBlockWithdrawOrClaim() public {
        FreezableToken frz = new FreezableToken();
        frz.mint(address(this), 1e36);
        frz.approve(address(swapRouter), type(uint256).max);
        frz.approve(address(lpRouter), type(uint256).max);
        PoolKey memory k =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(frz)), FEE, SPACING, IHooks(address(0)));
        manager.initialize(k, startPrice(k));
        seedLiquidity(k, 1e21);
        TidewellVault v = new TidewellVault(manager, k, owner, treasury, 2000, 1000);
        frz.mint(alice, 1e30);
        vm.prank(alice);
        frz.approve(address(v), type(uint256).max);
        vm.prank(alice);
        (uint128 s,,) = v.deposit{value: 10 ether}(10 ether, 11_000 ether, 0, 0, alice, block.timestamp);
        for (uint256 i; i < 5; i++) {
            trade(k, true, 5 ether);
            trade(k, false, 5000 ether);
        }
        frz.freeze(address(v));

        vm.prank(alice);
        (uint256 out0, uint256 out1) = v.withdraw(s, 0, 0, alice, block.timestamp);
        assertGt(out0, 0);
        assertGt(out1, 0);
        vm.prank(alice);
        (uint256 c0, uint256 c1) = v.claim(alice);
        assertGt(c0, 0);
        assertGt(c1, 0);
    }

    // ------------------------------------------------------------------ owner

    function test_protocolFee_canNeverExceedTheCap_andAppliesFromNowOn() public {
        stake(alice, 10 ether);
        churn(5);
        (uint256 f0,) = uncollected();
        vm.startPrank(owner);
        vm.expectRevert(TidewellVault.FeeAboveCap.selector);
        vault.setProtocolFee(2001);
        vault.setProtocolFee(2000); // collects first: fees so far cut at 10%
        vm.stopPrank();
        assertEq(vault.protocolOwed0(), f0 * 1000 / 10_000);

        TidewellVault capped = new TidewellVault(manager, key, owner, treasury, 1500, 1000);
        vm.prank(owner);
        vm.expectRevert(TidewellVault.FeeAboveCap.selector);
        capped.setProtocolFee(1600);
    }

    function test_owner_onlyOwner_twoStepTransfer() public {
        vm.prank(alice);
        vm.expectRevert(TidewellVault.NotOwner.selector);
        vault.setTreasury(alice);
        vm.prank(alice);
        vm.expectRevert(TidewellVault.NotOwner.selector);
        vault.setDepositsOpen(false);

        vm.prank(owner);
        vault.transferOwnership(alice);
        vm.prank(bob);
        vm.expectRevert(TidewellVault.NotOwner.selector);
        vault.acceptOwnership();
        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
    }

    function test_receive_rejectsStrayEth() public {
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_claimsHeld_coverEverythingOwed() public {
        stake(alice, 10 ether);
        stake(bob, 3 ether);
        churn(6);
        vault.poke();
        (uint256 a0, uint256 a1) = vault.owed(alice);
        (uint256 b0, uint256 b1) = vault.owed(bob);
        assertGe(claimsHeld(key.currency0), a0 + b0 + vault.protocolOwed0());
        assertGe(claimsHeld(key.currency1), a1 + b1 + vault.protocolOwed1());
    }
}

/// @notice The same vault on a WETH pool, WETH on either side.
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
        (uint256 d0, uint256 d1) =
            ethIs0 ? (uint256(10 ether), uint256(11_000 ether)) : (uint256(11_000 ether), uint256(10 ether));
        vm.prank(alice);
        (uint128 shares,,) = vault.deposit(d0, d1, 0, 0, alice, block.timestamp);
        assertEq(vault.positionLiquidity(), shares);
        for (uint256 i; i < 5; i++) {
            trade(key, ethIs0, 5 ether);
            trade(key, !ethIs0, 5000 ether);
        }
        vm.prank(alice);
        (,, uint256 f0, uint256 f1) = vault.exit(0, 0, alice, block.timestamp);
        assertGt(f0, 0);
        assertGt(f1, 0);
        assertEq(vault.totalSupply(), 0);
    }

    function test_wethPool() public {
        deployCore();
        _run(wethKey());
    }

    function test_wethPool_otherOrder() public {
        deployCore();
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
