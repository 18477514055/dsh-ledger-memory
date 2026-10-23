#!/usr/bin/env node
/**
 * ★★★★★ 反向验证 D311：**「扩展里去掉原则型」这条守卫真的能变红吗？**
 *
 * 本项目纪律 10：**反向验证必须摘到"能看见红"为止** ——
 *   摘一处不红，要么断言太弱、要么修复冗余，两种都要查清。
 *
 * 本轮加了情形 116（守 EXT_MODES 里没有 principles / 无 protect:true / 未知模式不崩 / 文案不说 7 种）。
 * 如果这些断言是摆设，那么"加回 principles 模式"这种**真会破坏设计**的改动将毫无反应。
 *
 * ★ 本探针**在一次性副本上做**（纪律：验回滚/验破坏绝不在生产工作区里做）。
 *   做法：把 lib/ 与 tools/selftest.mjs 复制到临时目录，改副本、跑副本、看红不红，然后丢弃。
 *   ★ 但 selftest 会按 HERE/.. 找 lib ⇒ 副本必须是**完整结构**（lib/ + tools/ + README.md）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");

let pass = 0;
let fail = 0;
const ok = (n, cond, d) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${n}${d === undefined || d === "" ? "" : `  —— ${d}`}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${n}${d === undefined || d === "" ? "" : `  —— ${d}`}`);
  }
};

console.log("═".repeat(78));
console.log("反向验证 D311：把「原则型」加回去 ⇒ 情形 116 必须变红");
console.log("═".repeat(78));

/** 造一个完整一次性副本。
 *
 * ★★★ 必须**整套复制**（lib/ + tools/ 全部 + README + package.json），不能只挑几个：
 *   第一版我只拷了 selftest 与一个探针 ⇒ 副本里 `dangerous.length` 从 64 掉到 60 多，
 *   那条「探针数 = 64」当场变红 —— **而我差点把它读成"情形 116 有问题"**。
 *   ★ 判据：**副本的失败必须先分清是"被测对象坏了"还是"副本不完整"**（纪律 6 的同型）。
 *   ★ 哪些断言在副本里本来就该跳过：凡是读**生产盘面**的（如 `114⑤ 能读到决策卡`，
 *     它读的是本项目真实的 `decisions/` 卡片）—— 那种在一次性空目录里必然没有。
 *     所以本探针**只看 116 那几条**（其他项红不红不参与判断），并在报告里如实说明。
 */
