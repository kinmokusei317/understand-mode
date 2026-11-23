#!/usr/bin/env bash
# understand-mode（/understand スキル）をインストールする
#   bash install.sh          … Claude Code 用（~/.claude/skills/understand）
#   bash install.sh --codex  … Codex 用（~/.agents/skills/understand）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。Node 18 以上を入れてから、もう一度実行してください。" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "Node.js ${NODE_MAJOR} は古すぎます。18 以上にしてください。" >&2
  exit 1
fi

# 知らない引数は全部断る（打ち間違いが Claude 用の上書きに流れないように）
case "$#:${1-}" in
  0:|1:--codex) ;;
  *) printf 'Usage: bash install.sh [--codex]\n' >&2; exit 2;;
esac

if [ "${1:-}" = "--codex" ]; then
  # Codex 版：共有のアプリと pr-guide に、Codex 用の SKILL.md と agents 設定を重ねる。
  # すでに何かある場所には上書きしない（リンクも含む）。消したいときは自分で消してからやり直す。
  DEST="${HOME}/.agents/skills/understand"
  if [ -e "${DEST}" ] || [ -L "${DEST}" ]; then
    echo "${DEST} はすでにあります。上書きはしません。入れ直すなら、まず自分で取り除いてください。" >&2
    exit 1
  fi
  # -p を DEST には付けない。確認と作成のあいだに割り込まれても、上書きせずに失敗する
  mkdir -p "$(dirname "${DEST}")"
  mkdir "${DEST}"
  cp -R "${HERE}/skill/understand/app" "${DEST}/app"
  cp "${HERE}/skill/understand/pr-guide.md" "${DEST}/pr-guide.md"
  cp "${HERE}/skill/codex/understand/SKILL.md" "${DEST}/SKILL.md"
  cp -R "${HERE}/skill/codex/understand/agents" "${DEST}/agents"

  echo "インストールしました：${DEST}"
  echo "Codex で \$understand と打つと使えます（暗黙には起動しません）。"
  exit 0
fi

DEST="${HOME}/.claude/skills/understand"
mkdir -p "${HOME}/.claude/skills"
rm -rf "${DEST}"
cp -R "${HERE}/skill/understand" "${DEST}"

echo "インストールしました：${DEST}"
echo "Claude Code を開き直すと /understand が使えます。"
