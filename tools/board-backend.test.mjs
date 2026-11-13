// Real HTTP integration; every mutable artifact is under this owned temporary home.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-board-backend-"));
process.env.DSH_HOME = home;
const board = await import("../lib/board-http.js");
const model = await import("../lib/board-model.js");
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const routes = new Map(); let rejection; let missingAuth = false;
const installed = board.installBoardRoutes({ get: () => missingAuth ? undefined : { requestRejection: () => rejection }, webServer: { register: ({ path: url, handler }) => { routes.set(url, handler); return () => routes.delete(url); } } }, {});
const server = http.createServer((req, res) => { const fn = routes.get(new URL(req.url, "http://local").pathname); if (fn) fn(req, res); else { res.writeHead(404); res.end(); } });
let origin;
async function call(route, params = {}, body) {
  const url = origin + route + "?" + new URLSearchParams(params);
  const r = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
function fixture(name, card = true) {
  const root = path.join(home, name); const mem = path.join(root, "memory");
  fs.mkdirSync(mem, { recursive: true });
  const manifest = { memoryRoot: "memory", active: "LEDGER.md", decisions: "DECISIONS.md", journal: "JOURNAL.md", goals: "GOALS.md", lessons: "LESSONS.md", principles: "PRINCIPLES.md", archiveDir: "archive", revision: 7, maxActiveLines: 400, autoGitAdd: false };
  if (card) for (const kind of ["decisions", "goals", "lessons"]) { manifest[`${kind}Dir`] = kind; fs.mkdirSync(path.join(mem, kind)); }
  const texts = {
    active: "# 活跃台账\n\n## 当前计划\n原有内容 AlphaNeedle\n\n## 保留部分\nKEEP SECOND\n",
    decisions: "## D1 · 第一条决策\n\n决策正文 DeltaNeedle\n\n### 子节\n保留子节\n",
    journal: "# 流水\n\n## 历史一\nORIGINAL HISTORY\n",
    goals: "## 目标 g1 · 根本目标\n- parent: -\n- title: 总目标\n- 更新于: 2026-11-01\n- 关键结果: 完成第一项\n- 教训: 已知经验\n- 自定义: MUST KEEP\n未知正文 MUST KEEP PROSE\n\n```md\n- title: CODE KEEP\n```\n",
    lessons: "## 教训 L1 · 假设错\n- 标题: 教训标题\n- 根因: 已查明根因\n- 正解: 修正方法\n- 自定义: LESSON KEEP\n未知教训正文\n",
    principles: "# 根本原则\nIMMUTABLE PRINCIPLE\n"
  };
  for (const [kind, text] of Object.entries(texts)) {
    const filename = card && ["decisions", "goals", "lessons"].includes(kind) ? path.join(kind, kind === "decisions" ? "D1.md" : kind === "goals" ? "g1.md" : "L1.md") : manifest[kind];
    fs.writeFileSync(path.join(mem, filename), text);
  }
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(manifest));
  return { root, mem, manifest, texts };
}
try {
  const a = fixture("project-a"); const b = fixture("project-b", false);
  board.rememberSessionRoot("sid-a", a.root); board.rememberSessionRoot("sid-b", b.root);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}/dsh-ledger-memory-board`;
  let r = await call("/board.json");
  check("no identity requires selection, not latest project", () => { assert.equal(r.body.needPick, true); assert.equal(r.body.root, undefined); assert.equal(r.headers.get("cache-control"), "no-store"); });
  r = await call("/board.json", { sid: "unknown" }); check("unknown sid fails closed", () => assert.equal(r.status, 404));
  r = await call("/board.json", { sid: "sid-a", root: b.root }); check("conflicting sid/root rejected", () => assert.equal(r.status, 409));
  r = await call("/board.json", { root: a.root });
  check("V3 inventories real cards and manifest revision", () => { assert.equal(r.body.revision, 7); assert.equal(r.body.rows.find((x) => x.kind === "decisions").items[0].key, "D1"); assert.equal(r.body.rows.find((x) => x.kind === "goals").count, 1); });
  r = await call("/board-file.json", { root: a.root, kind: "decisions", entry: "D999" }); check("missing card not successful empty document", () => { assert.equal(r.status, 404); assert.equal(r.body.ok, false); });
  r = await call("/board-file.json", { root: a.root, kind: "decisions", entry: "../../x" }); check("traversal key rejected", () => assert.ok(r.status >= 400));
  rejection = 401; r = await call("/board.json", { root: a.root }); check("unauthenticated request rejected", () => assert.equal(r.status, 401));
  rejection = 403; r = await call("/search.json", { root: a.root, q: "KEEP" }); check("cross origin policy rejection propagated", () => assert.equal(r.status, 403));
  rejection = undefined; missingAuth = true; r = await call("/board.json", { root: a.root }); check("missing auth context rejected", () => assert.equal(r.status, 503)); missingAuth = false;
  r = await call("/board.json", {}, { root: a.root, kind: "active", mode: "replace", content: "would overwrite" }); check("write requires CAS", () => { assert.equal(r.status, 428); assert.match(fs.readFileSync(path.join(a.mem, "LEDGER.md"), "utf8"), /原有内容/); });
  let selected = (await call("/board-file.json", { root: a.root, kind: "active", entry: "section:2" })).body;
  check("active sections expose structured editor", () => { assert.equal(selected.editor.type, "section"); assert.equal(selected.writable, true); });
  const edit = { root: a.root, kind: "active", entry: "section:2", mode: "replace", ifMatch: selected.etag, fields: { title: "新计划", body: "NEW CURRENT\n" } };
  const diskBefore = fs.readFileSync(path.join(a.mem, "LEDGER.md"), "utf8");
  r = await call("/preview.json", {}, edit); check("preview converts without writing", () => { assert.equal(r.body.ok, true); assert.match(r.body.text, /## 新计划/); assert.equal(fs.readFileSync(path.join(a.mem, "LEDGER.md"), "utf8"), diskBefore); });
  r = await call("/board.json", {}, edit); check("section save preserves adjacent section", () => { assert.equal(r.body.ok, true); const saved = fs.readFileSync(path.join(a.mem, "LEDGER.md"), "utf8"); assert.match(saved, /NEW CURRENT/); assert.match(saved, /KEEP SECOND/); });
  r = await call("/board.json", {}, edit); check("stale editor refused", () => assert.equal(r.status, 409));
  selected = (await call("/board-file.json", { root: a.root, kind: "active" })).body;
  r = await call("/board.json", {}, { root: b.root, kind: "active", mode: "replace", ifMatch: selected.etag, content: "cross project" }); check("CAS bound to project", () => assert.equal(r.status, 409));
  selected = (await call("/board-file.json", { root: a.root, kind: "journal" })).body;
  r = await call("/board.json", {}, { root: a.root, kind: "journal", mode: "replace", ifMatch: selected.etag, content: selected.text }); check("journal replace refused", () => assert.equal(r.status, 403));
  r = await call("/board.json", {}, { root: a.root, kind: "journal", mode: "append", ifMatch: selected.etag, content: "NEW HISTORY" }); check("journal append preserves original once", () => { assert.equal(r.body.ok, true); const saved = fs.readFileSync(path.join(a.mem, "JOURNAL.md"), "utf8"); assert.equal(saved.split("ORIGINAL HISTORY").length - 1, 1); assert.match(saved, /NEW HISTORY/); });
  selected = (await call("/board-file.json", { root: a.root, kind: "principles" })).body;
  r = await call("/board.json", {}, { root: a.root, kind: "principles", mode: "replace", ifMatch: selected.etag, content: "bad" }); check("principles always read-only", () => { assert.equal(r.status, 403); assert.equal(fs.readFileSync(path.join(a.mem, "PRINCIPLES.md"), "utf8"), a.texts.principles); });
  selected = (await call("/board-file.json", { root: a.root, kind: "decisions", entry: "D1" })).body;
  check("decision form exposes title/body", () => assert.equal(selected.editor.type, "decisions"));
  r = await call("/board.json", {}, { root: a.root, kind: "decisions", entry: "D1", mode: "replace", ifMatch: selected.etag, fields: { title: "新决策", body: "BODY EDITED" } });
  check("decision card edited with backup", () => { assert.equal(r.body.ok, true); assert.match(fs.readFileSync(path.join(a.mem, "decisions", "D1.md"), "utf8"), /BODY EDITED/); assert.equal(fs.readFileSync(path.join(a.mem, "_backup", "decisions", "D1.md.bak"), "utf8"), a.texts.decisions); });
  selected = (await call("/board-file.json", { root: a.root, kind: "goals", entry: "g1" })).body;
  r = await call("/board.json", {}, { root: a.root, kind: "goals", entry: "g1", mode: "replace", ifMatch: selected.etag, fields: { ...selected.editor.fields, title: "修改目标", status: "done" } });
  check("goal conversion retains unknown prose and fenced fields", () => { assert.equal(r.body.ok, true); const saved = fs.readFileSync(path.join(a.mem, "goals", "g1.md"), "utf8"); for (const text of ["MUST KEEP", "MUST KEEP PROSE", "CODE KEEP", "修改目标"]) assert.ok(saved.includes(text)); });
  selected = (await call("/board-file.json", { root: a.root, kind: "goals", entry: "g1" })).body;
  r = await call("/board.json", {}, { root: a.root, kind: "goals", entry: "g1", mode: "replace", ifMatch: selected.etag, fields: { ...selected.editor.fields, parent: "g1" } }); check("goal cycle rejected", () => assert.equal(r.status, 400));
  selected = (await call("/board-file.json", { root: a.root, kind: "lessons", entry: "L1" })).body;
  r = await call("/board.json", {}, { root: a.root, kind: "lessons", entry: "L1", mode: "replace", ifMatch: selected.etag, fields: { ...selected.editor.fields, title: "新教训" } }); check("lesson fields preserve extensions", () => { assert.equal(r.body.ok, true); assert.match(fs.readFileSync(path.join(a.mem, "lessons", "L1.md"), "utf8"), /LESSON KEEP/); });
  selected = (await call("/board-file.json", { root: a.root, kind: "lessons", entry: "L1" })).body;
  r = await call("/preview.json", {}, { root: a.root, kind: "lessons", entry: "L1", mode: "replace", ifMatch: selected.etag, fields: { ...selected.editor.fields, cause: "" } }); check("missing mandatory field explained", () => { assert.equal(r.status, 400); assert.match(r.body.reason, /根因/); });
  r = await call("/search.json", { root: a.root, q: "keep", limit: "1" }); check("case-insensitive full content search paginated", () => { assert.ok(r.body.total >= 2); assert.equal(r.body.items.length, 1); });
  // Single-file paths use section splice, not aggregate replacement from a parsed object.
  selected = (await call("/board-file.json", { root: b.root, kind: "goals", entry: "g1" })).body;
  r = await call("/board.json", {}, { root: b.root, kind: "goals", entry: "g1", mode: "replace", ifMatch: selected.etag, fields: { ...selected.editor.fields, title: "单文件目标" } }); check("single-file structured goal edit", () => { assert.equal(r.body.ok, true); assert.match(fs.readFileSync(path.join(b.mem, "GOALS.md"), "utf8"), /MUST KEEP PROSE/); });
  const alias = fixture("alias"); alias.manifest.active = "PRINCIPLES.md"; fs.writeFileSync(path.join(alias.root, ".dsh-ledger.json"), JSON.stringify(alias.manifest)); board.rememberSessionRoot("alias", alias.root);
  r = await call("/board-file.json", { root: alias.root, kind: "active" }); check("protected-role alias detected", () => { assert.equal(r.body.ok, false); assert.equal(r.status, 409); });
  const staleRoot = path.join(home, "dead"); fs.mkdirSync(staleRoot); board.rememberSessionRoot("dead", staleRoot); fs.rmdirSync(staleRoot);
  check("dead roots hidden at runtime", () => assert.equal(board.knownRoots().some((x) => x.root === staleRoot), false));
  board.flushBoardRootsStore(); const store = board.boardRootsStorePath();
  const originalStore = fs.readFileSync(store, "utf8"); fs.writeFileSync(store, JSON.stringify({version:999, roots:[{root:a.root,seq:1}], sessions:[]}));
  check("unknown roots store version rejected", () => assert.equal(board.loadBoardRootsStore().ok, false)); fs.writeFileSync(store, originalStore);
  check("fence-aware headings exclude code text", () => assert.equal(model.boardSections("## Real\n````js\n```\n## Not a section\n````\n## Next\n").length, 2));
  const parsedGoal = (await import('../lib/part2.js')).parseGoalCards;
  const continued = "## 目标 g9 · 进行中\n- parent: -\n- title: 续行目标\n- 关键结果: old\n  continuation\n- 教训: old lesson\n  detail\n- 扩展: KEEP EXT\n";
  const patched = model.patchBoardFields(continued, { kr: ["NEW KR"], lessons: ["NEW LESSON"] }, "goals");
  check("known list continuations replaced without stale reattachment", () => { assert.deepEqual(parsedGoal(patched)[0].kr, ["NEW KR"]); assert.deepEqual(parsedGoal(patched)[0].lessons, ["NEW LESSON"]); assert.match(patched, /KEEP EXT/); });
  const fencedContinuation = "## 目标 g1 · 进行中\n- parent: -\n- title: t\n- 关键结果: old\n  ~~~md\n- custom: KEEP\n  ~~~\n";
  const patchedFence = model.patchBoardFields(fencedContinuation, { kr: ["new"] }, "goals");
  check("indented fence after replaced list survives byte-for-byte", () => assert.ok(patchedFence.includes("  ~~~md\n- custom: KEEP\n  ~~~\n")));
  const multiline = model.patchBoardFields(a.texts.lessons, { cause: "line one\nline two" }, "lessons");
  check("lesson narrative multiline auto-flattens in protocol", () => assert.match(multiline, /- 根因: line one line two/));
  selected = (await call("/board-file.json", { root: a.root, kind: "goals", entry: "g1" })).body;
  r = await call("/preview.json", {}, { root: a.root, kind: "goals", entry: "g1", mode: "replace", ifMatch: selected.etag, content: selected.text.replace(/^##.*$/m, "## 目标 g1 · 非法状态") });
  check("raw goal cannot silently default invalid status", () => assert.equal(r.status, 400));
  selected = (await call("/board-file.json", { root: a.root, kind: "lessons", entry: "L1" })).body;
  r = await call("/preview.json", {}, { root: a.root, kind: "lessons", entry: "L1", mode: "replace", ifMatch: selected.etag, content: "## 经验 L1 · 机制\n- 标题: 类型混淆\n- 出处: source\n" });
  check("raw lesson cannot change identity type", () => assert.equal(r.status, 400));
  const overlap = fixture("overlap"); overlap.manifest.goalsDir = "decisions";
  fs.writeFileSync(path.join(overlap.root, ".dsh-ledger.json"), JSON.stringify(overlap.manifest)); board.rememberSessionRoot("overlap", overlap.root);
  r = await call("/board-file.json", { root: overlap.root, kind: "decisions", entry: "D1" }); check("overlapping untagged card-role directories rejected", () => assert.equal(r.status, 409));
  selected = (await call("/board-file.json", { root: a.root, kind: "active" })).body;
  const simultaneous = await Promise.all(["ONE", "TWO"].map((content) => call("/board.json", {}, { root: a.root, kind: "active", mode: "replace", ifMatch: selected.etag, content })));
  check("simultaneous HTTP saves allow exactly one CAS writer", () => { assert.equal(simultaneous.filter((x) => x.status === 200).length, 1); assert.equal(simultaneous.filter((x) => x.status === 409).length, 1); });
  board.rememberSessionRoot("save-failure", a.root);
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === store) throw Object.assign(new Error("fixture write denied"), { code: "EACCES" }); return originalRename(from, to); };
    const failed = board.flushBoardRootsStore();
    check("roots persistence failure retains dirty state and error", () => { assert.equal(failed.ok, false); assert.equal(board.boardRootsPersistenceStatus().dirty, true); assert.match(board.boardRootsPersistenceStatus().error, /fixture write denied/); });
  } finally { fs.renameSync = originalRename; }
  check("roots persistence retry clears dirty only after success", () => { assert.equal(board.flushBoardRootsStore().ok, true); assert.equal(board.boardRootsPersistenceStatus().dirty, false); });
  const fingerprint = await import('../lib/fingerprint.js');
  const fpFixture = fixture('fingerprint-cases'); fpFixture.manifest.projectId = '0123456789abcdef';
  fs.writeFileSync(path.join(fpFixture.root, '.dsh-ledger.json'), JSON.stringify(fpFixture.manifest));
  board.rememberSessionRoot('fingerprint-cases', fpFixture.root);
  const fpPath = path.join(fpFixture.mem, 'decisions', 'D1.md');
  for (const [label, id] of [
    ['foreign project', {kind:'decisions',project:'fedcba9876543210',key:'D1'}],
    ['foreign kind', {kind:'goals',project:'0123456789abcdef',key:'D1'}],
    ['foreign key', {kind:'decisions',project:'0123456789abcdef',key:'D2'}],
    ['singleton key on card', {kind:'decisions',project:'0123456789abcdef',key:'-'}]
  ]) {
    fs.writeFileSync(fpPath, fingerprint.applyFingerprint3('## D1 · identity test\nbody\n', id).text);
    r = await call('/board-file.json', {root:fpFixture.root,kind:'decisions',entry:'D1'});
    check(`fingerprint ${label} rejected`, () => { assert.equal(r.body.ok,false); assert.equal(r.body.writable,false); });
  }
  const validFp = fingerprint.applyFingerprint3('## D1 · identity test\nbody\n', {kind:'decisions',project:'0123456789abcdef',key:'D1'}).text;
  const brokenFp = validFp.replace(/check=[0-9a-f]{8}/, 'check=not-valid');
  assert.equal(fingerprint.readFingerprint3(brokenFp).ok,false);
  fs.writeFileSync(fpPath,brokenFp);
  r = await call('/board-file.json', {root:fpFixture.root,kind:'decisions',entry:'D1'});
  check('corrupted fingerprint carriers refused',()=>assert.equal(r.body.ok,false));
  fs.writeFileSync(path.join(fpFixture.mem,'decisions','renamed.md'),validFp);
  fs.unlinkSync(fpPath);
  r = await call('/board-file.json', {root:fpFixture.root,kind:'decisions',entry:'D1'});
  check('renamed fingerprint does not silently select another write target',()=>assert.equal(r.status,404));
  const repair = fixture('graph-repair');
  fs.writeFileSync(path.join(repair.mem,'goals','g1.md'),'## 目标 g1 · active\n- parent: missingA\n- title: First\n');
  fs.writeFileSync(path.join(repair.mem,'goals','g2.md'),'## 目标 g2 · active\n- parent: missingB\n- title: Second\n');
  board.rememberSessionRoot('graph-repair',repair.root);
  selected = (await call('/board-file.json',{root:repair.root,kind:'goals',entry:'g1'})).body;
  r = await call('/board.json',{}, {root:repair.root,kind:'goals',entry:'g1',mode:'replace',ifMatch:selected.etag,fields:{parent:'-'}});
  check('first broken parent can be repaired while another remains',()=>{assert.equal(r.body.ok,true,JSON.stringify(r.body));assert.match(r.body.warning,/既有问题/);});
  selected = (await call('/board-file.json',{root:repair.root,kind:'goals',entry:'g2'})).body;
  r = await call('/board.json',{}, {root:repair.root,kind:'goals',entry:'g2',mode:'replace',ifMatch:selected.etag,fields:{parent:'g1'}});
  check('second broken parent can be repaired independently',()=>{assert.equal(r.body.ok,true,JSON.stringify(r.body));assert.equal(r.body.warning,undefined);});
  selected = (await call('/board-file.json',{root:repair.root,kind:'goals',entry:'g1'})).body;
  r = await call('/preview.json',{}, {root:repair.root,kind:'goals',entry:'g1',mode:'replace',ifMatch:selected.etag,fields:{parent:'g2'}});
  check('new cycle still rejected after incremental repair',()=>assert.equal(r.status,400));
  const originalRead = fs.readFileSync; let sourceReads=0;
  try {
    fs.readFileSync=(file,...rest)=>{if(String(file)===path.join(a.mem,'decisions','D1.md'))sourceReads++;return originalRead(file,...rest);};
    model.boardSearch(a.root,'BODY',0,30);
    check('search reads each card body only once per request',()=>assert.equal(sourceReads,1));
  } finally {fs.readFileSync=originalRead;}
  const freshBefore=model.boardRead(a.root,'decisions','D1');
  fs.appendFileSync(path.join(a.mem,'decisions','D1.md'),'\nFRESH EXTERNAL TEXT\n');
  const freshAfter=model.boardRead(a.root,'decisions','D1');
  check('request-local cache never hides subsequent external edits',()=>{assert.notEqual(freshBefore.etag,freshAfter.etag);assert.match(freshAfter.text,/FRESH EXTERNAL TEXT/);});
  console.log(`BOARD BACKEND: ${passed} passed, 0 failed`);
} finally {
  board.flushBoardRootsStore(); installed.dispose(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(path.basename(home).startsWith("ledger-board-backend-"));
  fs.rmSync(home, { recursive: true, force: true });
}
