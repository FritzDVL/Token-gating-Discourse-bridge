#!/usr/bin/env node
// Usage: npm run test:lookup -- 0xWalletAddress
import { findUserByWallet, closeDb } from '../src/db.js';

const wallet = process.argv[2];
if (!wallet) {
  console.error('usage: npm run test:lookup -- 0xWalletAddress');
  process.exit(2);
}

try {
  const user = await findUserByWallet(wallet);
  if (!user) {
    console.log(JSON.stringify({ wallet, found: false }, null, 2));
  } else {
    console.log(JSON.stringify({ wallet, found: true, ...user }, null, 2));
  }
} catch (err) {
  console.error('lookup failed:', err.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
