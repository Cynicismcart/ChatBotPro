// ============================================================
// ChatBot Pro — PWA 核心逻辑
// ============================================================

// --- Config & State ---
const DEFAULT_CONFIG = {
  baseURL: '',
  apiKey: '',
  systemPrompt: 'You are a helpful assistant.',
  theme: 'system',
  defaultModel: '',
  models: [],
  searchEnabled: false,
  searchCount: 5,
  tavilyKey: '',
  searchWorkerURL: '',
  providers: [],        // [{name, baseURL, apiKey, models, defaultModel}]
  currentProvider: -1, // -1 = 使用手动配置，>=0 = providers 数组索引
  searchMode: 'on'     // 'off' | 'on' | 'auto'
};

let config = { ...DEFAULT_CONFIG };
let sessions = [];          // [{id, title, model, systemPrompt, messages, createdAt, updatedAt, totalTokens}]
let currentSessionId = null;
let isStreaming = false;
let abortController = null;
let selectedImageBase64 = null;

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  loadSessions();
  applyTheme();
  setupMarked();
  bindEvents();
  renderSessionList();
  renderProviderSelect();
  applyCurrentProvider();

  // 首次使用：未配置 API 时自动弹出设置
  if (!config.baseURL || !config.apiKey) {
    setTimeout(() => openSettings(), 300);
  } else if (config.models.length === 0) {
    fetchModels();
  } else {
    renderModelSelect();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});

// --- Storage (localStorage) ---
function loadConfig() {
  const saved = localStorage.getItem('chatbot_config');
  if (saved) config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
}

function saveConfig() {
  localStorage.setItem('chatbot_config', JSON.stringify(config));
}

function loadSessions() {
  const saved = localStorage.getItem('chatbot_sessions');
  if (saved) sessions = JSON.parse(saved);
}

function saveSessions() {
  localStorage.setItem('chatbot_sessions', JSON.stringify(sessions));
}

function getSession(id) {
  return sessions.find(s => s.id === id);
}

function currentSession() {
  return getSession(currentSessionId);
}

