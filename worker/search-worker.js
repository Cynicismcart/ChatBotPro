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

    // 网页阅读端点: ?read=URL
    const readUrl = url.searchParams.get('read');
    if (readUrl) {
      try {
        const result = await readWebPage(readUrl);
        return json(result);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // 搜索端点: ?q=QUERY
    const query = url.searchParams.get('q');
    const count = parseInt(url.searchParams.get('count') || '5');

    if (!query) {
      return json({ error: 'Missing ?q= or ?read= parameter' }, 400);
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
  const titleRegex = /<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles = [];
  let match;
  while ((match = titleRegex.exec(html)) !== null) {
    titles.push({ href: match[1], title: stripTags(match[2]) });
  }

  const snippets = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripTags(match[1]));
  }

  for (let i = 0; i < Math.min(titles.length, count); i++) {
    let linkUrl = titles[i].href;
    try {
      const parsed = new URL(linkUrl, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) linkUrl = decodeURIComponent(uddg);
    } catch {}

    results.push({
      title: titles[i].title,
      snippet: snippets[i] || '',
      url: linkUrl
    });
  }

  return results;
}

async function readWebPage(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { title: '', content: '[非HTML内容]', url: targetUrl };
    }

    let title = '';
    const textChunks = [];

    // 用 HTMLRewriter 提取文本
    const transformed = new HTMLRewriter()
      .on('title', { text(t) { title += t.text; } })
      .on('script,style,nav,footer,header,aside,iframe,noscript', {
        element(el) { el.remove(); }
      })
      .on('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption', {
        text(t) {
          if (t.text.trim()) textChunks.push(t.text);
        }
      })
      .transform(resp);

    // 消费 response 以触发 HTMLRewriter
    await transformed.text();

    let content = textChunks.join(' ').replace(/\s+/g, ' ').trim();
    if (content.length > 4000) content = content.slice(0, 4000) + '...';

    return { title: title.trim(), content, url: targetUrl };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { error: 'timeout', url: targetUrl };
    return { error: err.message, url: targetUrl };
  }
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
