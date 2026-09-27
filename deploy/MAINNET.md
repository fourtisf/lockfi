# Mainnet checklist

What has to be true before LockFi is announced as live on Robinhood Chain, in
order. Every liquidity action is a transaction to Uniswap's audited contracts,
built and dry-run by the page (§20). The one contract of LockFi's own is the
Router (§48), and it has its own section at the end: section 6.

Commands run on the VPS as root.

## 1. Deploy and check the box

```bash
bash /var/www/balast/deploy/deploy.sh
bash /var/www/balast/deploy/doctor.sh
```

The doctor's last lines say what to do next. `indexer: syncing` or `working`
is normal while the backfill runs; `stalled` or `misconfigured` is not.

## 2. Free RPC is enough for mainnet

Every transaction a person signs — the zap's swap, the mint, collect,
withdraw, every approval — is built in their browser and sent through **their
own wallet's connection** to Robinhood Chain. The site's RPC list is not on
that path. Reads the page makes without a wallet go through all four free
public endpoints in turn, so one endpoint rate-limiting a browser does not
stop anything.

What free RPC does limit is the **indexer's backfill**: the board's history
figures (liquidity, trailing yield, market cap) stay as old as the backfill,
and the top bar says how old. Today's volume and the live price come from the
head reader and the aggregators and are current either way. The API and the
logo process start on different free endpoints from the indexer (`RPC_START`
in `ecosystem.config.js`), so the reads a person is waiting on are not queued
behind the backfill's.

Optional, and never required for mainnet:

| What | Why | How |
|---|---|---|
| A paid RPC endpoint | Only makes the backfill catch up faster. | `bash deploy/set-env.sh RPC_URLS "https://your-endpoint,https://rpc.mainnet.chain.robinhood.com"` then deploy |
| WalletConnect project id | Phone wallets by QR. Free at cloud.reown.com. Browser wallets work without it. | `bash deploy/set-env.sh NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID <id>` then deploy |
| `STAKEABLE_HOOKS` | v4 pools with a hook stay unoffered until their hook is looked at and allowed. Empty is the safe default; plain pools and every v3 pool work without it. | `bash deploy/set-env.sh STAKEABLE_HOOKS 0xhook1,0xhook2` |
| `AI_API_KEY` | Turns on Ask LockFi AI in the drawer, the builder and /learn. An OpenRouter key (`sk-or-v1-…`, from openrouter.ai/keys, with credit at openrouter.ai/credits); hidden until set. `/api/health` → `ai` says whether it is on and how many answers today. | `bash deploy/set-env.sh AI_API_KEY sk-or-v1-…` then deploy |
| `LAUNCHPAD_HOOKS` | Names launchpad pools and keeps them unstakeable before graduation. | `bash deploy/set-env.sh LAUNCHPAD_HOOKS "Pons:0x…,Bags:0x…"` |

## 3. Verify the addresses once

```bash
cd /var/www/balast && npm run verify:chain
```

Every Uniswap address in `lib/chain.ts` was matched against Uniswap's own
registry for chain 4663; this checks each one holds code on the chain itself.

## 4. The first real transactions — small, watched

Use a fresh wallet with about **0.02 ETH**. After each step, open the
transaction on https://robinhoodchain.blockscout.com and check what is listed.

1. **Zap into a v4 ETH pool.** `/positions`, pick a token whose market is
   `ETH` on Uniswap v4, full range, deposit **0.005**. The wallet holds only
   ETH, so the button reads *Step 1 of 2 · Swap*. Sign it.
   - Explorer: the swap went to the Universal Router `0x8876…0904`; you
     received the token; the router holds nothing afterwards.
2. **Mint (step 2).** The button now reads *Mint 1 position*. Sign it.
   - Explorer: a Transfer of a new NFT from `0x0…0` to your wallet, from the
     PositionManager `0x58da…4fA7`.
   - `/portfolio` lists it within a minute.
3. **Zap into a v3 ETH pool** (VIRTUAL / ETH is one), deposit **0.005**.
   - The swap goes to SwapRouter02 `0xCaf6…5cb2`, paid in ETH; the mint to
     the v3 manager `0x7399…E0D3`, paid in ETH; the unspent ether is refunded
     in the same transaction (`refundETH`).
4. **Collect fees** on one position (after some trading), then **Withdraw**
   each one.
   - Explorer: the ether side arrives as ETH (no aeWETH left in the wallet),
     the NFT is burned, and the manager holds nothing.
5. Check `/portfolio` shows the positions gone and the Activity list shows
   every transaction as confirmed.

If any step's dry run refuses, the page says why before the wallet opens —
send that sentence and the pool link, and nothing needs to be signed.

## 5. Only then announce

Post the thread in `brand/social/THREAD.md`. Pin the contract-address warning
first: Balast has no token, and any address circulating as one is not ours.

## Not part of mainnet

- **The Router** (`/router`) needs a contract of its own and an external audit
  (§3.4, §8 P5). The page shows the design and sends nothing.
- **Vaults with a 7-day stream and a protocol fee** (§3.3) are the same: a
  contract, an audit. Under §20 a stake is a full-range position in the
  wallet and Balast takes no fee.

## 6. The Router

The Router is LockFi's own contract: a factory, deployed once, that creates one
router per token team. **It has not been externally audited** (the owner's
decision, §48); it is tested against Uniswap's own contracts with
`npm run check:router`. Do these in order.

1. **Make a keeper wallet.** A new account in MetaMask, used for nothing else.
   Send it about 0.005 ETH on Robinhood Chain for gas. It never receives funds.
2. **Give the box its key.** In MetaMask: account details → show private key.
   Never paste it anywhere but this command:

   ```bash
   bash /var/www/balast/deploy/set-env.sh KEEPER_PRIVATE_KEY 0x…
   ```

3. **Deploy the factory from your own wallet.** Open
   `https://lockfi.org/router/deploy`, connect the wallet that should own it,
   enter the keeper wallet's **address** (not its key) and the treasury that
   receives the 1% fee, and deploy. The page shows the factory's address.
4. **Send that address to your developer.** It goes in `ROUTER_FACTORY` in
   `lib/chain.ts`; after the next deploy the router page is live and the
   navigation's "later" tag is gone.

   ```bash
   bash /var/www/balast/deploy/deploy.sh
   pm2 logs lockfi-keeper --lines 20
   ```

   The keeper's log names its wallet and the factory. It waits 30 minutes
   after every start before its first route, to build its price average.
5. **The first router, small and watched.** Create a router for LockFi's own
   token (or one you control) and send it 0.005 ETH. When it routes, check on
   the explorer that the treasury received 1%, that the router holds almost
   no ETH afterwards, and that the pool shows a `ModifyLiquidity` from the
   router's address.
