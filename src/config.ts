import { type Address } from "viem";
import { arbitrum, avalanche } from "viem/chains";
import type { Chain } from "viem/chains";

export interface NetworkConfig {
  slug: "arbitrum" | "avalanche";
  name: string;
  chain: Chain;
  rpcUrl: string;
  apiUrl: string;
  contracts: {
    dataStore: Address;
    syntheticsReader: Address;
    glvReader: Address;
  };
}

/** Whitelist of reliable asset symbols (index tokens). Meme tokens are excluded. */
export const WHITELISTED_SYMBOLS = new Set([
  // Major L1 / L2
  "BTC", "ETH", "SOL", "AVAX", "BNB", "ADA", "DOT", "ATOM", "NEAR",
  "TRX", "XRP", "XLM", "TON", "SUI", "APT", "SEI", "TIA", "POL",
  "OP", "ARB", "MNT", "S", "STX", "ICP", "HBAR", "KAS", "FIL",
  "ALGO", "BCH", "LTC", "DASH", "ZEC",
  // DeFi / Infrastructure
  "LINK", "AAVE", "UNI", "MKR", "CRV", "CVX", "PENDLE", "GMX",
  "DYDX", "JUP", "JTO", "INJ", "ENA", "ONDO", "MORPHO", "SKY",
  "RENDER", "FET", "TAO", "EIGEN", "ZRO", "AR", "WLD",
  // Gold / wrapped / other established
  "XAUT", "XAUT.v2", "XAUt0", "OKB", "ORDI", "HYPE",
]);

export const NETWORKS: NetworkConfig[] = [
  {
    slug: "arbitrum",
    name: "Arbitrum",
    chain: arbitrum,
    rpcUrl: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
    apiUrl: "https://arbitrum-api.gmxinfra.io",
    contracts: {
      dataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
      syntheticsReader: "0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789",
      glvReader: "0x2C670A23f1E798184647288072e84054938B5497",
    },
  },
  {
    slug: "avalanche",
    name: "Avalanche",
    chain: avalanche,
    rpcUrl:
      process.env.AVALANCHE_RPC_URL ||
      "https://api.avax.network/ext/bc/C/rpc",
    apiUrl: "https://avalanche-api.gmxinfra.io",
    contracts: {
      dataStore: "0x2F0b22339414ADeD7D5F06f9D604c7fF5b2fe3f6",
      syntheticsReader: "0x62Cb8740E6986B29dC671B2EB596676f60590A5B",
      glvReader: "0x5C6905A3002f989E1625910ba1793d40a031f947",
    },
  },
];
