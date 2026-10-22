"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { storageConfig } = require("./cloud-storage.cjs");

function configuration(accountId, bucket) {
  assert.match(accountId, /^\d{12,20}$/, "阿里云账号 ID 无效");
  const { prefix } = storageConfig({ BESFUEL_OSS_BUCKET: bucket });
  const resource = `acs:oss:*:${accountId}:${bucket}/${prefix}*`;
  const provider = `acs:ram::${accountId}:oidc-provider/besfuel-github`;
  const policy = actions => ({ Version: "1", Statement: [{ Effect: "Allow", Action: actions, Resource: [resource] }] });
  return {
    "fc-role-trust.json": { Version: "1", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: ["fc.aliyuncs.com"] } }] },
    "fc-oss-policy.json": policy(["oss:PutObject"]),
    "github-oss-policy.json": { Version: "1", Statement: [...policy(["oss:GetObject"]).Statement,
      { Effect: "Allow", Action: ["oss:ListObjects"], Resource: [`acs:oss:*:${accountId}:${bucket}`],
        Condition: { StringEquals: { "oss:Prefix": prefix } } }] },
    "github-role-trust.json": { Version: "1", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole",
      Principal: { Federated: [provider] }, Condition: { StringEquals: {
        "oidc:iss": "https://token.actions.githubusercontent.com", "oidc:aud": "sts.aliyuncs.com",
        "oidc:sub": "repo:BensonLaur/BesFuel:ref:refs/heads/main"
      } } }] },
    "github-variables.json": { BESFUEL_FC_ENABLED: "true", BESFUEL_OSS_BUCKET: bucket,
      BESFUEL_ALIYUN_OIDC_PROVIDER_ARN: provider, BESFUEL_ALIYUN_READ_ROLE_ARN: `acs:ram::${accountId}:role/besfuel-github-read` },
    "fc-environment.json": { BESFUEL_OSS_BUCKET: bucket, BESFUEL_OSS_REGION: "cn-hangzhou" },
    "deployment.json": { functionName: "besfuel-collector", region: "cn-hangzhou", runtime: "custom.debian11",
      memorySize: 512, cpu: 0.35, diskSize: 512, timeout: 900, instanceConcurrency: 1, minimumInstances: 0,
      role: `acs:ram::${accountId}:role/besfuel-fc-collector`,
      // FC joins command and args; direct execution avoids splitting a bash -c script.
      customRuntimeConfig: { port: 9000, command: ["/code/runtime/node"], args: ["/code/cloud/fc/server.cjs"] },
      internetAccess: true, timer: { name: "besfuel-regions-twice-daily", cronExpression: "CRON_TZ=Asia/Shanghai 0 45 9,19 * * *", payload: "{}" },
      oss: { bucket, prefix, acl: "private", storageClass: "Standard", redundancy: "LRS", versioning: false, expireAfterDays: 7 } }
  };
}
if (require.main === module) {
  const [accountId, bucket, output] = process.argv.slice(2);
  if (!output) throw new Error("Usage: node scripts/fc-config.cjs ACCOUNT_ID BUCKET OUTPUT_DIRECTORY");
  const files = configuration(accountId, bucket);
  fs.mkdirSync(output, { recursive: true });
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2).replace(/\n/g, "\r\n") + "\r\n");
  console.log(`已生成配置文件：${path.resolve(output)}`);
}
module.exports = { configuration };
