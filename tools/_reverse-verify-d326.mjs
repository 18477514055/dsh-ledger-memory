/**
 * _reverse-verify-d326.mjs —— 证明 `_probe-d326-008-fixes.mjs` **不是空判据**。
 *
 * 为什么必须做这一层（本项目已被这条咬过四次）：
 *   · D323 的 `ok("标题", 条件)` 参数写反 ⇒ 3 条断言**永远绿**；
 *   · D324 的「我能破坏它 ≠ 它是那个洞的唯一守卫」⇒ 破坏点打偏；
 *   · D324 的「崩溃会冒充检出」⇒ 探针中途 ENOENT 也看起来像检出；
 *   · D325 的夹具能力不足 ⇒ 该记为 unverifiable 而非通过。
 *
 * ★ 判据（每次都必须同时成立）：`prepared && fails>0 && complete`。
 *   `complete` = 输出里有 `PROBE-COMPLETE` 哨兵 —— 没有它 = 崩了，不是检出。
 *
 * ★★ 每个破坏点都尽量构造**原缺陷的形态**（不是随便删一行）：
 *   比如 F-01 的破坏是把守卫**搬回 `const base` 之前** —— 那正是 TDZ 的成因。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_REL = path.join("tools", "_probe-d326-008-fixes.mjs");

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d326-"));
  fs.cpSync(path.join(ROOT, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, PROBE_REL), path.join(dir, PROBE_REL));
  return dir;
}

function run(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, PROBE_REL)], { cwd: dir, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fails = out
    .split("\n")
    .filter((l) => /^\s*FAIL/.test(l))
    .map((l) => l.trim().slice(0, 120));
  return { code: r.status, out, fails, complete: /PROBE-COMPLETE/.test(out) };
}

/** 在某文件里做一次"必须命中一次"的替换；命中不到就返回 false（= 破坏点打偏）。 */
function mutate(dir, rel, from, to, { expectCount = 1 } = {}) {
  const p = path.join(dir, rel);
  const src = fs.readFileSync(p, "utf8");
  const n = src.split(from).length - 1;
  if (n !== expectCount) {
    console.log(`  ⚠ 破坏点打偏：${rel} 里 "${from.slice(0, 60)}…" 命中 ${n} 次（期望 ${expectCount}）`);
    return false;
  }
  fs.writeFileSync(p, src.split(from).join(to), "utf8");
  return true;
}

