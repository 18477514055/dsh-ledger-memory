#!/usr/bin/env node
/**
 * ★★★★★ 探针：**V3 迁移会不会让自检的两条守卫静默失效**（D297）。
 *
 * 🔴 为什么必须单独验：
 *   自检里有两处读 `LEDGER.md`，找不到就 `⏭ 跳过`（那个分支本来是给**发布包**用的）。
 *   V3 迁移会把 `LEDGER.md` 搬进 `<项目名>-ledger-memory/` ⇒
 *   **同一个"文件不存在"，在开发树上就变成了"守卫永久失去牙齿"，而且不报红。**
 *   ★ 这与本项目反复记的那类错完全同型：**跳过等于放行，静默失效比没有守卫更糟。**
 *
 * 三组断言：
 *   ① **V2 形态**：`ledgerPathOf` 返回项目根下的台账（旧行为不许被改坏）
 *   ② **V3 形态**：清单里有 `memoryRoot` ⇒ 路径**必须**跟着走（这是修的东西）
 *   ③ **假绿检测**：在有清单、但台账按地址找不到的目录里跑，**那两条守卫必须报红**，
 *      而不是像以前那样"跳过 ⇒ 通过"
 *
 * ★ 第 ③ 组是本探针的重点：**它验的不是"路径算对了"，而是"错了会不会被看见"。**
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

let pass = 0;
let fail = 0;
const ok = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
};

// ── 先把 `ledgerPathOf` / `readProjectManifest` 从 selftest 里"取"出来用 ────
//
// ★ 为什么不 import：selftest.mjs 是个**会跑完整个自检**的脚本，import 它等于跑 2143 条。
//   ⇒ 用正则把那两个函数**原样截出来**求值。这样测的是**同一份代码**，
//     不是"我另写一份长得像的实现"（那种测法只能证明我抄对了，不能证明自检用对了）。
const selftestSrc = fs.readFileSync(path.join(HERE, "selftest.mjs"), "utf8");

/** 从源码里截一个 `function name(...) { ... }`（按大括号配平）。 */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const braceStart = src.indexOf("{", start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const fnPathOf = extractFunction(selftestSrc, "ledgerPathOf");
const fnManifest = extractFunction(selftestSrc, "readProjectManifest");
ok("⓪a 能从 selftest 里截出 ledgerPathOf", fnPathOf !== null);
ok("⓪b 能从 selftest 里截出 readProjectManifest", fnManifest !== null);
ok(
  "⓪c selftest 的**有效代码行**里不再有 `HERE, \"..\", \"LEDGER`",
  // ★ 判据必须只吃"有效代码"（纪律 2）：注释里提到这个串是**说明**，不是用法。
  //   ★★ 而且范围要窄：`path.join(root, "LEDGER.md")` 里 root 是**临时测试项目的根**，
  //     那是夹具、完全正当 —— 最初我把它一起算进来，143 条全是噪声（典型的尺子太宽）。
  //     真正的气味只有一个：**拿 `HERE/..`（=本仓库根）去拼台账**。
  selftestSrc
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .every((l) => !/HERE,\s*"\.\."\s*,\s*"LEDGER/.test(l)),
  "还有有效代码行在用 HERE/.. 拼 LEDGER"
);

// ── ① / ② 纯函数级：造两个临时项目，一个 V2 一个 V3 ──────────────────────────
console.log("\n=== ① V2 形态：台账在项目根（旧行为不许被改坏）===\n");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-d297-v2-"));
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify({ active: "LEDGER.md" }), "utf8");
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n", "utf8");

  const fn = new Function("fs", "path", "PROJECT_ROOT", `${fnPathOf}\nreturn ledgerPathOf;`)(
    fs,
    path,
    dir,
  );
  const got = fn({ active: "LEDGER.md" });
  ok("①a V2：路径 = 项目根/LEDGER.md", got === path.join(dir, "LEDGER.md"), got);
  ok("①b V2：该文件真的存在", fs.existsSync(got));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n=== ② V3 形态：清单有 memoryRoot ⇒ 路径必须跟着走 ===\n");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-d297-v3-"));
  const memDir = "proj-ledger-memory";
  fs.mkdirSync(path.join(dir, memDir), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".dsh-ledger.json"),
    JSON.stringify({ active: "LEDGER.md", memoryRoot: memDir }),
    "utf8",
  );
  // ★ 刻意**只在子目录里**放台账，项目根**不放** —— 这正是迁移后的真实形态
  fs.writeFileSync(path.join(dir, memDir, "LEDGER.md"), "# 台账\n", "utf8");

  const fn = new Function("fs", "path", "PROJECT_ROOT", `${fnPathOf}\nreturn ledgerPathOf;`)(
    fs,
    path,
    dir,
  );
  const got = fn({ active: "LEDGER.md", memoryRoot: memDir });
  ok("②a V3：路径 = memoryRoot/LEDGER.md", got === path.join(dir, memDir, "LEDGER.md"), got);
  ok("②b V3：该文件真的存在（不是只看字符串）", fs.existsSync(got));
  ok(
    "②c V3：**不再**指向项目根那一个（否则就是没跟着走）",
    got !== path.join(dir, "LEDGER.md"),
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ③ 假绿检测：真的跑一次自检，看它在「清单在、台账找不到」时会不会报红 ──────
console.log("\n=== ③ 关键：清单在但台账找不到 ⇒ 守卫必须报红（不许静默跳过）===\n");
{
  // ★ 做法：把整个仓库**复制到临时目录**，然后在副本里做两件事：
  //   ① 把 `LEDGER.md` 挪进 `<名字>-ledger-memory/` 并改清单 ⇒ **应当仍然全绿**（真 V3 形态）
  //   ② 再把它删掉、清单不改 ⇒ **必须报红**（这才是"路径算错"该有的样子）
  //
  //   ⚠️ 只复制**跑自检必需的部分**（lib/tools/清单/台账），不复制 node_modules 与 .git。
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-d297-run-"));
  const copyDir = (rel) => {
    const from = path.join(REPO, rel);
    const to = path.join(work, rel);
    if (!fs.existsSync(from)) return;
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(from, { withFileTypes: true })) copyDir(`${rel}/${e.name}`);
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  };
  for (const r of ["lib", "tools", "package.json", "cordis.patch.yml", ".dsh-ledger.json", "LEDGER.md"]) {
    copyDir(r);
  }
  // 自检要读的几样（缺了会大量报红，与本探针无关）—— 一并复制
  for (const r of ["README.md", "LICENSE", "decisions", "lessons", "goals", "PRINCIPLES.md", "JOURNAL.md"]) {
    copyDir(r);
  }

  const runSelftest = (cwd) => {
    const r = spawnSync(process.execPath, [path.join(cwd, "tools", "selftest.mjs")], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return {
      code: r.status,
      failCount: (out.match(/^\s*FAIL/gm) ?? []).length,
      out,
    };
  };

  // 基线：原样的副本应当通过
  const base = runSelftest(work);
  ok("③a 基线副本自检通过（0 FAIL）", base.failCount === 0, `实际 ${base.failCount} FAIL`);

  // 变成 V3：把台账搬进子目录并改清单
  const memName = "dsh-d297-ledger-memory";
  fs.mkdirSync(path.join(work, memName), { recursive: true });
  fs.renameSync(path.join(work, "LEDGER.md"), path.join(work, memName, "LEDGER.md"));
  const mf = JSON.parse(fs.readFileSync(path.join(work, ".dsh-ledger.json"), "utf8"));
  mf.memoryRoot = memName;
  fs.writeFileSync(path.join(work, ".dsh-ledger.json"), `${JSON.stringify(mf, null, 2)}\n`, "utf8");

  const v3 = runSelftest(work);
  ok("③b ★ V3 形态下自检**仍然 0 FAIL**（守卫没有因为搬家而失效）", v3.failCount === 0, `实际 ${v3.failCount} FAIL`);
  ok(
    "③c ★ 而且它**没有**退化成「跳过」—— 说明真的读到了新位置的台账",
    !/"口径：台账 §7 表与代码一致（⏭ 跳过/.test(v3.out),
    "出现了「跳过 ⇒ 通过」，说明没找到新位置的台账",
  );

  // 反向：把台账删掉但清单照旧 ⇒ 必须报红
  fs.unlinkSync(path.join(work, memName, "LEDGER.md"));
  const broken = runSelftest(work);
  ok("③d ★★★ 清单在、台账没了 ⇒ **必须报红**（这才是修好了，不许静默跳过）", broken.failCount > 0, `实际 ${broken.failCount} FAIL`);

  fs.rmSync(work, { recursive: true, force: true });
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`d297-ledger-path 探针：${pass} PASS / ${fail} FAIL`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
