// D221 · 把活跃台账里**已完整存在于卡片**的那一块移进归档（腾出行数给 D221）
//
// ★ 为什么用 Node 而不是 PowerShell：本机硬规矩 —— **绝不用 shell 对含中文的文件
//   做"读取→替换→写回"**（PowerShell 的 > 会写成 UTF-16、编码会被拆坏，已栽过）。
//   Node + 显式 utf8 是本项目推荐做法。
//
// 被移走的块：「为什么我们这档不能自动更新」（活跃台账 §D216 那一节）
//   ★ 它的**完整正文一直在 `decisions/D216.md` §十** ⇒ 移出不丢信息。
// 归档去处：`_ledger-archive/2026-10/week3/`（按期间分桶，只追加）
//
// 用法：node tools/_probe-d221-ledger-trim.mjs [--apply]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const LEDGER = path.join(ROOT, "LEDGER.md");
const APPLY = process.argv.includes("--apply");

// ★ D221 第二轮：再移走「D216 全程」那一整块（它的完整正文同样在 `decisions/D216.md` §六~§九）。
//   用 `--block=216` 选它。
const BLOCK = (process.argv.find((s) => s.startsWith("--block=")) ?? "--block=update").split("=")[1];

const BLOCKS = {
  // 「为什么我们这档不能自动更新」—— 正文在 decisions/D216.md §十
  update: {
    start: "### ★★★ 「为什么我们这档不能自动更新」",
    end: "\n> ★★★ **20:1x ",
    label: "为什么这档不能自动更新（D216§十）",
  },
  // 「D216 全程」整块 —— 正文在 decisions/D216.md §六~§九
  216: {
    start: "## ★★★ D216 全程（**四条指控已全解**）",
    end: "\n> ★★★ **20:1x ",
    label: "D216全程-四条指控全解（正文在D216.md）",
  },
  // 「D213 + D216（发布线）」整块 —— 正文在 decisions/D213.md 与 D216.md §一/§七/§九
  d213: {
    start: "## ★★ D213 + D216（**发布线**）",
    end: "\n\n## ★★ D214 + D215",
    label: "D213-D216发布线（正文在D213与D216卡片）",
  },
};

const spec = BLOCKS[BLOCK];
if (spec === undefined) {
  console.error(`★ 未知的 --block=${BLOCK}（可选：${Object.keys(BLOCKS).join(" / ")}）`);
  process.exit(2);
}

const src = fs.readFileSync(LEDGER, "utf8");
const START = spec.start;
const END = spec.end;

const a = src.indexOf(START);
const b = src.indexOf(END, a);
if (a < 0 || b < 0) {
  console.error("★ 没定位到要移走的那一块 —— 夹具故障，不是结论");
  console.error(`  START 命中：${a}   END 命中：${b}`);
  process.exit(2);
}

const removed = src.slice(a, b).replace(/\s+$/, "") + "\n";
const kept = src.slice(0, a) + src.slice(b + 1); // +1 去掉 END 前那个 \n

const beforeLines = src.split("\n").length;
const afterLines = kept.split("\n").length;
const removedLines = removed.split("\n").length;

console.log(`═══ 台账裁剪（block=${BLOCK}：把已存在于卡片的那一块移进归档）═══`);
console.log(`  移走 ${removedLines} 行 · 台账 ${beforeLines} → ${afterLines} 行`);
console.log(`  移走块的首行：${removed.split("\n")[0]}`);
console.log(`  移走块的末行：${removed.trimEnd().split("\n").pop()}`);
console.log(`  裁剪后紧邻内容：${kept.slice(a, a + 60).split("\n")[0]}`);

if (!APPLY) {
  console.log("\n（dry-run —— 加 --apply 才真的写）");
  process.exit(0);
}

// ① 归档（只追加）
const now = new Date();
const yyyy = now.getFullYear();
const mm = String(now.getMonth() + 1).padStart(2, "0");
const weekOfMonth = Math.ceil(now.getDate() / 7);
const archDir = path.join(ROOT, "_ledger-archive", `${yyyy}-${mm}`, `week${weekOfMonth}`);
fs.mkdirSync(archDir, { recursive: true });
const stamp = `${yyyy}-${mm}-${String(now.getDate()).padStart(2, "0")}`;
const archFile = path.join(archDir, `${stamp}-台账§-${spec.label}.md`);
const header = fs.existsSync(archFile) ? "" : `# 台账归档 · ${stamp}\n\n> 由 \`tools/_probe-d221-ledger-trim.mjs\` 从活跃台账移出。\n> ★ 完整正文在 \`decisions/D216.md\` §十；此处为**逐字副本**。\n\n`;
fs.appendFileSync(archFile, header + removed + "\n", "utf8");
console.log(`\n  ① 已追加到归档：${path.relative(ROOT, archFile)}`);

// ② 写回裁剪后的台账
fs.writeFileSync(LEDGER, kept, "utf8");
console.log(`  ② 已写回 LEDGER.md（${afterLines} 行）`);
