#!/usr/bin/env bash
#
# Deploy Tidewell's contracts to Robinhood Chain mainnet, from this server.
# One time. Run as root:
#
#   bash /var/www/balast/deploy/contracts.sh
#
# What it does, in order, stopping at the first problem:
#   1. Installs Foundry (forge, cast) if it is missing.
#   2. Fetches the contract libraries and builds the contracts.
#   3. Creates the KEEPER wallet here, on the server, and writes its key to
#      /var/www/balast/.env (mode 600). The key never leaves this machine.
#   4. Asks for the OWNER and TREASURY addresses (your own wallets — public
#      addresses only, never a private key).
#   5. Imports the DEPLOYER wallet into a Foundry keystore (no password): you
#      paste its private key into a hidden prompt. Use a fresh wallet holding
#      only ~0.002 ETH for gas; it has no role after deploying.
#   6. Simulates the deployment against mainnet and shows the cost.
#   7. Deploys only after you type DEPLOY (verifying the source on the
#      explorer), checks every address holds code on chain, and prints the
#      addresses to send back for the site.
#
# The contracts are NOT independently audited. ALFA decided to launch on
# mainnet anyway (CLAUDE.md §20); the site says so beside every signing button.
set -euo pipefail

APP_DIR=/var/www/balast
APP_USER=balast
RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
EXPLORER_API="https://robinhoodchain.blockscout.com/api/"
ACCOUNT=tidewell-deployer
# The first vaults: the two native ETH / USDG pools with the most depth, both
# hookless and both rehearsed on a fork (CLAUDE.md §20):
#   fee 460 (0.046%), spacing 9   pool 0x54f78839…  the deepest by the indexer's TVL
#   fee 500 (0.05%),  spacing 10  pool 0x387bf619…
VAULT_POOLS="${VAULT_POOLS:-0x0000000000000000000000000000000000000000:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168:460:9,0x0000000000000000000000000000000000000000:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168:500:10}"

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
say() { printf '\n==> %s\n' "$*"; }
is_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }

# ---------------------------------------------------------------- 1. Foundry
export PATH="$HOME/.foundry/bin:$PATH"
if ! command -v forge >/dev/null 2>&1; then
  say "installing Foundry"
  curl -fsSL https://foundry.paradigm.xyz | bash
  "$HOME/.foundry/bin/foundryup"
fi
forge --version | head -1

# ------------------------------------------------------------ 2. Build
say "fetching contract libraries"
cd "$APP_DIR"
runuser -u "$APP_USER" -- git submodule update --init --recursive
cd "$APP_DIR/contracts"
say "building"
forge build

# ------------------------------------------------------------ 3. Keeper
ENV_FILE="$APP_DIR/.env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
chown "$APP_USER":"$APP_USER" "$ENV_FILE"
existing=$(grep -E '^KEEPER_PRIVATE_KEY=0x[0-9a-fA-F]{64}$' "$ENV_FILE" | head -1 | cut -d= -f2 || true)
if [[ -n "$existing" ]]; then
  KEEPER=$(cast wallet address --private-key "$existing")
  say "keeper wallet already in .env: $KEEPER"
else
  say "creating the keeper wallet"
  # 32 random bytes are the key; cast only derives the address, whose output
  # is the address alone. Parsing `cast wallet new` broke on a newer Foundry
  # whose output format differs.
  KEEPER=""
  for _ in 1 2 3; do
    key="0x$(openssl rand -hex 32)"
    KEEPER=$(cast wallet address --private-key "$key" 2>/dev/null | tr -d '[:space:]' || true)
    is_addr "$KEEPER" && break
  done
  is_addr "$KEEPER" && [[ "$key" =~ ^0x[0-9a-f]{64}$ ]] || { echo "could not create the keeper wallet"; exit 1; }
  sed -i '/^KEEPER_PRIVATE_KEY=/d' "$ENV_FILE"
  printf 'KEEPER_PRIVATE_KEY=%s\n' "$key" >> "$ENV_FILE"
  unset key
  echo "    keeper: $KEEPER (key written to $ENV_FILE, readable by root and $APP_USER only)"
fi

# ------------------------------------------------------------ 4. Owner, treasury
say "addresses (public addresses only)"
read -r -p "    OWNER — the wallet that controls vault settings (treasury, fee up to 20%, new deposits; never funds): " OWNER
is_addr "$OWNER" || { echo "not an address: $OWNER"; exit 1; }
read -r -p "    TREASURY — where the 10% protocol fee is paid: " TREASURY
is_addr "$TREASURY" || { echo "not an address: $TREASURY"; exit 1; }

# ------------------------------------------------------------ 5. Deployer
# A key saved to a file by the one-line generator (see the README) is used
# from there, so nothing has to be copied out of a terminal — tmux makes that
# hard. Otherwise the key is pasted into a hidden prompt.
#
# The keystore has an EMPTY password, by ALFA's choice: the deployer is a
# throwaway holding only gas, it has no role once the contracts exist, and the
# file is readable by root alone. A password here only added three prompts.
KEY_FILE="${DEPLOYER_KEY_FILE:-/root/tidewell-deployer.txt}"
KEYSTORE="$HOME/.foundry/keystores/$ACCOUNT"
# A keystore left by an earlier run with a password: the empty one cannot open
# it, so it is replaced. It only ever held the throwaway deployer.
if [[ -f "$KEYSTORE" ]] && ! cast wallet address --account "$ACCOUNT" --password "" >/dev/null 2>&1; then
  say "an earlier deployer keystore has a password; replacing it with one that has none"
  rm -f "$KEYSTORE"
