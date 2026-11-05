# deploy.ps1 — 一鍵部署：build → docker build → push ECR → 註冊新的 task definition revision → 更新 service
#
# 第一次要先跑 bootstrap.ps1（建立 ECR/cluster/service 並產生 .aws-state/config.json）。
# 之後每次改程式碼，只要：
#   powershell -NoProfile -ExecutionPolicy Bypass -File ./deploy.ps1
#
# 可选参数：
#   -SkipBuild   只推镜像（.next/standalone 已經 build 過）
#   -Tag mytag   镜像 tag（預設 latest，同時記錄時間戳 tag 方便回滾）

param(
    [switch]$SkipBuild,
    [string]$Tag = 'latest'
)

. (Join-Path $PSScriptRoot 'aws/aws-common.ps1')

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

$state = Load-State
if (-not $state.ecrUri)   { throw 'config.json 缺少 ecrUri；先跑 bootstrap.ps1' }
if (-not $state.cluster)  { throw 'config.json 缺少 cluster；先跑 bootstrap.ps1' }
if (-not $state.service)  { throw 'config.json 缺少 service；先跑 bootstrap.ps1' }

Write-Host "專案 $repoRoot"
Write-Host "ECR  $state.ecrUri"

# 1) build
if (-not $SkipBuild) {
    Write-Host '=== 1) npm install + next build ==='
    if (Test-Path (Join-Path $repoRoot 'package-lock.json')) {
        npm ci
    } else {
        npm install
    }
    if ($LASTEXITCODE -ne 0) { throw 'npm install 失敗' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'next build 失敗' }
} else {
    Write-Host '=== 1) 跳過 build（用現有 .next）==='
}

# 2) docker build（Dockerfile 用 multi-stage，runtime 只有 standalone 輸出）
Write-Host '=== 2) docker build ==='
docker build -t "$($state.project):$Tag" .
if ($LASTEXITCODE -ne 0) { throw 'docker build 失敗' }

# 3) push ECR
Write-Host '=== 3) push 到 ECR ==='
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
docker tag "$($state.project):$Tag" "$($state.ecrUri):$Tag"
docker tag "$($state.project):$Tag" "$($state.ecrUri):$stamp"

# 登入 ECR（每次部署前新鮮拿 token）
$loginPassword = aws --region $state.region ecr get-login-password
if ($LASTEXITCODE -ne 0) { throw 'aws ecr get-login-password 失敗（检查 aws configure 與 IAM 權限）' }
$loginPassword | docker login --username AWS --password-stdin ($state.ecrUri.Split('/')[0])
if ($LASTEXITCODE -ne 0) { throw 'docker login 失敗' }

docker push "$($state.ecrUri):$Tag"
docker push "$($state.ecrUri):$stamp"

# 4) 新的 task definition revision（image 指到這次 push 的镜像）
Write-Host '=== 4) register task definition revision ==='
$td = Register-TaskDefinition -State $state -ImageUri "$($state.ecrUri):$stamp"
$state | Add-Member taskFamily   $td.family   -Force
$state | Add-Member taskRevision $td.revision -Force
$state | Add-Member lastImage    "$($state.ecrUri):$stamp" -Force

# 5) 讓 service 用新 revision 並強制換任務（rolling，舊任務在新任務 healthy 後才停）
Write-Host '=== 5) update service ==='
$tdRef = "$($td.family):$($td.revision)"
AWS 'ecs' @('update-service', '--cluster', $state.cluster, '--service', $state.service,
    '--task-definition', $tdRef, '--force-new-deployment') | Out-Null
$state | Add-Member lastDeploymentAt (Get-Date).ToString('s') -Force
Save-State $state

Write-Host ''
Write-Host '=== 部署完成 ==='
Write-Host "task definition: $tdRef"
Write-Host "image:           $($state.ecrUri):$stamp"
Write-Host "正在滾動更新，任務起來後看：http://$($state.albDns)/api/health"
Write-Host '看事件：aws --region ap-southeast-2 ecs describe-events --cluster ' + $state.cluster
