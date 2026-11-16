'use client';

import { useQuery } from '@tanstack/react-query';
import { erc20Abi, pad, parseAbiItem, toHex, zeroAddress, type Hex, type PublicClient } from 'viem';
import { usePublicClient } from 'wagmi';
import { useMarket } from '@/components/providers/MarketProvider';
import { useWallet } from '@/hooks/useWallet';
import { CHAIN, CONTRACTS } from '@/lib/chain';
import { deploymentFor } from '@/lib/contracts/deployments';
import { positionManagerAbi, stateViewAbi } from '@/lib/contracts/uniswap';
import { poolIdOf } from '@/lib/contracts/vault';
import { DATA_SOURCE } from '@/lib/data';
import type { PoolKey } from '@/lib/data/types';
import { buildPosition, decodePositionInfo, type RawBin, type WalletPosition } from '@/lib/positions';
import { liveEthPrice } from '@/lib/vault-view';

type Address = `0x${string}`;

const LIVE = DATA_SOURCE === 'live';
/** Fees grow with every swap in range; positions are re-read this often. */
const REFRESH_MS = 20_000;

const SHAPE_MINTED = parseAbiItem(
  'event ShapeMinted(address indexed user, bytes32 indexed poolId, uint256 firstTokenId, uint256 bins, uint256 totalLiquidity)',
);
const ZAP_MINTED = parseAbiItem(
  'event ZapMinted(address indexed user, uint256 indexed tokenId, address tokenIn, uint256 amountIn, uint256 liquidity)',
);

interface Mint {
  txHash: Hex;
  blockNumber: bigint;
  tokenIds: bigint[];
}

/**
 * Logs from `from` to head, splitting the range when an endpoint refuses it.
 * The filters are a wallet's own mints, so a single read normally answers.
 */
async function logsFrom<T>(read: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
  try {
    return await read(from, to);
  } catch (error) {
    if (to - from < 50_000n) throw error;
    const mid = from + (to - from) / 2n;
    return [...(await logsFrom(read, from, mid)), ...(await logsFrom(read, mid + 1n, to))];
  }
}

/** Every mint this wallet made through the shaper or the zap. */
async function readMints(client: PublicClient, wallet: Address): Promise<Mint[]> {
  const d = deploymentFor(CHAIN.id);
  if (!d) return [];
  const head = await client.getBlockNumber();
  const mints: Mint[] = [];
  if (d.shaper) {
    const from = BigInt(d.shaperDeployedBlock ?? 0);
    const logs = await logsFrom(
      (a, b) => client.getLogs({ address: d.shaper!, event: SHAPE_MINTED, args: { user: wallet }, fromBlock: a, toBlock: b }),
      from,
      head,
    );
    for (const l of logs) {
      const first = l.args.firstTokenId ?? 0n;
      const n = Number(l.args.bins ?? 0n);
      if (!l.transactionHash || l.blockNumber === null || first === 0n || n <= 0 || n > 60) continue;
      mints.push({ txHash: l.transactionHash, blockNumber: l.blockNumber, tokenIds: Array.from({ length: n }, (_, i) => first + BigInt(i)) });
    }
  }
  if (d.zap) {
    const from = BigInt(d.zapDeployedBlock ?? 0);
    const logs = await logsFrom(
      (a, b) => client.getLogs({ address: d.zap!, event: ZAP_MINTED, args: { user: wallet }, fromBlock: a, toBlock: b }),
      from,
      head,
    );
    for (const l of logs) {
      if (!l.transactionHash || l.blockNumber === null || l.args.tokenId === undefined) continue;
      mints.push({ txHash: l.transactionHash, blockNumber: l.blockNumber, tokenIds: [l.args.tokenId] });
    }
  }
  return mints.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0));
}

/**
 * The connected wallet's positions minted through Tidewell, read from the
 * chain in this browser: found from the shaper's and the zap's own mint
 * events (the PositionManager cannot list a wallet's NFTs), then every bin's
 * owner, range, liquidity and uncollected fees, and its pool's price, read
 * live. A bin sold or sent elsewhere is not this wallet's, and is left out.
 */
