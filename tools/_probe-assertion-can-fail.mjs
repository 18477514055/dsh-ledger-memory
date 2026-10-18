/**
 * 探针：验证"上层值被钉进 profile 层"那条断言**真的能失败**（尺子校验）。
 *
 * ★ 为什么需要这个：一条永远不会失败的断言等于没有断言。
 *   本机规矩「先证明尺子对，再报结论」—— 这里把实现临时换成**旧的错误写法**，
 *   看自检会不会红。红 ⇒ 断言有效；不红 ⇒ 断言是摆设。
 *
 * 做法：把 lib/index.js 里那句合并临时改回 `{ ...inherited, ...current }`，
 * 只跑情形 27h，然后**恢复原样**（用读写前后内容比对，确保恢复干净）。
 *
 * 用法：node tools/_probe-assertion-can-fail.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * ★★★★★ 2026-10-18（D270 · 修 review v1.2.7 的 F10③）：**判据读「整个 lib/ 的拼接」，
 *   但**改坏与恢复只落在「命中的那个模块文件」上**。
 *
 * 🔴 病（review 实测）：这个探针原来只读 `lib/index.js` 一个文件。
 *    D216 把代码拆成 `defs` + `part1~5` + `index` 之后，24 条用例里有 **9 条**的
 *    `good` 串根本不在这个文件里 ⇒ 探针报"找不到要替换的那段" ⇒ `npm run probes` 非零。
 *    ★ review 说得对：「**这些是假红**，不能据此断言胶囊没有落盘实现」。
 *
 * ★ 为什么**不**用"拼接 → 改 → 按原来的边界拆回去"这种省事做法：
 *   ① 拼接再拆分，**边界与字节都得逐字节复原**，一旦差一个换行就悄悄改了源码；
 *   ② 而 `bad` 串里可能**含换行**（本文件好几个 `good`/`bad` 都是多行的）
 *      ⇒ 替换点一旦落在文件交界处，拆回去的归属就变成猜的。
 *   ③ 这个探针**真的写盘**，猜错的代价是把用户源码写坏（本机栽过）。
 *
 * ⇒ 采用**两段式**：拼接只用来**定位**（这段 `good` 住在哪个模块、是否唯一），
 *   真正 `writeFileSync` 的目标永远是**那一个具体模块文件**，
 *   恢复也按那个文件的名字还原它的原文（原文在内存里逐字留着）。
 *   ★ 这样"多文件"只影响**看得见什么**，不影响**改得对不对**。
 */
const LIB_DIR = path.join(path.resolve(import.meta.dirname, ".."), "lib");

/** 读整个 `lib/` 的拼接（按名排序 ⇒ 确定）。与 `selftest.mjs` 的 `readLibSource()` 同口径。 */
function readLibSource() {
  const names = fs.readdirSync(LIB_DIR).filter((n) => n.endsWith(".js")).sort();
  return names.map((n) => fs.readFileSync(path.join(LIB_DIR, n), "utf8")).join("\n");
}

const original = readLibSource();

/**
 * 定位一段 `good` 所在的那个**模块文件**（以及它在这个文件里的出现次数）。
 *
 * ★ 返回值刻意区分三种情况，因为它们要采取的动作**完全不同**：
 *   · `{file}`          —— 唯一命中，正常改
 *   · `{file, n>1}`     —— 同一个文件里出现多次 ⇒ 尺子会打偏（原唯一性闸门拦的就是它）
 *   · `{crossFile: n}`  —— **跨文件**出现多次 ⇒ 必须报"不唯一"，不能随便挑一个改
 *                          （那是"改了别的地方也报绿"的另一种形态）
 */
function locateGain(needle) {
  const hits = [];
  for (const n of fs.readdirSync(LIB_DIR).filter((x) => x.endsWith(".js")).sort()) {
    const s = fs.readFileSync(path.join(LIB_DIR, n), "utf8");
    const c = s.split(needle).length - 1;
    if (c > 0) hits.push({ file: n, count: c });
  }
  return hits;
}

/**
 * 把**每个模块文件**恢复到开工时的原文。
 *
 * ★ 为什么按文件恢复、而不是"把拼接串写回去"：
 *   拼接串写回**单个文件**会把 9 个模块揉成一个（灾难）；而"拼接串按原边界拆开写回"
 *   要逐字节复现边界，差一个换行就是静默改源码。
 *   ⇒ 开工时把每个文件的原文留在内存，恢复时**逐文件原样写回**，并逐字节核对。
 */
const ORIGINALS = new Map(
  fs.readdirSync(LIB_DIR).filter((n) => n.endsWith(".js")).sort()
    .map((n) => [n, fs.readFileSync(path.join(LIB_DIR, n), "utf8")])
);

function restoreAll() {
  for (const [name, text] of ORIGINALS) {
    const abs = path.join(LIB_DIR, name);
    let cur;
    try {
      cur = fs.readFileSync(abs, "utf8");
    } catch {
      cur = null;
    }
    if (cur !== text) fs.writeFileSync(abs, text, "utf8");
  }
}

