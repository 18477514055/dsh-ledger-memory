/**
 * 探针（D212）—— **"两条升级路"到底通不通？**
 *
 * ★ 用户问（逐字）：*"现在就是在最新的插件的作用下，其他使用老版本插件的对话会自动被 AI
 *   识别到，然后改成新版本吗？"*
 *
 * ★★★ 回答之前必须先分清**两个完全不同的"版本"**（混了就会答错）：
 *   ① **代码版本**（插件包本身：npm 上的 `dsh-ledger-memory`）—— 由内核查；
 *   ② **项目规格版本**（这个项目的记忆文件长什么样：单文件 vs 卡片、有没有 goals/journal…）——
 *      由**我们**的注入推行。
 *   用户问的是"**其他对话会不会被 AI 识别到然后改成新版本**" ⇒ ①(自动/内核) + ②(AI/我们)。
 *
 * ★ 本探针只回答**②能不能被识别到**（"识别"是前提；"改不改"是 AI 的判断，不由代码决定）。
 *   ★ 判据：**同一个老规格项目**，注入里到底有没有
 *      (a) 「还有这些能力，本项目尚未启用」（D196 功能清单）
 *      (b) 「文件格式协议」（D197）
 *   ⇒ 若两者都在，那"AI 能不能识别到"这件事**是通的**；不在就是断的。
 *
 * 跑法：node tools/_probe-d212-upgrade-channels.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "lib", "index.js");

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "probe-d212-home-"));
process.env.DSH_HOME = SANDBOX_HOME;

function makeCtx() {
  const handlers = new Map();
  const services = {
    tokenMeter: {
      _total: 0,
      _window: 1000000,
      measure() {
        return { totalTokens: this._total, nodes: [] };
      },
    },
  };
  const ctx = {
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(ev, fn) {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
      return () => {};
    },
    inject(deps, cb) {
      for (const d of deps) if (!(d in services)) return undefined;
      const scope = Object.create(ctx);
      for (const d of deps) scope[d] = services[d];
      return cb(scope);
    },
    get: (k) => services[k],
  };
  return { ctx, handlers };
}

// ── 造一个**老规格**项目：只有 活跃台账 + 决策 + 归档（没有 goals/journal/lessons 卡片）──
function mkOldSpec(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `d212-${tag}-`));
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n## 一、状态\n\n- 老规格项目。\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify(
      {
        version: 1,
        active: "LEDGER.md",
        decisions: "DECISIONS.md", // ★ 故意用**单文件**（老规格），不是 decisions/ 卡片目录
        archiveDir: "_ledger-archive",
        maxActiveLines: 350,
        revision: 0,
      },
      null,
      2
    ),
    "utf8"
  );
  return root;
}

const roots = { old: mkOldSpec("oldspec") };
const m = await import(pathToFileURL(ENTRY).href);

console.log("════════ D212 探针：老规格项目能不能「被识别到」？ ════════\n");

for (const [label, root] of Object.entries(roots)) {
  const run = makeCtx();
  m.apply(run.ctx, {});
  const info = m.__test.inspect(root);
  const body = m.__test.renderInjectionBody(info, undefined, {});
  const capBlock = m.__test.renderUnenabledCapabilities(info);
  const protoBlock = m.__test.renderProtocolBlock(info);

  console.log(`──── ${label}（${root}）────`);
  console.log(`  清单里 decisions = ${info.decisionsRel ?? "(无)"}｜decisionsDir = ${info.decisionsDir ?? "(无，=单文件老规格)"}`);
  console.log(`  ① 「尚未启用的能力」那一段（D196）：${capBlock.trim() === "" ? "★ 没有" : "有"}`);
  if (capBlock.trim() !== "") {
    for (const l of capBlock.split("\n").filter((x) => x.startsWith("- **"))) console.log(`      ${l}`);
  }
  console.log(`  ② 「文件格式协议」那一段（D197）：${protoBlock.trim() === "" ? "★ 没有" : "有"}`);
  console.log(`  ③ 注入正文里真的含这两段吗：cap=${body.includes("尚未启用")} proto=${body.includes("文件格式协议")}`);
  console.log(`  ④ 注入里有没有报「当前插件版本」：${/当前插件版本/.test(body)}`);
  const m2 = /当前插件版本：`([^`]+)`/.exec(body);
  console.log(`      ${m2 === null ? "（没有）" : "版本 = " + m2[1]}`);
  console.log("");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("════════ 结论 ════════");
console.log("  ★ 「AI 能不能识别到这个项目该升级」= 上面 ①② 两段在不在注入里。");
console.log("  ★ 而「识别到之后改不改」**不由代码决定** —— 那是 AI 读协议 + 问过用户之后才动手（D197 的立场）。");

fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
