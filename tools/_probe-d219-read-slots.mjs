// D219 附 · 逐字读官方 ui-slots 的源码，看它到底 provide 什么、以及 caller inject 的
// 到底是不是服务名 —— 我的上一个判据说「slots 不存在」，但插件实际在跑 ⇒ 先怀疑尺子。
import fs from "node:fs";
import path from "node:path";

// ★ 隐私（D221）：**绝不把真实用户名写进 tools/**（它是 PUBLIC 的）。
//   路径按环境变量拼 ⇒ 任何人的机器上都能解析，且源码里没有本机专有信息。
const ASAR = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Programs", "DeepSeek Harness", "resources", "app.asar"
);
const TARGET = "/dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js";

const fd = fs.openSync(ASAR, "r");
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  const tree = JSON.parse(jb.toString("utf8"));

  let node = tree;
  for (const part of TARGET.split("/").filter(Boolean)) node = node.files?.[part];
  if (!node) {
    console.error("找不到目标文件");
    process.exit(2);
  }

  let text;
  if (node.offset === undefined) {
    // unpacked
    text = fs.readFileSync(`${ASAR}.unpacked/${TARGET.replace(/^\//, "").replace(/\//g, "\\")}`, "utf8");
  } else {
    const off = 16 + jsonLen + Number(node.offset);
    const buf = Buffer.alloc(Number(node.size));
    fs.readSync(fd, buf, 0, buf.length, off);
    text = buf.toString("utf8");
  }

  console.log(`═══ ${TARGET}（${Buffer.byteLength(text)} B）═══`);
  const lines = text.split("\n");
  console.log(`总行数 ${lines.length}\n`);

  console.log("── 含 provide / name / inject / slots 的行 ──");
  lines.forEach((l, i) => {
    if (/\bprovide\b|\bname\s*[:=]|\binject\b/.test(l)) {
      console.log(`  L${i + 1}: ${l.trim().slice(0, 150)}`);
    }
  });

  console.log("\n── 末尾 25 行（看它 return 什么）──");
  for (let i = Math.max(0, lines.length - 25); i < lines.length; i++) {
    console.log(`  L${i + 1}: ${lines[i].slice(0, 150)}`);
  }
} finally {
  fs.closeSync(fd);
}
