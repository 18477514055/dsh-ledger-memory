// 把「落在项目根 decisions/ 的那几张卡」搬进规范位置（memoryRoot/decisions/），
// 并把项目根那份同一内容的旧副本清掉，**不留第二份** —— 否则下次还会分叉。
//
// ★ 前置：先跑 _probe-d334-cardhome.mjs 看清分叉面。
// ★ 安全：① 每张搬之前记 sha256 并复制一份到 %TEMP% 备份目录；② 目标已存在且内容不同 ⇒ 先备份再覆盖；
//        ③ 只处理「项目根那份有、规范位置没有」和「D329 这种两边都在但内容不同」两类，别的一律不碰。
// ★ 本脚本给 --apply 才真动盘；不给就是 dry run。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAN = JSON.parse(fs.readFileSync(path.join(ROOT, ".dsh-ledger.json"), "utf8"));
const MEM = MAN.memoryRoot ? path.join(ROOT, MAN.memoryRoot) : ROOT;
const SRC = path.join(ROOT, MAN.decisionsDir);
const DST = path.join(MEM, MAN.decisionsDir);

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const BAK = path.join(os.tmpdir(), `d334-cardmove-${STAMP}`);

console.log(`模式：${APPLY ? "APPLY（真动盘）" : "DRY RUN（只看不动）"}`);
console.log(`从 ${SRC}`);
console.log(`到 ${DST}`);
console.log(`备份目录：${BAK}\n`);

if (!fs.existsSync(SRC)) {
  console.log("项目根 decisions/ 不存在 ⇒ 无事可做。");
  process.exit(0);
}
fs.mkdirSync(DST, { recursive: true });

const names = fs.readdirSync(SRC).filter((n) => n.toLowerCase().endsWith(".md"));
let moved = 0,
  replaced = 0,
  skipped = 0;
const plan = [];

for (const n of names.sort((a, b) => (parseInt(a.slice(1)) || 0) - (parseInt(b.slice(1)) || 0))) {
  const sAbs = path.join(SRC, n);
  const dAbs = path.join(DST, n);
  if (!fs.lstatSync(sAbs).isFile()) continue;
  const sbuf = fs.readFileSync(sAbs);
  const sHash = sha(sbuf);
  if (!fs.existsSync(dAbs)) {
    plan.push({ n, act: "move", sBytes: sbuf.length, sHash });
    if (APPLY) fs.writeFileSync(dAbs, sbuf);
    moved++;
  } else {
    const dbuf = fs.readFileSync(dAbs);
    if (sha(dbuf) === sHash) {
      plan.push({ n, act: "identical", sBytes: sbuf.length, sHash });
      skipped++;
    } else {
      // 两边都在但内容不同 ⇒ 谁更全取谁（字节大者），取小的那方先进备份
      const keepSrc = sbuf.length > dbuf.length;
      plan.push({
        n,
        act: keepSrc ? "replace-canonical" : "keep-canonical",
        sBytes: sbuf.length,
        dBytes: dbuf.length,
        sHash,
        dHash: sha(dbuf),
      });
      if (APPLY) {
        fs.mkdirSync(BAK, { recursive: true });
        if (keepSrc) {
          fs.writeFileSync(path.join(BAK, `${n}.canonical-旧`), dbuf);
          fs.writeFileSync(dAbs, sbuf);
          replaced++;
        } else {
          fs.writeFileSync(path.join(BAK, `${n}.root-旧`), sbuf);
        }
      } else if (keepSrc) replaced++;
    }
  }
}

console.log("=== 计划/结果 ===");
for (const p of plan) {
  const extra =
    p.act === "replace-canonical"
      ? `  根 ${p.sBytes} B > 规范 ${p.dBytes} B ⇒ 用根的覆盖规范（旧的进备份）`
      : p.act === "keep-canonical"
        ? `  规范 ${p.dBytes} B ≥ 根 ${p.sBytes} B ⇒ 保留规范，根的进备份`
        : p.act === "identical"
          ? "  两侧已逐字节相同"
          : "";
  console.log(`  ${p.act.padEnd(18)} ${p.n.padEnd(10)}${extra}`);
  console.log(`      sha256(src)=${p.sHash.slice(0, 16)}…`);
}
console.log(`\n合计：搬入 ${moved} · 覆盖 ${replaced} · 相同跳过 ${skipped}`);

if (APPLY) {
  // ★ 搬完之后**清掉项目根那份**，不留第二份。只在"该卡在规范位置已存在且内容与源一致"时才删。
  let removed = 0;
  for (const p of plan) {
    const sAbs = path.join(SRC, p.n);
    const dAbs = path.join(DST, p.n);
    if (!fs.existsSync(dAbs) || !fs.existsSync(sAbs)) continue;
    if (sha(fs.readFileSync(dAbs)) !== sha(fs.readFileSync(sAbs))) {
      console.log(`  ⚠️ 跳过删除 ${p.n}：规范位置内容与项目根那份仍不同`);
      continue;
    }
    fs.mkdirSync(BAK, { recursive: true });
    fs.copyFileSync(sAbs, path.join(BAK, `${p.n}.removed`));
    fs.unlinkSync(sAbs);
    removed++;
  }
  console.log(`已从项目根删除 ${removed} 张（原件都在 ${BAK}）`);
  const left = fs.readdirSync(SRC).filter((n) => n.toLowerCase().endsWith(".md"));
  console.log(`项目根 decisions/ 剩余 .md：${left.length} 张${left.length ? " → " + left.join(", ") : "（已空）"}`);
} else {
  console.log("\n（dry run —— 加 --apply 才真动盘）");
}
console.log("\nPROBE-COMPLETE");
