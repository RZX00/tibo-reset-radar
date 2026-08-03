# Tibo Reset Radar

An open-source radar for public Tibo activity and the next Reset window.

```ascii
X timeline -> signal extraction -> 28 rolling forecast buckets -> single-page radar
```

The forecast never uses `100%`. A confirmed Reset is a separate, evidence-backed state.

## Quick Start

Requirements: Node.js 24, pnpm 10.4, Docker, and Docker Compose.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d --build
```

Open `http://127.0.0.1:4173`. The checked-in target and page are visibly marked as Demo data.

One container runs everything: it migrates the schema on boot, serves the API and the built page
from the same origin, and runs the collector loop in-process. State is a single SQLite file
(`/data/radar.db` in the container, `RADAR_DB_PATH` elsewhere) — there is no database server to
run, back up, or scale, which is the right shape for one page reading one public timeline.

For process-level development run `pnpm db:migrate` once, then `pnpm dev:api` and `pnpm dev:web` in
separate terminals; `pnpm dev:worker` is only needed if you set `RADAR_RUN_WORKER=false` and want
the collector separate. Entrypoints load the ignored root `.env` automatically.

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

### Collecting from somewhere else

A deployment does not have to fetch X itself. With `RADAR_COLLECTOR_MODE=inbox` the API exposes one
authenticated write route, `POST /api/ingest/posts`, and the worker drains what lands there through
the same dedup, extraction and forecast path as any other source. The route only exists when
`RADAR_INGEST_TOKEN` is set, and every pushed post must satisfy the observed-post contract.

That keeps the X session on the machine that owns it — usually a personal one — instead of copying
it onto a server. [`tools/local-collector/collect.mjs`](tools/local-collector/collect.mjs) is a
dependency-free reference collector: it runs an X client you already have, keeps only posts whose
author id matches the target, and pushes them.

```bash
X_TARGET_HANDLE=thsottiaux X_TARGET_USER_ID=1953337039510003712 \
RADAR_INGEST_URL=https://example.com/api/ingest/posts RADAR_INGEST_TOKEN=... \
node tools/local-collector/collect.mjs
```

Add `RADAR_DRY_RUN=true` to print the payload instead of sending it. Re-sending the same posts is
harmless; the inbox is keyed by post id.

## Verification

```bash
pnpm check
pnpm test:integration
pnpm model:backtest
```

The integration test runs against a real SQLite database and proves collect -> edit/delete ->
extract -> forecast -> API/PNG, including that pushed history lands regardless of push order. The
backtest only evaluates forecast windows whose full 168-hour horizon has elapsed.

## Operations

A tagged release publishes one immutable image to GHCR. Production deployment and rollback use
`deploy/compose.production.yml`, `deploy/deploy.sh`, and `deploy/rollback.sh`; `latest` and `main`
image tags are rejected. Rolling back only changes the image — the SQLite file is untouched.

The Chinese-first architecture, model card, data policy, verification evidence, and runbook are in
[`docs/2026-08-03-architecture-model-and-operations.zh.html`](docs/2026-08-03-architecture-model-and-operations.zh.html).

## Boundaries

- Official X API only; no scraping or browser automation.
- No login, payment, subscription, email, paid API key, or webhook surface.
- No dependency on the ewo monorepo, database, runtime, or credentials.
- No real X history or secrets in Git.

## License

Apache-2.0. Open-source experiment by ewo.