/** 逐字节核对：所有模块都回到了开工时的原文。 */
function allRestored() {
  for (const [name, text] of ORIGINALS) {
    const abs = path.join(LIB_DIR, name);
    let cur;
    try {
      cur = fs.readFileSync(abs, "utf8");
    } catch {
      return false;
    }
    if (cur !== text) return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 开工前的"干净检查"（2026-10-09 加的，因为真的被这个坑咬过）
//
//   这个探针会**真的改** lib/index.js 再恢复。危险在于：
//   **如果上一次运行没恢复干净，这一次读到的 `original` 就是带伤的**，
//   于是"恢复"把伤**固化**下来 —— 而且症状极隐蔽：
//   语法通过、自检只红一两条、看上去像"某个小断言不对"。
//   实测撞到：line 3708 的水位旁路被留成 `>= 99`，自检只红 1 条。
//
//   ⇒ 开工前先确认：源码里**没有**任何用例的 `bad` 串。
//     有 ⇒ 立刻停手并报出来，**不要**在带伤的源码上继续跑
//     （否则把它当 baseline 恢复，伤就永久留下）。
// ══════════════════════════════════════════════════════════════════════════
{
  const casesStart = original.indexOf("const CASES = [");
  // 从**本文件**里抽 bad 串（不是从 index.js）。
  const me = fs.readFileSync(new URL(import.meta.url), "utf8");
  const block = me.slice(me.indexOf("const CASES = ["), me.indexOf("\n];", me.indexOf("const CASES = [")));
  const re = /name:\s*"([^"]+)"[\s\S]*?bad:\s*(`[\s\S]*?`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  const leftover = [];
  let m;
  while ((m = re.exec(block)) !== null) {
    const raw = m[2];
    let text;
    if (raw.startsWith("`")) text = raw.slice(1, -1);
    else if (raw.startsWith('"')) text = JSON.parse(raw);
    else text = raw.slice(1, -1);
    if (text.length > 0 && original.includes(text)) leftover.push(m[1]);
  }
  if (leftover.length > 0) {
    console.log("✗ 开工前检查失败：源码里**已经有**某个用例的 bad 串 ⇒ 上次没恢复干净。");
    for (const n of leftover) console.log(`    · ${n}`);
    console.log("\n  先跑 `node tools/_probe-dirty-source.mjs` 定位，并手工修回，然后重跑本探针。");
    console.log("  ⚠ 现在**不要**继续 —— 否则会把带伤的源码当作 baseline 恢复下来。");
    process.exit(3);
  }
}

