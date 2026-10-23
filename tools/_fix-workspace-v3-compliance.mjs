#!/usr/bin/env node
/**
 * 一次性：把**本工作区自身**改成 V3 合规形态（审计员 010 的 D-01 实地不合规项）。
 *
 * ★ 只做三件、每件都是幂等的，且**不删不改任何已有内容**：
 *   ① 记忆目录缺 `SECURITY.md` ⇒ 用 `writeSecurityMd`（与 `ledger_init` / `migrateToV3` 同一个出口）补上；
 *   ② `.gitignore` 缺 `/10.项目台账-ledger-memory/` 这条**整目录**规则 ⇒ 用 `mergeGitignore` 追加（合并式，不覆盖）；
 *   ③ 清单里 `autoGitAdd: true` 是**不生效的残留**（`shouldAutoStage` 对 V3 无条件拒）⇒ 改成 `false`，让清单说的与实际一致。
 *
 * ★ 为什么单独写脚本而不手动改：`.dsh-ledger.json` 是**寻址器**，手改容易写坏 JSON；
 *   而 `.gitignore` 里有大量中文注释，用 shell 做"读取→替换→写回"是本机明令禁止的操作
 *   （`AGENTS.md` 五：绝不对含中文的文件做那种往返）。⇒ 全部走 Node。
 *
 * ★ 用法：node tools/_fix-workspace-v3-compliance.mjs [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const APPLY = process.argv.includes("--apply");

const { writeSecurityMd } = await import(pathToFileURL(path.join(PROJECT, "lib", "part7.js")).href);
const { mergeGitignore } = await import(pathToFileURL(path.join(PROJECT, "lib", "part2.js")).href);
const { DEFAULT_IGNORE_LINES } = await import(pathToFileURL(path.join(PROJECT, "lib", "defs.js")).href);

const MANIFEST = path.join(PROJECT, ".dsh-ledger.json");
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const memRoot = manifest.memoryRoot;
if (typeof memRoot !== "string" || memRoot === "") {
  console.error("✗ 清单里没有 memoryRoot —— 这不是 V3 项目，本脚本不适用");
  process.exit(1);
}
const memAbs = path.join(PROJECT, memRoot);

console.log("═".repeat(72));
console.log("把本工作区自身改成 V3 合规形态");
console.log("═".repeat(72));
console.log(`模式：${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`memoryRoot = ${memRoot}`);

// ── ① SECURITY.md ────────────────────────────────────────────────────────
const secAbs = path.join(memAbs, "SECURITY.md");
console.log(`\n① SECURITY.md：${fs.existsSync(secAbs) ? "已存在（幂等跳过）" : "缺失 ⇒ 要建"}`);

// ── ② .gitignore 的整目录规则 ────────────────────────────────────────────
const giAbs = path.join(PROJECT, ".gitignore");
const giText = fs.existsSync(giAbs) ? fs.readFileSync(giAbs, "utf8") : "";
const wantLine = `/${memRoot.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")}/`;
const hasLine = giText
  .replace(/\r\n/g, "\n")
  .split("\n")
  .map((l) => l.trim())
  .includes(wantLine);
console.log(`② .gitignore 整目录规则 \`${wantLine}\`：${hasLine ? "已有（幂等跳过）" : "缺失 ⇒ 要追加"}`);

// ── ③ autoGitAdd ────────────────────────────────────────────────────────
const needFlag = manifest.autoGitAdd !== false;
console.log(`③ autoGitAdd：${manifest.autoGitAdd} ⇒ ${needFlag ? "改成 false（清单要与实际一致）" : "已是 false（跳过）"}`);

if (!APPLY) {
  console.log("\n（dry-run 结束；加 --apply 才真写。）");
  process.exit(0);
}

// ── 真写 ─────────────────────────────────────────────────────────────────
const done = [];

// ①
if (!fs.existsSync(secAbs)) {
  if (writeSecurityMd(memAbs)) done.push("建了 SECURITY.md");
}

// ②  ★ 用与 ledger_init 完全相同的表 + 规则（同一个函数，不是"照着写一遍"）
if (!hasLine) {
  const r = mergeGitignore(PROJECT, [...DEFAULT_IGNORE_LINES, wantLine]);
  done.push(`.gitignore 追加 ${r.added.length} 条（changed=${r.changed}）`);
}

// ③
if (needFlag) {
  const next = { ...manifest, autoGitAdd: false };
  // ★ 用 .tmp + rename 的原子写法，避免写坏这个"寻址器"
  const tmp = `${MANIFEST}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, MANIFEST);
  done.push("autoGitAdd → false");
}

// ── 写后从磁盘读回来验 ───────────────────────────────────────────────────
console.log("\n" + "─".repeat(72));
console.log("写后校验（真读回磁盘）");
console.log("─".repeat(72));
let bad = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : `  —— ${detail}`}`);
  if (!pass) bad += 1;
};
check("SECURITY.md 存在且非空", fs.existsSync(secAbs) && fs.statSync(secAbs).size > 500, fs.existsSync(secAbs) ? `${fs.statSync(secAbs).size} B` : "缺失");
const gi2 = fs.readFileSync(giAbs, "utf8");
check(
  `gitignore 含 \`${wantLine}\``,
  gi2.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).includes(wantLine),
  ""
);
check("原有中文注释未被破坏（抽查『依赖与产物』仍在）", gi2.includes("依赖与产物"), "");
check("原有 node_modules/ 规则仍在", gi2.split("\n").some((l) => l.trim() === "node_modules/"), "");
const m2 = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
check("清单 autoGitAdd === false", m2.autoGitAdd === false, String(m2.autoGitAdd));
check("清单其余键一个没丢（memoryRoot 仍在）", m2.memoryRoot === memRoot, String(m2.memoryRoot));
check("清单 JSON 可解析且 revision 仍在", typeof m2.revision === "number", String(m2.revision));

console.log("\n" + "─".repeat(72));
if (done.length === 0) console.log("什么都没改（三处本来就已经合规）。");
else for (const d of done) console.log(`  · ${d}`);
console.log(bad === 0 ? "✓ 全部校验通过" : `✗ ${bad} 项不过`);
console.log("─".repeat(72));
process.exit(bad === 0 ? 0 : 1);
