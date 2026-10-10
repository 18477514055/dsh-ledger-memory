// ★★★ 重启后验证：**活内核到底加载了哪一版代码**（只读，不写任何东西）。
//
// 为什么必须有这个（D59 的教训）：
//   我写了棘轮、自检全绿、还发了 1.0.0，**却从没核对过"活内核里跑的是哪一版"**。
//   用户那句"一次增量压缩都没发生"戳的就是这个盲区。
//   ⇒ 「文件改了」≠「内核加载了」。两者之间隔着一次**重启**。
//
// ═══ 判据一（首选，**结构性**、不怕正文污染）═══
//   `ledger_status` 工具是否返回 `compactionCounts` 字段。
//   这是 1.1.0 新增的**顶层字段** —— 旧代码不可能有。
//   ★ 为什么首选它：它不受"正文里恰好出现某个词"的干扰（见下面判据二的教训）。
//
// ═══ 判据二（辅助，**文本**）═══
//   注入正文里那条旧矛盾句「**收尾停手**」是否**消失**。
//   1.1.0 把常驻指令里「70% 时请收尾停手、把选择权交给用户」改成了「继续手上的活」，
//   所以**新代码不该再出现这五个字**（除了台账正文里引用它，见下）。
//
//   ⚠️ 我在这里栽过一次，记下来：一开始我拿「**义务**」当新代码的标记 ——
//     结果 40 条注入里 9 条命中，看似"部分生效"。**其实是污染**：
//     最近的注入把**我写的 LEDGER.md 正文**一起带进去了，而第十八节标题里就有「义务」。
//     ⇒ **判据词不能是本项目自己会写进正文的词。**
//     ⇒ 要挑「只可能出现在插件指令模板里」的词，并且优先用**结构性字段**。
//
// ★ 其他踩过的坑（都体现在这个文件里）：
//   · 注入正文**不在** `data.message.content`，也不在 `agent/inbox/spliced`；
//     本插件的注入是以 **`user/message`** 事件落盘的（含「台账约定」那段）。
//   · 会话日志是**多帧 zstd**，`zstdDecompressSync` 只解第一帧 ⇒ 必须按帧切。
//   · 事件 `time` 是**数字毫秒**（按 string 判会静默全放行）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? "", ".dsh");
const SESS = path.join(HOME, "sessions");

/** 多帧 zstd：按魔数切帧后逐帧解（只解第一帧会丢掉 99% 的内容）。 */
function decodeMultiFrameZstd(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) {
    starts.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  let out = "";
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      out += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8");
    } catch {
      /* 单帧坏了不影响其余 */
    }
  }
  return out;
}

/** 最近被写过的会话日志。 */
function newestSessionLog() {
  if (!fs.existsSync(SESS)) return undefined;
  let best;
  for (const d of fs.readdirSync(SESS)) {
    const dir = path.join(SESS, d);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const sub of fs.readdirSync(dir)) {
      const p = path.join(dir, sub, "session.v4.jsonl.zstd");
      if (!fs.existsSync(p)) continue;
      const m = fs.statSync(p).mtimeMs;
      if (best === undefined || m > best.mtimeMs) best = { path: p, mtimeMs: m, dir: sub };
    }
  }
  return best;
}

const found = newestSessionLog();
if (found === undefined) {
  console.log("FAILED：找不到会话日志（换过 DSH_HOME？）");
  process.exit(2);
}

console.log(`会话日志：${found.dir}`);
console.log(`最后写入：${new Date(found.mtimeMs).toLocaleString("zh-CN")}`);

const text = decodeMultiFrameZstd(fs.readFileSync(found.path));
console.log(`解出字符：${text.length.toLocaleString()}`);
console.log("");