// --- Theme ---
function applyTheme() {
  const t = config.theme;
  if (t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// --- Marked config ---
function setupMarked() {
  const renderer = new marked.Renderer();
  renderer.code = function(obj) {
    const code = typeof obj === 'object' ? obj.text : obj;
    const lang = typeof obj === 'object' ? (obj.lang || '') : (arguments[1] || '');
    let highlighted;
    try {
      highlighted = lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
    } catch { highlighted = escapeHtml(code); }
    return `<div class="code-block"><div class="code-header"><span>${lang || 'code'}</span><button class="copy-btn" onclick="copyCode(this)">复制</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
  };
  marked.setOptions({ renderer, breaks: true, gfm: true });
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// --- Event Bindings ---
function bindEvents() {
  const $ = id => document.getElementById(id);

  // New chat
  $('btn-new-chat').onclick = () => { createSession(); closeSidebar(); };

  // Settings
  $('btn-settings').onclick = () => openSettings();
  $('btn-save-settings').onclick = () => saveSettings();
  $('btn-fetch-models').onclick = () => fetchModels();

  // Sidebar toggle (mobile)
  $('btn-menu').onclick = () => toggleSidebar();
  $('overlay').onclick = () => closeSidebar();

  // Send
  $('btn-send').onclick = () => handleSend();
  $('msg-input').addEventListener('input', autoResize);
  $('msg-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  });

  // Search toggle
  $('btn-search-toggle').onclick = toggleSearch;
  updateSearchBtn();

  // Deep research
  $('btn-deep-research').onclick = handleDeepResearch;
  $('dr-stop-btn').onclick = () => { window.abortDeepResearch && window.abortDeepResearch(); };
  $('dr-close-btn').onclick = closeDRPanel;
  $('dr-overlay').onclick = closeDRPanel;

  // Provider管理
  $('btn-add-provider').onclick = addProvider;
  $('provider-select').onchange = switchProvider;

  // Image
  $('image-input').onchange = handleImageSelect;
  $('btn-clear-img').onclick = clearImage;

  // Export
  $('btn-export').onclick = () => $('export-modal').style.display = 'flex';
  document.querySelectorAll('.export-btn').forEach(btn => {
    btn.onclick = () => { exportChat(btn.dataset.format); $('export-modal').style.display = 'none'; };
  });

  // Modal close
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.onclick = () => document.getElementById(btn.dataset.modal).style.display = 'none';
  });

  // Theme listener
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

function autoResize() {
  const el = document.getElementById('msg-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  updateSendBtn();
}

function updateSendBtn() {
  const btn = document.getElementById('btn-send');
  const input = document.getElementById('msg-input');
  btn.disabled = !isStreaming && !input.value.trim() && !selectedImageBase64;
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('open');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

// --- Session Management ---
function createSession() {
  const session = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: '新对话',
    model: config.defaultModel,
    systemPrompt: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalTokens: 0
  };
  sessions.unshift(session);
  saveSessions();
  switchSession(session.id);
  renderSessionList();
}

function deleteSession(id) {
  sessions = sessions.filter(s => s.id !== id);
  saveSessions();
  if (currentSessionId === id) {
    currentSessionId = sessions[0]?.id || null;
    renderChat();
  }
  renderSessionList();
}

function switchSession(id) {
  currentSessionId = id;
  renderChat();
  renderSessionList();
  updateModelSelect();
  updateTokenCount();
}

function renderSessionList() {
  const list = document.getElementById('session-list');
  if (sessions.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">点击 + 创建新对话</div>';
    return;
  }
  list.innerHTML = sessions.map(s => `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''}" onclick="switchSession('${s.id}')">
      <div class="title">${escapeHtml(s.title)}</div>
      <div class="meta">
        <span class="preview">${escapeHtml((s.messages[s.messages.length-1]?.content || '空对话').slice(0, 40))}</span>
        <button class="delete-btn" onclick="event.stopPropagation();deleteSession('${s.id}')">✕</button>
      </div>
    </div>
  `).join('');
}

// --- Chat Rendering ---
function renderChat() {
  const container = document.getElementById('messages');
  const session = currentSession();
  const empty = document.getElementById('empty-state');

  if (!session || session.messages.length === 0) {
    container.innerHTML = '';
    if (empty) container.appendChild(empty);
    empty.style.display = 'flex';
    return;
  }

  if (empty) empty.style.display = 'none';
  container.innerHTML = session.messages.map((m, i) => renderMessage(m, i)).join('');
  scrollToBottom();
}

function renderMessage(msg, index) {
  const isUser = msg.role === 'user';
  const avatar = isUser ? '👤' : '✨';
  let content = '';

  if (isUser) {
    if (msg.image) content += `<img src="${msg.image}" alt="图片">`;
    content += escapeHtml(msg.content);
  } else if (msg.deepResearch && msg.streaming) {
    content = msg.content
      ? `<div class="dr-report-streaming">${marked.parse(msg.content)}</div>`
      : `<div class="dr-summary-bar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>正在深度研究中...</div>`;
  } else if (msg.drMeta) {
    // 深度研究完成 — Gemini 风格：摘要条 + 可折叠报告
    const meta = msg.drMeta;
    const mm = String(Math.floor(meta.elapsed / 60)).padStart(2,'0');
    const ss = String(meta.elapsed % 60).padStart(2,'0');
    let reportHtml = marked.parse(msg.content || '');
    if (msg.sources && msg.sources.length > 0) {
      reportHtml = reportHtml.replace(/\[(\d+)\]/g, (match, num) => {
        const src = msg.sources.find(s => s.index === parseInt(num));
        if (src?.url) return `<a class="cite-badge" href="${escapeHtml(src.url)}" target="_blank" title="${escapeHtml(src.title)}">${num}</a>`;
        return match;
      });
    }
    const msgId = index;
    content = `
      <div class="dr-result">
        <div class="dr-result-meta" onclick="document.getElementById('dr-result-body-${msgId}').classList.toggle('open')">
          <div class="dr-result-meta-left">
            <div class="dr-result-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </div>
            <span class="dr-result-label">深度研究完成</span>
            <span class="dr-result-stat">${meta.steps} 步</span>
            <span class="dr-result-dot">·</span>
            <span class="dr-result-stat">${meta.sources} 个来源</span>
            <span class="dr-result-dot">·</span>
            <span class="dr-result-stat">${mm}:${ss}</span>
          </div>
          <svg class="dr-result-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="dr-result-body open" id="dr-result-body-${msgId}">
          <div class="dr-result-report">${reportHtml}</div>
        </div>
      </div>`;
  } else {
    content = marked.parse(msg.content || '');
    if (msg.sources && msg.sources.length > 0) {
      content = content.replace(/\[(\d+)\]/g, (match, num) => {
        const idx = parseInt(num);
        const src = msg.sources.find(s => s.index === idx);
        if (src && src.url) {
          return `<a class="cite-badge" href="${escapeHtml(src.url)}" target="_blank" title="${escapeHtml(src.title)}">${num}</a>`;
        }
        return match;
      });
    }
  }

  const tokenHtml = msg.tokens ? `<div class="token-info">${msg.tokens} tokens</div>` : '';
  const streamClass = msg.streaming ? ' streaming-dot' : '';

  // 来源卡片
  let sourcesHtml = '';
  if (!isUser && msg.sources && msg.sources.length > 0 && !msg.streaming) {
    const cards = msg.sources.map(s => {
      const domain = getDomain(s.url);
      const favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
      return `<a class="source-card" href="${escapeHtml(s.url)}" target="_blank">
        <img class="source-favicon" src="${favicon}" alt="" onerror="this.style.display='none'">
        <div class="source-info">
          <div class="source-title">${escapeHtml(s.title.slice(0, 60))}</div>
          <div class="source-domain">${escapeHtml(domain)}</div>
        </div>
        <span class="source-num">${s.index}</span>
      </a>`;
    }).join('');
    sourcesHtml = `<div class="sources-section">
      <button class="sources-toggle" onclick="this.parentElement.classList.toggle('expanded')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
        ${msg.sources.length} 个来源
        <svg class="sources-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="sources-list">${cards}</div>
    </div>`;
  }

  return `<div class="message ${msg.role}">
    <div class="avatar">${avatar}</div>
    <div class="bubble-wrap">
      <div class="bubble${streamClass}">${content}${tokenHtml}</div>
      ${sourcesHtml}
    </div>
  </div>`;
}

function getDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

function scrollToBottom() {
  const el = document.getElementById('messages');
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function updateTokenCount() {
  const session = currentSession();
  const el = document.getElementById('token-count');
  if (session && session.totalTokens > 0) {
    el.textContent = `${session.totalTokens} tokens`;
  } else {
    el.textContent = '';
  }
}

// --- Deep Research 侧边面板 ---
function openDRPanel() {
  document.getElementById('dr-panel').classList.add('open');
  document.getElementById('dr-overlay').style.display = 'block';
}

function closeDRPanel() {
  document.getElementById('dr-panel').classList.remove('open');
  document.getElementById('dr-overlay').style.display = 'none';
}

function updateDRPanel() {
  const state = window.researchState;
  if (!state) return;

  // 计时器
  const elapsed = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const timerEl = document.getElementById('dr-timer');
  if (timerEl) timerEl.textContent = `${mm}:${ss}`;

  // 进度条
  const total = state.steps.length || 1;
  const done = state.steps.filter(s => s.status === 'done').length;
  const pct = Math.max(5, Math.round((done / total) * 100));
  const fill = document.getElementById('dr-progress-fill');
  if (fill) {
    fill.style.width = pct + '%';
    if (state.isRunning) fill.classList.add('running');
    else fill.classList.remove('running');
  }

  // 研究计划
  if (state.plan) {
    const planSec = document.getElementById('dr-plan-section');
    const planText = document.getElementById('dr-plan-text');
    if (planSec) planSec.style.display = 'block';
    if (planText) planText.textContent = state.plan;
  }

  // 步骤计数
  const stepCount = document.getElementById('dr-step-count');
  if (stepCount) stepCount.textContent = `${state.steps.filter(s=>s.status==='done').length}/${state.steps.length}`;

  // 步骤列表
  const stepsList = document.getElementById('dr-steps-list');
  if (stepsList) {
    const typeLabel = { plan: '计划', search: '搜索', read: '阅读', report: '报告' };
    const iconMap = { done: '✓', active: '▶', error: '✕', pending: '·' };
    stepsList.innerHTML = state.steps.map(step => {
      const tLabel = typeLabel[step.type] || step.type;
      const icon = iconMap[step.status] || '·';
      return `<div class="dr-step-item ${step.status}">
        <div class="dr-step-dot">${icon}</div>
        <div class="dr-step-content">
          <div class="dr-step-type">${tLabel}</div>
          <div class="dr-step-text">${escapeHtml(step.label)}</div>
        </div>
      </div>`;
    }).join('');
  }

  // 来源
  const sourceCount = state.sources.length;
  if (sourceCount > 0) {
    const srcPanel = document.getElementById('dr-sources-panel');
    const srcCount = document.getElementById('dr-source-count');
    const srcChips = document.getElementById('dr-sources-chips');
    if (srcPanel) srcPanel.style.display = 'block';
    if (srcCount) srcCount.textContent = sourceCount;
    if (srcChips) {
      srcChips.innerHTML = state.sources.map(s => {
        const domain = getDomain(s.url);
        const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
        return `<a class="dr-chip" href="${escapeHtml(s.url)}" target="_blank">
          <img src="${favicon}" alt="" onerror="this.style.display='none'">
          <span>${escapeHtml(domain)}</span>
        </a>`;
      }).join('');
    }
  }
}

async function handleDeepResearch() {
  if (isStreaming) { stopStreaming(); return; }

  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) { alert('请输入研究主题'); return; }
  if (!config.searchWorkerURL && !config.tavilyKey) {
    alert('深度研究需要搜索功能，请先在设置中配置搜索 Worker URL 或 Tavily Key'); return;
  }
  if (!config.baseURL || !config.apiKey) { openSettings(); return; }

  if (!currentSessionId) createSession();
  const session = currentSession();

  session.messages.push({ role: 'user', content: text });
  if (session.messages.length === 1) {
    session.title = '🔬 ' + text.slice(0, 18) + (text.length > 18 ? '...' : '');
    renderSessionList();
  }
  input.value = ''; input.style.height = 'auto';
  clearImage();

  // AI 消息占位（聊天里显示进度摘要）
  const aiMsg = { role: 'assistant', content: '', streaming: true, tokens: 0, sources: null, deepResearch: true };
  session.messages.push(aiMsg);
  session.updatedAt = Date.now();
  saveSessions();
  renderChat();
  setStreamingUI(true);

  // 打开侧边面板
  openDRPanel();

  // 重置面板状态
  const planSec = document.getElementById('dr-plan-section');
  if (planSec) planSec.style.display = 'none';
  const srcPanel = document.getElementById('dr-sources-panel');
  if (srcPanel) srcPanel.style.display = 'none';
  const stepsList = document.getElementById('dr-steps-list');
  if (stepsList) stepsList.innerHTML = '';
  const fill = document.getElementById('dr-progress-fill');
  if (fill) { fill.style.width = '5%'; fill.classList.add('running'); }

  // 计时器
  const timerInterval = setInterval(() => {
    if (!window.researchState.isRunning) { clearInterval(timerInterval); return; }
    updateDRPanel();
  }, 1000);

  await window.startDeepResearch(text, {
    config, session, aiMsg,
    onProgress: () => updateDRPanel(),
    onReportDelta: (delta) => {
      aiMsg.content += delta;
      // 流式更新聊天气泡里的报告
      const msgs = document.getElementById('messages');
      const lastBubble = msgs.querySelector('.message.assistant:last-child .bubble');
      if (lastBubble) {
        let reportEl = lastBubble.querySelector('.dr-report-streaming');
        if (!reportEl) {
          lastBubble.innerHTML = '';
          reportEl = document.createElement('div');
          reportEl.className = 'dr-report-streaming';
          lastBubble.appendChild(reportEl);
        }
        reportEl.innerHTML = marked.parse(aiMsg.content);
        scrollToBottom();
      }
    },
    onComplete: (sources) => {
      clearInterval(timerInterval);
      aiMsg.sources = sources;
      aiMsg.streaming = false;
      aiMsg.deepResearch = false;
      // 保存研究元数据用于渲染
      aiMsg.drMeta = {
        steps: window.researchState.steps.length,
        sources: sources.length,
        elapsed: window.researchState.startTime ? Math.floor((Date.now() - window.researchState.startTime) / 1000) : 0
      };
      // 进度条到100%
      const fill = document.getElementById('dr-progress-fill');
      if (fill) { fill.style.width = '100%'; fill.classList.remove('running'); }
      updateDRPanel();
      const stopBtn = document.getElementById('dr-stop-btn');
      if (stopBtn) stopBtn.style.display = 'none';
      setStreamingUI(false);
      saveSessions();
      renderChat();
      updateTokenCount();
    },
    onError: (err) => {
      clearInterval(timerInterval);
      aiMsg.content = aiMsg.content || `研究失败: ${err}`;
      aiMsg.streaming = false;
      aiMsg.deepResearch = false;
      setStreamingUI(false);
      saveSessions();
      renderChat();
    }
  });
}

// --- Send Message ---
async function handleSend() {
  if (isStreaming) { stopStreaming(); return; }

  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && !selectedImageBase64) return;

  if (!currentSessionId) createSession();
  const session = currentSession();

  // Add user message
  const userMsg = { role: 'user', content: text || '请描述这张图片', image: selectedImageBase64 || null };
  session.messages.push(userMsg);

  // Auto title
  if (session.messages.length === 1) {
    session.title = text.slice(0, 20) + (text.length > 20 ? '...' : '') || '图片对话';
    renderSessionList();
  }

  // Clear input
  input.value = '';
  input.style.height = 'auto';
  clearImage();

  // Add assistant placeholder
  const aiMsg = { role: 'assistant', content: '', streaming: true, tokens: 0, sources: null };
  session.messages.push(aiMsg);
  session.updatedAt = Date.now();
  renderChat();
  setStreamingUI(true);

  // Build API messages
  const apiMessages = [];
  const sysPrompt = session.systemPrompt || config.systemPrompt;

  // 联网搜索
  let searchContext = '';
  const hasSearchProvider = config.searchWorkerURL || config.tavilyKey;
  const shouldSearch = hasSearchProvider && text && await decideSearch(text);
  if (shouldSearch) {
    aiMsg.content = '🔍 正在搜索...';
    updateStreamingMessage(aiMsg);
    try {
      const searchData = await withTimeout(webSearch(text), 15000);
      if (searchData && searchData.formatted) {
        searchContext = `\n\n以下是从互联网搜索到的相关信息，请基于这些信息回答用户的问题。请在回答中使用 [1]、[2] 等编号引用对应的搜索结果来源。如果搜索结果与问题无关，可以忽略。\n\n---搜索结果---\n${searchData.formatted}\n---搜索结果结束---\n`;
        aiMsg.sources = searchData.sources;
      }
    } catch (err) {
      console.error('Search timeout/error:', err);
    }
    aiMsg.content = '';
  }

  if (sysPrompt || searchContext) {
    apiMessages.push({ role: 'system', content: (sysPrompt || '') + searchContext });
  }

  for (const m of session.messages) {
    if (m.role === 'assistant' && m.streaming) continue;
    if (m.image) {
      apiMessages.push({
        role: m.role,
        content: [
          { type: 'image_url', image_url: { url: m.image } },
          { type: 'text', text: m.content }
        ]
      });
    } else {
      apiMessages.push({ role: m.role, content: m.content });
    }
  }

  // Stream request
  abortController = new AbortController();
  try {
    const resp = await fetch(`${config.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: session.model || config.defaultModel,
        messages: apiMessages,
        stream: true,
        stream_options: { include_usage: true }
      }),
      signal: abortController.signal
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

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
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        if (trimmed === 'data: [DONE]') continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6));
          if (chunk.usage?.total_tokens) {
            aiMsg.tokens = chunk.usage.total_tokens;
            session.totalTokens = session.messages.reduce((s, m) => s + (m.tokens || 0), 0);
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            aiMsg.content += delta;
            updateStreamingMessage(aiMsg);
          }
        } catch {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      aiMsg.content = aiMsg.content || `请求失败: ${err.message}`;
    }
  }

  aiMsg.streaming = false;
  setStreamingUI(false);
  saveSessions();
  renderChat();
  updateTokenCount();
}

function updateStreamingMessage(aiMsg) {
  const msgs = document.getElementById('messages');
  const lastBubble = msgs.querySelector('.message.assistant:last-child .bubble');
  if (lastBubble) {
    lastBubble.innerHTML = marked.parse(aiMsg.content);
    scrollToBottom();
  }
}

function stopStreaming() {
  if (window.researchState?.isRunning) window.abortDeepResearch();
  if (abortController) abortController.abort();
  abortController = null;
  const session = currentSession();
  if (session) {
    const last = session.messages[session.messages.length - 1];
    if (last?.streaming) {
      last.streaming = false;
      if (!last.content) last.content = '（已中断）';
    }
  }
  setStreamingUI(false);
  saveSessions();
  renderChat();
}

function setStreamingUI(streaming) {
  isStreaming = streaming;
  const btn = document.getElementById('btn-send');
  const sendIcon = document.getElementById('send-icon');
  const stopIcon = document.getElementById('stop-icon');
  btn.disabled = false;
  if (streaming) {
    btn.classList.add('streaming');
    sendIcon.style.display = 'none';
    stopIcon.style.display = 'block';
  } else {
    btn.classList.remove('streaming');
    sendIcon.style.display = 'block';
    stopIcon.style.display = 'none';
    updateSendBtn();
  }
}

// --- Image Handling ---
function handleImageSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    selectedImageBase64 = reader.result;
    document.getElementById('image-preview').style.display = 'flex';
    updateSendBtn();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function clearImage() {
  selectedImageBase64 = null;
  document.getElementById('image-preview').style.display = 'none';
  updateSendBtn();
}

// --- Web Search ---
function toggleSearch() {
  if (!config.tavilyKey && !config.searchWorkerURL) {
    alert('请先在设置中配置搜索：\n\n方式一：填写 Tavily API Key（免费1000次/月）\n方式二：填写自建搜索代理地址（完全免费无限）');
    return;
  }
  config.searchEnabled = !config.searchEnabled;
  saveConfig();
  updateSearchBtn();
}

function updateSearchBtn() {
  const btn = document.getElementById('btn-search-toggle');
  const mode = config.searchMode || 'on';
  if (mode === 'off') {
    btn.style.display = 'none';
  } else if (mode === 'auto') {
    btn.style.display = 'flex';
    btn.classList.add('active');
    btn.title = '联网搜索: AI自动';
  } else {
    btn.style.display = 'flex';
    if (config.searchEnabled) {
      btn.classList.add('active');
      btn.title = '联网搜索: 开';
    } else {
      btn.classList.remove('active');
      btn.title = '联网搜索: 关';
    }
  }
}

// 判断是否需要联网：手动模式直接看开关，自动模式问 AI
async function decideSearch(text) {
  if (config.searchMode === 'off' || !config.searchWorkerURL && !config.tavilyKey) return false;
  if (config.searchMode === 'on') return config.searchEnabled;
  // auto 模式：快速问 AI
  try {
    const resp = await Promise.race([
      fetch(`${config.baseURL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.defaultModel,
          max_tokens: 5,
          temperature: 0,
          stream: false,
          messages: [
            { role: 'system', content: '判断用户的问题是否需要搜索互联网才能回答（涉及实时信息、新闻、当前价格、最新事件等）。只回答 yes 或 no。' },
            { role: 'user', content: text }
          ]
        })
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    ]);
    if (!resp.ok) return false;
    const data = await resp.json();
    const answer = (data.choices?.[0]?.message?.content || '').toLowerCase().trim();
    return answer.startsWith('yes');
  } catch (e) {
    return false;
  }
}

