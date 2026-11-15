// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
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

interface IERC721Owner {
    function ownerOf(uint256 id) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
}

contract TidewellPeripheryTest is Fixture, DeployPermit2 {
    using StateLibrary for *;
    using PoolIdLibrary for PoolKey;

    /// ArbOS caps a single transaction at 32M gas, whatever the block header
    /// says (Robinhood Chain reports 2^50 there, as Arbitrum chains do).
    uint256 internal constant TX_GAS_LIMIT = 32_000_000;

    PoolKey internal key;
    IAllowanceTransfer internal permit2;
    IPositionManager internal posm;
    TidewellVault internal vault;
    TidewellZap internal zap;
    TidewellShaper internal shaper;
    address internal user = makeAddr("user");

    function setUp() public {
        deployCore();
        key = nativeKey();
        initPool(key);
        seedLiquidity(key, 1e21);
        vault = newVault(key);

        permit2 = IAllowanceTransfer(deployPermit2());
        posm = IPositionManager(
            deployCode(
                "PositionManager.sol:PositionManager",
                abi.encode(address(manager), address(permit2), uint256(100_000), address(0), address(weth))
            )
        );
        zap = new TidewellZap(manager, posm, permit2, IWETH9(address(weth)));
        shaper = new TidewellShaper(manager, posm, permit2, IWETH9(address(weth)));

        fund(user, address(zap), 1000 ether, 1e27);
        vm.startPrank(user);
        token.approve(address(shaper), type(uint256).max);
        weth.approve(address(shaper), type(uint256).max);
        weth.deposit{value: 100 ether}();
        vm.stopPrank();
    }

    function assertHoldsNothing(address c) internal view {
        assertEq(c.balance, 0, "kept ETH");
        assertEq(token.balanceOf(c), 0, "kept TKN");
        assertEq(weth.balanceOf(c), 0, "kept WETH");
    }

    // -------------------------------------------------------------------- zap

    function test_zapStake_fromEth_stakesAndReturnsTheRest() public {
        uint256 ethBefore = user.balance;
        vm.prank(user);
        uint128 shares = zap.zapStake{value: 10 ether}(vault, address(0), 10 ether, 4.98 ether, 1, block.timestamp);

        assertGt(shares, 0);
        assertEq(vault.balanceOf(user), shares);
        assertHoldsNothing(address(zap));
        // At most the 10 ETH sent, and something came back or was used.
        assertLe(ethBefore - user.balance, 10 ether);
        assertGt(token.balanceOf(user), 1e27 - 1); // leftover TKN returned, none taken
    }

    function test_zapStake_fromWeth_unwrapsForANativePool() public {
        vm.prank(user);
        uint128 shares = zap.zapStake(vault, address(weth), 5 ether, 2.49 ether, 1, block.timestamp);
        assertGt(shares, 0);
        assertHoldsNothing(address(zap));
    }

    function test_zapStake_fromToken() public {
        vm.prank(user);
        uint128 shares = zap.zapStake(vault, address(token), 5000 ether, 2490 ether, 1, block.timestamp);
        assertGt(shares, 0);
        assertHoldsNothing(address(zap));
    }

    /// §3.5: a quote that degrades between build and execution reverts, never
    /// partially fills.
    function test_zapStake_degradedQuoteReverts() public {
        uint256 snap = vm.snapshotState();
        vm.prank(user);
        uint128 quoted = zap.zapStake{value: 10 ether}(vault, address(0), 10 ether, 4.98 ether, 1, block.timestamp);
        vm.revertToState(snap);

        // Someone sells ETH into the pool between the quote and the
        // transaction: ETH buys less TKN, so the same zap mints less.
        trade(key, true, 10 ether);

        uint128 minLiquidity = uint128(uint256(quoted) * 99 / 100);
        vm.prank(user);
        vm.expectPartialRevert(PeripheryBase.InsufficientLiquidity.selector);
        zap.zapStake{value: 10 ether}(vault, address(0), 10 ether, 4.98 ether, minLiquidity, block.timestamp);
        assertEq(vault.balanceOf(user), 0);
    }

    function test_zapStake_wrongValueReverts() public {
        vm.prank(user);
        vm.expectRevert(PeripheryBase.WrongValue.selector);
        zap.zapStake{value: 1 ether}(vault, address(0), 2 ether, 1 ether, 1, block.timestamp);
    }

    function test_zapMint_positionGoesToTheUser() public {
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        vm.prank(user);
        uint256 id = zap.zapMint{value: 10 ether}(
            key, 66_000, 72_000, address(0), 10 ether, 4.9 ether, 1, sqrtP / 2, sqrtP * 2, block.timestamp
        );
        assertEq(IERC721Owner(address(posm)).ownerOf(id), user);
        assertGt(posm.getPositionLiquidity(id), 0);
        assertHoldsNothing(address(zap));
    }

    function test_zapMint_priceOutsideBoundsReverts() public {
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        vm.prank(user);
        vm.expectRevert();
        zap.zapMint{value: 10 ether}(
            key, 66_000, 72_000, address(0), 10 ether, 4.9 ether, 1, sqrtP * 2, sqrtP * 3, block.timestamp
        );
    }

    // ----------------------------------------------------------------- shaper

    function bins3() internal pure returns (PeripheryBase.Bin[] memory b) {
        b = new PeripheryBase.Bin[](3);
        b[0] = PeripheryBase.Bin(68_400, 69_000, 3000); // below the price: TKN
        b[1] = PeripheryBase.Bin(69_000, 69_120, 4000); // around it: both
        b[2] = PeripheryBase.Bin(69_120, 69_780, 3000); // above it: ETH
    }

    function test_mintShaped_everyBinIsAnNftInTheUsersWallet() public {
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        vm.prank(user);
        uint256 first = shaper.mintShaped{value: 10 ether}(
            key, bins3(), address(0), 10 ether, 4 ether, sqrtP / 2, sqrtP * 2, block.timestamp
        );
        for (uint256 i; i < 3; i++) {
            assertEq(IERC721Owner(address(posm)).ownerOf(first + i), user);
            assertGt(posm.getPositionLiquidity(first + i), 0);
        }
        assertEq(IERC721Owner(address(posm)).balanceOf(address(shaper)), 0);
        assertHoldsNothing(address(shaper));
    }

    function test_mintShaped_weightsMustSumTo10000() public {
        PeripheryBase.Bin[] memory b = bins3();
        b[2].weightBps = 2999;
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PeripheryBase.WeightsMustSumTo10000.selector, 9999));
        shaper.mintShaped{value: 10 ether}(key, b, address(0), 10 ether, 4 ether, sqrtP / 2, sqrtP * 2, block.timestamp);
    }

    function test_mintShaped_moreThan60BinsIsRefusedNotTruncated() public {
        PeripheryBase.Bin[] memory b = new PeripheryBase.Bin[](61);
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PeripheryBase.TooManyBins.selector, 61));
        shaper.mintShaped{value: 10 ether}(key, b, address(0), 10 ether, 4 ether, sqrtP / 2, sqrtP * 2, block.timestamp);
    }

    /// §3.5: a 60-bin mint fits under the block gas limit.
    function test_mintShaped_sixtyBinsFitInOneTransaction() public {
        PeripheryBase.Bin[] memory b = new PeripheryBase.Bin[](60);
        int24 start = 69_060 - 30 * 60;
        for (uint256 i; i < 60; i++) {
            int24 lower = start + int24(int256(i)) * 60;
            b[i] = PeripheryBase.Bin(lower, lower + 60, i == 59 ? 206 : 166);
        }
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        vm.prank(user);
        uint256 gasBefore = gasleft();
        uint256 first = shaper.mintShaped{value: 50 ether}(
            key, b, address(0), 50 ether, 25 ether, sqrtP / 2, sqrtP * 2, block.timestamp
        );
        uint256 used = gasBefore - gasleft();
        emit log_named_uint("gas for 60 bins", used);
        assertLt(used, TX_GAS_LIMIT);
        assertEq(IERC721Owner(address(posm)).ownerOf(first + 59), user);
        assertHoldsNothing(address(shaper));
    }

    function test_strayEthIsRefused() public {
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok,) = address(zap).call{value: 1 ether}("");
        assertFalse(ok);
    }
}
