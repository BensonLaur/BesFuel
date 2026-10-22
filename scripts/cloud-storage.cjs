"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MAX_BYTES } = require("./cloud-bundle.cjs");

function storageConfig(env = process.env) {
  const bucket = env.BESFUEL_OSS_BUCKET, region = env.BESFUEL_OSS_REGION || "cn-hangzhou";
  const prefix = env.BESFUEL_OSS_PREFIX || "regions/";
  assert.ok(typeof bucket === "string" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket), "请配置 BESFUEL_OSS_BUCKET");
  assert.match(region, /^cn-[a-z]+(?:-[a-z]+)?$/, "OSS 地域无效");
  assert.match(prefix, /^[a-z0-9_-]+\/$/, "OSS 对象前缀无效");
  return { bucket, region, prefix };
}
function createStore({ credentials, internal = false, env = process.env, client } = {}) {
  const config = storageConfig(env);
  if (!client) {
    const values = credentials || { accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, securityToken: env.ALIBABA_CLOUD_SECURITY_TOKEN };
    assert.ok(values?.accessKeyId && values.accessKeySecret && values.securityToken, "缺少临时 OSS 凭证，请检查 FC 角色或 GitHub OIDC");
    const OSS = require("ali-oss");
    client = new OSS({ region: `oss-${config.region}`, bucket: config.bucket, internal, secure: true,
      authorizationV4: true, accessKeyId: values.accessKeyId, accessKeySecret: values.accessKeySecret,
      stsToken: values.securityToken, timeout: 30000, retryMax: 1 });
  }
  async function read() {
    let result;
    let key;
    try {
      const listing = await client.listV2({ prefix: config.prefix, "max-keys": 1000 });
      assert.ok(!listing.isTruncated, "OSS 快照超过 1000 份，请检查 7 天生命周期规则");
      const names = (listing.objects || []).map(item => item.name).filter(name => name.startsWith(config.prefix) &&
        /^\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(name.slice(config.prefix.length))).sort();
      key = names.at(-1);
      if (!key) return null;
      result = await client.getStream(key);
    }
    catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      throw new Error(`OSS 读取失败 (${error.code || error.name}, ${error.status || "network"})`);
    }
    const stream = result.stream, chunks = []; let size = 0;
    const timer = setTimeout(() => stream.destroy(new Error("OSS 内容读取超时")), 30000);
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        assert.ok(size <= MAX_BYTES, "OSS 快照超出大小上限");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      return { body, key };
    } finally { clearTimeout(timer); stream.destroy(); }
  }
  async function publish(bundle) {
    const body = Buffer.from(JSON.stringify(bundle));
    assert.ok(body.length <= MAX_BYTES, "FC 快照超出大小上限");
    assert.ok(typeof bundle.startedAt === "string" && Number.isFinite(Date.parse(bundle.startedAt)), "FC 快照时间无效");
    const key = config.prefix + bundle.startedAt.replace(/[-:.]/g, "") + "-" + crypto.randomUUID() + ".json";
    // OSS PutObject does not support If-Match. Immutable timestamped objects
    // avoid an older invocation overwriting a newer result; readers sort by start time.
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "x-oss-forbid-overwrite": "true" };
    try { await client.put(key, body, { headers }); }
    catch (error) { throw new Error(`OSS 写入失败 (${error.code || error.name}, ${error.status || "network"})`); }
    return { written: true, key, bytes: body.length };
  }
  return { read, publish, config };
}
module.exports = { storageConfig, createStore };
