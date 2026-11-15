// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {IWETH9} from "../../src/interfaces/IWETH9.sol";
import {TidewellVault} from "../../src/TidewellVault.sol";

/// @notice A local v4 deployment: a real PoolManager, WETH, a token, and the
///         v4-core test routers standing in for other traders and LPs.
abstract contract Fixture is Test {
    PoolManager internal manager;
    WETH internal weth;
    MockERC20 internal token;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");

    uint24 internal constant FEE = 3000;
    int24 internal constant SPACING = 60;
    /// @dev 1 ETH ≈ 1000 TKN (1.0001^69060 ≈ 1000).
    int24 internal constant START_TICK = 69_060;

    function deployCore() internal {
        manager = new PoolManager(address(this));
        weth = new WETH();
        token = new MockERC20("Token", "TKN", 18);
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        token.mint(address(this), 1e36);
        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(lpRouter), type(uint256).max);
        vm.deal(address(this), 1e30);
        weth.deposit{value: 1e27}();
        weth.approve(address(swapRouter), type(uint256).max);
        weth.approve(address(lpRouter), type(uint256).max);
    }

    /// @notice native ETH / TKN — the shape of most v4 ETH pools on this chain.
    function nativeKey() internal view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), FEE, SPACING, IHooks(address(0)));
    }

    /// @notice WETH / TKN, in whichever order the addresses sort.
    function wethKey() internal view returns (PoolKey memory key) {
        (address a, address b) =
            address(weth) < address(token) ? (address(weth), address(token)) : (address(token), address(weth));
        key = PoolKey(Currency.wrap(a), Currency.wrap(b), FEE, SPACING, IHooks(address(0)));
    }

    /// @dev The price for "1 ETH ≈ 1000 TKN" whichever side ETH sorts on.
    function startPrice(PoolKey memory key) internal view returns (uint160) {
        bool ethIs0 = Currency.unwrap(key.currency0) == address(0) || Currency.unwrap(key.currency0) == address(weth);
        return TickMath.getSqrtPriceAtTick(ethIs0 ? START_TICK : -START_TICK);
    }

    function initPool(PoolKey memory key) internal {
        manager.initialize(key, startPrice(key));
    }

    /// @notice Another LP's full-range liquidity, so trades have depth
    ///         beyond the vault's own.
    function seedLiquidity(PoolKey memory key, int256 liquidity) internal {
        uint256 value = Currency.unwrap(key.currency0) == address(0) ? 1e24 : 0;
        lpRouter.modifyLiquidity{value: value}(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(SPACING),
                tickUpper: TickMath.maxUsableTick(SPACING),
                liquidityDelta: liquidity,
                salt: 0
            }),
            ""
        );
    }

    /// @notice A trade from someone else, generating fees for LPs.
    function trade(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal {
        uint256 value = zeroForOne && Currency.unwrap(key.currency0) == address(0) ? amountIn : 0;
        swapRouter.swap{value: value}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function newVault(PoolKey memory key) internal returns (TidewellVault) {
        return new TidewellVault(manager, key, owner, treasury, 2000, 1000);
    }

    /// @notice Give `who` the tokens to stake and approve `spender`.
    function fund(address who, address spender, uint256 ethAmount, uint256 tokenAmount) internal {
        vm.deal(who, who.balance + ethAmount);
        token.mint(who, tokenAmount);
        vm.startPrank(who);
        token.approve(spender, type(uint256).max);
        weth.approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    receive() external payable {}
}
