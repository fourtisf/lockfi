// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Position} from "v4-core/libraries/Position.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {Settlement} from "./libraries/Settlement.sol";

/// @title TidewellVault
/// @notice One vault per Uniswap v4 pool. Stakers' liquidity sits in a single
///         full-range position the vault owns in the PoolManager. Every swap
///         fee that position earns belongs to the shares that earned it: fees
///         are credited per share at the moment they are collected, and any
///         staker can claim theirs, in the pool's own two tokens, at any time —
///         including after they have withdrawn.
///
/// Why per share, not a stream (CLAUDE.md §20). The first version pooled fees
/// and streamed each harvest over seven days to whoever held shares then. A
/// pre-audit review proved that let a large deposit made just before a harvest
/// take most of the fees others had earned, and made an early exit forfeit fees
/// the leaver's own stake had earned — an exit fee in all but name. Crediting
/// at collection removes both: any change to the position (a deposit, a
/// withdraw, a claim, a poke) first collects everything the position has
/// earned and credits it to the shares that existed while it was earned.
///
/// What this contract will never do (CLAUDE.md §1, §3.3):
///   - No admin withdraw. Only `withdraw` moves liquidity, only for the
///     caller's own shares, and only `claim` moves a staker's fees.
///   - No pause that traps funds. The owner can close NEW deposits; withdraw
///     and claim are never gated.
///   - No upgrade path. No proxy, no delegatecall.
///   - No fee on principal. The protocol fee is a share of fees collected, and
///     its ceiling is fixed at construction (at most 20%) and cannot be raised.
///   - No swap. Fees are paid in the tokens they were earned in, so there is
///     no price at which anyone could be made to sell them.
///
/// Collected fees are held as the PoolManager's own ERC-6909 claims, never as
/// tokens at this address, and paid out from the PoolManager straight to the
/// claimant. A token issuer freezing this vault's address therefore cannot
/// block any withdraw or claim.
///
/// Shares are liquidity units: depositing L liquidity mints L shares. There is
/// no exchange rate to manipulate and no first-depositor attack.
contract TidewellVault is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    /// @notice The absolute ceiling on any vault's protocol fee: 20% of fees.
    uint16 public constant MAX_PROTOCOL_FEE_CAP_BPS = 2000;
    uint256 private constant BPS = 10_000;
    uint256 private constant Q128 = 1 << 128;

    IPoolManager public immutable poolManager;
    PoolId public immutable poolId;
    Currency public immutable currency0;
    Currency public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    /// @notice This vault's protocol fee ceiling, fixed forever at deploy.
    uint16 public immutable protocolFeeCapBps;
    bytes32 private immutable positionKey;

    address public owner;
    address public pendingOwner;
    /// @notice Where the protocol's share of fees is paid.
    address public treasury;
    uint16 public protocolFeeBps;
    bool public depositsOpen = true;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    /// @notice Stakers' fees per share since deployment, ×2^128, per token.
    uint256 public feePerShare0X128;
    uint256 public feePerShare1X128;
    mapping(address => uint256) private feePerSharePaid0X128;
    mapping(address => uint256) private feePerSharePaid1X128;
    /// @dev Fees owed, ×2^128. Keeping the remainder below one unit is what
    ///      makes claiming often pay exactly what claiming once pays.
    mapping(address => uint256) private owed0X128;
    mapping(address => uint256) private owed1X128;

    /// @notice The protocol's share, collected and not yet paid to the treasury.
    uint256 public protocolOwed0;
    uint256 public protocolOwed1;

    uint256 private locked = 1;

    event Deposited(address indexed sender, address indexed recipient, uint256 liquidity, uint256 amount0, uint256 amount1);
    event Withdrawn(address indexed account, address indexed recipient, uint256 liquidity, uint256 amount0, uint256 amount1);
    event FeesCollected(uint256 amount0, uint256 amount1, uint256 protocolCut0, uint256 protocolCut1);
    event Claimed(address indexed account, address indexed recipient, uint256 amount0, uint256 amount1);
    event ProtocolFeesPaid(address indexed treasury, uint256 amount0, uint256 amount1);
    event TreasurySet(address treasury);
    event ProtocolFeeSet(uint16 bps);
    event DepositsOpenSet(bool open);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPoolManager();
    error Reentrancy();
    error Expired();
    error DepositsClosed();
    error ZeroLiquidity();
    error ZeroAddress();
    error InsufficientShares();
    error Slippage();
    error WrongValue();
    error FeeAboveCap();
    error CapAboveMaximum();
    error UnsupportedPool();
    error PoolNotInitialized();
    error Insolvent();
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

    modifier checkDeadline(uint256 deadline) {
        // A timestamp, never a block number: ~100ms blocks (§2).
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    /// @param key The pool. It must have no hooks: a hook can rewrite
    ///        liquidity deltas, and a vault holding other people's liquidity
    ///        does not sit behind code it cannot see.
    /// @param protocolFeeCapBps_ Ceiling on the protocol fee, forever. At most
    ///        MAX_PROTOCOL_FEE_CAP_BPS (2000 = 20%).
    /// @param protocolFeeBps_ The starting fee, at most the cap (spec: 1000).
    constructor(
        IPoolManager poolManager_,
        PoolKey memory key,
        address owner_,
        address treasury_,
        uint16 protocolFeeCapBps_,
        uint16 protocolFeeBps_
    ) {
        if (owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (protocolFeeCapBps_ > MAX_PROTOCOL_FEE_CAP_BPS) revert CapAboveMaximum();
        if (protocolFeeBps_ > protocolFeeCapBps_) revert FeeAboveCap();
        if (address(key.hooks) != address(0)) revert UnsupportedPool();

        poolManager = poolManager_;
        poolId = key.toId();
        currency0 = key.currency0;
        currency1 = key.currency1;
        fee = key.fee;
        tickSpacing = key.tickSpacing;
        tickLower = TickMath.minUsableTick(key.tickSpacing);
        tickUpper = TickMath.maxUsableTick(key.tickSpacing);
        protocolFeeCapBps = protocolFeeCapBps_;
        protocolFeeBps = protocolFeeBps_;
        owner = owner_;
        treasury = treasury_;
        positionKey = Position.calculatePositionKey(address(this), tickLower, tickUpper, bytes32(0));

        (uint160 sqrtPriceX96,,,) = poolManager_.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        emit OwnershipTransferred(address(0), owner_);
        emit TreasurySet(treasury_);
        emit ProtocolFeeSet(protocolFeeBps_);
    }

    /// @dev Native ETH reaches this contract only as msg.value on a deposit;
    ///      everything it pays out goes from the PoolManager to the recipient.
    receive() external payable {
        revert UnexpectedEth();
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(0))
        });
    }

    /// @notice The liquidity this vault holds in the PoolManager. Always
    ///         equal to totalSupply.
    function positionLiquidity() public view returns (uint128) {
        return poolManager.getPositionLiquidity(poolId, positionKey);
    }

    /// @notice What `account` can claim right now, in each token — including
    ///         fees the position has earned since they were last collected.
    function claimable(address account) external view returns (uint256 amount0, uint256 amount1) {
        (uint256 p0, uint256 p1) = _feePerShareNow();
        uint256 b = balanceOf[account];
        amount0 = (owed0X128[account] + b * (p0 - feePerSharePaid0X128[account])) / Q128;
        amount1 = (owed1X128[account] + b * (p1 - feePerSharePaid1X128[account])) / Q128;
    }

    /// @notice Fees already collected and credited to `account`, in each
    ///         token — what `claim` pays without new fees arriving.
    function owed(address account) external view returns (uint256 amount0, uint256 amount1) {
        uint256 b = balanceOf[account];
        amount0 = (owed0X128[account] + b * (feePerShare0X128 - feePerSharePaid0X128[account])) / Q128;
        amount1 = (owed1X128[account] + b * (feePerShare1X128 - feePerSharePaid1X128[account])) / Q128;
    }

    /// @notice What `liquidity` shares are worth in each token at the current
    ///         price, rounded down — what a withdraw would return.
    function amountsForLiquidity(uint128 liquidity) public view returns (uint256 amount0, uint256 amount1) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        (amount0, amount1) = _amounts(sqrtPriceX96, liquidity, false);
    }

    /// @notice The liquidity a deposit of these amounts mints, and what it
    ///         would actually take of each.
    function previewDeposit(uint256 amount0Desired, uint256 amount1Desired)
        external
        view
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        liquidity = _liquidityFor(sqrtPriceX96, amount0Desired, amount1Desired);
        (amount0, amount1) = _amounts(sqrtPriceX96, liquidity, true);
    }

    // -----------------------------------------------------------------------
    // Staking
    // -----------------------------------------------------------------------

    /// @notice Add liquidity to the vault's position and receive shares.
    /// @dev ERC20 sides are pulled from msg.sender (approve this vault first).
    ///      A native-ETH side is paid from msg.value, which must equal its
    ///      desired amount; what is not used is refunded to msg.sender.
    function deposit(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address recipient,
        uint256 deadline
    ) external payable nonReentrant checkDeadline(deadline) returns (uint128 liquidity, uint256 amount0, uint256 amount1) {
        if (!depositsOpen) revert DepositsClosed();
        if (recipient == address(0)) revert ZeroAddress();
        bool native = currency0.isAddressZero();
        if (native ? msg.value != amount0Desired : msg.value != 0) revert WrongValue();

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        liquidity = _liquidityFor(sqrtPriceX96, amount0Desired, amount1Desired);
        if (liquidity == 0) revert ZeroLiquidity();

        bytes memory result = poolManager.unlock(abi.encode(Action.Deposit, msg.sender, recipient, liquidity));
        (amount0, amount1) = abi.decode(result, (uint256, uint256));
        if (amount0 > amount0Desired || amount1 > amount1Desired) revert Slippage();
        if (amount0 < amount0Min || amount1 < amount1Min) revert Slippage();

        if (native && msg.value > amount0) currency0.transfer(msg.sender, msg.value - amount0);
        emit Deposited(msg.sender, recipient, liquidity, amount0, amount1);
    }

    /// @notice Remove `liquidity` of your shares. Always available: no lockup,
    ///         no exit fee, no timelock, no pause. Fees your shares earned stay
    ///         yours to claim, now or later.
    function withdraw(uint128 liquidity, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)
        public
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        if (liquidity == 0) revert ZeroLiquidity();
        if (recipient == address(0)) revert ZeroAddress();
        if (balanceOf[msg.sender] < liquidity) revert InsufficientShares();

        bytes memory result = poolManager.unlock(abi.encode(Action.Withdraw, msg.sender, recipient, liquidity));
        (amount0, amount1) = abi.decode(result, (uint256, uint256));
        if (amount0 < amount0Min || amount1 < amount1Min) revert Slippage();
        emit Withdrawn(msg.sender, recipient, liquidity, amount0, amount1);
    }

    /// @notice Pay your fees to `recipient`, in both tokens. With nothing
    ///         owed it pays nothing and does not revert.
    function claim(address recipient) public nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (recipient == address(0)) revert ZeroAddress();
        bytes memory result = poolManager.unlock(abi.encode(Action.Claim, msg.sender, recipient, uint128(0)));
        (amount0, amount1) = abi.decode(result, (uint256, uint256));
        emit Claimed(msg.sender, recipient, amount0, amount1);
    }

    /// @notice Withdraw everything and claim, in one call.
    function exit(uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)
        external
        returns (uint256 amount0, uint256 amount1, uint256 fees0, uint256 fees1)
    {
        uint256 shares = balanceOf[msg.sender];
        if (shares > 0) (amount0, amount1) = withdraw(uint128(shares), amount0Min, amount1Min, recipient, deadline);
        (fees0, fees1) = claim(recipient);
    }

    /// @notice Collect the position's fees and credit them to the shares that
    ///         earned them. Anyone may call; nothing depends on it — every
    ///         deposit, withdraw and claim does the same first.
    function poke() external nonReentrant {
        poolManager.unlock(abi.encode(Action.Poke, address(0), address(0), uint128(0)));
    }

    /// @notice Pay the protocol's share to the treasury. Anyone may call.
    function payProtocolFees() external nonReentrant returns (uint256 amount0, uint256 amount1) {
        address to = treasury;
        bytes memory result = poolManager.unlock(abi.encode(Action.Protocol, address(0), to, uint128(0)));
        (amount0, amount1) = abi.decode(result, (uint256, uint256));
        emit ProtocolFeesPaid(to, amount0, amount1);
    }

    // -----------------------------------------------------------------------
    // Owner (no path to staker funds)
    // -----------------------------------------------------------------------

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Change the fee on fees collected from now on, never above the
    ///         cap fixed at deploy. Fees earned so far are cut at the old rate.
    function setProtocolFee(uint16 bps) external onlyOwner nonReentrant {
        if (bps > protocolFeeCapBps) revert FeeAboveCap();
        if (totalSupply > 0) poolManager.unlock(abi.encode(Action.Poke, address(0), address(0), uint128(0)));
        protocolFeeBps = bps;
        emit ProtocolFeeSet(bps);
    }

    /// @notice Close or reopen NEW deposits. Withdraw and claim are unaffected.
    function setDepositsOpen(bool open) external onlyOwner {
        depositsOpen = open;
        emit DepositsOpenSet(open);
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
    // PoolManager callback
    // -----------------------------------------------------------------------

    enum Action {
        Deposit,
        Withdraw,
        Claim,
        Poke,
        Protocol
    }

    /// @dev Only the PoolManager calls this, and only during this vault's own
    ///      `unlock` — the PoolManager calls back whoever unlocked it.
    ///      `account` is msg.sender of the outer call (the payer, for a
    ///      deposit); `recipient` is who receives shares, tokens or fees.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, address account, address recipient, uint128 liquidity) =
            abi.decode(data, (Action, address, address, uint128));

        // 1. Collect what the position has earned and credit it to the
        //    shares as they stand before this action changes anything.
        _collectInside();

        if (action == Action.Poke) return "";
        if (action == Action.Protocol) return _payProtocol(recipient);

        // 2. Bring the holder's fees up to date before their shares change:
        //    for a deposit the holder is the recipient of the new shares.
        address holder = action == Action.Deposit ? recipient : account;
        _accrue(holder);
        if (action == Action.Claim) return _pay(holder, recipient);

        // 3. Shares change, then the position: the position is never larger
        //    than totalSupply, not even inside this call.
        if (action == Action.Deposit) {
            balanceOf[holder] += liquidity;
            totalSupply += liquidity;
            (BalanceDelta delta,) = poolManager.modifyLiquidity(poolKey(), _params(int256(uint256(liquidity))), "");
            uint256 owed0 = uint256(-int256(delta.amount0()));
            uint256 owed1 = uint256(-int256(delta.amount1()));
            Settlement.pay(poolManager, currency0, currency0.isAddressZero() ? address(this) : account, owed0);
            Settlement.pay(poolManager, currency1, account, owed1);
            return abi.encode(owed0, owed1);
        }
        balanceOf[holder] -= liquidity;
        totalSupply -= liquidity;
        (BalanceDelta out,) = poolManager.modifyLiquidity(poolKey(), _params(-int256(uint256(liquidity))), "");
        uint256 out0 = uint256(int256(out.amount0()));
        uint256 out1 = uint256(int256(out.amount1()));
        Settlement.collect(poolManager, currency0, recipient, out0);
        Settlement.collect(poolManager, currency1, recipient, out1);
        return abi.encode(out0, out1);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    function _params(int256 liquidityDelta) private view returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: 0});
    }

    /// @dev Collect the position's fees as ERC-6909 claims and credit them:
    ///      the protocol's share at the current rate, the rest per share.
    ///      With no shares there is no liquidity, so nothing was earned.
    ///      Within one call fee growth cannot move between this collection and
    ///      the liquidity change that follows (nothing swaps in between), so the
    ///      later modifyLiquidity carries no fees: its delta is all principal.
    function _collectInside() private {
        if (totalSupply == 0) return;
        (, BalanceDelta fees) = poolManager.modifyLiquidity(poolKey(), _params(0), "");
        uint256 f0 = uint256(int256(fees.amount0()));
        uint256 f1 = uint256(int256(fees.amount1()));
        if (f0 == 0 && f1 == 0) return;
        uint256 cut0 = f0 * protocolFeeBps / BPS;
        uint256 cut1 = f1 * protocolFeeBps / BPS;
        if (f0 > 0) {
            poolManager.mint(address(this), currency0.toId(), f0);
            protocolOwed0 += cut0;
            feePerShare0X128 += FullMath.mulDiv(f0 - cut0, Q128, totalSupply);
        }
        if (f1 > 0) {
            poolManager.mint(address(this), currency1.toId(), f1);
            protocolOwed1 += cut1;
            feePerShare1X128 += FullMath.mulDiv(f1 - cut1, Q128, totalSupply);
        }
        emit FeesCollected(f0, f1, cut0, cut1);
    }

    function _accrue(address account) private {
        uint256 b = balanceOf[account];
        uint256 p0 = feePerShare0X128;
        uint256 p1 = feePerShare1X128;
        if (b > 0) {
            owed0X128[account] += b * (p0 - feePerSharePaid0X128[account]);
            owed1X128[account] += b * (p1 - feePerSharePaid1X128[account]);
        }
        feePerSharePaid0X128[account] = p0;
        feePerSharePaid1X128[account] = p1;
    }

    /// @dev Pay an account's fees from the vault's claims, straight from the
    ///      PoolManager to the recipient.
    function _pay(address account, address recipient) private returns (bytes memory) {
        uint256 a0 = owed0X128[account] / Q128;
        uint256 a1 = owed1X128[account] / Q128;
        owed0X128[account] -= a0 * Q128;
        owed1X128[account] -= a1 * Q128;
        _payOut(currency0, recipient, a0);
        _payOut(currency1, recipient, a1);
        return abi.encode(a0, a1);
    }

    function _payProtocol(address to) private returns (bytes memory) {
        uint256 a0 = protocolOwed0;
        uint256 a1 = protocolOwed1;
        protocolOwed0 = 0;
        protocolOwed1 = 0;
        _payOut(currency0, to, a0);
        _payOut(currency1, to, a1);
        return abi.encode(a0, a1);
    }

    function _payOut(Currency currency, address to, uint256 amount) private {
        if (amount == 0) return;
        if (poolManager.balanceOf(address(this), currency.toId()) < amount) revert Insolvent();
        poolManager.burn(address(this), currency.toId(), amount);
        poolManager.take(currency, to, amount);
    }

    /// @dev Fees per share including what the position has earned and not yet
    ///      had collected, from the PoolManager's fee growth — for the view.
    function _feePerShareNow() private view returns (uint256 p0, uint256 p1) {
        p0 = feePerShare0X128;
        p1 = feePerShare1X128;
        uint256 supply = totalSupply;
        if (supply == 0) return (p0, p1);
        (uint128 liq, uint256 last0, uint256 last1) =
            poolManager.getPositionInfo(poolId, address(this), tickLower, tickUpper, bytes32(0));
        (uint256 now0, uint256 now1) = poolManager.getFeeGrowthInside(poolId, tickLower, tickUpper);
        uint256 f0;
        uint256 f1;
        unchecked {
            // Fee growth is allowed to wrap, as the PoolManager computes it.
            f0 = FullMath.mulDiv(now0 - last0, liq, Q128);
            f1 = FullMath.mulDiv(now1 - last1, liq, Q128);
        }
        p0 += FullMath.mulDiv(f0 - f0 * protocolFeeBps / BPS, Q128, supply);
        p1 += FullMath.mulDiv(f1 - f1 * protocolFeeBps / BPS, Q128, supply);
    }

    function _liquidityFor(uint160 sqrtPriceX96, uint256 amount0, uint256 amount1) private view returns (uint128) {
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount0, amount1
        );
    }

    function _amounts(uint160 sqrtPriceX96, uint128 liquidity, bool roundUp)
        private
        view
        returns (uint256 amount0, uint256 amount1)
    {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        // Full range: the price is always strictly inside it.
        amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, sqrtB, liquidity, roundUp);
        amount1 = SqrtPriceMath.getAmount1Delta(sqrtA, sqrtPriceX96, liquidity, roundUp);
    }
}
