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
docker compose up -d postgres
pnpm db:migrate
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

The checked-in target uses Demo mode. Replace `config/target.json` with the public X user ID,
handle, authoritative source IDs, and Reset definition before setting `DEMO_MODE=false`.

## Boundaries

- Official X API only; no scraping or browser automation.
- No login, payment, subscription, email, paid API key, or webhook surface.
- No dependency on the ewo monorepo, database, runtime, or credentials.
- No real X history or secrets in Git.

## License

Apache-2.0. Open-source experiment by ewo.
