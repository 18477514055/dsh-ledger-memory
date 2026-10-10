/**
 * 校准夹具：用**成对**的 surface（user / assistant(tool-call) / tool/result）
 * 算出 30a 该用多少节点、多少 token，才能真的"只压最旧一段"。
 *
 * ★ 上一版夹具的错：只造了 assistant(tool-call)、**从不造 tool/result**
 *   ⇒ 未回应的工具调用数一路累加 ⇒ 除开头外**所有切点都不平衡**
 *   ⇒ 选范围时 `while (keepFromIdx > firstIdx)` 一路退到 0 ⇒ 永远 null。
 *   实测真实会话里 tool/call 160 : tool/result 159（近乎成对，差的 1 个是当前开着的步骤）
 *   ⇒ 夹具必须成对。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return src.slice(start, end);
}
const mod = new Function(
  `${extractFn("toolCallDeltaOf")}\n${extractFn("balanceFlagsOf")}\n${extractFn("selectIncrementalRange")}
   return { selectIncrementalRange, balanceFlagsOf };`
)();

/** 成对的 surface：每轮 = user / assistant(1 tool-call) / tool/result。 */
function pairedEvents(rounds) {
  const events = [];
  let seq = 1;
  for (let r = 0; r < rounds; r += 1) {
    events.push({ type: "user/message", seq, data: { message: { role: "user", content: [] } } });
    seq += 1;
    events.push({
      type: "assistant/message",
      seq,
      data: { message: { role: "assistant", content: [{ type: "tool-call", id: `c${seq}` }] } },
    });
    seq += 1;
    events.push({ type: "tool/result", seq, data: { message: { role: "tool" } } });
    seq += 1;
  }
  return events;
}

for (const rounds of [5, 7]) {
  const events = pairedEvents(rounds);
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const session = { surface: { nodes: events.map((e) => e.seq) }, eventAt: (s) => bySeq.get(s) };
  const nodes = session.surface.nodes;
  const flags = mod.balanceFlagsOf(session, nodes);
  console.log(`\n轮数=${rounds} ⇒ 节点=${nodes.length}（seq 1..${nodes.length}）`);
  console.log(`  平衡切点 ${flags.filter(Boolean).length}/${flags.length}，flags=${flags.map((b) => (b ? "1" : "0")).join("")}`);

  // 每个节点 10 token；窗口 1000 ⇒ retain(10%) = 100 ⇒ 保留最后 10 个
  for (const [tok, keepPts] of [
    [10, 10],
    [10, 20],
    [20, 10],
  ]) {
    const measurement = { nodes: nodes.map((s) => ({ seq: s, tokens: tok })) };
    const retain = Math.floor((keepPts / 100) * 1000);
    const r = mod.selectIncrementalRange(session, measurement, retain);
    console.log(
      `  token/节点=${tok} 保留=${keepPts}点(retain=${retain}) ⇒ ${JSON.stringify(r)}` +
        (r === null ? "" : `（压 ${r.end - r.start + 1} 个节点，留 ${nodes.length - (r.end - r.start + 1)} 个）`)
    );
  }
}
