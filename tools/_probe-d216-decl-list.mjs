// 打印顶层声明清单（按字节降序）+ 每条的出度，供人工装箱。
import fs from "node:fs";
import path from "node:path";
const decls = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tools", "_d216-decls.json"), "utf8"));
const args = process.argv.slice(2);
const mode = args[0] ?? "big";

if (mode === "big") {
  const sorted = [...decls].sort((a, b) => b.bytes - a.bytes);
  console.log("按字节降序（前 40）：");
  for (const r of sorted.slice(0, 40)) {
    console.log(
      `  L${String(r.line).padStart(5)}-${String(r.end).padStart(5)}  ${String(r.bytes).padStart(7)} B  ${r.kind.padEnd(8)} ${r.name.padEnd(42)} out=${String(r.refs.length).padStart(3)}`
    );
  }
  const sum = sorted.reduce((a, b) => a + b.bytes, 0);
  console.log(`\n声明合计 ${sum} B · 文件 ${fs.statSync(path.join(process.cwd(), "lib", "index.js")).size} B`);
} else if (mode === "all") {
  for (const r of decls) {
    console.log(`${String(r.bytes).padStart(7)}  ${r.kind.padEnd(8)} ${r.name.padEnd(42)} L${r.line}-${r.end}  refs=[${r.refs.join(",")}]`);
  }
} else if (mode === "gaps") {
  // 找"没有被任何声明覆盖"的行区间（文件头、分节注释、裸语句块）
  const cov = new Array(21236).fill(false);
  for (const r of decls) for (let i = r.line; i <= r.end; i += 1) cov[i] = true;
  let s = null;
  const gaps = [];
  for (let i = 1; i <= 21235; i += 1) {
    if (!cov[i]) {
      if (s === null) s = i;
    } else if (s !== null) {
      gaps.push([s, i - 1]);
      s = null;
    }
  }
  if (s !== null) gaps.push([s, 21235]);
  let tot = 0;
  for (const [a, b] of gaps) {
    const t = Buffer.byteLength(
      fs.readFileSync(path.join(process.cwd(), "lib", "index.js"), "utf8").split("\n").slice(a - 1, b).join("\n"),
      "utf8"
    );
    tot += t;
  }
  console.log(`未覆盖行区间 ${gaps.length} 个，合计 ${tot} B`);
  for (const [a, b] of gaps.slice(0, 40)) console.log(`  L${a}-${b}`);
}
