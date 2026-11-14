#!/usr/bin/env node
/**
 * D367 反向验证：逐处**破坏**这次的修复，看 `_probe-d367-verify.mjs` 是否**见红**。
 *
 * ★★★★ 判据（本轮最值钱的一条，D366 立的）：
 *   一条断言若在"把被测代码拆掉"之后**仍然绿**，它就没在守任何东西。
 *
 * ★ 做法：备份原文件 → 施加破坏 → 跑取证器 → 记录 FAIL 数 → 还原。
 *   ★ 还原必须逐字节（用 Buffer 原样写回，不做任何编码转换）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROBE = path.join(ROOT, "tools", "_probe-d367-verify.mjs");

const runProbe = () => {
  try {
    const out = execFileSync(process.execPath, [PROBE], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const m = /合计：PASS (\d+) · FAIL (\d+)/.exec(out);
    if (m === null) return { pass: -1, fail: -1, raw: out.slice(-400) };
    return { pass: Number(m[1]), fail: Number(m[2]), raw: out };
  } catch (e) {
    // 崩溃也算"见红"，但要标出来（尺子错第 23 条：崩溃会冒充检出）
    return { pass: -1, fail: -1, crashed: true, raw: String(e?.stdout ?? "") + String(e?.stderr ?? "") };
  }
};

const breaks = [
  {
    id: "B1",
    what: "摘掉 backupPathOf 的词法拦截（盘符 / `.` `..` 段 / path.relative 复核）",
    file: "lib/backup.js",
    apply: (src) => {
      // ★★★ 上一版我只插了一行注释 ⇒ **文本变了但行为没变** ⇒ 断言照旧绿，我还差点把它记成"断言没守着"。
      //   这就是"破坏没生效"冒充"修复无人守"（尺子错第 22 条的反面）。⇒ 必须**真删掉**那几行。
      const before = src;
      const out = src
        .replace('  if (/^[A-Za-z]:[\\\\/]|^[\\\\/]/.test(rel)) return undefined;\n', "")
        .replace('  if (clean === "" || clean.split("/").some((p) => p === "" || p === "." || p === "..")) return undefined;\n', "")
        .replace(/  const relToBackup = path\.relative\(baseAbs, abs\);\n  if \(relToBackup === "" \|\| relToBackup\.startsWith\("\.\."\) \|\| path\.isAbsolute\(relToBackup\)\) return undefined;\n/, "");
      if (out === before) throw new Error("三处词法拦截一处都没删掉（正则不匹配源码）");
      return out;
    },
  },
  {
    id: "B2",
    what: "摘掉 writeLedger 落盘前重算封签（applyFingerprint3(next, fpIdW)）",
    file: "lib/part4.js",
    apply: (src) => src.replace("  if (fpIdW !== undefined) next = applyFingerprint3(next, fpIdW).text;", "  // BREAK-B2: 不重算封签"),
  },
  {
    id: "B3",
    what: "摘掉 archiveLedger 落盘前重算封签（applyFingerprint3(registered, fpIdAct)）",
    file: "lib/part4.js",
    apply: (src) => src.replace("  if (fpIdAct !== undefined) registered = applyFingerprint3(registered, fpIdAct).text;", "  // BREAK-B3: 不重算封签"),
  },
  {
    id: "B4",
    what: "摘掉 splitChangeRegister 过滤尾载体那一行",
    file: "lib/part1.js",
    apply: (src) => src.replace(".filter((l) => !isFingerprintLinkLine(l.trim()))", ""),
  },
  {
    id: "B5",
    what: "把 DECISIONS.md 从 HOT_FILES 里删掉",
    file: "lib/backup.js",
    apply: (src) => src.replace('  "DECISIONS.md",\n', ""),
  },
  {
    id: "B6",
    what: "摘掉 writePrinciples 的备份接线",
    file: "lib/part2.js",
    apply: (src) => {
      const m = /backupBeforeWrite\(/;
      const i = src.search(m);
      if (i < 0) throw new Error("part2 里找不到 backupBeforeWrite");
      // 把这次调用整行注释掉（只该有一处，即 writePrinciples 里新加的）
      const lineStart = src.lastIndexOf("\n", i) + 1;
      const lineEnd = src.indexOf("\n", i);
      return src.slice(0, lineStart) + "  // BREAK-B6: 不备份" + src.slice(lineEnd);
    },
  },
  {
    id: "B7",
    what: "摘掉 splitIntoCardParts 的剥离（让它带着单文件载体去切卡）",
    file: "lib/card-ops.js",
    apply: (src) => {
      // ★ 同上：必须**真删**那一行剥离线，插注释无效。
      const before = src;
      const out = src.replace(
        "  const src = readFingerprint3(rawStr).ok ? applyFingerprint3(rawStr, undefined, { strip: true }).text : rawStr;",
        "  const src = rawStr;",
      );
      if (out === before) throw new Error("剥离线没删掉（正则不匹配源码）");
      return out;
    },
  },
  {
    id: "B8",
    what: "把 logLevels Schema 里的 L4 删掉",
    file: "lib/part4.js",
    apply: (src) => src.replace('            L4: { type: "boolean" },\n', ""),
  },
];

const base = runProbe();
console.log(`基线：PASS ${base.pass} · FAIL ${base.fail}${base.crashed ? "（崩溃）" : ""}`);
if (base.fail !== 0) {
  console.log("★ 基线本身就不全绿 ⇒ 反向验证无意义，先修取证器。");
  process.exit(2);
}

let caught = 0;
let missed = 0;
const rows = [];
for (const b of breaks) {
  const abs = path.join(ROOT, b.file);
  const original = fs.readFileSync(abs); // Buffer，逐字节还原
  const text = original.toString("utf8");
  let broken;
  try {
    broken = b.apply(text);
  } catch (e) {
    rows.push(`ERROR ${b.id}（${b.what}）：施加破坏失败 —— ${String(e?.message ?? e)}`);
    missed += 1;
    continue;
  }
  if (broken === text) {
    rows.push(`ERROR ${b.id}（${b.what}）：破坏没生效（文本没变）⇒ 这条"验证"是空的`);
    missed += 1;
    continue;
  }
  fs.writeFileSync(abs, broken, "utf8");
  const r = runProbe();
  fs.writeFileSync(abs, original); // ★ 逐字节还原
  const red = r.crashed === true || r.fail > 0;
  if (red) {
    caught += 1;
    rows.push(`红  ${b.id} ${b.what} ⇒ FAIL ${r.fail}${r.crashed ? "（崩溃=也算见红，但已标注）" : ""}`);
  } else {
    missed += 1;
    rows.push(`★ 仍绿 ${b.id} ${b.what} ⇒ PASS ${r.pass} / FAIL ${r.fail} —— **这条修复没有被任何断言守着**`);
  }
}

console.log(rows.join("\n"));
const after = runProbe();
console.log("─".repeat(72));
console.log(`反向验证：${caught} / ${breaks.length} 见红${missed > 0 ? `，${missed} 处**没见红**` : ""}`);
console.log(`还原后复核：PASS ${after.pass} · FAIL ${after.fail}`);
console.log("REVERSE-COMPLETE");
process.exit(missed === 0 && after.fail === 0 ? 0 : 1);
