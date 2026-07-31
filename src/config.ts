import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`환경변수 ${name} 가 비어 있습니다. .env 를 확인하세요.`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function idList(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function int(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`환경변수 ${name} 는 정수여야 합니다 (받은 값: ${raw})`);
  }
  return parsed;
}

function float(name: string): number | undefined {
  const raw = optional(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`환경변수 ${name} 는 숫자여야 합니다 (받은 값: ${raw})`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

const STATUS_LINE_MODES = ['status', 'all', 'off'] as const;
export type StatusLineMode = (typeof STATUS_LINE_MODES)[number];

function statusLineMode(): StatusLineMode {
  const raw = (optional('STATUS_LINE') ?? 'status') as StatusLineMode;
  if (!STATUS_LINE_MODES.includes(raw)) {
    throw new Error(`STATUS_LINE 은 ${STATUS_LINE_MODES.join(' | ')} 중 하나여야 합니다.`);
  }
  return raw;
}

function effort(): Effort {
  const raw = (optional('CLAUDE_EFFORT') ?? 'high') as Effort;
  if (!EFFORT_LEVELS.includes(raw)) {
    throw new Error(`CLAUDE_EFFORT 는 ${EFFORT_LEVELS.join(' | ')} 중 하나여야 합니다.`);
  }
  return raw;
}

export const config = {
  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    guildId: optional('DISCORD_GUILD_ID'),
  },
  access: {
    /** 비어 있으면 아무도 사용할 수 없습니다 (fail-closed). */
    userIds: idList('ALLOWED_USER_IDS'),
    /** 비어 있으면 봇이 보이는 모든 채널에서 새 세션을 시작할 수 있습니다. */
    channelIds: idList('ALLOWED_CHANNEL_IDS'),
  },
  projectsRoot: path.resolve(optional('PROJECTS_ROOT') ?? path.join(os.homedir(), 'dev')),
  defaultProject: optional('DEFAULT_PROJECT'),
  claude: {
    model: optional('CLAUDE_MODEL'),
    effort: effort(),
    maxTurns: int('MAX_TURNS', 200),
    maxBudgetUsd: float('MAX_BUDGET_USD'),
  },
  usage: {
    /** 5h/7d 사용률 %를 JSON 으로 출력하는 외부 명령 (선택). 비우면 상태줄에서 생략됩니다. */
    command: optional('USAGE_COMMAND'),
    cacheSeconds: int('USAGE_CACHE_SECONDS', 120),
    timeoutMs: int('USAGE_TIMEOUT_MS', 8000),
  },
  runtime: {
    maxConcurrentRuns: int('MAX_CONCURRENT_RUNS', 3),
    approvalTimeoutMs: int('APPROVAL_TIMEOUT_MS', 10 * 60 * 1000),
    requireMentionInThread: bool('REQUIRE_MENTION_IN_THREAD', true),
    /** status: 진행/완료 메시지에만 · all: 모든 답변 메시지 하단에도 · off: 표시 안 함 */
    statusLine: statusLineMode(),
    dbPath: path.resolve(optional('DB_PATH') ?? './data/bot.db'),
    logLevel: (optional('LOG_LEVEL') ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  },
} as const;

export function assertConfigSane(): void {
  if (config.access.userIds.size === 0) {
    throw new Error(
      'ALLOWED_USER_IDS 가 비어 있습니다. 이 봇은 파일 수정과 셸 실행이 가능하므로 ' +
        '허용 유저를 반드시 지정해야 합니다.',
    );
  }
}
