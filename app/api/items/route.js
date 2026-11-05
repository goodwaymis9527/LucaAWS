import { NextResponse } from 'next/server';
import { addItem, listItems } from '../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    return NextResponse.redirect(new URL('/', req.url), 303);
  }
  return NextResponse.json(item, { status: 201 });
}
