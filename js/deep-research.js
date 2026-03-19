// ============================================================
// Deep Research Engine v2 — 强制多步研究
// ============================================================

const researchState = {
  isRunning: false,
  abortController: null,
  steps: [],
  sources: [],
  findings: [],
  startTime: null,
  plan: '',
  query: ''
};
window.researchState = researchState;

// 强制AI先搜索再报告的 system prompt
const DR_SYSTEM_PROMPT = `You are a deep research assistant. For every research request, you MUST follow these rules strictly:

1. First output a plan (action=plan)
2. Then perform AT LEAST 4 searches (action=search)
3. After each search, read 1-2 relevant pages (action=read)
4. Only output report (action=report) after you have at least 4 search results and 2 page reads
5. NEVER skip straight to report

Output ONLY a single JSON object each turn, no other text:

{"action":"plan","topic":"...","steps":["step1","step2","step3","step4","step5"]}
{"action":"search","query":"specific search terms"}
{"action":"read","url":"https://..."}
{"action":"report"}

IMPORTANT: You must do multiple searches before reporting. If you have fewer than 4 searches done, keep searching.`;

const DR_REPORT_SYSTEM_PROMPT = `你是专业研究报告撰写专家。根据提供的研究发现，撰写全面深入的研究报告。

要求：
- Markdown 格式，含标题/小节/列表
- 内容全面，覆盖主题各重要方面
- 在文中用 [1]、[2] 等编号引用来源（必须引用！）
- 含结论和关键发现摘要
- 至少 1000 字
- 中文撰写`;

// --- 启动研究 ---
window.startDeepResearch = async function(query, opts) {
  const { config, onProgress, onReportDelta, onComplete, onError } = opts;
  if (researchState.isRunning) return;

  Object.assign(researchState, {
    isRunning: true,
    abortController: new AbortController(),
    steps: [], sources: [], findings: [],
    startTime: Date.now(), plan: '', query
  });

  addStep('plan', '制定研究计划', 'active');
  onProgress();

  try {
    // 1. 制定计划
    const planAction = await callAction(
      [{ role: 'user', content: `Research topic: ${query}\n\nStart by outputting a research plan.` }],
      config
    );
    if (aborted()) throw new Error('aborted');

    if (planAction?.action === 'plan') {
      researchState.plan = (planAction.steps || []).join(' → ');
      updateStep(0, 'done');
    } else {
      updateStep(0, 'done');
    }
    onProgress();

    // 2. 研究循环
    const history = [
      { role: 'user', content: `Research topic: ${query}` }
    ];
    let searchCount = 0;
    let readCount = 0;
    let rounds = 0;
    const MAX_ROUNDS = 12;

    while (rounds < MAX_ROUNDS) {
      if (aborted()) throw new Error('aborted');
      rounds++;

      // 构建上下文
      const ctxMsg = buildContext(researchState.findings, researchState.sources, searchCount, readCount);
      const msgs = [...history, { role: 'user', content: ctxMsg }];

      const action = await callAction(msgs, config);
      if (!action) { break; }

      if (action.action === 'report') {
        // 强制最少搜索次数
        if (searchCount < 3) {
          // 忽略 report，强制继续搜索
          history.push({ role: 'assistant', content: JSON.stringify(action) });
          history.push({ role: 'user', content: `You only did ${searchCount} searches. You need at least 4. Keep searching for more information about: ${query}` });
          continue;
        }
        break;
      }

      if (action.action === 'search' && action.query) {
        const label = `搜索: "${action.query}"`;
        const idx = addStep('search', label, 'active');
        onProgress();
        history.push({ role: 'assistant', content: JSON.stringify(action) });

        try {
          const results = await doSearch(action.query, config);
          if (results.length > 0) {
            results.forEach(r => {
              if (!researchState.sources.find(s => s.url === r.url)) {
                researchState.sources.push({
                  index: researchState.sources.length + 1,
                  title: r.title || r.url,
                  url: r.url,
                  snippet: r.snippet || ''
                });
              }
            });
            const summary = results.slice(0, 5).map((r, i) => {
              const src = researchState.sources.find(s => s.url === r.url);
              return `[${src?.index || i+1}] ${r.title}\n${r.snippet}\nURL: ${r.url}`;
            }).join('\n\n');
            researchState.findings.push(`Search "${action.query}":\n${summary}`);
            history.push({ role: 'user', content: `Search results for "${action.query}":\n${summary}\n\nNow read the most relevant page or search for more information.` });
            searchCount++;
          } else {
            history.push({ role: 'user', content: 'No results found. Try different search terms.' });
          }
          updateStep(idx, 'done');
        } catch(e) {
          updateStep(idx, 'error');
          history.push({ role: 'user', content: `Search failed: ${e.message}` });
        }
        onProgress();

      } else if (action.action === 'read' && action.url) {
        const domain = getDR(action.url);
        const idx = addStep('read', `阅读: ${domain}`, 'active');
        onProgress();
        history.push({ role: 'assistant', content: JSON.stringify(action) });

        try {
          const page = await readPage(action.url, config);
          if (page.content && !page.error) {
            const text = page.content.slice(0, 3000);
            researchState.findings.push(`Page "${page.title || domain}":\n${text}`);
            history.push({ role: 'user', content: `Page content from ${domain}:\n${text}\n\nContinue researching.` });
            const src = researchState.sources.find(s => s.url === action.url);
            if (src && page.title) src.title = page.title;
            readCount++;
          } else {
            history.push({ role: 'user', content: `Could not read page: ${page.error || 'unknown error'}` });
          }
          updateStep(idx, 'done');
        } catch(e) {
          updateStep(idx, 'error');
          history.push({ role: 'user', content: `Read failed: ${e.message}` });
        }
        onProgress();
      }
    }

    if (aborted()) throw new Error('aborted');

    // 3. 生成报告
    const rptIdx = addStep('report', '生成研究报告', 'active');
    onProgress();

    const reportMsgs = buildReportMessages(query, researchState.findings, researchState.sources);
    await streamReport(reportMsgs, config, onReportDelta, researchState.abortController.signal);

    updateStep(rptIdx, 'done');
    researchState.isRunning = false;
    onComplete(researchState.sources);

  } catch(err) {
    researchState.isRunning = false;
    if (err.message === 'aborted') onComplete(researchState.sources);
    else onError(err.message);
  }
};

