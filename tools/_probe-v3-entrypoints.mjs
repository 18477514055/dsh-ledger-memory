/**
 * V3 地基勘查（任务书 §10 第一阶段）：**把 lib/ 里所有「会改变外部状态」与「会拼路径」的入口扫出来**。
 *
 * ★ 用户定的扫描范围：**全部** —— 写文件 + 读文件 + Git + 网络 + 路径拼接。
 * ★ 为什么必须先扫再动手（任务书 §10 原话）：*"不能凭 README 猜测实现。"*
 *
 * ★ 判据纪律（本项目栽过很多次）：
 *   ① **先剥注释**再判 —— 注释里出现 `writeFileSync` 不算入口。
 *   ② **保留字符串**（路径常量就在字符串里），但把「文档属性」抹掉，
 *      否则工具描述里的英文单词会被当成代码（D288 的 `fetch` 假阳性）。
 *   ③ 输出**文件:行号 + 原文片段**，让人能直接去核 —— 不报"大约有 N 处"。
 *
 * 跑法：node tools/_probe-v3-entrypoints.mjs
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

// ── 词法：剥注释、抹文档属性（与 D288 探针同一套，避免两处各写一份）──
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
      if (c === "'") {
        state = "sq";
        out += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        state = "dq";
        out += c;
        i += 1;
        continue;
      }
      if (c === "`") {
        state = "tpl";
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
    if (
      (state === "sq" && c === "'") ||
      (state === "dq" && c === '"') ||
      (state === "tpl" && c === "`")
    ) {
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

function stripDocStrings(code) {
  return code
    .replace(/\b(?:description|hint|why|label|note|title)\s*:\s*"(?:[^"\\]|\\.)*"/g, '$1:""')
    .replace(/\b(?:description|hint|why|label|note|title)\s*:\s*'(?:[^'\\]|\\.)*'/g, "$1:''")
    .replace(/\b(?:description|hint|why|label|note|title)\s*:\s*`(?:[^`\\]|\\.)*`/g, "$1:``");
}

const CATEGORIES = [
  {
    key: "write",
    title: "① 写文件（会改变磁盘状态）",
    re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|unlinkSync|unlink|rmSync|rm|rmdirSync|mkdirSync|ensureDir|copyFileSync|writeFileAtomic)\s*\(/g,
  },
  {
    key: "read",
    title: "② 读文件（路径错了就读不到，迁移后必须核对）",
    re: /\b(?:readFileSync|readFile|readTextSafe|readdirSync|readdir|existsSync|statSync|lstatSync|readManifest)\s*\(/g,
  },
  {
    key: "git",
    title: "③ Git 交互（V3 全部要改成「永不自动暂存」）",
    re: /\b(?:gitAdd|gitAvailable|git|gitInit)\s*\(/g,
  },
  {
    key: "net",
    title: "④ 网络 / 对外发送",
    re: /\b(?:fetch|https?\.(?:request|get)|net\.connect|dgram\.createSocket)\s*\(/g,
  },
  {
    key: "path",
    title: "⑤ 路径拼接（V3 要把它们统一收进 memoryRoot）",
    re: /\bpath\.(?:join|resolve|dirname|basename)\s*\(/g,
  },
];

const files = fs.readdirSync(LIB).filter((f) => f.endsWith(".js")).sort();
const results = {};

for (const cat of CATEGORIES) results[cat.key] = [];

for (const f of files) {
  const raw = fs.readFileSync(path.join(LIB, f), "utf8");
  const cleaned = stripDocStrings(stripComments(raw));
  const cleanedLines = cleaned.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);

  for (const cat of CATEGORIES) {
    for (let i = 0; i < cleanedLines.length; i++) {
      cat.re.lastIndex = 0;
      if (!cat.re.test(cleanedLines[i])) continue;
      // 只取**第一个**匹配名，读起来清楚
      const m = cleanedLines[i].match(
        /\b(?:writeFileSync|writeFileAtomic|writeFile|appendFileSync|appendFile|renameSync|rename|unlinkSync|unlink|rmSync|rm|rmdirSync|mkdirSync|ensureDir|copyFileSync|readFileSync|readFile|readTextSafe|readdirSync|readdir|existsSync|statSync|lstatSync|readManifest|gitAdd|gitAvailable|gitInit|git|fetch|path\.join|path\.resolve|path\.dirname|path\.basename)\b/,
      );
      results[cat.key].push({
        file: f,
        line: i + 1,
        name: m ? m[0] : "?",
        text: (rawLines[i] ?? "").trim().slice(0, 110),
      });
    }
  }
}

// ── 输出 ──
let total = 0;
for (const cat of CATEGORIES) {
  const rows = results[cat.key];
  total += rows.length;
  console.log(`\n${cat.title}  —— ${rows.length} 处`);
  // 按文件聚合，别刷屏
  const byFile = new Map();
  for (const r of rows) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  for (const [file, rs] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const names = [...new Set(rs.map((r) => r.name))].join(",");
    console.log(`   ${file.padEnd(12)} ${String(rs.length).padStart(3)} 处   含: ${names}`);
  }
}

console.log("\n════════════════════════════════════════");
console.log(`总计扫描 ${files.length} 个文件，命中 ${total} 处`);

// ★ 关键提醒：V3 要动的是"写"与"git"，读只要跟着新根走
const writeN = results.write.length;
const gitN = results.git.length;
const pathN = results.path.length;
console.log("");
console.log(`★ V3 直接要改：写 ${writeN} 处 + Git ${gitN} 处 = ${writeN + gitN} 处`);
console.log(`★ 路径拼接 ${pathN} 处 —— 它们是「新根从哪注入」的改造面，不逐个改，而是收口到一个函数`);
console.log(`★ 读 ${results.read.length} 处 —— 只要根变了就自动跟随，但要抽查有没有写死根的地方`);

// 把明细写盘，供后续做计划时逐条核对
const out = path.join(HERE, "_v3-entrypoints.md");
const lines = [
  "# V3 地基勘查：lib/ 入口清单",
  "",
  `> 生成：node tools/_probe-v3-entrypoints.mjs · 扫描 ${files.length} 个文件 · 命中 ${total} 处`,
  "> ★ 判据已剥注释、已抹文档属性；行号指向**原始文件**行号。",
  "",
];
for (const cat of CATEGORIES) {
  lines.push(`## ${cat.title}（${results[cat.key].length} 处）`, "");
  const byFile = new Map();
  for (const r of results[cat.key]) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  for (const [file, rs] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### \`lib/${file}\`（${rs.length} 处）`, "");
    for (const r of rs) lines.push(`- **L${r.line}** \`${r.name}\` — ${r.text}`);
    lines.push("");
  }
}
fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`\n明细已写至: ${out}`);
