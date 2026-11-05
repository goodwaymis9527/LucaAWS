# luca-aws — 正式區（Next.js + PostgreSQL，部署到 AWS ECS Fargate）

開發區是 `..\LucaWebVercel`（Vercel + Neon），這裡是**正式區**：
Docker 镜像 → ECR → ECS Fargate，資料庫走 **AWS RDS（PostgreSQL 17）**。

## 目錄

```
LucaAWS\
  package.json          output: 'standalone'（Docker/ECS 用）
  next.config.js
  .gitignore            .env / node_modules / .next / .aws-state
  .env.example          開發用（Neon）
  .dockerignore
  Dockerfile            multi-stage：build → runtime（只帶 standalone）
  buildspec.yml         可选：走 CodePipeline 自動部署
  bootstrap.ps1         只跑一次，把 AWS 資源建起來
  deploy.ps1            一鍵部署：build → push ECR → 新 revision → update-service
  schema.sql            items 表
  scripts\migrate.js    套 schema（DB_DRIVER 切換 pg / neon）
  lib\db.js             統一 query(text, params)，dev=Neon、prod=RDS
  app\layout.jsx
  app\page.jsx          列表 + 新增表单
  app\api\health\route.js   ECS / ALB health check
  app\api\items\route.js    GET / POST
  public\robots.txt
  aws\task-definition.json  Fargate task definition 模板
  aws\aws-common.ps1        bootstrap 與 deploy 共用函式
```

## 開發區（本機）

本機 outbound 5432 被封（實測 TCP timeout），所以開發走 `@neondatabase/serverless` 的 HTTP transport（443）：

```powershell
copy .env.example .env.local     # 填入 Neon 的 connection string
npm install
npm run dev                      # http://127.0.0.1:3000
npm run db:migrate               # 套 schema
```

`DB_DRIVER=neon`（預設）→ HTTP transport；`DB_DRIVER=pg` → node-postgres Pool（RDS 在 VPC 內可直通）。
`lib/db.js` 把兩種 driver 統一成同一個 `query(text, params)`，程式碼不用改。

## 正式區（AWS）

### 一次性的準備

1. `aws configure`（AWS CLI v2），區域 `ap-southeast-2`。
2. RDS PostgreSQL 建在 **default VPC**（與 ECS 同一個 VPC），SG 放行 5432。
3. `DATABASE_URL` 放 Secrets Manager（建議），把 secret ARN 寫進 `.aws-state/config.json` 的 `dbSecretArn`。
4. 跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./bootstrap.ps1
```

會建立 ECR repository、CloudWatch log group、IAM roles、ALB + target group + listener、ECS cluster、第一版 task definition、service，並把 ARN 寫進 `.aws-state/config.json`。

### 之後每次部署（一鍵）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./deploy.ps1
```

`npm ci` → `next build` → `docker build` → `docker push`（`latest` + 時間戳 tag）→
register 新 task definition revision → `update-service --force-new-deployment`。

看部署狀態：

```powershell
aws --region ap-southeast-2 ecs describe-services --cluster lucaaws --services lucaaws
aws --region ap-southeast-2 ecs describe-events --cluster lucaaws
```

正式網址是 ALB 的 DNS（bootstrap 會印出來，也記在 config.json）：`http://<alb-dns>/`

## 需要的環境變數

| 變數 | 開發 | 正式 |
|---|---|---|
| `DATABASE_URL` | Neon connection string | RDS endpoint |
| `DB_DRIVER` | `neon` | `pg` |
| `APP_ENV` | `development` | `production` |
| `AWS_REGION` | `ap-southeast-2` | `ap-southeast-2` |
| `PG_POOL_MAX` | 5 | 5 |
| `PORT` / `HOSTNAME` | （next start 預設） | `3000` / `0.0.0.0` |

## 注意

- **secret 不入倉庫**：`.env*` 與 `.aws-state/` 都在 `.gitignore`。
- ECS 的 task definition 建議用 Secrets Manager（`dbSecretArn`），不要把含密碼的 URL 寫成明文 environment。
- Fargate 任務與 RDS 必須同一 VPC；跨 VPC 或從本機連 RDS 會被 SG / 網路封鎖。
- 本地 5432 被封，所以 RDS 只能從 VPC 內（ECS、Lambda、或跳板）連；本機要測得靠 Neon 或 SSH 隧道。
