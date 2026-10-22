"use strict";
const http = require("node:http");
const { execute } = require("./index.cjs");

function createServer(handler = execute) {
  let running = false;
  return http.createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json", "x-fc-status": status === 200 ? "200" : "404" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/health" && request.method === "GET") return send(200, { ready: true });
    if (request.url !== "/invoke" || request.method !== "POST") return send(404, { error: "Unknown invocation route" });
    if (running) return send(409, { error: "Collection already in progress" });
    running = true;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 128 * 1024) throw new Error("FC 事件过大");
        chunks.push(chunk);
      }
      const context = { credentials: { accessKeyId: request.headers["x-fc-access-key-id"],
        accessKeySecret: request.headers["x-fc-access-key-secret"], securityToken: request.headers["x-fc-security-token"] } };
      const result = await handler(Buffer.concat(chunks).toString("utf8") || "{}", context);
      send(200, result);
    } catch (error) {
      console.error(error.message);
      send(500, { error: error.message });
    } finally { running = false; }
  });
}
if (require.main === module) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("正式采集运行时要求 Node.js 22 或更新 LTS");
  const server = createServer();
  server.requestTimeout = 920000;
  server.listen(Number(process.env.FC_SERVER_PORT || 9000), "0.0.0.0");
}
module.exports = { createServer };
