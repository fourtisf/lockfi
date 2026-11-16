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
   * True when a read failed because no endpoint could be reached or each
   * refused (rate limit, timeout) — not because the contract answered. The
   * fallbacks above are then guesses about a token nobody heard from, and
   * are not written: the token stays pending and is read again on the next
   * pass that needs it. A token that answered with a revert is a fact, and
   * its fallbacks stand.
   */
  transient?: boolean;
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
/**
 * True when a read failed for want of an answer — every endpoint timed out,
 * refused the connection or rate-limited it — rather than because the
 * contract answered badly. Anything else (a revert, no code, an undecodable
 * reply) is the contract's answer, so a strange token can never keep a pass
 * from completing.
 */
export function networkFailure(message: string): boolean {
  return /HTTP request failed|took too long|timed? ?out|\b429\b|too many requests|rate.?limit|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|\b50[234]\b|bad gateway|service unavailable/i.test(message);
}

export async function readToken(address: string): Promise<TokenFacts> {
  const checksummed = getAddress(address);
  const fallback = `${address.slice(2, 6)}…${address.slice(-4)}`.toUpperCase();

  let transient = false;
  const read = async <T>(
    functionName: 'symbol' | 'name' | 'decimals' | 'totalSupply',
  ): Promise<T | null> => {
    try {
      return (await rpc(
        (c) => c.readContract({ address: checksummed, abi: ERC20_ABI, functionName }),
        `${functionName}(${address})`,
      )) as T;
    } catch (error) {
      // totalSupply is re-read on its own cadence; only the facts that are
      // written once decide whether this read can be trusted.
      if (functionName !== 'totalSupply' && networkFailure(String((error as Error)?.message ?? error))) transient = true;
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
    ...(transient ? { transient: true } : {}),
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

/** Decimals of a token recorded but not yet read (`ensureTokens` lazy). */
export const PENDING_DECIMALS = -1;

/**
 * Read the real facts of any of these tokens recorded lazily. Called for the
 * tokens of every pool a swap touches, before the swap is valued.
 */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function hydrateTokens(addresses: Iterable<string>, read: TokenReader = readToken): Promise<number> {
  const wanted = [...new Set([...addresses].map((a) => a.toLowerCase()))];
  if (wanted.length === 0) return 0;
  const pending = await prisma.token.findMany({
    where: { address: { in: wanted }, decimals: PENDING_DECIMALS },
    select: { address: true },
  });
  const now = new Date();
  let read10 = 0;
  const retry: string[] = [];
  const readAll = async (addresses: string[], onTransient: (address: string) => void) => {
    const out: TokenFacts[] = [];
    for (let i = 0; i < addresses.length; i += 10) {
      for (const f of await Promise.all(addresses.slice(i, i + 10).map((a) => read(a)))) {
        if (f.transient) onTransient(f.address);
        else out.push(f);
      }
    }
    return out;
  };
  // Once now, and once more after a breath for any nobody answered: a 429 is
  // usually a burst. Still unanswered, a token stays pending and is read on
  // the next pass that needs it (TokenFacts.transient).
  const first = await readAll(pending.map((t) => t.address), (a) => retry.push(a));
  const second = retry.length > 0 ? (await wait(1_500), await readAll(retry, () => {})) : [];
  for (const facts of [first, second]) {
    for (const f of facts) {
      read10++;
      await prisma.token.update({
        where: { address: f.address },
        data: {
          symbol: f.symbol,
          name: f.name,
          decimals: f.decimals,
          totalSupply: f.totalSupply ? new Prisma.Decimal(f.totalSupply.toString()) : null,
          supplyReadAt: f.totalSupply ? now : null,
        },
      });
    }
  }
  return read10;
}

/** Upsert tokens we have not seen. Existing rows are left alone. */
export async function ensureTokens(
  addresses: Iterable<string>,
  seenAt: Date,
  read: TokenReader = readToken,
  options: {
    /**
     * Record the address and nothing else: symbol and name empty, decimals
     * -1. For pools found in ranges older than the swap window, most of which
     * are launches that never traded again — reading four facts off each of
     * hundreds of thousands of contracts was most of a structure pass. A
     * token is read for real (`hydrateTokens`) the first time a swap needs
     * it, and nothing prices a token whose decimals are unknown.
     */
    lazy?: boolean;
  } = {},
): Promise<number> {
  const wanted = [...new Set([...addresses].map((a) => a.toLowerCase()))];
  if (wanted.length === 0) return 0;

  const existing = await prisma.token.findMany({
    where: { address: { in: wanted } },
    select: { address: true },
  });
  const known = new Set(existing.map((t) => t.address.toLowerCase()));
  const missing = wanted.filter((a) => !known.has(a));

  if (options.lazy) {
    await prisma.token.createMany({
      data: missing.map((address) => ({
        address,
        symbol: '',
        name: '',
        decimals: PENDING_DECIMALS,
        logoColor: brandColor(address),
        launchpad: null,
        firstSeen: seenAt,
      })),
      skipDuplicates: true,
    });
    return missing.length;
  }

  // Read ten at a time: the reads for a group go out together, which the
  // client sends as one JSON-RPC batch. One by one, a pass that met thirty new
  // launchpad tokens spent seconds here.
  const read10: TokenFacts[] = [];
  for (let i = 0; i < missing.length; i += 10) {
    read10.push(...(await Promise.all(missing.slice(i, i + 10).map((address) => read(address)))));
  }
  for (const facts of read10) {
    if (facts.transient) {
      // Recorded without facts, to be read when a swap next needs it.
      await prisma.token.createMany({
        data: [{ address: facts.address, symbol: '', name: '', decimals: PENDING_DECIMALS, logoColor: brandColor(facts.address), launchpad: null, firstSeen: seenAt }],
        skipDuplicates: true,
      });
      continue;
    }
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
    // Never a token recorded lazily: its supply is read with its other facts.
    where: { decimals: { gte: 0 }, OR: [{ supplyReadAt: null }, { supplyReadAt: { lt: cutoff } }] },
    orderBy: [{ supplyReadAt: { sort: 'asc', nulls: 'first' } }],
    take: limit,
    select: { address: true },
  });

  let updated = 0;
  for (const token of stale) {
    const facts = await read(token.address);
    if (!facts.totalSupply) {
      // Asked, and no supply came back: it waits its turn like any other.
      // Left unmarked it stayed first in the queue — oldest read, nulls
      // first — so the same few tokens that never report a supply were read
      // on every refresh, five a time, and no other token's supply was ever
      // refreshed again.
      await prisma.token.update({ where: { address: token.address }, data: { supplyReadAt: now } });
      continue;
    }
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
  // Set-based. This was one UPDATE per pool, every pass — thousands of round
  // trips a pass once the chain had thousands of pools, on a step that almost
  // never changes anything.
  const hooks = [...LAUNCHPAD_HOOKS.entries()];
  const launchpadHooks = hooks.map(([hook]) => hook);

  // Every pool not on a configured launchpad hook is stakeable (§4).
  const freed = await prisma.pool.updateMany({
    where:
      launchpadHooks.length === 0
        ? { stakeable: false }
        : { stakeable: false, OR: [{ hooks: null }, { hooks: { notIn: launchpadHooks } }] },
    data: { stakeable: true },
  });
  let changed = freed.count;

  for (const [hook, launchpad] of hooks) {
    const held = await prisma.pool.updateMany({
      where: { hooks: hook, stakeable: true },
      data: { stakeable: false },
    });
    changed += held.count;
    // The launchpad belongs on the token, which is what the row displays.
    const pools = await prisma.pool.findMany({
      where: { hooks: hook },
      select: { token0: true, token1: true },
    });
    const tokens = [...new Set(pools.flatMap((p) => [p.token0, p.token1]))];
    if (tokens.length > 0) {
      await prisma.token.updateMany({
        where: { address: { in: tokens }, launchpad: null },
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