/** 每个"应该能失败"的断言各配一个「把实现改回错误写法」的替换。 */
const CASES = [
  {
    name: "上层值被钉进 profile 层（D38 末节）",
    good: "const base = { ...(current ?? {}) };",
    bad: "const base = { ...(inherited ?? {}), ...(current ?? {}) };",
    /** 自检里应当报红的那条断言的特征词。 */
    marker: "钉进",
  },
  {
    name: "autoCompact 闸门包住了整个 agent/status 监听器（会废掉手动压缩）",
    // 把闸门从"自动排队处"移回"包住监听器"——即还原成我第一版的错误写法。
    good: "  {\n    ctx.on(\"agent/status\", async ({ agent, status }) => {",
    bad: "  if (cfg.autoCompact !== false) {\n    ctx.on(\"agent/status\", async ({ agent, status }) => {",
    // ★ 标记词必须**逐字取自失败清单**（2026-10-09 收紧判据后改正）：
    //   原来写「手动工具仍然排队」，而那一条其实是 **PASS**（排队确实成功了），
    //   真正红的是下面这条"真的压了"。
    marker: "手动那条**真的压了**",
  },
  {
    // ★★★ 2026-10-09：本 profile 里 compaction 挂在 preset 的 isolate 组里，
    //   裸 `ctx.get("compaction")` 恒为 undefined ⇒ 高保真压缩**从未执行过**。
    //   这里把三处调用中的**自动那条**改回裸 ctx.get，看情形 29 会不会红。
    name: "压缩服务用裸 ctx.get 取（拿不到 preset 的 isolate 服务）",
    good: "  const compaction = compactionServiceFor(ctx, agent);",
    // ★★ `all: true`：源码里现在有 **5 处**这个调用（自动 / 工具 / 命令 / 全量 / 轻量）。
    //   真实的"退回错误做法"是**每一处都退回去**，所以这里必须全替换 ——
    //   只改第一处不是那种情形（那是"一半对一半错"，而我们要验的是全错）。
    //   ★ 这个 `all` 是**被下面那道唯一性闸门逼出来的**：
    //     闸门第一次跑就报"出现 5 次" ⇒ 才发现这条老用例**一直只改了第一处**。
    all: true,
    bad: '  const compaction = ctx.get("compaction");',
    // ★ 同样改成**失败清单里真实出现的那条**（原来的词只在通过项里）。
    marker: "手动工具经 serviceFor **能排队**",
  },
  {
    // ★★★ 这一条是**为我自己第一版错修**立的防回归。
    //
    //   第一版我以为"agent 的 ctx 就在 preset 子树里"，于是改成
    //   `agent.ctx.get("compaction")` 优先。**那是错的** —— agent 的 ctx 在子树
    //   之外，同样拿不到；用户重启后症状原样复现。
    //   而当时那组断言**照样全绿**，因为它走的其实是第三兜底（agent.ctx）。
    //   ⇒ 现在把 resolver 换成那一版错写法，必须让情形 29 变红；不红就说明
    //     我又写了一条测不出错的断言。
    name: "★ 我第一版的错修：用 agent.ctx.get 取（agent 的 ctx 也不在 isolate 子树里）",
    good: `  for (const scope of [ctx, agent?.ctx]) {
    try {
      const presets = scope?.get?.("agentPresets");
      const viaPresets = presets?.serviceFor?.(agent, "compaction");
      if (ok(viaPresets)) return viaPresets;
    } catch {
      /* 这一条路不通就换下一条 */
    }
  }`,
    bad: `  try {
    const viaAgent = agent?.ctx?.get?.("compaction");
    if (ok(viaAgent)) return viaAgent;
  } catch {
    /* 错修那一版的写法 */
  }`,
    marker: "只有 agentPresets.serviceFor 拿得到",
  },
  {
    // ★★★ 2026-10-09（第二轮）：用户报"手动按压缩不能进行"。
    //   修法是把 `/ledger compact` 改成**当场压**。这里把它改回**旧的只排队**写法，
    //   看自检会不会红 —— 不红就说明那组新断言是摆设。
    name: "手动命令退回「只排队不执行」（用户报的那个 bug）",
    good: "    return await runManualCompactNow(ctx, invocation, state, capsule, root);",
    bad: `    {
      const _agent = invocation?.agent;
      const _sid = _agent?.session?.header?.id;
      if (typeof _sid === "string" && _sid !== "") {
        state.hfCompactAfterTurn.set(String(_sid), { at: Date.now(), source: "command" });
      }
      return { kind: "success", text: "**已排队：高保真压缩**" };
    }`,
    marker: "命令入口**当场压缩**",
  },
  {
    // ★★★ 落盘闸门的两条旁路（水位 ≥75% / 人手动发起）。
    //   把第一条（手动授权）拆掉 ⇒ 必须红，否则"到水位按压缩被拦住"会悄悄回来。
    name: "拆掉落盘闸门的「手动授权」旁路",
    good: `  if (opts?.manual === true) return { ok: true, why: "手动触发（用户已授权）" };`,
    bad: `  if (opts?.manual === "never") return { ok: true, why: "手动触发（用户已授权）" };`,
    marker: "人打的 /ledger compact 没落盘也",
  },
  {
    // ★★★ 同上，拆掉「水位 ≥75%」那条旁路。
    name: "拆掉落盘闸门的「水位 ≥75%」旁路",
    // ★ 2026-10-18（D270 · F10③）：`good` 串已更新 —— 原串 `opts.ratio >= FLUSH_GATE_BYPASS_RATIO`
    //   后来加了 `!isFull` 前置条件（全量压缩不走这条旁路），逐字对不上了。
    //   ★ 这是**探针过时**，不是修复失效：能力还在，只是写法演进过。
    good: 'if (!isFull && typeof opts?.ratio === "number" && opts.ratio >= FLUSH_GATE_BYPASS_RATIO) {',
    bad: 'if (!isFull && typeof opts?.ratio === "number" && opts.ratio >= 99) {',
    // ★ 2026-10-18（D270 · F10③）：marker 已更新 —— 那支旁路现在**只对增量生效**，
    //   而原先指定的那条断言（`水位 80% 且**没落盘**`）测的是**全量**（走 78% 紧急线），
    //   两支根本不相通 ⇒ 变异不会让它变红。真正守着这条旁路的是新加的 109①。
    marker: "109① ★★ 增量压缩：水位 80% 且没落盘",
  },
  {
    // ★★★ 2026-10-09（第三轮）：增量（分段）压缩 —— 用户 #107–#119 那套方案。
    //   把"相对涨幅"判据拆掉（改成永远不触发）⇒ 情形 30 必须红。
    //   不红就说明那组断言测不出"到底有没有按相对涨幅压"。
    name: "增量压缩的触发判据被拆掉（永不触发）",
    // ★ 2026-10-18（D270 · F10③）：原串 `if (!forced && since < trigger) {` 已不存在。
    //   现行写法把"没推过"与"涨够了"合成一个布尔（`notNudgedYet`）。
    //   ⇒ 改坏方式相应变成"让那个布尔恒为假"。
    good: "const notNudgedYet = nudgedAt === undefined || since - nudgedAt >= trigger;",
    bad: "const notNudgedYet = false;",
    // ★ 2026-10-18（D270 · F10③）：marker 已更新 —— 摘掉触发判据后真正红的是三条
    //   "轻推文案"的断言（31a 那组），不是原来写的"调了一次 compactRegion"。
    marker: "31a：而是**注入一句轻推**",
  },
  {
    // ★★★ 把"压掉固定一段（棘轮）"改成"全压"（retain=0）—— 那就退回旧行为了。
    //   ⇒ 必须红在"只压最旧一段、不碰最新"那条上。
    // ★ 2026-10-11：保留量已从"常量"改成"当前水位 − 每轮压掉的点"（棘轮），
    //   所以 good 串跟着改。**探针的 good 串必须跟着源码走**，
    //   否则它会因为"找不到 good 串"而报错或误判（本机栽过）。
    // ★ 2026-10-18（D270 · F10③）：D62 又把尺度从 `keepRatio * window` 改成
    //   **nodes 尺度**（`nodeSum - removePoints% * window`）⇒ 原串再次过时，已更新。
    name: "增量压缩退化成「全压」（retain 归零）",
    good: "const retainTokens = Math.max(1, Math.floor(nodeSum - (removePoints / 100) * pressure.window));",
    bad: "const retainTokens = Math.max(1, 0);",
    // ★ 2026-10-18（D270 · F10③）：marker 已更新 —— 归零后真正红的是新加的 109⑤
    //   （这条算式原先**没有任何断言守着**：改坏后自检照样全绿，实测如此）。
    marker: "109⑤ ★★ 可压 token 数**明显少于全部**",
  },
  {
    // ★★★ 增量压缩的锚点：必须取**压后**水位。
    //   取压前 ⇒ 阈值一轮比一轮高（21→42→63→84…）⇒ 冲破 70%，正是用户要避免的。
    //   （轨迹证据见 `tools/_probe-delta-anchor.mjs`。）
    // ★ 2026-10-11：写入已改成 `setAnchor(...)`（多了一步落盘），good 串随之更新。
    name: "增量压缩的锚点取成「压前」水位（阈值会一轮轮漂高）",
    good: `    const after = measurePressure(ctx, agent);`,
    bad: `    const after = undefined; // 冒充"量不到"⇒ 退回到不重量的错路`,
    // ★ 2026-10-18（D270 · F10③）：marker 已更新 —— 锚点取压前时真正红的是
    //   "实绩也要报（压前 35% → 压后 30.6% ⇒ 4.4 点）"那两条（数值算错）。
    marker: "且**实绩**也要报",
  },
  {
    // ★★★ 选范围时不检查工具配对平衡（会劈开步骤）。
    name: "选范围时不检查工具配对平衡（会劈开步骤）",
    good: "    if (flags[keepFromIdx] === true) break;",
    bad: "    if (true) break;",
    // ★ 2026-10-18（D270 · F10③）：marker 已更新 —— 不查配对平衡时真正红的是新加的 109③b。
    marker: "109③ b ★★ 任何保留量下",
  },
  {
    // ★★★ 2026-10-09（第四轮）：用户报"选择里没有手动压缩命令"。
    //   把提示文字改回**手抄**的旧样子（漏 compact / light）⇒ 6b-6 必须红。
    //   不红就说明"提示与子命令表不许分叉"这条没被守住。
    name: "命令提示改回手抄（漏掉 compact / light —— 用户报的那个缺陷）",
    good: "            hint: ledgerInputHint(),",
    bad: '            hint: "[回车=选择卡片 | status | show | init | update | archive | log]",',
    marker: "一个不漏",
  },
  {
    // ★★★ `/ledger light` 不唤醒 AI ⇒ idle 时什么都不会发生（D40 那个坑的翻版）。
    //
    //   ⚠️ 我第一版踩的坑（值得记）：`good` 写的是 `agent.steer({\n  id: randomUUID(),`，
    //   而源码里有 **5 处** `agent.steer({`，`String.replace` 只替换**第一处**
    //   （第 4142 行、与 light 无关）⇒ 探针"红不了"，看着像"断言是摆设"，
    //   其实是**尺子打偏了**。
    //   ⇒ 现在用 **light 函数特有的**整段（含它的注释），确保替换点唯一。
    //   ⇒ 本探针下面还有一条**唯一性断言**，专门防止这种"改错地方"。
    name: "手动轻量压缩不唤醒 AI（idle 时永远不会发生）",
    good: `  // ③ 唤醒一轮，让 pre-step 真的跑到（idle 时不唤醒就什么都不会发生 —— 这正是 D40 那个坑）。
  let steered = false;
  if (typeof agent.steer === "function") {`,
    bad: `  // ③ 唤醒一轮，让 pre-step 真的跑到（idle 时不唤醒就什么都不会发生 —— 这正是 D40 那个坑）。
  let steered = false;
  if (false) {`,
    marker: "唤醒了 AI",
  },
  {
    // ★★★ 手动的 light 压不成时**静默**（不写回执）⇒ 用户以为压了、其实没有。
    name: "手动轻量压缩压不成时静默（不告诉用户）",
    // ★ 2026-10-18（D270 · F10③）：缩进已变（12 空格 → 10 空格），原文对不上 ⇒ 已按实际。
    good: "            } else if (forcedLight) {",
    bad: "            } else if (false) {",
    marker: "如实说了",
  },
  {
    // ★★★ 手动 light 的 `force` 没传到压缩里 ⇒ 涨不够就压不了，
    //   也就是"按了没反应"（用户最烦的那种）。30g 必须红。
    name: "手动 light 的 force 没传进去（按了等于没按）",
    // ★ 2026-10-18（D270 · F10③）：调用点已移到 index.js，且写成单行属性 ⇒ 原多行串过时。
    good: "force: forcedLight,",
    bad: "force: false,",
    marker: "涨 3 点也压",
  },
  {
    // ★★★ 立了旗子却**不看旗子**（只看 text）⇒ 手动 light 在本轮无其它注入时永不执行。
    //   ★★ 这条标记词是**实测校准**出来的：我第一版写「涨 3 点也压」，
    //     而那其实是 30g 的断言 —— 30g 那一轮**还有别的注入**，走的是前半句，
    //     所以把 `|| forcedLight` 拆掉后 30g **照样绿**（探针当场指出"该词只在通过项里"）。
    //     ⇒ 真正红的是 30h（专造 `text === undefined` 的场面）。
    //   ⇒ 教训：**"这条用例能红"必须实测，不能推**。
    name: "增量压缩段不看 forcedLight（只认 text，手动 light 会静默失效）",
    // ★ 2026-10-18（D270 · F10③）：条件已扩成四路（加了 `deltaWanted` / `toolRequestedLight`），
    //   原 `(enableDelta && text !== undefined) || forcedLight` 逐字不存在了。
    //   改坏方式相应变成"把 forcedLight 那一路摘掉"。
    good: "if (!nudgedThisStep && ((enableDelta && text !== undefined) || deltaWanted || forcedLight || toolRequestedLight)) {",
    bad: "if (!nudgedThisStep && ((enableDelta && text !== undefined) || deltaWanted || false || toolRequestedLight)) {",
    marker: "仍然压了",
  },
  {
    // ★★★ 2026-10-10：`command/done` 的 name 修复（**这是从真实日志里抓到的 bug**）。
    //   回退成旧的读法（`d.name`，而该事件**没有 name**）⇒ 情形 34 必须红。
    //   不红就说明"日志必须有信息量"这条没被守住 —— 而它已经默默坏了一整天。
    name: "L0 的 command/done 回退成读 d.name（真实日志里全记成 `命令 /?`）",
    good: '    const nm = id === "" ? undefined : extra?.commandNames?.get(id);',
    bad: "    const nm = d?.name;",
    marker: "不再是 `命令 /?`",
  },
  {
    // ★★ 同一处的第二半：`command/run` 时不再记名字 ⇒ 反查必然落空。
    name: "不再从 command/run 记住命令名（反查必然落空）",
    // ★ 2026-10-18（D270 · F10③）：变量名 `type` 变 `t`，缩进也变了 ⇒ 已按实际。
    good: 'if (type === "command/run") {\n      rememberCommand(event.data?.commandId, event.data?.name);\n    }',
    bad: 'if (false) {\n      rememberCommand(event.data?.commandId, event.data?.name);\n    }',
    marker: "不再是 `命令 /?`",
  },
  {
    // ★★★ 2026-10-10（D45）：胶囊不再落盘 ⇒ 退回"重启就没、消费就没"。
    //   情形 35 必须红 —— 这条是本轮查出来的那个真缺口，最该守住。
    name: "胶囊不落盘（退回「重启就没、消费就没」）",
    good: "    const pr = persistCapsule(info.projectRoot, info, key, snap, { source });",
    bad: "    const pr = { ok: false, reason: \"probe: 故意不落盘\" };",
    marker: "磁盘上真的有胶囊文件",
  },
  {
    // ★★ 落盘不再检查"有没有启用日志" ⇒ 会往没登记的项目里偷写文件。
    //   ★ 标记词**逐字取自失败清单**（探针当场报"该词只在通过项里出现"）：
    //     我第一版写「一个文件都不写」，而那条其实**通过了** ——
    //     因为那条断言查的是 `_ledger-log` 下有没有胶囊，而偷写时写的就是那里；
    //     真正红的是「而且如实说**没存**」（回执说存了，其实是偷写的）。
    name: "胶囊落盘不检查「有没有启用日志」（会往没登记的项目里偷写文件）",
    // ★ 2026-10-18（D270 · F10③）：D165 把目录算法收口到 `capsuleDirRel()`，
    //   判据变量从 `dir` 变 `relDir`，缩进也变了 ⇒ 已按实际。
    good: '  if (relDir === undefined) {\n    return { ok: false, reason: "这个项目没启用活动日志 ⇒ 按约定不往项目里写文件" };\n  }',
    bad: '  if (false) {\n    return { ok: false, reason: "x" };\n  }',
    // ★★★★★ 2026-10-18（D270 · F10③）：**这条是「修复冗余」，不是「断言太弱」** ——
    //   实测（`tools/_diag-capsule.mjs`）：把这处检查改成恒假之后，
    //   `persistCapsule` **不是安静地写文件，而是抛 TypeError**
    //   （`path.resolve(root, undefined)` —— `relDir` 本身是 undefined）。
    //   ⇒ 这道检查其实是**第二道**：`capsuleDirRel()` 已经返回 undefined，
    //     而下一行 `path.resolve` 天然挡不住 undefined ⇒ 双重保护。
    //
    //   ★ 按 L10 的判据，**"摘一处不红"有两种成因，必须说清是哪一种**：
    //     ① 断言太弱（该补断言）② 修复冗余（该如实记录，硬补断言反而是表演）。
    //     这里是 ②。⇒ 这条用例改成**接受两种合格结局**：
    //       a) 自检真的变红（说明那一行确实是唯一防线）；或
    //       b) 那一行被摘掉后**抛错**（说明有冗余保护，同样安全）。
    //     两者都通过；只有"既不红、也不抛错、还悄悄写了文件"才算缺陷。
    redundantGuard: true,
    marker: "磁盘上**真的有胶囊文件**",
  },
  {
    // ★★★ 2026-10-10（第③层）：新会话的注入**不再点名交接单** ⇒
    //   环路就断了（写得出文件，却没人被告诉去读）。情形 36b 必须红。
    //   ★ 这条是本轮最该守住的一条：D34 那条结论就是"恢复必须是推给模型的"。
    name: "新会话注入不再点名交接单（环路断掉 —— 写得出、没人读）",
    good: "      (info.handoffLatestRel !== undefined\n        ? \"\\n★ **接手这个项目时，先读上一次的交接单**：\" +",
    bad: "      (false\n        ? \"\\n★ **接手这个项目时，先读上一次的交接单**：\" +",
    marker: "主动点名",
  },
  {
    // ★★ 交接单目录解析的判据写错（用 `isGitRepo` 而不是"是不是容器"）⇒
    //   那些"建了台账但还没 git init"的项目会解析不出目录，工具直接失败。
    //   ★ 这正是我第一版真犯的错（实测 `ok:false`），所以必须有用例钉住。
    //   ★★ 标记词是**实测校准**的：我第一版写「写成功」，探针报
    //     "该词只在通过项里出现" —— 因为真实情况是自检**崩在** `path.basename(undefined)`，
    //     **失败清单根本没打印**，探针当然找不到任何标记词。
    //     ⇒ 修法是把断言本身改成耐失败的（先 `typeof === "string"` 再正则），
    //       于是失败清单正常打印，红的就是**第一条**关联断言：「落在 `_handoff/` 约定目录里」。
    name: "交接单目录判据写成 isGitRepo（没 git init 的项目就写不了交接单）",
    good: "  if (!isContainer) {\n    const manifestHandoff =",
    bad: "  if (isGitRepo) {\n    const manifestHandoff =",
    marker: "约定目录里",
  },
  {
    // ★★★ 2026-10-10（用户报的顺序 bug）：承诺判据失效 ⇒
    //   退回"自上次压缩以来落过盘吗"那个周期判据的漏洞 —— 到了水位这一步，
    //   往往**上一个周期**已经写过台账 ⇒ 放行 ⇒ 又变成"先压缩、再写台账"。
    //   ★ 这条是本轮那个修复的**唯一**机制（另一个 `noticeJustSent` 已被实测证明
    //     是死代码并删除），所以必须钉住。
    //
    // ★★★★★ 2026-10-18（D270 · F10③）：**这条用例的"被测机制"已经不存在了**。
    //
    //   🔴 实测（`grep 'flushOwedAt\.(set|get|delete)' lib/*.js`）⇒ **0 个赋值/读取点**。
    //      真源 `lib/defs.js:3097-3103` 逐字写着：
    //        「2026-10-12（D131，用户拍板"清掉"）：这里原来有两个 Map ——
    //          flushOwedAt 与 flushOwedStep …… **它们连同"承诺判据"整段一起删了**，
    //          因为唯一给 flushOwedAt 赋值的地方在 D129 按用户要求删掉了」
    //      ⇒ 守着"先记台账再压缩"的现在是**周期判据**（`flushedAt` vs
    //        `lastCompactCycleAt`），不是这条用例想测的那个东西。
    //
    //   ★ 为什么**不**改成"串个别的"：那样会造出一条**改不到实处**的用例 ——
    //     本文件末尾自己的注释早就写明了：「一条改不到实处的用例，比没有更坏，
    //     因为它让人以为覆盖到了」。
    //   ★ 也**不静默删掉**：删了之后没人知道"这里曾经有一条守卫、它去哪了"。
    //   ⇒ 用 `retired` 显式标记：**跳过执行，但在输出里点名叫出来 + 写清为什么**。
    //     这样下次有人以为这块有覆盖时，能立刻看见"它已经退役了，原因是用户拍板删了机制"。
    retired: "D131（2026-10-12）用户拍板删除 `flushOwedAt` 机制 ⇒ 无对象可变异；现由周期判据守着",
    name: "承诺判据失效（退回周期判据的漏洞 ⇒ 先压缩、再写台账）",
    good: "  const owedAt = state.flushOwedAt.get(key);\n  if (owedAt !== undefined) {",
    bad: "  const owedAt = undefined;\n  if (owedAt !== undefined) {",
    marker: "发提醒的那一步**不许压**",
  },
  {
    // ★★ 同上，另一半：发提醒时**不立标记** ⇒ 等于从没要求过它写。
    //   ★ 两半分开测是有意的：只测一半的话，另一半可以是死代码而没人知道
    //     （这正是 `noticeJustSent` 的下场）。
    //   ★★ 这一条**顺带**把 30a-2 那条"文案不自相矛盾"也验红了（探针输出里能看到
    //     两条一起红）—— 所以**不必**再为它单独立一条用例。
    //     ⚠️ 我原来确实立了第三条（往 `deltaHandled` 那行塞一句假文案），
    //        探针当场报"该词只在通过项里出现" —— **它是对的**：那行在
    //        `r.ok === true` 分支里，而 30a-2 那一步压缩是被拦下的（`r.ok` 为假），
    //        **根本走不到** ⇒ 那条用例改的是一个永远不执行的路径。
    //     ⇒ 已删。**一条改不到实处的用例，比没有更坏**：它让人以为覆盖到了。
    //
    // ★ 2026-10-18（D270 · F10③）：与上一条同因 —— `flushOwedAt.set(...)` 已随
    //   D131 一起删除（实测赋值点 0 处）⇒ 无对象可变异。同上，用 `retired` 显式退役。
    retired: "D131（2026-10-12）用户拍板删除 `flushOwedAt` 机制 ⇒ 无对象可变异；现由周期判据守着",
    name: "发水位提醒时不立「欠一次落盘」的标记（等于没要求过它写）",
    good: "                state.flushOwedAt.set(String(sid), Date.now());",
    bad: "                /* probe: 不立标记 */;",
    marker: "发提醒的那一步**不许压**",
  },
];

