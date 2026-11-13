// Verify final flush does not schedule writes after plugin disposal; owned fixture only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const home = fs.mkdtempSync(path.join(os.tmpdir(),'ledger-board-shutdown-'));
process.env.DSH_HOME = home;
const board = await import('../lib/board-http.js');
const timer = globalThis.setTimeout;
try {
  const root = path.join(home,'project'); fs.mkdirSync(root);
  board.rememberSessionRoot('shutdown-fixture',root);
  const store = board.boardRootsStorePath();
  assert.ok(store.startsWith(home+path.sep));
  assert.equal(fs.lstatSync(store).isFile(),true);
  fs.unlinkSync(store); fs.mkdirSync(store); // exact owned store path becomes an unwritable file target
  board.rememberSessionRoot('shutdown-fixture-2',root);
  let scheduled = 0;
  globalThis.setTimeout = (...args) => { scheduled++; return timer(...args); };
  const result = board.flushBoardRootsStore({retry:false});
  assert.equal(result.ok,false);
  assert.equal(scheduled,0);
  assert.equal(board.boardRootsPersistenceStatus().dirty,true);
  assert.equal(typeof board.boardRootsPersistenceStatus().error,'string');
  console.log('SHUTDOWN-COMPLETE checks=6');
} finally {
  globalThis.setTimeout = timer;
  board.flushBoardRootsStore({retry:false});
  assert.ok(path.basename(home).startsWith('ledger-board-shutdown-'));
  fs.rmSync(home,{recursive:true,force:true});
}
