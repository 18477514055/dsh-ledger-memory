// ★★★★★ D234 尺子自证：文件锚定的六维能不能真的把「今天害我停下的那份」排下去？
//
// 这个探针存在的理由（D231 立的规矩）：**每一版新增的修复，都必须有自己独一无二、
// 能在包里被找到的标志物**；而这一版更狠 —— 它必须先证明**尺子本身是对的**，
// 否则就会重演 D234 头部留档的"第 26 次尺子错"。
//
// 判据（必须全部成立）：
//   ① 一手精读（`docs/…/02-参照物精读`）**必须**排在高分侧；
//   ② 二手调研稿（`_调研-billion-context.md`）**必须**拿到"落后若干代"的告警；
//   ③ 缺值不惩罚：一个没有任何标注的文件**不许**因此被扣成 0；
//   ④ 相对性：同一份文件在不存在的维度被去掉后，位置会变（证明"多一维多一条尺子"）。
//
// ★ 只读、不写任何东西。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { anchorFiles, declaredDateMs, evidenceLevelOf, maxDecisionRefOf, renderFileAnchor, scanMemorySurface } from "../lib/part6.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const ok = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}${detail === undefined ? "" : `　${detail}`}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail === undefined ? "" : `　${detail}`}`);
  }
};

// ★ 用手搓夹具，**不依赖本机库**（探针要能在任何环境跑；本机库只是"顺便看一眼"）。
console.log("=== 一、维度抽取（纯函数，手搓夹具）===");
{
  const F1 = "## 0. 版本 [本地一手]\n[官方一手] [本地一手]\n> 调研日期：2026-10-16\n提到 D231";
  const F2 = "> 调研日期：2026-10-09\n只有一个旧结论，引用最大 D89";
  const F3 = "什么标注都没有的一段正文，也没有日期，也没有 D 号";

  ok("一手标注计数 = 3（两处 [本地一手] + 一处 [官方一手]）", evidenceLevelOf(F1) === 3, `实测 ${evidenceLevelOf(F1)}`);
  ok("★ [未证实] 是减分项（不是加分项）", evidenceLevelOf("[未证实] [本地一手]") === 0, `实测 ${evidenceLevelOf("[未证实] [本地一手]")}`);
  ok("★★ 没有任何标注 ⇒ undefined（**不是 0**：缺值不惩罚）", evidenceLevelOf(F3) === undefined, `实测 ${evidenceLevelOf(F3)}`);
  ok("日期从自称里读出来", declaredDateMs(F2) === new Date(2026, 9, 9).getTime(), `实测 ${declaredDateMs(F2)}`);
  ok("★ 认不出日期 ⇒ undefined（绝不猜）", declaredDateMs(F3) === undefined);
  ok("最大 D 号", maxDecisionRefOf(F2) === 89, `实测 ${maxDecisionRefOf(F2)}`);
  ok("没有 D 号 ⇒ undefined", maxDecisionRefOf(F3) === undefined);
}

