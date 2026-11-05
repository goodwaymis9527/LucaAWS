import { listItems, dbInfo, pingDb } from '../lib/db.js';

// ECS/Fargate 上不要靜態快取：build 時的結果會被固定，之後換資料庫或改資料都會看到舊內容
export const dynamic = 'force-dynamic';

export default async function Page() {
  const items = await listItems(50);
  const info = dbInfo();

  // 連不上資料庫時頁面要還能開（顯示錯誤而不是整個 500），ECS 的 health check 才不會誤判
  let dbOk = false;
  let dbError = null;
  try {
    dbOk = await pingDb();
  } catch (err) {
    dbError = err.message;
  }

  return (
    <main>
      <h1>LucaAWS（正式區）</h1>
      <p>
        資料來自 PostgreSQL <code>items</code> 表｜
        driver=<code>{info.driver}</code>｜
        env=<code>{info.env}</code>｜
        region=<code>{info.region}</code>｜
        DB <code>{dbOk ? 'OK' : '✗ ' + dbError}</code>
      </p>

      <table>
        <tr>
          <th>#</th>
          <th>標題</th>
          <th>內文</th>
          <th>建立時間</th>
        </tr>
        {items.length === 0 && (
          <tr>
            <td colSpan="4">還沒有資料，下方表单新增一筆</td>
          </tr>
        )}
        {items.map((item) => (
          <tr key={item.id}>
            <td>{item.id}</td>
            <td>{item.title}</td>
            <td>{item.body}</td>
            <td>{new Date(item.created_at).toISOString()}</td>
          </tr>
        ))}
      </table>

      {/* 純表單 POST，不需要 client JS；route handler 處理完會 303 轉回本页 */}
      <form method="post" action="/api/items">
        <input name="title" placeholder="標題" required maxLength="120" />
        <textarea name="body" placeholder="內文" rows="4" maxLength="2000"></textarea>
        <button type="submit">新增</button>
      </form>
    </main>
  );
}
