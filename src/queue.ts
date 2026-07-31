import { config } from './config.js';

type Task<T> = () => Promise<T>;

/**
 * 스레드별 직렬 실행 + 전역 동시 실행 수 제한.
 *
 * - 같은 스레드의 요청은 반드시 순서대로 하나씩 실행됩니다 (세션 꼬임 방지).
 * - 서로 다른 스레드는 MAX_CONCURRENT_RUNS 까지 동시에 실행됩니다.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const globalSemaphore = new Semaphore(config.runtime.maxConcurrentRuns);

interface ThreadQueue {
  tail: Promise<unknown>;
  pending: number;
}

const queues = new Map<string, ThreadQueue>();

export function queueDepth(threadId: string): number {
  return queues.get(threadId)?.pending ?? 0;
}

export function isBusy(threadId: string): boolean {
  return queueDepth(threadId) > 0;
}

export function enqueue<T>(threadId: string, task: Task<T>): Promise<T> {
  const queue = queues.get(threadId) ?? { tail: Promise.resolve(), pending: 0 };
  queues.set(threadId, queue);
  queue.pending += 1;

  const run = queue.tail.then(async () => {
    const release = await globalSemaphore.acquire();
    try {
      return await task();
    } finally {
      release();
      queue.pending -= 1;
      if (queue.pending === 0 && queues.get(threadId) === queue) {
        queues.delete(threadId);
      }
    }
  });

  // tail 은 실패해도 뒤 작업이 계속 실행되도록 흡수합니다.
  queue.tail = run.catch(() => undefined);
  return run as Promise<T>;
}
