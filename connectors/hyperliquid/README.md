# Hyperliquid Connector

Status: `beta`

This repo currently treats Hyperliquid as a read-only connector. Market/account reads work. Order placement and cancellation stay disabled until real EIP-712 signing is implemented and verified.

On-chain perpetual futures with non-custodial wallet auth. Direct REST wrapper — no SDK, no MCP dependencies.

## What's Supported

| Feature | Support |
|---|---|
| Perpetual futures | ✅ |
| Spot | ✅ |
| Leverage inspection | ✅ |
| Short selling | ✅ |
| Testnet | ✅ Default |
| Funding rates | ✅ |
| Order placement/cancellation | ❌ Disabled in this repo |
| Options | ❌ |

## Setup

1. Get a Hyperliquid-compatible wallet (MetaMask, Rabby, etc.)
2. Deposit USDC on Hyperliquid (mainnet) or use the [testnet faucet](https://app.hyperliquid-testnet.xyz/drip)
3. Export your wallet private key
4. Run `/setup` in Claude Code and select Hyperliquid — enter wallet address and private key

Credentials are stored in your system keychain (macOS) or `~/.ai-fund/hyperliquid/credentials.json` (0600 permissions).

## Security

Your private key remains local to your machine. The current connector does **not** enable write operations, so no exchange-signed order flow is performed yet. Once EIP-712 support is implemented, signing will continue to happen locally only.

## Testnet vs Mainnet

Testnet is **on by default**. Uses `https://api.hyperliquid-testnet.xyz`.

To trade on mainnet, you must explicitly configure live mode during `/setup`. The current repo still blocks order entry entirely until signing support is completed.

To get testnet funds: visit the [faucet](https://app.hyperliquid-testnet.xyz/drip) (requires a prior mainnet deposit with the same address for 1,000 mock USDC).

## Credentials

Resolved in order:
1. **Shared credential store** — `~/.ai-fund/hyperliquid/` (keychain, libsecret, or file)
2. **Environment variables** — fallback for CI/testing

| Variable | Description |
|---|---|
| `HYPERLIQUID_WALLET_ADDRESS` | Your `0x...` wallet address |
| `HYPERLIQUID_PRIVATE_KEY` | Your `0x...` private key (env fallback) |
| `HYPERLIQUID_TESTNET` | `true` (default) or `false` for mainnet |

## Leverage Warning

Perpetual futures use leverage. Higher leverage means higher liquidation risk. The connector supports `updateLeverage()` but defaults to conservative settings. The Risk Manager agent monitors liquidation prices.

## Not Supported (Yet)

- Full EIP-712 order signing
- Order placement and cancellation through this repo
- WebSocket streaming
- Vault trading
- TWAP orders

## Suggested Agents

```
/hire arthur-hayes
/hire risk-manager
/hire funding-rate-farmer
```
