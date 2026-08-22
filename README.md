# MCP Server for Australian Bureau of Statistics data

[![CI](https://github.com/RonanLION/mcp-server-abs/actions/workflows/ci.yml/badge.svg)](https://github.com/RonanLION/mcp-server-abs/actions/workflows/ci.yml)

A maintained, read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for the public [Australian Bureau of Statistics (ABS) Data API](https://www.abs.gov.au/statistics/application-programming-interfaces-apis/data-api-user-guide).

It lets an MCP client discover ABS datasets, inspect SDMX dimension order and codelists, and run bounded statistical-data queries. No ABS API key is required.

> [!IMPORTANT]
> This is an independent community project. It is not operated by or affiliated with the Australian Bureau of Statistics.

## Why this server exists

The original community project [`seansoreilly/mcp-server-abs`](https://github.com/seansoreilly/mcp-server-abs) targets an ABS hostname and route retired in November 2024 and uses a pre-1.0 MCP SDK. This project is a clean-room replacement built against:

- the current `https://data.api.abs.gov.au/rest/` API;
- the stable v2 TypeScript MCP SDK;
- the current SDMX structure and data response shapes.

No source code was copied from the older implementation.

## Tools

| Tool                     | Purpose                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `search_dataflows`       | Search and page through ABS datasets without placing the full catalogue in context.      |
| `get_dataflow_structure` | Return ordered data-key dimensions, separate time dimensions, attributes, and codelists. |
| `get_codelist`           | Search and page through valid codes for a dimension.                                     |
| `query_data`             | Query observations as CSV, labelled CSV, or SDMX-JSON with time, size, and row bounds.   |

All four tools declare `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: true`.

## Requirements

- Node.js 22 or 24
- An MCP client that supports local stdio servers

## Connect from Codex

Install directly from GitHub:

```bash
codex mcp add abs -- npx -y github:RonanLION/mcp-server-abs
```

Because this repository is private, the machine running Codex must already have authenticated Git access to it.

Then start a new Codex session and use `/mcp` to confirm that `abs` exposes four tools. The equivalent configuration is:

```toml
[mcp_servers.abs]
command = "npx"
args = ["-y", "github:RonanLION/mcp-server-abs"]
startup_timeout_sec = 30
tool_timeout_sec = 30
```

Codex stores this in `~/.codex/config.toml`. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp/) for other supported transports and settings.

## Connect from another stdio MCP client

Use this command and argument list:

```json
{
  "mcpServers": {
    "abs": {
      "command": "npx",
      "args": ["-y", "github:RonanLION/mcp-server-abs"]
    }
  }
}
```

For a local checkout instead:

```bash
git clone https://github.com/RonanLION/mcp-server-abs.git
cd mcp-server-abs
npm ci
npm run build
```

Configure the client to run `node /absolute/path/to/mcp-server-abs/dist/index.js`.

## Recommended workflow

1. Call `search_dataflows` with a topic such as `consumer price`.
2. Call `get_dataflow_structure` with the chosen dataflow ID.
3. Call `get_codelist` for each dimension whose valid codes you need.
4. Build the case-sensitive SDMX key in the returned dimension order and call `query_data`.

Example input for the small, stable ALC dataset:

```json
{
  "dataflow_id": "ALC",
  "data_key": "1.2.1.4.A",
  "start_period": "2008",
  "end_period": "2008",
  "format": "csv_with_labels"
}
```

Dimension values are separated by dots, `+` selects multiple codes in one dimension, and a blank position is a wildcard. `TIME_PERIOD` is returned separately and is not part of the data key. The whole key `all` (or a key with every position blank) selects every series.

## Safety and reliability defaults

- Requests are restricted to the fixed HTTPS ABS API origin; redirects are rejected.
- Only HTTP `GET` is used. The server cannot modify ABS data.
- Requests time out before the ABS gateway's 30-second limit.
- Upstream responses are capped below the ABS 10 MB gateway limit.
- Query output is capped by rows and characters before entering model context.
- A targeted query with no time bound defaults to `lastNObservations=1`.
- An unbounded all-series query is refused unless it includes an explicit period/observation bound or `allow_large_query=true`; `updated_after` alone is not treated as a size bound.
- The known-broken ABS combination of `updated_after` with plain `csv` is rejected with guidance to use `csv_with_labels` or `json`.
- Metadata is cached in memory for 15 minutes, up to 128 entries. Observation data is not cached.
- Transient `429`, `502`, `503`, and `504` responses receive one bounded retry.

The ABS Data API remains labelled Beta. ABS states that availability is not guaranteed, the service may change, and API data may lag the ABS website.

## Configuration

Optional environment variables:

| Variable                     |   Default |      Allowed range |
| ---------------------------- | --------: | -----------------: |
| `ABS_MCP_TIMEOUT_MS`         |   `25000` |     `1000`–`29000` |
| `ABS_MCP_MAX_RESPONSE_BYTES` | `8388608` | `65536`–`10485760` |
| `ABS_MCP_CACHE_TTL_MS`       |  `900000` |     `0`–`86400000` |
| `ABS_MCP_CACHE_MAX_ENTRIES`  |     `128` |         `1`–`1000` |

Invalid values are ignored with a message on stderr. The MCP protocol stream remains exclusively on stdout.

## Development

```bash
npm ci
npm run check
npm run test:live
```

`npm run check` runs formatting, lint, type checking, unit/protocol tests, a production build, and a spawned stdio handshake. `npm run test:live` exercises dataflow discovery, schema and codelist parsing, and one small read-only data query against the live ABS API.

To inspect tools manually:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

[MIT](LICENSE)
