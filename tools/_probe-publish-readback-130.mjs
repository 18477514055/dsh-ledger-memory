/**
 * 发布后回读五条（台账「发布顺序」的硬规矩）。
 *
 * ★ 为什么必须回读：「发布了」≠「发布的是修好的那一版」。
 *   GitHub 源码与 npm 包**各自独立**，必须分别核对。
 *
 * 五条：
 *   ① 有这版
 *   ② tarball 真能下
 *   ③ 包内 README 是对外版
 *   ④ 包内源码**逐字节相同**
 *   ⑤ **这一版修的那几行确实在包里**
 *
 * ★ 必须轮询：npm 发布是异步的，查一次必然误判成失败（本机 1.1.1 / 1.2.1 / 1.3.0 都第 5 次才拿到）。
 *
 * 跑法：node tools/_probe-publish-readback-130.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const NAME = "dsh-ledger-memory";
const VER = "1.3.0";

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra === undefined ? "" : `  ← ${extra}`}`); }
}

/** 跑 npm 并拿干净结果；★ 判据只看 exit code 与 stdout，**绝不在错误文本里找匹配**。 */
function npm(args) {
  try {
    const out = execFileSync("npm.cmd", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: true });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? "").trim() };
  }
}

console.log(`═══ ① 有这版 ═══`);
const v = npm(["view", `${NAME}@${VER}`, "version", "--silent"]);
ok(`① ${NAME}@${VER} 在 registry 上`, v.code === 0 && v.out === VER, `exit=${v.code} out=${v.out}`);

console.log(`\n═══ ② tarball 真能下 ═══`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "readback-"));
let tarballOk = false;
let tgzPath = "";
try {
  // 从 registry 直接下载，**不用本地那份**（本地的是我自己打的，不能证明远端）
  const packed = npm(["pack", `${NAME}@${VER}`, "--pack-destination", tmp]);
  tgzPath = path.join(tmp, `${NAME}-${VER}.tgz`);
  tarballOk = fs.existsSync(tgzPath) && fs.statSync(tgzPath).size > 100_000;
  ok("② 从 registry 能拉到 tarball", tarballOk, `exit=${packed.code} 路径=${tgzPath}`);
  if (tarballOk) console.log(`     大小 ${(fs.statSync(tgzPath).size / 1024).toFixed(1)} KB`);

  if (tarballOk) {
    const ex = path.join(tmp, "x");
    fs.mkdirSync(ex, { recursive: true });
    execFileSync("tar", ["-xzf", tgzPath, "-C", ex], { encoding: "utf8" });
    const pkgDir = path.join(ex, "package");

    console.log(`\n═══ ③ 包内 README 是对外版 ═══`);
    const readme = fs.readFileSync(path.join(pkgDir, "README.md"), "utf8");
    // ★★ 这里踩过一次「尺子太粗」，记清楚：
    //   第一版把 `_probe` 整个列进"内部用语"⇒ **误报**。
    //   实际那句话是 README 里**故意写的一句用户指引**（:97-100）：
    //     「本仓库里另有一个只读诊断 node tools/_probe-install-version.mjs。
    //       ⚠️ 它只在本仓库里有、不在 npm 包里 —— 整个 tools/ 目录都不发」
    //   ⇒ 它不但不是泄漏，**恰恰是"讲清楚什么不在包里"的那句话**。
    //   判据的问题在于：**"出现内部文件名" ≠ "内部用语泄漏"**。
    //   ⇒ 改成只查**真正不该出现的**：私有路径、待办标记、本机自述。
    //   （文件名本身不判 —— 它可能正被用来告诉用户"这个不在包里"。）
    const INTERNAL = ["C:\\Users\\", "D:\\Deepseek工作区", "TODO", "FIXME", "本机上我", "我自己"];
    const hits = INTERNAL.filter((x) => readme.includes(x));
    ok("③ README 不含私有路径/待办标记/本机自述", hits.length === 0, hits.join(", "));
    ok("③ b README 提到了本版新能力（两段式检索）", readme.includes("mode:\"index\"") || readme.includes("两段式"));
    // ★ 反向：若 README 提到 tools/ 里的脚本，必须同时说清"它不在包里"
    //   （否则用户会去自己机器上找一个不存在的文件）
    if (readme.includes("tools/")) {
      const explains = /不在\s*npm\s*包里|整个\s*`?tools\/`?\s*目录都不发|只在本仓库里有/.test(readme);
      ok("③ c README 提到 tools/ 时，必须说明它不在发布包里", explains);
    }

    console.log(`\n═══ ④ 包内源码逐字节相同 ═══`);
    let compared = 0;
    const bad = [];
    for (const f of fs.readdirSync(path.join(pkgDir, "lib"))) {
      if (!f.endsWith(".js")) continue;
      const a = createHash("sha256").update(fs.readFileSync(path.join(pkgDir, "lib", f))).digest("hex");
      const b = createHash("sha256").update(fs.readFileSync(path.join(ROOT, "lib", f))).digest("hex");
      compared += 1;
      if (a !== b) bad.push(f);
    }
    ok(`④ 包内 ${compared} 个 lib 文件与磁盘逐字节相同`, compared > 0 && bad.length === 0, bad.join(", "));

    console.log(`\n═══ ⑤ 本版改动确实在包里 ═══`);
    const p1 = fs.readFileSync(path.join(pkgDir, "lib/part1.js"), "utf8");
    const p5 = fs.readFileSync(path.join(pkgDir, "lib/part5.js"), "utf8");
    ok("⑤ A：eventTextOf（两段式共用的尺子）在包里", p1.includes("function eventTextOf"));
    ok("⑤ A：readSessionIndex 在包里", p1.includes("export function readSessionIndex"));
    ok("⑤ A：readSessionPicked 在包里", p1.includes("export function readSessionPicked"));
    ok("⑤ A：工具说明带 TWO-STAGE USE", p5.includes("TWO-STAGE USE"));
    ok("⑤ C：done 词表含「已作废」", p1.includes("\\u5df2\\u4f5c\\u5e9f"));
    ok("⑤ C：done 词表仍含旧词「已完成」", p1.includes("\\u5df2\\u5b8c\\u6210"));
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    ok(`⑤ b 包内 version = ${pkgJson.version}`, pkgJson.version === VER);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${"═".repeat(60)}`);
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
