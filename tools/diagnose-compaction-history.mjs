#!/usr/bin/env node
// Explicitly selected historical session only. Read-only; no files are written.
// No fixed home or user identity. Pass --through-seq to freeze a historical window.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const input = args[0];
const i = args.indexOf('--through-seq');
const through = i < 0 ? Infinity : Number(args[i + 1]);
if (!input || (through !== Infinity && !Number.isSafeInteger(through))) throw new Error('Usage: node tools/diagnose-compaction-history.mjs <session.zstd> --through-seq <number>');
const bytes = fs.readFileSync(input);
const digest = b => createHash('sha256').update(b).digest('hex');
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
for (let at = bytes.indexOf(magic); at >= 0; at = bytes.indexOf(magic, at + 4)) starts.push(at);
if (starts[0] !== 0) throw new Error('FAILED: no admitted zstd stream at offset zero');
starts.push(bytes.length);
const chunks = [];
for (let k = 0; k < starts.length - 1; k++) {
  try { chunks.push(zlib.zstdDecompressSync(bytes.subarray(starts[k], starts[k + 1]))); }
  catch (e) { throw new Error(`FAILED: frame ${k} at byte ${starts[k]}: ${e.message}`); }
}
const raw = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch (e) { throw new Error(`FAILED JSON line ${index + 1}: ${e.message}`); }
});
const events = raw.filter(e => Number.isInteger(e.seq) && e.seq <= through);
if (!events.length) throw new Error('FAILED: no sequenced events in selected window');
for (let k = 1; k < events.length; k++) if (events[k].seq <= events[k - 1].seq) throw new Error('FAILED: non-increasing event sequence');
const selectedDigest = digest(events.map(e => JSON.stringify(e)).join('\n'));
const all = type => events.filter(e => e.type === type);
const cs = all('compaction/start'), ends = all('compaction/end'), sums = all('compaction/summary');
const messages = all('assistant/message'), used = messages.filter(e => e.data?.usage);
const users = all('user/message').filter(e => e.data?.source?.kind === 'user');
const steps = all('step/start');
const header = all('request/header');
const inputTokens = e => e?.data?.usage ? (e.data.usage.inputTokens ?? 0) + (e.data.usage.cacheReadTokens ?? 0) : null;
const withOutput = e => inputTokens(e) === null ? null : inputTokens(e) + (e.data.usage.outputTokens ?? 0);
const stepOf = e => {
  if (!e) return undefined;
  const d = e.data ?? {};
  return steps.findLast(s => s.seq < e.seq && (d.turn === undefined || s.data?.turn === d.turn) && (d.step === undefined || s.data?.step === d.step));
};
console.log('WINDOW ' + JSON.stringify({ throughSeq: through, lastSeq: events.at(-1).seq, lastTimeUtc: new Date(events.at(-1).time).toISOString(), selectedEvents: events.length, selectedSha256: selectedDigest, observedFileBytes: bytes.length, observedFileSha256: digest(bytes), frames: starts.length - 1, rawJsonLines: raw.length }));
let originalStylePass = 0, inTurn = 0, inTurnSummaries = 0, sameTurnContinues = 0;
const absent = [], lifecycle = [];
for (const s of cs) {
  const id = s.data?.compactionId;
  const end = ends.find(e => e.data?.compactionId === id);
  const sum = sums.find(e => e.data?.compactionId === id);
  const anchor = end ?? s;
  const a = messages.find(e => e.seq > anchor.seq);
  const u = users.find(e => e.seq > anchor.seq);
  const assistantFirst = !!a && (!u || a.seq < u.seq);
  const inside = typeof s.data?.turn === 'number';
  if (inside) inTurn++;
  if (inside && sum && assistantFirst) originalStylePass++;
  if (inside && sum) {
    inTurnSummaries++;
    if (assistantFirst && (a.data?.turn ?? stepOf(a)?.data?.turn) === s.data.turn) sameTurnContinues++;
  }
  if (!sum) absent.push({ startSeq: s.seq, endSeq: end?.seq ?? null, error: end?.data?.error ?? null, nextEvent: events.find(e => e.seq > s.seq)?.type });
  const previousTurnEnd = events.findLast(e => e.seq < s.seq && e.type === 'turn/end');
  lifecycle.push({ startSeq: s.seq, turn: s.data?.turn, previousType: events.findLast(e => e.seq < s.seq)?.type, previousTurnEndSeq: previousTurnEnd?.seq ?? null, previousTurn: previousTurnEnd?.data?.turn ?? null });
}
console.log('COUNTS ' + JSON.stringify({ starts: cs.length, ends: ends.length, summaries: sums.length, inTurn, idle: cs.length - inTurn, originalStylePass, inTurnSummaries, sameTurnContinues }));
console.log('NO_SUMMARY ' + JSON.stringify(absent));
console.log('IDLE_LIFECYCLE ' + JSON.stringify(lifecycle.filter(e => e.turn === null)));
const anomalies = [];
for (const s of sums) {
  const first = used.find(e => e.seq > s.seq);
  if (withOutput(first) === null || withOutput(first) < inputTokens(s) * 0.5) continue;
  const start = cs.find(e => e.data?.compactionId === s.data?.compactionId);
  const end = ends.find(e => e.data?.compactionId === s.data?.compactionId);
  if (!start || !end) throw new Error('FAILED anomaly lifecycle pair');
  const before = used.findLast(e => e.seq < start.seq);
  const afterFirst = used.find(e => e.seq > end.seq);
  const fresh = used.find(e => e.seq > end.seq && stepOf(e)?.seq > end.seq);
  const h = fresh ? header.find(e => e.seq > end.seq && e.seq < fresh.seq) : undefined;
  anomalies.push({ startSeq: start.seq, summarySeq: s.seq, endSeq: end.seq, summarizerInput: inputTokens(s), beforeAssistantSeq: before?.seq, beforeInput: inputTokens(before), firstAssistantSeq: afterFirst?.seq, firstStepStartSeq: stepOf(afterFirst)?.seq, firstInput: inputTokens(afterFirst), freshAssistantSeq: fresh?.seq, freshStepStartSeq: stepOf(fresh)?.seq, freshRequestHeaderSeq: h?.seq ?? null, freshInput: inputTokens(fresh), reductionPct: before && fresh ? Number(((inputTokens(before) - inputTokens(fresh)) / inputTokens(before) * 100).toFixed(2)) : null });
}
console.log('OLD_ANOMALY_CANDIDATES_CORRECTED ' + JSON.stringify(anomalies));
console.log('LIMITATIONS: observational input usage, not causal efficacy, not tokenMeter surface pressure; source attribution requires compactionId-bound evidence; fresh-step filter does not cover same-step overflow recovery.');
