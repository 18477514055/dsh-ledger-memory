// D226 反向验证：把 92 那几条新判据**真的弄坏**，断言它们必须红。
// ★ 纪律 10：新守卫"当前源码全绿"等于没验 —— 必须把被测对象退回坏版本、看见红为止。
// ★ 纪律 L34：**必须同时断言"自检真跑完了"**（崩了与全绿长得一样）。
// ★ 纪律 L17：跑完**无条件还原**，并核对还原成功。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const runSelf = () => {
  try {
    return execFileSync(process.execPath, [path.join(HERE, "selftest.mjs")], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return String(e.stdout ?? "") + String(e.stderr ?? "");
  }
};

/** 每个实验：{文件, 找什么, 换成什么, 期望哪条断言红（子串）} */
const CASES = [
  {
    name: "92① 把「只影响新项目」塞回 client.js（非注释行）",
    file: "lib/client.js",
    from: '"pl-settings__tag" }, "⚠ 只影响本项目（清单说了算）"',
    to: '"pl-settings__tag" }, "⚠ 只影响新项目"',
    expect: "92①",
  },
  {
    name: "92③ 把项目优先警示的开关判断摘掉（去掉 projectFirst）",
    file: "lib/client.js",
    from: 'props.scopeNote === "project-first" && props.projectFirst === true\n            ? h(\n                "div",\n                { className: "pl-settings__scope-warn" },',
    to: 'props.scopeNote === "project-first"\n            ? h(\n                "div",\n                { className: "pl-settings__scope-warn" },',
    expect: "92③",
  },
  {
    name: "92⑤ 在 part3 里再写一遍「谁优先」判据（复发 D25 两个出口）",
    file: "lib/part3.js",
    from: "  const pf = precedenceIsProject();",
    to: '  const pf = currentSettings().settingPrecedence === "project";',
    expect: "92⑤",
  },
];

let allRed = 0;
for (const c of CASES) {
  const abs = path.join(ROOT, c.file);
  const original = fs.readFileSync(abs, "utf8");
  const idx = original.indexOf(c.from);
  console.log(`\n── ${c.name}`);
  if (idx < 0) {
    console.log("  ⚠️ 夹具故障：没找到要替换的那段（不是结论）⇒ 跳过");
    continue;
  }
  let out = "";
  try {
    fs.writeFileSync(abs, original.replace(c.from, c.to), "utf8");
    out = runSelf();
  } finally {
    fs.writeFileSync(abs, original, "utf8");
    const back = fs.readFileSync(abs, "utf8") === original;
    if (!back) console.log("  ★★ 还原失败 —— 立刻人工检查！");
  }
  const done = /通过\s+(-?\d+)\s+项，失败\s+(\d+)\s+项/.exec(out);
  if (done === null) {
    console.log("  ❌ 自检没跑完（没解析到总结行）⇒ 本次无效，不是结论");
    continue;
  }
  const red = out.includes("FAIL") && out.includes(c.expect);
  const line = (out.split("\n").find((l) => l.includes("FAIL") && l.includes(c.expect)) ?? "").trim();
  console.log(`  自检跑完：通过 ${done[1]} / 失败 ${done[2]}`);
  console.log(`  ${red ? "✅ 见红" : "❌ 没红（= 断言是空的）"}　${line.slice(0, 110)}`);
  if (red) allRed += 1;
}
console.log(`\n═══ 共 ${CASES.length} 项实验，见红 ${allRed} 项 ═══`);
process.exit(allRed === CASES.length ? 0 : 1);
