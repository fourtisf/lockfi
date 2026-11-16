// Reads the token's launchpad curve through the API's own reader, against the
// real chain, and prints what /api/token would serve.
//   npx tsx scripts/check-token-curve.mts [ethUsd]
import { createTokenCurveReader } from '../server/api/token-curve';

const reader = createTokenCurveReader();
if (!reader) {
  console.log('TOKEN_CA or TOKEN_LAUNCH is not set in lib/site.ts');
  process.exit(0);
}
const ethUsd = process.argv[2] ? Number(process.argv[2]) : null;
const value = await reader.get(ethUsd);
console.log(JSON.stringify({ ...value, history: `${value?.history.length ?? 0} points` }, null, 2));
