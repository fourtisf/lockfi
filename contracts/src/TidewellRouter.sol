// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Position} from "v4-core/libraries/Position.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {IWETH9} from "./interfaces/IWETH9.sol";
import {Settlement} from "./libraries/Settlement.sol";

/// @title TidewellRouter
/// @notice For token teams (CLAUDE.md §3.4): turns an accruing fee stream,
///         paid to this contract in ETH or WETH, into permanent liquidity in
///         one pool. Each route buys the token with part of the WETH and adds
///         both as liquidity owned by this contract — liquidity that nothing
///         in this contract can ever remove. Routed depth is permanent.
///
/// The rules it keeps:
///   - The destination pool and range are fixed at deployment. The keeper
///     address can be rotated; nothing else that decides where money goes can.
///   - The keeper only triggers. No function sends funds to the keeper.
///   - Prices come from a 30-minute time-weighted average this contract
///     records itself (Uniswap v4 pools carry no oracle). A route reverts if
///     the pool's spot price is further from that average than the guard, or
///     if its swap would return less than the average price allows.
///   - Milestones (market-cap steps, in WETH) are checked ascending when the
///     router is deployed, and each fires at most once, in order.
///   - `pause` stops routing and lets the owner take back what has NOT been
///     routed yet. What has been routed is not recoverable by anyone.
///
/// Fees earned by the routed liquidity are collected whenever more is added
/// and routed again with the next batch.
contract TidewellRouter is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    enum Mode {
        Cadence,
        Milestone
    }

    struct Observation {
        uint32 timestamp;
        int56 tickCumulative;
    }

    struct Config {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        Mode mode;
        uint32 cadenceSeconds;
        uint256[] milestonesWeth;
        uint16 maxSlippageBps;
        uint24 maxTwapDeviationTicks;
        uint256 minRouteWeth;
        /// @notice The most one route spends (0 = no limit). A thin pool
        ///         takes a large route at a price the slippage guard refuses;
        ///         routing it in slices keeps each one inside the guard.
        uint256 maxRouteWeth;
    }

    uint32 public constant TWAP_WINDOW = 30 minutes;
    /// @notice Observations closer together than this are not recorded, so a
    ///         burst of pokes in one minute cannot fill the window.
    uint32 public constant MIN_OBSERVATION_GAP = 1 minutes;
    /// @notice Distinct observations a TWAP must span: one manipulated sample
    ///         cannot be the whole average.
    uint16 public constant MIN_TWAP_SAMPLES = 6;
    uint16 public constant OBSERVATIONS = 64;
    uint16 public constant MAX_SLIPPAGE_CEILING_BPS = 1000;
    uint256 private constant BPS = 10_000;

    IPoolManager public immutable poolManager;
    IWETH9 public immutable weth;
    address public immutable token;
    PoolId public immutable poolId;
    Currency public immutable currency0;
    Currency public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    bool public immutable tokenIs0;
    bool public immutable ethIsNative;
    Mode public immutable mode;
    uint32 public immutable cadenceSeconds;
    uint16 public immutable maxSlippageBps;
    uint24 public immutable maxTwapDeviationTicks;
    uint256 public immutable minRouteWeth;
    uint256 public immutable maxRouteWeth;
    bytes32 private immutable positionKey;

    address public owner;
    address public pendingOwner;
    address public keeper;
    bool public paused;

    uint256[] private milestones;
    /// @notice Index of the next milestone to fire.
    uint256 public nextMilestone;
    uint256 public lastRouteAt;

    Observation[OBSERVATIONS] public observations;
    uint16 public observationIndex;
    uint16 public observationCount;
    int24 public lastTick;

    uint256 private locked = 1;

    event Routed(
        uint256 wethIn, uint256 wethSwapped, uint256 tokenBought, uint128 liquidity, int24 twapTick, int24 spotTick
    );
    event MilestoneFired(uint256 index, uint256 fdvWeth);
    event Observed(uint32 timestamp, int24 tick);
    event KeeperSet(address keeper);
    event Paused(bool paused);
    event UnroutedWithdrawn(address indexed to, uint256 weth, uint256 tokenAmount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotKeeper();
    error NotPoolManager();
    error Reentrancy();
    error Expired();
    error IsPaused();
    error NotPaused();
    error UnsupportedPool();
    error BadRange();
    error BadConfig();
    error MilestonesNotAscending(uint256 index);
    error NotDue();
    error NoMilestoneReached(uint256 fdvWeth, uint256 nextMilestoneWeth);
    error NothingToRoute();
    error TwapUnavailable();
    error TwapDeviation(int24 spotTick, int24 twapTick);
    error Slippage(uint256 out, uint256 minimum);
    error UnexpectedEth();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(IPoolManager poolManager_, IWETH9 weth_, Config memory cfg, address owner_, address keeper_) {
        if (owner_ == address(0)) revert BadConfig();
        address c0 = Currency.unwrap(cfg.key.currency0);
        address c1 = Currency.unwrap(cfg.key.currency1);
        bool eth0 = c0 == address(0) || c0 == address(weth_);
        bool eth1 = c1 == address(weth_);
        if (eth0 == eth1) revert UnsupportedPool();
        // A hook that can rewrite a liquidity delta could take what is routed.
        IHooks h = cfg.key.hooks;
        if (
            Hooks.hasPermission(h, Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG)
                || Hooks.hasPermission(h, Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG)
        ) revert UnsupportedPool();

        if (
            cfg.tickLower >= cfg.tickUpper || cfg.tickLower % cfg.key.tickSpacing != 0
                || cfg.tickUpper % cfg.key.tickSpacing != 0 || cfg.tickLower < TickMath.minUsableTick(cfg.key.tickSpacing)
                || cfg.tickUpper > TickMath.maxUsableTick(cfg.key.tickSpacing)
        ) revert BadRange();
        if (cfg.maxSlippageBps == 0 || cfg.maxSlippageBps > MAX_SLIPPAGE_CEILING_BPS) revert BadConfig();
        if (cfg.maxTwapDeviationTicks == 0) revert BadConfig();

        if (cfg.mode == Mode.Cadence) {
            if (cfg.cadenceSeconds < 1 hours || cfg.milestonesWeth.length != 0) revert BadConfig();
        } else {
            if (cfg.milestonesWeth.length == 0 || cfg.cadenceSeconds != 0) revert BadConfig();
            // Ascending, checked now — never discovered at route time (§3.5).
            for (uint256 i = 1; i < cfg.milestonesWeth.length; i++) {
                if (cfg.milestonesWeth[i] <= cfg.milestonesWeth[i - 1]) revert MilestonesNotAscending(i);
            }
            if (cfg.milestonesWeth[0] == 0) revert MilestonesNotAscending(0);
        }

        poolManager = poolManager_;
        weth = weth_;
        poolId = cfg.key.toId();
        currency0 = cfg.key.currency0;
        currency1 = cfg.key.currency1;
        fee = cfg.key.fee;
        tickSpacing = cfg.key.tickSpacing;
        hooks = h;
        tickLower = cfg.tickLower;
        tickUpper = cfg.tickUpper;
        tokenIs0 = !eth0;
        token = eth0 ? c1 : c0;
        ethIsNative = c0 == address(0);
        mode = cfg.mode;
        cadenceSeconds = cfg.cadenceSeconds;
        maxSlippageBps = cfg.maxSlippageBps;
        maxTwapDeviationTicks = cfg.maxTwapDeviationTicks;
        minRouteWeth = cfg.minRouteWeth;
        maxRouteWeth = cfg.maxRouteWeth;
        if (cfg.maxRouteWeth != 0 && cfg.maxRouteWeth < cfg.minRouteWeth) revert BadConfig();
        milestones = cfg.milestonesWeth;
        owner = owner_;
        keeper = keeper_;
        positionKey = Position.calculatePositionKey(address(this), cfg.tickLower, cfg.tickUpper, bytes32(0));

        (uint160 sqrtPriceX96, int24 tick,,) = poolManager_.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert UnsupportedPool();
        lastTick = tick;
        observations[0] = Observation({timestamp: uint32(block.timestamp), tickCumulative: 0});
        observationCount = 1;

        emit OwnershipTransferred(address(0), owner_);
        emit KeeperSet(keeper_);
    }

    /// @notice The fee stream arrives as native ETH or WETH; native ETH is
    ///         wrapped when routed. ETH from the PoolManager is a route's own.
    receive() external payable {}

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks});
    }

    function milestonesWeth() external view returns (uint256[] memory) {
        return milestones;
    }

    /// @notice The liquidity this router has added. It only ever grows.
    function routedLiquidity() external view returns (uint128) {
        return poolManager.getPositionLiquidity(poolId, positionKey);
    }

    /// @notice WETH waiting to be routed (native ETH counted as WETH).
    function unroutedWeth() public view returns (uint256) {
        return weth.balanceOf(address(this)) + address(this).balance;
    }

    /// @notice The time-weighted average tick over the last 30 minutes, from
    ///         this contract's own observations.
    function twapTick() public view returns (int24) {
        (uint32 tNow, int56 cumNow) = _cumulativeNow();
        if (tNow < TWAP_WINDOW) revert TwapUnavailable();
        uint32 target = tNow - TWAP_WINDOW;
        uint16 n = observationCount;
        // Walk back to the newest observation at or before the window start,
        // counting the samples inside the window as we go.
        uint16 idx = observationIndex;
        uint16 samples;
        for (uint16 i; i < n; i++) {
            Observation memory o = observations[idx];
            if (o.timestamp <= target) {
                if (samples < MIN_TWAP_SAMPLES) revert TwapUnavailable();
                int56 span = int56(uint56(tNow - o.timestamp));
                int56 delta = cumNow - o.tickCumulative;
                int56 avg = delta / span;
                // Round toward negative infinity, as Uniswap's oracle does.
                if (delta < 0 && delta % span != 0) avg--;
                return int24(avg);
            }
            samples++;
            idx = idx == 0 ? OBSERVATIONS - 1 : idx - 1;
        }
        revert TwapUnavailable();
    }

    /// @notice The token's fully diluted value in WETH wei at the TWAP:
    ///         totalSupply × price. What milestones are measured against.
    function fdvWeth() public view returns (uint256) {
        uint256 supply = ERC20(token).totalSupply();
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(twapTick());
        // price = token1 per token0 = sqrtP² / 2^192 (raw units)
        if (tokenIs0) {
            // WETH per token = price
            return FullMath.mulDiv(FullMath.mulDiv(supply, sqrtP, 1 << 96), sqrtP, 1 << 96);
        }
        // WETH per token = 1 / price
        return FullMath.mulDiv(FullMath.mulDiv(supply, 1 << 96, sqrtP), 1 << 96, sqrtP);
    }

    /// @notice Whether a route may run now, and why not when it may not.
    function due() public view returns (bool) {
        if (paused) return false;
        if (unroutedWeth() < minRouteWeth || unroutedWeth() == 0) return false;
        if (mode == Mode.Cadence) return lastRouteAt == 0 || block.timestamp >= lastRouteAt + cadenceSeconds;
        if (nextMilestone >= milestones.length) return false;
        try this.fdvWeth() returns (uint256 fdv) {
            return fdv >= milestones[nextMilestone];
        } catch {
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Observations
    // -----------------------------------------------------------------------

    /// @notice Record the pool's tick. Anyone may call; the keeper does so
    ///         every few minutes. Calls within a minute of the last are no-ops.
    function poke() public {
        uint32 t = uint32(block.timestamp);
        Observation memory last = observations[observationIndex];
        if (t < last.timestamp + MIN_OBSERVATION_GAP) return;
        int56 cum = last.tickCumulative + int56(lastTick) * int56(uint56(t - last.timestamp));
        uint16 next = (observationIndex + 1) % OBSERVATIONS;
        observations[next] = Observation({timestamp: t, tickCumulative: cum});
        observationIndex = next;
        if (observationCount < OBSERVATIONS) observationCount++;
        (, int24 tick,,) = poolManager.getSlot0(poolId);
        lastTick = tick;
        emit Observed(t, tick);
    }

    // -----------------------------------------------------------------------
    // Route (keeper)
    // -----------------------------------------------------------------------

    /// @notice Route everything unrouted into the destination pool.
    function route(uint256 deadline) external nonReentrant returns (uint128 liquidity) {
        if (msg.sender != keeper) revert NotKeeper();
        if (block.timestamp > deadline) revert Expired();
        if (paused) revert IsPaused();
        poke();

        uint256 wethIn = unroutedWeth();
        if (wethIn == 0 || wethIn < minRouteWeth) revert NothingToRoute();
        if (maxRouteWeth != 0 && wethIn > maxRouteWeth) wethIn = maxRouteWeth;

        if (mode == Mode.Cadence) {
            // The first route may run as soon as there is a TWAP.
            if (lastRouteAt != 0 && block.timestamp < lastRouteAt + cadenceSeconds) revert NotDue();
        } else {
            uint256 i = nextMilestone;
            if (i >= milestones.length) revert NotDue();
            uint256 fdv = fdvWeth();
            if (fdv < milestones[i]) revert NoMilestoneReached(fdv, milestones[i]);
            nextMilestone = i + 1; // fires once
            emit MilestoneFired(i, fdv);
        }

        int24 twap = twapTick();
        (, int24 spot,,) = poolManager.getSlot0(poolId);
        int256 deviation = int256(spot) - int256(twap);
        if (deviation < 0) deviation = -deviation;
        if (uint256(deviation) > maxTwapDeviationTicks) revert TwapDeviation(spot, twap);

        // Hold everything as the pool's own form of ETH.
        uint256 native = address(this).balance;
        if (ethIsNative) {
            uint256 w = weth.balanceOf(address(this));
            if (w > 0) weth.withdraw(w);
        } else if (native > 0) {
            weth.deposit{value: native}();
        }

        lastRouteAt = block.timestamp;
        bytes memory result = poolManager.unlock(abi.encode(wethIn, twap));
        uint256 swapped;
        uint256 bought;
        (swapped, bought, liquidity) = abi.decode(result, (uint256, uint256, uint128));
        emit Routed(wethIn, swapped, bought, liquidity, twap, spot);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 wethIn, int24 twap) = abi.decode(data, (uint256, int24));
        PoolKey memory key = poolKey();
        (Currency ethC, Currency tokC) = tokenIs0 ? (currency1, currency0) : (currency0, currency1);

        // 1. Buy the token with the share of WETH that pairs with the rest.
        uint256 swapAmount = _swapShare(wethIn);
        uint256 bought;
        if (swapAmount > 0) {
            bool zeroForOne = !tokenIs0; // selling ETH
            BalanceDelta d = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(swapAmount),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            int128 ethDelta = zeroForOne ? d.amount0() : d.amount1();
            int128 tokDelta = zeroForOne ? d.amount1() : d.amount0();
            swapAmount = uint256(int256(-ethDelta));
            bought = uint256(int256(tokDelta));
            uint256 minOut = _tokenForWeth(swapAmount, twap) * (BPS - maxSlippageBps) / BPS;
            if (bought < minOut) revert Slippage(bought, minOut);
            Settlement.pay(poolManager, ethC, address(this), swapAmount);
            Settlement.collect(poolManager, tokC, address(this), bought);
        }

        // 2. Add both as liquidity this contract owns and can never remove:
        //    this route's WETH (what was not swapped) and every token held.
        uint256 ethHeld = wethIn - swapAmount;
        uint256 tokHeld = ERC20(token).balanceOf(address(this));
        (uint160 sqrtP,,,) = poolManager.getSlot0(poolId);
        (uint256 a0, uint256 a1) = tokenIs0 ? (tokHeld, ethHeld) : (ethHeld, tokHeld);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), a0, a1
        );
        if (liquidity > 0) {
            (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: int256(uint256(liquidity)),
                    salt: 0
                }),
                ""
            );
            // callerDelta nets the deposit against fees the routed liquidity
            // earned since last time: pay what is owed, keep what is owed us.
            _settleDelta(currency0, callerDelta.amount0());
            _settleDelta(currency1, callerDelta.amount1());
        }
        return abi.encode(swapAmount, bought, liquidity);
    }

    // -----------------------------------------------------------------------
    // Owner
    // -----------------------------------------------------------------------

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }

    /// @notice While paused, take back what has not been routed: the WETH
    ///         (and ETH) waiting, and any token left from a route's swap.
    ///         Routed liquidity is not touched — nothing can touch it.
    function withdrawUnrouted(address to) external onlyOwner nonReentrant {
        if (!paused) revert NotPaused();
        if (to == address(0)) revert BadConfig();
        uint256 native = address(this).balance;
        if (native > 0) weth.deposit{value: native}();
        uint256 w = weth.balanceOf(address(this));
        uint256 t = ERC20(token).balanceOf(address(this));
        if (w > 0) SafeTransferLib.safeTransfer(ERC20(address(weth)), to, w);
        if (t > 0) SafeTransferLib.safeTransfer(ERC20(token), to, t);
        emit UnroutedWithdrawn(to, w, t);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    function _cumulativeNow() private view returns (uint32 t, int56 cum) {
        Observation memory last = observations[observationIndex];
        t = uint32(block.timestamp);
        cum = last.tickCumulative + int56(lastTick) * int56(uint56(t - last.timestamp));
    }

    /// @dev For a range the price sits inside, the share of WETH to swap so
    ///      what remains pairs with what it buys: ETH value of the token side
    ///      over the total, at the current price. Outside the range, the
    ///      position takes one side only.
    function _swapShare(uint256 wethIn) private view returns (uint256) {
        (uint160 sqrtP,,,) = poolManager.getSlot0(poolId);
        uint160 sa = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sb = TickMath.getSqrtPriceAtTick(tickUpper);
        bool ethIs0 = !tokenIs0;
        if (sqrtP <= sa) return ethIs0 ? 0 : wethIn; // all token0
        if (sqrtP >= sb) return ethIs0 ? wethIn : 0; // all token1
        // Amounts per unit liquidity at sqrtP, in raw units.
        uint256 amt0 = FullMath.mulDiv(1 << 96, sb - sqrtP, FullMath.mulDiv(sqrtP, sb, 1 << 96));
        uint256 amt1 = sqrtP - sa;
        // Value of each side in token1 units: amt0 × price + amt1.
        uint256 v0 = FullMath.mulDiv(FullMath.mulDiv(amt0, sqrtP, 1 << 96), sqrtP, 1 << 96);
        uint256 v1 = amt1;
        uint256 tokenShare = tokenIs0 ? v0 : v1;
        return FullMath.mulDiv(wethIn, tokenShare, v0 + v1);
    }

    /// @dev The token a WETH amount buys at a tick's price (raw units).
    function _tokenForWeth(uint256 wethAmount, int24 tick) private view returns (uint256) {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        if (tokenIs0) {
            // WETH is token1: token0 = weth / price
            return FullMath.mulDiv(FullMath.mulDiv(wethAmount, 1 << 96, sqrtP), 1 << 96, sqrtP);
        }
        // WETH is token0: token1 = weth × price
        return FullMath.mulDiv(FullMath.mulDiv(wethAmount, sqrtP, 1 << 96), sqrtP, 1 << 96);
    }

    function _settleDelta(Currency currency, int128 delta) private {
        if (delta < 0) Settlement.pay(poolManager, currency, address(this), uint256(int256(-delta)));
        else if (delta > 0) Settlement.collect(poolManager, currency, address(this), uint256(int256(delta)));
    }
}

/// @title TidewellRouterFactory
/// @notice Deploys routers and announces them, so the site can find every
///         router a team has configured.
contract TidewellRouterFactory {
    IPoolManager public immutable poolManager;
    IWETH9 public immutable weth;

    event RouterCreated(address indexed router, address indexed token, address indexed owner, bytes32 poolId);

    constructor(IPoolManager poolManager_, IWETH9 weth_) {
        poolManager = poolManager_;
        weth = weth_;
    }

    /// @notice The caller becomes the router's owner.
    function createRouter(TidewellRouter.Config calldata cfg, address keeper) external returns (TidewellRouter router) {
        router = new TidewellRouter(poolManager, weth, cfg, msg.sender, keeper);
        emit RouterCreated(address(router), router.token(), msg.sender, PoolId.unwrap(router.poolId()));
    }
}
