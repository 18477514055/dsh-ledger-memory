/**
 * ★★★ 反向验证（纪律第 10 条）：**摘到能看见红为止**。
 *
 * 逐一摘掉「被压段可回读」这条链的关键实现，每摘一处**立即**跑自检，
 * 断言对应的情形 45 断言必须变红；跑完自动恢复原文件。
 *
 * ★ 为什么必须自动化：手工「摘 + 跑 + 恢复」太慢，且容易忘恢复（文件留在半改状态）。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const FILE = "lib/index.js";
const orig = fs.readFileSync(FILE, "utf8");
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
console.log(`原文件 sha256(前16) = ${h(orig)}`);

const CASES = [
  {
    tag: "① 摘掉「常规注入推行索引」（idxBlock 置空）",
    from: '  const idxBlock = shadowedIndex === undefined ? "" : shadowedIndex;',
    to: '  const idxBlock = "";',
    expect: "45③",
  },
  {
    tag: "② 摘掉「回读里的推理块」",
    from: '          parts.push(`[推理] ${blk.text ?? ""}`);',
    to: "          /* 摘掉推理块（反向验证） */;",
    expect: "45②",
  },
  {
    tag: "③ 摘掉「官方压缩那条路补记索引」",
    from: '          recordShadowedIndex(state, String(sid), agent, "official");',
    to: "          /* 摘掉补记（反向验证） */;",
    expect: "45③",
  },
  {
    tag: "④ 摘掉「增量压缩那条路记索引」（★ 实测**确实不红** —— 已查清原因）",
    from: '  recordShadowedIndex(state, key, agent, "auto:delta");',
    to: "  /* 摘掉记索引（反向验证） */;",
    // ★★ 诚实结论（本测试**实测出来**的，不是推断）：
    //   摘掉它之后自检**仍然全绿**，因为 `agent/pre-step` 里那句兜底补记
    //   （`recordShadowedIndex(..., "official")`）会**读到同一条** `compaction/summary`
    //   —— 它对**所有**压缩路径都生效（包括我们不控制的内核 80% 那次）。
    //   ⇒ 所以这处调用**对"索引有没有"是冗余的**；它存在的价值是**把 source 标对**
    //     （"auto:delta" vs 兜底的 "official"），那是**可读性/可追查性**，不是功能性。
    //   ★ 两条纪律都守到了：既没有把它当"断言太弱"去硬补，
    //     也没有把它当"通过"——而是**把冗余本身查清并如实记下**（第 10 条）。
    expect: null,
    gapNote:
      "⇒ 实测**不红**，已查明是**冗余**（兜底补记覆盖所有路径）⇒ 保留它是为了 source 标注准确。" +
      "★ 若要让它变成「可被证伪」，得在情形 26 里驱动真增量压缩后断言 source 是 auto:delta（未做，记入待办）。",
  },
];

let allRed = true;
for (const c of CASES) {
  if (!orig.includes(c.from)) {
    console.log(`\n✗ ${c.tag}：**锚点没找到** ⇒ 本次反向验证无效（不等于通过）`);
    allRed = false;
    continue;
  }
  fs.writeFileSync(FILE, orig.replace(c.from, c.to));
  let out = "";
  try {
    out = execFileSync(process.execPath, ["tools/selftest.mjs"], { encoding: "utf8" });
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const m = out.match(/通过 (\d+) 项，失败 (\d+) 项/);
  const idx = out.indexOf("失败清单：");
  const failedList = idx === -1 ? "" : out.slice(idx);
  console.log(`\n${c.tag}`);
  console.log(`  ⇒ 自检：通过 ${m?.[1] ?? "?"} / 失败 ${m?.[2] ?? "?"}`);
  if (c.expect === null) {
    // ★ 预期不红 ⇒ 如实报"覆盖缺口"，**不**计入 allRed（缺口就是缺口，不许粉饰）。
    console.log(`  ⇒ ${c.gapNote ?? "预期不红（覆盖缺口）"}`);
    continue;
  }
  // ★ 判据只认「失败清单里出现了预期的那条」——之前写成三段式布尔，把自己绕晕了。
  const hit = failedList.includes(c.expect);
  console.log(`  ⇒ 期望变红（含「${c.expect}」）：${hit ? "✔ 确实红了" : "✗ **没红** ⇒ 断言太弱"}`);
  if (!hit) allRed = false;
}
fs.writeFileSync(FILE, orig);
console.log(`\n已恢复原文件。sha256(前16) = ${h(fs.readFileSync(FILE, "utf8"))}（应等于 ${h(orig)}）`);
console.log(allRed ? "\n★★★ 全部摘除都变红 ⇒ 断言有判别力。" : "\n⚠ 有断言没红 ⇒ 必须补强，不许当成通过。");
