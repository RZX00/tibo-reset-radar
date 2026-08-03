import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const migrationsDir = path.resolve("db/migrations");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const statusOnly = process.argv.includes("--status");

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS radar_schema_migrations (
      version text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const applied = await pool.query<{ version: string; checksum: string | null }>(
    "SELECT version, checksum FROM radar_schema_migrations ORDER BY version",
  );
  const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row.checksum]));

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = appliedByVersion.get(file);
    if (existing && existing !== checksum) {
      throw new Error(`Migration checksum drift detected for ${file}.`);
    }
    if (existing) continue;
    if (statusOnly) {
      console.log(`pending ${file}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO radar_schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum",
        [file, checksum],
      );
      await client.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  if (statusOnly && files.every((file) => appliedByVersion.has(file))) {
    console.log("database schema is current");
  }
} finally {
  await pool.end();
}
