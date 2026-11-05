# bootstrap.ps1 — 只跑一次：把 AWS 端資源建起來，之後每次部署只用 deploy.ps1
#
# 建立：ECR repository、CloudWatch log group、兩個 IAM role、ALB + target group + listener、
#       ECS cluster、第一版 task definition、ECS service
# 把所有 ARN 寫進 .aws-state/config.json，deploy.ps1 直接讀，不必重複猜 ARN。
#
# 需求：AWS CLI v2（已 aws configure）、ap-southeast-2 有 default VPC（RDS 要放同一 VPC）、
#       權限含 ecr / ecs / elasticloadbalancing / iam / logs / ec2 / sts
#
# 執行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File ./bootstrap.ps1

. (Join-Path $PSScriptRoot 'aws/aws-common.ps1')

$ErrorActionPreference = 'Stop'

Write-Host '=== 0) 檢查 ==='
if (-not (Get-Command aws -ErrorAction SilentlyContinue))    { throw '找不到 aws CLI（請安裝 AWS CLI v2 並 aws configure）' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw '找不到 docker（deploy.ps1 需要 Docker）' }

$acct  = (AWS 'sts' @('get-caller-identity')).Account
$state = [pscustomobject]@{ region = $Region; project = $Project; account = $acct }
Write-Host "帳號 $acct / 區域 $Region / 專案 $Project"

Write-Host '=== 1) VPC（RDS 必須與 ECS 同一個 VPC）==='
$vpc = (AWS 'ec2' @('describe-vpcs', '--filters', 'Name=isDefault,Values=true')).Vpcs | Select-Object -First 1
if (-not $vpc) { throw '此區域沒有 default VPC；請先建 VPC 或手動把 vpcId 寫進 config.json' }
$subnets = (AWS 'ec2' @('describe-subnets', '--filters', "Name=vpc-id,Values=$($vpc.VpcId)", 'Name=state,Values=available')).Subnets | ForEach-Object { $_.SubnetId }
if (-not $subnets) { throw 'VPC 內沒有可用 subnet' }
$state | Add-Member vpcId   $vpc.VpcId     -Force
$state | Add-Member vpcCidr $vpc.CidrBlock -Force
$state | Add-Member subnets $subnets       -Force
Write-Host "VPC $($vpc.VpcId)  $($vpc.CidrBlock)  subnet 數=$($subnets.Count)"

Write-Host '=== 2) ECR ==='
$repo = (AWS 'ecr' @('describe-repositories', '--repository-names', $Project)).repositories | Select-Object -First 1
if (-not $repo) {
    $repo = (AWS 'ecr' @('create-repository', '--repository-name', $Project,
        '--image-tag-mutability', 'SIMPLIFIED',
        '--image-scanning-configuration', 'scanOnPush=true')).repository
    Write-Host "建立 ECR: $($repo.repositoryUri)"
}
$state | Add-Member ecrUri $repo.repositoryUri -Force

Write-Host '=== 3) CloudWatch log group ==='
try { AWS 'logs' @('create-log-group', '--log-group-name', "/ecs/$Project") | Out-Null }
catch { Write-Host '（已存在，略過）' }

Write-Host '=== 4) IAM roles ==='
$trust = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

function Ensure-Role([string]$name) {
    try { return (AWS 'iam' @('get-role', '--role-name', $name)).Role.Arn }
    catch {
        $arn = (AWS 'iam' @('create-role', '--role-name', $name, '--assume-role-policy-document', $trust)).Role.Arn
        Write-Host "建立 role: $name"
        return $arn
    }
}

$state | Add-Member executionRoleArn (Ensure-Role "$Project-execution") -Force
$state | Add-Member taskRoleArn      (Ensure-Role "$Project-task")      -Force

# 執行角色：拉 ECR 镜像 + 寫 CloudWatch Logs
try { AWS 'iam' @('attach-role-policy', '--role-name', "$Project-execution", '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy') | Out-Null }
catch { Write-Host '（policy 已 attach，略過）' }

# task role：app 自己用到的權限（讀 Secrets Manager / SSM）
$secretPolicy = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue","ssm:GetParameter"],"Resource":"*"}]}'
try { AWS 'iam' @('put-role-policy', '--role-name', "$Project-task", '--policy-name', "$Project-app", '--policy-document', $secretPolicy) | Out-Null }
catch { Write-Host '（role policy 已存在，略過）' }

