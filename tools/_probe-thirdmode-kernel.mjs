/**
 * ★★★ 只读：模式③「每轮独立对话」的**可行性闸门**。
 *
 * 用户的原话（逐字，2026-10-11 17:26 之后）：
 *   *"相当于把一个模型的每一次交流全部变成一个独立的对话模型，永远只需要读工具定义
 *    用来缓存命中的提示词。以及一个我们留下的指针，剩下的全部放到外置。"*
 *
 * 要建这个模式，必须先回答一个**内核能不能做到**的问题：
 *   **我们有没有办法把「上一轮的 assistant 文本」从上下文里拿掉？**
 *   （工具结果占 27%，但 assistant 占 63.7% —— 后者才是关键。）
 *
 * 本探针只做一件事：把 asar 里与 compaction / prune / surface 有关的源码抽出来，
 * 好让 grep 去查「移除面」的接口到底支持哪些事件类型。**不判断，只搬运。**
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ASAR = "C:\\Users\\24239\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const OUT = path.join(os.tmpdir(), "dsh-asar-prune");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fd = fs.openSync(ASAR, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
const header = JSON.parse(jb.toString("utf8"));
const BASE = 16 + jsonLen;

const files = [];
const walk = (node, p) => {
  for (const [k, v] of Object.entries(node.files || {})) {
    const q = p + "/" + k;
    if (v.files) walk(v, q);
    else files.push({ p: q, off: Number(v.offset), size: v.size, link: v.link });
  }
};
walk(header, "");

console.log(`asar 条目总数 = ${files.length}   JSON 长度 = ${jsonLen}   BASE = ${BASE}`);

// ★ 只抽与「移除/裁剪/压缩/surface/配对」有关的，避免整包物化
const RE = /compaction|prune|tool-pairing|surface|token-meter|estimate/i;
const want = files.filter((f) => !f.link && RE.test(f.p) && /\.js$/.test(f.p));
console.log(`匹配到 ${want.length} 个 .js`);

let n = 0;
let bytes = 0;
for (const f of want) {
  const b = Buffer.alloc(f.size);
  fs.readSync(fd, b, 0, f.size, BASE + f.off);
  const dest = path.join(OUT, f.p.replace(/^\/+/, "").replace(/[:*?"<>|]/g, "_"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, b);
  bytes += f.size;
  n += 1;
}
fs.closeSync(fd);
console.log(`已抽出 ${n} 个文件 / ${(bytes / 1024).toFixed(0)} KB → ${OUT}`);
console.log("\n--- 抽出的文件（相对路径）---");
for (const f of want) console.log("  " + f.p);
