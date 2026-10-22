/**
 * 只读复算：我们注入消息的 `form:"instructions"`，在 UI 侧**实际会渲染成什么**？
 *
 * ★ 判据来源（一手，从 app.asar 解出来的真代码）：
 *   `@deepseek-ai/dsh-client-ui-chat/lib/client.js`
 *     · `contextForm(source)`      —— 只认 6 个 form：instructions/catalog/snapshot/notice/relay/recall
 *     · `contextBody(form, props)` —— **form 声明了但字段不可读 ⇒ 降级 opaque**
 *     · `instructionChanges(source)` —— `instructions` 要求 `source.changes` 是
 *       形如 `[{action:'set'|'replace'|'remove', scope, path, digest?}]` 的**非空数组**
 *     · `snapshotSections(source)` —— `snapshot` 要求 `source.sections` 是非空数组
 *     · `noticeSummary(source)`    —— `notice` 要求 `source.summary` 是非空字符串
 *     · `recalledSessions(source)`  —— `recall` 要求 `source.references`
 *
 * ⚠ 这是**照抄源码判据的复算**，不是调用真 UI（客户端代码是打包进浏览器的）。
 *   ⇒ 结论只说明"按这份判据会渲染成什么"，不替代真机看一眼前端。
 *
 * 跑法：node tools/_probe-inject-form-render.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// ─────────────────────────────────────────────────────────────
// 照抄 UI 侧的四个判据（源码见文件头）
// ─────────────────────────────────────────────────────────────
const asRecord = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : null);

function instructionChanges(source) {
  const record = asRecord(source);
  const list = record === null ? undefined : record["changes"];
  if (!Array.isArray(list)) return null;
  const changes = [];
  const seen = new Set();
  for (const entry of list) {
    const change = asRecord(entry);
    if (change === null) return null;
    const p = change["path"];
    if (typeof p !== "string" || p === "") return null;
    const action = change["action"];
    if (action !== "set" && action !== "replace" && action !== "remove") return null;
    if (seen.has(p)) continue;
    seen.add(p);
    changes.push({ action, path: p });
  }
  return changes.length === 0 ? null : changes;
}
function snapshotSections(source) {
  const record = asRecord(source);
  const list = record === null ? undefined : record["sections"];
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    const s = asRecord(item);
    if (s === null) return null;
    if (typeof s["name"] !== "string" || s["name"] === "" || typeof s["text"] !== "string") return null;
    out.push({ name: s["name"], text: s["text"] });
  }
  return out.length === 0 ? null : out;
}
function noticeSummary(source) {
  const record = asRecord(source);
  if (record === null) return null;
  const s = record["summary"];
  return typeof s === "string" && s !== "" ? s : null;
}
function recalledSessions(source) {
  const record = asRecord(source);
  if (record === null) return null;
  const list = record["references"];
  return Array.isArray(list) && list.length > 0 ? list : null;
}
const KNOWN_FORMS = ["instructions", "catalog", "snapshot", "notice", "relay", "recall"];

/** UI 侧 `contextBody` 的判定：返回真正渲染出来的 form，null = opaque。 */
function renderedForm(source) {
  const record = asRecord(source);
  const form = record === null ? null : (typeof record["form"] === "string" ? record["form"] : null);
  if (form === null || !KNOWN_FORMS.includes(form)) return { declared: form, rendered: null, why: "form 缺失或不在 6 个已知值里 ⇒ opaque" };
  switch (form) {
    case "instructions":
      return instructionChanges(source) === null
        ? { declared: form, rendered: null, why: "缺 source.changes（或形状不合）⇒ **降级 opaque**" }
        : { declared: form, rendered: "instructions", why: "changes 可读 ⇒ 渲染成「改动的文件清单」" };
    case "snapshot":
      return snapshotSections(source) === null
        ? { declared: form, rendered: null, why: "缺 source.sections ⇒ 降级 opaque" }
        : { declared: form, rendered: "snapshot", why: "sections 可读 ⇒ 分段快照" };
    case "notice":
      return noticeSummary(source) === null
        ? { declared: form, rendered: null, why: "缺 source.summary ⇒ 降级 opaque" }
        : { declared: form, rendered: "notice", why: "summary 可读 ⇒ 一行摘要" };
    case "recall":
      return recalledSessions(source) === null
        ? { declared: form, rendered: null, why: "缺 source.references ⇒ 降级 opaque" }
        : { declared: form, rendered: "recall", why: "references 可读 ⇒ 跨会话召回" };
    case "catalog":
      return { declared: form, rendered: null, why: "catalog 要求 source.entries（本探针未复算该判据）" };
    case "relay":
      return { declared: form, rendered: null, why: "relay 要求 source.senderSessionId（本探针未复算）" };
    default:
      return { declared: form, rendered: null, why: "未知 form ⇒ opaque" };
  }
}

