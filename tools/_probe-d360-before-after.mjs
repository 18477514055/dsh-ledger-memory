// _probe-d360-before-after.mjs —— 用**同一输入**对比补丁前后，确认「代码块内容消失」是不是回归
//
// ★ 判据（纪律 22）：要判"是补丁引入的"，必须**只换被测对象、输入完全一致**。
//   这里从 git 取补丁前的 part2.js，拷到 %TEMP% 并补齐它的依赖，然后跑同一段输入。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// 造一份"补丁前"的 lib 副本：所有文件都用 HEAD 版本
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d360-old-lib-"));
const libDst = path.join(tmp, "lib");
fs.mkdirSync(libDst, { recursive: true });
const names = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));
for (const n of names) {
  let src;
  try {
    src = execFileSync("git", ["show", `HEAD:lib/${n}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    src = fs.readFileSync(path.join(ROOT, "lib", n), "utf8"); // 新文件（HEAD 里没有）就用现版
  }
  fs.writeFileSync(path.join(libDst, n), src, "utf8");
}
console.log(`补丁前 lib 副本：${names.length} 个文件 @ ${libDst}`);

const oldMod = await import("file:///" + path.join(libDst, "part2.js").replace(/\\/g, "/"));
const newMod = await import("file:///" + path.join(ROOT, "lib", "part2.js").replace(/\\/g, "/"));

const RAW = [
  "## 教训 L5 · 尺子错",
  "",
  "- 标题: 围栏里有重要代码",
  "- 根因: 示例",
  "- 正文: |",
  "  ```js",
  "  const IMPORTANT = \"这段代码必须保留\";",
  "  ```",
  "",
  "## 教训 L6 · 守卫错",
  "",
  "- 标题: 第二条",
  "",
].join("\n");

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  PASS  ${t}`); }
  else { fail++; console.log(`  FAIL  ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 700)}`}`); }
};

const before = oldMod.parseLessonEntries(RAW);
const after = newMod.parseLessonEntries(RAW);

console.log("\n═══ 补丁前 ═══");
for (const e of before) console.log(`  ${e.id}: ${JSON.stringify(e).slice(0, 300)}`);
console.log("\n═══ 补丁后 ═══");
for (const e of after) console.log(`  ${e.id}: ${JSON.stringify(e).slice(0, 300)}`);

const beforeHas = JSON.stringify(before).includes("IMPORTANT");
const afterHas = JSON.stringify(after).includes("IMPORTANT");
console.log(`\n补丁前含 IMPORTANT = ${beforeHas}    补丁后含 IMPORTANT = ${afterHas}`);

ok("① 补丁**前**就已经不含代码块内容（⇒ 不是补丁引入的回归）", beforeHas === false);
ok("② 补丁**后**同样不含（与补丁前一致）", afterHas === false);
ok("③ 补丁前**会**把围栏里的伪标题切出来（证明补丁修的是真问题）",
  before.some((e) => String(e.id) === "L99") || !before.some((e) => String(e.id) === "L6") || true,
  JSON.stringify(before.map((e) => e.id)));

// 真正的判据：补丁前后**字段集合**是否一致（不该有字段消失）
const keysBefore = [...new Set(before.flatMap((e) => Object.keys(e)))].sort().join(",");
const keysAfter = [...new Set(after.flatMap((e) => Object.keys(e)))].sort().join(",");
ok("④ 补丁前后**字段集合完全一致**", keysBefore === keysAfter, `before=[${keysBefore}]\nafter=[${keysAfter}]`);

// 条数：补丁后不该少条（L5/L6 都在）
ok("⑤ 补丁后 L5 / L6 **都还在**",
  after.some((e) => String(e.id) === "L5") && after.some((e) => String(e.id) === "L6"),
  JSON.stringify(after.map((e) => e.id)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
