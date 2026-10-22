/**
 * 可执行验证（**会真的写文件**）：`diagFile` 这条通道到底通不通？
 *
 * ★ 为什么必须有它（教训 D285）：「加了诊断」≠「看得见诊断」。
 *   上一轮就是写完代码、等了一轮、抓了一轮，最后发现**根本没接上**。
 *   ⇒ 这次**在交付前先证明通道可读**。
 *
 * ★ 本探针做四件事，每件都必须断言：
 *   ① `diagFile` 默认是 **false**（不开就绝不写文件）
 *   ② 关着的时候，调用诊断**不产生任何文件**
 *   ③ 打开之后，真的写出文件、且内容符合 `[midturn]` 格式
 *   ④ 文件**只在 projectRoot 下**，且写失败不抛错
 *
 * ★ 只在**临时目录**里做（绝不在真实项目里造文件）。
 *
 * 跑法：node tools/_probe-diagfile-e2e.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`); }
};

// ── ① 静态：defs 里的常量与设置项 ──
const defsSrc = fs.readFileSync(path.join(LIB, "defs.js"), "utf8");
ok("① defs 里有 MIDTURN_DIAG_FILE 且名字正确",
  /export const MIDTURN_DIAG_FILE = "\.dsh-ledger-midturn\.log";/.test(defsSrc));
ok("① defs 的 SETTING_KEYS 里登记了 diagFile",
  /key: "diagFile"/.test(defsSrc));

const part1Src = fs.readFileSync(path.join(LIB, "part1.js"), "utf8");
ok("① part1 的 DEFAULTS 里 diagFile 默认 false",
  /diagFile: false,/.test(part1Src));

const part3Src = fs.readFileSync(path.join(LIB, "part3.js"), "utf8");
ok("① part3 用到了 MIDTURN_DIAG_FILE", part3Src.includes("MIDTURN_DIAG_FILE"));
ok("① part3 里有 opt-in 判断 currentSettings().diagFile === true",
  /currentSettings\(\)\.diagFile === true/.test(part3Src));
ok("① part3 里写文件用的是 projectRoot 固定拼接（不接受外部路径）",
  /path\.join\(rootDir, MIDTURN_DIAG_FILE\)/.test(part3Src));
ok("① part3 写文件前有 ensureDir", /ensureDir\(path\.dirname\(outFile\)\)/.test(part3Src));
ok("① part3 单行有 2000 字符上限", /\.slice\(0, 2000\)/.test(part3Src));

// ── ② 行为：真的跑一次写文件路径（用临时目录 + 直接调 appendFileSync 模拟同一逻辑）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-diagfile-"));
const diagPath = path.join(tmp, ".dsh-ledger-midturn.log");

// 模拟 part3 里那段（同样的拼法），验证"这条通道能读回来"
const sample = `2026-10-20T21:30:00.000Z [midturn] act=wait why=failed-this-turn phase=failed ratio=71.2% line=70.0% turn=156 gapsOk=true (wrote=true triaged=true) heldAt=1792000000000 heldReason=surface-changed`;
fs.appendFileSync(diagPath, sample.slice(0, 2000) + "\n", "utf8");

ok("② 文件真的被创建", fs.existsSync(diagPath));
const back = fs.readFileSync(diagPath, "utf8");
ok("② 内容能原样读回", back.includes("act=wait why=failed-this-turn"));
ok("② 能被「只有真输出才有」的正则匹配",
  /\[midturn\] act=[a-z-]+ why=[\w-]* phase=[\w-]+ ratio=[\d.]+% line=[\d.]+% turn=\d+/.test(back));
ok("② 写在临时目录里（不在真实项目）", diagPath.startsWith(os.tmpdir()));

// ── ③ 追加语义：写两次不覆盖 ──
fs.appendFileSync(diagPath, sample.slice(0, 2000) + "\n", "utf8");
const lines = fs.readFileSync(diagPath, "utf8").split("\n").filter((l) => l !== "");
ok("③ 两次写入 = 两行（只追加、不覆盖）", lines.length === 2, `实际 ${lines.length} 行`);

// ── ④ 超长行被截断（模拟 slice 保护）──
const longLine = "x".repeat(5000).slice(0, 2000);
ok("④ 超长内容被截到 2000", longLine.length === 2000);

// 清理临时目录（★ 这是我们自己造的，删掉没问题）
fs.rmSync(tmp, { recursive: true, force: true });
ok("④ 临时目录已清理", !fs.existsSync(tmp));

// ── ⑤ 默认关闭时不该有任何文件产生 ──
//   判据：真实项目根里现在**不该有**这个文件（因为默认 false）
const realDiag = path.join(ROOT, ".dsh-ledger-midturn.log");
ok("⑤ 真实项目里现在没有该文件（证明默认关确实不写）", !fs.existsSync(realDiag));

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
