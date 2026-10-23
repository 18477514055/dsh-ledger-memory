#!/usr/bin/env node
/**
 * 反向验证 `archiveEvictedUserMessage` 的基准修复（`part2.js:3146` `root` → `memoryBaseOf(info, root)`）。
 *
 * ★★★ 这条探针的存在理由（纪律 10：**看不见红的断言不是断言**）：
 *   函数是**导出**的、可被直接调用 ⇒ 不需要活内核就能验。而"读源码看见它改对了"**不是证据**
 *   —— 只有"V3 下真的落到记忆目录、V2 下真的仍落在项目根"这两条同时成立才算。
 *
 * ★ 判据（两条都必须成立，缺一不算）：
 *   ① **V3 夹具**（清单有 `memoryRoot`）⇒ 文件必须出现在 `memoryRoot/_ledger-archive/...`
 *      且项目根**没有** `_ledger-archive`；
 *   ② **V2 夹具**（清单无 `memoryRoot`）⇒ 文件必须出现在项目根（**行为逐字不变**，这是向后兼容的硬要求）。
 *   ③ 反向：把修复摘掉（临时注入旧写法），① 必须**变红** —— 否则说明这条断言测不到它。
 *
 * ★ 全程在 `os.tmpdir()` 的一次性目录里跑，**不碰真实工作区**（D: 上的这份是被测对象）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const PART2 = path.join(PROJECT, "lib", "part2.js");

const { inspect, archiveEvictedUserMessage } = await import(pathToFileURL(PART2).href);

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : `  —— ${detail}`}`);
};

/** 建一个一次性夹具：{ root, info } */
function fixture(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ledger-baseref-${kind}-`));
  // 清单：V2 不写 memoryRoot；V3 写 "mem-ledger-memory"
  const manifest = { version: 1, active: "LEDGER.md", archiveDir: "_ledger-archive" };
  if (kind === "v3") manifest.memoryRoot = "mem-ledger-memory";
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# t\n", "utf8");
  if (kind === "v3") fs.mkdirSync(path.join(root, "mem-ledger-memory"), { recursive: true });
  const info = inspect(root);
  return { root, info };
}

const msg = { text: "探针用的原话一条", at: "2026-10-23 11:00:00" };

console.log("═".repeat(74));
console.log("反向验证：archiveEvictedUserMessage 的基准（part2.js:3146）");
console.log("═".repeat(74));

// ── ① V3：必须落到记忆目录 ────────────────────────────────────────────────
const v3 = fixture("v3");
const wrote3 = archiveEvictedUserMessage(v3.root, v3.info, msg, "probe1234");
const memFile = path.join(
  v3.root,
  "mem-ledger-memory",
  "_ledger-archive",
  "2026-10",
  // 期间目录由 archiveStamp 按"当前时间"算，这里只按通配找
  "x"
);
const memHit = [];
(function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "用户原话-完整存档.md") memHit.push(p);
  }
})(path.join(v3.root, "mem-ledger-memory"));
const rootHit3 = fs.existsSync(path.join(v3.root, "_ledger-archive"));

ok("V3：函数回报写了（返回值 true）", wrote3 === true, `returned=${String(wrote3)}`);
ok("V3：文件落在 memoryRoot 之内", memHit.length === 1, memHit[0] ?? "（没找到）");
ok("V3：项目根**没有** _ledger-archive（泄露不再发生）", rootHit3 === false, `exists=${rootHit3}`);

// ── ② V2：必须仍在项目根（向后兼容） ─────────────────────────────────────
const v2 = fixture("v2");
const wrote2 = archiveEvictedUserMessage(v2.root, v2.info, msg, "probe5678");
const rootHit2 = fs.existsSync(path.join(v2.root, "_ledger-archive"));
ok("V2：函数回报写了（返回值 true）", wrote2 === true, `returned=${String(wrote2)}`);
ok("V2：文件仍落在项目根 _ledger-archive（V2 布局逐字不变）", rootHit2 === true, `exists=${rootHit2}`);

// ── ③ 反向：临时摘掉修复 ⇒ ① 必须变红 ─────────────────────────────────────
const src = fs.readFileSync(PART2, "utf8");
const FIXED = "const file = path.join(memoryBaseOf(info, root), ...relFile.split(\"/\"));";
const BROKEN = "const file = path.join(root, ...relFile.split(\"/\"));";
if (!src.includes(FIXED)) {
  ok("反向验证的前置：源码里确实有修复后的那一行", false, "找不到 FIXED 字面量 ⇒ 本探针的前提不成立");
} else {
  const backup = `${PART2}.bak-${process.pid}`;
  fs.writeFileSync(backup, src);
  try {
    fs.writeFileSync(PART2, src.replace(FIXED, BROKEN), "utf8");
    // 重新 import（带时间戳查询参数绕过 ESM 缓存）
    const mod2 = await import(`${pathToFileURL(PART2).href}?t=${Date.now()}`);
    const v3b = fixture("v3");
    mod2.archiveEvictedUserMessage(v3b.root, v3b.info, msg, "probe9999");
    const rooted = fs.existsSync(path.join(v3b.root, "_ledger-archive"));
    ok("反向（摘掉修复）：V3 下**重新**出现根目录 _ledger-archive ⇒ 断言能看见红", rooted === true, `exists=${rooted}`);
  } finally {
    fs.writeFileSync(PART2, src);
    fs.rmSync(backup, { force: true });
    console.log("  （源码已还原，字节数 " + Buffer.byteLength(fs.readFileSync(PART2)) + "）");
  }
  ok("还原后源码与修复版逐字相同", fs.readFileSync(PART2, "utf8") === src, "");
}

const bad = results.filter((r) => r.pass !== true).length;
console.log("\n" + "─".repeat(74));
console.log(`${results.length - bad} PASS / ${bad} FAIL`);
console.log("─".repeat(74));
process.exit(bad === 0 ? 0 : 1);
