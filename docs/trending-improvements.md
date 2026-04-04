# Repo Improvement Backlog for Discoverability and Adoption

This is a practical list of high-impact improvements that can help this project gain more attention, contributor activity, and social sharing.

## 1) Add short-form proof content in the repo
- Add a `/demo` folder with 3-5 terminal recordings (or GIFs) that show:
  - spinning up an agent desk in under 2 minutes,
  - running a paper trade,
  - risk-manager blocking an unsafe order.
- Add one “copy/paste demo command block” in README that reproduces each recording.

**Why it helps:** Repos that demonstrate visible outcomes quickly are more likely to be starred and shared.

## 2) Publish benchmark-style comparisons
- Add a `docs/benchmarks.md` page that compares:
  - manual trading workflow vs ai-fund workflow,
  - single-exchange bots vs multi-exchange routing,
  - no risk gate vs risk-manager approvals.
- Include reproducible scripts and fixed historical windows.

**Why it helps:** Quantified outcomes increase trust and improve repostability on social media.

## 3) Add one-click cloud/devcontainer onboarding
- Add a first-party devcontainer and GitHub Codespaces quickstart.
- Include a `make demo` or `npm run demo:paper` command that runs end-to-end in a clean environment.

**Why it helps:** Lower setup friction increases first-run success and contributor conversion.

## 4) Introduce “strategy packs” as installable bundles
- Create versioned strategy packs (e.g., momentum, mean-reversion, market-making) with:
  - required skills,
  - recommended connectors,
  - expected telemetry outputs.
- Add an install command and minimal schema validation.

**Why it helps:** Productized presets are easier for creators to review and recommend.

## 5) Add public observability artifacts
- Add optional local dashboard exports (CSV/JSON + chart snapshots) for:
  - PnL,
  - drawdown,
  - hit rate,
  - risk limit breaches.
- Save artifacts under `artifacts/` with deterministic naming.

**Why it helps:** Visual evidence improves credibility and lets users post reproducible results.

## 6) Strengthen contribution ergonomics
- Add issue forms for:
  - new connector requests,
  - new agent proposals,
  - bug reports with log templates.
- Add PR template checkboxes for tests, docs, and safety implications.

**Why it helps:** Better contributor UX raises PR velocity and reduces maintainer review load.

## 7) Expand integration safety tests
- Add a scheduled CI suite that runs paper-mode smoke tests across key connectors.
- Add failure-injection tests (timeouts, stale prices, rejected orders).

**Why it helps:** Reliability is a major trust signal for technical communities.

## 8) Build a “starter challenge” for social sharing
- Add a 7-day paper trading challenge with fixed rules and a leaderboard format.
- Provide a script that validates submissions from exported artifacts.

**Why it helps:** Challenges generate recurring user-generated content and word of mouth.

## 9) Improve docs information architecture
- Add a “Start Here” map that splits users by persona:
  - trader,
  - quant dev,
  - connector developer.
- Add a docs index page with estimated completion time per guide.

**Why it helps:** Better navigation reduces bounce and improves completion of first milestones.

## 10) Add release notes optimized for social and SEO
- Create a changelog format with:
  - headline feature,
  - measurable impact,
  - migration notes,
  - screenshots/terminal output.
- Publish monthly releases with consistent tagging and summaries.

**Why it helps:** Consistent, high-signal releases increase recurring discovery and backlinks.

## 11) Add canonical examples with deterministic outputs
- Add at least 3 end-to-end examples with expected outputs and fixture datasets.
- Ensure examples run identically in CI.

**Why it helps:** Deterministic examples reduce skepticism and improve onboarding confidence.

## 12) Add a transparent security posture page
- Include threat model, credential boundaries, and incident response process.
- Document least-privilege patterns per connector and rotation guidance.

**Why it helps:** Security clarity is critical for any repo touching exchange credentials.

## Suggested execution order
1. Demo assets + one-command paper demo
2. Deterministic examples + benchmark docs
3. CI smoke/failure tests
4. Issue/PR templates + docs IA refresh
5. Strategy packs + challenge framework
6. Monthly release workflow
