import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  AbsApiError,
  AbsClient,
  type ComponentSummary,
  type QueryDataResult,
} from './abs-client.js';

export const SERVER_NAME = 'mcp-server-abs';
export const SERVER_VERSION = '0.1.0';

const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
} as const;

const dataflowOutputSchema = z.object({
  agencyId: z.string(),
  description: z.string().optional(),
  id: z.string(),
  name: z.string(),
  version: z.string(),
});

const structureReferenceOutputSchema = z.object({
  agencyId: z.string(),
  id: z.string(),
  version: z.string(),
});

const componentOutputSchema = z.object({
  codelist: structureReferenceOutputSchema.optional(),
  concept: z.string().optional(),
  id: z.string(),
  position: z.number().int().optional(),
  type: z.string(),
});

const periodSchema = z
  .string()
  .regex(
    /^\d{4}(?:-(?:S[12]|Q[1-4]|(?:0[1-9]|1[0-2])|W(?:0[1-9]|[1-4]\d|5[0-3])|(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])))?$/,
    'Use YYYY, YYYY-S1, YYYY-Q1, YYYY-MM, YYYY-W01, or YYYY-MM-DD.',
  );

const queryInputSchema = z
  .object({
    dataflow_id: z.string().min(1).max(160).describe('ABS dataflow ID, such as CPI or ALC.'),
    data_key: z
      .string()
      .min(1)
      .max(5_000)
      .describe(
        'Case-sensitive SDMX key in the dataset dimension order. Use dots between dimensions, + for OR, blank positions as wildcards, or all for every series.',
      ),
    agency_id: z.string().min(1).max(160).default('ABS').describe('Maintaining agency.'),
    version: z
      .string()
      .min(1)
      .max(32)
      .default('latest')
      .describe('Use latest unless a historical structure version is required.'),
    start_period: periodSchema.optional().describe('Inclusive start period.'),
    end_period: periodSchema.optional().describe('Inclusive end period.'),
    first_n_observations: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Return the first N time observations per matching series.'),
    last_n_observations: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Return the last N time observations per matching series.'),
    updated_after: z
      .string()
      .max(64)
      .optional()
      .describe('Return data updated after an ISO 8601 timestamp.'),
    detail: z
      .enum(['full', 'dataonly', 'serieskeysonly', 'nodata'])
      .default('full')
      .describe('SDMX response detail level.'),
    dimension_at_observation: z
      .string()
      .min(1)
      .max(160)
      .default('AllDimensions')
      .describe('AllDimensions returns a flat result; TIME_PERIOD returns time series.'),
    format: z
      .enum(['csv', 'csv_with_labels', 'json'])
      .default('csv_with_labels')
      .describe(
        'CSV with labels is usually easiest for a model to interpret. Use csv_with_labels or json with updated_after.',
      ),
    max_rows: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe('Maximum CSV data rows returned to the MCP client.'),
    max_output_chars: z
      .number()
      .int()
      .min(1_000)
      .max(100_000)
      .default(40_000)
      .describe('Maximum ABS response-body characters returned in text content.'),
    allow_large_query: z
      .boolean()
      .default(false)
      .describe(
        'Required for an unfiltered data_key such as all or an all-wildcard key with no time or observation bound.',
      ),
  })
  .refine(
    ({ first_n_observations, last_n_observations }) =>
      first_n_observations === undefined || last_n_observations === undefined,
    {
      message: 'Choose first_n_observations or last_n_observations, not both.',
      path: ['first_n_observations'],
    },
  );

