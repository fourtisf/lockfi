# Tidewell contracts

Foundry project for the four contracts in CLAUDE.md §3: `TidewellVault`,
`TidewellZap`, `TidewellShaper`, `TidewellRouter` (+ `TidewellRouterFactory`).
Built against Uniswap v4-core and v4-periphery (git submodules in `lib/`).
The audit package is in [`docs/audit/`](../docs/audit/).

## Build and test

```bash
git submodule update --init --recursive
cd contracts
forge build
forge test
```

- `FOUNDRY_PROFILE=p2 forge test --match-contract Invariant` runs the vault
  invariant suite at 10,000 runs × 64 calls (CLAUDE.md §9; about ten minutes).
- `FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/fork/*'`
  rehearses stake → harvest → claim → withdraw, a shaped mint and a router
  route against the real Robinhood Chain contracts and pool, on a fork.
- After changing a contract: `node ../scripts/export-abis.mjs` so the site and
  keeper use the ABIs that were built.

## Deploying

Every deploy uses `script/Deploy.s.sol`. It deploys the zap, the shaper, the
router factory and one vault per pool in `VAULT_POOLS`, and writes
`deployments/<chainId>.json`. **It refuses Robinhood Chain mainnet (4663)
unless `TIDEWELL_AUDIT_REPORT` is set** — CLAUDE.md §8 P5.

| Variable | Meaning |
|---|---|
| `OWNER` | Vault owner — a multisig. Sets keeper, treasury, fee (≤ cap). Cannot touch funds. |
| `KEEPER` | The keeper's address: a fresh hot wallet holding only gas. Its key goes in the server's `.env` as `KEEPER_PRIVATE_KEY`. |
| `TREASURY` | Receives the protocol fee. |
| `PROTOCOL_FEE_BPS` | Default 1000 (10% of harvested fees). |
| `PROTOCOL_FEE_CAP_BPS` | Default 2000. **Fixed forever per vault.** Confirm before deploying (§10). |
| `VAULT_POOLS` | `currency0:currency1:fee:tickSpacing,...` — hookless pools with an ETH or WETH side. |
| `POOL_MANAGER`, `POSITION_MANAGER`, `PERMIT2`, `WETH` | Only off mainnet: that chain's Uniswap addresses. |
| `TIDEWELL_AUDIT_REPORT` | Mainnet only: the audit report's URL or hash. |

The deployer's key never goes in a file in this repository. Pass it on the
command line from your own machine, or use a hardware wallet (`--ledger`).

### 1. Rehearsal on a fork (no real funds, nothing on chain)

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 31337
```

```bash
OWNER=0x... KEEPER=0x... TREASURY=0x... \
VAULT_POOLS=0x0000000000000000000000000000000000000000:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168:500:10 \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

(That key is anvil's public test account 0, worthless anywhere else.) The
pool above is native ETH / USDG at 0.05%, the chain's deepest hookless
ETH/USDG pool when this was written.

### 2. Robinhood Chain testnet (chainId 46630)

Testnet ETH, not real money. First confirm Uniswap v4 is deployed on the
testnet and find its PoolManager, PositionManager, Permit2 and WETH on the
testnet explorer; then:

```bash
POOL_MANAGER=0x... POSITION_MANAGER=0x... PERMIT2=0x... WETH=0x... \
OWNER=0x... KEEPER=0x... TREASURY=0x... VAULT_POOLS=... \
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast --ledger
```

### 3. Mainnet — only after the external audit

```bash
TIDEWELL_AUDIT_REPORT=<report URL or hash> OWNER=<multisig> KEEPER=0x... TREASURY=0x... VAULT_POOLS=... \
forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --ledger --verify
```

### Publishing a deployment to the site

```bash
node scripts/apply-deployment.mjs <chainId>
```

This merges `contracts/deployments/<chainId>.json` into
`config/deployments.json` (it refuses a 4663 deployment without an audit
report too). Commit, push, and run the usual `deploy/deploy.sh` on the server;
set `KEEPER_PRIVATE_KEY` in the server's `.env` first so the keeper starts
harvesting.
