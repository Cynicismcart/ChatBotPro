const DR_LIMITS = {
  maxSubtopics: 6,
  minRounds: 3,
  maxRounds: 6,
  minUsefulSources: 8,
  maxQueriesPerRound: 3,
  resultsPerQuery: 8,
  maxReadsPerRound: 3,
  maxCandidateRankSize: 10,
  maxReadChars: 12000,
  maxNoteInputChars: 9000,
  maxSnapshotSources: 10,
  maxReportSources: 18,
  maxSteps: 160
};

const researchState = {
  isRunning: false,
  abortController: null,
  query: '',
  startTime: null,
  endTime: null,
  completedStatus: 'idle',
  brief: null,
  outline: [],
  steps: [],
  sources: [],
  findings: [],
  notes: [],
  searchHistory: [],
  gaps: [],
  currentFocus: '',
  stats: { currentRound: 0, roundsCompleted: 0, searches: 0, pagesRead: 0, notes: 0, reflections: 0 }
};

window.researchState = researchState;

window.startDeepResearch = async function startDeepResearch(query, opts) {
  const { config, session, onProgress, onReportDelta, onComplete, onError } = opts || {};
  if (researchState.isRunning) return;

  const runtimeConfig = {
    ...config,
    researchModel: session?.model || config?.defaultModel || ''
  };

  resetResearchState(query);
  const emitProgress = () => typeof onProgress === 'function' && onProgress();

  try {
    await runDeepResearch(query, runtimeConfig, emitProgress, onReportDelta);
    finalizeResearch('completed');
    if (typeof onComplete === 'function') onComplete(researchState.sources);
  } catch (err) {
    finalizeResearch(err.message === 'aborted' ? 'aborted' : 'error');
    if (err.message === 'aborted') {
      if (typeof onComplete === 'function') onComplete(researchState.sources);
      return;
    }
    if (typeof onError === 'function') onError(err.message || String(err));
  }
};

window.abortDeepResearch = function abortDeepResearch() {
  if (researchState.isRunning && researchState.abortController) {
    researchState.abortController.abort();
  }
};

function resetResearchState(query) {
  researchState.isRunning = true;
  researchState.abortController = new AbortController();
  researchState.query = query;
  researchState.startTime = Date.now();
  researchState.endTime = null;
  researchState.completedStatus = 'running';
  researchState.brief = null;
  researchState.outline = [];
  researchState.steps = [];
  researchState.sources = [];
  researchState.findings = [];
  researchState.notes = [];
  researchState.searchHistory = [];
  researchState.gaps = [];
  researchState.currentFocus = '';
  researchState.stats = { currentRound: 0, roundsCompleted: 0, searches: 0, pagesRead: 0, notes: 0, reflections: 0 };
}

function finalizeResearch(status) {
  researchState.isRunning = false;
  researchState.endTime = Date.now();
  researchState.completedStatus = status;
}

async function runDeepResearch(query, config, emitProgress, onReportDelta) {
  const planStep = addStep('plan', '正在制定研究蓝图...', 'active');
  emitProgress();

  const brief = await buildResearchBrief(query, config);
  assertNotAborted();

  researchState.brief = brief;
  researchState.outline = brief.subtopics.slice(0, DR_LIMITS.maxSubtopics).map(item => ({
    topic: item.topic,
    reason: item.reason || '',
    status: 'pending',
    coverage: 0,
    evidenceCount: 0,
    sourceIndices: [],
    lastUpdatedRound: 0
  }));
  researchState.gaps = brief.successCriteria.slice(0, 6);
  researchState.currentFocus = brief.goal || query;
  updateStep(planStep, 'done', `已规划 ${researchState.outline.length} 个研究方向`);
  emitProgress();

  let roundPlan = {
    focus: brief.goal || query,
    assessment: '根据初始规划开始研究',
    gaps: brief.successCriteria.slice(0, 6),
    coverage: [],
    queries: normalizePlannedQueries(brief.initialQueries, brief.subtopics),
    shouldStop: false,
    stopReason: ''
  };

  for (let round = 1; round <= DR_LIMITS.maxRounds; round++) {
    assertNotAborted();
    researchState.stats.currentRound = round;
    const roundStep = addStep('round', `第 ${round} 轮研究：${roundPlan.focus || query}`, 'active');
    emitProgress();

    if (round > 1) {
      const reflectStep = addStep('reflect', `评估已收集证据并规划第 ${round} 轮`, 'active');
      emitProgress();
      roundPlan = await reflectAndPlanNextRound(query, config);
      researchState.currentFocus = roundPlan.focus || query;
      researchState.gaps = roundPlan.gaps.length ? roundPlan.gaps.slice(0, 6) : researchState.gaps;
      applyCoverageUpdates(roundPlan.coverage, round);
      researchState.stats.reflections += 1;
      updateStep(reflectStep, 'done', roundPlan.assessment || `已更新第 ${round} 轮重点`);
      emitProgress();
      if (shouldStopResearch(roundPlan, round)) {
        updateStep(roundStep, 'done', roundPlan.stopReason || '主要问题已覆盖');
        researchState.stats.roundsCompleted = round - 1;
        emitProgress();
        break;
      }
    }

    const queries = ensureRoundQueries(roundPlan, query, round);
    if (!queries.length) {
      updateStep(roundStep, 'done', '没有新的高价值查询');
      researchState.stats.roundsCompleted = round - 1;
      emitProgress();
      if (round >= DR_LIMITS.minRounds) break;
      continue;
    }

    const touched = [];
    for (const plannedQuery of queries) {
      const found = await executeSearch(plannedQuery, config, round);
      touched.push(...found);
      emitProgress();
    }

    const readTargets = await selectSourcesToRead(query, config, roundPlan, round, touched);
    for (const source of readTargets) {
      await readAndAnalyzeSource(query, config, source, roundPlan, round);
      emitProgress();
    }

    updateOutlineHeuristics(round);
    updateStep(roundStep, 'done', summarizeRound(round, queries, readTargets));
    researchState.stats.roundsCompleted = round;
    emitProgress();
    if (canStopHeuristically(round)) break;
  }

  const synthStep = addStep('synthesize', '整理结构化笔记...', 'active');
  emitProgress();
  researchState.findings = buildTopicFindings();
  updateStep(synthStep, 'done', `已整理 ${researchState.findings.length} 个主题摘要`);
  emitProgress();

  const reportStep = addStep('report', '正在撰写研究报告...', 'active');
  emitProgress();
  await streamReport(buildReportMessages(query), config, onReportDelta, researchState.abortController.signal);
  updateStep(reportStep, 'done', '研究报告已生成');
  emitProgress();
}

