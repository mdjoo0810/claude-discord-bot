import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadChannel } from 'discord.js';
import { config } from './config.js';
import { store, type ThreadRecord } from './db.js';
import { log } from './log.js';
import { recordRateLimit, SessionMeter } from './meter.js';
import { createCanUseTool } from './permissions.js';
import { Presenter } from './presenter.js';

const SYSTEM_APPEND = `
당신은 Discord 스레드를 통해 조작되고 있습니다. 다음을 지켜주세요.

- 출력은 Discord 메시지로 렌더링됩니다. 터미널 색상/커서 제어 문자를 쓰지 마세요.
- 코드와 diff 는 코드 블록으로 감싸고, 언어를 명시하세요.
- 답변은 간결하게. 사용자는 모바일에서 볼 수도 있습니다.
- 사용자에게 확인이 필요하면 질문을 남기고 턴을 끝내세요. 사용자가 같은 스레드에 답장하면 대화가 이어집니다.
- 대화형 입력이 필요한 명령(예: vim, 대화형 프롬프트)은 실행하지 마세요. 비대화형 플래그를 사용하세요.
- 장시간 실행되는 서버 프로세스는 포그라운드로 띄우지 마세요.
`.trim();

interface ActiveRun {
  abort: AbortController;
  presenter: Presenter;
  startedAt: number;
  userId: string;
}

const activeRuns = new Map<string, ActiveRun>();

export function isRunning(threadId: string): boolean {
  return activeRuns.has(threadId);
}

/** 실행 중인 턴을 중단합니다. 실행 중이 아니면 false. */
export function stopRun(threadId: string): boolean {
  const run = activeRuns.get(threadId);
  if (!run) return false;
  run.abort.abort();
  return true;
}

export function stopAllRuns(): void {
  for (const run of activeRuns.values()) run.abort.abort();
}

export interface RunParams {
  thread: ThreadChannel;
  record: ThreadRecord;
  prompt: string;
  userId: string;
}