fi
if [[ ! -f "$KEYSTORE" ]]; then
  if [[ -f "$KEY_FILE" ]]; then
    key=$(grep -oE '0x[0-9a-fA-F]{64}' "$KEY_FILE" | head -1 || true)
    [[ -n "$key" ]] || { echo "no private key found in $KEY_FILE"; exit 1; }
    say "importing the deployer wallet from $KEY_FILE"
  else
    say "deployer wallet"
    read -r -s -p "    Paste the DEPLOYER's private key (hidden, then Enter): " key
    echo
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] || { echo "    that is not a private key (64 hex characters)"; exit 1; }
    [[ "$key" == 0x* ]] || key="0x$key"
  fi
  cast wallet import "$ACCOUNT" --private-key "$key" --unsafe-password "" >/dev/null
  unset key
fi
DEPLOYER=$(cast wallet address --account "$ACCOUNT" --password "")
balance=$(cast balance --rpc-url "$RPC" "$DEPLOYER" --ether)
echo "    deployer: $DEPLOYER  balance: $balance ETH"
if [[ "$(cast balance --rpc-url "$RPC" "$DEPLOYER")" == "0" ]]; then
  echo "    This wallet has no ETH for gas. Either send it ~0.002 ETH, or this is the"
  echo "    wrong key: rm $KEYSTORE and run this script again."
  exit 1
fi

export OWNER KEEPER TREASURY VAULT_POOLS
export PROTOCOL_FEE_BPS=1000 PROTOCOL_FEE_CAP_BPS=2000
export TIDEWELL_UNAUDITED_MAINNET=I_ACCEPT_THE_RISK

# ------------------------------------------------------------ 6. Simulate
say "simulating against mainnet (nothing is sent)"
ok=""
for attempt in 1 2 3; do
  # The public RPC is load-balanced and its nodes can disagree on the head
  # by a few blocks ("failed to get block number"); a retry is enough.
  if forge script script/Deploy.s.sol --rpc-url "$RPC" --sender "$DEPLOYER" 2>&1 | tee /tmp/tidewell-sim.log |
    grep -E 'dry run|Estimated|SIMULATION COMPLETE'; then
    ok=1
    break
  fi
  sleep 3
done
[[ -n "$ok" ]] || { echo "simulation failed — see /tmp/tidewell-sim.log"; exit 1; }

cat <<EOF

    About to deploy to Robinhood Chain MAINNET (chainId 4663):
      TidewellZap, TidewellShaper, TidewellRouterFactory,
      TidewellVault for ETH/USDG 0.046% and for ETH/USDG 0.05%
    owner     $OWNER
    keeper    $KEEPER
    treasury  $TREASURY
    fee       10% of fees collected (cap 20%, fixed forever)
    NOT independently audited.
EOF
read -r -p "    Type DEPLOY to send the transactions: " answer
[[ "$answer" == "DEPLOY" ]] || { echo "not deployed"; exit 1; }

# ------------------------------------------------------------ 7. Deploy
say "deploying"
# Not retried: a broadcast is not idempotent. Source verification on the
# explorer rides along; if only verification fails, the deployment stands.
set +e
forge script script/Deploy.s.sol --rpc-url "$RPC" --account "$ACCOUNT" --password "" --sender "$DEPLOYER" --broadcast --slow \
  --verify --verifier blockscout --verifier-url "$EXPLORER_API"
status=$?
set -e
OUT="$APP_DIR/contracts/deployments/4663.json"
[[ -s "$OUT" ]] || { echo "no $OUT — nothing was deployed"; exit 1; }

# forge writes that file while preparing the transactions, before they are
# sent. Trust it only once every address in it holds code on chain.
say "checking every address on chain"
missing=0
for a in $(node -e '
  const d = require(process.argv[1]);
  for (const a of [d.zap, d.shaper, d.routerFactory, ...d.vaults.map((v) => v.address)]) console.log(a);
' "$OUT"); do
  code=$(cast code --rpc-url "$RPC" "$a")
  if [[ "$code" == "0x" || -z "$code" ]]; then echo "    NO CODE at $a"; missing=1; else echo "    ok $a"; fi
done
if [[ $missing -ne 0 ]]; then
  echo "The deployment did not finish (forge exit $status). Do NOT publish $OUT."
  echo "Finish it with the same forge script command plus --resume, then rerun this check."
  exit 1
fi
[[ $status -eq 0 ]] || echo "    (forge exit $status: most likely source verification only — the contracts are deployed)"

say "deployed. Send this back so it is published to the site:"
cat "$OUT"
cat <<EOF

    Then:
      0. once the deployer key is saved on your own computer: shred -u $KEY_FILE
      1. send ~0.01 ETH to the keeper $KEEPER for router gas (vaults need no keeper;
         it idles until a token team creates a router)
      2. after the site update is pushed:  bash $APP_DIR/deploy/deploy.sh
EOF
