/**
 * 阶段 0.1（V3 地基）：**找出所有"绕过 `inspect()` 自己拼路径"的地方。**
 *
 * 🔴 为什么这一步必须最先做（这是我写在计划 §5.1 的头号风险）：
 *   V3 的做法是把 `inspect()` 内部的解析基准从 `projectRoot` 换成 `memoryRoot`。
 *   但如果有代码**不经过 inspect**、自己 `path.join(root, "LEDGER.md")` 这种写法，
 *   迁移后它会继续指旧位置 —— 而 `readTextSafe` 对不存在的文件**静默返回 undefined**
 *   ⇒ 表现成"台账突然空了"，**不是报错**。这是最难查的一类故障。
 *
 * ★ 判据怎么定（关键）：
 *   一个 `path.join(...)` **不算问题**的条件是：它的参数里出现了
 *   `info.` / `.Rel` / `.Abs` / `memoryRoot` / `projectRoot` 变量名，
 *   或者它出现在 `inspect()` 函数体内部（那里本来就是"定义基准"的地方）。
 *   其余都算"可疑硬编码拼路径"。
 *
 * ★ 只报**可疑项**，不报全部 186 处 —— 全面报等于没报。
 *
 * 跑法：node tools/_probe-v3-hardcoded-paths.mjs
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

function stripComments(src) {
  let out = "";
  let i = 0;
  let state = "code";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        state = c === "'" ? "sq" : c === '"' ? "dq" : "tpl";
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 2;
        continue;
      }
      if (c === "\n") out += c;
      i += 1;
      continue;
    }
    if (c === "\\") {
      out += c + (n ?? "");
      i += 2;
      continue;
    }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) {
      state = "code";
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ── 找出 inspect() 函数体的行区间（那里允许随便拼）──
function inspectBodyRange(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^export function inspect\s*\(/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return [0, 0];
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth += 1;
        seenBrace = true;
      } else if (ch === "}") {
        depth -= 1;
        if (seenBrace && depth === 0) return [start + 1, i + 1];
      }
    }
  }
  return [start + 1, lines.length];
}

const files = fs.readdirSync(LIB).filter((f) => f.endsWith(".js")).sort();

// 允许的"知情"标记：出现任一即认为它知道 memoryRoot 这件事
const AWARE =
  /\binfo\b|\bInfo\b|\.Rel\b|\.Abs\b|memoryRoot|projectRoot|notesAbs|handoffAbs|activeAbs|logAbs/;

const suspicious = [];
const inInspect = [];

for (const f of files) {
  const raw = fs.readFileSync(path.join(LIB, f), "utf8");
  const clean = stripComments(raw);
  const cleanLines = clean.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  const [a, b] = f === "part2.js" ? inspectBodyRange(cleanLines) : [0, 0];

  for (let i = 0; i < cleanLines.length; i++) {
    const line = cleanLines[i];
    if (!/path\.(?:join|resolve)\s*\(/.test(line)) continue;

    const inInspectFn = i + 1 >= a && i + 1 <= b;
    const aware = AWARE.test(line);
    const rec = {
      file: f,
      line: i + 1,
      text: (rawLines[i] ?? "").trim().slice(0, 120),
    };

    if (inInspectFn) {
      inInspect.push(rec);
    } else if (!aware) {
      suspicious.push(rec);
    }
  }
}

console.log("═══ 阶段 0.1：绕过 inspect() 的硬编码路径拼接 ═══\n");
console.log(`（inspect() 函数体内部 ${inInspect.length} 处 —— 那里本来就该拼，不计）\n`);

if (suspicious.length === 0) {
  console.log("✅ 没有发现可疑项：所有 `path.join/resolve` 都带着 info/.Rel/.Abs/memoryRoot 这类知情变量。");
} else {
  console.log(`⚠ 可疑 ${suspicious.length} 处（需要逐个确认：是不是在拼"项目内相对路径"）：\n`);
  const byFile = new Map();
  for (const r of suspicious) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  for (const [file, rs] of [...byFile.entries()].sort((x, y) => y[1].length - x[1].length)) {
    console.log(`── lib/${file}（${rs.length} 处）`);
    for (const r of rs) console.log(`   L${r.line}  ${r.text}`);
    console.log("");
  }
}

// 写盘供后续逐条核对
const out = path.join(HERE, "_v3-hardcoded-paths.md");
const lines = [
  "# V3 阶段 0.1：绕过 inspect() 的硬编码路径拼接",
  "",
  `> 生成：node tools/_probe-v3-hardcoded-paths.mjs`,
  `> 可疑 ${suspicious.length} 处 · inspect() 内部 ${inInspect.length} 处（不计）`,
  "",
  "## 判据",
  "一个 `path.join/resolve` **不算问题**的条件：参数里出现 `info` / `.Rel` / `.Abs` / `memoryRoot` / `projectRoot`，",
  "或者它位于 `inspect()` 函数体内部。其余算可疑。",
  "",
  "## 可疑清单",
  "",
];
for (const r of suspicious) lines.push(`- \`lib/${r.file}:${r.line}\` — ${r.text}`);
lines.push("", "## inspect() 内部（允许，仅供参考）", "");
for (const r of inInspect) lines.push(`- \`lib/${r.file}:${r.line}\` — ${r.text}`);
fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`明细已写至: ${out}`);
