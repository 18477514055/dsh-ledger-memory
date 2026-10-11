/** ★ 两处可疑，必须查清（否则结论会错）：
 *   ① 压缩摘要正文只有 "1 字符" —— 是字段名取错，还是内核真的产出了空摘要？
 *   ② 被替换进去的那个 checkpoint 节点（user/message）里到底装了什么？
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { s.push(i); i = buf.indexOf(MAGIC, i + 4); }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};
const SESS = path.join(os.homedir(), ".dsh", "sessions", "--D-Deepseek~5DE5~4F5C~533A--",
  "session-fada6e5f-52f2-4a4f-b52a-3c2483db117e", "session.v4.jsonl.zstd");
const evs = [];
for (const line of decodeAll(fs.readFileSync(SESS)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);

console.log("═".repeat(80));
console.log("① compaction/summary 的真实结构（别只看一个字段就说它空）");
console.log("═".repeat(80));
const cs = evs.filter((e) => e.type === "compaction/summary");
console.log(`  compaction/summary 共 ${cs.length} 条`);
const last = cs[cs.length - 1];
console.log(`  最后一条的 data 键 = ${Object.keys(last.data ?? {}).join(" · ")}`);
for (const [k, v] of Object.entries(last.data ?? {})) {
  if (typeof v === "string") console.log(`    ${k.padEnd(20)} string(${v.length})  ${JSON.stringify(v.slice(0, 80))}`);
  else if (Array.isArray(v)) console.log(`    ${k.padEnd(20)} array(${v.length})`);
  else if (v !== null && typeof v === "object") console.log(`    ${k.padEnd(20)} object{${Object.keys(v).join(",")}}`);
  else console.log(`    ${k.padEnd(20)} ${String(v)}`);
}
const sm = last.data?.summary;
console.log(`\n  ★ summary 字段的 typeof = ${typeof sm}`);
if (sm !== null && typeof sm === "object") {
  console.log(`     键 = ${Object.keys(sm).join(" · ")}`);
  for (const [k, v] of Object.entries(sm)) {
    console.log(`       ${k.padEnd(16)} ${typeof v === "string" ? `string(${v.length})` : JSON.stringify(v).slice(0, 60)}`);
  }
  const t = sm.text ?? sm.content ?? sm.markdown ?? "";
  if (typeof t === "string") {
    console.log(`\n  ★ 摘要正文（前 500 字符）：`);
    console.log("  " + "-".repeat(74));
    console.log(t.slice(0, 500).split("\n").map((l) => "  " + l).join("\n"));
    console.log("  " + "-".repeat(74));
    console.log(`  ⇒ 长度 ${t.length} 字符 ≈ ${(t.length / 4 / 1000).toFixed(1)}K tok`);
  }
}
console.log("\n  逐次摘要长度：");
for (const c of cs) {
  const s = c.data?.summary;
  const n = typeof s === "string" ? s.length : (s?.text?.length ?? s?.content?.length ?? -1);
  console.log(`    ${hm(c.time)}  shadowed=${String(c.data?.shadowedSeqs?.length).padStart(5)}  nodes  摘要=${n}`);
}

console.log("\n" + "═".repeat(80));
console.log("② 被替换进上下文的 checkpoint 节点：里面到底装了什么");
console.log("═".repeat(80));
// checkpoint = 那些 surfaceOp=replace 的 user/message
const reps = evs.filter((e) => e.type === "user/message" && e.surfaceOp && e.surfaceOp.op === "replace");
console.log(`  surfaceOp=replace 的 user/message = ${reps.length} 个`);
const r = reps[reps.length - 1];
const c = r.data?.content;
const txt = Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : String(c ?? "");
console.log(`  最后一个（seq=${r.seq}, ${hm(r.time)}）覆盖 seq ${r.surfaceOp.startSeq}-${r.surfaceOp.endSeq}`);
console.log(`  正文 ${txt.length} 字符 ≈ ${(txt.length / 4 / 1000).toFixed(1)}K tok`);
console.log(`\n  ★ 它长这样（前 900 字符）：`);
console.log("  " + "-".repeat(74));
console.log(txt.slice(0, 900).split("\n").map((l) => "  " + l).join("\n"));
console.log("  " + "-".repeat(74));
console.log(`\n  ★ 尾部 300 字符：`);
console.log("  " + "-".repeat(74));
console.log(txt.slice(-300).split("\n").map((l) => "  " + l).join("\n"));
console.log("  " + "-".repeat(74));
