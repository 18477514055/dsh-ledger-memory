// 诊断：为什么 part1.js 缺 DEFAULT_LOG_LEVELS 的 import？
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const lines = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8").split("\n");
const g = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "_d216-graph.json"), "utf8"));
const decls = g.decls;
const d = decls.find((x) => x.name === "settingDefaults");
const body = lines.slice(d.line - 1, d.end).join("\n");

const strip = (t) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");

console.log("settingDefaults  L" + d.line + "-" + d.end + "  " + d.bytes + "B");
console.log("graph 里它的 refs 是否含 DEFAULT_LOG_LEVELS：", d.refs.includes("DEFAULT_LOG_LEVELS"));
console.log("refs =", d.refs.join(", "));

const iRaw = body.indexOf("DEFAULT_LOG_LEVELS");
console.log("\n原文里第一次出现位置：", iRaw);
if (iRaw >= 0) console.log("  周围：", JSON.stringify(body.slice(Math.max(0, iRaw - 130), iRaw + 45)));

const st = strip(body);
console.log("\nstrip 之后还有：", st.includes("DEFAULT_LOG_LEVELS"));

// 逐行找它在哪一行，看看是不是在注释里
console.log("\n逐行（含该名字的行）：");
for (let k = 0; k < lines.length; k += 1) {
  if (k + 1 >= d.line && k + 1 <= d.end && lines[k].includes("DEFAULT_LOG_LEVELS")) {
    console.log(`  L${k + 1}: ${lines[k]}`);
  }
}

// ★ 关键：检查模块级 refs 用的判据是否与这里一致
const nameSet = new Set(decls.map((x) => x.name));
console.log("\n名称集合里有 DEFAULT_LOG_LEVELS：", nameSet.has("DEFAULT_LOG_LEVELS"));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(`(?<![\\w$.])${esc("DEFAULT_LOG_LEVELS")}(?![\\w$])`);
console.log("在 strip(body) 上测试正则：", re.test(st));

// 检查其它模块是否引用了它（回退：全局扫）
console.log("\n其它声明里引用 DEFAULT_LOG_LEVELS 的（前 20）：");
let n = 0;
for (const x of decls) {
  if (x.refs.includes("DEFAULT_LOG_LEVELS")) {
    console.log(`  ${x.name} (L${x.line})`);
    n += 1;
    if (n >= 20) break;
  }
}
console.log(`共 ${decls.filter((x) => x.refs.includes("DEFAULT_LOG_LEVELS")).length} 条`);
