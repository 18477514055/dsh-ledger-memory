/**
 * 探针（D288 §6.3）：**插件本体到底有没有"向外发送"的能力？**
 *
 * ★ 为什么要有它：用户 2026-10-21 授权写入原则「本插件的产物绝不擅自推送云端」，
 *   并要求「这个也应该成为我们插件其他地方的必须保证的东西」。
 *   —— "必须保证"如果只是文字，下次照样会被绕过（L26：教训必须变成判据）。
 *
 * ★ 本探针做两件事：
 *   ① **静态清点**：`lib/` 里有没有任何"远端写"能力（push / publish / upload / fetch 之类）。
 *      答：**一个都没有**（这是好消息 —— 说明插件本身没有后门，风险全在"模型接手那一步"）。
 *   ② **机检新增长点**：把这份清单固化成断言。将来谁在 lib 里加了一个 `git push`
 *      或一个 `fetch(...)`，这里**当场变红** —— 那就是原则里说的"必须配一条能看见红的机检"。
 *
 * ★ 判据要**只吃代码**，不吃注释（本项目栽过：注释里提了 `lib/index.js` 就算命中）。
 *
 * 跑法：node tools/_probe-no-cloud-write.mjs
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
};

/**
 * ★★★ 2026-10-21（D288 现场）：本探针第一版报了 **2 处命中**，逐个查清后——
 *   **两处都是假阳性**，而且成因不同，正好把"判据要吃对对象"这条纪律又演了一遍：
 *
 *   ① `part5.js:305` —— 命中的是**工具描述里的一句英文**：
 *      `"With mode:'events', the exact seqs to fetch (take them from …)"`
 *      ⇒ 那个 `fetch` 是**单词**，不是调用。★ 这类误报的根因是：
 *        我的 `stripComments` **保留了字符串**（因为命令名确实在字符串里），
 *        于是"文档正文"被当成了"代码"。
 *      ⇒ 修法：**`fetch(` 这类调用式判据，要求前面不是引号内的纯文本**；
 *        更稳的办法是——**单独判"字符串外"的调用**。这里用一个务实的折中：
 *        要求 `fetch(` 后面是表达式（`"`/`'`/`/ 参数`），并且**该行不是以 `"` 或 `+` 结尾的文档串**。
 *        实现上更简单可靠：**先看是否在 `description:`/`hint:`/`why:` 这类文档属性里**，是就跳过。
 *
 *   ② `client.js:228` —— 这是**真的 `fetch`**，但它打的是**同源相对路径**：
 *      `const API_BASE = "/" + PLUGIN_ID + "-settings"` ⇒ `fetch("/dsh-ledger-memory-settings/config.json")`，
 *      且带 `credentials: "same-origin"`。
 *      ⇒ **这是问本机宿主要设置，不是往外发**。插件设置面板必须这么走（D221 定的服务端授权边界）。
 *      ⇒ 判据要能区分"同源相对路径"与"绝对 URL"：**只有出现 `http(s)://` 或明显的域名才算外发**。
 *
 *   ★★ 结论：**判据不能一刀切"见到 fetch 就报"** —— 那会把唯一合法的本机调用也判死。
 *      真正的红线是「**内容离开本机**」，所以判据盯的是 **绝对 URL / socket / push / publish**。
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | sq | dq | tpl
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'") {
        state = "sq";
        out += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        state = "dq";
        out += c;
        i += 1;
        continue;
      }
      if (c === "`") {
        state = "tpl";
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 2;
        continue;
      }
      // ★ 保留换行，保证行号大致对得上
      if (c === "\n") out += c;
      i += 1;
      continue;
    }
    // 字符串内部：原样保留，处理转义
    if (c === "\\") {
      out += c + (n ?? "");
      i += 2;
      continue;
    }
    if (
      (state === "sq" && c === "'") ||
      (state === "dq" && c === '"') ||
      (state === "tpl" && c === "`")
    ) {
      state = "code";
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const files = fs.readdirSync(LIB).filter((f) => f.endsWith(".js")).sort();
ok("① lib/ 下有源码文件", files.length > 0, files.join(","));

// ── ② 逐条危险模式：任何一条命中都算"新增了向外发送能力" ──
//
//   ★ 每条都要**同时**给出：名字、正则、为什么危险。
//   ★ 判据刻意写得**宽**（宁可误报一次让人来看），因为漏报的代价是数据外泄。
const DANGEROUS = [
  {
    name: "git push",
    re: /\[\s*(?:["']push["'])/,
    why: "把本机提交推到远端。★ 这正是 D288 事故的最后一步。",
  },
  {
    name: "git remote add",
    re: /\[\s*["']remote["']\s*,\s*["']add["']/,
    why: "给用户仓库挂一个新远端 —— 之后一次 push 就出去了。",
  },
  {
    name: "npm publish",
    re: /npm\s+publish|["']publish["']\s*,\s*["']--/,
    why: "发布到包仓库，不可撤销。",
  },
  {
    // ★ 只有**绝对 URL** 才算外发。同源相对路径（插件问本机宿主要设置）不算。
    name: "向绝对 URL 发请求",
    re: /\bfetch\s*\(\s*[`"']https?:\/\//,
    why: "把数据发到本机之外的地址。",
  },
  {
    name: "http/https 请求（带 URL）",
    re: /(?:node:)?https?\.(?:request|get)\s*\(\s*[^)]{0,80}https?:\/\//,
    why: "同上，低层写法。",
  },
  {
    name: "网络请求（net / dgram）",
    re: /(?:node:)?(?:net|dgram)\.(?:connect|createSocket|createConnection)\s*\(/,
    why: "绕过 HTTP 的直接套接字。",
  },
  {
    name: "上传类调用",
    re: /\b(?:putObject|sendToCloud|uploadFile|webhookSend)\s*\(/i,
    why: "名字就写着往外发。",
  },
];

/**
 * ★ 文档属性里的字样不算代码。
 *   实测假阳性：`part5.js:305` 的工具描述里有一句英文
 *   `"… the exact seqs to fetch (take them from …)"` —— 那个 fetch 是**单词**。
 *   ⇒ 判据把 `description:` / `hint:` / `why:` / `label:` 这类**文档值**整段抹掉再判。
 *   ★ 这不是"放宽"，是**把判据对准被测对象**（纪律 2）。
 */
