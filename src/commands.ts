import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type ThreadChannel,
} from 'discord.js';
import { config } from './config.js';
import { store } from './db.js';
import { formatCost, truncate } from './format.js';
import { log } from './log.js';
import { rateLimitSnapshots } from './meter.js';
import { listProjects, resolveProject } from './projects.js';
import { enqueue, queueDepth } from './queue.js';
import { isRunning, runTurn, stopRun } from './runner.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('code')
    .setDescription('새 Claude Code 세션을 스레드로 시작합니다')
    .addStringOption((o) =>
      o.setName('task').setDescription('무엇을 할지 설명하세요').setRequired(true).setMaxLength(1800),
    )
    .addStringOption((o) =>
      o
        .setName('project')
        .setDescription('작업할 프로젝트 (생략 시 기본 프로젝트)')
        .setRequired(false)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder().setName('stop').setDescription('이 스레드에서 실행 중인 작업을 중단합니다'),
  new SlashCommandBuilder().setName('status').setDescription('이 스레드의 세션 상태와 사용량을 봅니다'),
  new SlashCommandBuilder()
    .setName('auto')
    .setDescription('이 스레드의 권한 자동 승인을 켜고 끕니다')
    .addBooleanOption((o) => o.setName('enabled').setDescription('켜기/끄기').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('이 스레드의 Claude 세션을 초기화합니다 (대화 기억을 비웁니다)'),
  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('이 스레드에 저장된 "항상 허용" 규칙을 관리합니다')
    .addBooleanOption((o) =>
      o.setName('clear').setDescription('true 로 두면 모든 규칙을 삭제합니다').setRequired(false),
    ),
  new SlashCommandBuilder().setName('projects').setDescription('작업 가능한 프로젝트 목록을 봅니다'),
].map((c) => c.toJSON());

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== 'code') return;
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = listProjects()
    .filter((p) => p.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((p) => ({ name: p.isGit ? `${p.name} (git)` : p.name, value: p.name }));
  await interaction.respond(choices);
}

export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.commandName) {
    case 'code':
      return handleCode(interaction);
    case 'stop':
      return handleStop(interaction);
    case 'status':
      return handleStatus(interaction);
    case 'auto':
      return handleAuto(interaction);
    case 'reset':
      return handleReset(interaction);
    case 'rules':
      return handleRules(interaction);
    case 'projects':
      return handleProjects(interaction);
    default:
      await ephemeral(interaction, '알 수 없는 커맨드입니다.');
  }
}

// ── /code ────────────────────────────────────────────────────────────────────

async function handleCode(interaction: ChatInputCommandInteraction): Promise<void> {
  const task = interaction.options.getString('task', true);
  const requested = interaction.options.getString('project') ?? config.defaultProject;

  if (!requested) {
    const names = listProjects().map((p) => `\`${p.name}\``).join(', ') || '(없음)';
    await ephemeral(
      interaction,
      `프로젝트를 지정해 주세요. DEFAULT_PROJECT 를 설정하면 생략할 수 있습니다.\n사용 가능: ${names}`,
    );
    return;
  }

  let project;
  try {
    project = resolveProject(requested);
  } catch (error) {
    await ephemeral(interaction, `❌ ${(error as Error).message}`);
    return;
  }

  const channel = interaction.channel;
  if (!channel) {
    await ephemeral(interaction, '채널 정보를 읽을 수 없습니다.');
    return;
  }

  // 이미 스레드 안이라면 그 스레드를 그대로 사용합니다.
  if (channel.isThread()) {
    await interaction.deferReply();
    ensureThreadRegistered(channel, interaction.user.id, project.name, project.dir);
    await interaction.editReply(`▶️ \`${project.name}\` 에서 이어서 실행합니다.`);
    void dispatch(channel, interaction.user.id, task);
    return;
  }

  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    await ephemeral(interaction, '스레드를 만들 수 있는 텍스트 채널에서 실행해 주세요.');
    return;
  }

  await interaction.deferReply();
  const starter = (await interaction.editReply(
    `🧵 \`${project.name}\` 세션을 시작합니다.\n> ${truncate(task, 300)}`,
  )) as Message;

  let thread: ThreadChannel;
  try {
    thread = await starter.startThread({
      name: truncate(task, 90) || `claude-${Date.now()}`,
      autoArchiveDuration: 10080, // 7일
    });
  } catch (error) {
    log.error('스레드 생성 실패', error);
    await interaction.editReply('❌ 스레드를 만들지 못했습니다. 봇의 "공개 스레드 만들기" 권한을 확인하세요.');
    return;
  }

  store.createThread({
    threadId: thread.id,
    channelId: channel.id,
    guildId: interaction.guildId,
    ownerId: interaction.user.id,
    project: project.name,
    cwd: project.dir,
  });

  void dispatch(thread, interaction.user.id, task);
}

