#!/usr/bin/env node
// Offline diagnosis only: imports production functions, never edits production source.
// Fixtures and DSH_HOME are isolated under one fresh temporary directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-continuity-diagnosis-'));
process.env.DSH_HOME = path.join(fixture, 'home');
const { newState, setActiveSettings } = await import('../lib/defs.js');
const { settingsOf } = await import('../lib/part1.js');
const { midTurnCompactGate: gate, runMidTurnCompact, renderPressureNotice } = await import('../lib/part3.js');
const { runTurnCompact } = await import('../lib/part5.js');
const before = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'lib')).filter(n => n.endsWith('.js')).map(n => [n, hash(path.join(ROOT, 'lib', n))]));
function hash(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
let pass = 0, fail = 0;
function check(name, yes, detail) { if (yes) pass++; else fail++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); }
const sid = 'offline-continuity-fixture';
const root = path.join(fixture, 'project');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'LEDGER.md'), '# fixture ledger\n');
fs.writeFileSync(path.join(root, '.dsh-ledger.json'), JSON.stringify({ active: 'LEDGER.md', revision: 1 }));
const logs = [], steers = [];
const agent = { session: { header: { id: sid, cwd: root } }, steer: m => steers.push(m) };
const ctx = { logger: { warn: s => logs.push(s) } };
const configure = patch => setActiveSettings(settingsOf({ midTurnCompact: true, diagFile: true, highFidelityCompactRatio: 0.7, turnEndPull: 1, ...patch }));
const ready = () => ({ wrote: true, triaged: true, writeSeq: 100, triageSeq: 101, lastNonLedgerSeq: 90 });
const params = { enabled: true, ratio: 0.78, line: 0.7, urgent: 0.78 };
configure();
check('gate: ready without phase can compact', gate({ ...params, gapsOk: true }).act === 'compact');
check('CONTRACT owed + completed obligations must advance', gate({ ...params, phase: 'owed', gapsOk: true }).act === 'compact');
check('gate: owed + missing obligations waits', gate({ ...params, phase: 'owed', gapsOk: false }).act === 'wait');

// Drive the actual state machine across steps, rather than testing unrelated static states.
const st = newState();
st.turnObligation.set(sid, { wrote: false, triaged: false });
let calls = 0;
const deps = { turn: 41, pressure: { ratio: 0.75 }, runTurnCompact: async () => { calls++; return { compacted: true }; } };
const first = await runMidTurnCompact(ctx, st, agent, deps);
check('flow: first step requests obligations and steers once', first.act === 'pull' && steers.length === 1 && st.turnCompact.get(sid)?.phase === 'owed');
st.turnObligation.set(sid, ready());
const second = await runMidTurnCompact(ctx, st, agent, deps);
check('CONTRACT flow: completed obligations invoke runner without new user input', calls === 1 && second.compacted === true, JSON.stringify({ calls, second, phase: st.turnCompact.get(sid)?.phase }));

// The budget-exhausted route currently bypasses the missing-obligation check.
configure({ turnEndPull: 0, hardMaintenanceGate: true });
const bypass = newState();
bypass.turnObligation.set(sid, { wrote: false, triaged: false });
let bypassCalls = 0;
const bypassResult = await runMidTurnCompact(ctx, bypass, agent, { ...deps, runTurnCompact: async () => { bypassCalls++; return { compacted: true }; } });
check('CONTRACT missing obligations + exhausted pull budget must not silently compact', bypassCalls === 0, JSON.stringify({ bypassCalls, bypassResult }));

// autoCompact and highFidelityCompact switches are not consulted by this entry.
for (const patch of [{ autoCompact: false }, { highFidelityCompact: false }]) {
  configure(patch);
  const s = newState(); s.turnObligation.set(sid, ready());
  let n = 0;
  const out = await runMidTurnCompact(ctx, s, agent, { ...deps, runTurnCompact: async () => { n++; return { compacted: true }; } });
  check('CONTRACT automatic master switch respected ' + JSON.stringify(patch), n === 0, JSON.stringify({ calls: n, out }));
}