async function buildResearchBrief(query, config) {
  const prompt = [
    { role: 'system', content: '你是顶级研究主管。为自动化深度研究生成初始蓝图。只返回严格 JSON。' },
    { role: 'user', content: [
      `研究主题：${query}`,
      '返回 {"goal":"","subtopics":[{"topic":"","reason":""}],"initialQueries":[],"successCriteria":[]}',
      `subtopics 最多 ${DR_LIMITS.maxSubtopics} 个，initialQueries 4-6 个，successCriteria 4-6 个。`
    ].join('\n') }
  ];
  const raw = await requestJSON(prompt, config, 900, 0.2);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return buildFallbackBrief(query);
  const subtopics = normalizeBriefSubtopics(raw.subtopics, query);
  return {
    goal: cleanText(raw.goal) || query,
    subtopics: subtopics.length ? subtopics : buildFallbackBrief(query).subtopics,
    initialQueries: normalizeStringArray(raw.initialQueries, 6),
    successCriteria: normalizeStringArray(raw.successCriteria, 6)
  };
}

async function reflectAndPlanNextRound(query, config) {
  const prompt = [
    { role: 'system', content: '你是深度研究总监。根据已有笔记评估覆盖度、缺口和下一轮查询。只返回严格 JSON。' },
    { role: 'user', content: [
      `研究主题：${query}`,
      buildResearchSnapshot(),
      '返回 {"focus":"","assessment":"","coverage":[{"topic":"","score":0,"status":"pending|active|done","reason":""}],"gaps":[],"queries":[{"q":"","topic":"","purpose":"explore|verify|fill_gap"}],"shouldStop":false,"stopReason":""}',
      `queries 最多 ${DR_LIMITS.maxQueriesPerRound} 条；关键结论缺乏交叉验证时至少给 1 条 verify 查询。`
    ].join('\n\n') }
  ];
  const raw = await requestJSON(prompt, config, 1100, 0.15);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return buildFallbackRoundPlan(query);
  return {
    focus: cleanText(raw.focus) || query,
    assessment: cleanText(raw.assessment) || '',
    coverage: normalizeCoverageUpdates(raw.coverage),
    gaps: normalizeStringArray(raw.gaps, 6),
    queries: normalizePlannedQueries(raw.queries, researchState.outline),
    shouldStop: !!raw.shouldStop,
    stopReason: cleanText(raw.stopReason) || ''
  };
}

async function executeSearch(plannedQuery, config, round) {
  const q = cleanText(plannedQuery?.q || plannedQuery);
  if (!q) return [];

  const step = addStep('search', `搜索：${q}`, 'active');
  const results = await doSearch(q, config);
  assertNotAborted();

  researchState.stats.searches += 1;
  researchState.searchHistory.push({
    query: q,
    topic: cleanText(plannedQuery?.topic || ''),
    purpose: cleanText(plannedQuery?.purpose || 'explore'),
    round,
    results: results.length
  });

  const discovered = [];
  for (const result of results) {
    const source = mergeSource(result, {
      round,
      query: q,
      topic: cleanText(plannedQuery?.topic || ''),
      purpose: cleanText(plannedQuery?.purpose || 'explore')
    });
    if (source) discovered.push(source);
  }

  updateStep(step, 'done', `搜索：${q}（发现 ${results.length} 条）`);
  return discovered;
}

