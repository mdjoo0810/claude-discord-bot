import path from 'node:path';
import os from 'node:os';
import { isInsideProject } from './projects.js';

export type Decision =
  | { action: 'allow'; reason: string }
  | { action: 'ask'; reason: string; rules: string[]; ruleLabel: string }
  | { action: 'deny'; reason: string };

export interface PolicyContext {
  projectDir: string;
  /** /auto 로 켠 스레드는 하드 차단을 제외한 모든 요청을 자동 승인합니다. */
  autoApprove: boolean;
  /** "항상 허용" 으로 이 스레드에 저장된 규칙들. */
  rules: Set<string>;
}

/** 승인 없이 항상 통과시키는 읽기 전용 도구. */
const SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoWrite',
  'WebSearch',
  'Task',
  'BashOutput',
  'ExitPlanMode',
  'AskUserQuestion',
]);

/** 프로젝트 안이면 자동 통과, 밖이면 승인이 필요한 쓰기 도구. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** 어떤 경우에도 실행하지 않는 셸 명령 패턴. */
const HARD_DENY: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-\w+\s+)*(-\w*[rf]\w*)\s+(\/|~|\$HOME)(\s|$)/, why: '루트/홈 디렉터리 재귀 삭제' },
  { re: /\bsudo\b/, why: 'sudo 권한 상승' },
  { re: /\b(shutdown|reboot|halt)\b/, why: '시스템 전원 제어' },
  { re: /\b(mkfs|diskutil\s+(erase|partition))/, why: '디스크 포맷' },
  { re: /\bdd\b[^|;]*\bof=\/dev\//, why: '블록 디바이스 직접 쓰기' },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: '원격 스크립트를 셸로 파이프' },
  { re: /\bchmod\s+(-R\s+)?777\s+\//, why: '루트 권한 전면 개방' },
  { re: /\bgit\s+push\b[^\n]*--force(?!-with-lease)/, why: 'force push (--force-with-lease 를 쓰세요)' },
  { re: /\bhistory\s+-c|\brm\s+[^\n]*\.bash_history/, why: '셸 기록 삭제' },
];

/** 프로젝트 밖이라도 절대 건드리면 안 되는 경로. */
const SENSITIVE_PATHS = [
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), 'Library', 'Keychains'),
];

function isSensitive(target: string): boolean {
  const abs = path.resolve(target);
  return SENSITIVE_PATHS.some((p) => abs === p || abs.startsWith(p + path.sep));
}

/** 명령 앞에 붙는 래퍼 — 실제로 실행되는 건 그 뒤쪽입니다. */
const COMMAND_PREFIXES = new Set(['env', 'command', 'exec', 'time', 'nohup', 'nice', 'builtin']);
/**
 * 이 키워드로 시작하는 구획은 조건절·반복 헤더라 실행 바이너리가 없습니다.
 * (`for f in *` 의 `f` 를 명령으로 오인하지 않도록 구획 전체를 건너뜁니다.)
 */
const CONTROL_HEADS = new Set(['if', 'elif', 'for', 'while', 'until', 'case', 'function', 'select']);
/** 구획 안에서 만나면 건너뛰는 키워드. 실제 명령은 그 뒤에 옵니다. */
const SHELL_KEYWORDS = new Set([
  'then', 'else', 'fi', 'do', 'done', 'esac', 'return',
  'in', 'set', 'unset', 'export', 'local', 'declare', 'readonly',
]);

