// Mutation verification is confined to a new owned directory; production source is never modified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const project = path.resolve(import.meta.dirname, '..');
const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-board-mutation-'));
const modelName = 'board-model.js';
const originalFile = path.join(project,'lib',modelName);
const originalBytes = fs.readFileSync(originalFile);
try {
  fs.mkdirSync(path.join(clone,'lib'));
  fs.mkdirSync(path.join(clone,'tools'));
  // Enumerate one bounded directory, do not recursively follow junctions or copy user memory.
  for (const entry of fs.readdirSync(path.join(project,'lib'),{withFileTypes:true})) {
    if (entry.isSymbolicLink()) throw new Error('Refuse linked source entry: '+entry.name);
    if (entry.isFile() && entry.name.endsWith('.js')) fs.copyFileSync(path.join(project,'lib',entry.name),path.join(clone,'lib',entry.name));
  }
  fs.copyFileSync(path.join(project,'package.json'),path.join(clone,'package.json'));
  fs.copyFileSync(path.join(project,'tools','board-tool-parity.test.mjs'),path.join(clone,'tools','board-tool-parity.test.mjs'));
  const run = () => spawnSync(process.execPath,['tools/board-tool-parity.test.mjs'],{cwd:clone,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  const baseline = run();
  assert.equal(baseline.status,0,baseline.stderr);
  assert.match(baseline.stdout,/TOOL-PARITY-COMPLETE checks=13/);
  console.log('PASS isolated baseline reached completion');
  const file = path.join(clone,'lib',modelName);
  const before = fs.readFileSync(file,'utf8');
  const needle = 'if (args.ifMatch !== s.etag)';
  assert.equal(before.split(needle).length-1,1,'Mutation target must be unique');
  fs.writeFileSync(file,before.replace(needle,'if (false)'), 'utf8');
  const mutant = run();
  assert.equal(mutant.status,1,mutant.stderr);
  assert.match(mutant.stderr,/ASSERTION-FAIL stale tool replay refuses without overwrite/);
  console.log('PASS removing stale-content CAS causes the exact stale-replay assertion to fail');
  fs.writeFileSync(file,before,'utf8');
  const restored = run();
  assert.equal(restored.status,0,restored.stderr);
  assert.match(restored.stdout,/TOOL-PARITY-COMPLETE checks=13/);
  assert.deepEqual(fs.readFileSync(originalFile),originalBytes,'Production source changed unexpectedly');
  console.log('PASS restoring isolated source returns to passing; production bytes unchanged');
  console.log('MUTATION-COMPLETE checks=3');
} finally {
  assert.ok(path.basename(clone).startsWith('ledger-board-mutation-'));
  fs.rmSync(clone,{recursive:true,force:true});
}
