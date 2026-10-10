/**
 * 探针：**在真内核里**验证"能不能拿到 compaction 服务"。
 *
 * ★ 为什么必须真跑：前两次修都栽在"看起来对"上 ——
 *   ① 裸 `ctx.get("compaction")`：以为挂在 host 平面，其实在 preset 的 isolate 组里；
 *   ② `agent.ctx.get("compaction")`：以为 agent 的 ctx 在子树里，其实在子树**之外**。
 *   两次症状都是软失败（不报错、只是永远不压），外面看不出来。
 *   ⇒ 本机规矩「验证某东西能否工作，必须真让它工作」。
 *
 * ★ 本探针做两件事，各自**独立成立**：
 *   A. 静态：从 app.asar 解出内核自己的取法，确认它确实是
 *      `agentPresets.serviceFor(agent, name)`（而不是我推的）。
 *   B. 运行时：用**本插件真实的 resolver 源码**（从 lib/index.js 里抽出来求值），
 *      配一份按内核形状伪造的 ctx / agent，验证四条路各自的命中顺序。
 *      —— 抽真源码而不是重写一份，是因为重写的那份"对不对"和实现无关。
 *
 * 用法：node tools/_probe-compaction-reach.mjs
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "..");
const ASAR = (process.env.DSH_ASAR ?? path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "app.asar"));

let fail = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) fail++;
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ A. 内核自己怎么取 isolate 组里的服务（读 app.asar 真源码）═══");
// 复刻 _probe-asar-extract.mjs 的读取（同一条已验过的尺子）。
{
  const buf = fs.readFileSync(ASAR);
  const u32 = (o) => buf.readUInt32LE(o);
  const headerSize = u32(12);
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString("utf8"));
  const DATA_BASE = 8 + u32(4);
  const walk = (node, prefix, out) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix === "" ? name : `${prefix}/${name}`;
      if (child.files !== undefined) walk(child, p, out);
      else out.push({ path: p, size: Number(child.size), offset: Number(child.offset) });
    }
    return out;
  };
  const all = walk(header, "", []);
  const read = (p) => {
    const f = all.find((x) => x.path === p);
    if (f === undefined) return undefined;
    return buf.subarray(DATA_BASE + f.offset, DATA_BASE + f.offset + f.size).toString("utf8");
  };

  // A1：mount.js 里 serviceForAgent 的核心 —— withinFiber + scope parent
  const mount = read("dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/types/mount.js");
  ok("A1 读到内核 `mount.js`", typeof mount === "string" && mount.length > 1000);
  ok(
    "A2 `serviceForAgent` 用 `standingMountFor` + `withinFiber` 找隔离实现",
    /export function serviceForAgent/.test(mount) &&
      /standingMountFor\(agent\.ctx\)/.test(mount) &&
      /withinFiber\(impl\.fiber, mount\.fiber\)/.test(mount),
    "内核正路的形状应当在这里"
  );
  ok(
    "A3 注释确认：isolate 里的服务必须经 scope parent 找（不是从 agent.ctx 直接 get）",
    /resolve outside that realm/.test(mount) && /scope parent/.test(mount),
    "这正是我第一版修错的地方"
  );

  // A4：preset 里 compaction 确实在 isolate 组内
  const std = read("dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml");
  ok(
    "A4 preset 里 compaction 组带 `isolate: { compaction: true, toolResultPruner: true }`",
    typeof std === "string" && /isolate:\s*\n\s*compaction: true/.test(std) && /toolResultPruner: true/.test(std)
  );

  // A5：agent-preset-registry 在 host 平面（无 isolate）⇒ 我的 ctx 才 get 得到
  const web = read("dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml");
  ok(
    "A5 `agent-preset-registry` 是 host 平面顶层 insert（无 isolate）",
    typeof web === "string" && /\n    - id: agent-preset-registry\n/.test(web) && !/isolate:/.test(web),
    "若它也被 isolate，我的插件就永远拿不到 agentPresets"
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ B. 用本插件**真实的 resolver 源码**跑四种部署 ═══");
// ★ 从 lib/index.js 里把 `function compactionServiceFor(...) {...}` 整段抽出来求值。
//   抽真源码是关键：重写一份的话，验的是重写那份，不是实现。
const src = fs.readFileSync(path.join(DIR, "lib", "index.js"), "utf8");
const fnStart = src.indexOf("function compactionServiceFor(ctx, agent) {");
ok("B1 在实现里找到 `compactionServiceFor` 定义", fnStart >= 0);
// 花括号配平，取出完整函数体。
let depth = 0;
let fnEnd = -1;
for (let i = src.indexOf("{", fnStart); i < src.length; i += 1) {
  if (src[i] === "{") depth += 1;
  else if (src[i] === "}") {
    depth -= 1;
    if (depth === 0) {
      fnEnd = i + 1;
      break;
    }
  }
}
const fnSrc = src.slice(fnStart, fnEnd);
// ★ 断言写错过一次：源码里是 `agent?.ctx`（可选链），用 /agent\.ctx/ 配不上。
//   是**尺子**错了不是代码错了 —— 记在这里，免得下次又怀疑实现。
ok("B2 抽出的函数体完整（含三条路）", /agentPresets/.test(fnSrc) && /agent\?\.ctx/.test(fnSrc) && fnSrc.length > 400);

// 求值出真实函数（不给它任何外部依赖 —— 它本来就自足）。
const compactionServiceFor = new Function(`${fnSrc}; return compactionServiceFor;`)();

/** 造一个 compaction 实现（只要求有 compactNow）。 */
const impl = (tag) => ({ compactNow: async () => ({ tag }) });

