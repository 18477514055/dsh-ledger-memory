#!/usr/bin/env node
/**
 * 一次性：给**本工作区自身**补上清单镜像（D303）。
 *
 * 用户原话（逐字）：*"清单保留在外，也在子目录中复制一份（注意同步）"*
 *
 * ★ 为什么单独跑一次：`syncManifestMirror` 已经接在四个写入入口上，所以**下次任何一次台账写入**
 *   都会自动把镜像建出来。但"下次"可能是几小时后 —— 而当前状态是"用户要的东西还没到位"。
 *   ⇒ 主动同步一次，让磁盘上的事实与用户的要求先对齐。
 *
 * ★ 只做两件：① 同步镜像；② **读回来核**（不信自己刚写的）。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const APPLY = process.argv.includes("--apply");

const mm = await import(pathToFileURL(path.join(PROJECT, "lib", "manifest-mirror.js")).href);

const rootManifest = path.join(PROJECT, ".dsh-ledger.json");
const manifest = JSON.parse(fs.readFileSync(rootManifest, "utf8"));
const text = fs.readFileSync(rootManifest, "utf8");
const target = mm.manifestMirrorPath(PROJECT, manifest);

console.log("═".repeat(72));
console.log("给本工作区补清单镜像（D303）");
console.log("═".repeat(72));
console.log(`模式：${APPLY ? "APPLY（真写）" : "DRY-RUN（不写任何东西）"}`);
console.log(`memoryRoot = ${manifest.memoryRoot}`);

if (target === undefined) {
  console.log("\n✗ 这是 V2 项目（没有 memoryRoot）⇒ 按纪律**不该有镜像**，本脚本不适用。");
  process.exit(1);
}
console.log(`镜像应落在 = ${target}`);

const before = mm.verifyManifestMirror(PROJECT, manifest, text);
console.log(`同步前状态 = **${before.state}**${before.detail === undefined ? "" : `（${before.detail}）`}`);

if (!APPLY) {
  console.log("\n（dry-run 结束；加 --apply 才真写。）");
  process.exit(0);
}

const r = mm.syncManifestMirror(PROJECT, manifest, text);
console.log(`\nsyncManifestMirror ⇒ ${JSON.stringify({ created: r.created, changed: r.changed, failed: r.failed ?? null })}`);

// ── 读回来核（不信刚才那一步） ──────────────────────────────────────────
const after = mm.verifyManifestMirror(PROJECT, manifest, text);
console.log("\n" + "─".repeat(72));
console.log("写后校验（真读回磁盘）");
console.log("─".repeat(72));
let bad = 0;
const check = (n, pass, d) => {
  console.log(`  ${pass ? "✓" : "✗"} ${n}${d === undefined ? "" : `  —— ${d}`}`);
  if (!pass) bad += 1;
};
check("镜像文件存在", target !== undefined && fs.existsSync(target), target);
check(
  "镜像与根**逐字节相同**",
  target !== undefined && fs.existsSync(target) && fs.readFileSync(target, "utf8") === text,
  ""
);
check("verifyManifestMirror 判为 in-sync", after.state === "in-sync", after.state);
check(
  "镜像能被解析成同一个 JSON",
  (() => {
    try {
      const a = JSON.parse(fs.readFileSync(target, "utf8"));
      return a.memoryRoot === manifest.memoryRoot && a.revision === manifest.revision;
    } catch {
      return false;
    }
  })(),
  `revision=${manifest.revision}`
);
console.log("\n" + "─".repeat(72));
console.log(bad === 0 ? "✓ 全部通过" : `✗ ${bad} 项不过`);
console.log("─".repeat(72));
process.exit(bad === 0 ? 0 : 1);
