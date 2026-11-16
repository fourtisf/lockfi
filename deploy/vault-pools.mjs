#!/usr/bin/env node
// Which pool a new vault goes on, for each token asked for. Used by
// deploy/add-vaults.sh; reads the API's own snapshot, so the choice is made
// from the same pools the site shows.
//
//   node deploy/vault-pools.mjs <api-base> <token|address|pool-id>...
//
// A token (symbol or address) gets its deepest pool that a vault can hold —
// Uniswap v4, no hook, not on a launchpad curve, no vault yet — or its
// deepest one paired with ETH when that holds at least a quarter as much, so
// a stake can be made with ETH without settling for a thin pool. A pool id is taken
// as given, after the same checks. A symbol several contracts share is
// refused unless one of them holds nearly all the depth: copies of popular
// tokens are common on this chain, and a vault on a copy is a vault nobody
// meant to build.
//
// stdout: one line per vault, "<currency0>:<currency1>:<fee>:<tickSpacing>\t<poolId>\t<label>".
// stderr: the reasoning, and the alternatives, for the person deciding.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const CHAIN_ID = '4663';

const [api, ...asked] = process.argv.slice(2);
if (!api || asked.length === 0) {
  console.error('usage: node deploy/vault-pools.mjs <api-base> <token|address|v4:pool-id>...');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = new Set(
  (JSON.parse(readFileSync(join(root, 'config/deployments.json'), 'utf8'))[CHAIN_ID]?.vaults ?? []).map((v) =>
    String(v.poolId).toLowerCase(),
  ),
);

const say = (line = '') => process.stderr.write(line + '\n');
const usd = (n) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`;
const isEth = (c) => c === ZERO || c === WETH;
const feeLabel = (fee) => `${+(fee / 10_000).toFixed(4)}%`;
// The token first, as the site names pairs (lib/pair.ts): CASHCAT / ETH.
const pairOf = (p) => {
  const k = p.key;
  const token = p.token.address.toLowerCase();
  const other = [k.currency0, k.currency1].map((c) => c.toLowerCase()).find((c) => c !== token) ?? '';
  return `${p.token.symbol} / ${other === ZERO ? 'ETH' : other === WETH ? 'WETH' : p.quote}`;
};
const label = (p) => `${pairOf(p)} · ${feeLabel(p.key.fee)}`;

/** Why a vault cannot hold this pool, or null when it can. */
function unfit(p) {
  if (p.protocol !== 'v4' || !p.key) return 'not a Uniswap v4 pool';
  if (p.key.hooks.toLowerCase() !== ZERO) return 'has a hook (a vault holds hookless pools only)';
  if (!p.stakeable) return 'still on its launchpad curve';
  if (deployed.has(p.id.toLowerCase())) return 'already has a vault';
  return null;
}

let snapshot;
try {
  const res = await fetch(`${api.replace(/\/$/, '')}/api/snapshot`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  snapshot = await res.json();
} catch (error) {
  say(`Could not read the pools from ${api}/api/snapshot: ${error.message}`);
  say('Is balast-api running?  runuser -u balast -- pm2 status');
  process.exit(1);
}
const pools = snapshot.pools ?? [];
if (pools.length === 0) {
  say('The API lists no pools yet — wait for the indexer, or pass an exact pool id.');
  process.exit(1);
}

const chosen = [];
let failed = false;

for (const arg of asked) {
  const a = arg.trim().toLowerCase();
  say(`\n  ${arg}`);

  if (/^v4:0x[0-9a-f]{64}$/.test(a)) {
    const p = pools.find((x) => x.id.toLowerCase() === a);
    if (!p) {
      say(`    no such pool among the ${pools.length} the API lists (it lists pools that traded in the last 8 days)`);
      failed = true;
      continue;
    }
    const why = unfit(p);
    if (why) {
      say(`    ${label(p)}: ${why}`);
      failed = true;
      continue;
    }
    say(`    ${label(p)}  depth ${usd(p.tvlUsd)}  fees 24h ${usd(p.fees24hUsd)}  — as given`);
    chosen.push(p);
    continue;
  }

  let tokenPools;
  if (/^0x[0-9a-f]{40}$/.test(a)) {
    tokenPools = pools.filter((p) => p.token.address.toLowerCase() === a);
    if (tokenPools.length === 0) {
      say('    no pool for that token address among the pools the API lists');
      failed = true;
      continue;
    }
  } else {
    const matches = pools.filter((p) => p.token.symbol.toLowerCase() === a);
    const byAddress = new Map();
    for (const p of matches) {
      const k = p.token.address.toLowerCase();
      byAddress.set(k, (byAddress.get(k) ?? 0) + p.tvlUsd);
    }
    const ranked = [...byAddress.entries()].sort((x, y) => y[1] - x[1]);
    if (ranked.length === 0) {
      say('    no token by that symbol among the pools the API lists');
      failed = true;
      continue;
    }
    if (ranked.length > 1) {
      const [top, next] = ranked;
      say(`    ${ranked.length} contracts call themselves ${arg}:`);
      for (const [addr, depth] of ranked.slice(0, 5)) say(`      ${addr}  depth ${usd(depth)}`);
      if (!(top[1] > 0 && top[1] >= next[1] * 10)) {
        say('    none holds nearly all the depth: pass the token address you mean instead of the symbol');
        failed = true;
        continue;
      }
      say(`    taking ${top[0]}: ${Math.round(top[1] / Math.max(next[1], 1))}x the depth of the next`);
    }
    tokenPools = matches.filter((p) => p.token.address.toLowerCase() === ranked[0][0]);
  }

  const symbol = tokenPools[0].token.symbol;
  const sorted = [...tokenPools].sort((x, y) => y.tvlUsd - x.tvlUsd);
  const already = sorted.find((p) => deployed.has(p.id.toLowerCase()));
  if (already) {
    say(`    ${symbol} already has a vault, on ${label(already)} — nothing to add`);
    continue;
  }
  const fit = sorted.filter((p) => unfit(p) === null);
  const withEth = fit.filter((p) => isEth(p.key.currency0.toLowerCase()) || isEth(p.key.currency1.toLowerCase()));
  // ETH first, so a stake can start from ETH — but not at any price: an ETH
  // pool a fraction as deep as the token's best (AAPL's ETH pool holds $2K
  // beside $401K against USDG) is the thinner market, with the wider moves.
  const ethPick = withEth[0] && fit[0] && withEth[0].tvlUsd >= fit[0].tvlUsd / 4 ? withEth[0] : null;
  const pick = ethPick ?? fit[0];
  if (!pick) {
    say(`    none of ${symbol}'s ${sorted.length} pools can hold a vault:`);
    for (const p of sorted.slice(0, 4)) say(`      ${p.key ? label(p) : p.id}  ${unfit(p)}`);
    failed = true;
    continue;
  }
  say(
    `    -> ${label(pick)}  depth ${usd(pick.tvlUsd)}  fees 24h ${usd(pick.fees24hUsd)}  ${pick.id}` +
      (isEth(pick.key.currency0.toLowerCase()) || isEth(pick.key.currency1.toLowerCase())
        ? ''
        : `\n       paired with ${pick.quote}, not ETH: stakes go in as ${pick.quote}, ${symbol}, or both`),
  );
  const others = fit.filter((p) => p !== pick).slice(0, 3);
  if (others.length > 0) {
    say('       other pools a vault could hold (pass the id instead to choose one):');
    for (const p of others) say(`         ${label(p)}  depth ${usd(p.tvlUsd)}  fees 24h ${usd(p.fees24hUsd)}  ${p.id}`);
  }
  chosen.push(pick);
}

if (failed) {
  say('\nNothing chosen: fix the lines above and run again.');
  process.exit(1);
}
const unique = [...new Map(chosen.map((p) => [p.id.toLowerCase(), p])).values()];
for (const p of unique) {
  const k = p.key;
  process.stdout.write(`${k.currency0}:${k.currency1}:${k.fee}:${k.tickSpacing}\t${p.id.toLowerCase()}\t${label(p)}\n`);
}
