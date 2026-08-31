import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.runtime.dbPath), { recursive: true });

const db = new Database(config.runtime.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS threads (
  thread_id     TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  guild_id      TEXT,
  owner_id      TEXT NOT NULL,
  project       TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  session_id    TEXT,
  auto_approve  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_rules (
  thread_id  TEXT NOT NULL,
  rule       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, rule),
  FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL,
  session_id  TEXT,
  cost_usd    REAL,
  num_turns   INTEGER,
  duration_ms INTEGER,
  error       TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, started_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

export interface ThreadRecord {
  thread_id: string;
  channel_id: string;
  guild_id: string | null;
  owner_id: string;
  project: string;
  cwd: string;
  session_id: string | null;
  auto_approve: number;
  created_at: number;
  updated_at: number;
}

const stmts = {
  getThread: db.prepare<[string], ThreadRecord>('SELECT * FROM threads WHERE thread_id = ?'),
  insertThread: db.prepare(
    `INSERT INTO threads (thread_id, channel_id, guild_id, owner_id, project, cwd, session_id, auto_approve, created_at, updated_at)
     VALUES (@thread_id, @channel_id, @guild_id, @owner_id, @project, @cwd, NULL,
             COALESCE(@auto_approve, 0), @now, @now)
     ON CONFLICT(thread_id) DO UPDATE SET project = excluded.project, cwd = excluded.cwd,
       -- 명시적으로 지정했을 때만 덮어씁니다. 그렇지 않으면 /auto 설정이 유지됩니다.
       auto_approve = COALESCE(@auto_approve, threads.auto_approve),
       updated_at = excluded.updated_at`,
  ),
  setSession: db.prepare('UPDATE threads SET session_id = ?, updated_at = ? WHERE thread_id = ?'),
  setAutoApprove: db.prepare('UPDATE threads SET auto_approve = ?, updated_at = ? WHERE thread_id = ?'),
  deleteThread: db.prepare('DELETE FROM threads WHERE thread_id = ?'),

  listRules: db.prepare<[string], { rule: string }>('SELECT rule FROM thread_rules WHERE thread_id = ?'),
  addRule: db.prepare(
    'INSERT OR IGNORE INTO thread_rules (thread_id, rule, created_at) VALUES (?, ?, ?)',
  ),
  clearRules: db.prepare('DELETE FROM thread_rules WHERE thread_id = ?'),

  startRun: db.prepare(
    `INSERT INTO runs (thread_id, user_id, prompt, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
  ),
  finishRun: db.prepare(
    `UPDATE runs SET status = @status, session_id = @session_id, cost_usd = @cost_usd,
       num_turns = @num_turns, duration_ms = @duration_ms, error = @error, ended_at = @ended_at
     WHERE id = @id`,
  ),
  threadStats: db.prepare<[string], { runs: number; cost: number | null }>(
    'SELECT COUNT(*) AS runs, SUM(cost_usd) AS cost FROM runs WHERE thread_id = ?',
  ),
  markOrphanRuns: db.prepare(
    `UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'`,
  ),

  getMeta: db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ),
};

export const store = {
  getThread(threadId: string): ThreadRecord | undefined {
    return stmts.getThread.get(threadId);
  },

  createThread(input: {
    threadId: string;
    channelId: string;
    guildId: string | null;
    ownerId: string;
    project: string;
    cwd: string;
    autoApprove?: boolean;
  }): void {
    stmts.insertThread.run({
      thread_id: input.threadId,
      channel_id: input.channelId,
      guild_id: input.guildId,
      owner_id: input.ownerId,
      project: input.project,
      cwd: input.cwd,
      auto_approve: input.autoApprove === undefined ? null : input.autoApprove ? 1 : 0,
      now: Date.now(),
    });
  },

  setSessionId(threadId: string, sessionId: string): void {
    stmts.setSession.run(sessionId, Date.now(), threadId);
  },

  setAutoApprove(threadId: string, enabled: boolean): void {
    stmts.setAutoApprove.run(enabled ? 1 : 0, Date.now(), threadId);
  },

  /** 세션만 초기화하고 스레드 등록/권한 규칙은 유지합니다. */
  resetSession(threadId: string): void {
    stmts.setSession.run(null, Date.now(), threadId);
  },

  deleteThread(threadId: string): void {
    stmts.deleteThread.run(threadId);
  },

  listRules(threadId: string): Set<string> {
    return new Set(stmts.listRules.all(threadId).map((r) => r.rule));
  },

  addRule(threadId: string, rule: string): void {
    stmts.addRule.run(threadId, rule, Date.now());
  },

  clearRules(threadId: string): void {
    stmts.clearRules.run(threadId);
  },

  startRun(threadId: string, userId: string, prompt: string): number {
    const info = stmts.startRun.run(threadId, userId, prompt, Date.now());
    return Number(info.lastInsertRowid);
  },

  finishRun(input: {
    id: number;
    status: 'ok' | 'error' | 'aborted';
    sessionId?: string | null;
    costUsd?: number | null;
    numTurns?: number | null;
    durationMs?: number | null;
    error?: string | null;
  }): void {
    stmts.finishRun.run({
      id: input.id,
      status: input.status,
      session_id: input.sessionId ?? null,
      cost_usd: input.costUsd ?? null,
      num_turns: input.numTurns ?? null,
      duration_ms: input.durationMs ?? null,
      error: input.error ?? null,
      ended_at: Date.now(),
    });
  },

  threadStats(threadId: string): { runs: number; cost: number } {
    const row = stmts.threadStats.get(threadId);
    return { runs: row?.runs ?? 0, cost: row?.cost ?? 0 };
  },

  /** 프로세스가 죽어 있는 동안 running 으로 남은 run 을 정리합니다. */
  markOrphanRuns(): void {
    stmts.markOrphanRuns.run(Date.now());
  },

  getMeta(key: string): string | undefined {
    return stmts.getMeta.get(key)?.value;
  },

  setMeta(key: string, value: string): void {
    stmts.setMeta.run(key, value, Date.now());
  },
};

export function closeDb(): void {
  db.close();
}
