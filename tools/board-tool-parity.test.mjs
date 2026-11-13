// Exercise the actual tool definitions and the board service on owned temporary files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-board-tool-'));
process.env.DSH_HOME = home;
const { defineReadTool, defineWriteTool } = await import('../lib/part4.js');
const { boardRead, boardPreview } = await import('../lib/board-model.js');
const state = {ledgerTouched:new Map(), flushedAt:new Map()};
const read = defineReadTool();
const write = defineWriteTool(state);
let checks = 0;
function check(label, fn) {
  try { fn(); checks++; console.log('PASS ' + label); }
  catch (error) { if (error?.code === 'ERR_ASSERTION') console.error('ASSERTION-FAIL ' + label); throw error; }
}
try {
  const root = path.join(home, 'project');
  const base = path.join(root, 'memory');
  fs.mkdirSync(path.join(base, 'decisions'), {recursive:true});
  fs.mkdirSync(path.join(base, 'goals'));
  fs.mkdirSync(path.join(base, 'lessons'));
  fs.writeFileSync(path.join(root, '.dsh-ledger.json'), JSON.stringify({memoryRoot:'memory',active:'LEDGER.md',decisionsDir:'decisions',goalsDir:'goals',lessonsDir:'lessons',principles:'PRINCIPLES.md',journal:'JOURNAL.md',archiveDir:'archive',revision:1,autoGitAdd:false,maxActiveLines:400}));
  fs.writeFileSync(path.join(base, 'LEDGER.md'), '# Ledger\n\n## First\nkeep\n\n## Second\nuntouched\n');
  fs.writeFileSync(path.join(base, 'PRINCIPLES.md'), '# Principles\nprotected\n');
  fs.writeFileSync(path.join(base, 'JOURNAL.md'), '# Journal\nold history\n');
  fs.writeFileSync(path.join(base, 'decisions', 'D1.md'), '## D1 · Original\n\nOriginal body\n');
  fs.writeFileSync(path.join(base, 'goals', 'g1.md'), '## 目标 g1 · root\n- parent: -\n- title: Original goal\n- 关键结果: keep\n\nUnknown prose must stay.\n');
  fs.writeFileSync(path.join(base, 'lessons', 'L1.md'), '## 教训 L1 · 其他\n- 标题: Original lesson\n- 根因: initial cause\n- 自定义: keep me\n');
  const exec = {agent:{session:{header:{id:'board-parity',cwd:root}}}};
  const loaded = await read.execute({target:'decisions',entry:'D1',editable:true}, exec);
  const fromBoard = boardRead(root,'decisions','D1');
  check('tool and board share exact text, fields and etag', () => {
    assert.equal(loaded.ok,true); assert.equal(loaded.text,fromBoard.text);
    assert.equal(loaded.etag,fromBoard.etag); assert.deepEqual(loaded.editor,fromBoard.editor);
  });
  check('editable result respects the registered output schema', () => {
    assert.equal(read.output.schema.properties.reason.type,'string');
    assert.ok(!Object.hasOwn(loaded,'reason') || typeof loaded.reason === 'string');
  });
  const fields = {title:'Changed',body:'Edited through shared operation\n'};
  const input = {target:'decisions',entry:'D1',mode:'replace',fields,ifMatch:loaded.etag};
  const diskBefore = fs.readFileSync(path.join(base,'decisions','D1.md'),'utf8');
  const preview = await write.execute({...input,preview:true},exec);
  check('tool preview equals board preview and writes nothing', () => {
    assert.deepEqual(preview,boardPreview(root,{...input,kind:'decisions'}));
    assert.equal(fs.readFileSync(path.join(base,'decisions','D1.md'),'utf8'),diskBefore);
    assert.equal(state.flushedAt.size,0);
  });
  const saved = await write.execute(input, exec);
  check('tool save commits shared formatted content', () => {
    assert.equal(saved.ok,true,JSON.stringify(saved));
    assert.equal(boardRead(root,'decisions','D1').text,preview.text);
    assert.equal(state.flushedAt.has('board-parity'),true);
  });
  const replay = await write.execute(input,exec);
  check('stale tool replay refuses without overwrite',()=>{assert.equal(replay.ok,false);assert.equal(replay.status,409);});
  const principle = await read.execute({target:'principles',editable:true},exec);
  const rejected = await write.execute({target:'principles',mode:'replace',ifMatch:principle.etag,content:'overwrite'},exec);
  check('editor tool cannot grant principle authority',()=>{assert.equal(rejected.ok,false);assert.equal(fs.readFileSync(path.join(base,'PRINCIPLES.md'),'utf8'),'# Principles\nprotected\n');});
  const journal = await read.execute({target:'journal',editable:true},exec);
  const journalReplace = await write.execute({target:'journal',mode:'replace',ifMatch:journal.etag,content:'replace old'},exec);
  check('editor journal replacement refuses rather than duplicating full text',()=>assert.equal(journalReplace.ok,false));
  const appended = await write.execute({target:'journal',mode:'append',ifMatch:journal.etag,content:'new history'},exec);
  check('editor journal append works once',()=>{assert.equal(appended.ok,true);assert.equal(fs.readFileSync(path.join(base,'JOURNAL.md'),'utf8').split('old history').length-1,1);});
  for (const [target,entry] of [['goals','g1'],['lessons','L1']]) {
    const snapshot = await read.execute({target,entry,editable:true},exec);
    const changed = await write.execute({target,entry,mode:'replace',ifMatch:snapshot.etag,fields:{...snapshot.editor.fields,title:'Updated via tool'}},exec);
    check(target+' editable via shared service preserves extra prose',()=>{
      assert.equal(changed.ok,true,JSON.stringify(changed));
      assert.equal(boardRead(root,target,entry).editor.fields.title,'Updated via tool');
      assert.match(fs.readFileSync(path.join(base,target,entry+'.md'),'utf8'),target==='goals'?/Unknown prose must stay/:/keep me/);
    });
  }
  const noToken = await write.execute({target:'lessons',content:'bad'},exec);
  check('new targets do not fall through legacy writer without CAS',()=>assert.equal(noToken.ok,false));
  const legacy = await write.execute({target:'active',mode:'append',content:'legacy append still works'},exec);
  check('legacy writing remains backward compatible',()=>assert.equal(legacy.ok,true));
  check('schema exposes editor fields but not forged authority',()=>{
    assert.ok(read.parameters.properties.editable); assert.ok(write.parameters.properties.ifMatch);
    assert.equal(write.parameters.properties.authorizedBy,undefined);
  });
  console.log(`TOOL-PARITY-COMPLETE checks=${checks}`);
} finally {
  assert.ok(path.basename(home).startsWith('ledger-board-tool-'));
  fs.rmSync(home,{recursive:true,force:true});
}
