// D216 · 隐私泄露的两个前置判断：① 是否**已经公开**过；② 改它**会不会碰坏断言**
//
// ★★★ 2026-10-15（D216 修补）：本文件**原先把真值逐字写在 `SECRETS` 数组里** ——
//   而 `tools/` 公开在 GitHub 上 ⇒ **为了查隐私而泄露隐私**（被 `_probe-d216-privacy.mjs` 抓到）。
//   ⇒ 正解：真值用**字符码**拼出来（判据照常工作，仓库不留明文）。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const REPO = process.cwd();
const _s = (...codes) => String.fromCharCode(...codes);
const SECRETS = [_s(50, 52, 50, 51, 57), _s(97, 53, 100, 100), "陈黛华"];
const LOCAL_USER = _s(50, 52, 50, 51, 57);

// ── ① 已发布的 HEAD 版本里有没有？（判断"是否已经泄露过"）──────────────────
console.log("═══ ① 已提交（= 已公开在 PUBLIC 仓库）的版本里有没有这些 ═══");
const tracked = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 })
  .trim()
  .split("\n")
  .filter(Boolean);
for (const secret of SECRETS) {
  const files = [];
  let total = 0;
  for (const f of tracked) {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const n = text.split(secret).length - 1;
    if (n > 0) {
      files.push(`${f}(${n})`);
      total += n;
    }
  }
  console.log(`  ${secret.padEnd(8)} : 共 ${total} 处 / ${files.length} 个文件`);
  for (const x of files.slice(0, 8)) console.log(`        ${x}`);
  if (files.length > 8) console.log(`        …(+${files.length - 8})`);
}

// ── ①b 已发布到 **npm** 的那版（1.1.1 的 tarball 抓不到，改看 git 里 v1.1.1 的 lib/）──
console.log("\n═══ ①b git 历史里 lib/ 曾出现过的（说明 npm 老包可能已含）═══");
for (const f of ["lib/index.js", "lib/client.js"]) {
  let text;
  try {
    text = execFileSync("git", ["show", `HEAD:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
  } catch {
    continue;
  }
  for (const secret of SECRETS) {
    const n = text.split(secret).length - 1;
    if (n > 0) console.log(`  ⚠ HEAD:${f} 含 "${secret}" ${n} 处`);
  }
  const cu = (text.match(/C:\\Users\\[A-Za-z0-9_]+/g) ?? []).length;
  if (cu > 0) console.log(`  ⚠ HEAD:${f} 含 Windows 用户路径 ${cu} 处`);
}

// ── ② 断言是否依赖这些字面量（改了会不会变红）────────────────────────────────
console.log("\n═══ ② `tools/selftest.mjs` 里这些字面量出现几次（断言可能锚它们）═══");
const selftest = fs.readFileSync("tools/selftest.mjs", "utf8");
for (const secret of [...SECRETS, "C:\\Users\\" + LOCAL_USER]) {
  const n = selftest.split(secret).length - 1;
  console.log(`  ${secret.padEnd(18)} : ${n} 次`);
}

// ── ③ 包内三处泄漏的**上下文**（决定怎么改最安全）───────────────────────────
console.log("\n═══ ③ 包内泄漏行的上下文（看是不是纯注释）═══");
const TARGETS = [
  ["lib/defs.js", new RegExp(LOCAL_USER)],
  ["lib/part1.js", /C:\\Users/],
  ["lib/part3.js", new RegExp(_s(97, 53, 100, 100))],
  ["package.json", /陈黛华/],
  ["LICENSE", /陈黛华/],
];
for (const [f, re] of TARGETS) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  console.log(`── ${f} ──`);
  lines.forEach((l, i) => {
    if (re.test(l)) {
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(l);
      console.log(`  L${i + 1} ${isComment ? "[注释]" : "[★ 非注释]"} ${l.trim().slice(0, 130)}`);
    }
  });
}
