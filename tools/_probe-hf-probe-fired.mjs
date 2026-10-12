/**
 * 只读探针 ⑩：确认「全量那条门的自造注入探针」到底有没有在本机跑过。
 *
 * ★ 那行探针的文案是唯一的（见 lib/index.js:11421-11425）：
 *     本插件注意到水位已到 NN%（≥ 全量线 NN%）—— 本步原本没有别的注入…
 *   全文件、全台账里**只有它**会这么说话 ⇒ 拿它当指纹是干净的。
 *
 * ★ 判据（纪律 2）：在**会话事件流**里找，不是在台账里找（台账里有我对它的引述）。
 *   分两个来源找，且分开数（纪律 15）：
 *     ① `user/message` 的注入（真正发给模型的那条）
 *     ② 其他任何地方（= 引述，不算）
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
      /* 尾帧可能不完整 */
    }
  }
  return out;
}

const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
function newestSession() {
  let best;
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
      else if (e.name === "session.v4.jsonl.zstd") {
        const m = fs.statSync(p).mtimeMs;
        if (best === undefined || m > best.m) best = { p, m };
      }
    }
  };
  walk(SESSIONS, 0);
  return best;
}
const events = [];
for (const l of decodeFrames(fs.readFileSync(newestSession().p)).split("\n")) {
  if (l.trim() === "") continue;
  try {
    events.push(JSON.parse(l));
  } catch {
    /* 跳过 */
  }
}
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
const nameOf = (e) => String(e?.name ?? e?.event ?? e?.type ?? "(无)");
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(5, 19);

const FINGER = "本插件注意到水位已到";
const DECL = "即将执行一次高保真压缩";

let inInject = 0;
let elsewhere = 0;
console.log(`=== 找指纹「${FINGER}」===`);
for (const e of events) {
  const s = JSON.stringify(e);
  if (!s.includes(FINGER)) continue;
  const n = nameOf(e);
  const isMsg = n === "user/message";
  let text = "";
  if (isMsg) {
    const content = e?.data?.content;
    if (Array.isArray(content)) for (const c of content) if (c?.type === "text") text += c.text ?? "";
  }
  // 只有"注入消息，且正文里真的出现这句话"才算真发射
  const real = isMsg && e?.data?.source?.kind !== undefined && text.includes(FINGER);
  if (real) {
    inInject++;
    console.log(`  ★ 真发射：${stamp(timeOf(e))} [${e?.data?.source?.kind}]`);
  } else {
    elsewhere++;
    if (elsewhere <= 6) {
      console.log(`  （引述/${n}）：${stamp(timeOf(e))} ${s.slice(s.indexOf(FINGER), s.indexOf(FINGER) + 60)}`);
    }
  }
}
console.log(`\n  真发射 ${inInject} 条 · 引述/其他 ${elsewhere} 条`);
console.log(
  inInject === 0
    ? "  ⇒ ★ 该探针**从未在本机真正发射过**（全流程一次都没有）"
    : "  ⇒ 该探针确实发射过（看上面的时间）"
);

// 另一头：数「即将执行一次高保真压缩」在**注入**里出现几次（= 排队宣言真正送达模型几次）
let declReal = 0;
console.log(`\n=== 排队宣言「${DECL}」在注入里的出现 ===`);
for (const e of events) {
  if (nameOf(e) !== "user/message") continue;
  if (e?.data?.source?.kind === undefined) continue;
  let text = "";
  const content = e?.data?.content;
  if (Array.isArray(content)) for (const c of content) if (c?.type === "text") text += c.text ?? "";
  if (!text.includes(DECL)) continue;
  // 排除"我引用它"的那些：真正的宣言必然同时含「压缩会自动发生」
  const genuine = text.includes("压缩会自动发生");
  declReal += genuine ? 1 : 0;
  console.log(`  ${stamp(timeOf(e))} [${e?.data?.source?.kind}]  ${genuine ? "★真宣言" : "引述"}`);
}
console.log(`\n  ★ 真宣言 ${declReal} 条`);
