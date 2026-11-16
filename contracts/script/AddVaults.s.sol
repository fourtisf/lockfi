// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {TidewellVault} from "../src/TidewellVault.sol";

/// @notice Deploys more vaults beside an existing deployment: one per pool in
///         VAULT_POOLS, and nothing else. The zap, shaper and router factory
///         already deployed serve every vault (the zap takes the vault as an
///         argument), so a token gets staking by deploying its vault alone.
///         Writes deployments/<chainId>-added-vaults.json, which
///         scripts/apply-deployment.mjs --add-vaults merges into
///         config/deployments.json.
///
/// The same mainnet gate as Deploy.s.sol: refused on 4663 unless
/// TIDEWELL_AUDIT_REPORT is set or TIDEWELL_UNAUDITED_MAINNET=I_ACCEPT_THE_RISK.
///
/// Environment:
///   OWNER, TREASURY        as the existing vaults (deploy/add-vaults.sh reads them from chain)
///   PROTOCOL_FEE_BPS       default 1000
///   PROTOCOL_FEE_CAP_BPS   default 2000; immutable per vault, never above 2000
///   VAULT_POOLS            "currency0:currency1:fee:tickSpacing,..." (no hooks), at most 10
contract AddVaults is Script {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant ROBINHOOD_MAINNET = 4663;
    address internal constant MAINNET_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external {
        string memory audit = vm.envOr("TIDEWELL_AUDIT_REPORT", string(""));
        bool unauditedAccepted =
            keccak256(bytes(vm.envOr("TIDEWELL_UNAUDITED_MAINNET", string("")))) == keccak256("I_ACCEPT_THE_RISK");
        if (block.chainid == ROBINHOOD_MAINNET && bytes(audit).length == 0 && !unauditedAccepted) {
            revert(
                "Refused: mainnet needs TIDEWELL_AUDIT_REPORT, or TIDEWELL_UNAUDITED_MAINNET=I_ACCEPT_THE_RISK (CLAUDE.md section 8 P5, section 20)."
            );
        }

        IPoolManager poolManager = IPoolManager(vm.envOr("POOL_MANAGER", MAINNET_POOL_MANAGER));
        require(address(poolManager).code.length > 0, "POOL_MANAGER has no code on this chain");

        PoolKey[] memory pools = _pools(vm.envString("VAULT_POOLS"));
        require(pools.length > 0, "VAULT_POOLS is empty");
        require(pools.length <= 10, "VAULT_POOLS: at most 10 vaults at a time");

        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");
        uint16 feeBps = uint16(vm.envOr("PROTOCOL_FEE_BPS", uint256(1000)));
        uint16 capBps = uint16(vm.envOr("PROTOCOL_FEE_CAP_BPS", uint256(2000)));

        address[] memory vaults = new address[](pools.length);
        vm.startBroadcast();
        for (uint256 i; i < pools.length; i++) {
            vaults[i] = address(new TidewellVault(poolManager, pools[i], owner, treasury, capBps, feeBps));
        }
        vm.stopBroadcast();

        _write(vaults, pools, audit, bytes(audit).length == 0 && unauditedAccepted);
    }

    /// @dev deployments/<chainId>-added-vaults.json
    function _write(address[] memory vaults, PoolKey[] memory pools, string memory audit, bool unaudited) internal {
        string memory obj = "added";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeBool(obj, "audited", bytes(audit).length > 0);
        vm.serializeString(obj, "auditReport", audit);
        vm.serializeBool(obj, "unauditedAccepted", unaudited);
        string[] memory entries = new string[](vaults.length);
        for (uint256 i; i < vaults.length; i++) {
            string memory v = string.concat("vault", vm.toString(i));
            vm.serializeAddress(v, "address", vaults[i]);
            // The L1 block on an Arbitrum chain; deploy/add-vaults.sh replaces
            // it with the receipt's own, as contracts.sh does.
            vm.serializeUint(v, "deployedBlock", block.number);
            entries[i] = vm.serializeString(v, "poolId", string.concat("v4:", vm.toString(PoolId.unwrap(pools[i].toId()))));
        }
        string memory json = vm.serializeString(obj, "vaults", entries);
        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            console2.log("dry run: nothing written. Add --broadcast to deploy.");
            console2.log(json);
            return;
        }
        string memory path =
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), "-added-vaults.json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }

    /// @dev "c0:c1:fee:spacing,c0:c1:fee:spacing" — hookless pools only;
    ///      the vault constructor refuses anything else anyway.
    function _pools(string memory spec) internal pure returns (PoolKey[] memory keys) {
        if (bytes(spec).length == 0) return new PoolKey[](0);
        string[] memory items = vm.split(spec, ",");
        keys = new PoolKey[](items.length);
        for (uint256 i; i < items.length; i++) {
            string[] memory f = vm.split(items[i], ":");
            require(f.length == 4, "VAULT_POOLS: currency0:currency1:fee:tickSpacing");
            keys[i] = PoolKey({
                currency0: Currency.wrap(vm.parseAddress(f[0])),
                currency1: Currency.wrap(vm.parseAddress(f[1])),
                fee: uint24(vm.parseUint(f[2])),
                tickSpacing: int24(vm.parseInt(f[3])),
                hooks: IHooks(address(0))
            });
        }
    }
}
