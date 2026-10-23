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
// ★★★★★ 2026-10-17（D234 发布时撞出）：这里原来**硬编码 `VER = "1.1.1"`** ——
//   于是每发一版，它都去回读 **1.1.1**，再拿那个旧包和**当前**工作树比。
//   ⇒ 第④条（包内源码与本机逐字节相同）**必然报红**，而发布其实是成功的。
//   ★ 这是"**记录存在 ≠ 记录适用**"的新形态：探针在、断言在、**它测的是另一个版本**。
//   ★★ 更糟的是它会让人去"修"一个没坏的东西（`git` 里的源码明明是新的）。
//   ⇒ 正解：**版本号只有一个出处** —— 从 `package.json` 现读，绝不手抄。
const VER = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const MAX_TRIES = 40;
console.log(`（回读目标版本：${VER} —— 从 package.json 现读，不硬编码）`);

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
//
// ★★★ 2026-10-17（D234）：这一条原来还比了 `tools/selftest.mjs` ——
//   而 **`files` 白名单里根本没有 `tools/`**（那是刻意的：`tools/` 里有会改写源码的探针）。
//   ⇒ 每次都会因为"包里没有这个文件"而读盘抛错/判红 ⇒ **一条永远红的假红**。
//   ★ 判据：**只比"包里真有的"**；比较对象与包面清单必须同源。
//     （这正是 `_probe-pack-check` 里那条"`tools/` 不进包（设计如此，跳过比对）"的同一条口径。）
const pkgLib = fs.readFileSync(path.join(pkgDir, "lib", "index.js"), "utf8");
const localLib = fs.readFileSync("lib/index.js", "utf8");
const pkgPart6 = fs.readFileSync(path.join(pkgDir, "lib", "part6.js"), "utf8");
const localPart6 = fs.readFileSync("lib/part6.js", "utf8");
const pkgPkgJson = fs.readFileSync(path.join(pkgDir, "package.json"), "utf8");
const localPkgJson = fs.readFileSync("package.json", "utf8");
const same = (a, b) => a === b;
console.log(`④ ${same(pkgLib, localLib) ? "✓" : "✗"} lib/index.js 逐字节相同`);
console.log(`   ${same(pkgPart6, localPart6) ? "✓" : "✗"} lib/part6.js 逐字节相同（本版新增）`);
console.log(`   ${same(pkgPkgJson, localPkgJson) ? "✓" : "✗"} package.json 逐字节相同`);
console.log(`   ★ tools/selftest.mjs **不进包**（files 白名单如此）—— 跳过比对，不是失败`);