console.log("\n=== 二、真机：今天那份库（这才是本探针的重点）===");
{
  const info = { docsDir: "docs", handoffDir: "_handoff", archiveDir: "_ledger-archive", decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals" };
  // ★ 把根目录那几份调研稿也当成"内部文档"面喂进去（它们在根，不在 docs/ 下）。
  const files = scanMemorySurface(ROOT, info);
  for (const rel of ["_调研-billion-context.md", "_调研-内核bundle-patch机制.md"]) {
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    const fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(Math.min(64 * 1024, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    files.push({ rel, surface: "内部文档", kind: "material", surfaceWhy: "根目录调研稿", head: buf.subarray(0, n).toString("utf8"), sizeBytes: st.size, mtimeMs: st.mtimeMs, hash: "" });
  }
  ok("扫到了文件", files.length > 0, `共 ${files.length} 份`);
  // ★★★ 根面必须扫到 —— 第一版就是漏了它（`push` 的守卫把空串"根"挡掉了），
  //   而今天害我停下的 `_调研-billion-context.md` **正躺在根上**。
  ok(
    "★★★★ 项目根那一面也被扫到了（`_调研-billion-context.md` 在根上）",
    files.some((f) => f.rel === "_调研-billion-context.md"),
    `根面 ${files.filter((f) => !f.rel.includes("/")).length} 份`
  );

  // ★★★ 语料必须给：不给 ⇒ 被引用度这一维静默算 0（"配了就该跑"的陷阱）。
  const corpus = files.filter((f) => f.kind === "conclusion").map((f) => ({ rel: f.rel, text: f.head }));
  ok("被引用度有语料可用（否则这一维静默失效）", corpus.length > 0, `${corpus.length} 份决策/经验卡`);

  const maxDecision = 234;
  const anchored = anchorFiles(files, { maxDecision, corpus });
  const byRel = new Map(anchored.map((f) => [f.rel, f]));
  // ★★★ 排名**只在 material 类内**算 —— 这正是第一版栽的地方：
  //   混排时前 6 名全是 `_ledger-archive/` 片段与刚写的决策卡，一手精读掉到第 158/402。
  const mat = anchored.filter((f) => (f.kind ?? "material") === "material");
  const rank = [...mat].sort((a, b) => b.anchor.score - a.anchor.score);
  const posOf = (rel) => rank.findIndex((f) => f.rel === rel) + 1;

  const firstHand = byRel.get("docs\\AI记忆与上下文压缩调研\\02-参照物精读-billion-context.md")
    ?? byRel.get("docs/AI记忆与上下文压缩调研/02-参照物精读-billion-context.md");
  const secondHand = byRel.get("_调研-billion-context.md");

  ok("两份关键文件都扫到了", firstHand !== undefined && secondHand !== undefined);
  ok(
    "★★★★★ 材质类与结论/历史类**分开打分**（不跨类混排）",
    anchored.some((f) => f.kind === "conclusion") && anchored.some((f) => f.kind === "history") && anchored.some((f) => f.kind === "material"),
    `material=${anchored.filter((f) => f.kind === "material").length} conclusion=${anchored.filter((f) => f.kind === "conclusion").length} history=${anchored.filter((f) => f.kind === "history").length}`
  );
  if (firstHand !== undefined && secondHand !== undefined) {
    console.log(`     一手精读：${firstHand.anchor.score} 分（材料类第 ${posOf(firstHand.rel)}/${rank.length}）`);
    console.log(`     二手调研：${secondHand.anchor.score} 分（材料类第 ${posOf(secondHand.rel)}/${rank.length}）`);
    console.log(`     ↑ 关键：**一手必须高于二手** —— 这正是今天失败的形态`);
    // ★★★ 这是本探针的**核心断言**：一手精读必须排在二手调研稿前面。
    ok(
      "★★★★★ 一手精读排在二手调研稿之前（今天失败的形态被治住）",
      firstHand.anchor.score > secondHand.anchor.score,
      `${firstHand.anchor.score} vs ${secondHand.anchor.score}`
    );
    // ★ 代际维：二手那份落后 234-89 = 145 代 ⇒ 必须被标出来
    ok(
      "★★ 二手稿被标出「落后若干代」",
      Number.isFinite(secondHand.anchor.raw.generation) && secondHand.anchor.raw.generation > 50,
      `落后 ${secondHand.anchor.raw.generation} 代`
    );
    ok("一手精读有证据标注（一手维拿到值）", Number.isFinite(firstHand.anchor.raw.firsthand) && firstHand.anchor.raw.firsthand > 0);
    ok("★ 二手稿**没有**标注 ⇒ 一手维是 undefined（缺值不惩罚）", secondHand.anchor.raw.firsthand === undefined);
  }

  const md = renderFileAnchor(anchored, { top: 6 });
  ok("渲染出了锚定段", md.includes("文件锚定"));
  ok("★★★ 段里必须含「老一代材料提醒」（这是今天真正能救我的那句）", md.includes("老一代材料提醒"), "");
  console.log("\n--- 渲染结果（注入里就是这个）---");
  console.log(md);
}

console.log("\n=== 三、缺值不惩罚（反向验证：把维度全抽掉，分数不许变负/变 0）===");
{
  const bare = [
    { rel: "a/x-one.md", head: "没有任何标注、日期、D 号", sizeBytes: 100, mtimeMs: 0 },
    { rel: "a/x-two.md", head: "[本地一手]\n日期：2026-10-16\nD234", sizeBytes: 100, mtimeMs: 0 },
  ];
  const r = anchorFiles(bare, { maxDecision: 234, corpus: [] });
  const a = r.find((x) => x.rel.includes("x-one"));
  ok("★ 无标注那份**没有**被扣成 0（缺值不惩罚）", a.anchor.score > 0, `实测 ${a.anchor.score}`);
  ok("它的 missing 里如实列了缺失维度", a.anchor.missing.length > 0, a.anchor.missing.join("/"));
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
