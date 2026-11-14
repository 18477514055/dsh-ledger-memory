import fs from "node:fs";

const p = "lib/init-tool.js";
const t = fs.readFileSync(p, "utf8");
if (t.includes('from "./card-ops.js"')) {
  console.log("已有 card-ops import，跳过");
} else {
  const anchor = 'import { clearProjectCache, ensureProjectId } from "./fingerprint.js";';
  if (!t.includes(anchor)) {
    console.log("找不到锚点！");
    process.exit(1);
  }
  const add =
    anchor +
    "\n" +
    "// ★ 这六个来自 card-ops（拆卡迁移那一段要用）。切分脚本的单行正则没匹配到 part4 里那条多行 import，\n" +
    "//   于是漏了它们 —— 是 node --check 抓出来的，不是我想到的。\n" +
    'import { cardDirLabel, cardModeOf, listCards, splitIntoCardParts, writeCard, writeCardIndex } from "./card-ops.js";';
  fs.writeFileSync(p, t.replace(anchor, add), "utf8");
  console.log("已补 card-ops import");
}
