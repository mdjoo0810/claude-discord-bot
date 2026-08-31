# claude-discord-bot

Discord에서 Claude Code 세션을 돌리는 봇. **스레드 하나 = Claude 세션 하나**로 매핑되고,
스레드 안에서 봇을 멘션하면 이전 대화 맥락을 그대로 이어서 작업합니다.

로컬 맥에 설치된 Claude Code 자격증명을 그대로 사용합니다 (별도 API 키 불필요).

```
#dev 채널에 메시지
   └─ 봇이 스레드 생성 → threadId ↔ Claude sessionId 매핑
        └─ 스레드에서 @봇 멘션 → resume 으로 맥락 유지하며 이어서 작업
             └─ 위험한 도구 호출은 Discord 버튼으로 승인
```

---

## 1. Discord 앱 만들기

1. https://discord.com/developers/applications → **New Application**
2. **Bot** 탭
   - **Reset Token** → 토큰 복사 (`DISCORD_TOKEN`)
   - **Privileged Gateway Intents** → **MESSAGE CONTENT INTENT 켜기** ← 필수
3. **General Information** → Application ID 복사 (`DISCORD_CLIENT_ID`)
4. 아래 URL의 `<CLIENT_ID>`를 바꿔서 서버에 초대

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=309237763072
```

권한 309237763072 = 채널 보기 · 메시지 보내기 · 스레드에서 메시지 보내기 ·
공개 스레드 만들기 · 메시지 기록 읽기 · 파일 첨부 · 링크 임베드

5. 본인의 Discord 유저 ID 확인 (설정 → 고급 → 개발자 모드 켜고 프로필 우클릭 → ID 복사)

---

## 2. 설정

```bash
cp .env.example .env
$EDITOR .env          # 최소한 DISCORD_TOKEN, DISCORD_CLIENT_ID, ALLOWED_USER_IDS 는 필수
npm run register      # 슬래시 커맨드 등록 (DISCORD_GUILD_ID 지정 시 즉시 반영)
npm run smoke         # 권한 정책·출력 로직 자체 점검
npm run dev           # 개발 중 실행
```

`ALLOWED_USER_IDS`가 비어 있으면 봇은 아무 요청도 받지 않고 시작 시 에러를 냅니다.
이 봇은 파일을 수정하고 셸을 실행하므로 의도적으로 fail-closed로 만들어 두었습니다.

---

## 3. 상주 실행 (launchd)

```bash
npm run service:install    # ~/Library/LaunchAgents 에 등록 + 즉시 시작
npm run service:logs       # 로그 보기
npm run service:uninstall  # 중지 및 해제
```

**로그인 세션(`gui/<uid>`)에 등록됩니다.** Claude Code 자격증명이 로그인 키체인에
들어 있어서, 사용자가 로그인한 상태여야 인증이 동작하기 때문입니다.

- 재부팅 후에는 **한 번 로그인해야** 봇이 다시 뜹니다 (자동 로그인을 켜두면 무인 운영 가능)
- 시스템 데몬(LaunchDaemon)으로 올리면 키체인 접근이 막혀 인증에 실패합니다
- 화면 잠금은 상관없습니다. 로그아웃만 피하면 됩니다

---

## 4. 사용법

### 세션 시작

| 방법 | 설명 |
|---|---|
| `/code project:dev-rtd task:...` | 프로젝트를 골라 새 스레드 시작 (자동완성 지원) |
| 지정 채널에 그냥 메시지 | `ALLOWED_CHANNEL_IDS`에 등록한 채널이면 멘션 없이도 스레드 생성 |
| `@봇 [dev-rtd] 작업 내용` | 아무 채널에서 멘션 + `[프로젝트]` 접두사 |

### 이어서 대화

스레드 안에서 **봇을 멘션**하면 같은 세션으로 이어집니다.
멘션 없이 반응하게 하려면 `REQUIRE_MENTION_IN_THREAD=false`.

### 커맨드

| 커맨드 | 설명 |
|---|---|
| `/code` | 새 세션 시작 |
| `/stop` | 실행 중인 작업 중단 |
| `/status` | 프로젝트·세션 ID·누적 비용·허용 규칙 확인 |
| `/auto enabled:true` | 이 스레드의 권한 승인을 전부 자동으로 (하드 차단은 유지) |
| `/code auto:true` | 처음부터 자동 승인으로 세션 시작 |
| `/reset` | 세션 초기화 — 대화 기억만 비움, 파일은 그대로 |
| `/rules` / `/rules clear:true` | "항상 허용" 규칙 조회/삭제 |
| `/projects` | 작업 가능한 프로젝트 목록 |

---

## 5. 권한 모델

도구 호출은 3단계로 처리됩니다.

| 단계 | 대상 | 동작 |
|---|---|---|
| **하드 차단** | `sudo`, `rm -rf /`, `curl \| sh`, `git push --force`, 디스크 포맷, `~/.ssh`·`~/.aws` 접근 | 무조건 거부. `/auto`를 켜도 통과하지 못함 |
| **자동 허용** | Read/Glob/Grep/TodoWrite/WebSearch, **프로젝트 디렉터리 안의** 파일 편집 | 확인 없이 실행 |
| **버튼 승인** | 모든 셸 명령, 프로젝트 밖 파일 수정, MCP·WebFetch 등 | Discord 버튼으로 허용/거부 |

### 승인을 줄이는 방법

승인 클릭이 잦다면 세 단계로 줄일 수 있습니다.

| 방법 | 범위 | 쓰임새 |
|---|---|---|
| **항상 허용** 버튼 | 그 스레드 · 그 명령 | 기본. `npm`, `git` 처럼 반복되는 명령을 누적 |
| `/code auto:true` | 그 스레드 전체 | 배포처럼 손이 많이 가는 작업을 시작할 때 |
| `AUTO_APPROVE_DEFAULT=true` | 모든 새 스레드 | 매번 켜기 번거로울 때. 되돌리려면 `/auto enabled:false` |

세 방법 모두 **하드 차단 목록은 우회하지 못합니다.**

승인 버튼은 4개입니다.

- **허용** — 이번 한 번만
- **항상 허용** — 이 스레드에 규칙 저장 (Bash는 `npm`, `git` 같은 명령어 단위)
  - `cd /x && npm test` 처럼 명령이 여러 개면 **전부** 저장되고, 다음부터는
    **모든 구성 명령이 허용된 경우에만** 통과합니다 (`cd` 하나로 뒷 명령이 통과하지 않음)
  - `MYSQL_PWD=... mysql ...` 같은 환경변수 접두사는 건너뛰고 실제 명령만 기억합니다
- **거부** — 이번 호출만 거부, 작업은 계속
- **거부하고 중단** — 거부 후 실행 전체 취소

`APPROVAL_TIMEOUT_MS`(기본 10분) 안에 응답이 없으면 자동 거부됩니다.
규칙은 SQLite에 저장되어 봇을 재시작해도 유지되며, `/rules clear:true`로 지웁니다.

---

## 6. 상태줄

각 진행/완료 메시지 하단에 현재 모델·컨텍스트·계정 사용량이 표시됩니다.

```
-# ◆ Opus 5(H) │ ████░░░░░░ │ 42% │ 417K/1.0M │ 5h: 8% (3h54m) │ 7d: 7% (4d18h)
```

| 항목 | 출처 |
|---|---|
| 모델·effort | `system.init` 메시지 + `CLAUDE_EFFORT` |
| 컨텍스트 % | assistant 메시지의 `usage` ÷ `modelUsage[].contextWindow` |
| 5h·7d 사용률 | `USAGE_COMMAND` (아래) |

Agent SDK의 `rate_limit_event`는 리셋 시각은 주지만 **사용률 %는 주지 않습니다.**
퍼센트를 보려면 이미 설치된 claude-dashboard를 연결하세요.

```bash
USAGE_COMMAND=node ~/.claude/plugins/marketplaces/claude-dashboard/dist/check-usage.js --json
```

미설정이면 `5h ⟳ 3h54m`처럼 리셋까지 남은 시간만 표시됩니다.
`STATUS_LINE=all`로 두면 모든 답변 메시지 하단에도 붙고, `off`면 표시하지 않습니다.

---

## 7. 구조

| 파일 | 역할 |
|---|---|
| `src/index.ts` | Discord 이벤트 배선, 스레드 생성, 종료 처리 |
| `src/commands.ts` | 슬래시 커맨드 정의·핸들러, 요청 디스패치 |
| `src/runner.ts` | Agent SDK `query()` 실행, 메시지 스트림 → Discord |
| `src/permissions.ts` | `canUseTool` → Discord 승인 버튼 |
| `src/policy.ts` | 허용/차단/승인필요 판정 |
| `src/presenter.ts` | 진행 메시지 편집, 2000자 청킹, 파일 첨부 |
| `src/meter.ts` | 상태줄 계산 |
| `src/usage.ts` | 외부 사용량 명령 연동 |
| `src/queue.ts` | 스레드별 직렬 실행 + 전역 동시 실행 제한 |
| `src/db.ts` | SQLite (스레드↔세션 매핑, 규칙, 실행 이력) |

동시성: 같은 스레드의 요청은 **순서대로 하나씩** 처리되고(세션 꼬임 방지),
서로 다른 스레드는 `MAX_CONCURRENT_RUNS`(기본 3)까지 동시에 실행됩니다.

---

## 8. 운영

```bash
tail -f logs/bot.out.log                       # 로그
sqlite3 data/bot.db 'SELECT * FROM threads;'   # 스레드↔세션 매핑
sqlite3 data/bot.db 'SELECT status, COUNT(*), ROUND(SUM(cost_usd),2) FROM runs GROUP BY status;'
```

Claude 세션 원본은 `~/.claude/projects/<인코딩된-cwd>/<session-id>.jsonl`에 있습니다.
`resume`은 **같은 `cwd`** 에서만 동작하므로, 프로젝트 디렉터리를 옮기면 기존 스레드의
세션은 이어지지 않습니다 (`/reset` 후 새로 시작하세요).

### 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 봇이 메시지에 반응 없음 | MESSAGE CONTENT INTENT, `ALLOWED_USER_IDS`에 내 ID |
| 스레드가 안 만들어짐 | 봇의 "공개 스레드 만들기" 권한 |
| 슬래시 커맨드 안 보임 | `npm run register`, 글로벌 등록은 반영에 최대 1시간 |
| 인증 오류 | 맥에 로그인되어 있는지 (키체인 잠금), 터미널에서 `claude` 동작 확인 |
| 재부팅 후 안 뜸 | 로그인 필요 — 자동 로그인 설정 검토 |

---

## 9. 보안 한계 (알고 쓰세요)

- **이 봇은 Discord 메시지를 코드 실행으로 바꿉니다.** `ALLOWED_USER_IDS`를 반드시
  본인(및 신뢰하는 사람)으로 제한하세요.
- 하드 차단 목록은 **명백한 사고를 막는 안전장치**지 샌드박스가 아닙니다.
  버튼 승인을 대충 누르면 무엇이든 실행될 수 있습니다.
- `/auto`는 그 스레드에서 셸 명령을 확인 없이 실행합니다. 신뢰하는 작업에만 쓰세요.
- Claude가 읽은 코드 내용이 Discord 메시지로 전송됩니다. 비공개 서버·비공개 채널에서만 쓰세요.
- 봇이 접근할 수 있는 범위는 `PROJECTS_ROOT` 하위로 제한되지만, 셸 명령은 그 밖으로도
  나갈 수 있습니다(승인 필요). 더 강한 격리가 필요하면 전용 사용자 계정이나 컨테이너를 쓰세요.
