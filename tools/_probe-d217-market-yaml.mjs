// D217 · 市场条目 YAML 的**结构自检**（不发出去之前先自己挑毛病）
//
// ★ 为什么自己写：本机没有 yaml 解析器，而那个仓库的 CI 会**严判格式**。
//   等 CI 红一遍再改，等于把一次 bounce 送出去。这里只校**这个条目的形状**
//   （扁平映射 + 一个嵌套 description，值是双引号字符串），够用且不引入依赖。
//
// 用法：node tools/_probe-d217-market-yaml.mjs <yml 路径>
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("用法：node tools/_probe-d217-market-yaml.mjs <yml 路径>");
  process.exit(2);
}
const text = fs.readFileSync(file, "utf8");
const lines = text.split("\n").filter((l) => l.trim() !== "");

let pass = 0;
let fail = 0;
const ok = (label, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
};

// ① 顶层必填键
const topKeys = new Set();
for (const l of lines) {
  const m = /^([a-zA-Z_]+):/.exec(l);
  if (m) topKeys.add(m[1]);
}
ok("顶层有 url", topKeys.has("url"));
ok("顶层有 name", topKeys.has("name"));
ok("顶层有 category", topKeys.has("category"));
ok("顶层有 description", topKeys.has("description"));

const urlM = /^url:\s*(\S+)\s*$/m.exec(text);
ok("url 与仓库完全一致", urlM?.[1] === "https://github.com/18477514055/dsh-ledger-memory", urlM?.[1]);

const nameM = /^name:\s*(\S+)\s*$/m.exec(text);
ok("name 是 owner/repo 形态", nameM?.[1] === "18477514055/dsh-ledger-memory", nameM?.[1]);

// ② category 必须在白名单里
const CATS = ["agi","ui","usage","theme","model","identity","session","memory","tools","wsl","browser","vision","voice","docs","skill","workflow","git","notify","dev","security","remote","market","fun"];
const catM = /^category:\s*(\S+)\s*$/m.exec(text);
ok(`category「${catM?.[1]}」在白名单里`, CATS.includes(catM?.[1]), `白名单 ${CATS.length} 个`);

// ③ tarball：https + GitHub Release + .tgz + **钉住 tag**（贡献指南 :124-128 明确要求）
const tarM = /^tarball:\s*(\S+)\s*$/m.exec(text);
const tar = tarM?.[1] ?? "";
ok("tarball 存在", tar !== "");
ok("tarball 是 https", tar.startsWith("https://"));
ok("tarball 托管在 GitHub Release", /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(tar), tar);
ok("tarball 以 .tgz 结尾", tar.endsWith(".tgz"));
// ★ 贡献指南的坑：latest/download + 带版本文件名 = 下次发版必 404
ok("tarball 钉住了 tag（不用 latest/download 配带版本的文件名）", !tar.includes("/releases/latest/download/"), tar);

// ④ description：只认双引号整行字符串，且**必须是单行**
const descLines = lines.filter((l) => /^\s{2}(en|zh):/.test(l));
ok("description 有 en（唯一必填）", descLines.some((l) => /^\s{2}en:/.test(l)));
ok("description 有 zh", descLines.some((l) => /^\s{2}zh:/.test(l)));

for (const l of descLines) {
  const lang = /^\s{2}(en|zh):/.exec(l)[1];
  const m = /^\s{2}(?:en|zh):\s*"(.*)"\s*$/.exec(l);
  ok(`description.${lang} 被双引号整体包住（含「: 」也安全）`, m !== null, l.slice(0, 80));
  if (m === null) continue;
  const body = m[1];
  ok(`description.${lang} 里没有未转义的双引号`, !body.includes('"'), body.slice(0, 80));
  ok(`description.${lang} 以句号结尾`, /[。.]$/.test(body.trim()), body.slice(-30));
  ok(`description.${lang} 没有营销词`, !/(最强|最好|第一|完美|革命|best|greatest|revolutionary|#1)/i.test(body));
}

// ⑤ ★★★ 关键：描述里出现的**数字**必须与代码真值一致（贡献指南 :81 明说会拿代码核）
//
//   真值来源：`tools/_probe-d217-market-truth.mjs` 实测（不许凭印象写）。
const TRUTH = { tools: 21, subs: 12, settings: 38 };
const zh = (/^\s{2}zh:\s*"(.*)"\s*$/m.exec(text) ?? [])[1] ?? "";
const en = (/^\s{2}en:\s*"(.*)"\s*$/m.exec(text) ?? [])[1] ?? "";

ok(`zh 写的工具数 = ${TRUTH.tools}`, zh.includes(`${TRUTH.tools} 个工具`), zh.match(/\d+ 个工具/)?.[0]);
ok(`en 写的工具数 = ${TRUTH.tools}`, en.includes(`${TRUTH.tools} tools`), en.match(/\d+ tools/)?.[0]);
ok(`zh 写的子命令数 = ${TRUTH.subs}`, zh.includes(`${TRUTH.subs} 个子命令`), zh.match(/\d+ 个子命令/)?.[0]);
ok(`en 写的子命令数 = ${TRUTH.subs}`, en.includes(`${TRUTH.subs} subcommands`), en.match(/\d+ subcommands/)?.[0]);
ok(`zh 写的设置项数 = ${TRUTH.settings}`, zh.includes(`${TRUTH.settings} 项设置`), zh.match(/\d+ 项设置/)?.[0]);
ok(`en 写的设置项数 = ${TRUTH.settings}`, en.includes(`${TRUTH.settings} settings`), en.match(/\d+ settings/)?.[0]);

// ⑥ 不许出现**已经不成立**的说法（这些坑本项目真栽过）
ok("不再宣称「两个模式」", !/两个模式|two modes|steady|surgical/i.test(zh + en));
ok("不再宣称「14 个工具」", !/14 个工具|14 tools/.test(zh + en));
ok("不再宣称「11 个子命令」", !/11 个子命令|11 subcommands/.test(zh + en));
ok("不再指向 v1.1.1 的 tarball", !tar.includes("v1.1.1"));

console.log(`\n═══ 通过 ${pass} / 失败 ${fail} ═══`);
if (fail > 0) process.exitCode = 1;
