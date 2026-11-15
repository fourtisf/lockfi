/**
 * Tidewell's own contracts: the vaults (P2), the router factory and the
 * routers it creates (P4).
 *
 * Their logs are read like the PoolManager's — in ranges, re-scanning the
 * last 32 blocks every pass, upserted by `(tx_hash, log_index)` into one raw
 * table — and the tables the site reads are REBUILT from those rows on every
 * pass, never incremented (§14). A re-scan, a restart or a replay from the
 * deployment block therefore produces the same `vaults` and `stakes` rows.
 *
 * Each contract has its own cursor (`tidewell:<address>`), independent of the
 * PoolManager's: these contracts emit a handful of logs a day, so they are
 * read to head on every pass even while the pool indexer is still crossing
 * months of history — a stake, a claim, a router's last observation are
 * current when the boards are not.
 *
 * Discovery: vaults come from config/deployments.json; routers are whatever
 * the factory's RouterCreated events announce, read from this same table, so
 * a router is followed from the block it was created in.
 */

import { decodeEventLog, type Abi } from 'viem';
import { CONTRACTS } from '../../lib/chain';
import { tidewellRouterAbi, tidewellRouterFactoryAbi, tidewellVaultAbi } from '../../lib/contracts/abis';
import type { VaultDeployment } from '../../lib/contracts/deployments';
import { prisma } from '../db';
import {
  MAX_SANE_PRICE_USD,
  MAX_SANE_TOTAL_USD,
  positionAmount0Sql,
  positionAmount1Sql,
  ratioSql,
  sane,
  type PriceAnchors,
} from './aggregate';
import type { LogSource } from './poller';
import { writeCursor } from './store';

export type ContractSource = 'vault' | 'router' | 'router-factory';

export interface WatchedContract {
  address: string;
  source: ContractSource;
  /** First block to read: a vault's deployedBlock, a router's creation block. */
  fromBlock: bigint;
}

export interface ContractsConfig {
  vaults: VaultDeployment[];
  /** Null when no factory is deployed: no routers to follow. */
  routerFactory: { address: string; fromBlock: bigint } | null;
}

/** The cursor row for one of our contracts. */
export function contractCursorKey(address: string): string {
  return `tidewell:${address.toLowerCase()}`;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const POOL_ID = /^v4:0x[0-9a-f]{64}$/;

const ABIS: Record<ContractSource, Abi> = {
  vault: tidewellVaultAbi as unknown as Abi,
  router: tidewellRouterAbi as unknown as Abi,
  'router-factory': tidewellRouterFactoryAbi as unknown as Abi,
};

/** Which argument names the address an event is ABOUT, per event. */
const ACCOUNT_ARG: Record<string, string> = {
  Deposited: 'recipient', // the share owner; `sender` paid
  Withdrawn: 'account',
  Claimed: 'account', // whose fees; `recipient` received them
  ProtocolFeesPaid: 'treasury',
  KeeperSet: 'keeper', // a router's
  TreasurySet: 'treasury',
  OwnershipTransferStarted: 'newOwner',
  OwnershipTransferred: 'newOwner',
  UnroutedWithdrawn: 'to',
  RouterCreated: 'router',
};

export interface ContractEventRow {
  txHash: string;
  logIndex: number;
  contract: string;
  source: ContractSource;
  blockNum: bigint;
  blockTime: Date;
  kind: string;
  account: string | null;
  args: Record<string, string | number | boolean>;
}

/** JSON-safe and deterministic: uints as decimal strings, addresses lowercase. */
function plain(value: unknown): string | number | boolean {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

/**
 * One raw log to a row, or null for anything the contract's ABI does not
 * describe. A pure function of the log, so a replay writes the same row.
 */
export function decodeContractLog(
  log: { address: string; topics: string[]; data: string; blockNumber: bigint; logIndex: number; transactionHash: string },
  source: ContractSource,
  blockTime: Date,
): ContractEventRow | null {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: ABIS[source],
      data: log.data as `0x${string}`,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    }) as unknown as { eventName: string; args: Record<string, unknown> };
  } catch {
    return null;
  }
  const args: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(decoded.args ?? {})) args[key] = plain(value);
  const accountArg = ACCOUNT_ARG[decoded.eventName];
  const account = accountArg && typeof args[accountArg] === 'string' ? (args[accountArg] as string) : null;
  return {
    txHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    contract: log.address.toLowerCase(),
    source,
    blockNum: log.blockNumber,
    blockTime,
    kind: decoded.eventName,
    account,
    args,
  };
}