window.abortDeepResearch = function() {
  if (researchState.isRunning && researchState.abortController) {
    researchState.abortController.abort();
  }
};

function aborted() {
  return researchState.abortController?.signal.aborted;
}

function addStep(type, label, status) {
  const idx = researchState.steps.length;
  researchState.steps.push({ type, label, status, time: Date.now() });
  return idx;
}

function updateStep(idx, status) {
  if (researchState.steps[idx]) researchState.steps[idx].status = status;
}

// --- LLM 调用（非流式）---
async function callAction(messages, config) {
  try {
    const resp = await fetch(`${config.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.defaultModel,
        messages: [{ role: 'system', content: DR_SYSTEM_PROMPT }, ...messages],
        max_tokens: 256,
        temperature: 0.2,
        stream: false
      }),
      signal: researchState.abortController?.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) return JSON.parse(m[0]);
  } catch(e) {}
  return null;
}

// --- 流式报告生成 ---
async function streamReport(messages, config, onDelta, signal) {
  const resp = await fetch(`${config.baseURL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.defaultModel, messages, max_tokens: 4096, temperature: 0.7, stream: true }),
    signal
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const d = JSON.parse(raw);
        const delta = d.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch(e) {}
    }
  }
}

// --- 搜索 ---
async function doSearch(query, config) {
  if (config.searchWorkerURL) {
    try {
      const resp = await Promise.race([
        fetch(`${config.searchWorkerURL}?q=${encodeURIComponent(query)}&count=6`),
        new Promise((_,r) => setTimeout(() => r(new Error('timeout')), 12000))
      ]);
      if (resp.ok) { const d = await resp.json(); if (d.results) return d.results; }
    } catch(e) {}
  }
  if (config.tavilyKey) {
    try {
      const resp = await Promise.race([
        fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: config.tavilyKey, query, max_results: 6 })
        }),
        new Promise((_,r) => setTimeout(() => r(new Error('timeout')), 12000))
      ]);
      if (resp.ok) { const d = await resp.json(); return (d.results||[]).map(r=>({title:r.title,url:r.url,snippet:r.content||r.snippet||''})); }
    } catch(e) {}
  }
  return [];
}

// --- 读取网页 ---
async function readPage(url, config) {
  if (!config.searchWorkerURL) return { error: '未配置Worker' };
  try {
    const resp = await Promise.race([
      fetch(`${config.searchWorkerURL}?read=${encodeURIComponent(url)}`),
      new Promise((_,r) => setTimeout(() => r(new Error('timeout')), 12000))
    ]);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    return await resp.json();
  } catch(e) { return { error: e.message }; }
}

// --- 上下文构建 ---
function buildContext(findings, sources, searchCount, readCount) {
  const status = `Progress: ${searchCount} searches done, ${readCount} pages read.`;
  if (findings.length === 0) return `${status}\n\nStart researching now. Do the first search.`;
  const recent = findings.slice(-3).join('\n\n---\n\n');
  const remaining = Math.max(0, 4 - searchCount);
  const hint = remaining > 0
    ? `You still need ${remaining} more searches before you can write the report.`
    : 'You have enough data. You can now output {"action":"report"} or continue for more depth.';
  return `${status}\n${hint}\n\nRecent findings:\n${recent}\n\nWhat is your next action?`;
}

// --- 报告消息 ---
function buildReportMessages(query, findings, sources) {
  const srcList = sources.map(s => `[${s.index}] ${s.title}\n来源: ${s.url}\n摘要: ${s.snippet}`).join('\n\n');
  const findingsText = findings.join('\n\n---\n\n');
  return [
    { role: 'system', content: DR_REPORT_SYSTEM_PROMPT },
    { role: 'user', content: `研究主题：${query}\n\n研究发现：\n${findingsText}\n\n来源列表：\n${srcList}\n\n请撰写完整研究报告，必须在适当位置标注 [数字] 引用。` }
  ];
}

function getDR(url) {
  try { return new URL(url).hostname.replace('www.',''); } catch { return url.slice(0,30); }
}