// ── 나머지 커맨드 ────────────────────────────────────────────────────────────

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const threadId = interaction.channelId;
  if (stopRun(threadId)) {
    await interaction.reply('🛑 중단 요청을 보냈습니다. 진행 중인 도구 실행이 끝나는 대로 멈춥니다.');
  } else {
    await ephemeral(interaction, '이 스레드에서 실행 중인 작업이 없습니다.');
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const record = store.getThread(interaction.channelId);
  if (!record) {
    await ephemeral(interaction, '이 스레드는 Claude 세션에 연결되어 있지 않습니다. `/code` 로 시작하세요.');
    return;
  }

  const stats = store.threadStats(record.thread_id);
  const rules = store.listRules(record.thread_id);
  const limits = rateLimitSnapshots()
    .map((s) => `${s.type}: ${s.percent}%`)
    .join(' · ');

  const lines = [
    `**프로젝트** \`${record.project}\``,
    `**경로** \`${record.cwd}\``,
    `**세션** ${record.session_id ? `\`${record.session_id.slice(0, 8)}…\`` : '아직 없음(첫 요청 시 생성)'}`,
    `**상태** ${isRunning(record.thread_id) ? '실행 중' : '대기'} · 대기열 ${queueDepth(record.thread_id)}건`,
    `**자동 승인** ${record.auto_approve ? '켜짐 ⚠️' : '꺼짐'}`,
    `**허용 규칙** ${rules.size}건${rules.size ? ` (${[...rules].join(', ')})` : ''}`,
    `**누적** ${stats.runs}회 요청 · ${formatCost(stats.cost)}`,
    limits ? `**계정 한도** ${limits}` : undefined,
  ].filter(Boolean);

  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

async function handleAuto(interaction: ChatInputCommandInteraction): Promise<void> {
  const record = store.getThread(interaction.channelId);
  if (!record) {
    await ephemeral(interaction, 'Claude 세션 스레드에서만 사용할 수 있습니다.');
    return;
  }
  const enabled = interaction.options.getBoolean('enabled', true);
  store.setAutoApprove(record.thread_id, enabled);
  await interaction.reply(
    enabled
      ? '⚠️ **자동 승인 켜짐** — 이 스레드에서는 셸 명령과 프로젝트 밖 수정도 확인 없이 실행됩니다. (하드 차단 목록은 계속 적용)'
      : '🔐 자동 승인 꺼짐 — 위험한 작업은 다시 버튼 승인을 받습니다.',
  );
}

async function handleReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const record = store.getThread(interaction.channelId);
  if (!record) {
    await ephemeral(interaction, 'Claude 세션 스레드에서만 사용할 수 있습니다.');
    return;
  }
  store.resetSession(record.thread_id);
  await interaction.reply('🧹 세션을 초기화했습니다. 다음 요청부터 새 대화로 시작합니다. (파일 변경은 되돌리지 않습니다)');
}

async function handleRules(interaction: ChatInputCommandInteraction): Promise<void> {
  const record = store.getThread(interaction.channelId);
  if (!record) {
    await ephemeral(interaction, 'Claude 세션 스레드에서만 사용할 수 있습니다.');
    return;
  }
  if (interaction.options.getBoolean('clear')) {
    store.clearRules(record.thread_id);
    await interaction.reply('🧽 이 스레드의 "항상 허용" 규칙을 모두 삭제했습니다.');
    return;
  }
  const rules = [...store.listRules(record.thread_id)];
  await ephemeral(
    interaction,
    rules.length ? `허용 규칙 ${rules.length}건:\n${rules.map((r) => `• \`${r}\``).join('\n')}` : '저장된 규칙이 없습니다.',
  );
}

async function handleProjects(interaction: ChatInputCommandInteraction): Promise<void> {
  const projects = listProjects();
  const body = projects.length
    ? projects.map((p) => `• \`${p.name}\`${p.isGit ? ' (git)' : ''}`).join('\n')
    : `\`${config.projectsRoot}\` 아래에 디렉터리가 없습니다.`;
  await ephemeral(interaction, `**${config.projectsRoot}**\n${body}`);
}

// ── 공용 ─────────────────────────────────────────────────────────────────────

export function ensureThreadRegistered(
  thread: ThreadChannel,
  ownerId: string,
  project: string,
  cwd: string,
): void {
  store.createThread({
    threadId: thread.id,
    channelId: thread.parentId ?? thread.id,
    guildId: thread.guildId,
    ownerId,
    project,
    cwd,
  });
}

/** 스레드 큐에 요청을 넣습니다. 실행은 순차적으로 이루어집니다. */
export function dispatch(thread: ThreadChannel, userId: string, prompt: string): Promise<void> {
  const record = store.getThread(thread.id);
  if (!record) {
    return thread.send('⚠️ 이 스레드의 세션 정보를 찾을 수 없습니다. `/code` 로 새 세션을 시작해 주세요.').then(() => undefined);
  }

  if (queueDepth(thread.id) > 0) {
    void thread.send('⏳ 앞선 요청이 끝난 뒤 이어서 처리합니다.');
  }

  return enqueue(thread.id, async () => {
    // 큐에서 빠져나온 시점의 최신 레코드를 사용합니다 (/reset, /auto 반영).
    const latest = store.getThread(thread.id) ?? record;
    try {
      await runTurn({ thread, record: latest, prompt, userId });
    } catch (error) {
      log.error(`턴 실행 중 예외 (thread ${thread.id})`, error);
      await thread
        .send(`⚠️ 처리 중 예기치 못한 오류가 발생했습니다.\n\`\`\`\n${truncate(String(error), 1500)}\n\`\`\``)
        .catch(() => undefined);
    }
  });
}

async function ephemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const payload = { content: truncate(content, 1900), flags: MessageFlags.Ephemeral } as const;
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}
