import { Buffer } from 'node:buffer';

import * as z from 'zod/v4';

const ABS_BASE_URL = 'https://data.api.abs.gov.au/rest/';
const STRUCTURE_ACCEPT = 'application/vnd.sdmx.structure+json;version=1.0';
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 128;
const DEFAULT_RETRY_COUNT = 1;
const ERROR_BODY_LIMIT = 16 * 1024;

const dataflowSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    agencyID: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    structure: z.string().optional(),
  })
  .loose();

const codelistReferenceSchema = z
  .object({
    enumeration: z.string().optional(),
  })
  .loose();

const componentSchema = z
  .object({
    id: z.string(),
    position: z.number().optional(),
    type: z.string().optional(),
    conceptIdentity: z.string().optional(),
    localRepresentation: codelistReferenceSchema.optional(),
  })
  .loose();

const dataStructureSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    agencyID: z.string(),
    name: z.string().optional(),
    dataStructureComponents: z
      .object({
        dimensionList: z
          .object({
            dimensions: z.array(componentSchema).optional(),
            timeDimensions: z.array(componentSchema).optional(),
          })
          .loose()
          .optional(),
        attributeList: z
          .object({
            attributes: z.array(componentSchema).optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  })
  .loose();

const codelistCodeSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    parent: z.string().optional(),
  })
  .loose();

const codelistSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    agencyID: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    codes: z.array(codelistCodeSchema).optional(),
  })
  .loose();

const dataflowsResponseSchema = z
  .object({
    data: z.object({ dataflows: z.array(dataflowSchema) }).loose(),
  })
  .loose();

const structureResponseSchema = z
  .object({
    data: z
      .object({
        dataflows: z.array(dataflowSchema).optional(),
        dataStructures: z.array(dataStructureSchema).optional(),
      })
      .loose(),
  })
  .loose();

const codelistResponseSchema = z
  .object({
    data: z.object({ codelists: z.array(codelistSchema) }).loose(),
  })
  .loose();

export interface DataflowSummary {
  agencyId: string;
  description?: string;
  id: string;
  name: string;
  version: string;
}

export interface SearchDataflowsResult {
  items: DataflowSummary[];
  nextOffset: number | null;
  offset: number;
  query: string;
  total: number;
}

export interface StructureReference {
  agencyId: string;
  id: string;
  version: string;
}

export interface ComponentSummary {
  codelist?: StructureReference;
  concept?: string;
  id: string;
  position?: number;
  type: string;
}

export interface DataflowStructureResult {
  agencyId: string;
  attributes: ComponentSummary[];
  dataflowDescription?: string;
  dataflowId: string;
  dataflowName: string;
  dimensions: ComponentSummary[];
  structureId: string;
  structureName: string;
  timeDimensions: ComponentSummary[];
  version: string;
}

export interface CodelistCode {
  description?: string;
  id: string;
  name: string;
  parent?: string;
}

export interface GetCodelistResult {
  agencyId: string;
  codes: CodelistCode[];
  description?: string;
  id: string;
  name: string;
  nextOffset: number | null;
  offset: number;
  query: string;
  total: number;
  version: string;
}

export type QueryFormat = 'csv' | 'csv_with_labels' | 'json';
export type QueryDetail = 'full' | 'dataonly' | 'serieskeysonly' | 'nodata';

export interface QueryDataOptions {
  agencyId: string;
  dataKey: string;
  dataflowId: string;
  detail: QueryDetail;
  dimensionAtObservation: string;
  endPeriod?: string;
  firstNObservations?: number;
  format: QueryFormat;
  lastNObservations?: number;
  maxOutputChars: number;
  maxRows: number;
  startPeriod?: string;
  updatedAfter?: string;
  version: string;
}

export interface QueryDataResult {
  body: string;
  bytesReceived: number;
  contentType: string;
  format: QueryFormat;
  retrievedAt: string;
  rowsReturned: number | null;
  truncated: boolean;
  url: string;
}

