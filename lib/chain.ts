/**
 * Robinhood Chain, and the addresses Balast talks to (§2).
 *
 * Every address here is UNVERIFIED: the handoff says to check each one on the
 * explorer before mainnet, and nothing in P0 sends a transaction. Keep them in
 * this one file so P2 has a single place to verify and to swap for testnet.
 */

export const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  /** EVM L2 on Arbitrum Orbit; gas is paid in native ETH. */
  stack: 'Arbitrum Orbit',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  /**
   * ~100ms blocks with a first-come-first-served sequencer. Transaction
   * deadlines are therefore timestamps, never block numbers (§2).
   */
  blockTimeMs: 100,
  /** Shallow but non-zero on an Orbit L2: re-scan this many blocks each pass. */
  reorgDepth: 32,
} as const;

/**
 * Deployed contracts.
 *
 * The §2 handoff addresses were unverified for a long time. They are now
 * checked against Uniswap's own registry — `sdks/sdk-core/src/addresses.ts`
 * and `universal-router-sdk/src/utils/constants.ts` in github.com/Uniswap/sdks,
 * which list Robinhood Chain (chainId 4663) — and every v4 address below
 * matches it byte for byte. The registry also supplied the two the handoff
 * did not have: the v4 PositionManager, which is what mints a position to a
 * wallet, and the v3 factory §14 asked for. `npm run verify:chain` still
 * checks that each holds code on the chain itself.
 */
export const CONTRACTS = {
  /** aeWETH proxy — the token every fee is paid in. */
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  /** Universal Router v2.1.1, created at block 18127 per the registry. */
  universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  /**
   * Uniswap's PositionManager for v4: one `modifyLiquidities` call mints,
   * settles and sweeps, and the position NFT goes to the owner it names.
   * Balast mints through it rather than through a contract of its own.
   */
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  v4Quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
  stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  /** Uniswap v3 factory on this chain, per the same registry (§14, §15). */
  v3Factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  /**
   * Uniswap v3's own NonfungiblePositionManager, from the same registry
   * entry as every address above (`ROBINHOOD_ADDRESSES` in
   * sdks/sdk-core/src/addresses.ts, chainId 4663).
   *
   * It is here because a token's ether market on this chain is often a v3
   * pool — VIRTUAL's is — and the builder could only mint through v4, so
   * that pair was listed, traded, and not offerable. That was a gap in what
   * Balast had built, never a fact about the chain.
   */
  v3PositionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  /**
   * The two contracts the single-token zap swaps through (§33), from the same
   * registry: v3's SwapRouter02 and QuoterV2. v4 swaps go through the
   * Universal Router above and are quoted by the V4Quoter.
   */
  swapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2',
  v3QuoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
} as const;

export type ContractName = keyof typeof CONTRACTS;

/**
 * The LockFi Router factory (§48): the one contract of LockFi's own on this
 * chain. null until it is deployed. The owner deploys it from /router/deploy
 * with their own wallet and the address goes here, as a constant for the same
 * reason the X link and the token address are (§19, §43): a stale value in a
 * box's .env must never point the page at the wrong contract.
 */
export const ROUTER_FACTORY: `0x${string}` | null = null;

/** The fee the factory takes on each route, in basis points. Fixed at deploy, capped at 200 in the contract. */
export const ROUTER_FEE_BPS = 100;

/**
 * The chain's block explorer, from the ethereum-lists/chains registry entry
 * for chainId 4663. It is a Blockscout, which means a documented JSON API
 * under `/api/v2/` — the indexer asks it for token icons, which §4 allows
 * from outside, and for nothing numeric. `EXPLORER_API_URL` overrides it.
 */
export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

/**
 * GeckoTerminal's id for this chain.
 *
 * Read off the box rather than guessed: the market feed quoted twenty-six
 * tokens through GeckoTerminal and reported this id. It is the default for
 * the same reason DexScreener's is (§20) — because leaving it unset makes
 * every process that uses the source DISCOVER it, by walking GeckoTerminal's
 * network list up to twenty requests at a time, on a keyless tier of a few
 * dozen calls a minute. Two processes doing that is what earned the 429 that
 * made GeckoTerminal answer nothing for BRODIE, a token it may well know.
 *
 * `GECKOTERMINAL_NETWORK` still overrides it, and an empty value restores the
 * discovery.
 */
export const GECKOTERMINAL_NETWORK = 'robinhood';

/**
 * The chain's free public endpoints, from the chain registry
 * (ethereum-lists/chains, eip155-4663) — the same list the server fails over
 * across (server/chain/endpoints.ts). The page reads through all of them in
 * turn (`publicTransport` in lib/v4/client.ts), so one endpoint rate-limiting
 * a browser does not make a pool unreadable; the wallet is told about all of
 * them when it adds the chain.
 */
