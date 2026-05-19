import { alchemyProvider } from './providers/alchemy.js';

/**
 * Pluggable holdings provider.
 *
 * A provider answers a single question:
 *   "For this wallet, which of OUR policy token IDs does it currently hold?"
 *
 * Returns a Set<string> of token IDs (as strings). Empty set means the wallet
 * holds none of our tokens. We never return tokens outside the active policy.
 *
 * Currently only one provider: 'alchemy' (reads the chain directly). The
 * interface is kept abstract so a different RPC provider (Infura, QuickNode,
 * self-hosted node) could be dropped in without touching the reconciler or
 * the chain listener.
 */
export function makeProvider() {
  return alchemyProvider();
}