export interface AbsClientOptions {
  cacheMaxEntries?: number;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  now?: () => number;
  retryCount?: number;
  timeoutMs?: number;
}

interface CachedValue {
  expiresAt: number;
  value: unknown;
}

interface FetchTextResult {
  body: string;
  bytes: number;
  contentType: string;
  url: string;
}

export class AbsApiError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'AbsApiError';
    this.code = code;
    this.status = status;
  }
}

export class AbsClient {
  readonly #cache = new Map<string, CachedValue>();
  readonly #cacheMaxEntries: number;
  readonly #cacheTtlMs: number;
  readonly #fetch: typeof fetch;
  readonly #maxResponseBytes: number;
  readonly #now: () => number;
  readonly #retryCount: number;
  readonly #timeoutMs: number;

  constructor(options: AbsClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    if (!Number.isInteger(this.#cacheMaxEntries) || this.#cacheMaxEntries < 1) {
      throw new RangeError('cacheMaxEntries must be a positive integer.');
    }
    this.#retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
    this.#now = options.now ?? Date.now;
  }

  async searchDataflows(query = '', limit = 20, offset = 0): Promise<SearchDataflowsResult> {
    const url = this.#buildUrl(['dataflow', 'ABS', 'all', 'latest'], {
      detail: 'allcompletestubs',
    });
    const json = await this.#getJson(url, STRUCTURE_ACCEPT, true);
    const parsed = dataflowsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AbsApiError('ABS returned an unexpected dataflow response.', 'INVALID_RESPONSE');
    }

    const normalizedQuery = query.trim().toLocaleLowerCase('en-AU');
    const matches = parsed.data.data.dataflows
      .map(toDataflowSummary)
      .filter((dataflow) => {
        if (!normalizedQuery) return true;
        return [dataflow.id, dataflow.name, dataflow.description ?? ''].some((value) =>
          value.toLocaleLowerCase('en-AU').includes(normalizedQuery),
        );
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'en-AU'));

    const items = matches.slice(offset, offset + limit);
    const nextOffset = offset + items.length < matches.length ? offset + items.length : null;
    return { items, nextOffset, offset, query: query.trim(), total: matches.length };
  }

  async getDataflowStructure(
    dataflowId: string,
    agencyId = 'ABS',
    version = 'latest',
  ): Promise<DataflowStructureResult> {
    assertIdentifier('dataflowId', dataflowId);
    assertIdentifier('agencyId', agencyId);
    assertVersion(version);

    const url = this.#buildUrl(['dataflow', agencyId, dataflowId, version], {
      detail: 'referencepartial',
      references: 'children',
    });
    const json = await this.#getJson(url, STRUCTURE_ACCEPT, true);
    const parsed = structureResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AbsApiError(
        'ABS returned an unexpected data structure response.',
        'INVALID_RESPONSE',
      );
    }

    const dataflow = parsed.data.data.dataflows?.[0];
    const structure = parsed.data.data.dataStructures?.[0];
    if (!dataflow || !structure) {
      throw new AbsApiError(`No data structure was returned for ${dataflowId}.`, 'NOT_FOUND', 404);
    }

    const dimensionList = structure.dataStructureComponents.dimensionList;
    const dimensions = (dimensionList?.dimensions ?? [])
      .map(toComponentSummary)
      .sort(
        (left, right) =>
          (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER),
      );
    const timeDimensions = (dimensionList?.timeDimensions ?? [])
      .map(toComponentSummary)
      .sort(
        (left, right) =>
          (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER),
      );
    const attributes = (structure.dataStructureComponents.attributeList?.attributes ?? []).map(
      toComponentSummary,
    );

    return {
      agencyId: dataflow.agencyID,
      attributes,
      ...(dataflow.description ? { dataflowDescription: dataflow.description } : {}),
      dataflowId: dataflow.id,
      dataflowName: dataflow.name ?? dataflow.id,
      dimensions,
      structureId: structure.id,
      structureName: structure.name ?? structure.id,
      timeDimensions,
      version: dataflow.version,
    };
  }

  async getCodelist(
    id: string,
    query = '',
    limit = 50,
    offset = 0,
    agencyId = 'ABS',
    version = 'latest',
  ): Promise<GetCodelistResult> {
    assertIdentifier('codelistId', id);
    assertIdentifier('agencyId', agencyId);
    assertVersion(version);

    const url = this.#buildUrl(['codelist', agencyId, id, version], { detail: 'full' });
    const json = await this.#getJson(url, STRUCTURE_ACCEPT, true);
    const parsed = codelistResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AbsApiError('ABS returned an unexpected codelist response.', 'INVALID_RESPONSE');
    }

    const codelist =
      parsed.data.data.codelists.find((candidate) => candidate.id === id) ??
      parsed.data.data.codelists[0];
    if (!codelist) {
      throw new AbsApiError(`No codelist was returned for ${id}.`, 'NOT_FOUND', 404);
    }

    const normalizedQuery = query.trim().toLocaleLowerCase('en-AU');
    const matchingCodes = (codelist.codes ?? []).map(toCodelistCode).filter((code) => {
      if (!normalizedQuery) return true;
      return [code.id, code.name, code.description ?? ''].some((value) =>
        value.toLocaleLowerCase('en-AU').includes(normalizedQuery),
      );
    });
    const codes = matchingCodes.slice(offset, offset + limit);
    const nextOffset = offset + codes.length < matchingCodes.length ? offset + codes.length : null;

    return {
      agencyId: codelist.agencyID,
      codes,
      ...(codelist.description ? { description: codelist.description } : {}),
      id: codelist.id,
      name: codelist.name ?? codelist.id,
      nextOffset,
      offset,
      query: query.trim(),
      total: matchingCodes.length,
      version: codelist.version,
    };
  }

  async queryData(options: QueryDataOptions): Promise<QueryDataResult> {
    assertIdentifier('dataflowId', options.dataflowId);
    assertIdentifier('agencyId', options.agencyId);
    assertVersion(options.version);
    assertDataKey(options.dataKey);
    if (options.updatedAfter && options.format === 'csv') {
      throw new AbsApiError(
        'The ABS API currently terminates some plain CSV responses that use updatedAfter. Use csv_with_labels or json for this query.',
        'UNSUPPORTED_COMBINATION',
      );
    }
    const dataKey = /^\.+$/.test(options.dataKey) ? 'all' : options.dataKey;

    const flowReference =
      options.version === 'latest'
        ? `${options.agencyId},${options.dataflowId}`
        : `${options.agencyId},${options.dataflowId},${options.version}`;
    const formatOptions = {
      csv: { accept: 'text/csv', parameter: 'csvfile' },
      csv_with_labels: {
        accept: 'application/vnd.sdmx.data+csv;file=true;labels=both',
        parameter: 'csvfilewithlabels',
      },
      json: { accept: 'application/vnd.sdmx.data+json', parameter: 'jsondata' },
    } as const;
    const selectedFormat = formatOptions[options.format];
    const url = this.#buildUrl(['data', flowReference, dataKey], {
      detail: options.detail,
      dimensionAtObservation: options.dimensionAtObservation,
      ...(options.endPeriod ? { endPeriod: options.endPeriod } : {}),
      ...(options.firstNObservations !== undefined
        ? { firstNObservations: String(options.firstNObservations) }
        : {}),
      format: selectedFormat.parameter,
      ...(options.lastNObservations !== undefined
        ? { lastNObservations: String(options.lastNObservations) }
        : {}),
      ...(options.startPeriod ? { startPeriod: options.startPeriod } : {}),
      ...(options.updatedAfter ? { updatedAfter: options.updatedAfter } : {}),
    });
    const fetched = await this.#fetchText(url, selectedFormat.accept);

    const truncated =
      options.format === 'json'
        ? truncateText(fetched.body, options.maxOutputChars)
        : truncateCsv(fetched.body, options.maxRows, options.maxOutputChars);

    return {
      body: truncated.body,
      bytesReceived: fetched.bytes,
      contentType: fetched.contentType,
      format: options.format,
      retrievedAt: new Date(this.#now()).toISOString(),
      rowsReturned: truncated.rows,
      truncated: truncated.truncated,
      url: fetched.url,
    };
  }

  async #getJson(url: URL, accept: string, cache: boolean): Promise<unknown> {
    const key = `${accept}:${url.href}`;
    const cached = this.#cache.get(key);
    if (cache && cached) {
      if (cached.expiresAt > this.#now()) {
        this.#cache.delete(key);
        this.#cache.set(key, cached);
        return cached.value;
      }
      this.#cache.delete(key);
    }

    const result = await this.#fetchText(url, accept);
    let value: unknown;
    try {
      value = JSON.parse(result.body) as unknown;
    } catch {
      throw new AbsApiError('ABS returned malformed JSON.', 'INVALID_JSON');
    }

    if (cache) {
      const now = this.#now();
      for (const [cachedKey, cachedValue] of this.#cache) {
        if (cachedValue.expiresAt <= now) this.#cache.delete(cachedKey);
      }
      while (this.#cache.size >= this.#cacheMaxEntries) {
        const oldestKey = this.#cache.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        this.#cache.delete(oldestKey);
      }
      this.#cache.set(key, { expiresAt: now + this.#cacheTtlMs, value });
    }
    return value;
  }

  async #fetchText(url: URL, accept: string): Promise<FetchTextResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#retryCount; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(url, {
          headers: {
            Accept: accept,
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': 'mcp-server-abs/0.1.0 (+https://github.com/RonanLION/mcp-server-abs)',
          },
          redirect: 'error',
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorBody = await readResponseBody(response, ERROR_BODY_LIMIT).catch(() => '');
          const message = summarizeHttpError(response.status, errorBody);
          if (attempt < this.#retryCount && isTransientStatus(response.status)) {
            await delay(200 * (attempt + 1));
            continue;
          }
          throw new AbsApiError(message, 'HTTP_ERROR', response.status);
        }

        const body = await readResponseBody(response, this.#maxResponseBytes);
        return {
          body,
          bytes: Buffer.byteLength(body, 'utf8'),
          contentType: response.headers.get('content-type') ?? 'application/octet-stream',
          url: url.href,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof AbsApiError) throw error;
        if (controller.signal.aborted) {
          throw new AbsApiError(
            `ABS did not respond within ${this.#timeoutMs} ms. Narrow the data key or time range.`,
            'TIMEOUT',
          );
        }
        if (attempt < this.#retryCount) {
          await delay(200 * (attempt + 1));
          continue;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new AbsApiError(`Could not reach the ABS Data API: ${detail}`, 'NETWORK_ERROR');
  }

  #buildUrl(pathSegments: string[], parameters: Record<string, string>): URL {
    const encodedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join('/');
    const url = new URL(encodedPath, ABS_BASE_URL);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return url;
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new AbsApiError(
      `ABS response exceeds the ${maxBytes}-byte safety limit. Narrow the query.`,
      'RESPONSE_TOO_LARGE',
    );
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AbsApiError(
        `ABS response exceeds the ${maxBytes}-byte safety limit. Narrow the query.`,
        'RESPONSE_TOO_LARGE',
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function toDataflowSummary(dataflow: z.infer<typeof dataflowSchema>): DataflowSummary {
  return {
    agencyId: dataflow.agencyID,
    ...(dataflow.description ? { description: dataflow.description } : {}),
    id: dataflow.id,
    name: dataflow.name ?? dataflow.id,
    version: dataflow.version,
  };
}

function toComponentSummary(component: z.infer<typeof componentSchema>): ComponentSummary {
  const codelist = parseStructureUrn(component.localRepresentation?.enumeration, 'Codelist');
  return {
    ...(codelist ? { codelist } : {}),
    ...(component.conceptIdentity ? { concept: component.conceptIdentity } : {}),
    id: component.id,
    ...(component.position !== undefined ? { position: component.position } : {}),
    type: component.type ?? 'Attribute',
  };
}

function toCodelistCode(code: z.infer<typeof codelistCodeSchema>): CodelistCode {
  return {
    ...(code.description ? { description: code.description } : {}),
    id: code.id,
    name: code.name ?? code.id,
    ...(code.parent ? { parent: code.parent } : {}),
  };
}

function parseStructureUrn(
  urn: string | undefined,
  structureType: string,
): StructureReference | undefined {
  if (!urn) return undefined;
  const expression = new RegExp(`${structureType}=([^:]+):([^()]+)\\(([^)]+)\\)`);
  const match = expression.exec(urn);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { agencyId: match[1], id: match[2], version: match[3] };
}

function assertIdentifier(name: string, value: string): void {
  if (!/^[A-Za-z0-9_.@-]{1,160}$/.test(value)) {
    throw new AbsApiError(
      `${name} contains unsupported characters or exceeds 160 characters.`,
      'INVALID_ARGUMENT',
    );
  }
}

function assertVersion(version: string): void {
  if (version !== 'latest' && !/^\d+(?:\.\d+){0,2}$/.test(version)) {
    throw new AbsApiError(
      'version must be "latest" or a numeric SDMX version.',
      'INVALID_ARGUMENT',
    );
  }
}

function assertDataKey(dataKey: string): void {
  const hasControlCharacter = [...dataKey].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (!dataKey || dataKey.length > 5_000 || /[/?#]/.test(dataKey) || hasControlCharacter) {
    throw new AbsApiError(
      'dataKey must be 1-5,000 characters and cannot contain slashes, query markers, fragments, or control characters.',
      'INVALID_ARGUMENT',
    );
  }
}

function summarizeHttpError(status: number, body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim().slice(0, 500);
  const suffix = compact ? `: ${compact}` : '';
  if (status === 404) return `ABS returned no matching records${suffix}`;
  if (status === 400 || status === 422) return `ABS rejected the query${suffix}`;
  if (status === 429) return `ABS rate-limited the request${suffix}`;
  return `ABS request failed with HTTP ${status}${suffix}`;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function truncateText(
  body: string,
  maxChars: number,
): {
  body: string;
  rows: null;
  truncated: boolean;
} {
  if (body.length <= maxChars) return { body, rows: null, truncated: false };
  return { body: body.slice(0, maxChars), rows: null, truncated: true };
}

export function truncateCsv(
  body: string,
  maxDataRows: number,
  maxChars: number,
): { body: string; rows: number; truncated: boolean } {
  let inQuotes = false;
  let completedRows = 0;
  let lastSafeEnd = 0;
  let cutoff = body.length;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '"') {
      if (inQuotes && body[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (character !== '\n' || inQuotes) continue;

    completedRows += 1;
    if (index + 1 <= maxChars) lastSafeEnd = index + 1;
    if (completedRows >= maxDataRows + 1 && index + 1 < body.length) {
      cutoff = index + 1;
      break;
    }
    if (index + 1 > maxChars) {
      cutoff = lastSafeEnd || maxChars;
      break;
    }
  }

  if (cutoff === body.length && body.length > maxChars) cutoff = lastSafeEnd || maxChars;
  const resultBody = body.slice(0, cutoff);
  const rowCount = Math.max(0, countCsvRows(resultBody) - 1);
  return { body: resultBody, rows: rowCount, truncated: cutoff < body.length };
}

function countCsvRows(body: string): number {
  if (!body) return 0;
  let inQuotes = false;
  let rows = 1;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '"') {
      if (inQuotes && body[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (character === '\n' && !inQuotes && index + 1 < body.length) {
      rows += 1;
    }
  }
  return rows;
}
