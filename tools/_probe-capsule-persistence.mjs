/**
 * ★ 回归守卫：逐字胶囊**必须**有落盘通道（D45）。
 *
 * ★ 来历：这个探针最初是**抓缺陷**用的 —— 2026-10-10 实测发现
 *   `capsuleSnapshot` 的 10 处用法里"与写盘有关的 **0 处**"，
 *   即胶囊只活在内存 Map：进程一重启就没了、被压缩消费掉也没了。
 *   ★ 而它恰恰是最该留存的东西 —— 尤其「器物索引」那一节：
 *     Factory 用 36,611 条生产消息实测，三家压缩方案在"哪些文件被改过"
 *     这一维只有 2.19–2.45/5，社区点名它是"统一薄弱、且最影响编码 agent 成败"的一维。
 *
 * ⇒ 缺陷修掉之后，这个探针**改成守卫**：它现在要求那些通道**在**，
 *   而不是报告它们缺失。（否则它会永远"报红"，变成没人看的噪音。）
 *
 * ★★★★★ 2026-10-18（D270 · 修 review v1.2.7 的 F10②）：**必须读「整个 lib/ 的拼接」**。
 *
 *   🔴 病（review 实测）：这里原来只读**一个**模块文件（拆分前的那个总入口），
 *      而 D216 把代码拆成 `defs` + `part1~5` + `index` ⇒
 *      `persistCapsule` 搬到 `part1.js`、`captureCapsuleBeforeCompact` 搬到 `part5.js`
 *      ⇒ 本探针**12 项全部报红**。
 *      ★ review 的原话点得很准：「**这些是假红**，不能据此断言胶囊没有落盘实现。」
 *      ★ 假红和假绿是同一种病的两面：都让"验过了"变成一句空话。
 *
 *   ★ 为什么不是"改成读 part1.js + part5.js"（那样更快改）：
 *     那等于把**文件的当前布局**钉进判据 ⇒ 下次再拆一次，这个探针**又**会集体假红，
 *     而"又假红一次"的经验会让人慢慢开始忽略它（这正是它退化成噪音的路径）。
 *     ⇒ 正确口径早就在本项目里了：`selftest.mjs` 的 `readLibSource()`
 *       （D146 立的规矩）与 `_probe-pack-check.mjs`（D216 当场撞到同一个病）。
 *     ⇒ **一个事实一个出口**：这里照抄同一口径。
 *
 * 用法：node tools/_probe-capsule-persistence.mjs
 */
import path from "node:path";
import fs from "node:fs";

const LIB_DIR = path.join(path.resolve(import.meta.dirname, ".."), "lib");

/**
 * 读**整个 `lib/` 的拼接**（按文件名排序 ⇒ 结果确定，不依赖 readdir 顺序）。
 * ★ 与 `selftest.mjs` 的 `readLibSource()` 逐字同口径。
 */
function readLibSource() {
  const names = fs.readdirSync(LIB_DIR).filter((n) => n.endsWith(".js")).sort();
  return names.map((n) => fs.readFileSync(path.join(LIB_DIR, n), "utf8")).join("\n");
}

const src = readLibSource();

let fail = 0;
const need = (label, cond, detail) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) {
    fail += 1;
    if (detail !== undefined) console.log(`      ${detail}`);
  }
};

console.log("═══ 胶囊落盘通道守卫（D45）═══\n");

/**
 * 取某个函数的**自然边界切片**（从声明到最后一条顶层语句之前）。
 *
 * ★ 为什么不用固定长度窗口（原来是 `slice(idx, idx + 3000)`）：
 *   实测 `persistCapsule` 的自然长度是 **3555 字符** > 3000 ⇒
 *   固定窗口**把它尾部截掉了**，而截掉的部分里正好可能有判据要找的东西
 *   ⇒ 那是**静默少算**（D167 那种"看着成功、其实没看到"的镜像）。
 *   反向的坑同样存在：函数很短时窗口会**伸进下一个模块**，
 *   把别人的 `writeFileSync` 算成"它真的写文件" ⇒ 假绿。
 *   ⇒ **按函数自己的边界切**，两头都不会错。
 */
function functionBodyOf(srcText, signature) {
  const i = srcText.indexOf(signature);
  if (i === -1) return "";
  const rest = srcText.slice(i + signature.length);
  const m = /\n(?:export\s+)?(?:async\s+)?function\s|\n(?:export\s+)?(?:const|let)\s/.exec(rest);
  return m ? srcText.slice(i, i + signature.length + m.index) : srcText.slice(i);
}

