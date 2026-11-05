export default function RootLayout({ children }) {
  return (
    <html lang="zh-TW">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>luca-aws</title>
        <style>{`
          body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 2rem; max-width: 760px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border-bottom: 1px solid #ddd; padding: .5rem; text-align: left; vertical-align: top; }
          form { margin-top: 1.5rem; display: flex; gap: .5rem; }
          input { padding: .4rem; flex: 1; }
          button { padding: .4rem .8rem; }
          code { background: #f2f3f5; padding: .15rem .4rem; border-radius: 4px; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
