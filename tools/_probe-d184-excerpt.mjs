/**
 * ★★★★★ 只读取证（D184）：把**压缩后那一次注入的原文**抠出来看。
 *
 * 只读：不写盘、不改 state。
 * 跑法：node tools/_probe-d184-excerpt.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decodeAll = (buf) => {
  const s = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) { s.push(i); i = buf.indexOf(MAGIC, i + 4); }
  s.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < s.length; k += 1) {
    try { const d = zlib.zstdDecompressSync(buf.subarray(s[k], s[k + 1])); if (d.length) out.push(d); } catch {}
  }
  return Buffer.concat(out).toString("utf8");
};

const P = path.join(
  os.homedir(),
  ".dsh",
  "sessions",
  "--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--",
  "session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8",
  "session.v4.jsonl.zstd"
);
const evs = [];
for (const line of decodeAll(fs.readFileSync(P)).split("\n")) {
  if (line === "") continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const textOf = (e) => {
  const c = e.data?.content;
  return Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : String(c ?? "");
};
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);

const inj = evs.filter((e) => e.type === "user/message" && textOf(e).includes("LEDGER-BLOCKS"));
console.log(`含块的注入共 ${inj.length} 条\n`);

for (const target of ["23:54:28", "23:45:27"]) {
  const e = inj.find((x) => hm(x.time ?? 0).endsWith(target));
  if (e === undefined) { console.log(`✗ 没找到 ${target}`); continue; }
  const t = textOf(e);
  console.log(`${"═".repeat(78)}\n注入时间 ${target} —— 原文（头 + 块段 + 目录）\n${"═".repeat(78)}`);
  const a = t.indexOf("<<<LEDGER-BLOCKS");
  const b = t.indexOf("LEDGER-BLOCKS>>>");
  const head = t.slice(Math.max(0, a - 420), a);
  console.log("── 块段之前 420 字符 ──");
  console.log(head.split("\n").map((l) => "  " + l).join("\n"));
  console.log("\n── 块段本体（`<<<LEDGER-BLOCKS` … `>>>` 之间的**全部内容**）──");
  const body = t.slice(a, b + "LEDGER-BLOCKS>>>".length);
  console.log(body === "" ? "  （空）" : body.split("\n").map((l) => "  " + l).join("\n"));
  console.log(`  ★ 该段总长 = ${body.length} 字符`);
  console.log("\n── 其后的目录（前 6 行）──");
  console.log(t.slice(b + "LEDGER-BLOCKS>>>".length).split("\n").slice(0, 6).map((l) => "  " + l).join("\n"));
  console.log("");
}
