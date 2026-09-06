// cryptoassetSelectionList.ts

export interface CryptoassetListEntry {
  readonly symbol: string;       // e.g. "BTC"
  readonly displayName: string;  // e.g. "Bitcoin"
}

/** The fixed, ordered list required by Req 9.1, largest to smallest market cap. */
export const CRYPTOASSET_SELECTION_LIST: readonly CryptoassetListEntry[] = [
  { symbol: 'BTC', displayName: 'Bitcoin' },
  { symbol: 'ETH', displayName: 'Ethereum' },
  { symbol: 'USDT', displayName: 'Tether' },
  { symbol: 'BNB', displayName: 'BNB' },
  { symbol: 'XRP', displayName: 'XRP' },
  { symbol: 'USDC', displayName: 'USDC' },
  { symbol: 'SOL', displayName: 'Solana' },
  { symbol: 'TRX', displayName: 'TRON' },
  { symbol: 'HYPE', displayName: 'Hyperliquid' },
  { symbol: 'ZEC', displayName: 'Zcash' },
  { symbol: 'DOGE', displayName: 'Dogecoin' },
  { symbol: 'XMR', displayName: 'Monero' },
  { symbol: 'LINK', displayName: 'Chainlink' },
  { symbol: 'LEO', displayName: 'UNUS SED LEO' },
  { symbol: 'ADA', displayName: 'Cardano' },
];