export interface CreateServerOptions {
  client?: AbsClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const client = options.client ?? createConfiguredClient();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Read-only access to the public Australian Bureau of Statistics Data API. Start with search_dataflows, inspect data-key dimension order with get_dataflow_structure, look up dimension codes with get_codelist, then call query_data. Never include TIME_PERIOD in an SDMX data key and never guess dimension order. query_data applies conservative bounds and may truncate output; narrow the key or time range when that happens.',
    },
  );

  server.registerTool(
    'search_dataflows',
    {
      annotations: readOnlyAnnotations,
      description:
        'Search current ABS dataflows by ID, name, or description. Results are locally filtered and paged so the full catalogue is never placed in model context.',
      inputSchema: z.object({
        query: z.string().max(200).default('').describe('Case-insensitive search text.'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).max(100_000).default(0),
      }),
      outputSchema: z.object({
        items: z.array(dataflowOutputSchema),
        nextOffset: z.number().int().nullable(),
        offset: z.number().int(),
        query: z.string(),
        total: z.number().int(),
      }),
      title: 'Search ABS dataflows',
    },
    async ({ limit, offset, query }) => {
      try {
        const output = await client.searchDataflows(query, limit, offset);
        return success(output);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'get_dataflow_structure',
    {
      annotations: readOnlyAnnotations,
      description:
        'Get a dataflow, its ordered data-key dimensions, separate time dimensions, attributes, and referenced codelist IDs. Call this before constructing a query data key; never include TIME_PERIOD in that key.',
      inputSchema: z.object({
        dataflow_id: z.string().min(1).max(160),
        agency_id: z.string().min(1).max(160).default('ABS'),
        version: z.string().min(1).max(32).default('latest'),
      }),
      outputSchema: z.object({
        agencyId: z.string(),
        attributes: z.array(componentOutputSchema),
        dataflowDescription: z.string().optional(),
        dataflowId: z.string(),
        dataflowName: z.string(),
        dimensions: z.array(componentOutputSchema),
        structureId: z.string(),
        structureName: z.string(),
        timeDimensions: z.array(componentOutputSchema),
        version: z.string(),
      }),
      title: 'Inspect an ABS dataflow',
    },
    async ({ agency_id, dataflow_id, version }) => {
      try {
        const output = await client.getDataflowStructure(dataflow_id, agency_id, version);
        return success(output, structureText(output.dimensions, output));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'get_codelist',
    {
      annotations: readOnlyAnnotations,
      description:
        'Search or page through an ABS codelist referenced by a dataflow dimension. Use returned code IDs when building a query data key.',
      inputSchema: z.object({
        codelist_id: z.string().min(1).max(160),
        query: z.string().max(200).default(''),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).max(1_000_000).default(0),
        agency_id: z.string().min(1).max(160).default('ABS'),
        version: z.string().min(1).max(32).default('latest'),
      }),
      outputSchema: z.object({
        agencyId: z.string(),
        codes: z.array(
          z.object({
            description: z.string().optional(),
            id: z.string(),
            name: z.string(),
            parent: z.string().optional(),
          }),
        ),
        description: z.string().optional(),
        id: z.string(),
        name: z.string(),
        nextOffset: z.number().int().nullable(),
        offset: z.number().int(),
        query: z.string(),
        total: z.number().int(),
        version: z.string(),
      }),
      title: 'Search an ABS codelist',
    },
    async ({ agency_id, codelist_id, limit, offset, query, version }) => {
      try {
        const output = await client.getCodelist(
          codelist_id,
          query,
          limit,
          offset,
          agency_id,
          version,
        );
        return success(output);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'query_data',
    {
      annotations: readOnlyAnnotations,
      description:
        'Query ABS observations with an SDMX data key and optional time filters. With no time or observation bound, the tool defaults to the latest observation per series. Unfiltered all-series requests require explicit opt-in.',
      inputSchema: queryInputSchema,
      outputSchema: z.object({
        appliedDefaultLastObservation: z.boolean(),
        bytesReceived: z.number().int(),
        contentType: z.string(),
        format: z.enum(['csv', 'csv_with_labels', 'json']),
        retrievedAt: z.string(),
        rowsReturned: z.number().int().nullable(),
        truncated: z.boolean(),
        url: z.string(),
      }),
      title: 'Query ABS data',
    },
    async (input) => {
      const hasResultBound =
        input.start_period !== undefined ||
        input.end_period !== undefined ||
        input.first_n_observations !== undefined ||
        input.last_n_observations !== undefined;
      const isUnfilteredSeriesQuery = isAllSeriesKey(input.data_key);
      if (isUnfilteredSeriesQuery && !hasResultBound && !input.allow_large_query) {
        return failure(
          new AbsApiError(
            'An unfiltered all-series query must include a period or observation bound, or set allow_large_query=true. updated_after alone is not a size bound. Inspect the structure and narrow the key first.',
            'QUERY_TOO_BROAD',
          ),
        );
      }

      const appliedDefaultLastObservation =
        !hasResultBound && !(isUnfilteredSeriesQuery && input.allow_large_query);
      try {
        const result = await client.queryData({
          agencyId: input.agency_id,
          dataKey: input.data_key,
          dataflowId: input.dataflow_id,
          detail: input.detail,
          dimensionAtObservation: input.dimension_at_observation,
          ...(input.end_period ? { endPeriod: input.end_period } : {}),
          ...(input.first_n_observations !== undefined
            ? { firstNObservations: input.first_n_observations }
            : {}),
          format: input.format,
          ...(input.last_n_observations !== undefined
            ? { lastNObservations: input.last_n_observations }
            : appliedDefaultLastObservation
              ? { lastNObservations: 1 }
              : {}),
          maxOutputChars: input.max_output_chars,
          maxRows: input.max_rows,
          ...(input.start_period ? { startPeriod: input.start_period } : {}),
          ...(input.updated_after ? { updatedAfter: input.updated_after } : {}),
          version: input.version,
        });
        const output = {
          appliedDefaultLastObservation,
          bytesReceived: result.bytesReceived,
          contentType: result.contentType,
          format: result.format,
          retrievedAt: result.retrievedAt,
          rowsReturned: result.rowsReturned,
          truncated: result.truncated,
          url: result.url,
        };
        return success(output, queryText(result, appliedDefaultLastObservation));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

function createConfiguredClient(): AbsClient {
  return new AbsClient({
    cacheMaxEntries: readIntegerEnvironment('ABS_MCP_CACHE_MAX_ENTRIES', 128, 1, 1_000),
    cacheTtlMs: readIntegerEnvironment('ABS_MCP_CACHE_TTL_MS', 15 * 60 * 1000, 0, 86_400_000),
    maxResponseBytes: readIntegerEnvironment(
      'ABS_MCP_MAX_RESPONSE_BYTES',
      8 * 1024 * 1024,
      64 * 1024,
      10 * 1024 * 1024,
    ),
    timeoutMs: readIntegerEnvironment('ABS_MCP_TIMEOUT_MS', 25_000, 1_000, 29_000),
  });
}

function isAllSeriesKey(dataKey: string): boolean {
  const normalized = dataKey.trim().toLocaleLowerCase('en-AU');
  return normalized === 'all' || /^\.+$/.test(normalized);
}

function readIntegerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    console.error(
      `${name} must be an integer between ${minimum} and ${maximum}; using ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

function success<T extends object>(output: T, text?: string) {
  return {
    content: [{ type: 'text' as const, text: text ?? JSON.stringify(output, null, 2) }],
    structuredContent: { ...output },
  };
}

function failure(error: unknown) {
  const message =
    error instanceof AbsApiError
      ? error.message
      : error instanceof Error
        ? `Unexpected error: ${error.message}`
        : 'Unexpected error while calling the ABS Data API.';
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

function structureText(
  dimensions: ComponentSummary[],
  output: { dataflowId: string; dataflowName: string; version: string },
): string {
  const lines = dimensions.map((dimension) => {
    const codelist = dimension.codelist ? ` — codelist ${dimension.codelist.id}` : '';
    return `${dimension.position ?? '?'}: ${dimension.id} (${dimension.type})${codelist}`;
  });
  return [
    `${output.dataflowId} ${output.version}: ${output.dataflowName}`,
    'Data-key dimension order (TIME_PERIOD excluded):',
    ...lines,
  ].join('\n');
}

function queryText(result: QueryDataResult, appliedDefault: boolean): string {
  const notes = [
    `ABS query: ${result.url}`,
    `Received ${result.bytesReceived} bytes; returned ${result.rowsReturned ?? 'JSON'} row(s); truncated=${result.truncated}.`,
  ];
  if (appliedDefault) notes.push('Safety default applied: lastNObservations=1.');
  notes.push('', result.body);
  return notes.join('\n');
}

export { AbsApiError, AbsClient };
export type {
  AbsClientOptions,
  CodelistCode,
  DataflowStructureResult,
  DataflowSummary,
  GetCodelistResult,
  QueryDataOptions,
  QueryDataResult,
  SearchDataflowsResult,
} from './abs-client.js';
