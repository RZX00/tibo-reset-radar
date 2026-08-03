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

Open `http://127.0.0.1:4173`. The checked-in target and page are visibly marked as Demo data. The default collector poll interval is 120 seconds, and the local Compose web port binds to loopback only.
The weather strip maps daily marginal probability to 晴 (0–19%), 晴间多云 (20–39%), 多云 (40–59%), 雷雨观察 (60–79%), and 暴雨预警 (80–99%).

For process-level development, start PostgreSQL with Compose, then run `pnpm db:migrate`,
`pnpm dev:api`, `pnpm dev:worker`, and `pnpm dev:web` in separate terminals. Entrypoints load the
ignored root `.env` automatically.

Before live mode, replace `config/target.json` with the exact public X user ID, handle,
authoritative source IDs, Reset definition, and banked-reset policy. Add X/LLM credentials only to
the ignored environment file, then change both target mode and `DEMO_MODE` deliberately.

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
- Filtered Stream mode depends on externally pre-provisioned X rules; this repository does not manage those rules.
- Polling and stream reconciliation are bounded recovery paths, not a real-time or SLO guarantee; deletion synchronization is not complete.
- No login, payment, subscription, email, paid API key, or webhook surface.
- No dependency on the ewo monorepo, database, runtime, or credentials.
- No real X history or secrets in Git.

## License

Apache-2.0. Open-source experiment by ewo.
