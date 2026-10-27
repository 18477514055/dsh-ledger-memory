/**
 * ★★★★★ 2026-10-23（D310，审计员010 第二份报告 F-07 实锤）：**V3 核心机制的合规体检**。
 *
 * 从 `part2.js` 的 `conformanceOf` 里**抽出来**（两个理由都成立）：
 *   ① `part2.js` 只剩 **3512 B** 余量（硬上限 262,144 B）—— 这段 4.5KB 塞不下；
 *   ② 更重要的是**语义**：这一整块回答的是「第 3 代的四项保障在不在」，
 *      与 `conformanceOf` 里那一大堆「V2 登记资产在不在」本来就不是一回事。
 *
 * 🔴 抽出来之前它压根不存在 —— 实测四条**全绿**：删掉 SECURITY.md / 清空 .gitignore /
 *   把镜像改 stale / 让清单路径越界，`verdict` 都还是 `ok`、`reasons` 都还是空。
 *   ⇒ 合规检查号称"体检医生"，可这四项正是**数据泄露风险**所在。
 *
 * ★ 它是**叶子模块**（只依赖 node 内建 + manifest-mirror）⇒ 不改 `lib/` 那张成环 import 图的求值顺序。
 * ★ 返回 `{reasons, fixable}`：调用方并进自己的数组。
 *   **故意不返回 `needsAI`** —— 这四项全都能机械修补（建文件 / 补一行 / 重写镜像 / 改键），
 *   按本项目纪律该进 `fixable`；进了 `needsAI` 就把「补个文件」报成「要 AI 决定」。
 */

import fs from "node:fs";
import path from "node:path";
// ★ 2026-10-25（D317 · Gemini 审查 004 F-04）：`isUnder` → `isUnderReal`。
//   词法比较认不出符号链接 ⇒ 合规门禁会给"逃逸链接"发合格证。
//   ★ 现在只有 `isUnderReal` 一个（见下方 F-04 那处）。
// ★ 2026-10-25（D317）：`isUnderReal` 也在这里 import —— `base.js` 是叶子模块，不成环。
//   ★ 为什么不用 deps 注入：6 个调用点（part2 / selftest / 3 个探针）**全都只传了 `memoryBaseOf`**，
//     走注入就得同时改 6 处；而 `isUnder` 本来就是直接 import 的 ⇒ 同族函数同一种取法。
//     ★ 判据：**同一个模块里，同一族工具函数不该一半 import 一半注入** —— 那样下次必然漏改一边。
//   ★★ 而且我**第一版就是忘了这一步**：只改用了 `isUnderReal` 却没 import，
//     静态看没问题、跑起来 `ReferenceError` —— 这正是 D307 记过的第三种复发形态。
import { isUnderReal, readTextSafe } from "./base.js";
import { verifyManifestMirror } from "./manifest-mirror.js";
// ★ 2026-10-25（D320 · F-05）：搬过来的 `readManifestDetailed` 需要清单文件名。
//   ★ 我第一版**在本文件里就地定义了一份** `const MANIFEST_REL`，理由是"defs.js import 了
//     整个 part 链，import 它会新开成环边"。
//   🔴 **自检当场报红**：「拆分后没有跨模块的重复顶层声明 —— 重复：MANIFEST_REL（defs.js / v3-conformance.js）」。
//   ★★ 那条断言是**对的**，而且它的来历很硬：`apply` 曾同时进 `index.js` 与 `part6.js`
//     ⇒ 陈旧副本满足静态断言 ⇒ 改了也不红 ⇒ **副本还进了 v1.2.0 的 npm 包**。
//   ★★★ 所以"避开成环"这个理由**不足以**让我复制一份常量 ——
//     **"一个事实只有一个出口"优先于"少一条 import"**。
//   ⇒ 正解：**不定义**，由调用方把文件名传进来（`readManifestDetailed(root, manifestRel)`）。
//     这样既不重复声明，也不新增任何 import 边。
// ★ 2026-10-23（D310）：`isUnder` **必须 import，不许本文件再写一份**。
//   🔴 我第一版就是在这里又实现了一遍 ⇒ 自检那条
//     「拆分后没有跨模块的重复顶层声明」**当场变红**，并指出
//     `isUnder（base.js / v3-conformance.js）`。
//   ★★ 那条判据的初衷（2026-10-15 真事）：`apply` 被同时写进 index.js 与 part6.js，
//     结果 **静态断言被那份陈旧副本满足 ⇒ 改了 index.js 却不红 = 假绿**。
//     同一个病在这里的形态是：两处 `isUnder` 判据一旦分叉，
//     "越界判定"就会在两个地方给出不同答案 —— 而那正是本项目最怕的那种分叉。
//   ⇒ **判据只能有一处定义**（base.js），这里 import 它。
//     ★ `base.js` 是叶子模块（只依赖 node 内建）⇒ 这条 import 不成环。

