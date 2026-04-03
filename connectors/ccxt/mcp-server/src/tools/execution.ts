import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ExchangeClient } from '../client/exchange';
import { registerExecutionAnalyticsTools } from './execution-analytics';
import { registerExecutionMicrostructureTools } from './execution-microstructure';
import { registerExecutionInfraTools } from './execution-infra';

export function registerExecutionTools(server: McpServer, client: ExchangeClient) {
  registerExecutionAnalyticsTools(server, client);
  registerExecutionMicrostructureTools(server, client);
  registerExecutionInfraTools(server, client);
}
