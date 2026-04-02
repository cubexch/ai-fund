/**
 * Connector registry — holds all initialized exchange connectors
 * and lets the skill layer look them up by name or asset class.
 */

import type { ExchangeConnector } from './connector-interface.js';

const registry = new Map<string, ExchangeConnector>();

export function register(connector: ExchangeConnector) {
  registry.set(connector.meta.name, connector);
}

export function get(name: string): ExchangeConnector | undefined {
  return registry.get(name);
}

export function list(): ExchangeConnector[] {
  return Array.from(registry.values());
}

export function getByAssetClass(
  assetClass: 'crypto' | 'equities' | 'futures' | 'options' | 'perps',
): ExchangeConnector[] {
  return list().filter(c => c.meta.assetClasses.includes(assetClass));
}
