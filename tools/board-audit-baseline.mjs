// Read-only against plugin source; all writes and HTTP requests use owned temp fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-board-baseline-'));
process.env.DSH_HOME = home;
const board = await import('../lib/board-http.js');
const routes = new Map();
const scope = { get: name => name === 'connection' ? {requestRejection: () => undefined} : undefined,
  webServer: { register: ({path: url, handler}) => { routes.set(url, handler); return () => routes.delete(url); } } };
const installed = board.installBoardRoutes(scope, {});
assert.equal(installed.ok, true);
const server = http.createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
  if (handler) handler(req, res); else { res.writeHead(404); res.end(); }
});
const observations = [];
let prefix;
const call = async (query, body) => {
  const response = await fetch(prefix + query, body === undefined ? {} : {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
  return {status:response.status, value:await response.json()};
};
try {
  const root = path.join(home, 'project');
  const mem = path.join(root, 'memory');
  fs.mkdirSync(path.join(mem, 'decisions'), {recursive:true});
  fs.writeFileSync(path.join(root, '.dsh-ledger.json'), JSON.stringify({memoryRoot:'memory', active:'LEDGER.md', decisionsDir:'decisions', journal:'JOURNAL.md', archiveDir:'archive', revision:7, maxActiveLines:400, autoGitAdd:false}));
  fs.writeFileSync(path.join(mem, 'LEDGER.md'), '# Ledger\n\n## Current\nold\n');
  fs.writeFileSync(path.join(mem, 'decisions', 'D1.md'), '## D1 · Searchable title\nbody needle\n');
  fs.writeFileSync(path.join(mem, 'JOURNAL.md'), '# Journal\n\noriginal history\n');
  board.rememberSessionRoot('fixture', root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  prefix = `http://127.0.0.1:${server.address().port}/dsh-ledger-memory-board`;
  const base = await call('/board.json?root=' + encodeURIComponent(root));
  observations.push({check:'V3 inventory should list D1', status:base.status, actual:base.value.rows?.find(r=>r.kind==='decisions')});
  observations.push({check:'revision should be 7', actual:base.value.revision});
  const unknown = await call('/board.json?sid=never-registered');
  observations.push({check:'unknown sid must not silently follow another project', status:unknown.status, actualRoot:unknown.value.root, followed:unknown.value.followed});
  const missing = await call('/board-file.json?root=' + encodeURIComponent(root) + '&kind=decisions&entry=D999');
  observations.push({check:'missing card must not look like successfully read empty text', ...missing});
  const stale = await call('/board.json', {root,kind:'active',mode:'replace',content:'# Ledger\n\n## Current\nstale overwrote\n',ifRevision:0});
  observations.push({check:'save without content CAS must be rejected', status:stale.status, actual:stale.value.ok, overwritten:fs.readFileSync(path.join(mem,'LEDGER.md'),'utf8').includes('stale overwrote')});
  const journal = await call('/board.json', {root,kind:'journal',mode:'replace',content:'# Journal\n\noriginal history\n'});
  observations.push({check:'journal replace must reject instead of appending loaded full text', status:journal.status, copies:fs.readFileSync(path.join(mem,'JOURNAL.md'),'utf8').split('original history').length-1});
  console.log(JSON.stringify({observations}, null, 2));
  console.log('BASELINE-COMPLETE');
} finally {
  board.flushBoardRootsStore();
  installed.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // home is the exact unique directory created by this script, never a computed project path.
  assert.ok(path.basename(home).startsWith('ledger-board-baseline-'));
  fs.rmSync(home, {recursive:true, force:true});
}
