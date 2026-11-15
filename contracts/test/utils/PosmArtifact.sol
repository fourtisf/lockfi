// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// Compiled only so the tests can deploy a real PositionManager from its
// artifact (vm.getCode). It needs via-IR, which foundry.toml restricts to
// this one dependency; tests use the interface and never import it.
import {PositionManager} from "v4-periphery/PositionManager.sol";
