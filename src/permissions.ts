import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type Message,
  type ThreadChannel,
} from 'discord.js';
import { config } from './config.js';
import { store } from './db.js';
import { describeTool, truncate } from './format.js';
import { log } from './log.js';
import { decide } from './policy.js';
import type { Presenter } from './presenter.js';

export interface PermissionContext {
  thread: ThreadChannel;
  threadId: string;
  projectDir: string;
  presenter: Presenter;
  /** 매 호출마다 최신 값을 읽습니다 (/auto 를 실행 중에 켤 수 있도록). */
  isAutoApprove: () => boolean;
  rules: Set<string>;
  /** "거부하고 중단" 을 눌렀을 때 실행 전체를 취소합니다. */
  requestStop: () => void;
  signal: AbortSignal;
}

let counter = 0;

export function createCanUseTool(ctx: PermissionContext): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const decision = decide(toolName, input, {
      projectDir: ctx.projectDir,
      autoApprove: ctx.isAutoApprove(),
      rules: ctx.rules,
    });

    if (decision.action === 'allow') {
      log.debug(`자동 승인: ${toolName} (${decision.reason})`);
      return { behavior: 'allow', updatedInput: input };
    }

    if (decision.action === 'deny') {
      await ctx.presenter.postNotice(`⛔ ${describeTool(toolName, input)} · 차단됨 (${decision.reason})`);
      return { behavior: 'deny', message: `호스트 정책에 의해 차단되었습니다: ${decision.reason}` };
    }

    if (decision.rules.length > 0 && decision.rules.every((rule) => ctx.rules.has(rule))) {
      return { behavior: 'allow', updatedInput: input };
    }

    return askUser(ctx, toolName, input, decision, options);
  };
}

type AskDecision = Extract<ReturnType<typeof decide>, { action: 'ask' }>;

async function askUser(
  ctx: PermissionContext,
  toolName: string,
  input: Record<string, unknown>,
  decision: AskDecision,
  options: { title?: string; description?: string; displayName?: string },
): Promise<PermissionResult> {
  const nonce = `${Date.now().toString(36)}-${(counter += 1).toString(36)}`;
  const ids = {
    allow: `perm:${nonce}:allow`,
    always: `perm:${nonce}:always`,
    deny: `perm:${nonce}:deny`,
    stop: `perm:${nonce}:stop`,
  };

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.allow).setLabel('허용').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ids.always).setLabel('항상 허용').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ids.deny).setLabel('거부').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ids.stop).setLabel('거부하고 중단').setStyle(ButtonStyle.Danger),
  );

  // 진행 상황 메시지를 가리지 않도록 한 줄로 유지합니다.
  const body = `🔐 ${compactRequest(toolName, input)}`;

  let message: Message;
  try {
    message = await ctx.thread.send({ content: truncate2000(body), components: [row] });
  } catch (error) {
    log.error('승인 요청 메시지 전송 실패', error);
    return { behavior: 'deny', message: '승인 요청을 사용자에게 전달하지 못했습니다.' };
  }

  // 승인 요청이 올라갔으니 진행 메시지는 아래로 내려야 합니다.
  // 다만 대기 중에는 버튼이 맨 아래에 있어야 하므로 재배치는 승인 이후로 미뤄집니다.
  ctx.presenter.markDisplaced();
  ctx.presenter.setWaiting(`${toolName} 승인 대기`);

  try {
    const interaction = await Promise.race([
      message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: config.runtime.approvalTimeoutMs,
        filter: (i) => i.customId.startsWith(`perm:${nonce}:`) && config.access.userIds.has(i.user.id),
      }),
      abortPromise(ctx.signal),
    ]);

    if (interaction === 'aborted') {
      await safeEdit(message, `🛑 ${describeTool(toolName, input)} · 실행 취소로 만료`);
      return { behavior: 'deny', message: '사용자가 실행을 중단했습니다.' };
    }

    const action = interaction.customId.split(':')[2];

    if (action === 'allow' || action === 'always') {
      if (action === 'always') {
        for (const rule of decision.rules) {
          ctx.rules.add(rule);
          store.addRule(ctx.threadId, rule);
        }
      }
      // 결정 후에는 한 줄만 남깁니다.
      await interaction.update({
        content: truncate2000(
          `✅ ${describeTool(toolName, input)}${action === 'always' ? ' · 이후 자동 허용' : ''}`,
        ),
        components: [],
      });
      ctx.presenter.setRunning();
      return { behavior: 'allow', updatedInput: input };
    }

    const stopping = action === 'stop';
    await interaction.update({
      content: truncate2000(
        `🚫 ${describeTool(toolName, input)}${stopping ? ' · 실행 중단' : ''}`,
      ),
      components: [],
    });
    ctx.presenter.setRunning();
    if (stopping) ctx.requestStop();
    return {
      behavior: 'deny',
      message: stopping
        ? '사용자가 이 작업을 거부하고 실행을 중단했습니다.'
        : '사용자가 이 작업을 거부했습니다. 다른 방법을 찾거나 왜 필요한지 설명해 주세요.',
      interrupt: stopping,
    };
  } catch {
    // awaitMessageComponent 는 타임아웃 시 예외를 던집니다.
    await safeEdit(message, `⌛ ${describeTool(toolName, input)} · 시간 초과로 자동 거부`);
    ctx.presenter.setRunning();
    return {
      behavior: 'deny',
      message: '승인 대기 시간이 초과되어 자동으로 거부되었습니다.',
    };
  }
}

function abortPromise(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

async function safeEdit(message: Message, content: string): Promise<void> {
  try {
    await message.edit({ content: truncate2000(content), components: [] });
  } catch (error) {
    log.debug('승인 메시지 편집 실패(무시)', error);
  }
}

/**
 * 승인 요청을 한 줄로 렌더링합니다.
 * 판단에 필요한 정보(주로 셸 명령 전문)는 남기되 코드 블록은 쓰지 않습니다.
 */
function compactRequest(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input['command'] === 'string') {
    const command = (input['command'] as string).replace(/\s+/g, ' ').trim();
    return `\`${truncate(command, 300)}\` 실행할까요?`;
  }
  return `${describeTool(toolName, input)} — 승인할까요?`;
}

function truncate2000(text: string): string {
  return text.length <= 1990 ? text : `${text.slice(0, 1987)}…`;
}
