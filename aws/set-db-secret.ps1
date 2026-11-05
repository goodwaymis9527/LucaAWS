# set-db-secret.ps1 — 把 DATABASE_URL 放進 Secrets Manager，並把 secret ARN 寫進 .aws-state/config.json
#
# deploy.ps1 每次 register task definition 時會讀 config.json 的 dbSecretArn，
# task definition 裡只寫 ARN（不含密碼），ECS 執行時把值注入成環境變數 DATABASE_URL。
#
# 三種給法（挑一種）：
#   1) 從檔讀（推薦，密碼不會留在 shell history）
#      powershell -NoProfile -ExecutionPolicy Bypass -File ./aws/set-db-secret.ps1 -FromFile C:\secrets\lucaaws-db.txt
#   2) 直接傳字串
#      powershell -NoProfile -ExecutionPolicy Bypass -File ./aws/set-db-secret.ps1 -DatabaseUrl 'postgresql://luca:pw@ep.ap-southeast-2.rds.amazonaws.com:5432/lucaaws?sslmode=require'
#   3) 交互輸入密碼，用 config.json 裡的 rdsEndpoint / rdsUser 組出 URI
#      powershell -NoProfile -ExecutionPolicy Bypass -File ./aws/set-db-secret.ps1
#
# 檔案位置的習慣：secret 檔放倉庫外（例如 C:\secrets\），不要放在 LucaAWS\ 內。

param(
    [string]$SecretName  = 'lucaaws/database',
    [string]$DatabaseUrl,
    [string]$FromFile
)

. (Join-Path $PSScriptRoot 'aws-common.ps1')

$state = Load-State

if (-not $DatabaseUrl) {
    if ($FromFile) {
        if (-not (Test-Path $FromFile)) { throw "讀不到 $FromFile" }
        $DatabaseUrl = (Get-Content $FromFile -Raw -Encoding UTF8).Trim()
    } else {
        if (-not $state.rdsEndpoint) { throw 'config.json 沒有 rdsEndpoint；先跑 aws/create-rds.ps1，或直接傳 -DatabaseUrl' }
        $pw = Read-Host 'RDS 密碼'
        $DatabaseUrl = "postgresql://$($state.rdsUser):$pw@$($state.rdsEndpoint):5432/$($state.rdsDbName)?sslmode=require"
    }
}

if ($DatabaseUrl -notmatch '^postgres(ql)?://') {
    throw 'DatabaseUrl 看起來不是 PostgreSQL 連線字串（应以 postgresql:// 開頭）'
}

Write-Host "將寫入 secret: $SecretName"
Write-Host "期望的 ARN: $(Arn 'secretsmanager' $SecretName $state.account)"
$u = [System.Uri]$DatabaseUrl
Write-Host "connection string host: $($u.HostName)"   # 只印 host，不印密碼

$existing = (AWS 'secretsmanager' @('list-secrets')).Secrets | Where-Object { $_.Name -eq $SecretName }
if ($existing) {
    $arn = $existing[0].ARN
    AWS 'secretsmanager' @('put-secret-value', '--secret-id', $SecretName, '--secret-string', $DatabaseUrl) | Out-Null
    Write-Host '更新既有 secret 的值'
} else {
    $arn = (AWS 'secretsmanager' @('create-secret', '--name', $SecretName,
        '--description', 'lucaaws DATABASE_URL',
        '--secret-string', $DatabaseUrl)).ARN
    Write-Host "建立 secret: $arn"
}

$state | Add-Member dbSecretArn $arn -Force
Save-State $state

Write-Host ''
Write-Host '完成。deploy.ps1 會把 DATABASE_URL 以 secrets 區塊（valueFrom=ARN）帶進 task definition。'
