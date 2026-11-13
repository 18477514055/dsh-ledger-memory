// Read-only smoke against an explicit project; no private text is printed or sent anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(process.argv[2] || process.cwd());
const home = fs.mkdtempSync(path.join(os.tmpdir(),'ledger-board-smoke-'));
process.env.DSH_HOME = home;
try {
  const {boardInventory,boardSearch} = await import('../lib/board-model.js');
  const started = performance.now();
  const inventory = boardInventory(root);
  console.log(JSON.stringify({operation:'inventory',durationMs:Math.round(performance.now()-started),layout:inventory.layout,revision:inventory.revision,
    rows:inventory.rows.map(row=>({kind:row.kind,count:row.count,unavailable:row.unavailable??false,reason:row.reason??null,badItems:row.items.filter(item=>item.ok===false).map(item=>({key:item.key,reason:item.reason}))}))},null,2));
  const startSearch = performance.now();
  const search = boardSearch(root,process.argv[3]||'D389',0,5);
  console.log(JSON.stringify({operation:'search',durationMs:Math.round(performance.now()-startSearch),total:search.total,returned:search.items.length,errors:search.errors},null,2));
  console.log('PROJECT-SMOKE-COMPLETE readOnly=true');
} finally {
  if (!path.basename(home).startsWith('ledger-board-smoke-')) throw new Error('Unexpected temp path');
  fs.rmSync(home,{recursive:true,force:true});
}
