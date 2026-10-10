/** 探针：核对本插件的**五处身份位**是否一致（经典脚本 + 双半插件最容易错的地方）。 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"));
const patch = fs.readFileSync(path.join(DIR, "cordis.patch.yml"), "utf8");
const host = fs.readFileSync(path.join(DIR, "lib", "index.js"), "utf8");
const client = fs.readFileSync(path.join(DIR, "lib", "client.js"), "utf8");

const hostName = (host.match(/export const name = "([^"]+)"/) ?? [])[1];
const clientId = (client.match(/id:\s*"([^"]+)",\s*\n\s*factory:/) ?? [])[1];
const patchId = (patch.match(/^\s*- id:\s*(\S+)/m) ?? [])[1];
const patchName = (patch.match(/^\s*name:\s*(\S+)/m) ?? [])[1];

const rows = [
  ["1 package.json  name", pkg.name],
  ["2 cordis.patch  id", patchId],
  ["3 cordis.patch  name", patchName],
  ["4 lib/index.js  name", hostName],
  ["5 lib/client.js id", clientId],
];
for (const [label, v] of rows) console.log(`  ${label.padEnd(24)} = ${JSON.stringify(v)}`);
const same = rows.every(([, v]) => v === pkg.name);
console.log(`\n  五处全同 = ${same}`);
if (!same) process.exit(1);
