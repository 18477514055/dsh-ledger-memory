/**
 * 探针：**证明我对内核 `toolPairingBalanced*` 的复刻是对的**。
 *
 * ★ 为什么必须证明：本插件是 **Junction 目标** ⇒ `import "@deepseek-ai/*"` 会
 *   `MODULE_NOT_FOUND`（内核起不来）。所以要用到"切点是否平衡"时，
 *   只能**自己复刻**那份算法。而"复刻得对不对"绝不能靠看代码觉得像 ——
 *   本机规矩：**先证明尺子对，再报结论**。
 *
 * 做法：
 *   ① 从 app.asar 解出内核**真的** `dsh-compaction/lib/types/tool-pairing.js`；
 *   ② 用一个**假的 session**（`surface.nodes` + `eventAt(seq)`）造各种工具调用形态
 *      —— 包括成对、悬空、连续多个 tool-call、穿插无关事件；
 *   ③ 把内核那份**当代码求值**（它是 ESM，含 `export`；剥掉 export 后 eval），
 *      拿到真的 `toolPairingBalancedBefore/After`；
 *   ④ 用**我实现里那同一份算法**（从 lib/index.js 抽出来求值）算一遍；
 *   ⑤ 逐 seq 对比两者。**全等才算复刻正确。**
 *
 * 用法：node tools/_probe-toolpairing-parity.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ASAR = (process.env.DSH_ASAR ?? path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "app.asar"));

// ── 读 asar（同一把已验过的尺子：偏移 12 是 JSON 长度；offset 是字符串要 Number）──
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
  if (f === undefined) throw new Error("asar 里没有 " + p);
  return buf.subarray(DATA_BASE + f.offset, DATA_BASE + f.offset + f.size).toString("utf8");
};

let fail = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) fail += 1;
};

// ── ① 把内核那份求值出来（剥掉 ESM export）──────────────────────────────
console.log("═══ ① 求值内核真的 tool-pairing.js ═══");
const KERNEL_SRC = read("dsh/node_modules/@deepseek-ai/dsh-compaction/lib/types/tool-pairing.js");
const kernelJs = KERNEL_SRC
  .replace(/export function /g, "function ")
  .replace(/\nexport \{[^}]*\};?/g, "\n");
const kernelMod = new Function(
  `${kernelJs}\nreturn { toolPairingBalancedBefore, toolPairingBalancedAfter };`
)();
ok("拿到内核的 toolPairingBalancedBefore/After", typeof kernelMod.toolPairingBalancedBefore === "function");

// ── ② 从**我自己的实现**里抽出那三个函数求值（抽真源码，不重写一份）──────
console.log("\n═══ ② 求值本插件实现里的复刻版 ═══");
const mine = fs.readFileSync(path.join(path.resolve(import.meta.dirname, ".."), "lib", "index.js"), "utf8");
function extractFn(name) {
  const start = mine.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`实现里找不到 ${name}`);
  let depth = 0;
  let end = -1;
  for (let i = mine.indexOf("{", start); i < mine.length; i += 1) {
    if (mine[i] === "{") depth += 1;
    else if (mine[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return mine.slice(start, end);
}
const fns = ["toolCallDeltaOf", "balanceFlagsOf"].map(extractFn).join("\n");
const myMod = new Function(`${fns}\nreturn { toolCallDeltaOf, balanceFlagsOf };`)();
ok("拿到本插件实现的 toolCallDeltaOf / balanceFlagsOf", typeof myMod.balanceFlagsOf === "function");

// ── ③ 造假的 session，覆盖各种工具调用形态 ──────────────────────────────
console.log("\n═══ ③ 造 session 并逐 seq 对比 ═══");

/** 造一个假 session：events 是 [{type, seq, data}]。 */
function mkSession(events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return {
    surface: { nodes: events.map((e) => e.seq) },
    eventAt: (seq) => bySeq.get(seq),
  };
}
const asst = (seq, nToolCalls) => ({
  type: "assistant/message",
  seq,
  data: {
    message: {
      role: "assistant",
      content: Array.from({ length: nToolCalls }, (_, i) => ({ type: "tool-call", id: `c${seq}-${i}` })),
    },
  },
});
const tool = (seq) => ({ type: "tool/result", seq, data: { message: { role: "tool" } } });
const user = (seq) => ({ type: "user/message", seq, data: { message: { role: "user", content: [] } } });

