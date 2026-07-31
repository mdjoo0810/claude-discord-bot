import { REST, Routes } from 'discord.js';
import { commandDefinitions } from '../src/commands.js';
import { config } from '../src/config.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);

const route = config.discord.guildId
  ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
  : Routes.applicationCommands(config.discord.clientId);

await rest.put(route, { body: commandDefinitions });

console.log(
  `✅ 슬래시 커맨드 ${commandDefinitions.length}개 등록 완료 ` +
    (config.discord.guildId ? `(길드 ${config.discord.guildId} — 즉시 반영)` : '(글로벌 — 반영에 최대 1시간)'),
);
