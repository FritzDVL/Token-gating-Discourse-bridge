#!/usr/bin/env node
// Usage: npm run test:holdings -- 0xWalletAddress
// Asks the configured holdings provider what policy tokens a wallet holds.
import { makeProvider } from '../src/holdings.js';

const wallet = process.argv[2];
if (!wallet) {
  console.error('usage: npm run test:holdings -- 0xWalletAddress');
  process.exit(2);
}

try {
  const provider = makeProvider();
  const held = await provider.getPolicyTokens(wallet.toLowerCase());
  console.log(JSON.stringify({
    wallet,
    provider: provider.name,
    heldPolicyTokens: [...held],
  }, null, 2));
} catch (err) {
  console.error('holdings lookup failed:', err.message);
  if (err.body) console.error('response:', err.body);
  process.exitCode = 1;
}
