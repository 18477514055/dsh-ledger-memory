// ═══════════════════════════════════════════════════════════════════════════
// D216 · 真正可靠的**词法器式**引用分析（替换正则版）
// ═══════════════════════════════════════════════════════════════════════════
//
// ★★★ 为什么必须换成逐字符状态机（我连栽三次，全是同一个根因）：
//   用**正则**剥注释/字符串，遇到**转义引号**就会配对错位 ——
//   实测那处代码是：`"...used \\\"journal\\\" ..." +` / 下一行 `CHECKPOINT_TOOL +`
//   正则把 `\\\"` 当成"字符串结束"⇒ 后半行被当成代码、或整行被当成字符串 ⇒
//   **`CHECKPOINT_TOOL` 被吃掉** ⇒ 校验器报"✅"而运行时 `ReferenceError`。
//   ⇒ 这与纪律 4（**剥离用的标记本身绝不能出现在被剥离的内容里**）同型，
//     但根因更深：**用正则做词法分析本身就是错的**（正则无记忆，处理不了嵌套/转义状态）。
//
// ⇒ 正解：**逐字符状态机**，状态 = { 代码, 行注释, 块注释, 单引号, 双引号, 模板 }，
//   正确处理 `\\` 转义；模板里**保留 `${…}` 的表达式**（那里是真的代码）。
//
// 导出：tokenizeRefs(text) → 只含**真实代码**的字符串（注释与字符串字面已剔除/占位）
//       —— 供"找引用"与"找定义"共用**同一把尺子**。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把源码变成"只有真实代码"的文本：
 *   · 注释 → 空格
 *   · 字符串字面量 → `""`（占位，保持不跨行）
 *   · 模板的**字面部分** → `T`；`${…}` 里的**表达式**原样保留（那是真代码）
 * ★ 不改变换行结构（保持行号可对齐）。
 */
export function codeOnly(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  // 上一个**非空白且有意义的**字符，用来判断 `/` 是除号还是正则
  let prevSig = "";
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    // 行注释
    if (c === "/" && c2 === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    // 块注释
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      out += " ";
      continue;
    }
    // 正则字面量（判据：`/` 前面是运算符/开括号等，绝不是标识符或 `)`/`]`）
    if (c === "/" && /[=(,:[!&|?{};+\-*%<>~^]/.test(prevSig)) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const d = text[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          i += 1;
          break;
        } else if (d === "\n") break;
        i += 1;
      }
      out += " R ";
      prevSig = "R";
      continue;
    }
    // 字符串（单/双引号）—— 处理 `\` 转义
    if (c === '"' || c === "'") {
      const q = c;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === q) {
          i += 1;
          break;
        }
        if (text[i] === "\n") break; // 未闭合（容错）
        i += 1;
      }
      out += '""';
      prevSig = '"';
      continue;
    }
    // 模板字符串：字面 → T；`${…}` 里的表达式**原样保留并递归剥离**
    if (c === "`") {
      i += 1;
      out += " T ";
      while (i < n) {
        const d = text[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "`") {
          i += 1;
          break;
        }
        if (d === "$" && text[i + 1] === "{") {
          // 找到配对的 `}`（要计嵌套花括号、并跳过其中的字符串）
          let j = i + 2;
          let depth = 1;
          while (j < n && depth > 0) {
            const e = text[j];
            if (e === "\\") {
              j += 2;
              continue;
            }
            if (e === '"' || e === "'" || e === "`") {
              const q = e;
              j += 1;
              while (j < n) {
                if (text[j] === "\\") {
                  j += 2;
                  continue;
                }
                if (text[j] === q) {
                  j += 1;
                  break;
                }
                j += 1;
              }
              continue;
            }
            if (e === "{") depth += 1;
            else if (e === "}") depth -= 1;
            j += 1;
          }
          const expr = text.slice(i + 2, depth === 0 ? j - 1 : j);
          out += " " + codeOnly(expr) + " ";
          i = j;
          continue;
        }
        if (d === "\n") out += "\n";
        i += 1;
      }
      prevSig = "`";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i += 1;
  }
  return out;
}

/** 在某段代码里找"哪些顶层名被引用了"（`...` 展开先换成空格，避免被误判成属性访问）。 */
export function refsIn(text, names, self) {
  const code = codeOnly(text).replace(/\.\.\./g, " ");
  const out = [];
  for (const n of names) {
    if (n === self) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`).test(code)) out.push(n);
  }
  return out;
}