async function webSearch(query) {
  try {
    let results = null;

    // 优先用自建 Worker（免费无限），其次 Tavily
    if (config.searchWorkerURL) {
      results = await searchWithWorker(query);
    }
    if ((!results || results.length === 0) && config.tavilyKey) {
      results = await searchWithTavily(query);
    }
    if (!results || results.length === 0) return null;

    const sources = results.slice(0, config.searchCount).map((r, i) => ({
      index: i + 1,
      title: r.title || '',
      snippet: r.snippet || '',
      url: r.url || ''
    }));

    const formatted = sources.map(s =>
      `[${s.index}] ${s.title}\n${s.snippet}\n来源: ${s.url}`
    ).join('\n\n');

    return { formatted, sources };
  } catch (err) {
    console.error('Web search failed:', err);
    return null;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function searchWithWorker(query) {
  try {
    const url = `${config.searchWorkerURL.replace(/\/+$/, '')}?q=${encodeURIComponent(query)}&count=${config.searchCount || 5}`;
    const resp = await withTimeout(fetch(url), 10000);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.results || null;
  } catch (err) {
    console.error('Worker search error:', err);
    return null;
  }
}

async function searchWithTavily(query) {
  try {
    const resp = await withTimeout(fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.tavilyKey,
        query: query,
        max_results: config.searchCount || 5,
        include_answer: false,
        search_depth: 'basic'
      })
    }), 10000);

    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.results && data.results.length > 0) {
      return data.results.map(r => ({
        title: r.title || '',
        snippet: r.content || '',
        url: r.url || ''
      }));
    }
    return null;
  } catch (err) {
    console.error('Tavily search error:', err);
    return null;
  }
}

