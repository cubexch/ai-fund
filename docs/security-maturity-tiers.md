# Security Maturity Tiers

Concrete operational guidance for securing your AI Fund desk at three levels. Start at Bronze and work up as your deployment matures.

---

## Bronze — Getting Started (Paper Trading)

**Goal:** Safe exploration with no real money at risk.

### Requirements

- [ ] All exchanges in paper/sandbox mode
- [ ] No production API keys stored anywhere
- [ ] `APCA_PAPER=true` for Alpaca
- [ ] CCXT sandbox mode enabled (`--sandbox` flag)
- [ ] Cube staging environment only
- [ ] Risk Manager agent hired before any trading agents
- [ ] `.env` and credential files in `.gitignore`

### Connector Checklist

| Connector | Action |
|-----------|--------|
| Cube | Use staging endpoint; device-login only (no API keys) |
| CCXT | Pass `--sandbox` flag; verify with `npx tsx src/cli/status.ts` |
| Alpaca | Set `APCA_PAPER=true`; use paper API keys from Alpaca dashboard |

### Hardening

- Run `npx ai-fund diagnose` to verify environment
- Never commit `.desk/` contents or credentials
- Use the default risk parameters (no overrides)

---

## Silver — Production Paper + Staging Live

**Goal:** Real exchange connections with guardrails. Small position sizes, automated risk limits.

### Requirements

All Bronze requirements, plus:

- [ ] API keys use subaccounts with limited permissions
- [ ] Read-only keys for market data; separate trade keys with withdrawal disabled
- [ ] Risk Manager sets explicit limits: max position size, max drawdown, max daily loss
- [ ] `.desk/risk.json` has populated parameters
- [ ] Order confirmation enabled (no `--yes` flag in automation)
- [ ] Credential store uses file-system permissions (not env vars in scripts)
- [ ] Regular credential rotation (at least quarterly)

### Connector Checklist

| Connector | Action |
|-----------|--------|
| Cube | Production device-login; Ed25519 keypair stored in credential store |
| CCXT | Subaccount API keys; withdrawal disabled; IP allowlist on exchange |
| Alpaca | Separate paper and live API keys; paper for testing, live for small positions |

### Hardening

- Set `max_position_pct: 2` in risk parameters (2% of portfolio per position)
- Set `max_drawdown: 0.05` (5% max drawdown before halting)
- Review `.desk/orders.json` daily
- Run `/health-report` before each trading session
- Enable IP allowlisting on all exchange accounts
- Use separate machines/containers for paper vs. production

---

## Gold — Production Live Trading

**Goal:** Full production with defense-in-depth. Suitable for meaningful capital.

### Requirements

All Silver requirements, plus:

- [ ] Hardware security module (HSM) or secure enclave for signing keys where supported
- [ ] All API keys on subaccounts with minimum necessary permissions
- [ ] Withdrawal addresses allowlisted on exchange side
- [ ] IP allowlist enforced on all exchange API keys
- [ ] Automated monitoring: PnL alerts, drawdown alerts, anomaly detection
- [ ] Credential rotation automated (monthly)
- [ ] Audit log enabled: all order submissions logged with timestamps
- [ ] Separate read-only API key for monitoring dashboards
- [ ] Network segmentation: trading bot on isolated network/VPC
- [ ] Rate limiting configured per-connector to prevent accidental API abuse

### Connector Checklist

| Connector | Action |
|-----------|--------|
| Cube | Ed25519 keypair in HSM; device-login with hardware 2FA; subaccount isolation |
| CCXT | Per-exchange subaccount; IP allowlist; withdrawal disabled; rate limiter tuned |
| Alpaca | Live API key on dedicated subaccount; paper key on separate subaccount |

### Hardening

- Run `/review` weekly to audit agent performance
- Set `max_daily_loss` in risk parameters
- Enable trade journaling (`get_trade_journal` tool)
- Back up `.desk/` state to encrypted storage
- Monitor exchange API key usage logs for unauthorized access
- Set up alerting for: rejected orders, position limit breaches, unusual trading volume
- Document incident response procedure for compromised credentials

---

## Quick Reference

| Control | Bronze | Silver | Gold |
|---------|--------|--------|------|
| Paper mode | Required | Default | Optional |
| Risk Manager | Hired | Hired + limits set | Hired + automated alerts |
| API key scope | None (paper) | Subaccount, no withdrawal | Subaccount, IP-locked |
| Credential storage | Env vars OK | File-system permissions | HSM/secure enclave |
| Rotation | Not needed | Quarterly | Monthly (automated) |
| IP allowlist | Not needed | Recommended | Required |
| Order confirmation | Default | Required | Required + audit log |
| Monitoring | Manual | Daily review | Automated alerts |

---

## Migration Path

**Bronze → Silver:**
1. Create subaccount on each exchange
2. Generate restricted API keys (trade only, no withdrawal)
3. Set risk parameters with `/hire risk-manager`
4. Switch one connector to production; keep others on paper
5. Run for 2 weeks with small positions before expanding

**Silver → Gold:**
1. Set up IP allowlisting on all exchange accounts
2. Move signing keys to HSM or secure credential store
3. Automate credential rotation
4. Set up PnL monitoring and alerting
5. Document and test incident response
6. Run for 1 month at Silver limits before increasing position sizes
