/**
 * The production `LogSource`: viem over the failover client.
 *
 * Block timestamps are the fiddly part. Every event needs chain time, not the
 * time we happened to read it — §7's whole point is that a stale number must
 * never look live — and Robinhood Chain's ~100ms blocks (§2) mean a 2000-block
 * range is 2000 timestamps and about three minutes of chain. Fetching each
 * block individually would be 2000 round trips a pass, so timestamps are
 * fetched only for the blocks that actually carry a log, cached, and reused —
 * and in a dense stretch, where nearly every block carries one, mostly read
 * off fixed anchor blocks instead (block-times.ts).
 */

import { rpc } from '../chain/client';
import { plan, resolve } from './block-times';
import type { LogSource } from './poller';

export class ViemLogSource implements LogSource {
  /** Block number to timestamp. Blocks are immutable, so this never expires. */
  private readonly times = new Map<bigint, Date>();
  private readonly needed = new Set<bigint>();
  /** The latest head seen: an anchor past it does not exist yet. */
  private head = 0n;

  async getHeadBlock(): Promise<{ number: bigint; timestamp: Date }> {
    const block = await rpc((c) => c.getBlock({ blockTag: 'latest' }), 'getBlock(latest)');
    const timestamp = new Date(Number(block.timestamp) * 1000);
    this.times.set(block.number, timestamp);
    if (block.number > this.head) this.head = block.number;
    return { number: block.number, timestamp };
  }

  async getLogs(args: {
    address: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
    topics?: string[];
  }) {
    const addresses = (Array.isArray(args.address) ? args.address : [args.address]).map(
      (a) => a as `0x${string}`,
    );
    type Raw = {
      address: string;
      topics: string[];
      data: string;
      blockNumber: bigint | null;
      logIndex: number | null;
      transactionHash: string | null;
    };
    let logs: Raw[];
    if (args.topics) {
      // viem's getLogs takes events, not raw topics; a topic filter is a plain
      // eth_getLogs with the first topic as an OR-list.
      const raw = await rpc(
        (c) =>
          c.request({
            method: 'eth_getLogs',
            params: [
              {
                address: addresses,
                fromBlock: `0x${args.fromBlock.toString(16)}`,
                toBlock: `0x${args.toBlock.toString(16)}`,
                topics: [args.topics as `0x${string}`[]],
              },
            ],
          }),
        `getLogs(${args.fromBlock}-${args.toBlock}, structure)`,
      );
      logs = (raw as { address: string; topics: string[]; data: string; blockNumber: string | null; logIndex: string | null; transactionHash: string | null }[]).map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber === null ? null : BigInt(l.blockNumber),
        logIndex: l.logIndex === null ? null : Number(BigInt(l.logIndex)),
        transactionHash: l.transactionHash,
      }));
    } else {
      logs = (await rpc(
        (c) =>
          c.getLogs({
            address: addresses.length === 1 ? addresses[0] : addresses,
            fromBlock: args.fromBlock,
            toBlock: args.toBlock,
          }),
        `getLogs(${args.fromBlock}-${args.toBlock})`,
      )) as unknown as Raw[];
    }

    const out = [];
    for (const log of logs) {
      if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) {
        // A pending log has no position, so it has no primary key. Skip it;
        // the next pass sees it mined.
        continue;
      }
      // Remember which blocks we will need a timestamp for.
      this.needed.add(log.blockNumber);
      out.push({
        address: log.address,
        topics: log.topics as string[],
        data: log.data,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        transactionHash: log.transactionHash,
      });
    }
    return out;
  }

  /**
   * Timestamps for the blocks in a range that carry logs, plus the range's own
   * end block so the cursor has an honest time to record.
   */
  async getBlockTimes(from: bigint, to: bigint): Promise<Map<bigint, Date>> {
    const wanted = new Set<bigint>([to]);
    for (const block of this.needed) {
      if (block >= from && block <= to) wanted.add(block);
    }
    this.needed.clear();

    // In groups, each sent as ONE JSON-RPC batch (the client batches calls made
    // together). The public endpoint answers a batch of 100 in the time of one.
    const GROUP = 100;
    const fetchTimes = async (numbers: bigint[]) => {
      const blocks = await Promise.all(
        numbers.map((number) =>
          rpc((c) => c.getBlock({ blockNumber: number }), `getBlock(${number})`),
        ),
      );
      for (const block of blocks) {
        this.times.set(block.number, new Date(Number(block.timestamp) * 1000));
      }
    };
    // The public endpoint rate-limits (HTTP 429) after a few batches in a row.
    // A refused batch is waited out and asked again rather than failing the
    // pass: a failed pass backs off for up to a minute, and in a dense stretch
    // that turned every rate limit into a minute of nothing.
    const withPatience = async (numbers: bigint[]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fetchTimes(numbers.filter((b) => !this.times.has(b)));
        } catch (error) {
          if (attempt >= 5) throw error;
          await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        }
      }
    };
    const fetchAll = async (numbers: bigint[]) => {
      const missing = numbers.filter((b) => !this.times.has(b));
      for (let i = 0; i < missing.length; i += GROUP) {
        const group = missing.slice(i, i + GROUP);
        try {
          await withPatience(group);
        } catch {
          // Not every endpoint takes a batch of 100. Ten at a time; whatever
          // still fails fails the pass, which retries with everything fetched
          // so far kept in the cache.
          for (let j = 0; j < group.length; j += 10) {
            await withPatience(group.slice(j, j + 10));
          }
        }
      }
    };

    // Anchors first (block-times.ts): a block between two anchors in the same
    // hour and within five minutes needs no request of its own. The rest are
    // fetched themselves.
    const head = this.head > to ? this.head : to;
    const { anchors, exact } = plan(wanted, head);
    await fetchAll([...anchors, ...exact]);
    const first = resolve(wanted, this.times);
    await fetchAll(first.unresolved);
    const resolved = first.unresolved.length > 0 ? resolve(wanted, this.times).times : first.times;

    const result = new Map<bigint, Date>();
    for (const block of wanted) {
      const time = resolved.get(block);
      if (time) result.set(block, time);
    }
    // Keep the cache from growing without bound over a long run.
    if (this.times.size > 50_000) {
      const keep = [...this.times.keys()].sort((a, b) => (a > b ? -1 : 1)).slice(0, 10_000);
      const kept = new Map(keep.map((k) => [k, this.times.get(k)!]));
      this.times.clear();
      for (const [k, v] of kept) this.times.set(k, v);
    }
    return result;
  }
}
