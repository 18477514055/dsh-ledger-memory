/** 检查台账插件的**真实使用效果**：从各项目的日志与台账里取硬证据。
 *
 * ★ 这是**一次性统计脚本**，projects 列表是本机工作区的项目名 ⇒ 公开仓库里没意义。
 *   用 `DSH_WS` 指定工作区根；不给就 SKIP（免得别人 clone 下来看到一堆假失败）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WS = process.env.DSH_WS;
if (WS === undefined) {
  console.log("  SKIP  这是本机一次性统计脚本：用 `DSH_WS=<工作区根>` 指定后再跑。");
  console.log("        （项目清单按需在下面 projects 里自己写）");
  process.exit(0);
}
// ★ 项目清单是**使用时自己填**的：这是"统计某个工作区里各项目"的工具，不是本插件的约定。
//    格式：[显示名, 相对工作区根的路径]
const projects = (process.env.DSH_WS_PROJECTS
  ? JSON.parse(process.env.DSH_WS_PROJECTS)
  : [
      ["本插件（本身）", "20-DSH插件/04-其余插件/10.项目台账"],
    ]);

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const linesOf = (s) => s.split("\n").filter((l) => l.trim().startsWith("-"));

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  台账插件真实使用情况（数据取自各项目自己的日志与台账）              ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

for (const [name, rel] of projects) {
  const dir = path.join(WS, rel);
  let m;
  try {
    m = JSON.parse(read(path.join(dir, ".dsh-ledger.json")));
  } catch {
    continue;
  }
  console.log(`\n━━━ ${name} ━━━`);
  console.log(`  路径：${rel}`);

  const logDir = path.join(dir, m.logDir ?? "_ledger-log");
  const all = [];
  (function walk(d) {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else all.push(p);
    }
  })(logDir);

  // L0 里程碑：事件类型分布 + 压缩事件
  const msFile = all.find((f) => path.basename(f) === "L0-milestones.md");
  if (msFile !== "") {
    const ms = linesOf(read(msFile));
    const byType = {};
    for (const l of ms) {
      const k = l.match(/\(([^)]+)\)/)?.[1] ?? "?";
      byType[k] = (byType[k] ?? 0) + 1;
    }
    console.log(`  L0 里程碑 ${ms.length} 条：` + Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));

    const comp = ms.filter((l) => /compaction/.test(l));
    const delta = comp.filter((l) => /auto:delta/.test(l));
    if (comp.length > 0) {
      console.log(`  ★ 压缩 ${comp.length} 次，其中 **auto:delta（增量）${delta.length} 次**`);
      for (const l of comp) console.log(`      ${l.slice(2, 70)}`);
    }
  }

  // L1：条数 + 会话标签
  const l1File = all.find((f) => path.basename(f) === "L1-turns.md");
  if (l1File !== "") {
    const l1 = linesOf(read(l1File));
    const tags = {};
    for (const l of l1) {
      const k = l.match(/\(L1\)\s*([0-9a-f]{4})[：:]/)?.[1] ?? "(无)";
      tags[k] = (tags[k] ?? 0) + 1;
    }
    const span = l1.length > 0 ? `${l1[0].slice(2, 16)} → ${l1.at(-1).slice(2, 16)}` : "—";
    console.log(`  L1 回合摘要 ${l1.length} 条（${span}）`);
    console.log(`      多会话标签：` + Object.entries(tags).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" · "));
  }

  // L4 用户消息
  const l4 = all.find((f) => path.basename(f) === "L4-user-messages.md");
  if (l4 !== undefined) {
    const n = linesOf(read(l4)).length;
    console.log(`  ★ L4 用户消息存档 ${n} 条（自动采集，不注入上下文）`);
  }

  // 台账规模
  const act = read(path.join(dir, m.active));
  const dec = read(path.join(dir, m.decisions));
  console.log(`  台账 ${act.split("\n").length} 行 / 上限 ${m.maxActiveLines} · revision **${m.revision}** · 决策 ${dec.split("\n").length} 行`);
}
