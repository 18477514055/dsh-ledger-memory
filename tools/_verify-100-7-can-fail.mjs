#!/usr/bin/env node
/**
 * 反向验证：情形 100⑦ 那组「结构布局走内联 style」的断言，**真的能变红**。
 *
 * ★★★ 为什么必须做这件事（本项目的硬纪律，纪律 10）：
 *   **反向验证必须摘到「能看见红」为止。** 摘一处不红，要么断言太弱、要么修复冗余，
 *   两种都要查清。只看「全绿」永远证明不了断言有区分力。
 *
 * ★★ 做法（安全第一）：
 *   ① 先把 lib/client.js 读进内存，记 sha256，并写一份 %TEMP% 备份；
 *   ② 逐个**变异**（mutation）写回真文件 → 跑 `node tools/selftest.mjs` →
 *      检查目标断言是否出现 `FAIL`；
 *   ③ `finally` 里把原始字节**原样写回**，并校验 sha256 与开始时一致。
 *      ★ 任何一步抛异常都会走 finally ⇒ 文件不会被留在变异状态。
 *   ⚠️ 这也是唯一能证明「断言读的是真源码」的办法 —— 在内存里跑正则只能证明
 *      「我的正则能匹配我拼的字符串」，那是我测我自己（纪律 2 的同型错误）。
 *
 * ★ 用法：node tools/_verify-100-7-can-fail.mjs
 *   退出码 0 = 每个变异都成功让目标断言变红，且文件已还原。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TARGET = path.join(ROOT, "lib", "client.js");
const SELFTEST = path.join(ROOT, "tools", "selftest.mjs");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** 每个变异：{ name, from, to, expectFail } —— expectFail 是必须出现的那条断言的标题片段。 */
const MUTATIONS = [
  {
    name: "① 摘掉 Row 根节点的内联 style",
    from: `h("div", { className: cls, style: rowStyle }, [`,
    to: `h("div", { className: cls }, [`,
    expectFail: "100⑦ ★ Row 根节点带内联 style",
  },
  {
    name: "② 普通行的 display 从 grid 改回 block",
    from: `            display: "grid",`,
    to: `            display: "block",`,
    expectFail: "100⑦ b 普通行 display 内联为 grid",
  },
  {
    name: "③ 控件列不再内联定位（去掉 style: ctlStyle）",
    from: `h("div", { key: "c", className: "pl-settings__ctl", style: ctlStyle }, props.children)`,
    to: `h("div", { key: "c", className: "pl-settings__ctl" }, props.children)`,
    expectFail: "100⑦ e 控件列内联 style 且定位到第 2 列",
  },
  {
    name: "④ 数值簇允许换行（nowrap → wrap）",
    from: `                flexWrap: "nowrap",
                gap: "8px",
                flex: "none",`,
    to: `                flexWrap: "wrap",
                gap: "8px",
                flex: "none",`,
    expectFail: "100⑦ j ★ 数值簇内联 nowrap + row",
  },
  {
    name: "⑤ 滑块宽度不再走变量（写死 72px）",
    from: `              width: "var(--pl-num-w, 72px)",
              minWidth: 0,
              maxWidth: "var(--pl-num-w, 72px)",
              margin: 0,`,
    to: `              width: "72px",
              minWidth: 0,
              maxWidth: "72px",
              margin: 0,`,
    expectFail: "100⑦ h ★ 滑块自己的宽度取自 --pl-num-w",
  },
  {
    name: "⑥ 把 display:contents 加回 **CSS 模板**（这是真实回归路径）",
    from: `.pl-settings__row--stack { flex-direction: column; align-items: stretch; }`,
    to: `.pl-settings__row--stack { flex-direction: column; align-items: stretch; }\n.pl-settings__main { display: contents; }`,
    expectFail: "100⑦ m2 ★ CSS 里也不许出现 display:contents",
  },
  {
    name: "⑥b 把 display:contents 加回 **JS 内联 style**",
    from: `      const labelStyle = {
        display: "flex",`,
    to: `      const labelStyle = {
        display: "contents",`,
    expectFail: "100⑦ m ★ JS 侧不许出现 display:contents",
  },
];

const original = fs.readFileSync(TARGET);
const originalHash = sha(original);
const backupPath = path.join(
  os.tmpdir(),
  `client.js.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`
);
fs.writeFileSync(backupPath, original);

console.log("═".repeat(72));
console.log("反向验证：情形 100⑦ 的断言能不能变红");
console.log(`目标文件 : ${TARGET}`);
console.log(`原始 sha : ${originalHash}`);
console.log(`备份     : ${backupPath}`);
console.log("═".repeat(72));

const text = original.toString("utf8");
let failures = 0;

function runSelftest() {
  // ★ 只取输出，不抛（selftest 在有 FAIL 时退出码非 0，那是预期）。
  try {
    return execFileSync(process.execPath, [SELFTEST], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return String((e.stdout || "") + (e.stderr || ""));
  }
}

try {
  // ── 基线：未变异时必须全绿（否则下面的"变红"证明不了任何事） ──────────
  const baseline = runSelftest();
  const baselineFails = (baseline.match(/^\s*FAIL\s/gm) || []).length;
  if (baselineFails !== 0) {
    console.log(`\n✗ 基线就不是全绿（FAIL ${baselineFails} 条）⇒ 反向验证无意义，中止。`);
    process.exitCode = 1;
    throw new Error("baseline not green");
  }
  console.log(`\n✓ 基线全绿（FAIL 0 条）⇒ 下面每个变异都必须让指定断言变红\n`);

  for (const m of MUTATIONS) {
    const hits = text.split(m.from).length - 1;
    if (hits !== 1) {
      console.log(`✗ ${m.name}`);
      console.log(`    锚点命中 ${hits} 次（必须恰好 1 次）⇒ 源码已变，本脚本需更新`);
      failures += 1;
      continue;
    }
    fs.writeFileSync(TARGET, text.replace(m.from, m.to), "utf8");
    const out = runSelftest();
    const red = out.includes("FAIL") && out.includes(m.expectFail);
    // 还要确认：**是这条断言**变红，不是别的什么崩了
    const anyFail = /^\s*FAIL\s/gm.test(out);
    if (red && anyFail) {
      console.log(`✓ ${m.name}`);
      console.log(`    ⇒ 目标断言变红：${m.expectFail}`);
    } else {
      console.log(`✗ ${m.name}`);
      console.log(`    ⇒ 期望「${m.expectFail}」变红，实际${anyFail ? "红了别的" : "全绿"}（断言没有区分力）`);
      failures += 1;
    }
    // 每个变异之后立刻还原，缩小"留在变异状态"的窗口
    fs.writeFileSync(TARGET, original);
  }
} finally {
  fs.writeFileSync(TARGET, original);
  const afterHash = sha(fs.readFileSync(TARGET));
  const restored = afterHash === originalHash;
  console.log("\n" + "─".repeat(72));
  console.log(`还原校验：${restored ? "✓ sha256 与原始一致" : "✗ 文件与原始不一致！"}`);
  console.log(`  原始 ${originalHash}`);
  console.log(`  现在 ${afterHash}`);
  if (!restored) failures += 1;
  console.log("─".repeat(72));
  console.log(failures === 0 ? "全部变异都成功让断言变红，文件已还原。" : `有 ${failures} 项未达预期。`);
  process.exitCode = failures === 0 ? 0 : 1;
}
