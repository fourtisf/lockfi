#!/usr/bin/env bash
#
# Give tokens staking: deploy a Tidewell vault on one pool of each.
#
#   bash /var/www/balast/deploy/add-vaults.sh CASHCAT PONS
#   bash /var/www/balast/deploy/add-vaults.sh 0x020bfc650a365f8bb26819deaabf3e21291018b4
#   bash /var/www/balast/deploy/add-vaults.sh v4:0xf7dc0af99fce7169eb76854c0b39beb9915526894d42229946e5cb469cab50b1
#
# A vault is per pool. For each token this picks its deepest pool a vault
# can hold (Uniswap v4, no hook), or its deepest pool paired with ETH when
# that holds at least a quarter as much, shows the others, and you can pass
# an exact pool id instead. Only vaults are deployed: the zap and shaper
# already deployed serve every vault. Each new vault gets the same owner,
# treasury, fee and fee cap as the first one, read from the chain.
#
# Run as root, after deploy/contracts.sh has run once (it installed Foundry
# and imported the deployer wallet). About 0.0002 ETH of gas per vault.
#
# Nothing on the site changes until the printed record is published: send it
# back, it goes into config/deployments.json, then run deploy/deploy.sh.
set -euo pipefail

APP_DIR=/var/www/balast
APP_USER=balast
RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
EXPLORER_API="https://robinhoodchain.blockscout.com/api/"
ACCOUNT=tidewell-deployer
API="${API_URL:-http://127.0.0.1:${API_PORT:-3001}}"

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
[[ $# -ge 1 ]] || { sed -n '3,7p' "$0"; exit 1; }
say() { printf '\n==> %s\n' "$*"; }
is_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }
first_word() { awk '{print $1}'; }

export PATH="$HOME/.foundry/bin:$PATH"
if ! command -v forge >/dev/null 2>&1 || ! command -v cast >/dev/null 2>&1; then
  echo "Foundry is not installed here: run  bash $APP_DIR/deploy/contracts.sh  first."
  exit 1
fi
cd "$APP_DIR"

# ------------------------------------------------------------ 1. Pools
say "choosing pools (from the site's own pool list)"
specs=$(node deploy/vault-pools.mjs "$API" "$@")
[[ -n "$specs" ]] || { echo "    nothing to deploy"; exit 0; }
VAULT_POOLS=$(cut -f1 <<<"$specs" | paste -sd, -)
count=$(wc -l <<<"$specs" | tr -d ' ')

# ------------------------------------------------------------ 2. Settings
# The same as the vaults already live, so every vault answers to one owner
# and pays one treasury — read from the chain, not typed again.
FIRST=$(node -e '
  const d = require(process.argv[1])["4663"];
  process.stdout.write(d && d.vaults && d.vaults[0] ? d.vaults[0].address : "");
' "$APP_DIR/config/deployments.json")
is_addr "$FIRST" || { echo "no vault in config/deployments.json to copy the settings from"; exit 1; }
OWNER=$(cast call --rpc-url "$RPC" "$FIRST" 'owner()(address)' | first_word)
TREASURY=$(cast call --rpc-url "$RPC" "$FIRST" 'treasury()(address)' | first_word)
PROTOCOL_FEE_BPS=$(cast call --rpc-url "$RPC" "$FIRST" 'protocolFeeBps()(uint16)' | first_word)
PROTOCOL_FEE_CAP_BPS=$(cast call --rpc-url "$RPC" "$FIRST" 'protocolFeeCapBps()(uint16)' | first_word)
is_addr "$OWNER" && is_addr "$TREASURY" || { echo "could not read owner and treasury from $FIRST"; exit 1; }
[[ "$PROTOCOL_FEE_BPS" =~ ^[0-9]+$ && "$PROTOCOL_FEE_CAP_BPS" =~ ^[0-9]+$ ]] || { echo "could not read the fee from $FIRST"; exit 1; }

# ------------------------------------------------------------ 3. Deployer
# The wallet contracts.sh imported; any wallet holding a little ETH will do —
# deploying a vault gives the deployer no role in it.
KEY_FILE="${DEPLOYER_KEY_FILE:-/root/tidewell-deployer.txt}"
KEYSTORE="$HOME/.foundry/keystores/$ACCOUNT"
if [[ -f "$KEYSTORE" ]] && ! cast wallet address --account "$ACCOUNT" --password "" >/dev/null 2>&1; then
  echo "    $KEYSTORE has a password this script cannot open; remove it and run again"
  exit 1
fi
if [[ ! -f "$KEYSTORE" ]]; then
  if [[ -f "$KEY_FILE" ]]; then
    key=$(grep -oE '0x[0-9a-fA-F]{64}' "$KEY_FILE" | head -1 || true)
    [[ -n "$key" ]] || { echo "no private key found in $KEY_FILE"; exit 1; }
  else
    say "deployer wallet"
    read -r -s -p "    Paste a private key holding ~0.001 ETH for gas (hidden, then Enter): " key
    echo
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] || { echo "    that is not a private key (64 hex characters)"; exit 1; }
    [[ "$key" == 0x* ]] || key="0x$key"
  fi
  cast wallet import "$ACCOUNT" --private-key "$key" --unsafe-password "" >/dev/null
  unset key
fi
DEPLOYER=$(cast wallet address --account "$ACCOUNT" --password "")
echo "    deployer: $DEPLOYER  balance: $(cast balance --rpc-url "$RPC" "$DEPLOYER" --ether) ETH"
if [[ "$(cast balance --rpc-url "$RPC" "$DEPLOYER")" == "0" ]]; then
  echo "    It has no ETH for gas: send it ~0.001 ETH and run this again."
  exit 1
fi

# ------------------------------------------------------------ 4. Build
say "building"
runuser -u "$APP_USER" -- git submodule update --init --recursive
cd "$APP_DIR/contracts"
forge build

export OWNER TREASURY PROTOCOL_FEE_BPS PROTOCOL_FEE_CAP_BPS VAULT_POOLS
export TIDEWELL_UNAUDITED_MAINNET=I_ACCEPT_THE_RISK

# ------------------------------------------------------------ 5. Simulate
say "simulating against mainnet (nothing is sent)"
ok=""
for attempt in 1 2 3; do
  if forge script script/AddVaults.s.sol --rpc-url "$RPC" --sender "$DEPLOYER" 2>&1 | tee /tmp/tidewell-add-sim.log |
    grep -E 'dry run|Estimated|SIMULATION COMPLETE'; then
    ok=1
    break
  fi
  sleep 3
done
[[ -n "$ok" ]] || { echo "simulation failed — see /tmp/tidewell-add-sim.log"; exit 1; }

echo
echo "    About to deploy $count vault(s) to Robinhood Chain MAINNET:"
cut -f3,2 <<<"$specs" | awk -F'\t' '{printf "      %-28s %s\n", $2, $1}'
cat <<EOF
    owner     $OWNER
    treasury  $TREASURY
    fee       $((PROTOCOL_FEE_BPS / 100))% of fees collected (cap $((PROTOCOL_FEE_CAP_BPS / 100))%, fixed forever per vault)
    NOT independently audited.
EOF
read -r -p "    Type DEPLOY to send the transactions: " answer
[[ "$answer" == "DEPLOY" ]] || { echo "not deployed"; exit 1; }

# ------------------------------------------------------------ 6. Deploy
say "deploying"
set +e
forge script script/AddVaults.s.sol --rpc-url "$RPC" --account "$ACCOUNT" --password "" --sender "$DEPLOYER" --broadcast --slow \
  --verify --verifier blockscout --verifier-url "$EXPLORER_API"
status=$?
set -e
OUT="$APP_DIR/contracts/deployments/4663-added-vaults.json"
[[ -s "$OUT" ]] || { echo "no $OUT — nothing was deployed"; exit 1; }

say "checking every vault on chain"
missing=0
for a in $(node -e 'for (const v of require(process.argv[1]).vaults) console.log(v.address)' "$OUT"); do
  code=$(cast code --rpc-url "$RPC" "$a")
  if [[ "$code" == "0x" || -z "$code" ]]; then echo "    NO CODE at $a"; missing=1; else echo "    ok $a"; fi
done
if [[ $missing -ne 0 ]]; then
  echo "The deployment did not finish (forge exit $status). Do NOT publish $OUT."
  echo "Finish it with the same forge script command plus --resume, then rerun this check."
  exit 1
fi
[[ $status -eq 0 ]] || echo "    (forge exit $status: most likely source verification only — the vaults are deployed)"

# block.number in a forge script on an Arbitrum chain is the L1 block; the
# indexer starts reading each vault at its block, so take the receipts' own.
node -e '
  const fs = require("fs");
  const [out, bc] = process.argv.slice(1);
  const d = JSON.parse(fs.readFileSync(out, "utf8"));
  let receipts = [];
  try { receipts = JSON.parse(fs.readFileSync(bc, "utf8")).receipts ?? []; } catch {}
  const at = {};
  for (const r of receipts) if (r.contractAddress) at[r.contractAddress.toLowerCase()] = Number(BigInt(r.blockNumber));
  const missing = d.vaults.filter((v) => !Number.isInteger(at[v.address.toLowerCase()]));
  if (missing.length) {
    console.error("    receipts missing for some vaults in " + bc + ": blocks NOT corrected — say so when sending this back");
    process.exit(0);
  }
  for (const v of d.vaults) v.deployedBlock = at[v.address.toLowerCase()];
  fs.writeFileSync(out, JSON.stringify(d, null, 2) + "\n");
  console.log("    blocks taken from the receipts");
' "$OUT" "$APP_DIR/contracts/broadcast/AddVaults.s.sol/4663/run-latest.json"

say "deployed. Send this back so the vaults are published to the site:"
cat "$OUT"
cat <<EOF

    The site does not show them until that record is in config/deployments.json
    and the site is redeployed:  bash $APP_DIR/deploy/deploy.sh
EOF
