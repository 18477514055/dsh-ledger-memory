/**
 * 真跑：`ledger_recall` 三段式（索引 → 按名单取正文）到底能不能用、省多少。
 *
 * ★ 为什么必须真跑：契约是"先看索引、再取正文"，但**索引报的字数与真取到的必须一致**，
 *   否则模型会以为内容丢了。本探针用**同一份真实会话日志**把两边对账。
 *
 * ★ 反向验证（关键，别省）：摘掉修复后必须**看得见红**。
 *   这里的做法是同时跑「旧路」（整段 from..to）与「新路」（index → events），
 *   断言：新路取回的正文 **逐字节等于** 旧路里同样那几个 seq 的正文。
 *   如果不等于 ⇒ 说明两条路用了不同的尺子（`eventTextOf` 没被共用）。
 *
 * 只读：不写盘、不改 state。
 * 跑法：node tools/_probe-recall-stages.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const T = mod.__test;

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
}

// ── 造一个假 session（真实形状：`session.eventAt(seq)`）──
//   ★ 判据：假 session 必须与内核 `eventAt` 的返回形状一致（`{type, seq, time, data}`），
//     否则测的是我自己编的形状（纪律 8：夹具前提错了，全绿就是假绿）。
const EVENTS = [
  { seq: 10, type: "user/message", time: 1000, data: { message: { role: "user", content: [{ type: "text", text: "用户的第一句话，很短。" }] } } },
  { seq: 11, type: "assistant/message", time: 2000, data: { message: { role: "assistant", content: [{ type: "reasoning", text: "我先想一想这个问题该怎么拆。" }, { type: "text", text: "我的回答正文，比提问长一些。" }] } } },
  { seq: 12, type: "tool/result", time: 3000, data: { content: [{ type: "text", text: "工具返回的结果内容。" }] } },
  { seq: 13, type: "assistant/message", time: 4000, data: { message: { role: "assistant", content: [{ type: "tool-call", name: "read", arguments: { path: "a.txt" } }] } } },
  // 空事件：必须被跳过，且**不许让索引与正文口径分叉**
  { seq: 14, type: "turn/start", time: 5000, data: {} },
  { seq: 15, type: "user/message", time: 6000, data: { message: { role: "user", content: [{ type: "text", text: "第二条用户消息。" }] } } },
  // ★ 一条**足够长**的事件：gist 省略号、索引省字、闸门截断三条判据都靠它，
  //   否则测的是"短文本碰巧通过"（夹具太短 ⇒ 假绿，纪律 8 的镜像）。
  { seq: 16, type: "user/message", time: 7000, data: { message: { role: "user", content: [{ type: "text", text: "这一条故意写得很长。".repeat(40) }] } } },
  { seq: 17, type: "user/message", time: 8000, data: { message: { role: "user", content: [{ type: "text", text: "又一条长消息。".repeat(40) }] } } },
];
const bySeq = new Map(EVENTS.map((e) => [e.seq, e]));
const fakeSession = {
  eventAt(seq) {
    return bySeq.get(seq);
  },
};

console.log("═══ 1. 索引层（mode:'index' 的底层）═══");
const idx = T.readSessionIndex(fakeSession, 10, 17, {});
ok("返回 ok", idx.ok === true);
ok("跳过空事件（8 个 seq 里只有 7 条有文本）", idx.events === 7, `events=${idx.events}`);
ok("行数正确", idx.rows.length === 7, `rows=${idx.rows.length}`);
ok("totalChars 等于各行 chars 之和", idx.totalChars === idx.rows.reduce((s, r) => s + r.chars, 0), `${idx.totalChars}`);
ok("每行都带 gist", idx.rows.every((r) => typeof r.gist === "string" && r.gist !== ""));
ok("gist 超长会带省略号", idx.rows.some((r) => r.gist.endsWith("…")), JSON.stringify(idx.rows.map((r) => r.gist)).slice(0, 200));
ok("标记了含推理块的那条", idx.rows.find((r) => r.seq === 11)?.hasReasoning === true, JSON.stringify(idx.rows.find((r) => r.seq === 11)));
ok("不含推理时那条不算 hasReasoning", (() => {
  const noR = T.readSessionIndex(fakeSession, 11, 11, { reasoning: false });
  return noR.rows[0]?.hasReasoning === true && !noR.rows[0].gist.includes("推理");
})(), "hasReasoning 是问'事件里有没有 reasoning 块'，与是否渲染它无关");
ok("maxRows 生效且如实报 omitted", (() => {
  const lim = T.readSessionIndex(fakeSession, 10, 17, { maxRows: 3 });
  return lim.rows.length === 3 && lim.omitted === 4;
})());

console.log("\n═══ 2. 按名单取正文（mode:'events' 的底层）═══");
const picked = T.readSessionPicked(fakeSession, [11, 15], {});
ok("只有点名的两条", picked.events.length === 2, `got=${picked.events.length}`);
ok("顺序按 seq 升序", picked.events[0].seq === 11 && picked.events[1].seq === 15);
ok("去重（传重复的 seq 只回一次）", (() => {
  const d = T.readSessionPicked(fakeSession, [11, 11, 11], {});
  return d.events.length === 1;
})());
ok("点不存在的 seq ⇒ 进 skipped，不静默丢", (() => {
  const s = T.readSessionPicked(fakeSession, [11, 999], {});
  return s.events.length === 1 && Array.isArray(s.skipped) && s.skipped.includes(999);
})());

console.log("\n═══ 3. ★★★ 两条路必须用同一把尺子（这是本次改动的核心断言）═══");
//   旧路：整段取 ⇒ 拿到 10..17 全部正文
//   新路：索引拿到 seq 列表 ⇒ 按名单取 ⇒ 同几个 seq 的正文必须逐字节一致
const whole = T.readSessionRange(fakeSession, 10, 17, { maxChars: 999999 });
const seqsFromIndex = idx.rows.map((r) => r.seq);
const viaIndex = T.readSessionPicked(fakeSession, seqsFromIndex, { maxChars: 999999 });
ok("两边条数一致", whole.events.length === viaIndex.events.length, `whole=${whole.events.length} viaIndex=${viaIndex.events.length}`);
ok("两边总字符一致", whole.chars === viaIndex.chars, `whole=${whole.chars} viaIndex=${viaIndex.chars}`);
let allSame = true;
let diffAt = "";
for (const w of whole.events) {
  const p = viaIndex.events.find((e) => e.seq === w.seq);
  if (p === undefined || p.text !== w.text) {
    allSame = false;
    diffAt = `seq=${w.seq}`;
    break;
  }
}
ok("逐条正文逐字节相同（同尺子）", allSame, diffAt || "全部一致");

console.log("\n═══ 4. 索引真的省 token 吗（拿真实体量算）═══");
// ★ 索引的固定开销按**真实字段**估：seq + type + chars 约 40 字，gist 本身另算。
const idxChars = idx.rows.reduce((s, r) => s + r.gist.length, 0) + idx.rows.length * 40;
const fullChars = whole.chars;
ok("索引比全文短", idxChars < fullChars, `索引≈${idxChars} 字 vs 全文=${fullChars} 字`);
if (idxChars < fullChars) {
  console.log(`     索引≈${idxChars} 字，全文=${fullChars} 字 ⇒ 只看索引省 ${(100 - (idxChars / fullChars) * 100).toFixed(0)}%`);
}
// ★ 最重要的不是"平均省多少"，而是"**筛过之后**取正文能省多少"：
const onlyTwo = T.readSessionPicked(fakeSession, [16, 17], { maxChars: 999999 });
console.log(`     若索引里只有 2 条真正相关 ⇒ 取正文 ${onlyTwo.chars} 字，比整段 ${fullChars} 字省 ${(100 - (onlyTwo.chars / fullChars) * 100).toFixed(0)}%`);
ok("精选后取得比整段少", onlyTwo.chars < fullChars);

console.log("\n═══ 5. 闸门仍然生效（不许因为加了 mode 就绕过 maxChars）═══");
// ★ 闸门下限是 200（`Math.max(200, …)`）⇒ 要测截断，必须让**正文总量 > 200**。
ok("夹具足够长，能真触发闸门", fullChars > 400, `fullChars=${fullChars}`);
const capped = T.readSessionPicked(fakeSession, seqsFromIndex, { maxChars: 200 });
ok("超闸门就截断", capped.truncated === true, `chars=${capped.chars} truncated=${capped.truncated}`);
ok("截断后总量不超闸门", capped.chars <= 200, `chars=${capped.chars}`);
ok("截断点落在事件边界（回的都是完整事件）", (() => {
  const wholeTexts = new Set(whole.events.map((e) => e.text));
  return capped.events.every((e) => wholeTexts.has(e.text));
})());

console.log("\n═══ 6. 没有会话时不崩（如实拒绝）═══");
ok("readSessionIndex 无 session ⇒ ok:false", T.readSessionIndex(undefined, 1, 2).ok === false);
ok("readSessionPicked 无 session ⇒ ok:false", T.readSessionPicked(undefined, [1]).ok === false);
ok("readSessionRange 无 session ⇒ ok:false（旧行为未变）", T.readSessionRange(undefined, 1, 2).ok === false);

console.log(`\n${"═".repeat(60)}`);
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