export async function writeContractEvents(rows: ContractEventRow[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const result = await prisma.contractEvent.createMany({
      data: rows.slice(i, i + 500).map((r) => ({ ...r, args: r.args })),
      // The key is the log's own coordinates: a duplicate is the same row.
      skipDuplicates: true,
    });
    written += result.count;
  }
  return written;
}

export interface RouterRef {
  address: string;
  token: string;
  owner: string;
  /** `v4:0x…`, the indexer's pool id. */
  poolId: string;
  createdBlock: bigint;
  createdAt: Date;
}

/** Routers the factory has announced, oldest first. */
export async function routersFromFactory(factory: string | null): Promise<RouterRef[]> {
  if (!factory) return [];
  const rows = await prisma.contractEvent.findMany({
    where: { contract: factory.toLowerCase(), kind: 'RouterCreated' },
    orderBy: [{ blockNum: 'asc' }, { logIndex: 'asc' }],
  });
  return rows.map((r) => {
    const args = r.args as Record<string, string>;
    return {
      address: String(args.router).toLowerCase(),
      token: String(args.token).toLowerCase(),
      owner: String(args.owner).toLowerCase(),
      poolId: `v4:${String(args.poolId).toLowerCase()}`,
      createdBlock: r.blockNum,
      createdAt: r.blockTime,
    };
  });
}

/** Every contract to read this pass: configured vaults, the factory, its routers. */
export async function watchedContracts(config: ContractsConfig): Promise<WatchedContract[]> {
  const out: WatchedContract[] = config.vaults.map((v) => ({
    address: v.address.toLowerCase(),
    source: 'vault' as const,
    fromBlock: BigInt(v.deployedBlock),
  }));
  if (config.routerFactory) {
    out.push({ address: config.routerFactory.address.toLowerCase(), source: 'router-factory', fromBlock: config.routerFactory.fromBlock });
    for (const router of await routersFromFactory(config.routerFactory.address)) {
      out.push({ address: router.address, source: 'router', fromBlock: router.createdBlock });
    }
  }
  return out;
}

export interface ContractPassResult {
  fromBlock: bigint;
  toBlock: bigint;
  events: number;
  written: number;
  /** True when every contract's cursor reached head. */
  caughtUp: boolean;
  vaultsWritten: number;
}

/**
 * Reads Tidewell's contracts in one `eth_getLogs` per pass: from the
 * earliest contract's resume point to head, every address at once, each log
 * kept only from its own contract's resume point. Contracts already at head
 * re-read a few blocks, which the upsert makes free.
 */
export class ContractIndexer {
  private range: bigint;
  private readonly floor: bigint;
  private readonly ceiling: bigint;
  private lastPassAt = 0;
  private behind = true;
  /** Vault diagnostics already logged, so a lasting one is said once. */
  private readonly said = new Set<string>();

  constructor(
    private readonly options: {
      source: LogSource;
      config: ContractsConfig;
      reorgDepth: bigint;
      /** Blocks per read to start from; widened while behind, halved on refusal. */
      startRange: bigint;
      /** Least time between passes once at head. */
      everyMs: number;
      log: (message: string) => void;
    },
  ) {
    this.range = options.startRange;
    this.floor = options.reorgDepth * 2n > 64n ? options.reorgDepth * 2n : 64n;
    this.ceiling = options.startRange * 10n;
  }

  get hasVaults(): boolean {
    return this.options.config.vaults.length > 0;
  }

  /** True until every contract's cursor has reached head and nothing new was announced. */
  get isBehind(): boolean {
    return this.behind;
  }

  /** Whether to read this pass: always while behind, then at most every `everyMs`. */
  due(now = Date.now()): boolean {
    return this.behind || now - this.lastPassAt >= this.options.everyMs;
  }

