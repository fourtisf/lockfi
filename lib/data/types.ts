/**
 * The contract between the UI and whatever is producing the numbers.
 *
 * P0 satisfies it with SimProvider (generated data, §8). P1 swaps in an
 * indexer-backed provider and nothing above this file changes — that is the
 * whole point of §4's rule: no component imports data directly.
 */

export type Quote = 'ETH' | 'USDG';
export type Protocol = 'v4' | 'v3';
export type ShapeId = 'spot' | 'curve' | 'bidask';

export interface TokenMeta {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Brand colour from token metadata. Data, not a design decision (§5). */
  logoColor: string;
  /**
   * Logo image, when a token list supplied one.
   *
   * §4 permits external sources for logos and metadata but not for numbers,
   * so this is the one field on this type that did not come from a node. The
   * colour above is always present and is what renders without it.
   */
  logoUrl?: string;
  /** Launchpad that minted it, when it came from one. */
  launchpad?: string;
}

/**
 * Fee yield, trailing. Never forward, never annualised from a single day
 * without saying so (§1, §7). The provider decides which case applies; the
 * component only renders it.
 */
export type FeeYield =
  /**
   * No honest figure: display "—", never a number (§7). `reason` says why,
   * because a dash nobody can read is a number nobody can trust: under 24
   * hours of fees, or a pool whose depth is not known.
   */
  | { basis: 'insufficient'; reason?: 'young' | 'no-depth' | 'unread' }
  /** Pool younger than 7d: annualised over what exists, labelled est. + age. */
  | { basis: 'estimate'; pct: number; windowHours: number }
  /** The real thing: fees_7d / tvl_now * 365/7. */
  | { basis: 'trailing7d'; pct: number };

/** A Uniswap v4 PoolKey, as a transaction needs it. Addresses lowercase. */
export interface PoolKey {
  /** address(0) for native ETH. */
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  /** In hundredths of a bip, as on chain (3000 = 0.30%). */
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

export interface Pool {
  id: string;
  address: string;
  token: TokenMeta;
  quote: Quote;
  feeTierBps: number;
  /** The v4 PoolKey, rebuilt from the indexer; absent for v3 and simulated pools. */
  key?: PoolKey;
  protocol: Protocol;
  /** Pre-graduation launchpad liquidity is listed but cannot be staked (§4). */
  stakeable: boolean;
  ageHours: number;