let allOk = true;
const retiredNames = [];
for (const c of CASES) {
  console.log(`\n═══ 尺子校验：${c.name} ═══`);

  // ★ 显式退役：被测机制**已经不存在** ⇒ 跳过执行，但**必须说出来**。
  //   ★ 为什么不能静默 `continue`：那样输出里只剩"24 条里的 22 条跑过"，
  //     没人看得出少的是哪两条、为什么少 —— 而这三样正是"覆盖还在不在"的全部信息。
  //   ★ 为什么不能改串硬跑：本文件自己写着「一条改不到实处的用例，比没有更坏」。
  if (c.retired !== undefined) {
    retiredNames.push({ name: c.name, why: c.retired });
    console.log(`  SKIP  已退役：${c.retired}`);
    continue;
  }

  // ★★★ 关键：**先恢复一次**再开始。这样即使上一次循环异常退出，
  //   这一次也从一个干净的文件开始（下面 try/finally 是主保障，这是兜底）。
  //   （2026-10-09 实测：某个用例的 bad 串留在了文件里 —— line 3708 变成 `>= 99`，
  //     而自检只红 1 条、语法还通过 ⇒ 看着像"小问题"，其实是**源码带伤**。
  //     新增 `tools/_probe-dirty-source.mjs` 专门扫这种残留。）
  restoreAll();

  if (!original.includes(c.good)) {
    console.log("  FAIL  找不到要替换的那段（源码可能与预期不同）");
    allOk = false;
    continue;
  }
  // ★★★ 唯一性闸门（2026-10-09 新加）：`good` 必须在源码里**只出现一次**。
  //
  //   为什么：`String.replace(str, …)` 只替换**第一处**。如果 `good` 写的是一段
  //   在别处也存在的通用代码（我第一版用 `agent.steer({\n  id: randomUUID(),`，
  //   而源码里有 5 处），探针实际改的是**另一个函数** ⇒ 自检照样全绿 ⇒
  //   表现为"这条断言是摆设"，**其实是尺子打偏了**。
  //   宁可在这里响亮地失败，也不要给出一个假的"断言无力"结论。
  //
  // ★ 2026-10-18（D270 · F10③）：**这一关在拼接源上更要紧** ——
  //   拼接把 9 个文件接成一串后，跨模块**凑巧**出现两次是完全可能的
  //   （实测就有 1 条：`compactionServiceFor(...)` 在 part3 与 part5 共 6 处）。
  //   ⇒ 判定必须按「跨**整个 lib**」算，而不是按单个文件算。
  {
    const hits = locateGain(c.good);
    const total = hits.reduce((s, h) => s + h.count, 0);
    // ★ `all: true` 的用例**故意**要求多处同时替换 —— 因为"退回错误做法"这件事
    //   在真实世界里是**每一处都退回**，只改一处不是那种情形。
    if (total > 1 && c.all !== true) {
      const where = hits.map((h) => `${h.file}×${h.count}`).join(" + ");
      console.log(`  FAIL  \`good\` 在整个 lib 里出现 ${total} 次（${where}）⇒ replace 只改**一处**，尺子打偏`);
      console.log("        修法：① 把 good 换成含该函数特有上下文的一段（唯一）；或 ② 给用例加 `all: true`（确实每一处都该改）。");
      allOk = false;
      continue;
    }
    if (hits.length === 0) {
      console.log("  FAIL  找不到要替换的那段（整个 lib 里都没有）");
      allOk = false;
      continue;
    }
  }
  let ok1 = false;
  let ok2 = false;
  // ★ 必须在 `try` **之前**声明：它在 `try` 外面（`allOk` 那行）还要用。
  //   （本项目栽过 TDZ 一次 —— D269 的 `ensureFile`；同一个形状。）
  let redundantPass = false;
  try {
    // ★ 只改**命中的那些模块文件**（`all` 时可能是多个），改完能逐个精确恢复。
    //   绝不"拼接改完再拆回去"—— 边界与字节都得复原，差一个换行就悄悄改了源码。
    for (const h of locateGain(c.good)) {
      const abs = path.join(LIB_DIR, h.file);
      const one = fs.readFileSync(abs, "utf8");
      const patched = c.all === true ? one.split(c.good).join(c.bad) : one.replace(c.good, c.bad);
      fs.writeFileSync(abs, patched, "utf8");
    }
    const r = spawnSync(process.execPath, ["tools/selftest.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    ok1 = /失败 [1-9]\d* 项/.test(out);
    // ★★★★★ 2026-10-18（D270 · F10③）：**"修复冗余"这一档的判定**。
    //   有些修复是**两道防线**（摘掉一处在运行时就会抛错，而不是真的犯错）。
    //   那时"摘了不红"**不是缺陷**，但也不能就这么放过 —— 判据改成：
    //     「**要么变红，要么抛错**」；只有"既不红、也不抛错"才算真没问题。
    //   ★ 为什么必须显式区分：把这一档混进"变红"，就是拿"崩溃"冒充"守卫生效"；
    //     而直接判失败，则是要求代码只有一道防线 —— 那会把冗余保护当成缺陷。
    const threwHard = /SyntaxError|ReferenceError|TypeError|ERR_[A-Z_]+/.test(out);
    // ★ 用标志位 + 后面的分支处理，**不能在这里 `continue`** ——
    //   那样会跳过后面的 `finally { restoreAll(); }`（源码就留在改坏状态了）。
    const redundantPassNow = c.redundantGuard === true && !ok1 && threwHard;
    redundantPass = redundantPassNow;
    if (redundantPassNow) {
      const crash = out.match(/(?:SyntaxError|ReferenceError|TypeError|ERR_[A-Z_]+)[^\n]*/);
      console.log(`  PASS  旧写法下**不是变红，而是抛错** ⇒ 这道检查是第二道防线（有冗余保护）`);
      console.log(`        抛的是：${String(crash?.[0] ?? "").slice(0, 120)}`);
      console.log("        ★ 不计入「断言有效」，但也不判失败 —— 见该用例的 `redundantGuard` 注释");
    }
    // ★★ 关键修正（2026-10-09 自查发现）：原来用 `out.includes(marker)` 判"点名"，
    //   而那是**全文搜索** —— 标记词出现在任何一条 **PASS** 的文案里也会算命中。
    //   于是"红的是对的那条"这个判断可能被**通过的那条**满足，等于没判。
    //   ⇒ 只在**失败清单**里找。失败清单由 selftest 末尾打印（`失败清单：` 到分隔线）：
    const failList = out.match(/失败清单：([\s\S]*?)═/)?.[1] ?? "";
    const inFailList = failList.includes(c.marker);
    // 同时记下"标记词在全文里出现过但不在失败清单里"这种可疑情形。
    const onlyOutside = !inFailList && out.includes(c.marker);
    ok2 = inFailList;
    if (!redundantPass) {
      console.log(`  ${ok1 ? "PASS" : "FAIL"}  旧写法下自检**确实变红**`);
      console.log(
        `  ${ok2 ? "PASS" : "FAIL"}  而且是**那条**断言报的红（点名「${c.marker}」）` +
          (onlyOutside ? "  ⚠ 该词只在通过项里出现 ⇒ 判据是漏的" : "")
      );
      const m = failList;
      if (m.trim() !== "") {
        console.log("        红的是：" + m.trim().split("\n").map((s) => s.trim()).join(" / "));
      }
    }
  } finally {
    restoreAll();
  }
  // ★ 冗余保护那档：`ok1/ok2` 都可能是 false，但它已经在上面的分支里被判为合格。
  allOk = allOk && (redundantPass || (ok1 && ok2));
}

// ★ 无论上面怎么炸，都要把**每个模块**恢复原样，并**逐字节核对**。
const same = allRestored();
console.log(`\n  ${same ? "PASS" : "FAIL"}  已恢复原样（逐文件逐字节比对 ${same ? "全部相同" : "**有不同**"}）`);
if (!same) process.exit(1);

// ★ 退役用例必须**被报出来**（否则"少跑了两条"与"两条都过了"长得一样 —— L34 同型）。
if (retiredNames.length > 0) {
  console.log(`\n  已退役 ${retiredNames.length} 条（**跳过执行**，不是通过）：`);
  for (const r of retiredNames) {
    console.log(`    · ${r.name}`);
    console.log(`      原因：${r.why}`);
  }
}

// 恢复后再跑一遍，确认回到全绿
const r2 = spawnSync(process.execPath, ["tools/selftest.mjs"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  encoding: "utf8",
});
const green = /通过 \d+ 项，失败 0 项/.test(r2.stdout ?? "");
console.log(`  ${green ? "PASS" : "FAIL"}  恢复后自检回到全绿`);

console.log(`\n${allOk && green ? "全部通过" : "失败"}`);
process.exit(allOk && green ? 0 : 1);