// --- Model Select ---
function renderModelSelect() {
  // 顶栏下拉菜单
  const select = document.getElementById('model-select');
  select.innerHTML = config.models.map(m =>
    `<option value="${m}" ${m === config.defaultModel ? 'selected' : ''}>${m}</option>`
  ).join('');
  select.onchange = () => {
    const session = currentSession();
    if (session) { session.model = select.value; saveSessions(); }
  };

  // 设置页默认模型下拉
  const cfgSelect = document.getElementById('cfg-default-model');
  if (cfgSelect) {
    cfgSelect.innerHTML = config.models.map(m =>
      `<option value="${m}" ${m === config.defaultModel ? 'selected' : ''}>${m}</option>`
    ).join('');
    cfgSelect.onchange = () => {
      config.defaultModel = cfgSelect.value;
      saveConfig();
      renderModelSelect();
    };
  }

  // 设置页模型列表展示
  const listBox = document.getElementById('cfg-model-list');
  if (listBox) {
    if (config.models.length) {
      listBox.innerHTML = config.models.map(m => `<span class="model-tag">${m}</span>`).join('');
    } else {
      listBox.textContent = '暂无模型，请点击刷新';
    }
  }
}

function updateModelSelect() {
  const session = currentSession();
  if (session) {
    document.getElementById('model-select').value = session.model || config.defaultModel;
  }
}

