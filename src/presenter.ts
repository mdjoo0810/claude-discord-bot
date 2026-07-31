import { AttachmentBuilder, type Message, type ThreadChannel } from 'discord.js';
import { config } from './config.js';
import { chunkText, describeTool, formatCost, formatDuration, truncate } from './format.js';
import { log } from './log.js';
import type { SessionMeter } from './meter.js';

const EDIT_INTERVAL_MS = 2500;
/** 진행 메시지의 경과 시간·사용량을 주기적으로 갱신합니다. */
const HEARTBEAT_MS = 10_000;
/**
 * 다른 메시지에 밀렸을 때 진행 메시지를 맨 아래로 옮기는 최소 간격.
 * 편집보다 비싼 작업(전송+삭제)이라 더 여유를 둡니다.
 */
const RELOCATE_INTERVAL_MS = 4000;
const MAX_ACTIVITY_LINES = 8;
/** 이 길이를 넘는 답변은 메시지 대신 파일로 첨부합니다. */
const ATTACH_THRESHOLD = 7000;

interface Activity {
  toolUseId: string;
  line: string;
  state: 'running' | 'ok' | 'error';
}

/**
 * 한 번의 실행(turn)에 대한 Discord 출력 담당.
 * 진행 상황은 메시지 하나를 스로틀링하며 편집하고, 답변 텍스트는 별도 메시지로 보냅니다.
 */
export class Presenter {
  private statusMessage: Message | undefined;
  private readonly activities: Activity[] = [];
  private readonly startedAt = Date.now();
  private turns = 0;
  private status: 'starting' | 'running' | 'waiting' | 'done' = 'starting';
  private statusNote = '';
  private lastEditAt = 0;
  private editTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private editing = false;
  private closed = false;
  private lastAssistantText = '';
  /** 진행 메시지 아래에 다른 메시지가 쌓여서 맨 아래로 옮겨야 하는 상태 */
  private displaced = false;
  private lastRelocateAt = 0;

  constructor(
    private readonly thread: ThreadChannel,
    private readonly meta: { project: string; meter: SessionMeter },
  ) {}

  async start(): Promise<void> {
    this.status = 'running';
    try {
      this.statusMessage = await this.thread.send(this.render());
    } catch (error) {
      log.warn('진행 상황 메시지 생성 실패', error);
    }
    this.heartbeat = setInterval(() => this.scheduleUpdate(), HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  setTurns(count: number): void {
    this.turns = count;
    this.scheduleUpdate();
  }

  /**
   * 스레드에 다른 메시지가 올라가 진행 메시지가 위로 밀렸음을 알립니다.
   * 다음 갱신 때 진행 메시지를 삭제하고 맨 아래에 새로 띄웁니다.
   */
  markDisplaced(): void {
    if (this.closed) return;
    this.displaced = true;
    this.scheduleUpdate();
  }

  setWaiting(note: string): void {
    this.status = 'waiting';
    this.statusNote = note;
    this.scheduleUpdate(true);
  }

  setRunning(): void {
    if (this.status === 'done') return;
    this.status = 'running';
    this.statusNote = '';
    this.scheduleUpdate();
  }

  toolStart(toolUseId: string, name: string, input: Record<string, unknown>): void {
    this.activities.push({ toolUseId, line: describeTool(name, input), state: 'running' });
    if (this.activities.length > 40) this.activities.splice(0, this.activities.length - 40);
    this.scheduleUpdate();
  }

  toolEnd(toolUseId: string, isError: boolean): void {
    const found = [...this.activities].reverse().find((a) => a.toolUseId === toolUseId);
    if (found) found.state = isError ? 'error' : 'ok';
    this.scheduleUpdate();
  }

  /** Claude 가 사용자에게 보내는 텍스트를 그대로 전달합니다. */
  async postAssistantText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.lastAssistantText = trimmed;
    const footer = config.runtime.statusLine === 'all' ? this.meta.meter.render() : '';
    await this.sendLongText(trimmed, 'answer.md', footer);
  }

  lastText(): string {
    return this.lastAssistantText;
  }

  async postNotice(text: string): Promise<void> {
    try {
      await this.thread.send(truncate(text, 1900));
      this.markDisplaced();
    } catch (error) {
      log.warn('알림 메시지 전송 실패', error);
    }
  }

  async finish(result: {
    status: 'ok' | 'error' | 'aborted';
    costUsd?: number;
    numTurns?: number;
    errorText?: string;
  }): Promise<void> {
    this.closed = true;
    if (this.editTimer) clearTimeout(this.editTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.status = 'done';
    if (result.numTurns !== undefined) this.turns = result.numTurns;

    const icon = result.status === 'ok' ? '✅' : result.status === 'aborted' ? '🛑' : '⚠️';
    const label =
      result.status === 'ok' ? '완료' : result.status === 'aborted' ? '중단됨' : '오류';

    const parts = [
      `${icon} **${label}** · ${formatDuration(Date.now() - this.startedAt)}`,
      this.turns ? `${this.turns}턴` : undefined,
      result.costUsd !== undefined ? formatCost(result.costUsd) : undefined,
    ].filter(Boolean);

    const body = [parts.join(' · '), this.renderActivity(), this.statusLine()]
      .filter(Boolean)
      .join('\n');

    // 완료 요약은 항상 맨 아래에 오도록 강제로 재배치합니다.
    await this.editStatus(body, true);

    if (result.errorText) {
      await this.sendLongText(`\`\`\`\n${truncate(result.errorText, 1500)}\n\`\`\``, 'error.txt');
    }
  }

  // ── 내부 구현 ────────────────────────────────────────────────────────────

  private statusLine(): string {
    return config.runtime.statusLine === 'off' ? '' : this.meta.meter.render();
  }

  private async sendLongText(text: string, filename: string, footer = ''): Promise<void> {
    try {
      if (text.length > ATTACH_THRESHOLD) {
        const attachment = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: filename });
        await this.thread.send({
          content: [`내용이 길어 파일로 첨부합니다 (${text.length.toLocaleString()}자).`, footer]
            .filter(Boolean)
            .join('\n'),
          files: [attachment],
        });
        return; // finally 에서 markDisplaced 가 실행됩니다.
      }
      const chunks = chunkText(text);
      for (const [index, chunk] of chunks.entries()) {
        const isLast = index === chunks.length - 1;
        const body = isLast && footer ? `${chunk}\n${footer}` : chunk;
        await this.thread.send(truncate2000(body));
      }
    } catch (error) {
      log.warn('메시지 전송 실패', error);
    } finally {
      // 답변이 올라갔으니 진행 메시지를 아래로 다시 내려야 합니다.
      this.markDisplaced();
    }
  }

