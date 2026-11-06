import { NextResponse } from 'next/server';
import { addItem, listItems } from '../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ALB / 反向代理後面：req.url 的 origin 是「容器自己看到的」 HOSTNAME:PORT（鏡像裡是 0.0.0.0:3000），
// 所以直接 new URL('/', req.url) 會把瀏覽器 303 導到 http://0.0.0.0:3000/ → Firefox「無法連線到伺服器」。
// 導向的 base 要用 client 實際看到的來源：x-forwarded-host → host → referer，都沒才退回 req.url。
function clientOrigin(req) {
  const proto = req.headers.get('x-forwarded-proto') || 'http';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  if (host) return new URL(`${proto}://${host}`);
  const referer = req.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer);
    } catch {
      // 不合法的 referer 就忽略，退回 req.url
    }
  }
  return new URL(req.url);
}

export async function GET(req) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit')) || 50;
  return NextResponse.json(await listItems(limit));
}

export async function POST(req) {
  // 表單送出是 form-encoded，fetch 送出是 JSON，兩種都支援
  let title = '';
  let body = '';
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const payload = await req.json();
    title = String(payload.title ?? '').trim();
    body = String(payload.body ?? '');
  } else {
    const form = await req.formData();
    title = String(form.get('title') ?? '').trim();
    body = String(form.get('body') ?? '');
  }

  if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 });
  if (title.length > 120) return NextResponse.json({ error: 'title too long' }, { status: 400 });

  const item = await addItem(title, body);

  // 表單提交要 303，讓瀏覽器改用 GET 回主页（避免重新整理重複新增）
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    return NextResponse.redirect(new URL('/', clientOrigin(req)), 303);
  }
  return NextResponse.json(item, { status: 201 });
}
