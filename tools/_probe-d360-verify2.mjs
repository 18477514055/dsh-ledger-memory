// _probe-d360-verify2.mjs —— 核实 016 的 F-03 ~ F-07（同样不照抄报告）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 600)}`}`); }
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

console.log("═══ F-03：settings-http 写路由未透传 matchedRoot ═══");
{
  const src = read("lib/settings-http.js");
  const lines = src.split("\n");
  const hits = lines.filter((l) => /createExtension\(|updateExtension\(|deleteExtension\(/.test(l) && !/function\s/.test(l));
  console.log("  调用点：");
  for (const l of hits) console.log(`    | ${l.trim()}`);
  ok("① 存在传 `root`（原始 body.root）而非 `matchedRoot` 的调用",
    hits.some((l) => /\broot\b/.test(l) && !/matchedRoot/.test(l)), JSON.stringify(hits));
  // normPath 的实现
  const nm = /const normPath = [\s\S]{0,600}?\n\s*\};|function normPath[\s\S]{0,600}?\n\}/.exec(src);
  const nmText = nm?.[0] ?? "(找不到 normPath)";
  console.log("  normPath 实现：");
  console.log(nmText.split("\n").map((l) => "    | " + l).join("\n").slice(0, 900));
  ok("② normPath **只在 win32/darwin 下小写**（跨平台盘符未归一化）",
    /win32.*darwin|darwin.*win32/.test(nmText) && /toLowerCase/.test(nmText), nmText.slice(0, 300));
}

console.log("\n═══ F-04：selftest 130② 直接写 PROJECT_ROOT ═══");
{
  const src = read("tools/selftest.mjs");
  const lines = src.split("\n");
  const idx = lines.findIndex((l) => /130②|情形 130/.test(l));
  const seg = lines.slice(Math.max(0, idx - 5), idx + 40).join("\n");
  const bad = /root:\s*PROJECT_ROOT/.test(seg);
  console.log(`  130 组附近是否出现 \`root: PROJECT_ROOT\` ⇒ ${bad}`);
  ok("① 存在以 PROJECT_ROOT 为 root 的 noteTool.execute 调用", bad, seg.slice(0, 500));
  ok("① 且**没有**先建临时 .git 目录（tmpGit130 之类）", !/tmpGit130/.test(src));
}

console.log("\n═══ F-05：符号链接纵深缺口 ═══");
{
  const pure = read("lib/pure-ops.js");
  const mir = read("lib/manifest-mirror.js");
  const p2 = read("lib/part2.js");
  const co = read("lib/card-ops.js");
  const fnOf = (src, name) => {
    const i = src.indexOf(`export function ${name}`);
    if (i < 0) return "";
    let d = 0, started = false;
    for (let k = i; k < src.length; k++) {
      if (src[k] === "{") { d++; started = true; }
      else if (src[k] === "}") { d--; if (started && d === 0) return src.slice(i, k + 1); }
    }
    return src.slice(i, i + 3000);
  };
  // ① mergeGitignore / writeManifestSynced 有没有 lstatSync + isSymbolicLink
  const mg = fnOf(pure, "mergeGitignore");
  const wm = fnOf(mir, "writeManifestSynced");
  ok("① mergeGitignore 里**没有** isSymbolicLink 检查", !/isSymbolicLink/.test(mg), mg.slice(0, 200));
  ok("① writeManifestSynced 里**没有** isSymbolicLink 检查", !/isSymbolicLink/.test(wm), wm.slice(0, 200));
  // ② guessArchiveDir / guessLogDir 用 statSync（跟随链接）
  const ga = fnOf(p2, "guessArchiveDir");
  const gl = fnOf(p2, "guessLogDir");
  const usesStat = /statSync\(/.test(ga) || /statSync\(/.test(gl);
  const usesLstat = /lstatSync/.test(ga) || /lstatSync/.test(gl);
  console.log(`  guessArchiveDir/guessLogDir：用 statSync=${usesStat}，用 lstatSync=${usesLstat}`);
  ok("② 候选目录探测**用 statSync 跟随链接**、**没有** lstatSync", usesStat && !usesLstat,
    (ga + gl).slice(0, 400));
  // ③ gateDir / cardDirIsSafe 自根只做词法比较
  const gd = fnOf(p2, "gateDir");
  const cds = fnOf(co, "cardDirIsSafe");
  ok("③ gateDir **只做词法 resolve 比较**（没有 realpathOf）", gd.includes("path.resolve") && !/realpathOf/.test(gd), gd.slice(0, 300));
  ok("③ cardDirIsSafe **只做词法 resolve 比较**（没有 realpathOf）", cds.includes("path.resolve") && !/realpathOf/.test(cds), cds.slice(0, 300));
}

console.log("\n═══ F-06：client.js ExtensionsPage 闭包依赖 ═══");
{
  const src = read("lib/client.js");
  const i = src.indexOf("ExtensionsPage");
  const seg = src.slice(i, i + 22000);
  const dep = /}, \[root, load\]\);/.test(seg);
  const matchRootOnly = /p\.root === root/.test(seg);
  ok("① useCallback 依赖数组**只有** [root, load]", dep);
  ok("① 匹配项目时**只比 root**、没用 cur?.root", matchRootOnly);
}

console.log("\n═══ F-07：.gitignore 与探针硬编码 ═══");
{
  const gi = read(".gitignore");
  ok("① .gitignore 只有 `tools/_p2.txt`、**没有** `tools/_p*.txt` 通配",
    gi.includes("tools/_p2.txt") && !gi.includes("tools/_p*.txt"));
  ok("① .gitignore **没有** `tools/_msg-*.txt`", !gi.includes("_msg-*"));
  ok("① .gitignore **没有** `tools/*.legacy`", !/tools\/\*\.legacy/.test(gi));
  const probe = read("tools/_probe-d358-scope.mjs");
  const hard = /const ROOT = "D:\\\\Deepseek工作区/.test(probe) || probe.includes('"D:\\\\Deepseek工作区');
  console.log(`  探针里出现本机绝对路径 ⇒ ${hard}`);
  ok("② _probe-d358-scope.mjs 硬编码本机绝对路径", hard, probe.split("\n").slice(8, 14).join("\n"));
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
