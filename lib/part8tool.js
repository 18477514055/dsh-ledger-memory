import { createExtension, deleteExtension, listExtensions, readExtension, updateExtension, writeExtension, EXT_MODE_KEYS, EXT_MODES } from "./part8.js";
import { OK_SCHEMA, ROOT_PARAM } from "./defs.js";
import { renderResult, rootFromExec } from "./part3.js";

/**
 * ★★★★★ 2026-10-21（D299 · V3 阶段 4）：`ledger_extension` —— 自定义扩展记忆的工具入口。
 *
 * ★ 为什么**一个**工具而不是六个：扩展的增删改查读写**必须一起被看到** ——
 *   模型只有在"知道有哪些 op"时才会去用 `list`，而它一旦 `list` 就会看到
 *   "原来还能 write"。★ 与 D199 把 `split` 挂在 `ledger_migrate` 上同一条理由。
 *
 * ★★★ 工具**不负责权限判断**：原则型不许写、流水型只许追加、越界不许碰 —— 全部在
 *   `part8.js` 的三个函数里。这里只做**参数转交**。
 *   理由：工具 schema 会变，判据不能跟着变（D292：判据要在语义层，不在调用层）。
 */

const OP_DESC =
  "list = 列出本项目全部扩展记忆（含存储位置与是否有内容）。" +
  " read = 读一个扩展（卡片型不给 key ⇒ 列卡片；给了 ⇒ 读那一张；单文件型 ⇒ 返回正文）。" +
  " write = 写一个扩展（卡片型必须给 key；流水型必须 append:true）。" +
  " create = 新建（用户也可在设置面板建；模型建时必须说明用途）。" +
  " update = 改说明 / 注入开关（**模式不可改**）。" +
  " delete = 删除（**有内容时必须 confirm:true**）。";

export function defineExtensionTool(state) {
  void state;
  return {
    name: "ledger_extension",
    description:
      "Read and write this project's CUSTOM EXTENSION MEMORIES (a Generation-3 / 1.5.0 feature). " +
      "An extension is an EXTRA memory unit the user defined for this project only — it is NOT a " +
      "replacement for the core memories (LEDGER / decisions / journal / goals / lessons / principles), " +
      "and using one never changes how those behave. Each extension declares a description (what it is " +
      "for) and a mode that decides its storage and rules (card-per-file vs single file; append-only). " +
      "Start with op:\"list\" to see what this project actually has, then read or write by id. " +
      "★ Extensions are per-project: one project's extensions never apply to another.",
    parameters: {
      type: "object",
      properties: {
        root: ROOT_PARAM,
        op: {
          type: "string",
          enum: ["list", "read", "write", "create", "update", "delete"],
          description: OP_DESC,
        },
        id: {
          type: "string",
          description: "Extension id（`list` 会给出）。read/write/update/delete 必填。",
        },
        key: {
          type: "string",
          description:
            "**卡片型**扩展的卡片键（如 `D1` / `L2`），也是文件名。卡片型 write 必填；read 可选（不给就列卡片）。",
        },
        content: {
          type: "string",
          description:
            "write 的内容。整份模式 = 新全文；流水型（append:true）= **要追加的那一段**。",
        },
        append: {
          type: "boolean",
          description:
            "write 时是否追加。★ 流水记录型**必须** true；其余模式**必须**不传（传了会被拒）。",
        },
        name: {
          type: "string",
          description: "create / update：记忆名称（如「Boss机制记录」）。",
        },
        description: {
          type: "string",
          description: "create / update：用途说明 —— 模型靠它判断该不该用这个扩展。",
        },
        mode: {
          type: "string",
          enum: EXT_MODE_KEYS,
          description:
            "create：记忆模式。" +
            EXT_MODE_KEYS.map((k) => `${k}=${EXT_MODES[k].label}`).join(" · ") +
            "。★ 建好之后**不可修改**（换模式 = 删了重建）。",
        },
        inject: {
          type: "boolean",
          description:
            "create / update：是否每回合把内容摘要注入上下文。★ 只影响注入方式，不影响是否保存。默认 false。",
        },
        confirm: {
          type: "boolean",
          description: "delete：扩展里已有内容时必须显式传 true，否则拒绝。",
        },
      },
      additionalProperties: false,
    },
    output: { schema: OK_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const root = rootFromExec(exec, args);
      const op = typeof args?.op === "string" ? args.op : "";

      // ★ 先取 info：所有函数都要它来决定 memoryBase（V3 下扩展住在记忆目录里）。
      //   ⚠️ 这里刻意**不 import inspect**：`part8` 里每个函数都会自己 inspect，
      //     在这里再取一次就成了第二个出处。传 root 即可。
      switch (op) {
        case "list":
          return listExtensions(null, root);

        case "read": {
          if (typeof args?.id !== "string" || args.id === "") {
            return { ok: false, reason: "`read` 需要 `id`（先用 op:\"list\" 看有哪些）。" };
          }
          return readExtension(null, root, args.id, {
            key: typeof args?.key === "string" ? args.key : undefined,
            limit: 8000,
          });
        }

        case "write": {
          if (typeof args?.id !== "string" || args.id === "") {
            return { ok: false, reason: "`write` 需要 `id`。" };
          }
          return writeExtension(null, root, args.id, {
            key: typeof args?.key === "string" ? args.key : undefined,
            content: typeof args?.content === "string" ? args.content : "",
            append: args?.append === true,
          });
        }

        case "create":
          return createExtension(null, root, {
            name: args?.name,
            description: args?.description,
            mode: args?.mode,
            inject: args?.inject === true,
          });

        case "update": {
          if (typeof args?.id !== "string" || args.id === "") {
            return { ok: false, reason: "`update` 需要 `id`。" };
          }
          return updateExtension(null, root, args.id, {
            name: args?.name,
            description: args?.description,
            inject: args?.inject,
            mode: args?.mode,
          });
        }

        case "delete": {
          if (typeof args?.id !== "string" || args.id === "") {
            return { ok: false, reason: "`delete` 需要 `id`。" };
          }
          return deleteExtension(null, root, args.id, { confirm: args?.confirm === true });
        }

        default:
          return {
            ok: false,
            reason: `未知 op：${op === "" ? "（空）" : op}。可用：list / read / write / create / update / delete。`,
          };
      }
    },
  };
}
