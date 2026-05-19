#!/usr/bin/env node
// Usage: npm run test:dryrun-grant -- 0xWalletAddress 11
import { processEvent } from '../src/webhook.js';
import { closeDb } from '../src/db.js';

const wallet = process.argv[2];
const tokenId = process.argv[3];
if (!wallet || !tokenId) {
  console.error('usage: npm run test:dryrun-grant -- 0xWalletAddress <tokenId>');
  process.exit(2);
}

try {
  const result = await processEvent(
    { wallet: wallet.toLowerCase(), tokenId: String(tokenId), action: 'grant' },
    { dryRun: true },
  );
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('dryrun failed:', err.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
