// _probe-d354-dual.mjs —— 双载体方案验证：frontmatter(可见性低+抗注释清洗) + 链接定义(抗往返)
// ★ 目标（用户 D354）：把 D353 的四类边界尽量扩大
// ★ 设计：**同时放两处**，任一处存活即可认出 —— 但必须验证：
//   ① 两处都写了，解析器能一致读出（不能打架）
//   ② 只有一处存活时仍能认出
//   ③ 两处不一致时，必须**报冲突**而不是瞎选
//   ④ 幂等：反复写不会堆叠
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

// ── 模拟"双载体"的写与读（先做原型，再决定是否进生产）──
const FPF = "dsh-fp-front";   // frontmatter 键
const FPL = "dsh-fp-link";    // 链接引用定义标签

function payload(id, seal) {
  return `v=${id.v ?? 1} kind=${id.kind} project=${id.project} key=${id.key} check=${id.check} seal=${seal}`;
}
function parsePayload(s) {
  const m = /v=(\d+) kind=([a-z][a-z0-9_-]*) project=([0-9a-f]{16}) key=(\S+?) check=([0-9a-f]{8}) seal=([0-9a-f]{8})/.exec(s ?? "");
  if (!m) return null;
  return { v: +m[1], kind: m[2], project: m[3], key: m[4], check: m[5], seal: m[6] };
}

function writeDual(body, id, seal) {
  const p = payload(id, seal);
  const lines = body.split("\n");
  // 去掉已有的两种载体
  const kept = [];
  let inFm = false;
  for (const l of lines) {
    if (/^---\s*$/.test(l)) { inFm = !inFm; continue; }
    if (inFm) continue; // 简化：整段 frontmatter 重写
    if (l.startsWith(`[${FPL}]:`)) continue;
    if (l.includes("<!-- dsh-ledger-fp:")) continue;
    kept.push(l);
  }
  const clean = kept.join("\n").replace(/^\n+/, "");
  return `---\n${FPF}: ${p}\n---\n${clean}\n\n[${FPL}]: dsh-ledger-fp ${p}\n`;
}

function readDual(text) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text ?? "");
  const fromFm = fm ? parsePayload((fm[1].split("\n").find((l) => l.startsWith(FPF + ":")) ?? "").slice(FPF.length + 1)) : null;
  const lm = new RegExp(`^\\[${FPL}\\]: dsh-ledger-fp (.*)$`, "m").exec(text ?? "");
  const fromLink = lm ? parsePayload(lm[1]) : null;
  if (fromFm && fromLink) {
    const same = ["v", "kind", "project", "key", "check", "seal"].every((k) => fromFm[k] === fromLink[k]);
    return same
      ? { ok: true, id: fromFm, src: "both", conflict: false }
      : { ok: false, reason: "两处指纹不一致", fromFm, fromLink };
  }
  if (fromFm) return { ok: true, id: fromFm, src: "frontmatter", conflict: false };
  if (fromLink) return { ok: true, id: fromLink, src: "link", conflict: false };
  return { ok: false, reason: "两处都没有" };
}

const ID = { v: 1, kind: "decisions", project: "0123456789abcdef", key: "D195", check: "deadbeef" };
const BODY = "# D195 决定\n\n理由正文。\n\n- 一\n- 二\n";

