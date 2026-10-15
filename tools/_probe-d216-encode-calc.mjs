// D216 · 为"清掉本机路径"算出**替换后用哪个编码值**（用被测函数自己算，不手推）
import { pathToFileURL } from "node:url";
import path from "node:path";
const mod = await import(pathToFileURL(path.join(process.cwd(), "lib", "index.js")).href);
const enc = mod.__test.encodeSessionDirName;

const CANDIDATES = [
  // 拟替换掉的本机路径 → 用别的"同形状"例子（仍能测同一条编码规则）
  "D:\\Example工作区",
  "D:\\Example工作区\\20-DSH插件",
  "D:\\Example工作区\\20-DSH插件\\04-其余插件\\10.项目台账",
  "C:\\Users\\Example\\Documents\\deepseek\\harness\\default\\workspace",
  // 对照：确认与旧值同形状（旧值仍能算出来，说明函数没变）
  "D:\\Deepseek工作区",
  "D:\\Deepseek工作区\\20-DSH插件",
];
for (const c of CANDIDATES) {
  console.log(`${JSON.stringify(c)}\n   → ${JSON.stringify(enc(c))}`);
}
