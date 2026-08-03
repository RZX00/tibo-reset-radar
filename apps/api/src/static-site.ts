import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".txt", "text/plain; charset=utf-8"],
]);

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
  [
    "content-security-policy",
    "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
      "base-uri 'self'; form-action 'none'",
  ],
];

/**
 * Serves the built single page from the same process as the API. One process means one origin,
 * so the page's `connect-src 'self'` covers its own API calls with no proxy in between.
 */
export function registerStaticSite(app: FastifyInstance, root: string): void {
  const absoluteRoot = path.resolve(root);

  app.get("/*", async (request, reply) => {
    const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (requested.startsWith("/api/")) return notFound(reply);

    const resolved = resolveWithin(absoluteRoot, requested);
    const file =
      resolved && (await isFile(resolved)) ? resolved : path.join(absoluteRoot, "index.html");
    if (!(await isFile(file))) return notFound(reply);
    return sendFile(request, reply, absoluteRoot, file);
  });
}

async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  root: string,
  file: string,
): Promise<FastifyReply> {
  for (const [header, value] of SECURITY_HEADERS) reply.header(header, value);
  // Vite fingerprints everything under /assets, so those are immutable; the shell never is.
  const immutable = path.relative(root, file).startsWith("assets");
  reply.header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  reply.type(CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? "application/octet-stream");
  if (request.method === "HEAD") return reply.send();
  return reply.send(createReadStream(file));
}

function resolveWithin(root: string, requested: string): string | null {
  const resolved = path.resolve(root, `.${path.posix.normalize(requested)}`);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } });
}
