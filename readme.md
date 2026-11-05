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
  aws\aws-common.js     SDK 版共用函式（region / config.json / task definition 組裝）
  aws\bootstrap.js      只跑一次，把 AWS 資源建起來
  aws\deploy.js         一鍵部署：build → push ECR（SDK 拿 token）→ 新 revision → update-service
  aws\rds.js            一次性：建 RDS + 兩個 SG（RDS 只放行來自 task SG 的 5432）
  aws\secret.js         把 DATABASE_URL 放 Secrets Manager，dbSecretArn 寫進 config.json
  aws\status.js         看 service / task / 最近日誌（不需要 CLI）
  aws\task-definition.json  Fargate 模板（欄位直接對應 RegisterTaskDefinitionCommand）
  bootstrap.ps1         （替代版，需要 AWS CLI）只跑一次，把 AWS 資源建起來
  deploy.ps1            （需要 AWS CLI）一鍵部署
  aws\create-rds.ps1    （需要 AWS CLI）一次性：建 RDS + 兩個 SG
  aws\set-db-secret.ps1 （需要 AWS CLI）把 DATABASE_URL 放 Secrets Manager
  schema.sql            items 表
  scripts\migrate.js    套 schema（DB_DRIVER 切換 pg / neon）
  lib\db.js             統一 query(text, params)，dev=Neon、prod=RDS
  app\layout.jsx
  app\page.jsx          列表 + 新增表单
  app\api\health\route.js   ECS / ALB health check
  app\api\items\route.js    GET / POST
  public\robots.txt
  aws\aws-common.ps1        （CLI 版）bootstrap 與 deploy 共用函式
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

1. **不需要裝 AWS CLI**。SDK 自己找憑據，順序是：
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 環境變數 → `C:\Users\g01943\.aws\credentials`（ini）。
   本機 `.aws` 目前是空的，要先建 `C:\Users\g01943\.aws\credentials`：

   ```ini
   [default]
   aws_access_key_id = AKIA...
   aws_secret_access_key = ...
   region = ap-southeast-2
   ```

   （用 IAM user / role 的 key；這個檔不在倉庫內，也不要 commit。）

2. `npm install`（`@aws-sdk/*` 列在 devDependencies，所以 Docker 鏡像內不會裝，只有本機跑腳本時用到）。

3. 順序：**rds → bootstrap → secret → deploy**。三個腳本共用 `.aws-state/config.json`，已有欄位會被沿用。

   ```powershell
   node aws/rds.js          # 建 RDS（default VPC、private、encrypted）+ 兩個 SG（RDS 只放行來自 task SG 的 5432）
   node aws/bootstrap.js    # 建 ECR / log group / IAM roles / task SG / ALB + target group + listener / cluster / service
   node aws/secret.js       # 把 DATABASE_URL 放 Secrets Manager，dbSecretArn 寫進 config.json
   node aws/deploy.js       # 第一次部署
   ```

   也可以用 npm scripts：`npm run aws:rds`、`npm run aws:bootstrap`、`npm run aws:secret`、`npm run deploy`、`npm run aws:status`。

### 之後每次部署（一鍵）

```powershell
node aws/deploy.js
# 可選：node aws/deploy.js --skip-build   或   --tag=dev
```

`npm ci` → `next build` → `docker build` → `docker push`（`latest` + 時間戳 tag，ECR token 由 SDK 取得後餵給 `docker login`）→
register 新 task definition revision → `update-service(forceNewDeployment)`。

看部署狀態：

```powershell
node aws/status.js            # service desired/running、task health、最近日誌
node aws/status.js --logs=20
```

正式網址是 ALB 的 DNS（bootstrap 會印出來，也記在 config.json）：`http://<alb-dns>/`

### 套 schema（本機連不上 RDS）

本機 outbound 5432 被封且 RDS 是 private，所以 `npm run db:migrate` 在本機一定失敗。要在 VPC 內跑：
部署後用控制台的 ECS → 任務 → **Execute command**（或 CloudShell 的 `aws ecs execute-command`）執行：

```
node scripts/migrate.js
```

（Dockerfile 已把 `scripts/` 與 `schema.sql` 進鏡像，service 開了 `enableExecuteCommand`，task role 有 `ssmmessages` 權限。）

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
- **兩條路并存**：`aws/*.js`（AWS SDK，本機只要有 Node）是主要路；`*.ps1` 是需要 AWS CLI 的替代版，函式與欄位名稱一致，跑哪一條都會寫同一份 `.aws-state/config.json`。
- `.ps1` 檔要存成 **UTF-8 with BOM**：PowerShell 5.1 讀沒 BOM 的 UTF-8 會把中文當成 ANSI，字串亂掉甚至解析失敗
  （`gitGithubPush.bat` 則相反：它需要 CRLF，靠 `chcp 65001` 顯示中文）。
- 這版 SDK 的 `@aws-sdk/client-ecs` 沒有 `DescribeEventsCommand`（ECS events 在 v3 這版被拿掉），所以 `aws/status.js` 改讀 CloudWatch Logs 的最近幾行。
- SDK 需要 Node ≥22 才會繼續收到更新（現在本機是 Node 20.20，仍可跑，只是有 NodeVersionSupportWarning）。
