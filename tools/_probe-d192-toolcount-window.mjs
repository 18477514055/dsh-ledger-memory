/**
 * ★★★★★ 只读诊断（D192 附带）：**自检里那条"工具数"口径为什么数不到 19？**
 *
 * 现象：`run.registeredTools.size === 19`（真注册数，走的注册表），
 *   而自检 `情形 43` 那条用**正则扫源码**数出来的是 **18** ⇒ 两条口径打架。
 *
 * ★ 怀疑：那条正则只扫 `regStart` 之后**固定 4000 字符**的窗口，
 *   而列表随 D191/D192 变长 ⇒ 最后那条被窗口截掉。
 * ★★ 这正是本项目那句"**判据要能吃被测对象的全部**"——
 *   窗口是写死的，列表是会长的 ⇒ **迟早截断**（今天截到了）。
 *
 * 只读。跑法：node tools/_probe-d192-toolcount-window.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

const regStart = src.indexOf("for (const [label, factory] of [");
console.log(`注册表起点偏移：${regStart}`);

const win = src.slice(regStart, regStart + 4000);
const inWin = [...win.matchAll(/\["(ledger_[a-z_]+)"/g)].map((m) => m[1]);
console.log(`\n① 固定 4000 字符窗口内数到：${inWin.length} 个`);
for (const n of inWin) console.log(`   · ${n}`);

// 完整列表：从起点到 `]) {` 收尾
const end = src.indexOf("]) {", regStart);
const full = src.slice(regStart, end);
const all = [...full.matchAll(/\["(ledger_[a-z_]+)"/g)].map((m) => m[1]);
console.log(`\n② 从起点到 \`]) {\`（真实边界，偏移 ${end}）数到：${all.length} 个`);
for (const n of all) console.log(`   · ${n}`);

const missing = all.filter((n) => !inWin.includes(n));
console.log(`\n③ ★ 被 4000 窗口截掉的：${missing.length} 个 → ${missing.join(", ")}`);
console.log(`   ★ 注册表实际长度：${end - regStart} 字符（> 4000 ⇒ 必然截断）`);

const hasCp = /"ledger_checkpoint"/.test(src);
console.log(`\n④ 加上 ledger_checkpoint（单独判断）：${all.length + (hasCp ? 1 : 0)}`);
console.log(`   ★ 真注册数（注册表 size）= 19 ⇒ 应当与它一致。`);
