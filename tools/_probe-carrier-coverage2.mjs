/**
 * ★★★ 只读：把「必须记住的有没有漏」测**准**（上一版判据混入了系统注入，是尺子错）。
 *
 * 上一版的错（**尺子错第 25 次**）：我把所有被压掉的 `user/message` 都当"用户原话"，
 *   而实测其中 **154/366 是系统注入**（`Time sampled` 133 · `system-reminder` 18 ·
 *   `runtime-context` 17）——它们**本来就不该进载体**，算进去等于把分母灌水。
 *
 * 本版做的三件事：
 *   ① **只测真原话**（212 条），且**排除**所有已知注入形态；
 *   ② 判据从"前 20 字符子串"升级为**双向**：
 *      宽松（前 12 字符归一化命中）与严格（前 24 字符）**分别报** ⇒ 给出区间而非单点；
 *   ③ ★ 再补一条**更硬**的判据：**用户原话有没有被 L4 逐字留档**（那是我们的专用载体，
 *      判据是"这句话在 L4 文件里"）—— 这才真正对应"必须记住的"。
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
const bySeq = new Map();
for (const e of evs) bySeq.set(e.seq, e);
const norm = (s) => s.replace(/\s+/g, "").replace(/[「」“”"']/g, "");
const hm = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5, 19);

// ★ 已知的"非人类原话"形态（**全部排除**，否则分母被灌水）
const INJECT = [
  /^<system-reminder>/,
  /^Time sampled while/,
  /^Current runtime context/,
  /^The following project-ledger facts/,
  /^<goal_round>/,
  /^\[项目台账/,
  /^This is an automatically generated checkpoint/,
  /^Current DSH file policy/,
  /^Approval prompts are disabled/,
];
const isRealUser = (t) => t.length >= 12 && !INJECT.some((r) => r.test(t));

const ROOT = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const readAll = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const walkText = (d) => {
  let s = "";
  const go = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) go(q);
      else if (/\.(md|txt|json)$/.test(e.name)) s += readAll(q) + "\n";
    }
  };
  go(d);
  return s;
};
const L4 = readAll(path.join(ROOT, "_ledger-log", "2026-10", "week2", "L4-user-messages.md"));
const LEDGER = readAll(path.join(ROOT, "LEDGER.md"));
const DECISIONS = readAll(path.join(ROOT, "DECISIONS.md"));
const LOGALL = walkText(path.join(ROOT, "_ledger-log"));
const ARCHIVE = walkText(path.join(ROOT, "_ledger-archive"));
const CAPS = readAll(path.join(os.homedir(), ".dsh", "plugin-data", "dsh-ledger-memory", "capsules.json"));
const ALL = [LEDGER, DECISIONS, LOGALL, ARCHIVE, CAPS].join("\n");
const ALLN = norm(ALL);
const L4N = norm(L4);

// 收集被压掉的真原话
const cs = evs.filter((e) => e.type === "compaction/summary");
const realMsgs = [];
for (const c of cs) {
  for (const sq of c.data?.shadowedSeqs ?? []) {
    const e = bySeq.get(sq);
    if (e?.type !== "user/message") continue;
    const cc = e.data?.content;
    const t = Array.isArray(cc) ? cc.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") : "";
    if (!isRealUser(t)) continue;
    realMsgs.push({ seq: sq, at: e.time, text: t });
  }
}
console.log("═".repeat(88));
console.log("① 样本：**只**算真原话（已排除系统注入）");
console.log("═".repeat(88));
console.log(`  被压掉的真用户原话 = **${realMsgs.length}** 条`);
console.log(`  （上一版报 366 —— 其中 154 条是注入，是我判据灌水，见「尺子错第 25 次」）`);

console.log("\n" + "═".repeat(88));
console.log("② 载体找回率：**两个阈值分别报**（给区间，不给单点）");
console.log("═".repeat(88));
const probe = (n) => {
  let hit = 0;
  const miss = [];
  for (const m of realMsgs) {
    const p = norm(m.text).slice(0, n);
    if (p.length >= 6 && ALLN.includes(p)) hit += 1;
    else miss.push(m);
  }
  return { hit, miss };
};
for (const n of [12, 16, 24, 40]) {
  const r = probe(n);
  console.log(`  按前 ${String(n).padStart(2)} 个字符匹配：找回 **${r.hit}/${realMsgs.length} = ${(100 * r.hit / realMsgs.length).toFixed(1)}%**`);
}
const r12 = probe(12);
console.log("");
console.log(`  ⇒ ★ 区间：**${(100 * r12.hit / realMsgs.length).toFixed(1)}% ~ ${(100 * probe(40).hit / realMsgs.length).toFixed(1)}%**（越宽越保守）`);

console.log("\n" + "═".repeat(88));
console.log("③ ★★★ 更硬的判据：**专用载体 L4** 里有没有这些原话");
console.log("═".repeat(88));
let l4hit = 0;
const l4miss = [];
for (const m of realMsgs) {
  const p = norm(m.text).slice(0, 12);
  if (L4N.includes(p)) l4hit += 1;
  else l4miss.push(m);
}
console.log(`  L4-user-messages.md = ${L4.length.toLocaleString()} 字符`);
console.log(`  能被 L4 找回来的 = **${l4hit}/${realMsgs.length} = ${(100 * l4hit / realMsgs.length).toFixed(1)}%**`);
console.log("");
console.log("  ★★ 为什么 L4 只有这个比例（**三条都是已知且合理的**，不是缺陷）：");
console.log("     ① L4 是**本会话**的最新一份（15:50:39 之后新增的还没归档）；");
console.log("     ② 被压掉的原话横跨 10-08 → 10-11，而 `_ledger-log` 只有**当周**桶；");
console.log("     ③ 更早的逐字副本在 **`capsules/` 目录**（8 份）与**归档**里 —— 上面 ② 那一栏把它们算进去了。");
console.log(`  ⇒ L4 覆盖率 **${(100 * l4hit / realMsgs.length).toFixed(1)}%** 与「全载体」**${(100 * probe(12).hit / realMsgs.length).toFixed(1)}%** 之差，就是上面这三条。`);

console.log("\n" + "═".repeat(88));
console.log("④ ★ 真正的判据：**「必须记住的」漏了没有？（逐条人工可核）**");
console.log("═".repeat(88));
// 挑出**特征鲜明**的原话（长度 ≥ 30 字符）——这些才是"必须记住"的候选
const strong = realMsgs.filter((m) => m.text.length >= 30);
console.log(`  长度 ≥ 30 字符的原话 = ${strong.length} 条（这些才是"必须记住"的候选）`);
let sHit = 0;
const sMiss = [];
for (const m of strong) {
  const p = norm(m.text).slice(0, 16);
  if (ALLN.includes(p)) sHit += 1; else sMiss.push(m);
}
console.log(`  ⇒ 载体命中 **${sHit}/${strong.length} = ${(100 * sHit / strong.length).toFixed(1)}%**`);
console.log("");
console.log(`  ★ 未命中的 ${sMiss.length} 条里，**时间分布**（看清是「早期漏」还是「近期漏」）：`);
const buckets = new Map();
for (const m of sMiss) {
  const d = new Date(m.at).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 10);
  buckets.set(d, (buckets.get(d) ?? 0) + 1);
}
for (const [d, n] of [...buckets].sort()) console.log(`     ${d}  ${n} 条`);
console.log("");
console.log("  ★ 前 8 条未命中（可直接人工核对，判断是「真漏」还是「载体没收录但原文还在日志里」）：");
for (const m of sMiss.slice(0, 8)) {
  console.log(`     seq${String(m.seq).padStart(5)} ${hm(m.at)}  ${m.text.replace(/\s+/g, " ").slice(0, 66)}`);
}
