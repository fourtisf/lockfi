/**
 * Token and pool discovery.
 *
 * §4 draws a hard line: numbers come from chain events, but logos and token
 * metadata may come from elsewhere. Symbol, name and decimals are read from
 * the token contract — on-chain, and the only place a string the site displays
 * comes from outside our own tables.
 */

import { Prisma } from '@prisma/client';
import { getAddress } from 'viem';
import { CONTRACTS } from '../../lib/chain';
import { tokenMark } from '../../lib/token-mark';
import { ERC20_ABI } from '../chain/abi';
import { rpc } from '../chain/client';
import { prisma } from '../db';
import { NATIVE_CURRENCY, pricedCurrencies } from './events';

/**
 * Hook addresses belonging to launchpads (§4: Pons, Bags, Bottom.fun).
 *
 * A pool whose hook is one of these is pre-graduation: index it for the
 * listing, but never offer it as a stake. The addresses are configuration
 * because they are not in the handoff and inventing them would silently mark
 * real pools unstakeable, or worse, mark launchpad pools stakeable.
 *
 *   LAUNCHPAD_HOOKS=Pons:0xabc…,Bags:0xdef…,Bottom.fun:0x123…
 *
 * With none configured every pool is stakeable, which is the conservative
 * direction for a listing and the wrong direction for a vault — so P2 must
 * not deploy a vault against a pool discovered while this was empty.
 */
function parseLaunchpadHooks(): Map<string, string> {
  const raw = process.env.LAUNCHPAD_HOOKS;
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const [name, address] = entry.split(':').map((s) => s?.trim());
    if (!name || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`LAUNCHPAD_HOOKS entry is malformed: ${JSON.stringify(entry)}`);
    }
    map.set(address.toLowerCase(), name);
  }
  return map;
}

export const LAUNCHPAD_HOOKS = parseLaunchpadHooks();

const ZERO_HOOK = '0x0000000000000000000000000000000000000000';

/** Which launchpad a pool's hook belongs to, if any. */
export function launchpadFor(hooks: string | null): string | null {
  if (!hooks || hooks.toLowerCase() === ZERO_HOOK) return null;
  return LAUNCHPAD_HOOKS.get(hooks.toLowerCase()) ?? null;
}

/**
 * Pre-graduation launchpad liquidity is listed but not stakeable (§4).
 * A pool with no hook, or a hook we do not recognise, is stakeable.
 */
export function isStakeable(hooks: string | null): boolean {
  return launchpadFor(hooks) === null;
}

/**
 * Deterministic badge colour for a token, so a row's badge is stable across
 * reloads without needing a logo service in the critical path.
 *
 * Shares `lib/token-mark.ts` with the client rather than hashing separately:
 * the saturation and lightness there were measured to keep the monogram
 * legible on every hue, and a second implementation would drift off that
 * guarantee without anything failing. It also means a token looks the same
 * whether the colour came from the indexer or was derived in the browser.
 */
export function brandColor(address: string): string {
  return tokenMark(address).bg;
}

export interface TokenFacts {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /**
   * `totalSupply()`, in the token's smallest units, or null if the contract
   * did not answer.
   *
   * TOTAL, not circulating — locked, vested and treasury-held tokens are all
   * in it and none of that is distinguishable on chain. What it produces is
   * fully diluted value, which is why it is labelled that way rather than
   * called market cap (§7).
   */
  totalSupply?: bigint | null;
}

/**
 * Read a token's metadata from its own contract.
 *
 * A token that does not answer is recorded under a truncated-address symbol
 * rather than skipped: a pool with an unreadable token still has real fees,
 * and dropping it would understate the chain totals.
 */
export async function readToken(address: string): Promise<TokenFacts> {
  const checksummed = getAddress(address);
  const fallback = `${address.slice(2, 6)}…${address.slice(-4)}`.toUpperCase();

  const read = async <T>(
    functionName: 'symbol' | 'name' | 'decimals' | 'totalSupply',
  ): Promise<T | null> => {
    try {
      return (await rpc(
        (c) => c.readContract({ address: checksummed, abi: ERC20_ABI, functionName }),
        `${functionName}(${address})`,
      )) as T;
    } catch {
      return null;
    }
  };

  const [symbol, name, decimals, totalSupply] = await Promise.all([
    read<string>('symbol'),
    read<string>('name'),
    read<number>('decimals'),
    read<bigint>('totalSupply'),
  ]);

  return {
    address: address.toLowerCase(),
    totalSupply: typeof totalSupply === 'bigint' && totalSupply > 0n ? totalSupply : null,
    // Trim: a token whose symbol is padded or absurdly long would break the
    // table layout, and the ticker is 14px/700 in a fixed column (§5).
    symbol: (symbol ?? fallback).trim().slice(0, 16) || fallback,
    name: (name ?? 'Unknown token').trim().slice(0, 64) || 'Unknown token',
    decimals: typeof decimals === 'number' && decimals >= 0 && decimals <= 36 ? decimals : 18,
  };
}

/** How a token's facts are obtained. Injectable for the same reason the log
 *  source is: §9's replay proof needs a chain it can reproduce exactly, token
 *  decimals included — and decimals are an input to every price. */
export type TokenReader = (address: string) => Promise<TokenFacts>;