/** 造一个 ctx：给的 `services` 就是 `ctx.get` 能拿到的东西。 */
const mkCtx = (services) => ({ get: (k) => services[k] });

// B3：只有 agentPresets.serviceFor 拿得到（★ 本 profile 的真实处境）
{
  const c = impl("presets");
  const agent = { ctx: mkCtx({}) }; // agent 作用域**故意**什么都不给
  const ctx = mkCtx({ agentPresets: { serviceFor: (a, n) => (a === agent && n === "compaction" ? c : undefined) } });
  ok("B3 只有 serviceFor 有 ⇒ 拿到（★ 真实处境：另两条路都拿不到）", compactionServiceFor(ctx, agent) === c);
}

// B4：serviceFor 必须收到**真 agent**（内核靠它找 scope parent）
{
  const c = impl("presets");
  const agent = { ctx: mkCtx({}) };
  // ★ 对任何 agent 都返回 c，但**记录**收到了什么；实现若没传 agent，这里就收不到。
  let seen;
  const ctx = mkCtx({
    agentPresets: {
      serviceFor: (a, n) => {
        seen = a;
        return n === "compaction" ? c : undefined;
      },
    },
  });
  ok("B4 serviceFor 收到了真 agent（不是 undefined）", compactionServiceFor(ctx, agent) === c && seen === agent, `收到 ${String(seen)}`);
}

// B5：agent.ctx 里有、serviceFor 没有 ⇒ **不该**靠它（钉死第一版错修）
{
  const wrong = impl("agent-ctx");
  const agent = { ctx: mkCtx({ compaction: wrong }) };
  const ctx = mkCtx({ agentPresets: { serviceFor: () => undefined } });
  // 实现里 agent.ctx 是**第三兜底** ⇒ 仍会返回它。
  // 但真实 profile 里 agent.ctx **根本拿不到**（B3 已证），所以这条只说明
  // "兜底存在"，不构成"能工作"的证据。真正的证据是 serviceFor 那条。
  const got = compactionServiceFor(ctx, agent);
  ok("B5 agent.ctx 兜底仍保留（非 isolate 部署有用），但它**不是**本 profile 的路", got === wrong, `拿到 ${got?.compactNow ? "有" : "无"}`);
}

// B6：三条路都没有 ⇒ undefined（如实，不假装）
{
  const agent = { ctx: mkCtx({}) };
  ok("B6 三条都没有 ⇒ undefined（不假装拿到）", compactionServiceFor(mkCtx({}), agent) === undefined);
}

// B7：顺序 —— serviceFor 优先于 ctx.get（两者都有时取 serviceFor）
{
  const a = impl("presets");
  const b = impl("hostctx");
  const agent = { ctx: mkCtx({}) };
  const ctx = mkCtx({
    agentPresets: { serviceFor: () => a },
    compaction: b,
  });
  ok("B7 serviceFor 优先于 ctx.get（isolate 部署下前者才对）", compactionServiceFor(ctx, agent) === a);
}

// B8：形状校验 —— `compactNow` 不是函数的假服务要被拒（防止拿到个空壳）
{
  const agent = { ctx: mkCtx({}) };
  const ctx = mkCtx({ agentPresets: { serviceFor: () => ({ compactNow: "not a function" }) }, compaction: {} });
  ok("B8 只认有 `compactNow` 函数的服务（空壳被拒）", compactionServiceFor(ctx, agent) === undefined);
}

// B9：`serviceFor` 抛错不能让整个取值炸（软失败要软到底）
{
  const c = impl("fallback");
  const agent = { ctx: mkCtx({ compaction: c }) };
  const ctx = mkCtx({
    agentPresets: {
      serviceFor: () => {
        throw new Error("内核这一版没有 serviceFor");
      },
    },
  });
  ok("B9 serviceFor 抛错 ⇒ 退回下一路（不把插件炸掉）", compactionServiceFor(ctx, agent) === c);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ C. 静态钉死：五处调用点 + 诊断输出一致 ═══");
{
  const calls = src.match(/const compaction = compactionServiceFor\(ctx, agent\)/g) ?? [];
  // ★ 2026-10-09：新增增量压缩那条（`runIncrementalCompact`）⇒ 3 → 4 处；
  //   再加手动轻量那条（`runManualLightCompactNow`）⇒ 4 → 5 处。
  //   ★ 这条断言的价值是"**没有一处漏掉 resolver**"，数量变了要跟着改；
  //     真正该守住的是下面 C2/C3（正路形状与可达性诊断）。
  ok(`C1 五处压缩取值都走 resolver（实际 ${calls.length}）`, calls.length === 5);
  ok(
    "C2 没有残留裸 `ctx.get(\"compaction\")` 取值",
    !/^\s*const compaction = ctx\.get\("compaction"\);/m.test(src)
  );
  ok(
    "C3 `ledger_status` 报出可达性与路径（让软失败可观测）",
    /compactionReachVia\(ctx, exec\?\.agent\)/.test(src)
  );
  // ★ 两者顺序必须一致，否则 status 会指错路。
  const via = src.slice(src.indexOf("function compactionReachVia"));
  ok(
    "C4 `compactionReachVia` 判断顺序与 resolver 一致（先 serviceFor）",
    via.indexOf("agentPresets") < via.indexOf('ctx?.get?.("compaction")')
  );
}

console.log(`\n${fail === 0 ? "探针通过：可达性有据（静态契约 + 真源码求值）" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
