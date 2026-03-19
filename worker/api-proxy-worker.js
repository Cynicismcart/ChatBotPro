// Cloudflare Worker — Anthropic API 代理
// 解决浏览器 CORS 限制，转发所有请求到 Anthropic 中转站
// 免费额度：每天 100,000 次请求
//
// 部署后在 PWA 设置中：
//   API Base URL = https://你的worker名字.你的子域名.workers.dev
//   API Key = 你的 Anthropic Key

const TARGET = 'https://api.tech2026.edu.kg';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 只代理 /v1/ 路径
    if (!url.pathname.startsWith('/v1/')) {
      return new Response('Not Found', { status: 404 });
    }

    // 构建目标 URL
    const targetURL = TARGET + url.pathname + url.search;

    // 转发请求头（只保留必要的）
    const headers = new Headers();
    for (const [k, v] of request.headers.entries()) {
      const kl = k.toLowerCase();
      if (['authorization', 'content-type', 'x-api-key',
           'anthropic-version', 'anthropic-beta'].includes(kl)) {
        headers.set(k, v);
      }
    }

    // 转发到上游
    let body = undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = request.body;
    }

    const upstream = await fetch(targetURL, {
      method: request.method,
      headers,
      body
    });

    // 返回响应，附加 CORS 头
    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders())) {
      respHeaders.set(k, v);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders
    });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
    'Access-Control-Max-Age': '86400'
  };
}
