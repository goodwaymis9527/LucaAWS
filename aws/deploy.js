// deploy.js — 一鍵部署（SDK 版，不需要 AWS CLI）
//
// 流程：npm ci → next build → docker build → docker push（拿 ECR token）→ register 新 revision → update-service
// 第一次要先跑 aws/bootstrap.js（建 ECR / cluster / service 並產生 .aws-state/config.json）。
//
// 執行：
//   node aws/deploy.js
//   node aws/deploy.js --skip-build
//   node aws/deploy.js --tag=dev

import { spawnSync } from 'node:child_process';
import { REGION, projectRoot, buildTaskDefinition, readState, saveState, whoami } from './aws-common.js';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { ECSClient, RegisterTaskDefinitionCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';

const argv = process.argv.slice(2);
const skipBuild = argv.includes('--skip-build');
const tag = (argv.find((a) => a.startsWith('--tag=')) || '').split('=')[1] || 'latest';

const state = readState();
if (!state.ecrUri) throw new Error('config.json 缺少 ecrUri；先跑 aws/bootstrap.js');
if (!state.cluster) throw new Error('config.json 缺少 cluster；先跑 aws/bootstrap.js');
if (!state.service) throw new Error('config.json 缺少 service；先跑 aws/bootstrap.js');

const region = state.region || REGION;
const ecr = new ECRClient({ region });
const ecs = new ECSClient({ region });

// 先確認憑據（跑 docker build 之前就能發現 key 不對）
state.account = await whoami();

// Windows 上 npm 是 npm.cmd，所以要 shell:true；docker 是 docker.exe，argv 直接傳比較安全
function run(cmd, args, useShell = false) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: projectRoot, shell: useShell });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失敗（exit ${r.status ?? 'null'}）`);
}

console.log(`專案 ${projectRoot}`);
console.log(`ECR    ${state.ecrUri}`);

// 1) build
if (skipBuild) {
  console.log('=== 1) 跳過 build（用現有 .next）===');
} else {
  console.log('=== 1) npm install + next build ===');
  run('npm', ['ci'], true);
  run('npm', ['run', 'build'], true);
}

// 2) docker build（Dockerfile 用 multi-stage，runtime 只有 standalone 輸出）
console.log('=== 2) docker build ===');
run('docker', ['build', '-t', `${state.project}:${tag}`, '.']);

// 3) ECR login + push
console.log('=== 3) push 到 ECR ===');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const registryHost = state.ecrUri.split('/')[0];

const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
const rawToken = auth.authorizationData?.[0]?.authorizationToken;
if (!rawToken) throw new Error('拿不到 ECR authorizationToken（檢查憑據與 ecr:GetAuthorizationToken 權限）');

// SDK 回的是 base64 的 "AWS:<password>"；--password-stdin 要的是解碼後的 password 本體
const decoded = Buffer.from(rawToken, 'base64').toString('utf8');
const password = decoded.startsWith('AWS:') ? decoded.slice(4) : decoded;

const login = spawnSync('docker', ['login', '--username', 'AWS', '--password-stdin', registryHost], {
  input: password,
});
if (login.status !== 0) throw new Error('docker login 失敗：' + (login.stderr?.toString() || ''));

run('docker', ['tag', `${state.project}:${tag}`, `${state.ecrUri}:${tag}`]);
run('docker', ['tag', `${state.project}:${tag}`, `${state.ecrUri}:${stamp}`]);
run('docker', ['push', `${state.ecrUri}:${tag}`]);
run('docker', ['push', `${state.ecrUri}:${stamp}`]);

// 4) 新的 task definition revision（image 指到這次 push 的镜像）
console.log('=== 4) register task definition revision ===');
const tdInput = buildTaskDefinition(state, `${state.ecrUri}:${stamp}`);
const out = await ecs.send(new RegisterTaskDefinitionCommand(tdInput));
state.taskFamily = out.taskDefinition.family;
state.taskRevision = out.taskDefinition.revision;
state.lastImage = `${state.ecrUri}:${stamp}`;

// 5) service 用新 revision 並強制換任務（rolling：新任務 healthy 後才停舊任務）
console.log('=== 5) update service ===');
const tdRef = `${state.taskFamily}:${state.taskRevision}`;
await ecs.send(new UpdateServiceCommand({
  cluster: state.cluster,
  service: state.service,
  taskDefinition: tdRef,
  forceNewDeployment: true,
}));
state.lastDeploymentAt = new Date().toISOString();
saveState(state);

console.log('');
console.log('=== 部署完成 ===');
console.log(`task definition: ${tdRef}`);
console.log(`image:           ${state.lastImage}`);
if (state.albDns) console.log(`看健康狀態：http://${state.albDns}/api/health`);
console.log('看狀態：node aws/status.js（service 部署狀態、最近事件、task health）');
