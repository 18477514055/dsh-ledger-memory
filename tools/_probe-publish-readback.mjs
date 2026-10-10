/**
 * ★★★ 发布回读五条（**必须轮询**：1.0.0 第 16 次、1.1.0 第 23 次才拿到）。
 *   ① packument 有这一版 ② tarball 真能下（gzip）③ 包内 README 是对外版
 *   ④ 包内源码与本机**逐字节相同** ⑤ **这一版修的那行确实在包里**
 * ★ 直连 registry 用 https 模块 + 重试（fetch 在本机会失败）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const NAME = "dsh-ledger-memory";
const VER = "1.1.1";
const MAX_TRIES = 40;

const get = (url, raw = false) =>
  new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const cs = [];
        res.on("data", (c) => cs.push(c));
        res.on("end", () => resolve(raw ? Buffer.concat(cs) : Buffer.concat(cs).toString("utf8")));
      })
      .on("error", reject)
      .on("timeout", function () { this.destroy(new Error("timeout")); });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ① packument 里有这一版（轮询）────────────────────────────────────────
let pack;
let found = -1;
for (let i = 1; i <= MAX_TRIES; i += 1) {
  try {
    pack = JSON.parse(await get(`https://registry.npmjs.org/${NAME}`));
    if (pack.versions?.[VER] !== undefined) { found = i; break; }
  } catch { /* 还没上去，继续 */ }
  process.stdout.write(`  第 ${i} 次未见 ${VER}，等 15s…\r`);
  await sleep(15000);
}
console.log("");
if (found < 0) { console.log(`① FAILED：${MAX_TRIES} 次轮询后 packument 仍无 ${VER}`); process.exit(1); }
console.log(`① ✓ packument 有 ${VER}（第 ${found} 次查到）`);
console.log(`   dist-tags.latest = ${pack["dist-tags"]?.latest}`);
console.log(`   发布时间 = ${pack.time?.[VER] ?? "?"}`);

// ── ② tarball 真能下（gzip）──────────────────────────────────────────────
const url = pack.versions[VER].dist.tarball;
const buf = await get(url, true);
console.log(`② ✓ tarball 能下：${buf.length} 字节；gzip 魔数 = ${buf[0] === 0x1f && buf[1] === 0x8b ? "0x1f8b ✓" : "✗"}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "readback-"));
const f = path.join(tmp, "p.tgz");
fs.writeFileSync(f, buf);
execFileSync("tar", ["-xzf", f, "-C", tmp], { stdio: "pipe" });
const pkgDir = path.join(tmp, "package");

// ── ③ README 是对外版（不是内部版：内部版含"给我自己"的味道）────────────
const readme = fs.readFileSync(path.join(pkgDir, "README.md"), "utf8");
const internalSmell = /只提交插件本体|开发过程记录留在本机|给我自己/.test(readme);
console.log(`③ ${internalSmell ? "✗ 像是内部版" : "✓"} README 是对外版（含内部痕迹=${internalSmell}）`);

// ── ④ 包内源码与本机逐字节相同 ───────────────────────────────────────────
const pkgLib = fs.readFileSync(path.join(pkgDir, "lib", "index.js"), "utf8");
const localLib = fs.readFileSync("lib/index.js", "utf8");
const pkgTest = fs.readFileSync(path.join(pkgDir, "tools", "selftest.mjs"), "utf8");
const localTest = fs.readFileSync("tools/selftest.mjs", "utf8");
console.log(`④ ${pkgLib === localLib ? "✓" : "✗"} lib/index.js 逐字节相同`);
console.log(`   ${pkgTest === localTest ? "✓" : "✗"} tools/selftest.mjs 逐字节相同`);

// ── ⑤ 这一版修的那行确实在包里（用**独一无二**的标志物）─────────────────
const marks = [
  ["D62 口径修复", "Math.max(1, Math.floor(nodeSum - removeRatio * pressure.window))"],
  ["A2 内容指纹", "batch:${bodySha}"],
  ["A2 内容不变量", "既不在新台账、也不在 entries 里"],
  ["A2 ifRevision 拒绝", "stale: true"],
  ["A3 保留扩展字段", "hadPrevManifest"],
  ["D61 胶囊落盘", "capsules.json"],
];
let ok5 = true;
for (const [n, k] of marks) {
  const has = pkgLib.includes(k);
  if (!has) ok5 = false;
  console.log(`   ${has ? "✓" : "✗"} ${n}`);
}
const hasSelfTest = pkgTest.includes("口径：工具数 = 14");
if (!hasSelfTest) ok5 = false;
console.log(`   ${hasSelfTest ? "✓" : "✗"} 口径自检`);
console.log(`⑤ ${ok5 ? "✓" : "✗"} 本版全部修复都在包里`);

const all = found >= 0 && buf.length > 0 && !internalSmell && pkgLib === localLib && pkgTest === localTest && ok5;
console.log(`\n═══ 回读${all ? " **五条全过**" : " **未全过**"} ═══`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(all ? 0 : 1);
