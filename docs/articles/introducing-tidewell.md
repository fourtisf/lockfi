# Introducing Tidewell: liquidity that earns from real trading

*Cover: `brand/article-cover-glass-1500.png` (or the gold finish), 5:2, offered on tidewell.live/brand.*

*Every claim below is true of Tidewell as built (CLAUDE.md §1, §7,
§20–§24). No yield figure appears on purpose: §1 forbids a forward one, and a
trailing one would be out of date the day after posting. The copy names no
contracts and lists no addresses, at ALFA's request; the audit disclaimer
stays, reworded, because a reader deciding whether to deposit needs it. If
something changes — a new vault, an audit — change this before reposting.*

---

## The post that links it (pick one)

> Most DeFi yield is paid in a token printed to pay it. When the printing stops, so does the yield.
>
> Tidewell pays LPs one thing: real swap fees from Uniswap v4 pools on Robinhood Chain. No emissions, ever.
>
> Here's how it works 👇

> Fees rise with the tide.
>
> Tidewell is live on Robinhood Chain: stake from $10, or shape your own liquidity, and earn a share of every trade. Real fees, claimable any time, withdrawable any time.
>
> Everything you need to know 👇

---

## The article

**Title:** Introducing Tidewell: liquidity that earns from real trading

**Subtitle:** Stake or shape liquidity on Robinhood Chain. Every fee is a real swap fee. No emissions, ever.

Most yield in DeFi is paid in a token printed to pay it. The number looks
generous for as long as the printing lasts, and then it doesn't.

Tidewell works the other way round. Every dollar an LP earns here is a swap
fee somebody paid to trade. When the market is busy, fees rise. When it is
quiet, they slow. Nothing props the number up, and nothing is hidden behind
it.

**Fees rise with the tide.**

### What Tidewell is

Tidewell is a liquidity layer for Robinhood Chain, built on Uniswap v4 pools.
Traders pay a fee on every swap, and that fee goes to the people providing
the liquidity. Tidewell gives you two ways to be one of them.

### Stakes: deposit once, earn from every trade

A stake goes into a Tidewell vault, one vault per pool.

- **One token in, from $10.** Deposit ETH, the pool's other token, or both
  in the pool's ratio. With one token, about half is swapped for the other
  in the same transaction. Depositing both skips the swap entirely.
- **Always in range.** The vault holds your liquidity across the pool's whole
  price range, so it earns on every trade the pool makes and never drifts
  out of range.
- **Fees credited the moment they are earned.** Your share is credited to
  you as the vault collects it. Claim any time, in the pool's own tokens, or
  compound it back into your stake.
- **Withdraw any time.** No lockup, no exit fee, and leaving never forfeits
  fees you have already earned.

Tidewell keeps 10% of the fees a vault collects, and never touches your
deposit. That 10% is capped at 20%, fixed when each vault is created, and
the cap can never be raised.

Live today: two vaults on the ETH / USDG pools (0.05% and 0.046% fee tiers).

### Positions: shape your own liquidity

For LPs who want to choose where their liquidity sits.

- **Pick a range and a shape**: spot, curve or bid-ask, split into up to 60
  bins, all minted in one transaction from a single ETH deposit.
- **Yours, in your wallet.** Each bin is a Uniswap v4 position NFT minted
  straight to you. Tidewell takes no fee on positions.
- **More per dollar, with a condition.** Concentrated liquidity earns more
  for each dollar while the price is inside your range, and nothing while it
  is outside. The portfolio says which, in the row, in red when you are out
  of range.
- **Collect fees and withdraw from your portfolio**, any time, every bin in
  one transaction.

Positions work on any token that trades against ETH in a Uniswap v4 pool,
not only the pools that have a vault.

### Numbers you can check

Most dashboards are built to make a number look big. Tidewell's are built so
the number can be trusted:

- Yield is **fee yield, trailing 7 days**. Never APY, never projected, never
  one good day multiplied by 365.
- A pool younger than a week is marked **est.**, with its age next to it.
  Under 24 hours of data, there is no figure at all, just a dash.
- A vault shows what a full-range stake actually earned, not the pool's
  average.
- Market cap is shown as **FDV** and labelled as such, because circulating
  supply cannot be read on chain.
- Your portfolio shows **price impact on holdings** (impermanent loss, by its
  honest name) beside the fees you earned, not buried under them.
- If the data is behind the chain, every page says so.

### Your money stays yours

- Only the wallet that deposited can withdraw. There is no admin withdraw
  path, no pause that traps funds, and no upgradeable proxy on the vaults.
- The owner can pause *new* deposits. Withdrawals and claims cannot be
  paused by anyone.

**Be clear about the risk.** Tidewell has **not yet been independently
audited**. Use it at your own risk, and with amounts you can afford to
lose. Providing liquidity is not risk-free: if a token's price falls, your
position's value falls with it. Fees soften that; they do not remove it.

### Get started

1. Go to **tidewell.live** and connect your wallet on Robinhood Chain.
2. **To stake:** open *Stakes*, choose a vault, pick ETH, USDG or both, and
   stake.
3. **To shape:** open *Positions*, choose a token, set your range and shape,
   and mint.
4. **Track it:** *Portfolio* shows what you hold, the fees you have earned,
   and Claim, Collect and Withdraw, all in one place.

Only use **tidewell.live**, and follow **@usetidewell** for announcements.
Anything else claiming to be Tidewell is not.

---

Real fees. No emissions. Withdraw any time.

**Fees rise with the tide.** → tidewell.live
