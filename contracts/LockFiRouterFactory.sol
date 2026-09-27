// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LockFiRouter, RouterConfig, PoolKey, IPoolManager, IUniswapV3Pool} from "./LockFiRouter.sol";

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
 */
contract LockFiRouterFactory {
    uint16 public constant MAX_FEE_BPS = 200;
    uint32 public constant MIN_CADENCE = 1 hours;
    uint32 public constant MAX_CADENCE = 30 days;

    uint16 public immutable feeBps;
    address public immutable poolManager;
    address public immutable weth;
    address public immutable v3Factory;

    address public owner;
    address public keeper;
    address public treasury;

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
    event TreasurySet(address treasury);
    event OwnerSet(address owner);

    error NotOwner();
    error BadPool();
    error BadCadence();
    error FeeTooHigh();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address poolManager_, address weth_, address v3Factory_, uint16 feeBps_, address treasury_, address keeper_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        poolManager = poolManager_;
        weth = weth_;
        v3Factory = v3Factory_;
        feeBps = feeBps_;
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
        if (token == address(0) || (other != address(0) && other != weth)) revert BadPool();
        bytes32 id = keccak256(abi.encode(key));
        // an uninitialised pool has no price
        bytes32 slot0 = IPoolManager(poolManager).extsload(keccak256(abi.encodePacked(id, bytes32(uint256(6)))));
        if (uint160(uint256(slot0)) == 0) revert BadPool();
        return _create(
            RouterConfig(true, poolManager, address(0), key, token, other, weth, msg.sender, _cadence(cadence), narrow),
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
        PoolKey memory key = PoolKey(t0, t1, fee, p.tickSpacing(), address(0));
        return _create(
            RouterConfig(false, address(0), pool, key, token, weth, weth, msg.sender, _cadence(cadence), narrow),
            pool,
            bytes32(0)
        );
    }

    function _cadence(uint32 c) internal pure returns (uint32) {
        if (c < MIN_CADENCE || c > MAX_CADENCE) revert BadCadence();
        return c;
    }

    function _create(RouterConfig memory c, address pool, bytes32 id) internal returns (address r) {
        r = address(new LockFiRouter(c));
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

    function routersForToken(address token) external view returns (address[] memory) {
        return _byToken[token];
    }

    function routersForTeam(address team) external view returns (address[] memory) {
        return _byTeam[team];
    }

    // ── owner ─────────────────────────────────────────────────────────────────

    function setKeeper(address k) external onlyOwner {
        keeper = k;
        emit KeeperSet(k);
    }

    function setTreasury(address t) external onlyOwner {
        require(t != address(0));
        treasury = t;
        emit TreasurySet(t);
    }

    function setOwner(address o) external onlyOwner {
        require(o != address(0));
        owner = o;
        emit OwnerSet(o);
    }
}
