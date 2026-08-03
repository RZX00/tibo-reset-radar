import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = ["apps", "packages", "config", "fixtures", "docs"];
const commercialSurfaceRoots = [path.join("apps", "web"), path.join("apps", "api")];
const forbidden = [
  /stripe/i,
  /checkout/i,
  /subscription/i,
  /paid api/i,
  /api[_ -]?key management/i,
  /webhook endpoint management/i,
];
const secretPatterns = [
  /(?:sk|xoxb|ghp)_[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", "dist", "coverage", "output", ".cache"].includes(entry.name)) {
      continue;
    }
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...(await filesUnder(file)));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

const findings: string[] = [];
for (const root of roots) {
  for (const file of await filesUnder(root)) {
    if (/\.(?:png|jpg|jpeg|webp|woff2?)$/i.test(file)) continue;
    const text = await readFile(file, "utf8");
    const patterns = commercialSurfaceRoots.some((surface) => file.startsWith(surface))
      ? [...forbidden, ...secretPatterns]
      : secretPatterns;
    for (const pattern of patterns) {
      if (pattern.test(text)) findings.push(`${file}: ${pattern}`);
    }
  }
}

const targetConfig = JSON.parse(await readFile(path.join("config", "target.json"), "utf8")) as {
  mode?: unknown;
  target?: { userId?: unknown };
};
if (
  targetConfig.mode !== "demo" ||
  !String(targetConfig.target?.userId ?? "").startsWith("demo-")
) {
  findings.push("config/target.json: public source must remain in explicit demo mode");
}

if (findings.length) {
  throw new Error(`OSS surface scan failed:\n${findings.join("\n")}`);
}
console.log("OSS surface scan passed");
