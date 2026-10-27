// ★ 核 013 的 F-02 声称的一件事：
//   「无扩展 / 无目标树 / 无交接单 / 无原则」时，fingerprintOf 的输出与改动前**逐字符一致**。
//
// 为什么必须核：fingerprintOf 是**去重判据**。若空集合时输出变了（哪怕差一个字符），
//   所有在线会话的指纹会集体失效 ⇒ 下一回合全部重注一份台账（一次全员重注）。
//   报告只说「四项已纳入」，没说「空集合时不变」—— 那正是要验的那一半。
//
// 做法：把 9b82d6a（013 之前）与当前工作树的 lib 各落一份到临时目录，
//   在**完全相同的 info** 上各算一次指纹，逐字符比。
// ★ 不用 tar（本机 tar 解 git archive 会 bad header checksum），改用 git show 逐文件落盘。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "9b82d6a"; // D331+D332 提交，即 013 补丁之前
const work = fs.mkdtempSync(path.join(os.tmpdir(), "d334-f02-"));

function materialize(label, getFile) {
  const dir = path.join(work, label);
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  const files = getFile();
  for (const [rel, content] of files) {
    const abs = path.join(dir, "lib", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

// ① 旧版：从 git 里逐个 lib/*.js 取
const oldLibFiles = execFileSync("git", ["ls-tree", "--name-only", `${BASE}:lib`], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);
const oldDir = materialize("old", () =>
  oldLibFiles.map((n) => [n, execFileSync("git", ["show", `${BASE}:lib/${n}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })]),
);
// ② 新版：直接拷工作树 lib/（连同子目录）
const newDir = path.join(work, "new");
fs.mkdirSync(path.join(newDir, "lib"), { recursive: true });
fs.cpSync(path.join(ROOT, "lib"), path.join(newDir, "lib"), { recursive: true });

console.log(`旧版 ${BASE} → ${oldDir}（${oldLibFiles.length} 个模块）`);
console.log(`新版 工作树 → ${newDir}\n`);

let pass = 0,
  fail = 0;
const ok = (t, c, extra = "") => {
  if (c) {
    pass++;
    console.log(`  PASS  ${t}`);
  } else {
    fail++;
    console.log(`  FAIL  ${t}${extra ? `\n        ${extra}` : ""}`);
  }
};

const { fingerprintOf: fpOld } = await import(pathToFileURL(path.join(oldDir, "lib", "defs.js")).href);
const { fingerprintOf: fpNew } = await import(pathToFileURL(path.join(newDir, "lib", "defs.js")).href);

// 夹具：一个「什么附加记忆都没有」的项目 —— 没有 goals / 没有扩展 / 没有交接单 / 没有原则
const projRoot = path.join(work, "proj");
fs.mkdirSync(projRoot, { recursive: true });
const activeAbs = path.join(projRoot, "LEDGER.md");
const led = "# 台账\n\n- 只有台账，别的记忆面一律没有\n";
fs.writeFileSync(activeAbs, led);

const info = {
  projectRoot: projRoot,
  activeExists: true,
  activeAbs,
  activeRel: "LEDGER.md",
  activeLines: led.split("\n").length,
  // ★ 关键：这四项**一律不给**
  //   goalsRel/GOALS.md 不存在 · 无 extensions 目录 · handoffLatestRel 不给 · principlesRel 不给
};

const a = fpOld({ ...info });
const b = fpNew({ ...info });
console.log("=== 空集合夹具下的指纹 ===");
console.log(`  旧：${a}`);
console.log(`  新：${b}`);
ok("空集合（无扩展/无目标树/无交接单/无原则）时指纹**逐字符一致**", a === b, a === b ? "" : "★ 不一致 ⇒ 所有在线会话指纹会集体失效，下一回合全员重注");

// 再验三次：证明这不是"两次都恰好返回空"之类的巧合，且台账改动仍能反映到指纹
const b2 = fpNew({ ...info });
ok("同一 info 连续两次调用结果稳定（旧）", fpOld({ ...info }) === a);
ok("同一 info 连续两次调用结果稳定（新）", b2 === b);

fs.writeFileSync(activeAbs, led + "\n- 多一行\n");
const a2 = fpOld({ ...info });
const b2b = fpNew({ ...info });
ok("台账变了 ⇒ 两边指纹都变（去重判据没坏）", a2 !== a && b2b !== b, `旧 ${a2 === a ? "没变" : "变了"} / 新 ${b2b === b ? "没变" : "变了"}`);
ok("台账改动后两边仍逐字符一致", a2 === b2b, `旧 ${a2}\n        新 ${b2b}`);

// ④ 有一条原则文件时（principles 存在于 manifest）—— 新版应当把 p: 折进指纹
const infoP = { ...info, principlesRel: "PRINCIPLES.md" };
const aP = fpOld({ ...infoP });
const bP = fpNew({ ...infoP });
console.log("\n=== 有原则文件时 ===");
console.log(`  旧：${aP}`);
console.log(`  新：${bP}`);
ok("有原则时新版指纹**确实变了**（F-02 那半修有效）", bP !== fpNew({ ...info }));
ok("有原则时旧版指纹**没变**（坐实修之前确实是漏的）", aP === fpOld({ ...info }));

// ⑤ 有交接单时
const infoH = { ...info, handoffLatestRel: "_handoff/x.md" };
ok("有交接单时新版指纹确实变了", fpNew({ ...infoH }) !== fpNew({ ...info }));
ok("有交接单时旧版指纹没变（同上）", fpOld({ ...infoH }) === fpOld({ ...info }));

console.log(`\nPROBE-COMPLETE  ${pass} PASS / ${fail} FAIL`);
console.log(`夹具目录（可删）：${work}`);
