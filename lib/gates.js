/**
 * ★★★★★ 2026-10-25（D319）：**从 `part3.js` 拆出的纯判据/纯文案族**（零外部依赖）。
 *
 * ── 为什么拆（承接 D318 的同一件事）────────────────────────────────
 * `part3.js` 已用到 **99.56%**（余 1,144 B），是当前最紧的一个。
 * 而 **F-03 / F-05 两条 P2 修复还没修**，且将来任何一处改动都随时会顶爆它。
 * 用户原话（逐字）：*"可以考虑进行拆分，但是要小心一点。"*
 *
 * ── 为什么是这三个（判据同 D318：**不看体积，看依赖**）────────────
 * `lib/` 的 import 图高度成环（`manifest-mirror.js:24-25` 自述：新模块若 import 任何 partN，
 * 就有把求值顺序改坏的风险，本项目栽过）。
 * 逐个统计 part3 的 88 个顶层块后，这三个是 **内部依赖 0 / 跨 part 引用 0**：
 *   · `obligationGaps`     纯算术（比三个 seq 的先后）—— 注释里的大写词是决策编号，不是常量
 *   · `midTurnCompactGate` 纯判据（比 ratio 与 line）—— 同上
 *   · `conformNext`        纯文案拼装（只依参数）
 * 合计 **9,895 B**。
 *
 * ── 为什么"搬实现 + 保 re-export"（D307/D318 同一先例）────────────
 * `part3` 里留 `import` + `export ... from` ⇒ 调用方（index.js / part4 / 探针）**一个都不用改**。
 * ★ 判据：**搬实现可以，改调用面不行** —— 后者会把"体积问题"变成"全库回归问题"。
 *
 * ★★★★ **D318 的教训必须带过来**：搬家**逐字复制，不能重写**。
 *   那一轮我把 `mergeGitignore` / `stageOutcomeOf` 两个返回形状"凭理解"重写了一遍，
 *   两次都错（数组写成数字、字段整个漏掉），而且**调用方读 undefined 不报错**。
 *   ⇒ 本文件里每个函数体都是**原样粘贴**，连注释都保留（注释也是行为说明的一部分）。
 */

/** 回合收尾义务的两条缺口 + "过期"判定（纯算术）。 */
export function obligationGaps(rec) {
  const wrote = rec?.wrote === true;
  const triaged = rec?.triaged === true;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const last = num(rec?.lastNonLedgerSeq);
  const wSeq = num(rec?.writeSeq);
  const tSeq = num(rec?.triageSeq);
  // ★ 取不到序号 ⇒ **不判过期**（宁可漏抽，不可误抽 —— 与 recordOwed 同一条口径）。
  const wroteStale = wrote && last !== undefined && wSeq !== undefined && last > wSeq;
  const triagedStale = triaged && last !== undefined && tSeq !== undefined && last > tSeq;
  return {
    missingWrite: !wrote,
    missingTriage: !triaged,
    wroteStale,
    triagedStale,
    ok: wrote && triaged && !wroteStale && !triagedStale,
    lastNonLedgerSeq: last,
  };
}

/**
 * 回合内压缩的**纯判据**（不做任何 IO —— 便于穷举测试）。
 *
 * ★ 为什么拆成"判据"与"执行"两半：判据可以穷举（off / unmeasurable / no-line / below-line /
 *   pressing / done / failed / urgent 旁路 / owed / ready），而执行那半要碰 ctx、磁盘、压缩服务。
 *   混在一起就只能靠实跑，分支覆盖不住。
 *
 * ★★★★ **D318 的教训（本轮第二次差点重犯）**：我第一版凭"这段逻辑我懂"写了
 *   `if (ratio < line) return {act:"none", why:"below"}` —— **而原文是 `"below-line"`，
 *   而且后面还有整个 `phase` 状态机**（pressing / done / failed / owed）与 `urgent` 紧急旁路。
 *   ⇒ 如果那样搬走，四个 why 值全变、状态机整个消失，调用方按 `why` 分支的逻辑全部静默失效。
 *   ★ 判据：**"我看懂了这段逻辑"不等于"我可以重写它"** —— 搬家只许逐字复制。
 */
