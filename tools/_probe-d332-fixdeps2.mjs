/**
 * _probe-d332-fixdeps2.mjs —— 补齐**只在 `execute()` 里**才会用到的符号
 *
 * ★ 上一版探针的口径漏洞（我的第 5 处尺子错）：
 *   我只调了 `defineGoalsTool()`（**外层工厂**），它返回的是 `{name, description, parameters, execute}`。
 *   `rootFromExec` 这类符号是在 **`execute` 被真正调用时**才求值的 ⇒ 光调工厂**测不到**。
 *   ★ 判据：**"能构造" ≠ "能执行"** —— 验一个工具，必须把 `execute` 也真跑一次。
 *
 * ★ 做法：对每个 tool，构造最小合法参数真跑 execute，抓到 ReferenceError 就补。
 *   （跑失败/抛业务错都没关系，我们只关心 `X is not defined` 这一种。）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const P2 = path.resolve("lib/part2.js");
const NEW = path.resolve("lib/part2-tools.js");
const TOOLS = ["defineGoalsTool", "defineLessonsTool", "definePrinciplesAccessTool", "defineProposePrincipleTool"];

const p2text = fs.readFileSync(P2, "utf8");
const p2lines = p2text.split(/\r?\n/);

const ownDecls = new Map();
for (let i = 0; i < p2lines.length; i += 1) {
  const l = p2lines[i];
  const m =
    /^(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(l) ||
    /^(export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/.exec(l) ||
    /^(export\s+)?let\s+([A-Za-z0-9_$]+)\s*=/.exec(l);
  if (m) ownDecls.set(m[2], i + 1);
}

/**
 * 扫 part2 的 import 块，得到 name -> 来源模块。
 *
 * ★★★ 2026-10-26（D332 · 我的第 6 处尺子错，记下来）：
 *   上一版用的是"抓 `{...}` 里的逗号分隔项"，而 `part2.js` 的多行 import 里**夹着注释行**
 *   （见 part2 第 22-23 行：`// ★★★ 2026-10-23（D316 …）`）⇒ 注释里的文字被当成名字，
 *   而紧跟注释后面的 `refuseIfMemoryRootUnsafe` 反而**没被收录**。
 *   ⇒ 判据：**解析代码块时，必须先把注释剔掉再切分** —— 否则注释会同时污染"多了"和"少了"两边。
 */
const importedFrom = new Map();
{
  let i = 0;
  while (i < p2lines.length) {
    if (!/^import\s/.test(p2lines[i])) { i += 1; continue; }
    let chunk = p2lines[i];
    let j = i;
    while (!/from\s+["'][^"']+["']\s*;?\s*$/.test(chunk.replace(/\/\/[^\n]*/g, "")) && j + 1 < p2lines.length) {
      j += 1;
      chunk += "\n" + p2lines[j];
    }
    const spec = /from\s+["']([^"']+)["']/.exec(chunk.replace(/\/\/[^\n]*/g, ""))?.[1];
    if (spec !== undefined) {
      // ★ 先剔注释，再抓花括号内容（注释会污染切分，两边都错）
      const stripped = chunk.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const brace = /\{([\s\S]*?)\}/.exec(stripped);
      if (brace !== null) {
        for (const raw of brace[1].split(",")) {
          const nm = raw.trim().split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(nm)) importedFrom.set(nm, spec);
        }
      }
    }
    i = j + 1;
  }
}
console.log(`扫到 part2 转手 import 的符号 ${importedFrom.size} 个`);

