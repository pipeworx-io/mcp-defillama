interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * DefiLlama MCP — DeFi analytics from DefiLlama (free, no auth)
 *
 * Tools:
 * - defi_tvl_protocols: list/search protocols by TVL
 * - defi_protocol_detail: detailed TVL history for a protocol
 * - defi_chain_tvl: TVL breakdown by blockchain
 * - defi_protocol_fees: fee/revenue data for a protocol
 * - defi_stablecoins: stablecoin market data
 * - defi_yields: DeFi yield pool opportunities
 */


const BASE = 'https://api.llama.fi';
const STABLECOINS = 'https://stablecoins.llama.fi';
const YIELDS = 'https://yields.llama.fi';

const tools: McpToolExport['tools'] = [
  {
    name: 'defi_tvl_protocols',
    description:
      'Get TVL (Total Value Locked) for all DeFi protocols, optionally filtered by name or category. Returns protocol name, TVL, chain, and category.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: {
          type: 'string',
          description: 'Filter protocols by name (case-insensitive substring match)',
        },
        category: {
          type: 'string',
          description:
            'Filter by category (e.g., "DEXes", "Lending", "Bridge", "CDP", "Yield")',
        },
      },
    },
  },
  {
    name: 'defi_protocol_detail',
    description:
      'Get detailed TVL history, chain breakdowns, and token info for a specific DeFi protocol.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        protocol: {
          type: 'string',
          description:
            'Protocol slug (e.g., "aave", "uniswap", "lido", "makerdao")',
        },
      },
      required: ['protocol'],
    },
  },
  {
    name: 'defi_chain_tvl',
    description:
      'Get TVL (Total Value Locked) for each blockchain. No parameters needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'defi_protocol_fees',
    description:
      'Get fee or revenue data for a DeFi protocol. Returns daily fee/revenue figures.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        protocol: {
          type: 'string',
          description: 'Protocol slug (e.g., "aave", "uniswap", "lido")',
        },
        data_type: {
          type: 'string',
          description:
            'Type of data: "dailyFees" or "dailyRevenue" (default: "dailyFees")',
        },
      },
      required: ['protocol'],
    },
  },
  {
    name: 'defi_stablecoins',
    description:
      'Get stablecoin market data including market cap and chain distribution. No parameters needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'defi_yields',
    description:
      'Get DeFi yield pool opportunities with APY, TVL, and project info. Optionally filter by project name, minimum TVL, or minimum APY.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: {
          type: 'string',
          description: 'Filter by project name (case-insensitive substring match)',
        },
        min_tvl: {
          type: 'number',
          description: 'Minimum TVL in USD (e.g., 1000000 for $1M)',
        },
        min_apy: {
          type: 'number',
          description: 'Minimum APY percentage (e.g., 5 for 5%)',
        },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'defi_tvl_protocols':
      return getTvlProtocols(args.search as string | undefined, args.category as string | undefined);
    case 'defi_protocol_detail':
      return getProtocolDetail(args.protocol as string);
    case 'defi_chain_tvl':
      return getChainTvl();
    case 'defi_protocol_fees':
      return getProtocolFees(args.protocol as string, (args.data_type as string) ?? 'dailyFees');
    case 'defi_stablecoins':
      return getStablecoins();
    case 'defi_yields':
      return getYields(
        args.search as string | undefined,
        args.min_tvl as number | undefined,
        args.min_apy as number | undefined,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

async function getTvlProtocols(search?: string, category?: string) {
  const res = await fetch(`${BASE}/protocols`);
  if (!res.ok) throw new Error(`DefiLlama API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    name: string;
    slug: string;
    tvl: number;
    chain: string;
    chains: string[];
    category: string;
    symbol?: string;
    change_1h?: number;
    change_1d?: number;
    change_7d?: number;
  }[];

  let filtered = data;

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((p) => p.name.toLowerCase().includes(q));
  }

  if (category) {
    const cat = category.toLowerCase();
    filtered = filtered.filter((p) => p.category?.toLowerCase() === cat);
  }

  // Return top 50 by TVL
  filtered.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  const top = filtered.slice(0, 50);

  return {
    total_matched: filtered.length,
    showing: top.length,
    protocols: top.map((p) => ({
      name: p.name,
      slug: p.slug,
      tvl: p.tvl,
      chain: p.chain,
      chains: p.chains,
      category: p.category,
      symbol: p.symbol ?? null,
      change_1d_pct: p.change_1d ?? null,
      change_7d_pct: p.change_7d ?? null,
    })),
  };
}

async function getProtocolDetail(protocol: string) {
  const res = await fetch(`${BASE}/protocol/${encodeURIComponent(protocol)}`);
  if (!res.ok) throw new Error(`DefiLlama API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    name: string;
    slug: string;
    description?: string;
    url?: string;
    symbol?: string;
    chain?: string;
    chains?: string[];
    category?: string;
    chainTvls?: Record<string, { tvl: { date: number; totalLiquidityUSD: number }[] }>;
    tvl?: { date: number; totalLiquidityUSD: number }[] | number;
    currentChainTvls?: Record<string, number>;
    mcap?: number;
  };

  // Get the last 30 TVL data points from the main tvl array
  const tvlHistory = Array.isArray(data.tvl)
    ? data.tvl.slice(-30).map((entry) => ({
        date: new Date(entry.date * 1000).toISOString().split('T')[0],
        tvl: entry.totalLiquidityUSD,
      }))
    : [];

  return {
    name: data.name,
    slug: data.slug,
    description: data.description ?? null,
    url: data.url ?? null,
    symbol: data.symbol ?? null,
    category: data.category ?? null,
    chain: data.chain ?? null,
    chains: data.chains ?? [],
    current_tvl: typeof data.tvl === 'number' ? data.tvl : null,
    mcap: data.mcap ?? null,
    chain_tvls: data.currentChainTvls ?? {},
    tvl_history_last_30: tvlHistory,
  };
}

async function getChainTvl() {
  const res = await fetch(`${BASE}/v2/chains`);
  if (!res.ok) throw new Error(`DefiLlama API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    gecko_id?: string;
    tvl: number;
    tokenSymbol?: string;
    cmcId?: string;
    name: string;
    chainId?: number;
  }[];

  data.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));

  return {
    total_chains: data.length,
    chains: data.map((c) => ({
      name: c.name,
      tvl: c.tvl,
      token_symbol: c.tokenSymbol ?? null,
      gecko_id: c.gecko_id ?? null,
    })),
  };
}

async function getProtocolFees(protocol: string, dataType: string) {
  const validTypes = ['dailyFees', 'dailyRevenue'];
  if (!validTypes.includes(dataType)) {
    throw new Error(`Invalid data_type: "${dataType}". Must be one of: ${validTypes.join(', ')}`);
  }

  const res = await fetch(
    `${BASE}/summary/fees/${encodeURIComponent(protocol)}?dataType=${encodeURIComponent(dataType)}`,
  );
  if (!res.ok) throw new Error(`DefiLlama API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    name?: string;
    total24h?: number;
    total48hto24h?: number;
    total7d?: number;
    total30d?: number;
    totalAllTime?: number;
    totalDataChart?: [number, number][];
    totalDataChartBreakdown?: unknown;
  };

  // Get last 30 daily entries from the chart data
  const dailyData = (data.totalDataChart ?? []).slice(-30).map(([ts, val]: [number, number]) => ({
    date: new Date(ts * 1000).toISOString().split('T')[0],
    value: val,
  }));

  return {
    protocol,
    data_type: dataType,
    name: data.name ?? protocol,
    total_24h: data.total24h ?? null,
    total_48h_to_24h: data.total48hto24h ?? null,
    total_7d: data.total7d ?? null,
    total_30d: data.total30d ?? null,
    total_all_time: data.totalAllTime ?? null,
    daily_chart_last_30: dailyData,
  };
}

async function getStablecoins() {
  const res = await fetch(`${STABLECOINS}/stablecoins?includePrices=true`);
  if (!res.ok) throw new Error(`DefiLlama API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    peggedAssets: {
      id: string;
      name: string;
      symbol: string;
      gecko_id?: string;
      pegType?: string;
      pegMechanism?: string;
      circulating?: Record<string, { peggedUSD?: number }>;
      price?: number;
      chains?: string[];
    }[];
  };

  const assets = (data.peggedAssets ?? [])
    .map((s) => {
      const totalMcap = s.circulating?.peggedUSD
        ? (s.circulating as unknown as { peggedUSD: number }).peggedUSD
        : null;
      return {
        name: s.name,
        symbol: s.symbol,
        peg_type: s.pegType ?? null,
        peg_mechanism: s.pegMechanism ?? null,
        price: s.price ?? null,
        circulating_mcap: totalMcap,
        chains: s.chains ?? [],
      };
    })
    .sort((a, b) => (b.circulating_mcap ?? 0) - (a.circulating_mcap ?? 0))
    .slice(0, 30);

  return {
    total_stablecoins: data.peggedAssets?.length ?? 0,
    showing: assets.length,
    stablecoins: assets,
  };
}

async function getYields(search?: string, minTvl?: number, minApy?: number) {
  const res = await fetch(`${YIELDS}/pools`);
  if (!res.ok) throw new Error(`DefiLlama API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    status: string;
    data: {
      pool: string;
      chain: string;
      project: string;
      symbol: string;
      tvlUsd: number;
      apy: number;
      apyBase?: number;
      apyReward?: number;
      rewardTokens?: string[];
      stablecoin?: boolean;
      ilRisk?: string;
      exposure?: string;
      poolMeta?: string;
    }[];
  };

  let pools = data.data ?? [];

  if (search) {
    const q = search.toLowerCase();
    pools = pools.filter((p) => p.project.toLowerCase().includes(q));
  }

  if (minTvl !== undefined) {
    pools = pools.filter((p) => p.tvlUsd >= minTvl);
  }

  if (minApy !== undefined) {
    pools = pools.filter((p) => p.apy >= minApy);
  }

  // Sort by TVL descending
  pools.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  const top = pools.slice(0, 50);

  return {
    total_matched: pools.length,
    showing: top.length,
    pools: top.map((p) => ({
      pool_id: p.pool,
      project: p.project,
      chain: p.chain,
      symbol: p.symbol,
      tvl_usd: p.tvlUsd,
      apy: p.apy,
      apy_base: p.apyBase ?? null,
      apy_reward: p.apyReward ?? null,
      stablecoin: p.stablecoin ?? false,
      il_risk: p.ilRisk ?? null,
      exposure: p.exposure ?? null,
    })),
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
