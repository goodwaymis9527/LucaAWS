# aws-common.ps1 — bootstrap.ps1 與 deploy.ps1 共用；兩個腳本都 dot-source 這檔
# 依賴：AWS CLI v2（PowerShell 內直接用 `aws`，JSON 輸出）

$ErrorActionPreference = 'Stop'

$Region     = 'ap-southeast-2'
$Project    = 'lucaaws'

# aws-common.ps1 在 LucaAWS\aws\ 內；專案根是它上一層，.aws-state 放在專案根
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StateDir    = Join-Path $ProjectRoot '.aws-state'
$StateFile   = Join-Path $StateDir 'config.json'
$TdTemplate  = Join-Path $PSScriptRoot 'task-definition.json'

function AWS {
    param([string]$service, [string[]]$call)
    $out = & aws --region $Region --output json $service @call
    if ($LASTEXITCODE -ne 0) { throw "aws $service $($call -join ' ') 失敗" }
    if (-not $out) { return $null }
    return ($out | ConvertFrom-Json)
}

function Ensure-StateDir {
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
}

function Load-State {
    Ensure-StateDir
    if (-not (Test-Path $StateFile)) { throw '.aws-state/config.json 不存在。先跑一次 bootstrap.ps1' }
    return Get-Content $StateFile -Raw | ConvertFrom-Json
}

function Save-State($state) {
    Ensure-StateDir
    $state | ConvertTo-Json -Depth 8 | Set-Content $StateFile -Encoding UTF8
    Write-Host "寫入 $StateFile"
}

# 讀 aws/task-definition.json 模板，把 {{...}} 換掉，然後 register-task-definition（每次都會產生新 revision）
function Register-TaskDefinition {
    param($State, [string]$ImageUri)

    $raw = Get-Content $TdTemplate -Raw -Encoding UTF8
    $raw = $raw.Replace('{{IMAGE_URI}}', $ImageUri)
    $raw = $raw.Replace('{{EXECUTION_ROLE_ARN}}', $State.executionRoleArn)
    $raw = $raw.Replace('{{TASK_ROLE_ARN}}', $State.taskRoleArn)
    $obj = $raw | ConvertFrom-Json

    $cd = $obj.containerDefinitions[0]

    # DATABASE_URL 的兩種給法：
    #   1) dbSecretArn（推薦）→ 放 Secrets Manager，task definition 內只寫 ARN，不含密碼
    #   2) databaseUrl（不推薦）→ 明文寫在 environment；只在私人 repo / 短期測試用
    if ($State.dbSecretArn) {
        $cd.secrets = @([pscustomobject]@{ name = 'DATABASE_URL'; valueFrom = $State.dbSecretArn })
    }
    elseif ($State.databaseUrl) {
        Write-Host '警告：DATABASE_URL 明文寫在 task definition。正式區建議改用 dbSecretArn（Secrets Manager）'
        $cd.environment = @($cd.environment + [pscustomobject]@{ name = 'DATABASE_URL'; value = $State.databaseUrl })
    }
    else {
        Write-Host '警告：state 裡沒有 dbSecretArn / databaseUrl，任務啟動時 DATABASE_URL 會缺失'
    }

    # 把 taskRoleArn（ECS execution role 已 attach）與 region 寫進環境，方便 lib/db.js 顯示
    $cd.environment = @($cd.environment + [pscustomobject]@{ name = 'DB_SSLMODE'; value = 'require' })

    $cdJson  = ConvertTo-Json -InputObject @($cd) -Depth 10 -Compress
    $logJson = ConvertTo-Json -InputObject $obj.logConfiguration -Depth 6 -Compress

    $call = @(
        'register-task-definition',
        '--family', $obj.family,
        '--network-mode', $obj.networkMode,
        '--cpu', $obj.cpu,
        '--memory', $obj.memory,
        '--requires-compatibilities', $obj.requiresCompatibilities[0],
        '--platform-version', $obj.platformVersion,
        '--runtime-platform', $obj.runtimePlatform,
        '--execution-role-arn', $State.executionRoleArn,
        '--task-role-arn', $State.taskRoleArn,
        '--log-configuration', $logJson,
        '--container-definitions', $cdJson
    )

    $r = AWS 'ecs' $call
    return $r.taskDefinition
}
