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
import { isUnder } from "./base.js";
import { verifyManifestMirror } from "./manifest-mirror.js";
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
      const secOk = isUnder(mBaseV3, secAbs) && fs.existsSync(secAbs);
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
    //     这里用朴素前缀/通配匹配（保守：**匹配上就算过**，宁可漏报也不误报）。
    {
      const giAbs = path.join(projectRoot, ".gitignore");
      let giText = "";
      try {
        giText = fs.existsSync(giAbs) ? fs.readFileSync(giAbs, "utf8") : "";
      } catch {
        giText = "";
      }
      const want = String(memoryRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
      const lines = giText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
      const covered =
        want !== "" &&
        lines.some((l) => {
          const pat = l.replace(/^!/, "").replace(/^\//, "").replace(/\/+$/, "");
          if (pat === "") return false;
          // 三种等价写法：逐字相等 · 以 `*` 开头的通配 · 目录名本身出现在模式里
          if (pat === want) return true;
          if (pat.startsWith("*") && want.endsWith(pat.slice(1))) return true;
          if (pat.includes("*") && new RegExp(`^${pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(want)) return true;
          return false;
        });
      if (!covered) {
        reasons.push(
          `\`.gitignore\` **没有覆盖记忆目录 \`${memoryRoot}\`**（第 3 代要求之一 —— 记忆绝不能被误提交）`
        );
        fixable.push(`往 \`.gitignore\` 追加一条 \`${want}/\`（纯加一行）`);
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
      }
    }

    // ④ 路径越界（`inspect()` 已经算出来了，这里必须把它变成判定）
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
  }
  return { reasons, fixable };
}
