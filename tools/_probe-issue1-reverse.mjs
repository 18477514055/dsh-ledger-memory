// 反向验证：把**旧实现的 splitChangeRegister** 临时装回 lib，跑同一个端到端场景，必须失败。
// ★ 纪律：反向验证必须在**一次性副本**上做，绝不改生产 lib。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.resolve(import.meta.dirname, "..");
const LIB = path.join(HERE, "lib");

// ── ① 造一份隔离副本 ──
const copy = fs.mkdtempSync(path.join(os.tmpdir(), "issue1-rev-"));
fs.cpSync(LIB, path.join(copy, "lib"), { recursive: true });
fs.copyFileSync(path.join(HERE, "package.json"), path.join(copy, "package.json"));

// ── ② 把 part1.js 里的 splitChangeRegister 换回**旧的**（从标题切到末尾）──
const p1Path = path.join(copy, "lib", "part1.js");
const p1 = fs.readFileSync(p1Path, "utf8");
const startMark = "export function splitChangeRegister(text) {";
const endMark = "\n}\n";
const i0 = p1.indexOf(startMark);
if (i0 < 0) throw new Error("找不到 splitChangeRegister");
const i1 = p1.indexOf(endMark, i0) + endMark.length;
const oldImpl = `export function splitChangeRegister(text) {
  if (typeof text !== "string" || text === "") return { body: "", entries: [] };
  const idx = text.indexOf(CHANGE_REGISTER_HEADING);
  if (idx < 0) return { body: text, entries: [] };
  const body = text.slice(0, idx).replace(/\\s+$/, "");
  const tail = text.slice(idx + CHANGE_REGISTER_HEADING.length);
  const entries = tail.split("\\n").map((l) => l.trim()).filter((l) => CHANGE_REGISTER_LINE_RE.test(l));
  return { body, entries };
}
`;
console.log("边界检查 —— 被替换段的首行：", p1.slice(i0, i0 + 60).split("\n")[0]);
console.log("边界检查 —— 被替换段的末行：", JSON.stringify(p1.slice(i0, i1).slice(-40)));
fs.writeFileSync(p1Path, p1.slice(0, i0) + oldImpl + p1.slice(i1), "utf8");

// ── ③ 同样把 part4.js 的调用改回旧拼接 ──
const p4Path = path.join(copy, "lib", "part4.js");
let p4 = fs.readFileSync(p4Path, "utf8");
const newCall =
  "const afterBody =\r\n    splitChangeRegister(newActive).body + \"\\n\" + splitChangeRegister(entries).body;\r\n  const lost = lostLines(priorBodyForArchive, afterBody);";
const newCallLF = newCall.replace(/\r\n/g, "\n");
if (p4.includes(newCall)) p4 = p4.replace(newCall, "const lost = lostLines(priorBodyForArchive, `${newActive}\\n${entries}`);");
else if (p4.includes(newCallLF)) p4 = p4.replace(newCallLF, "const lost = lostLines(priorBodyForArchive, `${newActive}\\n${entries}`);");
else throw new Error("找不到新的 lostLines 调用，边界不对，停手");
fs.writeFileSync(p4Path, p4, "utf8");
console.log("已把 part4.js 的判据改回旧拼接\n");

// ── ④ 在这个副本上跑同一个端到端场景 ──
const mod = await import(pathToFileURL(path.join(copy, "lib", "index.js")).href);
const run = { registeredTools: new Map() };
const ctx = {
  effect: () => {}, on: () => {}, inject: () => {}, provide: () => {},
  tools: { register(def) { run.registeredTools.set(typeof def === "string" ? def : def?.name, def); } },
  commands: { register() {} },
  logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  plugin: () => {}, get: () => undefined, set: () => {},
};
try { mod.apply(ctx, {}); } catch { /* ignore */ }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue1-revdata-"));
const REG = "## 变更登记（插件自动维护）";
const line = "- 2026-10-20 10:00:00 (append) [a5dd] +1 行 → 100 行 · revision→1";
const body = ["# Ledger", ""];
for (let i = 0; i < 4; i++) {
  body.push(`## 八之${i}`, "");
  for (let j = 0; j < 6; j++) body.push(`- 条目 ${i}-${j}`, "");
  body.push("");
}
fs.writeFileSync(path.join(root, "LEDGER.md"), body.join("\n").replace(/\s+$/, "") + `\n\n${REG}\n\n> 说明\n\n${line}\n`, "utf8");
fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify({ version: 1, active: "LEDGER.md", archiveDir: "_ledger-archive", maxActiveLines: 400, archiveWeekMode: "month", revision: 1 }, null, 2), "utf8");

const exec = { agent: { session: { header: { id: "session-rev00001-bbbb", cwd: root }, id: "session-rev00001-bbbb" } } };
const entries = ["## 八之0", "", ...Array.from({ length: 6 }, (_, j) => `- 条目 0-${j}`)].join("\n");
const newActive = ["# Ledger", "", ...body.slice(2).filter((l) => !l.includes("条目 0-")).filter((l) => l !== "## 八之0")]
  .join("\n").replace(/\s+$/, "") + `\n\n${REG}\n\n> 说明\n\n${line}\n`;

const r = await run.registeredTools.get("ledger_archive").execute({ entries, newActive, ifRevision: 1 }, exec);
console.log("── 旧代码跑同一场景 ──");
console.log(JSON.stringify(r, null, 2).slice(0, 900));
console.log(
  r.ok === false && (r.lostLines ?? 0) > 0
    ? `\n★★★ 反向验证成立：旧代码误报 ${r.lostLines} 行"凭空丢失" —— 与用户 issue 的症状一致。`
    : "\n⚠️ 旧代码没有失败 —— 反向验证不成立，需复查切片是否真生效。"
);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(copy, { recursive: true, force: true });
console.log("隔离副本与临时数据已清理。");