async function fetchModels() {
  // 先从输入框读取最新值（用户可能还没点保存）
  const urlInput = document.getElementById('cfg-url');
  const keyInput = document.getElementById('cfg-key');
  const baseURL = urlInput ? urlInput.value.replace(/\/+$/, '') : config.baseURL;
  const apiKey = keyInput ? keyInput.value : config.apiKey;

  if (!baseURL || !apiKey) {
    alert('请先填写 API Base URL 和 API Key');
    return;
  }

  const btn = document.getElementById('btn-fetch-models');
  if (btn) btn.textContent = '加载中...';
  try {
    const resp = await fetch(`${baseURL}/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.data && data.data.length) {
      config.baseURL = baseURL;
      config.apiKey = apiKey;
      config.models = data.data.map(m => m.id).sort();
      if (!config.models.includes(config.defaultModel) && config.models.length) {
        config.defaultModel = config.models[0];
      }
      saveConfig();
      renderModelSelect();
      if (btn) btn.textContent = `已加载 ${config.models.length} 个模型`;
      setTimeout(() => { if (btn) btn.textContent = '刷新模型列表'; }, 2000);
      return;
    }
    throw new Error('返回数据为空');
  } catch (err) {
    console.error('Fetch models failed:', err);
    alert('拉取模型失败: ' + err.message);
  }
  if (btn) btn.textContent = '刷新模型列表';
}

// --- Settings ---
// --- Provider Management ---
function renderProviderSelect() {
  const sel = document.getElementById('provider-select');
  if (!sel) return;
  sel.innerHTML = '<option value="-1">手动配置</option>';
  (config.providers || []).forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = p.name || `服务商${i+1}`;
    sel.appendChild(opt);
  });
  sel.value = config.currentProvider ?? -1;
}

function renderProvidersList() {
  const box = document.getElementById('cfg-providers');
  if (!box) return;
  if (!config.providers || config.providers.length === 0) {
    box.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:6px 0">暂无服务商，在下方添加</div>';
    return;
  }
  box.innerHTML = config.providers.map((p, i) => `
    <div class="provider-item${config.currentProvider === i ? ' active' : ''}">
      <div class="provider-item-info">
        <span class="provider-item-name">${escapeHtml(p.name)}</span>
        <span class="provider-item-url">${escapeHtml(p.baseURL)}</span>
      </div>
      <div class="provider-item-actions">
        <button class="provider-use-btn" onclick="useProvider(${i})">${config.currentProvider === i ? '使用中' : '切换'}</button>
        <button class="provider-del-btn" onclick="deleteProvider(${i})">删除</button>
      </div>
    </div>`).join('');
}

function addProvider() {
  const name = document.getElementById('cfg-prov-name').value.trim();
  const url = document.getElementById('cfg-prov-url').value.trim().replace(/\/+$/, '');
  const key = document.getElementById('cfg-prov-key').value.trim();
  if (!name || !url || !key) { alert('请填写服务商名称、URL 和 Key'); return; }
  if (!config.providers) config.providers = [];
  config.providers.push({ name, baseURL: url, apiKey: key, models: [], defaultModel: '' });
  document.getElementById('cfg-prov-name').value = '';
  document.getElementById('cfg-prov-url').value = '';
  document.getElementById('cfg-prov-key').value = '';
  saveConfig();
  renderProvidersList();
  renderProviderSelect();
  // 自动拉取新服务商的模型
  fetchModelsForProvider(config.providers.length - 1);
}

function deleteProvider(idx) {
  config.providers.splice(idx, 1);
  if (config.currentProvider === idx) {
    config.currentProvider = -1;
  } else if (config.currentProvider > idx) {
    config.currentProvider--;
  }
  saveConfig();
  renderProvidersList();
  renderProviderSelect();
  applyCurrentProvider();
}

function useProvider(idx) {
  config.currentProvider = idx;
  saveConfig();
  renderProvidersList();
  renderProviderSelect();
  applyCurrentProvider();
}

function switchProvider() {
  const sel = document.getElementById('provider-select');
  const idx = parseInt(sel.value);
  config.currentProvider = idx;
  saveConfig();
  applyCurrentProvider();
  renderProvidersList();
}

function applyCurrentProvider() {
  const idx = config.currentProvider;
  if (idx >= 0 && config.providers && config.providers[idx]) {
    const p = config.providers[idx];
    config.baseURL = p.baseURL;
    config.apiKey = p.apiKey;
    config.models = p.models || [];
    config.defaultModel = p.defaultModel || (config.models[0] || '');
  }
  renderModelSelect();
}

async function fetchModelsForProvider(idx) {
  const p = config.providers[idx];
  if (!p || !p.baseURL || !p.apiKey) return;
  try {
    const resp = await fetch(`${p.baseURL}/v1/models`, {
      headers: { 'Authorization': `Bearer ${p.apiKey}` }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.data && data.data.length) {
      p.models = data.data.map(m => m.id).sort();
      p.defaultModel = p.defaultModel || p.models[0];
      saveConfig();
      renderProvidersList();
      if (config.currentProvider === idx) applyCurrentProvider();
    }
  } catch (e) {}
}

function openSettings() {
  document.getElementById('cfg-url').value = config.baseURL;
  document.getElementById('cfg-key').value = config.apiKey;
  document.getElementById('cfg-prompt').value = config.systemPrompt;
  document.getElementById('cfg-theme').value = config.theme;
  document.getElementById('cfg-search-mode').value = config.searchMode || 'on';
  document.getElementById('cfg-search-count').value = config.searchCount || 5;
  document.getElementById('cfg-tavily-key').value = config.tavilyKey || '';
  document.getElementById('cfg-search-worker').value = config.searchWorkerURL || '';
  document.getElementById('stat-sessions').textContent = `对话: ${sessions.length}`;
  const totalTokens = sessions.reduce((s, sess) => s + (sess.totalTokens || 0), 0);
  document.getElementById('stat-tokens').textContent = `Tokens: ${totalTokens}`;
  renderProvidersList();
  renderModelSelect();
  document.getElementById('settings-modal').style.display = 'flex';
}

function saveSettings() {
  config.baseURL = document.getElementById('cfg-url').value.replace(/\/+$/, '');
  config.apiKey = document.getElementById('cfg-key').value;
  config.systemPrompt = document.getElementById('cfg-prompt').value;
  config.theme = document.getElementById('cfg-theme').value;
  config.searchMode = document.getElementById('cfg-search-mode').value || 'on';
  config.searchCount = parseInt(document.getElementById('cfg-search-count').value) || 5;
  config.tavilyKey = document.getElementById('cfg-tavily-key').value.trim();
  config.searchWorkerURL = document.getElementById('cfg-search-worker').value.trim().replace(/\/+$/, '');
  saveConfig();
  applyTheme();
  document.getElementById('settings-modal').style.display = 'none';
  // 保存后自动拉取模型列表
  if (config.baseURL && config.apiKey) fetchModels();
}

// --- Export ---
function exportChat(format) {
  const session = currentSession();
  if (!session) return;
  let text = '';

  if (format === 'markdown') {
    text = `# ${session.title}\n\n模型: ${session.model}\n\n---\n\n`;
    session.messages.forEach(m => {
      const role = m.role === 'user' ? '**用户**' : '**AI**';
      text += `${role}\n\n${m.content}\n\n---\n\n`;
    });
  } else if (format === 'text') {
    session.messages.forEach(m => {
      text += `[${m.role === 'user' ? '用户' : 'AI'}]\n${m.content}\n\n`;
    });
  } else {
    text = JSON.stringify({
      title: session.title,
      model: session.model,
      totalTokens: session.totalTokens,
      messages: session.messages.map(m => ({ role: m.role, content: m.content, tokens: m.tokens }))
    }, null, 2);
  }

  // 使用 Web Share API（移动端）或下载
  if (navigator.share) {
    navigator.share({ title: session.title, text }).catch(() => {});
  } else {
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${session.title}.${format === 'json' ? 'json' : format === 'markdown' ? 'md' : 'txt'}`;
    a.click();
  }
}

// --- Copy code ---
function copyCode(btn) {
  const code = btn.closest('.code-block').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = '已复制';
    setTimeout(() => btn.textContent = '复制', 1500);
  });
}
