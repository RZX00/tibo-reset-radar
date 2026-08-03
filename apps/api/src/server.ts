import { createHash } from "node:crypto";

import type { ForecastSnapshot } from "@tibo-radar/contracts";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { renderShareCard } from "./share-card.js";
import type { RadarReadStore } from "./store.js";

export interface BuildServerOptions {
  store: RadarReadStore;
  logger?: boolean;
}

export function buildServer(options: BuildServerOptions) {
  const app = Fastify({ logger: options.logger ?? false });
  let shareCardCache: { runId: string; image: Buffer } | null = null;

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } }),
  );
  app.setErrorHandler(async (error, _request, reply) => {
    app.log.error(error);
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The radar service could not complete the request",
      },
    });
  });

  app.get("/api/status", async (request, reply) =>
    sendEtagged(request, reply, await options.store.getStatus()),
  );

  app.get<{ Querystring: { timezone?: string } }>("/api/forecast", async (request, reply) => {
    const timezone = request.query.timezone ?? "UTC";
    if (!isIanaTimezone(timezone)) {
      return reply.code(400).send({
        error: { code: "INVALID_TIMEZONE", message: "timezone must be a valid IANA name" },
      });
    }
    const snapshot = await options.store.getLatestForecast();
    if (!snapshot)
      return reply
        .code(404)
        .send({ error: { code: "NO_FORECAST", message: "No forecast is available yet" } });
    return sendEtagged(request, reply, withTimezone(snapshot, timezone));
  });

  app.get<{ Querystring: { window?: string } }>("/api/events", async (request, reply) => {
    const window = request.query.window ?? "24h";
    const match = /^(\d{1,3})h$/.exec(window);
    const hours = match?.[1] ? Number(match[1]) : Number.NaN;
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      return reply
        .code(400)
        .send({ error: { code: "INVALID_WINDOW", message: "window must be between 1h and 168h" } });
    }
    return sendEtagged(request, reply, { window, items: await options.store.getEvents(hours) });
  });

  app.get("/api/reset-status", async (request, reply) => {
    const event = await options.store.getLatestResetEvent();
    return sendEtagged(request, reply, { state: event?.status ?? "forecasting", event });
  });

  app.get("/api/share-card.png", async (request, reply) => {
    const snapshot = await options.store.getLatestForecast();
    if (!snapshot)
      return reply
        .code(404)
        .send({ error: { code: "NO_FORECAST", message: "No forecast is available yet" } });
    const image =
      shareCardCache?.runId === snapshot.runId ? shareCardCache.image : renderShareCard(snapshot);
    shareCardCache = { runId: snapshot.runId, image };
    const etag = makeEtag(image);
    reply
      .header("etag", etag)
      .header("cache-control", "public, max-age=300, stale-while-revalidate=3600");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.type("image/png").send(image);
  });

  return app;
}

function withTimezone(snapshot: ForecastSnapshot, timezone: string): ForecastSnapshot {
  return { ...snapshot, timezone };
}

function isIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function sendEtagged(request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  const serialized = JSON.stringify(payload);
  const etag = makeEtag(Buffer.from(serialized));
  reply
    .header("etag", etag)
    .header("cache-control", "public, max-age=30, stale-while-revalidate=120");
  if (request.headers["if-none-match"] === etag) return reply.code(304).send();
  return reply.type("application/json; charset=utf-8").send(serialized);
}

function makeEtag(value: Buffer): string {
  return `"${createHash("sha256").update(value).digest("base64url")}"`;
}
