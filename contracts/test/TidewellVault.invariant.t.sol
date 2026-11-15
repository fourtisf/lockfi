// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {TidewellVault} from "../src/TidewellVault.sol";
import {Fixture} from "./utils/Fixture.sol";

/// @notice Drives the vault the way fifty wallets, traders and a keeper would,
///         in random order. CLAUDE.md §9: "random deposit / withdraw / claim
///         orderings across 50 wallets never leave the vault unable to pay
///         sum(earned)".
contract VaultHandler is Fixture {
    TidewellVault public vault;
    PoolKey internal key;
    address[] public actors;

    // Ghost accounting, kept outside the vault so the invariants can check
    // the vault against an independent tally.
    uint256 public ghostNotified;
    uint256 public ghostPaid;
    uint256 public ghostCut;
    uint256 public calls;

    constructor() {
        deployCore();
        key = nativeKey();
        initPool(key);
        seedLiquidity(key, 1e21);
        vault = newVault(key);
        for (uint256 i; i < 50; i++) {
            address a = address(uint160(0x10000 + i));
            actors.push(a);
            fund(a, address(vault), 1e24, 1e30);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 seed, uint256 eth) external {
        calls++;
        address a = _actor(seed);
        eth = bound(eth, 0.001 ether, 50 ether);
        vm.prank(a);
        vault.deposit{value: eth}(eth, eth * 2000, 0, 0, a, block.timestamp);
    }

    function withdraw(uint256 seed, uint256 fraction) external {
        calls++;
        address a = _actor(seed);
        uint256 shares = vault.balanceOf(a);
        if (shares == 0) return;
        uint256 amount = bound(fraction, 1, shares);
        vm.prank(a);
        vault.withdraw(uint128(amount), 0, 0, a, block.timestamp);
    }

    function claim(uint256 seed) external {
        calls++;
        address a = _actor(seed);
        vm.prank(a);
        ghostPaid += vault.claim(a);
    }

    function exit(uint256 seed) external {
        calls++;
        address a = _actor(seed);
        vm.prank(a);
        (,, uint256 reward) = vault.exit(0, 0, a, block.timestamp);
        ghostPaid += reward;
    }

    function swap(bool zeroForOne, uint256 amount) external {
        calls++;
        amount = zeroForOne ? bound(amount, 0.01 ether, 20 ether) : bound(amount, 10 ether, 20_000 ether);
        trade(key, zeroForOne, amount);
    }

    function harvest() external {
        calls++;
        vm.prank(keeper);
        (uint256 reward, uint256 cut) = vault.harvest(0, block.timestamp);
        ghostNotified += reward;
        ghostCut += cut;
    }

    function setFee(uint256 bps) external {
        calls++;
        bps = bound(bps, 0, 5000);
        vm.prank(owner);
        try vault.setProtocolFee(uint16(bps)) {} catch {}
    }

    function warp(uint256 secs) external {
        calls++;
        vm.warp(block.timestamp + bound(secs, 1 minutes, 3 days));
    }

    /// @notice Every staker leaves, in order, and is paid in full.
    function everyoneExits() external returns (uint256 paid) {
        for (uint256 i; i < actors.length; i++) {
            address a = actors[i];
            uint256 owed = vault.earned(a);
            vm.prank(a);
            (,, uint256 reward) = vault.exit(0, 0, a, block.timestamp);
            require(reward == owed, "paid less than earned");
            paid += reward;
        }
    }
}

contract TidewellVaultInvariantTest is Test {
    VaultHandler internal handler;
    TidewellVault internal vault;

    function setUp() public {
        handler = new VaultHandler();
        vault = handler.vault();
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.withdraw.selector;
        selectors[2] = VaultHandler.claim.selector;
        selectors[3] = VaultHandler.exit.selector;
        selectors[4] = VaultHandler.swap.selector;
        selectors[5] = VaultHandler.harvest.selector;
        selectors[6] = VaultHandler.setFee.selector;
        selectors[7] = VaultHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _sumEarned() internal view returns (uint256 sum) {
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; i++) sum += vault.earned(handler.actors(i));
    }

    /// §3.5: sum(balances) == totalSupply, always.
    function invariant_sharesSumToTotalSupply() public view {
        uint256 n = handler.actorCount();
        uint256 sum;
        for (uint256 i; i < n; i++) sum += vault.balanceOf(handler.actors(i));
        assertEq(sum, vault.totalSupply());
    }

    /// The liquidity in the PoolManager is exactly the shares outstanding.
    function invariant_positionIsTotalSupply() public view {
        assertEq(uint256(vault.positionLiquidity()), vault.totalSupply());
    }

    /// §3.5: protocolFeeBps can never exceed the constructor cap.
    function invariant_feeNeverAboveCap() public view {
        assertLe(vault.protocolFeeBps(), vault.protocolFeeCapBps());
        assertLe(vault.protocolFeeCapBps(), 2000);
    }

    /// §9: the vault can always pay sum(earned).
    function invariant_canAlwaysPayEverythingEarned() public view {
        uint256 sumEarned = _sumEarned();
        assertLe(sumEarned, vault.rewardsReserved());
        assertGe(weth().balanceOf(address(vault)), vault.rewardsReserved());
    }

    /// Nothing notified goes missing: it is paid, or still reserved.
    function invariant_rewardAccountingCloses() public view {
        assertEq(handler.ghostNotified(), handler.ghostPaid() + vault.rewardsReserved());
    }

    /// After every run: every staker can leave, and is paid what they earned.
    function afterInvariant() public {
        handler.everyoneExits();
        assertEq(vault.totalSupply(), 0);
        assertEq(uint256(vault.positionLiquidity()), 0);
        assertGe(weth().balanceOf(address(vault)), vault.rewardsReserved());
    }

    function weth() internal view returns (WETHView) {
        return WETHView(address(vault.weth()));
    }
}

interface WETHView {
    function balanceOf(address) external view returns (uint256);
}
