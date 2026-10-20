# 运维

> 本文从 README 迁出，内容为英文原文。回到 [README](../README.md)。

A tagged release publishes one immutable image to GHCR. Production deployment and rollback use
`deploy/compose.production.yml`, `deploy/deploy.sh`, and `deploy/rollback.sh`; `latest` and `main`
image tags are rejected. Rolling back only changes the image — the SQLite file is untouched.

## Reprocess one missed confirmation

When a post was already extracted under an older confirmation policy, the normal pending queue will
not evaluate it again. After deploying a policy fix, reprocess that stored post explicitly against
the current deterministic rules and target authority configuration:

```bash
pnpm signal:reprocess -- 2086188036493344823
```

Against the SQLite volume in the production container, run the same compiled entrypoint:

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml \
  exec radar node apps/worker/dist/reprocess-main.js 2086188036493344823
```

The command only accepts a numeric X post id, refuses deleted posts or posts whose retained text has
already been removed, and fails without writing when the current rules do not produce a confirmed
Reset or retraction. A successful run upserts the auditable Reset event; the next worker cycle
regenerates the forecast.

## Retention

The worker writes a forecast snapshot every cycle, so the collector prunes hourly instead of
letting the file grow forever. Snapshots inside `RADAR_RETENTION_FULL_HOURS` (6) are kept whole,
the last `RADAR_RETENTION_HOURLY_DAYS` (30) thin to one per hour, and older ones thin to one per
day; delivered inbox rows are dropped after `RADAR_RETENTION_INBOX_DAYS` (7). The newest snapshot —
the one the API serves — is never a deletion candidate, and posts, extractions and reset events are
never pruned at all: they are the evidence.
