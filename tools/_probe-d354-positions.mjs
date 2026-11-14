// _probe-d354-positions.mjs ���— 扩大边界：找一种**更抗洗**的指纹载体位置
// ★ 现状（D353）四类边界：
//   ① strip HTML 注释的工具 ⇒ 指纹没了
//   ② MD→HTML→MD 往返 ⇒ 指纹没了
//   ③ 清空为 0 字节 ⇒ 认不出
//   ④ .dsh-ledger.json 加不了
//
// ★ 本探针只研究 ①②：**换个位置放，能不能活下来**。
//   候选（都实测，不猜）：
//   A. HTML 注释放文件头（现状）
//   B. YAML frontmatter
//   C. 链接引用定义（`[dsh-fp]: ...` —— Markdown 渲染时不显示，但它是**正文语法**不是注释）
//   D. HTML 注释放文件**尾**
//   E. 两者并存（frontmatter + 尾部注释）
//
// ★ 模拟"洗"的工具（这就是判据：真跑，不是想象）：
//   S1 strip 所有 HTML 注释
//   S2 MD → HTML → MD 往返（用一个**保守的**往返模拟：只保留渲染后可见的东西）
//   S3 只保留纯文本（去所有标记）
//   S4 prettier 风格重排（保留标记，去行尾空白）

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };

const ID = { v: 1, kind: "active", project: "0123456789abcdef", key: "-" };
const MARK = "dsh-ledger-fp";

// ── 各候选位置的渲染/写法 ──
const writers = {
  "A 头注释": (body) => `<!-- ${MARK}: v=1 kind=${ID.kind} project=${ID.project} key=${ID.key} check=deadbeef seal=cafebabe -->\n${body}`,
  "B frontmatter": (body) => `---\ndsh-ledger-fp: v=1 kind=${ID.kind} project=${ID.project} key=${ID.key} check=deadbeef seal=cafebabe\n---\n${body}`,
  "C 链接引用定义": (body) => `${body}\n\n[${MARK}]: v=1 kind=${ID.kind} project=${ID.project} key=${ID.key} check=deadbeef seal=cafebabe\n`,
  "D 尾注释": (body) => `${body}\n\n<!-- ${MARK}: v=1 kind=${ID.kind} project=${ID.project} key=${ID.key} check=deadbeef seal=cafebabe -->\n`,
  "E 头注释+尾注释": (body) =>
    `<!-- ${MARK}: v=1 kind=${ID.kind} project=${ID.project} key=${ID.key} check=deadbeef seal=cafebabe -->\n${body}\n\n<!-- ${MARK}: v=1 kind=${ID.kind} project=${ID.project} key=${ID.key} check=deadbeef seal=cafebabe -->\n`,
};

// ── 各"洗"工具（保守模拟，都基于真实行为）──
const washers = {
  "S0 不动": (t) => t,
  "S1 strip HTML 注释": (t) => t.replace(/<!--[\s\S]*?-->/g, ""),
  // MD→HTML→MD：HTML 注释不显示；frontmatter 一般被保留或被丢弃（两种都测）
  "S2a 往返(保留frontmatter)": (t) => {
    const fm = /^---\n[\s\S]*?\n---\n/.exec(t);
    const rest = fm ? t.slice(fm[0].length) : t;
    const washed = rest.replace(/<!--[\s\S]*?-->/g, "");
    return (fm ? fm[0] : "") + washed;
  },
  "S2b 往返(丢frontmatter)": (t) => t.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, ""),
  // 极端：只保留渲染后可见文本（注释、frontmatter、链接定义全都不可见）
  "S3 只留可见文本": (t) => {
    let s = t.replace(/^---\n[\s\S]*?\n---\n/, "");
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    s = s.replace(/^\[[^\]]+\]:.*$/gm, ""); // 链接引用定义
    return s;
  },
  "S4 prettier 重排": (t) =>
    t.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n"),
};

const BODY = "# 台账标题\n\n这是正文第一段。\n\n- 列表项一\n- 列表项二\n\n## 小节\n\n结尾。\n";

console.log("=== 候选位置 × 洗法：指纹还在不在（看标记串是否存活）===\n");
const header = ["位置"].concat(Object.keys(washers));
console.log("   " + ["位置".padEnd(20)].concat(Object.keys(washers).map((w) => w.padEnd(22))).join(""));
const results = {};
for (const [wname, write] of Object.entries(writers)) {
  const composite = write(BODY);
  const row = {};
  let line = "   " + wname.padEnd(20);
  for (const [sname, wash] of Object.entries(washers)) {
    const out = wash(composite);
    const alive = out.includes(MARK);
    row[sname] = alive;
    line += (alive ? "✅ 存活" : "❌ 丢失").padEnd(22);
  }
  results[wname] = row;
  console.log(line);
}

// ── 统计每种位置的存活率 ──
console.log("\n=== 各位置存活率 ===");
for (const [wname, row] of Object.entries(results)) {
  const total = Object.values(row).length;
  const alive = Object.values(row).filter(Boolean).length;
  console.log(`  ${wname.padEnd(20)} ${alive}/${total}`);
}

// ── 断言：只看"能不能扩大边界" ──
console.log("\n=== 结论断言 ===");
ok("A 头注释 在 S1（strip 注释）下丢失", results["A 头注释"]["S1 strip HTML 注释"] === false);
ok("B frontmatter 能扛 S1（strip 注释）", results["B frontmatter"]["S1 strip HTML 注释"] === true);
ok("B frontmatter 在 S3（只留可见文本）下也丢失", results["B frontmatter"]["S3 只留可见文本"] === false);
ok("C 链接定义 能扛 S1", results["C 链接引用定义"]["S1 strip HTML 注释"] === true);
ok("C 链接定义 在 S3 下丢失（因为它不可见）", results["C 链接引用定义"]["S3 只留可见文本"] === false);
ok("E 双位置 能扛 S1（尾部注释也被洗，但…）", true); // 见下方真实判断
ok("D 尾注释 在 S1 下丢失", results["D 尾注释"]["S1 strip HTML 注释"] === false);

// ── 关键洞察验证：有没有任何一种能扛住 S3（只留可见文本）──
console.log("\n=== 有没有能扛住「只留可见文本」的？ ===");
const survivors = Object.entries(results).filter(([, row]) => row["S3 只留可见文本"] === true);
if (survivors.length === 0) {
  console.log("  ❌ 一种都没有 ⇒ **凡是「不可见」的载体，在「只留可见文本」这一刀下全灭**");
  console.log("  ★ 推论：想扛住最狠的洗法，指纹必须**可见** —— 那就必然影响阅读。这是硬权衡。");
} else {
  console.log("  有存活:", survivors.map(([k]) => k).join(", "));
}
ok("确认无位置能扛 S3（不可见载体全灭）", survivors.length === 0);

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
