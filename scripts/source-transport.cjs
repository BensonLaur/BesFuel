"use strict";
const https = require("node:https");
const { setTimeout: delay } = require("node:timers/promises");
const { errorChain } = require("./source-errors.cjs");

const userAgent = "BesFuel/0.1 (+https://github.com/BensonLaur/BesFuel)";

function compatibleHttps(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal: options.signal, headers: options.headers,
      // Hunan's TLS endpoint rejects the default curve negotiation. These
      // standard curves work with certificate and hostname checks still on.
      ecdhCurve: "X25519:prime256v1", rejectUnauthorized: true }, response => {
      const chunks = []; let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 5_000_000) { response.destroy(new Error("官方文件过大")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), {
          status: response.statusCode, headers: response.headers
        })); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
  });
}

async function fetchOfficial(url, options, { fetcher = fetch, compatibilityFetcher = compatibleHttps, sleep = delay } = {}) {
  const hostname = new URL(url).hostname;
  // Request-header compatibility is site-specific; several other portals
  // reject a custom User-Agent despite accepting Node's ordinary request.
  const requestOptions = hostname === "fzggw.jiangsu.gov.cn" ?
    { ...options, headers: { "User-Agent": userAgent, Accept: "*/*", ...options.headers } } : options;
  try { return await fetcher(url, requestOptions); }
  catch (error) {
    const causes = errorChain(error);
    if (hostname === "fgw.hunan.gov.cn" && causes.some(item => item.code === "ERR_SSL_BAD_ECPOINT")) {
      return compatibilityFetcher(url, { ...requestOptions, headers: { "User-Agent": userAgent, Accept: "*/*", ...options.headers } });
    }
    // Retry a reset/socket interruption once. Persistent timeouts and access
    // denials are reported directly instead of multiplying identical requests.
    if (!causes.some(item => ["ECONNRESET", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(item.code))) throw error;
    await sleep(500);
    try { return await fetcher(url, requestOptions); }
    catch (next) { throw new AggregateError([error, next], "来源请求重试仍失败"); }
  }
}

module.exports = { fetchOfficial };