export const PUBLIC_RPC_URLS = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhood-rpc.publicnode.com',
  'https://rpc.arrowrpc.com',
  'https://rpc.ordofi.network',
] as const;

/** The first of them: the chain's own, for the places that take exactly one. */
export const PUBLIC_RPC_URL = PUBLIC_RPC_URLS[0];

/**
 * How Uniswap v4 spells native ether: the zero address.
 *
 * v4 has no WETH-only rule — a pool's `currency0` is `address(0)` when the
 * pair trades native ETH, and on this chain that is what the flagship pairs
 * do. Every price path here anchors to ether (§4.3), so a pool holding it
 * natively has to be recognised as an ether pool or it is invisible: not
 * listed, not priced, and unable to act as the USD anchor.
 *
 * This is NOT the same thing as `hooks == address(0)`, which means a pool has
 * no hook. Same twenty zero bytes, different question — hence the two names.
 */
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

/**
 * Both spellings of ether, lowercased.
 *
 * Treating them as one asset is a statement about the wrapper and not a
 * convenience: aeWETH mints one token per ether deposited and burns one per
 * ether withdrawn, so one aeWETH is one ETH by construction. Pricing a
 * native-ETH pool through the aeWETH/USDG anchor is therefore exact, not an
 * approximation — which is what §4.3's "one anchor, one path" requires.
 *
 * They stay separate ROWS in `tokens`: they are different addresses with
 * different balances, and merging them would make a pool's own reserves
 * unreconstructable from its events.
 */
export function etherCurrencies(weth: string = CONTRACTS.weth): readonly string[] {
  return [NATIVE_ETH, weth.toLowerCase()];
}

/** Whether an address is ether in either spelling. */
export function isEther(address: string, weth: string = CONTRACTS.weth): boolean {
  return etherCurrencies(weth).includes(address.toLowerCase());
}

/** Day-one stablecoin on this chain is USDG, not USDC. There is no Aave (§2). */
export const STABLECOIN_SYMBOL = 'USDG';

/** The quote assets a pool can be priced against. */
export const QUOTES = ['ETH', STABLECOIN_SYMBOL] as const;

/**
 * Whether a token is a dollar, by its symbol.
 *
 * A stablecoin is not a project: its market cap is how much of it was
 * minted or bridged, and a board ranked by market cap would lead with the
 * dollars. Matched on the symbol — `USD` anywhere in it catches USDC, USDT,
 * USDe, syrupUSDG and the rest — plus the few that do not carry the letters.
 */
const STABLE_SYMBOLS = new Set(['DAI', 'FRAX', 'GHO', 'LUSD', 'MIM', 'TUSD', 'EURC', 'EURS', 'PYUSD']);
export function isStablecoinSymbol(symbol: string): boolean {
  const upper = symbol.trim().toUpperCase();
  return upper.includes('USD') || STABLE_SYMBOLS.has(upper);
}
/** The same rule as SQL over a symbol expression. Keep in step with `isStablecoinSymbol`. */
export function isStablecoinSql(symbolExpr: string): string {
  const list = [...STABLE_SYMBOLS].map((s) => `'${s}'`).join(', ');
  return `(upper(trim(${symbolExpr})) LIKE '%USD%' OR upper(trim(${symbolExpr})) IN (${list}))`;
}

/** Events the P1 indexer subscribes to (§4), kept next to the addresses. */
export const INDEXED_EVENTS = {
  poolManagerV4: ['Initialize', 'Swap', 'ModifyLiquidity'],
  uniswapV3Pool: ['Swap', 'Mint', 'Burn'],
} as const;

/** Launchpads whose hooks emit swaps before graduation (§4). */
export const LAUNCHPADS = ['Pons', 'Bags', 'Bottom.fun'] as const;

/** Protocol fee on harvested fees, and the immutable constructor cap (§3.3). */
export const PROTOCOL_FEE_BPS = 1000;
export const PROTOCOL_FEE_CAP_BPS = 2000;

/** The reward stream window. Seven days, everywhere (§3.3). */
export const REWARD_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/** TWAP window the router prices against — spot would be a free sandwich (§3.4). */
export const ROUTER_TWAP_MINUTES = 30;

/**
 * A deadline for a transaction, as a UNIX timestamp in seconds.
 * Timestamps, not block numbers — the sequencer's ~100ms blocks make block
 * numbers a bad clock (§2).
 */
export function deadlineFromNow(seconds: number, now = Date.now()): number {
  return Math.floor(now / 1000) + seconds;
}