async function selectSourcesToRead(query, config, roundPlan, round, touched) {
  const pool = uniqueBy(
    [...touched, ...researchState.sources.filter(source => !source.analyzed && source.status !== 'error')],
    source => source.index
  )
    .map(source => ({ source, score: scoreSourceForReading(source, query, roundPlan, round) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, DR_LIMITS.maxCandidateRankSize);

  if (!pool.length) return [];

  const ranked = await rankReadCandidates(query, config, roundPlan, pool.map(item => item.source));
  const ordered = ranked.length
    ? uniqueBy(ranked.map(index => pool.find(item => item.source.index === index)?.source).filter(Boolean), source => source.index)
    : pool.map(item => item.source);

  return ordered.slice(0, DR_LIMITS.maxReadsPerRound);
}

async function rankReadCandidates(query, config, roundPlan, candidates) {
  if (candidates.length <= 1) return candidates.map(source => source.index);

  const prompt = [
    { role: 'system', content: '你是研究助理，从候选网页中选出最值得优先深读的页面。只返回 source index 的 JSON 数组。' },
    { role: 'user', content: [
      `研究主题：${query}`,
      `当前重点：${roundPlan.focus || query}`,
      `当前缺口：${(roundPlan.gaps || []).join(' | ') || '无'}`,
      '候选来源：',
      candidates.map(source => [
        `[${source.index}] ${source.title}`,
        `domain: ${source.domain}`,
        `query: ${source.discoveredBy?.slice(-1)[0] || ''}`,
        `purpose: ${source.purposes?.slice(-1)[0] || ''}`,
        `snippet: ${source.rawSnippet || source.snippet || ''}`
      ].join('\n')).join('\n\n'),
      `返回格式示例：[3,1,5]，最多返回 ${DR_LIMITS.maxReadsPerRound} 个。`
    ].join('\n\n') }
  ];

  const raw = await requestJSON(prompt, config, 250, 0);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(value => parseInt(value, 10))
    .filter(value => Number.isInteger(value) && candidates.some(source => source.index === value));
}

async function readAndAnalyzeSource(query, config, source, roundPlan, round) {
  if (!source || source.analyzed || source.status === 'error') return;

  const readStep = addStep('read', `阅读：[${source.index}] ${source.domain}`, 'active');
  let note = null;
  let page = null;

  if (config.searchWorkerURL) {
    page = await readPage(source.url, config, DR_LIMITS.maxReadChars);
    assertNotAborted();
  }

  if (page?.content && !page.error) {
    researchState.stats.pagesRead += 1;
    source.readCount = (source.readCount || 0) + 1;
    note = await extractPageInsights(query, config, source, page, roundPlan);
    assertNotAborted();
  }

  if (!note) note = buildFallbackNote(source, roundPlan);

  if (!note || !note.useful) {
    source.status = page?.error ? 'error' : 'discovered';
    source.readError = page?.error || '';
    updateStep(
      readStep,
      page?.error ? 'error' : 'done',
      page?.error ? `阅读失败：[${source.index}] ${source.domain} (${page.error})` : `跳过：[${source.index}] ${source.domain}`
    );
    return;
  }

  applyNoteToResearchState(source, note, page, round);
  updateStep(readStep, 'done', `已提炼：[${source.index}] ${truncateText(source.title, 56)}`);
}

async function extractPageInsights(query, config, source, page, roundPlan) {
  const prompt = [
    { role: 'system', content: '你是深度研究分析师，从网页正文中提取和研究主题最相关的结构化信息。coveredTopics 只能使用给定子议题原文。只返回严格 JSON。' },
    { role: 'user', content: [
      `研究主题：${query}`,
      `当前重点：${roundPlan.focus || query}`,
      `来源标题：${page.title || source.title}`,
      `来源 URL：${source.url}`,
      `候选子议题：${researchState.outline.map(item => item.topic).join(' | ')}`,
      '返回 {"useful":true,"summary":"","coveredTopics":[],"keyPoints":[],"evidence":[],"openQuestions":[],"credibility":"high|medium|low","importance":1}',
      '如果页面基本无关，返回 {"useful":false,"summary":"原因"}。',
      '网页正文：',
      clipPromptText(page.content, DR_LIMITS.maxNoteInputChars)
    ].join('\n\n') }
  ];

  const raw = await requestJSON(prompt, config, 900, 0.15);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.useful === false) return { useful: false, summary: cleanText(raw.summary) || '页面关联较弱' };

  const summary = cleanText(raw.summary);
  const keyPoints = normalizeStringArray(raw.keyPoints, 4);
  const evidence = normalizeStringArray(raw.evidence, 4);
  if (!summary && !keyPoints.length && !evidence.length) return null;

  return {
    useful: true,
    summary: summary || keyPoints[0] || source.rawSnippet || source.title,
    coveredTopics: matchTopicsToOutline(raw.coveredTopics).length ? matchTopicsToOutline(raw.coveredTopics) : guessTopicsForSource(source),
    keyPoints,
    evidence,
    openQuestions: normalizeStringArray(raw.openQuestions, 3),
    credibility: normalizeCredibility(raw.credibility),
    importance: clampInt(raw.importance, 1, 5, 3),
    mode: 'page'
  };
}

function buildFallbackNote(source, roundPlan) {
  const summary = cleanText(source.rawSnippet || source.snippet || source.title);
  if (!summary) return null;
  return {
    useful: true,
    summary: truncateText(summary, 240),
    coveredTopics: guessTopicsForSource(source),
    keyPoints: [truncateText(summary, 220)],
    evidence: [],
    openQuestions: normalizeStringArray(roundPlan?.gaps, 1),
    credibility: 'unknown',
    importance: 2,
    mode: 'snippet'
  };
}

function applyNoteToResearchState(source, note, page, round) {
  source.title = page?.title || source.title;
  source.summary = note.summary;
  source.snippet = note.summary;
  source.rawSnippet = source.rawSnippet || source.snippet;
  source.coveredTopics = note.coveredTopics.slice();
  source.keyPoints = note.keyPoints.slice();
  source.evidence = note.evidence.slice();
  source.openQuestions = note.openQuestions.slice();
  source.credibility = note.credibility;
  source.importance = note.importance;
  source.analyzed = true;
  source.status = note.mode === 'page' ? 'analyzed' : 'noted';
  source.lastAnalyzedRound = round;
  source.readError = '';

  const noteRecord = {
    sourceIndex: source.index,
    url: source.url,
    title: source.title,
    summary: note.summary,
    coveredTopics: note.coveredTopics.slice(),
    keyPoints: note.keyPoints.slice(),
    evidence: note.evidence.slice(),
    openQuestions: note.openQuestions.slice(),
    credibility: note.credibility,
    importance: note.importance,
    mode: note.mode
  };

  const existing = researchState.notes.findIndex(item => item.sourceIndex === source.index);
  if (existing >= 0) researchState.notes[existing] = noteRecord;
  else researchState.notes.push(noteRecord);
  researchState.stats.notes = researchState.notes.length;

  for (const topic of note.coveredTopics) {
    const item = researchState.outline.find(entry => entry.topic === topic);
    if (!item) continue;
    if (!item.sourceIndices.includes(source.index)) item.sourceIndices.push(source.index);
    item.evidenceCount = item.sourceIndices.length;
    item.lastUpdatedRound = round;
    const domainCount = uniqueBy(
      item.sourceIndices.map(index => researchState.sources.find(entry => entry.index === index)).filter(Boolean),
      entry => entry.domain
    ).length;
    const credibilityBoost = note.credibility === 'high' ? 12 : note.credibility === 'medium' ? 6 : 0;
    item.coverage = Math.min(100, Math.max(item.coverage, item.evidenceCount * 22 + domainCount * 10 + note.importance * 6 + credibilityBoost));
    item.status = item.coverage >= 72 || item.evidenceCount >= 3 ? 'done' : 'active';
  }
}

function applyCoverageUpdates(updates, round) {
  for (const update of updates) {
    const item = researchState.outline.find(entry => entry.topic === update.topic);
    if (!item) continue;
    item.coverage = Math.max(item.coverage, clampInt(update.score, 0, 100, item.coverage));
    item.status = ['pending', 'active', 'done'].includes(update.status) ? update.status : item.status;
    item.lastUpdatedRound = round;
  }
}

function updateOutlineHeuristics(round) {
  for (const item of researchState.outline) {
    if (!item.evidenceCount) {
      item.status = item.status === 'active' ? 'active' : 'pending';
      continue;
    }
    if (item.status !== 'done' && (item.lastUpdatedRound === round || item.evidenceCount > 0)) {
      item.status = item.coverage >= 72 || item.evidenceCount >= 3 ? 'done' : 'active';
    }
  }
}

function buildTopicFindings() {
  return researchState.outline.map(item => {
    const notes = researchState.notes
      .filter(note => note.coveredTopics.includes(item.topic))
      .sort((a, b) => (b.importance - a.importance) || (b.evidence.length - a.evidence.length))
      .slice(0, 5);

    if (!notes.length) {
      return { topic: item.topic, content: '- 当前资料仍不足，需要继续补充高质量来源。' };
    }

    const lines = [];
    const summaries = uniqueBy(notes.map(note => ({ text: `${note.summary} [${note.sourceIndex}]`, key: note.summary })), entry => entry.key).slice(0, 3);
    for (const entry of summaries) lines.push(`- ${entry.text}`);

    const detailLines = [];
    for (const note of notes) {
      for (const point of note.keyPoints.slice(0, 2)) detailLines.push(`- ${point} [${note.sourceIndex}]`);
      for (const fact of note.evidence.slice(0, 1)) detailLines.push(`- ${fact} [${note.sourceIndex}]`);
    }
    lines.push(...uniqueBy(detailLines.map(text => ({ text, key: text })), entry => entry.key).slice(0, 5).map(entry => entry.text));

    const gap = researchState.gaps.find(value => includesFuzzy(value, item.topic));
    if (gap && item.coverage < 80) lines.push(`- 仍待补充：${gap}`);
    return { topic: item.topic, content: lines.join('\n') };
  });
}

function buildReportMessages(query) {
  const brief = researchState.brief || buildFallbackBrief(query);
  const topicSummaries = researchState.findings.map((finding, index) => `## 主题 ${index + 1}: ${finding.topic}\n${finding.content}`).join('\n\n');
  const evidenceDigest = researchState.notes
    .sort((a, b) => (b.importance - a.importance) || (b.evidence.length - a.evidence.length))
    .slice(0, DR_LIMITS.maxReportSources)
    .map(note => {
      const bullets = uniqueBy([...note.keyPoints, ...note.evidence].map(text => ({ text, key: text })), entry => entry.key)
        .slice(0, 4)
        .map(entry => `- ${entry.text}`)
        .join('\n');
      return [`[${note.sourceIndex}] ${note.title}`, `topics: ${note.coveredTopics.join(' | ') || '未归类'}`, `summary: ${note.summary}`, `credibility: ${note.credibility}`, bullets].filter(Boolean).join('\n');
    })
    .join('\n\n');
  const sourceList = researchState.sources.map(source => `[${source.index}] ${source.title}\nURL: ${source.url}`).join('\n\n');

  return [
    { role: 'system', content: '你是顶级深度研究分析师。输出 Markdown 中文研究报告，先给执行摘要，再给关键发现表格，再展开分主题分析，最后写结论与不确定性。所有关键判断都要用 [数字] 引用来源编号。' },
    { role: 'user', content: [
      `研究主题：${query}`,
      `研究目标：${brief.goal}`,
      `研究成功标准：${brief.successCriteria.join(' | ') || '无'}`,
      '研究蓝图：',
      brief.subtopics.map((item, index) => `${index + 1}. ${item.topic} - ${item.reason}`).join('\n'),
      '按主题整理后的研究发现：',
      topicSummaries,
      '结构化证据摘录：',
      evidenceDigest || '暂无',
      `当前仍存在的缺口：${researchState.gaps.join(' | ') || '无明显缺口'}`,
      '来源列表：',
      sourceList,
      '请基于上述材料写出完整研究报告。'
    ].join('\n\n') }
  ];
}

async function doSearch(query, config) {
  if (config.searchWorkerURL) {
    try {
      const workerURL = `${config.searchWorkerURL.replace(/\/+$/, '')}?q=${encodeURIComponent(query)}&count=${DR_LIMITS.resultsPerQuery}`;
      const resp = await withTimeout(fetch(workerURL), 12000);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.results) && data.results.length) {
          return data.results.map(normalizeSearchResult).filter(Boolean);
        }
      }
    } catch (err) {}
  }

  if (config.tavilyKey) {
    try {
      const resp = await withTimeout(fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: config.tavilyKey,
          query,
          max_results: DR_LIMITS.resultsPerQuery,
          include_answer: false,
          search_depth: 'advanced'
        })
      }), 12000);

      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.results)) {
          return data.results
            .map(result => normalizeSearchResult({ title: result.title, url: result.url, snippet: result.content || result.snippet || '' }))
            .filter(Boolean);
        }
      }
    } catch (err) {}
  }

  return [];
}

