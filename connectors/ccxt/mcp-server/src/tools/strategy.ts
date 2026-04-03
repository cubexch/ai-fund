import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ExchangeClient } from '../client/exchange';
import { registerStrategyAnalysisTools } from './strategy-analysis';
import { registerStrategyPortfolioTools } from './strategy-portfolio';
import { registerStrategyEntryTools } from './strategy-entry';
import { registerStrategyInfoTools } from './strategy-info';

export function registerStrategyTools(server: McpServer, client: ExchangeClient) {
  registerStrategyAnalysisTools(server, client);
  registerStrategyPortfolioTools(server, client);
  registerStrategyEntryTools(server, client);
  registerStrategyInfoTools(server, client);
}
