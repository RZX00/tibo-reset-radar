import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TargetConfigSchema } from "@tibo-radar/contracts";
import { OpenAICompatibleSignalAdapter } from "@tibo-radar/signal";
import {
  DemoTimelineSource,
  runReconnectingStream,
  XFilteredStreamSource,
  XUserTimelineSource,
} from "@tibo-radar/x-source";
import pg from "pg";

import { createDemoFixtures } from "./demo-fixtures.js";
import { PostgresWorkerRepository } from "./repository.js";
import { DeterministicOnlySignalAdapter, RadarWorker } from "./worker.js";

export const DEFAULT_POLL_INTERVAL_MS = 120_000;

export async function startWorker() {
  loadRepositoryEnv();
  const config = TargetConfigSchema.parse(JSON.parse(await readFile(targetConfigPath(), "utf8")));
  const pool = new pg.Pool({ connectionString: requiredEnv("DATABASE_URL") });
  const repository = new PostgresWorkerRepository(pool);
  const timeline =
    config.mode === "demo"
      ? new DemoTimelineSource(createDemoFixtures(config))
      : new XUserTimelineSource({ bearerToken: requiredEnv("X_BEARER_TOKEN") });
  const signalAdapter =
    process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL
      ? new OpenAICompatibleSignalAdapter({
          baseUrl: process.env.LLM_BASE_URL,
          apiKey: process.env.LLM_API_KEY,
          model: process.env.LLM_MODEL,
          timeoutMs: positiveIntegerEnv("LLM_TIMEOUT_MS", 30_000),
        })
      : new DeterministicOnlySignalAdapter();
  const worker = new RadarWorker({ source: timeline, repository, target: config, signalAdapter });
  const controller = new AbortController();
  for (const event of ["SIGINT", "SIGTERM"] as const) {
    process.once(event, () => controller.abort());
  }

  try {
    if (process.env.WORKER_RUN_ONCE === "true") {
      await worker.runOnce(controller.signal);
      return;
    }

    if (config.mode === "live" && process.env.RADAR_COLLECTOR_MODE === "stream") {
      await worker.runOnce(controller.signal);
      await runReconnectingStream({
        source: new XFilteredStreamSource({ bearerToken: requiredEnv("X_BEARER_TOKEN") }),
        signal: controller.signal,
        onPost: (post) => worker.processStreamPost(post),
        reconcile: () => worker.runOnce(controller.signal),
        onError: (error) => console.error("collector stream error", safeMessage(error)),
      });
    } else {
      const intervalMs = pollIntervalMs();
      while (!controller.signal.aborted) {
        try {
          await worker.runOnce(controller.signal);
        } catch (error) {
          console.error("worker cycle failed", safeMessage(error));
        }
        await abortableDelay(intervalMs, controller.signal);
      }
    }
  } finally {
    await pool.end();
  }
}

function loadRepositoryEnv(): void {
  try {
    loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function targetConfigPath(): string {
  const configured = process.env.TARGET_CONFIG_PATH ?? "config/target.json";
  if (path.isAbsolute(configured)) return configured;
  return path.resolve(fileURLToPath(new URL("../../../", import.meta.url)), configured);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerEnv("POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS, env);
}

function positiveIntegerEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message.slice(0, 300)}`
    : "Unknown worker error";
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startWorker();
}
