/**
 * ★ 只读：量 desktop profile 的 node_modules 到底多大（决定镜像怎么建）。
 *
 * ★ 为什么不用 PowerShell：`-$_.LinkType` 不是布尔（LinkType 是字符串 "Junction"），
 *   而且本机规矩是「判联接必须用 lstatSync 或 Dirent，statSync 会跟随」。
 *   PowerShell 的 Get-ChildItem -Recurse 默认**跟随**联接 ⇒ 会量出荒谬的数字。
 */
import fs from "node:fs";
import path from "node:path";

const P = path.join(process.env.USERPROFILE, ".dsh", "profiles", "desktop");
const NM = path.join(P, "node_modules");

let realBytes = 0;
let realFiles = 0;
const links = [];

const walk = (dir, depth) => {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    // ★ lstat：绝不跟随联接
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      if (depth === 0) links.push(e.name);
      continue;
    }
    if (st.isDirectory()) { walk(full, depth + 1); continue; }
    if (st.isFile()) { realBytes += st.size; realFiles += 1; }
  }
};

walk(NM, 0);

console.log("═".repeat(80));
console.log("desktop/profile 体量（**不跟随联接**，lstat 口径）");
console.log("═".repeat(80));
console.log(`  真文件数      : ${realFiles.toLocaleString()}`);
console.log(`  真字节        : ${realBytes.toLocaleString()} B  ≈ **${(realBytes / 1048576).toFixed(1)} MB**`);
console.log(`  顶层联接      : ${links.length} 条`);
for (const l of links) console.log(`      · ${l}`);

// profile 根下的散件
let rootBytes = 0;
for (const e of fs.readdirSync(P, { withFileTypes: true })) {
  if (e.name === "node_modules") continue;
  const full = path.join(P, e.name);
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink()) { console.log(`  [根·联接] ${e.name}`); continue; }
  if (st.isFile()) rootBytes += st.size;
}
console.log(`  profile 根散件: ≈ ${(rootBytes / 1024).toFixed(1)} KB`);

console.log("\n" + "═".repeat(80));
console.log("镜像怎么建（三个选项）");
console.log("═".repeat(80));
console.log(`  A. 全量复制 node_modules        : 复制 ${(realBytes / 1048576).toFixed(0)} MB，慢但最干净`);
console.log(`  B. 只复制根散件 + 联接 node_modules : 复制 ~${(rootBytes / 1024).toFixed(0)} KB，node_modules 用 Junction 指回真的`);
console.log(`     ⚠️ 风险：dsh 若往 profile 里写东西，经 Junction 会**写到真 node_modules**`);
console.log("     ⇒ 但 `--dump-config` 的文档原话是「print the composed profile tree and exit」");
console.log("  C. 沙箱 DSH_HOME + B             : 再套一层，dsh 的所有写入都落在沙箱里");
console.log("     ⇒ 真树唯一接触面 = 那一个只读用的 Junction");
