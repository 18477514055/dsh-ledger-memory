/**
 * ★★★ 真机验证（D114）：新文案是否**真的**推给模型了。
 *
 * ★ 判据（两条，都要）：
 *   ① **注入侧**：最近的台账注入里出现新文案的**独有串**
 *      （\"按需压，不按百分比\" / \"压缩也是你的职责\"），且**旧文案的独有串消失**
 *      （\"压缩由插件在后台自己完成\"）。
 *   ② **工具侧**：活内核发出的工具表里，`ledger_compact` 的描述含新串
 *      （\"Compress BY NEED\"）且**不含**旧串（\"do NOT compact routinely\"）。
 *      ★ 这一条最硬：工具描述是**内核按当前加载的插件**生成的（`request/header`）。
 *
 * ★ 为什么要分开查：注入与工具描述是**两个通道**，我们两处都改了
 *   ⇒ 只验一个通道，等于只验了一半。
 * ★ 时间窗：只看**重启之后**的事件（重启前那些注入必然是旧文案，
 *   把它们算进来会把结论污染成"没生效"）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

function decodeFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let idx = buf.indexOf(MAGIC, 0);
  while (idx !== -1) {
    starts.push(idx);
    idx = buf.indexOf(MAGIC, idx + 1);
  }
  let out = "";
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      const d = zlib.zstdDecompressSync(buf.subarray(starts[k], end));
      if (d.length) out += d.toString("utf8");
    } catch {
      /* 尾帧不完整 */
    }
  }
  return out;
}

const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
let best;
const walk = (d, depth) => {
  if (depth > 3) return;
  let es;
  try {
    es = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === "session.v4.jsonl.zstd") {
      const m = fs.statSync(p).mtimeMs;
      if (best === undefined || m > best.m) best = { p, m };
    }
  }
};
walk(SESSIONS, 0);
const events = [];
for (const l of decodeFrames(fs.readFileSync(best.p)).split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {
    /* 跳过 */
  }
}
const nameOf = (e) => String(e?.name ?? e?.event ?? e?.type ?? "(无)");
const timeOf = (e) => {
  for (const k of ["time", "timestamp", "at", "ts"]) {
    const v = e?.[k];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return undefined;
};
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(5, 19);

// 重启时刻：用"最后一条事件"往前找最近的 turn/start 当参照不如直接问进程；
// 这里改成：找出**最后一次**带新文案的注入，并报告它的时间（那就是证据）。
const NEW_INJECT = "按需压，不按百分比";
const OLD_INJECT = "压缩由插件在后台自己完成";
let lastNew;
let lastOld;
for (const e of events) {
  if (nameOf(e) !== "user/message") continue;
  if (e?.data?.source?.kind === undefined) continue;
  let t = "";
  const c = e?.data?.content;
  if (Array.isArray(c)) for (const x of c) if (x?.type === "text") t += x.text ?? "";
  const when = timeOf(e);
  if (t.includes(NEW_INJECT)) lastNew = when;
  if (t.includes(OLD_INJECT)) lastOld = when;
}
console.log("=== ① 注入侧 ===");
console.log(`  新文案「${NEW_INJECT}」最后出现 : ${lastNew === undefined ? "★ 从未出现" : stamp(lastNew)}`);
console.log(`  旧文案「${OLD_INJECT}」最后出现 : ${lastOld === undefined ? "从未出现" : stamp(lastOld)}`);
if (lastNew !== undefined && lastOld !== undefined) {
  console.log(
    `  ⇒ ${lastNew > lastOld ? "★ 新文案更新 ⇒ 注入侧已切换 ✅" : "★★★ 旧文案更新 ⇒ 注入侧尚未切换（或又退回去了）"}`
  );
} else if (lastNew !== undefined) {
  console.log("  ⇒ ★ 只有新文案出现（旧文案本次会话没出现过）✅");
}

// ② 工具侧：读活内核发出的工具表
console.log("\n=== ② 工具侧（活内核工具表）===");
let toolHits = 0;
let lastHeader;
for (const e of events) {
  if (nameOf(e) !== "request/header") continue;
  const txt = JSON.stringify(e?.data ?? {});
  if (txt.includes("ledger_compact")) {
    lastHeader = e;
    toolHits++;
  }
}
if (lastHeader === undefined) {
  console.log("  ★ 本次会话日志里没找到带 ledger_compact 的 request/header");
} else {
  const txt = JSON.stringify(lastHeader.data ?? {});
  const hasNew = txt.includes("Compress BY NEED");
  const hasOld = txt.includes("do NOT compact routinely");
  console.log(`  最后一份 header 时间 : ${stamp(timeOf(lastHeader))}`);
  console.log(`  含新串「Compress BY NEED」      : ${hasNew ? "★ 是 ✅" : "★ 否"}`);
  console.log(`  含旧串「do NOT compact routinely」: ${hasOld ? "★★★ 是（还没切换）" : "否 ✅"}`);
  console.log(
    `  ⇒ ${hasNew && !hasOld ? "★ 工具侧已切换 ✅" : "★★ 工具侧未完全切换"}`
  );
}
console.log("\n★ 说明：只看**现状**（最后一次），不数历史 —— 重启前必然是旧文案。");
