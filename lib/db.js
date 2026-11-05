import pg from 'pg';
import { neon } from '@neondatabase/serverless';

// 一份介面、兩種 driver，開發與正式只靠環境變數切換：
//   DB_DRIVER=neon（開發，預設）→ @neondatabase/serverless 的 HTTP transport
//       本機 5432 被封（實測 TCP timeout），HTTP 走 443 可通，所以開發用這個最省事
//   DB_DRIVER=pg（正式，AWS）→ node-postgres Pool，接 RDS（VPC 內 5432 直通）
//
// 兩者回傳格式不同：pg 回 Result 物件（.rows），neon 的 query() 直接回 rows 陣列。
// 這裡統一成 rows 陣列，app 端只需要認得 query(text, params)。
const driver = (process.env.DB_DRIVER || 'neon').toLowerCase();
const connectionString = process.env.DATABASE_URL;

let pool;
let sql;

function getClient() {
  if (!connectionString) {
    throw new Error('DATABASE_URL 沒有設定。開發請檢查 .env.local，正式區請檢查 ECS 任務的環境變數');
  }

  if (driver === 'pg') {
    if (!pool) {
      pool = new pg.Pool({
        connectionString,
        max: Number(process.env.PG_POOL_MAX) || 5,
        // Fargate 任務被停止時讓連線能正常收尾，不會整包挂住
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10000,
      });
    }
    return (text, params) => pool.query(text, params);
  }

  if (!sql) sql = neon(connectionString);
  return (text, params) => sql.query(text, params);
}

export async function query(text, params = []) {
  const result = await getClient()(text, params);
  return result.rows ?? result;
}

// 只用參數化，不拼字串 SQL：$1 由 driver 送，不會字串插值
export async function listItems(limit = 50) {
  const capped = Math.min(Number(limit) || 50, 200);
  return query('SELECT id, title, body, created_at FROM items ORDER BY id DESC LIMIT $1', [capped]);
}

export async function addItem(title, body = '') {
  const rows = await query(
    'INSERT INTO items (title, body) VALUES ($1, $2) RETURNING id, title, body, created_at',
    [title, body]
  );
  return rows[0];
}

export async function pingDb() {
  const rows = await query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

// 給頁面與 /api/health 顯示「現在接的是哪一邊」，排錯時很好用
export function dbInfo() {
  return {
    driver,
    region: process.env.AWS_REGION || 'local',
    env: process.env.APP_ENV || 'development',
    // 只印 host 部分，不要把含密碼的完整字串帶出去
    host: connectionString ? new URL(connectionString).hostname : null,
  };
}
