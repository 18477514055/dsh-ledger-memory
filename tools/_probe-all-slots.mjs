/**
 * 只读：**完整复刻内核 `mapEventMessages` 的 5 个槽位**，逐事件检查 source.kind。
 * 内核判据（app.asar 原文）：
 *   source(message): source 必须是对象、kind 是非空 string、且 kind !== "plugin"
 * 槽位（内核原文）：
 *   · user/message                → data 本身
 *   · developer|system|assistant/message | tool/result → data.message
 *   · agent/inbox/spliced         → data.inserted[]（每一项是 message）
 *   · session/title-llm-request   → data.messages[]
 * 全库扫，找出所有违规事件。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function loadEvents(F) {
  const buf = fs.readFileSync(F);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++)
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  const chunks = [];
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)));
    } catch {}
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 内核 source(message) 判据 */
function sourceViolation(m) {
  const value = m?.["source"];
  if (!isObj(value)) return `source 不是对象（${JSON.stringify(value)}）`;
  if (typeof value["kind"] !== "string") return `kind 不是 string（${JSON.stringify(value["kind"])}）`;
  if (value["kind"].length === 0) return "kind 是空字符串";
  if (value["kind"] === "plugin") return `kind === "plugin"（plugin=${JSON.stringify(value["plugin"])}）`;
  return null;
}

/** 复刻 mapEventMessages：返回该事件要校验的 message 列表（带槽位名） */
function slotsOf(e) {
  const d = e?.data;
  if (!isObj(d)) return [];
  if (e.type === "user/message") return [["data", d]];
  if (
    e.type === "developer/message" ||
    e.type === "system/message" ||
    e.type === "assistant/message" ||
    e.type === "tool/result"
  )
    return isObj(d["message"]) ? [["data.message", d["message"]]] : [];
  if (e.type === "agent/inbox/spliced")
    return Array.isArray(d["inserted"]) ? d["inserted"].map((m, i) => [`data.inserted[${i}]`, m]) : [];
  if (e.type === "session/title-llm-request")
    return Array.isArray(d["messages"]) ? d["messages"].map((m, i) => [`data.messages[${i}]`, m]) : [];
  return [];
}

function scanOne(label, F, verbose) {
  let evs;
  try {
    evs = loadEvents(F);
  } catch (e) {
    console.log(`  ✗ 读失败 ${F}: ${e.message}`);
    return 0;
  }
  const bad = [];
  for (const e of evs) {
    for (const [slot, m] of slotsOf(e)) {
      if (!isObj(m)) continue;
      const v = sourceViolation(m);
      if (v !== null) bad.push({ seq: e.seq, type: e.type, slot, why: v, preview: JSON.stringify(m).slice(0, 260) });
    }
  }
  if (bad.length > 0 || verbose) {
    console.log(`\n★ ${label}`);
    console.log(`   ${F}`);
    console.log(`   事件 ${evs.length}，★ 违规 ${bad.length} 条`);
    for (const b of bad.slice(0, 12)) {
      console.log(`   ── seq=${b.seq} type=${b.type} slot=${b.slot}`);
      console.log(`      原因: ${b.why}`);
      console.log(`      内容: ${b.preview}`);
    }
  }
  return bad.length;
}

const ROOT = "C:\\Users\\24239\\.dsh\\sessions";
function findLogs() {
  const out = [];
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "session.v4.jsonl.zstd") out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

const logs = findLogs();
console.log(`全库 ${logs.length} 个会话日志，开始扫 5 个槽位…\n`);

// 先详查目标
const TARGET = "session-d0a8dcf4-eb93-4c03-89fc-a2b6b554db4c";
for (const F of logs) if (F.includes(TARGET)) {
  console.log("=".repeat(76));
  console.log("★ 目标会话详查");
  console.log("=".repeat(76));
  scanOne("目标（崩溃）", F, true);
}

// 全库统计
let totalBad = 0,
  filesBad = 0;
const badList = [];
for (const F of logs) {
  let evs;
  try {
    evs = loadEvents(F);
  } catch {
    continue;
  }
  let n = 0;
  for (const e of evs)
    for (const [, m] of slotsOf(e)) {
      if (!isObj(m)) continue;
      if (sourceViolation(m) !== null) n++;
    }
  if (n > 0) {
    filesBad++;
    totalBad += n;
    badList.push({ dir: path.basename(path.dirname(F)), n });
  }
}
console.log(`\n${"=".repeat(76)}\n全库汇总\n${"=".repeat(76)}`);
console.log(`有违规的会话文件: ${filesBad} / ${logs.length}`);
console.log(`违规事件总数: ${totalBad}`);
for (const b of badList) console.log(`   ${b.dir}  →  ${b.n} 条`);
