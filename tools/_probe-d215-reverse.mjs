/**
 * 反向验证（D215）：把三处修复**逐一摘掉**，确认情形 91 的断言**真的会红**。
 *
 * ★ 为什么必须做（纪律 10：**反向验证必须摘到"能看见红"为止**）：
 *   自检 1689 全绿**不构成**"我的新代码在起作用"的证据 ——
 *   它只证明"没弄坏旧东西"。若情形 91 的断言太弱（或修复冗余），
 *   摘掉修复它照样全绿 ⇒ 那些断言根本没在管这件事。
 *
 * ★ 做法：在 `%TEMP%` 的**副本**上改 `lib/index.js`（**绝不碰真源码**），
 *   每摘一处跑一次自检，期望**恰好那一两条变红**。
 *
 * 摘除点（与 D215 卡片逐一对应）：
 *   A. 过期排队撤销   —— `staleQueued` 那个 return 整段
 *   B. L0 看 data.error —— `compactionEndFailed` 那个分支
 *   C. 外来压缩抓胶囊 —— `compaction/start` 那个分支
 *   D.（附带）`ours` 判据 —— 用回 `snap !== undefined`（应让 91⑥b 红）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const LIB = path.join(ROOT, "lib", "index.js");
const SELFTEST = path.join(ROOT, "tools", "selftest.mjs");
const src = fs.readFileSync(LIB, "utf8");

/** 每个摘除点：{名, 断言期望哪条红, 摘除后的内容} */
const CASES = [
  {
    name: "A 摘掉「过期排队撤销」",
    expect: "91①",
    mutate: (s) => {
      // ★ 第一版这里是**夹具错**（纪律 6）：我插了 `if (false)` 却没给原来的 `if`
      //   加 else，结果得到 `if (false) if (…) {…}` 两段相邻 if —— 语法上能过，
      //   但**整个副本跑不起来**（自检一条都没输出）⇒ 那不是"断言没见红"，
      //   是"夹具没走通"。⇒ 现在改成**把水位判据本身短路**（只改一个表达式，不动结构）。
      const marker = "if (autoSourced && typeof measuredRatio === \"number\" && measuredRatio < line) {";
      if (!s.includes(marker)) throw new Error("找不到 A 的锚点");
      return s.replace(marker, "if (autoSourced && false) {");
    },
  },
  {
    name: "B 摘掉「L0 看 data.error」",
    expect: "91③",
    mutate: (s) => {
      const marker = "    if (compactionEndFailed(d)) {";
      if (!s.includes(marker)) throw new Error("找不到 B 的锚点");
      return s.replace(marker, "    if (false) {");
    },
  },
  {
    name: "C 摘掉「外来压缩抓胶囊」",
    expect: "91⑥",
    mutate: (s) => {
      const marker = 'if (event?.type === "compaction/start") {';
      if (!s.includes(marker)) throw new Error("找不到 C 的锚点");
      return s.replace(marker, "if (false) {");
    },
  },
  {
    name: "D 把 ours 判据退回 snap !== undefined",
    expect: "91⑥e",
    mutate: (s) => {
      const marker = "            ours: oursFlag,";
      if (!s.includes(marker)) throw new Error("找不到 D 的锚点");
      return s.replace(marker, "            ours: snap !== undefined,");
    },
  },
];

/** 在副本上跑自检，返回 {ok, failed:[], tail} */
function runSelftest(libSource, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rev-d215-${tag}-`));
  try {
    // 复制整个仓库（除 _ledger-* / .git），保证自检找得到所有依赖
    fs.cpSync(ROOT, dir, {
      recursive: true,
      filter: (p) => {
        const rel = path.relative(ROOT, p);
        if (rel === "") return true;
        if (/^(\.git|_ledger-archive|_ledger-log|_stash|node_modules)([\\/]|$)/.test(rel)) return false;
        return true;
      },
    });
    fs.writeFileSync(path.join(dir, "lib", "index.js"), libSource, "utf8");
    let out = "";
    let ok = true;
    try {
      out = execFileSync(process.execPath, [path.join(dir, "tools", "selftest.mjs")], {
        cwd: dir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600_000,
      });
    } catch (e) {
      ok = false;
      out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
    }
    const failed = [...out.matchAll(/^    - (.+)$/gm)].map((m) => m[1].trim());
    const tail = (out.match(/通过 \d+ 项，失败 \d+ 项/) ?? ["(没拿到汇总行)"])[0];
    return { ok, failed, tail };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ }
  }
}

console.log("=== 反向验证：逐处摘掉修复，看断言是否真的红 ===\n");
let bad = 0;
for (const c of CASES) {
  const mutated = c.mutate(src);
  const r = runSelftest(mutated, c.name.slice(0, 1));
  // ★ 期望：**恰好**期望的那条（或含它名字的）出现在失败清单里
  const hit = r.failed.some((f) => f.includes(c.expect));
  const stillGreen = r.ok === true;
  const verdict = hit && !stillGreen ? "✅ 见红（断言真的在管这件事）" : "❌ **没见红 ⇒ 那条断言是空的**";
  if (!(hit && !stillGreen)) bad += 1;
  console.log(`${c.name}`);
  console.log(`  期望失败含「${c.expect}」  实际：${r.tail}`);
  console.log(`  失败清单：${r.failed.length === 0 ? "(空)" : r.failed.map((f) => f.slice(0, 60)).join(" ｜ ")}`);
  console.log(`  ⇒ ${verdict}\n`);
}

console.log(bad === 0
  ? "✅ 四个摘除点**全部见红** ⇒ 情形 91 的断言确实在守这三处修复（不是空转）"
  : `❌ 有 ${bad} 个摘除点**没见红** ⇒ 对应断言太弱，必须加强`);
process.exit(bad === 0 ? 0 : 1);