/**
 * @param {object} info `inspect()` 的结果
 * @param {{memoryBaseOf:(info:object, fallback:string)=>string}} deps 注入项（避免本模块 import partN）
 * @returns {{reasons:string[], fixable:string[]}}
 */

/**
 * ★★★★★ 2026-10-24（D317 · GPT 审查 002 的 F05）：**"记忆目录到底被忽略了吗" —— 唯一出口**。
 *
 * 🔴 病（真缺口，两侧判据分叉）：
 *   · **检测侧**（本文件原来那段内联逻辑）认 `*` 通配 ⇒ 通配反选能识别成"反选"；
 *   · **修复侧**（`part4.js` 的 `negatedLast()`）只比**字面目录名** ⇒ 认不出通配反选。
 *   ⇒ 于是出现最坏的一种组合：**检测说"可修"，执行却什么都不做**（回 `changed:false, actions:[]`），
 *     而用户照提示修了个寂寞 —— 与 D316「凡进 fixable 的必须有一条对应动作」正面冲突。
 *   ★ 而这里的风险是**真的**：`*` 后跟通配反选是常见套路（"忽略一切、但保留目录结构"），
 *     它会把 `/mem-memory/` 重新纳回 ⇒ **记忆目录变得可被 `git add`** ⇒ 一次手滑就是隐私泄露。
 *
 * ★ 修法：**把"最后一条命中规则说了算"收成这一个函数**，检测与修复**都调它**（一个事实一个出口）。
 *   ★ 为什么不按 GPT 的建议去调 `git check-ignore`：那是**真源**，但它要求 git 在场、
 *     要落一个临时文件、还要为"没有 git"设计降级路 —— 代价大于收益，而且**降级路本身就是新的分叉点**。
 *     这里改成一个**纯函数**：给定 (目录名, .gitignore 文本) 就算出结论，可单测、无副作用。
 *
 * ★★★ 本注释的写法有个坑，写下来免得后人重踩：**块注释里不许出现星号斜杠** ——
 *   我第一版在这里直接写那个两字符序列，**它把块注释提前闭合了**，后面几行注释被当成代码
 *   ⇒ `SyntaxError: Unexpected identifier`，而且**报错位置指向注释第 45 行**，看起来像"注释写错了内容"，
 *     实际是"注释**结构**被自己截断了"。
 *   ⇒ 判据：**引用"结束注释"这个标记本身时，必须转义/拆开写**（本书用反斜杠隔开）。
 *     这一类坑与 `_probe-unbound-after-split` 那次"剥注释器漏配"是**同一个病的两面**：
 *     一面是**写**注释时把结构写坏，一面是**读**注释时把结构读错。
 *
 * @param {string} memoryRoot 记忆目录名（相对项目根，如 `myproj-ledger-memory`）
 * @param {string} gitignoreText `.gitignore` 全文
 * @returns {{ignored:boolean|null, hits:Array<{line:string,negated:boolean,ignored:boolean}>, want:string,
 *            lastHit:object|undefined}}
 *   `ignored === true` 才算"真被忽略"；`null` = 没有任何规则命中；`false` = 最后一条是反选。
 */
