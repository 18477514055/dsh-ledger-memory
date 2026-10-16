// D221 · 从活桌面端 app.asar 里**只解出指定的一个包**（按 asar 内路径前缀）
// 用法：node tools/_probe-d221-asar-extract.mjs <asar内相对路径> <输出目录>
//   例：node tools/_probe-d221-asar-extract.mjs dsh/node_modules/@deepseek-ai/dsh-host-webserver %TEMP%\ws-host
import fs from "node:fs";
import path from "node:path";

// ★ 隐私（D221）：**绝不把真实用户名写进 tools/**（它是 PUBLIC 的）。
//   路径用环境变量拼：%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\app.asar
//   ★ 回读：本机解析结果就是活桌面端那个 asar（与硬编码时同一个文件）。
const ASAR = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "app.asar");
const REL = process.argv[2];
const OUT = process.argv[3];
if (!REL || !OUT) {
  console.error("用法：node tools/_probe-d221-asar-extract.mjs <asar内相对路径> <输出目录>");
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

  const UNPACKED_ROOT = `${ASAR}.unpacked`;
  let files = 0;
  let bytes = 0;
  const writeNode = (n, abs, relFull) => {
    for (const [name, v] of Object.entries(n.files ?? {})) {
      const full = path.join(abs, name);
      const rf = `${relFull}/${name}`;
      if (v.files) {
        fs.mkdirSync(full, { recursive: true });
        writeNode(v, full, rf);
      } else if (v.offset === undefined || v.size === undefined) {
        // unpacked 条目：内容在 <asar>.unpacked 下
        const src = path.join(UNPACKED_ROOT, rf);
        try {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.copyFileSync(src, full);
          files += 1;
          bytes += fs.statSync(full).size;
        } catch {
          /* 有些 unpacked 不存在，跳过 */
        }
      } else {
        const off = 16 + jsonLen + Number(v.offset);
        const buf = Buffer.alloc(Number(v.size));
        fs.readSync(fd, buf, 0, buf.length, off);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, buf);
        files += 1;
        bytes += buf.length;
      }
    }
  };

  fs.mkdirSync(OUT, { recursive: true });
  writeNode(node, OUT, REL);
  console.log(`解出 ${files} 个文件 · ${bytes} B → ${OUT}`);
} finally {
  fs.closeSync(fd);
}
