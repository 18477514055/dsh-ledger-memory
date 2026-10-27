/**
 * _fixdeps-d332-selftest-driven.mjs —— **以 selftest 为驱动**补齐新模块缺失的符号
 *
 * ★ 为什么换驱动（前面两版探针都漏，这是第 8 处尺子错）：
 *   我的夹具只调到"浅层"分支（`op:"tree"` 之类），而 selftest 会走到**更深**的路径
 *   （比如带 `arguments` / 卡片目录 / 并发场景）⇒ 深层的符号（`isUnderReal`、`appendAudit`…）
 *   我的夹具永远摸不到。
 *   ★ 判据：**夹具的覆盖深度决定探针能发现什么** —— 想发现全部，就用**真实调用方**当驱动。
 *   这里直接用 `tools/selftest.mjs` 当驱动：它跑到哪崩，就说明缺哪个符号。
 *
 * ★ 做法：跑 selftest → 从 stderr 抓 `X is not defined` → 定位 X 在 part2 里的来源 → 补 import
 *   → 再跑，直到 selftest 不再因 ReferenceError 崩。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const NEW = path.resolve("lib/part2-tools.js");
const P2 = path.resolve("lib/part2.js");
const SELFTEST = path.resolve("tools/selftest.mjs");

const p2text = fs.readFileSync(P2, "utf8");
const p2lines = p2text.split(/\r?\n/);

// ── part2 的符号来源表（**注释感知**，修掉前面那个 bug） ────────────────────
const ownDecls = new Map();
for (let i = 0; i < p2lines.length; i += 1) {
  const m =
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(p2lines[i]) ||
    /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/.exec(p2lines[i]) ||
    /^(?:export\s+)?let\s+([A-Za-z0-9_$]+)\s*=/.exec(p2lines[i]);
  if (m) ownDecls.set(m[1], i + 1);
}

const importedFrom = new Map();
{
  let i = 0;
  while (i < p2lines.length) {
    const strippedLine = p2lines[i].replace(/\/\/[^\n]*/g, "");
    if (!/^import\s/.test(strippedLine)) { i += 1; continue; }
    let chunk = p2lines[i];
    let j = i;
    const done = (s) => /from\s+["'][^"']+["']\s*;?\s*$/.test(s.replace(/\/\/[^\n]*/g, ""));
    while (!done(chunk) && j + 1 < p2lines.length) { j += 1; chunk += "\n" + p2lines[j]; }
    const stripped = chunk.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const spec = /from\s+["']([^"']+)["']/.exec(stripped)?.[1];
    if (spec !== undefined) {
      const brace = /\{([\s\S]*?)\}/.exec(stripped);
      if (brace !== null) {
        for (const raw of brace[1].split(",")) {
          const nm = raw.trim().split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(nm)) importedFrom.set(nm, spec);
        }
      }
    }
    i = j + 1;
  }
}
// node 内置的默认导入
const nodeDefaults = new Map();
for (const m of p2text.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](node:[^"']+)["'];/gm)) {
  nodeDefaults.set(m[1], m[2]);
}

console.log(`part2：自声明 ${ownDecls.size} · 转手 import ${importedFrom.size} · node 默认 ${nodeDefaults.size}`);

let text = fs.readFileSync(NEW, "utf8");
const tmp = process.env.TEMP ?? ".";
fs.writeFileSync(path.join(tmp, `part2-tools-before-selftest-fix-${Date.now()}.js`), text, "utf8");

/** 把若干名字插进对应的 import；没有就新建一条。 */
function addImports(src, namesBySpec) {
  let out = src;
  for (const [spec, names] of namesBySpec) {
    // ★★★ 修（我的第 9 处尺子错）：原正则用 `[\s\S]*?` 跨行匹配花括号，
    //   于是 `from "./part2.js"` 那条**长 import** 会把**后面**别的模板的花括号一起吃掉
    //   ⇒ 把 buildGoalTree 这类"part2 的实现"错误地并进了 `./base.js`。
    //   判据：**按模块名反查 import 时，花括号内容不能跨 `import` 边界**。
    //   改法：先把 import 区按 `;` 切成语句，只在那一条语句内部找花括号。
    const stmtRe = new RegExp(
      `import\\s*\\{[^}]*\\}\\s*from\\s*["']${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'];`
    );
    const m = stmtRe.exec(out);
    if (m !== null) {
      const brace = /\{([^}]*)\}/.exec(m[0]);
      const existing = new Set(
        brace[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x))
      );
      const toAdd = [...names].filter((n) => !existing.has(n)).sort();
      if (toAdd.length === 0) continue;
      const merged = [...existing, ...toAdd].sort();
      const oneLine = `import { ${merged.join(", ")} } from "${spec}";`;
      out = out.replace(stmtRe, oneLine);
    } else {
      const lastImport = [...out.matchAll(/^import[\s\S]*?from\s*["'][^"']+["'];\s*$/gm)].pop();
      const at = lastImport === undefined ? 0 : lastImport.index + lastImport[0].length;
      out = out.slice(0, at) + `\nimport { ${[...names].sort().join(", ")} } from "${spec}";` + out.slice(at);
    }
  }
  return out;
}

