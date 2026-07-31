#!/bin/bash
# macOS launchd 에 봇을 상주 서비스로 등록합니다.
#   npm run service:install
#
# 로그인 세션(gui 도메인)에 등록하는 이유:
# Claude Code 자격증명이 로그인 키체인에 저장되어 있어서, 사용자가 로그인한
# GUI 세션에서 실행되어야 인증이 동작합니다. LaunchDaemon(시스템 도메인)으로
# 올리면 키체인에 접근하지 못해 인증에 실패합니다.
set -euo pipefail

LABEL="com.myeongdonjoo.claude-discord-bot"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "❌ .env 가 없습니다. cp .env.example .env 후 값을 채우세요." >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/logs" "$HOME/Library/LaunchAgents"

# nvm 을 명시적으로 로드한 뒤 node 를 실행합니다.
# zsh -l 은 .zprofile/.zlogin 만 읽고 .zshrc 는 읽지 않습니다(비대화형이라서).
# nvm 초기화가 .zshrc 에 있으므로 -lc 만으로는 launchd 의 빈 PATH 에서
# `command not found: node` 로 exit 127 이 납니다.
# nvm.sh 를 직접 source 하면 node 버전을 올려도 plist 를 다시 만들 필요가 없습니다.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>export NVM_DIR="\$HOME/.nvm"; [ -s "\$NVM_DIR/nvm.sh" ] &amp;&amp; . "\$NVM_DIR/nvm.sh"; cd "$PROJECT_DIR" &amp;&amp; exec node node_modules/tsx/dist/cli.mjs src/index.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <!-- 크래시 루프 방지: 재시작 사이 최소 간격(초) -->
  <key>ThrottleInterval</key>
  <integer>15</integer>

  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/logs/bot.out.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/logs/bot.err.log</string>

  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
PLIST_EOF

# 이미 등록되어 있으면 내렸다가 다시 올립니다.
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

echo "✅ 등록 완료: $LABEL"
echo "   상태 확인: launchctl print gui/$UID_NUM/$LABEL | head -20"
echo "   로그:      tail -f $PROJECT_DIR/logs/bot.out.log"
echo "   중지:      launchctl bootout gui/$UID_NUM/$LABEL"
