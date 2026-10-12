/**
 * ★★★ 反向验证（纪律第 10 条）：把 D61 的修复摘掉，42d 必须变红。
 * 摘法：把 `live === undefined` 时"建一条"那段改回 `return 0`。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LIB = path.join(ROOT, "lib", "index.js");
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

const original = fs.readFileSync(LIB);
const H0 = sha(original);
console.log(`原文件 sha256(前16) = ${H0}`);

// ★ 用**最小且语法安全**的摘法：在 `let live = capsule.get(sid);` 之前插一句
//   `if (capsule.get(sid) === undefined) return 0;` —— 即恢复旧行为
//   （"内存没有就整段放弃"），而**不动**下面任何结构。
const NEEDLE = `    let live = capsule.get(sid);`;
if (!original.toString("utf8").includes(NEEDLE)) throw new Error("找不到那段 —— 先 read 确认");
let src = original.toString("utf8");
src = src.replace(
  NEEDLE,
  `    // ← 反向验证：恢复旧行为（内存没有就整段放弃 = D61 的病）
    if (capsule.get(sid) === undefined) return 0;
    let live = capsule.get(sid);`
);

if (src === original.toString("utf8")) throw new Error("替换没生效");
fs.writeFileSync(LIB, src, "utf8");
console.log(`已摘掉 D61 修复，sha256(前16) = ${sha(fs.readFileSync(LIB))}\n`);

let out = "", code = 0;
try {
  out = execFileSync(process.execPath, [path.join(ROOT, "tools", "selftest.mjs")], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  code = e.status ?? 1;
  out = String(e.stdout ?? "") + String(e.stderr ?? "");
}

fs.writeFileSync(LIB, original);
const H1 = sha(fs.readFileSync(LIB));
console.log(`已还原，sha256(前16) = ${H1}  ${H1 === H0 ? "✅ 逐字节一致" : "❌ 不一致！"}`);

const total = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
const fails = [...out.matchAll(/^\s+FAIL\s+(.+)$/gm)].map((m) => m[1].trim());
console.log(`\n自检退出码 = ${code}`);
console.log(`汇总：${total === null ? "（没读到汇总行）" : `通过 ${total[1]}，失败 ${total[2]}`}`);
console.log(`\n摘掉后出现的 FAIL：`);
if (fails.length === 0) console.log("  ★★★ 一条红都没有 —— 断言太弱！");
else for (const f of fails) console.log(`  · ${f.slice(0, 120)}`);

const hit = fails.some((f) => f.includes("42d"));
const pass = hit && H1 === H0;
console.log(`\n${pass ? "✅ 反向验证通过（42d 变红 = D61 的病真的被抓住了）" : "❌ 反向验证未通过"}`);
process.exit(pass ? 0 : 1);
