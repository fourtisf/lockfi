/**
 * Finding the USD anchor without being told.
 *
 * §4.3 allows exactly one path to a dollar figure: the WETH/USDG pool prices
 * WETH, and everything else prices through WETH. §2 names USDG as the day-one
 * stablecoin but not its address, so until now the indexer refused to start
 * until a human looked the address up and set `USDG_ADDRESS`.
 *
 * That is a bad design, and it showed: the site sat on a "not configured"
 * page waiting for a step only a person could take. The indexer already reads
 * every token's symbol off its own contract while discovering pools — it has
 * the answer in its own tables. So it looks.
 *
 * The order this can happen in is the interesting part, and it works because
 * of a decision made much earlier: aggregates are REBUILT, never incremented.
 * So the indexer can write raw rows with no anchor at all, discover the anchor
 * later, and the next rebuild prices everything retroactively. Nothing needs
 * a second pass over the chain.
 *
 * Where it will not guess: if two tokens both call themselves USDG, the wrong
 * choice makes every dollar figure on the site wrong in a way nothing
 * downstream can detect. It picks the one with real depth, says so, and
 * reports both — and `USDG_ADDRESS` still overrides everything.
 */

import { CONTRACTS } from '../../lib/chain';
import { prisma } from '../db';

/** Symbols a day-one stablecoin on this chain might legitimately carry. */
const STABLE_SYMBOLS = ['USDG'];

export type AnchorSource = 'configured' | 'discovered' | 'none';

export interface AnchorCandidate {
  address: string;
  symbol: string;
  decimals: number;
  /** Pools pairing it with WETH. The anchor has to trade against WETH. */
  wethPools: number;
  /** Swaps across those pools: depth, as opposed to mere existence. */
  swaps: number;
}

export interface AnchorResolution {
  address: string | null;
  source: AnchorSource;
  /** Every token that called itself a stablecoin, best first. */
  candidates: AnchorCandidate[];
  /** Why this address, in a sentence, for the log and for /api/health. */
  note: string;
}

function isAddress(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Resolve the anchor: configuration first, then the chain's own tokens.
 *
 * Cheap enough to call every pass — it is one indexed query — which matters
 * because the anchor may not exist yet on the first pass and must be picked
 * up the moment it does.
 */
export async function resolveUsdg(configured?: string | null): Promise<AnchorResolution> {
  if (isAddress(configured)) {
    return {
      address: configured.toLowerCase(),
      source: 'configured',
      candidates: [],
      note: 'USDG_ADDRESS was set explicitly; no discovery was attempted.',
    };
  }
  if (configured) {
    // Set but malformed. Never fall through to discovery on this: someone
    // meant to pin a specific token and mistyped it, and silently choosing a
    // different one is worse than stopping.
    return {
      address: null,
      source: 'none',
      candidates: [],
      note: `USDG_ADDRESS is set but is not an address: ${JSON.stringify(configured)}`,
    };
  }

  const weth = CONTRACTS.weth.toLowerCase();
  const candidates = await prisma.$queryRaw<
    { address: string; symbol: string; decimals: number; weth_pools: number; swaps: number }[]
  >`
    SELECT
      t.address,
      t.symbol,
      t.decimals,
      COUNT(DISTINCT p.id)::int                    AS weth_pools,
      COALESCE(SUM(s.swaps), 0)::int               AS swaps
    FROM tokens t
    JOIN pools p
      ON (lower(p.token0) = lower(t.address) AND lower(p.token1) = ${weth})
      OR (lower(p.token1) = lower(t.address) AND lower(p.token0) = ${weth})
    LEFT JOIN (
      SELECT pool_id, COUNT(*)::int AS swaps FROM swap_events GROUP BY pool_id
    ) s ON s.pool_id = p.id
    WHERE upper(t.symbol) = ANY(${STABLE_SYMBOLS})
    GROUP BY t.address, t.symbol, t.decimals
    ORDER BY swaps DESC, weth_pools DESC, t.address ASC
  `;

  const mapped: AnchorCandidate[] = candidates.map((c) => ({
    address: c.address.toLowerCase(),
    symbol: c.symbol,
    decimals: c.decimals,
    wethPools: c.weth_pools,
    swaps: c.swaps,
  }));

  if (mapped.length === 0) {
    return {
      address: null,
      source: 'none',
      candidates: [],
      note:
        `No token with symbol ${STABLE_SYMBOLS.join(' or ')} paired with ETH or WETH has been ` +
        'indexed yet. Dollar figures appear once one is — or set USDG_ADDRESS to pin it.',
    };
  }

  const best = mapped[0];
  if (mapped.length === 1) {
    return {
      address: best.address,
      source: 'discovered',
      candidates: mapped,
      note:
        `Discovered ${best.symbol} at ${best.address} — the only token by that name ` +
        `trading against WETH (${best.wethPools} pool(s), ${best.swaps} swaps).`,
    };
  }

  return {
    address: best.address,
    source: 'discovered',
    candidates: mapped,
    note:
      `${mapped.length} tokens call themselves ${best.symbol}. Chose ${best.address} ` +
      `on depth (${best.swaps} swaps across ${best.wethPools} pool(s)); the runner-up ` +
      `${mapped[1].address} has ${mapped[1].swaps}. Set USDG_ADDRESS to pin a different one.`,
  };
}
