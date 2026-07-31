/**
 * Agent SDK 연동 실측 스크립트.
 *   npx tsx scripts/probe-sdk.ts
 *
 * - 로컬 Claude Code 인증으로 붙는지
 * - session_id / resume 이 실제로 동작하는지
 * - 상태줄에 필요한 값(model, usage, contextWindow, rate_limit_info)이 오는지
 * 를 확인합니다. 아주 작은 프롬프트 2회만 실행합니다.
 */
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';

const cwd = os.tmpdir();
const seen = new Set<string>();
let sessionId: string | undefined;

async function run(prompt: string, resume?: string): Promise<string> {
  let text = '';
  const options = {
    cwd,
    maxTurns: 2,
    ...(resume ? { resume } : {}),
  };

  for await (const message of query({ prompt, options })) {
    const type = message.type;
    const subtype = (message as { subtype?: string }).subtype;
    seen.add(subtype ? `${type}/${subtype}` : type);

    if (type === 'system' && subtype === 'init') {
      const m = message as unknown as { session_id: string; model: string; permissionMode: string };
      sessionId = m.session_id;
      console.log(`  init      session=${m.session_id.slice(0, 8)}… model=${m.model} mode=${m.permissionMode}`);
    }

    if (type === 'assistant') {
      const usage = (message as unknown as { message?: { usage?: Record<string, number> } }).message?.usage;
      if (usage) {
        const used =
          (usage['input_tokens'] ?? 0) +
          (usage['cache_read_input_tokens'] ?? 0) +
          (usage['cache_creation_input_tokens'] ?? 0);
        console.log(`  usage     컨텍스트 점유 ≈ ${used.toLocaleString()} 토큰`);
      }
    }

    if (type === 'rate_limit_event') {
      console.log('  ratelimit', JSON.stringify((message as unknown as { rate_limit_info: unknown }).rate_limit_info));
    }

    if (type === 'result') {
      const r = message as unknown as {
        subtype: string;
        result?: string;
        session_id: string;
        total_cost_usd: number;
        num_turns: number;
        modelUsage: Record<string, { contextWindow?: number }>;
      };
      sessionId = r.session_id;
      text = r.result ?? '';
      const windows = Object.entries(r.modelUsage ?? {})
        .map(([m, u]) => `${m}=${u.contextWindow?.toLocaleString() ?? '?'}`)
        .join(', ');
      console.log(
        `  result    ${r.subtype} turns=${r.num_turns} cost=$${r.total_cost_usd?.toFixed(5)} contextWindow: ${windows}`,
      );
    }
  }
  return text;
}

console.log('1) 새 세션');
const first = await run('Reply with exactly this one word and nothing else: PONG');
console.log(`  응답      "${first.trim().slice(0, 80)}"`);

if (!sessionId) {
  console.error('\n❌ session_id 를 얻지 못했습니다.');
  process.exit(1);
}

console.log(`\n2) resume (${sessionId.slice(0, 8)}…)`);
const second = await run('What single word did I just ask you to reply with? Answer with only that word.', sessionId);
console.log(`  응답      "${second.trim().slice(0, 80)}"`);

const resumed = /pong/i.test(second);
console.log(`\n메시지 타입: ${[...seen].sort().join(', ')}`);
console.log(resumed ? '\n✅ resume 으로 대화 맥락이 이어집니다.' : '\n❌ resume 후 맥락이 이어지지 않았습니다.');
process.exit(resumed ? 0 : 1);
