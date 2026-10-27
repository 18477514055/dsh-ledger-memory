/**
 * _probe-d332-fixdeps.mjs —— **自动**把新模块缺的符号一次性补齐（循环到不再缺）
 *
 * ★ 为什么写自动的：JS 一个函数里只报**第一个** `ReferenceError`，
 *   手动一个个补要跑十几轮（刚才已经跑了 2 轮还没完）。
 *   ⇒ 让脚本自己：真跑 → 抓缺失 → 查来源 → 写进 import → 再跑，直到缺 0 个。
 *
 * ★ 来源判定三步（按可信度递减）：
 *   ① part2.js 自己**声明**的（顶层 function/const/let）⇒ 从 `./part2.js` import
 *   ② part2.js 从别处 **import** 进来转手的 ⇒ 直接 import 那个**原始模块**（少一层中转）
 *   ③ 两个都找不到 ⇒ **停下来报给我**（不猜）
 *
 * ★ 安全：写之前备份；**只改 import 区**，绝不碰实现体。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const P2 = path.resolve("lib/part2.js");
const NEW = path.resolve("lib/part2-tools.js");
const TOOLS = ["defineGoalsTool", "defineLessonsTool", "definePrinciplesAccessTool", "defineProposePrincipleTool"];

const p2text = fs.readFileSync(P2, "utf8");
const p2lines = p2text.split(/\r?\n/);

// ── 解析 part2.js 的顶层声明与 import 映射 ────────────────────────────────
const ownDecls = new Map(); // name -> {kind, line}
for (let i = 0; i < p2lines.length; i += 1) {
  const l = p2lines[i];
  const m =
    /^(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^(export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/.exec(l) ||
    /^(export\s+)?let\s+([A-Za-z0-9_$]+)\s*=/.exec(l);
  if (m) ownDecls.set(m[2], { line: i + 1 });
}

/** 扫 part2 的 import 块，得到 name -> 来源模块。 */
const importedFrom = new Map(); // name -> module spec
{
  let i = 0;
  while (i < p2lines.length) {
    if (!/^import\s/.test(p2lines[i])) { i += 1; continue; }
    let chunk = p2lines[i];
    let j = i;
    while (!/from\s+["'][^"']+["']\s*;?\s*$/.test(chunk) && j + 1 < p2lines.length) {
      j += 1;
      chunk += "\n" + p2lines[j];
    }
    const spec = /from\s+["']([^"']+)["']/.exec(chunk)?.[1];
    if (spec !== undefined) {
      // 抓 `{ a, b as c }` 里的原名（我们只用原名）
      const brace = /\{([\s\S]*?)\}/.exec(chunk);
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

console.log(`part2 自声明 ${ownDecls.size} 个 · 转手 import ${importedFrom.size} 个`);

// ── 循环补齐 ──────────────────────────────────────────────────────────────
let newText = fs.readFileSync(NEW, "utf8");
const tmp = process.env.TEMP ?? ".";
fs.writeFileSync(path.join(tmp, `part2-tools-before-fixdeps-${Date.now()}.js`), newText, "utf8");

const addFromPart2 = new Set();
const addFromModule = new Map(); // spec -> Set(names)
const unresolvable = new Set();

for (let round = 1; round <= 20; round += 1) {
  fs.writeFileSync(NEW, newText, "utf8");
  const mod = await import(pathToFileURL(NEW).href + `?r=${round}`);
  const missing = new Set();
  for (const t of TOOLS) {
    try {
      const r = mod[t]();
      if (r === undefined || typeof r.name !== "string") {
        console.log(`  ⚠️ ${t}() 返回形状可疑：${typeof r}`);
      }
    } catch (e) {
      const m = /^([A-Za-z_$][\w$]*) is not defined$/.exec(e.message);
      if (m) missing.add(m[1]);
      else console.log(`  ⚠️ ${t} 抛了非 ReferenceError：${e.message}`);
    }
  }
  if (missing.size === 0) {
    console.log(`\n✅ 第 ${round} 轮：四个 tool **全部可调用，零缺失**`);
    break;
  }
  console.log(`\n第 ${round} 轮缺 ${missing.size} 个：${[...missing].join(", ")}`);

  // 判定来源并写进待加清单
  const linesToInsert = [];
  for (const n of [...missing].sort()) {
    if (ownDecls.has(n)) {
      addFromPart2.add(n);
      console.log(`    ${n.padEnd(30)} ← part2 自己声明（第 ${ownDecls.get(n).line} 行）⇒ 从 ./part2.js import`);
    } else if (importedFrom.has(n)) {
      const spec = importedFrom.get(n);
      if (!addFromModule.has(spec)) addFromModule.set(spec, new Set());
      addFromModule.get(spec).add(n);
      console.log(`    ${n.padEnd(30)} ← part2 转手自 ${spec} ⇒ 直接从 ${spec} import`);
    } else {
      unresolvable.add(n);
      console.log(`    ${n.padEnd(30)} 🔴 **找不到来源**，需人工查`);
    }
  }
  if (unresolvable.size > 0) {
    console.log("\n🔴 有符号找不到来源 ⇒ 停下来报给用户，不猜。");
    process.exit(1);
  }

  // 生成 import 行
  for (const n of [...addFromPart2].sort()) {
    linesToInsert.push(`  ${n},`);
  }
  // 把新名字并进 part2 import 块
  if (addFromPart2.size > 0) {
    newText = newText.replace(
      /(import\s*\{)([\s\S]*?)(\}\s*from\s*["']\.\/part2\.js["'];)/,
      (_, a, body, c) => `${a}${body}${[...addFromPart2].sort().map((n) => `  ${n},\n`).join("")}${c}`
    );
    addFromPart2.clear();
  }
  // 追加别的模块 import
  if (addFromModule.size > 0) {
    const extra = [...addFromModule.entries()]
      .map(([spec, set]) => `import { ${[...set].sort().join(", ")} } from "${spec}";`)
      .join("\n");
    // 插在最后一个 import 之后
    const lastImport = [...newText.matchAll(/^import[\s\S]*?from\s*["'][^"']+["'];\s*$/gm)].pop();
    if (lastImport !== undefined) {
      const idx = lastImport.index + lastImport[0].length;
      newText = newText.slice(0, idx) + "\n" + extra + newText.slice(idx);
    } else {
      newText = extra + "\n" + newText;
    }
    addFromModule.clear();
  }
}

fs.writeFileSync(NEW, newText, "utf8");
const finalBytes = Buffer.byteLength(newText, "utf8");
console.log(`\npart2-tools.js 最终 ${finalBytes} B / ${newText.split(/\r?\n/).length} 行`);
console.log("PROBE-COMPLETE");