  async pass(head: { number: bigint; timestamp: Date }, anchors: PriceAnchors | null): Promise<ContractPassResult | null> {
    this.lastPassAt = Date.now();
    const { source, reorgDepth, log } = this.options;
    const contracts = await watchedContracts(this.options.config);
    if (contracts.length === 0) {
      this.behind = false;
      return null;
    }

    const cursorRows = await prisma.indexerCursor.findMany({
      where: { contract: { in: contracts.map((c) => contractCursorKey(c.address)) } },
    });
    const cursorOf = new Map(cursorRows.map((r) => [r.contract, r.lastIndexedBlock]));
    const resumeAt = new Map<string, bigint>();
    for (const c of contracts) {
      const cursor = cursorOf.get(contractCursorKey(c.address));
      const from = cursor === undefined ? c.fromBlock : max(c.fromBlock, cursor - reorgDepth + 1n);
      resumeAt.set(c.address, from);
    }
    const from = [...resumeAt.values()].reduce((a, b) => (b < a ? b : a));
    let vaultsWritten = 0;
    if (from > head.number) {
      // Every contract is deployed past head (a config typo, or a lagging node).
      this.behind = false;
      if (this.hasVaults) vaultsWritten = await this.rebuild(anchors);
      return { fromBlock: from, toBlock: head.number, events: 0, written: 0, caughtUp: true, vaultsWritten };
    }
    const to = min(head.number, from + this.range - 1n);
    const included = contracts.filter((c) => resumeAt.get(c.address)! <= to);
    const sourceOf = new Map(included.map((c) => [c.address, c.source]));

    let logs;
    try {
      logs = await source.getLogs({ address: included.map((c) => c.address), fromBlock: from, toBlock: to });
    } catch (error) {
      // A busy endpoint is asked again next pass at the same width; anything
      // else is taken as the width being refused (poller.ts's reasoning).
      if (!/\b429\b|too many requests|rate.?limit/i.test((error as Error).message)) {
        this.range = max(this.floor, (to - from + 1n) / 2n);
        log(`  contract logs refused for ${to - from + 1n} blocks — range now ${this.range}`);
      }
      return null;
    }
    const times = await source.getBlockTimes(from, to);

    const rows: ContractEventRow[] = [];
    for (const raw of logs) {
      const address = raw.address.toLowerCase();
      const kind = sourceOf.get(address);
      if (!kind || raw.blockNumber < resumeAt.get(address)!) continue;
      const blockTime = times.get(raw.blockNumber);
      if (!blockTime) continue; // a block we could not time is a block we skip
      const row = decodeContractLog(raw, kind, blockTime);
      if (row) rows.push(row);
    }
    const written = await writeContractEvents(rows);
    const toTime = times.get(to) ?? head.timestamp;
    for (const c of included) await writeCursor(contractCursorKey(c.address), to, toTime);

    const created = rows.filter((r) => r.kind === 'RouterCreated');
    for (const r of created) log(`  router ${r.args.router} created for token ${r.args.token} — following it`);

    this.behind = to < head.number || created.length > 0;
    if (this.behind && logs.length < 1_000) this.range = min(this.ceiling, this.range * 2n);
    if (this.hasVaults) vaultsWritten = await this.rebuild(anchors);
    return { fromBlock: from, toBlock: to, events: rows.length, written, caughtUp: !this.behind, vaultsWritten };
  }

  private async rebuild(anchors: PriceAnchors | null): Promise<number> {
    const { written, problems } = await rebuildVaults(this.options.config.vaults, anchors);
    for (const problem of problems) {
      if (this.said.has(problem)) continue;
      this.said.add(problem);
      this.options.log(`  ${problem}`);
    }
    return written;
  }
}

/**
 * `vaults` and `stakes`, rebuilt from contract_events (§14: never
 * incremented).
 *
 * The vault credits fees per share the moment it collects them — any
 * deposit, withdraw, claim or poke collects first — and pays them in the
 * pool's own two tokens. So there is no stream, harvest or keeper to track;
 * the rows are what was staked, collected and paid:
 *
 *   total staked     Σ Deposited.liquidity − Σ Withdrawn.liquidity
 *   stakers          accounts whose share is above zero
 *   fees collected   Σ FeesCollected.amount0/1, before the protocol's cut
 *   protocol cut     Σ FeesCollected.protocolCut0/1
 *   claimed          Σ Claimed.amount0/1 (per wallet in `stakes`)
 *   protocol paid    Σ ProtocolFeesPaid.amount0/1
 *   protocol fee     the latest ProtocolFeeSet (the constructor emits one)
 *   staked USD       the vault's full-range liquidity valued at the pool's
 *                    latest price, by the same formulas as pool TVL
 *
 * A vault is written only once its pool is indexed (the row references it)
 * and its constructor's ProtocolFeeSet has been read. Without the second, the
 * fee the drawer discloses would be a guess — §7 says disclose, not guess —
 * and it means config's deployedBlock is after the constructor, so its first
 * deposits may be missing too. Both are reported, never papered over.
 */
