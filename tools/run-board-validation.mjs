// Reproducible validation entrypoint: keep full stdout/stderr, report failures without hiding them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const project = path.resolve(import.meta.dirname,'..');
const output = fs.mkdtempSync(path.join(project,'docs','board-validation-'));
const suites = [
  ['syntax-client',['--check','lib/client.js']],
  ['syntax-board-model',['--check','lib/board-model.js']],
  ['syntax-board-http',['--check','lib/board-http.js']],
  ['syntax-tools',['--check','lib/part4.js']],
  ['board-backend',['tools/board-backend.test.mjs']],
  ['board-tool-parity',['tools/board-tool-parity.test.mjs']],
  ['core-boundaries',['tools/board-core-boundaries.test.mjs']],
  ['board-shutdown',['tools/board-shutdown.test.mjs']],
  ['board-selector',['tools/board-client-contract.test.mjs']],
  ['board-mutation',['tools/board-mutation.test.mjs']],
  ['kind-mapping',['tools/_probe-d386-board-read.mjs']],
  ['recent-roots',['tools/_probe-d388-follow-recent.mjs']],
  ['persisted-roots',['tools/_probe-d389-board-roots-store.mjs']],
  ['selftest',['tools/selftest.mjs']],
];
let failures = 0;
const results = [];
for (const [name,args] of suites) {
  const start = performance.now();
  const result = spawnSync(process.execPath,args,{cwd:project,encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024});
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  fs.writeFileSync(path.join(output,name+'.stdout.log'),stdout,'utf8');
  fs.writeFileSync(path.join(output,name+'.stderr.log'),stderr,'utf8');
  const ok = result.status === 0 && !result.error;
  if (!ok) failures++;
  const item = {name,ok,status:result.status,signal:result.signal,durationMs:Math.round(performance.now()-start),stderrBytes:Buffer.byteLength(stderr),error:result.error?.message ?? null};
  results.push(item);
  console.log(JSON.stringify(item));
  const summary = stdout.split(/\r?\n/).filter(line=>/合计|COMPLETE|FAIL|SKIP|not ok|^BOARD |^CORE |^# (?:tests|pass|fail|skipped)/.test(line));
  console.log(summary.slice(-25).join('\n'));
  if (stderr) console.error(stderr);
}
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({results,failures},null,2)+'\n','utf8');
console.log('VALIDATION-COMPLETE failures='+failures+' evidence='+output);
process.exitCode = failures ? 1 : 0;
