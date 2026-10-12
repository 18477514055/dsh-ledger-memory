/**
 * 只读探针 ⑦：本会话**每次压缩的真实来源**（按时间序）。
 *
 * ★ 为什么要单独数这个：用户的核心判断是「**全量总是轮不上**」。
 *   那是"频率/比例"主张 ⇒ 必须**数**，不能凭一两次观察（纪律 11/12）。
 *
 * ★ 尺子（纪律 2/15）：来源只认**胶囊头里那一行** —— 它是插件在 `pushHfSource` 之后、
 *   由 `compaction/end` 出队时写下的，是**被测系统自己产生的那部分**。
 *   ★ 注意 `source` 的两种口径要分开：全量的语义是 `auto:70%` / `manual` / `command`，
 *     增量的语义是 `auto:delta` / `auto`。数的时候必须按口径分组（纪律 15）。
 */
import fs from "node:fs";
import path from "node:path";

const CAPS = path.join(
  "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账",
  "_ledger-log", "2026-10", "week2", "capsules"
);

const files = fs.readdirSync(CAPS).filter((f) => f.endsWith(".md")).sort();
console.log(`capsules 目录共 ${files.length} 个 md\n`);

const rows = [];
for (const f of files) {
  const s = fs.readFileSync(path.join(CAPS, f), "utf8");
  const m = s.match(/来源\*\*[:：]\s*([^\n]+)/);
  const sess = s.match(/会话\*\*[:：]\s*`?([^`\n]+)`?/);
  rows.push({
    file: f,
    source: m === null ? "(无来源行)" : m[1].trim(),
    session: sess === null ? "?" : sess[1].trim(),
    bytes: fs.statSync(path.join(CAPS, f)).size,
  });
}

// 全量 vs 增量：按 source 文本判定（口径分开数）
const isFull = (s) => /70%|水位|手动|命令|command|manual|card/i.test(s) && !/增量/.test(s);
const isDelta = (s) => /增量/.test(s);

let full = 0;
let delta = 0;
let other = 0;
console.log("文件                                            来源                        类别");
for (const r of rows) {
  const cat = isDelta(r.source) ? "增量" : isFull(r.source) ? "★全量" : "其他";
  if (cat === "★全量") full++;
  else if (cat === "增量") delta++;
  else other++;
  console.log(`  ${r.file.padEnd(46)} ${r.source.padEnd(26)} ${cat}   会话=${r.session.slice(0, 12)}`);
}
console.log(`\n合计：全量 ${full} · 增量 ${delta} · 其他 ${other} · 共 ${rows.length}`);