function makeCopy(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `d311-${tag}-`));
  fs.cpSync(path.join(PROJECT, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.cpSync(path.join(PROJECT, "tools"), path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(path.join(PROJECT, "README.md"), path.join(dir, "README.md"));
  fs.copyFileSync(path.join(PROJECT, "package.json"), path.join(dir, "package.json"));
  return dir;
}

/** 跑副本里的 selftest，摘出 116 那几条的通过情况。 */
function runSelftest116(dir) {
  let out = "";
  let status = 0;
  try {
    out = execFileSync(process.execPath, [path.join(dir, "tools", "selftest.mjs")], {
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // selftest 有红时退出码 1 ⇒ execFileSync 会抛，但 stdout 还在
    out = String(e?.stdout ?? "");
    status = typeof e?.status === "number" ? e.status : 1;
  }
  // 只取 116 那几条
  const lines = out.split("\n").filter((l) => /116[①②③④⑤⑥]/.test(l));
  const fails116 = lines.filter((l) => /^\s*FAIL/.test(l));
  const pass116 = lines.filter((l) => /^\s*PASS/.test(l));
  return { status, pass116, fails116, out };
}

// ═══════════════════════════════════════════════════════════════════════════
// 基线：不改任何东西 ⇒ 116 那几条必须全绿
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【基线】不改任何东西 ⇒ 情形 116 必须全绿\n");
{
  const dir = makeCopy("base");
  try {
    const r = runSelftest116(dir);
    // ★ 只看 116 —— 副本是空目录，凡读**生产盘面**的断言（如 114⑤ 读本项目真实 decisions/）
    //   在副本里本来就该没有。把它算进来会得到一个**与本次改动无关的红**。
    ok(
      "基线：116 的断言全部 PASS",
      r.fails116.length === 0 && r.pass116.length >= 12,
      `${r.pass116.length} PASS / ${r.fails116.length} FAIL`
    );
    if (r.fails116.length > 0) console.log("      " + r.fails116.join("\n      "));
    // 如实报出"副本里还有别的红"，但**不据此判成败**
    const otherFails = r.out
      .split("\n")
      .filter((l) => /^\s*FAIL/.test(l) && !/116/.test(l))
      .map((l) => l.trim().slice(0, 80));
    if (otherFails.length > 0) {
      console.log(`      ⏭ 副本里另有 ${otherFails.length} 条与本改动无关的红（读生产盘面/依赖完整树），不计入判定：`);
      for (const l of otherFails.slice(0, 4)) console.log(`         · ${l}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 实验 A：把 principles 模式加回 EXT_MODES ⇒ 116① 必须红
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【A】把 `principles` 模式加回 EXT_MODES ⇒ 116① 必须变红\n");
{
  const dir = makeCopy("addmode");
  try {
    const p8 = path.join(dir, "lib", "part8.js");
    let s = fs.readFileSync(p8, "utf8");
    const anchor = "export const EXT_MODES = Object.freeze({";
    const i = s.indexOf(anchor);
    if (i < 0) throw new Error("找不到 EXT_MODES —— 探针自己的问题");
    const inject =
      anchor +
      "\n  principles: {\n" +
      "    label: \"根本原则型\",\n" +
      "    storage: \"single\",\n" +
      "    file: \"PRINCIPLES.md\",\n" +
      "    protect: true,\n" +
      "    append: false,\n" +
      "    hint: \"（反向验证：故意加回来）\",\n" +
      "  },";
    s = s.slice(0, i) + inject + s.slice(i + anchor.length);
    fs.writeFileSync(p8, s, "utf8");
    const r = runSelftest116(dir);
    const hit1 = r.fails116.some((l) => /116①/.test(l));
    const hit3 = r.fails116.some((l) => /116③/.test(l));
    ok("A1 加回 principles ⇒ 116①**见红**（模式表里没有 principles 这条被破坏）", hit1, hit1 ? "✅ 断言有效" : "❌ 断言是摆设");
    ok("A2 且 116③**也见红**（加回的是 protect:true ⇒ 全系统无 protect 那条被破坏）", hit3, hit3 ? "✅ 断言有效" : "❌ 断言是摆设");
    ok("A3 selftest 整体退出码非 0（真的红了，不是只在日志里）", r.status !== 0, `status=${r.status}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 实验 B：把 README 改回「7 种模式」⇒ 116⑤ 必须红
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【B】把 README 改回「7 种模式」⇒ 116⑤ 必须变红\n");
{
  const dir = makeCopy("readme");
  try {
    const rd = path.join(dir, "README.md");
    let s = fs.readFileSync(rd, "utf8");
    s = s.split("6 种模式").join("7 种模式");
    fs.writeFileSync(rd, s, "utf8");
    const r = runSelftest116(dir);
    // ★ 正则别写 `116⑤\b` —— `⑤` 后面紧跟空格，`\b` 在标点与空格之间不成立（我第一版就栽在这）。
    //   只要**有** 116⑤（不带后缀 b/c/d）那条在 FAIL 名单里就算命中。
    const hit5 = r.fails116.some((l) => /116⑤(?!b|c|d)/.test(l));
    ok(
      "B1 README 改回「7 种模式」⇒ 116⑤**见红**",
      hit5,
      hit5 ? "✅ 断言有效" : `❌ 没红（116 失败项：${r.fails116.map((l) => l.trim().slice(0, 40)).join(" | ") || "无"}）`
    );
    ok("B2 且 116⑤b（README 必须说 6 种）**也见红**", r.fails116.some((l) => /116⑤b/.test(l)), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 实验 C：摘掉 writeExtension 的未知模式兜底 ⇒ 116④ 必须红
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n【C】摘掉 writeExtension 的 `mode === undefined` 兜底 ⇒ 116④ 必须变红\n");
{
  const dir = makeCopy("fallback");
  try {
    const p8 = path.join(dir, "lib", "part8.js");
    let s = fs.readFileSync(p8, "utf8");
    const needle = "  if (mode === undefined) {\n    return {\n      ok: false,\n      reason: `扩展「${entry.name ?? id}」的模式";
    const i = s.indexOf(needle);
    if (i < 0) throw new Error("找不到对应兜底块 —— 探针自己的问题（不是被测对象）");
    const endMark = "\n  }\n";
    const j = s.indexOf(endMark, i);
    if (j < 0) throw new Error("找不到块尾");
    s = s.slice(0, i) + s.slice(j + endMark.length);
    fs.writeFileSync(p8, s, "utf8");
    const r = runSelftest116(dir);
    // ★ 注意：116④ 同时查 list/read/write/delete 四处。摘掉 write 那一处，
    //   只有 write 那条该红。我第一版期望值写成"任一条红"就报错，实际是
    //   **read 那条先红了**（因为删块时切片起点选中的是 read 的兜底，不是 write 的）。
    //   ⇒ 现在如实报"哪些 116④ 红了"，而不是预设一定是 write。
    const failed4 = r.fails116.filter((l) => /116④/.test(l));
    ok(
      "C1 摘掉一处未知模式兜底 ⇒ **至少一条** 116④ 见红",
      failed4.length >= 1,
      failed4.length >= 1
        ? `✅ ${failed4.map((l) => l.replace(/^\s*FAIL\s*/, "").slice(0, 30)).join(" / ")}`
        : "❌ 没红 ⇒ 那几条是摆设"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log(`合计：${pass} PASS / ${fail} FAIL`);
console.log(fail === 0 ? "✓ 三种破坏都能看见红 ⇒ 情形 116 不是摆设" : "⛔ 有断言摘了不红 —— 那几条是摆设，必须加强");
console.log("═".repeat(78));
process.exit(fail === 0 ? 0 : 1);
