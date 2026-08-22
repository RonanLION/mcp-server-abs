#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createServer } from './server.js';

const handle = serveStdio(() => createServer());

async function shutdown(): Promise<void> {
  await handle.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
