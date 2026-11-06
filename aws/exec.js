// exec.js - run a command inside the running Fargate task (no shell in Fargate, so this is the only way to look inside).
//
// Needs:
//   1) service enableExecuteCommand = true
//   2) task role has ssmmessages:CreateControlChannel / CreateDataChannel / ListsChannels
//   3) the IAM user running this script has ssm:SendCommand (ECS Exec is built on SSM)
//
// Usage:
//   node aws/exec.js "node -e \"console.log(process.env.DATABASE_URL)\""
//   node aws/exec.js "node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>r.text().then(t=>console.log(r.status,t))).catch(e=>console.log('ERR',e.message))\""
//
// Output may print secrets: one-off diagnosis only, do not paste into the repo.

import { ECSClient, ListTasksCommand, DescribeTasksCommand, ExecuteCommandCommand } from '@aws-sdk/client-ecs';
import { REGION, readState } from './aws-common.js';

const state = readState();
const region = REGION;

const command = process.argv.slice(2).join(' ');
if (!command) {
  console.log('usage: node aws/exec.js "<command to run inside the container>"');
  process.exit(1);
}

const ecs = new ECSClient({ region });

const list = await ecs.send(new ListTasksCommand({ cluster: state.cluster, service: state.service }));
// 新版 SDK 的 ListTasks 回的是 taskArns（不是 tasks）：兩個都要接，否則會誤判「沒有任務」
const arns = list.taskArns || list.tasks || [];
if (!arns.length) {
  console.log('no task under the service');
  process.exit(1);
}
const d = await ecs.send(new DescribeTasksCommand({ cluster: state.cluster, tasks: arns }));
const task = d.tasks[0];
console.log('task: ' + task.taskArn);

const res = await ecs.send(new ExecuteCommandCommand({
  cluster: state.cluster,
  task: task.taskArn,
  command,
  interactive: false,
}));

const out = res.executeCommandOutput;
console.log('exitCode: ' + out.exitCode);
if (out.reason) console.log('reason: ' + out.reason);
process.stdout.write(out.stdout || '');
process.stderr.write(out.stderr || '');
