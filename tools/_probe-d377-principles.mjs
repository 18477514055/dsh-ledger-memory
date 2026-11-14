// D377 探针：验证「append 剥重复文档头」与「工具描述不再让人默认挑提议」
// ★ 两段：① 纯函数单测（含反向用例） ② 端到端真写盘（含反向验证：还原旧拼接形状 ⇒ 必现重复）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { stripDuplicatePreamble, writePrinciples } = await import(
  new URL("../lib/part2.js", import.meta.url)
);

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log("  PASS  " + name); }
  else { fails.push(name); console.log("  FAIL  " + name + (detail === undefined ? "" : "  << " + detail)); }
}

const H1 = "# 根本原则";
const QUOTE1 = "> 这个项目只有用户能改这份文件。以下条目由用户在 2026-10-15 与 2026-10-21 授权写入；";
const QUOTE2 = "> 2026-11-01 用户授权新增 P4。";
const EXISTING = [H1, "", QUOTE1, QUOTE2, "", "## P0 · 绝不自动拉起登录", "", "P0 正文", "",
  "## P1 · 执行与验收分离", "", "P1 正文", "", "## P2 · 先验尺子", "", "P2 正文", "",
  "## P3 · 否定也算完成", "", "P3 正文", ""].join("\n");
// 用户/模型传进来的「整份文件」—— 与 EXISTING 同样的头 + 新增 P4
const FULL_FILE = [H1, "", QUOTE1, QUOTE2, "", "## P0 · 绝不自动拉起登录", "", "P0 正文", "",
  "## P1 · 执行与验收分离", "", "P1 正文", "", "## P2 · 先验尺子", "", "P2 正文", "",
  "## P3 · 否定也算完成", "", "P3 正文", "", "## P4 · 新加的一条", "", "P4 正文", ""].join("\n");

console.log("=== ① stripDuplicatePreamble 单测 ===");

