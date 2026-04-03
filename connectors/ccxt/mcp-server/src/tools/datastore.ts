import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ExchangeClient } from '../client/exchange';
import { registerDatastoreIngestTools } from './datastore-ingest';
import { registerDatastoreAnalysisTools } from './datastore-analysis';
import { registerDatastoreJournalTools } from './datastore-journal';

export function registerDatastoreTools(server: McpServer, client: ExchangeClient) {
  registerDatastoreIngestTools(server, client);
  registerDatastoreAnalysisTools(server, client);
  registerDatastoreJournalTools(server, client);
}
