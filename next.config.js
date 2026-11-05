/**
 * output: 'standalone' 是给 Docker/ECS 用的：
 * next build 會產出 .next/standalone，里面含 server.js 與實際被用到的依賴，
 * 镜像裡只需要 node + 這份輸出，不用把整個 node_modules 複製進去。
 */
const nextConfig = {
  output: 'standalone',
};

export default nextConfig;