// ── 判据二：注入正文里的旧矛盾句 ──────────────────────────────────────
//
// ★★★ 2026-10-11 **两个「尺子错」都发生在这里，务必看清**：
//
//   错法①（指标没有时间窗）：第一版把**全部历史注入**一起数（42 条）
//     ⇒ 重启后必然仍报「42/42 是旧代码」，因为重启前那 40 条**永远留在日志里**。
//     ⇒ 修：只看**最近一条**。
//
//   错法②（判据词被自己的台账污染）：修完①之后**仍然全红**，因为
//     本插件的注入 = **插件指令模板 + 整个 LEDGER.md 正文**，
//     而我在 LEDGER.md 第十八节里**亲手引用了那句旧话**（"常驻那句说「70% 请收尾停手…」"）
//     ⇒ 于是"旧句还在"这个判据**永远为真**，无论代码是新是旧。
//     ⚠️ **同一个坑我当天已经为「义务」记过一次教训**（"判据词不能挑本项目会写进正文的词"），
//        转头又为「收尾停手」踩了同一遍。
//     ⇒ 修：**把台账正文剥掉**（它夹在 `<<<LEDGER` 与 `LEDGER>>>` 之间），
//        只查**插件自己的指令模板**。这才是"代码版本"的真实指纹。
//
//   ★ 沉淀成一句通用纪律：**判据的输入必须是"被测系统自己产生的那部分"** ——
//     把被观测方的正文混进来，测的就不是它了。
function templateOnly(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf("<<<LEDGER", i);
    if (a < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, a);
    const b = s.indexOf("LEDGER>>>", a);
    if (b < 0) break; // 正文没闭合就到此为止（保守：宁可少查，不可误判）
    i = b + "LEDGER>>>".length;
  }
  return out;
}

const rows = [];
for (const line of text.split("\n")) {
  if (!line.includes("台账约定")) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.type !== "user/message") continue;
  const body = JSON.stringify(e);
  // ★ 关键：剥掉台账正文之后再看模板
  const tpl = templateOnly(body);
  rows.push({
    at: typeof e.time === "number" ? e.time : 0,
    old: tpl.includes("收尾停手"),
    duty: tpl.includes("是你的义务"),
  });
}
rows.sort((a, b) => a.at - b.at);

console.log("── 判据二（文本）：注入**模板**里的旧矛盾句「收尾停手」──");
console.log(`  历史注入共 ${rows.length} 条（**含重启前的，不能全数** —— 见上）`);
const recent = rows.slice(-6);
console.log(`  最近 ${recent.length} 条（已剥掉台账正文）：`);
for (const r of recent) {
  console.log(
    `    ${new Date(r.at).toLocaleString("zh-CN")}  ` +
      `旧矛盾句=${r.old ? "有" : "**无**"}   义务句=${r.duty ? "**有**" : "无"}`
  );
}
const last = rows[rows.length - 1];
console.log("");
console.log("★ 只看**最近一条**（历史会淹没现状），且**只看模板**（台账正文会污染判据）");
console.log("");

// ── 判据一：结构性字段（这个探针**不能**自己调工具，所以给出指令）──────
console.log("── 判据一（结构性，首选）：`ledger_status` 有没有 `compactionCounts` ──");
console.log("  ★ 这个探针是只读脚本、调不了插件工具，所以由 AI 来查；");
console.log("     它比任何文本判据都可靠：那是 1.1.0 新增的顶层字段，旧代码不可能有。");
console.log("");

if (rows.length === 0) {
  console.log("判定：? **样本不足**（本段对话没触发过插件注入）");
  console.log("  ⇒ 不要据此说「代码没生效」。改看 `ledger_status` 的 `compactionCounts`：");
  console.log("     有 ⇒ 新代码已加载；没有 ⇒ 仍是旧代码（需重启）。");
  process.exit(3);
} else if (last.old) {
  console.log("判定：✗ **最近一次注入仍是旧代码**（还带着「收尾停手」）");
  console.log(`  （出现在 ${new Date(last.at).toLocaleString("zh-CN")}）`);
  console.log("  ⇒ 结论：需要**重启内核**，新代码才会被加载。");
  process.exit(1);
} else {
  console.log("判定：✓ **新代码已生效**（最近一次注入已无旧矛盾句）");
  console.log(`  （${new Date(last.at).toLocaleString("zh-CN")}；义务句=${last.duty ? "有" : "无"}）`);
  process.exit(0);
}