  private render(): string {
    const icon = this.status === 'waiting' ? '⏸️' : '🟢';
    const label = this.status === 'waiting' ? `대기 중 — ${this.statusNote}` : '실행 중';
    const head = [
      `${icon} **${label}** · ${formatDuration(Date.now() - this.startedAt)}`,
      this.turns ? `${this.turns}턴` : undefined,
      `\`${this.meta.project}\``,
    ]
      .filter(Boolean)
      .join(' · ');
    return [head, this.renderActivity(), this.statusLine()].filter(Boolean).join('\n');
  }

  private renderActivity(): string {
    if (this.activities.length === 0) return '';
    const recent = this.activities.slice(-MAX_ACTIVITY_LINES);
    const hidden = this.activities.length - recent.length;
    const lines = recent.map((a) => {
      const mark = a.state === 'running' ? '⏳' : a.state === 'error' ? '❌' : '·';
      return `${mark} ${a.line}`;
    });
    if (hidden > 0) lines.unshift(`… 이전 작업 ${hidden}건`);
    return lines.join('\n');
  }

  private scheduleUpdate(immediate = false): void {
    if (this.closed || !this.statusMessage) return;
    if (this.editTimer) return;

    const elapsed = Date.now() - this.lastEditAt;
    const delay = immediate ? 0 : Math.max(0, EDIT_INTERVAL_MS - elapsed);

    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      void this.editStatus(this.render());
    }, delay);
    if (typeof this.editTimer.unref === 'function') this.editTimer.unref();
  }

  private async editStatus(content: string, force = false): Promise<void> {
    if (!this.statusMessage || this.editing) return;
    this.editing = true;
    this.lastEditAt = Date.now();
    const body = truncate2000(content);

    try {
      if (this.shouldRelocate(force)) {
        // 새로 보낸 뒤 이전 것을 지웁니다. 순서를 바꾸면 상태가 잠깐 사라집니다.
        const previous = this.statusMessage;
        this.statusMessage = await this.thread.send(body);
        this.displaced = false;
        this.lastRelocateAt = Date.now();
        await previous.delete().catch(() => undefined);
      } else {
        await this.statusMessage.edit(body);
      }
    } catch (error) {
      log.debug('진행 상황 갱신 실패(무시)', error);
    } finally {
      this.editing = false;
    }
  }

  /**
   * 맨 아래로 옮길지 판단합니다.
   * 승인 대기 중에는 옮기지 않습니다 — 버튼이 맨 아래에 있어야 누르기 쉽습니다.
   */
  private shouldRelocate(force: boolean): boolean {
    if (!this.displaced) return false;
    if (this.status === 'waiting') return false;
    if (force) return true;
    return Date.now() - this.lastRelocateAt >= RELOCATE_INTERVAL_MS;
  }
}

function truncate2000(text: string): string {
  return text.length <= 1990 ? text : `${text.slice(0, 1987)}…`;
}
