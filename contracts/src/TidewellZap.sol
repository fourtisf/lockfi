// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {IWETH9} from "./interfaces/IWETH9.sol";
import {PeripheryBase} from "./base/PeripheryBase.sol";
import {TidewellVault} from "./TidewellVault.sol";

/// @title TidewellZap
/// @notice Single-token entry (CLAUDE.md §3.1). Takes ETH or one side of a
///         pair, swaps the fraction the front end computed into the other
///         side, and either stakes the pair in a Tidewell vault or mints a
///         Uniswap v4 position to the caller. Everything left over is
///         returned in the same transaction.
/// @dev The swap fraction is computed off chain and passed in. The contract
///      does not trust it: `minLiquidity` makes a quote that degraded between
///      building the transaction and executing it revert, never fill partly.
contract TidewellZap is PeripheryBase {
    event ZapStaked(address indexed user, address indexed vault, address tokenIn, uint256 amountIn, uint256 liquidity);
    event ZapMinted(address indexed user, uint256 indexed tokenId, address tokenIn, uint256 amountIn, uint256 liquidity);

    constructor(IPoolManager poolManager_, IPositionManager positionManager_, IAllowanceTransfer permit2_, IWETH9 weth_)
        PeripheryBase(poolManager_, positionManager_, permit2_, weth_)
    {}

    /// @notice Stake one token into a vault.
    /// @param tokenIn    address(0) for ETH, WETH, or the pool's other token.
    /// @param swapAmount How much of the input to swap into the other side.
    /// @return liquidity The vault shares minted to the caller.
    function zapStake(
        TidewellVault vault,
        address tokenIn,
        uint256 amountIn,
        uint256 swapAmount,
        uint128 minLiquidity,
        uint256 deadline
    ) external payable nonReentrant checkDeadline(deadline) returns (uint128 liquidity) {
        PoolKey memory key = vault.poolKey();
        bool inputIs0 = _takeInput(key, tokenIn, amountIn);
        _swap(key, inputIs0, swapAmount);

        uint256 bal0 = _balance(key.currency0);
        uint256 bal1 = _balance(key.currency1);
        _approve(key.currency0, address(vault), bal0);
        _approve(key.currency1, address(vault), bal1);
        uint256 value = key.currency0.isAddressZero() ? bal0 : 0;
        (liquidity,,) = vault.deposit{value: value}(bal0, bal1, 0, 0, msg.sender, deadline);
        if (liquidity < minLiquidity) revert InsufficientLiquidity(liquidity, minLiquidity);
        _approve(key.currency0, address(vault), 0);
        _approve(key.currency1, address(vault), 0);

        _sweep(key.currency0, msg.sender);
        _sweep(key.currency1, msg.sender);
        emit ZapStaked(msg.sender, address(vault), tokenIn, amountIn, liquidity);
    }

    /// @notice Mint one concentrated position from one token (§3.1's zapMint).
    /// @param sqrtPriceMinX96,sqrtPriceMaxX96 The price must still be inside
    ///        these after the swap, or nothing happens.
    function zapMint(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        address tokenIn,
        uint256 amountIn,
        uint256 swapAmount,
        uint128 minLiquidity,
        uint160 sqrtPriceMinX96,
        uint160 sqrtPriceMaxX96,
        uint256 deadline
    ) external payable nonReentrant checkDeadline(deadline) returns (uint256 tokenId) {
        bool inputIs0 = _takeInput(key, tokenIn, amountIn);
        _swap(key, inputIs0, swapAmount);
        _checkPrice(key, sqrtPriceMinX96, sqrtPriceMaxX96);

        Bin[] memory bins = new Bin[](1);
        bins[0] = Bin({lower: tickLower, upper: tickUpper, weightBps: uint128(BPS)});
        uint256 liquidity;
        (tokenId, liquidity) = _mintBins(key, bins, msg.sender, deadline);
        if (liquidity < minLiquidity) revert InsufficientLiquidity(liquidity, minLiquidity);

        _sweep(key.currency0, msg.sender);
        _sweep(key.currency1, msg.sender);
        emit ZapMinted(msg.sender, tokenId, tokenIn, amountIn, liquidity);
    }

    function _approve(Currency currency, address spender, uint256 amount) private {
        if (currency.isAddressZero()) return;
        SafeTransferLib.safeApprove(ERC20(Currency.unwrap(currency)), spender, amount);
    }
}
