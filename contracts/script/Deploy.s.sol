// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IWETH9} from "../src/interfaces/IWETH9.sol";
import {TidewellVault} from "../src/TidewellVault.sol";
import {TidewellZap} from "../src/TidewellZap.sol";
import {TidewellShaper} from "../src/TidewellShaper.sol";
import {TidewellRouterFactory} from "../src/TidewellRouter.sol";

/// @notice Deploys Tidewell: the zap, the shaper, the router factory, and one
///         vault per pool in VAULT_POOLS. Writes deployments/<chainId>.json,
///         which scripts/apply-deployment.mjs merges into
///         config/deployments.json for the site, indexer and keeper.
///
/// Robinhood Chain mainnet (4663) is refused unless TIDEWELL_AUDIT_REPORT
/// names the external audit of exactly this code (CLAUDE.md §8, P5: "No
/// mainnet deployment of the vault before an external audit"). A rehearsal
/// on a fork runs anvil with --chain-id 31337, so the gate never needs an
/// override switch that could be flipped for the real thing.
///
/// Environment:
///   OWNER                  vaults' owner: sets keeper, treasury, fee (<= cap)
///   KEEPER                 harvest / route trigger (a hot wallet with gas only)
///   TREASURY               receives the protocol fee
///   PROTOCOL_FEE_BPS       default 1000 (10% of harvested fees)
///   PROTOCOL_FEE_CAP_BPS   default 2000; immutable per vault, never above 2000
///   VAULT_POOLS            "currency0:currency1:fee:tickSpacing,..." (no hooks)
///   TIDEWELL_AUDIT_REPORT  required on 4663: report URL or hash
contract Deploy is Script {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant ROBINHOOD_MAINNET = 4663;

    // Robinhood Chain mainnet. On another chain (the testnet, 46630) pass that
    // chain's Uniswap addresses in POOL_MANAGER, POSITION_MANAGER, PERMIT2 and
    // WETH — verified on its explorer first, as §2 asks for every address.
    address internal constant MAINNET_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant MAINNET_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant MAINNET_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant MAINNET_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    IPoolManager internal POOL_MANAGER;
    IPositionManager internal POSITION_MANAGER;
    IAllowanceTransfer internal PERMIT2;
    IWETH9 internal WETH;

    function run() external {
        string memory audit = vm.envOr("TIDEWELL_AUDIT_REPORT", string(""));
        if (block.chainid == ROBINHOOD_MAINNET && bytes(audit).length == 0) {
            revert("Refused: no mainnet deployment before an external audit (CLAUDE.md section 8, P5). Set TIDEWELL_AUDIT_REPORT.");
        }

        POOL_MANAGER = IPoolManager(vm.envOr("POOL_MANAGER", MAINNET_POOL_MANAGER));
        POSITION_MANAGER = IPositionManager(vm.envOr("POSITION_MANAGER", MAINNET_POSITION_MANAGER));
        PERMIT2 = IAllowanceTransfer(vm.envOr("PERMIT2", MAINNET_PERMIT2));
        WETH = IWETH9(vm.envOr("WETH", MAINNET_WETH));
        require(address(POOL_MANAGER).code.length > 0, "POOL_MANAGER has no code on this chain");
        require(address(POSITION_MANAGER).code.length > 0, "POSITION_MANAGER has no code on this chain");
        require(address(WETH).code.length > 0, "WETH has no code on this chain");

        address owner = vm.envAddress("OWNER");
        address keeper = vm.envAddress("KEEPER");
        address treasury = vm.envAddress("TREASURY");
        uint16 feeBps = uint16(vm.envOr("PROTOCOL_FEE_BPS", uint256(1000)));
        uint16 capBps = uint16(vm.envOr("PROTOCOL_FEE_CAP_BPS", uint256(2000)));
        PoolKey[] memory pools = _pools(vm.envOr("VAULT_POOLS", string("")));

        vm.startBroadcast();
        TidewellZap zap = new TidewellZap(POOL_MANAGER, POSITION_MANAGER, PERMIT2, WETH);
        TidewellShaper shaper = new TidewellShaper(POOL_MANAGER, POSITION_MANAGER, PERMIT2, WETH);
        TidewellRouterFactory factory = new TidewellRouterFactory(POOL_MANAGER, WETH);
        address[] memory vaults = new address[](pools.length);
        for (uint256 i; i < pools.length; i++) {
            vaults[i] = address(new TidewellVault(POOL_MANAGER, WETH, pools[i], owner, keeper, treasury, capBps, feeBps));
        }
        vm.stopBroadcast();

        // deployments/<chainId>.json
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "block", block.number);
        vm.serializeBool(obj, "audited", bytes(audit).length > 0);
        vm.serializeString(obj, "auditReport", audit);
        vm.serializeAddress(obj, "zap", address(zap));
        vm.serializeAddress(obj, "shaper", address(shaper));
        vm.serializeAddress(obj, "routerFactory", address(factory));
        string[] memory entries = new string[](pools.length);
        for (uint256 i; i < pools.length; i++) {
            string memory v = string.concat("vault", vm.toString(i));
            vm.serializeAddress(v, "address", vaults[i]);
            vm.serializeUint(v, "deployedBlock", block.number);
            entries[i] = vm.serializeString(v, "poolId", string.concat("v4:", vm.toString(PoolId.unwrap(pools[i].toId()))));
        }
        string memory json = vm.serializeString(obj, "vaults", entries);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
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
