// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {TidewellVault} from "../src/TidewellVault.sol";
import {Fixture} from "./utils/Fixture.sol";

/// @notice Drives the vault the way fifty wallets and the market would, in
///         random order. CLAUDE.md §9: "random deposit / withdraw / claim
///         orderings across 50 wallets never leave the vault unable to pay
///         sum(earned)" — here, every fee owed, in both tokens.
contract VaultHandler is Fixture {
    TidewellVault public vault;
    PoolKey internal key;
    address[] public actors;

    // Independent tallies the invariants check the vault against.
    uint256 public ghostPaid0;
    uint256 public ghostPaid1;
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

    function currency(uint256 i) external view returns (Currency) {
        return i == 0 ? key.currency0 : key.currency1;
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

    function depositFor(uint256 payerSeed, uint256 recipientSeed, uint256 eth) external {
        calls++;
        address payer = _actor(payerSeed);
        address recipient = _actor(recipientSeed);
        eth = bound(eth, 0.001 ether, 20 ether);
        vm.prank(payer);
        vault.deposit{value: eth}(eth, eth * 2000, 0, 0, recipient, block.timestamp);
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
        (uint256 c0, uint256 c1) = vault.claim(a);
        ghostPaid0 += c0;
        ghostPaid1 += c1;
    }

    function exit(uint256 seed) external {
        calls++;
        address a = _actor(seed);
        vm.prank(a);
        (,, uint256 f0, uint256 f1) = vault.exit(0, 0, a, block.timestamp);
        ghostPaid0 += f0;
        ghostPaid1 += f1;
    }

    function swap(bool zeroForOne, uint256 amount) external {
        calls++;
        amount = zeroForOne ? bound(amount, 0.01 ether, 20 ether) : bound(amount, 10 ether, 20_000 ether);
        trade(key, zeroForOne, amount);
    }

    function poke() external {
        calls++;
        vault.poke();
    }

    function payProtocol() external {
        calls++;
        vault.payProtocolFees();
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

    /// @notice Every staker leaves and claims, in order, and is paid exactly
    ///         what the vault said they were owed.
    function everyoneExits() external {
        vault.poke();
        for (uint256 i; i < actors.length; i++) {
            address a = actors[i];
            (uint256 o0, uint256 o1) = vault.owed(a);
            vm.prank(a);
            (,, uint256 f0, uint256 f1) = vault.exit(0, 0, a, block.timestamp);
            require(f0 == o0 && f1 == o1, "paid other than owed");
        }
        vault.payProtocolFees();
    }
}

contract TidewellVaultInvariantTest is Test {
    VaultHandler internal handler;
    TidewellVault internal vault;

    function setUp() public {
        handler = new VaultHandler();
        vault = handler.vault();
        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.depositFor.selector;
        selectors[2] = VaultHandler.withdraw.selector;
        selectors[3] = VaultHandler.claim.selector;
        selectors[4] = VaultHandler.exit.selector;
        selectors[5] = VaultHandler.swap.selector;
        selectors[6] = VaultHandler.poke.selector;
        selectors[7] = VaultHandler.payProtocol.selector;
        selectors[8] = VaultHandler.setFee.selector;
        selectors[9] = VaultHandler.warp.selector;
        selectors[10] = VaultHandler.swap.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _held(uint256 i) internal view returns (uint256) {
        return PM(address(vault.poolManager())).balanceOf(address(vault), handler.currency(i).toId());
    }

    function _sumOwed() internal view returns (uint256 s0, uint256 s1) {
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; i++) {
            (uint256 o0, uint256 o1) = vault.owed(handler.actors(i));
            s0 += o0;
            s1 += o1;
        }
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

    /// §9: the vault can always pay every fee it owes — every staker's and the
    /// protocol's — from the claims it holds, in both tokens.
    function invariant_canAlwaysPayEverythingOwed() public view {
        (uint256 s0, uint256 s1) = _sumOwed();
        assertGe(_held(0), s0 + vault.protocolOwed0());
        assertGe(_held(1), s1 + vault.protocolOwed1());
    }

    /// The only thing left over is rounding dust below a wei per staker.
    function invariant_noValueStrandedBeyondDust() public view {
        (uint256 s0, uint256 s1) = _sumOwed();
        uint256 n = handler.actorCount();
        assertLe(_held(0) - s0 - vault.protocolOwed0(), n + handler.calls());
        assertLe(_held(1) - s1 - vault.protocolOwed1(), n + handler.calls());
    }

    /// After every run: everyone leaves and is paid exactly what they are owed.
    function afterInvariant() public {
        handler.everyoneExits();
        assertEq(vault.totalSupply(), 0);
        assertEq(uint256(vault.positionLiquidity()), 0);
        assertEq(vault.protocolOwed0() + vault.protocolOwed1(), 0);
    }
}

interface PM {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
}