// ① 存在落盘函数，且它真的写文件
need(
  "有 `persistCapsule` 函数",
  /function persistCapsule\(/.test(src),
  "没有落盘函数 ⇒ 胶囊又会退回「只在内存」"
);
const pBody = functionBodyOf(src, "function persistCapsule(");
need("`persistCapsule` 真的写文件（`writeFileSync`）", /writeFileSync\(/.test(pBody));
// ★ 数**个数**而不是"有没有"：`persistCapsule` 里有**两个**写盘点
//   （正常一次 + 撞名时换后缀一次），两处都必须 `wx`。
//   ⚠️ 我第一版只判 `flag: "wx"` 存在，而那在全文件里有 3 处 ⇒
//      只改掉一个写盘点，这条守卫**照样绿**（用 `_tmp-verify-persist-guard` 实测撞到）。
//      真正"永不覆写"的行为证明在自检情形 35b（再压一次 ⇒ 多一个文件）。
const wxCount = (pBody.match(/flag:\s*"wx"/g) ?? []).length;
need(
  `★ 两个写盘点都用 \`flag: "wx"\` ⇒ **永不覆写**（实际 ${wxCount} 处，应为 2）`,
  wxCount === 2,
  "少一处 ⇒ 撞名那条路会覆盖已有的胶囊（记录就不再是证据）"
);
need("★ 且做**路径逃逸检查**（`isUnder`）", /isUnder\(root, abs/.test(pBody));
need(
  "★★ 且**没启用日志时不写**（守住「没登记就不写项目」的承诺）",
  /relDir === undefined/.test(pBody) && /没启用活动日志/.test(pBody)
);

// ② 压缩前抓胶囊的**唯一入口**存在，且里面调了落盘
need("有 `captureCapsuleBeforeCompact`（四条压缩路径的统一入口）", /function captureCapsuleBeforeCompact\(/.test(src));
const cBody = functionBodyOf(src, "function captureCapsuleBeforeCompact(");
need("★★ 它内部调了 `persistCapsule`（不只是存内存）", /persistCapsule\(/.test(cBody));
need("★ 且落盘失败**不挡压缩**（单独 try 包住）", /try \{[\s\S]{0,200}persistCapsule\(/.test(cBody));

// ③ 每条真压缩路径都走那个入口
//
// ★★★ 2026-10-18（D270 · F10②）：这条判据原来是"调用数 == 2"，**已经过时**。
//
//   🔴 实测（`grep captureCapsuleBeforeCompact lib/*.js`）：真调用是 **4 处**，
//      来源标签分别是 `official` / `auto:delta` / `auto:midturn` / 另一条。
//      原断言写"应为 2" —— 它是 D45 那个年代的数（当时只有两条压缩路径）。
//      后来 D244/D252/D257 加了回合内压缩，路径变多了，**而这条判据没跟着走**。
//   ★ 注意它坏得多隐蔽：断言的是"**等于** 2"，而实际是 4 ⇒ 它一直在报红。
//     一条长期报红的守卫与没有守卫等价（人会开始忽略它）。
//
//   ★ 修法不是把 2 改成 4 —— 那样下次再加一条压缩路径，**又是同样的过时**。
//     ⇒ 改成**按来源逐一验**：现有每个来源标签都必须在场。
//     ★ 这比"数个数"强在：它问的是"**哪几条路**有原件"，而不是"一共有几处"。
//       少数一处（某条路径漏抓）会直接点名少的是哪一条。
const REQUIRED_SOURCES = ["official", "auto:delta", "auto:midturn"];
/**
 * 取 `captureCapsuleBeforeCompact(` 那次调用的**实参文本**（括号配平到匹配的 `)`）。
 *
 * ★ 为什么不能用 `[^)]*`：`official` 那次写的是
 *   `captureCapsuleBeforeCompact(state, sidStart, inspect(rootStart), capsule, "official")`
 *   —— 参数里**含一对括号** ⇒ `[^)]*` 在 `inspect(rootStart)` 的 `)` 处就停，
 *   永远看不到后面的 `"official"` ⇒ 判据报"缺 official"，而它明明在。
 *   ★ 这是 L29 那一类（匹配面写窄了 ⇒ 坏写法天生不可见 / 好写法被误判）。
 */
function callArgsOf(srcText, fnName, tag) {
  const sig = `${fnName}(`;
  let from = 0;
  for (;;) {
    const i = srcText.indexOf(sig, from);
    if (i === -1) return undefined;
    from = i + sig.length;
    // 括号配平
    let depth = 1;
    let j = from;
    for (; j < srcText.length && depth > 0; j += 1) {
      const ch = srcText[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
    }
    const args = srcText.slice(from, j - 1);
    if (new RegExp(`"${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(args)) return args;
  }
}
const missingSources = REQUIRED_SOURCES.filter((tag) => callArgsOf(src, "captureCapsuleBeforeCompact", tag) === undefined);
need(
  `★ 每条压缩路径都走它（来源标签逐个验：${REQUIRED_SOURCES.join(" / ")}）` +
    (missingSources.length === 0 ? "" : ` · **缺 ${missingSources.join(", ")}**`),
  missingSources.length === 0,
  "少一条 ⇒ 那条路径压完仍然没有原件"
);

// ④ 胶囊目录名是常量，且在「去哪重读」里被指出来
need("有 `CAPSULE_DIR_NAME` 常量", /const CAPSULE_DIR_NAME = /.test(src));
need("★★ 胶囊目录被写进「去哪重读」（可回溯的前提是知道去哪找）", /历次逐字胶囊/.test(src));

// ⑤ 回执里说得出路径（自动那条 + 命令那条）
need("★ 自动压缩的注入里报出落盘路径（`r.capsuleRel`）", /r\.capsuleRel/.test(src));
need("★ 命令回执里报出落盘路径", /胶囊已\*\*存盘\*\*/.test(src));
need("★ 没存时要如实说（不假装成功）", /胶囊\*\*没存盘\*\*/.test(src));

console.log(
  fail === 0
    ? "\n探针通过：胶囊有落盘通道，且「没启用日志就不写」的承诺仍在"
    : `\n失败 ${fail} 项：胶囊落盘通道被破坏了`
);
process.exit(fail === 0 ? 0 : 1);
