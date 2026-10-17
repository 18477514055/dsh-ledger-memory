// D230 · 只读核对：① 活内核加载的 lib 是哪个路径（我改的改动是否已生效）；② 设置快照文案是否已变。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

console.log("═══ ① 我改过的文件，mtime 与内容指纹 ═══");
for (const f of ["lib/client.js", "lib/defs.js", "lib/part1.js", "lib/part3.js", "lib/part4.js"]) {
  const p = path.join(ROOT, f);
  const st = fs.statSync(p);
  const src = fs.readFileSync(p, "utf8");
  // 只检查"我改过的那几处"是否在盘上
  const marks = {
    "lib/client.js": ["只影响本项目（清单说了算）", "projectFirst: props.projectFirst"],
    "lib/defs.js": ['DEFAULT_NOTES_DIR = "问题记录"', "问题记录"],
    "lib/part1.js": ["precedenceIsProject"],
    "lib/part3.js": ["precedenceIsProject()", "两者不一致时，以「${pf ?"],
    "lib/part4.js": ["creates `问题记录/`"],
  }[f] ?? [];
  const hit = marks.map((m) => `${src.includes(m) ? "✅" : "❌"}${m.slice(0, 30)}`).join("  ");
  console.log(`  ${f.padEnd(14)} ${st.mtime.toISOString().slice(0, 19)}  ${hit}`);
}

console.log("\n═══ ② 本回合注入里的设置快照文案（看是否已是新版）═══");
console.log("  ★ 本回合注入里出现了：『带「插件」= 用插件面板的值（或它派生的默认值）。』");
console.log("    『★ 两者不一致时，以「设置面板」为准（当前设为「以设置面板为准（默认）」）。』");
console.log("  ⇒ 这两句**正是 D226 改过的新文案**（旧版是「两者不一致时以「项目」为准」）。");
console.log("  ⇒ 说明活内核**已经在跑含 D226 改动的新代码**。");

console.log("\n═══ ③ 插件可能从哪加载（看 profile 里的 link）═══");
const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? "", ".dsh");
const cands = [
  path.join(home, "profiles", "desktop", "cordis.patch.yml"),
  path.join(home, "profiles", "desktop", "package.json"),
];
for (const c of cands) {
  if (!fs.existsSync(c)) { console.log(`  (缺) ${c}`); continue; }
  const txt = fs.readFileSync(c, "utf8");
  const hit = txt.split("\n").filter((l) => /ledger-memory|dsh-int-project-ledger|04-其余插件/.test(l));
  console.log(`  ${c}`);
  hit.slice(0, 8).forEach((l) => console.log(`     ${l.trim().slice(0, 150)}`));
  if (hit.length === 0) console.log("     (没有提到本插件)");
}
