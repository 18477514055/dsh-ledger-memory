/**
 * 探针：从 app.asar 里**只读**导出指定文件到 stdout（或一个临时文件）。
 *
 * 用法：node tools/_probe-asar-read.mjs <asar内路径> [--out <本机路径>]
 *
 * ★ 只读 asar，不写 asar。`--out` 写的是**你自己指定的**临时路径。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ASAR = (process.env.DSH_ASAR ?? path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "app.asar"));
const want = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx > 0 ? process.argv[outIdx + 1] : undefined;
if (want === undefined) throw new Error("用法：node tools/_probe-asar-read.mjs <asar内路径> [--out <路径>]");

const fd = fs.openSync(ASAR, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPickleLen = head.readUInt32LE(12);
const raw = Buffer.alloc(headerPickleLen);
fs.readSync(fd, raw, 0, headerPickleLen, 16);

let start = raw.indexOf(0x7b);
let depth = 0;
let inStr = false;
let esc = false;
let end = -1;
for (let i = start; i < raw.length; i++) {
  const c = raw[i];
  if (inStr) {
    if (esc) esc = false;
    else if (c === 0x5c) esc = true;
    else if (c === 0x22) inStr = false;
    continue;
  }
  if (c === 0x22) inStr = true;
  else if (c === 0x7b) depth++;
  else if (c === 0x7d) {
    depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
const header = JSON.parse(raw.subarray(start, end).toString("utf8"));
const dataStart = 8 + headerPickleLen;

let node = header;
for (const seg of want.split("/")) {
  if (node.files === undefined || node.files[seg] === undefined) {
    fs.closeSync(fd);
    throw new Error(`asar 里没有这个路径：${want}（在 "${seg}" 处断了）`);
  }
  node = node.files[seg];
}
if (node.files !== undefined) {
  fs.closeSync(fd);
  throw new Error(`${want} 是个目录，不是文件`);
}

const buf = Buffer.alloc(node.size);
fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
fs.closeSync(fd);

if (outPath === undefined) {
  process.stdout.write(buf);
} else {
  fs.writeFileSync(outPath, buf);
  console.log(`写出 ${buf.length} 字节 → ${outPath}`);
}
