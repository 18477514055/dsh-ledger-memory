// D326：修 尺子错 #37 —— 我上一个探针问的是「有没有 export / import」，
// 而真正要问的是「这个名字在这个作用域里**有没有绑定**」。
// 局部 const/function 既不需要 export 也不需要 import。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(path.resolve(here, ".."), "lib");

/** 某文件里这个名字是否「可解析」（本地定义 / import 进来 / 具名导出都算）。 */
function hasBinding(src, name) {
  const n = name.replace(/[$]/g, "\\$");
  if (new RegExp(`(?:^|[\\s;{(])(?:async\\s+)?function\\*?\\s+${n}\\s*\\(`, "m").test(src)) return "local-fn";
  if (new RegExp(`(?:^|[\\s;{(])(?:const|let|var)\\s+${n}\\s*=`, "m").test(src)) return "local-const";
  // import { a, b as c } from "..."
  for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (t === "") continue;
      const asM = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      if ((asM !== null ? asM[1] : t) === name) return "import-named";
    }
  }
  if (new RegExp(`import\\s+\\*\\s+as\\s+${n}\\b`).test(src)) return "import-ns";
  if (new RegExp(`import\\s+${n}\\s+from`).test(src)) return "import-default";
  return "NO-BINDING";
}

let pass = 0, fail = 0;
const ok = (t, c) => {
  if (typeof c !== "boolean") throw new TypeError("ok() 第二参必须是布尔：" + t);
  if (c) { pass++; console.log("PASS  " + t); } else { fail++; console.log("FAIL  " + t); }
};

// 008 补丁在 part7 / part5 里用到的每一个名字，逐个查「可解析」
const CASES = [
  ["part7.js", "checkNoNestedSymlink", "补丁 L243/L168 用到"],
  ["part7.js", "listFiles", "补丁 L260 用到"],
  ["part7.js", "isUnderReal", "补丁 L243 用到"],
  ["part7.js", "hashOf", "原有"],
  ["part7.js", "expected", "原有"],
  ["part5.js", "findWorkspaceRoot", "补丁新加 import（补丁 L158）"],
  ["part5.js", "isUnderReal", "补丁 L160 用到"],
  ["part5.js", "armReinject", "补丁 L197 用到（本文件定义）"],
  ["part5.js", "setAnchor", "补丁 L195 用到"],
  ["part5.js", "recordShadowedIndex", "补丁 L199 用到"],
  ["part5.js", "capsulePathFor", "补丁 L200 用到"],
  ["part5.js", "captureCapsuleBeforeCompact", "补丁 L186 用到"],
  ["part2.js", "bumpRevision", "补丁新加 import（补丁 L10）"],
  ["part2.js", "countLines", "补丁 L31 用到"],
];

for (const [file, name, why] of CASES) {
  const src = fs.readFileSync(path.join(libDir, file), "utf8");
  const how = hasBinding(src, name);
  ok(`${file} 里 \`${name}\` 可解析（${how}）—— ${why}`, how !== "NO-BINDING");
}

// 尺子自检：造一个确实不存在的名字，必须报 NO-BINDING
const src1 = fs.readFileSync(path.join(libDir, "part5.js"), "utf8");
ok("尺子自检：part5.js 里 __NO_SUCH__ 报 NO-BINDING", hasBinding(src1, "__NO_SUCH__") === "NO-BINDING");

console.log("");
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
