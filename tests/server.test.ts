import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AbsClient } from '../src/abs-client.js';
import { createServer } from '../src/server.js';

const dataflowsBody = JSON.stringify({
  data: {
    dataflows: [
      { id: 'ALC', version: '1.0.0', agencyID: 'ABS', name: 'Apparent Consumption of Alcohol' },
    ],
  },
});
const csvBody = 'DATAFLOW,MEASURE,TIME_PERIOD,OBS_VALUE\nABS:ALC(1.0.0),1,2008,0.56\n';

describe('MCP server', () => {
  let mcpClient: Client;
  let server: ReturnType<typeof createServer>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dataflow/ABS/all/latest')) return new Response(dataflowsBody);
      if (url.includes('/data/'))
        return new Response(csvBody, { headers: { 'content-type': 'text/csv' } });
      return new Response('not found', { status: 404 });
    });
    const absClient = new AbsClient({ fetchImpl: fetchMock as typeof fetch, retryCount: 0 });
    server = createServer({ client: absClient });
    mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  afterEach(async () => {
    await mcpClient.close();
    await server.close();
  });

  it('advertises four accurately annotated read-only tools', async () => {
    const result = await mcpClient.listTools();

    expect(result.tools.map(({ name }) => name)).toEqual([
      'search_dataflows',
      'get_dataflow_structure',
      'get_codelist',
      'query_data',
    ]);
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      });
    }
  });

  it('returns structured search output', async () => {
    const result = await mcpClient.callTool({
      name: 'search_dataflows',
      arguments: { query: 'alcohol' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ total: 1, items: [{ id: 'ALC' }] });
  });

  it('blocks an unbounded all-series query before making an HTTP request', async () => {
    const result = await mcpClient.callTool({
      name: 'query_data',
      arguments: { dataflow_id: 'ALC', data_key: 'all' },
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['....', 'all'])(
    'blocks unbounded all-series key %s even when updated_after is supplied',
    async (dataKey) => {
      const result = await mcpClient.callTool({
        name: 'query_data',
        arguments: {
          dataflow_id: 'ALC',
          data_key: dataKey,
          updated_after: '2024-01-01T00:00:00Z',
        },
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('defaults a targeted query to the latest observation', async () => {
    const result = await mcpClient.callTool({
      name: 'query_data',
      arguments: { dataflow_id: 'ALC', data_key: '1.2.1.4.A' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ appliedDefaultLastObservation: true });
    expect(result.structuredContent).not.toHaveProperty('body');
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('0.56') })]),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('lastNObservations=1');
  });

  it('honours explicit opt-in to an unbounded all-series query', async () => {
    const result = await mcpClient.callTool({
      name: 'query_data',
      arguments: { dataflow_id: 'ALC', data_key: 'all', allow_large_query: true },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ appliedDefaultLastObservation: false });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('lastNObservations');
  });

  it('canonicalizes an explicitly allowed all-wildcard key to all', async () => {
    const result = await mcpClient.callTool({
      name: 'query_data',
      arguments: { dataflow_id: 'ALC', data_key: '....', allow_large_query: true },
    });

    expect(result.isError).not.toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/all?');
  });
});
