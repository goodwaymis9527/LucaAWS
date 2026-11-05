// bootstrap.js — 只跑一次：把 AWS 端資源建起來（SDK 版，不需要 AWS CLI）
//
// 建立：ECR、CloudWatch log group、兩個 IAM role、task SG、ALB + target group + listener、
//       ECS cluster、第一版 task definition、ECS service
// 所有 ARN 寫進 .aws-state/config.json，之後 deploy.js / status.js 直接讀。
//
// 執行：
//   node aws/bootstrap.js

import { ECRClient, CreateRepositoryCommand, DescribeRepositoriesCommand } from '@aws-sdk/client-ecr';
import { CloudWatchLogsClient, CreateLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { IAMClient, AttachRolePolicyCommand, CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
} from '@aws-sdk/client-ec2';
import {
  ElasticLoadBalancingV2Client,
  CreateListenerCommand,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  ECSClient,
  CreateClusterCommand,
  CreateServiceCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  ListServicesCommand,
  RegisterTaskDefinitionCommand,
} from '@aws-sdk/client-ecs';

import { REGION, PROJECT, buildTaskDefinition, newState, saveState, whoami } from './aws-common.js';

const clientOpts = { region: REGION };
const ecr = new ECRClient(clientOpts);
const logs = new CloudWatchLogsClient(clientOpts);
const iam = new IAMClient(clientOpts);
const ec2 = new EC2Client(clientOpts);
const elb = new ElasticLoadBalancingV2Client(clientOpts);
const ecs = new ECSClient(clientOpts);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = newState();
state.account = await whoami();

console.log('=== 1) VPC / subnets ===');
const vpc = ((await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }))).Vpcs || [])[0];
if (!vpc) throw new Error('此區域沒有 default VPC；請先建 VPC 或手動把 vpcId 寫進 config.json');

let subnets = (await ec2.send(new DescribeSubnetsCommand({
  Filters: [{ Name: 'vpc-id', Values: [vpc.VpcId] }, { Name: 'state', Values: ['available'] }],
}))).Subnets.map((s) => s.SubnetId);
if (!subnets.length) throw new Error('VPC 內沒有可用 subnet');

state.region = REGION;
state.project = PROJECT;
state.vpcId = vpc.VpcId;
state.vpcCidr = vpc.CidrBlock;
state.subnets = subnets;
console.log(`VPC ${vpc.VpcId}  ${vpc.CidrBlock}  subnet 數=${subnets.length}`);

console.log('=== 2) ECR ===');
let repo = ((await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [PROJECT] }))).repositories || [])[0];
if (!repo) {
  repo = ((await ecr.send(new CreateRepositoryCommand({
    repositoryName: PROJECT,
    imageTagMutability: 'SIMPLIFIED',
    imageScanningConfiguration: { scanOnPush: true },
  }))).repository);
  console.log(`建立 ECR: ${repo.repositoryUri}`);
}
state.ecrUri = repo.repositoryUri;

console.log('=== 3) CloudWatch log group ===');
const logGroup = `/ecs/${PROJECT}`;
state.logGroup = logGroup;
try {
  await logs.send(new CreateLogGroupCommand({ logGroupName: logGroup }));
  console.log(`建立 log group: ${logGroup}`);
} catch (err) {
  if (err.name !== 'ResourceAlreadyExistsException') throw err;
  console.log('（已存在，略過）');
}

console.log('=== 4) IAM roles ===');
const trust = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
});

async function ensureRole(name) {
  try {
    return ((await iam.send(new GetRoleCommand({ RoleName: name }))).Role).Arn;
  } catch (err) {
    if (err.name !== 'NoSuchEntityException') throw err;
    const role = await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: trust }));
    console.log(`建立 role: ${name}`);
    return role.Role.Arn;
  }
}

const execRoleName = `${PROJECT}-execution`;
const taskRoleName = `${PROJECT}-task`;
state.executionRoleArn = await ensureRole(execRoleName);
state.taskRoleArn = await ensureRole(taskRoleName);

// 執行角色：拉 ECR 镜像 + 寫 CloudWatch Logs
await iam.send(new AttachRolePolicyCommand({
  RoleName: execRoleName,
  PolicyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
}));

// task role：讀 Secrets Manager / SSM，外加 ecs execute-command 需要的 ssmmessages
const appPolicy = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue', 'ssm:GetParameter'], Resource: '*' },
    {
      Effect: 'Allow',
      Action: [
        'ssm:ListCommands', 'ssm:SendCommand',
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      Resource: '*',
    },
  ],
});
await iam.send(new PutRolePolicyCommand({ RoleName: taskRoleName, PolicyName: `${PROJECT}-app`, PolicyDocument: appPolicy }));

console.log('=== 5) task security group（RDS 的 5432 會指到這個 SG）===');
async function ensureSg(name, description) {
  const existing = (await ec2.send(new DescribeSecurityGroupsCommand({
    Filters: [{ Name: 'vpc-id', Values: [vpc.VpcId] }, { Name: 'group-name', Values: [name] }],
  })).SecurityGroups || [])[0];
  if (existing) return existing.GroupId;
  const created = await ec2.send(new CreateSecurityGroupCommand({ GroupName: name, Description: description, VpcId: vpc.VpcId }));
  console.log(`建立 SG: ${name}`);
  return created.GroupId;
}

