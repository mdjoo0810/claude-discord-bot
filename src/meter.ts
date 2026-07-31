import { store } from './db.js';
import { log } from './log.js';
import { externalUsageWindows, refreshUsageIfStale } from './usage.js';

/**
 * 상태줄(status line) 데이터.
 *
 *   ◆ Opus 4.5(H) │ ████░░░░░░ │ 42% │ 417K/1.0M │ 5h: 4% (4h22m) │ 7d: 6% (4d18h)
 *
 * - 모델/effort: system.init 메시지 + 설정값
 * - 컨텍스트: assistant 메시지의 usage 합계 / modelUsage[].contextWindow
 * - 5h·7d 한도: rate_limit_event (claude.ai 구독 사용자 한정)
 */

export interface RateLimitSnapshot {
  type: string;
  /** SDK 가 utilization 을 보내지 않는 경우가 있어 선택 필드입니다. */
  percent?: number;
  resetsAt?: number;
  status?: string;
  at: number;
}

const RATE_LIMIT_META_KEY = 'rate_limits';

/** 한도 정보는 계정 단위이므로 프로세스 전역에 캐시하고 DB 에 남깁니다. */
const rateLimits = new Map<string, RateLimitSnapshot>();

(function restore() {
  try {
    const raw = store.getMeta(RATE_LIMIT_META_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as RateLimitSnapshot[];
    for (const entry of parsed) rateLimits.set(entry.type, entry);
  } catch (error) {
    log.debug('저장된 rate limit 복원 실패(무시)', error);
  }
})();

function persistRateLimits(): void {
  try {
    store.setMeta(RATE_LIMIT_META_KEY, JSON.stringify([...rateLimits.values()]));
  } catch (error) {
    log.debug('rate limit 저장 실패(무시)', error);
  }
}

export function recordRateLimit(info: {
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  status?: string;
}): void {
  if (!info.rateLimitType) return;
  const percent = toPercent(info.utilization);

  rateLimits.set(info.rateLimitType, {
    type: info.rateLimitType,
    ...(percent !== undefined ? { percent } : {}),
    ...(info.resetsAt !== undefined ? { resetsAt: normalizeEpochMs(info.resetsAt) } : {}),
    ...(info.status !== undefined ? { status: info.status } : {}),
    at: Date.now(),
  });
  persistRateLimits();
}

export function rateLimitSnapshots(): RateLimitSnapshot[] {
  return [...rateLimits.values()];
}

/** 모델별 컨텍스트 윈도 크기. modelUsage 를 받으면 실제 값으로 덮어씁니다. */
const contextWindowCache = new Map<string, number>();

const DEFAULT_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/haiku/i, 200_000],
  [/opus|sonnet|fable|mythos/i, 1_000_000],
];

function defaultContextWindow(model: string): number | undefined {
  for (const [re, size] of DEFAULT_CONTEXT_WINDOWS) if (re.test(model)) return size;
  return undefined;
}

export class SessionMeter {
  private model: string | undefined;
  private contextUsed = 0;
  private contextWindow = 0;

  constructor(private readonly effort: string) {}

  setModel(model: string): void {
    this.model = model;
    const known = contextWindowCache.get(model) ?? defaultContextWindow(model);
    if (known) this.contextWindow = known;
  }

  /** assistant 메시지의 usage 로 현재 컨텍스트 점유량을 갱신합니다. */
  recordUsage(usage: unknown): void {
    if (typeof usage !== 'object' || usage === null) return;
    const u = usage as Record<string, unknown>;
    const num = (key: string): number => (typeof u[key] === 'number' ? (u[key] as number) : 0);
    const total =
      num('input_tokens') + num('cache_read_input_tokens') + num('cache_creation_input_tokens');
    if (total > 0) this.contextUsed = total;
  }

  /** result 메시지의 modelUsage 로 실제 컨텍스트 윈도 크기를 학습합니다. */
  recordModelUsage(modelUsage: unknown): void {
    if (typeof modelUsage !== 'object' || modelUsage === null) return;
    for (const [model, value] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const window = (value as { contextWindow?: unknown }).contextWindow;
      if (typeof window === 'number' && window > 0) {
        contextWindowCache.set(model, window);
        if (model === this.model || !this.contextWindow) this.contextWindow = window;
      }
    }
  }

