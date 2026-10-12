/**
 * ★★★ 关键验证：**模拟"用户装包后"的目录**，跑一遍自检。
 *
 * ★ 为什么必须做（这是我自己刚引入的一个**只会在发布包里暴露**的风险）：
 *   我把"会改写源码的探针"守卫改成**扫 tools/ 目录**，并加了一条自证断言「扫到数 ≥1，否则红」。
 *   但发布出去的包 `files` 白名单**只有 `tools/selftest.mjs`** ⇒ 用户那边 `tools/` 里
 *   **只有 selftest 自己** ⇒ 扫到 **0** ⇒ ★ **我的自证断言会在用户机器上报红**。
 *   ⇒ 那是"**装上即坏**"级别的错（用户看到测试失败，其实代码是好的）。
 *
 * ★ 本脚本：把项目按 `files` 白名单**复制成一个模拟包**，在那里跑自检。
 *   ★ 判据：模拟包里**必须 0 失败**；若红，就是我引入了发布期缺陷。
 *   ★ 只读源、只写 %TEMP%，跑完删掉临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SRC = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const DST = path.join(os.tmpdir(), "sim-pkg-ledger");

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });

// 按 package.json 的 files 白名单复制（与真实发包一致）
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8"));
const files = pkg.files ?? [];
console.log(`files 白名单 = ${JSON.stringify(files)}`);
for (const f of files) {
  const from = path.join(SRC, f);
  const to = path.join(DST, f);
  if (!fs.existsSync(from)) {
    console.log(`  ⚠ 白名单里的 ${f} 源不存在`);
    continue;
  }
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.cpSync(from, to, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  console.log(`  已复制 ${f}`);
}
// selftest 需要能读到 lib（已在白名单里）；另外它可能读 package.json
// ★★★ 而我第一版**漏了 package.json** ⇒ 自检在模拟包里 **ENOENT 崩掉**
//   ⇒ 于是"红 0 条"是**因为脚本没跑起来**，不是通过 —— ★ 又一次"夹具没走通却被当成结论"
//   （纪律 6）。⇒ package.json 是 npm 包**必然包含**的文件（不受 files 白名单限制），必须补上。
fs.copyFileSync(path.join(SRC, "package.json"), path.join(DST, "package.json"));
console.log("  已复制 package.json（npm 包必含，不受 files 限制）");
console.log(`\n模拟包：${DST}`);
console.log(`  tools/ 里实际有：${JSON.stringify(fs.readdirSync(path.join(DST, "tools")))}`);

// 跑自检
console.log(`\n=========== 在模拟包里跑自检 ===========`);
let out = "";
try {
  out = execFileSync(process.execPath, [path.join(DST, "tools", "selftest.mjs")], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: DST,
  });
} catch (e) {
  out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
}
const lines = out.split("\n");
const red = lines.filter((l) => /^\s*FAIL/.test(l));
console.log(`--- 红：${red.length} 条 ---`);
for (const r of red.slice(0, 15)) console.log("   " + r.trim().slice(0, 160));
for (const s of lines.filter((l) => /通过 \d+ 项/.test(l))) console.log("   " + s.trim());
for (const s of lines.filter((l) => /自发现扫到/.test(l))) console.log("   " + s.trim());

console.log(
  red.length === 0
    ? "\n⇒ ★ 结论：模拟包里**全绿** ⇒ 我的改动不会让用户装上即坏 ✅"
    : "\n⇒ ★★ 结论：模拟包里有红 ⇒ ★★★ **我引入了发布期缺陷，必须修**（用户那边 tools/ 只有 selftest）"
);
fs.writeFileSync(path.join(os.tmpdir(), "sim-pkg-output.txt"), out);
console.log(`（完整输出：${path.join(os.tmpdir(), "sim-pkg-output.txt")}）`);
