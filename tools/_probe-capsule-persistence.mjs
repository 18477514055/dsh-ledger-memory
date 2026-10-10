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
 * 用法：node tools/_probe-capsule-persistence.mjs
 */
import path from "node:path";
import fs from "node:fs";

const P = path.join(path.resolve(import.meta.dirname, ".."), "lib", "index.js");
const src = fs.readFileSync(P, "utf8");

let fail = 0;
const need = (label, cond, detail) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) {
    fail += 1;
    if (detail !== undefined) console.log(`      ${detail}`);
  }
};

console.log("═══ 胶囊落盘通道守卫（D45）═══\n");

// ① 存在落盘函数，且它真的写文件
need(
  "有 `persistCapsule` 函数",
  /function persistCapsule\(/.test(src),
  "没有落盘函数 ⇒ 胶囊又会退回「只在内存」"
);
const pIdx = src.indexOf("function persistCapsule(");
const pBody = pIdx === -1 ? "" : src.slice(pIdx, pIdx + 3000);
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
  /dir === undefined/.test(pBody) && /没启用活动日志/.test(pBody)
);

// ② 压缩前抓胶囊的**唯一入口**存在，且里面调了落盘
need("有 `captureCapsuleBeforeCompact`（四条压缩路径的统一入口）", /function captureCapsuleBeforeCompact\(/.test(src));
const cIdx = src.indexOf("function captureCapsuleBeforeCompact(");
const cBody = cIdx === -1 ? "" : src.slice(cIdx, cIdx + 1400);
need("★★ 它内部调了 `persistCapsule`（不只是存内存）", /persistCapsule\(/.test(cBody));
need("★ 且落盘失败**不挡压缩**（单独 try 包住）", /try \{[\s\S]{0,200}persistCapsule\(/.test(cBody));

// ③ 两条真压缩路径都走那个入口
const captureCalls = (src.match(/captureCapsuleBeforeCompact\(/g) ?? []).length - 1; // 减去函数定义那次
need(
  `★ 两条压缩路径都走它（实际 ${captureCalls} 处调用，应为 2）`,
  captureCalls === 2,
  "少一处 ⇒ 那条路径压完仍然没有原件"
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
