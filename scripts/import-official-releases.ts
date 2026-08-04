import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";

import { SqliteWorkerRepository } from "../apps/worker/src/repository.js";
import { ExternalEventSchema } from "../packages/contracts/dist/index.js";
import { migrate, RadarDatabase } from "../packages/db/dist/index.js";

loadLocalEnv();
const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: pnpm external:import-releases -- <events.json>");
const raw: unknown = JSON.parse(await readFile(path.resolve(inputPath), "utf8"));
const events = ExternalEventSchema.array().parse(Array.isArray(raw) ? raw : [raw]);
if (events.some((event) => event.sourceType !== "official_release")) {
  throw new Error("Release import accepts only sourceType=official_release");
}

const db = new RadarDatabase({ file: process.env.RADAR_DB_PATH ?? path.resolve("data/radar.db") });
try {
  await migrate(db, path.resolve("db/migrations"));
  await new SqliteWorkerRepository(db).upsertExternalEvents(events);
  console.log(
    JSON.stringify({ imported: events.length, eventIds: events.map((event) => event.eventId) }),
  );
} finally {
  await db.close();
}

function loadLocalEnv(): void {
  try {
    loadEnvFile(path.resolve(".env"));
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
}