// ── 夹具：一个最小项目根 ───────────────────────────────────────────────────
function mkRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `d332-${tag}-`));
  fs.writeFileSync(path.join(d, "LEDGER.md"), "# 台账\n\n- x\n", "utf8");
  // 卡片目录给齐，避免工具走进"目录不存在"的早退分支而漏测后面的符号
  for (const sub of ["decisions", "lessons", "goals"]) fs.mkdirSync(path.join(d, sub), { recursive: true });
  fs.writeFileSync(
    path.join(d, ".dsh-ledger.json"),
    JSON.stringify({ active: "LEDGER.md", decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals", archiveDir: "_archive", protocolVersion: 3 }, null, 2),
    "utf8"
  );
  return d;
}

/** 每个 tool 的"最小真实调用"（尽量走到深处，好把 execute 里的符号都摸出来）。 */
function callPlan(name, mod, root) {
  const exec = { agent: { session: { header: { cwd: root, id: "session-d332-0000-4000-8000-000000000001" } } }, steer() {} };
  const t = mod[name]();
  if (name === "defineGoalsTool") {
    return Promise.all([
      t.execute({ op: "tree" }, { agent: exec.agent }),
      t.execute({ op: "upsert", id: "g1", title: "测试目标", parent: "-", status: "root" }, { agent: exec.agent }),
      t.execute({ op: "status", id: "g1", status: "done" }, { agent: exec.agent }),
      t.execute({ op: "lesson", id: "g1", lesson: "走过一次" }, { agent: exec.agent }),
    ]);
  }
  if (name === "defineLessonsTool") {
    return Promise.all([
      t.execute({ op: "list" }, { agent: exec.agent }),
      t.execute({ op: "add", type: "教训", kind: "尺子错", title: "测试", symptom: "s", cause: "c", fix: "f" }, { agent: exec.agent }),
    ]);
  }
  if (name === "definePrinciplesAccessTool") {
    return Promise.all([t.execute({ reason: "测试" }, { agent: exec.agent })]);
  }
  if (name === "defineProposePrincipleTool") {
    return Promise.all([t.execute({ op: "add", text: "测试原则", reason: "因为" }, { agent: exec.agent })]);
  }
  return Promise.resolve();
}

let newText = fs.readFileSync(NEW, "utf8");
const tmp = process.env.TEMP ?? ".";
fs.writeFileSync(path.join(tmp, `part2-tools-before-fixdeps2-${Date.now()}.js`), newText, "utf8");

const unresolvable = new Set();

for (let round = 1; round <= 20; round += 1) {
  fs.writeFileSync(NEW, newText, "utf8");
  const mod = await import(pathToFileURL(NEW).href + `?r=${round}`);
  const missing = new Set();
  const root = mkRoot(`r${round}`);

  for (const name of TOOLS) {
    try {
      await callPlan(name, mod, root);
    } catch (e) {
      // 一次只报一个 ReferenceError，逐个收集
      let msg = String(e?.message ?? e);
      const m = /^([A-Za-z_$][\w$]*) is not defined$/.exec(msg);
      if (m) missing.add(m[1]);
      else console.log(`  ⚠️ ${name} 抛了非 ReferenceError：${msg.slice(0, 100)}`);
    }
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 无所谓 */ }

  if (missing.size === 0) {
    console.log(`\n✅ 第 ${round} 轮：四个 tool 的 **execute 全部可跑，零缺失**`);
    break;
  }
  console.log(`\n第 ${round} 轮缺 ${missing.size} 个：${[...missing].join(", ")}`);

  const addP2 = new Set();
  const addMod = new Map();
  for (const n of [...missing].sort()) {
    if (ownDecls.has(n)) { addP2.add(n); console.log(`    ${n.padEnd(28)} ← part2 自己声明（第 ${ownDecls.get(n)} 行）`); }
    else if (importedFrom.has(n)) {
      const spec = importedFrom.get(n);
      if (!addMod.has(spec)) addMod.set(spec, new Set());
      addMod.get(spec).add(n);
      console.log(`    ${n.padEnd(28)} ← part2 转手自 ${spec}`);
    } else { unresolvable.add(n); console.log(`    ${n.padEnd(28)} 🔴 找不到来源`); }
  }
  if (unresolvable.size > 0) { console.log("\n🔴 有符号找不到来源 ⇒ 停下报告，不猜。"); process.exit(1); }

  if (addP2.size > 0) {
    newText = newText.replace(
      /(import\s*\{)([\s\S]*?)(\}\s*from\s*["']\.\/part2\.js["'];)/,
      (_, a, body, c) => `${a}${body}${[...addP2].sort().map((n) => `  ${n},\n`).join("")}${c}`
    );
  }
  if (addMod.size > 0) {
    const extra = [...addMod.entries()].map(([spec, set]) => `import { ${[...set].sort().join(", ")} } from "${spec}";`).join("\n");
    const lastImport = [...newText.matchAll(/^import[\s\S]*?from\s*["'][^"']+["'];\s*$/gm)].pop();
    const idx = lastImport.index + lastImport[0].length;
    newText = newText.slice(0, idx) + "\n" + extra + newText.slice(idx);
  }
}

fs.writeFileSync(NEW, newText, "utf8");
console.log(`\npart2-tools.js 最终 ${Buffer.byteLength(newText, "utf8")} B / ${newText.split(/\r?\n/).length} 行`);
console.log("PROBE-COMPLETE");
