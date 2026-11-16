# Introducing Tidewell

*Cover: `brand/article-cover-glass-3000.png` (or the gold finish), 5:2, offered on tidewell.live/brand.*

*Do not paste this Markdown into X's article editor. The editor makes a new paragraph at every line break, so the blank lines below become empty paragraphs and the `**` and `-` stay as characters. Paste `introducing-tidewell.x.txt` instead (one line per paragraph, no blank lines), or use the copy page, which copies headings, lists and bold as formatting.*

*Every claim below is true of Tidewell as built (CLAUDE.md §1, §7, §20–§24). No yield figure appears on purpose: §1 forbids a forward one, and a trailing one would be out of date the day after posting. It names no contracts and lists no addresses, at ALFA's request; the audit disclaimer stays, because a reader deciding whether to deposit needs it. If something changes (a new vault, an audit), change this before reposting.*

---

## The post that links it

> Introducing Tidewell, the liquidity layer for Robinhood Chain.
> Provide liquidity to Uniswap v4 pools and earn a share of real swap fees. No emissions, no lockups, and you can withdraw at any time.
> The full overview is below.

---

## The article

**Title (X's title field):** Introducing Tidewell

Tidewell is a liquidity layer for Robinhood Chain. Liquidity providers deposit into Uniswap v4 pools through Tidewell and earn a proportional share of the trading fees those pools generate.

There are no token emissions and no incentive programs. Every dollar of yield on Tidewell is a fee that a trader paid.

### Why real fees matter

Much of the yield in DeFi is funded by issuing new tokens. It looks attractive while the issuance lasts and fades once it stops. Tidewell's returns come only from swap fees, so they follow trading activity. They rise when markets are busy and slow when markets are quiet, and every figure on the site can be traced to fees paid on chain.

### Stakes: passive liquidity

A stake is a deposit into a Tidewell vault. Each vault serves a single pool and holds its liquidity across the full price range, so it earns on every trade and never falls out of range.

- **Flexible deposits.** Deposit ETH, the pool's other token, or both, from $10. A single-token deposit is balanced within the same transaction, and depositing both tokens avoids the swap entirely.
- **Fees as they are earned.** Your share of fees is credited as the vault collects them. Claim at any time in the pool's own tokens, or compound them back into your stake.
- **No lockup.** Withdraw at any time, with no exit fee. Leaving never forfeits fees you have already earned.
- **A fixed protocol fee.** Tidewell retains 10% of the fees a vault collects and never takes from deposits. The fee is capped at 20% when each vault is created, and the cap cannot be raised.

Two vaults are live today, on the ETH / USDG pools at the 0.05% and 0.046% fee tiers.

### Positions: concentrated liquidity

Positions are for liquidity providers who want to decide where their liquidity sits.

- **Shaped in one transaction.** Choose a price range and a shape: spot, curve or bid-ask. Tidewell splits it across up to 60 bins and mints them in a single transaction from one ETH deposit.
- **Held in your wallet.** Each bin is a Uniswap v4 position NFT minted directly to you. Tidewell charges no fee on positions.
- **Clear range status.** Concentrated liquidity earns more per dollar while the price is inside your range and nothing while it is outside. Your portfolio shows which, for every position.
- **Full control.** Collect fees or withdraw at any time, across every bin in one transaction.

Positions are available for any token paired with ETH in a Uniswap v4 pool, including pools without a vault.

### Transparent by design

Every number on Tidewell is built to be checked.

- Yield is shown as fee yield over the trailing 7 days. It is never presented as APY and never projected forward.
- Pools younger than 7 days are marked as estimates. With less than 24 hours of data, no figure is shown.
- Vaults show what a full-range position actually earned, not the pool average.
- Market capitalisation is shown as fully diluted value and labelled as such.
- Your portfolio shows price impact on holdings, also known as impermanent loss, next to the fees you have earned.
- If the data falls behind the chain, every page says so.

### Non-custodial

Only the wallet that made a deposit can withdraw it. There is no admin withdrawal function, no pause that can lock funds, and no upgradeable proxy on the vaults. The owner can pause new deposits, while withdrawals and claims stay open at all times.

### Risks

Tidewell has not yet been independently audited. Use it at your own risk and only with funds you can afford to lose.

Providing liquidity also carries market risk. If a token's price falls, the value of your position falls with it. Fees offset this risk but do not remove it.

### Getting started

1. Visit tidewell.live and connect your wallet on Robinhood Chain.
2. To stake, open Stakes, choose a vault, select ETH, USDG or both, and confirm.
3. To provide concentrated liquidity, open Positions, choose a token, set your range and shape, and mint.
4. Track everything in Portfolio, including holdings, fees earned, claims and withdrawals.

tidewell.live is the only official website, and official announcements come from @usetidewell.

*Fees rise with the tide.*
