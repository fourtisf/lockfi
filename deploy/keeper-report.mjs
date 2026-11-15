// The keeper, in words, from /api/health's `keeper` section.
//
// Imported by indexer-status.mjs, and by a test: kept apart from that script
// because it runs PM2 at import. Prints what the chain says the keeper has
// done for each router — the last observation, the last route, the reason
// the last attempt gave — not whether the keeper process is up, which PM2
// says. Vaults need no keeper, and the report says so rather than checking
// them for something that cannot go wrong.

/** 42 seconds / 15 minutes / 3 hours / 41 days. */
function span(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} seconds`;
  if (s < 90 * 60) return `${Math.round(s / 60)} minutes`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
}

const short = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a));

function ago(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? span((now - t) / 1000) : null;
}

/**
 * Lines for the report. `keeper` is /api/health's section, or undefined when
 * talking to an API older than the keeper.
 */
export function keeperReport(keeper, now = Date.now()) {
  if (!keeper) return ['  not reported by this API (deployed before the keeper)'];
  const lines = [];
  if (keeper.vaultCount > 0) {
    lines.push(`  vaults     ${keeper.vaultCount} deployed — vaults need no keeper: fees are credited on every deposit, withdraw, claim or poke`);
  }
  if (keeper.status === 'not-needed') {
    lines.push('  not needed yet: no router is deployed, so there is nothing to poke or route');
    return lines;
  }
  if (keeper.status === 'unknown' && !(keeper.routers ?? []).length) {
    lines.push(`  ${keeper.message}`);
    return lines;
  }
  for (const r of keeper.routers ?? []) {
    const name = `router ${short(r.address)}`;
    const routed = r.lastRouteAt ? `last routed ${ago(r.lastRouteAt, now)} ago` : 'never routed';
    const observed = r.observationAgeSeconds != null ? `observed ${span(r.observationAgeSeconds)} ago` : 'not observed';
    switch (r.state) {
      case 'not-indexed':
        lines.push(`  ${name}  not read by the indexer yet`);
        break;
      case 'paused':
        lines.push(`  ${name}  paused by its owner (${routed})`);
        break;
      case 'stale':
        lines.push(`  ${name}  STALE: ${observed}, so it has no TWAP and cannot route (${routed})`);
        break;
      default:
        lines.push(`  ${name}  ${observed}, ${routed}`);
    }
    const run = r.lastRun;
    if (run && run.status !== 'ok') {
      lines.push(`             last attempt: ${run.kind} ${run.status}${run.reason ? ` — ${run.reason}` : ''}`);
    }
  }
  if (keeper.status === 'overdue') lines.push('  see:       runuser -u balast -- pm2 logs balast-keeper --lines 40 --nostream');
  return lines;
}
