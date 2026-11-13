/** Board application boundary. No module-load writes; HTTP and tests share this implementation.
 * File-backed CAS binds the selected project, role, entry, manifest and complete source file.
 * Never round-trip arbitrary Markdown through the lossy structured renderers.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspect, parseGoalCards, parseLessonEntries, renderGoalCard, renderLessonEntry, buildGoalTree, recordGoalsChange } from "./part2.js";
import { cardModeOf, kindToRel, isSafeCardKey, cardFileAbs, cardDirIsSafe, writeKindCard, cardHeadingOf } from "./card-ops.js";
import { memoryBaseOf, refuseIfMemoryRootUnsafe, isUnderReal, writeFileAtomic } from "./base.js";
import { readFingerprint3, applyFingerprint3, projectOf, decodeKey } from "./fingerprint.js";
import { manifestRevision, bumpRevision, sessionTag } from "./part1.js";
import { writeLedger, appendAudit } from "./part4.js";
import { backupBeforeWrite } from "./backup.js";
import { GOAL_STATUSES, GOAL_STATUS_LABEL, LESSON_TYPES, LESSON_KINDS, EXPERIENCE_KINDS } from "./defs.js";

export const BOARD_KINDS = ["active", "decisions", "journal", "lessons", "goals", "principles"];
const LABELS = { active: "台账", decisions: "决策", journal: "流水", lessons: "经验教训", goals: "目标树", principles: "根本原则" };
const MAX_FILE_BYTES = 8 * 1024 * 1024;
function boardError(reason, status = 400) { const e = new Error(reason); e.status = status; throw e; }
function readDisk(abs, missing = false) {
  try {
    const s = fs.lstatSync(abs);
    if (s.isSymbolicLink() || !s.isFile()) boardError("拒绝读取链接或非普通文件。", 403);
    if (s.size > MAX_FILE_BYTES) boardError("文件超过看板 8 MiB 读取上限，请使用文件编辑器。", 413);
    return fs.readFileSync(abs, "utf8");
  } catch (e) { if (e.code === "ENOENT" && missing) return ""; throw e; }
}
function identity(abs) {
  let p = path.resolve(abs);
  try { p = fs.realpathSync(p); } catch { /* lexical identity for missing files */ }
  return process.platform === "win32" ? p.toLowerCase() : p;
}
function boardReadRequest(root) {
  const info = inspect(root);
  return { root, info, base: memoryBaseOf(info, root), manifestText: readDisk(info.manifestPath, true),
    projectId: projectOf(root), identities: new Map(), documents: new Map(), cardLists: new Map(), contexts: new Map() };
}
function requestIdentity(request, abs) {
  const key = path.resolve(abs);
  if (!request.identities.has(key)) request.identities.set(key, identity(key));
  return request.identities.get(key);
}
function boundedCards(c) {
  if (c.request.cardLists.has(c.kind)) return c.request.cardLists.get(c.kind);
  if (!cardDirIsSafe(c.base, c.mode.dirRel).ok) boardError("卡片目录不安全。", 403);
  const dir = path.resolve(c.base, c.mode.dirRel);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length > 2000) boardError("卡片目录超过看板单次 2000 项扫描上限，请先缩小目录。", 413);
  let bytes = 0;
  for (const e of entries) {
    if (e.isSymbolicLink() || !e.isFile() || !/\.md$/i.test(e.name)) continue;
    const size = fs.statSync(path.join(dir, e.name)).size;
    if (size > MAX_FILE_BYTES) boardError(`卡片 ${e.name} 超过看板 8 MiB 上限。`, 413);
    bytes += size;
    if (bytes > 32 * 1024 * 1024) boardError("卡片目录超过看板单次 32 MiB 扫描上限。", 413);
  }
  // Directory inventory must not read each body merely to count its characters.
  const cards = entries.filter((e) => !e.isSymbolicLink() && e.isFile() && e.name.endsWith(".md") && isSafeCardKey(e.name.slice(0, -3)))
    .map((e) => ({ key: e.name.slice(0, -3) })).sort((a, b) => {
      const na = Number(/(\d+)$/.exec(a.key)?.[1] ?? NaN); const nb = Number(/(\d+)$/.exec(b.key)?.[1] ?? NaN);
      return Number.isFinite(na) && Number.isFinite(nb) && na !== nb ? na - nb : a.key.localeCompare(b.key);
    });
  c.request.cardLists.set(c.kind, cards);
  return cards;
}
function context(root, kind, request) {
  if (!BOARD_KINDS.includes(kind)) boardError("未知记忆类别。", 400);
  const req = request ?? boardReadRequest(root);
  if (req.contexts.has(kind)) return req.contexts.get(kind);
  const info = req.info;
  const unsafe = refuseIfMemoryRootUnsafe(info, [kind, `${kind}Dir`]);
  if (unsafe) boardError(unsafe.reason, 409);
  const c = { root, info, base: req.base, mode: cardModeOf(info, kind), kind, manifestText: req.manifestText, request: req };
  req.contexts.set(kind, c);
  return c;
}
/** Recognize ATX sections outside correctly matched code fences. Offsets preserve untouched bytes. */
export function boardSections(text) {
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0] !== "");
  const heads = []; let fence;
  for (const m of lines) {
    const line = m[0].replace(/\r?\n$/, "");
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      if (!fence) fence = { char: f[1][0], length: f[1].length };
      else if (f[1][0] === fence.char && f[1].length >= fence.length && f[2].trim() === "") fence = undefined;
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!fence && h) heads.push({ start: m.index, level: h[1].length, title: h[2].trim(), line: line });
  }
  return heads.map((h, i) => ({ ...h, key: `section:${i + 1}`, end: heads.slice(i + 1).find((n) => n.level <= h.level)?.start ?? text.length }));
}
function fileSections(text, kind) {
  const sections = boardSections(text);
  if (kind === "active" || kind === "journal" || kind === "principles") return sections;
  return sections.filter((s) => s.level === 2).map((s) => {
    const m = kind === "decisions" ? /^D(\d+)(?![\dA-Za-z])/.exec(s.title)
      : kind === "lessons" ? /^(?:经验|教训)\s+([LE]\d+)(?![\dA-Za-z])/i.exec(s.title)
        : /^目标\s+([A-Za-z0-9._-]+)/.exec(s.title);
    return { ...s, key: m ? (kind === "decisions" ? `D${m[1]}` : m[1]) : s.key };
  });
}
function roleGuard(c, abs, writing = false) {
  if (!isUnderReal(c.base, abs).ok) boardError("目标超出记忆目录。", 403);
  const target = requestIdentity(c.request, abs);
  for (const role of BOARD_KINDS) {
    if (role === c.kind) continue;
    const otherMode = cardModeOf(c.info, role);
    if (otherMode.card) {
      const otherDir = requestIdentity(c.request, path.resolve(c.base, otherMode.dirRel));
      const relative = path.relative(otherDir, target);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) boardError(`目标落入另一记忆类别 ${role} 的卡片目录，拒绝交叉角色编辑。`, 409);
    }
    const rel = kindToRel(c.info, role);
    if (typeof rel === "string" && requestIdentity(c.request, path.resolve(c.base, rel)) === target) {
      boardError(`目标文件同时登记为 ${c.kind} / ${role}，拒绝角色混用。`, 409);
    }
  }
  // An unregistered but existing conventional principles file is protected, too.
  const conventional = path.join(c.base, "PRINCIPLES.md");
  if (c.kind !== "principles" && fs.existsSync(conventional) && requestIdentity(c.request, conventional) === target) boardError("原则文件不能作为普通记忆编辑。", 403);
  if (writing && c.kind === "principles") boardError("根本原则在看板中只读，请使用授权卡流程。", 403);
}
function source(root, kind, entry = "", cachedContext) {
  const c = cachedContext ?? context(root, kind); let abs; let rel;
  if (c.mode.card) {
    if (!entry) return { ...c, aggregate: true, text: "", raw: "", entry: "" };
    if (!cardDirIsSafe(c.base, c.mode.dirRel).ok) boardError("卡片目录不安全。", 403);
    abs = cardFileAbs(c.base, c.mode.dirRel, entry);
    if (!abs) boardError("非法卡片编号。", 400);
    rel = path.relative(c.base, abs);
    if (!fs.existsSync(abs)) boardError("卡片不存在或已被改名，请恢复登记文件名后编辑。", 404);

  } else {
    rel = kindToRel(c.info, kind);
    if (!rel) boardError("这一类记忆尚未登记。", 404);
    abs = path.resolve(c.base, rel);
  }
  const documentKey = kind + "\0" + path.resolve(abs);
  let document = c.request.documents.get(documentKey);
  if (!document) {
    roleGuard(c, abs);
    const raw = readDisk(abs, kind === "journal" && !entry);
    const fp = readFingerprint3(raw);
    if (fp.ok && (fp.id.kind !== kind || (c.request.projectId && fp.id.project !== c.request.projectId))) boardError("文件指纹与项目/记忆类别不一致。", 409);
    if (!fp.ok && /损坏|不一致|自证位/.test(String(fp.reason))) boardError("文件指纹损坏，拒绝将其当作正常正文。", 409);
    if (fp.ok && c.mode.card && fp.id.key !== entry && decodeKey(String(fp.id.key ?? "")) !== entry) boardError("卡片指纹编号与文件名请求不一致。", 409);
    const text = fp.ok ? applyFingerprint3(raw, undefined, { strip: true }).text : raw;
    document = { raw, text, sections: null };
    c.request.documents.set(documentKey, document);
  }
  const { raw, text } = document;
  let selectedText = text; let section;
  if (!c.mode.card && entry) {
    document.sections ??= fileSections(text, kind);
    const found = document.sections.filter((p) => p.key === entry);
    if (found.length !== 1) boardError(found.length ? "条目编号重复，无法唯一定位。" : "条目不存在。", found.length ? 409 : 404);
    section = found[0]; selectedText = text.slice(section.start, section.end);
  }

  const manifest = c.manifestText;
  const etag = createHash("sha256").update(JSON.stringify([requestIdentity(c.request, root), kind, entry, requestIdentity(c.request, abs), manifest, raw])).digest("hex");
  return { ...c, abs, rel, raw, text, selectedText, section, entry, etag };
}
function narrativeParts(s) {
  const sections = boardSections(s.selectedText);
  const head = s.kind === "decisions" ? sections.find((p) => p.level === 2 && new RegExp(`^${s.entry}(?![0-9A-Za-z])`).test(p.title)) : sections[0];
  if (!head) return null;
  const newline = s.selectedText.indexOf("\n", head.start);
  const bodyStart = newline < 0 ? s.selectedText.length : newline + 1;
  return { head, bodyStart, prefix: s.selectedText.slice(0, head.start), title: s.kind === "decisions" ? head.title.replace(/^D\d+\s*(?:[·|]\s*)?/, "") : head.title, body: s.selectedText.slice(bodyStart) };
}
function editorOf(s) {
  if ((s.kind === "active" && s.section) || (s.kind === "decisions" && s.entry)) {
    const p = narrativeParts(s);
    if (p) return { type: s.kind === "decisions" ? "decisions" : "section", fields: { title: p.title, body: p.body }, level: p.head.level };
  }
  if (s.kind === "goals") {
    const cards = parseGoalCards(s.selectedText);
    if (cards.length === 1 && (s.mode.card ? cards[0].id === s.entry : true)) {
      const c = cards[0];
      return { type: "goals", fields: { title: c.title, parent: c.parent ?? "-", status: c.status, kr: c.kr, lessons: c.lessons }, statuses: GOAL_STATUSES };
    }
  }
  if (s.kind === "lessons") {
    const entries = parseLessonEntries(s.selectedText);
    if (entries.length === 1 && (s.mode.card ? entries[0].id === s.entry : true)) {
      const e = entries[0];
      return { type: "lessons", fields: { type: e.type, kind: e.kind, title: e.title, symptom: e.symptom, cause: e.cause, source: e.source, fix: e.fix, scope: e.scope, files: e.files }, types: LESSON_TYPES, lessonKinds: LESSON_KINDS, experienceKinds: EXPERIENCE_KINDS };
    }
  }
  return { type: "markdown", fields: {} };
}
export function boardRead(root, kind = "active", entry = "", cachedContext) {
  try {
    const s = source(root, kind, entry, cachedContext);
    if (s.aggregate) return { ok: true, kind, entry: null, text: "", etag: null, writable: false, editor: { type: "markdown", fields: {} }, reason: "请先选择一张卡片。" };
    const writable = kind !== "principles" && !(kind === "journal" && entry) && !(["goals", "lessons"].includes(kind) && !entry);
    return { ok: true, kind, entry: entry || null, text: s.selectedText, etag: s.etag, writable, editor: editorOf(s), reason: writable ? null : kind === "principles" ? "根本原则只读，修改须走授权流程。" : kind === "journal" ? "历史流水不可改写；请选择全文追加新记录。" : "请先选择一条记录。", rel: s.rel, mode: s.mode.card ? "card" : "file" };
  } catch (e) { return { ok: false, kind, entry: entry || null, text: "", writable: false, etag: null, editor: { type: "markdown", fields: {} }, reason: e.message, status: e.status ?? 500 }; }
}
export function boardInventory(root) { return inventoryInRequest(root, boardReadRequest(root)); }
function inventoryInRequest(root, request) {
  const info = request.info;
  const rows = BOARD_KINDS.map((kind) => {
    try {
      const c = context(root, kind, request); const m = c.mode; let items;
      if (m.card) {
        // Unlike listCards' permissive fallback, inaccessible/oversized directories are visible errors.
        items = boundedCards(c).map(({ key }) => {
          const r = boardRead(root, kind, key, c);
          return { key, title: r.ok ? (r.editor.fields.title || cardHeadingOf(r.text) || key) : key, chars: r.text.length, ok: r.ok, reason: r.reason };
        });
      } else {
        const s = source(root, kind, "", c);
        items = fileSections(s.text, kind).map((p) => ({ key: p.key, title: p.title, chars: p.end - p.start }));
      }
      return { kind, label: LABELS[kind], card: m.card, rel: m.card ? m.dirRel : kindToRel(info, kind), count: items.length, items };
    } catch (e) { return { kind, label: LABELS[kind], card: cardModeOf(info, kind).card, count: 0, items: [], reason: e.message, unavailable: true }; }
  });
  return { root, memoryRoot: info.memoryRoot ?? "", layout: info.memoryRoot ? "v3" : "flat", revision: manifestRevision(info.manifest), activeLines: info.activeLines, rows };
}
export function boardSearch(root, q, offset = 0, limit = 30) {
  if (typeof q !== "string" || !q.trim()) return { ok: true, items: [], total: 0, offset: 0, limit: 30 };
  if (q.length > 300) boardError("搜索词过长。", 400);
  const needle = q.trim().toLocaleLowerCase(); const results = []; const errors = [];
  const request = boardReadRequest(root);
  for (const row of inventoryInRequest(root, request).rows) {
    if (row.unavailable) { errors.push({ kind: row.kind, reason: row.reason }); continue; }
    const candidates = row.items.length ? [...row.items] : [{ key: "", title: row.label }];
    // Text preceding the first heading is searchable too; sections do not own that preamble.
    if (!row.card && row.items.length) {
      const whole = boardRead(root, row.kind, "", context(root, row.kind, request));
      const first = boardSections(whole.text)[0]?.start ?? whole.text.length;
      if (whole.ok && whole.text.slice(0, first).toLocaleLowerCase().includes(needle)) candidates.unshift({ key: "", title: `${row.label}（前言/全文）` });
    }
    const searchContext = context(root, row.kind, request);
    for (const item of candidates) {
      const r = boardRead(root, row.kind, item.key, searchContext);
      if (!r.ok) { errors.push({ kind: row.kind, key: item.key, reason: r.reason }); continue; }
      const at = r.text.toLocaleLowerCase().indexOf(needle);
      if (at < 0 && !String(item.title).toLocaleLowerCase().includes(needle) && !item.key.toLocaleLowerCase().includes(needle)) continue;
      results.push({ kind: row.kind, key: item.key, title: item.title, snippet: r.text.slice(Math.max(0, at - 70), Math.max(0, at - 70) + 220) });
    }
  }
  const off = Number.isSafeInteger(Number(offset)) ? Math.max(0, Number(offset)) : 0;
  const size = Number.isSafeInteger(Number(limit)) ? Math.min(100, Math.max(1, Number(limit))) : 30;
  return { ok: true, items: results.slice(off, off + size), total: results.length, offset: off, limit: size, errors };
}
/** Replace only explicitly editable protocol lines; preserve prose, comments and unknown fields. */
export function patchBoardFields(text, fields, kind) {
  const parsed = kind === "goals" ? parseGoalCards(text) : parseLessonEntries(text);
  if (parsed.length !== 1) boardError("结构化编辑需要恰好一条可识别记录，请切换原文模式。");
  const original = parsed[0]; const oldId = original.id;
  const allowed = kind === "goals" ? ["title", "parent", "status", "kr", "lessons"] : ["type", "kind", "title", "symptom", "cause", "source", "fix", "scope", "files"];
  for (const key of Object.keys(fields)) if (!allowed.includes(key)) boardError(`不支持结构字段：${key}`);
  const next = { ...original, ...fields };
  for (const key of allowed) {
    if (["kr", "lessons", "files"].includes(key)) {
      if (!Array.isArray(next[key]) || next[key].some((v) => typeof v !== "string" || /[\r\n]/.test(v))) boardError(`${key} 必须是单行字符串数组。`);
    } else if (next[key] !== undefined && next[key] !== null) {
      if (typeof next[key] !== "string") boardError(`${key} 必须是文本。`);
      if (kind === "lessons" && ["symptom", "cause", "source", "fix", "scope"].includes(key)) next[key] = next[key].replace(/\s*\r?\n\s*/g, " ").trim();
      else if (/[\r\n]/.test(next[key])) boardError(`${key} 必须是单行文本。`);
    }
  }
  if (!String(next.title ?? "").trim()) boardError("标题不能为空。");
  if (kind === "goals") {
    if (!GOAL_STATUSES.includes(next.status)) boardError("目标状态无效。");
    next.parent = next.parent === "-" || next.parent === "" ? null : next.parent;
  } else {
    if (!LESSON_TYPES.includes(next.type)) boardError("请选择经验或教训。");
    if (!(next.type === "经验" ? EXPERIENCE_KINDS : LESSON_KINDS).includes(next.kind)) boardError("分类与经验/教训类型不匹配。");
    if (!String(next.type === "经验" ? next.source : next.cause).trim()) boardError(next.type === "经验" ? "经验必须填写出处。" : "教训必须填写根因。");
    // L/E is an identity; changing its type would create a contradictory file key.
    if (next.type !== original.type) boardError("不能原地将教训改成经验（或反之），编号身份不同。");
  }
  const rendered = kind === "goals" ? renderGoalCard(next) : renderLessonEntry(next);
  const mapping = kind === "goals" ? { title: "title", parent: "parent", status: "status", kr: "关键结果", lessons: "教训" }
    : { title: "标题", symptom: "现象", cause: "根因", source: "出处", fix: "正解", scope: "适用范围", files: "相关文件" };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/); const canonical = rendered.trimEnd().split("\n");
  const updates = new Map();
  for (const key of Object.keys(fields)) {
    const label = mapping[key]; if (!label) continue;
    updates.set(label, canonical.filter((l) => l.startsWith(`- ${label}:`)));
  }
  if (kind === "goals") { updates.set("更新于", canonical.filter((l) => l.startsWith("- 更新于:"))); updates.set("updated", []); }
  const out = []; const seen = new Set(); let fence; let replacedHeading = false; let replacedListContinuation = false;
  for (const line of lines) {
    // A fence opener is never a list continuation, even with up to three leading spaces.
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) { if (!fence) fence = { char: f[1][0], length: f[1].length }; else if (f[1][0] === fence.char && f[1].length >= fence.length && !f[2].trim()) fence = undefined; replacedListContinuation = false; out.push(line); continue; }
    // Immediate indented continuations belong to the replaced known list item, not an extension.
    if (!fence && replacedListContinuation && /^\s+\S/.test(line)) continue;
    replacedListContinuation = false;
    if (!fence && !replacedHeading && /^##\s*(?:目标|经验|教训)\s+/.test(line)) { out.push(canonical[0]); replacedHeading = true; continue; }
    const m = !fence ? /^-\s*([^:：]+)\s*[:：]/.exec(line) : null;
    const label = m?.[1].trim();
    if (label && updates.has(label)) {
      if (!seen.has(label)) out.push(...updates.get(label));
      seen.add(label);
      replacedListContinuation = kind === "goals" && (label === "关键结果" || label === "教训");
    }
    else out.push(line);
  }
  for (const [label, replacement] of updates) if (!seen.has(label)) out.push(...replacement);
  const result = out.join(eol);
  const check = kind === "goals" ? parseGoalCards(result) : parseLessonEntries(result);
  if (check.length !== 1 || check[0].id !== oldId) boardError("转换后条目身份改变，拒绝保存。");
  return result;
}
function protocolLines(text) {
  const out = []; let fence;
  for (const line of text.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) { if (!fence) fence = { char: f[1][0], length: f[1].length }; else if (f[1][0] === fence.char && f[1].length >= fence.length && !f[2].trim()) fence = undefined; continue; }
    if (!fence) out.push(line);
  }
  return out;
}
function validateRecord(s, text) {
  if (!["goals", "lessons", "decisions"].includes(s.kind)) return;
  if (!s.entry) return;
  if (s.kind === "decisions") {
    const ids = fileSections(text, "decisions").filter((p) => /^D\d+$/.test(p.key));
    if (ids.length !== 1 || ids[0].key !== s.entry) boardError("决策编辑必须保留原编号，且不能合并多条记录。");
    return;
  }
  const parsed = s.kind === "goals" ? parseGoalCards(text) : parseLessonEntries(text);
  const before = s.kind === "goals" ? parseGoalCards(s.selectedText) : parseLessonEntries(s.selectedText);
  if (parsed.length !== 1 || before.length !== 1 || parsed[0].id !== before[0].id) boardError("编辑必须保留原条目编号，且只能包含一条记录。");
  if (s.kind === "goals") {
    const c = parsed[0];
    const lines = protocolLines(text);
    const headerState = /^##\s*目标\s+[A-Za-z0-9._-]+\s*[·|]\s*(.*?)\s*$/.exec(lines.find((l) => /^##\s*目标\s+/.test(l)) ?? "")?.[1];
    const explicitStates = lines.map((l) => /^-\s*status\s*[:：]\s*(.*?)\s*$/.exec(l)?.[1]).filter((v) => v !== undefined);
    const accepted = [...GOAL_STATUSES, ...Object.values(GOAL_STATUS_LABEL)];
    if ((!headerState && !explicitStates.length) || (headerState && !accepted.includes(headerState)) || explicitStates.some((v) => !accepted.includes(v))) boardError("目标必须声明有效状态，不能依赖解析器猜默认状态。");
    if (!lines.some((l) => /^-\s*title\s*[:：]\s*\S/.test(l)) || !lines.some((l) => /^-\s*parent\s*[:：]\s*\S/.test(l)) || !GOAL_STATUSES.includes(c.status) || !c.title.trim()) boardError("目标必须填写 title、parent 和有效状态。");
    let all;
    if (s.mode.card) all = boundedCards(s).flatMap(({ key }) => parseGoalCards(source(s.root, "goals", key, s).text));
    else all = parseGoalCards(s.text);
    if (new Set(all.map((p) => p.id)).size !== all.length) boardError("目标树中有重复编号，须先修复再编辑。");
    const previousIssues = new Set(buildGoalTree(all).issues);
    const tree = buildGoalTree(all.map((p) => p.id === c.id ? c : p));
    const introduced = tree.issues.filter((issue) => !previousIssues.has(issue));
    if (introduced.length) boardError("目标修改引入新的结构问题：" + JSON.stringify(introduced));
    if (tree.issues.length) return "本次修改未增加结构问题，但目标树仍有既有问题：" + JSON.stringify(tree.issues);
  } else {
    const c = parsed[0];
    if (c.type !== before[0].type || !c.id.startsWith(c.type === "经验" ? "E" : "L")) boardError("经验/教训类型与原编号身份不一致。");
    if (!c.title.trim() || !(c.type === "经验" ? EXPERIENCE_KINDS : LESSON_KINDS).includes(c.kind) || !(c.type === "经验" ? c.source : c.cause).trim()) boardError("经验教训缺少有效标题、分类或必填出处/根因。");
  }
}
function prepare(root, args) {
  const kind = typeof args.kind === "string" ? args.kind : "active";
  const entry = typeof args.entry === "string" ? args.entry : "";
  const s = source(root, kind, entry);
  if (s.aggregate) boardError("请先选择一张卡片。");
  roleGuard(s, s.abs, true);
  if (typeof args.ifMatch !== "string" || !args.ifMatch) boardError("缺少版本凭据，请先读取内容再保存。", 428);
  if (args.ifMatch !== s.etag) boardError("内容或项目配置已经改变；请重新读取并合并草稿。", 409);
  const mode = args.mode;
  if (mode !== "replace" && mode !== "append") boardError("必须明确指定 replace 或 append。");
  if (kind === "journal" && (mode !== "append" || entry)) boardError("流水只允许在全文末尾追加；历史条目不可改写。", 403);
  if (["goals", "lessons"].includes(kind) && !entry) boardError("目标/经验教训请逐条编辑，不能整份替换。");
  if ((args.fields !== undefined) === (args.content !== undefined)) boardError("content 与 fields 必须且只能提供一个。");
  let text;
  if (args.fields !== undefined) {
    if (!args.fields || Array.isArray(args.fields) || typeof args.fields !== "object" || mode !== "replace") boardError("此条目不支持这种结构化编辑。");
    if (["goals", "lessons"].includes(kind)) text = patchBoardFields(s.selectedText, args.fields, kind);
    else if ((kind === "active" && s.section) || (kind === "decisions" && entry)) {
      const p = narrativeParts(s); const f = args.fields;
      if (!p || Object.keys(f).some((k) => k !== "title" && k !== "body") || typeof f.title !== "string" || !f.title.trim() || /[\r\n]/.test(f.title) || typeof f.body !== "string") boardError("标题/正文格式无效，标题必须单行且不能为空。");
      if (boardSections(f.body).some((h) => h.level <= p.head.level)) boardError("正文中不能新增同级或更高级标题；请改用子标题。");
      const eol = s.selectedText.includes("\r\n") ? "\r\n" : "\n";
      text = p.prefix + "#".repeat(p.head.level) + " " + (kind === "decisions" ? `${entry} · ` : "") + f.title.trim() + eol + f.body;
    } else boardError("此条目不支持结构化编辑。");
  } else {
    if (typeof args.content !== "string" || !args.content.trim()) boardError("内容不能为空。");
    text = args.content;
  }
  if (mode === "append" && kind !== "journal") text = s.selectedText.replace(/\s*$/, "") + "\n\n" + text;
  const warning = validateRecord(s, text);
  return { s, text, mode, warning };
}
export function boardPreview(root, args) {
  const p = prepare(root, args); return { ok: true, text: p.text, etag: p.s.etag, ...(p.warning ? { warning: p.warning } : {}) };
}
/** Synchronous critical section: no awaits between CAS/read/backup/replace within this Host. */
export function boardWrite(root, args, state, exec) {
  const { s, text, mode, warning } = prepare(root, args);
  const actorTag = exec ? sessionTag(exec.agent) ?? "工具编辑器" : "看板";
  const sessionId = exec?.agent?.session?.header?.id;
  if (source(root, s.kind, s.entry).etag !== s.etag) boardError("写前内容已改变，请重试读取。", 409);
  let result;
  if (!s.mode.card && ["active", "decisions", "journal"].includes(s.kind)) {
    let next = text;
    if (s.section) next = s.text.slice(0, s.section.start) + text.replace(/\s*$/, "") + "\n\n" + s.text.slice(s.section.end);
    result = writeLedger(root, { target: s.kind, mode: s.kind === "journal" ? "append" : "replace", content: next, ifRevision: manifestRevision(s.info.manifest) }, exec, state);
  } else {
    const backup = backupBeforeWrite({ memBase: s.base, rel: s.rel, prevText: s.raw, forceHot: true });
    if (!backup.ok && !backup.skipped) boardError("备份失败，未执行看板覆盖：" + backup.reason, 500);
    if (s.mode.card) result = writeKindCard(root, s.info, s.kind, s.entry, text);
    else {
      const next = s.text.slice(0, s.section.start) + text.replace(/\s*$/, "") + "\n\n" + s.text.slice(s.section.end);
      const pid = projectOf(root);
      result = writeFileAtomic(s.abs, next, pid ? { fp: { kind: s.kind, project: pid, key: "-" } } : undefined);
    }
    if (result?.ok) {
      let revision;
      if (s.kind === "goals") revision = recordGoalsChange(root, s.info, { op: "board-edit", id: s.entry, relPath: s.rel, tag: actorTag, sessionId });
      else { revision = bumpRevision(root); try { appendAudit(root, s.info, { target: s.kind, mode: "board-edit", relPath: s.rel, tag: actorTag, sessionId, revision }); } catch { /* main write already committed */ } }
      result = { ...result, revision: revision ?? null, backup: backup.rel ?? null, ...(revision === undefined ? { warning: "正文已保存，但清单版本更新失败。" } : {}) };
    }
  }
  if (result?.ok !== true) boardError(result?.reason ?? "保存失败。", 409);
  const warnings = [warning, result.warning,
    !Number.isFinite(result.revision) ? "正文已保存，但清单版本更新失败。" : null,
    result.backupFailed ? `正文已保存，但备份失败：${result.backupFailed}` : null].filter(Boolean);
  return { ...result, ok: true, root,
    ...(warnings.length ? { warning: [...new Set(warnings)].join("\n") } : {}),
    selected: boardRead(root, s.kind, s.entry) };
}
