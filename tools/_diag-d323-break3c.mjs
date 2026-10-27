/** _diag-d323-break3c.mjs —— 真跑一次破坏3的副本，看探针到底输出什么。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg3-"));
fs.cpSync(path.join(ROOT, "lib"), path.join(dir, "lib"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "tools", "_probe-d323-f07-split.mjs"), path.join(dir, "tools", "_probe-d323-f07-split.mjs"));

const p = path.join(dir, "lib", "settings-http.js");
let src = fs.readFileSync(p, "utf8");
const at = src.indexOf("export function saveSettings");
const seg = src.slice(at);
const lineRe = /^\s*const verdict = assertAuthorized\(scope, req\);\s*$/m;
let next = src.slice(0, at) + seg.replace(lineRe, "// (反向验证：自查被挪走)");
const editAt = next.indexOf(".edit(", at);
const insertAt = next.indexOf("\n", next.indexOf("});", editAt));
const final = next.slice(0, insertAt + 1) + "    const verdict2 = assertAuthorized(scope, req);\n" + next.slice(insertAt + 1);
fs.writeFileSync(p, final, "utf8");

const r = spawnSync(process.execPath, [path.join(dir, "tools", "_probe-d323-f07-split.mjs")], {
  cwd: dir, encoding: "utf8",
});
console.log("EXIT =", r.status);
console.log("=== stdout ===");
console.log(r.stdout ?? "");
console.log("=== stderr ===");
console.log(r.stderr ?? "");
fs.rmSync(dir, { recursive: true, force: true });