// Await sequencing works in the reachable ready path (fake runner, not a live LLM).
configure();
const waitState = newState(); waitState.turnObligation.set(sid, ready());
let resolveRunner, finished = false;
const held = new Promise(r => { resolveRunner = r; });
const pending = runMidTurnCompact(ctx, waitState, agent, { ...deps, runTurnCompact: () => held }).then(r => { finished = true; return r; });
check('flow: state machine remains pending while runner is pending', !finished && waitState.turnCompact.get(sid)?.phase === 'pressing');
resolveRunner({ compacted: true });
const waited = await pending;
check('flow: resumes after runner completes', finished && waited.compacted === true && waitState.turnCompact.get(sid)?.phase === 'done');

// Real runner boundary, with a fake service: range selection and result classification.
const events = [
  { type: 'system/message', seq: 1, data: {} },
  { type: 'user/message', seq: 2, data: {} },
  { type: 'assistant/message', seq: 3, data: { message: { content: [] } } },
  { type: 'user/message', seq: 4, data: {} },
  { type: 'assistant/message', seq: 5, data: { message: { content: [] } } },
];
const session = { header: { id: sid, cwd: root }, surface: { nodes: events.map(e => e.seq) }, eventAt: seq => events.find(e => e.seq === seq), requestContext: () => ({ contextWindow: 1000 }) };
const meter = { measure: () => ({ totalTokens: 750, nodes: events.map(e => ({ seq: e.seq, tokens: e.seq === 1 ? 10 : 170 })) }) };
let regionCalls = 0;
const svc = { compactNow() {}, async compactRegion() { regionCalls++; return { shadowedTokenCount: 0, shadowedSeqs: [] }; } };
const rctx = { get: n => n === 'tokenMeter' ? meter : n === 'compaction' ? svc : undefined };
const result = await runTurnCompact(rctx, newState(), { session }, undefined, undefined);
check('runner: real range selection reaches fake compactRegion', regionCalls === 1, JSON.stringify(result));
check('observation: runner success flag is not a measured reduction verdict', result.compacted === true && result.after === result.before, JSON.stringify(result));
console.log('LIMITATION zero-change service above is synthetic; it does not prove the real kernel can return that result.');

// An attempt result is not emitted immediately: reason only appears on a later gate pass.
configure();
const failedState = newState(); failedState.turnObligation.set(sid, ready());
const logStart = logs.length;
const failed = await runMidTurnCompact(ctx, failedState, agent, { ...deps, runTurnCompact: async () => ({ compacted: false, reason: 'diagnosis-sentinel-error' }) });
check('CONTRACT attempt failure reason must be observable before another step', logs.slice(logStart).some(s => s.includes('diagnosis-sentinel-error')), JSON.stringify(failed));
await runMidTurnCompact(ctx, failedState, agent, deps);
check('observation: failure reason does appear on the next gate pass', logs.slice(logStart).some(s => s.includes('diagnosis-sentinel-error')));
const notice = renderPressureNotice({ projectRoot: root, activeRel: 'LEDGER.md' }, { ratio: 0.75, total: 750, window: 1000 }, 0.7);
check('CONTRACT mid-turn mode must not instruct the model to await turn end', !notice.includes('本回合结束之后'));

// Aggregate both existing diagnostic locations, no session files are read by this tool.
const logRows = [];
for (const rel of ['.dsh-ledger-midturn.log', path.join('10.项目台账-ledger-memory', '.dsh-ledger-midturn.log')]) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log('MISSING diagnostic ' + rel); continue; }
  const rows = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  console.log('DIAGNOSTIC ' + JSON.stringify({ rel, sha256: hash(p), rows: rows.length }));
  logRows.push(...rows);
}
const distribution = {};
for (const row of logRows) { const m = row.match(/act=(\S+) why=(\S+)/); if (m) { const k = m[1] + '/' + m[2]; distribution[k] = (distribution[k] ?? 0) + 1; } }
console.log('OBSERVED_LOGS ' + JSON.stringify({ rows: logRows.length, distribution, readyButWaiting: logRows.filter(r => /gapsOk=true/.test(r) && /why=awaiting-owed/.test(r)).length }));
check('production JS files remain byte-identical', Object.entries(before).every(([n,h]) => hash(path.join(ROOT, 'lib', n)) === h));
console.log('FIXTURE ' + fixture);
console.log(`SUMMARY PASS ${pass} FAIL ${fail} (FAIL means an unmet contract; no product changes)`);
process.exitCode = fail ? 1 : 0;
