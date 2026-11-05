# ── 1) build：只在这里裝 dev 依賴（next build 需要）──
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ── 2) runtime：只帶 standalone 輸出，镜像小、啟動快 ──
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# standalone 裡已含 server.js 與實際用到的依賴
COPY --from=build /app/package.json ./
RUN npm install --omit=dev

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# migrate 要在 VPC 內跑（本機 5432 被封，連不上 RDS）：
#   aws ecs execute-command --cluster lucaaws --task <taskArn> --container lucaaws --command "node scripts/migrate.js"
# 所以 scripts/ 與 schema.sql 也要進 runtime 鏡像
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/schema.sql ./schema.sql

# package.json 再複製一次：standalone 內的 package.json 可能不含 "type": "module"，
# 而 scripts/migrate.js 是 ESM（import），缺 type 就會被當成 CJS 而報錯
COPY --from=build /app/package.json ./package.json

EXPOSE 3000

# ECS task definition 的 containerHealthCheck 會用這個；本地 docker run 也能看到狀態
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
