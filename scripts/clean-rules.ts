/**
 * 규칙 테이블 정리: 옛 버전이 만든 잘못된 키를 제거합니다.
 *   npx tsx scripts/clean-rules.ts          # 미리보기
 *   npx tsx scripts/clean-rules.ts --apply  # 실제 삭제
 *
 * 예전 firstWord() 는 `MYSQL_PWD=secret mysql ...` 의 첫 토큰을 그대로 써서
 * 비밀번호·API 키가 규칙 이름으로 저장됐습니다. 매칭도 되지 않아 무용지물입니다.
 */
process.env['DISCORD_TOKEN'] ||= 'cleanup';
process.env['DISCORD_CLIENT_ID'] ||= 'cleanup';
process.env['ALLOWED_USER_IDS'] ||= '1';
process.env['LOG_LEVEL'] ||= 'error';

const Database = (await import('better-sqlite3')).default;
const { config } = await import('../src/config.js');

const apply = process.argv.includes('--apply');
const db = new Database(config.runtime.dbPath);

/** 정상적인 규칙 키인지 검사합니다. */
function isValid(rule: string): boolean {
  if (rule.startsWith('Tool:')) return /^Tool:[\w.-]+$/.test(rule);
  if (/^(Edit|Write|MultiEdit|NotebookEdit):outside$/.test(rule)) return true;
  if (!rule.startsWith('Bash:')) return false;
  const bin = rule.slice(5);
  if (/https?/i.test(bin)) return false;

  // 절대·상대 경로 실행 파일은 길이에 관계없이 유효합니다.
  // (`MY/opt/...`, `D/var/...`, `ROOT/Users/...` 처럼 잘린 것은 / 로 시작하지 않아 걸러집니다.)
  if (/^(\/|\.\.?\/)/.test(bin)) return /^[\w.\-/]+$/.test(bin);

  // 그 외에는 평범한 명령 이름이어야 합니다.
  if (!/^[\w.\-]+$/.test(bin)) return false;
  // 대문자로 시작하는 긴 토큰은 해시·API 키 잔재입니다.
  if (/^[A-Z][A-Za-z0-9_]{9,}$/.test(bin)) return false;
  // 전부 대문자인 식별자는 환경변수 잔재입니다 (실제 명령에는 거의 없습니다).
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(bin)) return false;
  return true;
}

const rows = db.prepare('SELECT thread_id, rule FROM thread_rules').all() as Array<{
  thread_id: string;
  rule: string;
}>;
const bad = rows.filter((r) => !isValid(r.rule));

console.log(`전체 ${rows.length}건 · 삭제 대상 ${bad.length}건\n`);
for (const r of [...new Set(bad.map((b) => b.rule))]) {
  console.log(`  ✗ ${r.length > 60 ? r.slice(0, 60) + '…' : r}`);
}

if (!apply) {
  console.log('\n미리보기입니다. 실제로 지우려면 --apply 를 붙이세요.');
} else {
  const del = db.prepare('DELETE FROM thread_rules WHERE thread_id = ? AND rule = ?');
  const tx = db.transaction(() => bad.forEach((b) => del.run(b.thread_id, b.rule)));
  tx();
  console.log(`\n✅ ${bad.length}건 삭제 완료. 남은 규칙 ${rows.length - bad.length}건.`);
}
db.close();
