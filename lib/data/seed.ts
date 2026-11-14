import type { Quote } from './types';

/**
 * The prototype's generated market, lifted verbatim from design/depth.html so
 * P0 renders exactly what was approved. Ages are stored as hours rather than
 * derived from Date.now() — the first snapshot has to be identical on the
 * server and in the browser.
 */
export interface SeedPool {
  symbol: string;
  name: string;
  logoColor: string;
  marketCapUsd: number;
  change24hPct: number;
  fees24hUsd: number;
  volume24hUsd: number;
  tvlUsd: number;
  ageHours: number;
  kind: 'stock' | 'meme' | 'new';
  priceUsd: number;
  launchpad?: string;
  /** Pre-graduation launchpad liquidity: listed, but not stakeable (§4). */
  stakeable?: boolean;
  protocol?: 'v4' | 'v3';
}

export const SEED_POOLS: SeedPool[] = [
  { symbol: 'NVDA', name: 'NVIDIA · Robinhood Token', logoColor: '#3DD68C', marketCapUsd: 20.9e6, change24hPct: 0.1, fees24hUsd: 7710, volume24hUsd: 15.4e6, tvlUsd: 1.9e6, ageHours: 69 * 24, kind: 'stock', priceUsd: 187.2 },
  { symbol: 'HOODR', name: 'Hoodr', logoColor: '#3DD68C', marketCapUsd: 9.9e6, change24hPct: 6.3, fees24hUsd: 4190, volume24hUsd: 1.68e6, tvlUsd: 420e3, ageHours: 37 * 24, kind: 'meme', priceUsd: 0.0099, launchpad: 'Bags' },
  { symbol: 'MOONCAT', name: 'Mooncat', logoColor: '#2FB87A', marketCapUsd: 52.5e6, change24hPct: 32.7, fees24hUsd: 30830, volume24hUsd: 3.08e6, tvlUsd: 1.6e6, ageHours: 7 * 24, kind: 'meme', priceUsd: 0.0525, launchpad: 'Pons' },
  { symbol: 'GOOGL', name: 'Alphabet A · Robinhood Token', logoColor: '#2A9D8F', marketCapUsd: 5.4e6, change24hPct: 0.8, fees24hUsd: 2900, volume24hUsd: 5.8e6, tvlUsd: 900e3, ageHours: 69 * 24, kind: 'stock', priceUsd: 231.4 },
  { symbol: 'SPY', name: 'S&P 500 ETF · Robinhood Token', logoColor: '#3B82F6', marketCapUsd: 25.1e6, change24hPct: 0.1, fees24hUsd: 251, volume24hUsd: 2.51e6, tvlUsd: 2.4e6, ageHours: 69 * 24, kind: 'stock', priceUsd: 648.1 },
  { symbol: 'AAPL', name: 'Apple · Robinhood Token', logoColor: '#6B7280', marketCapUsd: 5.1e6, change24hPct: 0.2, fees24hUsd: 1130, volume24hUsd: 2.25e6, tvlUsd: 620e3, ageHours: 69 * 24, kind: 'stock', priceUsd: 234.6 },
  { symbol: 'PONS', name: 'Pons', logoColor: '#F97316', marketCapUsd: 593.7e6, change24hPct: 3.5, fees24hUsd: 52140, volume24hUsd: 17.4e6, tvlUsd: 6.2e6, ageHours: 60 * 24, kind: 'meme', priceUsd: 0.5937, launchpad: 'Pons' },
  { symbol: 'TSLA', name: 'Tesla · Robinhood Token', logoColor: '#B45309', marketCapUsd: 4.6e6, change24hPct: 0.6, fees24hUsd: 410, volume24hUsd: 410e3, tvlUsd: 300e3, ageHours: 69 * 24, kind: 'stock', priceUsd: 412.9, protocol: 'v3' },
  { symbol: 'LAURA', name: 'Laura Is Online', logoColor: '#EC4899', marketCapUsd: 1.15e6, change24hPct: 43.8, fees24hUsd: 6310, volume24hUsd: 631e3, tvlUsd: 180e3, ageHours: 24, kind: 'new', priceUsd: 0.00115, launchpad: 'Bottom.fun' },
  // One hour old and still on its launchpad curve: indexed for the listing,
  // never offered as a stake, and too young for any yield figure at all.
  { symbol: 'TWINE', name: 'Twine', logoColor: '#14B8A6', marketCapUsd: 1.63e6, change24hPct: 16.3, fees24hUsd: 2160, volume24hUsd: 216e3, tvlUsd: 90e3, ageHours: 1, kind: 'new', priceUsd: 0.00163, launchpad: 'Bottom.fun', stakeable: false },
  { symbol: 'GLD', name: 'Gold Trust · Robinhood Token', logoColor: '#EAB308', marketCapUsd: 9.4e6, change24hPct: 0, fees24hUsd: 96, volume24hUsd: 129e3, tvlUsd: 500e3, ageHours: 32 * 24, kind: 'stock', priceUsd: 312.2 },
];

/** Day-one stablecoin on this chain is USDG, not USDC (§2). */
export const quoteFor = (kind: SeedPool['kind']): Quote => (kind === 'stock' ? 'USDG' : 'ETH');

/** Which pools have a vault, in the prototype's order. */
export const SEED_VAULT_SYMBOLS = ['NVDA', 'MOONCAT', 'PONS', 'SPY', 'HOODR', 'GOOGL'];

/**
 * Only the figures that cannot be derived from the pool rows live here. TVL,
 * fees, volume, the 24h move and the staker count are summed from the pools
 * and the vaults instead, so the top bar can never contradict the table under
 * it — the prototype's standalone numbers did.
 */
export const SEED_GLOBAL = {
  /** Positions ever minted. Not derivable from a live snapshot. */
  totalPositions: 27_844,
  /** Fees paid out since launch. Cumulative, so it only ever grows. */
  totalFeesUsd: 5_142_908,
  ethPriceUsd: 2521.08,
};

export const SEED_FEATURED = {
  /** Tidewell's share of all liquidity on the chain. Needs chain-wide data. */
  chainSharePct: 2.4,
};

export const SEED_ROUTER = {
  tokenSymbol: 'HOODR',
  feeSourceAddress: '0x8f2c…a91e',
  accruedWeth: 3.84,
  accruedUsd: 9681,
  currentDepthUsd: 31_000,
  projectedDepthUsd: 118_000,
  slippageNowPct: 3.1,
  slippageLaterPct: 1.4,
  firstRouteWeth: 1.92,
  firstRouteDepthUsd: 4800,
  twapMinutes: 30,
  // The prototype's badge, kept for the simulator only.
  deployerVerified: true,
};
