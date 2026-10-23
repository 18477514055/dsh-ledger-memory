#!/usr/bin/env node
/**
 * ★★★★★ 反向验证 D312：**发布前文案审计的判据真的会红吗？**
 *
 * 本项目纪律 10：**反向验证必须摘到"能看见红"为止。**
 *
 * 这套判据是**新补的**（D224 证明旧探针漏掉了面板 UI 与注入脚注），
 * 而它现在 23/23 全绿。**"新探针一上来就全绿"是最需要怀疑的状态** ——
 * 必须证明它在**真过时**时会红，否则它就是一堆好看的摆设。
 *
 * ★ 在一次性副本上做（纪律：验破坏绝不在生产工作区里做）。
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
  if (cond) { pass += 1; console.log(`  ✓ ${n}${d ? `  —— ${d}` : ""}`); }
  else { fail += 1; console.log(`  ✗ ${n}${d ? `  —— ${d}` : ""}`); }
};

console.log("═".repeat(78));
console.log("反向验证 D312：发布前文案审计的判据会红吗");
console.log("═".repeat(78));

function makeCopy(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `d312-${tag}-`));
  fs.cpSync(path.join(PROJECT, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(path.join(PROJECT, "tools", "_probe-publish-copy-audit.mjs"), path.join(dir, "tools", "_probe-publish-copy-audit.mjs"));
  fs.copyFileSync(path.join(PROJECT, "README.md"), path.join(dir, "README.md"));
  fs.copyFileSync(path.join(PROJECT, "package.json"), path.join(dir, "package.json"));
  return dir;
}

/** 跑副本里的探针，返回 { status, failed: [失败断言标签] } */
function runAudit(dir) {
  let out = "";
  let status = 0;
  try {
    out = execFileSync(process.execPath, [path.join(dir, "tools", "_probe-publish-copy-audit.mjs")], {
      encoding: "utf8", timeout: 180000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = String(e?.stdout ?? "");
    status = typeof e?.status === "number" ? e.status : 1;
  }
  // 失败清单在 "未通过：" 之后
  const tail = out.split("未通过：")[1] ?? "";
  const failed = tail.split("\n").filter((l) => /^\s*✗/.test(l)).map((l) => l.replace(/^\s*✗\s*/, "").trim());
  return { status, failed, out };
}

// ── 基线 ──────────────────────────────────────────────────────────────────
console.log("\n【基线】不改任何东西 ⇒ 必须 0 FAIL\n");
{
  const dir = makeCopy("base");
  try {
    const r = runAudit(dir);
    ok("基线：探针退出码 0", r.status === 0, `status=${r.status}`);
    ok("基线：没有失败项", r.failed.length === 0, r.failed.join(" | ") || "无");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── A：把 package.json description 改回「7 种模式」⇒ A1b 必须红 ─────────────
console.log("\n【A】description 改回「7 种模式」⇒ A1b 必须红\n");
{
  const dir = makeCopy("desc7");
  try {
    const p = path.join(dir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    pkg.description = pkg.description.replace("6 种模式", "7 种模式");
    fs.writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    const r = runAudit(dir);
    const hit = r.failed.some((f) => /A1b/.test(f));
    ok("A1 description=7 种 ⇒ A1b 见红", hit, hit ? "✅" : `❌ 没红（失败项：${r.failed.join(" | ") || "无"}）`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── B：把 part6 的注入文案改回「原则型」⇒ B 必须红（D224 那个面）───────────
console.log("\n【B】part6 注入文案改回「原则型」⇒ B 必须红（这正是旧探针漏掉的面）\n");
{
  const dir = makeCopy("part6principle");
  try {
    const p = path.join(dir, "lib", "part6.js");
    let s = fs.readFileSync(p, "utf8");
    // ★★★ 这里必须**只改真正那行代码**，不能 `String.replace` 全文替换。
    //   🔴 我第一版就是全文 `replace(...)` —— 而那串文字在 part6 里**出现两次**
    //     （:343 是注释、:366 才是真文案）。`replace` 默认只换**第一处** ⇒
    //     改中的是**注释**，而判据剥掉注释 ⇒ **当然不红**。
    //   ★ 更危险的是：我差点据此判定"B 判据是摆设" —— 实际是**我的反向探针没改到点子上**。
    //     ⇒ 判据：**反向验证失败时，先怀疑"破坏真的发生了吗"**（与纪律 7 同型：
    //       结论与已手工验证过的事实冲突时，先怀疑尺子）。
    const lines = s.split("\n");
    let hitLine = -1;
    lines.forEach((l, i) => {
      // 只认**代码行**：含 push(EXTENSIONS_DIR 且不是注释开头
      if (/push\(EXTENSIONS_DIR/.test(l) && !/^\s*\/\//.test(l)) hitLine = i;
    });
    if (hitLine < 0) throw new Error("找不到 push(EXTENSIONS_DIR 的代码行 —— 反向探针自己的问题");
    lines[hitLine] = lines[hitLine].replace(
      "（决策型 / 目标树型 / 经验教训型 / 流水型 …）",
      "（原则型 / 决策型 / 目标树型 …）"
    );
    s = lines.join("\n");
    fs.writeFileSync(p, s, "utf8");
    // ★ 自证：破坏**真的发生了**（否则下面的"没红"是个假结论）
    const injected = fs.readFileSync(p, "utf8").split("\n").some((l) => /push\(EXTENSIONS_DIR/.test(l) && /原则型/.test(l));
    ok("B0 破坏真的注入了（代码行里出现「原则型」）", injected, injected ? "" : "⛔ 没注入成功 ⇒ 下面的判断无效");
    const r = runAudit(dir);
    const hit = r.failed.some((f) => /extension-principles-mode/.test(f));
    ok("B1 part6 注入文案写回「原则型」⇒ B 见红", hit, hit ? "✅ 旧探针漏掉的那个面，新判据抓到了" : `❌ 没红（${r.failed.join(" | ") || "无"}）`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── C：造一个"只在 defs.js 声明、全库无人读"的死开关 ⇒ C/C-c 必须红 ────────
console.log("\n【C】造一个死开关（只在 defs 声明）⇒ C / C-c 必须红\n");
{
  const dir = makeCopy("deadswitch");
  try {
    const p = path.join(dir, "lib", "defs.js");
    let s = fs.readFileSync(p, "utf8");
    // 往 SETTING_SPECS 里塞一个谁也不读的 key
    const anchor = "SETTING_SPECS = [";
    const i = s.indexOf(anchor);
    if (i < 0) throw new Error("找不到 SETTING_SPECS");
    const inject = `${anchor}\n  { key: "ghostDeadSwitch", kind: "bool", group: "ledger", label: "幽灵开关", hint: "谁都不读它。" },`;
    s = s.slice(0, i) + inject + s.slice(i + anchor.length);
    fs.writeFileSync(p, s, "utf8");
    const r = runAudit(dir);
    const hit = r.failed.some((f) => /死开关|ghostDeadSwitch/.test(f));
    ok("C1 死开关 ⇒ C/C-c 见红", hit, hit ? "✅" : `❌ 没红（${r.failed.join(" | ") || "无"}）`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── D：把全量压缩线默认值改成 0.5 ⇒ C2d 必须红 ─────────────────────────────
console.log("\n【D】全量压缩线默认值改成 0.5 ⇒ C2d 必须红（期望值是 0.7）\n");
{
  const dir = makeCopy("ratio");
  try {
    const p = path.join(dir, "lib", "part1.js");
    let s = fs.readFileSync(p, "utf8");
    s = s.replace("highFidelityCompactRatio: HIGH_FIDELITY_COMPACT_RATIO,", "highFidelityCompactRatio: 0.5,");
    fs.writeFileSync(p, s, "utf8");
    const r = runAudit(dir);
    const hit = r.failed.some((f) => /C2d/.test(f));
    ok("D1 压缩线=0.5 ⇒ C2d 见红", hit, hit ? "✅" : `❌ 没红（${r.failed.join(" | ") || "无"}）`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── E：删掉 part6 的存在性判断 ⇒ D 必须红 ──────────────────────────────────
console.log("\n【E】删掉 part6 的 extensions 存在性判断 ⇒ D 必须红\n");
{
  const dir = makeCopy("noexists");
  try {
    const p = path.join(dir, "lib", "part6.js");
    let s = fs.readFileSync(p, "utf8");
    s = s.replace("exists = fs.existsSync(abs) && fs.statSync(abs).isDirectory();", "exists = true;");
    fs.writeFileSync(p, s, "utf8");
    const r = runAudit(dir);
    const hit = r.failed.some((f) => /\bD\b.*extensions/.test(f));
    ok("E1 去掉存在性检查 ⇒ D 见红", hit, hit ? "✅" : `❌ 没红（${r.failed.join(" | ") || "无"}）`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log("\n" + "═".repeat(78));
console.log(`合计：${pass} PASS / ${fail} FAIL`);
console.log(fail === 0 ? "✓ 五种破坏都能看见红 ⇒ 这套判据不是摆设" : "⛔ 有摘了不红的 —— 那几条必须加强");
console.log("═".repeat(78));
process.exit(fail === 0 ? 0 : 1);
