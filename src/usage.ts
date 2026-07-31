import { execFile } from 'node:child_process';
import { config } from './config.js';
import { log } from './log.js';

/**
 * 외부 명령으로 계정 사용량(5h / 7d %)을 가져옵니다.
 *
 * Agent SDK 의 `rate_limit_event` 는 상태와 리셋 시각은 주지만
 * `utilization`(사용률 %)이 항상 오지는 않습니다. 그래서 퍼센트가 필요하면
 * 이미 설치된 도구(예: claude-dashboard 의 check-usage --json)를 붙입니다.
 *
 *   USAGE_COMMAND="node ~/.claude/plugins/marketplaces/claude-dashboard/dist/check-usage.js --json"
 *
 * 명령은 JSON 을 stdout 으로 출력해야 하며, 아래 두 형태를 인식합니다.
 *
 *   claude-dashboard 형태:
 *     { "claude": { "fiveHourPercent": 8, "sevenDayPercent": 7,
 *                   "fiveHourReset": "...", "sevenDayReset": "..." } }
 *
 *   일반 형태:
 *     { "windows": [ { "label": "5h", "percent": 8, "resetsAt": "..." } ] }
 */

export interface UsageWindow {
  label: string;
  percent: number;
  resetsAt?: number;
}

let cached: UsageWindow[] = [];
let fetchedAt = 0;
let inFlight: Promise<void> | undefined;

export function externalUsageWindows(): UsageWindow[] {
  return cached;
}

/** 캐시가 오래됐으면 백그라운드로 갱신합니다. 호출자를 블로킹하지 않습니다. */
export function refreshUsageIfStale(): void {
  if (!config.usage.command) return;
  if (inFlight) return;
  if (Date.now() - fetchedAt < config.usage.cacheSeconds * 1000) return;
  inFlight = runProbe().finally(() => {
    inFlight = undefined;
  });
}

async function runProbe(): Promise<void> {
  const command = config.usage.command;
  if (!command) return;

  try {
    const stdout = await execShell(command, config.usage.timeoutMs);
    const parsed = parseUsage(stdout);
    if (parsed.length > 0) {
      cached = parsed;
      log.debug(`사용량 갱신: ${parsed.map((w) => `${w.label} ${w.percent}%`).join(', ')}`);
    }
    fetchedAt = Date.now();
  } catch (error) {
    // 실패해도 상태줄만 비워질 뿐 실행에는 영향이 없습니다.
    fetchedAt = Date.now();
    log.debug('USAGE_COMMAND 실행 실패(무시)', error);
  }
}

function execShell(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.env['SHELL'] ?? '/bin/sh',
      ['-c', command],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export function parseUsage(stdout: string): UsageWindow[] {
  const json = extractJson(stdout);
  if (!json) return [];

  // 1) claude-dashboard 형태
  const claude = (json as { claude?: Record<string, unknown> }).claude;
  if (claude && typeof claude === 'object') {
    const windows: UsageWindow[] = [];
    const push = (label: string, percentKey: string, resetKey: string) => {
      const percent = claude[percentKey];
      if (typeof percent !== 'number') return;
      const reset = toEpochMs(claude[resetKey]);
      windows.push({ label, percent: Math.round(percent), ...(reset ? { resetsAt: reset } : {}) });
    };
    push('5h', 'fiveHourPercent', 'fiveHourReset');
    push('7d', 'sevenDayPercent', 'sevenDayReset');
    push('7d-S', 'sevenDaySonnetPercent', 'sevenDaySonnetReset');
    push('7d-F', 'sevenDayFablePercent', 'sevenDayFableReset');
    if (windows.length > 0) return windows;
  }

  // 2) 일반 형태
  const list = (json as { windows?: unknown }).windows;
  if (Array.isArray(list)) {
    return list
      .filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
      .map((w) => {
        const percent = typeof w['percent'] === 'number' ? Math.round(w['percent'] as number) : undefined;
        if (percent === undefined) return undefined;
        const reset = toEpochMs(w['resetsAt']);
        return {
          label: String(w['label'] ?? '?'),
          percent,
          ...(reset ? { resetsAt: reset } : {}),
        } satisfies UsageWindow;
      })
      .filter((w): w is UsageWindow => w !== undefined);
  }

  return [];
}

/** 명령이 로그를 함께 출력해도 JSON 부분만 뽑아냅니다. */
function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