function stripDocStrings(code) {
  return code
    .replace(/\b(?:description|hint|why|label|note|title)\s*:\s*"(?:[^"\\]|\\.)*"/g, '$1:""')
    .replace(/\b(?:description|hint|why|label|note|title)\s*:\s*'(?:[^'\\]|\\.)*'/g, "$1:''")
    .replace(/\b(?:description|hint|why|label|note|title)\s*:\s*`(?:[^`\\]|\\.)*`/g, "$1:``");
}

console.log("\n── ② 逐个文件扫描「向外发送」能力 ──");
const hits = [];
for (const f of files) {
  const raw = fs.readFileSync(path.join(LIB, f), "utf8");
  const code = stripDocStrings(stripComments(raw));
  for (const d of DANGEROUS) {
    if (d.re.test(code)) {
      hits.push({ file: f, rule: d.name, why: d.why });
    }
  }
}
if (hits.length === 0) {
  console.log("        未发现任何向外发送能力 —— 与预期一致。");
}
for (const h of hits) console.log(`        ⚠ ${h.file}: ${h.rule}（${h.why}）`);

ok(
  "② ★ 插件本体**没有任何**向外发送能力（push / publish / fetch / socket / upload）",
  hits.length === 0,
  hits.map((h) => `${h.file}:${h.rule}`).join(" | "),
);

// ── ③ 反向自检：这套判据**能不能看见红**？──────────────────────────────
//
//   ★ 纪律 10：反向验证必须摘到"能看见红"为止。
//     这里不摘真实代码（那要改源码），而是**造一段假代码**喂给同一套正则 ——
//     若它连明显的 `git push` 都认不出来，那上面那条 PASS 就是假绿。
console.log("\n── ③ 反向自检：判据本身认得出来吗 ──");
const fakeBad = `
  // 注释里的 git push 不该算
  const g = (root, args) => git(root, args);
  g(root, ["push", "origin", "main"]);
  g(root, ["remote", "add", "origin", "https://evil"]);
  await fetch("https://example.com/upload");
  https.request("https://example.com/x", { method: "POST" });
  putObject(payload);
`;
const fakeCode = stripDocStrings(stripComments(fakeBad));
const detected = DANGEROUS.filter((d) => d.re.test(fakeCode)).map((d) => d.name);
ok(
  "③ 反向：伪造的危险代码能被识别（≥5 条规则命中）",
  detected.length >= 5,
  `只命中 ${detected.length} 条：${detected.join(",")}`,
);
console.log(`        命中规则：${detected.join(" / ")}`);

// ★ 再反向一层：**纯注释**里写同样的字样，必须**一条都不命中**
const fakeCommentOnly = `
  // 这里将来可能 git push、也可能 fetch("https://x") 或 putObject()
  /* https.request("https://y") 也不要 */
`;
const fakeCommentCode = stripDocStrings(stripComments(fakeCommentOnly));
const falseHits = DANGEROUS.filter((d) => d.re.test(fakeCommentCode)).map((d) => d.name);
ok(
  "③ 反向：纯注释里的同样字样**不**命中（判据只吃代码）",
  falseHits.length === 0,
  `误报：${falseHits.join(",")}`,
);

// ★★★ 第三层反向：**本机同源 fetch 必须豁免**（这是真实假阳性的固化）
const fakeSameOrigin = `
  const API_BASE = "/dsh-ledger-memory-settings";
  const res = await fetch(API_BASE + "/config.json", { credentials: "same-origin" });
  description: "the exact seqs to fetch (take them from a mode:'index' result)";
`;
const fakeSameCode = stripDocStrings(stripComments(fakeSameOrigin));
const sameHits = DANGEROUS.filter((d) => d.re.test(fakeSameCode)).map((d) => d.name);
ok(
  "③ ★ 同源相对 fetch 与文档串里的「fetch」**不算外发**（真实假阳性的固化）",
  sameHits.length === 0,
  `误报：${sameHits.join(",")}`,
);

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
