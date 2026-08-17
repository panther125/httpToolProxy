/**
 * HTTP 工具 - 本地跨域代理 / 静态服务器 (零依赖, 仅用 Node 内置模块)
 *
 * 作用: 浏览器直接请求第三方 API 会触发 CORS 限制 (如 corsproxy.io 预检失败)。
 *       本服务在本地 8787 端口接收前端请求, 由服务端代替浏览器去请求目标地址,
 *       再带上 CORS 响应头回传给前端, 从而彻底规避浏览器的跨域拦截。
 *
 * 前端约定 (见 index.html):
 *   - 健康检查: GET http://localhost:8787/?url=http%3A%2F%2Flocalhost%3A8787%2Fping
 *   - 代理接口: GET/POST/... http://localhost:8787/?url=<encodeURIComponent(目标地址)>
 *   - 直接访问: http://localhost:8787/  -> 返回 index.html
 *
 * 启动: node server.js
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");
const MAX_REDIRECTS = 5;

// 这些响应头由本代理自己管理, 不应透传给目标服务器
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length", // 让 Node 根据真实 body 重新计算
]);

// 统一给所有响应追加 CORS 头, 允许任意前端页面 (含 file:// origin=null) 调用
function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"
  );
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// 读取请求体 (GET/HEAD 通常不带 body)
function readBody(req, method) {
  return new Promise((resolve) => {
    if (method === "GET" || method === "HEAD") return resolve(null);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

// 过滤出需要转发给目标服务器的请求头
function forwardHeaders(incomingHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(incomingHeaders)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    // 浏览器的 Origin/Referer 对第三方无意义, 且可能干扰某些站点, 透传亦可, 这里保留
    out[k] = v;
  }
  return out;
}

// 真正执行一次到目标服务器的请求, 并把响应内容回写
function proxyOnce(targetUrl, method, headers, body, redirectDepth, res) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "非法的目标 URL: " + targetUrl }));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "仅支持 http/https 协议" }));
  }

  const client = parsed.protocol === "https:" ? https : http;
  const options = {
    method,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: forwardHeaders(headers),
    timeout: 30000,
  };
  // 有 body 时带上长度, 没有则移除 (避免 Node 把 GET 当成有体)
  if (body && body.length) options.headers["Content-Length"] = Buffer.byteLength(body);
  else delete options.headers["Content-Length"];

  const req = client.request(options, (upstream) => {
    const status = upstream.statusCode;

    // 处理重定向 (3xx)
    if (
      [301, 302, 303, 307, 308].includes(status) &&
      upstream.headers.location &&
      redirectDepth < MAX_REDIRECTS
    ) {
      let next = upstream.headers.location;
      try {
        next = new URL(next, parsed).href; // 相对路径补全
      } catch (e) {}
      upstream.resume(); // 丢弃当前响应体
      const nextMethod = status === 303 || status === 302 ? "GET" : method;
      const nextBody = status === 303 || status === 302 ? null : body;
      return proxyOnce(next, nextMethod, headers, nextBody, redirectDepth + 1, res);
    }

    // 回写上游状态码与响应头 (同样过滤逐跳头);
    // 但移除上游自带 CORS 头, 改由本代理统一下发, 避免上游严格策略影响浏览器
    const outHeaders = {};
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (k.toLowerCase().startsWith("access-control-")) continue;
      outHeaders[k] = v;
    }
    withCors(res);
    res.writeHead(status, outHeaders);
    upstream.pipe(res);
    upstream.on("error", () => res.destroy());
  });

  req.on("timeout", () => req.destroy(new Error("上游请求超时")));
  req.on("error", (err) => {
    if (!res.headersSent) {
      withCors(res);
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: "代理请求失败: " + err.message }));
    }
  });

  if (body && body.length) req.write(body);
  req.end();
}

function serveIndex(res) {
  fs.readFile(INDEX_FILE, (err, data) => {
    withCors(res);
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("未找到 index.html");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  // 预检请求: 直接放行
  if (req.method === "OPTIONS") {
    withCors(res);
    return res.writeHead(204).end();
  }

  const reqUrl = new URL(req.url, "http://localhost");
  const target = reqUrl.searchParams.get("url");

  // 健康检查
  if (reqUrl.pathname === "/ping") {
    withCors(res);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("pong");
  }

  // 没有 url 参数: 当作静态页面服务 (方便直接打开 http://localhost:8787/)
  if (!target) {
    return serveIndex(res);
  }

  // 代理模式: 转发方法 / 头 / body
  const body = await readBody(req, req.method);
  try {
    proxyOnce(target, req.method, req.headers, body, 0, res);
  } catch (e) {
    withCors(res);
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "代理内部错误: " + e.message }));
  }
});

server.listen(PORT, () => {
  console.log("HTTP 工具已启动:");
  console.log("  页面:  http://localhost:" + PORT);
  console.log("  代理:  http://localhost:" + PORT + "/?url=<目标地址>");
});
