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

    // API 代理端点: /v1/*
    if (url.pathname.startsWith('/v1/')) {
      return proxyAPI(request, url);
    }

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

const API_TARGET = 'https://api.tech2026.edu.kg';

async function proxyAPI(request, url) {
  const pathname = url.pathname;
  const authHeader = request.headers.get('Authorization') || '';
  const apiKey = authHeader.replace('Bearer ', '');

  // /v1/models — 转发原生 models 端点
  if (pathname === '/v1/models') {
    const resp = await fetch(API_TARGET + '/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    // 转换为 OpenAI 格式（data 数组里加 object 字段）
    if (data.data) {
      data.data = data.data.map(m => Object.assign({ object: 'model' }, m));
    }
    return json(data);
  }

  // /v1/chat/completions — OpenAI 格式转 Anthropic 格式
  if (pathname === '/v1/chat/completions') {
    const body = await request.json();
    const isStream = !!body.stream;

    // 提取 system prompt
    const systemMsgs = body.messages.filter(m => m.role === 'system');
    const chatMsgs = body.messages.filter(m => m.role !== 'system');
    const systemText = systemMsgs.map(m => m.content).join('\n');

    // 构建 Anthropic 格式请求
    const anthropicBody = {
      model: body.model || 'claude-opus-4-6',
      max_tokens: body.max_tokens || 4096,
      messages: chatMsgs.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content :
          Array.isArray(m.content) ? m.content.map(c =>
            c.type === 'image_url'
              ? { type: 'image', source: { type: 'url', url: c.image_url.url } }
              : { type: 'text', text: c.text || '' }
          ) : String(m.content)
      })),
      stream: isStream
    };
    if (systemText) anthropicBody.system = systemText;
    if (body.temperature !== undefined) anthropicBody.temperature = body.temperature;

    const upstreamResp = await fetch(API_TARGET + '/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(anthropicBody)
    });

    if (!upstreamResp.ok) {
      const err = await upstreamResp.text();
      return new Response(err, { status: upstreamResp.status, headers: corsHeaders() });
    }

    // 流式响应：转换 Anthropic SSE → OpenAI SSE
    if (isStream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = upstreamResp.body.getReader();

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6).trim();
              if (raw === '[DONE]') { await writer.write(encoder.encode('data: [DONE]\n\n')); continue; }
              try {
                const evt = JSON.parse(raw);
                let delta = '';
                if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                  delta = evt.delta.text || '';
                }
                if (delta) {
                  const chunk = { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model,
                    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] };
                  await writer.write(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
                }
                if (evt.type === 'message_stop') {
                  const done_chunk = { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
                  await writer.write(encoder.encode('data: ' + JSON.stringify(done_chunk) + '\n\n'));
                  await writer.write(encoder.encode('data: [DONE]\n\n'));
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
        await writer.close();
      })();

      const h = Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, corsHeaders());
      return new Response(readable, { status: 200, headers: h });
    }

    // 非流式：转换 Anthropic 响应 → OpenAI 格式
    const data = await upstreamResp.json();
    const text = data.content?.[0]?.text || '';
    const openaiResp = {
      id: data.id || 'chatcmpl-1',
      object: 'chat.completion',
      model: data.model || body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: data.stop_reason || 'stop' }],
      usage: { prompt_tokens: data.usage?.input_tokens || 0, completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) }
    };
    return json(openaiResp);
  }

  // 其他 /v1/ 路径直接透传
  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (['authorization','content-type','x-api-key','anthropic-version'].includes(k.toLowerCase())) headers.set(k, v);
  }
  const upResp = await fetch(API_TARGET + pathname + url.search, {
    method: request.method, headers,
    body: request.method !== 'GET' ? request.body : undefined
  });
  const respHeaders = new Headers(upResp.headers);
  for (const [k, v] of Object.entries(corsHeaders())) respHeaders.set(k, v);
  return new Response(upResp.body, { status: upResp.status, headers: respHeaders });
}

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