Write-Host '=== 5) ALB + target group + listener ==='
$albs = (AWS 'elasticloadbalancing' @('describe-load-balancers')).LoadBalancers | Where-Object { $_.LoadBalancerName -eq $Project }
if ($albs) {
    $albArn = $albs[0].LoadBalancerArn
    $albDns = $albs[0].DNSName
    Write-Host "ALB 已存在: $albArn"
} else {
    $alb = AWS 'elasticloadbalancing' @('create-load-balancer', '--name', $Project, '--type', 'application',
        '--subnets', ($subnets -join ' '), '--scheme', 'internet-facing')
    $albArn = $alb.LoadBalancerArn
    for ($i = 0; $i -lt 30; $i++) {
        $d = (AWS 'elasticloadbalancing' @('describe-load-balancers', '--load-balancer-arns', $albArn)).LoadBalancers
        if ($d[0].State -eq 'active') { break }
        Start-Sleep -Seconds 5
    }
    $albDns = $d[0].DNSName
    Write-Host "ALB: $albArn"
}

$tgs = (AWS 'elasticloadbalancing' @('describe-target-groups')).TargetGroups | Where-Object { $_.TargetGroupName -eq $Project }
if (-not $tgs) {
    $tgs = (AWS 'elasticloadbalancing' @('create-target-group', '--name', $Project,
        '--protocol', 'HTTP', '--port', '3000', '--vpc-id', $vpc.VpcId,
        '--target-type', 'ip',
        '--health-check-path', '/api/health',
        '--health-check-protocol', 'HTTP',
        '--deregistration-delay-timeout', '60')).TargetGroups
}
$tgArn = $tgs[0].TargetGroupArn

if (-not (AWS 'elasticloadbalancing' @('describe-listeners', '--load-balancer-arn', $albArn)).Listeners) {
    AWS 'elasticloadbalancing' @('create-listener', '--load-balancer-arn', $albArn,
        '--protocol', 'HTTP', '--port', '80',
        '--default-actions', "Type=forward,TargetGroupArn=$tgArn") | Out-Null
    Write-Host '建立 listener :80'
}

$state | Add-Member albArn         $albArn -Force
$state | Add-Member targetGroupArn $tgArn  -Force
$state | Add-Member albDns         $albDns -Force
Write-Host "正式網址: http://$albDns"

Write-Host '=== 6) Task definition（第一版）==='
$td = Register-TaskDefinition -State $state -ImageUri $state.ecrUri
$state | Add-Member taskFamily   $td.family   -Force
$state | Add-Member taskRevision $td.revision -Force
Write-Host "task definition: $($td.taskDefinitionArn)"

Write-Host '=== 7) ECS cluster + service ==='
$cluster = (AWS 'ecs' @('describe-clusters', '--clusters', $Project)).clusters | Select-Object -First 1
if (-not $cluster) {
    $cluster = (AWS 'ecs' @('create-cluster', '--cluster-name', $Project)).clusters[0]
    Write-Host "建立 cluster: $($cluster.clusterName)"
}

$svc  = $null
$arns = (AWS 'ecs' @('list-services', '--cluster', $Project)).serviceArns
if ($arns) { $svc = (AWS 'ecs' @('describe-services', '--cluster', $Project, '--services', ($arns -join ' '))).services | Select-Object -First 1 }

if (-not $svc) {
    $subnetStr = ($subnets -join ',')
    $svc = (AWS 'ecs' @('create-service', '--cluster', $Project, '--service-name', $Project,
        '--task-definition', $td.taskDefinitionArn,
        '--launch-type', 'FARGATE',
        '--platform-version', '1.0.0',
        '--desired-count', '1',
        '--network-mode', 'awsvpc',
        '--load-balancers', "targetGroupArn=$tgArn",
        '--network', "awsvpcConfiguration={subnets=[$subnetStr],assignPublicIp=ENABLED}")).services[0]
    Write-Host "建立 service: $($svc.serviceName)"
}

$state | Add-Member cluster    $cluster.clusterName -Force
$state | Add-Member service    $svc.serviceName     -Force
$state | Add-Member serviceArn $svc.serviceArn      -Force

Save-State $state
Write-Host ''
Write-Host '=== bootstrap 完成 ==='
Write-Host '以後每次部署只需：powershell -NoProfile -ExecutionPolicy Bypass -File ./deploy.ps1'
Write-Host 'RDS 手動建在同一个 VPC（SG 放行 5432），然後把 DATABASE_URL 放 Secrets Manager 或寫進 config.json 的 databaseUrl。'
