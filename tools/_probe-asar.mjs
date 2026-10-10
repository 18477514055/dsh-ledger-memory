/**
 * 探针：从 app.asar 里**只读**取文件列表，并按关键词筛出候选文件。
 *
 * ★ 为什么不能直接 `readFileSync(asar)`：121 MB，整份读进内存又慢又占上下文。
 *   asar 格式：前 4 字节是 pickle 长度，接着是 header（JSON），data 区在
 *   `8 + headerPickleLen` 处。用括号配平从第 16 字节起把 JSON 抠出来。
 *
 * 用法：node tools/_probe-asar.mjs <关键词> [关键词...]
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ASAR = (process.env.DSH_ASAR ?? path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "app.asar"));

const fd = fs.openSync(ASAR, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPickleLen = head.readUInt32LE(12);
const jsonLen = head.readUInt32LE(4);

const raw = Buffer.alloc(headerPickleLen);
fs.readSync(fd, raw, 0, headerPickleLen, 16);

// 从第一个 `{` 起做括号配平（跳过字符串里的括号）。
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
if (end < 0) throw new Error("没找到 header JSON 的结尾");
const header = JSON.parse(raw.subarray(start, end).toString("utf8"));
fs.closeSync(fd);

const dataStart = 8 + headerPickleLen;
const files = [];
(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files ?? {})) {
    const p = prefix === "" ? name : `${prefix}/${name}`;
    if (v.files !== undefined) walk(v, p);
    else files.push({ path: p, size: v.size ?? 0, offset: v.offset });
  }
})(header, "");

const kws = process.argv.slice(2).map((s) => s.toLowerCase());
if (kws.length === 0) {
  console.log(`headerPickleLen=${headerPickleLen} dataStart=${dataStart} files=${files.length}`);
  console.log("（没给关键词，只打印统计）");
} else {
  for (const f of files) {
    const low = f.path.toLowerCase();
    if (kws.some((k) => low.includes(k))) {
      console.log(`${String(f.size).padStart(10)}  off=${String(f.offset).padStart(10)}  ${f.path}`);
    }
  }
}

/** 导出给别的探针用（本文件被 import 时）。 */
export { files, dataStart, ASAR };
