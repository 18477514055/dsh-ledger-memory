// ★ 反向验证（D335）：把 014 修好的每一处**重新破坏**，看探针能不能看见红。
//   ★ 纪律（D333 §七④）：**要破坏一个守卫，必须先读它认什么** ——
//     所以这里每一处破坏都针对 `_probe-d335-014-verify.mjs` 真正读取的那个模式。
//   ★ 全部在**一次性副本**上做（绝不在生产工作区破坏）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set([".git", "node_modules", "_dist", "_stash", "_ledger-log", "_ledger-archive", ".dsh-ledger.json"]);
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// 每个破坏点：{ 名称, 文件, 替换(old→new) }
// ★★★ 2026-10-27（尺子错第 44 处，已修）：第一版有 3 个破坏点选错 ⇒ 漏检，而**漏检的原因是我的破坏点，
//   不是断言弱**。三个错误的教训（已进 D335）：
//     ① 破坏1 我禁用了"空 dirRel"检查 —— 而 `.` 的拦截在 `abs === rootAbs`（另一个守卫）；
//     ② 破坏2 我把 `INDEX|README` 换成同一字符串加注释 —— **等于没破坏**（守卫是**行为**探针，改注释它照样绿）；
//     ③ 破坏3 我把 `if (st.isDirectory())` 改成 `if (false && st.isDirectory())` —— 探针当时只核**字面量在不在**，
//        字面量还在 ⇒ 照样绿。★ 所以这一处我**同时**加强了探针（改成核 `copyDirVerified` 真被调 + 顺序）。
//   ⇒ 现在的破坏点**针对探针真正读取的那个判据**：行为破坏行为、字面量改真值。
const BREAKS = [
  {
    name: "破坏1 cardDirIsSafe 不再拒绝 '.'（F-02①）—— 摘掉 abs === rootAbs 守卫",
    file: "lib/card-ops.js",
    from: "if (abs === rootAbs) {",
    to: "if (false && abs === rootAbs) {",
  },
  {
    name: "破坏2 isSafeCardKey 不再排除 SECURITY（F-02①b）",
    file: "lib/card-ops.js",
    from: 'if (/^(?:INDEX|README|SECURITY)$/i.test(k)) return false;',
    to: 'if (/^(?:INDEX|README)$/i.test(k)) return false;',
  },
  {
    name: "破坏3 moveAcrossVolumes 目录分支短路（F-01①c/d —— 必须真跨卷才看得见）",
    file: "lib/base.js",
    from: "if (st.isDirectory()) {",
    to: "if (false && st.isDirectory()) {",
  },
  {
    name: "破坏3b moveAcrossVolumes 目录分支不再调 copyDirVerified（F-01①b）",
    file: "lib/base.js",
    from: "copyDirVerified(fromAbs, toAbs);",
    to: "void fromAbs; void toAbs;",
  },
  {
    name: "破坏4 repairConformance 不补 active（F-04③）",
    file: "lib/part4.js",
    from: "nextManifest.active =",
    to: "nextManifest.__disabledActive =",
  },
  {
    name: "破坏5 compactCountsOf 去掉可选链（F-04④）",
    file: "lib/part5.js",
    from: "state?.compactCounts?.get?.(String(sid))",
    to: "state.compactCounts.get(String(sid))",
  },
  {
    name: "破坏6 hfSourceShort 去掉 auto:midturn 分支（F-07①）",
    file: "lib/part1.js",
    from: 'if (src === "auto:midturn") return `自动（回合内 ${autoFullPct()}%）`;',
    to: 'if (src === "__never__") return "x";',
  },
  {
    name: "破坏7 index.js 70% 分支去掉 !silentBecauseDecided（F-04①）",
    file: "lib/index.js",
    from: "!silentBecauseDecided(info) &&\n          hfSettings.highFidelityCompact === true",
    to: "hfSettings.highFidelityCompact === true",
  },
];

const { verify } = { verify: null };
const work = fs.mkdtempSync(path.join(os.tmpdir(), "d335-rev-"));

/** 在某个目录上跑 verify 探针，返回 {pass, fail, out} */
function runVerify(dir) {
  // 用副本里那份 verify 探针（它按 dir 上解析 lib/）
  const probe = path.join(dir, "tools", "_probe-d335-014-verify.mjs");
  let out = "";
  try {
    out = execFileSync("node", [probe], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_PROXY: "github.com" },
    });
  } catch (e) {
    out = String(e.stdout || "");
  }
  const pass = (out.match(/^\s*PASS\s/gm) || []).length;
  const failLines = [...out.matchAll(/^\s*FAIL\s+(.+)$/gm)].map((m) => m[1].trim());
  const sentinel = /PROBE-COMPLETE/.test(out);
  return { pass, fail: failLines, sentinel, out };
}

console.log("剪出基线副本…");
const base = path.join(work, "base");
copyDir(ROOT, base);
const r0 = runVerify(base);
console.log(`基线（未破坏）: PASS=${r0.pass} FAIL=${r0.fail.length} 哨兵=${r0.sentinel}`);
if (r0.fail.length > 0 || !r0.sentinel) {
  console.log("⚠️ 基线就不干净，后续差集无意义：");
  for (const f of r0.fail) console.log(`   FAIL ${f}`);
  process.exit(1);
}

let caught = 0;
const results = [];
for (const b of BREAKS) {
  const dir = path.join(work, "case-" + String(results.length + 1));
  copyDir(ROOT, dir);
  const abs = path.join(dir, b.file);
  const before = fs.readFileSync(abs, "utf8");
  if (!before.includes(b.from)) {
    results.push({ ...b, ok: false, why: `替换源在 ${b.file} 里找不到（破坏点选错）` });
    console.log(`\n✗ ${b.name}\n  ↳ 找不到替换源 ⇒ 破坏点选错（不是断言问题）`);
    continue;
  }
  fs.writeFileSync(abs, before.replace(b.from, b.to));
  const r = runVerify(dir);
  const newlyRed = r.fail.filter((x) => !r0.fail.includes(x));
  const detected = newlyRed.length > 0;
  if (detected) caught++;
  results.push({ ...b, ok: detected, newlyRed, sentinel: r.sentinel });
  console.log(`\n${detected ? "✓ 检出" : "✗ 漏检"} ${b.name}`);
  console.log(`   哨兵=${r.sentinel}（崩了就不算检出） · 新红 ${newlyRed.length} 条`);
  for (const x of newlyRed) console.log(`   ← ${x.slice(0, 110)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n══════════ 反向验证结果 ══════════`);
console.log(`${caught} / ${BREAKS.length} 破坏点被检出`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.why ? ` —— ${r.why}` : ""}`);
console.log(`\n副本（可删）：${work}`);
console.log(caught === BREAKS.length ? "\nPROBE-COMPLETE  反向验证全检出" : "\nPROBE-COMPLETE  ⚠️ 有漏检");
