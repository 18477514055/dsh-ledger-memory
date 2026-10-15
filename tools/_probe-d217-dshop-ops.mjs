// D217 · 查清官方对 `dshOperations` 四项（install/start/uninstall/rollback）的**语义与证据要求**
// —— 这一项决定我们能不能把 `unknown` 诚实变成别的值。
// 用法：node tools/_probe-d217-dshop-ops.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SR = path.join(HERE, "..", "_store-research");

// ① schema 里 dshOperations 的定义与描述
const schema = JSON.parse(fs.readFileSync(path.join(SR, "catalog.schema.json"), "utf8"));
function walk(node, cb, p = "") {
  if (node === null || typeof node !== "object") return;
  cb(node, p);
  for (const [k, v] of Object.entries(node)) walk(v, cb, `${p}.${k}`);
}
console.log("═══ ① schema 里含 dshOperations 的节点 ═══");
walk(schema, (n, p) => {
  if (JSON.stringify(n).includes("dshOperations") && p.split(".").length <= 5) {
    const s = JSON.stringify(n);
    if (s.length < 1600) console.log(`\n[${p}]\n${JSON.stringify(n, null, 1)}`);
  }
});

// ② 官方源码里这些值允许取什么、怎么被写
console.log("\n═══ ② 取值域与写入点 ═══");
for (const f of fs.readdirSync(SR)) {
  if (!f.endsWith(".mjs") && !f.endsWith(".js")) continue;
  const text = fs.readFileSync(path.join(SR, f), "utf8");
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    if (/passed|failed|unknown/.test(l) && /DSH_OPERATIONS|install|rollback|operations/i.test(l)) {
      const t = l.trim();
      if (t.length < 190) console.log(`  ${f}:${i + 1}  ${t}`);
    }
  });
}

// ③ README 里那段规则的完整上下文
console.log("\n═══ ③ README 里 dshOperations 的规则（上下文）═══");
const rd = fs.readFileSync(path.join(SR, "README.md"), "utf8").split("\n");
rd.forEach((l, i) => {
  if (/dshOperations|真实证据|verified|partial/.test(l)) {
    console.log(`  L${i + 1}: ${l.trim().slice(0, 200)}`);
  }
});
