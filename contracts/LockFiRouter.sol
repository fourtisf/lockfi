// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "./vendor/TickMath.sol";
import {LiquidityAmounts} from "./vendor/LiquidityAmounts.sol";
import {FullMath} from "./vendor/FullMath.sol";

/*
 * LockFi Router: a token team's creator fees, turned into permanent pool
 * liquidity.
 *
 * One router per token. Creator fees arrive as ETH (or WETH, or the token
 * itself). On each route the router:
 *   1. takes the LockFi fee (factory.feeBps, capped in the factory, never
 *      raisable) from the ETH that arrived since the last route, and sends it
 *      to the treasury;
 *   2. collects the swap fees its own liquidity has earned, into itself;
 *   3. swaps enough ETH for the token, in the destination pool itself, to
 *      balance the two sides, refusing a price below the caller's minimum;
 *   4. adds both sides to the pool as liquidity owned by this contract.
 *
 * The liquidity is permanent because nothing in this contract can remove it:
 * there is no call that lowers a position's liquidity, and no way to hand a
 * position to anyone else. What the team can do is pause future routes and
 * withdraw what has not been routed yet.
 *
 * The pool is Uniswap v4 (quote: native ETH or WETH) or Uniswap v3 (quote:
 * WETH). The position is held at the pool itself, not as an NFT: on v4 with
 * the PoolManager's `modifyLiquidity`, on v3 with the pool's `mint`.
 *
 * Who can route: the keeper the factory names, on the router's cadence, or
 * the team at any time. Neither ever receives funds from a route.
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256, uint256);
    function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested)
        external
        returns (uint128, uint128);
}

interface IUniswapV3PoolLiquidity {
    function liquidity() external view returns (uint128);
}

interface ILockFiRouterFactory {
    function keeper() external view returns (address);
    function treasury() external view returns (address);
    function feeBps() external view returns (uint16);
}

/// Everything a router is told once, at creation.
struct RouterConfig {
    bool isV4;
    address poolManager; // v4
    address v3Pool; // v3
    PoolKey key; // v4 key; for v3, the pool's own tokens, fee and spacing
    address token; // the team's token
    address quote; // address(0) for native ETH, else WETH
    address weth;
    address team;
    uint32 cadence; // seconds between keeper routes
    bool narrow; // false: full range; true: ±20% around the token's price
}

contract LockFiRouter {
    // ── configuration, fixed at creation ──────────────────────────────────────
    address public immutable factory;
    bool public immutable isV4;
    IPoolManager public immutable poolManager;
    address public immutable v3Pool;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    address public immutable hooks;
    address public immutable token;
    address public immutable quote;
    address public immutable weth;
    bool public immutable tokenIs0;
    uint32 public immutable cadence;
    bool public immutable narrow;

    // ── state ─────────────────────────────────────────────────────────────────
    address public team;
    bool public paused;
    uint64 public lastRouteAt;
    uint32 public routes;
    /// Quote (ETH) already charged the LockFi fee: what a route left behind.
    uint256 public feeFreeQuote;
    uint256 public totalQuoteAdded;
    uint256 public totalTokenAdded;
    uint256 public totalFeePaid;

    struct Range {
        int24 lower;
        int24 upper;
    }

    Range[] internal _ranges;
    mapping(bytes32 => bool) internal _seen;

    uint256 private _lock = 1;
    uint256 private _maxPay; // v3 swap callback bound
    bool private _minting; // v3 mint callback gate

    /// How many of the most recent ranges a route collects fees from.
    uint256 public constant COLLECT_RECENT = 8;
    /// ±20% of the token's price, in ticks: ln(0.8)/ln(1.0001) and ln(1.2)/ln(1.0001).
    int24 internal constant TICKS_DOWN_20 = 2232;
    int24 internal constant TICKS_UP_20 = 1824;

    event Routed(
        address indexed caller,
        uint256 feePaid,
        uint256 swapIn,
        uint256 tokenOut,
        uint256 quoteAdded,
        uint256 tokenAdded,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper,
        uint160 sqrtPriceX96
    );
    event Collected(uint256 quote, uint256 token);
    event PausedSet(bool paused);
    event TeamSet(address team);
    event Withdrawn(address indexed to, uint256 eth, uint256 weth, uint256 token);

    error NotAuthorized();
    error NotDue();
    error IsPaused();
    error NotPaused();
    error Expired();
    error Slippage();
    error BadCallback();
    error Reentrant();
    error TransferFailed();
    error HookOverdraw();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyTeam() {
        if (msg.sender != team) revert NotAuthorized();
        _;
    }

    constructor(RouterConfig memory c) {
        factory = msg.sender;
        isV4 = c.isV4;
        poolManager = IPoolManager(c.poolManager);
        v3Pool = c.v3Pool;
        currency0 = c.key.currency0;
        currency1 = c.key.currency1;
        poolFee = c.key.fee;
        tickSpacing = c.key.tickSpacing;
        hooks = c.key.hooks;
        token = c.token;
        quote = c.quote;
        weth = c.weth;
        tokenIs0 = c.key.currency0 == c.token;
        cadence = c.cadence;
        narrow = c.narrow;
        team = c.team;
    }

    /// Creator fees arrive here. Kept empty so a sender that forwards a 2300
    /// gas stipend can still pay in.
    receive() external payable {}

    // ── views ─────────────────────────────────────────────────────────────────

    function key() public view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, poolFee, tickSpacing, hooks);
    }

    function ranges() external view returns (Range[] memory) {
        return _ranges;
    }

    function rangeCount() external view returns (uint256) {
        return _ranges.length;
    }

    /// ETH plus WETH held: the quote side waiting to be routed.
    function quoteBalance() public view returns (uint256) {
        return address(this).balance + (weth == address(0) ? 0 : IERC20(weth).balanceOf(address(this)));
    }

    function tokenBalance() public view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function nextRouteAt() public view returns (uint256) {
        return lastRouteAt == 0 ? 0 : uint256(lastRouteAt) + cadence;
    }

    function due() public view returns (bool) {
        return !paused && block.timestamp >= nextRouteAt();
    }

    function price() public view returns (uint160 sqrtPriceX96, int24 tick) {
        return isV4 ? _slot0V4() : _slot0V3();
    }

    /// What a route would do now, before the fees its liquidity has earned:
    /// the LockFi fee it would pay and the ETH it would swap. The keeper quotes
    /// `swapIn` to set the minimum price it passes to `route`.
    function plan() public view returns (uint256 fee, uint256 swapIn) {
        uint256 q = quoteBalance();
        fee = q > feeFreeQuote ? ((q - feeFreeQuote) * ILockFiRouterFactory(factory).feeBps()) / 10_000 : 0;
        (uint160 sqrtP,) = price();
        swapIn = _swapIn(q - fee, tokenBalance(), sqrtP);
    }

    // ── routing ───────────────────────────────────────────────────────────────

    /// @param minTokenPerQuoteE18 the least token (in its smallest unit) the swap
    ///        may return per wei of ETH, times 1e18. The caller quotes it off
    ///        chain; a price below it reverts the whole route.
    /// @param deadline a timestamp; the route reverts after it.
    function route(uint256 minTokenPerQuoteE18, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        if (paused) revert IsPaused();
        if (msg.sender != team) {
            if (msg.sender != ILockFiRouterFactory(factory).keeper()) revert NotAuthorized();
            if (block.timestamp < nextRouteAt()) revert NotDue();
        }

        // 1. every quote unit as ETH, then the LockFi fee on what is new
        if (weth != address(0)) {
            uint256 w = IERC20(weth).balanceOf(address(this));
            if (w > 0) IWETH9(weth).withdraw(w);
        }
        uint256 q = address(this).balance;
        uint256 fee = q > feeFreeQuote ? ((q - feeFreeQuote) * ILockFiRouterFactory(factory).feeBps()) / 10_000 : 0;
        if (fee > 0) {
            _sendEth(ILockFiRouterFactory(factory).treasury(), fee);
            q -= fee;
            totalFeePaid += fee;
        }
        if (quote != address(0) && q > 0) IWETH9(weth).deposit{value: q}();

        // 2-4
        RouteResult memory r = isV4 ? _routeV4(minTokenPerQuoteE18) : _routeV3(minTokenPerQuoteE18);

        feeFreeQuote = quoteBalance();
        lastRouteAt = uint64(block.timestamp);
        routes += 1;
        totalQuoteAdded += r.quoteAdded;
        totalTokenAdded += r.tokenAdded;
        emit Routed(
            msg.sender, fee, r.swapIn, r.tokenOut, r.quoteAdded, r.tokenAdded, r.liquidity, r.lower, r.upper, r.sqrtP
        );
    }

    /// Collect the swap fees earned by ranges [from, to) into this contract,
    /// to be routed next time. Anyone may call it: it can only move fees in.
    function collect(uint256 from, uint256 to) external nonReentrant {
        if (to > _ranges.length) to = _ranges.length;
        if (from >= to) return;
        uint256 cq;
        uint256 ct;
        if (isV4) {
            bytes memory out = poolManager.unlock(abi.encode(uint8(1), from, to, uint256(0), uint256(0)));
            (cq, ct) = abi.decode(out, (uint256, uint256));
        } else {
            (cq, ct) = _collectV3(from, to);
        }
        // What the liquidity earned is not new creator fees and pays no LockFi
        // fee. Only that amount is marked: setting the mark to the whole
        // balance would let anyone call this to wave through fees that
        // arrived since the last route.
        feeFreeQuote += cq;
        emit Collected(cq, ct);
    }

    // ── team ──────────────────────────────────────────────────────────────────

    function setPaused(bool p) external onlyTeam {
        paused = p;
        emit PausedSet(p);
    }

    /// While paused, everything not yet routed goes back to the team. Routed
    /// liquidity is not held here and cannot be withdrawn by anyone.
    function withdrawUnrouted(address to) external onlyTeam nonReentrant {
        if (!paused) revert NotPaused();
        uint256 e = address(this).balance;
        uint256 w = weth == address(0) ? 0 : IERC20(weth).balanceOf(address(this));
        uint256 t = IERC20(token).balanceOf(address(this));
        if (w > 0) _transfer(weth, to, w);
        if (t > 0) _transfer(token, to, t);
        if (e > 0) _sendEth(to, e);
        feeFreeQuote = 0;
        emit Withdrawn(to, e, w, t);
    }

    function setTeam(address next) external onlyTeam {
        require(next != address(0));
        team = next;
        emit TeamSet(next);
    }

    // ── v4 ────────────────────────────────────────────────────────────────────

    struct RouteResult {
        uint256 swapIn;
        uint256 tokenOut;
        uint256 quoteAdded;
        uint256 tokenAdded;
        uint128 liquidity;
        int24 lower;
        int24 upper;
        uint160 sqrtP;
    }

    function _routeV4(uint256 minRate) internal returns (RouteResult memory r) {
        uint256 n = _ranges.length;
        uint256 from = n > COLLECT_RECENT ? n - COLLECT_RECENT : 0;
        bytes memory out = poolManager.unlock(abi.encode(uint8(0), from, n, minRate, uint256(0)));
        r = abi.decode(out, (RouteResult));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _lock != 2) revert BadCallback();
        (uint8 mode, uint256 from, uint256 to, uint256 minRate,) =
            abi.decode(data, (uint8, uint256, uint256, uint256, uint256));
        PoolKey memory k = key();

        // collect: a zero-liquidity touch credits each range's earned fees
        int256 d0;
        int256 d1;
        for (uint256 i = from; i < to; i++) {
            Range memory g = _ranges[i];
            (int256 cd,) = poolManager.modifyLiquidity(k, ModifyLiquidityParams(g.lower, g.upper, 0, 0), "");
            d0 += _amt0(cd);
            d1 += _amt1(cd);
        }
        if (mode == 1) {
            _settleV4(currency0, d0);
            _settleV4(currency1, d1);
            (uint256 cq, uint256 ct) = tokenIs0 ? (_pos(d1), _pos(d0)) : (_pos(d0), _pos(d1));
            return abi.encode(cq, ct);
        }

        RouteResult memory r;
        // what is available on each side: held here, plus what the pool owes us
        uint256 quoteHeld = quote == address(0) ? address(this).balance : IERC20(quote).balanceOf(address(this));
        uint256 tokenHeld = IERC20(token).balanceOf(address(this));
        int256 dq = tokenIs0 ? d1 : d0;
        int256 dt = tokenIs0 ? d0 : d1;

        {
            (uint160 sqrtBefore,) = _slot0V4();
            r.swapIn = _swapIn(uint256(int256(quoteHeld) + dq), uint256(int256(tokenHeld) + dt), sqrtBefore);
        }
        if (r.swapIn > 0) {
            bool zeroForOne = !tokenIs0; // quote -> token
            int256 sd = poolManager.swap(
                k,
                SwapParams(
                    zeroForOne,
                    -int256(r.swapIn),
                    zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                ),
                ""
            );
            int256 sq = tokenIs0 ? _amt1(sd) : _amt0(sd);
            int256 st = tokenIs0 ? _amt0(sd) : _amt1(sd);
            // exact input: the pool may take at most swapIn of the quote
            if (sq > 0 || uint256(-sq) > r.swapIn) revert HookOverdraw();
            if (st <= 0) revert Slippage();
            r.tokenOut = uint256(st);
            if (r.tokenOut < FullMath.mulDiv(r.swapIn, minRate, 1e18)) revert Slippage();
            dq += sq;
            dt += st;
        }

        uint256 qMax;
        uint256 tMax;
        (r.sqrtP, r.lower, r.upper, r.liquidity, qMax, tMax) =
            _sizeV4(uint256(int256(quoteHeld) + dq), uint256(int256(tokenHeld) + dt));
        if (r.liquidity > 0) {
            (int256 cd,) = poolManager.modifyLiquidity(
                k, ModifyLiquidityParams(r.lower, r.upper, int256(uint256(r.liquidity)), 0), ""
            );
            int256 lq = tokenIs0 ? _amt1(cd) : _amt0(cd);
            int256 lt = tokenIs0 ? _amt0(cd) : _amt1(cd);
            // what was added, net of any fees the same range had earned
            r.quoteAdded = lq < 0 ? uint256(-lq) : 0;
            r.tokenAdded = lt < 0 ? uint256(-lt) : 0;
            // The liquidity was sized against qMax and tMax, so the pool can ask
            // for at most those (one wei of rounding each). A hook that asks for
            // more is refused here, whatever the router happens to hold.
            if (r.quoteAdded > qMax + 1 || r.tokenAdded > tMax + 1) revert HookOverdraw();
            dq += lq;
            dt += lt;
            if (int256(quoteHeld) + dq < 0 || int256(tokenHeld) + dt < 0) revert HookOverdraw();
            _remember(r.lower, r.upper);
        }
        (int256 f0, int256 f1) = tokenIs0 ? (dt, dq) : (dq, dt);
        _settleV4(currency0, f0);
        _settleV4(currency1, f1);
        return abi.encode(r);
    }

    function _sizeV4(uint256 qAvail, uint256 tAvail)
        internal
        view
        returns (uint160 sqrtP, int24 lower, int24 upper, uint128 liquidity, uint256 qMax, uint256 tMax)
    {
        int24 tick;
        (sqrtP, tick) = _slot0V4();
        (lower, upper) = _range(tick);
        (liquidity, qMax, tMax) = _liquidityFor(sqrtP, lower, upper, qAvail, tAvail);
    }

    function _settleV4(address currency, int256 d) internal {
        if (d < 0) {
            uint256 amt = uint256(-d);
            if (currency == address(0)) {
                poolManager.settle{value: amt}();
            } else {
                poolManager.sync(currency);
                _transfer(currency, address(poolManager), amt);
                poolManager.settle();
            }
        } else if (d > 0) {
            poolManager.take(currency, address(this), uint256(d));
        }
    }

    function _slot0V4() internal view returns (uint160 sqrtPriceX96, int24 tick) {
        bytes32 id = keccak256(abi.encode(key()));
        bytes32 stateSlot = keccak256(abi.encodePacked(id, bytes32(uint256(6))));
        bytes32 data = poolManager.extsload(stateSlot);
        assembly ("memory-safe") {
            sqrtPriceX96 := and(data, 0xffffffffffffffffffffffffffffffffffffffff)
            tick := signextend(2, shr(160, data))
        }
    }

    // ── v3 ────────────────────────────────────────────────────────────────────

    function _routeV3(uint256 minRate) internal returns (RouteResult memory r) {
        uint256 n = _ranges.length;
        _collectV3(n > COLLECT_RECENT ? n - COLLECT_RECENT : 0, n);

        IUniswapV3Pool pool = IUniswapV3Pool(v3Pool);
        (uint160 sqrtBefore,,,,,,) = pool.slot0();
        r.swapIn = _swapIn(IERC20(weth).balanceOf(address(this)), tokenBalance(), sqrtBefore);
        if (r.swapIn > 0) {
            bool zeroForOne = !tokenIs0;
            _maxPay = r.swapIn;
            (int256 a0, int256 a1) = pool.swap(
                address(this),
                zeroForOne,
                int256(r.swapIn),
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
                ""
            );
            _maxPay = 0;
            int256 out = tokenIs0 ? a0 : a1;
            if (out >= 0) revert Slippage();
            r.tokenOut = uint256(-out);
            if (r.tokenOut < FullMath.mulDiv(r.swapIn, minRate, 1e18)) revert Slippage();
        }

        int24 tick;
        (r.sqrtP, tick,,,,,) = pool.slot0();
        (r.lower, r.upper) = _range(tick);
        uint256 qBefore = IERC20(weth).balanceOf(address(this));
        uint256 tBefore = tokenBalance();
        (r.liquidity,,) = _liquidityFor(r.sqrtP, r.lower, r.upper, qBefore, tBefore);
        if (r.liquidity > 0) {
            _minting = true;
            pool.mint(address(this), r.lower, r.upper, r.liquidity, "");
            _minting = false;
            r.quoteAdded = qBefore - IERC20(weth).balanceOf(address(this));
            r.tokenAdded = tBefore - tokenBalance();
            _remember(r.lower, r.upper);
        }
    }

    function _collectV3(uint256 from, uint256 to) internal returns (uint256 cq, uint256 ct) {
        IUniswapV3Pool pool = IUniswapV3Pool(v3Pool);
        for (uint256 i = from; i < to; i++) {
            Range memory g = _ranges[i];
            pool.burn(g.lower, g.upper, 0);
            (uint128 c0, uint128 c1) =
                pool.collect(address(this), g.lower, g.upper, type(uint128).max, type(uint128).max);
            if (tokenIs0) {
                ct += c0;
                cq += c1;
            } else {
                cq += c0;
                ct += c1;
            }
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != v3Pool || _lock != 2 || _maxPay == 0) revert BadCallback();
        // the quote side is what we pay; the token side is what we receive
        int256 pay = tokenIs0 ? amount1Delta : amount0Delta;
        if (pay <= 0 || uint256(pay) > _maxPay) revert HookOverdraw();
        _transfer(weth, msg.sender, uint256(pay));
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (msg.sender != v3Pool || _lock != 2 || !_minting) revert BadCallback();
        if (amount0Owed > 0) _transfer(currency0, msg.sender, amount0Owed);
        if (amount1Owed > 0) _transfer(currency1, msg.sender, amount1Owed);
    }

    function _slot0V3() internal view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick,,,,,) = IUniswapV3Pool(v3Pool).slot0();
    }

    // ── shared maths ──────────────────────────────────────────────────────────

    /// ETH to swap so what is left balances what is bought, after the swap's
    /// own price impact and fee: the constant-product optimal swap,
    ///   s = (√(R²(2−f)² + 4R·a(1−f)) − R(2−f)) / (2(1−f)),
    /// on the pool's virtual reserve R of the quote at the active liquidity,
    /// for `a`, the ETH in excess of the token already held. Exact for a full
    /// range in a full-range pool; otherwise close, and whatever is left over
    /// waits for the next route. Falls back to half the excess when the pool's
    /// figures are out of the formula's range.
    function _swapIn(uint256 q, uint256 t, uint160 sqrtP) internal view returns (uint256) {
        if (sqrtP == 0) return 0;
        uint256 tValue = tokenIs0
            ? FullMath.mulDiv(FullMath.mulDiv(t, sqrtP, 1 << 96), sqrtP, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(t, 1 << 96, sqrtP), 1 << 96, sqrtP);
        if (q <= tValue) return 0;
        uint256 a = q - tValue;
        uint256 L = _poolLiquidity();
        // quote is currency1 when the token is currency0: R1 = L·√P; else R0 = L/√P
        uint256 R = tokenIs0 ? FullMath.mulDiv(L, sqrtP, 1 << 96) : FullMath.mulDiv(L, 1 << 96, sqrtP);
        uint256 f = isV4 && (poolFee & 0x800000) != 0 ? 0 : poolFee; // dynamic fee: unknown, taken as none
        if (R == 0 || R > 1 << 100 || a > 1 << 100 || f >= 1_000_000) return a / 2;
        uint256 F = 1_000_000 - f; // (1 − f), in millionths
        uint256 twoMinusF = 1_000_000 + F; // (2 − f), in millionths
        uint256 root = _sqrt(R * R * twoMinusF * twoMinusF + 4 * R * a * F * 1_000_000);
        uint256 base = R * twoMinusF;
        if (root <= base) return 0;
        uint256 s = (root - base) / (2 * F);
        return s < a ? s : a / 2;
    }

    /// The pool's liquidity active at the current price.
    function _poolLiquidity() internal view returns (uint256) {
        if (!isV4) return IUniswapV3PoolLiquidity(v3Pool).liquidity();
        bytes32 id = keccak256(abi.encode(key()));
        bytes32 stateSlot = keccak256(abi.encodePacked(id, bytes32(uint256(6))));
        return uint128(uint256(poolManager.extsload(bytes32(uint256(stateSlot) + 3))));
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = x / 2 + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }

    function _range(int24 tick) internal view returns (int24 lower, int24 upper) {
        int24 s = tickSpacing;
        int24 minT = (TickMath.MIN_TICK / s) * s;
        int24 maxT = (TickMath.MAX_TICK / s) * s;
        if (!narrow) return (minT, maxT);
        // pool price is token1 per token0; the token's price is its inverse
        // when the token is currency1, so the wider side flips with it
        int24 down = tokenIs0 ? TICKS_DOWN_20 : TICKS_UP_20;
        int24 up = tokenIs0 ? TICKS_UP_20 : TICKS_DOWN_20;
        lower = _floor(tick - down, s);
        upper = _ceil(tick + up, s);
        if (lower < minT) lower = minT;
        if (upper > maxT) upper = maxT;
        if (upper <= lower) upper = lower + s;
    }

    function _floor(int24 t, int24 s) internal pure returns (int24) {
        int24 c = t / s;
        if (t < 0 && t % s != 0) c--;
        return c * s;
    }

    function _ceil(int24 t, int24 s) internal pure returns (int24) {
        int24 c = t / s;
        if (t > 0 && t % s != 0) c++;
        return c * s;
    }

    /// The liquidity the two sides buy in [lower, upper), with a hair left
    /// over for rounding, so the pool never asks for a wei more than is held.
    /// Also returns the two amounts it was sized against, quote then token:
    /// the most that liquidity may cost, which a v4 route holds a hook to.
    function _liquidityFor(uint160 sqrtP, int24 lower, int24 upper, uint256 qAvail, uint256 tAvail)
        internal
        view
        returns (uint128 liquidity, uint256 qMax, uint256 tMax)
    {
        qMax = qAvail > 2 ? qAvail - qAvail / 100_000 - 2 : 0;
        tMax = tAvail > 2 ? tAvail - tAvail / 100_000 - 2 : 0;
        if (qMax == 0 && tMax == 0) return (0, 0, 0);
        (uint256 a0, uint256 a1) = tokenIs0 ? (tMax, qMax) : (qMax, tMax);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), a0, a1
        );
    }

    function _remember(int24 lower, int24 upper) internal {
        bytes32 h = keccak256(abi.encode(lower, upper));
        if (!_seen[h]) {
            _seen[h] = true;
            _ranges.push(Range(lower, upper));
        }
    }

    function _amt0(int256 d) internal pure returns (int256 a) {
        assembly ("memory-safe") {
            a := sar(128, d)
        }
    }

    function _amt1(int256 d) internal pure returns (int256 a) {
        assembly ("memory-safe") {
            a := signextend(15, d)
        }
    }

    function _pos(int256 d) internal pure returns (uint256) {
        return d > 0 ? uint256(d) : 0;
    }

    function _transfer(address t, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = t.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