// ─────────────────────────────────────────────────────────────
// 取本机真实会话里**我们**的 source，逐一复算
// ─────────────────────────────────────────────────────────────
const SESS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
function findNewest(root) {
  const cands = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.jsonl\.zstd$/.test(e.name)) cands.push({ p, m: fs.statSync(p).mtimeMs });
      }
    } catch {}
  })(root, 0);
  cands.sort((a, b) => b.m - a.m);
  return cands[0]?.p;
}
const FILE = process.env.DSH_SESSION_FILE ?? findNewest(SESS_ROOT);

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const texts = [];
if (FILE !== undefined) {
  const raw = fs.readFileSync(FILE);
  const cand = [0];
  for (let i = 1; ; ) {
    const p = raw.indexOf(MAGIC, i);
    if (p < 0) break;
    cand.push(p);
    i = p + 4;
  }
  for (let k = 0; k < cand.length; k += 1) {
    let out;
    try {
      out = zlib.zstdDecompressSync(raw.subarray(cand[k], k + 1 < cand.length ? cand[k + 1] : raw.length));
    } catch {
      continue;
    }
    const s = out.toString("utf8");
    const first = s.split("\n").find((l) => l.trim() !== "");
    if (first === undefined) continue;
    try {
      JSON.parse(first);
    } catch {
      continue;
    }
    texts.push(s);
  }
}

const byKind = new Map();
for (const l of texts.join("").split("\n")) {
  if (l.trim() === "") continue;
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  if ((o?.type ?? o?.event?.type) !== "user/message") continue;
  const d = o?.data ?? o?.event?.data;
  const src = d?.source;
  if (typeof src?.kind !== "string") continue;
  if (!byKind.has(src.kind)) byKind.set(src.kind, src);
}

console.log("═══ 各 kind 的 source 在实际 UI 侧会渲染成什么 ═══\n");
let opaqueCount = 0;
for (const [kind, src] of [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const r = renderedForm(src);
  if (r.rendered === null) opaqueCount += 1;
  console.log(`【${kind}】声明 form=${JSON.stringify(r.declared)}`);
  console.log(`   ⇒ 渲染：${r.rendered === null ? "**opaque（无结构）**" : `**${r.rendered}**`}   ${r.why}`);
  console.log(`   source 键：${Object.keys(src).join(", ")}`);
  console.log("");
}
console.log(`合计 ${byKind.size} 种 kind，其中 ${opaqueCount} 种**声明了 form 却降级 opaque**。`);

// ─────────────────────────────────────────────────────────────
// 三种候选改法的效果对照
// ─────────────────────────────────────────────────────────────
console.log("\n═══ 若改成别的形状，UI 会怎样（同一份台账正文）═══\n");
const candidates = [
  ["现状", { kind: "project-ledger-notes", form: "instructions" }],
  ["去掉 form", { kind: "project-ledger-notes" }],
  ["配 changes（列台账文件）", { kind: "project-ledger-notes", form: "instructions", changes: [{ action: "set", scope: "ledger", path: "LEDGER.md" }] }],
  ["配 notice + summary", { kind: "project-ledger-notes", form: "notice", summary: "项目台账（区块级注入）" }],
  ["配 snapshot + sections", { kind: "project-ledger-notes", form: "snapshot", sections: [{ name: "ledger", text: "…台账正文…" }] }],
  ["学 hindsight 用 recall", { kind: "project-ledger-notes", form: "recall" }],
];
for (const [label, src] of candidates) {
  const r = renderedForm(src);
  console.log(`  ${label.padEnd(24)} ⇒ ${(r.rendered ?? "opaque").padEnd(12)} ${r.why}`);
}
