// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {IWETH9} from "../interfaces/IWETH9.sol";
import {Settlement} from "../libraries/Settlement.sol";

/// @notice What TidewellZap and TidewellShaper share: taking one token in,
///         swapping part of it in the target pool, minting Uniswap v4
///         positions straight to the user, and returning everything left.
/// @dev These contracts hold nothing between transactions. Whatever they hold
///      at the end of a call is returned to the caller — never kept as dust.
abstract contract PeripheryBase is IUnlockCallback {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    /// @notice A tick range and its share of the deposit, in basis points.
    struct Bin {
        int24 lower;
        int24 upper;
        uint128 weightBps;
    }

    uint256 public constant MAX_BINS = 60;
    uint256 internal constant BPS = 10_000;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    IWETH9 public immutable weth;

    uint256 private locked = 1;

    error NotPoolManager();
    error Reentrancy();
    error Expired();
    error WrongValue();
    error UnsupportedToken();
    error TooManyBins(uint256 count);
    error NoBins();
    error WeightsMustSumTo10000(uint256 sum);
    error EmptyBin(uint256 index);
    error PriceOutOfBounds(uint160 sqrtPriceX96);
    error InsufficientLiquidity(uint256 liquidity, uint256 minimum);
    error UnexpectedEth();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    constructor(IPoolManager poolManager_, IPositionManager positionManager_, IAllowanceTransfer permit2_, IWETH9 weth_) {
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        weth = weth_;
    }

    /// @dev ETH arrives only mid-operation: swap proceeds, WETH unwraps,
    ///      a vault's refund, the PositionManager's sweep.
    receive() external payable {
        if (locked != 2) revert UnexpectedEth();
    }

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------

    /// @notice Take `amountIn` of `tokenIn` from the caller and express it as
    ///         one of the pool's two currencies.
    /// @param tokenIn address(0) for native ETH, WETH, or either pool token.
    /// @return inputIs0 Whether the input is now held as currency0.
    function _takeInput(PoolKey memory key, address tokenIn, uint256 amountIn) internal returns (bool inputIs0) {
        if (tokenIn == address(0)) {
            if (msg.value != amountIn) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            SafeTransferLib.safeTransferFrom(ERC20(tokenIn), msg.sender, address(this), amountIn);
        }
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (tokenIn == c0) return true;
        if (tokenIn == c1) return false;
        // ETH in the form the pool does not use: wrap or unwrap it.
        if (tokenIn == address(weth) && c0 == address(0)) {
            weth.withdraw(amountIn);
            return true;
        }
        if (tokenIn == address(0) && (c0 == address(weth) || c1 == address(weth))) {
            weth.deposit{value: amountIn}();
            return c0 == address(weth);
        }
        revert UnsupportedToken();
    }

    // -----------------------------------------------------------------------
    // Swap
    // -----------------------------------------------------------------------

    /// @notice Sell exactly `amountIn` of one side for the other, in `key`.
    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (uint256 amountOut) {
        if (amountIn == 0) return 0;
        bytes memory result = poolManager.unlock(abi.encode(key, zeroForOne, amountIn));
        amountOut = abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency sold, Currency bought) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        int128 soldDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 boughtDelta = zeroForOne ? delta.amount1() : delta.amount0();
        Settlement.pay(poolManager, sold, address(this), uint256(int256(-soldDelta)));
        uint256 out = uint256(int256(boughtDelta));
        Settlement.collect(poolManager, bought, address(this), out);
        return abi.encode(out);
    }

    // -----------------------------------------------------------------------
    // Minting through the PositionManager
    // -----------------------------------------------------------------------

    /// @notice Split what this contract holds of the pool's two currencies
    ///         across `bins` by weight, and mint one position per bin to
    ///         `recipient`. One transaction; every NFT goes to the user.
    /// @dev Token0 is shared among the bins that need it (those whose range
    ///      reaches above the price) and token1 among those reaching below,
    ///      each in proportion to its weight. A bin straddling the price
    ///      takes both, limited by whichever runs out first.
    /// @dev The figures every bin is sized against, gathered so the loop
    ///      below stays within the EVM's stack.
    struct Budget {
        uint160 sqrtP;
        uint256 bal0;
        uint256 bal1;
        uint256 w0;
        uint256 w1;
    }

    function _mintBins(PoolKey memory key, Bin[] memory bins, address recipient, uint256 deadline)
        internal
        returns (uint256 firstTokenId, uint256 totalLiquidity)
    {
        uint256 n = bins.length;
        if (n == 0) revert NoBins();
        if (n > MAX_BINS) revert TooManyBins(n);

        Budget memory budget;
        (budget.sqrtP,,,) = poolManager.getSlot0(key.toId());
        uint256 sum;
        for (uint256 i; i < n; i++) {
            sum += bins[i].weightBps;
            if (bins[i].weightBps == 0) revert EmptyBin(i);
            if (budget.sqrtP < TickMath.getSqrtPriceAtTick(bins[i].upper)) budget.w0 += bins[i].weightBps;
            if (budget.sqrtP > TickMath.getSqrtPriceAtTick(bins[i].lower)) budget.w1 += bins[i].weightBps;
        }
        if (sum != BPS) revert WeightsMustSumTo10000(sum);
        budget.bal0 = _balance(key.currency0);
        budget.bal1 = _balance(key.currency1);

        bool native = key.currency0.isAddressZero();
        bytes memory actions = new bytes(native ? n + 2 : n + 1);
        bytes[] memory params = new bytes[](native ? n + 2 : n + 1);
        for (uint256 i; i < n; i++) {
            uint128 liquidity;
            (params[i], liquidity) = _mintParams(key, bins[i], budget, recipient);
            if (liquidity == 0) revert EmptyBin(i);
            totalLiquidity += liquidity;
            actions[i] = bytes1(uint8(Actions.MINT_POSITION));
        }
        actions[n] = bytes1(uint8(Actions.SETTLE_PAIR));
        params[n] = abi.encode(key.currency0, key.currency1);
        if (native) {
            // Native ETH the mint did not use comes back here, then to the user.
            actions[n + 1] = bytes1(uint8(Actions.SWEEP));
            params[n + 1] = abi.encode(key.currency0, address(this));
        }

        _approvePermit2(key.currency0, budget.bal0);
        _approvePermit2(key.currency1, budget.bal1);

        firstTokenId = positionManager.nextTokenId();
        positionManager.modifyLiquidities{value: native ? budget.bal0 : 0}(abi.encode(actions, params), deadline);
    }

    /// @dev One bin's share of each token, the liquidity that buys, and the
    ///      MINT_POSITION parameters for it.
    function _mintParams(PoolKey memory key, Bin memory b, Budget memory budget, address recipient)
        private
        pure
        returns (bytes memory params, uint128 liquidity)
    {
        uint160 sa = TickMath.getSqrtPriceAtTick(b.lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(b.upper);
        uint256 a0 = (budget.sqrtP < sb && budget.w0 > 0) ? budget.bal0 * b.weightBps / budget.w0 : 0;
        uint256 a1 = (budget.sqrtP > sa && budget.w1 > 0) ? budget.bal1 * b.weightBps / budget.w1 : 0;
        liquidity = LiquidityAmounts.getLiquidityForAmounts(budget.sqrtP, sa, sb, a0, a1);
        // amountMax: the bin's own budget plus one wei of rounding.
        params = abi.encode(key, b.lower, b.upper, uint256(liquidity), uint128(a0 + 1), uint128(a1 + 1), recipient, bytes(""));
    }

    function _approvePermit2(Currency currency, uint256 amount) private {
        if (currency.isAddressZero() || amount == 0) return;
        address token = Currency.unwrap(currency);
        if (ERC20(token).allowance(address(this), address(permit2)) < amount) {
            SafeTransferLib.safeApprove(ERC20(token), address(permit2), type(uint256).max);
        }
        // Valid for this block only, for exactly what is held.
        permit2.approve(token, address(positionManager), uint160(amount), uint48(block.timestamp));
    }

    // -----------------------------------------------------------------------
    // Output
    // -----------------------------------------------------------------------

    /// @notice Send everything held of `currency` to `to`.
    function _sweep(Currency currency, address to) internal {
        uint256 amount = _balance(currency);
        if (amount > 0) currency.transfer(to, amount);
    }

    function _balance(Currency currency) internal view returns (uint256) {
        return currency.isAddressZero() ? address(this).balance : ERC20(Currency.unwrap(currency)).balanceOf(address(this));
    }

    function _checkPrice(PoolKey memory key, uint160 sqrtPriceMinX96, uint160 sqrtPriceMaxX96) internal view {
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        if (sqrtP < sqrtPriceMinX96 || sqrtP > sqrtPriceMaxX96) revert PriceOutOfBounds(sqrtP);
    }
}
