import { describe, expect, it } from 'vitest';
import { explorerWalletSent } from './router-tokens';

const W = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

describe('explorerWalletSent', () => {
  it('lists what the wallet sent, what each deployed and whether it called a contract, across pages', async () => {
    const asked: string[] = [];
    const pages = [
      {
        items: [
          { hash: h(1), status: 'ok', from: { hash: W }, to: { hash: '0x' + '1'.repeat(40), is_contract: true }, created_contract: null },
          { hash: h(2), status: 'ok', from: { hash: W }, to: null, created_contract: { hash: '0x' + 'A'.repeat(40) } },
          // failed: it created nothing
          { hash: h(3), status: 'error', from: { hash: W }, to: { hash: '0x' + '1'.repeat(40), is_contract: true } },
          // a payment to an account: nothing to read
          { hash: h(4), status: 'ok', from: { hash: W }, to: { hash: '0x' + '2'.repeat(40), is_contract: false } },
        ],
        next_page_params: { block_number: 9, index: 1 },
      },
      {
        items: [
          // sent by someone else: not this wallet's
          { hash: h(5), status: 'ok', from: { hash: '0x' + '3'.repeat(40) }, to: { hash: '0x' + '1'.repeat(40), is_contract: true } },
          // a field left out is not a no
          { hash: h(6), from: { hash: W }, to: { hash: '0x' + '1'.repeat(40) } },
        ],
        next_page_params: null,
      },
    ];
    const fetchFn = async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(pages[asked.length - 1]), { status: 200 });
    };
    const sent = await explorerWalletSent('https://explorer.test/', fetchFn)(W);
    expect(sent).toEqual([
      { hash: h(1), created: null, toContract: true },
      { hash: h(2), created: '0x' + 'a'.repeat(40), toContract: false },
      { hash: h(4), created: null, toContract: false },
      { hash: h(6), created: null, toContract: true },
    ]);
    expect(asked[0]).toBe(`https://explorer.test/api/v2/addresses/${W}/transactions?filter=from`);
    expect(asked[1]).toContain('filter=from&block_number=9&index=1');
  });
});
