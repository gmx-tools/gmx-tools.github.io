import {
  type Address,
  type PublicClient,
  encodeAbiParameters,
  keccak256,
} from "viem";
import { type NetworkConfig, WHITELISTED_SYMBOLS } from "./config.js";
import type { OracleMarket, Ticker, TokenMeta, GmResult, GlvResult } from "./types.js";
import { SyntheticsReaderAbi, GlvReaderAbi } from "./abis.js";

const MAX_PNL_FACTOR_FOR_TRADERS_KEY = keccak256(
  encodeAbiParameters([{ type: "string" }], ["MAX_PNL_FACTOR_FOR_TRADERS"])
);

const BATCH_SIZE = 10;

async function processBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R | undefined>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    for (const r of batchResults) {
      if (r !== undefined) results.push(r);
    }
  }
  return results;
}

function bigintToFloat(value: bigint, decimals = 30): number {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = ((value < 0n ? -value : value) % divisor) * 10000n / divisor;
  return Number(whole) + (value < 0n ? -1 : 1) * Number(frac) / 10000;
}

function buildMarketName(
  market: OracleMarket,
  tokenMeta: Record<string, TokenMeta>
): string {
  const idx = tokenMeta[market.indexToken.toLowerCase()];
  const lng = tokenMeta[market.longToken.toLowerCase()];
  const sht = tokenMeta[market.shortToken.toLowerCase()];
  return `${idx?.symbol || "?"}/USD [${lng?.symbol || "?"}-${sht?.symbol || "?"}]`;
}

export async function fetchGmPrices(
  client: PublicClient,
  network: NetworkConfig,
  markets: OracleMarket[],
  tickers: Record<string, Ticker>,
  tokenMeta: Record<string, TokenMeta>
): Promise<GmResult[]> {
  // Filter to markets with available oracle prices
  const viable = markets.filter((m) => {
    const indexP = tickers[m.indexToken.toLowerCase()];
    const longP = tickers[m.longToken.toLowerCase()];
    const shortP = tickers[m.shortToken.toLowerCase()];
    return indexP && longP && shortP;
  });

  // Whitelist: only reliable assets, exclude meme tokens
  const filtered = viable.filter((m) => {
    const sym = tokenMeta[m.indexToken.toLowerCase()]?.symbol;
    return sym && WHITELISTED_SYMBOLS.has(sym);
  });

  const results = await processBatches(filtered, BATCH_SIZE, async (m) => {
    const indexP = tickers[m.indexToken.toLowerCase()];
    const longP = tickers[m.longToken.toLowerCase()];
    const shortP = tickers[m.shortToken.toLowerCase()];

    try {
      const [gmPrice, poolInfo] = await client.readContract({
        address: network.contracts.syntheticsReader,
        abi: SyntheticsReaderAbi,
        functionName: "getMarketTokenPrice",
        args: [
          network.contracts.dataStore,
          {
            marketToken: m.marketToken as Address,
            indexToken: m.indexToken as Address,
            longToken: m.longToken as Address,
            shortToken: m.shortToken as Address,
          },
          { min: BigInt(indexP.minPrice), max: BigInt(indexP.maxPrice) },
          { min: BigInt(longP.minPrice), max: BigInt(longP.maxPrice) },
          { min: BigInt(shortP.minPrice), max: BigInt(shortP.maxPrice) },
          MAX_PNL_FACTOR_FOR_TRADERS_KEY,
          false,
        ],
      });

      return {
        address: m.marketToken,
        name: buildMarketName(m, tokenMeta),
        price: bigintToFloat(gmPrice),
        poolValue: bigintToFloat(poolInfo.poolValue),
      };
    } catch (err: any) {
      console.warn(
        `  [${network.slug}] Skipping GM ${m.marketToken}: ${err.shortMessage || err.message}`
      );
      return undefined;
    }
  });

  results.sort((a, b) => b.poolValue - a.poolValue);
  return results;
}

interface GlvInfo {
  glv: {
    glvToken: Address;
    longToken: Address;
    shortToken: Address;
  };
  markets: readonly Address[];
}

export async function fetchGlvPrices(
  client: PublicClient,
  network: NetworkConfig,
  markets: OracleMarket[],
  tickers: Record<string, Ticker>,
  tokenMeta: Record<string, TokenMeta>
): Promise<GlvResult[]> {
  // Discover GLV vaults from chain
  let glvInfos: GlvInfo[];
  try {
    glvInfos = (await client.readContract({
      address: network.contracts.glvReader,
      abi: GlvReaderAbi,
      functionName: "getGlvInfoList",
      args: [network.contracts.dataStore, 0n, 100n],
    })) as unknown as GlvInfo[];
  } catch (err: any) {
    console.warn(
      `  [${network.slug}] Could not fetch GLV info: ${err.shortMessage || err.message}`
    );
    return [];
  }

  if (!glvInfos || glvInfos.length === 0) return [];

  // Build market lookup: marketToken -> OracleMarket
  const marketLookup: Record<string, OracleMarket> = {};
  for (const m of markets) {
    marketLookup[m.marketToken.toLowerCase()] = m;
  }

  const results: GlvResult[] = [];

  await Promise.all(
    glvInfos.map(async (info) => {
      const longP = tickers[info.glv.longToken.toLowerCase()];
      const shortP = tickers[info.glv.shortToken.toLowerCase()];

      if (!longP || !shortP) return;

      // Build parallel arrays for constituent markets
      const marketAddresses: Address[] = [];
      const indexTokenPrices: Array<{ min: bigint; max: bigint }> = [];

      for (const marketAddr of info.markets) {
        const m = marketLookup[marketAddr.toLowerCase()];
        if (!m) continue;

        const indexP = tickers[m.indexToken.toLowerCase()];
        if (!indexP) continue;

        marketAddresses.push(marketAddr);
        indexTokenPrices.push({
          min: BigInt(indexP.minPrice),
          max: BigInt(indexP.maxPrice),
        });
      }

      if (marketAddresses.length === 0) return;

      try {
        const result = await client.readContract({
          address: network.contracts.glvReader,
          abi: GlvReaderAbi,
          functionName: "getGlvTokenPrice",
          args: [
            network.contracts.dataStore,
            marketAddresses,
            indexTokenPrices,
            { min: BigInt(longP.minPrice), max: BigInt(longP.maxPrice) },
            { min: BigInt(shortP.minPrice), max: BigInt(shortP.maxPrice) },
            info.glv.glvToken,
            false,
          ],
        });

        const [glvPrice, glvSupply, glvValue] = result as readonly [bigint, bigint, bigint];

        const lng = tokenMeta[info.glv.longToken.toLowerCase()];
        const sht = tokenMeta[info.glv.shortToken.toLowerCase()];
        const name = `GLV [${lng?.symbol || "?"}-${sht?.symbol || "?"}]`;

        results.push({
          address: info.glv.glvToken,
          name,
          price: bigintToFloat(glvPrice),
          tvl: bigintToFloat(glvValue, 18),
        });
      } catch (err: any) {
        console.warn(
          `  [${network.slug}] Skipping GLV ${info.glv.glvToken}: ${err.shortMessage || err.message}`
        );
      }
    })
  );

  results.sort((a, b) => b.tvl - a.tvl);
  return results;
}
