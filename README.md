# Tibo Reset Radar

An open-source radar for public Tibo activity and the next Reset window.

```ascii
X timeline -> Reset confirmation + post counts -> cadence-activity-v1 -> public single-page radar
                         \-----> survival-v2 -> shadow snapshots/backtest only
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

## Language

The page ships Chinese and English. A visitor whose browser prefers Chinese lands on the Chinese
page, everyone else on the English one, and the switch in the masthead is remembered per browser.
Every visible string lives in [`apps/web/src/i18n.ts`](apps/web/src/i18n.ts) behind one typed
`Strings` interface, so an untranslated string is a type error rather than a Chinese sentence on the
English page. Dates, weekdays and clock times follow the chosen language; the numbers never change.

## Verification

```bash
pnpm check
pnpm test:integration
pnpm model:backtest
pnpm model:backtest:v2
```

The integration test runs against a real SQLite database and proves collect -> edit/delete ->
extract -> V1/V2 shadow forecast -> API/PNG, including that pushed history lands regardless of push
order. The V1 backtest waits for the full 168-hour horizon; V2 evaluates 24/72/168-hour horizons
independently as each one matures.

## Forecast V2 shadow strategy

V2 is deliberately isolated from `GET /api/forecast` and the page. It generates 28 contiguous
six-hour survival buckets and stores both the point-in-time feature snapshot and result in
`forecast_feature_snapshots` / `shadow_forecast_runs`. The current public model is
`cadence-activity-v1`: it starts from a fixed cadence table centered on the observed roughly
3.6-day mean Reset interval, then adjusts only for Tibo's rolling 24-hour post and reply count
relative to the prior 14 complete days. Reposts are excluded, incomplete activity history applies
no adjustment, text wording never changes probability, and no random value is used. Every V2
result remains shadow-only with `publicImpact: "none"`.

The public status keeps four observed states (`active`, `cooling`, `quiet`, `data_delayed`). When
the collector is fresh, the observed state is `quiet`, and at least 20 non-repost posts exist in
the trailing 30 days, the API also infers the quietest contiguous eight-hour UTC window. The page
labels that window `可能在睡觉`; this is a display-only inference and never sets forecast risk to
zero or changes the cadence/activity probability calculation.

The outcome is narrowly defined as a confirmed primary Reset with scope `all` or `unknown`.
`limited`, plan, region and cohort events do not count, and a later retraction removes the event
through its correction link while leaving both audit records intact. Every feature is computed
as-of the forecast time, so a correction or external event learned later cannot leak into an
earlier snapshot.

V2 currently records these feature families:

- historical reset intervals, quantiles, right-censored exposure and smoothed duration hazards;
- Tibo's own 90-day UTC posting/reply rhythm as a non-zero, normalized circadian multiplier;
- six/24-hour post and reply bursts plus unique conversations, without collecting public replies
  from other users;
- time-decayed reset wording, incidents and milestones from the existing signal extractor;
- optional OpenAI incidents from the public official status feed and operator-imported competitor
  releases that link to an official source.

Until there are at least 20 effective confirmed resets, maturity is
`insufficient_history`. At 20 or more it is still `shadow`: contextual coefficients remain exactly
zero unless a version has been written to `forecast_model_versions` with a backtested status.
Competitor releases therefore cannot change probability merely because they were collected.
Calibration is only representable from 50 effective resets onward. No code path currently trains
or promotes a model automatically.

Enable the unauthenticated official OpenAI status collector explicitly:

```dotenv
FORECAST_V2_OPENAI_STATUS_ENABLED=true
FORECAST_V2_OPENAI_STATUS_TIMEOUT_MS=10000
```

For a competitor release, import an operator-reviewed JSON file; `knownAt` must be when this radar
first learned the event, not a backdated publication timestamp:

```json
[
  {
    "eventId": "anthropic:official-release:example",
    "sourceType": "official_release",
    "provider": "Anthropic",
    "eventType": "model_release",
    "title": "Official release title",
    "sourceUrl": "https://www.anthropic.com/news/example",
    "occurredAt": "2026-08-03T00:00:00.000Z",
    "knownAt": "2026-08-03T00:05:00.000Z",
    "endedAt": null,
    "relevance": 0.8,
    "severity": 0.7,
    "metadata": {}
  }
]
```

```bash
pnpm external:import-releases -- ./official-releases.json
```

Grok and full public-comment collection are intentionally absent. The lower-cost interaction proxy
is Tibo's own reply rate and conversation spread; this is auditable and does not require estimating
the sentiment or pressure of an unbounded audience.

## Operations

A tagged release publishes one immutable image to GHCR. Production deployment and rollback use
`deploy/compose.production.yml`, `deploy/deploy.sh`, and `deploy/rollback.sh`; `latest` and `main`
image tags are rejected. Rolling back only changes the image — the SQLite file is untouched.

### Retention

The worker writes a forecast snapshot every cycle, so the collector prunes hourly instead of
letting the file grow forever. Snapshots inside `RADAR_RETENTION_FULL_HOURS` (6) are kept whole,
the last `RADAR_RETENTION_HOURLY_DAYS` (30) thin to one per hour, and older ones thin to one per
day; delivered inbox rows are dropped after `RADAR_RETENTION_INBOX_DAYS` (7). The newest snapshot —
the one the API serves — is never a deletion candidate, and posts, extractions and reset events are
never pruned at all: they are the evidence.

The Chinese-first architecture, model card, data policy, verification evidence, and runbook are in
[`docs/2026-08-03-architecture-model-and-operations.zh.html`](docs/2026-08-03-architecture-model-and-operations.zh.html).

## Boundaries

- Official X API and optional official status/release sources only; no scraping or browser automation.
- No login, payment, subscription, email, paid API key, or webhook surface.
- No dependency on the ewo monorepo, database, runtime, or credentials.
- No real X history or secrets in Git.

## License

Apache-2.0. Open-source experiment by ewo.
