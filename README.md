# DefiLlama — DeFi Protocol Metrics

DefiLlama is the canonical free dashboard and API for decentralized finance. TVL (total value locked), protocol tokens, yield aggregators, stablecoins, derivatives, lending markets, DEX volumes — across every major chain and protocol. Used by everyone in crypto. Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1745+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

For DeFi research — comparing yields, tracking TVL flows between protocols, analyzing stablecoin issuance, monitoring liquidations — DefiLlama is the source. The data is normalized across chains (Ethereum, Solana, Base, Arbitrum, etc.) so cross-chain comparison is sane. Pair with [Alpha Vantage](/docs/reference/alphavantage) or [Finnhub](/docs/reference/finnhub) for the public-equity intersection (Coinbase, Microstrategy, etc.).

Common flows:

- **Protocol TVL.** "What's Aave's TVL?" → current TVL with history.
- **TVL leaderboard.** "Top 20 DeFi protocols by TVL" → rankings.
- **Yield search.** "Best stablecoin yields right now?" → APY across pools, with volume + risk indicators.
- **Stablecoin supply.** "USDC supply across chains" → issuance + bridge flows.
- **DEX volume.** Trading volumes by exchange or pair.

- **Token unlocks.** "Which token unlocks are scheduled this week?" / "unlocks over $10M between 2026-10-05 and 2026-10-12" → `defi_token_unlocks`: every vesting cliff and emission-rate change across ~370 tokens, with tokens, USD value, share of circulating supply and recipients.
- **One token's vesting schedule.** "Hyperliquid HYPE unlock schedule" → `defi_token_emission`: allocation by category, per-recipient unlocked-now vs final, dated past and upcoming unlocks.

## Token unlock data

`defi_token_unlocks` and `defi_token_emission` read DefiLlama's public unlocks dataset (`defillama-datasets.llama.fi` — the same files https://defillama.com/unlocks renders). The documented API route for this (`api.llama.fi/emissions`) answers `402 Upgrade to the paid API plan`, so these tools do not use it. Every response carries `data_as_of` (the dataset file's Last-Modified time) and `price_as_of`.

- **USD values use the CURRENT price**, not the price on the unlock date. A past unlock's `cliff_usd` is what those tokens are worth now.
- **Not every allocation is scheduled.** Some tokens (Hyperliquid among them) document past unlocks only; the rest of the supply sits in `supply_metrics.tbdAmount` with no published dates, and the response says so instead of returning an empty future.
- **`emission_rate_changes`** are linear-vesting rate changes (tokens per week), which have no single USD amount; `min_usd` filters them out.

## Auth

Free, no auth. DefiLlama is community-supported and welcomes API use; rate limits are gentle.

## What's tracked

| Vertical | Coverage |
|---|---|
| **TVL** | All major DeFi protocols, multi-chain rolled up |
| **Stablecoins** | Issuance per token per chain; bridge flows |
| **Yields** | Lending, LP, vault, restaking yields |
| **DEX** | Volume per exchange, per pair, per chain |
| **Derivatives** | Perpetuals, options venues |
| **Bridges** | Cross-chain transfer volumes |
| **NFTs** | (Limited; better dedicated NFT tools) |

## Common pitfalls

- **TVL ≠ protocol value.** TVL is the dollar amount of assets deposited. Doesn't reflect protocol revenue, token price, or actual usage. A protocol can have $1B TVL and zero users (sleeping idle deposits).
- **Double-counting across chains.** A protocol on Ethereum + Arbitrum has TVL on both. DefiLlama mostly handles this but edge cases (assets bridged-then-deposited) can double-count.
- **Yield decay.** APYs in pools change rapidly. The "current APY" snapshot may not last days. For "expected return" computations, use longer-term averages.
- **Risk isn't priced.** A 100% APY pool isn't free money — it usually reflects high impermanent-loss risk, smart-contract risk, or token-emission inflation. DefiLlama exposes some risk metrics but agents should report them prominently.
- **Stablecoin supply ≠ stable.** "Stablecoin" supply tracks token-level supply. Not all stablecoins are equally stable (USDT, USDC ≈ truly stable; algorithmic stables can deviate). Trust depends on issuer and mechanism.
- **Bridge data is approximate.** Cross-chain flows are tracked via bridge contracts; not every bridge is monitored, and centralized bridges (CEX deposits/withdrawals) are invisible.
- **Token prices vary by source.** DefiLlama has its own price index. May differ slightly from CoinGecko / CoinMarketCap. For high-precision price work, use a dedicated price feed.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "defillama": {
      "url": "https://gateway.pipeworx.io/defillama/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/defillama/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1745+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/defi_tvl_protocols \
  -H 'Content-Type: application/json' \
  -d '{"search":"aave"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/defi_tvl_protocols`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "defillama": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-defillama"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-defillama
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Defillama data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
