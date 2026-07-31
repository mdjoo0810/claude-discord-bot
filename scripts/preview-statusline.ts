/** 상태줄 최종 형태 미리보기: npx tsx scripts/preview-statusline.ts */
process.env['DISCORD_TOKEN'] ||= 'preview';
process.env['DISCORD_CLIENT_ID'] ||= 'preview';
process.env['ALLOWED_USER_IDS'] ||= '1';
process.env['LOG_LEVEL'] ||= 'error';
process.env['DB_PATH'] ||= '/tmp/claude-discord-bot-smoke.db';

const { SessionMeter } = await import('../src/meter.js');

const meter = new SessionMeter(process.env['CLAUDE_EFFORT'] ?? 'high');
meter.setModel('claude-opus-5[1m]');
meter.recordUsage({ input_tokens: 417_000 });
meter.recordModelUsage({ 'claude-opus-5[1m]': { contextWindow: 1_000_000 } });

meter.render(); // 사용량 갱신을 백그라운드로 트리거
await new Promise((resolve) => setTimeout(resolve, 8000));
console.log('\n' + meter.render() + '\n');
process.exit(0);
