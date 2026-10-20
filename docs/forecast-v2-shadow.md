# Forecast V2 影子策略

> 本文从 README 迁出，内容为英文原文。V2 只做影子运行，不影响公开页面和 `GET /api/forecast`。回到 [README](../README.md)。

V2 is deliberately isolated from `GET /api/forecast` and the page. It generates 28 contiguous
six-hour survival buckets and stores both the point-in-time feature snapshot and result in
`forecast_feature_snapshots` / `shadow_forecast_runs`. The current public model is
`cadence-activity-circadian-v1`: it starts from a fixed cadence table centered on the observed
roughly 3.6-day mean Reset interval, then adjusts for Tibo's rolling 24-hour post and reply count
relative to the prior 14 complete days and for a fixed daily-routine factor on the
`America/Los_Angeles` clock. Reposts are excluded, incomplete activity history applies no activity
adjustment, text wording never changes probability, and no random value is used. Every V2
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
