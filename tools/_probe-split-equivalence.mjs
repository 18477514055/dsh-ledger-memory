/**
 * _probe-split-equivalence.mjs —— D318：证明"搬家没改行为"
 *
 * ★★★ 为什么必须做这一步（这一轮我自己已经错了两次）：
 *   我把 `mergeGitignore` 与 `stageOutcomeOf` **凭印象重写**过一遍，两次都写错了返回形状
 *   （`mergeGitignore` 原文返回 `{changed, added[], path, created}`，我写成 `{ok, added:n}`；
 *     `stageOutcomeOf` 原文返回 `{staged:boolean, stagedPaths, stagedSkipped, stagedNote}`，
 *     我写成 `{ok, staged:number, ...}`）。
 *   ⇒ 那两次是**我读源码才发现的**，不是探针发现的。这正说明：**必须有自动对拍**。
 *
 * 判据（四条）：
 *   ① `part2` 与 `pure-ops` 导出的这三个名字**是同一个函数**（=== 同一引用）
 *   ② 三个函数的**返回值 key 集合**与历史约定一致（逐字比对 key 名单）
 *   ③ **真调**：在临时目录里造输入，跑一次，比对返回形状与关键字段
 *   ④ 外部调用方（part1/part4/part5/index/defs）**不需要改**（从 part2 取仍可用）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("lib");
const P2 = await import(pathToFileURL(path.join(ROOT, "part2.js")).href);
const PO = await import(pathToFileURL(path.join(ROOT, "pure-ops.js")).href);

const results = [];
const ok = (c, label, detail) => results.push({ c, label, detail });

const NAMES = ["findDeFactoLedger", "mergeGitignore", "stageOutcomeOf"];

// ── ① 同一引用（re-export 没造出第二个实现）
for (const n of NAMES) {
  ok(
    typeof P2[n] === "function" && P2[n] === PO[n],
    `① part2.${n} === pure-ops.${n}（同一引用，不是两份实现）`,
    typeof P2[n] === "function" ? (P2[n] === PO[n] ? "同一引用" : "🔴 是两个不同函数") : "🔴 part2 没导出"
  );
}

// ── ①b ★★★ `part2` **内部**也必须能调到这三个名字（D307 型：`export ... from` 只转发、不绑定本地名）
//
//   ★ 我第一版漏了这条断言，反向验证当场抓到：把 `import` 删掉、只留 `export ... from`，
//     上面 ① 那三条**照样全绿**（因为 `part2.xxx` 依然指向同一个函数引用）
//     —— 而 `conformanceOf`（L1841）调 `findDeFactoLedger` 会 **ReferenceError**。
//   ⇒ 判据：**"对外能取到"与"对内能用"是两件事**，必须分开断言。
//     这正是本项目那条老病：**断言只覆盖了它看得见的那一面。**
{
  const part2src = fs.readFileSync(path.join(ROOT, "part2.js"), "utf8");
  // 剥注释，避免注释里的 import 造成假绿
  const code = part2src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  for (const n of NAMES) {
    const hasImport = new RegExp(`^import\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from\\s*"\\./pure-ops\\.js"`, "m").test(code);
    const hasExportFrom = new RegExp(`^export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from\\s*"\\./pure-ops\\.js"`, "m").test(code);
    ok(
      hasImport && hasExportFrom,
      `①b part2 **既 import 又 export-from** ${n}（只做后者 ⇒ 内部 ReferenceError）`,
      `import=${hasImport} exportFrom=${hasExportFrom}`
    );
  }
  // ② 还要证明"内部真的在用"：找出 part2 里剥注释后仍调用它的地方
  const internalUsers = {
    findDeFactoLedger: /(?<![\w$.])findDeFactoLedger\s*\(/,
    mergeGitignore: /(?<![\w$.])mergeGitignore\s*\(/,
    stageOutcomeOf: /(?<![\w$.])stageOutcomeOf\s*\(/,
  };
  for (const [n, re] of Object.entries(internalUsers)) {
    const usedInside = re.test(code.replace(new RegExp(`^import[\\s\\S]*?from\\s*"\\./pure-ops\\.js";`, "m"), ""));
    if (usedInside) {
      ok(hasImportFlag(code, n), `② part2 内部确实调用 ${n} ⇒ 必须有本地绑定（实测有此调用）`, "内部有调用点");
    }
  }
  function hasImportFlag(src, n) {
    return new RegExp(`^import\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from\\s*"\\./pure-ops\\.js"`, "m").test(src);
  }
}

// ── ② 返回值 key 集合（这是我这轮错了两次的地方，必须钉死）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eq-merge-"));
  // 2a：文件不存在 ⇒ created:true
  const r1 = P2.mergeGitignore(tmp, ["a.txt", "b.txt"]);
  const k1 = Object.keys(r1).sort().join(",");
  ok(
    k1 === "added,changed,created,path",
    "② mergeGitignore 返回 key = added,changed,created,path",
    k1
  );
  ok(Array.isArray(r1.added), "②b mergeGitignore.added 是**数组**（不是数字）", Array.isArray(r1.added) ? `数组(${r1.added.length})` : `🔴 ${typeof r1.added}`);
  ok(r1.created === true && r1.changed === true, "②c 首次创建 ⇒ created:true / changed:true", `created=${r1.created} changed=${r1.changed}`);
  // 2d：再加一次同样的行 ⇒ changed:false
  const r2 = P2.mergeGitignore(tmp, ["a.txt", "b.txt"]);
  ok(r2.changed === false && r2.created === false, "②d 重复调用 ⇒ changed:false / created:false", `changed=${r2.changed} created=${r2.created}`);
  // 2e：内容确实写进去了
  const gi = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
  ok(/a\.txt/.test(gi) && /b\.txt/.test(gi), "②e .gitignore 里真的有那两行", gi.trim().replace(/\n/g, " | ").slice(0, 60));
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const keys = Object.keys(P2.stageOutcomeOf({ ok: true, skipped: [] }, ["x"])).sort().join(",");
  ok(
    keys === "staged,stagedNote,stagedPaths,stagedSkipped",
    "② stageOutcomeOf 返回 key = staged,stagedNote,stagedPaths,stagedSkipped",
    keys
  );
  const a = P2.stageOutcomeOf({ ok: true, skipped: [] }, ["x"]);
  ok(a.staged === true && Array.isArray(a.stagedPaths) && a.stagedPaths[0] === "x", "②b staged 是**布尔**、stagedPaths 是数组", `staged=${a.staged}(${typeof a.staged})`);
  const b = P2.stageOutcomeOf({ ok: true, skipped: ["x"] }, ["x"]);
  ok(b.staged === false, "②c 全被 skip ⇒ staged:false（这是当初修过的那个反向 bug）", `staged=${b.staged}`);
  const c = P2.stageOutcomeOf({ ok: false, error: "boom" }, ["x"]);
  ok(c.staged === false && /boom/.test(String(c.stagedNote)), "②d git add 失败 ⇒ staged:false 且 note 带原因", `note=${String(c.stagedNote).slice(0, 30)}`);
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eq-dfl-"));
  fs.writeFileSync(path.join(tmp, "README.md"), "# x\n", "utf8");
  const none = P2.findDeFactoLedger(tmp);
  ok(none === undefined, "② findDeFactoLedger：没有台账文件 ⇒ undefined", String(none));
  fs.writeFileSync(path.join(tmp, "项目台账.md"), "a\nb\nc\n", "utf8");
  const found = P2.findDeFactoLedger(tmp);
  ok(
    found !== undefined && found.name === "项目台账.md" && found.lines === 3,
    "②b 有台账 ⇒ {name, lines}（且 README 被 EXCLUDE 排除）",
    JSON.stringify(found)
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── ③ 外部调用方零改动：它们 import 的都是 part2
//   ★ 我第一版这里**报了假红**：`defs.js` 只在**注释**里提到 `mergeGitignore`（解释它怎么用），
//     我把"提到"当成了"使用" ⇒ 要求它必须有 import 语句 ⇒ 必然失败。
//   ★ 判据：**先剥注释再判"用没用"** —— 注释里的名字不是使用。
//     （这与本项目纪律第 2 条同型：判据的输入必须是"被测对象自己"的那部分，不是描述它的文字。）
{
  const callers = ["part1.js", "part4.js", "part5.js", "index.js", "defs.js"];
  const bad = [];
  const stripComments = (t) =>
    t
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
  for (const f of callers) {
    const t = stripComments(fs.readFileSync(path.join(ROOT, f), "utf8"));
    for (const n of NAMES) {
      if (!new RegExp(`\\b${n}\\b`).test(t)) continue; // 剥注释后真没用到
      const fromP2 = new RegExp(`import\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from\\s*"\\./part2\\.js"`, "s").test(t);
      const fromPO = new RegExp(`import\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from\\s*"\\./pure-ops\\.js"`, "s").test(t);
      if (!fromP2 && !fromPO) bad.push(`${f}:${n}`);
    }
  }
  ok(bad.length === 0, "③ 外部调用方都能解析到这三个名字（剥注释后判，无需改 import）", bad.length ? bad.join(", ") : "全部从 part2/pure-ops 取");
}

// ── ④ pure-ops 不成环：它只 import base（叶子）
//   ★ 第一版**报了假红**：我用 `/from\s+"(\.\/[^"]+)"/g` 扫全文，**扫到了我写在文件头上的注释**
//     （那句举例 `import { … } from "./part2.js"`）⇒ 误判成"它 import 了 part2"。
//   ★ 判据：**扫 import 必须锚行首 `^import`**，不能全文件乱找 from。
{
  const t = fs.readFileSync(path.join(ROOT, "pure-ops.js"), "utf8");
  const imports = [...t.matchAll(/^import[\s\S]*?from\s+"(\.\/[^"]+)"/gm)].map((m) => m[1]);
  ok(
    imports.every((p) => p === "./base.js"),
    "④ pure-ops.js 的**真 import** 只有 base.js（叶子模块）⇒ 不成环",
    imports.join(", ") || "(无相对 import)"
  );
}

let pass = 0;
let fail = 0;
for (const r of results) {
  console.log(`  ${r.c ? "PASS" : "FAIL"}  ${r.label}  —— ${r.detail}`);
  if (r.c) pass++;
  else fail++;
}
console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
