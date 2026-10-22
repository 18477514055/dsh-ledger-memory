#!/usr/bin/env node
/**
 * ★★★★★ 探针：**扩展记忆的注入**（D299 · 任务书 §6.6）。
 *
 * 任务书原话：用户保存扩展后，模型**至少应该知道**
 * 「当前项目存在一个名为 X 的扩展记忆，适合保存 Y，采用 Z 规则，可按需读取和写入」。
 *
 * 并且三条硬边界：
 *   · 「不因为扩展数量增多就无条件注入全部扩展全文」
 *   · 「是否注入只影响上下文提供方式，不影响数据是否保存」
 *   · 「不影响第二代压缩和缓存优化」「保留原有活跃台账注入逻辑」
 *
 * 五组：
 *   ① 没有扩展 ⇒ 注入里**一个字都不该多**（不许凭空多出一节）
 *   ② 有一个扩展 ⇒ 名称/用途/模式/读法**都在**
 *   ③ **不开注入** ⇒ 有名单但**没有内容**；**开注入** ⇒ 才有内容且有上限
 *   ④ 七个扩展 ⇒ **总量有界**（不能线性爆炸）
 *   ⑤ 台账注入**照旧**（扩展不许把台账挤掉）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
let pass = 0;
let fail = 0;
const ok = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
};

const P8 = await import(pathToFileURL(path.join(ROOT, "lib", "part8.js")).href);
const P3 = await import(pathToFileURL(path.join(ROOT, "lib", "part3.js")).href);
const { inspect } = await import(pathToFileURL(path.join(ROOT, "lib", "part2.js")).href);

function makeProject(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `d299i-${tag}-`));
  const memDir = "proj-ledger-memory";
  const mem = path.join(root, memDir);
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(mem, "_a"), { recursive: true });
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 核心台账\n\n这是台账正文，必须一直在注入里。\n", "utf8");
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify(
      {
        version: 1,
        active: "LEDGER.md",
        archiveDir: "_a",
        decisionsDir: "decisions",
        maxActiveLines: 300,
        revision: 0,
        memoryRoot: memDir,
      },
      null,
      2,
    ),
    "utf8",
  );
  return root;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ① 没有扩展 ⇒ 注入里不该多出扩展那一节 ===\n");
{
  const root = makeProject("none");
  const info = inspect(root);
  const block = P8.renderExtensionInjection(info, root, {});
  ok("①a 没有扩展时渲染结果为空字符串", block === "", JSON.stringify(block));
  const full = P3.renderInjection(info, undefined, undefined, undefined, {});
  ok("①b 整体注入里**没有**「自定义扩展记忆」标题", !full.includes("自定义扩展记忆"), full.slice(-400));
  ok("①c 但台账正文照旧在", full.includes("这是台账正文"));
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ② 有扩展 ⇒ 名称/用途/模式/读法都在 ===\n");
{
  const root = makeProject("one");
  const info = inspect(root);
  P8.createExtension(info, root, {
    name: "Boss机制记录",
    description: "记录 Boss 的攻击阶段与验收状态",
    mode: "decisions",
    inject: false,
  });
  const block = P8.renderExtensionInjection(info, root, {});
  ok("②a 有「自定义扩展记忆」标题", block.includes("自定义扩展记忆"));
  ok("②b 有**名称**", block.includes("Boss机制记录"));
  ok("②c 有**用途说明**", block.includes("记录 Boss 的攻击阶段与验收状态"));
  ok("②d 有**模式标签**（决策型）", block.includes("决策型"));
  ok("②e 有**读法**（怎么按需读）", block.includes("ledger_extension") && block.includes("read"));
  ok("②f 有**写法**", block.includes("write"));
  ok("②g ★ 明确说它**不是核心记忆的替代品**", block.includes("不是") && block.includes("核心"));
  ok("②h ★ 未开注入 ⇒ 明确说明「不会自动塞进上下文」", block.includes("不会自动塞进上下文"), block);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ③ 注入开关：只影响提供方式，不影响保存 ===\n");
{
  const root = makeProject("inject");
  const info = inspect(root);
  const SECRET = "内容标记ZZZ";

  const r1 = P8.createExtension(info, root, { name: "不注入的", description: "这份的说明里**没有**那个内容标记", mode: "plain", inject: false });
  P8.writeExtension(info, root, r1.created.id, { content: `${SECRET}-不该出现\n` });

  const r2 = P8.createExtension(info, root, { name: "要注入的", description: "这份的说明里也没有那个标记", mode: "plain", inject: true });
  P8.writeExtension(info, root, r2.created.id, { content: `${SECRET}-应当出现\n` });

  const block = P8.renderExtensionInjection(info, root, { maxChars: 600 });
  // ★★★ 判据必须只盯**内容标记**，不能盯"说明"。
  //   第一版我把 `-不该出现` 当标记，而它在**说明**里也出现过 ⇒ 假红。
  //   ★ 纪律 2 的同型：**判据的输入必须是"被测的那一部分"** —— 这里被测的是"内容有没有被注入"，
  //     不是"说明里有没有这几个字"。说明本来就该出现。
  ok("③a ★ 未开注入的那份**内容**没有出现在注入里", !block.includes(`${SECRET}-不该出现`), block);
  ok("③b ★ 开了注入的那份内容**出现了**", block.includes(`${SECRET}-应当出现`), block);
  ok("③c 但两份的**名字都在**（关注入 ≠ 模型不知道有它）", block.includes("不注入的") && block.includes("要注入的"));

  // ★ 关键：关注入的那份，数据还在磁盘上（只影响提供方式）
  const rd = P8.readExtension(info, root, r1.created.id, {});
  ok("③d ★★ 关注入的那份**数据仍然完好**（只是不推给模型）", rd.ok === true && rd.text.includes("不该出现"));

  // ③e 内容上限：写很长的内容，注入里必须被截断
  const r3 = P8.createExtension(info, root, { name: "超长的", description: "测试上限", mode: "plain", inject: true });
  P8.writeExtension(info, root, r3.created.id, { content: `${"啊".repeat(3000)}\n` });
  const block2 = P8.renderExtensionInjection(info, root, { maxChars: 600 });
  ok("③e ★★ 超长内容**被截断**（有「已截断」标记）", block2.includes("已截断"), block2.slice(0, 200));
  ok("③f 且注入总长**没有**跟着内容线性膨胀", block2.length < 6000, `${block2.length} 字符`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ④ 七个扩展 ⇒ 总量有界（不线性爆炸）===\n");
{
  const root = makeProject("many");
  const info = inspect(root);
  for (const mode of P8.EXT_MODE_KEYS) {
    const r = P8.createExtension(info, root, {
      name: `扩展-${mode}`,
      description: `${mode} 模式：${"说明".repeat(20)}`,
      mode,
      inject: false,
    });
    if (r.ok) P8.writeExtension(info, root, r.created.id, mode === "decisions" || mode === "goals" || mode === "lessons" ? { key: "D1", content: "x".repeat(500) } : { content: "y".repeat(500), append: mode === "journal" });
  }
  const block = P8.renderExtensionInjection(info, root, { maxChars: 200 });
  ok("④a 七个都在名单里", P8.EXT_MODE_KEYS.every((m) => block.includes(`扩展-${m}`)));
  // ★ 七个扩展、每个写 500 字符，但都没开注入 ⇒ 注入总量必须远小于 7*500
  ok("④b ★★ 注入总量**远小于**内容总量（没把全文塞进来）", block.length < 7 * 500, `${block.length} 字符`);
  ok("④c 有明确的一行概括「不是替代品」", block.includes("不是") && block.includes("核心记忆"));
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ⑤ 扩展不许把台账挤掉（保留原有注入逻辑）===\n");
{
  const root = makeProject("keep");
  const info = inspect(root);
  const before = P3.renderInjection(info, undefined, undefined, undefined, {});
  ok("⑤a 基线注入里有台账正文", before.includes("这是台账正文"));
  ok("⑤b 基线里没有扩展节", !before.includes("自定义扩展记忆"));

  for (const mode of P8.EXT_MODE_KEYS) {
    P8.createExtension(info, root, { name: `塞-${mode}`, description: "占位", mode, inject: true });
  }
  const after = P3.renderInjection(info, undefined, undefined, undefined, {});
  ok("⑤c ★★★ 加满扩展之后**台账正文仍然在**", after.includes("这是台账正文"));
  ok("⑤d 扩展节也在", after.includes("自定义扩展记忆"));
  ok("⑤e 注入长度增长**有界**（不是 7 份全文）", after.length - before.length < 8000, `增长 ${after.length - before.length} 字符`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`d299-extension-inject 探针：${pass} PASS / ${fail} FAIL`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
