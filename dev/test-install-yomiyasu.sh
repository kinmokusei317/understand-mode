#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/test-install-yomiyasu.XXXXXX")"
trap 'rm -rf "$root"' EXIT

for provider in claude codex; do
  profile=.claude
  if [ "$provider" = codex ]; then profile=.agents; fi
  install_in_home() {
    if [ "$provider" = codex ]; then
      env -i HOME="$home" PATH="$PATH" bash "$repo/install.sh" --codex
    else
      env -i HOME="$home" PATH="$PATH" bash "$repo/install.sh"
    fi
  }
  for fixture in fresh file directory symlink dangling refusal refusal-link; do
    home="$root/$provider-$fixture"
    skills="$home/$profile/skills"
    target="$skills/yomiyasu"
    mkdir -p "$skills"
    case "$fixture" in
      file) printf 'existing' > "$target" ;;
      directory) mkdir "$target"; printf 'existing' > "$target/SKILL.md" ;;
      symlink) mkdir "$home/custom"; ln -s "$home/custom" "$target" ;;
      dangling) ln -s "$home/missing" "$target" ;;
      refusal) mkdir "$skills/understand"; printf 'existing' > "$skills/understand/SKILL.md" ;;
      refusal-link) ln -s "$home/missing" "$skills/understand" ;;
    esac
    case "$fixture" in
      refusal*)
        before="$(find "$home" -print | sort)"
        if install_in_home; then exit 1; fi
        [ "$(find "$home" -print | sort)" = "$before" ]
        if [ "$fixture" = refusal ]; then
          [ "$(ls -A "$skills/understand")" = SKILL.md ]
          [ "$(cat "$skills/understand/SKILL.md")" = existing ]
        else
          [ "$(readlink "$skills/understand")" = "$home/missing" ]
        fi
        continue ;;
    esac
    install_in_home
    [ -f "$skills/understand/SKILL.md" ]
    case "$fixture" in
      fresh)
        g() { env -i HOME="$home" PATH="$PATH" GIT_CONFIG_NOSYSTEM=1 git -C "$home" "$@"; }
        g init -q --object-format=sha1
        g add --force "$profile/skills/yomiyasu"
        [ "$(g write-tree --prefix="$profile/skills/yomiyasu/")" = c0830fa9e902cac7477f9ec9130caba5ec049da2 ]
        [ ! -e "$skills/understand/app/public/vendor/yomiyasu/scripts" ]
        [ ! -e "$skills/understand/app/public/vendor/yomiyasu/assets" ] ;;
      file) [ "$(cat "$target")" = existing ] ;;
      directory) [ "$(ls -A "$target")" = SKILL.md ]; [ "$(cat "$target/SKILL.md")" = existing ] ;;
      symlink) [ "$(readlink "$target")" = "$home/custom" ]; [ -z "$(ls -A "$home/custom")" ] ;;
      dangling) [ "$(readlink "$target")" = "$home/missing" ]; [ ! -e "$home/missing" ] ;;
    esac
  done
done
echo 'OK: 両形式で標準スキルの全ファイルと実行権限が固定版に一致。既存のスキルとリンクを保持。'
