/**
 * ★★★★★★ 反向验证（D203）：**把卡片模式的读写接线摘掉 ⇒ 情形 89 必须见红**。
 *
 * ★ 为什么必须做（纪律 10）：情形 89 是"迁移能成立"的守卫 ——
 *   若我摘掉修复它却仍然全绿，那说明**它守的不是那个东西**（或断言太弱），
 *   而迁移就会在当前这份代码上**造出两份真源**，且**没有任何东西会报警**。
 *
 * ★ 做法：**真的把 `lib/index.js` 改回坏版本**（在 %TEMP% 里改副本，不动真源），
 *   然后跑 selftest，看情形 89 是否变红。
 *   ★ 不改真源：复制整个项目到 %TEMP%（只复制跑自检所需的最小集）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

/** 复制一份到 %TEMP%（只带自检 + lib + 夹具需要的文件）。 */
function cloneProject(tag) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), `d203-rev-${tag}-`));
  fs.cpSync(path.join(ROOT, "lib"), path.join(dst, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dst, "tools"), { recursive: true });
  for (const f of ["selftest.mjs"]) fs.copyFileSync(path.join(ROOT, "tools", f), path.join(dst, "tools", f));
  // selftest 会读 package.json（版本/身份位）
  for (const f of ["package.json"]) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dst, f));
  }
  return dst;
}

/** 跑 selftest，返回 {pass, fail, lines}。 */
function runSelf(dir) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(dir, "tools", "selftest.mjs")], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = String((e && e.stdout) || "") + String((e && e.stderr) || "");
  }
  const m = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
  return { pass: m === null ? -1 : Number(m[1]), fail: m === null ? -1 : Number(m[2]), out };
}

/** 情形 89 / 88 的失败条目。 */
function failuresOf(out, tag) {
  return out
    .split(/\r?\n/)
    .filter((l) => /FAIL|失败清单/.test(l))
    .filter((l) => l.includes(tag))
    .map((l) => l.trim());
}

/** 替换源码里的一段（**必须命中恰好一次**，否则报错 —— 免得"改了个空"）。 */
function patch(src, from, to, label) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`反向验证的锚点在源码里命中 ${n} 次（应为 1）：${label}`);
  return src.replace(from, to);
}

const results = [];

// ── 基线：不改，情形 89 必须全绿（否则下面的"见红"没有对照）──────────────
{
  const dir = cloneProject("base");
  const r = runSelf(dir);
  results.push({ label: "基线（不改）", pass: r.pass, fail: r.fail, affected: failuresOf(r.out, "89").length });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 反向 A：摘掉"写侧走卡片" ⇒ 写回旧文件 ⇒ 89③/89③b/89③d 应见红 ──────
{
  const dir = cloneProject("writeside");
  const p = path.join(dir, "lib", "index.js");
  let src = fs.readFileSync(p, "utf8");
  // 把"卡片模式下写决策"那条整个短路成"不处理"（= 退回 D202 的行为：写进旧文件）。
  src = patch(
    src,
    'if (target === "decisions" && cardModeOf(info, "decisions").card === true) {',
    'if (false && target === "decisions" && cardModeOf(info, "decisions").card === true) {',
    "写侧卡片分支"
  );
  fs.writeFileSync(p, src, "utf8");
  const r = runSelf(dir);
  results.push({
    label: "反向A：摘掉写侧卡片分支",
    pass: r.pass,
    fail: r.fail,
    affected: failuresOf(r.out, "89").length,
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 反向 B：摘掉"读侧拼卡"（整份读回落快照）⇒ 89②/89②b 应见红 ──────────
{
  const dir = cloneProject("readside");
  const p = path.join(dir, "lib", "index.js");
  let src = fs.readFileSync(p, "utf8");
  // 让"整份读"永远走单文件那条路（= 读迁移前快照）。
  src = patch(
    src,
    'const cardWhole = readKind !== undefined && cMode.card === true ? readKindRaw(root, info, readKind) : undefined;',
    "const cardWhole = undefined;",
    "读侧拼卡"
  );
  fs.writeFileSync(p, src, "utf8");
  const r = runSelf(dir);
  results.push({
    label: "反向B：摘掉读侧拼卡（回落快照）",
    pass: r.pass,
    fail: r.fail,
    affected: failuresOf(r.out, "89").length,
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 反向 C：摘掉 `readKindRaw` 的卡片分支（goals/lessons 整份读回落快照）──
{
  const dir = cloneProject("readkind");
  const p = path.join(dir, "lib", "index.js");
  let src = fs.readFileSync(p, "utf8");
  src = patch(
    src,
    "  const mode = cardModeOf(info, kind);\n  if (mode.card === true) {\n    const cards = listCards(root, mode.dirRel);",
    "  const mode = cardModeOf(info, kind);\n  if (false && mode.card === true) {\n    const cards = listCards(root, mode.dirRel);",
    "readKindRaw 卡片分支"
  );
  fs.writeFileSync(p, src, "utf8");
  const r = runSelf(dir);
  results.push({
    label: "反向C：摘掉 readKindRaw 卡片分支",
    pass: r.pass,
    fail: r.fail,
    affected: failuresOf(r.out, "89").length,
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 反向 D：摘掉 `kindLocationOf` 的目录指向（注入契约指回旧文件）──────────
{
  const dir = cloneProject("kindloc");
  const p = path.join(dir, "lib", "index.js");
  let src = fs.readFileSync(p, "utf8");
  src = patch(
    src,
    '  if (mode.card === true) return { card: true, rel: mode.dirRel };\n  const rel = mode.fileRel;\n  return typeof rel === "string" && rel !== "" ? { card: false, rel } : { card: false, rel: undefined };',
    '  if (false && mode.card === true) return { card: true, rel: mode.dirRel };\n  const rel = mode.fileRel;\n  return typeof rel === "string" && rel !== "" ? { card: false, rel } : { card: false, rel: undefined };',
    "kindLocationOf 卡片分支"
  );
  fs.writeFileSync(p, src, "utf8");
  const r = runSelf(dir);
  results.push({
    label: "反向D：摘掉 kindLocationOf 卡片分支",
    pass: r.pass,
    fail: r.fail,
    affected: failuresOf(r.out, "89").length,
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("═══ D203 反向验证：摘掉修复 ⇒ 情形 89 必须见红 ═══");
for (const r of results) {
  const verdict = r.label.startsWith("基线")
    ? r.affected === 0
      ? "✅ 基线全绿（对照成立）"
      : "❌ 基线本来就红 —— 反向验证无意义"
    : r.affected > 0
      ? `✅ 见红 ${r.affected} 条（断言真的守着它）`
      : "❌ **仍然全绿** —— 断言太弱或修复冗余，必须查清";
  console.log(`  ${r.label}: 通过=${r.pass} 失败=${r.fail} · 89 相关失败=${r.affected}  ${verdict}`);
} 
