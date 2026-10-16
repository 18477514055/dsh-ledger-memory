// D221 · 从 app.asar 里读**单个文件**的原文（按 asar 内路径）
// 用法：node tools/_probe-d221-asar-read.mjs <asar内路径> [输出文件]
import fs from "node:fs";
import path from "node:path";

// ★ 隐私（D221）：**绝不把真实用户名写进 tools/**（它是 PUBLIC 的）。
//   路径用环境变量拼：%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\app.asar
//   ★ 回读：本机解析结果就是活桌面端那个 asar（与硬编码时同一个文件）。
const ASAR = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "app.asar");
const REL = process.argv[2];
const OUT = process.argv[3];
if (!REL) {
  console.error("用法：node tools/_probe-d221-asar-read.mjs <asar内路径> [输出文件]");
  process.exit(2);
}

const fd = fs.openSync(ASAR, "r");
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const tree = JSON.parse(jsonBuf.toString("utf8"));

  const parts = REL.split("/").filter(Boolean);
  let node = tree;
  for (const p of parts) {
    node = node?.files?.[p];
    if (!node) throw new Error(`asar 里没有 ${REL}（在 "${p}" 处断掉）`);
  }
  if (node.files) throw new Error(`${REL} 是目录，不是文件`);

  let buf;
  if (node.offset === undefined || node.size === undefined) {
    buf = fs.readFileSync(`${ASAR}.unpacked/${REL.split("/").join("/")}`);
  } else {
    const off = 16 + jsonLen + Number(node.offset);
    buf = Buffer.alloc(Number(node.size));
    fs.readSync(fd, buf, 0, buf.length, off);
  }
  if (OUT) {
    fs.writeFileSync(OUT, buf);
    console.log(`${REL} → ${OUT}（${buf.length} B）`);
  } else {
    process.stdout.write(buf.toString("utf8"));
  }
} finally {
  fs.closeSync(fd);
}
