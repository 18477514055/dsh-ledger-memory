// ═══════════════════════════════════════════════════════════════════════════
// D216 · 把每个 permission 信号**定位到具体行**（才知道能不能改）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么要定位到行：上面已经证明**信号本身不是硬墙**（32 个已上架里 29 个是
//   `user-reviewed`；`dsh-cache-stabilizer`/`dsh-recall-plugin` 这些必然用文件系统的
//   也上架了）⇒ **不必为了躲信号去改代码**（那会伤功能）。
//   ★ 但仍有**两个**理由需要这张表：
//     ① 若某个信号是**误报**（比如注释、字符串里的 `exec(`），那值得**顺手修掉** ——
//        减少人工审核要看的面积；
//     ② 若某个信号来自**测试/构建残留**（不该在包里），那是**真该修**的。
//
// 用法：node tools/_probe-d216-signal-lines.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { permissionSignals } from "../_store-research/automation-source-policy.mjs";

const REPO = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账";
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

// 与官方一致的候选集合：files 白名单里的可扫源码
const roots = ["lib", "cordis.patch.yml", "README.md"];
const files = [];
for (const r of roots) {
  const p = path.join(REPO, r);
  if (!fs.existsSync(p)) continue;
  const st = fs.statSync(p);
  if (st.isFile()) files.push(r);
  else {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name);
        if (fs.statSync(q).isDirectory()) walk(q);
        else if (/\.(?:[cm]?[jt]sx?|[cm]?ts)$/i.test(e.name)) files.push(path.relative(REPO, q).split(path.sep).join("/"));
      }
    };
    walk(p);
  }
}

/** 官方的判据（照 `permissionSignals` 抄一份**只为定位**用；认定仍以官方函数为准）。 */
const CHECKS = [
  ["files", /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?:node:)?(?:fs|fs\/promises)["']/i],
  ["files", /\b(?:readFile|writeFile|appendFile|rename|unlink|mkdir|rmdir|rm)\s*\(/i],
  ["files", /\bprocess\s*\.\s*env\s*\.\s*DSH_HOME\b/i],
  ["network", /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?:node:)?(?:http|https|net|tls|dgram|axios|got|undici)["']/i],
  ["network", /\b(?:fetch|WebSocket|EventSource)\s*\(/i],
  ["network", /\b(?:axios|got|undici)\s*(?:\.|\()/i],
  ["commands", /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?:node:)?child_process["']/i],
  ["commands", /(?:^|[^\w$.'"`])(?:exec|execFile|spawn|fork)\s*\(/im],
  ["commands", /shell\s*:\s*true|Bun\.spawn|new\s+Deno\.Command/i],
  ["credentials", /process\s*\.\s*env/i],
  ["credentials", /\b(?:keychain|credentials?|oauth)\b\s*(?:\.|\[|\()/i],
  ["credentials", /\b(?:api[_-]?key|apiKey|access[_-]?token|accessToken|client[_-]?secret|clientSecret|password)\b/i],
];

console.log(`候选文件 ${files.length} 个\n`);
const summary = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(REPO, f), "utf8");
  const lines = src.split("\n");
  const official = permissionSignals(src, f);
  const hits = Object.entries(official).filter(([, v]) => v === true).map(([k]) => k);
  console.log(`── ${f}（官方：${hits.join(", ") || "无"}）──`);
  for (const key of hits) {
    // 逐行找该信号的触发行（**用官方同一个函数判每行**，不重抄判据）
    const found = [];
    for (let i = 0; i < lines.length; i += 1) {
      const one = permissionSignals(lines[i], f);
      if (one[key] === true) found.push(i + 1);
    }
    summary[key] = (summary[key] ?? 0) + found.length;
    console.log(`   ${key}: ${found.length} 行`);
    for (const ln of found.slice(0, 6)) {
      console.log(`      L${ln}: ${lines[ln - 1].trim().slice(0, 110)}`);
    }
    if (found.length > 6) console.log(`      …(+${found.length - 6} 行)`);
  }
  console.log("");
}

console.log("═══ 汇总：每个信号的触发行数 ═══");
for (const [k, v] of Object.entries(summary).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v} 行`);