const MAX = 25;
for (let round = 1; round <= MAX; round += 1) {
  fs.writeFileSync(NEW, text, "utf8");
  const r = spawnSync(process.execPath, [SELFTEST], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 1800000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NO_PROXY: "github.com" },
  });
  const err = String(r.stderr ?? "");
  const out = String(r.stdout ?? "");

  // 只在"因 ReferenceError 崩"时才继续修；否则停
  // ★ 修：Node 的 ReferenceError 在 stderr 里**不是干净的一行**（前面有 `file:///…:380` 和源码行），
  //   原正则 `^X is not defined$` 带 `m` 也匹配不到 ⇒ 我第一版直接判成"不是 ReferenceError"。
  //   ⇒ 改成"行内包含即可"（`[\w$]+ is not defined` 这个串在 JS 里不会误伤别的错误）。
  const refErr = /([A-Za-z_$][\w$]*) is not defined/.exec(err);
  const totals = /合计：PASS (\d+) · SKIP (\d+) · FAIL (\d+)/.exec(out + err);

  if (totals !== null) {
    console.log(`\n✅ 第 ${round} 轮：selftest 跑完 → PASS ${totals[1]} · SKIP ${totals[2]} · FAIL ${totals[3]}`);
    break;
  }
  if (refErr === null) {
    console.log(`\n⚠️ 第 ${round} 轮：崩了但不是 ReferenceError，停下来看：`);
    console.log(err.split(/\r?\n/).slice(0, 20).join("\n"));
    break;
  }

  const sym = refErr[1];
  console.log(`\n第 ${round} 轮缺：${sym}`);
  // 收集同一份 stderr 里所有 "X is not defined"（可能多个）
  const allSyms = new Set([...err.matchAll(/([A-Za-z_$][\w$]*) is not defined/g)].map((x) => x[1]));
  allSyms.add(sym);

  const bySpec = new Map();
  const unknown = [];
  for (const n of allSyms) {
    if (nodeDefaults.has(n)) {
      // node 默认导入：直接加一行
      if (!new RegExp(`^import\\s+${n}\\s+from`, "m").test(text)) {
        text = `import ${n} from "${nodeDefaults.get(n)}";\n` + text;
        console.log(`    ${n.padEnd(26)} ← node 内置 ${nodeDefaults.get(n)}（默认导入）`);
      }
      continue;
    }
    const spec = importedFrom.get(n);
    if (spec !== undefined) {
      if (!bySpec.has(spec)) bySpec.set(spec, new Set());
      bySpec.get(spec).add(n);
      console.log(`    ${n.padEnd(26)} ← 从 ${spec} import`);
    } else if (ownDecls.has(n)) {
      if (!bySpec.has("./part2.js")) bySpec.set("./part2.js", new Set());
      bySpec.get("./part2.js").add(n);
      console.log(`    ${n.padEnd(26)} ← part2 自己声明（第 ${ownDecls.get(n)} 行）`);
    } else {
      unknown.push(n);
      console.log(`    ${n.padEnd(26)} 🔴 找不到来源`);
    }
  }
  if (unknown.length > 0) {
    console.log(`\n🔴 ${unknown.length} 个找不到来源 ⇒ 停下报告，不猜：${unknown.join(", ")}`);
    process.exit(1);
  }
  text = addImports(text, bySpec);
}

fs.writeFileSync(NEW, text, "utf8");
console.log(`\npart2-tools.js = ${Buffer.byteLength(text, "utf8")} B / ${text.split(/\r?\n/).length} 行`);
console.log("PROBE-COMPLETE");
