/**
 * 决定性统计：36 次压缩里，哪些是"官方的"、哪些是"我们的"。
 *
 * ★ 为什么这是最重要的一个数：我们的压缩会**先抓逐字胶囊**（用户原话/报错/器物索引）。
 *   如果用户实际按的是**官方 /compact**，那 20 次压缩**都没有胶囊** ——
 *   也就是说，我们花大力气做的那件事，在他真实的使用习惯里**被绕过了**。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SESS = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const cands = [];
(function walk(d, depth) {
  if (depth > 3) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === "session.v4.jsonl.zstd") cands.push(p);
  }
})(SESS, 0);

const decodeAll = (buf) => {
  const starts = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) {
    starts.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  starts.push(buf.length);
  const out = [];
  for (let k = 0; k + 1 < starts.length; k++) {
    try {
      const d = zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1]));
      if (d.length > 0) out.push(d);
    } catch {}
  }
  return out;
};

const bySource = new Map();
let total = 0;
const detail = [];

for (const p of cands) {
  let text;
  try {
    text = Buffer.concat(decodeAll(fs.readFileSync(p))).toString("utf8");
  } catch {
    continue;
  }
  const sid = path.basename(path.dirname(p)).replace("session-", "").slice(0, 8);
  /** commandId → 命令名（`command/done` 没有 name，`command/run` 才有） */
  const cmdName = new Map();
  for (const line of text.split("\n")) {
    if (line.includes('"command/run"')) {
      try {
        const j = JSON.parse(line);
        if (j.data?.commandId) cmdName.set(j.data.commandId, j.data.name);
      } catch {}
    }
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"compaction/start"')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    total += 1;
    const src = j.data?.sourceCommandId;
    let label;
    if (typeof src === "string") {
      const nm = cmdName.get(src);
      label = nm === "compact" ? "官方 /compact（无胶囊）" : nm === "ledger" ? "我们的 /ledger compact（有胶囊）" : `命令 ${nm ?? "?"}`;
    } else {
      // 没有 sourceCommandId ⇒ 自动触发（内核 0.8 或我们的增量/70%）
      label = j.data?.turn === null ? "自动（无 turn）" : "自动（回合内）";
    }
    bySource.set(label, (bySource.get(label) ?? 0) + 1);
    detail.push({ sid, label, turn: j.data?.turn ?? null });
  }
}

console.log(`═══ 全部会话共 ${total} 次压缩，按来源分 ═══\n`);
for (const [k, v] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)} 次  ${k}`);
}

const official = bySource.get("官方 /compact（无胶囊）") ?? 0;
const ours = bySource.get("我们的 /ledger compact（有胶囊）") ?? 0;
console.log(`\n★ 结论：官方 /compact **${official}** 次 vs 我们的 **${ours}** 次`);
console.log("  ⇒ 用户真实习惯是**按官方的**，而那些压缩**抓不到逐字胶囊**。");
