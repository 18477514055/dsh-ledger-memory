// _probe-d359-recent.mjs —— 验 D359「最近的工作」块：拿真项目跑，看它到底渲染出什么
//
// 四条必须成立的：
//   ① 真的读到了 L1（不是空）
//   ② 每条都**带时间戳**，且带「距今多久」
//   ③ 顺序是**倒序**（最近的在最上面）
//   ④ 拿不到 / 没有 L1 时返回 ""（**不抛、不挡重注**）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib", "part2.js");
const { renderRecentWork } = await import("file:///" + LIB.replace(/\\/g, "/"));

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 400)}`}`); }
};

// ── 真项目（本仓库）──────────────────────────────────
const REAL_ROOT = path.resolve(HERE, "..");
const realInfo = {
  projectRoot: REAL_ROOT,
  logRel: path.join("10.项目台账-ledger-memory", "_ledger-log"),
  memoryRoot: "10.项目台账-ledger-memory",
};

console.log("== ① 真项目上渲染 ==");
const txt = renderRecentWork(realInfo, Date.parse("2026-10-29T01:10:00+08:00"));
ok("非空（真读到了 L1）", typeof txt === "string" && txt.length > 200, `len=${txt?.length}`);
ok("有标题「最近的工作」", txt.includes("### 最近的工作"));
ok("明说「已经做过了，不要重做」", txt.includes("不要重做"));
ok("给了按需查的出口（ledger_log）", txt.includes("ledger_log"));

// ② 时间戳
const stamps = txt.match(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/g) ?? [];
ok("每条都带时间戳（≥1）", stamps.length >= 1, `stamps=${stamps.length}`);
const ages = txt.match(/（(刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前)）/g) ?? [];
ok("每条都带「距今多久」", ages.length === stamps.length, `stamps=${stamps.length} ages=${ages.length}`);
console.log(`  —— 时间戳 ${stamps.length} 个，相对时间 ${ages.length} 个`);

// ③ 倒序：第一条的时间必须 >= 最后一条
const rows = txt.split("\n").filter((l) => /^- `\d{4}-\d{2}-\d{2}/.test(l));
ok("渲染出了条目行", rows.length >= 1, `rows=${rows.length}`);
if (rows.length >= 2) {
  const t0 = rows[0].match(/`(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})`/)?.[1] ?? "";
  const tN = rows[rows.length - 1].match(/`(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})`/)?.[1] ?? "";
  ok("顺序是倒序（最近的在最上）", t0 >= tN, `first=${t0} last=${tN}`);
  ok("条数有界（≤6）", rows.length <= 6, `rows=${rows.length}`);
}
console.log("\n--- 实际渲染（前 1200 字符）---");
console.log(txt.slice(0, 1200));

// ── ④ 各种"拿不到"的情形，必须返回 "" 且不抛 ─────────────
console.log("\n== ② 拿不到时必须安静返回空 ==");
const cases = [
  ["没有 logRel", { projectRoot: REAL_ROOT, memoryRoot: "x" }],
  ["logRel 指向不存在的目录", { projectRoot: REAL_ROOT, logRel: "no-such-dir-xyz", memoryRoot: "x" }],
  ["info 是 undefined", undefined],
  ["info 是空对象", {}],
];
for (const [label, info] of cases) {
  let out, threw = false;
  try { out = renderRecentWork(info); } catch { threw = true; }
  ok(`${label} ⇒ 返回空且不抛`, threw === false && out === "", threw ? "抛异常了" : `out=${JSON.stringify(out)?.slice(0, 80)}`);
}

// ── ⑤ 空 L1 文件（有目录、文件存在但一条 L1 都没有）──────────
console.log("\n== ③ 有文件但没有 L1 行 ==");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d359-"));
  const logDir = path.join(tmp, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "L1-turns.md"), "# L1 回合摘要\n\n（暂无）\n", "utf8");
  const out = renderRecentWork({ projectRoot: tmp, logRel: "log" });
  ok("只有表头 ⇒ 返回空", out === "", `out=${JSON.stringify(out)?.slice(0, 120)}`);

  // ⑥ 真有条目 ⇒ 能渲染，且「下一步」也带出来
  fs.writeFileSync(
    path.join(logDir, "L1-turns.md"),
    "# L1\n" +
      "- 2026-10-29 00:10:00 (L1) 第一件事 ｜ 要什么：A ｜ 做了什么：做完了 A ｜ 改了：a.js ｜ 下一步：做 B\n" +
      "- 2026-10-29 00:20:00 (L1) 第二件事 ｜ 要什么：B ｜ 做了什么：做完了 B ｜ 改了：b.js ｜ 下一步：做 C\n",
    "utf8"
  );
  const out2 = renderRecentWork({ projectRoot: tmp, logRel: "log" }, Date.parse("2026-10-29T00:30:00+08:00"));
  ok("两条 L1 ⇒ 渲染出 2 行", (out2.match(/^- `/gm) ?? []).length === 2, out2);
  ok("带「下一步」", out2.includes("下一步"));
  ok("倒序：第二件事在上", out2.indexOf("第二件事") < out2.indexOf("第一件事"), out2);
  ok("相对时间算对（10 分钟前）", out2.includes("10 分钟前"), out2);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
