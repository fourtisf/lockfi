/**
 * The one Uniswap v4 read the site makes from the browser: a pool's current
 * price, from StateView (CONTRACTS.stateView in lib/chain.ts). Hand-written,
 * because it is Uniswap's interface, not one of ours in abis.ts.
 */
export const stateViewAbi = [
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ],
  },
] as const;
