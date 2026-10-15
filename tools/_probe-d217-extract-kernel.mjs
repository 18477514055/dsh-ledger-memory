// D217 · 从活桌面端的 app.asar 里解出 **0.2.0-rc.2 的 dsh 内核**（只解 /dsh 子树）
// 目的：用它跑一次性 profile ⇒ dshOperations 的证据才与声明的键 0.2.0-rc.2 匹配。
// 用法：node tools/_probe-d217-extract-kernel.mjs <输出目录>
import fs from "node:fs";
import path from "node:path";

const ASAR = "C:/Users/24239/AppData/Local/Programs/DeepSeek Harness/resources/app.asar";
const OUT = process.argv[2];
if (!OUT) {
  console.error("用法：node tools/_probe-d217-extract-kernel.mjs <输出目录>");
  process.exit(2);
}

const fd = fs.openSync(ASAR, "r");
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // ★ 本项目记过的坑：JSON 长度在偏移 12，不在 8
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const tree = JSON.parse(jsonBuf.toString("utf8"));

  const root = tree.files?.["dsh"];
  if (!root) throw new Error("app.asar 里没有 /dsh 子树");

  let files = 0;
  let bytes = 0;
  let unpacked = 0;
  const UNPACKED_ROOT = `${ASAR}.unpacked`;
  const walk = (node, abs, rel) => {
    for (const [name, v] of Object.entries(node.files ?? {})) {
      const full = path.join(abs, name);
      const relFull = `${rel}/${name}`;
      if (v.files) {
        fs.mkdirSync(full, { recursive: true });
        walk(v, full, relFull);
      } else if (v.offset === undefined || v.size === undefined) {
        // ★ asar 的 "unpacked" 条目：内容不在 asar 里，在 <asar>.unpacked/<相对路径>
        const src = path.join(UNPACKED_ROOT, relFull);
        try {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.copyFileSync(src, full);
          unpacked += 1;
          bytes += fs.statSync(full).size;
        } catch {
          /* 有些 unpacked 文件可能不存在，跳过（内核未必需要） */
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
  walk(root, OUT, "dsh");
  console.log(`解出 ${files} 个内联 + ${unpacked} 个 unpacked · ${(bytes / 1048576).toFixed(1)} MB → ${OUT}`);

  const pj = path.join(OUT, "node_modules", "@deepseek-ai", "dsh", "package.json");
  const j = JSON.parse(fs.readFileSync(pj, "utf8"));
  console.log(`★ 内核：${j.name}@${j.version}   bin=${JSON.stringify(j.bin)}`);
} finally {
  fs.closeSync(fd);
}
