/**
 * ★★★★★ 行为探针（D201）：**按条目取正文**真的解决问题吗？
 *
 * 用户原话（逐字）：*"我认为我们的整个记忆系统应该都要提高他们的召回率……"*
 *
 * ★★★ 这个探针要回答的**唯一问题**（也是 D201 全部工作的成败判据）：
 *   实测过的那个事实 —— **台账引用的 44 个 D 号里，42 个（95%）原来取不回来** ——
 *   现在**还取不回来吗**？
 *
 * ★ 判据设计（三条，缺一不可）：
 *   ① **正**：`entry:"D195"` 取回来的文本里**确实有 D195 的正文特征**（且**不含** D196 的）；
 *   ② **全覆盖**：把台账引用的**每一个** D 号都试着取一遍 ⇒ 统计命中率（原来 2/44）；
 *   ③ **不猜**：取一个**不存在**的条目 ⇒ 必须 `found:false` + 给目录，**绝不返回一条相近的**（那会制造假记忆）。
 *
 * 只读项目文件。跑法：node tools/_probe-d201-entry-read.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let bad = 0;
const check = (ok, label, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
};

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const tools = new Map();
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on: () => () => {},
  inject: (deps, cb) => {
    const s = { commands: { register: () => () => {} }, userQuestions: { async ask() { return { answers: [] }; } } };
    for (const d of deps) if (!(d in s)) return undefined;
    const scope = Object.create(ctx);
    for (const d of deps) scope[d] = s[d];
    return cb(scope);
  },
  get: () => undefined,
  webServer: { register: () => () => {} },
  configEditor: { entries: () => [], configuration: () => [], edit: async () => {} },
};
mod.apply(ctx, {});
const exec = { agent: { session: { header: { id: "s-d201", cwd: ROOT } } } };
const read = (a) => tools.get("ledger_read").execute(a, exec);

// ── ① 取回来的确实是那一条（且不是邻居）────────────────────────────────
bar("① `entry:\"D195\"` 取回来的是**那一条**吗？（且不会把 D196 也带进来）");
{
  const r = await read({ target: "decisions", entry: "D195" });
  check(r.found === true, "找到 D195", r.found ? `第 ${r.startLine}-${r.endLine} 行` : r.reason);
  const t = r.text ?? "";
  // ★ 内容特征：D195 讲的是"结构契约/可见性"，D196 讲"升级通道/功能清单"
  check(/D195/.test(t), "★ 正文标题里有 D195");
  check(/契约|可见性/.test(t), "★ 正文内容对得上（含「契约/可见性」这类 D195 的特征词）");
  check(!/^##\s*D196/m.test(t), "★★ **没有把 D196 也带进来**（边界切对了）", `长度 ${t.length} 字符`);
  console.log(`  ── 取回来的开头 ──\n${t.split("\n").slice(0, 3).map((l) => "    " + l).join("\n")}`);
}

// ── ② ★★★ 全覆盖：台账引用的**每一个** D 号都取一遍 ─────────────────────
bar("② ★★★ 台账引用的每个 D 号，现在**都取得到吗**？（原来只有 2/44）");
{
  const led = fs.readFileSync(path.join(ROOT, "LEDGER.md"), "utf8");
  const cited = [...new Set([...led.matchAll(/\bD(\d{1,3})\b/g)].map((m) => +m[1]))].sort((a, b) => a - b);
  const okList = [];
  const failList = [];
  for (const n of cited) {
    const r = await read({ target: "decisions", entry: `D${n}` });
    if (r.found === true && typeof r.text === "string" && r.text.length > 0) okList.push(n);
    else failList.push(n);
  }
  check(
    failList.length === 0,
    `★★★★★ 全部 ${cited.length} 个引用**都取得到**（D201 前实测只有 2 个）`,
    failList.length === 0 ? `覆盖 44/44 → 现在 ${okList.length}/${cited.length}` : `仍取不到：${failList.join(", ")}`
  );
  console.log(`  取得到：${okList.length} 个 · 取不到：${failList.length} 个`);
  // ★ 反向对照：证明"全都取得到"不是因为函数恒返回 true（③ 就是那个对照）
}

// ── ③ ★★ 最重要的一条：取不到时**绝不许猜** ─────────────────────────────
bar("③ 取一个**不存在**的条目：必须如实说「没有」+ 给目录，**绝不许返回相近的**");
{
  const r = await read({ target: "decisions", entry: "D99999" });
  check(r.found === false, "★ 如实回报 `found:false`（不是硬凑一条）", r.found ? "**它居然返回了内容！**" : "对");
  check(typeof r.reason === "string" && r.reason.includes("没有找到"), "★ 给出人话的原因", r.reason?.slice(0, 60));
  check(r.toc !== undefined && Array.isArray(r.toc.entries), "★★ 并附上一张**目录**（比让模型猜关键词有用）",
    r.toc === undefined ? "**没有目录**" : `目录 ${r.toc.count} 条`);
  // ★ 反向对照：证明 ③ 这条不是"因为函数什么都没返回所以看起来对" ——
  //   同一个不存在的键，在**目标树**上也要如实说没有
  const r2 = await read({ target: "goals", entry: "gZZZ" });
  check(r2.found === false, "★ 负向对照：目标树上取不存在的卡，同样如实回报", r2.found ? "**返回了内容**" : "对");
}

// ── ④ 各种条目的形状都能认（决策/教训/经验/目标卡/小节）───────────────
bar("④ 四种条目的形状**都认**吗？（决策 · 教训 · 经验 · 目标卡）");
{
  const cases = [
    ["decisions", "D1", "决策"],
    ["lessons", "L1", "教训"],
    ["lessons", "E1", "经验"],
    ["goals", "g1", "目标卡"],
  ];
  for (const [target, entry, label] of cases) {
    const r = await read({ target, entry });
    check(r.found === true && (r.text ?? "").length > 0, `${label} \`${entry}\` 取得到`, r.found ? `${r.text.length} 字符 · 第 ${r.startLine}-${r.endLine} 行` : r.reason);
  }
  // ★★ 反向对照：教训编号与经验编号**都是数字**，不许串（L1 不能取到 E1）
  const l1 = await read({ target: "lessons", entry: "L1" });
  const e1 = await read({ target: "lessons", entry: "E1" });
  check(
    /教训/.test(l1?.text ?? "") && /经验/.test(e1?.text ?? ""),
    "★★★★ **L1 取到的是「教训」、E1 取到的是「经验」**（两种编号同形，不许串）",
    `L1 含教训=${/教训/.test(l1?.text ?? "")} · E1 含经验=${/经验/.test(e1?.text ?? "")}`
  );
}

// ── ⑤ 整份读取被截断时，**别把模型丢在黑暗里** ────────────────────────
bar("⑤ 不带 entry 读超长文件：被截断时必须**指路 + 给目录**");
{
  const r = await read({ target: "decisions" });
  check(r.truncated === true, "★ 如实标 `truncated:true`（没有假装读全了）", `${r.chars} 字符，取了 ${(r.text ?? "").length}`);
  check(typeof r.hint === "string" && r.hint.includes("entry"), "★★ 并给出「怎么取到其余部分」的指路（entry）", "有");
  check(r.toc !== undefined && r.toc.count > 0, "★★ 并附**目录**（每条一行）", `目录 ${r.toc?.count} 条，列出 ${r.toc?.shown} 条`);
}

bar(`结  论：${bad === 0 ? "全部通过" : `${bad} 项不符合预期`}`);
console.log("  ★ 通过意味着：**「见 D195」这类精确引用现在真的能解析到正文**（原来 95% 取不回来）。");
console.log("  ★★ 而这一条与「模糊搜索」无关 —— 它治的是**取回能力**（D201 §一①）。");
