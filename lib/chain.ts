/**
 * Robinhood Chain, and the addresses Tidewell talks to (§2).
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
 * Deployed contracts. VERIFY EACH ON THE EXPLORER BEFORE MAINNET (§2).
 */
export const CONTRACTS = {
  /** aeWETH proxy — the token every fee is paid in. */
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  v4Quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
  stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  /**
   * Uniswap v4 PositionManager ("Uniswap v4 Positions NFT"). Read off the
   * UniversalRouter's V4_POSITION_MANAGER() on chain; its poolManager(),
   * permit2() and WETH9() match the addresses above.
   */
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
} as const;

/** The public RPC the browser's wallet layer reads through. */
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';

export type ContractName = keyof typeof CONTRACTS;

/** Day-one stablecoin on this chain is USDG, not USDC. There is no Aave (§2). */
export const STABLECOIN_SYMBOL = 'USDG';

/** The quote assets a pool can be priced against. */
export const QUOTES = ['ETH', STABLECOIN_SYMBOL] as const;

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
