/**
 * 端到端探针（**真写临时项目、真调 archiveLedger**）：D287 新判据在真实归档流程里到底怎么表现？
 *
 * ★ 为什么要端到端、而不是只测 `archiveSegmentOf`：
 *   昨天连撞四次的那个场景，**全部发生在完整流程里**（`ifRevision` → 行数闸门 → 内容判据 → 写档）。
 *   只测纯函数证明不了"整条路走得通"。
 *
 * ★ 本探针要证明的核心命题（用户拍板的那条契约）：
 *   **活跃台账怎么改都不影响归档；只要 entries 是原文里完整的一段。**
 *
 * 跑法：node tools/_probe-archive-e2e.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
};

const { archiveLedger } = await import(new URL("./part4.js", `file://${LIB.replace(/\\/g, "/")}/`).href);
const part1 = await import(new URL("./part1.js", `file://${LIB.replace(/\\/g, "/")}/`).href);
const defs = await import(new URL("./defs.js", `file://${LIB.replace(/\\/g, "/")}/`).href);
const part2 = await import(new URL("./part2.js", `file://${LIB.replace(/\\/g, "/")}/`).href);

// 设置：给一个宽松上限，免得被行数闸门挡住
defs.setActiveSettings({ ...part1.settingDefaults(), maxActiveLines: 400 });

/** 造一个最小可用的台账项目。 */
function makeProject(ledgerBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-arch-e2e-"));
  fs.writeFileSync(path.join(dir, "LEDGER.md"), ledgerBody, "utf8");
  const manifest = {
    version: 1,
    active: "LEDGER.md",
    archiveDir: "_ledger-archive",
    logDir: "_ledger-log",
    revision: 7,
    maxActiveLines: 400,
    autoGitAdd: false, // ★ 临时目录里没有 git，且绝不碰用户的仓库
  };
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

const BODY = [
  "# 项目台账",
  "",
  "## 一、总纲",
  "",
  "- [a1] 10:00 第一条已完成",
  "  ★ 细节 A",
  "  ★ 细节 B",
  "- [a1] 10:05 第二条已完成",
  "  ★ 细节 C",
  "",
  "## 二、下一步",
  "",
  "- 还没做的事",
].join("\n");

const SLICE = ["- [a1] 10:00 第一条已完成", "  ★ 细节 A", "  ★ 细节 B"].join("\n");

// ══════════════════════════════════════════════════════════════
console.log("── ① ★核心场景：归档一段 + 同时就地改写别的行（昨天连撞四次的那个） ──");
{
  const dir = makeProject(BODY);
  // 新台账：移走第一条，并且**改掉**标题与第二条的细节（模拟"顺手精简/更正"）
  const newActive = [
    "# 项目台账（标题已更正）",
    "",
    "## 一、总纲（就地精简）",
    "",
    "- [a1] 10:05 第二条已完成",
    "  ★ 细节 C（补充了一句）",
    "",
    "## 二、下一步",
    "",
    "- 还没做的事",
  ].join("\n");

  const r = archiveLedger(dir, { entries: SLICE, newActive, ifRevision: 7 });
  ok("① 归档成功（旧判据在这里必然拒绝）", r.ok === true, r.reason);
  ok("① 回执带 archivedSegment 行号区间", r.archivedSegment !== undefined, JSON.stringify(r.archivedSegment));
  ok(
    "① 行号指向原文第 5–7 行",
    r.archivedSegment?.startLine === 5 && r.archivedSegment?.endLine === 7,
    JSON.stringify(r.archivedSegment),
  );
  // ★ 改过的那些行会被列进 goneFromActive（**提示，不拦**）
  ok(
    "① 被改过的旧行只作提示（goneFromActive 有值但 ok=true）",
    r.ok === true && typeof r.goneFromActive === "number",
    `goneFromActive=${r.goneFromActive}`,
  );
  ok("① 归档文件真被写出", fs.existsSync(path.join(dir, "_ledger-archive")));
  // 校验归档里确实有那三行
  const archFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else archFiles.push(p);
    }
  };
  const archDir = path.join(dir, "_ledger-archive");
  if (fs.existsSync(archDir)) walk(archDir);
  const archText = archFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  ok("① 归档里逐字含那三行", SLICE.split("\n").every((l) => archText.includes(l)));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════
console.log("\n── ② 真风险仍被拦：拼接 / 编造 / 空壳 ──");
{
  const dir = makeProject(BODY);
  const invented = ["- [a1] 10:00 第一条已完成", "  ★ 我编的一行"].join("\n");
  const r = archiveLedger(dir, { entries: invented, newActive: "# 空\n", ifRevision: 7 });
  ok("② 编造内容 ⇒ 拒绝", r.ok === false, `居然通过了`);
  ok("② 拒绝时什么都没写", fs.readFileSync(path.join(dir, "LEDGER.md"), "utf8") === BODY);
  ok("② 回执带 contract（把要求说给模型听）", typeof r.contract === "string" && r.contract.length > 20);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = makeProject(BODY);
  const r = archiveLedger(dir, { entries: "   \n\n", newActive: "# 空\n", ifRevision: 7 });
  ok("② 全空白 entries ⇒ 拒绝", r.ok === false);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = makeProject(BODY);
  const spliced = ["- [a1] 10:00 第一条已完成", "  ★ 细节 C"].join("\n"); // 跨段拼接
  const r = archiveLedger(dir, { entries: spliced, newActive: "# 空\n", ifRevision: 7 });
  ok("② 跨段拼接 ⇒ 拒绝", r.ok === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════
console.log("\n── ③ 首尾空行 = 格式噪声，不拦 ──");
{
  const dir = makeProject(BODY);
  const padded = `\n\n${SLICE}\n\n`;
  const r = archiveLedger(dir, { entries: padded, newActive: "# 精简\n", ifRevision: 7 });
  ok("③ 前后多空行 ⇒ 成功", r.ok === true, r.reason);
  ok("③ 行数仍算 3", r.archivedSegment?.lineCount === 3, JSON.stringify(r.archivedSegment));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════
console.log("\n── ④ 活跃台账被大改也放行（极端：只剩一行） ──");
{
  const dir = makeProject(BODY);
  const r = archiveLedger(dir, { entries: SLICE, newActive: "# 只剩标题\n", ifRevision: 7 });
  ok("④ 归档成功", r.ok === true, r.reason);
  ok("④ 活跃台账确实只写了那一行", fs.readFileSync(path.join(dir, "LEDGER.md"), "utf8").startsWith("# 只剩标题"));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════
console.log("\n── ⑤ ifRevision 仍然生效（这条不能被换判据搞坏） ──");
{
  const dir = makeProject(BODY);
  const r = archiveLedger(dir, { entries: SLICE, newActive: "# x\n", ifRevision: 999 });
  ok("⑤ 版本对不上 ⇒ 拒绝", r.ok === false);
  ok("⑤ 拒绝时台账未动", fs.readFileSync(path.join(dir, "LEDGER.md"), "utf8") === BODY);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