const CASES = [
  {
    name: "普通交替：user / asst(1 call) / result / user / asst(1 call) / result",
    events: [user(1), asst(2, 1), tool(3), user(4), asst(5, 1), tool(6)],
  },
  {
    name: "悬空：最后一个 tool-call 没有 result（步骤还开着）",
    events: [user(1), asst(2, 1), tool(3), user(4), asst(5, 1)],
  },
  {
    name: "一次多条 tool-call（并行调用）",
    events: [user(1), asst(2, 3), tool(3), tool(4), tool(5), user(6)],
  },
  {
    name: "纯文字，完全无工具调用",
    events: [user(1), asst(2, 0), user(3), asst(4, 0)],
  },
  {
    name: "开头就是悬空的 result 之前：asst(2calls) 后只回了一个",
    events: [user(1), asst(2, 2), tool(3), user(4)],
  },
  { name: "空 surface", events: [] },
  { name: "只有一个 user", events: [user(1)] },
];

for (const c of CASES) {
  const s = mkSession(c.events);
  const nodes = c.events.map((e) => e.seq);
  let mismatch = 0;
  const detail = [];
  // 内核：对每个 seq 求 before/after；我的：算一次 flags 数组
  let myFlags;
  try {
    myFlags = myMod.balanceFlagsOf(s, nodes);
  } catch (e) {
    myFlags = undefined;
    detail.push(`我的实现抛错：${e.message}`);
  }
  for (const [i, seq] of nodes.entries()) {
    let kBefore;
    let kAfter;
    try {
      kBefore = kernelMod.toolPairingBalancedBefore(s, seq);
    } catch (e) {
      kBefore = `throw:${e.message.slice(0, 40)}`;
    }
    try {
      kAfter = kernelMod.toolPairingBalancedAfter(s, seq);
    } catch (e) {
      kAfter = `throw:${e.message.slice(0, 40)}`;
    }
    const mBefore = myFlags?.[i];
    const mAfter = myFlags?.[i + 1];
    if (kBefore !== mBefore || kAfter !== mAfter) {
      mismatch += 1;
      detail.push(`seq=${seq} idx=${i}: 内核 before=${kBefore} after=${kAfter} / 我 before=${mBefore} after=${mAfter}`);
    }
  }
  ok(`「${c.name}」（${nodes.length} 个节点）`, mismatch === 0, detail.slice(0, 8).join("\n        "));
}

// ── ④ 再验一次"真的会不相等"：故意用错的事件增量 ────────────────────────
console.log("\n═══ ④ 反向校验：故意写错的增量必须被判为不等（证明上面不是空过）═══");
{
  const s = mkSession([user(1), asst(2, 1), tool(3)]);
  const nodes = [1, 2, 3];
  const correct = myMod.balanceFlagsOf(s, nodes);
  // 故意错：把 tool/result 的增量也当 0（漏掉配对）
  const wrongSrc = `
    function toolCallDeltaOf(event) {
      if (event?.type === "assistant/message") {
        const c = event?.data?.message?.content;
        return Array.isArray(c) ? c.filter((b) => b?.type === "tool-call").length : 0;
      }
      return 0;
    }
    ${extractFn("balanceFlagsOf")}
    return { balanceFlagsOf };`;
  const wrong = new Function(wrongSrc)();
  let wrongFlags;
  try {
    wrongFlags = wrong.balanceFlagsOf(s, nodes);
  } catch {
    wrongFlags = undefined;
  }
  const same = JSON.stringify(correct) === JSON.stringify(wrongFlags);
  ok("写错增量后结果**确实不同** ⇒ 上面的对比有分辨力", same === false, `正确=${JSON.stringify(correct)} 错=${JSON.stringify(wrongFlags)}`);
}

console.log(`\n${fail === 0 ? "探针通过：复刻与内核逐 seq 全等" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