const taskSg = await ensureSg(`${PROJECT}-task`, 'ECS Fargate task ENI');
try {
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: taskSg, IpProtocol: 'tcp', FromPort: 3000, ToPort: 3000, SourceGroup: taskSg,
  }));
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: taskSg, IpProtocol: 'tcp', FromPort: 3000, ToPort: 3000, CidrIp: vpc.CidrBlock,
  }));
} catch (err) {
  if (err.name !== 'InvalidPermissionDuplicate') throw err;
  console.log('（SG 規則已存在，略過）');
}
state.taskSgId = taskSg;

console.log('=== 6) ALB + target group + listener ===');
let alb = ((await elb.send(new DescribeLoadBalancersCommand({}))).LoadBalancers || []).find((l) => l.LoadBalancerName === PROJECT);
if (alb) {
  console.log(`ALB 已存在: ${alb.LoadBalancerArn}`);
} else {
  alb = (await elb.send(new CreateLoadBalancerCommand({
    Name: PROJECT,
    Type: 'application',
    Subnets: subnets,
    Scheme: 'internet-facing',
  })).LoadBalancers[0]);

  let d = alb;
  for (let i = 0; i < 30; i++) {
    d = (await elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [alb.LoadBalancerArn] }))).LoadBalancers;
    if (d[0].State === 'active') break;
    await sleep(5000);
  }
  alb = d[0];
  console.log(`ALB: ${alb.LoadBalancerArn}`);
}

let tg = ((await elb.send(new DescribeTargetGroupsCommand({}))).TargetGroups || []).find((t) => t.TargetGroupName === PROJECT);
if (!tg) {
  const createdTg = await elb.send(new CreateTargetGroupCommand({
    Name: PROJECT,
    Protocol: 'HTTP',
    Port: 3000,
    VpcId: vpc.VpcId,
    TargetType: 'ip',
    HealthCheckPath: '/api/health',
    HealthCheckProtocol: 'HTTP',
    DeregistrationDelayTimeout: { Seconds: 60 },
  }));
  tg = createdTg.TargetGroups[0];
  console.log(`建立 target group: ${tg.TargetGroupArn}`);
}

const listeners = (await elb.send(new DescribeListenersCommand({ LoadBalancerArn: alb.LoadBalancerArn }))).Listeners;
if (!listeners.length) {
  await elb.send(new CreateListenerCommand({
    LoadBalancerArn: alb.LoadBalancerArn,
    Protocol: 'HTTP',
    Port: 80,
    DefaultActions: [{ Type: 'forward', TargetGroupArn: tg.TargetGroupArn }],
  }));
  console.log('建立 listener :80');
}

state.albArn = alb.LoadBalancerArn;
state.albDns = alb.DNSName;
state.targetGroupArn = tg.TargetGroupArn;
console.log(`正式網址: http://${state.albDns}`);

console.log('=== 7) task definition（第一版）===');
const td = ((await ecs.send(new RegisterTaskDefinitionCommand(buildTaskDefinition(state, state.ecrUri)))).taskDefinition);
state.taskFamily = td.family;
state.taskRevision = td.revision;
console.log(`task definition: ${td.taskDefinitionArn}`);

console.log('=== 8) ECS cluster + service ===');
let cluster = ((await ecs.send(new DescribeClustersCommand({ clusters: [PROJECT] }))).clusters || [])[0];
if (!cluster) {
  cluster = ((await ecs.send(new CreateClusterCommand({ clusterName: PROJECT }))).clusters || [])[0];
  console.log(`建立 cluster: ${cluster.clusterName}`);
}

const arns = ((await ecs.send(new ListServicesCommand({ cluster: PROJECT }))).serviceArns) || [];
let svc = arns.length ? ((await ecs.send(new DescribeServicesCommand({ cluster: PROJECT, services: arns }))).services || [])[0] : null;

if (!svc) {
  const createdSvc = await ecs.send(new CreateServiceCommand({
    cluster: PROJECT,
    serviceName: PROJECT,
    taskDefinition: td.taskDefinitionArn,
    launchType: 'FARGATE',
    platformVersion: '1.0.0',
    desiredCount: 1,
    networkMode: 'awsvpc',
    loadBalancers: [{ targetGroupArn: tg.TargetGroupArn }],
    enableExecuteCommand: true,
    networkConfiguration: {
      awsvpcConfiguration: { subnets, securityGroups: [taskSg], assignPublicIp: 'ENABLED' },
    },
  }));
  svc = (createdSvc.services || [])[0];
  console.log(`建立 service: ${svc.serviceName}（SG: ${taskSg}）`);
}

state.cluster = cluster.clusterName;
state.service = svc.serviceName;
state.serviceArn = svc.serviceArn;

saveState(state);
console.log('');
console.log('=== bootstrap 完成 ===');
console.log('以後每次部署只需：node aws/deploy.js');
console.log('RDS 與 secret：node aws/rds.js、node aws/secret.js（RDS 的 5432 要放行來自 task SG）');