// ── ⑤ 这一版修的那行确实在包里（用**独一无二**的标志物）─────────────────
//
// ★★★ 2026-10-17（D234）：这一组标志物原来**停在 1.1.1 时代**
//   （D62 / A2 / A3 / D61 / 「工具数 = 14」）⇒ 后面每一版它只能证明"**老修复还在**"，
//   证明不了"**这一版的新修复进了包**"。这与 `_probe-pack-check` 那个病**同型**。
//   ⇒ 现在按**当前版本**给标志物：本版 = 1.2.4（D234 文件级六维锚定 + 0.2.1-rc.2 兼容）。
//   ★ 判据不变：**每一版新增的修复，都必须有自己独一无二、能在包里被找到的标志物。**
// ★★★ 2026-10-17（D234 发布时第 3 次撞同一个类）：`MARKS` 只登记了 `"1.2.4"`，
//   于是 1.2.5 落进 `LEGACY` 兜底；而 `LEGACY` 的六条标志物**全被我写成 `lib/index.js`** ——
//   它们其实在 `part1~part5.js`（代码早就按模块拆过了）。
//   ⇒ 一条判据连续三次栽在「**路径/版本凭印象**」上，正对应台账纪律 9。
//   ⇒ 正解：**不按版本分家** —— D234 的标志物 + 长期标志物**并成一组合并跑**，
//     并且**每条都带真实路径**（下面这些路径已用 grep 复核过）。
const MARKS = {
  "1.2.4": [
    ["D234 六维函数（lib/part6.js 已进包）", "fileAnchorDims", "lib/part6.js"],
    ["D234 按类分组（两次混类的修法）", "anchorWithinKind", "lib/part6.js"],
    // ★ 这两条的路径**当场写错过一次**：`renderFileAnchorBlock` 与 `fileAnchor` 我都写了 `lib/index.js`，
    //   而它们实际在 `part3.js` / `defs.js`（`grep` 复核：part3.js:1145 · defs.js:329）。
    //   ⇒ 判据：**标志物必须带"它在哪个文件的哪一处"，并且报之前 grep 一次**
    //     （台账纪律 9 的原话：「函数名+行号看起来最硬，却最容易凭印象编」）。
    ["D234 注入装配点", "export function renderFileAnchorBlock", "lib/part3.js"],
    ["D234 设置项 fileAnchor", 'key: "fileAnchor"', "lib/defs.js"],
    ["★ 兼容当前客户端 0.2.1-rc.2", '"0.2.1-rc.2": "compatible"', "package.json"],
  ],
};
// ★ 兜底：没有登记的版本 ⇒ 退回到那一组"长期存在的"标志物（仍然要能证明包没被换掉）。
//   ★ 路径已 grep 复核（不是凭印象）：它们分布在 part*.js 与 defs.js，**都不在 index.js**。
const LEGACY = [
  // ★★★ 这一条我**连续猜错两次**（先 `index.js`、再 `part1.js`，实际在 `part5.js:1963`）——
  //   `grep removeRatio` 一次就能定，我两次都是先写再试。
  //   ⇒ 纪律 9 不是"知道就行"，是**报之前必须 grep 一次**；本文件因此每条都带 `文件:行`。
  ["D62 口径修复", "Math.max(1, Math.floor(nodeSum - removeRatio * pressure.window))", "lib/part5.js"],
  ["A2 内容指纹", "batch:${bodySha}", "lib/part4.js"],
  // ★★★ 2026-10-23（D312）：这条标志物的**措辞在源码里被改过**，我一直没跟上：
  //   旧写法「既不在新台账、也不在 entries 里」⇒ 现写法「这批移走后，旧台账里还有 N 行不在新台账也不在 entries 了」
  //   （part4.js:3106，已 grep 复核）。
  //   ★ 判据：**标志物是"代码里的一句话"，代码改措辞它就失效** —— 这是这条机制**固有的脆弱性**。
  //     ⇒ 处理照先例：**改标志物去追代码**，但必须**先 grep 新位置/新措辞**，不许凭印象写。
  //   ★ 更稳的写法是把标志物选在**不容易被改写的部分**（如函数名、关键表达式），
  //     但那样就失去了"这一版的修复真的进了包"这个意义 —— 两者是取舍，不是谁对。
  ["A2 内容不变量", "不在新台账也不在 entries 了", "lib/part4.js"],
  ["A2 ifRevision 拒绝", "stale: true", "lib/part4.js"],
  ["A3 保留扩展字段", "hadPrevManifest", "lib/part4.js"],
  ["D61 胶囊落盘", "capsules.json", "lib/defs.js"],
];
// ★★★ 合并跑（**不按版本二选一**）：D234 的标志物必须一直在，长期标志物也必须一直在。
//   ★ 为什么不再分版本：1.2.4 与 1.2.5 是同一份代码（只差两个兼容键）⇒ "按版本分家"只会制造假红。
//   ★ 只有在**下一代大改**时，才把它这一版的标志物并进本表 —— 那时旧标志物仍应保留。
const pick = [...Object.values(MARKS).flat(), ...LEGACY];
let ok5 = true;
for (const [n, k, rel] of pick) {
  const abs = path.join(pkgDir, rel);
  const body = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const has = body.includes(k);
  if (!has) ok5 = false;
  console.log(`   ${has ? "✓" : "✗"} ${n}　（${rel}）`);
}
console.log(`⑤ ${ok5 ? "✓" : "✗"} 本版全部修复都在包里`);

const all = found >= 0 && buf.length > 0 && !internalSmell && same(pkgLib, localLib) && same(pkgPart6, localPart6) && same(pkgPkgJson, localPkgJson) && ok5;
console.log(`\n═══ 回读${all ? " **五条全过**" : " **未全过**"} ═══`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(all ? 0 : 1);
