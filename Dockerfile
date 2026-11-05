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

EXPOSE 3000

# ECS task definition 的 containerHealthCheck 會用這個；本地 docker run 也能看到狀態
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
