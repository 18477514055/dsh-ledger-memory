// issue #1 —— **旧实现逐字还原** vs 新实现。
// ★ 上一版探针犯了个错（当场发现）：我拿"修好后的 lostLines"去跑"旧实现的拼接顺序"，
//   而 bug 其实埋在 lostLines **内部**对 nextText 的 split 里 ⇒ 那条对照根本不成立。
//   ⇒ 本版把**旧的 splitChangeRegister 与旧的 lostLines 都逐字复制过来**，才叫对照组。
import { lostLines, splitChangeRegister } from "../lib/part1.js";

const REG = "## 变更登记（插件自动维护）";
const LINE_RE = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \((?:write|append|replace|archive)[^)]*\)/;
const realLine = (t) => `- ${t} (append) [a5dd] +1 行 → 100 行 · revision→1`;
const mkReg = (...times) => `\n\n${REG}\n\n> 说明行\n\n${times.map(realLine).join("\n")}\n`;

// ─── 旧实现（逐字还原 1.2.9 的代码）────────────────────────────────────────
function oldSplit(text) {
  if (typeof text !== "string" || text === "") return { body: "", entries: [] };
  const idx = text.indexOf(REG);
  if (idx < 0) return { body: text, entries: [] };
  const body = text.slice(0, idx).replace(/\s+$/, "");
  const tail = text.slice(idx + REG.length);
  const entries = tail.split("\n").map((l) => l.trim()).filter((l) => LINE_RE.test(l));
  return { body, entries };
}
function oldLostLines(currentText, nextText) {
  const normLine = (l) => String(l).replace(/\r$/, "").replace(/\s+$/, "");
  const isHeading = (l) => /^\s*#{1,6}\s/.test(l);
  const tally = (text) => {
    const m = new Map();
    for (const raw of oldSplit(text ?? "").body.split(/\r?\n/)) {
      const l = normLine(raw);
      if (l.trim() === "") continue;
      if (isHeading(l)) continue;
      m.set(l, (m.get(l) ?? 0) + 1);
    }
    return m;
  };
  const before = tally(currentText), after = tally(nextText), out = [];
  for (const [l, n] of before) for (let i = after.get(l) ?? 0; i < n; i++) out.push(l);
  return out;
}

const priorActive = `# Ledger\n\n## A 段\n\nA 正文。\n\n## C 段\n\nC 正文。\n${mkReg("2026-10-20 10:00:00")}`;
const newActive = `# Ledger\n${mkReg("2026-10-20 10:00:00")}`;   // 归档掉 A、C 两段
const entries = `## A 段\n\nA 正文。\n\n## C 段\n\nC 正文。`;

const show = (r) => (r.length === 0 ? "✅ 0（正确）" : `❌ ${r.length} 行 → ${JSON.stringify(r)}`);

console.log("═══ 旧实现 1.2.9（逐字还原）═══");
console.log("  priorBody(旧) =", JSON.stringify(oldSplit(priorActive).body));
console.log("  combined(旧)  = `${newActive}\\n${entries}`");
console.log(`  oldLostLines  → ${show(oldLostLines(oldSplit(priorActive).body, `${newActive}\n${entries}`))}`);
console.log("  ⇒ 这就是 issue 报的『凭空丢失』：A 正文 / C 正文 明明在 entries 里。\n");

console.log("═══ 新实现（现在的 lib）═══");
const priorBody = splitChangeRegister(priorActive).body;
const afterBody = splitChangeRegister(newActive).body + "\n" + splitChangeRegister(entries).body;
console.log("  priorBody(新) =", JSON.stringify(priorBody));
console.log("  afterBody(新) 含 A 正文 =", afterBody.includes("A 正文。"), "含 C 正文 =", afterBody.includes("C 正文。"));
console.log(`  lostLines     → ${show(lostLines(priorBody, afterBody))}\n`);

// ── 真实规模：模拟"归档 36 行整节"那种量级 ──
const big = ["# Ledger", ""];
for (let i = 0; i < 6; i++) {
  big.push(`## 八之${i}`, "");
  for (let j = 0; j < 6; j++) big.push(`- 条目 ${i}-${j}`, "");
}
const bigEntries = big.slice(2).join("\n");
const bigPrior = big.join("\n") + mkReg("2026-10-20 10:00:00");
const bigNew = `# Ledger\n${mkReg("2026-10-20 10:00:00")}`;

console.log("═══ 真实规模（6 节 × 6 条 = 36 条目整节归档）═══");
const oldR = oldLostLines(oldSplit(bigPrior).body, `${bigNew}\n${bigEntries}`);
const newR = lostLines(splitChangeRegister(bigPrior).body, splitChangeRegister(bigNew).body + "\n" + splitChangeRegister(bigEntries).body);
console.log(`  旧实现 → ${show(oldR)}`);
console.log(`  新实现 → ${show(newR)}`);
console.log(`  ${oldR.length > 0 && newR.length === 0 ? "★ 修复有效：旧版误报 36 行，新版 0。" : "⚠️ 对照没拉开，需复查。"}`);
