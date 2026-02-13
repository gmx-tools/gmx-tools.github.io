import {
  createPublicClient,
  http,
  type Address,
  encodeAbiParameters,
  keccak256,
} from "viem";
import { arbitrum } from "viem/chains";
import { mkdirSync, writeFileSync } from "node:fs";

const ORACLE_URL = "https://arbitrum-api.gmxinfra.io";
const DATA_STORE = "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8" as const;
const READER = "0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789" as const;

const MAX_PNL_FACTOR_FOR_TRADERS_KEY = keccak256(
  encodeAbiParameters([{ type: "string" }], ["MAX_PNL_FACTOR_FOR_TRADERS"])
);

const readerAbi = [
  {
    inputs: [
      { name: "dataStore", type: "address" },
      {
        name: "market",
        type: "tuple",
        components: [
          { name: "marketToken", type: "address" },
          { name: "indexToken", type: "address" },
          { name: "longToken", type: "address" },
          { name: "shortToken", type: "address" },
        ],
      },
      {
        name: "indexTokenPrice",
        type: "tuple",
        components: [
          { name: "min", type: "uint256" },
          { name: "max", type: "uint256" },
        ],
      },
      {
        name: "longTokenPrice",
        type: "tuple",
        components: [
          { name: "min", type: "uint256" },
          { name: "max", type: "uint256" },
        ],
      },
      {
        name: "shortTokenPrice",
        type: "tuple",
        components: [
          { name: "min", type: "uint256" },
          { name: "max", type: "uint256" },
        ],
      },
      { name: "pnlFactorType", type: "bytes32" },
      { name: "maximize", type: "bool" },
    ],
    name: "getMarketTokenPrice",
    outputs: [
      { name: "", type: "int256" },
      {
        name: "",
        type: "tuple",
        components: [
          { name: "poolValue", type: "int256" },
          { name: "longPnl", type: "int256" },
          { name: "shortPnl", type: "int256" },
          { name: "netPnl", type: "int256" },
          { name: "longTokenAmount", type: "uint256" },
          { name: "shortTokenAmount", type: "uint256" },
          { name: "longTokenUsd", type: "uint256" },
          { name: "shortTokenUsd", type: "uint256" },
          { name: "totalBorrowingFees", type: "uint256" },
          { name: "borrowingFeePoolFactor", type: "uint256" },
          { name: "impactPoolAmount", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface OracleMarket {
  marketToken: string;
  indexToken: string;
  longToken: string;
  shortToken: string;
}

interface Ticker {
  tokenAddress: string;
  tokenSymbol: string;
  minPrice: string;
  maxPrice: string;
}

const TARGET_ADDRESSES = new Set([
  "0x47c031236e19d024b42f8AE6780E44A573170703".toLowerCase(),
  "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336".toLowerCase(),
  "0x7C11F78Ce78768518D743E81Fdfa2F860C6b9A77".toLowerCase(),
]);

function bigintToUsd(value: bigint): number {
  // value is in 30-decimal USD. Convert to float with 4 decimal places.
  const whole = value / 10n ** 30n;
  const frac = (value % 10n ** 30n) * 10000n / 10n ** 30n;
  return Number(whole) + Number(frac) / 10000;
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://arb1.arbitrum.io/rpc";

  const client = createPublicClient({
    chain: arbitrum,
    transport: http(rpcUrl),
  });

  console.log("Fetching GM token prices...");

  const [marketsRes, tickersRes, tokensRes] = await Promise.all([
    fetch(`${ORACLE_URL}/markets`).then((r) => r.json()) as Promise<{
      markets: OracleMarket[];
    }>,
    fetch(`${ORACLE_URL}/prices/tickers`).then((r) => r.json()) as Promise<Ticker[]>,
    fetch(`${ORACLE_URL}/tokens`).then((r) => r.json()) as Promise<{
      tokens: Array<{ address: string; symbol: string; decimals: number }>;
    }>,
  ]);

  const tickers: Record<string, Ticker> = {};
  for (const t of tickersRes) {
    tickers[t.tokenAddress.toLowerCase()] = t;
  }

  const tokenMeta: Record<string, { symbol: string; decimals: number }> = {};
  for (const t of tokensRes.tokens) {
    tokenMeta[t.address.toLowerCase()] = { symbol: t.symbol, decimals: t.decimals };
  }

  const markets = marketsRes.markets.filter((m) =>
    TARGET_ADDRESSES.has(m.marketToken.toLowerCase())
  );

  if (markets.length === 0) {
    throw new Error("No target markets found in GMX API");
  }

  const results = await Promise.all(
    markets.map(async (m) => {
      const indexP = tickers[m.indexToken.toLowerCase()];
      const longP = tickers[m.longToken.toLowerCase()];
      const shortP = tickers[m.shortToken.toLowerCase()];

      if (!indexP || !longP || !shortP) {
        throw new Error(`Missing oracle prices for market ${m.marketToken}`);
      }

      const [gmPrice, poolInfo] = await client.readContract({
        address: READER,
        abi: readerAbi,
        functionName: "getMarketTokenPrice",
        args: [
          DATA_STORE,
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

      const idx = tokenMeta[m.indexToken.toLowerCase()];
      const lng = tokenMeta[m.longToken.toLowerCase()];
      const sht = tokenMeta[m.shortToken.toLowerCase()];
      const name = `${idx?.symbol || "?"}/USD [${lng?.symbol || "?"}-${sht?.symbol || "?"}]`;

      return {
        address: m.marketToken,
        name,
        price: bigintToUsd(gmPrice),
        poolValue: bigintToUsd(poolInfo.poolValue),
      };
    })
  );

  const now = new Date().toISOString();

  // Build JSON
  const jsonData: Record<string, any> = { updated: now, markets: {} };
  for (const r of results) {
    jsonData.markets[r.address] = {
      name: r.name,
      price: r.price,
      poolValue: r.poolValue,
    };
  }

  // Build CSV
  const csvLines = ["market,price"];
  for (const r of results) {
    csvLines.push(`${r.name},${r.price}`);
  }

  // Write to dist/
  mkdirSync("dist", { recursive: true });
  writeFileSync("dist/prices.json", JSON.stringify(jsonData, null, 2) + "\n");
  writeFileSync("dist/prices.csv", csvLines.join("\n") + "\n");

  console.log("Written dist/prices.json and dist/prices.csv");
  console.log(JSON.stringify(jsonData, null, 2));
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