/** Upsert tokens we have not seen. Existing rows are left alone. */
export async function ensureTokens(
  addresses: Iterable<string>,
  seenAt: Date,
  read: TokenReader = readToken,
): Promise<number> {
  const wanted = [...new Set([...addresses].map((a) => a.toLowerCase()))];
  if (wanted.length === 0) return 0;

  const existing = await prisma.token.findMany({
    where: { address: { in: wanted } },
    select: { address: true },
  });
  const known = new Set(existing.map((t) => t.address.toLowerCase()));
  const missing = wanted.filter((a) => !known.has(a));

  for (const address of missing) {
    const facts = await read(address);
    await prisma.token.upsert({
      where: { address: facts.address },
      create: {
        address: facts.address,
        symbol: facts.symbol,
        name: facts.name,
        decimals: facts.decimals,
        totalSupply: facts.totalSupply ? new Prisma.Decimal(facts.totalSupply.toString()) : null,
        supplyReadAt: facts.totalSupply ? seenAt : null,
        logoColor: brandColor(facts.address),
        launchpad: null,
        firstSeen: seenAt,
      },
      update: {},
    });
  }
  return missing.length;
}

/**
 * Correct pools recorded before native ETH was understood.
 *
 * `events.ts` now records a v4 pool's native-ETH side as WETH as it decodes
 * the Initialize. Pools already in the database from before that carry the
 * zero address and are invisible to every price and to the anchor search.
 * Re-reading the chain to fix them would be a full re-sync; their Initialize
 * is in the row already, so this rewrites the one column instead, and the
 * next rebuild prices them retroactively — aggregates are rebuilt from raw
 * rows (§14), so nothing else needs touching.
 *
 * Idempotent: on a database with no such pool it is one query and returns 0.
 */
export async function adoptNativeEthPools(
  seenAt: Date,
  read: TokenReader = readToken,
): Promise<number> {
  const native = await prisma.pool.findMany({
    where: { OR: [{ token0: NATIVE_CURRENCY }, { token1: NATIVE_CURRENCY }] },
    select: { id: true, token0: true, token1: true },
  });
  if (native.length === 0) return 0;

  // The WETH row must exist before a pool can point at it.
  await ensureTokens([CONTRACTS.weth], seenAt, read);
  let changed = 0;
  for (const pool of native) {
    const [token0, token1] = pricedCurrencies(pool.token0, pool.token1);
    if (token0 === pool.token0 && token1 === pool.token1) continue;
    await prisma.pool.update({ where: { id: pool.id }, data: { token0, token1 } });
    changed++;
  }

  // The placeholder read off address(0) — symbol "0000…0000" — once nothing
  // points at it. An ETH/WETH pool still does, and keeps it.
  const stillNative = await prisma.pool.count({
    where: { OR: [{ token0: NATIVE_CURRENCY }, { token1: NATIVE_CURRENCY }] },
  });
  if (stillNative === 0) await prisma.token.deleteMany({ where: { address: NATIVE_CURRENCY } });
  return changed;
}

/**
 * Re-read `totalSupply()` for the tokens whose figure is most stale.
 *
 * Supply is not immutable — a mintable token's changes, and a fully diluted
 * value computed from a stale supply is wrong in the direction that flatters
 * the token. But it is also one RPC call per token, so this refreshes a
 * bounded few per pass rather than all of them, oldest first.
 *
 * A token that stops answering keeps its last known supply and its old
 * timestamp, so the staleness is recorded rather than reset.
 */
export async function refreshSupplies(
  now: Date,
  options: { maxAgeMinutes?: number; limit?: number; read?: TokenReader } = {},
): Promise<number> {
  const maxAge = options.maxAgeMinutes ?? 60;
  const limit = options.limit ?? 5;
  const read = options.read ?? readToken;
  const cutoff = new Date(now.getTime() - maxAge * 60_000);

  const stale = await prisma.token.findMany({
    where: { OR: [{ supplyReadAt: null }, { supplyReadAt: { lt: cutoff } }] },
    orderBy: [{ supplyReadAt: { sort: 'asc', nulls: 'first' } }],
    take: limit,
    select: { address: true },
  });

  let updated = 0;
  for (const token of stale) {
    const facts = await read(token.address);
    if (!facts.totalSupply) continue;
    await prisma.token.update({
      where: { address: token.address },
      data: {
        totalSupply: new Prisma.Decimal(facts.totalSupply.toString()),
        supplyReadAt: now,
      },
    });
    updated++;
  }
  return updated;
}

/**
 * Apply the launchpad classification to pools. Separate from the ingest write
 * because it depends on configuration rather than on the log stream, and a
 * re-scan must not undo it.
 */
export async function classifyPools(): Promise<number> {
  const pools = await prisma.pool.findMany({ select: { id: true, hooks: true, token0: true, token1: true } });
  let changed = 0;
  for (const pool of pools) {
    const launchpad = launchpadFor(pool.hooks);
    const stakeable = launchpad === null;
    const updated = await prisma.pool.updateMany({
      where: { id: pool.id, stakeable: { not: stakeable } },
      data: { stakeable },
    });
    changed += updated.count;
    if (launchpad) {
      // The launchpad belongs on the token, which is what the row displays.
      await prisma.token.updateMany({
        where: { address: { in: [pool.token0, pool.token1] }, launchpad: null },
        data: { launchpad },
      });
    }
  }
  return changed;
}

/**
 * The WETH/USDG pool, which is the site's one USD anchor (§4.3).
 *
 * Chosen by depth, not by recency: if two WETH/USDG pools exist, the deeper
 * one is the honest anchor. Null when there is none, and every USD figure
 * downstream then reads zero rather than being guessed.
 */
export async function findAnchorPool(usdgAddress: string): Promise<string | null> {
  const weth = CONTRACTS.weth.toLowerCase();
  const usdg = usdgAddress.toLowerCase();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id
    FROM pools p
    LEFT JOIN pool_state ps ON ps.pool_id = p.id
    WHERE (lower(p.token0) = ${weth} AND lower(p.token1) = ${usdg})
       OR (lower(p.token0) = ${usdg} AND lower(p.token1) = ${weth})
    ORDER BY COALESCE(ps.liquidity, 0) DESC, p.created_block ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}