const cases = [];
function tryBreak(name, expectRedLine, mutateFn) {
  const d = stage();
  let prepared;
  try {
    prepared = mutateFn(d) === true;
  } catch (e) {
    console.log(`  ⚠ 破坏动作抛错：${String(e?.message ?? e)}`);
    prepared = false;
  }
  const r = run(d);
  const hit = expectRedLine === undefined ? true : r.fails.some((l) => l.includes(expectRedLine));
  cases.push({
    name,
    prepared,
    got: r.code === 0 ? "green" : "red",
    seenLine: hit,
    fails: r.fails,
    complete: r.complete,
  });
  fs.rmSync(d, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// ① F-01 的两个破坏点
// ══════════════════════════════════════════════════════════════════════════
// (a) 把越界守卫**搬回 `const base` 之前** —— 这就是 TDZ 的原形态
tryBreak(
  "破坏 ①-a：把 defineIndexTool 的越界守卫搬回 `const base` 之前（还原 TDZ）",
  "① a",
  (d) => {
    const rel = path.join("lib", "part4.js");
    const p = path.join(d, rel);
    let s = fs.readFileSync(p, "utf8");
    const guard =
      `      const unsafeIdx = refuseIfMemoryRootUnsafe(info);\n` +
      `      if (args?.op === "write" && unsafeIdx !== undefined) {\n` +
      `        return { ...base, wrote: false, writeError: unsafeIdx.reason };\n` +
      `      }\n`;
    if ((s.split(guard).length - 1) !== 1) {
      console.log("  ⚠ 找不到守卫原文");
      return false;
    }
    s = s.split(guard).join(""); // 先摘掉
    // 再插到 `const r = renderCardIndex(memBase` 之前（= base 声明之前）
    const anchor = `      const r = renderCardIndex(memBase, mode.dirRel, { limit });\n`;
    if ((s.split(anchor).length - 1) !== 1) {
      console.log("  ⚠ 找不到插入锚点");
      return false;
    }
    s = s.split(anchor).join(guard + anchor);
    fs.writeFileSync(p, s, "utf8");
    return true;
  }
);

// (b) 直接删掉越界守卫 —— 证明"它不抛"不是天然成立的
tryBreak(
  "破坏 ①-b：整个删掉越界守卫 ⇒ 越界时不再返回 wrote:false",
  "① b",
  (d) =>
    mutate(
      d,
      path.join("lib", "part4.js"),
      `      const unsafeIdx = refuseIfMemoryRootUnsafe(info);\n` +
        `      if (args?.op === "write" && unsafeIdx !== undefined) {\n` +
        `        return { ...base, wrote: false, writeError: unsafeIdx.reason };\n` +
        `      }\n`,
      ""
    )
);

// ══════════════════════════════════════════════════════════════════════════
// ② F-02 的两个破坏点
// ══════════════════════════════════════════════════════════════════════════
// (a) 把条件展开改回裸 `lines: r.lines` —— 这就是 lossless JSON 违规的原形态
tryBreak(
  "破坏 ②-a：把 goals upsert 的条件展开改回裸 `lines: r.lines`（还原 undefined 属性）",
  "② b",
  (d) =>
    mutate(
      d,
      path.join("lib", "part2.js"),
      `...(r.lines === undefined ? {} : { lines: r.lines }), mode: r.card === undefined ? "file" : "card", ...(rev === undefined ? {} : { revision: rev }) };`,
      `lines: r.lines, mode: r.card === undefined ? "file" : "card", ...(rev === undefined ? {} : { revision: rev }) };`
    )
);

// (b) 摘掉 `bumpRevision` —— 证明"revision 真递增"不是顺带发生的
tryBreak(
  "破坏 ②-b：recordGoalsChange 不再 bumpRevision ⇒ revision 不再递增",
  "② d",
  (d) =>
    mutate(
      d,
      path.join("lib", "part2.js"),
      `  let rev;\n  try {\n    rev = bumpRevision(root);\n  } catch {\n    rev = undefined;\n  }\n`,
      `  const rev = undefined;\n`
    )
);

// (c) 把审计行改回写死的 GOALS.md —— 证明"真路径"是被验的
tryBreak(
  "破坏 ②-c：审计 relPath 改回写死 `info.goalsRel ?? DEFAULT_GOALS_NAME` ⇒ 卡片模式下指向不存在的 GOALS.md",
  "② e",
  (d) =>
    mutate(
      d,
      path.join("lib", "part2.js"),
      `      relPath: rec.relPath ?? info.goalsDir ?? info.goalsRel ?? DEFAULT_GOALS_NAME,`,
      `      relPath: info.goalsRel ?? DEFAULT_GOALS_NAME,`
    )
);

// ══════════════════════════════════════════════════════════════════════════
// ③ F-03 的四个破坏点（6 项收尾里挑 4 项，每项单独能红）
// ══════════════════════════════════════════════════════════════════════════
tryBreak("破坏 ③-a：runTurnCompact 不再传 capRel ⇒ 索引行丢掉「逐字原件」指针", "③ a", (d) =>
  mutate(d, path.join("lib", "part5.js"), `      capRel: capPersist?.persistRel ?? capsulePathFor(projectInfo, Date.now()),\n`, "")
);

tryBreak("破坏 ③-b：runTurnCompact 不再 armReinject ⇒ 压后首步不强制重注", "③ b", (d) =>
  mutate(d, path.join("lib", "part5.js"), `  armReinject(state, key, agent);\n  try {\n    recordShadowedIndex(state, key, agent, "auto:midturn"`, `  try {\n    recordShadowedIndex(state, key, agent, "auto:midturn"`)
);

tryBreak("破坏 ③-e：runTurnCompact 不再清 flushedAt ⇒ 下一周期闸门被旧时间戳误放行", "③ e", (d) =>
  mutate(d, path.join("lib", "part5.js"), `  state.flushedAt?.delete?.(key);\n  try {\n    const cc = state.compactCounts?.get?.(key)`, `  try {\n    const cc = state.compactCounts?.get?.(key)`)
);

tryBreak("破坏 ③-d：runTurnCompact 不再累加 compactCounts ⇒ /ledger status 压缩次数永远是 0", "③ d", (d) => {
  const rel = path.join("lib", "part5.js");
  const p = path.join(d, rel);
  const s = fs.readFileSync(p, "utf8");
  const blk =
    `  try {\n` +
    `    const cc = state.compactCounts?.get?.(key) ?? { total: 0, delta: 0, full: 0 };\n` +
    `    cc.total += 1;\n` +
    `    cc.full += 1;\n` +
    `    cc.lastAt = Date.now();\n` +
    `    cc.lastSource = "auto:midturn";\n` +
    `    state.compactCounts?.set?.(key, cc);\n` +
    `  } catch {\n` +
    `    /* 计数失败绝不影响压缩本身 */\n` +
    `  }\n`;
  if ((s.split(blk).length - 1) !== 1) {
    console.log("  ⚠ compactCounts 块命中次数不对");
    return false;
  }
  fs.writeFileSync(p, s.split(blk).join(""), "utf8");
  return true;
});

// ══════════════════════════════════════════════════════════════════════════
// ④ F-04 的两个破坏点
// ══════════════════════════════════════════════════════════════════════════
tryBreak("破坏 ④-a：/ledger lock 命令去掉工作区边界守卫 ⇒ 能锁到工作区外", "④ a", (d) => {
  const rel = path.join("lib", "part5.js");
  const p = path.join(d, rel);
  const s = fs.readFileSync(p, "utf8");
  const blk =
    `    if (typeof base === "string" && base !== "") {\n` +
    `      const wsRoot = findWorkspaceRoot(base) ?? base;\n` +
    `      const g = isUnderReal(wsRoot, abs);\n` +
    `      if (g.ok !== true && fs.existsSync(abs)) {\n` +
    `        return { kind: "error", text: \`拒绝锁定：目标目录 \\\`\${abs}\\\` 越出了当前会话工作区边界（\${g.why}）。\` };\n` +
    `      }\n` +
    `    }\n`;
  const n = s.split(blk).length - 1;
  if (n !== 1) {
    // 退一步：用更宽松的锚点定位（只删 if 那三行）
    const loose =
      `      const wsRoot = findWorkspaceRoot(base) ?? base;\n` +
      `      const g = isUnderReal(wsRoot, abs);\n` +
      `      if (g.ok !== true && fs.existsSync(abs)) {\n`;
    if ((s.split(loose).length - 1) !== 1) {
      console.log(`  ⚠ /ledger lock 守卫定位失败（严格 ${n} 次，宽松也失败）`);
      return false;
    }
    // 把守卫条件改成恒假 ⇒ 等价于"没有守卫"
    return mutate(d, rel, loose, `      const wsRoot = findWorkspaceRoot(base) ?? base;\n      const g = isUnderReal(wsRoot, abs);\n      if (false && fs.existsSync(abs)) {\n`);
  }
  return mutate(d, rel, blk, "");
});

tryBreak("破坏 ④-b：ledger_init 去掉损坏清单预检 ⇒ 静默覆写损坏的 .dsh-ledger.json", "④ e", (d) =>
  mutate(
    d,
    path.join("lib", "part4.js"),
    `      if (manifestBefore === undefined && fs.existsSync(path.join(root, MANIFEST_REL))) {\n` +
      `        throw fail(\`ledger_init: 拒绝覆盖 —— \\\`\${MANIFEST_REL}\\\` 已存在但无法解析为合法 JSON，请先修复或备份后再重试。\`);\n` +
      `      }\n`,
    ""
  )
);

// ══════════════════════════════════════════════════════════════════════════
// ⑤ F-05 的破坏点
// ══════════════════════════════════════════════════════════════════════════
tryBreak("破坏 ⑤-a：migrateToV3 去掉「多出未知文件」那一向 ⇒ 脏卡可混入权威记忆面", "⑤ a", (d) => {
  const rel = path.join("lib", "part7.js");
  const p = path.join(d, rel);
  const s = fs.readFileSync(p, "utf8");
  const blk =
    `    for (const actualRel of listFiles(memAbs, ".")) {\n` +
    `      if (actualRel === "SECURITY.md" || actualRel === ".dsh-ledger.json") continue;\n` +
    `      if (!expectedSet.has(actualRel)) {\n` +
    `        mismatched.push(\`多出未知文件：\${actualRel}\`);\n` +
    `      }\n` +
    `    }\n`;
  if ((s.split(blk).length - 1) !== 1) {
    console.log("  ⚠ 双向校验块定位失败");
    return false;
  }
  fs.writeFileSync(p, s.split(blk).join(""), "utf8");
  return true;
});

// ══════════════════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════════════════
console.log("");
console.log("═══════════ 反向验证汇总 ═══════════");
let good = 0;
let bad = 0;
let unverifiable = 0;
for (const c of cases) {
  const isOk = c.prepared === true && c.got === "red" && c.seenLine === true && c.complete === true;
  if (isOk) good += 1;
  else bad += 1;
  console.log(
    `${isOk ? "✅" : "❌"} ${c.name}\n` +
      `     prepared=${c.prepared} got=${c.got} 命中期望的那条 FAIL=${c.seenLine} 跑完哨兵=${c.complete}\n` +
      `     FAIL 行：${c.fails.length === 0 ? "(无)" : c.fails.slice(0, 3).join(" ｜ ")}`
  );
}
console.log("");
console.log(`全部破坏点：${good} 见红 / ${bad} 未见红 / ${unverifiable} 无法验证（共 ${cases.length}）`);
console.log("PROBE-COMPLETE");
process.exit(bad === 0 ? 0 : 2);
