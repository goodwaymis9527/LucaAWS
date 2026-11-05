// status.js — 看部署狀態（SDK 版，不需要 AWS CLI）
// 印：service 的 desired/running、每個 task 的 healthStatus、CloudWatch Logs 最近幾行
//
// 執行：
//   node aws/status.js
//   node aws/status.js --logs=20

import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTasksCommand,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { EC2Client, DescribeInternetGatewaysCommand, DescribeRouteTablesCommand } from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client, DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { REGION, PROJECT, ACCOUNT, readState, whoami } from './aws-common.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};
const logLimit = Number(opt('logs', 10));

const region = REGION;
const state = readState();
const ecs = new ECSClient({ region });
const logs = new CloudWatchLogsClient({ region });

state.account = await whoami();

const svc = ((await ecs.send(new DescribeServicesCommand({
  cluster: state.cluster,
  services: [state.service],
}))).services || [])[0];

if (!svc) throw new Error(`找不到 service：${state.service}`);

console.log('=== service ===');
console.log(`account        : ${state.account || ACCOUNT}`);
console.log(`taskDefinition : ${svc.taskDefinition}`);
console.log(`desired/running: ${svc.desiredCount} / ${svc.runningCount}`);
console.log(`deployments    : ${svc.deployments.length}（active = ${svc.deployments.filter((d) => d.status === 'ACTIVE').length}）`);

if (svc.events?.length) {
  console.log('');
  console.log('=== service events（最近 10 條）===');
  for (const e of svc.events.slice(0, 10)) {
    console.log(`  ${new Date(e.createdAt).toISOString()}  ${e.message}`);
  }
}

let taskArns = [];
for (let i = 0; i < 4; i++) {
  const listed = await ecs.send(new ListTasksCommand({
    cluster: state.cluster,
    services: [state.service],
    maxResults: 10,
  }));
  taskArns = listed.tasks || [];
  if (taskArns.length) break;
  // ListTasks 偶爾會比 runningCount 慢一拍（最終一致性），running>0 時重試幾次
  if (!svc.runningCount) break;
  await new Promise((r) => setTimeout(r, 1500));
}
if (!taskArns.length) {
  console.log('');
  console.log('=== tasks ===');
  console.log('（目前沒有 task；DescribeTasks 帶空清單會被 ECS 拒：Tasks cannot be empty）');
} else {
  const tasks = await ecs.send(new DescribeTasksCommand({ cluster: state.cluster, tasks: taskArns }));
  console.log('');
  console.log('=== tasks ===');
  for (const t of tasks.tasks || []) {
    const health = t.healthStatus || '（task definition 沒 container healthCheck，只有 ALB 的 health check）';
    console.log(`${t.taskArn.split('/').pop()}  ${t.lastStatus}  health=${health}  image=${(t.containers?.[0]?.image || '').split('/').pop()}`);
  }
}

// === 網路（ALB 連不通通常是這裡）===
const ec2 = new EC2Client({ region });
const elb = new ElasticLoadBalancingV2Client({ region });
try {
  const igws = (await ec2.send(new DescribeInternetGatewaysCommand({}))).InternetGateways || [];
  const igw = igws.find((g) => (g.Attachment || []).some((a) => a.VpcId === state.vpcId));
  console.log(`IGW            : ${igw ? igw.InternetGatewayId + '（已 attach）' : '（VPC 沒有 attach IGW → 外部連不進來，task 也連不出去）'}`);
  const tables = (await ec2.send(new DescribeRouteTablesCommand({ Filters: [{ Name: 'vpc-id', Values: [state.vpcId] }] }))).RouteTables || [];
  const table = tables.find((t) => t.Default) || tables[0];
  const route = (table?.Routes || []).find((r) => r.DestinationCidrBlock === '0.0.0.0/0');
  console.log(`route table    : ${table?.RouteTableId || '?'}  0.0.0.0/0 → ${route?.GatewayId || '（沒有預設路由）'}`);
} catch (err) {
  console.log(`網路檢查 skipped : ${(err.__type || err.name)}（需要 ec2:DescribeInternetGateways / DescribeRouteTables）`);
}

if (state.targetGroupArn) {
  try {
    const th = (await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: state.targetGroupArn }))).TargetHealthDescriptions || [];
    console.log('');
    console.log('=== ALB target health ===');
    if (!th.length) console.log('（target group 沒有目标 → task 還沒註冊進來）');
    for (const t of th) console.log(`  ${t.Target.Id}  ${t.TargetHealth.State}${t.TargetHealth.Reason ? '  ' + t.TargetHealth.Reason : ''}`);
  } catch (err) {
    console.log(`target health skipped: ${(err.__type || err.name)} - ${err.message}`);
  }
}

if (state.albDns) {
  console.log('');
  console.log('=== 實際打一次 ALB ===');
  try {
    const r = await fetch(`http://${state.albDns}/api/health`, { signal: AbortSignal.timeout(15000) });
    const body = (await r.text()).slice(0, 300);
    console.log(`http://${state.albDns}/api/health → ${r.status}  ${body}`);
  } catch (err) {
    const cause = err.cause?.message || err.message;
    console.log(`連不通：${err.name} ${cause}`);
    console.log('  TCP 連不上通常是 IGW/路由問題（上面 IGW 那行）；若是 503 則代表 ALB 通但沒有 healthy target');
  }
}

console.log('');
console.log('=== 最近日誌 ===');
const logGroup = state.logGroup || `/ecs/${PROJECT}`;
const streams = ((await logs.send(new DescribeLogStreamsCommand({
  logGroupName: logGroup,
  orderBy: 'LastEventTime',   // enum 是 LastEventTime / LogStreamName（不是小寫）
  limit: 3,
}))).logStreams || []).filter((s) => s.lastEventTimestamp);

if (!streams.length) {
  console.log('（還沒有日誌；任務起來後才會寫入 /ecs/' + PROJECT + '）');
} else {
  for (const s of streams) {
    const events = ((await logs.send(new GetLogEventsCommand({
      logGroupName: logGroup,
      logStreamName: s.logStreamName,
      limit: logLimit,
      descending: true,   // 直接由最新往前讀（startFromBeginning:false 沒給 startTime 會報錯）
    }))).events || []).slice(-logLimit);
    console.log(`--- stream: ${s.logStreamName}`);
    for (const e of events) {
      console.log(`  ${new Date(e.timestamp).toISOString()}  ${e.message}`);
    }
  }
}

if (state.albDns) {
  console.log('');
  console.log(`正式網址：http://${state.albDns}/`);
}
