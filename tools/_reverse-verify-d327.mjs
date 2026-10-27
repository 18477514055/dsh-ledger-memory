/**
 * _reverse-verify-d327.mjs —— 证明 `_probe-d327-009-fixes.mjs` 不是空判据。
 *
 * ★ 判据（每次都要求同时成立）：`prepared && got==="red" && 命中期望的那条 FAIL && complete`。
 *   缺 `PROBE-COMPLETE` = 崩溃，不算检出（D324 教训）。
 *
 * ★ 每个破坏点都尽量还原**原缺陷形态**，而不是随便删一行：
 *   比如 F-01 的破坏是把 `enabledKeysOf` 改回只看 `infoField`（那正是原写法）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_REL = path.join("tools", "_probe-d327-009-fixes.mjs");

function stage() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d327-"));
  fs.cpSync(path.join(ROOT, "lib"), path.join(d, "lib"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(d, "package.json"));
  fs.mkdirSync(path.join(d, "tools"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, PROBE_REL), path.join(d, PROBE_REL));
  return d;
}
function run(d) {
  const r = spawnSync(process.execPath, [path.join(d, PROBE_REL)], { cwd: d, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    code: r.status,
    fails: out.split("\n").filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim().slice(0, 120)),
    complete: /PROBE-COMPLETE/.test(out),
  };
}
function mutate(d, rel, from, to, expectCount = 1) {
  const p = path.join(d, rel);
  const s = fs.readFileSync(p, "utf8");
  const n = s.split(from).length - 1;
  if (n !== expectCount) {
    console.log(`  ⚠ 破坏点打偏：${rel} 里命中 ${n} 次（期望 ${expectCount}）`);
    return false;
  }
  fs.writeFileSync(p, s.split(from).join(to), "utf8");
  return true;
}
const cases = [];
function tryBreak(name, expectRed, fn) {
  const d = stage();
  let prepared;
  try {
    prepared = fn(d) === true;
  } catch (e) {
    console.log("  ⚠ 破坏动作抛错：" + String(e?.message ?? e));
    prepared = false;
  }
  const r = run(d);
  cases.push({
    name,
    prepared,
    got: r.code === 0 ? "green" : "red",
    seen: r.fails.some((l) => l.includes(expectRed)),
    fails: r.fails,
    complete: r.complete,
  });
  fs.rmSync(d, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// ① F-01：把 enabledKeysOf 改回「只看 infoField」（原写法）
// ══════════════════════════════════════════════════════════════════════════
tryBreak("破坏 ①-a：enabledKeysOf 改回只看 infoField ⇒ 卡片目录不算启用", "① a", (d) =>
  mutate(
    d,
    path.join("lib", "part1.js"),
    `    const d = c.dirField === undefined ? undefined : info?.[c.dirField];
    if ((typeof v === "string" && v !== "") || (typeof d === "string" && d !== "")) on.add(c.key);`,
    `    void c; /* 破坏：不认卡片目录 */
    if (typeof v === "string" && v !== "") on.add(c.key);`
  )
);

// ══════════════════════════════════════════════════════════════════════════
// ② F-02：repairConformance 去掉卡片目录分支
// ══════════════════════════════════════════════════════════════════════════
tryBreak("破坏 ②-a：repairConformance 去掉「卡片模式下建目录」这一段 ⇒ 干跑空转", "② a", (d) => {
  const p = path.join(d, "lib", "part4.js");
  const s = fs.readFileSync(p, "utf8");
  const i = s.indexOf("const decMode = cardModeOf(info, \"decisions\")");
  if (i < 0) {
    console.log("  ⚠ 找不到 decMode 分支");
    return false;
  }
  // 把 `decMode.card === true` 那个 if 的条件改成恒假 —— 等价于"没有这段"
  const j = s.indexOf("if (decMode.card === true)", i);
  if (j < 0) {
    console.log("  ⚠ 找不到 if (decMode.card === true)");
    return false;
  }
  fs.writeFileSync(p, s.slice(0, j) + "if (false && decMode.card === true)" + s.slice(j + "if (decMode.card === true)".length), "utf8");
  return true;
});

// ══════════════════════════════════════════════════════════════════════════
// ③ F-03：settingsValuesOf 改回「清单优先」
//   ★★ 尺子错 #45（本轮自己撞的）：第一版破坏写成
//     `const v = hasMan ? man[key] : s[key]` —— 可补丁已经把 `hasMan`/`man`
//     两行**删掉了** ⇒ 变量未定义 ⇒ **ReferenceError 崩掉**，不是"检出"。
//     证据：返回 `got=red` 但 `哨兵=false`、`FAIL=(无)` —— 这正是 D324 那条
//     「崩溃会冒充检出」的形态。⇒ 破坏点必须**自洽**（把要用的变量一起补回去）。
// ══════════════════════════════════════════════════════════════════════════
tryBreak("破坏 ③-a：settingsValuesOf 改回无条件清单优先 ⇒ 面板改了不生效", "③ a", (d) =>
  mutate(
    d,
    path.join("lib", "part3.js"),
    `    const v = PRECEDENCE_KEYS.includes(key) ? precedenceValue(info, key) : s[key];`,
    `    const man = info?.manifest ?? {}; /* 破坏：还原清单优先 */
    const hasMan = Object.prototype.hasOwnProperty.call(man, key) && man[key] !== undefined && man[key] !== null;
    const v = hasMan ? man[key] : s[key];`
  )
);

// ══════════════════════════════════════════════════════════════════════════
// ④ F-04：lessons 的 relPath / revision 各拆一处
// ══════════════════════════════════════════════════════════════════════════
tryBreak("破坏 ④-a：lessons list 的 relPath 改回裸 `rel` ⇒ 卡片模式下是 undefined", "④ d", (d) =>
  mutate(
    d,
    path.join("lib", "part2.js"),
    `          relPath: lcard ? lmode.dirRel : rel,`,
    `          relPath: rel, /* 破坏：卡片模式下 undefined */`
  )
);

tryBreak("破坏 ④-b：recordLessonAudit 不再 bumpRevision ⇒ add/rm 不递增 revision", "④ c", (d) =>
  mutate(
    d,
    path.join("lib", "part2.js"),
    `        let rev;
        try {
          rev = bumpRevision(root);
        } catch {
          rev = undefined;
        }`,
    `        const rev = undefined; /* 破坏：不递增 revision */`
  )
);

// ══════════════════════════════════════════════════════════════════════════
// ⑤ F-05：detectMigration 的目标卡检查改回只看单文件
// ══════════════════════════════════════════════════════════════════════════
tryBreak("破坏 ⑤-a：detectMigration 改回只看 info.goalsRel ⇒ 卡片模式全部漏检", "⑤ a", (d) =>
  mutate(
    d,
    path.join("lib", "part4.js"),
    `    const gLoc = kindLocationOf(info, "goals");
    const gRaw = gLoc.rel !== undefined ? readKindRaw(root, info, "goals").raw : "";`,
    `    const gLoc = { rel: info.goalsRel }; /* 破坏：只看单文件 */
    const gRaw = typeof info.goalsRel === "string" ? readTextSafe(path.resolve(memoryBaseOf(info, root), info.goalsRel)) ?? "" : "";`
  )
);

console.log("");
console.log("═══════════ 反向验证汇总 ═══════════");
let good = 0;
let bad = 0;
for (const c of cases) {
  const fine = c.prepared === true && c.got === "red" && c.seen === true && c.complete === true;
  if (fine) good += 1;
  else bad += 1;
  console.log(
    `${fine ? "✅" : "❌"} ${c.name}\n` +
      `     prepared=${c.prepared} got=${c.got} 命中期望FAIL=${c.seen} 哨兵=${c.complete}\n` +
      `     FAIL：${c.fails.length === 0 ? "(无)" : c.fails.slice(0, 3).join(" ｜ ")}`
  );
}
console.log("");
console.log(`全部破坏点：${good} 见红 / ${bad} 未见红（共 ${cases.length}）`);
console.log("PROBE-COMPLETE");
process.exit(bad === 0 ? 0 : 2);
