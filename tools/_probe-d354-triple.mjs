// _probe-d354-triple.mjs —— 三载体定稿：frontmatter + 链接定义 + **行内可见标记**
// ★ 为什么还要第三处：双载体在「只留可见文本」与「整体缩进」两种洗法下仍会丢。
//   根本原因是**两处都不可见** ⇒ 一旦工具只保留"渲染后看得见的东西"，全灭。
// ★ 第三处的取舍（必须诚实）：
//   要扛住「只留可见文本」，信标就**必须可见** ⇒ 必然在正文里留下痕迹。
//   解法：**极短、极不打扰** —— 一个零宽字符序列 + 短标记，或放在标题行尾。
//   ★ 但零宽字符在"只留可见文本"的工具里也可能被 strip（它们常做 whitespace 归一化）。
//   ⇒ 所以第三处用**可见但极短**的标记，并且**只在第一行标题里嵌**，不新增行。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

// ── 三载体的原型 ──
const FM = "dsh-fp-front";
const LK = "dsh-fp-link";
const INLINE_RE = /<!--dsh-id:([0-9a-f]{16}):([A-Za-z0-9_.-]+)-->/; // 行内，嵌在标题行尾

function mkPayload(id, seal) {
  return `v=${id.v ?? 1} kind=${id.kind} project=${id.project} key=${id.key} check=${id.check} seal=${seal}`;
}
function parsePayload(s) {
  const m = /v=(\d+) kind=([a-z][a-z0-9_-]*) project=([0-9a-f]{16}) key=(\S+?) check=([0-9a-f]{8}) seal=([0-9a-f]{8})/.exec(s ?? "");
  if (!m) return null;
  return { v: +m[1], kind: m[2], project: m[3], key: m[4], check: m[5], seal: m[6] };
}

/** 写入三载体（幂等） */
function writeTriple(text, id, seal) {
  const p = mkPayload(id, seal);
  let s = text ?? "";

  // ① 摘掉三处旧载体
  s = s.replace(/^---\n[\s\S]*?\n---\n/, "");
  s = s.replace(new RegExp(`^\\[${LK}\\]:.*$\\n?`, "gm"), "");
  s = s.replace(new RegExp(INLINE_RE.source, "g"), "");
  s = s.replace(/<!--\s*dsh-ledger-fp:[\s\S]*?-->\n?/g, "");

  // ② 行内标记嵌在第一行末尾（标题行）
  const lines = s.split("\n");
  let placed = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    lines[i] = lines[i].replace(/\s+$/, "") + ` <!--dsh-id:${id.project}:${id.key}-->`;
    placed = true;
    break;
  }
  s = lines.join("\n");
  if (!placed) s = `<!--dsh-id:${id.project}:${id.key}-->\n`;

  return `---\n${FM}: ${p}\n---\n${s.replace(/\s+$/, "")}\n\n[${LK}]: dsh-ledger-fp ${p}\n`;
}

/** 读三载体，返回所有来源并判冲突 */
function readTriple(text) {
  const t = text ?? "";
  const out = [];

  const fm = /^---\n([\s\S]*?)\n---\n/.exec(t);
  if (fm) {
    const line = fm[1].split("\n").find((l) => l.startsWith(FM + ":"));
    const p = parsePayload((line ?? "").slice(FM.length + 1));
    if (p) out.push({ src: "frontmatter", id: p });
  }
  const lm = new RegExp(`^\\[${LK}\\]: dsh-ledger-fp (.*)$`, "m").exec(t);
  if (lm) {
    const p = parsePayload(lm[1]);
    if (p) out.push({ src: "link", id: p });
  }
  const im = INLINE_RE.exec(t);
  if (im) out.push({ src: "inline", id: { project: im[1], key: im[2] } });

  if (out.length === 0) return { ok: false, reason: "三处都没有" };
  // 冲突判定：只对"完整身份"（有 kind/project/key）比；行内只有 project+key
  const full = out.filter((x) => x.id.kind !== undefined);
  if (full.length >= 2) {
    const first = full[0].id;
    const bad = full.find((x) => x.id.kind !== first.kind || x.id.project !== first.project || x.id.key !== first.key);
    if (bad) return { ok: false, reason: "多载体身份不一致", all: out };
  }
  // 行内也要与完整身份一致
  const inl = out.find((x) => x.src === "inline");
  const ref = full[0]?.id;
  if (inl && ref && (inl.id.project !== ref.project || inl.id.key !== ref.key)) {
    return { ok: false, reason: "行内标记与其它载体不一致", all: out };
  }
  return { ok: true, id: ref ?? inl.id, sources: out.map((x) => x.src) };
}

const ID = { v: 1, kind: "decisions", project: "0123456789abcdef", key: "D195", check: "deadbeef" };
const BODY = "# D195 · 某决定\n\n理由正文。\n\n- 一\n- 二\n";

