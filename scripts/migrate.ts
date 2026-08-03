import path from "node:path";
import { loadEnvFile } from "node:process";

import { migrate, RadarDatabase } from "@tibo-radar/db";

loadLocalEnv();
const db = new RadarDatabase({ file: databasePath() });
const statusOnly = process.argv.includes("--status");

try {
  const result = await migrate(db, path.resolve("db/migrations"), { statusOnly });
  for (const file of result.applied) console.log(`applied ${file}`);
  for (const file of result.pending) console.log(`pending ${file}`);
  if (statusOnly && result.pending.length === 0) console.log("database schema is current");
} finally {
  await db.close();
}

function databasePath(): string {
  return process.env.RADAR_DB_PATH ?? path.resolve("data/radar.db");
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
