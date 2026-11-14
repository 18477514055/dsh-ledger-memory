/**
 * D373 正式反向验证：6 处破坏，确认取证器 + 自检都见红。
 * ★ 用**加固之后**的自检（131⑮ b / 131⑰ a,b / 131⑯ b 都已补上调用点与可达性断言）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const runSelftest = () => {
  const call = () => execFileSync(process.execPath, ["tools/selftest.mjs"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  let out;
  try { out = call(); } catch (e) { out = String(e?.stdout ?? ""); }
  const m = /合计：PASS (\d+) · SKIP (\d+) · FAIL (\d+)/.exec(out);
  if (m === null) return { crash: true, pass: -1, fail: -1 };
  return { pass: Number(m[1]), skip: Number(m[2]), fail: Number(m[3]) };
};

const BREAKS = [
  { id: "B1", what: "撤 F-01 identityOfPath 的 ./ 归一化", file: "lib/fingerprint.js",
    from: `    if (typeof name === "string" && name !== "") {\n      const normName = name.replace(/\\\\/g, "/").replace(/^(?:\\.\\/)+/, "");\n      if (posix === normName) return { kind, key: "-" };\n    }`,
    to: `    if (typeof name === "string" && name !== "" && posix === name.split(path.sep).join("/")) {\n      return { kind, key: "-" };\n    }` },
  { id: "B2", what: "撤 F-02 /extensions/", file: "lib/defs.js", from: `  "/extensions/",\n`, to: `` },
  { id: "B2b", what: "撤 F-02 裸 extensions", file: "lib/defs.js", from: `  "goals",\n  "extensions",\n`, to: `  "goals",\n` },
  { id: "B3", what: "撤 F-03 调用点（改回裸 fileRel）", file: "lib/log-collector.js",
    from: `          written.push(toGitRel(b.root, abs));`, to: `          written.push(fileRel);` },
  { id: "B5", what: "撤 F-05（改回 throw）", file: "lib/part4.js",
    from: `            if (_wGi.ok !== true) return { ok: false, reason: "repairConformance: .gitignore 修复失败: " + String(_wGi.reason ?? "原子写失败") };`,
    to: `            if (_wGi.ok !== true) throw fail(String(_wGi.reason ?? "原子写失败"));` },
];

const base = runSelftest();
console.log(`基线：PASS ${base.pass} · SKIP ${base.skip} · FAIL ${base.fail}${base.crash ? "（崩了）" : ""}`);
if (base.fail !== 0 || base.crash) { console.log("基线不绿 ⇒ 停"); process.exit(2); }

let caught = 0, missed = 0;
const rows = [];
for (const b of BREAKS) {
  const abs = path.join(process.cwd(), b.file);
  const orig = fs.readFileSync(abs);
  let text = orig.toString("utf8");
  if (!text.includes(b.from)) { rows.push(`★未生效 ${b.id} ⇒ 锚点没命中`); missed += 1; continue; }
  fs.writeFileSync(abs, text.split(b.from).join(b.to), "utf8");
  const r = runSelftest();
  fs.writeFileSync(abs, orig);
  if (r.crash || r.fail > 0) { caught += 1; rows.push(`红  ${b.id} ${b.what} ⇒ FAIL ${r.fail}${r.crash ? "（崩溃）" : ""}`); }
  else { missed += 1; rows.push(`★仍绿 ${b.id} ${b.what}`); }
}
console.log(rows.join("\n"));
const after = runSelftest();
console.log("─".repeat(72));
console.log(`反向验证：${caught} / ${BREAKS.length} 见红${missed ? `，${missed} 处没见红` : ""}`);
console.log(`还原后：PASS ${after.pass} · SKIP ${after.skip} · FAIL ${after.fail}`);
console.log("REVERSE-DONE");
process.exit(missed === 0 && after.fail === 0 ? 0 : 1);
