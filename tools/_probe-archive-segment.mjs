/**
 * 探针：`archiveSegmentOf` 的判据方向对不对？（D287）
 *
 * ★ 这套断言就是「用户拍板的新契约」的可执行版本：
 *   A. **活跃台账怎么改都放行** —— 改、删、精简都不影响归档判定（这是核心变化）
 *   B. **整段连续逐字 ⇒ 通过**，并报出真实行号
 *   C. **拼接 / 编造 / 空壳 ⇒ 拒绝**（这才是要拦的真风险）
 *   D. 首尾空行差异算格式噪声（粘贴常多/少一个换行）
 *   E. 拒绝时要给**能照着改**的诊断（前 k 行对得上 + 两边那行原文）
 *
 * ★ 与旧判据的对照断言也在里面（`lostLines` 仍会算，但不再是门槛）。
 *
 * 跑法：node tools/_probe-archive-segment.mjs
 */
import { archiveSegmentOf, lostLines, splitChangeRegister } from "../lib/part1.js";

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
};

// ── 夹具：一份"旧活跃台账" ──
const PRIOR = [
  "# 项目台账",
  "",
  "## 一、总纲",
  "",
  "- [a1] 10:00 第一条已完成",
  "  ★ 细节 A",
  "  ★ 细节 B",
  "- [a1] 10:05 第二条已完成",
  "  ★ 细节 C",
  "",
  "## 二、下一步",
  "",
  "- 还没做的事",
].join("\n");

console.log("── A. 整段连续逐字 ⇒ 通过，并报真实行号 ──");
{
  const entries = [
    "- [a1] 10:00 第一条已完成",
    "  ★ 细节 A",
    "  ★ 细节 B",
  ].join("\n");
  const r = archiveSegmentOf(PRIOR, entries);
  ok("A1 整段逐字 ⇒ 通过", r.ok === true, r.why);
  ok("A2 报出起始行号（原文第 5 行）", r.startLine === 5, `实际 startLine=${r.startLine}`);
  ok("A3 报出行数 3", r.lineCount === 3, `实际 ${r.lineCount}`);
}

console.log("\n── B. 首尾空行差异 = 格式噪声，不算不一致 ──");
{
  const entries = "\n\n- [a1] 10:00 第一条已完成\n  ★ 细节 A\n  ★ 细节 B\n\n";
  const r = archiveSegmentOf(PRIOR, entries);
  ok("B1 前后各多两个空行 ⇒ 仍通过", r.ok === true, r.why);
  ok("B2 行数仍算 3（空行被裁掉）", r.lineCount === 3, `实际 ${r.lineCount}`);
}

console.log("\n── C. 真风险：拼接 / 编造 / 空壳 ⇒ 必须拒绝 ──");
{
  // C1：把两段不相邻的内容**拼接**（中间隔了一个标题）
  const spliced = [
    "- [a1] 10:00 第一条已完成",
    "  ★ 细节 A",
    "  ★ 细节 B",
    "- [a1] 10:05 第二条已完成", // 中间隔着空行 + 标题，实际不连续
  ].join("\n");
  const r1 = archiveSegmentOf(PRIOR, spliced);
  // 说明：这一段在原文里其实是连续的（第5~8行之间没有别的内容），所以应当通过
  ok("C1 ⚠ 先确认夹具：这四行在原文里确实连续 ⇒ 应通过", r1.ok === true, r1.why);

  // C2：真正的拼接 —— 跳过中间的「## 二、下一步」等行
  const spliced2 = [
    "- [a1] 10:00 第一条已完成",
    "  ★ 细节 C", // 这行属于第二条，中间隔着别的行
  ].join("\n");
  const r2 = archiveSegmentOf(PRIOR, spliced2);
  ok("C2 跨段拼接 ⇒ 拒绝", r2.ok === false, `居然通过了：${JSON.stringify(r2)}`);

  // C3：编造一行（原文没有）
  const invented = [
    "- [a1] 10:00 第一条已完成",
    "  ★ 细节 A",
    "  ★ 这一行是我编的",
  ].join("\n");
  const r3 = archiveSegmentOf(PRIOR, invented);
  ok("C3 编造内容 ⇒ 拒绝", r3.ok === false);

  // C4：空 entries
  const r4 = archiveSegmentOf(PRIOR, "\n\n   \n");
  ok("C4 全空白 entries ⇒ 拒绝", r4.ok === false, r4.why);

  const r5 = archiveSegmentOf(PRIOR, "");
  ok("C5 空字符串 entries ⇒ 拒绝", r5.ok === false);
}

