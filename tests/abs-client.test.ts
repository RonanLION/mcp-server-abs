import { readFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbsClient, truncateCsv } from '../src/abs-client.js';

const fixtureRoot = new URL('./fixtures/', import.meta.url);
const dataflows = await readFile(new URL('dataflows.json', fixtureRoot), 'utf8');
const structure = await readFile(new URL('structure.json', fixtureRoot), 'utf8');
const codelist = await readFile(new URL('codelist.json', fixtureRoot), 'utf8');
const queryCsv = await readFile(new URL('query.csv', fixtureRoot), 'utf8');

describe('AbsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: AbsClient;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dataflow/ABS/all/latest')) {
        expect(url).toContain('detail=allcompletestubs');
        return jsonResponse(dataflows);
      }
      if (url.includes('/dataflow/ABS/ALC/latest')) return jsonResponse(structure);
      if (url.includes('/codelist/ABS/CL_ALC_TYP/latest')) return jsonResponse(codelist);
      if (url.includes('/data/'))
        return new Response(queryCsv, { headers: { 'content-type': 'text/csv' } });
      return new Response('not found', { status: 404 });
    });
    client = new AbsClient({
      cacheTtlMs: 60_000,
      fetchImpl: fetchMock as typeof fetch,
      retryCount: 0,
    });
  });

  it('searches and caches dataflows', async () => {
    const first = await client.searchDataflows('price', 10, 0);
    const second = await client.searchDataflows('price', 10, 0);

    expect(first).toEqual({
      items: [
        {
          agencyId: 'ABS',
          description: 'Quarterly consumer price indexes for Australia.',
          id: 'CPI',
          name: 'Consumer Price Index',
          version: '1.1.0',
        },
      ],
      nextOffset: null,
      offset: 0,
      query: 'price',
      total: 1,
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('searches dataflow descriptions', async () => {
    const result = await client.searchDataflows('quarterly', 10, 0);

    expect(result.items.map(({ id }) => id)).toEqual(['CPI']);
  });

  it('returns dimensions in their SDMX key order', async () => {
    const result = await client.getDataflowStructure('ALC');

    expect(result.dimensions.map(({ id }) => id)).toEqual(['MEASURE', 'ALCOHOL_TYPE']);
    expect(result.timeDimensions.map(({ id }) => id)).toEqual(['TIME_PERIOD']);
    expect(result.dimensions[1]?.codelist).toEqual({
      agencyId: 'ABS',
      id: 'CL_ALC_TYP',
      version: '1.0.0',
    });
  });

  it('filters and pages codelist codes', async () => {
    const result = await client.getCodelist('CL_ALC_TYP', 'i', 1, 0);

    expect(result.codes).toEqual([{ description: 'Wine products.', id: '2', name: 'Wine' }]);
    expect(result.total).toBe(2);
    expect(result.nextOffset).toBe(1);
  });

  it('bounds the metadata cache and evicts the least recently used entry', async () => {
    const boundedClient = new AbsClient({
      cacheMaxEntries: 1,
      cacheTtlMs: 60_000,
      fetchImpl: fetchMock as typeof fetch,
      retryCount: 0,
    });

    await boundedClient.searchDataflows();
    await boundedClient.getCodelist('CL_ALC_TYP');
    await boundedClient.searchDataflows();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('builds encoded queries and truncates CSV by data row', async () => {
    const result = await client.queryData({
      agencyId: 'ABS',
      dataKey: '1.1+2.A',
      dataflowId: 'ALC',
      detail: 'full',
      dimensionAtObservation: 'AllDimensions',
      format: 'csv_with_labels',
      lastNObservations: 3,
      maxOutputChars: 100_000,
      maxRows: 2,
      version: 'latest',
    });

    expect(result.url).toContain('/rest/data/ABS%2CALC/1.1%2B2.A');
    expect(result.url).toContain('lastNObservations=3');
    expect(result.rowsReturned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.body).not.toContain('2010');
  });

  it('canonicalizes an all-wildcard key before URL parsing can normalize dot segments', async () => {
    const result = await client.queryData({
      agencyId: 'ABS',
      dataKey: '....',
      dataflowId: 'ALC',
      detail: 'full',
      dimensionAtObservation: 'AllDimensions',
      format: 'csv',
      lastNObservations: 1,
      maxOutputChars: 100_000,
      maxRows: 2,
      version: 'latest',
    });

    expect(result.url).toContain('/rest/data/ABS%2CALC/all?');
  });

  it('rejects the ABS upstream plain-CSV and updatedAfter failure mode', async () => {
    await expect(
      client.queryData({
        agencyId: 'ABS',
        dataKey: '1.2.1.4.A',
        dataflowId: 'ALC',
        detail: 'full',
        dimensionAtObservation: 'AllDimensions',
        format: 'csv',
        maxOutputChars: 100_000,
        maxRows: 2,
        updatedAfter: '2026-01-01T00:00:00Z',
        version: 'latest',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_COMBINATION' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects responses over the configured byte limit', async () => {
    const smallClient = new AbsClient({
      fetchImpl: vi.fn(
        async () =>
          new Response('123456', {
            headers: { 'content-length': '6', 'content-type': 'text/csv' },
          }),
      ) as typeof fetch,
      maxResponseBytes: 5,
      retryCount: 0,
    });

    await expect(
      smallClient.queryData({
        agencyId: 'ABS',
        dataKey: '1.2.1.4.A',
        dataflowId: 'ALC',
        detail: 'full',
        dimensionAtObservation: 'AllDimensions',
        format: 'csv',
        maxOutputChars: 10_000,
        maxRows: 10,
        version: 'latest',
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});

describe('truncateCsv', () => {
  it('does not treat newlines inside quoted fields as rows', () => {
    const csv = 'id,note\n1,"line one\nline two"\n2,plain\n';
    const result = truncateCsv(csv, 1, 1_000);

    expect(result.rows).toBe(1);
    expect(result.body).toContain('line two');
    expect(result.body).not.toContain('2,plain');
    expect(result.truncated).toBe(true);
  });
});

function jsonResponse(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'application/vnd.sdmx.structure+json;version=1.0' },
  });
}
