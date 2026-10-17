/**
 * ★ 反向验证（D208）：把"设置快照"从注入里摘掉 ⇒ 89⑫ 必须见红。
 * ★ 纪律 10：摘不到能看见红为止 = 那条断言是空的。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

function clone(tag) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), `d208rev-${tag}-`));
  fs.cpSync(path.join(ROOT, "lib"), path.join(dst, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dst, "tools"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "tools", "selftest.mjs"), path.join(dst, "tools", "selftest.mjs"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dst, "package.json"));
  return dst;
}
function run(dir) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(dir, "tools", "selftest.mjs")], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String((e && e.stdout) || "") + String((e && e.stderr) || "");
  }
  const m = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
  return { pass: m === null ? -1 : Number(m[1]), fail: m === null ? -1 : Number(m[2]), out, ran: m !== null };
}
/** ★ L34：**"没跑完"不等于"没红"** —— 必须分开判。 */
const fof = (out) => out.split(/\r?\n/).filter((l) => /FAIL .*89⑫/.test(l)).map((l) => l.trim());

const results = [];
{
  const d = clone("base");
  const r = run(d);
  results.push({ label: "基线（不改）", pass: r.pass, fail: r.fail, hit: fof(r.out).length, ran: r.ran });
  fs.rmSync(d, { recursive: true, force: true });
}
{
  const d = clone("nosnap");
  const p = path.join(d, "lib", "index.js");
  let s = fs.readFileSync(p, "utf8");
  // ★ 摘掉的写法必须**保持语法合法**（否则自检会崩，而"崩了"与"绿了"在计数上无法区分 —— L27）。
  //   两处调用的形状不同，分别处理：
  //   ① tail 里：`renderSettingsSnapshot(info);` + 换行 + `);`  ⇒ 换成空语句（去掉那行）
  //   ② 短注入里：`+ renderSettingsSnapshot(info)` ⇒ 换成空串
  const before1 = (s.match(/renderSettingsSnapshot\(info\);/g) ?? []).length;
  const before2 = (s.match(/renderSettingsSnapshot\(info\)$/gm) ?? []).length;
  // ★ L34：**摘掉链式表达式里的项，必须换成空串，不能整行删** ——
  //   这两处都是 `+` 字符串链的最后一项；删行会让上一行的 `+` **悬空** ⇒ 语法坏 ⇒ 自检崩，
  //   而"崩了"与"绿了"在 FAIL 计数上**完全一样**。
  s = s.replace(/renderSettingsSnapshot\(info\);/g, '"";');
  s = s.replace(/renderSettingsSnapshot\(info\)$/gm, '""');
  const after = (s.match(/renderSettingsSnapshot\(info\)/g) ?? []).length - 2; // 减去定义 + __test 导出
  fs.writeFileSync(p, s, "utf8");
  // ★ 先校验替换后的源码**语法合法**（否则下面的"见红"毫无意义）
  let syntaxOk = true;
  try {
    execFileSync(process.execPath, ["--check", p], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    syntaxOk = false;
  }
  const r = run(d);
  results.push({
    label: `摘掉快照（剩下 2 处 = 定义+导出；调用应为 0，实为 ${Math.max(0, after)}）`,
    pass: r.pass, fail: r.fail, hit: fof(r.out).length, ran: r.ran && syntaxOk,
  });
  fs.rmSync(d, { recursive: true, force: true });
}
console.log("═══ D208 反向验证：摘掉「设置快照」⇒ 89⑫ 必须见红 ═══");
for (const r of results) {
  // ★ L34：先判"自检到底跑完了没" —— 崩了与绿了长得一样，必须先分开。
  if (!r.ran) {
    console.log(`  ${r.label}: ❌ **自检没跑完（脚本坏了）** —— 这一项无效，必须修脚本重跑（不是"没红"）`);
    continue;
  }
  const v = r.label.startsWith("基线")
    ? r.hit === 0 ? "✅ 基线全绿（对照成立）" : "❌ 基线本来就红"
    : r.hit > 0 ? `✅ 见红 ${r.hit} 条` : "❌ **仍然全绿** ⇒ 断言是空的，必须查清";
  console.log(`  ${r.label}: 通过=${r.pass} 失败=${r.fail} · 89⑫失败=${r.hit}  ${v}`);
}
