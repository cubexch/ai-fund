# Architecture

Visual reference for how AI Fund is structured, how agents move through their lifecycle, and how trades flow from idea to execution.

All diagrams use [Mermaid](https://mermaid.js.org/) and render natively on GitHub.

---

## System Architecture

The system has two independent layers: **Skills** (what agents think) and **Connectors** (how exchanges are reached). Adding an exchange requires no changes to agent code. Writing an agent requires no changes to exchange code.

```mermaid
flowchart TD
  User[Trader] --> CC[Claude Code]
  CC --> Skills["Skills Layer\n42 Agent Personas"]
  CC --> Connectors["Connector Layer\nMCP Plugins"]
  Skills --> |propose trades| CC
  Connectors --> Cube[Cube Exchange]
  Connectors --> Binance[Binance]
  Connectors --> Kraken[Kraken]
  Connectors --> CCXT["100+ via CCXT"]

  subgraph "Exchange-Agnostic"
    Skills
  end

  subgraph "Exchange-Specific"
    Connectors
  end
```

Skills are `SKILL.md` files: personality, philosophy, strategy, KPIs. Connectors are MCP servers that translate generic tool calls (`place_order`, `get_tickers`) into exchange-specific API requests. The shared `lib/` layer provides technical indicators and financial math used by both.

---

## Agent Lifecycle

Agents are hired, perform work, get reviewed against KPIs, and are either kept or fired. Briefing books in `.desk/briefings/` persist context across sessions so a re-hired agent picks up where it left off.

```mermaid
stateDiagram-v2
  [*] --> Available
  Available --> Hired: /hire
  Hired --> Active: Load SKILL.md + briefing book
  Active --> Active: Analyze, propose, trade
  Active --> Review: /review
  Review --> Active: KPIs met
  Review --> Fired: KPIs missed
  Fired --> Available: Exit briefing saved
  Fired --> [*]
```

Key transitions:

- **/hire** -- Loads the agent's `SKILL.md` and reads its briefing book from `.desk/briefings/<agent>.md`.
- **/review** -- Evaluates all active agents against their declared KPIs (win rate, Sharpe, drawdown, etc.).
- **/fire** -- Writes a final exit summary to the briefing book and deactivates the agent.

---

## Trade Flow

Every trade passes through the Risk Manager before reaching an exchange. No agent can place orders unilaterally. The Risk Manager checks position sizing, portfolio VaR, correlation limits, and exchange-level exposure.

```mermaid
sequenceDiagram
  participant Agent
  participant Risk as Risk Manager
  participant Exec as Execution
  participant Exchange

  Agent->>Risk: Propose trade (instrument, side, size)
  Risk->>Risk: Check sizing, VaR, drawdown limits
  alt Approved
    Risk->>Exec: Approve with constraints
    Exec->>Exchange: Place order (via MCP connector)
    Exchange-->>Exec: Fill confirmation
    Exec-->>Agent: Execution report
    Agent->>Agent: Update briefing book
  else Rejected
    Risk-->>Agent: Blocked (reason: sizing / VaR / correlation)
  end
```

The Execution layer handles order types (TWAP, VWAP, Iceberg) and smart order routing when multiple exchanges are connected.

---

## Multi-Exchange Tool Namespacing

When a single exchange is connected, tools are called directly. When multiple exchanges are connected via MCP, tools are namespaced so agents can target specific venues or scan across all of them.

```mermaid
flowchart LR
  CC[Claude Code] --> Router{How many\nexchanges?}

  Router -->|Single| Direct["Direct calls\nplace_order\nget_tickers"]
  Router -->|Multiple| Namespaced["Namespaced calls"]

  Namespaced --> CubeNS["Cube\nplace_order\nget_positions"]
  Namespaced --> OKXNS["OKX\nspot_place_order\nmarket_get_ticker"]
  Namespaced --> KrakenNS["Kraken\nkraken CLI commands"]
  Namespaced --> CCXTNS["CCXT\nplace_order\nget_ticker"]

  subgraph "Multi-Exchange Capabilities"
    Arb[Arbitrage -- price gaps across venues]
    SOR[Smart Order Routing -- best fill]
    MM[Multi-Venue Market Making]
  end

  Namespaced --> Arb
  Namespaced --> SOR
  Namespaced --> MM
```

More connected exchanges means more strategies become available. Cross-exchange arbitrage, smart order routing, and multi-venue market making all require two or more connectors.

---

## Desk State Persistence

Agent state, trade logs, and risk parameters persist between sessions in the `.desk/` directory. This is gitignored (per-user, per-account state).

```mermaid
flowchart TD
  Session[Claude Code Session] --> State[".desk/state.json\nHired agents, exchange status"]
  Session --> Orders[".desk/orders.json\nTrade log: proposed, submitted, filled, rejected"]
  Session --> RiskFile[".desk/risk.json\nRisk parameters from Risk Manager"]
  Session --> Briefings[".desk/briefings/\nPer-agent compacted summaries"]

  Briefings --> B1["cz.md"]
  Briefings --> B2["jesse-livermore.md"]
  Briefings --> B3["arthur-hayes.md"]
  Briefings --> BN["..."]
```

---

## Contributor Growth Funnel

How new contributors discover, try, and contribute back to the project.

```mermaid
flowchart TD
  A["See PnL screenshot or agent debate artifact"] --> B["Click repo link"]
  B --> C["Run npx demo in under 60s"]
  C --> D["Generate shareable artifacts"]
  D --> E["Share on social + link back"]
  D --> F["Fork + build custom agent"]
  F --> G["Open PR or community submission"]
  G --> H["Featured in agent gallery"]
  H --> A
```

The loop is self-reinforcing: artifacts shared by existing users bring new users to the repo, who generate their own artifacts and contribute agents back.
