import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { neon } from '@neondatabase/serverless';

// Schema 用這份腳本管理，不在請求路徑裡跑 ensureSchema()
// 遷移要用「直接連線」：PgBouncer transaction mode 不支援 session 級行為（SET、prepated statements）
//
// 連線選擇（與 lib/db.js 同一套 DB_DRIVER 邏輯）：
//   DB_DRIVER=pg   → 本機若能把 5432 打通（RDS 在 VPC 內、或自己有跳板）就用 pg 直接連線
//   DB_DRIVER=neon → 本機 5432 被封時改走 HTTP transport（443），DDL 一樣能跑
const driver = (process.env.DB_DRIVER || 'neon').toLowerCase();
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL 沒有設定。用 node --env-file=.env.local scripts/migrate.js 執行');
}

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

async function run() {
  if (driver === 'pg') {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
    await client.connect();
    for (const statement of statements) {
      await client.query(statement);
      console.log('✔ ' + statement.replace(/\s+/g, ' ').slice(0, 60));
    }
    await client.end();
    return;
  }

  const sql = neon(connectionString);
  for (const statement of statements) {
    await sql.query(statement);
    console.log('✔ ' + statement.replace(/\s+/g, ' ').slice(0, 60));
  }
}

run().catch((err) => {
  console.error('❌ migrate 失敗：' + err.message);
  process.exit(1);
});