console.log("\n── D. 拒绝时必须给「能照着改」的诊断 ──");
{
  const bad = [
    "- [a1] 10:00 第一条已完成",
    "  ★ 细节 A",
    "  ★ 细节 B 被我改了",
  ].join("\n");
  const r = archiveSegmentOf(PRIOR, bad);
  ok("D1 拒绝", r.ok === false);
  ok("D2 诊断里说明了「前几行对得上」", /前 \d+ 行对得上/.test(r.hint ?? ""), r.hint);
  ok("D3 诊断里同时给出原文行与 entries 行", /台账原文/.test(r.hint ?? "") && /你交的 entries/.test(r.hint ?? ""));
  ok("D4 诊断里重申「活跃台账怎么改都行」", /活跃台账你怎么改都行/.test(r.hint ?? ""));
}

console.log("\n── E. ★核心契约：活跃台账被**改过**不影响归档判定 ──");
{
  // 【真实场景】我先归档一段，同时把**别的行**改掉（这正是昨天连撞四次的场景）
  const entries = [
    "- [a1] 10:00 第一条已完成",
    "  ★ 细节 A",
    "  ★ 细节 B",
  ].join("\n");

  // 改后：第 3~4 行（标题）、第 8 行都被改了，但 entries 覆盖的那 3 行**原样**
  const newActive = [
    "# 项目台账（改过的标题）",
    "",
    "## 一、总纲（就地更正）",
    "",
    "- [a1] 10:05 第二条已完成", // 第一条已被移走
    "  ★ 细节 C（补充）",
    "",
    "## 二、下一步",
    "",
    "- 还没做的事",
  ].join("\n");

  const r = archiveSegmentOf(PRIOR, entries);
  ok("E1 ★ entries 是原文里的一整段 ⇒ 通过（哪怕活跃台账已被大改）", r.ok === true, r.why);

  // ★★ 对照：旧判据会怎么判？（它只看"旧行还在不在"，所以会报一堆）
  const oldFound = lostLines(PRIOR, `${newActive}\n${entries}`);
  console.log(`        旧判据 lostLines 会报 ${oldFound.length} 行"丢失"（新判据已不再用它做门槛）`);
  ok(
    "E2 ★ 对照成立：旧判据会拦，新判据放行 ⇒ 换判据确有实际差别",
    oldFound.length > 0 && r.ok === true,
    `lostLines=${oldFound.length} ok=${r.ok}`,
  );
}

console.log("\n── F. 边界：entries 就是整份旧台账 ⇒ 通过（整段归档）──");
{
  const r = archiveSegmentOf(PRIOR, PRIOR);
  ok("F1 整份归档 ⇒ 通过", r.ok === true, r.why);
  ok("F2 行号从 1 开始", r.startLine === 1, `实际 ${r.startLine}`);
}

console.log("\n── G. 边界：变更登记区不算内容（两侧都剥）──");
{
  const priorWithReg = `${PRIOR}\n\n## 变更登记（插件自动维护）\n\n- 2026-10-21 10:00 (append) [a1] +3 行\n`;
  const entries = [
    "- [a1] 10:00 第一条已完成",
    "  ★ 细节 A",
    "  ★ 细节 B",
  ].join("\n");
  const r = archiveSegmentOf(priorWithReg, entries);
  ok("G1 旧台账带登记区 ⇒ 仍能定位到正文段落", r.ok === true, r.why);
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