  priceUsd: number;
  /**
   * The token's total value at the current price.
   *
   * `marketCapIsFdv` says which figure it actually is. Zero means the
   * provider could not establish a supply, and the row shows an em dash.
   */
  marketCapUsd: number;
  /**
   * True when the figure above is fully diluted value rather than market cap.
   *
   * The live indexer derives it from `totalSupply()`, which includes locked,
   * vested and treasury-held tokens — none of which is distinguishable on
   * chain. That is FDV, and §7 does not allow it to be presented as market
   * cap: for a token with a vesting schedule the two differ by a lot, always
   * in the flattering direction.
   */
  marketCapIsFdv: boolean;
  tvlUsd: number;
  /**
   * The price move over the last 24h of chain time, or null when there is no
   * price to compare against — no trade in the pool before or during the
   * window. Null renders as an em dash: it was rendered as 0.0%, which
   * claimed no movement for a figure nobody had.
   */
  change24hPct: number | null;
  /**
   * Hours before the snapshot's moment of the trade the 24h move is measured
   * from: 24 or more for a true 24h figure, fewer when it is the first trade
   * inside the window (a pool younger than a day, or one nobody traded in the
   * hours before the mark). Absent from the simulator, which has no trades.
   */
  change24hRefHours?: number | null;
  fees24hUsd: number;
  /** Fees over the trailing 7d, or over the pool's whole life if younger. */
  feesWindowUsd: number;
  feeWindowHours: number;
  volume24hUsd: number;
  trades24h: number;
  /** 14 buckets of recent fee revenue, for the row sparkline. */
  feeHistory: number[];
  feeYield: FeeYield;
}

/** One of a vault pool's two currencies, as the chain describes it. */
export interface VaultCurrency {
  /** address(0) for native ETH. Lowercase. */
  address: string;
  symbol: string;
  decimals: number;
  /** Dollars per whole token, or null when there is no honest price. */
  priceUsd: number | null;
}

/**
 * A vault's pool read straight from the chain by the vault watcher
 * (server/keeper/vault-watch.ts), every minute, independent of the pool
 * indexer — whose boards can be months behind while it crosses history.
 */
export interface VaultLive {
  /** Chain time of the block these figures were read at (ISO). */
  asOf: string;
  blockNumber: number;
  currencies: [VaultCurrency, VaultCurrency];
  /** ETH in dollars from this pool's own price, when it pairs ETH with USDG. */
  ethPriceUsd: number | null;
  /**
   * The move in currency0's price, in currency1, over the last 24h — from the
   * pool's last swap 24h ago to its price now. Null without a swap that old.
   */
  change24hPct: number | null;
  /** The vault's own liquidity at today's price; null when a side has no price. */
  stakedUsd: number | null;
  /** LP fees over the last 24h, Uniswap's protocol fee taken out. */
  fees24hUsd: number;
  volume24hUsd: number;
  trades24h: number;
  /** LP fees per 12h bucket over the trailing 7 days, oldest first: 14 points. */
  feeHistory: number[];
  /** Hours of swap history behind the figures, at most 168. */
  historyHours: number;
  /**
   * What a full-range position — exactly what the vault holds — earned over
   * the trailing window, annualised, BEFORE the vault's protocol fee. Not the
   * pool's average, which concentrated LPs pull far above what full range
   * earns (lib/yield.ts, stakerYield, takes the protocol fee out).
   */
  fullRangeYield: FeeYield;
}

export interface Vault {
  id: string;
  poolId: string;
  address: string;
  totalStakedUsd: number;
  stakers: number;
  /** WETH per second currently streaming out of the 7-day window. */
  rewardRate: number;
  nextHarvestInSeconds: number;
  protocolFeeBps: number;
  /**
   * How long a due harvest has not happened, in seconds; 0 when on schedule,
   * null when unknown. A keeper that dies silently is a vault paying zero
   * while displaying a yield (§8, P3), so this is shown, not hidden.
   */
  harvestLagSeconds?: number | null;
  /**
   * The vault's pool read live from the chain; absent until the watcher has
   * read it (and in the simulator's older snapshots). Where present, every
   * vault figure on the site comes from here, not from the pool's row.
   */
  live?: VaultLive;
}

export interface UserStake {
  vaultId: string;
  poolId: string;
  stakedUsd: number;
  earnedWeth: number;
  /** 0–100, how far through the 7-day stream this position is. */
  streamProgressPct: number;
  streamRemainingSeconds: number;
}

export interface UserPosition {
  tokenId: string;
  poolId: string;
  shape: ShapeId;
  rangePct: number;
  inRange: boolean;
  /** Set when inRange is false: how long it has been earning nothing. */
  outOfRangeSinceHours?: number;
  valueUsd: number;
  feesWeth: number;
}

export interface Portfolio {
  netValueUsd: number;
  netChangeUsd: number;
  netChangePct: number;
  feesEarnedWeth: number;
  feesEarnedUsd: number;
  /** Impermanent loss, under its honest name (§7). Negative. */
  priceImpactUsd: number;
  fees7dUsd: number;
  /** 56 days of WETH fees, oldest first. */
  dailyFeesWeth: number[];
  stakes: UserStake[];
  positions: UserPosition[];
  claimableWeth: number;
  /**
   * Spendable ETH in the connected wallet, or null with no wallet connected —
   * which, until P2 brings a connector, is always the case on the live site.
   * The forms read it from here rather than a constant, so a live page never
   * offers "Max 4.18" out of a wallet nobody connected.
   */
  walletBalanceEth: number | null;
}

export interface GlobalStats {
  totalPositions: number;
  totalFeesUsd: number;
  tvlUsd: number;
  ethPriceUsd: number;
}

export interface Payout {
  id: string;
  poolId: string;
  weth: number;
  wallet: string;
}

export interface FeaturedStats {
  fees24hUsd: number;
  change24hPct: number;
  volume24hUsd: number;
  liquidityUsd: number;
  stakers: number;
  chainSharePct: number;
  /** Fees paid per 12h bucket over the trailing 7 days, oldest first: 14 points. */
  history: number[];
}

export interface RouterPlan {
  tokenSymbol: string;
  feeSourceAddress: string;
  accruedWeth: number;
  accruedUsd: number;
  currentDepthUsd: number;
  projectedDepthUsd: number;
  /** Slippage on a $5K buy, now and after 30 days at the current fee rate. */
  slippageNowPct: number;
  slippageLaterPct: number;
  firstRouteWeth: number;
  firstRouteDepthUsd: number;
  twapMinutes: number;
  /**
   * Whether the token's deployer has been verified as the one configuring the
   * route. Nothing verifies a deployer until P4, so the live API sends false
   * and the badge does not render — it used to be printed unconditionally.
   */
  deployerVerified: boolean;
}

export interface MarketSnapshot {
  pools: Pool[];
  vaults: Vault[];
  portfolio: Portfolio;
  global: GlobalStats;
  featured: FeaturedStats;
  router: RouterPlan;
  /** Last few fee payouts, newest first. */
  payouts: Payout[];
  payoutTotalUsd: number;
  /** How far behind head the indexer is. Shown in the top bar (§7). */
  indexerLagSeconds: number;
  /** Monotonic counter so consumers can cheaply detect a new snapshot. */
  revision: number;
}

export type MarketListener = (snapshot: MarketSnapshot) => void;
export type Unsubscribe = () => void;

export type ProviderKind = 'sim' | 'live';

export interface DataProvider {
  readonly kind: ProviderKind;
  /** Latest snapshot, or null if none has arrived yet (live, pre-connect). */
  getSnapshot(): MarketSnapshot | null;
  /** Push deltas. The returned function detaches and may stop the stream. */
  subscribe(listener: MarketListener): Unsubscribe;
}
