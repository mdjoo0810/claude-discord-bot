export const DISCORD_MESSAGE_LIMIT = 2000;
const CHUNK_LIMIT = 1900; // 여유분 확보

/**
 * 긴 텍스트를 Discord 메시지 길이에 맞게 쪼갭니다.
 * 코드 펜스(```) 안에서 잘릴 경우 펜스를 닫고 다음 조각에서 다시 엽니다.
 */
export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  let fenceLang: string | null = null; // null 이면 펜스 밖

  const flush = () => {
    if (!current) return;
    chunks.push(fenceLang !== null ? `${current}\n\`\`\`` : current);
    current = fenceLang !== null ? `\`\`\`${fenceLang}` : '';
  };

  for (const rawLine of lines) {
    // 한 줄이 통째로 한계를 넘으면 강제로 자릅니다.
    const pieces = rawLine.length > limit - 20 ? hardSplit(rawLine, limit - 20) : [rawLine];

    for (const line of pieces) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length + (fenceLang !== null ? 4 : 0) > limit) {
        flush();
        current = current ? `${current}\n${line}` : line;
      } else {
        current = candidate;
      }

      const fenceMatch = /^```(\w*)/.exec(line.trim());
      if (fenceMatch) {
        fenceLang = fenceLang === null ? (fenceMatch[1] ?? '') : null;
      }
    }
  }

  if (current.trim()) chunks.push(fenceLang !== null ? `${current}\n\`\`\`` : current);
  return chunks.filter((c) => c.trim().length > 0);
}

function hardSplit(line: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
  return out;
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 ${minutes % 60}분`;
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined || Number.isNaN(usd)) return '-';
  return `$${usd.toFixed(4)}`;
}

const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Glob: '🔍',
  Grep: '🔍',
  Edit: '✏️',
  MultiEdit: '✏️',
  Write: '📝',
  NotebookEdit: '📓',
  NotebookRead: '📓',
  Bash: '💻',
  BashOutput: '💻',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Task: '🤖',
  TodoWrite: '📋',
  Skill: '🧩',
  SlashCommand: '⚡',
};

export function toolIcon(name: string): string {
  if (name.startsWith('mcp__')) return '🔌';
  return TOOL_ICONS[name] ?? '🔧';
}

/** 툴 호출을 한 줄로 요약합니다. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const icon = toolIcon(name);
  const str = (key: string): string | undefined =>
    typeof input[key] === 'string' ? (input[key] as string) : undefined;

  switch (name) {
    case 'Bash': {
      const cmd = str('command') ?? '';
      return `${icon} \`${truncate(cmd, 120)}\``;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'NotebookRead': {
      const p = str('file_path') ?? str('notebook_path') ?? '';
      return `${icon} ${name} \`${shortenPath(p)}\``;
    }
    case 'Glob':
      return `${icon} Glob \`${truncate(str('pattern') ?? '', 80)}\``;
    case 'Grep':
      return `${icon} Grep \`${truncate(str('pattern') ?? '', 80)}\``;
    case 'WebFetch':
      return `${icon} Fetch ${truncate(str('url') ?? '', 100)}`;
    case 'WebSearch':
      return `${icon} Search \`${truncate(str('query') ?? '', 80)}\``;
    case 'Task':
      return `${icon} 서브에이전트: ${truncate(str('description') ?? str('subagent_type') ?? '', 80)}`;
    case 'TodoWrite':
      return `${icon} 할 일 목록 갱신`;
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return `${icon} ${name}${first ? ` \`${truncate(first, 80)}\`` : ''}`;
    }
  }
}

/** 홈 디렉터리를 ~ 로 줄이고 너무 길면 앞을 생략합니다. */
export function shortenPath(p: string, max = 60): string {
  const home = process.env['HOME'] ?? '';
  let out = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  if (out.length > max) out = `…${out.slice(out.length - max + 1)}`;
  return out;
}

/** Discord 마크다운에서 의미를 갖는 문자를 이스케이프합니다. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([*_`~|\\])/g, '\\$1');
}
