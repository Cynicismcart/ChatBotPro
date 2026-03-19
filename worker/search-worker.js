// Cloudflare Worker — 免费搜索代理
// 部署到 Cloudflare Workers 后，PWA 通过它搜索网页
// 免费额度：每天 100,000 次请求

export default {
  async fetch(request) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    const count = parseInt(url.searchParams.get('count') || '5');

    if (!query) {
      return json({ error: 'Missing ?q= parameter' }, 400);
    }

    try {
      const results = await searchDuckDuckGo(query, count);
      return json({ results });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

async function searchDuckDuckGo(query, count) {
  const resp = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: `q=${encodeURIComponent(query)}`
  });

  const html = await resp.text();
  const results = [];

  // 解析 DuckDuckGo HTML 搜索结果
  const regex = /<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>(.*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) !== null && results.length < count) {
    let url = match[1];
    // DDG 的链接是重定向格式，提取真实 URL
    const uddg = new URL(url, 'https://duckduckgo.com').searchParams.get('uddg');
    if (uddg) url = decodeURIComponent(uddg);

    results.push({
      title: stripTags(match[2]),
      snippet: stripTags(match[3]),
      url: url
    });
  }

  return results;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
