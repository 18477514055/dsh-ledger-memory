/**
 * ★ 只读：定位「未配对的 compaction/start」+ 找真正的压缩失败记录。
 * ★ 修上一版的尺子错：`workbuddy` 是 provider 名，不是失败标记 ⇒ 那个正则 13561 条全是假命中。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const starts = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  starts.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < starts.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const fmt = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });

const SESS = path.join(os.homedir(), ".dsh", "sessions",
  "--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--",
  "session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8", "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}

// ── ① 按 compactionId 精确配对（上一版按时间就近配对，会把失败的那次错配给下一次）
console.log("═══ ① 按 compactionId 精确配对 ═══");
const byId = new Map();
for (const e of evs) {
  if (!e.type?.startsWith("compaction/")) continue;
  const id = e.data?.compactionId;
  if (!id) continue;
  if (!byId.has(id)) byId.set(id, {});
  byId.get(id)[e.type] = e;
}
const ids = [...byId.keys()];
const unpaired = ids.filter((id) => byId.get(id)["compaction/start"] && !byId.get(id)["compaction/end"]);
const noStart = ids.filter((id) => !byId.get(id)["compaction/start"]);
console.log(`  compactionId 总数 = ${ids.length} · 有 start 无 end = ${unpaired.length} · 有 end 无 start = ${noStart.length}`);
for (const id of unpaired) {
  const s = byId.get(id)["compaction/start"];
  const d = s.data ?? {};
  const who = d.sourceCommandId !== undefined ? "手动" : d.turn === null ? "回合末" : `回合内(turn=${d.turn})`;
  console.log(`  ★ 未配对 id=${id}  ${fmt(s.time)}  ${who}`);
  const keys = Object.keys(byId.get(id));
  console.log(`      该 id 下出现的事件类型: ${keys.join(", ")}`);
}
for (const id of noStart) {
  const e = byId.get(id)["compaction/end"] ?? Object.values(byId.get(id))[0];
  console.log(`  ? 有 end 无 start id=${id} ${fmt(e.time)} ${Object.keys(byId.get(id)).join(",")}`);
}

// ── ② 失败痕迹：只看"错误/警告"性质的事件类型，且只报与压缩同时间窗的
console.log("\n═══ ② 压缩前后 120 秒内的异常事件 ═══");
const starts = evs.filter((e) => e.type === "compaction/start");
let found = 0;
for (const s of starts) {
  const win = evs.filter((e) => e.time >= s.time && e.time <= s.time + 120000 &&
    /error|fail|abort|cancel|rollback/i.test(String(e.type)));
  if (win.length) {
    found += 1;
    console.log(`  ${fmt(s.time)} 附近异常 ${win.length} 条：`);
    for (const w of win.slice(0, 3)) {
      const s2 = JSON.stringify(w.data ?? {});
      console.log(`     [${w.type}] ${s2.slice(0, 300)}`);
    }
  }
}
if (!found) console.log("  (压缩窗口内没有任何 error/fail 事件 —— 说明失败不落在会话事件流里)");

// ── ③ compaction/end 的 data 全字段（看它记不记 afterTokens / success）
console.log("\n═══ ③ compaction/end 的 data 字段（一次样本）═══");
const firstEnd = evs.find((e) => e.type === "compaction/end");
console.log("  keys:", Object.keys(firstEnd?.data ?? {}).join(","));
console.log("  " + JSON.stringify(firstEnd?.data ?? {}).slice(0, 600));

console.log("\n═══ ④ compaction/summary 的 data 字段（一次样本）═══");
const fs2 = evs.find((e) => e.type === "compaction/summary");
console.log("  keys:", Object.keys(fs2?.data ?? {}).join(","));
console.log("  " + JSON.stringify(fs2?.data ?? {}).slice(0, 800));

console.log("\n═══ ⑤ compaction/prune 的 data（16 条）═══");
const prunes = evs.filter((e) => e.type === "compaction/prune");
console.log(`  共 ${prunes.length} 条；data keys=${Object.keys(prunes[0]?.data ?? {}).join(",")}`);
for (const p of prunes.slice(-4)) console.log(`  ${fmt(p.time)} ${JSON.stringify(p.data ?? {}).slice(0, 240)}`);
