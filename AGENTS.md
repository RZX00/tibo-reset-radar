# Tibo Reset Radar Agent Contract

```ascii
Owned here
|- apps/web --------------------- single-page public radar
|- apps/api --------------------- public read API and share card
|- apps/worker ------------------ collectors and model jobs
|- packages/* ------------------- portable contracts and domain logic
|- db/migrations ---------------- PostgreSQL schema authority
\- config/target.json ----------- public target semantics, never secrets
```

- Keep this repository independent from ewo. Do not import ewo packages, read its database,
  reuse its session cookies, or add commercial/authentication surfaces.
- Use the official X API only. Keep tokens and LLM credentials in ignored environment files.
- Forecast values are capped below 100%. Only the confirmation engine may produce
  `confirmed_reset`, and it must retain evidence.
- `main` is the only long-lived branch. Task branches use `<type>/<scope>-<description>`.
- Run `pnpm check` before merging. Keep generated output, real X content, logs, and secrets out
  of Git.
