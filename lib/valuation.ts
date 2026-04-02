/**
 * Valuation models for trading skills.
 *
 * Models are classified by asset class:
 *   [CRYPTO]   — Designed for crypto assets (tokens, L1s, DeFi protocols)
 *   [EQUITIES] — Traditional equity valuation (stocks, ETFs)
 *   [UNIVERSAL] — Works for any asset class
 */

// ══════════════════════════════════════════════════════════════
//  UNIVERSAL — Works for any asset class
// ══════════════════════════════════════════════════════════════

/**
 * [UNIVERSAL] Discounted cash flow: present value of future cash flows.
 * Works for any asset producing cash flows (equities, fee-generating protocols, etc.)
 * @param cashFlows - projected future cash flows per period
 * @param discountRate - per-period discount rate (decimal, e.g., 0.10 for 10%)
 * @param terminalGrowth - perpetuity growth rate for terminal value (decimal)
 * @returns present value of all cash flows + terminal value
 */
export function dcf(cashFlows: number[], discountRate: number, terminalGrowth: number = 0.02): number {
  if (cashFlows.length === 0 || discountRate <= terminalGrowth) return 0;

  let pv = 0;
  for (let i = 0; i < cashFlows.length; i++) {
    pv += cashFlows[i] / (1 + discountRate) ** (i + 1);
  }

  // Terminal value (Gordon Growth Model) discounted back
  const terminalCF = cashFlows[cashFlows.length - 1] * (1 + terminalGrowth);
  const terminalValue = terminalCF / (discountRate - terminalGrowth);
  pv += terminalValue / (1 + discountRate) ** cashFlows.length;

  return pv;
}

/**
 * [UNIVERSAL] Margin of safety: how much below fair value the current price is.
 * Positive → undervalued, negative → overvalued.
 * @returns margin as decimal (e.g., 0.25 = 25% margin of safety)
 */
export function marginOfSafety(fairValue: number, marketPrice: number): number {
  if (fairValue === 0) return 0;
  return (fairValue - marketPrice) / fairValue;
}

// ══════════════════════════════════════════════════════════════
//  CRYPTO — Designed for crypto assets
// ══════════════════════════════════════════════════════════════

/**
 * [CRYPTO] Network Value to Transactions (NVT) ratio.
 * Crypto's P/E equivalent — measures if network value is justified by on-chain activity.
 * High NVT → overvalued (price outpacing usage), Low NVT → undervalued.
 * @param networkValue - market cap or fully diluted valuation
 * @param dailyTransactionVolume - on-chain transaction volume (USD) per day
 */
export function nvtRatio(networkValue: number, dailyTransactionVolume: number): number {
  if (dailyTransactionVolume === 0) return Infinity;
  return networkValue / (dailyTransactionVolume * 365);
}

/**
 * [CRYPTO] Market Value to Realized Value (MVRV) ratio.
 * Compares market cap to realized cap (sum of each UTXO at its last-moved price).
 * MVRV > 3.5 → historically overheated, MVRV < 1 → historically undervalued.
 * @param marketCap - current market cap
 * @param realizedCap - realized capitalization
 */
export function mvrvRatio(marketCap: number, realizedCap: number): number {
  if (realizedCap === 0) return Infinity;
  return marketCap / realizedCap;
}

/**
 * [CRYPTO] Stock-to-Flow ratio.
 * Models scarcity: higher S2F → scarcer → higher expected value.
 * Used by PlanB for BTC valuation.
 * @param currentSupply - circulating supply
 * @param annualProduction - new tokens produced per year (issuance)
 */
export function stockToFlow(currentSupply: number, annualProduction: number): number {
  if (annualProduction === 0) return Infinity;
  return currentSupply / annualProduction;
}

/**
 * [CRYPTO] Stock-to-Flow model price.
 * PlanB's regression: ln(price) = 3.21 * ln(S2F) + 14.6
 * @param s2fRatio - stock-to-flow ratio
 * @returns model price prediction
 */
export function stockToFlowPrice(s2fRatio: number): number {
  if (s2fRatio <= 0) return 0;
  return Math.exp(3.21 * Math.log(s2fRatio) + 14.6);
}

/**
 * [CRYPTO] Protocol revenue valuation (Price-to-Fees / P/F ratio).
 * For fee-generating DeFi protocols. Lower → cheaper relative to revenue.
 * @param fullyDilutedValuation - FDV of the protocol token
 * @param annualizedFees - total fees earned by the protocol (annualized)
 */
export function priceToFeesRatio(fullyDilutedValuation: number, annualizedFees: number): number {
  if (annualizedFees === 0) return Infinity;
  return fullyDilutedValuation / annualizedFees;
}

/**
 * [CRYPTO] Token terminal value from fee capture.
 * Values a protocol based on its fee revenue and a P/F multiple.
 * @param annualizedFees - protocol's annualized fee revenue
 * @param multiple - comparable P/F multiple (e.g., 20-50 for growth DeFi, 10-20 for mature)
 * @param tokenShareOfFees - fraction of fees accruing to token holders (0-1)
 */
export function feeBasedValuation(
  annualizedFees: number,
  multiple: number,
  tokenShareOfFees: number = 1
): number {
  return annualizedFees * tokenShareOfFees * multiple;
}

/**
 * [CRYPTO] Metcalfe's Law valuation.
 * Network value proportional to n^2 (or n * log(n) variant).
 * @param activeAddresses - daily active addresses (or users)
 * @param coefficient - scaling coefficient (calibrated from historical data)
 * @param exponent - network effect exponent (2 for classic Metcalfe, 1.5 for conservative)
 */