export function useWalletPositions(): {
  positions: WalletPosition[];
  loading: boolean;
  failed: boolean;
  refetch: () => void;
} {
  const { address } = useWallet();
  const client = usePublicClient({ chainId: CHAIN.id });
  const { vaults, pools, global } = useMarket();
  const ethUsd = liveEthPrice(vaults, global.ethPriceUsd);
  // USDG, from a vault's live read, else from any pool quoted in it.
  const usdg =
    vaults.flatMap((v) => v.live?.currencies ?? []).find((c) => c.symbol === 'USDG')?.address ??
    pools
      .filter((p) => p.quote === 'USDG' && p.key)
      .map((p) => [p.key!.currency0, p.key!.currency1].find((c) => c.toLowerCase() !== p.token.address.toLowerCase()))
      .find((c) => c !== undefined) ??
    null;
  const enabled = LIVE && address !== undefined && client !== undefined;

  const query = useQuery({
    queryKey: ['wallet-positions', address, CHAIN.id],
    enabled,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const c = client as PublicClient;
      const wallet = address as Address;
      const mints = await readMints(c, wallet);
      const ids = mints.flatMap((m) => m.tokenIds);
      if (ids.length === 0) return { mints, bins: new Map<bigint, { key: PoolKey; raw: RawBin }>(), slots: new Map(), metas: new Map() };

      const pm = CONTRACTS.positionManager as Address;
      const base = await c.multicall({
        allowFailure: true,
        contracts: ids.flatMap((id) => [
          { address: pm, abi: positionManagerAbi, functionName: 'ownerOf', args: [id] } as const,
          { address: pm, abi: positionManagerAbi, functionName: 'getPoolAndPositionInfo', args: [id] } as const,
          { address: pm, abi: positionManagerAbi, functionName: 'getPositionLiquidity', args: [id] } as const,
        ]),
      });
      const owned: { id: bigint; key: PoolKey; poolId: Hex; tickLower: number; tickUpper: number; liquidity: bigint }[] = [];
      ids.forEach((id, i) => {
        const [owner, info, liq] = [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]];
        // Burned (ownerOf reverts) or no longer this wallet's: not listed.
        if (owner.status !== 'success' || (owner.result as string).toLowerCase() !== wallet.toLowerCase()) return;
        if (info.status !== 'success' || liq.status !== 'success') return;
        const [k, packed] = info.result as readonly [{ currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, bigint];
        const key: PoolKey = { currency0: k.currency0, currency1: k.currency1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks };
        owned.push({ id, key, poolId: poolIdOf(key), ...decodePositionInfo(packed), liquidity: liq.result as bigint });
      });

      const poolIds = [...new Set(owned.map((o) => o.poolId))];
      const tokens = [...new Set(owned.flatMap((o) => [o.key.currency0, o.key.currency1]).filter((t) => t.toLowerCase() !== zeroAddress))];
      const sv = CONTRACTS.stateView as Address;
      const reads = await c.multicall({
        allowFailure: true,
        contracts: [
          ...poolIds.map((poolId) => ({ address: sv, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] }) as const),
          ...owned.flatMap((o) => [
            { address: sv, abi: stateViewAbi, functionName: 'getFeeGrowthInside', args: [o.poolId, o.tickLower, o.tickUpper] } as const,
            {
              address: sv,
              abi: stateViewAbi,
              functionName: 'getPositionInfo',
              args: [o.poolId, pm, o.tickLower, o.tickUpper, pad(toHex(o.id), { size: 32 })],
            } as const,
          ]),
          ...tokens.flatMap((t) => [
            { address: t as Address, abi: erc20Abi, functionName: 'symbol' } as const,
            { address: t as Address, abi: erc20Abi, functionName: 'decimals' } as const,
          ]),
        ],
      });
      const slots = new Map<Hex, { sqrtPriceX96: bigint; tick: number }>();
      poolIds.forEach((poolId, i) => {
        const r = reads[i];
        if (r.status === 'success') {
          const [sqrtPriceX96, tick] = r.result as readonly [bigint, number, number, number];
          slots.set(poolId, { sqrtPriceX96, tick: Number(tick) });
        }
      });
      const bins = new Map<bigint, { key: PoolKey; raw: RawBin }>();
      owned.forEach((o, j) => {
        const inside = reads[poolIds.length + j * 2];
        const last = reads[poolIds.length + j * 2 + 1];
        if (inside.status !== 'success' || last.status !== 'success') return;
        const [g0, g1] = inside.result as readonly [bigint, bigint];
        const [, l0, l1] = last.result as readonly [bigint, bigint, bigint];
        bins.set(o.id, {
          key: o.key,
          raw: {
            tokenId: o.id,
            tickLower: o.tickLower,
            tickUpper: o.tickUpper,
            liquidity: o.liquidity,
            feeGrowthInside0X128: g0,
            feeGrowthInside1X128: g1,
            feeGrowthInside0LastX128: l0,
            feeGrowthInside1LastX128: l1,
          },
        });
      });
      const metas = new Map<string, { symbol: string; decimals: number }>();
      metas.set(zeroAddress, { symbol: 'ETH', decimals: 18 });
      const offset = poolIds.length + owned.length * 2;
      tokens.forEach((t, i) => {
        const s = reads[offset + i * 2];
        const d = reads[offset + i * 2 + 1];
        if (d.status !== 'success') return;
        metas.set(t.toLowerCase(), { symbol: s.status === 'success' ? String(s.result).slice(0, 16) : 'token', decimals: Number(d.result) });
      });
      return { mints, bins, slots, metas };
    },
  });

  const positions: WalletPosition[] = [];
  const data = query.data;
  if (data) {
    for (const m of data.mints) {
      const own = m.tokenIds.map((id) => data.bins.get(id)).filter((b): b is NonNullable<typeof b> => b !== undefined);
      if (own.length === 0) continue;
      const key = own[0].key;
      const poolId = poolIdOf(key);
      const slot = data.slots.get(poolId);
      const m0 = data.metas.get(key.currency0.toLowerCase());
      const m1 = data.metas.get(key.currency1.toLowerCase());
      if (!slot || !m0 || !m1) continue;
      const p = buildPosition({
        txHash: m.txHash,
        blockNumber: m.blockNumber,
        poolId,
        key,
        currencies: [
          { address: key.currency0 as Address, ...m0 },
          { address: key.currency1 as Address, ...m1 },
        ],
        sqrtPriceX96: slot.sqrtPriceX96,
        tick: slot.tick,
        // One mint is one pool; a bin that somehow is not is left out.
        bins: own.filter((b) => poolIdOf(b.key) === poolId).map((b) => b.raw),
        ethUsd: Number.isFinite(ethUsd) && ethUsd > 0 ? ethUsd : null,
        usdg,
      });
      if (p) positions.push(p);
    }
  }

  return {
    positions,
    loading: enabled && query.isPending,
    failed: query.isError,
    refetch: () => void query.refetch(),
  };
}