export function ignoreStateOf(memoryRoot, gitignoreText) {
  const want = String(memoryRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

  /** 一条 gitignore 模式是否命中我们的目录（**不剥 `!`** —— 剥不剥由调用方决定）。 */
  const patternMatches = (rawPat) => {
    const pat = rawPat.replace(/^\//, "").replace(/\/+$/, "");
    if (pat === "") return false;
    if (pat === want) return true;
    // `*` 通配（如 `*-ledger-memory`、`*/` ⇒ 匹配任意单段目录名）
    if (pat.includes("*")) {
      const re = new RegExp(
        `^${pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`
      );
      return re.test(want);
    }
    // 目录名的前缀形式：`foo/bar` 只影响 foo/bar 之下，不影响 foo/barXXX
    return want.startsWith(`${pat}/`);
  };

  // ★ 按顺序模拟：最后一条**命中本目录**的规则说了算（`!` = 取消忽略）
  let ignored = null;
  const hits = [];
  for (const line of String(gitignoreText ?? "").split(/\r?\n/)) {
    const l = line.trim();
    if (l === "" || l.startsWith("#")) continue;
    const negated = l.startsWith("!");
    const body = negated ? l.slice(1) : l;
    if (!patternMatches(body)) continue;
    ignored = !negated;
    hits.push({ line: l, negated, ignored });
  }
  return { ignored, hits, want, lastHit: hits[hits.length - 1] };
}

export function v3ConformanceGaps(info, deps) {
  const reasons = [];
  const fixable = [];
  const projectRoot = info.projectRoot;
  const memoryRoot = info.memoryRoot;
  const manifest = info.manifest;
  const unsafePaths = info.unsafePaths;
  //
  //   🔴 病（实测四条**全绿**）：`conformanceOf` 上面那些判据问的都是
  //      「V2 那套登记过的资产在不在」，而**V3 新引入的四项保障一件都没查**：
  //       ① `SECURITY.md`（记忆目录里的安全原则）—— 删掉它，verdict 仍 `ok`
  //       ② `.gitignore` 是否真忽略记忆目录 —— 清空它，verdict 仍 `ok`
  //       ③ 清单镜像是否与权威一致 —— 把它改 stale，verdict 仍 `ok`
  //       ④ `inspect()` 已经算出的 `unsafePaths`（路径越界）—— **一个字都不提**，仍 `ok`
  //      ⇒ 合规检查是"体检医生"，可这四项正是**数据泄露风险**所在。
  //         出现风险的项目跑一体检，全部亮绿灯 ⇒ 失去自愈与预警能力。
  //
  //   ★★ 为什么这四条**必须进 `reasons`**（而不是像 V2 的可选项那样进 notes）：
  //     它们全都能**机械修补**（建文件 / 补忽略行 / 重写镜像 / 改清单键），
  //     而"能机械修"的东西按本项目纪律应进 `fixable` + `reasons`，
  //     不进 `needsAI`（那会让 verdict 变 `NONCONFORMING`，把"补个文件"报成"要 AI 决定"）。
  //   ★ 判据：**新一代引入的保障，必须与新代次同时进入体检** ——
  //     只有"代次数字变成了 3"而"3 的机制没被检查"，体检就还是一代的体检。
  //   ★★ 2026-10-23（D310 第二轮修正）：**`inspect()` 并不返回 `isV3`**。
  //     我第一版写 `if (info.isV3 === true)` ⇒ 条件恒假 ⇒ 四条断言全红（看着像"修了没用"）。
  //     `isV3` 是 `part3.js:3839` 在 `ledger_status` 里**临时算**的，`inspect()` 从不给它。
  //     ⇒ 判定必须自己从 `inspect()` **真的给了的字段**推：
  //       `memoryRoot` 有值 ⇒ 已声明第 3 代布局（这正是 `since:3` 那条要求键）。
  //   ★★ 判据（本项目第 10 次同型）：**用别人的字段前先确认它真的存在** ——
  //      否则 `if (undefined === true)` 静默跳过，而"没报错"会被读成"检查过了"。
  if (typeof memoryRoot === "string" && memoryRoot !== "") {
    const mBaseV3 = deps.memoryBaseOf(info, projectRoot);

    // ① SECURITY.md —— 记忆目录里的安全原则（任务书 §3.6）
    {
      const secAbs = path.resolve(mBaseV3, "SECURITY.md");
      // ★★★★★ 2026-10-25（D317 · Gemini 审查 004 F-04）：**词法 `isUnder` → 真实路径 `isUnderReal`**。
      //   🔴 病：`SECURITY.md` 若是指向项目外部的**符号链接**，词法比较照样返回 true，
      //     `fs.existsSync` 也 true ⇒ **合规检查被判通过**，而实际那是个逃逸链接。
      //   ★ 为什么必须改：本文件是**合规门禁**。门禁自己看走眼，等于给"迁出去"发合格证。
      //     而修复侧 `repairConformance`（`part4.js:228`）**早就在用 `isUnderReal`** ⇒
      //     两处判据分叉：一个说合格、一个说不合格。★ 同一条事实只能有一把尺子。
      const secOk = isUnderReal(mBaseV3, secAbs).ok === true && fs.existsSync(secAbs);
      if (!secOk) {
        reasons.push(
          `记忆目录 \`${memoryRoot}\` 里**没有安全原则文件 \`SECURITY.md\`**（第 3 代要求之一）`
        );
        // ★ 机械可修：正文有唯一出处（`SECURITY_MD_TEXT`），不需要 AI 现编
        fixable.push("写入 `SECURITY.md`（正文由插件内置模板生成，不需要你提供内容）");
      }
    }

    // ② .gitignore 是否真忽略记忆目录（任务书 §3.2 —— 防误提交）
    //   ★ 判据：**看"这个目录有没有被忽略规则覆盖"，不是"文件里有没有那一行"** ——
    //     用户完全可能写 `*-ledger-memory/` 或 `/10.*-memory/` 这类等价写法。
    //
    // ═══════════════════════════════════════════════════════════════════════════
    // 🔴🔴 2026-10-23（D313，GPT 静态审查 001 的 F03）**真缺陷修复**：
    //
    //   病：原来写 `const pat = l.replace(/^!/, "")...` —— **把 `!` 剥掉再当忽略**。
    //     而 Git 里 `!` 的意思是**取消忽略**（negation）。⇒ `!mem/` 被当成"有效保护"，
    //     **合规检查报 ok，而 git check-ignore 说那些文件根本没被忽略**。
    //   ★ 实测复现（`tools/_probe-gpt001-findings.mjs` F03-②）：
    //     写 `!mem-memory/` ⇒ 本函数 reasons=[]（假绿）；真 git 说"不被忽略"。
    //     写 `mem-memory/` 再写 `!mem-memory/` ⇒ 净效果是不忽略，本函数仍报 ok（F03-③ 也红）。
    //
    //   ★★★ 判据（值得记）：**"把这个标记删掉再匹配" 是把语义删掉了，不是把噪音删掉了。**
    //     同一个病在别处也犯过：D307 的"剥离用的标记不能出现在被剥离的内容里"。
    //     标记**有语义**时，必须**按语义处理**（negation ⇒ 取消先前规则），不能一删了之。
    //
    //   ★ 修法：**按 Git 的规则顺序模拟**——逐行扫，`!` 开头 = 取消匹配，其余 = 置匹配。
    //     这比"找有没有那一行"准确得多，且能处理"先忽略后否定"的顺序。
    //     ★ 只模拟**与我们这个目录相关**的规则（其它规则的顺序不影响本目录是否被忽略）。
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const giAbs = path.join(projectRoot, ".gitignore");
      let giText = "";
      try {
        giText = fs.existsSync(giAbs) ? fs.readFileSync(giAbs, "utf8") : "";
      } catch {
        giText = "";
      }

      // ★★★★★ 2026-10-24（D317 · F05 收口）：**改调 `ignoreStateOf`，不再在本函数里内联一份。**
      //   🔴 这里原来有一份 `patternMatches` + 顺序模拟 —— 与 `part4.repairConformance` 的
      //     `negatedLast()` **各写一套**，而后者只比字面目录名 ⇒
      //     检测能认出通配反选、修复认不出 ⇒ **"说能修、修不了"**（回 `changed:false, actions:[]`）。
      //   ★ 判据：**同一个事实（"这目录被忽略了吗"）只能有一个出口**。
      //     两套判据必然分叉，而分叉的表现就是"一个说行、一个说不行"——**这比两边都错更难查**。
      const gi = ignoreStateOf(memoryRoot, giText);
      if (gi.ignored !== true) {
        const why =
          gi.hits.length === 0
            ? "没有任何一条规则命中它"
            : `最后一条命中的规则是 \`${gi.lastHit.line}\` —— \`!\` 表示**取消忽略**`;
        reasons.push(
          `\`.gitignore\` **没有覆盖记忆目录 \`${memoryRoot}\`**（第 3 代要求之一 —— 记忆绝不能被误提交）：${why}`
        );
        fixable.push(`往 \`.gitignore\` 追加一条 \`${gi.want}/\`（纯加一行；★ 注意不要写成 \`!${gi.want}/\`）`);
      }
    }

    // ③ 清单镜像是否与权威一致（D303 铁律：两份必须同步）
    {
      const mtext = manifest === undefined ? undefined : `${JSON.stringify(manifest, null, 2)}\n`;
      const mv = verifyManifestMirror(projectRoot, manifest, mtext);
      if (mv.state === "missing") {
        reasons.push(`记忆目录里**没有清单镜像 \`.dsh-ledger.json\`**（第 3 代要求之一：两份清单必须同步）`);
        fixable.push("用权威清单重写镜像（插件自动完成，不需要你提供内容）");
      } else if (mv.state === "stale") {
        reasons.push(
          `清单镜像与权威**不同步**（${mv.detail ?? "内容不同"}）—— 有一处改动漏了同步（第 3 代要求之一）`
        );
        fixable.push("用权威清单重写镜像（插件自动完成）");
      } else if (mv.state === "unreadable") {
        reasons.push(`清单镜像**存在但读不出**（权限或编码问题）：${mv.path}`);
        fixable.push("检查该文件权限后重写镜像");
      } else if (mv.state === "unsafe") {
        // ★ 2026-10-23（D313 / F02）：**越界的镜像必须报成越界，不能报成 in-sync**。
        //   ★ 为什么单列一个分支：如果只在写侧拒绝，一个**已经越界**的镜像会继续被读侧判成
        //     "内容一致" ⇒ 合规说 ok，而那份文件其实住在项目外。那是比 stale 更坏的假绿。
        reasons.push(
          `清单镜像的落点**越界**（${mv.detail ?? "真实路径在项目之外"}）—— 第 3 代要求镜像必须住在记忆目录内`
        );
        fixable.push("把 `memoryRoot` 改回记忆目录内的相对路径（或去掉那个符号链接），然后重写镜像");
      }
    }

    // ④ 路径越界（`inspect()` 已经算出来了，这里必须把它变成判定）
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔴🔴 2026-10-23（D315 · Gemini 静态审查 001 的 F-02）**真缺陷修复**
  //
  //   病：`④ 路径越界` 原本写在 `if (typeof memoryRoot === "string" && memoryRoot !== "")`
  //       **里面**。而 `memoryRoot` **越界时 `inspect()` 会把 `info.memoryRoot` 置为 `undefined`**
  //       （它只把值记进 `unsafePaths`）⇒ `if` 整段跳过 ⇒ **reasons 恒空**。
  //   ⇒ 结果：**"memoryRoot 越界"这件最该报的事，恰好是唯一报不出来的**；
  //      V2 项目里 `decisionsDir: "../outside"` 越界同样因为 `memoryRoot === undefined` 而完全漏报。
  //   ★ 实测（`tools/_probe-gemini001-findings.mjs` F-02①）：`unsafePaths` 有 1 项，`reasons = []`。
  //
  //   ★★★ 判据：**"门槛条件"与"门槛里的检查项"必须分清** ——
  //      一个检查项若**正是为了报"门槛条件不成立"**，它就不能被放在那个门槛里面。
  //      （这里门槛是"已声明第 3 代布局"，而"路径越界"恰恰会让第 3 代布局声明失效。）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const bad = Array.isArray(unsafePaths) ? unsafePaths : [];
    for (const u of bad.slice(0, 6)) {
      reasons.push(
        `清单字段 \`${u.field}\` 的值 \`${String(u.value)}\` **路径越界**：${u.why ?? "逃出了允许范围"}`
      );
      fixable.push(`把清单里的 \`${u.field}\` 改成记忆目录内的相对路径`);
    }
    if (bad.length > 6) reasons.push(`另有 ${bad.length - 6} 处清单路径越界（未逐条列出）`);
  }
  return { reasons, fixable };
}


// ═══════════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-25（D320 · F-05）：从 `part2.js` 搬来的**清单坏档判据**。
//   为什么搬：`part2.js` 已到 262,064 B（余 80 B），这段 2,133 B 塞不下。
//   为什么放这里而不是新开文件：本文件已经是**合规/清单体检**的归属地，
//     且它只依赖 node 内建（叶子模块）⇒ 搬进来不新开任何依赖边。
//   ★ part2 里留 `import` + `export ... from` ⇒ 调用方零改动。
// ═══════════════════════════════════════════════════════════════════

/**
 * ★★★★★ 2026-10-25（D320 · Gemini 审查 004 的 **F-05**）：**"清单不存在"与"清单坏了"必须分开**。
 *
 * 🔴 病：`readManifest` 对**三种**情况一律返回 `undefined`：
 *   ① 文件不存在（从没建过台账）；② 文件在但 JSON 坏了；③ 能解析但缺 `active`。
 *   ⇒ 一个 **V3 项目**的清单被手改坏之后，`inspect` 会丢掉 `memoryRoot`
 *     ⇒ **静默从 V3 降级成 V2**，且 `memoryRootUnsafe` 是 undefined
 *     ⇒ `refuseIfMemoryRootUnsafe` **整条失效** ⇒ 之后每次写记忆都写进**源码根**。
 * ★★★ 判据：**"读不到"与"没有"是两件事** —— 合并它们，等于让一个可修复的编辑错误
 *   变成一次静默的数据落错位置（D167「不许把失败说成没发生」同型）。
 *
 * @returns {{ok:boolean, manifest?:object, broken?:boolean, why?:string}}
 *   `ok:true,manifest` 正常 · `ok:true,manifest:undefined,broken:false` **真的没有**（唯一允许"猜"的情况）
 *   · `ok:false,broken:true,why` **有文件但读不出来**（必须让用户知道）
 */
export function readManifestDetailed(projectRoot, manifestRel) {
  const file = path.join(projectRoot, manifestRel);
  let fileLstat = false;
  try {
    fs.lstatSync(file);
    fileLstat = true;
  } catch {
    fileLstat = false;
  }
  const raw = readTextSafe(file);
  // ① 文件不存在 ⇒ 真的没有（这是**唯一**允许走"猜"的情况）
  if (raw === undefined) {
    if (fileLstat) {
      return { ok: false, broken: true, why: "清单文件存在但无法读取（可能为损坏符号链接或权限不足）" };
    }
    return { ok: true, manifest: undefined, broken: false };
  }
  // ② 文件在但解析不了 ⇒ 坏档
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, broken: true, why: `JSON 解析失败：${String((e && e.message) || e).slice(0, 200)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, broken: true, why: "顶层不是一个对象（清单必须是 JSON 对象）" };
  }
  // ③ 能解析但缺 active ⇒ 缺必填字段
  if (typeof parsed.active !== "string" || parsed.active === "") {
    return { ok: false, broken: true, why: "缺少必填字段 `active`（或它是空串）" };
  }
  return { ok: true, manifest: parsed, broken: false };
}