/** VAR=value 형태의 환경변수 지정인지 판단합니다. 값에 비밀번호가 들어올 수 있습니다. */
function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** 한 구획(파이프·&& 로 나뉜 조각)에서 실제로 실행되는 바이너리 이름을 뽑습니다. */
function binaryOf(segment: string): string {
  const tokens = segment
    .trim()
    .replace(/^[({\s]+/, '')
    .split(/\s+/)
    .filter(Boolean);

  // 제어 구문 헤더는 통째로 건너뜁니다.
  const head = tokens[0]?.replace(/^["']|["']$/g, '');
  if (head && CONTROL_HEADS.has(head)) return '';

  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (!token) continue;
    // VAR=value 는 건너뜁니다. 예전에는 이걸 이름으로 써서 비밀번호가
    // 규칙에 그대로 저장되고, 값이 매번 달라 규칙이 재사용되지 않았습니다.
    if (isEnvAssignment(token)) continue;
    if (COMMAND_PREFIXES.has(token)) continue;
    if (SHELL_KEYWORDS.has(token)) continue;
    if (token.startsWith('-')) continue;

    // 경로는 유지하되(./deploy.sh 와 deploy.sh 를 구분), 셸 메타문자는 제거합니다.
    const name = token.replace(/[^\w.\-/]/g, '');
    if (!name || /^\d+$/.test(name)) continue;
    return name;
  }
  return '';
}

/**
 * 명령에 등장하는 모든 바이너리를 반환합니다.
 *
 * `cd /x && rm -rf /y` 처럼 여러 명령이 이어진 경우 앞의 것만 보면
 * `cd` 승인 하나로 뒤의 임의 명령까지 통과합니다. 그래서 전부 확인합니다.
 */
export function commandBinaries(command: string): string[] {
  const segments = command.split(/\|\||&&|[;|\n]|\$\(|`/);
  const names = segments.map(binaryOf).filter(Boolean);
  return [...new Set(names)];
}

function targetPath(toolName: string, input: Record<string, unknown>): string | undefined {
  const candidates = ['file_path', 'notebook_path', 'path', 'filePath'];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  if (toolName === 'Bash') return undefined;
  return undefined;
}

export function decide(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PolicyContext,
): Decision {
  // 1. 하드 차단 — autoApprove 여도 통과하지 못합니다.
  if (toolName === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    for (const { re, why } of HARD_DENY) {
      if (re.test(command)) {
        return { action: 'deny', reason: `정책상 차단된 명령입니다 (${why}).` };
      }
    }
  }

  const target = targetPath(toolName, input);
  if (target && isSensitive(target)) {
    return { action: 'deny', reason: '민감한 경로(.ssh/.aws/.gnupg/Keychains)에는 접근할 수 없습니다.' };
  }

  // 2. 스레드가 전체 자동 승인 모드인 경우.
  if (ctx.autoApprove) {
    return { action: 'allow', reason: '스레드 자동 승인(/auto on)' };
  }

  // 3. 읽기 전용 도구.
  if (SAFE_TOOLS.has(toolName)) {
    return { action: 'allow', reason: '읽기 전용 도구' };
  }

  // 4. 프로젝트 내부 파일 편집.
  if (WRITE_TOOLS.has(toolName)) {
    if (target && isInsideProject(ctx.projectDir, target)) {
      return { action: 'allow', reason: '프로젝트 내부 파일 편집' };
    }
    return {
      action: 'ask',
      reason: '프로젝트 디렉터리 밖의 파일을 수정하려고 합니다.',
      rules: [`${toolName}:outside`],
      ruleLabel: `이 스레드에서 ${toolName} 의 프로젝트 밖 수정 허용`,
    };
  }

  // 5. 셸 명령 — 명령어 단위로 기억하되, 한 줄에 여러 명령이 있으면 전부 확인합니다.
  if (toolName === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    const binaries = commandBinaries(command);

    if (binaries.length > 0 && binaries.every((bin) => ctx.rules.has(`Bash:${bin}`))) {
      return { action: 'allow', reason: `이 스레드에서 \`${binaries.join('`, `')}\` 허용됨` };
    }

    // 승인 시 저장할 규칙은 아직 허용되지 않은 것들입니다.
    const pending = binaries.filter((bin) => !ctx.rules.has(`Bash:${bin}`));
    return {
      action: 'ask',
      reason: '셸 명령 실행',
      rules: pending.map((bin) => `Bash:${bin}`),
      ruleLabel: pending.length
        ? `이 스레드에서 \`${pending.join('`, `')}\` 항상 허용`
        : '이 스레드에서 항상 허용',
    };
  }

  // 6. 그 외(MCP 도구, WebFetch 등) — 도구 단위로 기억합니다.
  if (ctx.rules.has(`Tool:${toolName}`)) {
    return { action: 'allow', reason: `이 스레드에서 ${toolName} 허용됨` };
  }
  return {
    action: 'ask',
    reason: '사전 승인되지 않은 도구',
    rules: [`Tool:${toolName}`],
    ruleLabel: `이 스레드에서 ${toolName} 항상 허용`,
  };
}

/** 프로젝트 밖 쓰기 규칙이 저장돼 있으면 4번 단계에서도 통과시킵니다. */
export function ruleAllows(rules: Set<string>, decision: Decision): boolean {
  return (
    decision.action === 'ask' &&
    decision.rules.length > 0 &&
    decision.rules.every((rule) => rules.has(rule))
  );
}
