// D227③ · 修好的描述提取器（只读）
// ★ 上一版错在哪：我写的正则 `name:\s*"<tool>"[\s\S]{0,900}?description:` 是**跨文件**扫的，
//   而 `[\s\S]{0,900}` 会**越过本工具的边界**抓到后面某个工具的 description ⇒ 21 个全同一个答案。
//   ★ 这正是本项目纪律：「判据的输入必须是被测对象自己产生的那部分」——不许跨界抓。
// ⇒ 正确做法：**按 `name: "<tool>"` 切开，只在本段内找 description**。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const files = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));
const TOOLS = ["ledger_status","ledger_init","ledger_read","ledger_write","ledger_archive","ledger_log",
  "ledger_recall","ledger_log_write","ledger_note","ledger_handoff","ledger_triage","ledger_lock",
  "ledger_conform","ledger_migrate","ledger_index","ledger_propose_principle","ledger_principles_access",
  "ledger_goals","ledger_lessons","ledger_compact","ledger_checkpoint"];

// 把每个文件按 `name: "..."` 的位置切成段，每段 = 一个工具定义（到下一个 name: 为止）
const segments = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
  const marks = [...src.matchAll(/\bname:\s*("([a-z_]+)"|([A-Z_]+))/g)];
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    segments.push({ file: f, name: marks[i][2] ?? marks[i][3], text: src.slice(start, end) });
  }
}

console.log("【工具 → 它真正声称做什么（description）】\n");
const found = new Set();
for (const t of TOOLS) {
  const seg = segments.find((s) => s.name === t);
  if (seg === undefined) { console.log(`  ${t.padEnd(24)} ⚠️ 没定位到定义（需人工看）`); continue; }
  found.add(t);
  const m = seg.text.match(/description:\s*\n?\s*"((?:[^"\\]|\\.){20,400})"/);
  const d = m === null ? "(这段里没有 description 字符串，可能由别处拼的)" : m[1].replace(/\\n/g, " ").replace(/\s+/g, " ");
  console.log(`  ▸ ${t}  [${seg.file}]`);
  console.log(`      ${d.slice(0, 220)}`);
  console.log("");
}
const miss = TOOLS.filter((t) => !found.has(t));
if (miss.length) console.log(`⚠️ 未定位到：${miss.join(", ")}`);
