// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {IWETH9} from "../src/interfaces/IWETH9.sol";
import {TidewellVault} from "../src/TidewellVault.sol";
import {TidewellZap} from "../src/TidewellZap.sol";
import {TidewellShaper} from "../src/TidewellShaper.sol";
import {PeripheryBase} from "../src/base/PeripheryBase.sol";
import {Fixture} from "./utils/Fixture.sol";

/// @notice Fuzzing the questions a staker would ask: can anyone take out
///         more than they put in, take fees earned before they arrived, or
///         leave value stuck in the periphery?
contract TidewellFuzzTest is Fixture, DeployPermit2 {
    using StateLibrary for *;
    using PoolIdLibrary for PoolKey;

    PoolKey internal key;
    TidewellVault internal vault;
    TidewellZap internal zap;
    TidewellShaper internal shaper;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        deployCore();
        key = nativeKey();
        initPool(key);
        seedLiquidity(key, 1e22);
        vault = newVault(key);
        IAllowanceTransfer permit2 = IAllowanceTransfer(deployPermit2());
        IPositionManager posm = IPositionManager(
            deployCode(
                "PositionManager.sol:PositionManager",
                abi.encode(address(manager), address(permit2), uint256(100_000), address(0), address(weth))
            )
        );
        zap = new TidewellZap(manager, posm, permit2, IWETH9(address(weth)));
        shaper = new TidewellShaper(manager, posm, permit2, IWETH9(address(weth)));
        fund(alice, address(vault), 10_000 ether, 1e30);
        fund(bob, address(vault), 10_000 ether, 1e30);
    }

    /// Value in ETH at the current price: ETH + TKN / 1000-ish, from the pool.
    function valueOf(uint256 eth, uint256 tkn) internal view returns (uint256) {
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        uint256 priceX96 = uint256(sqrtP) * uint256(sqrtP) >> 96; // TKN per ETH, Q96
        return eth + (tkn << 96) / priceX96;
    }

    struct Leg {
        address who;
        uint256 amount;
        uint128 shares;
        uint256 in0;
        uint256 in1;
    }

    function _in(Leg memory l) internal {
        vm.prank(l.who);
        (l.shares, l.in0, l.in1) = vault.deposit{value: l.amount}(l.amount, l.amount * 1100, 0, 0, l.who, block.timestamp);
    }

    function _outAtMostIn(Leg memory l) internal {
        vm.prank(l.who);
        (uint256 out0, uint256 out1) = vault.withdraw(l.shares, 0, 0, l.who, block.timestamp);
        assertLe(out0, l.in0);
        assertLe(out1, l.in1);
    }

    /// With no trading in between, nobody withdraws more than they deposited.
    function testFuzz_depositThenWithdraw_neverReturnsMore(uint256 a, uint256 b, bool bobFirst) public {
        Leg memory la = Leg(alice, bound(a, 0.001 ether, 500 ether), 0, 0, 0);
        Leg memory lb = Leg(bob, bound(b, 0.001 ether, 500 ether), 0, 0, 0);
        (Leg memory first, Leg memory second) = bobFirst ? (lb, la) : (la, lb);
        _in(first);
        _in(second);
        _outAtMostIn(first);
        _outAtMostIn(second);
        assertEq(vault.totalSupply(), 0);
    }

    /// Someone who arrives after fees accrued and leaves at once gets back
    /// their principal and nothing of the fees that were already earned.
    function testFuzz_lateArrival_cannotTakeEarlierFees(uint256 stakeA, uint256 trades, uint256 stakeB) public {
        stakeA = bound(stakeA, 1 ether, 200 ether);
        stakeB = bound(stakeB, 1 ether, 2000 ether);
        trades = bound(trades, 1, 8);
        vm.prank(alice);
        vault.deposit{value: stakeA}(stakeA, stakeA * 1100, 0, 0, alice, block.timestamp);
        for (uint256 i; i < trades; i++) {
            trade(key, true, 3 ether);
            trade(key, false, 3000 ether);
        }

        uint256 ethBefore = bob.balance;
        uint256 tknBefore = token.balanceOf(bob);
        vm.prank(bob);
        (uint128 s,,) = vault.deposit{value: stakeB}(stakeB, stakeB * 1100, 0, 0, bob, block.timestamp);
        vm.prank(bob);
        vault.withdraw(s, 0, 0, bob, block.timestamp);
        uint256 ethAfter = bob.balance;
        uint256 tknAfter = token.balanceOf(bob);

        // Bob ends with at most what he started with, in each token.
        assertLe(ethAfter, ethBefore);
        assertLe(tknAfter, tknBefore);
        // And the fees stayed with the vault for its stakers.
        assertGt(vault.pendingEthFees() + vault.pendingTokenFees(), 0);
    }

    /// Whatever the amount and however much of it is swapped, the zap ends
    /// holding nothing: shares are minted, or the whole call reverts.
    function testFuzz_zapStake_keepsNothing(uint256 amount, uint256 swapBps) public {
        amount = bound(amount, 0.001 ether, 100 ether);
        swapBps = bound(swapBps, 0, 10_000);
        uint256 swapAmount = amount * swapBps / 10_000;
        vm.deal(alice, amount);
        vm.prank(alice);
        try zap.zapStake{value: amount}(vault, address(0), amount, swapAmount, 1, block.timestamp) returns (uint128 s) {
            assertGt(s, 0);
        } catch {}
        assertEq(address(zap).balance, 0);
        assertEq(token.balanceOf(address(zap)), 0);
        assertEq(weth.balanceOf(address(zap)), 0);
    }

    /// Random shapes: 1-60 bins, random widths and weights normalised to
    /// 10,000. Either every bin is the user's NFT and the shaper is empty, or
    /// the call reverts — never a partial mint, never stuck funds.
    function testFuzz_mintShaped_randomShapes(uint256 seed, uint256 nBins, uint256 amount) public {
        nBins = bound(nBins, 1, 60);
        amount = bound(amount, 1 ether, 50 ether);
        PeripheryBase.Bin[] memory bins = new PeripheryBase.Bin[](nBins);
        uint256[] memory raw = new uint256[](nBins);
        uint256 total;
        for (uint256 i; i < nBins; i++) {
            raw[i] = uint256(keccak256(abi.encode(seed, i))) % 1000 + 1;
            total += raw[i];
        }
        uint256 assigned;
        int24 cursor = 69_060 - int24(int256(nBins)) * 60;
        for (uint256 i; i < nBins; i++) {
            uint256 w = i == nBins - 1 ? 10_000 - assigned : raw[i] * 10_000 / total;
            if (w == 0) w = 1;
            assigned += w;
            int24 width = int24(int256(uint256(keccak256(abi.encode(seed, i, "w"))) % 4 + 1)) * 60;
            bins[i] = PeripheryBase.Bin(cursor, cursor + width, uint128(w));
            cursor += width;
        }
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        vm.deal(alice, amount);
        vm.prank(alice);
        try shaper.mintShaped{value: amount}(key, bins, address(0), amount, amount / 2, sqrtP / 2, sqrtP * 2, block.timestamp)
        returns (uint256) {} catch {}
        assertEq(address(shaper).balance, 0);
        assertEq(token.balanceOf(address(shaper)), 0);
        assertEq(weth.balanceOf(address(shaper)), 0);
    }
}
