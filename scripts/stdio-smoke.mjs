import process from 'node:process';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.argv[2] ?? 'dist/index.js'],
  stderr: 'pipe',
});
const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const expected = ['get_codelist', 'get_dataflow_structure', 'query_data', 'search_dataflows'];
  const actual = tools.map(({ name }) => name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tool list: ${actual.join(', ')}`);
  }
  process.stdout.write(`stdio smoke passed (${actual.length} tools)\n`);
} finally {
  await client.close();
}
