// D329：F-02 修复的**反向验证** —— 逐个摘掉修复点，探针必须见红。
// ★ 判据（D324）：反向验证必须摘到"能看见红"为止；崩溃冒充检出不算，
//   所以每个破坏点跑完都要求 `PROBE-COMPLETE` 出现且 FAIL > 0（不是"进程非零就判检出"）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "lib");

const BREAKS = [
  {
    name: "破坏1：saveSettings 不换算当前值（复原成 {...currentSettings(), ...patch}）",
    file: "settings-http.js",
    from: "normalizeSettings({ ...panelUnitsOf(currentSettings()), ...patch })",
    to: "normalizeSettings({ ...currentSettings(), ...patch })",
  },
  {
    name: "破坏2：读取视图不给面板换算（只有 settings 那半）",
    file: "settings-http.js",
    from: "settings: panelUnitsOf(currentSettings()),",
    to: "settings: currentSettings(),",
  },
  {
    name: "破坏2b：读取视图走 editor 那条路不给换算",
    file: "settings-http.js",
    from: "panelUnitsOf(settingsOf(hit.entry?.options?.config ?? hit.current ?? {}))",
    to: "settingsOf(hit.entry?.options?.config ?? hit.current ?? {})",
  },
  {
    name: "破坏3：defaults 不给面板换算（「恢复默认」会放大 60000 倍）",
    file: "settings-http.js",
    from: "defaults: panelUnitsOf(settingDefaults()),",
    to: "defaults: settingDefaults(),",
  },
  {
    name: "破坏4：保存回执不给面板换算",
    file: "settings-http.js",
    from: "settings: panelUnitsOf(check.value),",
    to: "settings: check.value,",
  },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d329-"));
// 一次性副本：绝不改动生产工作区的文件（D324 事故判据）
const ISO = path.join(tmp, "proj");
fs.cpSync(ROOT, ISO, {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    return base !== ".git" && base !== "node_modules" && base !== "tools" ? true : false;
  },
});
// tools 目录单独拷（探针本身要在副本里跑）
fs.mkdirSync(path.join(ISO, "tools"), { recursive: true });
fs.copyFileSync(
  path.join(ROOT, "tools", "_probe-d329-f02-unit.mjs"),
  path.join(ISO, "tools", "_probe-d329-f02-unit.mjs")
);
fs.copyFileSync(
  path.join(ROOT, "package.json"),
  path.join(ISO, "package.json")
);

const run = () => {
  const r = spawnSync(process.execPath, [path.join(ISO, "tools", "_probe-d329-f02-unit.mjs")], {
    encoding: "utf8",
    cwd: ISO,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const completed = out.includes("PROBE-COMPLETE");
  const pass = Number((out.match(/合计：(\d+) PASS/) ?? [])[1] ?? -1);
  const fail = Number((out.match(/(\d+) FAIL/) ?? [])[1] ?? -1);
  return { completed, pass, fail, out };
};

console.log("═══ 基线（未破坏）═══");
{
  const b = run();
  console.log(`  完成=${b.completed}  PASS=${b.pass}  FAIL=${b.fail}`);
  if (!b.completed || b.fail !== 0) {
    console.log("  ✗ 基线本身就不绿 ⇒ 后面的反向验证没有意义，先修基线");
    console.log(b.out);
    process.exit(1);
  }
  console.log("  ✓ 基线 15/0，可以开始破坏");
}

let caught = 0;
let missed = 0;
console.log("");
for (const b of BREAKS) {
  const f = path.join(ISO, "lib", b.file);
  const src = fs.readFileSync(f, "utf8");
  if (!src.includes(b.from)) {
    console.log(`  ?? ${b.name}`);
    console.log(`     锚点没找到 ⇒ 这条破坏点**不自洽**，不能算检出`);
    missed += 1;
    continue;
  }
  const backup = src;
  fs.writeFileSync(f, src.replace(b.from, b.to), "utf8");
  const r = run();
  fs.writeFileSync(f, backup, "utf8");
  // ★ 判据：必须**跑完**且**见红**。崩溃（没 PROBE-COMPLETE）不算检出。
  const detected = r.completed && r.fail > 0;
  if (detected) caught += 1;
  else missed += 1;
  console.log(`  ${detected ? "✓ 检出" : "✗ 漏检"}  ${b.name}`);
  console.log(`     PASS=${r.pass} FAIL=${r.fail} 完成=${r.completed}`);
}

console.log("");
console.log(`═══ 合计：检出 ${caught} / 漏检 ${missed}（共 ${BREAKS.length} 个破坏点）═══`);
console.log(caught === BREAKS.length && missed === 0 ? "⇒ 每条修复都是**唯一守卫**（摘掉它就红）" : "⇒ 有漏检，上面逐条列出");
console.log("PROBE-COMPLETE");