  /** Discord 하단에 붙일 한 줄. 표시할 정보가 없으면 빈 문자열. */
  render(): string {
    const segments: string[] = [];

    if (this.model) segments.push(`◆ ${shortModel(this.model)}(${effortLetter(this.effort)})`);

    if (this.contextUsed > 0 && this.contextWindow > 0) {
      const ratio = Math.min(1, this.contextUsed / this.contextWindow);
      segments.push(bar(ratio));
      segments.push(`${Math.round(ratio * 100)}%`);
      segments.push(`${compactTokens(this.contextUsed)}/${compactTokens(this.contextWindow)}`);
    }

    segments.push(...renderUsageSegments());

    if (segments.length === 0) return '';
    return `-# ${segments.join(' │ ')}`;
  }
}

// ── 렌더 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * 사용량 구간을 렌더링합니다.
 * USAGE_COMMAND 로 얻은 실제 퍼센트를 우선 사용하고, 없으면 SDK 의
 * rate_limit_event 로 리셋 시각만이라도 보여줍니다.
 */
function renderUsageSegments(): string[] {
  refreshUsageIfStale();

  const external = externalUsageWindows();
  if (external.length > 0) {
    return external.map(
      (w) => `${w.label}: ${w.percent}%${w.resetsAt ? ` (${remaining(w.resetsAt)})` : ''}`,
    );
  }

  return orderedRateLimits().map((s) => {
    const label = rateLimitLabel(s.type);
    if (s.percent !== undefined) {
      return `${label}: ${s.percent}%${s.resetsAt ? ` (${remaining(s.resetsAt)})` : ''}`;
    }
    // 퍼센트를 모를 때는 리셋까지 남은 시간만 표시합니다.
    return s.resetsAt ? `${label} ⟳ ${remaining(s.resetsAt)}` : '';
  }).filter(Boolean);
}

const RATE_LIMIT_ORDER = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
];

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d-O',
  seven_day_sonnet: '7d-S',
  seven_day_overage_included: '7d+',
  overage: 'OV',
};

function rateLimitLabel(type: string): string {
  return RATE_LIMIT_LABELS[type] ?? type;
}

function orderedRateLimits(): RateLimitSnapshot[] {
  return [...rateLimits.values()].sort(
    (a, b) => indexOrLast(a.type) - indexOrLast(b.type),
  );
}

function indexOrLast(type: string): number {
  const index = RATE_LIMIT_ORDER.indexOf(type);
  return index === -1 ? RATE_LIMIT_ORDER.length : index;
}

function bar(ratio: number, width = 10): string {
  const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function remaining(epochMs: number): string {
  const ms = epochMs - Date.now();
  if (ms <= 0) return '리셋됨';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  return `${minutes}m`;
}

function shortModel(model: string): string {
  const family = /opus/i.test(model)
    ? 'Opus'
    : /sonnet/i.test(model)
      ? 'Sonnet'
      : /haiku/i.test(model)
        ? 'Haiku'
        : /fable/i.test(model)
          ? 'Fable'
          : /mythos/i.test(model)
            ? 'Mythos'
            : model;

  // claude-opus-4-5-20251101 → 4.5 / claude-opus-5 → 5
  const version = /(?:opus|sonnet|haiku|fable|mythos)-(\d+(?:-\d+)?)/i.exec(model)?.[1];
  return version ? `${family} ${version.replace('-', '.')}` : family;
}

function effortLetter(effort: string): string {
  switch (effort) {
    case 'low':
      return 'L';
    case 'medium':
      return 'M';
    case 'high':
      return 'H';
    case 'xhigh':
      return 'XH';
    case 'max':
      return 'MAX';
    default:
      return effort.toUpperCase();
  }
}

/**
 * utilization 이 0~1 비율인지 0~100 퍼센트인지 문서상 명확하지 않아 둘 다 받습니다.
 * 1 이하이면 비율로 간주합니다(=100%). 한도 게이지는 과소 표기보다 과대 표기가 안전합니다.
 */
function toPercent(utilization: number | undefined): number | undefined {
  if (utilization === undefined || !Number.isFinite(utilization)) return undefined;
  const percent = utilization <= 1 ? utilization * 100 : utilization;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function normalizeEpochMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}
