import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { TargetConfigSchema } from "@tibo-radar/contracts";
import { migrate, RadarDatabase } from "@tibo-radar/db";

import { SqliteWorkerRepository } from "./repository.js";
import { reprocessStoredConfirmation } from "./reprocess-confirmation.js";

export async function reprocessConfirmationMain(args: readonly string[]): Promise<void> {
  loadLocalEnv();
  const postId = parsePostId(args);
  const targetPath = path.resolve(process.env.TARGET_CONFIG_PATH ?? "config/target.json");
  const target = TargetConfigSchema.parse(JSON.parse(await readFile(targetPath, "utf8")));
  const db = new RadarDatabase({
    file: process.env.RADAR_DB_PATH ?? path.resolve("data/radar.db"),
  });

  try {
    await migrate(db, path.resolve(process.env.RADAR_MIGRATIONS_DIR ?? "db/migrations"));
    const result = await reprocessStoredConfirmation(
      new SqliteWorkerRepository(db),
      target,
      postId,
    );
    console.log(JSON.stringify(result));
  } finally {
    await db.close();
  }
}

export function parsePostId(args: readonly string[]): string {
  const positional = args.filter((argument) => argument !== "--");
  const postId = positional[0];
  if (positional.length !== 1 || !postId || !/^\d+$/.test(postId)) {
    throw new Error("Usage: pnpm signal:reprocess -- <numeric-x-post-id>");
  }
  return postId;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await reprocessConfirmationMain(process.argv.slice(2));
}
