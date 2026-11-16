/**
 * The token on its launchpad curve (§30): Pons's bonding curve, read from its
 * own events and reserves. Pure functions, shared by the API that reads the
 * chain and the tests that pin the arithmetic.
 *
 * What the curve's events mean was not taken from documentation (there is
 * none on chain). It was measured: replaying every Buy and Sell since launch
 * with the reading below lands on the curve's own getReserves() to the wei,
 * and the API repeats that check on every read (`verified`).
 */

/** Pons curve events, by topic0. Three topics: the event, then the trader twice. */
export const PONS_BUY_TOPIC = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455';
export const PONS_SELL_TOPIC = '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df';

export interface CurveReserves {
  /** wei: real ETH in the curve plus its virtual reserve */
  eth: bigint;
  /** token base units still in the curve */
  tokens: bigint;
}

export interface CurveTrade {
  kind: 'buy' | 'sell';
  block: number;
  logIndex: number;
  /** ms since epoch, the block's time */
  at: number;
  /** what the trader paid or received before the curve's fees, in wei */
  ethGross: bigint;
  /** how the curve's ETH reserve moved (fees leave it) */
  ethDelta: bigint;
  /** how the curve's token reserve moved */
  tokenDelta: bigint;
}

function words(data: string): bigint[] {
  return (data.startsWith('0x') ? data.slice(2) : data).match(/.{64}/g)?.map((w) => BigInt(`0x${w}`)) ?? [];
}

/**
 * Buy: (ETH in, tokens out, fee, fee); the reserve keeps ETH in less both
 * fees. Sell: (tokens in, ETH out, fee, fee); the reserve gives up ETH out
 * plus both fees. Anything else the curve emits is not a trade.
 */
export function decodeCurveTrade(
  log: { topics: readonly string[]; data: string; blockNumber: bigint | number; logIndex: number },
  at: number,
): CurveTrade | null {
  const topic = log.topics[0]?.toLowerCase();
  const w = words(log.data);
  if (w.length < 4) return null;
  const [a, b, f1, f2] = w;
  const base = { block: Number(log.blockNumber), logIndex: log.logIndex, at };
  if (topic === PONS_BUY_TOPIC) return { ...base, kind: 'buy', ethGross: a, ethDelta: a - f1 - f2, tokenDelta: -b };
  if (topic === PONS_SELL_TOPIC) return { ...base, kind: 'sell', ethGross: b + f1 + f2, ethDelta: -(b + f1 + f2), tokenDelta: a };
  return null;
}

/** ETH per token. Both sides have 18 decimals, so the ratio of base units is the price. */
export function priceOf(r: CurveReserves): number {
  return r.tokens > 0n ? Number(r.eth) / Number(r.tokens) : 0;
}

/** The reserves after every trade, from the launch reserves. */
export function replay(initial: CurveReserves, trades: readonly CurveTrade[]): { points: { at: number; price: number }[]; end: CurveReserves } {
  let eth = initial.eth;
  let tokens = initial.tokens;
  const points: { at: number; price: number }[] = [];
  for (const t of trades) {
    eth += t.ethDelta;
    tokens += t.tokenDelta;
    points.push({ at: t.at, price: priceOf({ eth, tokens }) });
  }
  return { points, end: { eth, tokens } };
}

export interface TokenLive {
  address: string;
  symbol: string;
  launchpad: string;
  buyUrl: string;
  curve: string;
  graduated: boolean;
  /** ETH per token, from the curve's reserves now; null once graduated */
  priceEth: number | null;
  priceUsd: number | null;
  /** price × supply: fully diluted, said so wherever it is shown */
  fdvUsd: number | null;
  supply: number;
  /** real ETH the curve holds */
  ethInCurve: number;
  launchedAt: string;
  ageHours: number;
  /** move against 24h ago, or since launch while younger than a day */
  changePct: number | null;
  /** hours the move covers: 24, or the token's age */
  changeHours: number | null;
  volumeEth: number;
  volumeUsd: number | null;
  /** hours the volume covers: 24, or the token's age */
  volumeHours: number;
  trades: number;
  buys: number;
  sells: number;
  /** price after each trade in the window, ETH per token, oldest first */
  history: { t: number; p: number }[];
  /** the replay of every trade since launch lands on the curve's reserves */
  verified: boolean;
  asOf: string;
  /**
   * Once graduated: the Uniswap v4 pool the token moved to, and whether a
   * Tidewell vault can hold it (vaults need a pool without a hook).
   */
  uniswapPool?: { id: string; fee: number; hooks: string; vaultEligible: boolean } | null;
}

const DAY = 24 * 3600 * 1000;

/** Keep at most `n` points, always the first and the last. */
function thin<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = (xs.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => xs[Math.round(i * step)]);
}

export function summariseCurve(input: {
  meta: { address: string; symbol: string; launchpad: string; buyUrl: string; curve: string; supply: number };
  initial: CurveReserves;
  trades: readonly CurveTrade[];
  reserves: CurveReserves;
  ethInCurveWei: bigint;
  graduated: boolean;
  launchedAt: number;
  now: number;
  ethUsd: number | null;
}): TokenLive {
  const { meta, initial, trades, reserves, graduated, launchedAt, now, ethUsd } = input;
  const { points, end } = replay(initial, trades);
  const verified = !graduated && end.eth === reserves.eth && end.tokens === reserves.tokens;
  const priceEth = graduated ? null : priceOf(reserves);
  const priceUsd = priceEth !== null && ethUsd ? priceEth * ethUsd : null;
  const ageMs = Math.max(0, now - launchedAt);
  const windowMs = Math.min(DAY, ageMs);
  const since = now - windowMs;

  // The price at the window's start: the last trade before it, else launch.
  let ref = priceOf(initial);
  for (const p of points) if (p.at <= since) ref = p.price;
  const inWindow = trades.filter((t) => t.at > since);
  const volumeWei = inWindow.reduce((s, t) => s + t.ethGross, 0n);
  const volumeEth = Number(volumeWei) / 1e18;
  const history =
    priceEth === null ? [] : thin([{ t: since, p: ref }, ...points.filter((p) => p.at > since).map((p) => ({ t: p.at, p: p.price })), { t: now, p: priceEth }], 120);

  return {
    ...meta,
    graduated,
    priceEth,
    priceUsd,
    fdvUsd: priceUsd !== null ? priceUsd * meta.supply : null,
    ethInCurve: Number(input.ethInCurveWei) / 1e18,
    launchedAt: new Date(launchedAt).toISOString(),
    ageHours: ageMs / 3_600_000,
    // Only from a replay that matched the curve: otherwise the past is a guess.
    changePct: verified && priceEth !== null && ref > 0 ? (priceEth / ref - 1) * 100 : null,
    changeHours: verified ? windowMs / 3_600_000 : null,
    volumeEth,
    volumeUsd: ethUsd ? volumeEth * ethUsd : null,
    volumeHours: windowMs / 3_600_000,
    trades: inWindow.length,
    buys: inWindow.filter((t) => t.kind === 'buy').length,
    sells: inWindow.filter((t) => t.kind === 'sell').length,
    history: verified ? history : [],
    verified,
    asOf: new Date(now).toISOString(),
  };
}
