// D221 · 把探针里**硬编码的本机用户名**改成按环境变量拼（与 `_probe-d221-asar-*.mjs` 同口径）
//
// ★ 为什么必须做：`tools/` 是**公开仓库**的一部分（184 个探针已被跟踪）。
//   本机硬规矩：**never write real values (username / session id / real paths) to tools/**。
//   ⚠️ 诚实边界：`_probe-d217-extract-kernel.mjs` 与 `-find-kernel.mjs` 的**历史提交里已经有**
//     这个用户名 —— 改写工作区**抹不掉已发布的历史**。这里做的是"**从今往后干净**"，
//     不是"历史干净"（后者要重写公开历史，代价远大于收益，不做）。
//
// 用法：node tools/_probe-d221-fix-paths.mjs [--apply]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

const FILES = [
  "_probe-d217-extract-kernel.mjs",
  "_probe-d217-find-kernel.mjs",
  "_probe-d219-read-slots.mjs",
  "_probe-d219-who-provides-slots.mjs",
  "_probe-d219-boot-crash.mjs",
];

// 旧写法：`const ASAR = "C:/Users/<名>/AppData/..."`（本机用户名照字面写在源码里）
const OLD_RE = /const ASAR = "C:\/Users\/[^/"]+\/AppData\/Local\/Programs\/DeepSeek Harness\/resources\/app\.asar";/;

const NEW = [
  "// ★ 隐私（D221）：**绝不把真实用户名写进 tools/**（它是 PUBLIC 的）。",
  "//   路径按环境变量拼 ⇒ 任何人的机器上都能解析，且源码里没有本机专有信息。",
  "const ASAR = path.join(",
  "  process.env.LOCALAPPDATA ?? \"\",",
  "  \"Programs\", \"DeepSeek Harness\", \"resources\", \"app.asar\"",
  ");",
].join("\n");

let changed = 0;
for (const f of FILES) {
  const p = path.join(HERE, f);
  if (!fs.existsSync(p)) {
    console.log(`  ⏭ ${f}（不存在）`);
    continue;
  }
  let s = fs.readFileSync(p, "utf8");
  if (!OLD_RE.test(s)) {
    console.log(`  ⏭ ${f}（没有硬编码用户名）`);
    continue;
  }
  s = s.replace(OLD_RE, NEW);
  // 确保有 `path` 的 import（这些文件原来只用 fs）
  if (!/^import path from "node:path";/m.test(s)) {
    if (/^import fs from "node:fs";/m.test(s)) {
      s = s.replace('import fs from "node:fs";', 'import fs from "node:fs";\nimport path from "node:path";');
    } else {
      s = 'import path from "node:path";\n' + s;
    }
  }
  if (APPLY) {
    fs.writeFileSync(p, s, "utf8");
    console.log(`  ✅ ${f}`);
  } else {
    console.log(`  （dry-run）${f}`);
  }
  changed += 1;
}
console.log(`\n${APPLY ? "已改" : "待改"} ${changed} 个文件`);
if (!APPLY) console.log("（dry-run —— 加 --apply 才真的写）");
