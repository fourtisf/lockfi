// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LockFiRouterDeployer, RouterConfig, PoolKey, IPoolManager, IUniswapV3Pool} from "./LockFiRouter.sol";

interface IUniswapV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

/*
 * Creates one LockFiRouter per token team and holds the settings every router
 * reads: who the keeper is, where the LockFi fee goes, and how large it is.
 *
 * The fee is fixed at deployment and capped at MAX_FEE_BPS; nothing can raise
 * it. The owner can name a new keeper or treasury, and nothing else: no
 * setting here reaches a router's funds or its liquidity.
 *
 * A new keeper takes effect only KEEPER_DELAY after it is named, so a team
 * can see it coming and turn the keeper off for its router first. Removing
 * the keeper (naming the zero address) is immediate. Ownership moves in two
 * steps, so a mistyped address cannot take it.
 *
 * A v4 pool whose hook can act on liquidity is refused (see LockFiRouter).
 */
contract LockFiRouterFactory {
    uint16 public constant MAX_FEE_BPS = 200;
    uint32 public constant MIN_CADENCE = 1 hours;
    uint32 public constant MAX_CADENCE = 30 days;
    uint32 public constant KEEPER_DELAY = 2 days;
    /// Hook permissions that act on liquidity: before/after add and remove
    /// (bits 8-11) and the two liquidity return deltas (bits 0-1).
    uint160 public constant LIQUIDITY_HOOK_FLAGS = (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 1) | 1;

    uint16 public immutable feeBps;
    address public immutable poolManager;
    address public immutable weth;
    address public immutable v3Factory;
    LockFiRouterDeployer public immutable deployer;

    address public owner;
    address public pendingOwner;
    address public keeper;
    address public treasury;
    /// A keeper named by the owner, and when it may take over.
    address public pendingKeeper;
    uint64 public pendingKeeperAt;

    address[] public allRouters;
    mapping(address => address[]) internal _byToken;
    mapping(address => address[]) internal _byTeam;

    event RouterCreated(
        address indexed router,
        address indexed token,
        address indexed team,
        bool isV4,
        address pool,
        bytes32 poolId,
        uint32 cadence,
        bool narrow
    );
    event KeeperSet(address keeper);
    event KeeperProposed(address keeper, uint64 activeAt);
    event OwnerProposed(address owner);
    event TreasurySet(address treasury);
    event OwnerSet(address owner);

    error NotOwner();
    error BadPool();
    error BadCadence();
    error FeeTooHigh();
    error BadHook();
    error BadAddress();
    error TooEarly();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address poolManager_, address weth_, address v3Factory_, uint16 feeBps_, address treasury_, address keeper_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (treasury_ == address(0) || keeper_ == address(0) || treasury_ == keeper_) revert BadAddress();
        poolManager = poolManager_;
        weth = weth_;
        v3Factory = v3Factory_;
        feeBps = feeBps_;
        deployer = new LockFiRouterDeployer();
        owner = msg.sender;
        treasury = treasury_;
        keeper = keeper_;
        emit OwnerSet(msg.sender);
        emit TreasurySet(treasury_);
        emit KeeperSet(keeper_);
    }

    /// A router for `token` into a Uniswap v4 pool whose other side is native
    /// ETH or WETH. The caller is the team.
    function createV4(PoolKey calldata key, address token, uint32 cadence, bool narrow) external returns (address) {
        address other;
        if (key.currency0 == token) other = key.currency1;
        else if (key.currency1 == token) other = key.currency0;
        else revert BadPool();
        if (token == address(0) || token == weth || (other != address(0) && other != weth)) revert BadPool();
        if (uint160(key.hooks) & LIQUIDITY_HOOK_FLAGS != 0) revert BadHook();
        bytes32 id = keccak256(abi.encode(key));
        // an uninitialised pool has no price
        bytes32 slot0 = IPoolManager(poolManager).extsload(keccak256(abi.encodePacked(id, bytes32(uint256(6)))));
        if (uint160(uint256(slot0)) == 0) revert BadPool();
        return _create(
            RouterConfig(address(this), true, poolManager, address(0), key, token, other, weth, msg.sender, _cadence(cadence), narrow),
            address(0),
            id
        );
    }

    /// A router for `token` into a Uniswap v3 pool against WETH, which must be
    /// the factory's own pool for its tokens and fee. The caller is the team.
    function createV3(address pool, uint32 cadence, bool narrow) external returns (address) {
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        address t0 = p.token0();
        address t1 = p.token1();
        uint24 fee = p.fee();
        if (IUniswapV3Factory(v3Factory).getPool(t0, t1, fee) != pool) revert BadPool();
        address token;
        if (t0 == weth) token = t1;
        else if (t1 == weth) token = t0;
        else revert BadPool();
        (uint160 sqrtP,,,,,,) = p.slot0();
        if (sqrtP == 0) revert BadPool();
        PoolKey memory key = PoolKey(t0, t1, fee, p.tickSpacing(), address(0));
        return _create(
            RouterConfig(address(this), false, address(0), pool, key, token, weth, weth, msg.sender, _cadence(cadence), narrow),
            pool,
            bytes32(0)
        );
    }

    function _cadence(uint32 c) internal pure returns (uint32) {
        if (c < MIN_CADENCE || c > MAX_CADENCE) revert BadCadence();
        return c;
    }

    function _create(RouterConfig memory c, address pool, bytes32 id) internal returns (address r) {
        r = deployer.deploy(c);
        allRouters.push(r);
        _byToken[c.token].push(r);
        _byTeam[c.team].push(r);
        emit RouterCreated(r, c.token, c.team, c.isV4, pool, id, c.cadence, c.narrow);
    }

    // ── views ─────────────────────────────────────────────────────────────────

    function routerCount() external view returns (uint256) {
        return allRouters.length;
    }

    function routers() external view returns (address[] memory) {
        return allRouters;
    }

    /// Routers [start, start + count), for a reader that pages rather than
    /// asks for a list anyone can lengthen.
    function routersPage(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 n = allRouters.length;
        if (start >= n) return new address[](0);
        uint256 end = start + count > n ? n : start + count;
        page = new address[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = allRouters[i];
    }

    /// Routers by the team that created them. A router's team can change
    /// since (`setTeam`); read the router's own `team` for who holds it now.
    function routersForToken(address token) external view returns (address[] memory) {
        return _byToken[token];
    }

    function routersForTeam(address team) external view returns (address[] memory) {
        return _byTeam[team];
    }

    // ── owner ─────────────────────────────────────────────────────────────────

    /// Name a new keeper; it takes over after KEEPER_DELAY, through
    /// `activateKeeper`. The zero address removes the keeper at once.
    function setKeeper(address k) external onlyOwner {
        if (k == address(0)) {
            keeper = address(0);
            pendingKeeper = address(0);
            pendingKeeperAt = 0;
            emit KeeperSet(address(0));
            return;
        }
        if (k == treasury) revert BadAddress();
        pendingKeeper = k;
        pendingKeeperAt = uint64(block.timestamp) + KEEPER_DELAY;
        emit KeeperProposed(k, pendingKeeperAt);
    }

    /// Anyone may complete a keeper change once its delay has passed.
    function activateKeeper() external {
        if (pendingKeeper == address(0)) revert BadAddress();
        if (block.timestamp < pendingKeeperAt) revert TooEarly();
        keeper = pendingKeeper;
        pendingKeeper = address(0);
        pendingKeeperAt = 0;
        emit KeeperSet(keeper);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0) || t == keeper) revert BadAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    /// Ownership moves in two steps: named here, taken by `acceptOwner`.
    function setOwner(address o) external onlyOwner {
        pendingOwner = o;
        emit OwnerProposed(o);
    }

    function acceptOwner() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerSet(msg.sender);
    }
}
