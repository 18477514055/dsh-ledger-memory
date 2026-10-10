/**
 * 只读：按**商城的判据**（src/automation-source-policy.mjs 的 permissionSignals）
 * 扫一遍我们发布包里的源码，看会命中哪些「权限信号」。
 * ★ 六项允许值在 automation-policy.json 里**全为 false** ⇒ 任一命中都单独构成拒绝理由。
 */
import fs from "node:fs";

const files = ["lib/index.js", "lib/client.js", "tools/selftest.mjs", "cordis.patch.yml"];
const checks = [
  ["files", "node:fs 模块", /from\s+["']node:fs["']/],
  ["files", "readFile/writeFile/rename/unlink/mkdir/rm 调用", /\b(?:readFile|writeFile|appendFile|rename|unlink|mkdir|rmdir|rm)\s*\(/],
  ["files", "process.env.DSH_HOME", /process\s*\.\s*env\s*\.\s*DSH_HOME/],
  ["credentials", "process.env（任意）", /process\s*\.\s*env/],
  ["credentials", "apiKey/token/secret/password 字样", /\b(?:api[_-]?key|apiKey|access[_-]?token|accessToken|client[_-]?secret|clientSecret|password)\b/i],
  ["commands", "node:child_process 模块", /from\s+["']node:child_process["']/],
  ["commands", "spawnSync/execSync/spawn/exec 调用", /\b(?:spawnSync|execSync|spawn|exec)\s*\(/],
  ["network", "fetch/WebSocket/EventSource 调用", /\b(?:fetch|WebSocket|EventSource)\s*\(/],
  ["network", "node:http(s) 模块", /from\s+["']node:https?["']/],
];

console.log("=== 按商城判据扫描发布包（命中即一条独立拒绝理由）===\n");
const hitSignals = new Set();
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, "utf8");
  const hits = checks.filter(([, , re]) => re.test(src));
  console.log(`${f}  (${src.length} 字符)${hits.length ? "" : "  —— 无命中"}`);
  for (const [sig, name] of hits) {
    hitSignals.add(sig);
    console.log(`    ★ [${sig}] ${name}`);
  }
}
console.log("\n=== 会触发的信号集合 ===");
console.log("  " + ([...hitSignals].join(", ") || "(无)"));
console.log("\n⇒ 六个允许值全为 false，上面每一条都会**单独**把条目判为 blocked。");
