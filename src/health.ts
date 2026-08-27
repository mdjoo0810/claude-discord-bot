import { Client, Events, type ThreadChannel } from 'discord.js';
import { log } from './log.js';

/**
 * 게이트웨이 연결 감시.
 *
 * 실제로 겪은 장애: 프로세스는 살아 있는데 웹소켓만 끊겨서 봇이 3주간
 * "running" 상태로 죽어 있었습니다. launchd 의 KeepAlive 는 프로세스가
 * 종료돼야 재시작하므로, 되살릴 수 없는 상태라면 스스로 죽는 편이 낫습니다.
 *
 * 판정 기준
 *  - Invalidated: 세션이 무효화됨. 복구 불가 → 즉시 종료
 *  - ShardDisconnect 후 GRACE_MS 안에 ShardReady/Resume 이 없음 → 종료
 *  - WebSocket ping 이 STALE_MS 동안 갱신되지 않음 → 종료
 */

/** 재연결을 기다려 주는 시간. discord.js 자체 백오프보다 넉넉하게 잡습니다. */
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
/** 주기적 헬스체크 간격. */
const CHECK_INTERVAL_MS = 60 * 1000;
/** 이 시간 넘게 게이트웨이가 무응답이면 죽은 것으로 간주합니다. */
const STALE_MS = 10 * 60 * 1000;

export interface HealthOptions {
  /** 프로세스를 종료하기 직전에 호출됩니다 (정리 작업용). */
  onFatal: (reason: string) => Promise<void> | void;
}

export function installHealthWatch(client: Client, options: HealthOptions): void {
  let disconnectedAt: number | undefined;
  let lastAliveAt = Date.now();
  let exiting = false;

  const markAlive = () => {
    lastAliveAt = Date.now();
    disconnectedAt = undefined;
  };

  /** 되살릴 수 없는 상태 — 종료해서 launchd 가 새 프로세스를 띄우게 합니다. */
  const fatal = (reason: string): void => {
    if (exiting) return;
    exiting = true;
    log.error(`게이트웨이 복구 불가 — 재시작을 위해 종료합니다: ${reason}`);
    void (async () => {
      try {
        await options.onFatal(reason);
      } catch (error) {
        log.warn('종료 전 정리 실패', error);
      }
      // exit code 1 → launchd KeepAlive(SuccessfulExit=false) 가 재시작합니다.
      process.exit(1);
    })();
  };

  client.on(Events.ShardReady, (id) => {
    log.info(`샤드 ${id} 준비됨`);
    markAlive();
  });

  client.on(Events.ShardResume, (id, replayed) => {
    log.info(`샤드 ${id} 재개됨 (${replayed}건 재전송)`);
    markAlive();
  });

  client.on(Events.ShardReconnecting, (id) => {
    log.warn(`샤드 ${id} 재연결 시도 중`);
  });

  client.on(Events.ShardDisconnect, (event, id) => {
    // code 1000/1001 은 정상 종료지만, 우리 쪽에서 의도한 게 아니라면 여전히 문제입니다.
    log.warn(`샤드 ${id} 연결 끊김 (code=${event.code})`);
    disconnectedAt ??= Date.now();
  });

  client.on(Events.ShardError, (error, id) => {
    log.error(`샤드 ${id} 오류`, error);
    disconnectedAt ??= Date.now();
  });

  client.on(Events.Error, (error) => log.error('클라이언트 오류', error));

  // 토큰 무효화·강제 로그아웃 등 — discord.js 가 재연결을 포기한 상태입니다.
  client.on(Events.Invalidated, () => fatal('세션이 무효화되었습니다 (토큰 확인 필요)'));

  const timer = setInterval(() => {
    if (exiting) return;

    // isReady() 는 게이트웨이가 READY 상태인지를 그대로 알려줍니다.
    // ws.ping 은 하트비트 ACK 전에 -1 을 돌려주므로 생존 판정에 쓰면
    // 멀쩡한 프로세스를 죽일 수 있어 쓰지 않습니다.
    if (client.isReady()) {
      markAlive();
      return;
    }

    if (disconnectedAt && Date.now() - disconnectedAt > RECONNECT_GRACE_MS) {
      fatal(`${Math.round((Date.now() - disconnectedAt) / 60000)}분간 재연결 실패`);
      return;
    }

    if (Date.now() - lastAliveAt > STALE_MS) {
      fatal(`${Math.round((Date.now() - lastAliveAt) / 60000)}분간 게이트웨이 무응답`);
    }
  }, CHECK_INTERVAL_MS);

  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Claude 인증 만료 감지.
 *
 * OAuth 가 만료되면 사용자가 맥에서 직접 `claude` 에 로그인하기 전까지
 * 어떤 요청도 성공할 수 없습니다. 조용히 실패하면 알 수가 없으므로
 * 스레드에 명확히 알리고, 로그에도 남깁니다.
 */
const AUTH_ERROR_PATTERNS = [
  /OAuth session expired/i,
  /could not be refreshed/i,
  /Failed to authenticate/i,
  /authentication_failed/i,
  /invalid[_ ]api[_ ]key/i,
  /Please run .*claude.* to (log ?in|authenticate)/i,
];

export function isAuthError(text: string | undefined): boolean {
  if (!text) return false;
  return AUTH_ERROR_PATTERNS.some((re) => re.test(text));
}

export function authErrorNotice(): string {
  return [
    '🔑 **Claude 인증이 만료되었습니다.**',
    '맥에서 터미널을 열고 `claude` 를 실행해 로그인한 뒤 다시 요청해 주세요.',
    '-# 봇 재시작은 필요 없습니다. 로그인만 마치면 바로 이어서 사용할 수 있습니다.',
  ].join('\n');
}

/** 인증 만료를 알릴 스레드에 메시지를 보냅니다. */
export async function notifyAuthExpired(thread: ThreadChannel): Promise<void> {
  log.error('Claude 인증 만료 — 사용자 로그인이 필요합니다.');
  try {
    await thread.send(authErrorNotice());
  } catch (error) {
    log.warn('인증 만료 알림 전송 실패', error);
  }
}
