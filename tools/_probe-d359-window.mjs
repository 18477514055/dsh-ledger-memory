// _probe-d359-window.mjs —— 补一刀：重复会不会发生在 40 次调用**之后**？
// ★ 上一版窗口取压后 40 次。若重复其实发生在第 60~120 次，那 40 次的窗口就看不见它。
//   ⇒ 换三个窗口（10 / 40 / 120）看趋势，趋势不涨才算"确实没有"。
import fs from "node:fs";
import zlib from "node:zlib";

const REAL =
  "C:\\Users\\24239\\.dsh\\sessions\\--D-Deepseek~5DE5~4F5C~533A-20-DSH~63D2~4EF6-04-~5176~4F59~63D2~4EF6-10.~9879~76EE~53F0~8D26--\\session-a5dd1f8f-8f7a-4590-9ede-34f72354dad8\\session.v4.jsonl.zstd";

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

const argObj = (a) => {
  if (a !== null && typeof a === "object") return a;
  if (typeof a !== "string") return {};
  try { const v = JSON.parse(a); return v !== null && typeof v === "object" ? v : {}; } catch { return {}; }
};
const cmdOf = (x) => String(x.o.command ?? x.o.cmd ?? "");
const scriptOf = (cmd) => {
  const m = cmd.match(/[\w\-.一-鿿/\\]+\.(?:mjs|js)/);
  return m ? m[0].replace(/\\/g, "/").toLowerCase().split("/").pop() : undefined;
};
const WRITE_TOOLS = new Set(["write", "edit", "ledger_write", "ledger_archive", "ledger_init", "ledger_conform", "ledger_migrate", "ledger_handoff", "ledger_note", "ledger_prune"]);

const events = readAllEvents(REAL);
const calls = [];
for (const ev of events) {
  if (ev.type !== "tool/call") continue;
  calls.push({ seq: ev.seq, name: ev.data?.name, o: argObj(ev.data?.arguments) });
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
  comps.push({ turn: s.turn, startSeq: s.seq, endSeq: e.seq });
}
comps.sort((a, b) => a.startSeq - b.startSeq);

/** 在给定窗口内数「逐字相同的命令重跑（中间零写）」 */
function countExactRerun(W) {
  let same = 0, total = 0;
  for (const c of comps) {
    const post = calls.filter((x) => x.seq > c.endSeq).slice(0, W);
    total += post.length;
    for (let i = 0; i < post.length; i++) {
      if (post[i].name !== "pwsh" && post[i].name !== "shell") continue;
      const si = scriptOf(cmdOf(post[i]));
      if (si === undefined) continue;
      for (let j = i + 1; j < post.length; j++) {
        const xj = post[j];
        if (WRITE_TOOLS.has(xj.name)) break;
        if (xj.name === "git_run" && ["commit", "push", "add"].includes(String(xj.o.action))) break;
        if (xj.name !== "pwsh" && xj.name !== "shell") continue;
        if (scriptOf(cmdOf(xj)) !== si) continue;
        const a = cmdOf(post[i]).replace(/\s+/g, " ").trim();
        const b = cmdOf(xj).replace(/\s+/g, " ").trim();
        if (a === b) same++;
        break;
      }
    }
  }
  return { same, total };
}

/** 在给定窗口内数「同一目标+同一内容的写操作重做」 */
function countWasteMutation(W) {
  const MUT = new Set(["edit", "write", "ledger_write"]);
  const sha = (s) => String(s).length + "|" + String(s).slice(0, 120);
  let waste = 0, total = 0;
  for (const c of comps) {
    const pre = calls.filter((x) => x.seq < c.startSeq).slice(-200);
    const post = calls.filter((x) => x.seq > c.endSeq).slice(0, W);
    total += post.length;
    const seen = new Set();
    for (const x of pre) {
      if (!MUT.has(x.name)) continue;
      const p = x.o.file_path ?? x.o.path ?? "";
      seen.add(`${x.name}|${p}|${sha(x.name === "ledger_write" ? (x.o.content ?? "") : (x.o.new_string ?? x.o.content ?? ""))}`);
    }
    for (const x of post) {
      if (!MUT.has(x.name)) continue;
      const p = x.o.file_path ?? x.o.path ?? "";
      const k = `${x.name}|${p}|${sha(x.name === "ledger_write" ? (x.o.content ?? "") : (x.o.new_string ?? x.o.content ?? ""))}`;
      if (seen.has(k)) waste++;
    }
  }
  return { waste, total };
}

console.log("== 换窗口看趋势（趋势不涨 ⇒ 确实没有）==");
for (const W of [10, 40, 120, 300]) {
  const a = countExactRerun(W);
  const b = countWasteMutation(W);
  console.log(
    `  窗口 ${String(W).padStart(3)} 次：逐字同命令重跑 ${String(a.same).padStart(3)}/${String(a.total).padStart(5)}` +
    ` · 同内容重写 ${String(b.waste).padStart(3)}/${String(b.total).padStart(5)}`
  );
}
