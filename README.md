# Tibo Reset Radar

An open-source weather radar for public Tibo activity and the next Reset window.

```ascii
X official API -> signal extraction -> 28 rolling forecast buckets -> weather UI
```

The forecast never uses `100%`. A confirmed Reset is a separate, evidence-backed state.

## Quick Start

Requirements: Node.js 22, pnpm 10.4, Docker, and Docker Compose.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d --build
```

Open `http://127.0.0.1:4173`. The checked-in target and page are visibly marked as Demo data.

For process-level development, start PostgreSQL with Compose, then run `pnpm db:migrate`,
`pnpm dev:api`, `pnpm dev:worker`, and `pnpm dev:web` in separate terminals. Entrypoints load the
ignored root `.env` automatically.

## Going live

`config/target.json` stays in demo mode in this repository; CI fails if it does not. The live
identity lives in [`config/target.live.example.json`](config/target.live.example.json): the tracked
account is the public X account that announces the resets (`@thsottiaux`, numeric ID
`1953337039510003712`), and the authoritative accounts that can confirm one are that account plus
`@OpenAI`, `@OpenAIDevs`, and `@embirico`. `banked_reset` stays `forecast_only` on purpose — a
banked reset raises the forecast but must not claim that anyone's limit has already been restored.

A deployment mounts its own target file, so switching modes is host state rather than a rebuild:

```bash
cp config/target.live.example.json deploy/target.live.json   # untracked on the host
# deploy/.env.production
RADAR_TARGET_CONFIG_FILE=./target.live.json
DEMO_MODE=false
X_BEARER_TOKEN=...        # required by the live collector
LLM_BASE_URL=...          # optional; without it, extraction uses the deterministic fallback
LLM_API_KEY=...
LLM_MODEL=...
```

Credentials belong only in the ignored environment file. Both the target mode and `DEMO_MODE` are
deliberate, separate switches: the first decides where posts come from, the second decides whether
the page still labels itself as demonstration data.

## Verification

```bash
pnpm check
pnpm test:integration
pnpm model:backtest
```

The integration test uses PostgreSQL and proves collect -> edit/delete -> extract -> forecast ->
API/PNG. The backtest only evaluates forecast windows whose full 168-hour horizon has elapsed.

## Operations

Tagged releases publish immutable node and web images to GHCR. Production deployment and rollback
use `deploy/compose.production.yml`, `deploy/deploy.sh`, and `deploy/rollback.sh`; `latest` and
`main` image tags are rejected.

The Chinese-first architecture, model card, data policy, verification evidence, and runbook are in
[`docs/2026-08-03-architecture-model-and-operations.zh.html`](docs/2026-08-03-architecture-model-and-operations.zh.html).

## Boundaries

- Official X API only; no scraping or browser automation.
- No login, payment, subscription, email, paid API key, or webhook surface.
- No dependency on the ewo monorepo, database, runtime, or credentials.
- No real X history or secrets in Git.

## License

Apache-2.0. Open-source experiment by ewo.
