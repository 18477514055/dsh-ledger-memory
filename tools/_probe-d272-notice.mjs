// 真跑：看「协议过期」这条提示在注入里长什么样（三档：有缺口 / 只缺版本号 / 超前）。
import { renderProtocolUpgradeNotice } from "../lib/part1.js";
import { protocolGapOf } from "../lib/defs.js";

const CASES = [
  {
    label: "A 老项目（缺卡片化 + 缺 logDir，无 protocolVersion）",
    manifest: { version: 1, active: "LEDGER.md", archiveDir: "_ledger-archive" },
  },
  {
    label: "B 结构齐全、只是没写 protocolVersion（= 本项目现状）",
    manifest: {
      version: 1,
      active: "LEDGER.md",
      archiveDir: "_ledger-archive",
      logDir: "_ledger-log",
      decisionsDir: "decisions",
      lessonsDir: "lessons",
      goalsDir: "goals",
    },
  },
  {
    label: "C 已是最新一代",
    manifest: {
      protocolVersion: 2,
      active: "LEDGER.md",
      logDir: "_ledger-log",
      decisionsDir: "decisions",
      lessonsDir: "lessons",
      goalsDir: "goals",
    },
  },
  {
    label: "D 超前（别人用更新插件建的，protocolVersion=3）",
    manifest: { protocolVersion: 3, active: "LEDGER.md" },
  },
];

for (const c of CASES) {
  const g = protocolGapOf(c.manifest);
  const text = renderProtocolUpgradeNotice({ manifest: c.manifest });
  console.log("═".repeat(78));
  console.log(c.label);
  console.log(`  projectVersion=${g.projectVersion} current=${g.currentVersion} outdated=${g.outdated} gaps=${g.missing.length}`);
  console.log(`  注入段长度=${text.length}`);
  if (text !== "") {
    console.log("  ---- 注入正文 ----");
    // ★ 按真实换行打印（原实现用 split("\n") + join("") 把裸 \n 吃掉了 —— 那是探针的错，不是代码的错）
    text.split("\n").forEach((l) => console.log("  " + l));
  }
}
