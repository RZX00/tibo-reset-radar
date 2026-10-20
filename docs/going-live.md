# 接入真实数据

> 本文从 README 迁出，内容为英文原文。回到 [README](../README.md)。

`config/target.json` stays in demo mode in this repository; CI fails if it does not. The live
identity lives in [`config/target.live.example.json`](../config/target.live.example.json): the tracked
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

## Collecting from somewhere else

A deployment does not have to fetch X itself. With `RADAR_COLLECTOR_MODE=inbox` the API exposes one
authenticated write route, `POST /api/ingest/posts`, and the worker drains what lands there through
the same dedup, extraction and forecast path as any other source. The route only exists when
`RADAR_INGEST_TOKEN` is set, and every pushed post must satisfy the observed-post contract.

That keeps the X session on the machine that owns it — usually a personal one — instead of copying
it onto a server. [`tools/local-collector/collect.mjs`](../tools/local-collector/collect.mjs) is a
dependency-free reference collector: it runs an X client you already have, keeps only posts whose
author id matches the target, and pushes them.

```bash
X_TARGET_HANDLE=thsottiaux X_TARGET_USER_ID=1953337039510003712 \
RADAR_INGEST_URL=https://example.com/api/ingest/posts RADAR_INGEST_TOKEN=... \
node tools/local-collector/collect.mjs
```

Add `RADAR_DRY_RUN=true` to print the payload instead of sending it. Re-sending the same posts is
harmless; the inbox is keyed by post id.
