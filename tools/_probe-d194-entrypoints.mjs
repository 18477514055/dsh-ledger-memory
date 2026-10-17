/**
 * 只读取证（D194）：**把"子命令/工具是怎么注册的"这条链路钉成可引用的行号。**
 *
 * ★ 为什么需要它：我这一轮为了加 `/ledger principles approve`，把这条链路**重新读了一遍**；
 *   而下次（或下一场会话）还会一字不变地需要同样的答案。
 *   ⇒ 与其记在脑子里，不如**当场把行号取准**，写进 `LESSONS.md` 的经验条目（带出处）。
 * ★ 纪律 9：函数名+行号看起来最硬、最容易凭印象编 ⇒ **报之前必须真的取一次**（本探针就是这个动作）。
 *
 * 跑法：node tools/_probe-d194-entrypoints.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const files = ["lib/index.js", "lib/client.js", "tools/selftest.mjs"];
const anchors = [
  // ── 子命令 ──
  "const LEDGER_SUBCOMMANDS = [",
  "function ledgerInputHint()",
  "function ledgerCommandDescription()",
  "function ledgerHelpText(",
  "async function pickLedgerSub(",
  "async function runLedgerSub(",
  "async function handleLedgerCommand(",
  // ── 命令注册 ──
  'ctx.inject(["commands"]',
  'name: "ledger",',
  // ── 工具注册 ──
  "for (const [label, factory] of [",
  "const d = ctx.tools.register(factory());",
  // ── 原则那条链（D180/D193）──
  "function writePrinciples(",
  "function proposePrinciple(",
  "function applyPrincipleProposal(",
  "function findPendingProposal(",
  "function pendingProposals(",
  "const PRINCIPLE_AUTH_TTL_MS",
  "const PRINCIPLE_APPROVE_TIMEOUT_MS",
  "const PRINCIPLE_GRANT_TOOL",
  // ── 经验教训（D192/D194）──
  "const LESSON_TYPES",
  "const LESSON_KINDS",
  "const EXPERIENCE_KINDS",
  "function parseLessonEntries(",
  "function renderLessonEntry(",
  "function defineLessonsTool(",
  // ── 注入 ──
  "function renderBlockInjection(",
  "function armReinject(",
  "export const inject =",
];

console.log("═".repeat(78));
console.log("注册点 / 入口 —— 实测行号（取证时间：由本探针运行时取得）");
console.log("═".repeat(78));
for (const f of files) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) {
    console.log(`\n── ${f}（不存在，跳过）`);
    continue;
  }
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const hits = [];
  for (const a of anchors) {
    const i = lines.findIndex((l) => l.includes(a));
    if (i >= 0) hits.push({ ln: i + 1, a });
  }
  if (hits.length === 0) continue;
  console.log(`\n── ${f}（${lines.length} 行）`);
  for (const h of hits) console.log(`  L${String(h.ln).padStart(6)}  ${h.a}`);
}

console.log("\n" + "═".repeat(78));
console.log("★ 引用写法（写进 LESSONS.md 的出处字段时就照这个抄）：");
console.log("   lib/index.js:14443 等 —— ★ 行号会随改动漂移，所以出处只用来「快速定位」，");
console.log("   真正的锚是**那一行的内容**（探针会连内容一起复核）。");
