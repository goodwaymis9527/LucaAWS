# create-rds.ps1 — 建立 RDS PostgreSQL（正式區資料庫）與兩個 security group
#
# 這一腳本做四件事：
#   1) 找 default VPC 與它的 subnets，必要的時候建 RDS DB subnet group
#   2) 建 SG：lucaaws-task（給 Fargate 任務）與 lucaaws-rds（給 RDS，只放行來自 task SG 的 5432）
#   3) 建 RDS instance（private，不公開存取）
#   4) 把 endpoint 與 SG id 寫進 .aws-state/config.json（set-db-secret.ps1 與 bootstrap.ps1 會讀）
#
# 執行（密碼用環境變數帶，不要寫死在檔內）：
#   $env:RDS_PASSWORD = '你的密碼'
#   powershell -NoProfile -ExecutionPolicy Bypass -File ./aws/create-rds.ps1
#
# 注意：本機 5432 被封（實測 TCP timeout），所以建好之後本機 psql 連不上 RDS；
#       schema 要透過 VPC 內跑（deploy 後用 aws ecs execute-command 執行 node scripts/migrate.js）。

param(
    [string]$DbName          = 'lucaaws',
    [string]$MasterUser      = 'luca',
    [string]$MasterPassword  = $env:RDS_PASSWORD,
    [string]$InstanceClass   = 'db.t4g.micro',
    [int]$AllocatedStorage   = 20
)

. (Join-Path $PSScriptRoot 'aws-common.ps1')

if (-not $MasterPassword) {
    throw '請先設定 $env:RDS_PASSWORD，或用 -MasterPassword 傳入（這個值不會寫進倉庫）'
}

$state = Load-State

Write-Host '=== 1) VPC / subnets / DB subnet group ==='
$vpc = (AWS 'ec2' @('describe-vpcs', '--filters', 'Name=isDefault,Values=true')).Vpcs | Select-Object -First 1
if (-not $vpc) { throw '此區域沒有 default VPC' }
$subnets = (AWS 'ec2' @('describe-subnets', '--filters', "Name=vpc-id,Values=$($vpc.VpcId)", 'Name=state,Values=available')).Subnets | ForEach-Object { $_.SubnetId }
$state | Add-Member vpcId   $vpc.VpcId     -Force
$state | Add-Member vpcCidr $vpc.CidrBlock -Force
$state | Add-Member subnets $subnets       -Force

$snGroups = (AWS 'rds' @('describe-db-subnet-groups')).DBSubnetGroups
$snGroup = $snGroups | Where-Object { $_.DBSubnetGroupName -eq $Project }
if (-not $snGroup) {
    $snGroup = $snGroups | Where-Object { $_.VpcId -eq $vpc.VpcId } | Select-Object -First 1
}
if (-not $snGroup) {
    $snJson = ($subnets | ForEach-Object { [pscustomobject]@{ SubnetIdentifier = $_ } }) | ConvertTo-Json -Compress
    $snGroup = (AWS 'rds' @('create-db-subnet-group', '--db-subnet-group-name', $Project,
        '--db-subnet-group-description', 'lucaaws RDS subnets',
        '--subnet-ids', $snJson)).DBSubnetGroup
}
Write-Host "DB subnet group: $($snGroup.DBSubnetGroupName)"

Write-Host '=== 2) Security groups ==='
function Ensure-Sg([string]$name, [string]$desc) {
    $sgs = (AWS 'ec2' @('describe-security-groups', '--filters', "Name=vpc-id,Values=$($vpc.VpcId)", 'Name=group-name,Values=' + $name)).SecurityGroups
    if ($sgs) { return $sgs[0].GroupId }
    $sg = AWS 'ec2' @('create-security-group', '--group-name', $name, '--description', $desc, '--vpc-id', $vpc.VpcId)
    Write-Host "建立 SG: $name"
    return $sg.GroupId
}

$taskSg = Ensure-Sg "$Project-task" 'ECS Fargate task ENI'
$rdsSg  = Ensure-Sg "$Project-rds"  'RDS PostgreSQL'

# task SG：放行 ALB → 任務的 3000（同 SG 與 VPC 內）；RDS SG：只接受來自 task SG 的 5432
try {
    AWS 'ec2' @('authorize-security-group-ingress', '--group-id', $taskSg, '--cidr', $vpc.CidrBlock, '--port', '3000', '--protocol', 'tcp') | Out-Null
} catch { Write-Host '（task SG 的 3000 規則已存在，略過）' }
try {
    AWS 'ec2' @('authorize-security-group-ingress', '--group-id', $taskSg, '--source-group', $taskSg, '--port', '3000', '--protocol', 'tcp') | Out-Null
} catch { Write-Host '（task SG 同 SG 規則已存在，略過）' }
try {
    AWS 'ec2' @('authorize-security-group-ingress', '--group-id', $rdsSg, '--source-group', $taskSg, '--port', '5432', '--protocol', 'tcp') | Out-Null
} catch { Write-Host '（RDS SG 的 5432 規則已存在，略過）' }

$state | Add-Member taskSgId $taskSg -Force
$state | Add-Member rdsSgId  $rdsSg  -Force

Write-Host '=== 3) RDS instance ==='
$existing = (AWS 'rds' @('describe-db-instances')).DBInstances | Where-Object { $_.DBInstanceIdentifier -eq $Project }
if ($existing) {
    Write-Host "RDS 已存在: $($existing[0].DBInstanceIdentifier)"
    $inst = $existing[0]
} else {
    $inst = (AWS 'rds' @('create-db-instance',
        '--db-instance-identifier', $Project,
        '--engine', 'postgres',
        '--engine-version', '17',
        '--db-name', $DbName,
        '--master-username', $MasterUser,
        '--master-user-password', $MasterPassword,
        '--db-instance-class', $InstanceClass,
        '--allocated-storage', "$AllocatedStorage",
        '--storage-type', 'gp3',
        '--vpc-security-group-ids', $rdsSg,
        '--db-subnet-group-name', $snGroup.DBSubnetGroupName,
        '--publicly-accessible', 'false',
        '--multi-az', 'false',
        '--storage-encrypted', 'true',
        '--backup-retention-period', '7')).DBInstance
    Write-Host 'RDS 建立中（約 5-10 分鐘），此腳本不等它變成 available；可以用下面指令看：'
    Write-Host "  aws --region $Region rds describe-db-instances --db-instance-identifier $Project --query 'DBInstances[0].Status' --output text"
}

$endpoint = if ($inst.Endpoint) { $inst.Endpoint.Address } else { $null }
$state | Add-Member rdsEndpoint $endpoint -Force
$state | Add-Member rdsDbName   $DbName   -Force
$state | Add-Member rdsUser     $MasterUser -Force

Save-State $state
Write-Host ''
Write-Host '=== 完成 ==='
Write-Host "endpoint: $endpoint"
Write-Host "下一步：powershell -NoProfile -ExecutionPolicy Bypass -File ./aws/set-db-secret.ps1"
