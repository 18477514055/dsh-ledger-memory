/**
 * ★★★ D61 真机判据（修正版 —— 我上一版把「报错」也数成了「原话」，是尺子错）。
 *
 * 判据分三层，逐层看：
 *   ① **D61 的代码是否活着**：`capsules.json` 只由**新代码**创建 ⇒ 它存在 = 新代码在跑。
 *   ② **素材有没有被保住**：capsules.json 里有没有「重启之前」的原话。
 *   ③ 若②为空，**为什么空** —— 是"没机会"还是"机制没生效"。
 *
 * ★ 关键背景（时间线）：
 *   · 04:51:42 内核启动（那时**还没有** D61 代码，lib 的 D61 修改在 04:58）
 *   · 05:06:15 一次压缩 → 但跑的是**旧代码** ⇒ 不会写 capsules.json
 *   · 05:30:22 内核**再次**启动（这次才加载 D61 代码）
 *   · 05:39:14 压缩 → **第一次**由新代码写 capsules.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ★★ 2026-10-15（D216）：原来硬编码本机绝对路径 ⇒ 改成**从本文件位置推**（跨机器都对、且不泄露本机路径）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAPS = path.join(ROOT, "_ledger-log/2026-10/week2/capsules");
const BT = String.fromCharCode(96);
const RESTART = new Date("2026-10-11T05:30:22+08:00").getTime();

// ── ① 代码活着吗 ──────────────────────────────────────────────────────────
const storePath = path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "capsules.json");
const exists = fs.existsSync(storePath);
console.log("① D61 代码是否活着");
console.log(`   capsules.json 存在: ${exists ? "★ 是" : "✗ 否"}（该文件**只由新代码**创建）`);
if (exists) {
  const st = fs.statSync(storePath);
  console.log(`   首次可见写入时间: ${st.mtime.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })}`);
}

// ── ② 只数「用户原话」那一段（**不数报错**）────────────────────────────────
console.log("\n② 胶囊里的原话（只看「用户原话」小节）");
for (const f of fs.readdirSync(CAPS).sort()) {
  const t = fs.readFileSync(path.join(CAPS, f), "utf8");
  // 切出「用户原话」小节，到下一个 ### 为止
  const seg = t.split(/^### /m).find((s) => s.startsWith("用户原话"));
  const quotes = seg === undefined ? [] : [...seg.matchAll(new RegExp("^- " + BT + "(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})", "gm"))].map((m) => m[1]);
  const pre = quotes.filter((q) => new Date(q.replace(" ", "T") + "+08:00").getTime() < RESTART);
  console.log(`   ${f}  原话=${String(quotes.length).padStart(2)}  其中「重启前」=${pre.length}  ${pre.length ? "★ 保住了" : ""}`);
}

// ── ③ capsules.json 里存了什么 ────────────────────────────────────────────
if (exists) {
  console.log("\n③ capsules.json 里存的素材");
  const j = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const [sid, v] of Object.entries(j.bySession ?? {})) {
    const qs = v.userMessages ?? [];
    const pre = qs.filter((m) => new Date(String(m.at).replace(" ", "T") + "+08:00").getTime() < RESTART);
    console.log(`   ${sid}：原话 ${qs.length} 条，其中「重启前」=${pre.length}`);
    for (const m of qs) console.log(`      ${m.at} | ${String(m.text).slice(0, 50)}`);
  }
}

console.log("\n═══ 结论 ═══");
console.log("  ① 代码活着：capsules.json 由新代码创建 ⇒ 见上（存在即 alive）");
console.log("  ② 重启前原话：见上 —— 若为 0，看 ③ 的理由");
console.log("  ★ 大概率理由：**上一次重启是「杀进程」，不触发 agent/disposed**，");
console.log("     而 D61 只在「压缩前」与「disposed 时」落盘 ⇒ 杀进程前那段没来得及存。");
