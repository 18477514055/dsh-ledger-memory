/**
 * 探针：**官方会话文件到底在哪** —— 把编码规则从"我记得"变成"实测"。
 *
 * ★ 为什么必须实测（本机纪律「尺子先验」）：
 *   ① 索引要**指向官方的保存**，路径必须真能解析到，否则模型照抄读不到
 *     ⇒ 直接伤「准确性」与「可回溯」两条底线（与 D164/D165 同型）。
 *   ② 编码规则我是"推"出来的（非 ASCII ⇒ `~XXXX`），**没验过**。
 *
 * ★ 本探针 1 个前提都不假设：把 8 个真实目录名反解回路径，
 *   再正向编码本机若干真实 cwd，**看两边对不对得上**。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSIONS = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");

/**
 * 把 cwd 编成官方目录名。
 *
 * ★★★ 2026-10-13：**第一版算错，探针当场抓到**（本机纪律「尺子先验」的又一次兑现）。
 *   我原以为 `:` 与 `\` **都**换成 `-` ⇒ 产出 `D--Deepseek…`（两个连字符）；
 *   而真实目录名是 `--D-Deepseek~5DE5…--`（**一个**）。
 *   ⇒ 实测出来的真规则：**分隔符（`\` `/`）⇒ `-`；盘符的 `:` ⇒ 直接丢掉**；
 *     非 ASCII ⇒ `~XXXX`（大写十六进制，补充平面拆成两个代理项）；整串首尾各加 `--`。
 *   ★ 判别力：把 `stripColon` 关掉 ⇒ 本节下面的「正向 HIT」当场全 MISS。
 */
const stripColon = true;
function encodeCwd(cwd) {
  const BS = String.fromCharCode(92);
  let out = "";
  for (const ch of cwd) {
    if (stripColon && ch === ":") continue;
    if (ch === BS || ch === "/") {
      out += "-";
      continue;
    }
    const c = ch.codePointAt(0);
    if (c < 128) {
      out += ch;
      continue;
    }
    const units = c > 0xffff ? [ch.charCodeAt(0), ch.charCodeAt(1)] : [ch.charCodeAt(0)];
    for (const u of units) out += "~" + u.toString(16).toUpperCase().padStart(4, "0");
  }
  return "--" + out + "--";
}

/** 反解：官方目录名 ⇒ 原 cwd（用来验证规则，而不是只靠正向）。 */
function decodeDirName(name) {
  const BS = String.fromCharCode(92);
  let s = name;
  if (s.startsWith("--")) s = s.slice(2);
  if (s.endsWith("--")) s = s.slice(0, -2);
  // 先把 ~XXXX 还原成字符（可能连续两个组成一个补充平面字符）
  let out = "";
  const re = /~([0-9A-Fa-f]{4})/g;
  let last = 0;
  let m;
  const parts = [];
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ lit: s.slice(last, m.index) });
    parts.push({ unit: parseInt(m[1], 16) });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ lit: s.slice(last) });
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].lit !== undefined) {
      out += parts[i].lit;
    } else {
      const u = parts[i].unit;
      if (u >= 0xd800 && u <= 0xdbff && parts[i + 1]?.unit !== undefined) {
        out += String.fromCharCode(u, parts[i + 1].unit);
        i += 1;
      } else {
        out += String.fromCharCode(u);
      }
    }
  }
  // 剩下的 '-' 按位置还原：`D-Deepseek...` ⇒ `D:\Deepseek...`
  // 规则：第一个 '-' 前是盘符，其后每个 '-' 都是分隔符（本机所有的 cwd 都只有盘符: + 分隔符）
  const segs = out.split("-");
  if (segs.length >= 2 && segs[0].length === 1) {
    return segs[0] + ":" + BS + segs.slice(1).join(BS);
  }
  return out.replace(/-/g, BS);
}

console.log("sessions root:", SESSIONS);
let dirs = [];
try {
  dirs = fs.readdirSync(SESSIONS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
} catch (e) {
  console.log("FAILED: 读不到 sessions 根：", String(e.message || e));
  process.exit(0);
}
console.log("目录数:", dirs.length, "\n");

console.log("── 反解（官方目录名 ⇒ cwd）：");
for (const d of dirs) {
  const cwd = decodeDirName(d);
  const ok = fs.existsSync(cwd);
  console.log(`  ${ok ? "OK  " : "MISS"} ${d}`);
  console.log(`       ⇒ ${cwd}`);
}

console.log("\n── 正向（本项目 cwd ⇒ 目录名 ⇒ 是否命中）：");
const ours = [
  "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账",
  "D:\\Deepseek工作区\\20-DSH插件",
  "D:\\Deepseek工作区",
];
for (const c of ours) {
  const enc = encodeCwd(c);
  const hit = dirs.includes(enc);
  console.log(`  ${hit ? "HIT " : "MISS"} ${enc}`);
  console.log(`       from ${c}`);
}

console.log("\n── 目标会话的文件（本项目）：");
const target = encodeCwd(ours[0]);
const dir = path.join(SESSIONS, target);
try {
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  console.log(`  子会话数: ${subs.length}`);
  for (const s of subs.slice(0, 5)) {
    const f = path.join(dir, s, "session.v4.jsonl.zstd");
    let size = 0;
    try { size = fs.statSync(f).size; } catch { /* 没有就是 0 */ }
    console.log(`    ${s}  session.v4.jsonl.zstd ${size} B`);
  }
  const newest = subs.map((s) => {
    try { return { s, t: fs.statSync(path.join(dir, s, "session.v4.jsonl.zstd")).mtimeMs }; } catch { return { s, t: 0 }; }
  }).sort((a, b) => b.t - a.t)[0];
  if (newest) {
    console.log(`  ★ 最新的一个: ${newest.s}`);
    console.log(`    绝对路径: ${path.join(dir, newest.s, "session.v4.jsonl.zstd")}`);
  }
} catch (e) {
  console.log("  FAILED:", String(e.message || e));
}
