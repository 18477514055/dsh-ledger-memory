// Tests only the pure session selector, not React, DOM, rendering or GUI behavior.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
const matched = /function boardCurrentSession\(snapshot\) \{[\s\S]*?\n    \}/.exec(source);
assert.ok(matched,'Pure selector must be discoverable');
const select = vm.runInNewContext('(' + matched[0] + ')');
const snapshot = {byId:{
  background:{id:'background',updatedAt:99999,retainedBy:{agent:1}},
  selected:{id:'selected',updatedAt:1,retainedBy:{mainView:1}},
}};
const before = JSON.stringify(snapshot);
assert.equal(select(snapshot),'selected');
assert.equal(JSON.stringify(snapshot),before);
assert.equal(select({byId:{}}),undefined);
assert.equal(select(undefined),undefined);
assert.equal(select({byId:{a:{id:'a',retainedBy:{mainView:1}},b:{id:'b',retainedBy:{mainView:1}}}}),undefined);
assert.equal(select({byId:{a:{id:'a',retainedBy:{mainView:0}},b:{id:'b',retainedBy:{mainView:2}}}}),'b');
console.log('CLIENT-SELECTOR-COMPLETE checks=6 (pure selector only; GUI not tested)');