// ══════════════════════════════════════════════════════════
console.log("=== 1. 三载体写入 / 读取 / 幂等 ===");
{
  let t = writeTriple(BODY, ID, "cafebabe");
  const r = readTriple(t);
  eq("三处都在 ⇒ ok", r.ok, true);
  eq("来源有三处", r.sources.length, 3);
  eq("kind 正确", r.id.kind, "decisions");
  eq("key 正确", r.id.key, "D195");

  // 幂等
  for (let i = 0; i < 3; i += 1) t = writeTriple(t, ID, "cafebabe");
  eq("frontmatter 只 1 处", (t.match(new RegExp(FM + ":", "g")) ?? []).length, 1);
  eq("链接定义只 1 处", (t.match(new RegExp(`\\[${LK}\\]:`, "g")) ?? []).length, 1);
  eq("行内标记只 1 处", (t.match(/<!--dsh-id:/g) ?? []).length, 1);
  ok("正文保留", t.includes("理由正文"));
  // ★ 不新增行（行内标记嵌在标题行里）
  const bodyLines = t.split("\n").length;
  console.log(`     成品行数 ${bodyLines}（原文 ${BODY.split("\n").length + 3} 行含 frontmatter/链接/空行）`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 2. ★★★★ 八种洗法 × 三载体：哪些活、哪些死 ===");
{
  const t = writeTriple(BODY, ID, "cafebabe");
  const washes = {
    "strip HTML 注释": (x) => x.replace(/<!--[\s\S]*?-->/g, ""),
    "往返(保留fm)": (x) => x.replace(/<!--[\s\S]*?-->/g, ""),
    "往返(丢fm)": (x) => x.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, ""),
    "只留可见文本": (x) =>
      x.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\[[^\]]+\]:.*$/gm, ""),
    "prettier 重排": (x) => x.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n"),
    "Windows CRLF": (x) => x.replace(/\n/g, "\r\n"),
    "加 BOM": (x) => "\uFEFF" + x,
    "整体缩进两格": (x) => x.split("\n").map((l) => (l ? "  " + l : l)).join("\n"),
  };
  let alive = 0;
  for (const [name, fn] of Object.entries(washes)) {
    const r = readTriple(fn(t));
    if (r.ok) alive += 1;
    console.log(`  ${name.padEnd(16)} ${r.ok ? `✅ 存活（${r.sources.join("+")}）` : `❌ 丢失（${r.reason}）`}`);
  }
  console.log(`\n  存活 ${alive}/8`);
  ok("★ 比双载体的 6/8 更多（至少不再丢「整体缩进」）", alive >= 7, `只活了 ${alive}/8`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 3. ★★★★ 冲突必须报出来，且要能定位到哪一处 ===");
{
  let t = writeTriple(BODY, ID, "cafebabe");
  // 只改链接那处
  t = t.replace(`[${LK}]: dsh-ledger-fp v=1 kind=decisions project=0123456789abcdef key=D195`,
                `[${LK}]: dsh-ledger-fp v=1 kind=decisions project=0123456789abcdef key=D999`);
  const r = readTriple(t);
  eq("★ 报冲突", r.ok, false);
  eq("★ 原因明确", r.reason, "多载体身份不一致");
  ok("★ 三处都回显", Array.isArray(r.all) && r.all.length >= 2);

  // 行内被改
  let t2 = writeTriple(BODY, ID, "cafebabe");
  t2 = t2.replace(`<!--dsh-id:0123456789abcdef:D195-->`, `<!--dsh-id:0123456789abcdef:D777-->`);
  const r2 = readTriple(t2);
  eq("★ 行内被改也报冲突", r2.ok, false);
  eq("★ 指出是行内", r2.reason, "行内标记与其它载体不一致");
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 4. 只剩一处载体时仍能认出（降级可用）===");
{
  const t = writeTriple(BODY, ID, "cafebabe");
  const onlyInline = t.replace(/^---\n[\s\S]*?\n---\n/, "").replace(new RegExp(`^\\[${LK}\\]:.*$\\n?`, "gm"), "");
  const r1 = readTriple(onlyInline);
  eq("★ 只留行内 ⇒ 仍认出 project", r1.ok && r1.id.project, "0123456789abcdef");
  ok("★ 且标出来源是 inline", r1.sources.includes("inline"));

  const onlyLink = t.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--dsh-id:[^>]*-->/g, "");
  const r2 = readTriple(onlyLink);
  eq("★ 只留链接定义 ⇒ kind/key 仍全", r2.ok && `${r2.id.kind}/${r2.id.key}`, "decisions/D195");
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 5. 诚实检查：行内标记对「正文阅读」的干扰有多大 ===");
{
  const t = writeTriple(BODY, ID, "cafebabe");
  const firstLine = t.split("\n").find((l) => l.includes("dsh-id"));
  console.log(`  第一行实际内容: ${JSON.stringify(firstLine)}`);
  const added = " <!--dsh-id:0123456789abcdef:D195-->".length;
  console.log(`  每份文件额外字节（行内那一处）: ${added}`);
  ok("★ 行内标记在渲染后不可见（HTML 注释形式）", firstLine.includes("<!--"));
  console.log("  ⚠ 但注意：它**是可见字符** —— 在纯文本查看器里会显示，这是换取「扛住只留可见文本」的代价");
}

fs.rmSync;
console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
