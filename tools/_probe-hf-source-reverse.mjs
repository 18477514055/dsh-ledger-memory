/**
 * ★★★ 反向验证（纪律第 10 条）：**摘掉修复，必须看得见红**。
 *
 * 被验对象：情形 48（并发压缩来源互相覆盖）。
 * 做法：把 `lib/index.js` 里 `pushHfSource` / `popHfSource` 的**函数体**换回旧的单槽写法，
 *       跑一次自检，确认情形 48 变红；然后**逐字节还原**并核对 sha256。
 *
 * ★ 为什么必须换函数体、而不是删调用：换函数体保留调用点，只改语义 ⇒
 *   红的只可能是"语义"这一层，不会因为"某处没被调用"而红了另一个理由。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(ROOT, "lib", "index.js");
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

const original = fs.readFileSync(LIB);
const H0 = sha(original);
console.log(`原文件 sha256(前16) = ${H0}`);
fs.writeFileSync(path.join(process.env.TEMP ?? ".", "index.js.pristine"), original);

let src = original.toString("utf8");

// ① 单槽 push：直接 set，后写覆盖先写
const pushNew = src.indexOf("function pushHfSource(state, sid, source) {");
const pushEnd = src.indexOf("\n}", pushNew);
if (pushNew === -1 || pushEnd === -1) throw new Error("找不到 pushHfSource");
const pushOld = `function pushHfSource(state, sid, source) {
  try {
    state.hfSource.set(String(sid), source === undefined ? "auto" : source);
  } catch {}
}`;
src = src.slice(0, pushNew) + pushOld + src.slice(pushEnd + 2);

// ② 单槽 pop：get + delete 整键（旧写法）
const popNew = src.indexOf("function popHfSource(state, sid) {");
const popEnd = src.indexOf("\n}", popNew);
if (popNew === -1 || popEnd === -1) throw new Error("找不到 popHfSource");
const popOld = `function popHfSource(state, sid) {
  try {
    const src = state.hfSource.get(String(sid));
    state.hfSource.delete(String(sid));
    return src;
  } catch {
    return undefined;
  }
}`;
src = src.slice(0, popNew) + popOld + src.slice(popEnd + 2);

if (src === original.toString("utf8")) throw new Error("替换没生效 —— 后面看到的绿是假的");
fs.writeFileSync(LIB, src, "utf8");
console.log(`已换成单槽写法，sha256(前16) = ${sha(fs.readFileSync(LIB))}\n`);

let out = "";
let code = 0;
try {
  out = execFileSync(process.execPath, [path.join(ROOT, "tools", "selftest.mjs")], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  code = e.status ?? 1;
  out = String(e.stdout ?? "") + String(e.stderr ?? "");
}

fs.writeFileSync(LIB, original); // ★ 无论成败都还原
const H1 = sha(fs.readFileSync(LIB));
console.log(`已还原，sha256(前16) = ${H1}  ${H1 === H0 ? "✅ 逐字节一致" : "❌ 不一致！"}`);

const total = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
const case48 = out.split("情形 48")[1]?.split("情形 36")[0] ?? "";
const fails = [...case48.matchAll(/^\s+FAIL\s+(.+)$/gm)].map((m) => m[1].trim());

console.log(`\n自检退出码 = ${code}`);
console.log(`汇总：${total === null ? "（没读到汇总行！）" : `通过 ${total[1]}，失败 ${total[2]}`}`);
console.log(`\n情形 48 里的 FAIL（摘掉修复后应当出现）：`);
if (fails.length === 0) console.log("  ★★★ 一条红都没有 —— 断言太弱，修复不成立！");
else for (const f of fails) console.log(`  · ${f}`);

// ★ 判据：至少要有 2 条红（48a 的"自动 70%"与 48b 的"不许认领作废票"）
const pass = fails.length >= 2 && H1 === H0;
console.log(`\n${pass ? "✅ 反向验证通过（摘掉修复后确实变红，且文件已逐字节还原）" : "❌ 反向验证未通过"}`);
process.exit(pass ? 0 : 1);
