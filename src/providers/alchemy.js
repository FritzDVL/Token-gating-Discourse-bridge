import { ethers } from 'ethers';
import { config, ACTIVE_POLICY_TOKEN_IDS } from '../config.js';
import { logger } from '../logger.js';

// Minimal ERC-1155 ABI — only the bits we actually use.
export const ERC1155_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
];

let _httpProvider = null;
let _contract = null;

function httpProvider() {
  if (_httpProvider) return _httpProvider;
  _httpProvider = new ethers.JsonRpcProvider(
    `https://eth-mainnet.g.alchemy.com/v2/${config.alchemy.apiKey}`,
  );
  return _httpProvider;
}

export function contractHttp() {
  if (_contract) return _contract;
  _contract = new ethers.Contract(
    config.nft.contractAddress,
    ERC1155_ABI,
    httpProvider(),
  );
  return _contract;
}

/**
 * Holdings provider for the reconciler.
 *   getPolicyTokens(wallet)         -> Set<tokenIdString>
 *   getPolicyTokensBatch(wallets[]) -> Map<wallet, Set<tokenIdString>>
 *
 * Uses balanceOfBatch in both cases — one RPC call serves up to
 * ~1000 / N_tokens wallets, which makes the reconciler very cheap.
 */
export function alchemyProvider() {
  const contract = contractHttp();
  // Only query tokens that are actually wired to a Discourse group.
  // Tokens with groupId=null are skipped to save RPC work.
  const policyTokens = [...ACTIVE_POLICY_TOKEN_IDS];

  return {
    name: 'alchemy',

    async getPolicyTokens(wallet) {
      // Batch all policy tokens for this single wallet in one RPC call.
      const accounts = policyTokens.map(() => wallet);
      const ids = policyTokens.map((t) => BigInt(t));
      const balances = await contract.balanceOfBatch(accounts, ids);
      const held = new Set();
      balances.forEach((bal, i) => {
        if (bal > 0n) held.add(policyTokens[i]);
      });
      return held;
    },

    /**
     * Batched version for the reconciler. Returns Map<wallet, Set<tokenId>>.
     * One RPC call serves up to `chunkSize / policyTokens.length` wallets.
     */
    async getPolicyTokensBatch(wallets, { chunkSize = 1000 } = {}) {
      const out = new Map();
      const tokensPerWallet = policyTokens.length;
      const walletsPerChunk = Math.max(1, Math.floor(chunkSize / tokensPerWallet));

      for (let i = 0; i < wallets.length; i += walletsPerChunk) {
        const chunk = wallets.slice(i, i + walletsPerChunk);
        const accounts = [];
        const ids = [];
        for (const w of chunk) {
          for (const t of policyTokens) {
            accounts.push(w);
            ids.push(BigInt(t));
          }
        }
        const balances = await contract.balanceOfBatch(accounts, ids);
        for (let w = 0; w < chunk.length; w++) {
          const held = new Set();
          for (let t = 0; t < tokensPerWallet; t++) {
            const idx = w * tokensPerWallet + t;
            if (balances[idx] > 0n) held.add(policyTokens[t]);
          }
          out.set(chunk[w], held);
        }
        logger.debug('alchemy batch chunk', {
          wallets: chunk.length,
          tokens: tokensPerWallet,
          calls: 1,
        });
      }
      return out;
    },
  };
}

/**
 * Read a single (wallet, tokenId) balance. Used by the chain listener
 * to react to one transfer at a time.
 */
export async function readBalance(wallet, tokenId) {
  const balance = await contractHttp().balanceOf(wallet, BigInt(tokenId));
  return balance > 0n;
}