export function midTurnCompactGate(x) {
  if (x?.enabled !== true) return { act: "none", why: "off" };
  const ratio = x.ratio;
  const line = x.line;
  // 量不到水位 / 线没配 ⇒ 不猜（宁可晚一次）
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return { act: "none", why: "unmeasurable" };
  if (typeof line !== "number" || !Number.isFinite(line)) return { act: "none", why: "no-line" };
  // 水位没到线 ⇒ 什么都不做（长回合的大部分时间都走这一支）
  if (ratio < line) {
    // ★ 掉回线下 ⇒ 本回合的"已压过"标记可以清了（下一轮涨上来还能再压）。
    return { act: "none", why: "below-line" };
  }
  // 正在压（防重入）⇒ 等
  if (x.phase === "pressing") return { act: "wait", why: "pressing" };
  // 本回合已经压过、而且水位还没掉回线下 ⇒ 等（防连环重压）
  if (x.phase === "done") return { act: "wait", why: "already-done" };
  // ★★★★★ 2026-10-18（D265）：**本回合已经失败过 ⇒ 这一回合不再试**。
  //
  //   🔴 病（故障报告 007 §8.1）：原来失败就把相位删掉（"让下一次还能试"）——
  //     而 `pre-step` **每个 step 都跑** ⇒ "下一次"= 几秒到几十秒后。
  //     真机实测连试 4 次（间隔 21s / 21s / 27s），而每次失败收尾都在 `turn/end`
  //     之后落盘 ⇒ **每多试一次，就多写出一条可能的坏档**。失败本身是允许的，
  //     **几秒后重试的那个放大器才是病**。
  //
  //   ★ 为什么"不删相位"就等于"隔一个回合"：`turn/end` 那条路本来就会
  //     `state.turnCompact.delete(key)`（D246 的修复）⇒ 下一回合开始时相位是干净的。
  //     用**已有的生命周期**做节流，不引入计时器（计时器会带上时钟漂移这类新失败面）。
  //
  //   ★★ 必须配例外：水位到 `urgent`（78%）就**不再等** —— 否则等于把机会让给
  //     内核 80% 那次抓不到逐字胶囊的硬压（用户最在意的正是"逐字可回读"）。
  //     ★ 但紧急旁路**不豁免「先落盘」**：下面 `gapsOk` 那条仍然在前面拦。
  if (x.phase === "failed") {
    const urgent = typeof x.urgent === "number" && Number.isFinite(x.urgent);
    const over = urgent && typeof ratio === "number" && ratio >= x.urgent;
    if (!over) return { act: "wait", why: "failed-this-turn" };
  }
  // 已抽起等义务 ⇒ 等模型那一步做完（它做完会再回到这里）
  //
  // ★ 2026-10-24（M2a/F1）：**`owed` 必须有出口**，否则义务做完也永远出不去。
  //   病：原来无条件 wait，而清相位只有"水位掉回线下"一条路（线上掉不回去）。
  //   实证：诊断日志 175 行里 `act=compact` 0 次、`awaiting-owed` 133 行。
  //   详见 decisions/D318.md。义务成了 ⇒ 前进到压；没成 ⇒ 继续等。
  if (x.phase === "owed") {
    if (x.gapsOk === true) return { act: "compact", why: "owed-done" };
    return { act: "wait", why: "awaiting-owed" };
  }
  // 到线了、义务还没做 ⇒ 先抽起做义务
  if (x.gapsOk !== true) return { act: "pull", why: "owed-first" };
  // 义务已做 + 到线 ⇒ 压
  return { act: "compact", why: "ready" };
}

/** 「合规修复」三选一之后的下一步指令（纯文案拼装）。 */
export function conformNext(choice, info, conf, received) {
  const fixList =
    conf.fixable.length > 0 ? conf.fixable.map((f) => `- ${f}`).join("\n") : "（没有可自动修的项）";
  const aiList = conf.needsAI.length > 0 ? conf.needsAI.map((f) => `- ${f}`).join("\n") : "（没有）";
  if (choice === "skip") {
    return "用户选了「不用改」。**不要再动这个项目的台账结构**，继续下一步工作。";
  }
  if (choice === "preview") {
    return (
      "用户选了「先给我看要改什么」。请调用 `ledger_conform`（**不要传 `apply`**，默认就是预览），" +
      "把它报出来的 `actions` / `skipped` 原样讲给用户听，并说明哪些**只能由你判断**：" +
      `\n${aiList}\n**先别改**，等用户确认后再传 \`apply: true\`。`
    );
  }
  if (choice === "repair") {
    return (
      "用户选了「修复台账（只补缺的）」。请：\n" +
      "1. 先调 `ledger_conform`（不传 `apply`）看一遍将要做什么；\n" +
      `2. 这些是**只做加法**的修复，可以直接执行 —— 传 \`apply: true\`：\n${fixList}\n` +
      "   （它只补清单字段、只建**空的**决策记录/归档目录，**绝不改写或删除任何已有内容**。）\n" +
      `3. 这些**要你来判断**，\`ledger_conform\` 不会替你动：\n${aiList}\n` +
      "   超阈值那种请用 `ledger_archive` 挑**最旧的已完成条目**移进归档（别删还有用的）；\n" +
      "4. 做完用一句话告诉用户改了什么、没改什么。"
    );
  }
  return (
    `用户的选择没有对上三个选项（收到：${received ?? ""}）。` +
    "请按最稳妥的方式继续：先跑 `ledger_conform` 预览给用户看，**不要**直接改。"
  );
}
