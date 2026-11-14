// _probe-d359-waste.mjs —— 把「重复工作」与「必要的重新取得」分开量
//
// ★★ 为什么要分：上一版（_probe-d359-repeat2）报「同工具+同主键 53.5%」——
//   那个数**不能**当"重复劳动"用。压缩后**文件内容已经不在上下文里了**，
//   重读 package.json 不是"重做工作"，是**把丢掉的东西取回来**（而且我们自己的重注
//   就明确叫它"直接重读磁盘"）。把这两类混在一个数里 = 尺子错。
//
// 本探针只量**真正的浪费**：带副作用、且做过的动作被原样再做一遍。
//   浪费 = 压后窗口里出现一次「变更类调用」，其 (目标, 内容指纹) 与**压前**某次完全一致。
//   非浪费 = 只读类调用（read/glob/grep/ledger_status…）—— 无论重复多少次都不算。
//
// 另外单列一档：**同一目标被反复改写**（目标相同、内容不同）—— 那不是重复，是继续写，
//   但它的比例能说明"模型是不是在同一个地方打转"。
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

const ABS =
  "C:\\Users\\24239\\.dsh\\sessions\\--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--\\session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8\\session.v4.jsonl.zstd";
const WINDOW = 40;

// ── 变更类工具（带副作用）────────────────────────────────
// ★ 判据：这个调用**改了磁盘或远端**。只读的（read/glob/grep/ledger_status/ledger_read…）一律不算。
// ★★★ 尺子错 #65（自查纠正）：`ledger_lessons` / `ledger_goals` / `ledger_extension` 是
//   **一个工具两种性质** —— `op:"list"/"tree"/"read"` 是纯读，`op:"add"/"upsert"/"write"` 才写。
//   上一版把整个工具名塞进 MUTATING ⇒ 三条 `ledger_lessons:list` 被当成"重复做了写操作"。
//   ⇒ 必须**按 op 分流**，不能按工具名分流。
const MUTATING = new Set([
  "edit", "write", "ledger_write", "ledger_archive", "ledger_init", "ledger_conform",
  "ledger_migrate", "ledger_handoff", "ledger_note", "ledger_prune",
  "liblib_generate", "modelscope_generate",
]);
/** 一工具两性质：只有这些 op 才算写 */
const OP_MUTATING = {
  ledger_goals: new Set(["upsert", "lesson", "status", "rm"]),
  ledger_lessons: new Set(["add", "rm"]),
  ledger_extension: new Set(["write", "create", "update", "delete"]),
  ledger_index: new Set(["write"]),
};
const GIT_MUTATING = new Set(["commit", "push", "add", "checkout", "clone", "pull", "fetch"]);

function readAllEvents(file) {
  const buf = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString("utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip */ }
    }
  }
  return out;
}

const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 12);
const argObj = (a) => {
  if (a !== null && typeof a === "object") return a;
  if (typeof a !== "string") return {};
  try { const v = JSON.parse(a); return v !== null && typeof v === "object" ? v : {}; } catch { return {}; }
};

/** 变更类调用的 (目标, 内容指纹)；不是变更类 ⇒ undefined */
function mutationOf(name, args) {
  const o = argObj(args);
  const p = o.file_path ?? o.path ?? undefined;
  if (name === "edit") {
    return typeof p === "string" ? { target: `file:${p.replace(/\\/g, "/").toLowerCase()}`, fp: sha(`${o.old_string ?? ""}\u0000${o.new_string ?? ""}`) } : undefined;
  }
  if (name === "write") {
    return typeof p === "string" ? { target: `file:${p.replace(/\\/g, "/").toLowerCase()}`, fp: sha(o.content ?? "") } : undefined;
  }
  if (name === "ledger_write") {
    return { target: `ledger:${o.target ?? "active"}`, fp: sha(o.content ?? "") };
  }
  if (name === "git_run") {
    const act = o.action;
    if (!GIT_MUTATING.has(act)) return undefined;
    return { target: `git:${act}`, fp: sha(`${o.message ?? ""}\u0000${(o.paths ?? []).join(",")}`) };
  }
  if (MUTATING.has(name)) {
    // 其余台账类：只按 target 归（它们的"内容"字段各不相同，硬比会误判）
    return { target: `${name}:${o.target ?? o.op ?? o.id ?? o.title ?? ""}`, fp: sha(JSON.stringify(o)) };
  }
  const ops = OP_MUTATING[name];
  if (ops !== undefined) {
    if (!ops.has(String(o.op ?? ""))) return undefined; // 只读 op ⇒ 不算变更
    return { target: `${name}:${o.op}`, fp: sha(JSON.stringify(o)) };
  }
  return undefined;
}

