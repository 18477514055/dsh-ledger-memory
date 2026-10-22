// 在 app.asar 里按**内容**检索（不是文件名），定位渲染 settings.section 的外壳组件
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ASAR = (process.env.DSH_ASAR ?? path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "app.asar"));
const fd = fs.openSync(ASAR, "r");

const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPickleLen = head.readUInt32LE(12);

const raw = Buffer.alloc(headerPickleLen);
fs.readSync(fd, raw, 0, headerPickleLen, 16);

let start = raw.indexOf(0x7b);
let depth = 0, inStr = false, esc = false, end = -1;
for (let i = start; i < raw.length; i++) {
  const c = raw[i];
  if (inStr) {
    if (esc) esc = false;
    else if (c === 0x5c) esc = true;
    else if (c === 0x22) inStr = false;
    continue;
  }
  if (c === 0x22) inStr = true;
  else if (c === 0x7b) depth++;
  else if (c === 0x7d) { depth--; if (depth === 0) { end = i; break; } }
}
const header = JSON.parse(raw.slice(start, end + 1).toString("utf8"));

const DATA_OFFSET = 8 + headerPickleLen;

// 收集所有文件条目
const entries = [];
(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files ?? {})) {
    const p = prefix === "" ? name : `${prefix}/${name}`;
    if (v.files !== undefined) walk(v, p);
    else entries.push({ path: p, size: v.size, offset: v.offset === undefined ? undefined : Number(v.offset) });
  }
})(header, "");

const NEEDLES = process.argv.slice(2);
if (NEEDLES.length === 0) {
  console.log("用法：node tools/_probe-asar-grep.mjs <关键词...>");
  process.exit(0);
}

console.log(`asar 内文件 ${entries.length} 个；检索 ${NEEDLES.length} 个关键词\n`);

const hits = [];
for (const e of entries) {
  // 只看可能装 UI 的源码/文本
  if (!/\.(js|mjs|json|css)$/.test(e.path)) continue;
  if (e.size === undefined || e.size > 4_000_000) continue;
  // ★ 坑（台账里记过）：asar header 里的 offset 是**字符串**，不是数字。
  if (!Number.isFinite(e.offset)) continue;
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, DATA_OFFSET + e.offset);
  const txt = buf.toString("utf8");
  const found = NEEDLES.filter((n) => txt.includes(n));
  if (found.length === NEEDLES.length) hits.push({ p: e.path, size: e.size, txt, found });
}

console.log(`命中 ${hits.length} 个文件：\n`);
for (const h of hits) {
  console.log(`  ${String(h.size).padStart(8)}  ${h.p}`);
}
fs.closeSync(fd);

// 把命中文件写到临时目录，方便后续读
const outDir = path.join(os.tmpdir(), "asar-grep");
fs.mkdirSync(outDir, { recursive: true });
for (const h of hits) {
  const flat = h.p.replace(/[/\\]/g, "__");
  fs.writeFileSync(path.join(outDir, flat), h.txt, "utf8");
}
console.log(`\n已写出到 ${outDir}`);
