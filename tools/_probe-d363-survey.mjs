// _probe-d363-survey.mjs —— 摸清现状：用户手写的记忆文件现在的待遇是什么
//
// ★ 用户问题（逐字）：*"可以让用户自己写的台账日志记忆文件也被归入其中…有时候用户也会往一些其他的
//   文件写一点东西，或者是增加一些文件，这些的话得依靠模型自己赋予指纹吗？"*
// ★ 本探针只**量现状**，不下结论、不改代码。判据必须来自行为，不看代码长什么样。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LIB = (n) => pathToFileURL(path.join(ROOT, "lib", n)).href;
const fp = await import(LIB("fingerprint.js"));
const cardOps = await import(LIB("card-ops.js"));

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  ✓ ${t}`); }
  else { fail++; console.log(`  ✗ ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 400)}`}`); }
};
const mk = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `d363-${t}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };
const PID = "0123456789abcdef";

function mkProject(tag) {
  const root = mk(tag);
  const memName = `${path.basename(root)}-ledger-memory`;
  const mem = path.join(root, memName);
  for (const d of ["decisions", "lessons", "goals", "_arch", "_ledger-log", "extensions"]) {
    fs.mkdirSync(path.join(mem, d), { recursive: true });
  }
  const mf = {
    version: 1, protocolVersion: 3, active: "LEDGER.md", archiveDir: "_arch",
    logDir: "_ledger-log", decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals",
    maxActiveLines: 400, revision: 0, projectId: PID, memoryRoot: memName,
  };
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify(mf, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n\n## 目标\n测试\n", "utf8");
  return { root, mem, memName, mf };
}

console.log("═══ ① 用户手写在已有记忆面里的文件（如 lessons/ 下手写一张卡）═══");
{
  const { root, mem, mf } = mkProject("a");
  const info = { memoryBase: mem, active: "LEDGER.md", decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals", archiveDir: "_arch", logDir: "_ledger-log" };

  // 用户用编辑器直接写一张卡（完全绕过插件）
  const handwritten = path.join(mem, "lessons", "L99.md");
  fs.writeFileSync(handwritten, "## 教训 L99 · 用户手写的\n\n- 标题: 手动写\n- 根因: 无\n", "utf8");

  const id = fp.identityOfPath(info, handwritten);
  console.log(`  identityOfPath(lessons/L99.md) ⇒ ${JSON.stringify(id)}`);
  ok("① 已有的记忆面里，手写文件**认得出身份**（不需要指纹）", id !== undefined && id.kind === "lessons", JSON.stringify(id));

  const txt = fs.readFileSync(handwritten, "utf8");
  const p3 = fp.readFingerprint3(txt);
  console.log(`  它带指纹吗 ⇒ readFingerprint3 = ${JSON.stringify(p3?.reason ?? p3?.id)}`);
  ok("① 但它**没有**指纹（用户手写不经过插件）", p3?.ok !== true, JSON.stringify(p3?.id));

  // 改名后还能不能找到
  fs.renameSync(handwritten, path.join(mem, "lessons", "renamed-L99.md"));
  const r = fp.resolveByIdentity(mem, { name: "lessons/L99.md", kind: "lessons", project: PID, key: "L99" });
  console.log(`  改名后 resolveByIdentity ⇒ ${JSON.stringify(r)?.slice(0, 220)}`);
  ok("① 手写文件一改名就找不回（没指纹 ⇒ 兜底失效）", r?.ok !== true, JSON.stringify(r)?.slice(0, 200));
  rm(root);
}

console.log("\n═══ ② 用户自建的**新目录**（不在清单里）里写的文件 ═══");
{
  const { root, mem } = mkProject("b");
  const info = { memoryBase: mem, active: "LEDGER.md", decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals", archiveDir: "_arch", logDir: "_ledger-log" };

  fs.mkdirSync(path.join(mem, "我的笔记"), { recursive: true });
  const p = path.join(mem, "我的笔记", "想法.md");
  fs.writeFileSync(p, "# 一些想法\n\n随手记\n", "utf8");

  const id = fp.identityOfPath(info, p);
  console.log(`  identityOfPath(我的笔记/想法.md) ⇒ ${JSON.stringify(id)}`);
  // ★★★ 2026-10-29（D364 之后更新）：这条原来断言 `id === undefined`（"认不出"）——
  //   那正是 D363 记录的**缺口 B**。用户拍板「记忆根里一律算我们的」之后，
  //   **必须认得出**才是对的。★ 这是"断言也会过期"的第 3 次（纪律 21）：
  //   断言守的是**旧行为**，不改它就会下一轮把 D364 判成回归。
  ok("② 自建目录里的文件 ⇒ **认得出身份**（D364 之后的口径：kind=custom）", id !== undefined && id.kind === "custom", JSON.stringify(id));
  // ★ 对照项：**不能一刀切**。INDEX/README 这类缓存必须仍然认不出，否则会往缓存里写指纹。
  const idx = path.join(mem, "我的笔记", "INDEX.md");
  fs.writeFileSync(idx, "# 目录\n", "utf8");
  ok("② 对照：自建目录里的 INDEX.md 仍然**不**给身份（缓存不盖指纹）", fp.identityOfPath(info, idx) === undefined, JSON.stringify(fp.identityOfPath(info, idx)));

  // 但它仍然能被 scanMemorySurface 扫到（那是另一条路）
  const part6 = await import(LIB("part6.js"));
  const surfaces = part6.memorySurfaces({ ...info, projectRoot: root });
  console.log(`  memorySurfaces 里有 ${surfaces.length} 个面：${surfaces.map((s) => s.label).join(" / ")}`);
  rm(root);
}

console.log("\n═══ ③ 记忆根下放「别人的文件」（用户说：不仅是扩展记忆）═══");
{
  const { root, mem } = mkProject("c");
  const info = { memoryBase: mem, active: "LEDGER.md", decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals", archiveDir: "_arch", logDir: "_ledger-log" };

  for (const [rel, body] of [
    ["README.md", "# 记忆目录说明\n"],
    ["随手记.md", "我的随手记\n"],
    ["data/清单.txt", "a,b,c\n"],
  ]) {
    const p = path.join(mem, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
    const id = fp.identityOfPath(info, p);
    console.log(`  ${rel.padEnd(16)} ⇒ ${JSON.stringify(id)}`);
  }
  // ★★★ 2026-10-29（D364 之后更新）：原来这一条是 `ok(..., true)` —— **一条永远为真的死判据**
  //   （尺子错第 21/31 条：数个数、写常量都测不出行为变了）。D364 之后口径反了：
  //   记忆根下但不在任何已知面的文件 ⇒ **认得出（kind=custom）**。
  ok(
    "③ 记忆根下但不在任何已知面的文件 ⇒ **认得出**（D364：记忆根里一律算我们的）",
    ["随手记.md", "data/清单.txt"].every((rel) => {
      const q = fp.identityOfPath(info, path.join(mem, rel));
      return q !== undefined && q.kind === "custom";
    }),
    "",
  );
  // ★ 对照项：README 仍不认（说明文件，不是记忆）
  ok("③ 对照：记忆根下的 README.md 仍然**不**给身份", fp.identityOfPath(info, path.join(mem, "README.md")) === undefined, "");

  // stampDir 会不会误盖
  const dry = fp.stampDir(mem, (rel) => fp.identityOfPath(info, path.join(mem, rel)), { dryRun: true });
  console.log(`  stampDir(dryRun) ⇒ updated=${JSON.stringify(dry.updated)} skipped=${dry.skipped.length} failed=${dry.failed.length}`);
  // ★★★ 这一条原来断言 `updated` 里**不能**出现 随手记 / data/清单.txt —— 那也是 D364 之前的旧口径。
  //   现在它们**应当**被盖上（用户要的就是这个）。★ 但必须同时守住两个不该动的：
  //   README（说明）与 INDEX（缓存）不许出现在 updated 里。
  ok(
    "③ stampDir 盖上用户文件，但**不**盖 README / INDEX",
    dry.updated.some((u) => u.includes("随手记")) &&
      dry.updated.some((u) => u.includes("清单")) &&
      !dry.updated.some((u) => /(^|[\\/])README\./.test(u)) &&
      !dry.updated.some((u) => /(^|[\\/])INDEX\./.test(u)),
    JSON.stringify(dry.updated),
  );
  rm(root);
}

console.log("\n═══ ④ stampDir 有没有生产入口（用户能不能用上）═══");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "fingerprint.js"), "utf8");
  ok("④ stampDir 是导出函数", /export function stampDir/.test(src));
  // 查 lib 里除定义外还有没有引用
  const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));
  let users = [];
  for (const f of libFiles) {
    const s = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
    if (f === "fingerprint.js") continue;
    if (/\bstampDir\b/.test(s)) users.push(f);
  }
  console.log(`  lib/ 里引用 stampDir 的文件：${users.length === 0 ? "（无）" : users.join(", ")}`);
  ok("④ **没有**生产调用方 ⇒ 用户目前没有任何入口去「补铺指纹」", users.length === 0, users.join(","));
}

console.log("\n═══ ⑤ 模型写路径（writeCard）会不会给手写文件补指纹 ═══");
{
  const { root, mem, memName } = mkProject("e");
  // 用户手写一张卡（无指纹）
  fs.writeFileSync(path.join(mem, "decisions", "D50.md"), "## D50 · 手写\n\n正文\n", "utf8");

  // 模型通过 writeCard 重写同一张卡
  const w = cardOps.writeCard(mem, "decisions", "D50", "## D50 · 手写（被模型改过）\n\n正文\n");
  const txt = fs.readFileSync(path.join(mem, "decisions", "D50.md"), "utf8");
  const p3 = fp.readFingerprint3(txt);
  console.log(`  模型改写后 ⇒ writeCard.ok=${w?.ok}；有指纹=${p3?.ok === true}`);
  ok("⑤ **模型写一次就自动补上指纹**（不需要模型「想」着去打）", p3?.ok === true, JSON.stringify(p3?.reason));
  rm(root);
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
console.log("PROBE-COMPLETE");