export function metcalfeValuation(
  activeAddresses: number,
  coefficient: number,
  exponent: number = 2
): number {
  if (activeAddresses <= 0) return 0;
  return coefficient * activeAddresses ** exponent;
}

/**
 * [CRYPTO] Thermocap multiple.
 * Ratio of market cap to cumulative miner/validator revenue.
 * Historically >32 signals BTC cycle top, <8 signals bottom.
 * @param marketCap - current market cap
 * @param cumulativeSecuritySpend - total ever paid to miners/validators
 */
export function thermocapMultiple(marketCap: number, cumulativeSecuritySpend: number): number {
  if (cumulativeSecuritySpend === 0) return Infinity;
  return marketCap / cumulativeSecuritySpend;
}

/**
 * [CRYPTO] TVL-based valuation ratio (Market Cap / TVL).
 * For DeFi protocols. Lower → cheaper relative to locked capital.
 * MC/TVL < 1 → potentially undervalued, > 10 → speculative premium.
 * @param marketCap - token market cap
 * @param tvl - total value locked in protocol
 */
export function mcapToTvl(marketCap: number, tvl: number): number {
  if (tvl === 0) return Infinity;
  return marketCap / tvl;
}

// ══════════════════════════════════════════════════════════════
//  EQUITIES — Traditional equity valuation
// ══════════════════════════════════════════════════════════════

/**
 * [EQUITIES] Multi-stage DCF intrinsic value.
 * Projects FCF growth at a high rate, then transitions to terminal growth.
 * @param fcf - current free cash flow
 * @param highGrowthRate - initial growth rate (e.g., 0.15 for 15%)
 * @param discountRate - WACC or required return (e.g., 0.10)
 * @param terminalMultiple - exit EV/FCF multiple (e.g., 15)
 * @param highGrowthYears - years of high growth before terminal (e.g., 5)
 */
export function intrinsicValue(
  fcf: number,
  highGrowthRate: number,
  discountRate: number,
  terminalMultiple: number,
  highGrowthYears: number = 5
): number {
  if (discountRate <= 0) return 0;

  let pv = 0;
  let projectedFCF = fcf;

  for (let i = 1; i <= highGrowthYears; i++) {
    projectedFCF *= (1 + highGrowthRate);
    pv += projectedFCF / (1 + discountRate) ** i;
  }

  const terminalValue = projectedFCF * terminalMultiple;
  pv += terminalValue / (1 + discountRate) ** highGrowthYears;

  return pv;
}

/**
 * [EQUITIES] Graham Number: conservative intrinsic value.
 * sqrt(22.5 * EPS * BVPS). Assumes P/E ≤ 15 and P/B ≤ 1.5.
 * Returns 0 if either input is negative (no meaningful value).
 */
export function grahamNumber(earningsPerShare: number, bookValuePerShare: number): number {
  if (earningsPerShare <= 0 || bookValuePerShare <= 0) return 0;
  return Math.sqrt(22.5 * earningsPerShare * bookValuePerShare);
}

/**
 * [EQUITIES] Owner earnings (Buffett's preferred FCF measure).
 * Net income + depreciation - maintenance capex - working capital changes.
 */
export function ownerEarnings(
  netIncome: number,
  depreciation: number,
  capex: number,
  workingCapitalChange: number
): number {
  return netIncome + depreciation - capex - workingCapitalChange;
}

/**
 * [EQUITIES] Weighted Average Cost of Capital.
 * @param equityWeight - equity / (equity + debt)
 * @param costOfEquity - required return on equity
 * @param debtWeight - debt / (equity + debt)
 * @param costOfDebt - interest rate on debt
 * @param taxRate - corporate tax rate
 */
export function wacc(
  equityWeight: number,
  costOfEquity: number,
  debtWeight: number,
  costOfDebt: number,
  taxRate: number
): number {
  return equityWeight * costOfEquity + debtWeight * costOfDebt * (1 - taxRate);
}

/**
 * [EQUITIES] Capital Asset Pricing Model: cost of equity.
 * r_e = r_f + β × (r_m - r_f)
 */
export function capm(riskFreeRate: number, assetBeta: number, marketReturn: number): number {
  return riskFreeRate + assetBeta * (marketReturn - riskFreeRate);
}

/**
 * [EQUITIES] PEG ratio: P/E divided by earnings growth rate.
 * PEG < 1 → potentially undervalued, PEG > 2 → expensive for growth.
 * @param peRatio - price-to-earnings ratio
 * @param earningsGrowthRate - annual EPS growth rate as percentage (e.g., 15 for 15%)
 */
export function pegRatio(peRatio: number, earningsGrowthRate: number): number {
  if (earningsGrowthRate === 0) return Infinity;
  return peRatio / earningsGrowthRate;
}

/**
 * [EQUITIES] Free cash flow yield.
 * @param freeCashFlow - annual FCF
 * @param marketCap - market capitalization
 */
export function fcfYield(freeCashFlow: number, marketCap: number): number {
  if (marketCap === 0) return 0;
  return freeCashFlow / marketCap;
}

/**
 * [EQUITIES] Enterprise Value to EBITDA ratio.
 */
export function evToEbitda(enterpriseValue: number, ebitda: number): number {
  if (ebitda === 0) return Infinity;
  return enterpriseValue / ebitda;
}
