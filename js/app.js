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
  searchCount: 5
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
  } else {
    content = marked.parse(msg.content || '');
    // 将 [1] [2] 等转为可点击的引用标签
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
  if (config.searchEnabled && text) {
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
  config.searchEnabled = !config.searchEnabled;
  saveConfig();
  updateSearchBtn();
}

function updateSearchBtn() {
  const btn = document.getElementById('btn-search-toggle');
  if (config.searchEnabled) {
    btn.classList.add('active');
    btn.title = '联网搜索: 开';
  } else {
    btn.classList.remove('active');
    btn.title = '联网搜索: 关';
  }
}

async function webSearch(query) {
  try {
    // 直接用用户问题作为搜索词（跳过 LLM 提取，避免额外延迟）
    const keywords = query.slice(0, 100);

    // 依次尝试多个搜索源
    let results = null;
    const searchFns = [searchWithSearXNG, searchWithDuckDuckGo];
    for (const fn of searchFns) {
      try {
        results = await withTimeout(fn(keywords), 8000);
        if (results && results.length > 0) break;
      } catch { continue; }
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

function corsProxy(url) {
  return `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
}

async function searchWithSearXNG(query) {
  const instances = [
    'https://searx.be',
    'https://search.sapti.me',
    'https://searx.tiekoetter.com',
    'https://search.ononoki.org'
  ];
  for (const base of instances) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=auto`;
      // 先直接请求，失败再走代理
      let resp;
      try {
        resp = await withTimeout(fetch(url), 4000);
      } catch {
        resp = await withTimeout(fetch(corsProxy(url)), 5000);
      }
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.results && data.results.length > 0) {
        return data.results.slice(0, 8).map(r => ({
          title: r.title || '',
          snippet: r.content || '',
          url: r.url || ''
        }));
      }
    } catch { continue; }
  }
  return null;
}

async function searchWithDuckDuckGo(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    let resp;
    try {
      resp = await withTimeout(fetch(url), 4000);
    } catch {
      resp = await withTimeout(fetch(corsProxy(url)), 5000);
    }
    if (!resp.ok) return null;
    const data = await resp.json();
    const results = [];
    if (data.Abstract) {
      results.push({ title: data.Heading || query, snippet: data.Abstract, url: data.AbstractURL || '' });
    }
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics) {
        if (topic.Text && results.length < 8) {
          results.push({ title: topic.Text.slice(0, 80), snippet: topic.Text, url: topic.FirstURL || '' });
        }
      }
    }
    return results.length > 0 ? results : null;
  } catch { return null; }
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
function openSettings() {
  document.getElementById('cfg-url').value = config.baseURL;
  document.getElementById('cfg-key').value = config.apiKey;
  document.getElementById('cfg-prompt').value = config.systemPrompt;
  document.getElementById('cfg-theme').value = config.theme;
  document.getElementById('cfg-search-count').value = config.searchCount || 5;
  document.getElementById('stat-sessions').textContent = `对话: ${sessions.length}`;
  const totalTokens = sessions.reduce((s, sess) => s + (sess.totalTokens || 0), 0);
  document.getElementById('stat-tokens').textContent = `Tokens: ${totalTokens}`;
  renderModelSelect(); // 刷新设置页里的模型列表和下拉菜单
  document.getElementById('settings-modal').style.display = 'flex';
}

function saveSettings() {
  config.baseURL = document.getElementById('cfg-url').value.replace(/\/+$/, '');
  config.apiKey = document.getElementById('cfg-key').value;
  config.systemPrompt = document.getElementById('cfg-prompt').value;
  config.theme = document.getElementById('cfg-theme').value;
  config.searchCount = parseInt(document.getElementById('cfg-search-count').value) || 5;
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