const events = readAllEvents(ABS);

const calls = [];
for (const ev of events) {
  if (ev.type !== "tool/call") continue;
  const name = ev.data?.name;
  const args = ev.data?.arguments;
  calls.push({ seq: ev.seq, name, m: mutationOf(name, args) });
}
calls.sort((a, b) => a.seq - b.seq);

const startsM = new Map();
const endsM = new Map();
for (const ev of events) {
  if (ev.type === "compaction/start") startsM.set(ev.data?.compactionId, { seq: ev.seq, turn: ev.data?.turn });
  if (ev.type === "compaction/end") endsM.set(ev.data?.compactionId, { seq: ev.seq, error: ev.data?.error });
}
const comps = [];
for (const [id, s] of startsM) {
  const e = endsM.get(id);
  if (!e || e.error !== undefined) continue;
  comps.push({ id, startSeq: s.seq, endSeq: e.seq, turn: s.turn });
}
comps.sort((a, b) => a.startSeq - b.startSeq);

let afterAll = 0, afterMut = 0, waste = 0, sameTargetDiff = 0, readRe = 0;
const wasteDetail = [];
const perComp = [];

for (const c of comps) {
  const before = calls.filter((x) => x.seq < c.startSeq);
  const after = calls.filter((x) => x.seq > c.endSeq).slice(0, WINDOW);
  if (before.length === 0 || after.length === 0) continue;

  const beforeMut = before.filter((x) => x.m !== undefined);
  const beforeExact = new Set(beforeMut.map((x) => `${x.m.target}|${x.m.fp}`));
  const beforeTargets = new Set(beforeMut.map((x) => x.m.target));
  const beforeReads = new Set(before.filter((x) => x.m === undefined).map((x) => `${x.name}|${JSON.stringify(argObj(null))}`));

  const afterMutList = after.filter((x) => x.m !== undefined);
  const w = afterMutList.filter((x) => beforeExact.has(`${x.m.target}|${x.m.fp}`));
  const st = afterMutList.filter((x) => !beforeExact.has(`${x.m.target}|${x.m.fp}`) && beforeTargets.has(x.m.target));

  afterAll += after.length;
  afterMut += afterMutList.length;
  waste += w.length;
  sameTargetDiff += st.length;

  for (const x of w) wasteDetail.push({ turn: c.turn, seq: x.seq, name: x.name, target: x.m.target });

  perComp.push({ turn: c.turn, after: after.length, mut: afterMutList.length, waste: w.length, sameTargetDiff: st.length });
}

const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
console.log(`可比压缩次数 = ${perComp.length}`);
console.log(`压后窗口调用总数 = ${afterAll}`);
console.log(`  其中变更类（带副作用）= ${afterMut}（${pct(afterMut, afterAll)}）`);
console.log("");
console.log("== 真正的浪费（同一目标 + 同一内容，压前已经做过）==");
console.log(`  ${waste} 次  —— 占压后变更类的 ${pct(waste, afterMut)}，占压后全部调用的 ${pct(waste, afterAll)}`);
console.log(`== 同一目标被继续改写（内容不同；多半是正常继续）==`);
console.log(`  ${sameTargetDiff} 次  —— 占压后变更类的 ${pct(sameTargetDiff, afterMut)}`);
console.log("");
console.log("== 逐次（after / mut / waste / sameTargetDiff）==");
for (const r of perComp) {
  console.log(`  turn=${String(r.turn).padStart(4)}  ${String(r.after).padStart(2)} / ${String(r.mut).padStart(2)} / ${String(r.waste).padStart(2)} / ${String(r.sameTargetDiff).padStart(2)}`);
}
console.log("\n== 浪费明细（全部）==");
for (const d of wasteDetail) console.log(`  turn=${d.turn} seq=${d.seq} ${d.name} → ${d.target}`);
