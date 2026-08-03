import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { RadarDatabase } from "./index.js";

export interface MigrationResult {
  applied: string[];
  pending: string[];
}

/**
 * Applies every unapplied migration file in order. Checksums are stored so an edited migration is
 * an error rather than a silent divergence between what the file says and what the database is.
 */
export async function migrate(
  db: RadarDatabase,
  migrationsDir: string,
  options: { statusOnly?: boolean } = {},
): Promise<MigrationResult> {
  db.exec(`CREATE TABLE IF NOT EXISTS radar_schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const existing = await db.query<{ version: string; checksum: string | null }>(
    "SELECT version, checksum FROM radar_schema_migrations ORDER BY version",
  );
  const appliedByVersion = new Map(existing.rows.map((row) => [row.version, row.checksum]));

  const applied: string[] = [];
  const pending: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const known = appliedByVersion.get(file);
    if (known && known !== checksum) {
      throw new Error(`Migration checksum drift detected for ${file}.`);
    }
    if (known) continue;
    if (options.statusOnly) {
      pending.push(file);
      continue;
    }
    await db.transaction(async () => {
      db.exec(sql);
      await db.query(
        `INSERT INTO radar_schema_migrations (version, checksum) VALUES ($1, $2)
         ON CONFLICT (version) DO UPDATE SET checksum = excluded.checksum`,
        [file, checksum],
      );
    });
    applied.push(file);
  }
  return { applied, pending };
}