export async function rebuildVaults(
  vaults: VaultDeployment[],
  anchors: PriceAnchors | null,
): Promise<{ written: number; problems: string[] }> {
  const configured = vaults.map((v) => ({ address: v.address.toLowerCase(), poolId: v.poolId.toLowerCase() }));
  for (const v of configured) {
    if (!ADDRESS.test(v.address) || !POOL_ID.test(v.poolId)) {
      throw new Error(`Refusing to interpolate a vault into SQL: ${JSON.stringify(v)}`);
    }
  }
  if (configured.length === 0) {
    await prisma.$executeRawUnsafe('DELETE FROM vaults');
    return { written: 0, problems: [] };
  }
  const weth = CONTRACTS.weth.toLowerCase();
  const usdg = anchors?.usdg?.toLowerCase() ?? '0x0000000000000000000000000000000000000000';
  if (!ADDRESS.test(usdg)) throw new Error(`Refusing to interpolate USDG into SQL: ${usdg}`);
  const values = configured.map((v) => `('${v.address}', '${v.poolId}')`).join(', ');
  const addressList = configured.map((v) => `'${v.address}'`).join(', ');
  /** Σ of one uint argument over one event kind, per vault. */
  const sum = (kind: string, arg: string) =>
    `COALESCE(SUM(CASE WHEN kind = '${kind}' THEN (args->>'${arg}')::numeric END), 0)`;

  const common = `
    cfg(address, pool_id) AS (VALUES ${values}),
    ev AS (SELECT * FROM contract_events WHERE contract IN (SELECT address FROM cfg)),
    asof AS (
      SELECT cfg.address, c.last_indexed_at AS at
      FROM cfg JOIN indexer_cursors c ON c.contract = 'tidewell:' || cfg.address
    )`;

  const upsertVaults = `
    WITH ${common},
    shares AS (
      SELECT contract AS address, account,
        SUM(CASE WHEN kind = 'Deposited' THEN (args->>'liquidity')::numeric
                 ELSE -(args->>'liquidity')::numeric END) AS shares
      FROM ev WHERE kind IN ('Deposited', 'Withdrawn') AND account IS NOT NULL
      GROUP BY contract, account
    ),
    totals AS (
      SELECT address, SUM(shares) AS staked, (COUNT(*) FILTER (WHERE shares > 0))::int AS stakers
      FROM shares GROUP BY address
    ),
    flows AS (
      SELECT contract AS address,
        ${sum('FeesCollected', 'amount0')} AS fees0,
        ${sum('FeesCollected', 'amount1')} AS fees1,
        ${sum('FeesCollected', 'protocolCut0')} AS cut0,
        ${sum('FeesCollected', 'protocolCut1')} AS cut1,
        ${sum('Claimed', 'amount0')} AS claimed0,
        ${sum('Claimed', 'amount1')} AS claimed1,
        ${sum('ProtocolFeesPaid', 'amount0')} AS paid0,
        ${sum('ProtocolFeesPaid', 'amount1')} AS paid1,
        MIN(block_time) FILTER (WHERE kind = 'Deposited') AS staked_since,
        MAX(block_time) FILTER (WHERE kind = 'FeesCollected') AS last_collected_at
      FROM ev GROUP BY contract
    ),
    fee AS (
      SELECT DISTINCT ON (contract) contract AS address, (args->>'bps')::int AS bps
      FROM ev WHERE kind = 'ProtocolFeeSet'
      ORDER BY contract, block_num DESC, log_index DESC
    ),
    opening AS (
      SELECT DISTINCT ON (contract) contract AS address, (args->>'open')::boolean AS open
      FROM ev WHERE kind = 'DepositsOpenSet'
      ORDER BY contract, block_num DESC, log_index DESC
    ),
    weth_usd AS (SELECT weth_usd AS usd FROM weth_usd_hourly ORDER BY hour DESC LIMIT 1),
    base AS (
      SELECT cfg.address, cfg.pool_id,
        COALESCE(t.staked, 0) AS staked,
        COALESCE(t.stakers, 0) AS stakers,
        t0.decimals AS dec0, t1.decimals AS dec1, t0.address AS addr0, t1.address AS addr1,
        -- The vault's position is full range: TickMath.min/maxUsableTick,
        -- which truncate toward zero exactly as trunc() does.
        exp((trunc(-887272::numeric / p.tick_spacing) * p.tick_spacing)::float8 * ln(1.0001::float8) / 2) AS sa,
        exp((trunc(887272::numeric / p.tick_spacing) * p.tick_spacing)::float8 * ln(1.0001::float8) / 2) AS sb,
        CASE WHEN COALESCE(ps.sqrt_price_x96, 0) = 0 THEN NULL
             ELSE ps.sqrt_price_x96::float8 / 2::float8 ^ 96 END AS sp,
        CASE WHEN COALESCE(ps.sqrt_price_x96, 0) = 0 THEN NULL
             ELSE ${ratioSql('ps.sqrt_price_x96', 't0.decimals', 't1.decimals')} END AS ratio,
        ${anchors ? '(SELECT usd FROM weth_usd)' : 'NULL::numeric'} AS weth_usd
      FROM cfg
      JOIN pools p   ON p.id = cfg.pool_id
      JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
      LEFT JOIN totals t      ON t.address = cfg.address
      LEFT JOIN pool_state ps ON ps.pool_id = p.id
    ),
    quoted AS (
      SELECT *,
        CASE WHEN lower(addr0) = '${weth}' THEN weth_usd WHEN lower(addr0) = '${usdg}' THEN 1::numeric END AS quote0_usd,
        CASE WHEN lower(addr1) = '${weth}' THEN weth_usd WHEN lower(addr1) = '${usdg}' THEN 1::numeric END AS quote1_usd
      FROM base
    ),
    priced AS (
      SELECT *,
        ${sane('COALESCE(quote0_usd, CASE WHEN quote1_usd IS NOT NULL THEN ratio * quote1_usd END)', MAX_SANE_PRICE_USD)} AS price0_usd,
        ${sane('COALESCE(quote1_usd, CASE WHEN quote0_usd IS NOT NULL AND ratio > 0 THEN quote0_usd / ratio END)', MAX_SANE_PRICE_USD)} AS price1_usd,
        (${positionAmount0Sql('staked::float8', 'sp', 'sa', 'sb')})::numeric AS r0,
        (${positionAmount1Sql('staked::float8', 'sp', 'sa', 'sb')})::numeric AS r1
      FROM quoted
    )
    INSERT INTO vaults (pool_id, address, total_staked, total_staked_usd, stakers, protocol_fee_bps, deposits_open,
                        fees_collected0, fees_collected1, protocol_cut0, protocol_cut1, claimed0, claimed1,
                        protocol_paid0, protocol_paid1, staked_since, last_collected_at, updated_at)
    SELECT v.pool_id, v.address,
      v.staked::numeric(78,0),
      CASE WHEN v.dec0 < 0 OR v.dec1 < 0 THEN 0 ELSE
        GREATEST(COALESCE(${sane(
          `COALESCE(v.r0 / power(10::numeric, v.dec0) * v.price0_usd, 0)
           + COALESCE(v.r1 / power(10::numeric, v.dec1) * v.price1_usd, 0)`,
          MAX_SANE_TOTAL_USD,
        )}, 0), 0)
      END::numeric(38,18),
      v.stakers,
      f.bps,
      COALESCE(o.open, true),
      COALESCE(fl.fees0, 0)::numeric(78,0), COALESCE(fl.fees1, 0)::numeric(78,0),
      COALESCE(fl.cut0, 0)::numeric(78,0), COALESCE(fl.cut1, 0)::numeric(78,0),
      COALESCE(fl.claimed0, 0)::numeric(78,0), COALESCE(fl.claimed1, 0)::numeric(78,0),
      COALESCE(fl.paid0, 0)::numeric(78,0), COALESCE(fl.paid1, 0)::numeric(78,0),
      fl.staked_since,
      fl.last_collected_at,
      a.at
    FROM priced v
    JOIN fee  f ON f.address = v.address
    JOIN asof a ON a.address = v.address
    LEFT JOIN flows fl ON fl.address = v.address
    LEFT JOIN opening o ON o.address = v.address
    ON CONFLICT (pool_id) DO UPDATE SET
      address           = EXCLUDED.address,
      total_staked      = EXCLUDED.total_staked,
      total_staked_usd  = EXCLUDED.total_staked_usd,
      stakers           = EXCLUDED.stakers,
      protocol_fee_bps  = EXCLUDED.protocol_fee_bps,
      deposits_open     = EXCLUDED.deposits_open,
      fees_collected0   = EXCLUDED.fees_collected0,
      fees_collected1   = EXCLUDED.fees_collected1,
      protocol_cut0     = EXCLUDED.protocol_cut0,
      protocol_cut1     = EXCLUDED.protocol_cut1,
      claimed0          = EXCLUDED.claimed0,
      claimed1          = EXCLUDED.claimed1,
      protocol_paid0    = EXCLUDED.protocol_paid0,
      protocol_paid1    = EXCLUDED.protocol_paid1,
      staked_since      = EXCLUDED.staked_since,
      last_collected_at = EXCLUDED.last_collected_at,
      updated_at        = EXCLUDED.updated_at`;

  const rebuildStakes = `
    WITH ${common},
    per AS (
      SELECT contract AS address, account,
        SUM(CASE kind WHEN 'Deposited' THEN (args->>'liquidity')::numeric
                      WHEN 'Withdrawn' THEN -(args->>'liquidity')::numeric ELSE 0 END) AS shares,
        ${sum('Claimed', 'amount0')} AS claimed0,
        ${sum('Claimed', 'amount1')} AS claimed1
      FROM ev WHERE kind IN ('Deposited', 'Withdrawn', 'Claimed') AND account IS NOT NULL
      GROUP BY contract, account
    )
    INSERT INTO stakes (wallet, vault_id, shares, claimed0, claimed1, updated_at)
    SELECT per.account, v.pool_id, per.shares::numeric(78,0), per.claimed0::numeric(78,0), per.claimed1::numeric(78,0), a.at
    FROM per
    JOIN vaults v ON v.address = per.address
    JOIN asof a   ON a.address = per.address
    -- A wallet that withdrew keeps its row while it has claimed anything:
    -- fees stay claimable after a withdrawal.
    WHERE per.shares <> 0 OR per.claimed0 > 0 OR per.claimed1 > 0`;

  // One transaction: a reader never sees a vault without its stakes.
  const results = await prisma.$transaction([
    prisma.$executeRawUnsafe(`DELETE FROM vaults WHERE address NOT IN (${addressList})`),
    prisma.$executeRawUnsafe(upsertVaults),
    prisma.$executeRawUnsafe(`DELETE FROM stakes WHERE vault_id IN (SELECT pool_id FROM vaults)`),
    prisma.$executeRawUnsafe(rebuildStakes),
  ]);
  const written = results[1];

  const problems: string[] = [];
  if (written < configured.length) {
    const present = new Set(
      (await prisma.vault.findMany({ select: { address: true } })).map((v) => v.address.toLowerCase()),
    );
    for (const v of configured.filter((c) => !present.has(c.address))) {
      const [pool, fee, cursor] = await Promise.all([
        prisma.pool.findUnique({ where: { id: v.poolId }, select: { id: true } }),
        prisma.contractEvent.findFirst({ where: { contract: v.address, kind: 'ProtocolFeeSet' }, select: { txHash: true } }),
        prisma.indexerCursor.findUnique({ where: { contract: contractCursorKey(v.address) } }),
      ]);
      problems.push(
        !cursor
          ? `vault ${v.address}: its events have not been read yet`
          : !pool
            ? `vault ${v.address}: its pool ${v.poolId} is not indexed yet — it appears once the indexer reaches the pool's Initialize`
            : !fee
              ? `vault ${v.address}: no ProtocolFeeSet event read — config/deployments.json's deployedBlock is after the vault's constructor, so its first events are missing; fix deployedBlock`
              : `vault ${v.address}: not written, for no reason found`,
      );
    }
  }
  return { written, problems };
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
