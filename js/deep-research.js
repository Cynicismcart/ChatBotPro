// ============================================================
// Deep Research Engine — 深度研究引擎
// ============================================================

const researchState = {
  isRunning: false,
  abortController: null,
  steps: [],
  sources: [],
  findings: [],
  startTime: null,
  plan: '',
  callbacks: null
};
window.researchState = researchState;

const DR_SYSTEM_PROMPT = `你是一个专业的深度研究助手。你的任务是对用户提出的问题进行深入、全面的研究。

你必须通过以下 JSON 格式指令来控制研究流程（每次只输出一个 JSON 对象，不要有其他文字）：

制定计划：
{"action":"plan","topic":"研究主题","steps":["步骤1","步骤2","步骤3"]}

执行搜索：
{"action":"search","query":"具体搜索词","reason":"为什么搜索这个"}

阅读网页：
{"action":"read","url":"https://...","reason":"为什么阅读这个页面"}

生成报告（当收集到足够信息后）：
{"action":"report"}

规则：
- 先输出 plan，然后依次执行 search/read，最后输出 report
- 每次搜索后选择最相关的 1-2 个网页进行 read
- 研究步骤总数控制在 6-10 步
- 当已有足够信息时输出 report
- 只输出 JSON，不要有任何额外文字`;

const DR_REPORT_SYSTEM_PROMPT = `你是一个专业的研究报告撰写专家。根据提供的研究发现，撰写一份全面、深入、结构清晰的研究报告。

报告要求：
- 使用 Markdown 格式，包含标题、小节、列表等
- 内容全面深入，覆盖主题的各个重要方面
- 在文中使用 [1]、[2] 等编号引用对应的来源
- 包含结论和关键发现摘要
- 语言流畅，逻辑严谨
- 报告长度至少 800 字`;

// --- 启动深度研究 ---
window.startDeepResearch = async function(query, opts) {
  const { config, session, aiMsg, onProgress, onReportDelta, onComplete, onError } = opts;

  if (researchState.isRunning) return;

  // 初始化状态
  Object.assign(researchState, {
    isRunning: true,
    abortController: new AbortController(),
    steps: [],
    sources: [],
    findings: [],
    startTime: Date.now(),
    plan: '',
    callbacks: opts
  });

  addStep('plan', null, 'active', '制定研究计划');
  onProgress();

  try {
    // Step 1: 获取研究计划
    const planAction = await callLLMForAction(
      [{ role: 'user', content: `请为以下研究主题制定研究计划：${query}` }],
      config
    );

    if (researchState.abortController.signal.aborted) throw new Error('aborted');

    if (planAction && planAction.action === 'plan') {
      researchState.plan = planAction.steps ? planAction.steps.join(' → ') : query;
    }
    updateStep(0, 'done');
    onProgress();

    // Step 2: 研究循环（最多 10 轮）
    const conversationHistory = [
      { role: 'user', content: `研究主题：${query}\n\n请开始研究，先执行第一个搜索。` }
    ];

    let rounds = 0;
    const MAX_ROUNDS = 10;

    while (rounds < MAX_ROUNDS) {
      if (researchState.abortController.signal.aborted) throw new Error('aborted');

      rounds++;

      // 构建包含所有发现的上下文
      const contextMsg = buildContextMessage(researchState.findings, researchState.sources);
      const messagesForLLM = [
        ...conversationHistory,
        { role: 'user', content: contextMsg }
      ];

      const action = await callLLMForAction(messagesForLLM, config);
      if (!action) { break; }

      if (action.action === 'report') {
        break;
      } else if (action.action === 'search') {
        const stepIdx = addStep('search', action.query, 'active', `搜索: "${action.query}"`);
        onProgress();

        conversationHistory.push({ role: 'assistant', content: JSON.stringify(action) });

        try {
          const results = await doSearch(action.query, config);
          if (results.length > 0) {
            // 将搜索结果加入 sources
            results.forEach(r => {
              if (!researchState.sources.find(s => s.url === r.url)) {
                researchState.sources.push({
                  index: researchState.sources.length + 1,
                  title: r.title,
                  url: r.url,
                  snippet: r.snippet
                });
              }
            });

            const searchSummary = results.map((r, i) =>
              `[${researchState.sources.find(s => s.url === r.url)?.index || i+1}] ${r.title}\n${r.snippet}\nURL: ${r.url}`
            ).join('\n\n');

            researchState.findings.push(`搜索"${action.query}"结果：\n${searchSummary}`);
            conversationHistory.push({ role: 'user', content: `搜索完成。结果：\n${searchSummary}` });
          } else {
            conversationHistory.push({ role: 'user', content: '搜索无结果，请尝试其他关键词。' });
          }
          updateStep(stepIdx, 'done');
        } catch (e) {
          updateStep(stepIdx, 'error');
          conversationHistory.push({ role: 'user', content: `搜索失败：${e.message}` });
        }
        onProgress();

      } else if (action.action === 'read') {
        const domain = getDomainDR(action.url);
        const stepIdx = addStep('read', action.url, 'active', `阅读: ${domain}`);
        onProgress();

        conversationHistory.push({ role: 'assistant', content: JSON.stringify(action) });

        try {
          const pageData = await readPage(action.url, config);
          if (pageData.content && !pageData.error) {
            const truncated = pageData.content.slice(0, 3000);
            researchState.findings.push(`网页"${pageData.title || domain}"内容：\n${truncated}`);
            conversationHistory.push({ role: 'user', content: `页面内容：\n${truncated}` });

            // 更新 source 标题（如果有更准确的标题）
            const src = researchState.sources.find(s => s.url === action.url);
            if (src && pageData.title) src.title = pageData.title;
          } else {
            conversationHistory.push({ role: 'user', content: `无法读取页面：${pageData.error || '未知错误'}` });
          }
          updateStep(stepIdx, 'done');
        } catch (e) {
          updateStep(stepIdx, 'error');
          conversationHistory.push({ role: 'user', content: `读取页面失败：${e.message}` });
        }
        onProgress();
      }
    }

    if (researchState.abortController.signal.aborted) throw new Error('aborted');

    // Step 3: 生成最终报告
    const reportStepIdx = addStep('report', null, 'active', '生成研究报告');
    onProgress();

    const reportMessages = buildReportMessages(query, researchState.findings, researchState.sources);
    await callLLMStream(reportMessages, config, onReportDelta, researchState.abortController.signal);

    updateStep(reportStepIdx, 'done');
    researchState.isRunning = false;
    onComplete(researchState.sources);

  } catch (err) {
    researchState.isRunning = false;
    if (err.message === 'aborted') {
      onComplete(researchState.sources);
    } else {
      onError(err.message);
    }
  }
};