export async function runTurn({ thread, record, prompt, userId }: RunParams): Promise<void> {
  const abort = new AbortController();
  const meter = new SessionMeter(config.claude.effort);
  if (config.claude.model) meter.setModel(config.claude.model);
  const presenter = new Presenter(thread, { project: record.project, meter });
  await presenter.start();

  const startedAt = Date.now();
  activeRuns.set(record.thread_id, { abort, presenter, startedAt, userId });
  const runId = store.startRun(record.thread_id, userId, prompt);

  const rules = store.listRules(record.thread_id);
  let sessionId = record.session_id ?? undefined;
  let turns = 0;
  let costUsd: number | undefined;
  let finalText = '';
  let errorText: string | undefined;
  let sawResult = false;

  const canUseTool = createCanUseTool({
    thread,
    threadId: record.thread_id,
    projectDir: record.cwd,
    presenter,
    isAutoApprove: () => store.getThread(record.thread_id)?.auto_approve === 1,
    rules,
    requestStop: () => abort.abort(),
    signal: abort.signal,
  });

  const options: Options = {
    cwd: record.cwd,
    abortController: abort,
    canUseTool,
    permissionMode: 'default',
    // 프로젝트의 CLAUDE.md / .claude/settings.json 을 그대로 사용합니다.
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
    effort: config.claude.effort,
    maxTurns: config.claude.maxTurns,
    includePartialMessages: false,
    stderr: (data) => log.debug(`[claude stderr] ${data.trimEnd()}`),
    ...(sessionId ? { resume: sessionId } : {}),
    ...(config.claude.model ? { model: config.claude.model } : {}),
    ...(config.claude.maxBudgetUsd !== undefined ? { maxBudgetUsd: config.claude.maxBudgetUsd } : {}),
  };

  try {
    for await (const message of query({ prompt, options })) {
      if (abort.signal.aborted) break;

      switch (message.type) {
        case 'rate_limit_event': {
          recordRateLimit((message as { rate_limit_info?: Record<string, unknown> }).rate_limit_info ?? {});
          break;
        }

        case 'system': {
          const subtype = (message as { subtype?: string }).subtype;
          if (subtype === 'init') {
            const id = (message as { session_id?: string }).session_id;
            if (id && id !== sessionId) {
              sessionId = id;
              store.setSessionId(record.thread_id, id);
            }
            const model = (message as { model?: string }).model;
            if (model) meter.setModel(model);
          } else if (subtype === 'compact_boundary') {
            await presenter.postNotice('🗜️ 컨텍스트가 길어져 대화를 압축했습니다. 세션은 그대로 이어집니다.');
          }
          break;
        }

        case 'assistant': {
          turns += 1;
          presenter.setTurns(turns);
          meter.recordUsage((message as { message?: { usage?: unknown } }).message?.usage);
          const isSubagent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id != null;
          for (const block of contentBlocks(message)) {
            if (block.type === 'tool_use') {
              presenter.toolStart(String(block.id ?? ''), String(block.name ?? '알 수 없는 도구'), asRecord(block.input));
            } else if (block.type === 'text' && !isSubagent) {
              await presenter.postAssistantText(String(block.text ?? ''));
            }
          }
          break;
        }

        case 'user': {
          for (const block of contentBlocks(message)) {
            if (block.type === 'tool_result') {
              presenter.toolEnd(String(block.tool_use_id ?? ''), block.is_error === true);
            }
          }
          break;
        }

        case 'result': {
          sawResult = true;
          const result = message as Extract<SDKMessage, { type: 'result' }>;
          sessionId = result.session_id ?? sessionId;
          if (sessionId) store.setSessionId(record.thread_id, sessionId);
          costUsd = result.total_cost_usd;
          turns = result.num_turns ?? turns;
          meter.recordModelUsage(result.modelUsage);

          if (result.subtype === 'success') {
            finalText = result.result ?? '';
          } else {
            errorText = summarizeErrors(result);
          }
          break;
        }

        default:
          break;
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // 에러 result 를 이미 받았다면 그 내용을 우선합니다.
      if (!errorText) errorText = text;
      log.error(`실행 실패 (thread ${record.thread_id})`, error);
    }
  } finally {
    activeRuns.delete(record.thread_id);
  }

  const aborted = abort.signal.aborted;

  // result.result 가 마지막 assistant 텍스트와 같으면 중복 출력하지 않습니다.
  if (!aborted && finalText.trim() && finalText.trim() !== presenter.lastText()) {
    await presenter.postAssistantText(finalText);
  }

  if (!aborted && !sawResult && !errorText) {
    errorText = 'Claude 프로세스가 결과를 반환하지 않고 종료되었습니다.';
  }

  const status: 'ok' | 'error' | 'aborted' = aborted ? 'aborted' : errorText ? 'error' : 'ok';

  await presenter.finish({
    status,
    ...(costUsd !== undefined ? { costUsd } : {}),
    numTurns: turns,
    ...(errorText ? { errorText } : {}),
  });

  store.finishRun({
    id: runId,
    status,
    sessionId: sessionId ?? null,
    costUsd: costUsd ?? null,
    numTurns: turns,
    durationMs: Date.now() - startedAt,
    error: errorText ?? null,
  });
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

interface LooseBlock {
  type?: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
}

/** SDK 메시지에서 content 블록 배열을 안전하게 꺼냅니다. */
function contentBlocks(message: unknown): Array<LooseBlock & { type: string }> {
  const inner = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(inner)) return [];
  return inner.filter(
    (b): b is LooseBlock & { type: string } =>
      typeof b === 'object' && b !== null && typeof (b as LooseBlock).type === 'string',
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function summarizeErrors(result: Extract<SDKMessage, { type: 'result' }>): string {
  const subtype = result.subtype;
  const errors = 'errors' in result && Array.isArray(result.errors) ? result.errors : [];
  const detail = errors.length ? `\n${errors.join('\n')}` : '';
  switch (subtype) {
    case 'error_max_turns':
      return `최대 턴 수(${config.claude.maxTurns})에 도달했습니다. 이어서 진행하려면 스레드에 다시 요청하세요.${detail}`;
    case 'error_max_budget_usd':
      return `설정된 비용 한도에 도달했습니다.${detail}`;
    default:
      return `실행 중 오류가 발생했습니다 (${subtype}).${detail}`;
  }
}
