import { readFile } from "node:fs/promises";
import { TargetConfigSchema } from "../packages/contracts/src/index.js";

const target = JSON.parse(await readFile("config/target.json", "utf8")) as unknown;
TargetConfigSchema.parse(target);
console.log("target contract is valid");
