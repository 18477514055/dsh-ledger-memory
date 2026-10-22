/**
 * 只读探针：**重建"真正发给上游的那一份载荷"，并与上游自报的 usage 对账**。
 *
 * ★★★ 为什么必须重建（用户 2026-10-21 的原话）：
 *   「我怀疑是注入的文本大小是正常的，但是传递给上游网关的信息是不正常的。
 *     或者换句话说，可能当前只有五六十水位的上下文，但是传递给上游的信息就是好几千（K？），
 *     因为普遍发生在长对话，特别是那些一两千兆总输入输出量的。」
 *   ⇒ 这就是要回答的唯一问题：**发出去的东西，和插件看到的 token，是不是同一件事。**
 *
 * ★★★ 上一版这个探针**漏了 `reasoning` 块**（只数了 text / arguments / thinkingSignature）
 *   ⇒ 少报一大截，差点把"上游是对的"误判成"上游在乱报"。**这是尺子错，不是被测对象的错。**
 *   ⇒ 本版**先按块类型 dump 形状，再聚合**（纪律 16：形状对了再写聚合）。
 *
 * 载荷的构成（顺序即 DSH 组装顺序）：
 *   ① system prompt（AGENTS.md / 环境说明 / 技能目录 …）—— **日志里没有原文**，只能量到注入的部分
 *   ② tools 数组 —— 在 `request/header.data.header.tools` 里**有全文**（这是唯一能精确量到的）
 *   ③ 表面消息：`user/message` + `assistant/message` + `tool/result`（压缩后的那一部分）
 *
 * 跑法：
 *   node tools/_probe-payload-truth.mjs
 *   node tools/_probe-payload-truth.mjs --session <目录名> --at "2026-10-21T20:46:03+08:00"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const argOf = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

const SESS = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
const BUCKET = argOf("--bucket") ?? "--D-Deepseek~5DE5~4F5C~533A--";
const AT = argOf("--at") ?? "2026-10-21T20:46:03+08:00";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decode(file) {
  const raw = fs.readFileSync(file);
  const starts = [0];
  for (let i = 1; ; ) {
    const p = raw.indexOf(MAGIC, i);
    if (p < 0) break;
    if (p !== 0) starts.push(p);
    i = p + 4;
  }
  const evs = [];
  let bad = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : raw.length;
    let out;
    try {
      out = zlib.zstdDecompressSync(raw.subarray(starts[k], end));
    } catch {
      bad += 1;
      continue;
    }
    for (const l of out.toString("utf8").split("\n")) {
      if (l.trim() === "") continue;
      try {
        evs.push(JSON.parse(l));
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return { evs, bad, frames: starts.length };
}

// ── 找会话文件 ────────────────────────────────────────────────────────
const dir = path.join(SESS, BUCKET);
if (!fs.existsSync(dir)) {
  console.log(`SKIP：找不到会话桶 ${BUCKET}`);
  process.exit(0);
}
const subs = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
const want = argOf("--session");
let target;
if (want !== undefined) {
  target = path.join(dir, want, "session.v4.jsonl.zstd");
} else {
  const cands = subs
    .map((s) => {
      const p = path.join(dir, s, "session.v4.jsonl.zstd");
      try {
        return { p, m: fs.statSync(p).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m);
  target = cands[0]?.p;
}
if (target === undefined || !fs.existsSync(target)) {
  console.log("SKIP：找不到会话文件");
  process.exit(0);
}

const { evs, bad, frames } = decode(target);
console.log(`会话：${path.basename(path.dirname(target))}`);
console.log(`帧 ${frames}（坏 ${bad}）· 事件 ${evs.length}\n`);

const TARGET_T = new Date(AT).getTime();
console.log(`对账时刻：${new Date(TARGET_T).toLocaleString("zh-CN")}\n`);

// ── 1. 找那一刻之前最后一次成功 usage 与最后一次压缩 ──────────────────
let lastUsage;
let lastCompSeq = -1;
let lastCompTime;
for (const e of evs) {
  if (e.time > TARGET_T) break;
  if (e.type === "assistant/message" && e?.data?.usage !== undefined) lastUsage = e;
  if (e.type === "compaction/end") {
    lastCompSeq = e.seq;
    lastCompTime = e.time;
  }
}
console.log(`最后一次压缩：seq=${lastCompSeq}  ${lastCompTime === undefined ? "?" : new Date(lastCompTime).toLocaleString("zh-CN")}`);
if (lastUsage !== undefined) {
  const u = lastUsage.data.usage;
  console.log(
    `最后一次成功 usage：seq=${lastUsage.seq}  ${new Date(lastUsage.time).toLocaleString("zh-CN")}  ` +
      `input=${u.inputTokens} cacheRead=${u.cacheReadTokens} output=${u.outputTokens} total=${u.totalTokens}`
  );
}
console.log("");

// ── 2. 按**块类型**统计（先 dump 形状）────────────────────────────────
//
// ★ 这是上一版漏掉的那一步：`assistant/message` 的 content 里
//   **有 `reasoning` 块**，它同样会被发回上游（DeepSeek 的 reasoning_content）。
const acc = {
  "user/message": { text: 0, n: 0 },
  "assistant/message": { text: 0, reasoning: 0, arguments: 0, signature: 0, n: 0 },
  "tool/result": { text: 0, n: 0 },
};
const kinds = new Map();
for (const e of evs) {
  if (e.time > TARGET_T) break;
  if (e.seq <= lastCompSeq) continue;
  const d = e.data ?? {};
  if (e.type === "user/message") {
    const c = d.content;
    let n = 0;
    if (Array.isArray(c)) {
      for (const x of c) if (typeof x?.text === "string") n += x.text.length;
    } else if (typeof c === "string") n = c.length;
    acc["user/message"].text += n;
    acc["user/message"].n += 1;
    const k = d?.source?.kind ?? "?";
    kinds.set(k, (kinds.get(k) ?? 0) + n);
  } else if (e.type === "assistant/message") {
    const c = d?.message?.content;
    if (Array.isArray(c)) {
      for (const x of c) {
        if (x?.type === "reasoning") {
          if (typeof x.text === "string") acc["assistant/message"].reasoning += x.text.length;
          if (typeof x.thinkingSignature === "string") acc["assistant/message"].signature += x.thinkingSignature.length;
        } else if (x?.type === "text") {
          if (typeof x.text === "string") acc["assistant/message"].text += x.text.length;
        } else if (x?.type === "tool-call") {
          if (typeof x.arguments === "string") acc["assistant/message"].arguments += x.arguments.length;
          else if (x.arguments !== undefined) acc["assistant/message"].arguments += JSON.stringify(x.arguments).length;
        }
        // ★ 其余未知块类型**必须报出来**，不能静默丢 —— 那就是尺子漏口。
        if (!["reasoning", "text", "tool-call"].includes(x?.type)) {
          const key = `assistant 未知块 type=${String(x?.type)}`;
          kinds.set(key, (kinds.get(key) ?? 0) + JSON.stringify(x ?? null).length);
        }
      }
    }
    acc["assistant/message"].n += 1;
  } else if (e.type === "tool/result") {
    const m = d.message;
    let n = 0;
    if (typeof m === "string") n = m.length;
    else if (Array.isArray(m?.content)) {
      for (const x of m.content) if (typeof x?.text === "string") n += x.text.length;
    } else if (m !== undefined) n = JSON.stringify(m).length;
    acc["tool/result"].text += n;
    acc["tool/result"].n += 1;
  }
}

console.log("═══ 2. 压缩后表面正文（按块类型）═══");
let surface = 0;
for (const [k, v] of Object.entries(acc)) {
  const sum =
    (v.text ?? 0) + (v.reasoning ?? 0) + (v.arguments ?? 0) + (v.signature ?? 0);
  surface += sum;
  const parts = [];
  if (v.text) parts.push(`text=${v.text.toLocaleString("en-US")}`);
  if (v.reasoning) parts.push(`reasoning=${v.reasoning.toLocaleString("en-US")}`);
  if (v.arguments) parts.push(`arguments=${v.arguments.toLocaleString("en-US")}`);
  if (v.signature) parts.push(`sig=${v.signature.toLocaleString("en-US")}`);
  console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(5)} 条  ${String(sum).padStart(10)} 字符  ${parts.join(" · ")}`);
}
console.log(`  ${"合计".padEnd(20)} ${" ".repeat(5)}     ${String(surface).padStart(10)} 字符 ≈ ${Math.round(surface / 3.2).toLocaleString("en-US")} tok @3.2c/tok`);
console.log("");

console.log("═══ 2b. user/message 按 kind（注入 vs 原话）═══");
for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(10)}  ${k}`);
}
console.log("");

// ── 3. tools 数组（这是唯一能精确量的"每次必带"开销）─────────────────
const reqs = evs.filter((e) => e.type === "request/header" && e.time <= TARGET_T);
const lastReq = reqs.at(-1);
let toolsChars = 0;
let toolsN = 0;
if (lastReq !== undefined) {
  const t = lastReq?.data?.header?.tools;
  if (Array.isArray(t)) {
    toolsChars = JSON.stringify(t).length;
    toolsN = t.length;
  }
  console.log(`═══ 3. tools（最后一次 request/header）═══`);
  console.log(`  ${toolsN} 个 · ${toolsChars.toLocaleString("en-US")} 字符 ≈ ${Math.round(toolsChars / 3.2).toLocaleString("en-US")} tok`);
  console.log(`  config = ${JSON.stringify(lastReq?.data?.header?.config)}`);
  console.log(`  startsSeries = ${JSON.stringify(lastReq?.data?.startsSeries)} · reason = ${JSON.stringify(lastReq?.data?.reason)}`);
} else {
  console.log("═══ 3. tools：本会话没有 request/header 事件 ═══");
}
console.log("");

// ── 4. 对账：重建总量 vs 上游自报 ────────────────────────────────────
console.log("═══ 4. 对账（★ 这是本探针的唯一目的）═══");
const rebuilt = surface + toolsChars;
const reported = lastUsage?.data?.usage?.totalTokens;
console.log(`  重建（表面正文 + tools）  ${rebuilt.toLocaleString("en-US")} 字符 ≈ ${Math.round(rebuilt / 3.2).toLocaleString("en-US")} tok`);
console.log(`  上游自报 totalTokens      ${reported === undefined ? "?" : reported.toLocaleString("en-US")}`);
if (reported !== undefined && reported > 0) {
  const diff = reported - Math.round(rebuilt / 3.2);
  console.log(`  差                        ${diff.toLocaleString("en-US")} tok  （${((diff / reported) * 100).toFixed(1)}% 未被重建覆盖）`);
  console.log("");
  console.log("  ★ 差额的**已知**去向（不是「消失了」，是我们日志里没有原文）：");
  console.log("    · system prompt 正文（AGENTS.md ×2 + 环境说明 + 记忆库注入…）—— 日志不存它");
  console.log("    · token 计量本身不是 3.2 字符/token（中文 ≈1.5、英文 ≈4、base64/JSON ≈2）");
  console.log("    ⇒ 所以**只有 tools 那一项是硬数**，其余是估算。别把估算当证据。");
}
console.log("");

// ── 5. 那一刻会话表面有多少条消息（上游看的是条数 + 体积）───────────
let nMsg = 0;
for (const e of evs) {
  if (e.time > TARGET_T) break;
  if (e.seq <= lastCompSeq) continue;
  if (e.type === "user/message" || e.type === "assistant/message") nMsg += 1;
  if (e.type === "tool/result") nMsg += 1;
}
console.log(`═══ 5. 表面消息条数（压缩后）＝ ${nMsg} 条 ═══`);
console.log(`   ★ 若上游是"按条数 × 保守系数"估算，条数越多越容易被判超限。`);
console.log("");
console.log("完成。");
