#!/usr/bin/env node
// Run one reconcile cycle from the CLI.
//   npm run reconcile             # apply changes
//   npm run reconcile -- --dry    # show diff only, no writes
import { reconcile } from '../src/reconciler.js';
import { closeDb } from '../src/db.js';
import { config } from '../src/config.js';

const dryRun = process.argv.includes('--dry');

try {
  const result = await reconcile({
    dryRun,
    concurrency: config.reconcile.concurrency,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('reconcile failed:', err.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
