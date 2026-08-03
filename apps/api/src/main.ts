import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import { PostgresRadarIngestStore } from "./ingest.js";
import { buildServer } from "./server.js";
import { PostgresRadarReadStore } from "./store.js";

export async function startApi() {
  loadRepositoryEnv();
  const databaseUrl = requiredEnv("DATABASE_URL");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const ingestToken = process.env.RADAR_INGEST_TOKEN ?? "";
  const app = buildServer({
    store: new PostgresRadarReadStore({
      pool,
      serviceVersion: process.env.npm_package_version ?? "0.1.0",
      demoMode: process.env.DEMO_MODE !== "false",
    }),
    // No token configured means no write surface exists at all, not an unguarded one.
    ...(ingestToken
      ? { ingest: { store: new PostgresRadarIngestStore(pool), token: ingestToken } }
      : {}),
    logger: true,
  });
  app.addHook("onClose", async () => pool.end());
  await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 3001) });
  return app;
}

function loadRepositoryEnv(): void {
  try {
    loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startApi();
}
