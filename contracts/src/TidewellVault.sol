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
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {Position} from "v4-core/libraries/Position.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {IWETH9} from "./interfaces/IWETH9.sol";
import {Settlement} from "./libraries/Settlement.sol";

/// @title TidewellVault
/// @notice One vault per Uniswap v4 pool. Stakers' liquidity sits in a single
///         full-range position the vault owns in the PoolManager; the swap
///         fees it earns are harvested, converted to WETH, and streamed back
///         to stakers over seven days (the Synthetix StakingRewards pattern).
///
/// What this contract will never do (CLAUDE.md §1, §3.3):
///   - No admin withdraw. Nothing but `withdraw` moves a staker's liquidity,
///     and only the staker can call it for their own shares.
///   - No pause that traps funds. The owner can close *new* deposits;
///     withdraw and claim are never gated.
///   - No upgrade path. There is no proxy and no delegatecall.
///   - No fee on principal. The protocol fee is a share of harvested fees,
///     and its ceiling is fixed at construction (at most 20%) and cannot be
///     raised by anyone.
///
/// Shares are liquidity units: depositing L liquidity mints L shares, so
/// there is no exchange rate to manipulate and no first-depositor attack.
contract TidewellVault is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // -----------------------------------------------------------------------
    // Constants and immutables
    // -----------------------------------------------------------------------

    /// @notice How long one harvest's rewards stream for (§3.3).
    uint256 public constant REWARDS_DURATION = 7 days;
    /// @notice The absolute ceiling on any vault's protocol fee: 20% of fees.
    uint16 public constant MAX_PROTOCOL_FEE_CAP_BPS = 2000;
    uint256 private constant BPS = 10_000;
    uint256 private constant PRECISION = 1e18;

    IPoolManager public immutable poolManager;
    IWETH9 public immutable weth;
    PoolId public immutable poolId;
    Currency public immutable currency0;
    Currency public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    /// @notice Which currency is ETH (native or WETH): 0 or 1.
    uint8 public immutable ethIndex;
    /// @notice True when the ETH side is native ETH (address(0)), not WETH.
    bool public immutable ethIsNative;
    /// @notice This vault's protocol fee ceiling, fixed forever at deploy.
    uint16 public immutable protocolFeeCapBps;
    bytes32 private immutable positionKey;

    // -----------------------------------------------------------------------
    // Roles and settings
    // -----------------------------------------------------------------------

    address public owner;
    address public pendingOwner;
    /// @notice The only address that can trigger a harvest. It never holds or
    ///         receives funds; it chooses when, and the minimum swap output.
    address public keeper;
    /// @notice Where the protocol's share of harvested fees goes.
    address public treasury;
    uint16 public protocolFeeBps;
    bool public depositsOpen = true;

    // -----------------------------------------------------------------------
    // Shares
    // -----------------------------------------------------------------------

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    // -----------------------------------------------------------------------
    // Reward stream (WETH)
    // -----------------------------------------------------------------------

    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    /// @notice WETH waiting for the next stream: the rounding remainder of
    ///         `reward / duration`, and anything that streamed while nobody
    ///         was staked. Folded into the next harvest, never lost.
    uint256 public queuedRewards;
    /// @notice Every WETH committed to stakers and not yet paid. The vault's
    ///         WETH balance never falls below this.
    uint256 public rewardsReserved;
    mapping(address => uint256) public userRewardPerTokenPaid;
    /// @dev Earned rewards scaled by 1e18. Keeping the remainder below one wei
    ///      is what makes a staker who claims every hour receive exactly what
    ///      one who never claims receives (§3.5).
    mapping(address => uint256) private rewardsScaled;

    // -----------------------------------------------------------------------
    // Fees collected but not yet harvested
    // -----------------------------------------------------------------------

    /// @notice ETH-side fees held (native ETH or WETH, matching the pool).
    uint256 public pendingEthFees;
    /// @notice Token-side fees held, converted to ETH at the next harvest.
    uint256 public pendingTokenFees;

    uint256 private locked = 1;

    // -----------------------------------------------------------------------
    // Events and errors
    // -----------------------------------------------------------------------

    event Deposited(address indexed sender, address indexed recipient, uint256 liquidity, uint256 amount0, uint256 amount1);
    event Withdrawn(address indexed account, address indexed recipient, uint256 liquidity, uint256 amount0, uint256 amount1);
    event RewardPaid(address indexed account, address indexed recipient, uint256 amount);
    event FeesCollected(uint256 ethFees, uint256 tokenFees);
    event Harvested(uint256 ethFees, uint256 tokenFeesSold, uint256 ethFromTokens, uint256 protocolCut, uint256 reward);
    event RewardAdded(uint256 reward, uint256 rewardRate, uint256 periodFinish);
    event KeeperSet(address keeper);
    event TreasurySet(address treasury);
    event ProtocolFeeSet(uint16 bps);
    event DepositsOpenSet(bool open);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotKeeper();
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

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// @param key            The pool. It must have no hooks, and exactly one
    ///                       side must be ETH (native) or WETH: rewards are
    ///                       paid in WETH and fees convert through that side.
    /// @param protocolFeeCapBps_ Ceiling on the protocol fee, forever. At most
    ///                       MAX_PROTOCOL_FEE_CAP_BPS (2000 = 20%).
    /// @param protocolFeeBps_ The starting fee, at most the cap (spec: 1000).
    constructor(
        IPoolManager poolManager_,
        IWETH9 weth_,
        PoolKey memory key,
        address owner_,
        address keeper_,
        address treasury_,
        uint16 protocolFeeCapBps_,
        uint16 protocolFeeBps_
    ) {
        if (owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (protocolFeeCapBps_ > MAX_PROTOCOL_FEE_CAP_BPS) revert CapAboveMaximum();
        if (protocolFeeBps_ > protocolFeeCapBps_) revert FeeAboveCap();
        // A hook can rewrite liquidity deltas; a vault holding other people's
        // liquidity does not sit behind code it cannot see.
        if (address(key.hooks) != address(0)) revert UnsupportedPool();

        address wethAddr = address(weth_);
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool eth0 = c0 == address(0) || c0 == wethAddr;
        bool eth1 = c1 == wethAddr;
        if (eth0 == eth1) revert UnsupportedPool(); // neither side, or ETH/WETH

        poolManager = poolManager_;
        weth = weth_;
        poolId = key.toId();
        currency0 = key.currency0;
        currency1 = key.currency1;
        fee = key.fee;
        tickSpacing = key.tickSpacing;
        tickLower = TickMath.minUsableTick(key.tickSpacing);
        tickUpper = TickMath.maxUsableTick(key.tickSpacing);
        ethIndex = eth0 ? 0 : 1;
        ethIsNative = c0 == address(0);
        protocolFeeCapBps = protocolFeeCapBps_;
        protocolFeeBps = protocolFeeBps_;
        owner = owner_;
        keeper = keeper_;
        treasury = treasury_;
        positionKey = Position.calculatePositionKey(address(this), tickLower, tickUpper, bytes32(0));

        (uint160 sqrtPriceX96,,,) = poolManager_.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        emit OwnershipTransferred(address(0), owner_);
        emit KeeperSet(keeper_);
        emit TreasurySet(treasury_);
        emit ProtocolFeeSet(protocolFeeBps_);
    }

    /// @dev Native ETH arrives from the PoolManager (fees, withdrawals routed
    ///      through the vault) and from WETH unwraps. Nothing else.
    receive() external payable {
        if (msg.sender != address(poolManager) && msg.sender != address(weth)) revert UnexpectedEth();
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
    function positionLiquidity() external view returns (uint128) {
        return poolManager.getPositionLiquidity(poolId, positionKey);
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalSupply == 0) return rewardPerTokenStored;
        uint256 applicable = lastTimeRewardApplicable();
        if (applicable <= lastUpdateTime) return rewardPerTokenStored;
        return rewardPerTokenStored + (applicable - lastUpdateTime) * rewardRate * PRECISION / totalSupply;
    }

    /// @notice WETH `account` can claim right now.
    function earned(address account) public view returns (uint256) {
        return _scaledEarned(account, rewardPerToken()) / PRECISION;
    }

    /// @notice WETH the current stream pays over its full seven days.
    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * REWARDS_DURATION;
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
    /// @param amount0Min,amount1Min Slippage bounds on what is actually taken.
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
        if (ethIsNative) {
            if (msg.value != amount0Desired) revert WrongValue();
        } else if (msg.value != 0) {
            revert WrongValue();
        }

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        liquidity = _liquidityFor(sqrtPriceX96, amount0Desired, amount1Desired);
        if (liquidity == 0) revert ZeroLiquidity();

        _updateReward(recipient);

        bytes memory result = poolManager.unlock(abi.encode(Action.Deposit, msg.sender, liquidity));
        (amount0, amount1) = abi.decode(result, (uint256, uint256));
        if (amount0 > amount0Desired || amount1 > amount1Desired) revert Slippage();
        if (amount0 < amount0Min || amount1 < amount1Min) revert Slippage();

        balanceOf[recipient] += liquidity;
        totalSupply += liquidity;

        if (ethIsNative && msg.value > amount0) {
            Currency.wrap(address(0)).transfer(msg.sender, msg.value - amount0);
        }
        emit Deposited(msg.sender, recipient, liquidity, amount0, amount1);
    }

    /// @notice Remove `liquidity` of your shares from the position. Always
    ///         available: no lockup, no exit fee, no timelock, no pause.
    function withdraw(uint128 liquidity, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)
        public
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        if (liquidity == 0) revert ZeroLiquidity();
        if (recipient == address(0)) revert ZeroAddress();
        if (balanceOf[msg.sender] < liquidity) revert InsufficientShares();

        _updateReward(msg.sender);
        balanceOf[msg.sender] -= liquidity;
        totalSupply -= liquidity;

        bytes memory result = poolManager.unlock(abi.encode(Action.Withdraw, recipient, liquidity));
        (amount0, amount1) = abi.decode(result, (uint256, uint256));
        if (amount0 < amount0Min || amount1 < amount1Min) revert Slippage();
        emit Withdrawn(msg.sender, recipient, liquidity, amount0, amount1);
    }

    /// @notice Send your earned WETH to `recipient`. Never reverts for want of
    ///         rewards: with nothing earned it pays nothing.
    function claim(address recipient) public nonReentrant returns (uint256 amount) {
        if (recipient == address(0)) revert ZeroAddress();
        amount = _claim(msg.sender, recipient);
    }

    /// @notice Withdraw everything and claim, in one call.
    function exit(uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)
        external
        returns (uint256 amount0, uint256 amount1, uint256 reward)
    {
        uint256 shares = balanceOf[msg.sender];
        if (shares > 0) {
            (amount0, amount1) = withdraw(uint128(shares), amount0Min, amount1Min, recipient, deadline);
        }
        reward = claim(recipient);
    }

    // -----------------------------------------------------------------------
    // Harvest (keeper)
    // -----------------------------------------------------------------------

    /// @notice Collect the position's fees, convert the token side to ETH in
    ///         this pool, take the protocol's share, and stream the rest.
    /// @param minEthFromTokens The least ETH the token-side swap may return.
    ///        Computed off chain by the keeper from a trailing price, so a
    ///        price pushed around just before the harvest reverts it instead
    ///        of selling the fees cheaply. Ignored when there are no token fees.
    function harvest(uint256 minEthFromTokens, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 reward, uint256 protocolCut)
    {
        if (msg.sender != keeper) revert NotKeeper();
        _updateReward(address(0));

        bytes memory result = poolManager.unlock(abi.encode(Action.Harvest, address(0), uint128(0)));
        (uint256 ethFees, uint256 tokenSold, uint256 ethFromTokens) = abi.decode(result, (uint256, uint256, uint256));
        if (tokenSold > 0 && ethFromTokens < minEthFromTokens) revert Slippage();

        uint256 total = ethFees + ethFromTokens;
        if (ethIsNative && total > 0) weth.deposit{value: total}();

        protocolCut = total * protocolFeeBps / BPS;
        reward = total - protocolCut;
        if (protocolCut > 0) _sendWeth(treasury, protocolCut);
        if (reward > 0) _notifyReward(reward);

        emit Harvested(ethFees, tokenSold, ethFromTokens, protocolCut, reward);
    }

    // -----------------------------------------------------------------------
    // Owner (no path to staker funds)
    // -----------------------------------------------------------------------

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Lower or raise the fee, never above the cap fixed at deploy.
    function setProtocolFee(uint16 bps) external onlyOwner {
        if (bps > protocolFeeCapBps) revert FeeAboveCap();
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
        Harvest
    }

    /// @dev Only the PoolManager calls this, and only during this vault's own
    ///      `unlock` — the PoolManager calls back whoever unlocked it.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, address party, uint128 liquidity) = abi.decode(data, (Action, address, uint128));
        PoolKey memory key = poolKey();

        if (action == Action.Harvest) return _harvestInside(key);

        int256 liquidityDelta = action == Action.Deposit ? int256(uint256(liquidity)) : -int256(uint256(liquidity));
        (BalanceDelta callerDelta, BalanceDelta feesAccrued) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: 0}),
            ""
        );
        // Any change to the position also collects every fee it has earned.
        // Those belong to the stakers as a whole, not to whoever triggered the
        // change: they are held for the next harvest.
        _collectFees(feesAccrued);
        BalanceDelta principal = callerDelta - feesAccrued;

        if (action == Action.Deposit) {
            uint256 owed0 = uint256(-int256(principal.amount0()));
            uint256 owed1 = uint256(-int256(principal.amount1()));
            Settlement.pay(poolManager, currency0, currency0.isAddressZero() ? address(this) : party, owed0);
            Settlement.pay(poolManager, currency1, party, owed1);
            return abi.encode(owed0, owed1);
        }
        uint256 out0 = uint256(int256(principal.amount0()));
        uint256 out1 = uint256(int256(principal.amount1()));
        Settlement.collect(poolManager, currency0, party, out0);
        Settlement.collect(poolManager, currency1, party, out1);
        return abi.encode(out0, out1);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    function _harvestInside(PoolKey memory key) private returns (bytes memory) {
        if (totalSupply > 0) {
            (, BalanceDelta feesAccrued) = poolManager.modifyLiquidity(
                key, ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: 0, salt: 0}), ""
            );
            _collectFees(feesAccrued);
        }

        uint256 tokenSold;
        uint256 ethFromTokens;
        uint256 tokenFees = pendingTokenFees;
        if (tokenFees > 0) {
            // Sell the token side for ETH, exact input, in this same pool.
            bool zeroForOne = ethIndex == 1; // the token is currency0
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(tokenFees),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            int128 tokenDelta = zeroForOne ? delta.amount0() : delta.amount1();
            int128 ethDelta = zeroForOne ? delta.amount1() : delta.amount0();
            tokenSold = uint256(int256(-tokenDelta));
            ethFromTokens = uint256(int256(ethDelta));
            Settlement.pay(poolManager, _tokenCurrency(), address(this), tokenSold);
            Settlement.collect(poolManager, _ethCurrency(), address(this), ethFromTokens);
            // A partial fill leaves the rest for the next harvest.
            pendingTokenFees = tokenFees - tokenSold;
        }

        uint256 ethFees = pendingEthFees;
        pendingEthFees = 0;
        return abi.encode(ethFees, tokenSold, ethFromTokens);
    }

    function _collectFees(BalanceDelta feesAccrued) private {
        uint256 f0 = uint256(int256(feesAccrued.amount0()));
        uint256 f1 = uint256(int256(feesAccrued.amount1()));
        if (f0 == 0 && f1 == 0) return;
        Settlement.collect(poolManager, currency0, address(this), f0);
        Settlement.collect(poolManager, currency1, address(this), f1);
        (uint256 ethFees, uint256 tokenFees) = ethIndex == 0 ? (f0, f1) : (f1, f0);
        pendingEthFees += ethFees;
        pendingTokenFees += tokenFees;
        emit FeesCollected(ethFees, tokenFees);
    }

    /// @dev Synthetix notifyRewardAmount, with nothing lost to rounding: the
    ///      remainder of `total / duration` waits in `queuedRewards`.
    function _notifyReward(uint256 reward) private {
        uint256 total = reward + queuedRewards;
        if (block.timestamp < periodFinish) total += (periodFinish - block.timestamp) * rewardRate;
        rewardRate = total / REWARDS_DURATION;
        queuedRewards = total % REWARDS_DURATION;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + REWARDS_DURATION;
        rewardsReserved += reward;

        uint256 held = weth.balanceOf(address(this));
        uint256 wethFeesHeld = ethIsNative ? 0 : pendingEthFees;
        if (held < rewardsReserved + wethFeesHeld) revert Insolvent();
        emit RewardAdded(reward, rewardRate, periodFinish);
    }

    function _updateReward(address account) private {
        uint256 applicable = lastTimeRewardApplicable();
        if (applicable > lastUpdateTime) {
            uint256 streamed = (applicable - lastUpdateTime) * rewardRate;
            if (totalSupply == 0) {
                // Nobody to pay: keep it for the next stream.
                queuedRewards += streamed;
            } else {
                rewardPerTokenStored += streamed * PRECISION / totalSupply;
            }
            lastUpdateTime = applicable;
        }
        if (account != address(0)) {
            rewardsScaled[account] = _scaledEarned(account, rewardPerTokenStored);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    function _scaledEarned(address account, uint256 rpt) private view returns (uint256) {
        return rewardsScaled[account] + balanceOf[account] * (rpt - userRewardPerTokenPaid[account]);
    }

    function _claim(address account, address recipient) private returns (uint256 amount) {
        _updateReward(account);
        uint256 scaled = rewardsScaled[account];
        amount = scaled / PRECISION;
        if (amount == 0) return 0;
        rewardsScaled[account] = scaled - amount * PRECISION;
        rewardsReserved -= amount;
        _sendWeth(recipient, amount);
        emit RewardPaid(account, recipient, amount);
    }

    function _sendWeth(address to, uint256 amount) private {
        if (!weth.transfer(to, amount)) revert Insolvent();
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

    function _ethCurrency() private view returns (Currency) {
        return ethIndex == 0 ? currency0 : currency1;
    }

    function _tokenCurrency() private view returns (Currency) {
        return ethIndex == 0 ? currency1 : currency0;
    }
}
