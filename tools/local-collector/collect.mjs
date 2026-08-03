#!/usr/bin/env node
// Operator-run collector. It reads a public timeline through an X client you already own and
// pushes the result to a radar deployment's ingest endpoint.
//
// It lives outside the services on purpose: the machine that talks to X is usually a personal
// one, and its session must not be copied onto a server. The deployment never holds X credentials
// and never scrapes; it only accepts posts that satisfy the observed-post contract.
//
//   X_COLLECT_COMMAND   command that prints the timeline as JSON (default: twitter)
//   X_COLLECT_ARGS      comma-separated argv template; {handle} and {limit} are substituted
//                       (default: user-posts,{handle},-n,{limit},--json)
//   X_TARGET_HANDLE     handle to read, without @
//   X_TARGET_USER_ID    numeric id; posts from any other author are dropped
//   X_COLLECT_LIMIT     posts per run (default 20)
//   RADAR_INGEST_URL    e.g. https://example.com/api/ingest/posts
//   RADAR_INGEST_TOKEN  bearer token configured on the deployment
//   RADAR_DRY_RUN=true  print the payload instead of sending it

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const command = process.env.X_COLLECT_COMMAND ?? "twitter";
const argsTemplate = (
  process.env.X_COLLECT_ARGS ?? "user-posts,{handle},-n,{limit},--json"
).split(",");
const handle = required("X_TARGET_HANDLE").replace(/^@/, "");
const targetUserId = required("X_TARGET_USER_ID");
const limit = String(Number(process.env.X_COLLECT_LIMIT ?? 20));
const dryRun = process.env.RADAR_DRY_RUN === "true";

const args = argsTemplate.map((part) =>
  part.replaceAll("{handle}", handle).replaceAll("{limit}", limit),
);
const { stdout } = await execFileAsync(command, args, {
  maxBuffer: 32 * 1024 * 1024,
  windowsHide: true,
});
const observedAt = new Date().toISOString();
const posts = extractItems(JSON.parse(stdout))
  .filter((item) => !item.isRetweet && String(item?.author?.id ?? "") === targetUserId)
  .map((item) => toObservedPost(item, observedAt));

if (dryRun) {
  console.log(JSON.stringify({ posts }, null, 2));
  process.exit(0);
}

const response = await fetch(required("RADAR_INGEST_URL"), {
  method: "POST",
  headers: {
    authorization: `Bearer ${required("RADAR_INGEST_TOKEN")}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ posts }),
});
const body = await response.text();
if (!response.ok) {
  console.error(`ingest failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  process.exit(1);
}
console.log(`collected ${posts.length} posts -> ${body}`);

function extractItems(payload) {
  const items = Array.isArray(payload) ? payload : (payload?.data ?? payload?.tweets ?? []);
  if (!Array.isArray(items)) throw new Error("collector output has no array of posts");
  return items;
}

function toObservedPost(item, observedAt) {
  const text = String(item.text ?? "");
  const screenName = item?.author?.screenName ?? handle;
  const quoted = item?.quotedTweet?.id ? [String(item.quotedTweet.id)] : [];
  return {
    postId: String(item.id),
    authorId: String(item.author.id),
    authorDisplayName: item.author.name ?? null,
    authorHandle: screenName,
    authorAvatarUrl: item.author.profileImageUrl ?? null,
    sourceKind: quoted.length > 0 ? "quote" : "post",
    conversationId: null,
    referencedPostIds: quoted,
    language: item.lang ?? null,
    sourceUrl: `https://x.com/${screenName}/status/${item.id}`,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    createdAt: new Date(item.createdAtISO ?? item.createdAt).toISOString(),
    observedAt,
    editedAt: null,
    deletedAt: null,
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}
