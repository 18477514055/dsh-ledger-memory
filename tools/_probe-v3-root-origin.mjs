/**
 * 阶段 0.3（V3 地基）：**查清 `path.resolve(root, …)` 里那个 `root` 到底是"项目根"还是"记忆根"。**
 *
 * 🔴 为什么这是最后一块拼图：
 *   0.2 查出了 24 处 `path.xxx(root, info.xxxRel)` —— 那些必须把 root 换成 memoryRoot。
 *   但还有约 78 处 `path.resolve(root, relPath)`，`relPath` 是**函数参数传进来的**。
 *   它们的对错取决于**调用方传的 rel 是哪来的**：
 *     · 来自 `info.xxxRel` ⇒ 必须配 memoryRoot；
 *     · 来自用户参数 / 相对路径字面量 ⇒ 可能是项目根，要单独看。
 *
 * ★ 本脚本给每条路径标一个**归属猜测**，并把判断依据（函数的参数名、调用点）一并列出 ——
 *   结论仍要人看，但它把"78 处"压缩成"少数几个家族"。
 *
 * 跑法：node tools/_probe-v3-root-origin.mjs
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");
const files = fs.readdirSync(LIB).filter((f) => f.endsWith(".js")).sort();

/**
 * 找出每个文件的**函数边界**，这样每一处 path 调用都能归到"它在哪个函数里"，
 * 而函数的第一个参数名往往就叫 root / projectRoot —— 那是最直接的证据。
 */
function functionSpans(lines) {
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
    if (!m) continue;
    const name = m[1];
    const params = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    // 花括号配对找函数结束
    let depth = 0;
    let started = false;
    let end = lines.length;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth += 1;
          started = true;
        } else if (ch === "}") {
          depth -= 1;
          if (started && depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end !== lines.length) break;
    }
    spans.push({ name, params, start: i + 1, end: end + 1 });
  }
  return spans;
}

const groups = new Map(); // 归到"函数签名"这一层

for (const f of files) {
  const raw = fs.readFileSync(path.join(LIB, f), "utf8");
  const lines = raw.split(/\r?\n/);
  const spans = functionSpans(lines);

  for (let i = 0; i < lines.length; i++) {
    if (!/path\.(?:resolve|join)\(\s*(?:root|projectRoot|base)\s*,/.test(lines[i])) continue;
    const ln = i + 1;
    const host = spans.find((s) => ln >= s.start && ln <= s.end);
    // 只统计"参数是变量"的（字面量 0.1 已单独处理）
    const call = lines[i].match(/path\.(?:resolve|join)\(\s*(root|projectRoot|base)\s*,\s*([^),]+)/);
    if (!call) continue;
    const second = call[2].trim();
    if (/^["'`]/.test(second)) continue; // 字面量跳过

    const key = `${f}::${host ? host.name : "(顶层)"}::${host ? host.params[0] ?? "" : ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        file: f,
        fn: host ? host.name : "(顶层)",
        firstParam: host ? host.params[0] ?? "" : "",
        calls: [],
      });
    }
    groups.get(key).calls.push({ line: ln, second, text: lines[i].trim().slice(0, 100) });
  }
}

console.log("═══ 阶段 0.3：`path.resolve(root, …)` 的函数归属 ═══\n");
console.log(`共 ${groups.size} 个"函数家族"，下面逐个说明它的 root 该是谁。\n`);

const rows = [...groups.values()].sort((a, b) => b.calls.length - a.calls.length);
for (const g of rows) {
  console.log(`── lib/${g.file} :: ${g.fn}(…, ${g.firstParam || "?"}, …)  — ${g.calls.length} 处`);
  for (const c of g.calls) {
    console.log(`     L${c.line}  第二个参数=\`${c.second}\``);
  }
  console.log("");
}

// 判据：第二参数名里出现典型的"记忆相对路径"关键词 ⇒ 该用 memoryRoot
const MEMORYISH =
  /(Rel|Path|rel|path|fileRel|targetRel|relDir|dirRel|journal|goals|lessons|principles|decisions|archive|log|stash|handoff|capsule)/i;

let mem = 0;
let unclear = 0;
for (const g of rows) {
  for (const c of g.calls) {
    if (MEMORYISH.test(c.second)) mem += 1;
    else unclear += 1;
  }
}

console.log("═══ 粗分类（供人核，不是最终结论）═══");
console.log(`  · 第二参数名像"记忆相对路径"        = ${mem} 处  ⇒ 倾向 memoryRoot`);
console.log(`  · 看不出（可能项目根，需逐个确认）  = ${unclear} 处`);

const out = path.join(HERE, "_v3-root-origin.md");
const md = [
  "# V3 阶段 0.3：`path.resolve(root, …)` 的函数归属",
  "",
  `> 生成：node tools/_probe-v3-root-origin.mjs`,
  `> ${groups.size} 个函数家族 · 疑似记忆路径 ${mem} 处 · 需人工确认 ${unclear} 处`,
  "",
  "## 判断方式",
  "每一处都归到它所在的函数；函数的**第一个参数名**通常就是 root 的来源。",
  "第二参数名像 `xxxRel` / `relPath` / `fileRel` / `journal` / `archive` 的 ⇒ 倾向记忆根。",
  "",
];
for (const g of rows) {
  md.push(`### \`lib/${g.file}\` :: \`${g.fn}\`（首参 \`${g.firstParam || "?"}\`）— ${g.calls.length} 处`);
  md.push("");
  for (const c of g.calls) {
    const tag = MEMORYISH.test(c.second) ? "**记忆根?**" : "待确认";
    md.push(`- L${c.line} [${tag}] \`${c.second}\` — ${c.text}`);
  }
  md.push("");
}
fs.writeFileSync(out, md.join("\n"), "utf8");
console.log(`\n明细已写至: ${out}`);
