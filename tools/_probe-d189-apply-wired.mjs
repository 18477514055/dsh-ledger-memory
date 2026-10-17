/**
 * ★★★★★★ 只读取证（D189 之二）：**`applyPrincipleProposal` 到底有没有被调用过？**
 *
 * 线索：`grep -n "applyPrincipleProposal" lib/index.js` 只回了 **4 处**，
 *   其中 **3 处是注释**（4 个"它只由用户批准触发"的说明），
 *   而**唯一的代码出现是它自己的函数定义**（`function applyPrincipleProposal(...)`）。
 *   ⇒ **没有任何调用点。**
 *
 * ★★★ 若属实，后果很重：
 *   `ledger_propose_principle` 的**唯一出路**就是那条批准回调 —— 而**它不存在**
 *   ⇒ 模型提议之后，**用户即使同意也没有任何东西去写盘** ⇒
 *   D180 承诺的第二种授权形式（"模型问我一句，我同意之后他去写"）**整个是空的**。
 *
 * ★ 判据（三重，缺一不可）：
 *   ① **静态**：在**剥掉注释**的源码里数真实调用点（★ 必须剥 —— 纪律 4，
 *      否则注释里的提及会被当成调用，本项目已栽过多次）。
 *   ② ★★★ **行为**：真跑一次"提议 → 走批准路 ⇒ 看文件有没有被建"。
 *      这才是最硬的：静态看不见"有没有接线"，行为能。
 *   ③ **对照**：同族的 `applyGoalsChange`（目标树那条）**有**调用点吗？
 *      —— 若它有、而原则那条没有，就是"半修"的又一例。
 *
 * 只读：只在临时目录里造项目，不碰本项目任何文件。
 * 跑法：node tools/_probe-d189-apply-wired.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

const src = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");

/** 剥注释（与自检里那把尺子同一实现；行号不变）。 */
function stripComments(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) {
        if (s[i] === "\n") out += "\n";
        i++;
      }
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}
const code = stripComments(src);

bar("① 静态判据（**剥掉注释后**）—— 真实调用点有几个？");
for (const fn of ["applyPrincipleProposal", "applyGoalsChange", "registerGoalsInManifest", "registerPrinciplesInManifest"]) {
  const re = new RegExp(`\\b${fn}\\s*\\(`, "g");
  const all = [...code.matchAll(re)];
  // ★ "函数定义" 与 "调用" 要分开数：定义是 `function NAME(`.
  const defs = all.filter((m) => /function\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index))).length;
  const calls = all.length - defs;
  console.log(`  ${fn.padEnd(30)} 出现 ${String(all.length).padStart(2)} 处 · 定义 ${defs} · **调用 ${calls}**`);
}

bar("② ★★★ 行为判据 —— 真跑一次「提议 → 走批准路」");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d189-"));
  fs.writeFileSync(path.join(tmp, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(tmp, "DECISIONS.md"), "# 决策\n", "utf8");
  fs.writeFileSync(
    path.join(tmp, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_a", revision: 0 }),
    "utf8"
  );
  const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
  const tools = new Map();
  const handlers = new Map();
  const run = {
    tools: { register: (t) => tools.set(t.name, t), get: (n) => tools.get(n) },
    on: (ev, h) => {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(h);
    },
    get: () => undefined,
    inject: () => ({ dispose() {} }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  mod.apply(run, {});
  const exec = { agent: { session: { header: { id: "s-d189", cwd: tmp } } } };

  const prop = await tools.get("ledger_propose_principle").execute(
    { op: "add", text: "## 一、准确性优先\n不确定就退回整份。" },
    exec
  );
  console.log(`  提议：ok=${prop.ok} proposalId=${prop.proposalId}`);
  const abs = path.join(tmp, "PRINCIPLES.md");
  console.log(`  提议之后 PRINCIPLES.md 存在吗：${fs.existsSync(abs)}　${fs.existsSync(abs) ? "（不该存在）" : "✅ 正确地不存在"}`);

  // ★ 这里**故意不去调内部函数** —— 就看看"有没有任何公开出口"能把提议变成文件。
  //   模拟"用户同意"：把能想到的公开路径都试一遍。
  const tries = [];
  // (a) 再调一次 write（用户亲手写的形态：带 authorizedBy）
  try {
    const w = await tools.get("ledger_write").execute(
      { target: "principles", content: "## 用户批准后写入\n准确性优先", authorizedBy: "user-card" },
      exec
    );
    tries.push({ what: "ledger_write({target:principles, authorizedBy:'user-card'})", ok: w.ok, reason: w.reason });
  } catch (e) {
    tries.push({ what: "ledger_write 抛错", ok: false, reason: String(e?.message ?? e) });
  }
  for (const t of tries) {
    console.log(`  试：${t.what}`);
    console.log(`     ⇒ ok=${t.ok} ${t.reason === undefined ? "" : String(t.reason).slice(0, 110)}`);
  }
  const body = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  console.log(`\n  ★ 最终 PRINCIPLES.md：存在=${fs.existsSync(abs)}`);
  console.log(`     这**只能**证明"带授权的 write 能建它"；`);
  console.log(`     而**"批准那条提议"这条路**是否存在，取决于 ① 的调用点数。`);
  console.log(`  ⚠️ 临时目录：${tmp}`);
}
