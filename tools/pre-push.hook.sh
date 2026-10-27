#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# dsh-ledger-memory · 发布分级 pre-push 钩子（**受版本控制的模板**）
#
# ★ 为什么它在 tools/ 里而不是只躺在 .git/hooks/ 里（D315 · F-07①）：
#   `.git/hooks/*` **永远不会被 git 推送到任何远端** —— 所以从远端 clone 出来的人
#   （哪怕是作者自己换台机器）**根本拿不到这个钩子**，反向探针会在读它时直接 ENOENT 崩掉。
#   ⇒ 模板入库，由 `node tools/install-hooks.mjs` 安装到 `.git/hooks/`。
#
# ★ 它拦什么（用一句话）：**把提交推到公开仓库这件事，必须显式解锁**。
#   · 裸 `git push` 已经默认落私有库（`remote.pushDefault = private`）⇒ 常规路径不会出事；
#   · 万一手滑打了 `git push origin`，这里拦下；
#   · 确实要发版：`DSH_ALLOW_PUBLIC_PUSH=1 git push origin main`。
#   ★ 必须留解锁路 —— 只拦不放会把**正常发布**也堵死，那不是安全，那是坏掉。
# ═══════════════════════════════════════════════════════════════════════════

remote_name="$1"
remote_url="$2"

case "$remote_url" in
  *dsh-ledger-memory-private*)
    exit 0 ;;
  *github.com*18477514055/dsh-ledger-memory*)
    if [ "$DSH_ALLOW_PUBLIC_PUSH" = "1" ]; then
      echo "→ 已显式解锁（DSH_ALLOW_PUBLIC_PUSH=1）：允许推送公开仓库 $remote_name"
      exit 0
    fi
    echo ""
    echo "✗ 拦下了：这次要把提交推到**公开仓库**（$remote_name = $remote_url）"
    echo ""
    echo "  本项目的规矩是：改动先进私有仓库，审查通过后才上公开仓库。"
    echo "  公开仓库的 git 历史推上去就永久留在公网，force-push 也收不回来。"
    echo ""
    echo "  想推到私有仓库：  git push            （pushDefault 已经是 private）"
    echo "  确实要发公开库：  DSH_ALLOW_PUBLIC_PUSH=1 git push $remote_name <分支>"
    echo ""
    exit 1 ;;
esac

exit 0