// ══════════════════════════════════════════════════════════
console.log("=== 1. 写入与读取一致性 ===");
{
  const t = writeDual(BODY, ID, "cafebabe");
  const r = readDual(t);
  eq("两处都写 ⇒ src=both", r.src, "both");
  eq("kind 正确", r.id.kind, "decisions");
  eq("key 正确", r.id.key, "D195");
  eq("无冲突", r.conflict, false);
  // 正文完好
  ok("正文保留", t.includes("理由正文"), t.slice(0, 200));
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 2. 幂等：反复写不堆叠 ===");
{
  let t = writeDual(BODY, ID, "cafebabe");
  for (let i = 0; i < 3; i += 1) t = writeDual(t, ID, "cafebabe");
  const fmCount = (t.match(new RegExp(`${FPF}:`, "g")) ?? []).length;
  const linkCount = (t.match(new RegExp(`\\[${FPL}\\]:`, "g")) ?? []).length;
  eq("frontmatter 只 1 处", fmCount, 1);
  eq("链接定义只 1 处", linkCount, 1);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 3. ★★★ 各种洗法下，双载体还能不能活 ===");
{
  const t = writeDual(BODY, ID, "cafebabe");
  const washes = {
    "strip HTML 注释": (x) => x.replace(/<!--[\s\S]*?-->/g, ""),
    "往返(保留fm)": (x) => x,
    "往返(丢fm)": (x) => x.replace(/^---\n[\s\S]*?\n---\n/, ""),
    "只留可见文本": (x) => x.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^\[[^\]]+\]:.*$/gm, ""),
    "prettier 重排": (x) => x.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n"),
    "Windows CRLF": (x) => x.replace(/\n/g, "\r\n"),
    "加 BOM": (x) => "\uFEFF" + x,
    "整体缩进": (x) => x.split("\n").map((l) => (l ? "  " + l : l)).join("\n"),
  };
  for (const [name, fn] of Object.entries(washes)) {
    const r = readDual(fn(t));
    const who = r.ok ? `✅ 存活（来自 ${r.src}）` : "❌ 丢失";
    console.log(`  ${name.padEnd(18)} ${who}`);
  }
  // 关键：两种洗法各灭一处，但另一处活 ⇒ 组合起来才叫扩大边界
  const onlyStrip = readDual(t.replace(/<!--[\s\S]*?-->/g, ""));
  ok("★ 只 strip 注释 ⇒ frontmatter 顶上", onlyStrip.ok && onlyStrip.src === "both");
  const onlyLoseFm = readDual(t.replace(/^---\n[\s\S]*?\n---\n/, ""));
  ok("★ 只丢 frontmatter ⇒ 链接定义顶上", onlyLoseFm.ok && onlyLoseFm.src === "link");
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 4. ★★★★ 两处不一致 ⇒ 必须报冲突，不许瞎选 ===");
{
  let t = writeDual(BODY, ID, "cafebabe");
  // 手工把链接那处改成别的 key
  t = t.replace(`[${FPL}]: dsh-ledger-fp v=1 kind=decisions project=0123456789abcdef key=D195`,
                `[${FPL}]: dsh-ledger-fp v=1 kind=decisions project=0123456789abcdef key=D999`);
  const r = readDual(t);
  eq("★ 报冲突", r.ok, false);
  eq("★ 冲突原因明确", r.reason, "两处指纹不一致");
  ok("★ 两处都回显，便于人判断", r.fromFm?.key === "D195" && r.fromLink?.key === "D999",
     JSON.stringify({ fm: r.fromFm?.key, link: r.fromLink?.key }));
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 5. ★ 第四问：清空为 0 字节怎么办（边界③能不能扩）===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ghost-"));
  // 思路：清单里存「期望表 + 每份的 identityCheck」，文件空了也能报"谁丢了"
  //   但**仍不能证明空文件是它** —— 这里只验证"能报出丢失"
  const expect = {
    decisions: { "D195": "deadbeef", "D196": "cafebabe" },
    active: { "-": "12345678" },
  };
  let reported = 0;
  for (const [kind, keys] of Object.entries(expect)) {
    for (const [key, check] of Object.entries(keys)) {
      // 模拟：文件内容为空 ⇒ 读不到任何指纹
      const content = "";
      const got = readDual(content);
      if (!got.ok) reported += 1;
    }
  }
  eq("★ 期望表能逐条报出「这 3 份都没了」", reported, 3);
  console.log("      ⇒ 但这只到「存在性」；**空文件是哪个，仍然不知道**");
  console.log("      ⇒ 边界③ 最多扩到「丢失可枚举」，扩不到「**同一性**可恢复」");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
