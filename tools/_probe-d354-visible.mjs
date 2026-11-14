// _probe-d354-visible.mjs —— 最后那 1/8：「只留可见文本」能不能扛，代价多大
// ★ 前提已明确：想扛住"只留可见文本"，信标就必须**真的可见**。
//   候选可见形态，逐个量「字数」与「能否扛住」。
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };

const PROJ = "0123456789abcdef";
const KEY = "D195";

// 候选可见信标（都嵌在标题行尾）
const cands = [
  { name: "① 全项目+key 明文", text: ` [dsh:${PROJ}:${KEY}]`, budget: 30 },
  { name: "② 项目短码+key", text: ` [dsh:a1b2${KEY}]`, budget: 14 },
  { name: "③ 只 key（项目靠清单）", text: ` {#${KEY}}`, budget: 10 },
  { name: "④ key+4 字符校验", text: ` {#${KEY}.c0de}`, budget: 15 },
  { name: "⑤ 极短：项目2+key", text: ` 〔a1${KEY}〕`, budget: 9 },
];

console.log("=== 可见信标候选：字数代价 ===");
for (const c of cands) {
  console.log(`  ${c.name.padEnd(22)} ${String(c.text.length).padStart(3)} 字符  ${JSON.stringify(c.text)}`);
}

// ★ 关键判据：这些是**真可见**的，所以它们一定能扛住"只留可见文本"
console.log("\n=== 能否扛住「只留可见文本」===");
const washer = (t) => {
  // 只留可见文本：去 frontmatter、去 HTML 注释、去链接定义
  let s = t.replace(/^---\n[\s\S]*?\n---\n/, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/^\[[^\]]+\]:.*$/gm, "");
  return s;
};
for (const c of cands) {
  const doc = `# 标题${c.text}\n\n正文\n`;
  const out = washer(doc);
  const alive = out.includes("D195");
  ok(`${c.name} 扛住洗法`, alive);
}

// ── 代价对比：不可见 vs 可见 ──
console.log("\n=== 代价对比（每份文件）===");
const invisible = " <!--dsh-id:0123456789abcdef:D195-->";
console.log(`  不可见（现状）  ${String(invisible.length).padStart(3)} 字符，但**扛不住**「只留可见文本」`);
console.log(`  可见 ②          ${String(cands[1].text.length).padStart(3)} 字符，**扛得住**，但正文里会看到`);

// ── 一个折中：把可见信标做成"读起来像正常标注" ──
console.log("\n=== 折中方案：让它读起来不像垃圾 ===");
const niceForms = [
  `# D195 · 某决定`,
  `# D195 · 某决定 〔a1〕`,
  `D195 · 某决定`,
];
niceForms.forEach((f) => console.log(`  ${JSON.stringify(f)}`));

// ★★ 真正的洞察：**key 本身已经是可见的**（D195 在标题里）！
console.log("\n=== ★★★★ 关键发现：卡片类的 key 本来就在正文里 ===");
const realCards = [
  "# D195 · 某决定",
  "## D195 · 标题",
  "## 目标 g1 · 状态",
  "## 经验 E2 · 机制",
];
for (const c of realCards) {
  const m = /\b(D\d+|g\d+|E\d+|L\d+)\b/.exec(c);
  ok(`「${c}」里能抓到 key=${m?.[1]}`, m !== null);
}
console.log("  ⇒ 决策/经验/目标卡的 key **天然可见** ⇒ 这类文件即使被洗到只剩可见文本，也能认出 key");
console.log("  ⇒ 真正需要额外可见信标的，只有「单例文件」（LEDGER/JOURNAL/PRINCIPLES/SECURITY）——");
console.log("     它们单靠标题是认不出来的。而它们各只有 1 个，代价极低。");

// ── 结论量化 ──
console.log("\n=== 分类型结论 ===");
console.log("  卡片类（decisions/lessons/goals，共 405 份）");
console.log("    ⇒ 标题里已有 D195/L1/E2/g1 这类 key ⇒ **不需要额外可见信标**");
console.log("  单例类（active/journal/principles/security，共 4 份）");
console.log("    ⇒ 需要，但只 4 份 ⇒ 加 14 字符/份 完全可接受");
console.log("  碎片/归档/日志（598 份）");
console.log("    ⇒ 本来就不靠名字引用 ⇒ 不可见载体够用");

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
