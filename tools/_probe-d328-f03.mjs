// D328：核 010 的 F-03 —— 「模板空置判据过宽」到底能不能吃掉用户数据？
// 判据：造一个**单文件模式**的扩展，模板之外只写**一行真实内容**（总非空行 ≤ 6），
//       然后看 extUsageOf 是否判为 hasContent:false（= 免确认可删）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const part8 = await import(pathToFileURL(path.join(ROOT, "lib", "part8.js")).href);

/** 只测 extUsageOf（纯函数 + 读盘），不需要建完整项目。 */
function mkDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "d328-" + tag + "-"));
  return d;
}

// 模拟「单文件模式的模板 + 用户写的一行真实内容」
function templatePlus(userLine) {
  return [
    "> **自定义扩展记忆** · 测试",
    "",
    "---",
    "",
    userLine,
    "",
  ].join("\n");
}

const mode = { storage: "file", file: "NOTES.md" };

console.log("═══ A. 只有模板（应当 hasContent:false）═══");
{
  const d = mkDir("tpl");
  fs.writeFileSync(path.join(d, "NOTES.md"), templatePlus(""), "utf8");
  const u = part8.extUsageOf(d, mode);
  console.log(`  ${JSON.stringify(u)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("");
console.log("═══ B. 模板 + 一行真实内容（**应当 hasContent:true**）═══");
{
  const d = mkDir("one");
  const body = templatePlus("- 我的关键账号：user@example.com / 密码见保险箱");
  fs.writeFileSync(path.join(d, "NOTES.md"), body, "utf8");
  const nonEmpty = body.split("\n").filter((l) => l.trim() !== "").length;
  const u = part8.extUsageOf(d, mode);
  console.log(`  非空行 = ${nonEmpty}`);
  console.log(`  ${JSON.stringify(u)}`);
  console.log(`  ⇒ ${u.hasContent === true ? "✓ 判为有内容（正确）" : "⚠ **判为「只有模板」⇒ 免确认可删**"}`);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("");
console.log("═══ C. 模板 + 两行真实内容（非空行 7 ⇒ 应当安全）═══");
{
  const d = mkDir("two");
  const body = [
    "> **自定义扩展记忆** · 测试",
    "",
    "---",
    "",
    "- 第一行真实内容",
    "- 第二行真实内容",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(d, "NOTES.md"), body, "utf8");
  const nonEmpty = body.split("\n").filter((l) => l.trim() !== "").length;
  const u = part8.extUsageOf(d, mode);
  console.log(`  非空行 = ${nonEmpty} ⇒ ${JSON.stringify(u)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("");
console.log("═══ D. 真模板长什么样（从 createExtension 的渲染处取）═══");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "part8.js"), "utf8");
  const i = src.indexOf("自定义扩展记忆");
  console.log(src.slice(Math.max(0, i - 700), i + 500));
}
console.log("PROBE-COMPLETE");
