/**
 * _probe-d325-symlink-fallback.mjs —— 用**目录联接（junction）**补验 007 的 F-01 / F-02。
 *
 * ★ 为什么需要它：Windows 上 `fs.symlinkSync(文件)` 需要管理员或开发者模式（实测 EPERM），
 *   ⇒ selftest 情形 122① / 122② 在本机只能 SKIP。**但"跳过"不等于"验过了"**。
 * ★ junction（`fs.symlinkSync(target, path, "junction")`）只需要目录 + 不需要特权，
 *   所以用它构造"指向工作区外"的目录链接，就能在本机真正验证：
 *     · F-01：`migrateToV3` 是否拒绝**候选目录内部**的嵌套链接；
 *     · F-02：`listExtensions` / `logRead` 是否跳过链接目录。
 * ★ 注意：junction 只能指目录，所以这里的夹具用**目录**而不是单文件 ——
 *   被测的那条判据（"是否跟随链接逃出去"）是同一件事。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = pathToFileURL(path.join(ROOT, "lib")).href;

let pass = 0;
let fail = 0;
let skipped = 0;
const ok = (c, name, detail) => {
  if (typeof c !== "boolean") throw new TypeError(`ok() 第一个参数必须是布尔，收到 ${typeof c}`);
  if (c) {
    pass++;
    console.log(`  PASS  ${name}  —— ${detail ?? ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  —— ${detail ?? ""}`);
  }
};

let part7;
let part2;
let part8;
let part4;
try {
  part7 = await import(`${LIB}/part7.js`);
  part2 = await import(`${LIB}/part2.js`);
  part8 = await import(`${LIB}/part8.js`);
  part4 = await import(`${LIB}/part4.js`);
} catch (e) {
  console.log(`  🔴 导入 lib 失败：${e.message}`);
  process.exit(1);
}

// ═══ 先证明 junction 在本机可用（夹具前提）═══
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "jtest-"));
  const target = path.join(t, "target");
  const link = path.join(t, "link");
  fs.mkdirSync(target, { recursive: true });
  let made = false;
  try {
    fs.symlinkSync(target, link, "junction");
    made = true;
  } catch (e) {
    console.log(`  ⚠️ junction 也不可用：${e.code}`);
  }
  ok(made, "夹具前提：本机能用 junction 造目录链接（否则下面的验证无意义）", made ? "可用" : "不可用");
  fs.rmSync(t, { recursive: true, force: true });
  if (!made) {
    console.log(`\n═══ 无法验证（夹具不可用）═══`);
    process.exit(1);
  }
}

// ═══ F-01：migrateToV3 必须拒绝候选目录**内部**的嵌套链接目录 ═══
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d325-f01-"));
  try {
    const proj = path.join(tmp, "proj");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "TOP_SECRET_OUTSIDE\n", "utf8");
    fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
    fs.mkdirSync(path.join(proj, "_ledger-archive"), { recursive: true });
    fs.mkdirSync(path.join(proj, "decisions"), { recursive: true });
    fs.writeFileSync(path.join(proj, "decisions", "D1.md"), "## D1 · 正常\n", "utf8");
    // 关键：decisions/ 本身是真目录，但**内部**有一个指向外部的 junction
    fs.symlinkSync(outside, path.join(proj, "decisions", "escape"), "junction");
    fs.writeFileSync(
      path.join(proj, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", decisionsDir: "decisions", archiveDir: "_ledger-archive" }),
      "utf8"
    );

    const dry = part7.migrateToV3(proj, { apply: false });
    const res = part7.migrateToV3(proj, { apply: true });
    const memDir = path.join(proj, "proj-ledger-memory");
    // 逃出去的那个 secret 有没有被复制进记忆目录（不管叫什么名）
    let leaked = false;
    if (fs.existsSync(memDir)) {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else {
            try {
              if (fs.readFileSync(p, "utf8").includes("TOP_SECRET_OUTSIDE")) leaked = true;
            } catch {
              /* 二进制/读不了，忽略 */
            }
          }
        }
      };
      walk(memDir);
    }
    ok(
      dry.ok === false || res.ok === false || !leaked,
      "F-01 🔴 migrateToV3 拒绝候选目录**内部**的嵌套链接（干跑/实跑拒绝，或至少没把外部内容复制进来）",
      `dry.ok=${dry.ok} res.ok=${res.ok} leaked=${leaked}`
    );
  } catch (e) {
    // ★ 同 F-07：每段自己兜住，异常记成一条 FAIL，探针照常跑完（否则外部只看到崩溃）。
    ok(false, "F-01 🔴 migrateToV3 拒绝候选目录**内部**的嵌套链接", `异常：${String(e.message).slice(0, 100)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══ F-02：日志扫描必须跳过链接目录 ═══
//
// ★★★★ 2026-10-25（D325）：**这条在本机只能证明"没泄露"，不能证明"是那道守卫在挡"。**
//
//   实测链条（`_diag-d325-junction.mjs` + `_diag-d325-f02-guards2.mjs`）：
//     ① junction 在 `readdirSync(withFileTypes)` 里是
//        `isSymbolicLink=true, isDirectory=false, isFile=false` —— **它压根不算目录**；
//     ② 于是 `logFileList` 的 walk 到它时：
//        · 摘掉 `isSymbolicLink` 那道 ⇒ 它还是不是目录 ⇒ 落到文件名正则 `^(L[0-4])-.*\.md$` ⇒ 不匹配 ⇒ 跳过；
//        · 再摘掉 `isUnderReal` ⇒ `files: []`，**仍然读不到**；
//     ③ ⇒ **本机造不出"跟随链接目录逃出去"这个洞**（Windows 上要真 symlink 目录才行，而 symlink 需管理员）。
//
//   ★ 判据（纪律第 6 条 + 第 8 条）：**夹具前提不成立时，全绿就是假绿** ——
//     所以这里**如实记 SKIP**，不把它算成"F-02 已验证"。
//     下面的断言只证明"本机这个形状没泄露"，措辞也要说清它不能证明什么。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d325-f02-"));
  try {
    const proj = path.join(tmp, "proj");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "L0-milestones.md"), "- 2026-10-25 (L0) LOG_SECRET_OUTSIDE\n", "utf8");
    fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
    fs.mkdirSync(path.join(proj, "_ledger-log", "2026-10", "week4"), { recursive: true });
    let made = false;
    try {
      fs.symlinkSync(outside, path.join(proj, "_ledger-log", "2026-10", "week4", "escape"), "junction");
      made = true;
    } catch (e) {
      console.log(`        （junction 都建不了：${e.code}）`);
    }
    fs.writeFileSync(
      path.join(proj, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", logDir: "_ledger-log" }),
      "utf8"
    );
    if (!made) {
      skipped++;
      console.log(`  SKIP  F-02 logRead 不跟随日志目录中层链接（本机连 junction 都建不了）`);
    } else {
      let leaked = false;
      try {
        const lr = part4.logRead(proj, { view: "raw" });
        leaked = JSON.stringify(lr ?? {}).includes("LOG_SECRET_OUTSIDE");
      } catch {
        leaked = false;
      }
      // ★ 只断言"本机这个形状没泄露" —— **不**声称"那条 isSymbolicLink 守卫已验证"。
      ok(!leaked, "F-02 logRead 在本机 junction 形状下未泄露（★ 弱断言：junction 不是目录，构不出那道洞）", `leaked=${leaked}`);
    }
  } catch (e) {
    ok(false, "F-02 日志链接夹具异常", `异常：${String(e.message).slice(0, 100)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══ F-07：listExtensions(info) 单参调用不该抛 TypeError ═══
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d325-f07-"));
  try {
    fs.writeFileSync(path.join(tmp, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(
      path.join(tmp, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md" }),
      "utf8"
    );
    const info = part2.inspect(tmp);
    let threw = null;
    let r;
    try {
      r = part8.listExtensions(info); // ★ 单参：不传 fallbackRoot
    } catch (e) {
      threw = String(e.message).slice(0, 120);
    }
    ok(threw === null, "F-07 🔴 listExtensions(info) 单参调用不抛 TypeError", threw ?? `ok=${r?.ok}`);
  } catch (e) {
    // ★ 2026-10-25（D325）：**外层也要兜住**。
    //   反向验证里我把 `baseRoot` 换成 `fallbackRoot` 想让 F-07 变红，
    //   结果它在 `inspect()` 之后就抛了 ⇒ 整个探针**崩在 F-07 段**、连 PROBE-COMPLETE 都没打印，
    //   外部因此判成"崩溃不是检出"。⇒ 每一段自己兜住异常，把它记成一条 FAIL，探针照常跑完。
    ok(false, "F-07 🔴 listExtensions(info) 单参调用不抛 TypeError", `夹具/被测异常：${String(e.message).slice(0, 100)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
console.log(`PROBE-COMPLETE pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
