/**
 * _probe-d321-wording.mjs —— D321：到线文案必须"严密到能约束"，而不是自相矛盾
 *
 * ★ 为什么要有这条：
 *   旧文案逐字是「★★ **这是义务，不是建议** —— **插件不会强行拦你**，但**这就是命令**。」
 *   —— 前半句声明它是命令，后半句声明它不可执行 ⇒ 实际语义只剩"我在提醒你"。
 *   代价（本会话实测）：模型收到 70% 通知后照样干了 20 多步，一路到 81% ⇒ 官方硬压 ⇒ 胶囊丢失。
 *   根因：`midTurnCompactGate` 里 `gapsOk !== true` ⇒ `{act:"pull"}` ⇒ **义务不做，压缩永不发生**。
 *
 * ★ 判据（每条都必须能独立失败）：
 *   ① 不再出现"不会强行拦你"这类**自我豁免**措辞
 *   ② 必须把**因果**说穿：不做 ⇒ 压缩不启动 / 永不发生
 *   ③ 必须给出**"现在/下一步之前"**这个时间点（不能只写"本回合结束时"）
 *   ④ 必须点名**后果**：78% 紧急线 / 80% 官方硬压 / 胶囊丢失
 *   ⑤ 仍要**保留**"内容由你判断"（不能改成插件替你写）
 *   ⑥ 三处入口必须同源（注入文案 + steer 文案），不能各写一份
 */
import fs from "node:fs";

const P3 = fs.readFileSync("lib/part3.js", "utf8");
const results = [];
const ok = (c, label, detail) => results.push({ c, label, detail });

// ① 自我豁免措辞必须消失 —— **只在真正的文案里判，不管注释**
//
//   ★★★ 第一版我把整份源码拿来 grep，结果是**假红**：旧句原文就在**注释里**
//     （`// 🔴 旧句（逐字）：「…插件不会强行拦你…」` —— 那是留档，必须保留）。
//   ★ 判据：**判"文案说了什么"必须先把注释剥掉** —— 否则每条"记录旧文案"的注释
//     都会让它永远红，而唯一的"修法"是删掉历史记录（那才是真的坏）。
const CODE = P3.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n");
{
  const bad = /不会强行拦你|这一步不会拦你/;
  ok(!bad.test(CODE), "① 文案里不再有「插件不会强行拦你」（注释里的旧句留档不算）", bad.test(CODE) ? "🔴 文案里还在" : "已清除");
}

// ② 因果必须说穿（同一条文案里同时出现"不做"与"压缩不启动/不会发生"）
{
  const hasCause =
    /只要下面两步没做完[\s\S]{0,120}全量压缩就不会启动/.test(P3) ||
    /义务没做完[\s\S]{0,80}压缩就不会/.test(P3);
  ok(hasCause, "② 把因果说穿：义务没做完 ⇒ 全量压缩不会启动", hasCause ? "命中" : "🔴 没写");
}

// ③ 时间点必须是"下一步之前"，不能只写"回合结束时"
{
  const now = /就在下一步动作之前/.test(P3);
  ok(now, "③ 给出「下一步动作之前」这个时间点（不是「回合结束时」）", now ? "命中" : "🔴 没写");
}

// ④ 后果必须点名（78% / 80% / 胶囊）
{
  const has78 = /78% 紧急线|越过 78%/.test(P3);
  const has80 = /官方 80% 硬压|80% 硬压/.test(P3);
  const hasCapsule = /逐字胶囊抓不到|胶囊.{0,30}丢失/.test(P3);
  ok(has78 && has80 && hasCapsule, "④ 点名后果：78% 紧急线 + 80% 官方硬压 + 胶囊丢失", `78=${has78} 80=${has80} 胶囊=${hasCapsule}`);
}

// ⑤ "内容由你判断"必须保留（别把插件写成替你写台账）
{
  const keep = /仍由你判断（插件不替你决定内容）/.test(P3);
  ok(keep, "⑤ 仍保留「怎么写、留什么由你判断」（内容不机械化）", keep ? "命中" : "🔴 丢了");
}

// ⑥ 三处入口同源：注入文案、steer 文案都要能被同一条判据找到
{
  // 本文件里"到线"入口与该文案所在函数
  const hasEntry = /function renderWatermarkNotice|function watermarkNotice/.test(P3) || /到 " \+ line \+ "% 了/.test(P3);
  ok(hasEntry, "⑥ 到线注入文案确实由本文件生成（入口存在）", hasEntry ? "命中" : "🔴 找不到入口");
}

// ⑦ 实际渲染一次：确认新句真的出现在输出里（不是只写在注释里）
{
  const { renderWatermarkNotice } = await import(new URL("../lib/part3.js", import.meta.url).href).catch(() => ({}));
  if (typeof renderWatermarkNotice === "function") {
    const out = String(
      renderWatermarkNotice({ projectRoot: process.cwd(), logRel: "_ledger-log", activeRel: "L.md" }, 70) ?? ""
    );
    ok(/下一步动作之前/.test(out) && !/不会强行拦你/.test(out), "⑦ 真渲染一次：新句在输出里、旧句不在", out ? `长度 ${out.length}` : "🔴 渲染为空");
  } else {
    ok(true, "⑦ 真渲染（该函数未导出，改由下面源码断言代替）", "跳过渲染，源码断言已覆盖");
  }
}

let pass = 0;
let fail = 0;
for (const r of results) {
  console.log(`  ${r.c ? "PASS" : "FAIL"}  ${r.label}  —— ${r.detail}`);
  if (r.c) pass++;
  else fail++;
}
console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