// 正例：整份文件 append ⇒ 头被剥，P0 只出现一次
{
  const out = stripDuplicatePreamble(FULL_FILE, EXISTING);
  const p0 = (out.match(/^## P0 /gm) ?? []).length;
  const h1 = (out.match(/^# 根本原则$/gm) ?? []).length;
  ok("F-01 a 整份文件 append ⇒ 剥掉重复的 `# 根本原则`", h1 === 0, "h1=" + h1);
  ok("F-01 b 整份文件 append ⇒ 剥掉重复的 P0", p0 === 0, "p0=" + p0);
  ok("F-01 c 新内容 P4 仍在", out.includes("## P4 · 新加的一条"));
  ok("F-01 d 剥完不以空行开头", !/^\s/.test(out), JSON.stringify(out.slice(0, 20)));
}

// 反例 1：正常小节 append（`## P4`）⇒ 一个字都不能动
{
  const body = "## P4 · 任何改动都必须先对比上游\n\n正文。\n";
  ok("F-02 a 正常小节 append 原样返回", stripDuplicatePreamble(body, EXISTING) === body);
}

// 反例 2：body 是别的 H1 ⇒ 不动（不能见 # 就剥）
{
  const body = "# 另一份完全不同的文件\n\n内容。\n";
  ok("F-02 b 不同 H1 原样返回", stripDuplicatePreamble(body, EXISTING) === body);
}

// 反例 3：H1 相同，但引用块里有**新的一句**（existing 没有），正文也不重复 ⇒ **一个字节都不动**
// ★ 设计选择：此时无法证明这是"重复文档头"，硬剥会丢掉用户新写的说明 ⇒ 宁可原样返回。
{
  const body = [H1, "", "> 这是一句全新的授权说明，existing 里没有。", "", "## P9 · 新条目", "", "x", ""].join("\n");
  const out = stripDuplicatePreamble(body, EXISTING);
  ok("F-02 c 相同 H1 + 新引用 + 正文不重复 ⇒ 逐字原样返回（宁可少剥）", out === body);
  ok("F-02 d 新的引用句必须保留", out.includes("这是一句全新的授权说明"));
}

// 反例 3b：H1 + **新引用** + 重复正文块 ⇒ 保留文档头、只剥重复正文
//   ★ 这是"用户改了那句引用说明、然后贴了整份文件"的真实情形，第一版漏掉的就是它。
{
  const body = [H1, "", "> 全新的授权说明（existing 没有）。", "", "## P0 · 绝不自动拉起登录", "",
    "P0 正文", "", "## P1 · 执行与验收分离", "", "P1 正文", "", "## P2 · 先验尺子", "", "P2 正文", "",
    "## P3 · 否定也算完成", "", "P3 正文", "", "## P5 · 新加的一条", "", "P5 正文", ""].join("\n");
  const out = stripDuplicatePreamble(body, EXISTING);
  ok("F-02 g 新引用 + 重复正文 ⇒ 重复正文被剥（P0 不重复）", (out.match(/^## P0 /gm) ?? []).length === 0);
  ok("F-02 h 新引用说明必须保留", out.includes("全新的授权说明"));
  ok("F-02 i 新增的 P5 必须保留", out.includes("## P5 · 新加的一条"));
  ok("F-02 j 文件头只留 body 自己那一份（不重复）", (out.match(/^# 根本原则$/gm) ?? []).length === 1);
}

// 反例 4：existing 为空 ⇒ 原样（新建文件路径不走这里，但别崩）
ok("F-02 e existing 为空时原样返回", stripDuplicatePreamble(FULL_FILE, "") === FULL_FILE);
// 反例 5：body 为空 ⇒ 原样
ok("F-02 f body 为空时原样返回", stripDuplicatePreamble("", EXISTING) === "");

console.log("\n=== ② 端到端真写盘（含反向验证）===");

function mkProject(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d377-" + tag + "-"));
  fs.writeFileSync(
    path.join(dir, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_ledger-archive", principles: "PRINCIPLES.md" }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n初始。\n", "utf8");
  return dir;
}

// 正向：写第一份（整份文件），再 append 同一份 ⇒ 不应重复
{
  const dir = mkProject("a");
  const r1 = writePrinciples(dir, { content: EXISTING, mode: "replace", authorizedBy: "probe-d377" });
  const r2 = writePrinciples(dir, { content: FULL_FILE, mode: "append", authorizedBy: "probe-d377" });
  const text = fs.readFileSync(path.join(dir, "PRINCIPLES.md"), "utf8");
  const p0 = (text.match(/^## P0 /gm) ?? []).length;
  const h1 = (text.match(/^# 根本原则$/gm) ?? []).length;
  ok("E-01 a 两次写入成功", r1.ok === true && r2.ok === true, JSON.stringify([r1.ok, r2.ok]));
  ok("E-01 b P0 只出现一次（不重复）", p0 === 1, "p0=" + p0);
  ok("E-01 c `# 根本原则` 只出现一次", h1 === 1, "h1=" + h1);
  ok("E-01 d P4 被追加进来", text.includes("## P4 · 新加的一条"));
  ok("E-01 e 回执 mode 是 append", r2.mode === "append", String(r2.mode));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 反向验证：还原成「未修形状」（纯拼接）⇒ 必须复现重复
{
  const naive = `${EXISTING.replace(/\s+$/, "")}\n\n${FULL_FILE.replace(/\s+$/, "")}\n`;
  const p0 = (naive.match(/^## P0 /gm) ?? []).length;
  const h1 = (naive.match(/^# 根本原则$/gm) ?? []).length;
  ok("B-01 未修形状（纯拼接）确实复现重复 —— P0 两次", p0 === 2, "p0=" + p0);
  ok("B-01 未修形状确实复现重复 —— 文件头两个", h1 === 2, "h1=" + h1);
  // 再确认修复后同一输入不再复现（与 B-01 对照）
  const fixed = `${EXISTING.replace(/\s+$/, "")}\n\n${stripDuplicatePreamble(FULL_FILE, EXISTING).replace(/\s+$/, "")}\n`;
  ok("B-02 修复后同一输入 P0 只一次", (fixed.match(/^## P0 /gm) ?? []).length === 1);
}

// 反向验证 2：真项目那个坏文件的形状（P0 在 5 行与 97 行）
{
  const broken = [EXISTING.replace(/\s+$/, ""), "", H1, "", QUOTE1, QUOTE2, "",
    "## P0 · 绝不自动拉起登录", "", "P0 正文", "", "## P1 · 执行与验收分离", "", "P1 正文", "",
    "## P2 · 先验尺子", "", "P2 正文", "", "## P3 · 否定也算完成", "", "P3 正文", ""].join("\n");
  ok("B-03 坏文件形状：P0 出现两次（复刻真实事故）", (broken.match(/^## P0 /gm) ?? []).length === 2);
  const p4only = "## P4 · 随便一条\n\n正文。\n";
  ok("B-04 对坏文件再 append 正常小节 ⇒ 不动它（不误治）",
    stripDuplicatePreamble(p4only, broken) === p4only);
}

console.log("\n=== ③ 工具描述（缺陷 A）===");
{
  const src = fs.readFileSync(path.join(ROOT, "lib/part2-tools.js"), "utf8");
  const i = src.indexOf('name: "ledger_propose_principle"');
  const seg = src.slice(i, i + 2600);
  ok("T-01 propose 描述里点到了 ledger_principles_access", seg.includes("ledger_principles_access"));
  ok("T-02 propose 描述要求「先问一句走哪条路」", /ASK ONE SHORT QUESTION/i.test(seg));
  ok("T-03 propose 描述明说「不弹卡、不写盘」", /shows NO card/i.test(seg) && /Nothing is written/i.test(seg));
  ok("T-04 propose 描述禁止说「已添加」", /Never say the principle[^\n]*has been added/i.test(seg));
  const j = src.indexOf("name: PRINCIPLE_GRANT_TOOL");
  const seg2 = src.slice(j, j + 1800);
  ok("T-05 access 描述里也点到了 propose 这条别的路", seg2.includes("ledger_propose_principle"));
  ok("T-06 access 描述要求先问用户走哪条", /ask them which one they want/i.test(seg2));
}

console.log("\n=== 结果 ===");
console.log("PASS " + pass + " · FAIL " + fails.length);
if (fails.length > 0) { for (const f of fails) console.log("  FAILED: " + f); }
console.log("PROBE-COMPLETE");
process.exit(fails.length === 0 ? 0 : 1);