async function readPage(url, config, maxLen) {
  if (!config.searchWorkerURL) return { error: 'no worker', url };
  try {
    const workerURL = `${config.searchWorkerURL.replace(/\/+$/, '')}?read=${encodeURIComponent(url)}&maxLen=${maxLen}`;
    const resp = await withTimeout(fetch(workerURL), 18000);
    if (!resp.ok) return { error: `HTTP ${resp.status}`, url };
    return await resp.json();
  } catch (err) {
    return { error: err.message || String(err), url };
  }
}

async function requestJSON(messages, config, maxTokens, temperature) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await chatOnce(messages, config, maxTokens, temperature);
      const json = extractJSON(text);
      if (json !== null) return json;
    } catch (err) {
      if (attempt === 1) return null;
    }
  }
  return null;
}

async function chatOnce(messages, config, maxTokens, temperature) {
  const resp = await fetch(`${config.baseURL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.researchModel || config.defaultModel,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false
    }),
    signal: researchState.abortController?.signal
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`LLM ${resp.status}: ${errText.slice(0, 160)}`);
  }

  const data = await resp.json();
  return cleanText(data.choices?.[0]?.message?.content || '');
}

async function streamReport(messages, config, onDelta, signal) {
  const resp = await fetch(`${config.baseURL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.researchModel || config.defaultModel,
      messages,
      max_tokens: 4800,
      temperature: 0.35,
      stream: true
    }),
    signal
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`LLM ${resp.status}: ${errText.slice(0, 160)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const chunk = JSON.parse(raw);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta && typeof onDelta === 'function') onDelta(delta);
      } catch (err) {}
    }
  }
}

function buildResearchSnapshot() {
  const outlineText = researchState.outline.map(item => [
    `- ${item.topic}`,
    `  status: ${item.status}`,
    `  coverage: ${item.coverage}`,
    `  evidence: ${item.evidenceCount}`,
    item.reason ? `  why: ${item.reason}` : ''
  ].filter(Boolean).join('\n')).join('\n');

  const recentQueries = researchState.searchHistory.slice(-8)
    .map(entry => `- ${entry.query} | topic=${entry.topic || '未指定'} | purpose=${entry.purpose} | results=${entry.results}`)
    .join('\n') || '- 尚无';

  const sourceDigest = researchState.sources
    .filter(source => source.analyzed || source.summary)
    .slice(-DR_LIMITS.maxSnapshotSources)
    .map(source => [
      `[${source.index}] ${source.title}`,
      `domain: ${source.domain}`,
      `topics: ${(source.coveredTopics || []).join(' | ') || '未归类'}`,
      `summary: ${source.summary || source.snippet || ''}`,
      source.keyPoints?.length ? `points: ${source.keyPoints.join(' | ')}` : ''
    ].filter(Boolean).join('\n'))
    .join('\n\n') || '暂无';

  return [
    `当前轮次：${researchState.stats.currentRound}`,
    `已完成轮次：${researchState.stats.roundsCompleted}`,
    `来源数：${researchState.sources.length}`,
    `已读页面：${researchState.stats.pagesRead}`,
    `已提炼笔记：${researchState.notes.length}`,
    '子议题覆盖：',
    outlineText || '- 暂无',
    '最近查询：',
    recentQueries,
    '关键来源摘要：',
    sourceDigest,
    `当前缺口：${researchState.gaps.join(' | ') || '无'}`
  ].join('\n\n');
}

function buildFallbackBrief(query) {
  const q = cleanText(query);
  return {
    goal: q,
    subtopics: [
      { topic: `${q} 的定义与研究范围`, reason: '先建立边界。' },
      { topic: `${q} 的现状与关键事实`, reason: '掌握当前主流信息和数据。' },
      { topic: `${q} 的主要参与者与利益相关方`, reason: '识别核心主体和立场。' },
      { topic: `${q} 的争议、风险与限制`, reason: '覆盖反面证据与不确定性。' },
      { topic: `${q} 的趋势与未来影响`, reason: '补足时间维度。' }
    ],
    initialQueries: [q, `${q} 最新进展`, `${q} 数据 报告`, `${q} 争议 风险`, `${q} 趋势 分析`],
    successCriteria: [
      '主要结论是否有多个独立来源支持',
      '关键争议点是否已识别并标出不确定性',
      '是否覆盖背景、现状、风险和趋势',
      '是否找到了具体数据或事实依据'
    ]
  };
}

function buildFallbackRoundPlan(query) {
  const weakest = researchState.outline.slice().sort((a, b) => a.coverage - b.coverage).slice(0, 2);
  const queries = [];
  for (const item of weakest) {
    queries.push({ q: `${query} ${item.topic}`, topic: item.topic, purpose: 'fill_gap' });
    if (queries.length < DR_LIMITS.maxQueriesPerRound) {
      queries.push({ q: `${item.topic} 数据 报告`, topic: item.topic, purpose: 'verify' });
    }
  }
  return {
    focus: weakest[0]?.topic || query,
    assessment: '使用启发式策略补齐覆盖度最低的主题。',
    coverage: researchState.outline.map(item => ({ topic: item.topic, score: item.coverage, status: item.status, reason: item.reason || '' })),
    gaps: researchState.gaps.slice(0, 6),
    queries: queries.slice(0, DR_LIMITS.maxQueriesPerRound),
    shouldStop: false,
    stopReason: ''
  };
}

function normalizeBriefSubtopics(value, query) {
  const items = Array.isArray(value) ? value : [];
  const result = [];
  for (const entry of items) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      const topic = cleanText(entry);
      if (topic) result.push({ topic, reason: '' });
      continue;
    }
    const topic = cleanText(entry.topic || entry.name || '');
    const reason = cleanText(entry.reason || entry.why || '');
    if (topic) result.push({ topic, reason });
  }
  const deduped = uniqueBy(result, item => item.topic.toLowerCase()).slice(0, DR_LIMITS.maxSubtopics);
  return deduped.length ? deduped : buildFallbackBrief(query).subtopics;
}

function normalizeCoverageUpdates(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map(entry => ({ topic: cleanText(entry?.topic || ''), score: clampInt(entry?.score, 0, 100, 0), status: cleanText(entry?.status || ''), reason: cleanText(entry?.reason || '') }))
    .filter(entry => entry.topic);
}

function normalizePlannedQueries(value, outline) {
  const items = Array.isArray(value) ? value : [];
  const topics = Array.isArray(outline) ? outline.map(item => item.topic || item).filter(Boolean) : [];
  const normalized = items.map(entry => {
    if (typeof entry === 'string') return { q: cleanText(entry), topic: topics[0] || '', purpose: 'explore' };
    return {
      q: cleanText(entry?.q || entry?.query || ''),
      topic: cleanText(entry?.topic || '') || topics[0] || '',
      purpose: cleanText(entry?.purpose || 'explore')
    };
  }).filter(entry => entry.q);
  return uniqueBy(normalized, entry => entry.q.toLowerCase()).slice(0, DR_LIMITS.maxQueriesPerRound + 2);
}

function normalizeStringArray(value, limit) {
  const items = Array.isArray(value) ? value : [];
  return uniqueBy(
    items.map(item => ({ text: cleanText(item), key: cleanText(item).toLowerCase() })).filter(item => item.text),
    item => item.key
  ).slice(0, limit).map(item => item.text);
}

function normalizeSearchResult(result) {
  const url = normalizeURL(result?.url || '');
  if (!url) return null;
  return {
    title: cleanText(result?.title || url) || url,
    url,
    snippet: cleanText(result?.snippet || result?.content || '')
  };
}

function mergeSource(result, meta) {
  const url = normalizeURL(result.url);
  if (!url) return null;

  let source = researchState.sources.find(item => item.url === url);
  if (!source) {
    source = {
      index: researchState.sources.length + 1,
      title: result.title || url,
      url,
      domain: getDomain(url),
      snippet: result.snippet || '',
      rawSnippet: result.snippet || '',
      analyzed: false,
      status: 'discovered',
      readCount: 0,
      discoveredRound: meta.round,
      discoveredBy: [],
      purposes: [],
      topics: [],
      coveredTopics: [],
      keyPoints: [],
      evidence: [],
      openQuestions: [],
      credibility: 'unknown',
      importance: 0,
      lastAnalyzedRound: 0,
      readError: ''
    };
    researchState.sources.push(source);
  }

  source.title = betterText(result.title, source.title);
  source.snippet = betterText(source.summary || '', betterText(result.snippet, source.snippet));
  source.rawSnippet = betterText(result.snippet, source.rawSnippet);
  if (meta.query && !source.discoveredBy.includes(meta.query)) source.discoveredBy.push(meta.query);
  if (meta.purpose && !source.purposes.includes(meta.purpose)) source.purposes.push(meta.purpose);
  if (meta.topic && !source.topics.includes(meta.topic)) source.topics.push(meta.topic);
  return source;
}

function ensureRoundQueries(roundPlan, query, round) {
  const planned = normalizePlannedQueries(roundPlan?.queries, researchState.outline);
  const seen = new Set(researchState.searchHistory.map(entry => entry.query.toLowerCase()));
  const queries = [];

  for (const entry of planned) {
    if (seen.has(entry.q.toLowerCase())) continue;
    queries.push(entry);
    if (queries.length >= DR_LIMITS.maxQueriesPerRound) return queries;
  }

  const weakest = researchState.outline.slice().sort((a, b) => a.coverage - b.coverage).slice(0, 2);
  for (const item of weakest) {
    for (const fallback of [
      { q: `${query} ${item.topic}`, topic: item.topic, purpose: 'fill_gap' },
      { q: `${item.topic} 数据 报告`, topic: item.topic, purpose: 'verify' },
      { q: `${item.topic} 深度 分析`, topic: item.topic, purpose: 'explore' }
    ]) {
      if (seen.has(fallback.q.toLowerCase())) continue;
      if (queries.some(entry => entry.q.toLowerCase() === fallback.q.toLowerCase())) continue;
      queries.push(fallback);
      if (queries.length >= DR_LIMITS.maxQueriesPerRound) return queries;
    }
  }

  if (!queries.length && round === 1) {
    queries.push({ q: query, topic: researchState.outline[0]?.topic || '', purpose: 'explore' });
  }
  return queries.slice(0, DR_LIMITS.maxQueriesPerRound);
}

function shouldStopResearch(roundPlan, round) {
  return !!roundPlan.shouldStop && round >= DR_LIMITS.minRounds && researchState.notes.length >= Math.min(DR_LIMITS.minUsefulSources, researchState.sources.length);
}

function canStopHeuristically(round) {
  if (round < DR_LIMITS.minRounds || researchState.notes.length < DR_LIMITS.minUsefulSources) return false;
  const doneCount = researchState.outline.filter(item => item.status === 'done').length;
  return doneCount >= Math.max(3, Math.ceil(researchState.outline.length * 0.7));
}

function summarizeRound(round, queries, readTargets) {
  return `第 ${round} 轮完成：${queries.length} 次搜索，${readTargets.length} 个重点来源`;
}

function scoreSourceForReading(source, query, roundPlan, round) {
  const text = `${source.title} ${source.rawSnippet || ''}`.toLowerCase();
  const keywords = tokenize([query, roundPlan?.focus, ...(roundPlan?.gaps || []), ...(source.topics || [])].join(' '));
  let score = 20;
  if (!source.analyzed) score += 18;
  if (source.discoveredRound === round) score += 8;
  if ((source.purposes || []).includes('verify')) score += 10;
  if ((source.purposes || []).includes('fill_gap')) score += 8;
  if (/\d/.test(text)) score += 4;
  if (/report|study|paper|analysis|research|survey|white paper/.test(text)) score += 5;
  if (/login|signin|subscribe|advertisement|cookie/.test(text)) score -= 18;
  for (const word of keywords) {
    if (word.length > 1 && text.includes(word)) score += 3;
  }
  const domainReads = researchState.sources.filter(item => item.domain === source.domain && item.analyzed).length;
  return score - domainReads * 4;
}

function guessTopicsForSource(source) {
  const text = `${source.title} ${source.rawSnippet || source.snippet || ''}`;
  const matches = researchState.outline
    .map(item => ({ topic: item.topic, score: overlapScore(text, item.topic) }))
    .sort((a, b) => b.score - a.score)
    .filter(item => item.score > 0)
    .slice(0, 2)
    .map(item => item.topic);
  return matches.length ? matches : researchState.outline.slice(0, 1).map(item => item.topic);
}

function matchTopicsToOutline(value) {
  const rawTopics = normalizeStringArray(value, 3);
  const matches = [];
  for (const raw of rawTopics) {
    const exact = researchState.outline.find(item => item.topic === raw);
    if (exact) {
      matches.push(exact.topic);
      continue;
    }
    const fuzzy = researchState.outline
      .map(item => ({ topic: item.topic, score: overlapScore(raw, item.topic) }))
      .sort((a, b) => b.score - a.score)[0];
    if (fuzzy && fuzzy.score > 0) matches.push(fuzzy.topic);
  }
  return uniqueBy(matches.map(topic => ({ topic, key: topic })), item => item.key).map(item => item.topic);
}

function addStep(type, label, status) {
  const idx = researchState.steps.length;
  researchState.steps.push({ type, label, status, time: Date.now() });
  if (researchState.steps.length > DR_LIMITS.maxSteps) {
    researchState.steps = researchState.steps.slice(-DR_LIMITS.maxSteps);
  }
  return Math.min(idx, researchState.steps.length - 1);
}

function updateStep(index, status, label) {
  const step = researchState.steps[index];
  if (!step) return;
  step.status = status;
  if (label) step.label = label;
}

function extractJSON(text) {
  const direct = tryParseJSON(text);
  if (direct !== null) return direct;
  const cleaned = cleanText(text).replace(/```json/gi, '```');
  const fenced = cleaned.match(/```([\s\S]*?)```/);
  if (fenced) {
    const parsed = tryParseJSON(fenced[1].trim());
    if (parsed !== null) return parsed;
  }
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (char !== '{' && char !== '[') continue;
    const candidate = sliceBalancedJSON(cleaned, i);
    if (!candidate) continue;
    const parsed = tryParseJSON(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function tryParseJSON(text) {
  try { return JSON.parse(text); } catch (err) { return null; }
}

function sliceBalancedJSON(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return '';
}

function assertNotAborted() {
  if (researchState.abortController?.signal.aborted) throw new Error('aborted');
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function normalizeURL(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch (err) {
    return '';
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clipPromptText(value, maxLen) {
  return cleanText(value).slice(0, maxLen);
}

function truncateText(value, maxLen) {
  const text = cleanText(value);
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function betterText(preferred, fallback) {
  const a = cleanText(preferred);
  const b = cleanText(fallback);
  return a.length >= b.length ? a : b;
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (err) { return url; }
}

function tokenize(text) {
  return Array.from(new Set(cleanText(text).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean)));
}

function overlapScore(a, b) {
  const setA = tokenize(a);
  const setB = new Set(tokenize(b));
  let score = 0;
  for (const token of setA) if (setB.has(token)) score += 1;
  return score;
}

function includesFuzzy(text, keyword) {
  const target = cleanText(text).toLowerCase();
  return tokenize(keyword).some(word => word.length > 1 && target.includes(word));
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function clampInt(value, min, max, fallback) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeCredibility(value) {
  const text = cleanText(value).toLowerCase();
  if (text === 'high' || text === 'medium' || text === 'low') return text;
  return 'unknown';
}
