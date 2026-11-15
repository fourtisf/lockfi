// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IWETH9} from "./interfaces/IWETH9.sol";
import {PeripheryBase} from "./base/PeripheryBase.sol";

/// @title TidewellShaper
/// @notice Builds a shaped position across up to 60 bins in one transaction
///         (CLAUDE.md §3.2). Uniswap v4 has ticks, not bins: a bin is one
///         tick-range position with its own weight, and each is minted as its
///         own position NFT straight to the caller.
/// @dev Shape-agnostic on purpose. Spot, curve and bid-ask are weight
///      generators in the front end; a new shape needs no contract change.
///      `sum(weightBps) == 10_000` is enforced here, and more than 60 bins is
///      refused with a clear error rather than truncated.
contract TidewellShaper is PeripheryBase {
    event ShapeMinted(
        address indexed user, bytes32 indexed poolId, uint256 firstTokenId, uint256 bins, uint256 totalLiquidity
    );

    constructor(IPoolManager poolManager_, IPositionManager positionManager_, IAllowanceTransfer permit2_, IWETH9 weth_)
        PeripheryBase(poolManager_, positionManager_, permit2_, weth_)
    {}

    /// @param tokenIn    address(0) for ETH, WETH, or either pool token.
    /// @param swapAmount How much of the input to swap into the other side
    ///                   first (the "split at mint" the page shows).
    /// @param sqrtPriceMinX96,sqrtPriceMaxX96 The price must still be inside
    ///        these after the swap, or the whole mint reverts.
    /// @return firstTokenId The first position's id; the rest follow in order.
    function mintShaped(
        PoolKey calldata key,
        Bin[] calldata bins,
        address tokenIn,
        uint256 amountIn,
        uint256 swapAmount,
        uint160 sqrtPriceMinX96,
        uint160 sqrtPriceMaxX96,
        uint256 deadline
    ) external payable nonReentrant checkDeadline(deadline) returns (uint256 firstTokenId) {
        if (bins.length > MAX_BINS) revert TooManyBins(bins.length);
        bool inputIs0 = _takeInput(key, tokenIn, amountIn);
        _swap(key, inputIs0, swapAmount);
        _checkPrice(key, sqrtPriceMinX96, sqrtPriceMaxX96);

        uint256 totalLiquidity;
        (firstTokenId, totalLiquidity) = _mintBins(key, bins, msg.sender, deadline);

        _sweep(key.currency0, msg.sender);
        _sweep(key.currency1, msg.sender);
        emit ShapeMinted(msg.sender, keccak256(abi.encode(key)), firstTokenId, bins.length, totalLiquidity);
    }
}