window.abortDeepResearch = function() {
  if (researchState.isRunning && researchState.abortController) {
    researchState.abortController.abort();
  }
};

// --- 步骤管理 ---
function addStep(type, query, status, label) {
  const idx = researchState.steps.length;
  researchState.steps.push({ type, query, status, label, timestamp: Date.now() });
  return idx;
}

function updateStep(idx, status) {
  if (researchState.steps[idx]) {
    researchState.steps[idx].status = status;
  }
}

// --- LLM 调用（非流式，返回 JSON action）---
async function callLLMForAction(messages, config) {
  const resp = await fetch(config.baseURL + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.defaultModel,
      messages: [
        { role: 'system', content: DR_SYSTEM_PROMPT },
        ...messages
      ],
      max_tokens: 512,
      temperature: 0.3,
      stream: false
    }),
    signal: researchState.abortController?.signal
  });

  if (!resp.ok) throw new Error(`LLM error ${resp.status}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content?.trim() || '';

  // 提取 JSON
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {}
  return null;
}

// --- LLM 调用（流式，用于报告生成）---
async function callLLMStream(messages, config, onDelta, signal) {
  const resp = await fetch(config.baseURL + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.defaultModel,
      messages,
      max_tokens: 4096,
      temperature: 0.7,
      stream: true
    }),
    signal
  });

  if (!resp.ok) throw new Error(`LLM stream error ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const chunk = JSON.parse(raw);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch (e) {}
    }
  }
}

// --- 搜索（复用 app.js 的 webSearch，通过全局暴露）---
async function doSearch(query, config) {
  // 优先用 Worker，fallback 用 Tavily
  if (config.searchWorkerURL) {
    try {
      const url = `${config.searchWorkerURL}?q=${encodeURIComponent(query)}&count=5`;
      const resp = await Promise.race([
        fetch(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
      ]);
      if (resp.ok) {
        const data = await resp.json();
        if (data.results) return data.results;
      }
    } catch (e) {}
  }
  if (config.tavilyKey) {
    try {
      const resp = await Promise.race([
        fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: config.tavilyKey, query, max_results: 5 })
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
      ]);
      if (resp.ok) {
        const data = await resp.json();
        return (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content || r.snippet || '' }));
      }
    } catch (e) {}
  }
  return [];
}

// --- 阅读网页（通过 Worker 的 ?read= 端点）---
async function readPage(url, config) {
  if (!config.searchWorkerURL) return { error: '未配置 Worker' };
  try {
    const resp = await Promise.race([
      fetch(`${config.searchWorkerURL}?read=${encodeURIComponent(url)}`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
    ]);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
}

// --- 构建上下文消息 ---
function buildContextMessage(findings, sources) {
  if (findings.length === 0) return '请开始第一步研究。';
  const findingsText = findings.slice(-4).join('\n\n---\n\n');
  return `已收集的研究发现：\n\n${findingsText}\n\n请根据以上发现决定下一步（继续搜索/阅读更多内容，或如果信息充足则输出 report）。`;
}

// --- 构建报告消息 ---
function buildReportMessages(query, findings, sources) {
  const sourcesText = sources.map(s =>
    `[${s.index}] ${s.title}\n${s.snippet}\nURL: ${s.url}`
  ).join('\n\n');

  const findingsText = findings.join('\n\n---\n\n');

  return [
    { role: 'system', content: DR_REPORT_SYSTEM_PROMPT },
    { role: 'user', content: `研究主题：${query}\n\n研究发现：\n${findingsText}\n\n来源列表：\n${sourcesText}\n\n请撰写完整的研究报告，在适当位置使用 [数字] 引用来源。` }
  ];
}

// --- 工具函数 ---
function getDomainDR(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url.slice(0, 30); }
}
