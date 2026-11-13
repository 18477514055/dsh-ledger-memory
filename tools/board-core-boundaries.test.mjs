// Legacy tool regression boundaries. Fixtures and fault injection are confined to one temp home.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-core-boundaries-"));
process.env.DSH_HOME = home;
const core = await import("../lib/part2-tools.js");
const part2 = await import("../lib/part2.js");
const writes = await import("../lib/part4.js");
const guard = await import("../lib/memory-role-guard.js");
const goals = core.defineGoalsTool(); const lessons = core.defineLessonsTool();
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
function fixture(name, card = true, omitGoals = false) {
  const root = path.join(home, name); const mem = path.join(root, "memory"); fs.mkdirSync(mem, { recursive: true });
  const manifest = { memoryRoot: "memory", active: "LEDGER.md", decisions: "DECISIONS.md", journal: "JOURNAL.md", principles: "PRINCIPLES.md", lessons: "LESSONS.md", archiveDir: "archive", autoGitAdd: false, revision: 1, maxActiveLines: 400 };
  if (!omitGoals) manifest.goals = "GOALS.md";
  if (card) for (const kind of ["goals", "lessons"]) { manifest[`${kind}Dir`] = kind; fs.mkdirSync(path.join(mem, kind)); }
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# Ledger\nORIGINAL ACTIVE\n");
  fs.writeFileSync(path.join(mem, "DECISIONS.md"), "# Decisions\n");
  fs.writeFileSync(path.join(mem, "JOURNAL.md"), "# Journal\nORIGINAL JOURNAL\n");
  fs.writeFileSync(path.join(mem, "PRINCIPLES.md"), "# Principles\nORIGINAL PRINCIPLES\n");
  const goalText = "## 目标 g1 · active\n- parent: -\n- title: Existing goal\n- 关键结果: First result\n- 教训: Previous lesson\n- 自定义字段: PRESERVE FIELD\n\nUnknown paragraph PRESERVE PROSE\n```md\n- title: CODE SAMPLE\n```\n";
  if (!omitGoals) fs.writeFileSync(path.join(mem, card ? "goals/g1.md" : "GOALS.md"), goalText);
  if (!card) fs.writeFileSync(path.join(mem, "LESSONS.md"), "# Lessons\n");
  const exec = { agent: { session: { header: { id: name, cwd: root } } } };
  return { root, mem, manifest, exec, goalText };
}
function manifestSave(f) { fs.writeFileSync(path.join(f.root, ".dsh-ledger.json"), JSON.stringify(f.manifest)); }
try {
  const f = fixture("cards");
  fs.writeFileSync(path.join(f.mem, "lessons", "L1.md"), "MALFORMED BUT VALUABLE CARD\n");
  let r = await lessons.execute({ op: "add", kind: "其他", title: "New lesson", cause: "Verified reason" }, f.exec);
  check("malformed physical card reserves its ID", () => { assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.id, "L2"); assert.equal(fs.readFileSync(path.join(f.mem, "lessons", "L1.md"), "utf8"), "MALFORMED BUT VALUABLE CARD\n"); });
  fs.writeFileSync(path.join(f.mem, "lessons", "l9.MD"), "UPPER EXTENSION OCCUPANT");
  r = await lessons.execute({ op: "add", kind: "其他", title: "Next lesson", cause: "Verified reason" }, f.exec);
  check("case-insensitive physical filename allocation", () => { assert.equal(r.id, "L10"); assert.equal(fs.readFileSync(path.join(f.mem, "lessons", "l9.MD"), "utf8"), "UPPER EXTENSION OCCUPANT"); });
  fs.mkdirSync(path.join(f.mem, "lessons", "E8.md"));
  r = await lessons.execute({ op: "add", type: "经验", kind: "机制", title: "New experience", source: "file:1" }, f.exec);
  check("directory occupants also reserve generated keys", () => { assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.id, "E9"); });
  for (const cardMode of [true, false]) {
    const g = cardMode ? f : fixture("singletons", false);
    const filename = path.join(g.mem, cardMode ? "goals/g1.md" : "GOALS.md");
    r = await goals.execute({ op: "status", id: "g1", status: "done" }, g.exec);
    check(`legacy goal status preserves unknown data (${cardMode ? "card" : "file"})`, () => { assert.equal(r.ok, true, JSON.stringify(r)); const raw = fs.readFileSync(filename, "utf8"); for (const s of ["PRESERVE FIELD", "PRESERVE PROSE", "CODE SAMPLE"]) assert.ok(raw.includes(s)); assert.equal(part2.parseGoalCards(raw)[0].status, "done"); });
    r = await goals.execute({ op: "lesson", id: "g1", lesson: "Additional\nlesson" }, g.exec);
    check(`legacy goal lesson preserves raw extensions (${cardMode ? "card" : "file"})`, () => { assert.equal(r.ok, true, JSON.stringify(r)); const raw = fs.readFileSync(filename, "utf8"); assert.match(raw, /PRESERVE FIELD/); assert.match(raw, /PRESERVE PROSE/); assert.deepEqual(part2.parseGoalCards(raw)[0].lessons, ["Previous lesson", "Additional lesson"]); });
  }
  const fresh = fixture("registration-failure", false, true);
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === path.join(fresh.root, ".dsh-ledger.json")) throw Object.assign(new Error("fixture manifest denied"), { code: "EACCES" }); return originalRename(from, to); };
    r = await goals.execute({ op: "upsert", id: "g1", title: "First goal", parent: "-", status: "root" }, fresh.exec);
    check("registration failure reports committed content and partial state", () => { assert.equal(r.ok, true); assert.equal(r.partial, true); assert.equal(r.contentWritten, true); assert.equal(r.manifestRegistered, false); assert.match(r.warning, /不要盲目重试/); assert.ok(fs.existsSync(path.join(fresh.mem, "GOALS.md"))); assert.equal(JSON.parse(fs.readFileSync(path.join(fresh.root, ".dsh-ledger.json"), "utf8")).goals, undefined); });
  } finally { fs.renameSync = originalRename; }
  for (const protectedRole of ["principles", "journal"]) {
    const alias = fixture(`alias-${protectedRole}`, false);
    alias.manifest.active = alias.manifest[protectedRole]; manifestSave(alias);
    const file = path.join(alias.mem, alias.manifest[protectedRole]); const before = fs.readFileSync(file, "utf8");
    r = writes.writeLedger(alias.root, { target: "active", mode: "replace", content: "WRONG ROLE" }, alias.exec, {});
    check(`legacy writer cannot overwrite ${protectedRole} via active alias`, () => { assert.equal(r.ok, false); assert.equal(r.roleCollision, true); assert.equal(fs.readFileSync(file, "utf8"), before); });
    r = writes.archiveLedger(alias.root, { entries: before, newActive: "EMPTY", label: "alias test" }, alias.exec);
    check(`archive cannot overwrite ${protectedRole} via active alias`, () => { assert.equal(r.ok, false); assert.equal(r.roleCollision, true); assert.equal(fs.readFileSync(file, "utf8"), before); assert.equal(fs.existsSync(path.join(alias.mem, "archive")), false); });
  }
  const shared = fixture("shared-card-directory"); shared.manifest.goalsDir = "lessons"; manifestSave(shared);
  r = await goals.execute({ op: "upsert", id: "g9", title: "Cross role", parent: "-" }, shared.exec);
  check("goal direct tool refuses overlapping card-role directory", () => { assert.equal(r.ok, false); assert.equal(r.roleCollision, true); assert.equal(fs.existsSync(path.join(shared.mem, "lessons", "g9.md")), false); });
  r = await lessons.execute({ op: "add", kind: "其他", title: "Cross role", cause: "root" }, shared.exec);
  check("lesson direct tool refuses overlapping card-role directory", () => { assert.equal(r.ok, false); assert.equal(r.roleCollision, true); });
  const nested = fixture("nested-card-directory"); nested.manifest.goalsDir = "lessons/goals"; manifestSave(nested);
  r = guard.refuseMemoryRoleCollision(nested.root, part2.inspect(nested.root), "goals");
  check("ancestor-descendant card directories collide before child exists", () => assert.equal(r?.roleCollision, true));
  const normalized = fixture("normalized-role"); normalized.manifest.active = "./PRINCIPLES.md"; manifestSave(normalized);
  check("normalized aliases share final identity", () => assert.equal(guard.refuseMemoryRoleCollision(normalized.root, part2.inspect(normalized.root), "active")?.roleCollision, true));
  const realAlias = fixture("real-alias", false);
  fs.mkdirSync(path.join(realAlias.mem, "actual"));
  fs.writeFileSync(path.join(realAlias.mem, "actual", "protected.md"), "PHYSICAL PROTECTED");
  fs.symlinkSync(path.join(realAlias.mem, "actual"), path.join(realAlias.mem, "alias"), "junction");
  realAlias.manifest.active = "alias/protected.md"; realAlias.manifest.journal = "actual/protected.md"; manifestSave(realAlias);
  check("real ancestor aliases cannot bypass role identity", () => assert.equal(guard.refuseMemoryRoleCollision(realAlias.root, part2.inspect(realAlias.root), "active")?.roleCollision, true));
  const normal = fixture("normal-role");
  check("valid distinct roles remain usable", () => assert.equal(guard.refuseMemoryRoleCollision(normal.root, part2.inspect(normal.root), "goals"), undefined));
  console.log(`CORE BOUNDARIES: ${passed} passed, 0 failed`);
} finally {
  assert.ok(path.basename(home).startsWith("ledger-core-boundaries-"));
  fs.rmSync(home, { recursive: true, force: true });
}
