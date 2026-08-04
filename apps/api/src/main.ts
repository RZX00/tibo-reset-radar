import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { migrate, RadarDatabase } from "@tibo-radar/db";
import { startWorkerLoop } from "@tibo-radar/worker";

import { SqliteRadarIngestStore } from "./ingest.js";
import { buildServer } from "./server.js";
import { registerStaticSite } from "./static-site.js";
import { SqliteRadarReadStore } from "./store.js";

export async function startApi() {
  loadRepositoryEnv();
  const db = new RadarDatabase({ file: databasePath() });
  await migrate(db, migrationsDir());
  const ingestToken = process.env.RADAR_INGEST_TOKEN ?? "";
  const app = buildServer({
    store: new SqliteRadarReadStore({
      db,
      serviceVersion: process.env.npm_package_version ?? "0.1.0",
      demoMode: process.env.DEMO_MODE !== "false",
    }),
    // No token configured means no write surface exists at all, not an unguarded one.
    ...(ingestToken
      ? { ingest: { store: new SqliteRadarIngestStore(db), token: ingestToken } }
      : {}),
    logger: true,
  });

  const siteRoot = process.env.RADAR_SITE_ROOT ?? defaultSiteRoot();
  registerStaticSite(app, siteRoot);

  // One container: the collector loop lives in this process too, unless an operator splits it out.
  const worker =
    process.env.RADAR_RUN_WORKER === "false"
      ? null
      : startWorkerLoop({
          db,
          onError: (error) => app.log.error(error),
          onRetention: (report) => app.log.info({ retention: report }, "pruned old snapshots"),
        });

  app.addHook("onClose", async () => {
    await worker?.stop();
    await db.close();
  });
  await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 8787) });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close();
    });
  }
  return app;
}

function databasePath(): string {
  return process.env.RADAR_DB_PATH ?? path.resolve("data/radar.db");
}

function migrationsDir(): string {
  return (
    process.env.RADAR_MIGRATIONS_DIR ??
    path.resolve(fileURLToPath(new URL("../../../db/migrations", import.meta.url)))
  );
}

function defaultSiteRoot(): string {
  return path.resolve(fileURLToPath(new URL("../../../", import.meta.url)), "apps/web/dist");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startApi();
}
