import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Message,
  type ThreadChannel,
} from 'discord.js';
import { assertConfigSane, config } from './config.js';
import { dispatch, ensureThreadRegistered, handleAutocomplete, handleCommand } from './commands.js';
import { closeDb, store } from './db.js';
import { installHealthWatch } from './health.js';
import { truncate } from './format.js';
import { log } from './log.js';
import { listProjects, resolveProject, type Project } from './projects.js';
import { stopAllRuns } from './runner.js';
import { refreshUsageIfStale } from './usage.js';

assertConfigSane();
store.markOrphanRuns();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// 게이트웨이가 끊긴 채 프로세스만 살아 있는 상태를 막습니다.
installHealthWatch(client, {
  onFatal: () => {
    stopAllRuns();
    store.markOrphanRuns();
    closeDb();
  },
});

client.once(Events.ClientReady, (ready) => {
  log.info(`로그인 완료: ${ready.user.tag}`);
  log.info(`프로젝트 루트: ${config.projectsRoot} (${listProjects().length}개 발견)`);
  log.info(
    `허용 유저 ${config.access.userIds.size}명 · 허용 채널 ${
      config.access.channelIds.size || '전체(멘션 필요)'
    } · 동시 실행 ${config.runtime.maxConcurrentRuns}`,
  );

  if (config.usage.command) {
    refreshUsageIfStale();
    const timer = setInterval(() => refreshUsageIfStale(), 60_000);
    if (typeof timer.unref === 'function') timer.unref();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    if (!config.access.userIds.has(interaction.user.id)) {
      await interaction.reply({
        content: '이 봇을 사용할 권한이 없습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await handleCommand(interaction);
  } catch (error) {
    log.error('인터랙션 처리 실패', error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: '⚠️ 처리 중 오류가 발생했습니다.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await onMessage(message);
  } catch (error) {
    log.error('메시지 처리 실패', error);
  }
});

async function onMessage(message: Message): Promise<void> {
  const botId = client.user?.id;

  // 왜 반응하지 않았는지 추적하기 위한 진단 로그 (LOG_LEVEL=debug 에서만 출력)
  log.debug(
    `MessageCreate ch=${message.channelId} thread=${message.channel.isThread()} ` +
      `author=${message.author.id} bot=${message.author.bot} ` +
      `허용유저=${config.access.userIds.has(message.author.id)} ` +
      `멘션=${botId ? message.mentions.users.has(botId) : '?'} ` +
      `역할멘션=${botId ? message.mentions.roles.size > 0 : '?'} ` +
      `content="${message.content.slice(0, 60)}"`,
  );

  if (message.author.bot || message.system) return;
  if (!message.inGuild()) return;
  if (!config.access.userIds.has(message.author.id)) return;

  if (!botId) return;
  const mentioned = isBotMentioned(message, botId);
  const channel = message.channel;

  // ── 스레드 안 ────────────────────────────────────────────────────────────
  if (channel.isThread()) {
    const thread = channel as ThreadChannel;
    const record = store.getThread(thread.id);

    if (record) {
      if (config.runtime.requireMentionInThread && !mentioned) return;
      const prompt = buildPrompt(message, botId);
      if (!prompt) return;
      await dispatch(thread, message.author.id, prompt);
      return;
    }

    // 등록되지 않은 스레드에서 멘션하면 그 자리에서 세션을 붙입니다.
    if (!mentioned) return;
    if (!isChannelAllowed(thread.parentId ?? '')) return;

    const parsed = parseProject(message.content);
    const project = pickProject(parsed.project);
    if (!project) {
      await thread.send(projectHelp());
      return;
    }
    ensureThreadRegistered(thread, message.author.id, project.name, project.dir);
    await thread.send(`🔗 이 스레드를 \`${project.name}\` 세션에 연결했습니다.`);
    const prompt = buildPrompt(message, botId);
    if (prompt) await dispatch(thread, message.author.id, prompt);
    return;
  }

  // ── 일반 채널 → 새 스레드 ────────────────────────────────────────────────
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return;
  if (!isChannelAllowed(channel.id)) return;

  // 채널을 명시적으로 지정한 경우엔 멘션 없이도 반응합니다.
  const channelIsDedicated = config.access.channelIds.has(channel.id);
  if (!channelIsDedicated && !mentioned) return;

  const prompt = buildPrompt(message, botId);
  if (!prompt) return;

  const parsed = parseProject(prompt);
  const project = pickProject(parsed.project);
  if (!project) {
    await message.reply(projectHelp());
    return;
  }

  let thread: ThreadChannel;
  try {
    thread = await message.startThread({
      name: truncate(parsed.rest, 90) || `claude-${Date.now()}`,
      autoArchiveDuration: 10080, // 7일
    });
  } catch (error) {
    log.error('스레드 생성 실패', error);
    await message.reply('❌ 스레드를 만들지 못했습니다. 봇의 "공개 스레드 만들기" 권한을 확인하세요.');
    return;
  }

  store.createThread({
    threadId: thread.id,
    channelId: channel.id,
    guildId: message.guildId,
    ownerId: message.author.id,
    project: project.name,
    cwd: project.dir,
  });

  await thread.send(`🧵 \`${project.name}\` 세션을 시작합니다. 이어서 말하려면 이 스레드에서 저를 멘션하세요.`);
  await dispatch(thread, message.author.id, parsed.rest);
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function isChannelAllowed(channelId: string): boolean {
  return config.access.channelIds.size === 0 || config.access.channelIds.has(channelId);
}

/**
 * 봇이 멘션되었는지 판정합니다.
 * `mentions.users` 만으로는 놓치는 경우가 있어서 세 가지를 모두 봅니다.
 *  - 직접 멘션: <@id>
 *  - 봇의 관리형 역할 멘션: <@&roleId>
 *  - 봇 메시지에 대한 답장(Discord 가 멘션 칩으로 표시)
 */
function isBotMentioned(message: Message, botId: string): boolean {
  if (message.mentions.users.has(botId)) return true;
  if (message.content.includes(`<@${botId}>`) || message.content.includes(`<@!${botId}>`)) return true;

  const botMember = message.guild?.members.me;
  if (botMember && message.mentions.roles.some((role) => botMember.roles.cache.has(role.id))) {
    return true;
  }

  if (message.mentions.repliedUser?.id === botId) return true;
  return false;
}

/** 멘션을 제거하고 첨부 파일 정보를 덧붙인 프롬프트를 만듭니다. */
function buildPrompt(message: Message, botId: string): string {
  const mentionPattern = new RegExp(`<@!?${botId}>`, 'g');
  let text = message.content.replace(mentionPattern, ' ').trim();

  if (message.attachments.size > 0) {
    const lines = [...message.attachments.values()].map((a) => `- ${a.name}: ${a.url}`);
    text += `\n\n[Discord 첨부 파일 — 필요하면 WebFetch 로 내려받으세요]\n${lines.join('\n')}`;
  }

  if (message.reference?.messageId) {
    // 답장한 원본 메시지를 참고할 수 있도록 표시만 남깁니다.
    text += `\n\n[이 메시지는 다른 메시지에 대한 답장입니다]`;
  }

  return text.trim();
}

/** `[project] 나머지` 형태의 접두사를 파싱합니다. */
function parseProject(text: string): { project?: string; rest: string } {
  const match = /^\s*\[([\w.\-/]+)\]\s*([\s\S]*)$/.exec(text);
  if (!match) return { rest: text.trim() };
  return { project: match[1], rest: (match[2] ?? '').trim() };
}

function pickProject(requested: string | undefined): Project | undefined {
  const name = requested ?? config.defaultProject;
  if (name) {
    try {
      return resolveProject(name);
    } catch (error) {
      log.warn(`프로젝트 해석 실패: ${name}`, error);
      return undefined;
    }
  }
  const all = listProjects();
  return all.length === 1 ? all[0] : undefined;
}

function projectHelp(): string {
  const names = listProjects().map((p) => `\`${p.name}\``).join(', ') || '(없음)';
  return [
    '어떤 프로젝트에서 작업할지 알 수 없습니다.',
    `메시지 앞에 \`[프로젝트명]\` 을 붙이거나 \`/code\` 를 사용하세요.`,
    `사용 가능: ${names}`,
  ].join('\n');
}

// ── 종료 처리 ────────────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} 수신 — 종료합니다.`);
  stopAllRuns();
  try {
    await client.destroy();
  } catch (error) {
    log.warn('클라이언트 종료 실패', error);
  }
  store.markOrphanRuns();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// 실행 중 예외로 봇 전체가 죽지 않도록 합니다.
process.on('unhandledRejection', (reason) => log.error('처리되지 않은 Promise 거부', reason));
process.on('uncaughtException', (error) => log.error('처리되지 않은 예외', error));

try {
  await client.login(config.discord.token);
} catch (error) {
  // 로그인 실패는 복구할 수 없으므로 명시적으로 종료합니다.
  // (uncaughtException 핸들러가 삼켜서 프로세스가 멈춘 채 남아 있으면
  //  launchd 가 재시작하지 못합니다.)
  log.error('Discord 로그인 실패 — DISCORD_TOKEN 을 확인하세요.', error);
  closeDb();
  process.exit(1);
}
