import { NextResponse } from 'next/server';
import { pingDb, dbInfo } from '../../../lib/db.js';

// ECS 的 target group / health check 打的就是這條；跑在 Node runtime（pg 需要 net 模組，edge 跑不了）
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let dbOk = false;
  let dbError = null;
  try {
    dbOk = await pingDb();
  } catch (err) {
    dbError = err.message;
  }

  // health check 若回 500，ECS 會把任務當成 unhealthy 而一直重啟；
  // 這裡一律回 200，把 DB 狀態寫在 body，讓 ALB 只看「服務活得過來」，DB 問題由內容判斷
  return NextResponse.json({ ok: dbOk, db: dbInfo(), error: dbError }, { status: 200 });
}
