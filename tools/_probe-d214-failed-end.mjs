/**
 * 只读探针（D214 之四）：把**失败那一次**的 `compaction/end` 原始载荷逐字打出来。
 *
 * ★ 为什么单独一个探针：我要报「L0 把一次**失败**的压缩记成了『已压缩（自动 70%）』」，
 *   而这句话的**唯一依据**是"`error` 挂在 `compaction/end` 上"。
 *   上一版探针是按 compactionId 聚合的 ⇒ 它证明了"这个 id 有 error"，**没**证明
 *   "error 在哪条事件上"。报这类结论必须逐字看到那条事件（证据纪律）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const wantId = (process.argv[2] ?? "5c7d51b1").toLowerCase();
const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");

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
      /* 尾帧可能不完整 */
    }
  }
  return out;
}

function newest(hint) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "session.v4.jsonl.zstd") out.push({ p, m: fs.statSync(p).mtimeMs });
    }
  };
  walk(SESSIONS, 0);
  out.sort((a, b) => b.m - a.m);
  return out.find((s) => s.p.includes(hint)) ?? out[0];
}

const target = newest("a5dd1f8f");
let n = 0;
for (const l of decodeFrames(fs.readFileSync(target.p)).split("\n")) {
  if (l.trim() === "") continue;
  let e;
  try {
    e = JSON.parse(l);
  } catch {
    continue;
  }
  const s = JSON.stringify(e);
  if (!s.toLowerCase().includes(wantId)) continue;
  n++;
  const t = e?.time ?? e?.timestamp;
  const when = typeof t === "number" ? new Date(t).toLocaleString("sv-SE") : String(t);
  console.log(`--- 第 ${n} 条 · ${when} · type=${e?.type ?? e?.name} ---`);
  console.log(`  data 的键：${Object.keys(e?.data ?? {}).join(", ")}`);
  // 只把 data 打出来（够用，且不会把整棵会话树打爆）
  console.log(`  data = ${JSON.stringify(e?.data ?? {}).slice(0, 1200)}`);
  console.log("");
}
console.log(`共 ${n} 条含 "${wantId}" 的事件`);
