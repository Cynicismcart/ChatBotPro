// ============================================================
// Deep Research Engine v3 — Gemini 架构
// 大纲 → 每议题多轮搜索 → 读取网页 → 汇总报告
// ============================================================

const researchState = {
  isRunning: false,
  abortController: null,
  outline: [],      // [{topic, status, searches:[]}]
  sources: [],      // 所有来源
  findings: [],     // 每个议题的发现
  steps: [],        // 面板步骤列表
  startTime: null,
  query: ''
};
window.researchState = researchState;

window.startDeepResearch = async function(query, opts) {
  const { config, onProgress, onReportDelta, onComplete, onError } = opts;
  if (researchState.isRunning) return;

  Object.assign(researchState, {
    isRunning: true,
    abortController: new AbortController(),
    outline: [], sources: [], findings: [], steps: [],
    startTime: Date.now(), query
  });

  try {
    // ── 阶段1：生成研究大纲 ──
    addStep('plan', '正在生成研究大纲...', 'active');
    onProgress();

    const outline = await generateOutline(query, config);
    if (aborted()) throw new Error('aborted');
    researchState.outline = outline.map(t => ({ topic: t, status: 'pending', searches: [], findings: '' }));
    updateStep(0, 'done', `研究大纲：${outline.length} 个议题`);
    onProgress();

    // ── 阶段2：逐议题搜索 ──
    for (let i = 0; i < researchState.outline.length; i++) {
      if (aborted()) throw new Error('aborted');
      const item = researchState.outline[i];
      item.status = 'active';

      const topicStepIdx = addStep('search', `研究议题 ${i+1}/${researchState.outline.length}: ${item.topic}`, 'active');
      onProgress();

      // 每个议题搜索 3-5 轮
      const topicFindings = [];
      const queries = await generateSearchQueries(query, item.topic, config);
      if (aborted()) throw new Error('aborted');

      for (let q = 0; q < Math.min(queries.length, 5); q++) {
        if (aborted()) throw new Error('aborted');
        const sq = queries[q];

        const searchIdx = addStep('search', `搜索: "${sq}"`, 'active');
        onProgress();

        const results = await doSearch(sq, config);
        results.forEach(r => {
          if (!researchState.sources.find(s => s.url === r.url)) {
            researchState.sources.push({
              index: researchState.sources.length + 1,
              title: r.title || r.url,
              url: r.url,
              snippet: r.snippet || '',
              topic: item.topic
            });
          }
        });
        topicFindings.push(...results.map(r => `${r.title}: ${r.snippet}`));
        updateStep(searchIdx, 'done');
        onProgress();

        // 读取最相关的1-2个网页
        if (results.length > 0 && config.searchWorkerURL) {
          const toRead = results.slice(0, 2);
          for (const r of toRead) {
            if (aborted()) break;
            const readIdx = addStep('read', `阅读: ${getDR(r.url)}`, 'active');
            onProgress();
            const page = await readPage(r.url, config);
            if (page.content && !page.error) {
              topicFindings.push(`[来自${getDR(r.url)}] ${page.content.slice(0, 1500)}`);
              const src = researchState.sources.find(s => s.url === r.url);
              if (src && page.title) src.title = page.title;
            }
            updateStep(readIdx, 'done');
            onProgress();
          }
        }
      }

      item.findings = topicFindings.join('\n\n');
      item.status = 'done';
      researchState.findings.push({ topic: item.topic, content: item.findings });
      updateStep(topicStepIdx, 'done', `完成: ${item.topic}`);
      onProgress();
    }

    if (aborted()) throw new Error('aborted');

    // ── 阶段3：生成报告 ──
    const rptIdx = addStep('report', '正在撰写研究报告...', 'active');
    onProgress();

    const reportMsgs = buildReportMessages(query, researchState.findings, researchState.sources);
    await streamReport(reportMsgs, config, onReportDelta, researchState.abortController.signal);

    updateStep(rptIdx, 'done', '研究报告已生成');
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

function aborted() { return researchState.abortController?.signal.aborted; }

function addStep(type, label, status) {
  const idx = researchState.steps.length;
  researchState.steps.push({ type, label, status, time: Date.now() });
  return idx;
}

function updateStep(idx, status, label) {
  if (!researchState.steps[idx]) return;
  researchState.steps[idx].status = status;
  if (label) researchState.steps[idx].label = label;
}

// 生成研究大纲
async function generateOutline(query, config) {
  const resp = await llmJSON([
    { role: 'system', content: '你是研究规划专家。将用户的研究主题分解为5-7个具体的子议题，每个议题是一个独立的研究方向。只输出JSON数组，不要其他文字。' },
    { role: 'user', content: `研究主题：${query}\n\n输出格式：["议题1","议题2","议题3",...]` }
  ], config, 512);
  if (Array.isArray(resp)) return resp.slice(0, 7);
  // fallback
  return [query + ' 概述', query + ' 现状', query + ' 发展趋势', query + ' 影响因素', query + ' 未来展望'];
}

// 为每个议题生成搜索词
async function generateSearchQueries(mainQuery, topic, config) {
  const resp = await llmJSON([
    { role: 'system', content: '生成搜索词。只输出JSON字符串数组，不要其他文字。' },
    { role: 'user', content: `主题：${mainQuery}\n议题：${topic}\n\n生成3-4个不同角度的搜索词，输出格式：["搜索词1","搜索词2","搜索词3"]` }
  ], config, 256);
  if (Array.isArray(resp)) return resp.slice(0, 4);
  return [topic, `${mainQuery} ${topic}`];
}

// 通用 LLM 调用返回 JSON
async function llmJSON(messages, config, maxTokens) {
  try {
    const resp = await fetch(`${config.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.defaultModel, messages, max_tokens: maxTokens, temperature: 0.3, stream: false }),
      signal: researchState.abortController?.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    const m = text.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
  } catch(e) {}
  return null;
}

// 流式报告
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
      try { const d = JSON.parse(raw); const delta = d.choices?.[0]?.delta?.content; if (delta) onDelta(delta); } catch(e) {}
    }
  }
}

// 搜索
async function doSearch(query, config) {
  if (config.searchWorkerURL) {
    try {
      const resp = await Promise.race([
        fetch(`${config.searchWorkerURL}?q=${encodeURIComponent(query)}&count=6`),
        new Promise((_,r) => setTimeout(() => r(new Error('timeout')), 12000))
      ]);
      if (resp.ok) { const d = await resp.json(); if (d.results?.length) return d.results; }
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

// 读取网页
async function readPage(url, config) {
  if (!config.searchWorkerURL) return { error: 'no worker' };
  try {
    const resp = await Promise.race([
      fetch(`${config.searchWorkerURL}?read=${encodeURIComponent(url)}`),
      new Promise((_,r) => setTimeout(() => r(new Error('timeout')), 12000))
    ]);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    return await resp.json();
  } catch(e) { return { error: e.message }; }
}

// 构建报告消息
function buildReportMessages(query, findings, sources) {
  const findingsText = findings.map((f, i) =>
    `## 议题${i+1}: ${f.topic}\n${f.content}`
  ).join('\n\n---\n\n');

  const srcList = sources.map(s =>
    `[${s.index}] ${s.title}\nURL: ${s.url}\n摘要: ${s.snippet}`
  ).join('\n\n');

  return [
    { role: 'system', content: `你是专业研究报告撰写专家。根据提供的各议题研究发现，撰写全面深入的研究报告。
要求：
- Markdown 格式，含标题/小节/列表
- 内容全面，覆盖所有议题
- 必须在文中用 [数字] 引用来源
- 含执行摘要和结论
- 至少 1200 字
- 中文撰写` },
    { role: 'user', content: `研究主题：${query}\n\n各议题研究发现：\n${findingsText}\n\n来源列表：\n${srcList}\n\n请撰写完整研究报告。` }
  ];
}

function getDR(url) {
  try { return new URL(url).hostname.replace('www.',''); } catch { return url.slice(0,30); }
}
