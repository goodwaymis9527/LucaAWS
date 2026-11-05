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

const listed = await ecs.send(new ListTasksCommand({
  cluster: state.cluster,
  services: [state.service],
  maxResults: 10,
}));
const tasks = await ecs.send(new DescribeTasksCommand({
  cluster: state.cluster,
  tasks: listed.tasks || [],
}));

console.log('');
console.log('=== tasks ===');
for (const t of tasks.tasks || []) {
  const health = t.healthStatus || '（task definition 沒 container healthCheck，只有 ALB 的 health check）';
  console.log(`${t.taskArn.split('/').pop()}  ${t.lastStatus}  health=${health}  image=${(t.containers?.[0]?.image || '').split('/').pop()}`);
}

console.log('');
console.log('=== 最近日誌 ===');
const logGroup = state.logGroup || `/ecs/${PROJECT}`;
const streams = ((await logs.send(new DescribeLogStreamsCommand({
  logGroupName: logGroup,
  orderBy: 'lastEventTime',
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
      startFromBeginning: false,
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
