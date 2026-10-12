/**
 * ★★★ 判定：剩下 8 条红，是 D119 的**语义连带**，还是我改坏了？
 *
 * ★ 方法（比猜可靠）：把 D119 的**让路改动**退回原样（`&& !hfQueued`），
 *   其余 D119 改动保留 ⇒ 跑一遍。
 *   · 若那几条**转绿** ⇒ 它们红的成因**确实是"让路判据变了"** ⇒ 是语义连带，不是 bug。
 *   · 若仍红 ⇒ 另有成因，必须继续查。
 *
 * ★ 为什么只退让路、不退闸门：这两处改动**承重不同**，要分开归因。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PLUGIN = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const LIB = path.join(PLUGIN, "lib", "index.js");
const SELFTEST = path.join(PLUGIN, "tools", "selftest.mjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const original = fs.readFileSync(LIB);
const origSha = sha(original);
fs.writeFileSync(path.join(os.tmpdir(), "d119-attrib-lib.js"), original);
console.log(`⓪ 备份 sha256=${origSha.slice(0, 16)}…`);

let s = original.toString("utf8");
// 把让路判据退回"看队列"（= D119 之前）
const NEEDLE = "    if (pressure.ratio >= hfLine && oursDone !== true) {";
const n = s.split(NEEDLE).length - 1;
console.log(`① 让路判据摘点命中 ${n} 次（应为 1）`);
if (n !== 1) {
  console.log("★ 定位失败 ⇒ 退出");
  process.exit(1);
}
s = s.replace(NEEDLE, "    if (pressure.ratio >= hfLine && oursDone !== true && !state.hfCompactAfterTurn.get(key)) {");
fs.writeFileSync(LIB, s);
console.log(`   已写入"退回看队列"版 sha256=${sha(fs.readFileSync(LIB)).slice(0, 16)}…`);

console.log(`\n=========== 自检（让路退回"看队列"之后）===========`);
let out = "";
try {
  out = execFileSync(process.execPath, [SELFTEST], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
}
const lines = out.split("\n");
const red = lines.filter((l) => /^\s*FAIL/.test(l));
console.log(`--- 红：${red.length} 条 ---`);
for (const r of red.slice(0, 16)) console.log("   " + r.trim().slice(0, 150));
for (const x of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + x.trim());
fs.writeFileSync(path.join(os.tmpdir(), "d119-attrib-out.txt"), out);

fs.writeFileSync(LIB, original);
const restored = sha(fs.readFileSync(LIB));
console.log(`\n④ 已还原。sha256=${restored.slice(0, 16)}… ${restored === origSha ? "★ 逐字节一致 ✅" : "★★★ 不一致 ❌"}`);
console.log(
  red.length < 8
    ? `\n⇒ ★ 结论：退回让路判据后**红数从 8 降到 ${red.length}** ⇒ 差额那些是**让路语义的连带**（预期内）`
    : `\n⇒ ★★ 结论：仍是 ${red.length} 条 ⇒ 它们**不是**让路引起的，另有成因，必须继续查`
);
