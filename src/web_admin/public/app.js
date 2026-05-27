import { h, render } from 'https://esm.sh/preact@10.19.3';
import { useState, useEffect, useRef, useCallback, useMemo } from 'https://esm.sh/preact@10.19.3/hooks';
import htm from 'https://esm.sh/htm@3.1.1';

const html = htm.bind(h);

// ─── Utilities ────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const { headers: optsHeaders, body: optsBody, ...restOpts } = opts;
  const headers = { 'Content-Type': 'application/json', ...optsHeaders };
  const res = await fetch(`/admin/api${path}`, {
    ...restOpts,
    headers,
    body: optsBody ? (typeof optsBody === 'string' ? optsBody : JSON.stringify(optsBody)) : undefined,
  });
  if (res.status === 401) {
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => res.statusText);
    let msg = raw || `HTTP ${res.status}`;
    try { const j = JSON.parse(raw); if (j.error) msg = j.error; } catch { }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function truncate(str, n = 40) {
  if (!str) return '';
  const s = String(str);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function findDefaultFromProviders(providers) {
  for (const pr of providers) {
    const pid = pr.name || pr.id;
    for (const m of pr.models || []) {
      const mo = typeof m === 'string' ? { id: m } : m;
      if (mo.roles?.includes('default')) {
        return { defaultProvider: pid, defaultModel: mo.id || mo.name };
      }
    }
  }
  return null;
}

function applyDefaultRoleToProviders(providers, defaultProvider, defaultModel) {
  if (!defaultProvider || !defaultModel || !Array.isArray(providers)) return providers;
  return providers.map(pr => ({
    ...pr,
    models: (pr.models || []).map(m => {
      const o = typeof m === 'string' ? { id: m, name: m } : { ...m };
      const pid = pr.name || pr.id;
      const oid = o.id || o.name;
      let roles = [...(o.roles || [])].filter(r => r !== 'default');
      if (pid === defaultProvider && oid === defaultModel) roles.push('default');
      if (roles.length === 0) delete o.roles; else o.roles = roles;
      return o;
    }),
  }));
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

let _workspaceCache = null;
let _workspaceFetching = false;
async function fetchWorkspaces() {
  if (_workspaceCache) return _workspaceCache;
  if (_workspaceFetching) return [];
  _workspaceFetching = true;
  try {
    const data = await api('/workspaces');
    _workspaceCache = Array.isArray(data) ? data : [];
    return _workspaceCache;
  } catch { return []; }
  finally { _workspaceFetching = false; }
}

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState(_workspaceCache || []);
  useEffect(() => { fetchWorkspaces().then(ws => setWorkspaces(ws)); }, []);
  return workspaces;
}

function workspaceDisplayName(wsId, workspaces) {
  if (!wsId) return 'Default';
  const ws = (workspaces || []).find(w => w.id === wsId);
  if (!ws) return wsId.slice(0, 8) + '…';
  return ws.displayName || ws.name || wsId.slice(0, 8);
}

const TYPE_META = {
  user_msg: { color: 'yellow', icon: '💬', label: 'User' },
  assistant_msg: { color: 'purple', icon: '🤖', label: 'Assistant' },
  llm_request: { color: 'blue', icon: '📤', label: 'LLM Request' },
  llm_response: { color: 'blue', icon: '📥', label: 'LLM Response' },
  tool_call: { color: 'green', icon: '🔧', label: 'Tool Call' },
  tool_result: { color: 'green', icon: '📋', label: 'Tool Result' },
  tool_exec: { color: 'yellow', icon: '⚡', label: 'Auto Exec' },
  error: { color: 'red', icon: '❌', label: 'Error' },
  session_start: { color: 'blue', icon: '▶', label: 'Session Start' },
  session_end: { color: 'blue', icon: '⏹', label: 'Session End' },
  notify: { color: 'cyan', icon: '💬', label: 'Notify' },
  system_prompt: { color: 'purple', icon: '📝', label: 'System Prompt' },
  context_compaction: { color: 'purple', icon: '📦', label: 'Context Compaction' },
  heartbeat: { color: 'purple', icon: '💓', label: 'Heartbeat' },
  system: { color: 'blue', icon: '⚙', label: 'System' },
};

function typeMeta(type) {
  return TYPE_META[type] || { color: 'blue', icon: '•', label: type || 'Unknown' };
}

function parseTypes(types) {
  if (!types) return [];
  if (Array.isArray(types)) return types;
  return String(types).split(',').filter(Boolean);
}

// ─── Toast System ─────────────────────────────────────────────────────────────

let _toastId = 0;
let _setToasts = null;

function showToast(message, type = 'info', duration = 3000) {
  if (!_setToasts) return;
  const id = ++_toastId;
  _setToasts(prev => [...prev, { id, message, type }]);
  setTimeout(() => {
    _setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
    setTimeout(() => _setToasts(prev => prev.filter(t => t.id !== id)), 300);
  }, duration);
}

function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  _setToasts = setToasts;
  return html`
    <div class="toast-container">
      ${toasts.map(t => html`
        <div key=${t.id} class="toast toast-${t.type} ${t.leaving ? 'toast-out' : ''}">
          ${t.message}
        </div>
      `)}
    </div>
  `;
}

// ─── Router ───────────────────────────────────────────────────────────────────

function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const handler = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  const path = hash.replace('#', '') || '/';
  const segments = path.split('/').filter(Boolean);
  return { path, segments };
}

function navigate(path) { location.hash = '#' + path; }

// ─── Sidebar ──────────────────────────────────────────────────────────────────

let __multiUserEnabled = false;
let __billingEnabled = false;

const NAV_ITEMS_BASE = [
  { path: '/', label: 'Dashboard', icon: '◉' },
  { path: '/users', label: 'Users', icon: '👥', multiOnly: true },
  { path: '/live', label: 'Live Log', icon: '⚡' },
  { path: '/sessions', label: 'Sessions', icon: '☰', singleOnly: true },
  { path: '/tasks', label: 'Tasks', icon: '📅', singleOnly: true },
  { path: '/memory', label: 'Memory', icon: '🧠', singleOnly: true },
  { path: '/config', label: 'Config', icon: '⚙' },
  { path: '/tools', label: 'Tools & MCP', icon: '🔧' },
  { path: '/security', label: 'Security', icon: '🛡' },
  { path: '/agents', label: 'Sub-Agents', icon: '🤖', singleOnly: true },
];

function getNavItems() {
  return NAV_ITEMS_BASE.filter(item => {
    if (item.multiOnly && !__multiUserEnabled) return false;
    if (item.singleOnly && __multiUserEnabled) return false;
    return true;
  });
}

function Sidebar({ currentPath, open, onToggle, onLogout }) {
  const isActive = (p) => p === '/' ? currentPath === '/' : currentPath.startsWith(p);
  const navItems = getNavItems();
  return html`
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1>⬡ Kora <span>Admin</span></h1>
      </div>
      <nav class="sidebar-nav">
        ${navItems.map(item => html`
          <a key=${item.path} href="#${item.path}" class=${isActive(item.path) ? 'active' : ''}>
            <span class="nav-icon">${item.icon}</span>${item.label}
          </a>
        `)}
      </nav>
      <div class="sidebar-footer">
        <button class="sidebar-logout-btn" onClick=${onLogout}>🚪 Logout</button>
      </div>
    </aside>
  `;
}

function getBottomNavItems() {
  const items = [
    { path: '/', label: 'Home', icon: '◉' },
    { path: '/live', label: 'Live', icon: '⚡' },
  ];
  if (__multiUserEnabled) {
    items.push({ path: '/users', label: 'Users', icon: '👥' });
  } else {
    items.push({ path: '/sessions', label: 'Sessions', icon: '☰' });
    items.push({ path: '/tasks', label: 'Tasks', icon: '📅' });
  }
  items.push({ path: '/tools', label: 'Tools', icon: '🔧' });
  return items;
}

function getMoreSheetItems() {
  const items = [];
  if (__multiUserEnabled) items.push({ path: '/users', label: 'Users', icon: '👥' });
  if (!__multiUserEnabled) items.push({ path: '/memory', label: 'Memory', icon: '🧠' });
  items.push({ path: '/config', label: 'Configuration', icon: '⚙' });
  items.push({ path: '/security', label: 'Security', icon: '🛡' });
  if (!__multiUserEnabled) items.push({ path: '/agents', label: 'Sub-Agents', icon: '🤖' });
  return items;
}

function BottomNav({ currentPath, onLogout }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const isActive = (p) => p === '/' ? currentPath === '/' : currentPath.startsWith(p);
  const moreItems = getMoreSheetItems();
  return html`
    ${sheetOpen && html`<div class="sheet-overlay" onClick=${() => setSheetOpen(false)} />`}
    ${sheetOpen && html`
      <div class="bottom-sheet">
        <div class="bottom-sheet-handle" />
        ${moreItems.map(item => html`
          <a key=${item.path} href="#${item.path}" class="bottom-sheet-item ${isActive(item.path) ? 'active' : ''}" onClick=${() => setSheetOpen(false)}>
            <span class="bottom-sheet-icon">${item.icon}</span>
            <span>${item.label}</span>
          </a>
        `)}
        <div class="bottom-sheet-divider" />
        <button class="bottom-sheet-item bottom-sheet-logout" onClick=${() => { setSheetOpen(false); onLogout(); }}>
          <span class="bottom-sheet-icon">🚪</span>
          <span>Logout</span>
        </button>
      </div>
    `}
    <nav class="bottom-nav">
      ${getBottomNavItems().map(item => html`
        <a key=${item.path} href="#${item.path}" class="bottom-nav-item ${isActive(item.path) ? 'active' : ''}">
          <span class="bottom-nav-icon">${item.icon}</span>
          <span class="bottom-nav-label">${item.label}</span>
        </a>
      `)}
      <button class="bottom-nav-item ${sheetOpen ? 'active' : ''}" onClick=${() => setSheetOpen(v => !v)}>
        <span class="bottom-nav-icon">•••</span>
        <span class="bottom-nav-label">More</span>
      </button>
    </nav>
  `;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard() {
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    const isFirst = !status;
    if (isFirst) setLoading(true);
    Promise.all([api('/status'), api('/sessions?limit=5&offset=0')])
      .then(([s, sess]) => {
        setStatus(s);
        if (s.multiUserEnabled !== undefined) __multiUserEnabled = !!s.multiUserEnabled;
        if (s.billingEnabled !== undefined) __billingEnabled = !!s.billingEnabled;
        setSessions(Array.isArray(sess) ? sess : []);
        setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;
  if (error) return html`<div class="error-card">Failed to load: ${error}</div>`;
  if (!status) return null;

  const cards = [
    { label: 'Provider', value: status.provider || '—', icon: '🤖' },
    { label: 'Model', value: status.model || '—', icon: '🧠' },
    { label: 'Channels', value: status.channels ?? 0, icon: '📡' },
    { label: 'Tools', value: status.toolCount ?? 0, icon: '🔧' },
    { label: 'MCP Servers', value: status.mcpCount ?? 0, icon: '🖥' },
    { label: 'Tasks', value: `${status.schedulerJobs ?? 0} jobs`, icon: '📅' },
    {
      label: 'Heartbeat', value: status.heartbeat === 'active' ? 'Active' : status.heartbeat || '—', icon: '💓',
      badge: (status.heartbeat === 'active' || status.heartbeat === true) ? 'green' : 'red'
    },
    { label: 'Uptime', value: status.uptime || '—', icon: '⏱' },
  ];

  return html`
    <div class="page-header flex justify-between items-center">
      <div><h2>Dashboard</h2><p>System overview</p></div>
      <button class="btn btn-secondary btn-sm" onClick=${load}>↻ Refresh</button>
    </div>
    <div class="grid grid-4">
      ${cards.map(c => html`
        <div class="card" key=${c.label}>
          <div class="card-header"><h3>${c.label}</h3><span>${c.icon}</span></div>
          <div class="card-value">
            ${c.badge ? html`<span class="badge badge-${c.badge}">${c.value}</span>` : c.value}
          </div>
        </div>
      `)}
    </div>
    ${sessions.length > 0 && html`
      <div class="mt-24">
        <h3 style="font-size:16px;font-weight:600;margin-bottom:12px;">Recent Sessions</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${sessions.map(s => {
    const info = sessionDisplayInfo(s);
    return html`
              <div key=${s.sessionId} class="card cursor-pointer" style="padding:10px 14px;" onClick=${() => navigate(`/sessions/${s.sessionId}`)}>
                <div class="flex justify-between items-center">
                  <div class="flex items-center" style="gap:10px;">
                    <span style="font-size:18px;">${info.icon}</span>
                    <div>
                      <div style="font-weight:600;font-size:13px;">${info.label}</div>
                      <div class="text-muted" style="font-size:11px;">${relativeTime(s.lastActivityAt || s.startedAt)}</div>
          </div>
                  </div>
                  <span class="badge badge-blue" style="font-size:11px;">${s.entryCount ?? 0}</span>
                </div>
              </div>
            `;
  })}
        </div>
      </div>
    `}
  `;
}

// ─── Rendered Audit Entry (reusable) ──────────────────────────────────────────

function AuditEntryCard({ entry, showSession = false, expanded = false, onToggle: parentToggle }) {
  const meta = typeMeta(entry.type);
  const data = entry.data || {};
  const onToggle = (section) => {
    if (typeof section === 'string') parentToggle(section);
    else parentToggle();
  };

  const renderContent = () => {
    switch (entry.type) {
      case 'user_msg':
        return html`<div class="entry-content-text">${data.content || ''}
          ${data.voiceTranscribed ? html`<div class="badge badge-blue mt-4" style="font-size:10px;">Voice transcribed</div>` : null}
        </div>`;

      case 'assistant_msg':
        return html`<div class="entry-content-text">${data.content || ''}</div>
          <div class="entry-meta-grid mt-8">
            ${data.iteration != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Iteration</span><span class="entry-meta-value">#${data.iteration}</span></div>` : null}
            ${data.iterations != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Iteration</span><span class="entry-meta-value">#${data.iterations}</span></div>` : null}
            ${data.llmCall != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">LLM Call</span><span class="entry-meta-value">#${data.llmCall}</span></div>` : null}
            ${data.continueRequested ? html`<div class="entry-meta-item"><span class="badge badge-yellow">continue</span></div>` : null}
            ${data.finishRequested ? html`<div class="entry-meta-item"><span class="badge badge-green">finish</span></div>` : null}
            ${data.noMarkerFound ? html`<div class="entry-meta-item"><span class="badge badge-red">no signal</span></div>` : null}
            ${data.multipleMarkers ? html`<div class="entry-meta-item"><span class="badge badge-red">multiple markers</span></div>` : null}
          </div>
          `;

      case 'llm_request':
        return html`
          <div class="entry-meta-grid">
            ${data.reason && data.reason !== 'primary' ? html`<div class="entry-meta-item"><span class="entry-meta-label">Reason</span><span class="entry-meta-value badge badge-yellow">${data.reason.replace(/_/g, ' ')}</span></div>` : null}
            ${data.model ? html`<div class="entry-meta-item"><span class="entry-meta-label">Model</span><span class="entry-meta-value">${data.model}</span></div>` : null}
            ${data.messageCount != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Messages</span><span class="entry-meta-value">${data.messageCount}</span></div>` : null}
            ${data.toolCount != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Tools</span><span class="entry-meta-value">${data.toolCount}</span></div>` : null}
            ${data.iteration != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Iteration</span><span class="entry-meta-value">#${data.iteration}</span></div>` : null}
          </div>
          <div class="flex gap-8 mt-8">
            ${data.messages && data.messages.length > 0 ? html`
              <button class="expandable-toggle" onClick=${() => onToggle('messages')}>
                ${expanded === true || expanded === 'messages' ? '▾ Hide messages' : `▸ Messages (${data.messageCount})`}
              </button>
            ` : null}
            ${data.tools && data.tools.length > 0 ? html`
              <button class="expandable-toggle" onClick=${() => onToggle('tools')}>
                ${expanded === 'tools' ? '▾ Hide tools' : `▸ Tools (${data.toolCount})`}
              </button>
            ` : null}
          </div>
          ${(expanded === true || expanded === 'messages') && Array.isArray(data.messages) ? html`
            <div class="llm-messages-list mt-8">
              ${data.messages.map((m, i) => {
          const roleColors = { system: 'purple', user: 'yellow', assistant: 'blue', tool: 'green' };
          const color = roleColors[m.role] || 'blue';
          return html`
                  <div key=${i} class="llm-msg-item" style="margin-bottom:6px;padding:8px 10px;background:var(--bg-primary);border-radius:var(--radius-md);border-left:3px solid var(--badge-${color}-text);">
                    <div class="flex items-center gap-8 mb-4">
                      <span class="badge badge-${color}" style="font-size:11px;">${m.role}</span>
                      <span class="text-muted text-sm">${m.length} chars</span>
                      ${m.toolCalls ? html`<span class="text-muted text-sm">calls: ${m.toolCalls.map(tc => typeof tc === 'string' ? tc : tc.name).join(', ')}</span>` : null}
                      ${m.toolCallId ? html`<span class="text-muted text-sm">id: ${truncate(m.toolCallId, 12)}</span>` : null}
                    </div>
                    <div style="font-size:13px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;">${m.preview || '(empty)'}</div>
                  </div>
                `;
        })}
            </div>
          ` : null}
          ${expanded === 'tools' && data.tools ? html`
            <div class="mt-8" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px;">
              ${data.tools.map((t, i) => html`
                <div key=${i} style="padding:6px 10px;background:var(--bg-primary);border-radius:var(--radius-md);border:1px solid var(--border-color);">
                  <div style="font-size:13px;font-weight:600;color:var(--accent-cyan);font-family:var(--font-mono);">${t.name}</div>
                  <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${t.description || ''}</div>
                </div>
              `)}
            </div>
          ` : null}`;

      case 'llm_response':
        return html`
          <div class="entry-meta-grid">
            ${data.reason && data.reason !== 'primary' ? html`<div class="entry-meta-item"><span class="entry-meta-label">Reason</span><span class="entry-meta-value badge badge-yellow">${data.reason.replace(/_/g, ' ')}</span></div>` : null}
            ${data.finishReason ? html`<div class="entry-meta-item"><span class="entry-meta-label">Finish</span><span class="entry-meta-value badge badge-${data.finishReason === 'tool_calls' ? 'green' : data.finishReason === 'stop' ? 'blue' : 'yellow'}">${data.finishReason}</span></div>` : null}
            ${data.hasToolCalls ? html`<div class="entry-meta-item"><span class="entry-meta-label">Tool Calls</span><span class="entry-meta-value">${data.toolCallCount}${data.toolNames ? ': ' + data.toolNames.join(', ') : ''}</span></div>` : null}
            ${data.contentLength != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Content</span><span class="entry-meta-value">${data.contentLength > 0
            ? (data.visibleContentLength === 0
              ? html`<span>${data.contentLength} chars <span class="badge badge-purple" style="margin-left:4px;">thinking only</span></span>`
              : data.contentLength + ' chars')
            : html`<span class="text-muted">${data.hasToolCalls ? 'tools only' : 'empty'}</span>`
            }</span></div>` : null}
            ${data.usage ? html`
              <div class="entry-meta-item"><span class="entry-meta-label">Tokens In</span><span class="entry-meta-value">${data.usage.promptTokens?.toLocaleString() ?? '?'}</span></div>
              <div class="entry-meta-item"><span class="entry-meta-label">Tokens Out</span><span class="entry-meta-value">${data.usage.completionTokens?.toLocaleString() ?? '?'}</span></div>
              <div class="entry-meta-item"><span class="entry-meta-label">Total</span><span class="entry-meta-value">${data.usage.totalTokens?.toLocaleString() ?? '?'}</span></div>
            ` : null}
          </div>
          ${data.reasoning ? html`
            <div class="entry-expandable mt-8">
              <button class="expandable-toggle" onClick=${(e) => { const el = e.target.nextElementSibling; el.style.display = el.style.display === 'none' ? 'block' : 'none'; e.target.textContent = el.style.display === 'none' ? '▸ Show reasoning' : '▾ Hide reasoning'; }}>▸ Show reasoning</button>
              <div style="display:none;background:var(--bg-tertiary);border-radius:6px;padding:10px;margin-top:6px;font-size:13px;white-space:pre-wrap;color:var(--text-secondary);border-left:3px solid var(--accent-purple);">${data.reasoning}</div>
            </div>
          ` : null}
          ${data.contentPreview && data.contentLength > 0 ? html`
            <div class="entry-expandable">
              <button class="expandable-toggle" onClick=${onToggle}>${expanded ? '▾ Hide content' : '▸ Show content preview'}</button>
              ${expanded ? html`<div class="entry-content-text mt-8" style="opacity:0.8;font-size:13px;white-space:pre-wrap;">${data.contentPreview}</div>` : null}
            </div>
          ` : null}`;

      case 'tool_call':
        return html`
          <div class="entry-tool-name">${data.name || 'unknown tool'}</div>
          ${data.arguments && Object.keys(data.arguments).length > 0 ? html`
            <div class="entry-expandable">
              <button class="expandable-toggle" onClick=${onToggle}>${expanded ? '▾ Hide arguments' : '▸ Show arguments'}</button>
              ${expanded ? html`<pre class="entry-json mt-8"><code>${JSON.stringify(data.arguments, null, 2)}</code></pre>` : null}
            </div>
          ` : null}`;

      case 'tool_result':
        return html`
          <div class="entry-tool-name">${data.name || 'unknown tool'}${data.isError ? html` <span class="badge badge-red">error</span>` : html` <span class="badge badge-green">ok</span>`}</div>
          ${data.resultPreview ? html`
            <div class="entry-expandable">
              <button class="expandable-toggle" onClick=${onToggle}>${expanded ? '▾ Hide result' : '▸ Show result'}</button>
              ${expanded ? html`<pre class="entry-json mt-8"><code>${formatResultPreview(data.resultPreview)}</code></pre>` : null}
            </div>
          ` : null}`;

      case 'tool_exec':
        return html`
          <div class="entry-tool-name">${data.tool || 'unknown'} <span class="badge badge-yellow">${data.source || 'auto'}</span></div>
          ${data.args ? html`
            <div class="entry-expandable">
              <button class="expandable-toggle" onClick=${onToggle}>${expanded ? '▾ Hide details' : '▸ Show details'}</button>
              ${expanded ? html`<pre class="entry-json mt-8"><code>${JSON.stringify(data.args, null, 2)}</code></pre>` : null}
            </div>
          ` : null}`;

      case 'system_prompt':
        return html`
          <div class="entry-meta-grid">
            ${data.agentName ? html`<div class="entry-meta-item"><span class="entry-meta-label">Agent</span><span class="entry-meta-value">${data.agentName}</span></div>` : null}
            ${data.model ? html`<div class="entry-meta-item"><span class="entry-meta-label">Model</span><span class="entry-meta-value">${data.model}</span></div>` : null}
            ${data.maxIterations != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Max Iter</span><span class="entry-meta-value">${data.maxIterations}</span></div>` : null}
            ${data.length != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Length</span><span class="entry-meta-value">${data.length} chars</span></div>` : null}
            ${data.toolCount != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Tools</span><span class="entry-meta-value">${data.toolCount}</span></div>` : null}
            ${data.memoryEntries != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Memory</span><span class="entry-meta-value">${data.memoryEntries} entries</span></div>` : null}
            ${data.hasGlobalAgentMd != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Global Agent.md</span><span class="entry-meta-value">${data.hasGlobalAgentMd ? 'yes' : 'no'}</span></div>` : null}
            ${data.hasUserAgentMd != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">User Agent.md</span><span class="entry-meta-value" style="color:${data.hasUserAgentMd ? 'var(--accent)' : 'inherit'}">${data.hasUserAgentMd ? 'yes' : 'no'}</span></div>` : null}
            ${data.hasAgentMd != null && data.hasGlobalAgentMd == null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Agent.md</span><span class="entry-meta-value">${data.hasAgentMd ? 'yes' : 'no'}</span></div>` : null}
            ${data.documentChunks != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Doc Chunks</span><span class="entry-meta-value">${data.documentChunks}</span></div>` : null}
            ${data.task ? html`<div class="entry-meta-item" style="grid-column:1/-1;"><span class="entry-meta-label">Task</span><span class="entry-meta-value" style="white-space:pre-wrap;font-size:12px;">${data.task}</span></div>` : null}
          </div>
          ${data.content ? html`
            <div class="entry-expandable">
              <button class="expandable-toggle" onClick=${onToggle}>${expanded ? '▾ Hide prompt' : '▸ Show system prompt'}</button>
              ${expanded ? html`<pre class="entry-json mt-8" style="white-space:pre-wrap;max-height:500px;overflow:auto;"><code>${data.content}</code></pre>` : null}
            </div>
          ` : null}`;

      case 'context_compaction':
        return html`
          <div class="entry-meta-grid">
            <div class="entry-meta-item"><span class="entry-meta-label">Before</span><span class="entry-meta-value">${(data.beforeTokens || 0).toLocaleString()} tokens</span></div>
            <div class="entry-meta-item"><span class="entry-meta-label">After</span><span class="entry-meta-value">${(data.afterTokens || 0).toLocaleString()} tokens</span></div>
            <div class="entry-meta-item"><span class="entry-meta-label">Removed</span><span class="entry-meta-value">${data.removedMessages || 0} messages</span></div>
            <div class="entry-meta-item"><span class="entry-meta-label">Limit</span><span class="entry-meta-value">${(data.maxContextTokens || 0).toLocaleString()}</span></div>
          </div>`;

      case 'notify':
        return html`
          <div class="entry-meta-grid">
            <div class="entry-meta-item" style="grid-column:1/-1;">
              <span class="entry-meta-label">Message</span>
              <span class="entry-meta-value" style="white-space:pre-wrap;">${data.message || '(empty)'}</span>
            </div>
            <div class="entry-meta-item"><span class="entry-meta-label">Delivered</span><span class="entry-meta-value">${data.delivered ? 'Yes' : 'No'}</span></div>
          </div>`;

      case 'error':
        return html`<div class="entry-error-text">${data.error || data.message || JSON.stringify(data)}</div>`;

      case 'session_start':
        return html`<div class="entry-meta-row"><span class="entry-meta-label">Channel:</span> ${data.channel || '—'} · <span class="entry-meta-label">Type:</span> ${data.type || '—'}</div>`;

      case 'session_end': {
        const reasonLabels = {
          finish: 'Completed normally',
          completed: 'Completed normally',
          max_iterations: 'Max iterations reached',
          no_marker_exhausted: 'No control signal (auto-finished)',
          no_signal_exhausted: 'No control signal (auto-finished)',
          error: 'Error',
          completed: 'Completed',
          ask: 'Waiting for user input',
        };
        const rawReason = data.reason || data.status || '';
        const reasonLabel = reasonLabels[rawReason] || (rawReason ? rawReason : 'Session closed');
        const reasonColor = (rawReason === 'finish' || rawReason === 'completed') ? 'green'
          : (rawReason === 'max_iterations' || rawReason === 'no_marker_exhausted' || rawReason === 'no_signal_exhausted') ? 'yellow'
            : (rawReason === 'error') ? 'red' : 'blue';
        return html`
          <div class="entry-meta-grid">
            <div class="entry-meta-item"><span class="entry-meta-label">Reason</span><span class="entry-meta-value badge badge-${reasonColor}">${reasonLabel}</span></div>
            ${data.totalDurationMs != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Duration</span><span class="entry-meta-value">${formatDuration(data.totalDurationMs)}</span></div>` : null}
            ${data.iterations != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Iterations</span><span class="entry-meta-value">${data.iterations}</span></div>` : null}
            ${data.llmCalls != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">LLM Calls</span><span class="entry-meta-value">${data.llmCalls}</span></div>` : null}
            ${data.toolCallsTotal != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Tool Calls</span><span class="entry-meta-value">${data.toolCallsTotal}</span></div>` : null}
            ${data.notifyUsed != null ? html`<div class="entry-meta-item"><span class="entry-meta-label">Notify Used</span><span class="entry-meta-value">${data.notifyUsed ? 'Yes' : 'No'}</span></div>` : null}
            ${data.agentName ? html`<div class="entry-meta-item"><span class="entry-meta-label">Agent</span><span class="entry-meta-value">${data.agentName}</span></div>` : null}
            ${data.resultPreview ? html`<div class="entry-meta-item" style="grid-column:1/-1;"><span class="entry-meta-label">Result</span><span class="entry-meta-value" style="white-space:pre-wrap;font-size:12px;">${data.resultPreview}</span></div>` : null}
          </div>`;
      }

      default:
        if (data && Object.keys(data).length > 0) {
          return html`
            <div class="entry-expandable">
              <button class="expandable-toggle" onClick=${onToggle}>${expanded ? '▾ Hide data' : '▸ Show data'}</button>
              ${expanded ? html`<pre class="entry-json mt-8"><code>${JSON.stringify(data, null, 2)}</code></pre>` : null}
            </div>`;
        }
        return null;
    }
  };

  return html`
    <div class="audit-entry type-${entry.type}">
      <div class="audit-entry-header">
        <span class="audit-type-icon">${meta.icon}</span>
        <span class="badge badge-${meta.color}">${meta.label}</span>
        <span class="audit-entry-time">${formatTime(entry.timestamp)}</span>
        ${entry.durationMs ? html`<span class="audit-duration-badge">${formatDuration(entry.durationMs)}</span>` : null}
        ${showSession && entry.sessionId ? html`<span class="audit-entry-session" title=${entry.sessionId}>${truncate(entry.sessionId, 8)}</span>` : null}
      </div>
      <div class="audit-entry-body">${renderContent()}</div>
    </div>
  `;
}

function formatResultPreview(preview) {
  if (!preview) return '';
  try {
    const parsed = JSON.parse(preview);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return preview;
  }
}

// ─── Live Log ─────────────────────────────────────────────────────────────────

const ALL_TYPES = ['user_msg', 'assistant_msg', 'llm_request', 'llm_response', 'tool_call', 'tool_result', 'system_prompt', 'error', 'session_start', 'session_end', 'notify'];

function LiveLog() {
  const [entries, setEntries] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filters, setFilters] = useState(() => {
    const f = {};
    ALL_TYPES.forEach(t => f[t] = true);
    return f;
  });
  const [groupBySession, setGroupBySession] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState({});
  const [expandedEntries, setExpandedEntries] = useState({});
  const [connected, setConnected] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [mode, setMode] = useState('ws');
  const bottomRef = useRef(null);
  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const pingRef = useRef(null);
  const pollRef = useRef(null);
  const lastTsRef = useRef(new Date(Date.now() - 60000).toISOString());

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const WS_MAX_RETRIES = 3;

    function addEntry(entry) {
      if (entry.timestamp || entry.type) {
        if (entry.timestamp && entry.timestamp > lastTsRef.current) {
          lastTsRef.current = entry.timestamp;
        }
        setEntries(prev => {
          const next = [entry, ...prev];
          return next.length > 500 ? next.slice(0, 500) : next;
        });
      }
    }

    function startPolling() {
      if (cancelled || pollRef.current) return;
      setMode('poll');
      setConnected(true);

      async function poll() {
        if (cancelled) return;
        try {
          const data = await api(`/audit/poll?since=${encodeURIComponent(lastTsRef.current)}&limit=100`);
          if (Array.isArray(data)) {
            data.forEach(addEntry);
          }
        } catch { /* ignore poll errors */ }
        if (!cancelled) {
          pollRef.current = setTimeout(poll, 3000);
        }
      }
      poll();
    }

    function stopPolling() {
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    }

    function connect() {
      if (cancelled) return;

      if (retryRef.current >= WS_MAX_RETRIES) {
        startPolling();
        return;
      }

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${location.host}/admin/ws`;

      let ws;
      try { ws = new WebSocket(wsUrl); } catch {
        retryRef.current = WS_MAX_RETRIES;
        startPolling();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setMode('ws');
        retryRef.current = 0;
        if (pingRef.current) clearInterval(pingRef.current);
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'ping' })); } catch { }
          }
        }, 25000);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') return;
          const entry = msg.data || msg;
          addEntry(entry);
        } catch { /* ignore */ }
      };
      ws.onerror = () => { };
      ws.onclose = () => {
        setConnected(false);
        if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
        if (!cancelled) {
          retryRef.current++;
          if (retryRef.current >= WS_MAX_RETRIES) {
            startPolling();
          } else {
            const delay = Math.min(1000 * Math.pow(2, retryRef.current), 10000);
            timer = setTimeout(connect, delay);
          }
        }
      };
    }

    timer = setTimeout(connect, 500);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !cancelled) {
        if (wsRef.current?.readyState !== WebSocket.OPEN && !pollRef.current) {
          retryRef.current = 0;
          connect();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (pingRef.current) clearInterval(pingRef.current);
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [entries, autoScroll]);

  const toggleFilter = (type) => setFilters(prev => ({ ...prev, [type]: !prev[type] }));
  const toggleEntryExpand = (id, section) => setExpandedEntries(prev => {
    const current = prev[id];
    if (typeof section === 'string') {
      return { ...prev, [id]: current === section ? false : section };
    }
    return { ...prev, [id]: !current };
  });

  const filtered = useMemo(
    () => entries.filter(e => filters[e.type] !== false),
    [entries, filters]
  );

  const activeFilterCount = useMemo(
    () => ALL_TYPES.filter(t => filters[t]).length,
    [filters]
  );

  const grouped = useMemo(() => {
    if (!groupBySession) return null;
    const map = {};
    filtered.forEach(e => {
      const sid = e.sessionId || 'unknown';
      if (!map[sid]) map[sid] = [];
      map[sid].push(e);
    });
    return map;
  }, [filtered, groupBySession]);

  const renderEntry = (e, i) => {
    const key = e.id || `${e.sessionId}-${i}`;
    return html`<${AuditEntryCard}
      key=${key}
      entry=${e}
      showSession=${!groupBySession}
      expanded=${expandedEntries[key] ?? false}
      onToggle=${(section) => toggleEntryExpand(key, section)}
    />`;
  };

  return html`
    <div class="page-header flex justify-between items-center">
      <div>
        <h2>Live Log <span class="badge ${connected ? 'badge-green' : 'badge-red'}" style="font-size:11px;vertical-align:middle;margin-left:8px;">${connected ? (mode === 'poll' ? 'polling' : 'live') : 'disconnected'}</span>
          ${!connected ? html` <button class="btn btn-secondary btn-sm" style="margin-left:8px;font-size:11px;padding:2px 8px;" onClick=${() => { retryRef.current = 0; if (wsRef.current) wsRef.current.close(); }}>↻ Reconnect</button>` : null}
        </h2>
        <p>${mode === 'poll' ? 'HTTP polling (3s)' : 'Real-time audit stream'} · ${entries.length} entries</p>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-secondary btn-sm" onClick=${() => setAutoScroll(v => !v)}>
          ${autoScroll ? '⏸ Pause' : '▶ Auto-scroll'}
        </button>
        <button class="btn btn-secondary btn-sm" onClick=${() => setGroupBySession(v => !v)}>
          ${groupBySession ? '☰ Flat' : '▤ Group'}
        </button>
        <button class="btn btn-danger btn-sm" onClick=${() => setEntries([])}>Clear</button>
      </div>
    </div>

    <div class="filter-bar">
      <button class="filter-toggle-btn" onClick=${() => setFiltersExpanded(v => !v)}>
        <span>Filter</span>
        <span class="badge badge-blue" style="font-size:10px;margin-left:6px;">${activeFilterCount}/${ALL_TYPES.length}</span>
        <span class="chevron ${filtersExpanded ? 'expanded' : ''}" style="margin-left:auto;">▸</span>
      </button>
      <div class="filter-chips ${filtersExpanded ? 'expanded' : ''}">
        ${ALL_TYPES.map(t => {
    const m = typeMeta(t);
    return html`
            <label key=${t} class="filter-chip ${filters[t] ? 'active' : ''}">
              <input type="checkbox" checked=${filters[t]} onChange=${() => toggleFilter(t)} style="display:none;" />
              <span class="filter-chip-dot" style="background:var(--badge-${m.color}-text);"></span>
              ${m.label}
        </label>
          `;
  })}
      </div>
    </div>

    <div class="live-log-container">
      <div ref=${bottomRef} />
    ${groupBySession && grouped ? Object.entries(grouped).map(([sid, items]) => html`
      <div class="session-group" key=${sid}>
          <div class="session-group-header" onClick=${() => setExpandedGroups(prev => ({ ...prev, [sid]: !prev[sid] }))}>
          <div class="flex items-center gap-8">
            <span class="text-mono text-sm">${truncate(sid, 16)}</span>
            <span class="badge badge-blue">${items.length}</span>
              <span class="text-sm text-muted">${formatTime(items[0]?.timestamp)}</span>
          </div>
          <span class="chevron ${expandedGroups[sid] ? 'expanded' : ''}">▸</span>
        </div>
          ${expandedGroups[sid] ? html`<div class="session-group-body-inner">${items.map(renderEntry)}</div>` : null}
      </div>
    `) : filtered.map(renderEntry)}
    </div>
  `;
}

// ─── Sessions List ────────────────────────────────────────────────────────────

function ConversationHistories() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const workspaces = useWorkspaces();

  const resolveLabel = (key) => {
    const base = chatKeyLabel(key);
    if (/^[0-9a-f-]{32,}$/i.test(key)) {
      const ws = workspaces.find(w => w.id === key);
      if (ws) return { icon: '💬', label: ws.displayName || ws.name || ('Workspace ' + key.slice(0, 8)) };
    }
    const hbMatch = key.match(/^heartbeat:(.+)$/);
    if (hbMatch) {
      const ws = workspaces.find(w => w.id === hbMatch[1]);
      if (ws) return { icon: '💓', label: 'Heartbeat — ' + (ws.displayName || ws.name) };
    }
    return base;
  };

  const loadKeys = useCallback(() => {
    api('/history').then(data => setKeys(Array.isArray(data) ? data : []))
      .catch(() => { }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  const deleteHistory = async (key) => {
    if (!confirm(`Clear conversation history for "${key}"? This cannot be undone.`)) return;
    try {
      await api(`/history/${encodeURIComponent(key)}`, { method: 'DELETE' });
      showToast(`History "${key}" cleared`, 'success');
      loadKeys();
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  const deleteAll = async () => {
    if (!confirm(`Clear ALL conversation histories (${keys.length})? This cannot be undone.`)) return;
    try {
      await api('/history', { method: 'DELETE' });
      showToast('All conversation histories cleared', 'success');
      setKeys([]);
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  if (loading || keys.length === 0) return null;

  return html`
    <div class="card mb-16" style="border-left:3px solid var(--accent-purple);">
      <div class="flex justify-between items-center cursor-pointer" onClick=${() => setExpanded(v => !v)}>
        <div class="flex items-center gap-8">
          <span style="font-size:16px;">🧠</span>
          <div>
            <div style="font-weight:600;font-size:14px;">Agent Current Context</div>
            <div class="text-muted" style="font-size:12px;">${keys.length} active conversation(s) — this is the context the agent remembers. Clearing makes the agent forget past messages for that channel.</div>
          </div>
        </div>
        <div class="flex items-center gap-8">
          <span class="badge badge-purple" style="font-size:11px;">${keys.length}</span>
          <span style="font-size:12px;">${expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      ${expanded ? html`
        <div style="margin-top:12px;border-top:1px solid var(--border-color);padding-top:12px;">
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${keys.map(k => {
    const { icon, label } = resolveLabel(k);
    return html`
                <div key=${k} class="flex justify-between items-center" style="padding:6px 10px;background:var(--bg-primary);border-radius:var(--radius-md);">
                  <div class="flex items-center gap-8">
                    <span>${icon}</span>
                    <span style="font-size:13px;font-weight:500;">${label}</span>
                  </div>
                  <button class="btn btn-danger btn-sm" onClick=${(e) => { e.stopPropagation(); deleteHistory(k); }} style="padding:2px 8px;font-size:12px;">Clear Memory</button>
                </div>
              `;
  })}
          </div>
          <div style="margin-top:10px;text-align:right;">
            <button class="btn btn-danger btn-sm" onClick=${(e) => { e.stopPropagation(); deleteAll(); }}>Clear All Memory</button>
          </div>
        </div>
      ` : null}
    </div>
  `;
}

function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const limit = 20;

  const load = useCallback(() => {
    const isFirst = loading;
    if (isFirst) setLoading(true);
    api(`/sessions?limit=${limit}&offset=${offset}`)
      .then(data => {
        setSessions(Array.isArray(data) ? data : data.sessions || []);
        setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [offset]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, load]);

  const deleteSession = async (sessionId, e) => {
    e.stopPropagation();
    if (!confirm('Delete this audit session? This cannot be undone.')) return;
    try {
      await api(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      showToast('Session deleted', 'success');
      load();
    } catch (err) { showToast(`Failed: ${err.message}`, 'error'); }
  };

  const purgeHeartbeat = async () => {
    if (!confirm('Delete ALL heartbeat audit sessions? This cannot be undone.')) return;
    try {
      await api('/sessions?identity=' + encodeURIComponent('system:heartbeat%'), { method: 'DELETE' });
      showToast('Heartbeat sessions purged', 'success');
      load();
    } catch (err) { showToast(`Failed: ${err.message}`, 'error'); }
  };

  const purgeAll = async () => {
    if (!confirm('Delete ALL audit sessions? This cannot be undone.')) return;
    try {
      await api('/sessions', { method: 'DELETE' });
      showToast('All sessions deleted', 'success');
      setSessions([]);
    } catch (err) { showToast(`Failed: ${err.message}`, 'error'); }
  };

  const heartbeatCount = sessions.filter(s => (s.identityId || '').startsWith('system:heartbeat')).length;

  if (loading && sessions.length === 0) return html`<div class="loading-center"><div class="spinner" /></div>`;
  if (error && sessions.length === 0) return html`<div class="error-card">Failed to load sessions: ${error}</div>`;

  return html`
    <div class="page-header flex justify-between items-center">
      <div><h2>Sessions</h2><p>Browse audit log sessions and manage conversation histories</p></div>
      <div class="flex gap-8">
        <button class="btn btn-secondary btn-sm" onClick=${() => setAutoRefresh(v => !v)}>
          ${autoRefresh ? '⏸ Pause refresh' : '▶ Auto-refresh'}
        </button>
        <button class="btn btn-secondary btn-sm" onClick=${load}>↻ Refresh</button>
      </div>
    </div>

    <${ConversationHistories} />

    <div class="flex justify-between items-center mb-12 mt-24">
      <div>
        <h3 style="font-size:16px;font-weight:600;margin:0;">Audit Log</h3>
        <p class="text-muted" style="font-size:12px;margin:4px 0 0;">Activity logs for debugging and monitoring. Deleting only removes log entries — does not affect agent memory.</p>
      </div>
      ${sessions.length > 0 ? html`
        <div class="flex gap-8">
          ${heartbeatCount > 0 ? html`<button class="btn btn-danger btn-sm" onClick=${purgeHeartbeat}>💓 Purge Heartbeat (${heartbeatCount})</button>` : null}
          <button class="btn btn-danger btn-sm" onClick=${purgeAll}>🗑 Clear All</button>
        </div>
      ` : null}
      </div>

    ${sessions.length === 0 ? html`
      <div class="empty-state"><div class="empty-state-icon">☰</div><p>No sessions recorded yet</p></div>
    ` : html`
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${sessions.map(s => {
    const info = sessionDisplayInfo(s);
    return html`
            <div key=${s.sessionId} class="card" style="padding:12px 16px;">
              <div class="flex justify-between items-center">
                <div class="flex items-center cursor-pointer" style="gap:10px;flex:1;" onClick=${() => navigate(`/sessions/${s.sessionId}`)}>
                  <span style="font-size:20px;">${info.icon}</span>
                  <div>
                    <div style="font-weight:600;font-size:14px;">${info.label}</div>
                    <div class="text-muted" style="font-size:12px;">${info.chLabel} · ${relativeTime(s.lastActivityAt || s.startedAt)}</div>
                  </div>
                </div>
                <div class="flex items-center gap-8">
                  <span class="badge badge-blue">${s.entryCount ?? 0}</span>
                  <button class="btn btn-danger btn-sm" onClick=${(e) => deleteSession(s.sessionId, e)} style="padding:2px 8px;font-size:12px;" title="Delete session">🗑</button>
                </div>
              </div>
            </div>
          `;
  })}
      </div>
      <div class="pagination">
        <button class="btn btn-secondary btn-sm" disabled=${offset === 0} onClick=${() => setOffset(Math.max(0, offset - limit))}>← Prev</button>
        <span class="pagination-info">Page ${Math.floor(offset / limit) + 1}</span>
        <button class="btn btn-secondary btn-sm" disabled=${sessions.length < limit} onClick=${() => setOffset(offset + limit)}>Next →</button>
      </div>
    `}
  `;
}

// ─── Session Detail ───────────────────────────────────────────────────────────

function SessionDetail({ sessionId }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedEntries, setExpandedEntries] = useState({});
  const [reversed, setReversed] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const loadedOnce = useRef(false);
  const [pageOffset, setPageOffset] = useState(0);
  const [totalEntries, setTotalEntries] = useState(0);
  const pageLimit = 50;

  const loadEntries = useCallback(() => {
    if (!loadedOnce.current) setLoading(true);
    const sortParam = reversed ? 'desc' : 'asc';
    api(`/sessions/${sessionId}?limit=${pageLimit}&offset=${pageOffset}&sort=${sortParam}`)
      .then(data => {
        if (data && data.entries) {
          setEntries(data.entries);
          setTotalEntries(data.total || data.entries.length);
        } else {
          setEntries(Array.isArray(data) ? data : []);
          setTotalEntries(Array.isArray(data) ? data.length : 0);
        }
        setError(null);
        loadedOnce.current = true;
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [sessionId, pageOffset, reversed]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(loadEntries, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadEntries]);

  const isActive = entries.length > 0 && !entries.some(e => e.type === 'session_end');

  if (loading && !loadedOnce.current) return html`<div class="loading-center"><div class="spinner" /></div>`;
  if (error && entries.length === 0) return html`<div class="error-card">Failed to load session: ${error}</div>`;

  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  const totalDuration = firstEntry && lastEntry
    ? Math.abs(new Date(lastEntry.timestamp) - new Date(firstEntry.timestamp))
    : 0;
  const toolCalls = entries.filter(e => e.type === 'tool_call');
  const errEntries = entries.filter(e => e.type === 'error');

  return html`
    <div class="page-header">
      <div class="flex items-center justify-between" style="width:100%">
        <div class="flex items-center gap-12">
          <button class="btn btn-secondary btn-sm" onClick=${() => window.history.back()}>← Back</button>
          <div>
            <h2>Session Detail ${isActive ? html` <span class="badge badge-green" style="font-size:11px;vertical-align:middle;">ACTIVE</span>` : ''}</h2>
            <p class="text-mono text-sm">${sessionId}</p>
          </div>
        </div>
        <div class="flex gap-8">
          <button class="btn btn-secondary btn-sm" onClick=${() => { setReversed(v => !v); setPageOffset(0); }}>
            ${reversed ? '↑ Oldest first' : '↓ Newest first'}
          </button>
          <button class="btn btn-secondary btn-sm" onClick=${() => setAutoRefresh(v => !v)}>
            ${autoRefresh ? '⏸ Pause' : '▶ Auto-refresh'}
          </button>
          <button class="btn btn-secondary btn-sm" onClick=${loadEntries}>↻</button>
          <button class="btn btn-danger btn-sm" onClick=${async () => {
      if (!confirm('Delete this session and all its entries?')) return;
      try {
        await api(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
        showToast('Session deleted', 'success');
        navigate('/sessions');
      } catch (err) { showToast(`Failed: ${err.message}`, 'error'); }
    }}>🗑 Delete</button>
        </div>
      </div>
    </div>

    <div class="session-summary-bar mb-16">
      ${firstEntry ? (() => {
      const info = sessionDisplayInfo({ channel: firstEntry.channel, identityId: firstEntry.identityId, sessionId });
      return html`<div class="summary-item"><span class="summary-label">Source</span><span>${info.icon} ${info.chLabel}</span></div>
      <div class="summary-item"><span class="summary-label">Identity</span><span>${info.label}</span></div>`;
    })() : null}
      <div class="summary-item"><span class="summary-label">Started</span><span>${formatTime(firstEntry?.timestamp)}</span></div>
      <div class="summary-item"><span class="summary-label">Duration</span><span>${formatDuration(totalDuration)}</span></div>
      <div class="summary-item"><span class="summary-label">Entries</span><span class="badge badge-blue">${totalEntries}</span></div>
      ${toolCalls.length > 0 ? html`<div class="summary-item"><span class="summary-label">Tool Calls</span><span class="badge badge-green">${toolCalls.length}</span></div>` : null}
      ${errEntries.length > 0 ? html`<div class="summary-item"><span class="summary-label">Errors</span><span class="badge badge-red">${errEntries.length}</span></div>` : null}
    </div>

    ${totalEntries > pageLimit ? html`
      <div class="pagination mb-12">
        <button class="btn btn-secondary btn-sm" disabled=${pageOffset === 0} onClick=${() => setPageOffset(Math.max(0, pageOffset - pageLimit))}>← Prev</button>
        <span class="pagination-info">Page ${Math.floor(pageOffset / pageLimit) + 1} of ${Math.ceil(totalEntries / pageLimit)}</span>
        <button class="btn btn-secondary btn-sm" disabled=${pageOffset + pageLimit >= totalEntries} onClick=${() => setPageOffset(pageOffset + pageLimit)}>Next →</button>
      </div>
    ` : null}

    <div class="session-timeline">
      ${entries.map((entry, idx) => {
      const key = entry.id || (sessionId + '-' + idx);
      return html`
          <div key=${key}>
            <${AuditEntryCard}
              entry=${entry}
              expanded=${expandedEntries[key] ?? false}
              onToggle=${(section) => setExpandedEntries(prev => {
        const cur = prev[key];
        if (typeof section === 'string') return { ...prev, [key]: cur === section ? false : section };
        return { ...prev, [key]: !cur };
      })}
            />
          </div>
        `;
    })}
    </div>

    ${totalEntries > pageLimit ? html`
      <div class="pagination mt-12">
        <button class="btn btn-secondary btn-sm" disabled=${pageOffset === 0} onClick=${() => setPageOffset(Math.max(0, pageOffset - pageLimit))}>← Prev</button>
        <span class="pagination-info">Page ${Math.floor(pageOffset / pageLimit) + 1} of ${Math.ceil(totalEntries / pageLimit)}</span>
        <button class="btn btn-secondary btn-sm" disabled=${pageOffset + pageLimit >= totalEntries} onClick=${() => setPageOffset(pageOffset + pageLimit)}>Next →</button>
          </div>
    ` : null}
  `;
}

function simpleMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\n/g, '<br/>');
}

const INTERNAL_AGENT_LABELS = {
  'internal:memory_update_agent': { icon: '🧠', label: 'Memory Update', chLabel: 'Internal' },
  'internal:memory_cleanup_agent': { icon: '🧹', label: 'Memory Cleanup', chLabel: 'Internal' },
  'internal:self_learner_agent': { icon: '📚', label: 'Self Learner', chLabel: 'Internal' },
  'internal:kyu_agent': { icon: '👤', label: 'KYU Profile', chLabel: 'Internal' },
};

function sessionDisplayInfo(s) {
  const ch = s.channel || 'internal';
  const id = s.identityId || '';
  const sid = s.sessionId || '';
  const isScheduler = id.startsWith('scheduler:');
  const isHeartbeat = id.startsWith('system:heartbeat');
  if (isScheduler) {
    const taskId = id.replace('scheduler:', '').slice(0, 12);
    return { icon: '📅', label: 'Task ' + taskId, chLabel: 'Task' };
  }
  if (isHeartbeat) {
    const wsId = id.replace('system:heartbeat:', '').slice(0, 8);
    return { icon: '💓', label: 'Heartbeat ' + wsId, chLabel: 'Heartbeat' };
  }
  if (ch === 'subagent') {
    const name = id.replace('subagent:', '');
    return { icon: '🤖', label: name || sid.slice(0, 8), chLabel: 'Sub-Agent' };
  }
  if (ch === 'internal' && INTERNAL_AGENT_LABELS[id]) {
    return INTERNAL_AGENT_LABELS[id];
  }
  if (ch === 'internal' && id.startsWith('internal:')) {
    const name = id.replace('internal:', '');
    return { icon: '⚙️', label: name, chLabel: 'Internal' };
  }
  if (ch === 'telegram') {
    const ctx = s.chatContext;
    if (ctx) {
      const isGroup = ctx.type === 'group';
      const icon = isGroup ? '👥' : '💬';
      const title = ctx.chatTitle || (isGroup ? 'Group' : 'Private');
      const threadSuffix = ctx.threadId ? ' #' + ctx.threadId : '';
      const typeLabel = isGroup ? 'Group' : 'Private';
      return { icon, label: title + threadSuffix, chLabel: 'Telegram · ' + typeLabel };
    }
    const tgId = id.replace('telegram:', '').slice(0, 12);
    return { icon: '💬', label: tgId || sid.slice(0, 8), chLabel: 'Telegram' };
  }
  if (ch === 'email') {
    const addr = id.replace('email:', '');
    return { icon: '✉️', label: addr || sid.slice(0, 8), chLabel: 'Email' };
  }
  const fallbackLabel = id.replace(/^system:/, '') || sid.slice(0, 8);
  return { icon: '🔗', label: fallbackLabel, chLabel: ch.charAt(0).toUpperCase() + ch.slice(1) };
}

function chatKeyLabel(key) {
  if (key.startsWith('telegram:')) return { icon: '💬', label: 'Telegram ' + key.replace('telegram:telegram:', '').replace('telegram:', '').slice(0, 12) };
  if (key.startsWith('task:')) return { icon: '📅', label: 'Task ' + key.replace('task:', '').slice(0, 12) };
  if (key.startsWith('scheduler:')) return { icon: '📅', label: 'Task ' + key.replace('scheduler:', '').slice(0, 12) };
  if (key.startsWith('heartbeat:')) return { icon: '💓', label: 'Heartbeat (' + key.replace('heartbeat:', '').slice(0, 8) + ')' };
  if (key === 'heartbeat') return { icon: '💓', label: 'Heartbeat' };
  if (key.startsWith('email:')) return { icon: '✉️', label: 'Email ' + key.replace('email:', '') };
  if (key.startsWith('subagent:')) return { icon: '🤖', label: 'SubAgent ' + key.replace('subagent:', '') };
  if (/^[0-9a-f-]{32,}$/i.test(key)) return { icon: '💬', label: 'Workspace ' + key.slice(0, 8) };
  return { icon: '🔗', label: key.length > 20 ? key.slice(0, 16) + '…' : key };
}


// ─── Config Editor ────────────────────────────────────────────────────────────

const CONFIG_TABS = [
  { id: 'settings', label: 'Settings', endpoint: '/config/settings', format: 'json' },
  { id: 'providers', label: 'Providers', endpoint: '/config/providers', format: 'content' },
  { id: 'channels', label: 'Channels', endpoint: '/config/channels', format: 'content' },
  { id: 'agent', label: 'Agent Prompt', endpoint: '/config/agent', format: 'content' },
  { id: 'identity', label: 'Identity', endpoint: '/config/identity', format: 'content' },
  { id: 'heartbeat', label: 'Heartbeat Prompt', endpoint: '/config/heartbeat', format: 'content' },
  { id: 'kyu', label: 'KYU Profile', endpoint: '/config/kyu', format: 'content' },
];

function SettingsEditor() {
  const [settings, setSettings] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api('/config/settings').then(data => typeof data === 'string' ? JSON.parse(data) : data),
      api('/config/providers').then(data => Array.isArray(data) ? data : []).catch(() => []),
    ]).then(([settingsData, providersData]) => {
      setSettings(settingsData);
      setProviders(providersData);
    }).catch(e => showToast(`Failed: ${e.message}`, 'error'))
      .finally(() => setLoading(false));
  }, []);

  const update = (path, value) => {
    setSettings(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const parts = path.split('.');
      let obj = next;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const freshProviders = await api('/config/providers').then(d => (Array.isArray(d) ? d : []));
      const merged = applyDefaultRoleToProviders(freshProviders, settings.defaultProvider, settings.defaultModel);
      await api('/config/providers', { method: 'PUT', body: merged });
      setProviders(merged);
      await api('/config/settings', { method: 'PUT', body: settings });
      showToast('Settings saved', 'success');
      window.dispatchEvent(new Event('config-saved'));
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setSaving(false); }
  };

  if (loading || !settings) return html`<div class="loading-center"><div class="spinner" /></div>`;

  const hb = settings.heartbeat || {};
  const wa = settings.web_admin || {};

  const selectedProvider = providers.find(p => (p.name || p.id) === settings.defaultProvider);
  const providerModels = selectedProvider?.models || [];

  const onProviderChange = (provId) => {
    update('defaultProvider', provId);
    const prov = providers.find(p => (p.name || p.id) === provId);
    if (prov?.models?.length) {
      const first = prov.models[0];
      update('defaultModel', first.id || first.name);
      if (first.maxTokens) update('maxTokens', first.maxTokens);
    }
  };

  const onModelChange = (modelId) => {
    update('defaultModel', modelId);
    const model = providerModels.find(m => (m.id || m.name) === modelId);
    if (model?.maxTokens) update('maxTokens', model.maxTokens);
  };

  return html`
    <div class="form-section">
      <h3 class="form-section-title">LLM Defaults</h3>
      <div class="form-grid">
        <div class="form-field">
          <label>Default Provider</label>
          ${providers.length > 0 ? html`
            <select value=${settings.defaultProvider || ''} onChange=${e => onProviderChange(e.target.value)}>
              <option value="">— Select —</option>
              ${providers.map(p => html`<option key=${p.name || p.id} value=${p.name || p.id}>${p.name || p.id}${p.type ? ` (${p.type})` : ''}</option>`)}
            </select>
          ` : html`
            <input type="text" value=${settings.defaultProvider || ''} onInput=${e => update('defaultProvider', e.target.value)} placeholder="e.g. openai" />
          `}
            </div>
        <div class="form-field">
          <label>Default Model</label>
          ${providerModels.length > 0 ? html`
            <select value=${settings.defaultModel || ''} onChange=${e => onModelChange(e.target.value)}>
              <option value="">— Select —</option>
              ${providerModels.map(m => html`<option key=${m.id || m.name} value=${m.id || m.name}>${m.name || m.id}${m.maxTokens ? ` (${(m.maxTokens / 1024).toFixed(0)}k)` : ''}</option>`)}
            </select>
          ` : html`
            <input type="text" value=${settings.defaultModel || ''} onInput=${e => update('defaultModel', e.target.value)} placeholder="e.g. gpt-4o" />
          `}
              </div>
        <div class="form-field">
          <label>Max Tokens (output)</label>
          <input type="number" value=${settings.maxTokens || 16384} onInput=${e => update('maxTokens', parseInt(e.target.value) || 16384)} />
            </div>
        <div class="form-field">
          <label>Max Context Tokens</label>
          <input type="number" value=${settings.maxContextTokens || 200000} onInput=${e => update('maxContextTokens', parseInt(e.target.value) || 200000)} />
              </div>
        <div class="form-field">
          <label>Max Iterations (soft limit)</label>
          <input type="number" value=${settings.maxIterations || 50} min="1" onInput=${e => update('maxIterations', parseInt(e.target.value) || 50)} />
          </div>
        <div class="form-field">
          <label>Max Iterations (hard limit)</label>
          <input type="number" value=${settings.maxIterationsEnforced || 100} min="1" onInput=${e => update('maxIterationsEnforced', parseInt(e.target.value) || 100)} />
        </div>
        <div class="form-field">
          <label>Log Level</label>
          <select value=${settings.logLevel || 'info'} onChange=${e => update('logLevel', e.target.value)}>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </div>
      </div>
    </div>

    <div class="form-section">
      <h3 class="form-section-title">Mode</h3>
      <div class="form-grid">
        <div class="form-field">
          <label class="toggle-label">
            <label class="pill-switch">
              <input type="checkbox" checked=${settings.multiUser === true} onChange=${e => update('multiUser', e.target.checked)} />
              <span class="pill-slider"></span>
            </label>
            <span>Multi-User Mode</span>
          </label>
          <p class="text-sm text-muted" style="margin-top:4px;">When enabled, each Telegram user gets their own workspace and isolated context. Requires reload.</p>
            </div>
            </div>
          </div>

    <div class="form-section">
      <h3 class="form-section-title">Heartbeat</h3>
      <div class="form-grid">
        <div class="form-field">
          <label class="toggle-label">
            <label class="pill-switch">
              <input type="checkbox" checked=${hb.enabled !== false} onChange=${e => update('heartbeat.enabled', e.target.checked)} />
              <span class="pill-slider"></span>
            </label>
            <span>Enabled</span>
          </label>
            </div>
        <div class="form-field">
          <label>Interval (minutes)</label>
          <input type="number" value=${hb.intervalMinutes || 30} min="1" onInput=${e => update('heartbeat.intervalMinutes', parseInt(e.target.value) || 30)} />
          </div>
      </div>
    </div>

    <div class="form-section">
      <h3 class="form-section-title">Web Admin</h3>
      <div class="form-grid">
        <div class="form-field">
          <label class="toggle-label">
            <label class="pill-switch">
              <input type="checkbox" checked=${wa.enabled !== false} onChange=${e => update('web_admin.enabled', e.target.checked)} />
              <span class="pill-slider"></span>
            </label>
            <span>Enabled</span>
          </label>
            </div>
        <div class="form-field">
          <label>Port</label>
          <input type="number" value=${wa.port || 3100} onInput=${e => update('web_admin.port', parseInt(e.target.value) || 3100)} />
        </div>
        <div class="form-field">
          <label>Username</label>
          <input type="text" value=${wa.username || ''} onInput=${e => update('web_admin.username', e.target.value)} placeholder="admin" />
        </div>
        <div class="form-field">
          <label>Password</label>
          <input type="password" value=${wa.password || ''} onInput=${e => update('web_admin.password', e.target.value)} />
        </div>
      </div>
    </div>

    <div class="flex justify-between items-center mt-16">
      <div />
      <button class="btn btn-primary" onClick=${handleSave} disabled=${saving}>${saving ? 'Saving…' : '💾 Save Settings'}</button>
          </div>
        `;
}

function ProvidersEditor() {
  const [content, setContent] = useState('');
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState('form');

  const loadProviders = useCallback(() => {
    setLoading(true);
    api('/config/providers')
      .then(data => {
        const arr = Array.isArray(data) ? data : [];
        setProviders(arr);
        setContent(JSON.stringify(arr, null, 2));
      })
      .catch(e => showToast(`Failed: ${e.message}`, 'error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = editMode === 'form' ? providers : JSON.parse(content);
      await api('/config/providers', { method: 'PUT', body: data });
      const def = findDefaultFromProviders(data);
      if (def) {
        const cur = await api('/config/settings');
        const base = typeof cur === 'object' && cur ? cur : {};
        await api('/config/settings', { method: 'PUT', body: { ...base, defaultProvider: def.defaultProvider, defaultModel: def.defaultModel } });
      }
      showToast('Providers saved', 'success');
      window.dispatchEvent(new Event('config-saved'));
      if (editMode !== 'form') {
        try { setProviders(JSON.parse(content)); } catch { }
      }
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setSaving(false); }
  };

  const updateProvider = (index, field, value) => {
    setProviders(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const addProvider = () => {
    setProviders(prev => [...prev, { id: 'new-provider', type: 'openai', apiKey: '', models: [] }]);
  };

  const removeProvider = (index) => {
    if (!confirm('Remove this provider?')) return;
    setProviders(prev => prev.filter((_, i) => i !== index));
  };

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;

  return html`
    <div class="flex justify-between items-center mb-16">
      <div class="flex gap-8">
        <button class="btn ${editMode === 'form' ? 'btn-primary' : 'btn-secondary'} btn-sm" onClick=${() => { setEditMode('form'); try { setProviders(JSON.parse(content)); } catch { } }}>Form</button>
        <button class="btn ${editMode === 'raw' ? 'btn-primary' : 'btn-secondary'} btn-sm" onClick=${() => { setEditMode('raw'); setContent(JSON.stringify(providers, null, 2)); }}>Raw JSON</button>
        </div>
      <button class="btn btn-primary btn-sm" onClick=${addProvider} disabled=${editMode !== 'form'}>+ Add Provider</button>
    </div>

    ${editMode === 'form' ? html`
      ${providers.length === 0 ? html`<div class="empty-state"><div class="empty-state-icon">🤖</div><p>No providers configured</p></div>` : null}
      ${providers.map((p, i) => html`
        <div class="card mb-12" key=${i} style="border-left:3px solid var(--accent-blue);">
          <div class="flex justify-between items-center mb-12">
            <span class="badge badge-blue">${p.type || 'unknown'}</span>
            <button class="btn btn-danger btn-sm" onClick=${() => removeProvider(i)}>Remove</button>
    </div>
          <div class="form-grid">
            <div class="form-field">
              <label>ID</label>
              <input type="text" value=${p.id || ''} onInput=${e => updateProvider(i, 'id', e.target.value)} />
            </div>
            <div class="form-field">
              <label>Type</label>
              <select value=${p.type || 'openai'} onChange=${e => updateProvider(i, 'type', e.target.value)}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai_compat">OpenAI Compatible</option>
              </select>
            </div>
            <div class="form-field">
              <label>API Key</label>
              <input type="password" value=${p.apiKey || ''} onInput=${e => updateProvider(i, 'apiKey', e.target.value)} placeholder="sk-..." />
            </div>
            ${p.type === 'openai_compat' || p.baseUrl ? html`
              <div class="form-field">
                <label>Base URL</label>
                <input type="url" value=${p.baseUrl || ''} onInput=${e => updateProvider(i, 'baseUrl', e.target.value)} placeholder="https://api.example.com/v1" />
              </div>
            ` : null}
            <div class="form-field" style="grid-column:1/-1;">
              <label>Models (comma-separated IDs)</label>
              <input type="text" value=${(p.models || []).map(m => typeof m === 'string' ? m : m.id || m.name || '').join(', ')} onInput=${e => updateProvider(i, 'models', e.target.value.split(',').map(s => s.trim()).filter(Boolean).map(id => {
    const existing = (p.models || []).find(m => (typeof m === 'string' ? m : m.id) === id);
    return typeof existing === 'object' && existing ? existing : { id, name: id };
  }))} placeholder="gpt-4o, gpt-4o-mini" />
            </div>
            ${(p.models || []).length > 0 ? html`
              <div class="form-field" style="grid-column:1/-1;">
                <label>Model Settings</label>
                ${(p.models || []).map((m, mi) => {
    const model = typeof m === 'string' ? { id: m, name: m } : m;
    return html`
                    <div key=${mi} style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
                      <span style="min-width:120px;font-size:13px;font-weight:500;">${model.id || model.name}</span>
                      <select style="font-size:12px;padding:2px 6px;" value=${model.reasoningEffort || ''}
                        onChange=${e => {
        const val = e.target.value;
        const updated = [...(p.models || [])];
        const obj = typeof updated[mi] === 'string' ? { id: updated[mi], name: updated[mi] } : { ...updated[mi] };
        if (val) obj.reasoningEffort = val; else delete obj.reasoningEffort;
        updated[mi] = obj;
        updateProvider(i, 'models', updated);
      }}>
                        <option value="">No reasoning</option>
                        <option value="low">Reasoning: low</option>
                        <option value="medium">Reasoning: medium</option>
                        <option value="high">Reasoning: high</option>
                      </select>
                      <div style="display:flex;gap:4px;flex-wrap:wrap;">
                        ${['default', 'fallback', 'fast', 'capable', 'vision', 'coding', 'multimodal', 'long-context', 'cheap', 'planner', 'creative', 'translator', 'summarizer'].map(role => {
        const roles = model.roles || [];
        const active = roles.includes(role);
        return html`<button type="button" style=${{
          fontSize: '11px', padding: '1px 6px', borderRadius: '10px', border: active ? 'none' : '1px solid #444',
          background: active ? (role === 'default' ? '#238636' : role === 'fallback' ? '#b08800' : '#1f6feb') : 'transparent',
          color: active ? '#fff' : '#8b949e', cursor: 'pointer'
        }} onClick=${() => {
          setProviders(prev => {
            const provId = p.id;
            const modelId = model.id || model.name;
            const willActivate = !active;
            return prev.map((prov, pi) => {
              const thisProv = prov.id === provId;
              return {
                ...prov,
                models: (prov.models || []).map((mod, mj) => {
                  const o = typeof mod === 'string' ? { id: mod, name: mod } : { ...mod };
                  const oid = o.id || o.name;
                  const thisModel = pi === i && mj === mi;
                  let roles = [...(o.roles || [])];
                  if (role === 'default' || role === 'fallback') {
                    if (thisModel) {
                      if (willActivate) roles = [...roles.filter(r => r !== role), role];
                      else roles = roles.filter(r => r !== role);
                    } else if (willActivate) {
                      roles = roles.filter(r => r !== role);
                    }
                  } else if (thisModel) {
                    if (roles.includes(role)) roles = roles.filter(r => r !== role);
                    else roles = [...roles, role];
                  }
                  if (roles.length === 0) delete o.roles; else o.roles = roles;
                  return o;
                }),
              };
            });
          });
        }}>${role}</button>`;
      })}
                      </div>
                    </div>`;
  })}
              </div>
            ` : null}
          </div>
        </div>
      `)}
    ` : html`
      <textarea class="code-editor w-full" value=${content} onInput=${e => setContent(e.target.value)} spellcheck=${false} />
    `}

    <div class="flex justify-between items-center mt-16">
      <button class="btn btn-secondary" onClick=${loadProviders}>↻ Reload</button>
      <button class="btn btn-primary" onClick=${handleSave} disabled=${saving}>${saving ? 'Saving…' : '💾 Save Providers'}</button>
    </div>
  `;
}

function GmailOAuthButton({ channelIndex, channels, updateChannel }) {
  const [step, setStep] = useState('idle');
  const [authUrl, setAuthUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const ch = channels[channelIndex];
  const clientId = ch?.config?.clientId || '';
  const clientSecret = ch?.config?.clientSecret || '';

  const startOAuth = async () => {
    if (!clientId || !clientSecret) {
      setError('Enter Client ID and Client Secret first');
      return;
    }
    setError('');
    setStep('loading');
    try {
      const res = await api('/gmail/auth-url', { method: 'POST', body: { clientId, clientSecret } });
      if (!res.ok) throw new Error(res.error || 'Failed to generate auth URL');
      setAuthUrl(res.url);
      setStep('authorize');
    } catch (e) {
      setError(e.message);
      setStep('idle');
    }
  };

  const exchangeToken = async () => {
    if (!code.trim()) return;
    setError('');
    setStep('exchanging');
    try {
      const res = await api('/gmail/exchange', { method: 'POST', body: { clientId, clientSecret, code: code.trim() } });
      if (!res.ok) throw new Error(res.error || 'Exchange failed');
      updateChannel(channelIndex, 'config.refreshToken', res.refreshToken);
      updateChannel(channelIndex, 'config.email', res.email);
      showToast(`Gmail authorized for ${res.email}`, 'success');
      setStep('done');
    } catch (e) {
      setError(e.message);
      setStep('authorize');
    }
  };

  if (step === 'idle') {
    return html`<button class="btn btn-secondary btn-sm" type="button" onClick=${startOAuth}>Authorize</button>`;
  }

  if (step === 'loading' || step === 'exchanging') {
    return html`<button class="btn btn-secondary btn-sm" disabled>Loading...</button>`;
  }

  if (step === 'done') {
    return html`<span class="badge badge-green">Authorized</span>`;
  }

  return html`
    <div style="display:flex;flex-direction:column;gap:6px;">
      <a href=${authUrl} target="_blank" class="btn btn-secondary btn-sm" style="text-align:center;">Open Google Auth</a>
      <div class="flex gap-4">
        <input type="text" style="flex:1;font-size:12px;" value=${code} onInput=${e => setCode(e.target.value)} placeholder="Paste auth code here" />
        <button class="btn btn-primary btn-sm" type="button" onClick=${exchangeToken} disabled=${!code.trim()}>Exchange</button>
      </div>
      ${error ? html`<div style="color:var(--badge-red-text);font-size:12px;">${error}</div>` : null}
    </div>
  `;
}

function ChannelsEditor() {
  const [content, setContent] = useState('');
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState('form');

  const loadChannels = useCallback(() => {
    setLoading(true);
    api('/config/channels')
      .then(data => {
        const arr = Array.isArray(data) ? data : [];
        setChannels(arr);
        setContent(JSON.stringify(arr, null, 2));
      })
      .catch(e => showToast(`Failed: ${e.message}`, 'error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadChannels(); }, [loadChannels]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = editMode === 'form' ? channels : JSON.parse(content);
      await api('/config/channels', { method: 'PUT', body: data });
      showToast('Channels saved', 'success');
      window.dispatchEvent(new Event('config-saved'));
      if (editMode !== 'form') {
        try { setChannels(JSON.parse(content)); } catch { }
      }
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setSaving(false); }
  };

  const updateChannel = (index, path, value) => {
    setChannels(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const parts = path.split('.');
      let obj = next[index];
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      return next;
    });
  };

  const addChannel = () => {
    setChannels(prev => [...prev, { id: `channel-${prev.length + 1}`, type: 'telegram', enabled: true, config: { token: '', allowedChatIds: [] } }]);
  };

  const removeChannel = (index) => {
    if (!confirm('Remove this channel?')) return;
    setChannels(prev => prev.filter((_, i) => i !== index));
  };

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;

  return html`
    <div class="flex justify-between items-center mb-16">
      <div class="flex gap-8">
        <button class="btn ${editMode === 'form' ? 'btn-primary' : 'btn-secondary'} btn-sm" onClick=${() => { setEditMode('form'); try { setChannels(JSON.parse(content)); } catch { } }}>Form</button>
        <button class="btn ${editMode === 'raw' ? 'btn-primary' : 'btn-secondary'} btn-sm" onClick=${() => { setEditMode('raw'); setContent(JSON.stringify(channels, null, 2)); }}>Raw JSON</button>
      </div>
      <button class="btn btn-primary btn-sm" onClick=${addChannel} disabled=${editMode !== 'form'}>+ Add Channel</button>
    </div>

    ${editMode === 'form' ? html`
      ${channels.length === 0 ? html`<div class="empty-state"><div class="empty-state-icon">📡</div><p>No channels configured</p></div>` : null}
      ${channels.map((ch, i) => html`
        <div class="card mb-12" key=${i} style="border-left:3px solid var(--accent-green);">
          <div class="flex justify-between items-center mb-12">
            <div class="flex items-center gap-8">
              <span class="badge badge-green">${ch.type || 'unknown'}</span>
              <span class="badge ${ch.enabled ? 'badge-green' : 'badge-red'}">${ch.enabled ? 'enabled' : 'disabled'}</span>
      </div>
            <button class="btn btn-danger btn-sm" onClick=${() => removeChannel(i)}>Remove</button>
          </div>
          <div class="form-grid">
            <div class="form-field">
              <label>ID</label>
              <input type="text" value=${ch.id || ''} onInput=${e => updateChannel(i, 'id', e.target.value)} />
      </div>
            <div class="form-field">
              <label>Type</label>
              <select value=${ch.type || 'telegram'} onChange=${e => {
      const newType = e.target.value;
      setChannels(prev => {
        const next = JSON.parse(JSON.stringify(prev));
        next[i].type = newType;
        if (newType === 'telegram') next[i].config = { token: '', allowedChatIds: [] };
        else if (newType === 'email') next[i].config = { imap: { host: '', port: 993, user: '', password: '', tls: true }, smtp: { host: '', port: 465, user: '', password: '', secure: true } };
        else if (newType === 'gmail') next[i].config = { clientId: '', clientSecret: '', refreshToken: '', email: '', pollIntervalSeconds: 30 };
        else if (newType === 'mqtt') next[i].config = { broker_url: '', username: '', password: '', subscribe_topics: ['korabot/inbox'], response_topic: 'korabot/response', client_id: '' };
        return next;
      });
    }}>
                <option value="telegram">Telegram</option>
                <option value="email">Email (IMAP/SMTP)</option>
                <option value="gmail">Gmail (OAuth2 API)</option>
                <option value="mqtt">MQTT</option>
              </select>
            </div>
            <div class="form-field">
              <label class="toggle-label">
                <input type="checkbox" checked=${ch.enabled !== false} onChange=${e => updateChannel(i, 'enabled', e.target.checked)} style="width:auto;min-height:auto;" />
                <span>Enabled</span>
              </label>
            </div>
            ${ch.type === 'telegram' ? html`
              <div class="form-field">
                <label>Bot Token</label>
                <input type="password" value=${ch.config?.token || ''} onInput=${e => updateChannel(i, 'config.token', e.target.value)} placeholder="123456:ABC-DEF..." />
              </div>
              <div class="form-field" style="grid-column:1/-1;">
                <label>Allowed Chat IDs (comma-separated) <span class="text-muted" style="font-size:11px;">— leave empty to allow all (insecure)</span></label>
                <input type="text" value=${(ch.config?.allowedChatIds || []).join(', ')} onInput=${e => updateChannel(i, 'config.allowedChatIds', e.target.value.split(',').map(s => s.trim()).filter(Boolean).map(Number))} placeholder="12345678, 87654321" />
              </div>
            ` : null}
            ${ch.type === 'email' ? html`
              <div class="form-field" style="grid-column:1/-1;"><strong style="font-size:0.85rem;color:var(--text-secondary);">IMAP (Incoming)</strong></div>
              <div class="form-field">
                <label>Host</label>
                <input type="text" value=${ch.config?.imap?.host || ''} onInput=${e => updateChannel(i, 'config.imap.host', e.target.value)} placeholder="imap.gmail.com" />
              </div>
              <div class="form-field">
                <label>Port</label>
                <input type="number" value=${ch.config?.imap?.port || 993} onInput=${e => updateChannel(i, 'config.imap.port', parseInt(e.target.value) || 993)} />
              </div>
              <div class="form-field">
                <label>User</label>
                <input type="text" value=${ch.config?.imap?.user || ''} onInput=${e => updateChannel(i, 'config.imap.user', e.target.value)} placeholder="user@example.com" />
              </div>
              <div class="form-field">
                <label>Password</label>
                <input type="password" value=${ch.config?.imap?.password || ''} onInput=${e => updateChannel(i, 'config.imap.password', e.target.value)} />
              </div>
              <div class="form-field">
                <label class="toggle-label">
                  <input type="checkbox" checked=${ch.config?.imap?.tls !== false} onChange=${e => updateChannel(i, 'config.imap.tls', e.target.checked)} style="width:auto;min-height:auto;" />
                  <span>TLS</span>
                </label>
              </div>
              <div class="form-field" style="grid-column:1/-1;margin-top:8px;"><strong style="font-size:0.85rem;color:var(--text-secondary);">SMTP (Outgoing)</strong></div>
              <div class="form-field">
                <label>Host</label>
                <input type="text" value=${ch.config?.smtp?.host || ''} onInput=${e => updateChannel(i, 'config.smtp.host', e.target.value)} placeholder="smtp.gmail.com" />
              </div>
              <div class="form-field">
                <label>Port</label>
                <input type="number" value=${ch.config?.smtp?.port || 587} onInput=${e => updateChannel(i, 'config.smtp.port', parseInt(e.target.value) || 587)} />
              </div>
              <div class="form-field">
                <label>User</label>
                <input type="text" value=${ch.config?.smtp?.user || ''} onInput=${e => updateChannel(i, 'config.smtp.user', e.target.value)} placeholder="user@example.com" />
              </div>
              <div class="form-field">
                <label>Password</label>
                <input type="password" value=${ch.config?.smtp?.password || ''} onInput=${e => updateChannel(i, 'config.smtp.password', e.target.value)} />
              </div>
              <div class="form-field">
                <label class="toggle-label">
                  <input type="checkbox" checked=${ch.config?.smtp?.secure !== false} onChange=${e => updateChannel(i, 'config.smtp.secure', e.target.checked)} style="width:auto;min-height:auto;" />
                  <span>Secure (TLS)</span>
                </label>
              </div>
              <div class="form-field" style="grid-column:1/-1;margin-top:8px;">
                <label>Allowed Senders (comma-separated) <span class="text-muted" style="font-size:11px;">— leave empty to allow all (insecure)</span></label>
                <input type="text" value=${(ch.config?.allowedSenders || []).join(', ')} onInput=${e => updateChannel(i, 'config.allowedSenders', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} placeholder="user@example.com, admin@corp.com" />
              </div>
            ` : null}
            ${ch.type === 'gmail' ? html`
              <div class="form-field" style="grid-column:1/-1;">
                <div class="text-muted" style="font-size:12px;margin-bottom:8px;">
                  Uses the Gmail API with OAuth2. Create credentials at
                  <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:var(--accent-cyan);">Google Cloud Console</a>
                  (Desktop app type). Enable the Gmail API first.
                </div>
              </div>
              <div class="form-field">
                <label>Client ID</label>
                <input type="text" value=${ch.config?.clientId || ''} onInput=${e => updateChannel(i, 'config.clientId', e.target.value)} placeholder="xxxx.apps.googleusercontent.com" />
              </div>
              <div class="form-field">
                <label>Client Secret</label>
                <input type="password" value=${ch.config?.clientSecret || ''} onInput=${e => updateChannel(i, 'config.clientSecret', e.target.value)} />
              </div>
              <div class="form-field" style="grid-column:1/-1;">
                <label>Refresh Token</label>
                <div class="flex gap-8">
                  <input type="password" style="flex:1;" value=${ch.config?.refreshToken || ''} onInput=${e => updateChannel(i, 'config.refreshToken', e.target.value)} placeholder="Obtained via OAuth2 flow" />
                  <${GmailOAuthButton} channelIndex=${i} channels=${channels} updateChannel=${updateChannel} />
                </div>
              </div>
              <div class="form-field">
                <label>Email (auto-detected)</label>
                <input type="text" value=${ch.config?.email || ''} onInput=${e => updateChannel(i, 'config.email', e.target.value)} placeholder="user@gmail.com" readonly style="opacity:0.7;" />
              </div>
              <div class="form-field">
                <label>Poll Interval (seconds)</label>
                <input type="number" value=${ch.config?.pollIntervalSeconds || 120} onInput=${e => updateChannel(i, 'config.pollIntervalSeconds', parseInt(e.target.value) || 120)} />
              </div>
              <div class="form-field" style="grid-column:1/-1;">
                <label>Allowed Senders (comma-separated) <span class="text-muted" style="font-size:11px;">— leave empty to allow all (insecure)</span></label>
                <input type="text" value=${(ch.config?.allowedSenders || []).join(', ')} onInput=${e => updateChannel(i, 'config.allowedSenders', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} placeholder="user@example.com, admin@corp.com" />
              </div>
            ` : null}
            ${ch.type === 'mqtt' ? html`
              <div class="form-field" style="grid-column:1/-1;">
                <div class="text-muted" style="font-size:12px;margin-bottom:8px;">
                  Connect to an MQTT broker to receive real-time events (e.g. from Home Assistant automations or IoT devices).
                  Messages published to subscribed topics will be routed to the agent as incoming messages.
                </div>
              </div>
              <div class="form-field" style="grid-column:1/-1;">
                <label>Broker URL</label>
                <input type="text" value=${ch.config?.broker_url || ''} onInput=${e => updateChannel(i, 'config.broker_url', e.target.value)} placeholder="mqtt://localhost:1883" />
              </div>
              <div class="form-field">
                <label>Username</label>
                <input type="text" value=${ch.config?.username || ''} onInput=${e => updateChannel(i, 'config.username', e.target.value)} placeholder="(optional)" />
              </div>
              <div class="form-field">
                <label>Password</label>
                <input type="password" value=${ch.config?.password || ''} onInput=${e => updateChannel(i, 'config.password', e.target.value)} placeholder="(optional)" />
              </div>
              <div class="form-field" style="grid-column:1/-1;">
                <label>Subscribe Topics (comma-separated) <span class="text-muted" style="font-size:11px;">— topics the agent will listen to</span></label>
                <input type="text" value=${(ch.config?.subscribe_topics || []).join(', ')} onInput=${e => updateChannel(i, 'config.subscribe_topics', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} placeholder="korabot/inbox, homeassistant/binary_sensor/+/state" />
              </div>
              <div class="form-field">
                <label>Response Topic <span class="text-muted" style="font-size:11px;">— where the agent publishes replies</span></label>
                <input type="text" value=${ch.config?.response_topic || ''} onInput=${e => updateChannel(i, 'config.response_topic', e.target.value)} placeholder="korabot/response" />
              </div>
              <div class="form-field">
                <label>Client ID <span class="text-muted" style="font-size:11px;">— optional</span></label>
                <input type="text" value=${ch.config?.client_id || ''} onInput=${e => updateChannel(i, 'config.client_id', e.target.value)} placeholder="korabot-mqtt" />
              </div>
            ` : null}
          </div>
        </div>
      `)}
    ` : html`
      <textarea class="code-editor w-full" value=${content} onInput=${e => setContent(e.target.value)} spellcheck=${false} />
    `}

    <div class="flex justify-between items-center mt-16">
      <button class="btn btn-secondary" onClick=${loadChannels}>↻ Reload</button>
      <button class="btn btn-primary" onClick=${handleSave} disabled=${saving}>${saving ? 'Saving…' : '💾 Save Channels'}</button>
    </div>
  `;
}

function RawConfigEditor({ endpoint, label }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api(endpoint)
      .then(data => {
        if (typeof data === 'object' && data.content !== undefined) setContent(data.content);
        else if (typeof data === 'string') setContent(data);
        else setContent(JSON.stringify(data, null, 2));
      })
      .catch(e => showToast(`Failed: ${e.message}`, 'error'))
      .finally(() => setLoading(false));
  }, [endpoint]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api(endpoint, { method: 'PUT', body: { content } });
      showToast(`${label} saved`, 'success');
      window.dispatchEvent(new Event('config-saved'));
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setSaving(false); }
  };

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;

  return html`
    <textarea class="code-editor w-full" value=${content} onInput=${e => setContent(e.target.value)} spellcheck=${false} />
    <div class="flex justify-between items-center mt-16">
      <button class="btn btn-secondary" onClick=${load}>↻ Reload</button>
      <button class="btn btn-primary" onClick=${handleSave} disabled=${saving}>${saving ? 'Saving…' : '💾 Save'}</button>
    </div>
  `;
}

function ConfigEditor() {
  const [activeTab, setActiveTab] = useState('settings');

  const renderTabContent = () => {
    switch (activeTab) {
      case 'settings': return html`<${SettingsEditor} />`;
      case 'providers': return html`<${ProvidersEditor} />`;
      case 'channels': return html`<${ChannelsEditor} />`;
      case 'agent': return html`<${RawConfigEditor} key="agent" endpoint="/config/agent" label="Agent Prompt" />`;
      case 'identity': return html`<${RawConfigEditor} key="identity" endpoint="/config/identity" label="Agent Identity" />`;
      case 'heartbeat': return html`<${RawConfigEditor} key="heartbeat" endpoint="/config/heartbeat" label="Heartbeat Prompt" />`;
      case 'kyu': return html`<${RawConfigEditor} key="kyu" endpoint="/config/kyu" label="KYU Profile" />`;
      default: return null;
    }
  };

  return html`
    <div class="page-header"><h2>Configuration</h2><p>Manage runtime settings, providers, and channels</p></div>
    <div class="tabs">
      ${CONFIG_TABS.map(t => html`<button key=${t.id} class="tab ${activeTab === t.id ? 'active' : ''}" onClick=${() => setActiveTab(t.id)}>${t.label}</button>`)}
    </div>
    ${renderTabContent()}
  `;
}

// ─── Tools & MCP ──────────────────────────────────────────────────────────────

const TOOL_CATEGORIES = [
  { key: 'scheduler', label: 'Tasks', icon: '📅', desc: 'Create and manage scheduled tasks with cron expressions' },
  { key: 'mail', label: 'Mail (Bot)', icon: '✉️', desc: 'Send emails from the bot\'s configured email account. Auto-enabled when an email channel is active.' },
  { key: 'mail_delegation', label: 'Mail Delegation', icon: '📬', desc: 'Read and manage the user\'s email accounts. Configure delegated accounts in the Mail Delegation section below.' },
  { key: 'shell', label: 'Shell', icon: '💻', desc: 'Execute system commands (requires approval unless unlimited)' },
  { key: 'browser', label: 'Browser', icon: '🌐', desc: 'Navigate web pages and extract content via headless Chrome' },
  {
    key: 'web_search', label: 'Web Search', icon: '🔍', desc: 'Search the internet for real-time information', hasConfig: true,
    configFields: [
      { key: 'web_search_engine', label: 'Engine', type: 'select', options: ['brave', 'google'], default: 'brave' },
      { key: 'web_search_api_key', label: 'API Key', type: 'password', placeholder: 'Your search API key' },
    ]
  },
  { key: 'web_fetch', label: 'Web Fetch', icon: '📥', desc: 'Fetch the contents of any URL (web pages, APIs, JSON endpoints, RSS feeds)' },
  { key: 'mcp', label: 'MCP Servers', icon: '🔌', desc: 'Connect to external MCP tool servers' },
  { key: 'settings', label: 'Settings Tool', icon: '⚙️', desc: 'Allow the agent to update its own configuration' },
  { key: 'identity', label: 'Identity / Evolve', icon: '🧬', desc: 'Allow the agent to read and evolve its own identity (IDENTITY.md)' },
  {
    key: 'homeassistant_mqtt', label: 'Home Assistant', icon: '🏠',
    desc: 'Query and control Home Assistant entities via REST API. Requires a Long-Lived Access Token from your HA instance.',
    hasConfig: true,
    configFields: [
      { key: 'ha_url', label: 'Home Assistant URL', type: 'text', placeholder: 'http://homeassistant.local:8123' },
      { key: 'ha_token', label: 'Long-Lived Access Token', type: 'password', placeholder: 'eyJhbGciOiJIUzI1NiIs...' },
    ]
  },
  {
    key: 'stt', label: 'Speech to Text', icon: '🎤',
    desc: 'Transcribe voice messages locally using Whisper (whisper.cpp). Models are downloaded on first use.',
    hasConfig: true,
    configFields: [
      { key: 'stt_model', label: 'Model Size', type: 'select', options: ['tiny', 'base', 'small'], default: 'base' },
    ]
  },
  {
    key: 'tts', label: 'Text to Speech', icon: '🔊',
    desc: 'Reply with voice messages using local Piper TTS. When enabled, voice replies are sent back for voice messages.',
    hasConfig: true,
    configFields: [
      { key: 'tts_voice', label: 'Voice', type: 'piper_voice', default: 'es_ES-davefx-medium' },
    ]
  },
];

function AdminMailIndexingStatus() {
  const [progress, setProgress] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => api('/mail-indexing').then(d => { if (Array.isArray(d)) setProgress(d); setLoading(false); });
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, []);

  if (loading || progress.length === 0) return null;

  const statusBadge = (s) => {
    const colors = { completed: 'var(--accent-green)', running: 'var(--accent-blue)', error: 'var(--text-danger)', paused: 'var(--text-muted)' };
    return html`<span class="badge" style="background:${colors[s] || '#555'};font-size:11px">${s}</span>`;
  };
  const pct = (p) => p.totalMessages > 0 ? Math.round((p.indexedCount / p.totalMessages) * 100) : 0;

  const startIndexing = async (wsId) => {
    await api('/mail-indexing/start', { method: 'POST', body: { workspaceId: wsId } });
    showToast('Indexing started', 'success');
    refresh();
  };
  const stopIndexing = async (wsId) => {
    await api('/mail-indexing/stop', { method: 'POST', body: { workspaceId: wsId } });
    showToast('Indexing stopped', 'success');
    refresh();
  };
  const resetIndexing = async (wsId, delegationId) => {
    if (!confirm('Reset indexing? This will delete all indexed emails and restart from scratch.')) return;
    await api('/mail-indexing/reset', { method: 'POST', body: { workspaceId: wsId, delegationId } });
    showToast('Indexing reset initiated', 'success');
    setTimeout(refresh, 1500);
  };

  return html`
    <div class="card mb-16" style="border-left:3px solid var(--accent-blue)">
      <h3 style="margin:0 0 8px">🔍 Email Indexing</h3>
      <p class="text-sm text-muted mb-12">Background indexing of delegated emails into the knowledge base for contextual search.</p>
      ${progress.map(p => html`
        <div class="card mb-8" key=${p.delegationId} style="padding:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div>
              <span style="font-weight:600">${p.accountEmail}</span>
              <span class="text-sm text-muted" style="margin-left:8px">ws:${p.workspaceId?.slice(0, 8)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              ${statusBadge(p.status)}
              ${p.status === 'running'
      ? html`<button class="btn btn-sm" onClick=${() => stopIndexing(p.workspaceId)}>⏸ Pause</button>`
      : html`<button class="btn btn-sm btn-primary" onClick=${() => startIndexing(p.workspaceId)}>▶ Start</button>`}
              <button class="btn btn-sm" style="color:var(--text-danger)" onClick=${() => resetIndexing(p.workspaceId, p.delegationId)}>🔄 Reset</button>
            </div>
          </div>
          <div style="width:100%;height:6px;background:var(--bg-secondary);border-radius:3px;overflow:hidden;margin-bottom:4px">
            <div style="width:${pct(p)}%;height:100%;background:var(--accent-blue);transition:width 0.5s"></div>
          </div>
          <div class="text-sm text-muted" style="display:flex;justify-content:space-between">
            <span>${p.indexedCount} / ${p.totalMessages} indexed${p.skippedSensitive ? `, ${p.skippedSensitive} sensitive skipped` : ''}</span>
            <span>${pct(p)}%</span>
          </div>
          ${p.error && html`<div class="text-sm" style="color:var(--text-danger);margin-top:4px">${p.error}</div>`}
        </div>
      `)}
    </div>
  `;
}

function MailDelegationPanel() {
  const [delegations, setDelegations] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [globalConfig, setGlobalConfig] = useState({});
  const [form, setForm] = useState({ provider: 'gmail', email: '', workspaceId: '', read: true, send: false, autoCheckMinutes: 0 });
  const [imapForm, setImapForm] = useState({ imapHost: '', imapPort: '993', imapUser: '', imapPass: '', imapTls: true, smtpHost: '', smtpPort: '465', smtpUser: '', smtpPass: '', smtpSecure: true });
  const [oauthStep, setOauthStep] = useState(null);
  const [oauthCode, setOauthCode] = useState('');

  const load = useCallback(() => {
    Promise.all([
      api('/mail-delegations'),
      api('/config/settings').then(s => s.mail_delegation || {}),
      api('/workspaces').catch(() => []),
    ]).then(([d, gc, ws]) => {
      setDelegations(Array.isArray(d) ? d : []);
      setGlobalConfig(gc);
      setWorkspaces(Array.isArray(ws) ? ws : []);
    }).catch(e => showToast(e.message, 'error')).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveGlobalConfig = async () => {
    try {
      await api('/config/settings', { method: 'PUT', body: { mail_delegation: globalConfig } });
      showToast('Global OAuth credentials saved', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  };

  const startOAuth = async () => {
    try {
      const r = await api('/mail-delegations/oauth-url', { method: 'POST' });
      if (r.ok) { setOauthStep({ url: r.url }); window.open(r.url, '_blank'); }
      else showToast(r.error, 'error');
    } catch (e) { showToast(e.message, 'error'); }
  };

  const exchangeOAuth = async () => {
    try {
      const r = await api('/mail-delegations/oauth-exchange', { method: 'POST', body: { code: oauthCode } });
      if (r.ok) {
        setForm(f => ({ ...f, email: r.email }));
        setOauthStep({ ...oauthStep, refreshToken: r.refreshToken, email: r.email, done: true });
        showToast(`Authenticated as ${r.email}`, 'success');
      } else showToast(r.error, 'error');
    } catch (e) { showToast(e.message, 'error'); }
  };

  const addDelegation = async () => {
    try {
      const wsId = form.workspaceId || (workspaces.find(w => w.isDefault) || workspaces[0])?.id || 'default';
      let credentials = {};
      if (form.provider === 'gmail') {
        if (!oauthStep?.refreshToken) { showToast('Complete OAuth flow first', 'error'); return; }
        credentials = { refreshToken: oauthStep.refreshToken };
      } else {
        credentials = {
          imap: { host: imapForm.imapHost, port: parseInt(imapForm.imapPort), user: imapForm.imapUser, password: imapForm.imapPass, tls: imapForm.imapTls },
          smtp: { host: imapForm.smtpHost, port: parseInt(imapForm.smtpPort), user: imapForm.smtpUser, password: imapForm.smtpPass, secure: imapForm.smtpSecure },
        };
      }
      const r = await api('/mail-delegations', {
        method: 'POST',
        body: { workspaceId: wsId, provider: form.provider, email: form.email, credentials, permissions: { read: form.read, send: form.send }, autoCheckMinutes: form.autoCheckMinutes },
      });
      if (r.ok) {
        showToast('Delegation added', 'success');
        setAdding(false);
        setOauthStep(null);
        setOauthCode('');
        setForm({ provider: 'gmail', email: '', workspaceId: '', read: true, send: false, autoCheckMinutes: 0 });
        load();
      } else showToast(r.error, 'error');
    } catch (e) { showToast(e.message, 'error'); }
  };

  const removeDelegation = async (id) => {
    if (!confirm('Remove this delegated account?')) return;
    try {
      await api(`/mail-delegations/${id}`, { method: 'DELETE' });
      showToast('Delegation removed', 'success');
      load();
    } catch (e) { showToast(e.message, 'error'); }
  };

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;

  return html`
    <div>
      <div class="card mb-16" style="border-left:3px solid var(--accent-purple);">
        <h3 style="margin:0 0 8px 0;">🔑 Global Google OAuth2 Credentials</h3>
        <p class="text-sm text-muted mb-12">Required for Gmail delegation. These are your Google Cloud app credentials shared across all users.</p>
        <div class="form-group mb-8">
          <label class="form-label">Client ID</label>
          <input class="form-input" type="text" placeholder="xxxxx.apps.googleusercontent.com"
            value=${globalConfig.google_client_id || ''} onInput=${e => setGlobalConfig(g => ({ ...g, google_client_id: e.target.value }))} />
        </div>
        <div class="form-group mb-8">
          <label class="form-label">Client Secret</label>
          <input class="form-input" type="password" placeholder="GOCSPX-..."
            value=${globalConfig.google_client_secret || ''} onInput=${e => setGlobalConfig(g => ({ ...g, google_client_secret: e.target.value }))} />
        </div>
        <button class="btn btn-sm" onClick=${saveGlobalConfig}>Save OAuth Credentials</button>
      </div>

      <${AdminMailIndexingStatus} />

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;">Delegated Accounts</h3>
        <button class="btn btn-sm btn-primary" onClick=${() => setAdding(true)}>+ Add Account</button>
      </div>

      ${delegations.length === 0 ? html`
        <div class="card text-center text-muted" style="padding:32px;">
          <p>No delegated email accounts configured.</p>
          <p class="text-sm">Add an account to let the agent read and manage a user's email.</p>
        </div>
      ` : html`
        <div class="card-list">
          ${delegations.map(d => html`
            <div class="card mb-8" key=${d.id}>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                  <div style="font-weight:600;">📬 ${d.email}</div>
                  <div class="text-sm text-muted">
                    ${d.provider === 'gmail' ? 'Gmail API' : 'IMAP/SMTP'} ·
                    ${d.permissions?.read ? '📖 Read' : ''} ${d.permissions?.send ? '✍️ Send' : ''} ·
                    Auto-check: ${d.autoCheckMinutes > 0 ? `every ${d.autoCheckMinutes}min` : 'disabled'} ·
                    Workspace: ${d.workspaceId?.slice(0, 8)}
                  </div>
                </div>
                <button class="btn btn-sm" style="color:var(--text-danger);" onClick=${() => removeDelegation(d.id)}>🗑</button>
              </div>
            </div>
      `)}
    </div>
      `}

      ${adding ? html`
        <div class="card mt-16" style="border-left:3px solid var(--accent-blue);">
          <h3 style="margin:0 0 12px 0;">Add Delegated Account</h3>

          <div class="form-group mb-8">
            <label class="form-label">Provider</label>
            <select class="form-input" value=${form.provider} onChange=${e => { setForm(f => ({ ...f, provider: e.target.value, email: '' })); setOauthStep(null); }}>
              <option value="gmail">Gmail (OAuth2)</option>
              <option value="imap">IMAP/SMTP</option>
            </select>
          </div>

          ${workspaces.length > 1 ? html`
            <div class="form-group mb-8">
              <label class="form-label">Workspace</label>
              <select class="form-input" value=${form.workspaceId} onChange=${e => setForm(f => ({ ...f, workspaceId: e.target.value }))}>
                <option value="">Default</option>
                ${workspaces.map(w => html`<option key=${w.id} value=${w.id}>${w.displayName || w.name} ${w.isDefault ? '(default)' : ''}</option>`)}
              </select>
            </div>
          ` : ''}

          ${form.provider === 'gmail' ? html`
            ${!oauthStep ? html`
              <button class="btn btn-sm btn-primary mb-8" onClick=${startOAuth}>🔗 Authorize Gmail Account</button>
              <p class="text-sm text-muted">This will open Google's consent screen. The user logs in with THEIR Gmail account.</p>
            ` : !oauthStep.done ? html`
              <p class="text-sm mb-8">Paste the authorization code from Google:</p>
              <div style="display:flex;gap:8px;">
                <input class="form-input" placeholder="Authorization code" value=${oauthCode} onInput=${e => setOauthCode(e.target.value)} />
                <button class="btn btn-sm btn-primary" onClick=${exchangeOAuth}>Verify</button>
              </div>
    ` : html`
              <div class="text-sm" style="color:var(--accent-green);margin-bottom:8px;">✅ Authenticated as ${oauthStep.email}</div>
            `}
          ` : html`
            <div class="form-group mb-8">
              <label class="form-label">Email Address</label>
              <input class="form-input" type="email" placeholder="user@example.com" value=${form.email} onInput=${e => setForm(f => ({ ...f, email: e.target.value }))} />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div>
                <h4 style="margin:8px 0 4px;">IMAP</h4>
                <input class="form-input mb-4" placeholder="Host" value=${imapForm.imapHost} onInput=${e => setImapForm(f => ({ ...f, imapHost: e.target.value }))} />
                <input class="form-input mb-4" placeholder="Port" value=${imapForm.imapPort} onInput=${e => setImapForm(f => ({ ...f, imapPort: e.target.value }))} />
                <input class="form-input mb-4" placeholder="User" value=${imapForm.imapUser} onInput=${e => setImapForm(f => ({ ...f, imapUser: e.target.value }))} />
                <input class="form-input mb-4" type="password" placeholder="Password" value=${imapForm.imapPass} onInput=${e => setImapForm(f => ({ ...f, imapPass: e.target.value }))} />
              </div>
              <div>
                <h4 style="margin:8px 0 4px;">SMTP</h4>
                <input class="form-input mb-4" placeholder="Host" value=${imapForm.smtpHost} onInput=${e => setImapForm(f => ({ ...f, smtpHost: e.target.value }))} />
                <input class="form-input mb-4" placeholder="Port" value=${imapForm.smtpPort} onInput=${e => setImapForm(f => ({ ...f, smtpPort: e.target.value }))} />
                <input class="form-input mb-4" placeholder="User" value=${imapForm.smtpUser} onInput=${e => setImapForm(f => ({ ...f, smtpUser: e.target.value }))} />
                <input class="form-input mb-4" type="password" placeholder="Password" value=${imapForm.smtpPass} onInput=${e => setImapForm(f => ({ ...f, smtpPass: e.target.value }))} />
              </div>
            </div>
          `}

          <div style="display:flex;gap:16px;align-items:center;margin-top:12px;">
            <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" checked=${form.read} onChange=${e => setForm(f => ({ ...f, read: e.target.checked }))} /> 📖 Read</label>
            <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" checked=${form.send} onChange=${e => setForm(f => ({ ...f, send: e.target.checked }))} /> ✍️ Send</label>
            <div style="display:flex;align-items:center;gap:4px;">
              <label class="text-sm">Auto-check (min):</label>
              <input class="form-input" type="number" min="0" style="width:70px;" value=${form.autoCheckMinutes} onInput=${e => setForm(f => ({ ...f, autoCheckMinutes: parseInt(e.target.value) || 0 }))} />
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:12px;">
            <button class="btn btn-sm btn-primary" onClick=${addDelegation}>Save</button>
            <button class="btn btn-sm" onClick=${() => { setAdding(false); setOauthStep(null); }}>Cancel</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function ToolsAndMcp() {
  const [toolSettings, setToolSettings] = useState({});
  const [mcpServers, setMcpServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMcp, setLoadingMcp] = useState(true);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installForm, setInstallForm] = useState({ source: '', transport: 'stdio', args: '', env: '', url: '', command: '', commandName: '' });
  const [activeTab, setActiveTab] = useState('builtin');
  const [piperVoices, setPiperVoices] = useState(null);
  const [piperLangs, setPiperLangs] = useState([]);
  const [selectedTtsLang, setSelectedTtsLang] = useState('');

  const loadToolSettings = useCallback(() => {
    api('/tools/settings')
      .then(data => { setToolSettings(data || {}); })
      .catch(e => showToast(`Failed to load: ${e.message}`, 'error'))
      .finally(() => setLoading(false));
  }, []);

  const loadMcp = useCallback(() => {
    api('/mcp/servers')
      .then(data => setMcpServers(Array.isArray(data) ? data : data.servers || []))
      .catch(e => showToast(`Failed to load MCP: ${e.message}`, 'error'))
      .finally(() => setLoadingMcp(false));
  }, []);

  useEffect(() => { loadToolSettings(); loadMcp(); }, [loadToolSettings, loadMcp]);

  useEffect(() => {
    api('/piper-voices').then(data => {
      if (data && !data.error) {
        setPiperVoices(data);
        const langMap = {};
        for (const [key, v] of Object.entries(data)) {
          const code = v.language.code;
          if (!langMap[code]) langMap[code] = { code, label: `${v.language.name_english} (${v.language.country_english})`, voices: [] };
          langMap[code].voices.push({ key, name: v.key || key, quality: v.quality || key.split('-').pop(), num_speakers: v.num_speakers || 1 });
        }
        const sorted = Object.values(langMap).sort((a, b) => a.label.localeCompare(b.label));
        sorted.forEach(l => l.voices.sort((a, b) => a.key.localeCompare(b.key)));
        setPiperLangs(sorted);
      }
    }).catch(() => { });
  }, []);

  const toggleTool = async (key, currentValue) => {
    const newVal = !currentValue;
    const updated = { ...toolSettings, [key]: newVal };
    setToolSettings(updated);
    setSaving(true);
    try {
      await api('/tools/settings', { method: 'PUT', body: { [key]: newVal } });
      showToast(`${key} ${newVal ? 'enabled' : 'disabled'}`, 'success');
      window.dispatchEvent(new Event('config-saved'));
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setSaving(false); }
  };

  const updateConfig = async (key, value) => {
    const updated = { ...toolSettings, [key]: value };
    setToolSettings(updated);
    try {
      await api('/tools/settings', { method: 'PUT', body: { [key]: value } });
      showToast('Saved', 'success');
      window.dispatchEvent(new Event('config-saved'));
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  const handleInstall = async () => {
    const isCmd = installForm.transport === 'command';
    const isSseMode = installForm.transport === 'sse';
    if (!isCmd && !installForm.source.trim() && !installForm.url.trim()) return;
    if (isCmd && !installForm.command.trim()) return;
    setInstalling(true);
    try {
      const payload = { transport: isCmd ? 'stdio' : installForm.transport };
      if (isCmd) {
        payload.command = installForm.command.trim();
        if (installForm.args.trim()) payload.args = installForm.args.split(/\s+/).filter(Boolean);
        if (installForm.commandName.trim()) payload.name = installForm.commandName.trim();
        payload.source = payload.name || payload.command;
      } else {
        payload.source = installForm.source.trim() || installForm.url.trim();
        if (installForm.args.trim()) payload.args = installForm.args.split(/\s+/).filter(Boolean);
        if (isSseMode && installForm.url.trim()) payload.url = installForm.url.trim();
      }
      if (installForm.env.trim()) {
        const env = {};
        installForm.env.split('\n').filter(Boolean).forEach(line => {
          const [k, ...v] = line.split('=');
          if (k) env[k.trim()] = v.join('=').trim();
        });
        payload.env = env;
      }
      await api('/mcp/install', { method: 'POST', body: payload });
      showToast('MCP server installed', 'success');
      setInstallForm({ source: '', transport: 'stdio', args: '', env: '', url: '', command: '', commandName: '' });
      loadMcp();
    } catch (e) { showToast(`Install failed: ${e.message}`, 'error'); }
    finally { setInstalling(false); }
  };

  const handleRemove = async (id) => {
    if (!confirm(`Remove MCP server "${id}"?`)) return;
    try {
      await api(`/mcp/${id}`, { method: 'DELETE' });
      showToast('Removed', 'success');
      setMcpServers(prev => prev.filter(s => (s.id || s.name) !== id));
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  const handleReconnect = async (id) => {
    try {
      const r = await api(`/mcp/${id}/reconnect`, { method: 'POST' });
      showToast(r.ok ? `Reconnected (${(r.tools || []).length} tools)` : `Failed: ${r.error}`, r.ok ? 'success' : 'error');
      loadMcp();
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  const isSse = installForm.transport === 'sse';
  const isCommand = installForm.transport === 'command';

  const renderBuiltinTools = () => html`
    <div class="card-list">
      ${TOOL_CATEGORIES.filter(cat => !(__multiUserEnabled && cat.key === 'mail_delegation')).map(cat => {
    const isOn = cat.key === 'scheduler' || cat.key === 'browser' || cat.key === 'mcp'
      ? toolSettings[cat.key] !== false
      : toolSettings[cat.key] === true;
    return html`
          <div class="card mb-12" key=${cat.key}>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
              <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1;">
                <span style="font-size:22px;flex-shrink:0;">${cat.icon}</span>
                <div style="min-width:0;">
                  <div style="font-weight:600;font-size:14px;">${cat.label}</div>
                  <div class="text-sm text-muted" style="word-break:break-word;">${cat.desc}</div>
    </div>
              </div>
              <label class="pill-switch">
                <input type="checkbox" checked=${isOn} onChange=${() => toggleTool(cat.key, isOn)} />
                <span class="pill-slider"></span>
              </label>
            </div>
            ${cat.hasConfig && isOn && cat.configFields ? html`
              <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color);">
                ${cat.configFields.map(f => {
      if (f.type === 'piper_voice') {
        const currentVoice = toolSettings[f.key] || f.default || '';
        const currentLangCode = currentVoice.match(/^[a-z]{2}_[A-Z]{2}/)?.[0] || '';
        const effectiveLang = selectedTtsLang || currentLangCode;
        const langEntry = piperLangs.find(l => l.code === effectiveLang);
        const voicesForLang = langEntry ? langEntry.voices : [];
        const selectStyle = 'flex:1;padding:6px 8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;';
        return html`
                      <div key=${f.key} style="display:flex;flex-direction:column;gap:8px;">
                        <div class="flex items-center gap-8">
                          <label style="min-width:80px;font-size:13px;color:var(--text-secondary);">Language</label>
                          ${piperLangs.length ? html`
                            <select value=${effectiveLang} onChange=${(e) => { setSelectedTtsLang(e.target.value); }}
                              style=${selectStyle}>
                              ${piperLangs.map(l => html`<option key=${l.code} value=${l.code}>${l.label}</option>`)}
                            </select>
                          ` : html`<span class="text-sm text-muted">Loading voices...</span>`}
                        </div>
                        <div class="flex items-center gap-8">
                          <label style="min-width:80px;font-size:13px;color:var(--text-secondary);">${f.label}</label>
                          ${voicesForLang.length ? html`
                            <select value=${currentVoice} onChange=${(e) => updateConfig(f.key, e.target.value)}
                              style=${selectStyle}>
                              ${voicesForLang.map(v => html`<option key=${v.key} value=${v.key}>${v.key} (${v.quality}${v.num_speakers > 1 ? `, ${v.num_speakers} spk` : ''})</option>`)}
                            </select>
                          ` : html`
                            <input type="text" value=${currentVoice} placeholder="e.g. es_ES-davefx-medium"
                              onBlur=${(e) => updateConfig(f.key, e.target.value)}
                              style=${selectStyle} />
                          `}
                        </div>
                      </div>
                    `;
      }
      return html`
                  <div class="flex items-center gap-8 mb-8" key=${f.key}>
                    <label style="min-width:80px;font-size:13px;color:var(--text-secondary);">${f.label}</label>
                    ${f.type === 'select' ? html`
                      <select value=${toolSettings[f.key] || f.default || ''} onChange=${(e) => updateConfig(f.key, e.target.value)}
                        style="flex:1;padding:6px 8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;">
                        ${(f.options || []).map(o => html`<option key=${o} value=${o}>${o}</option>`)}
                      </select>
                    ` : html`
                      <input type=${f.type || 'text'} placeholder=${f.placeholder || ''} value=${toolSettings[f.key] || ''}
                        onBlur=${(e) => updateConfig(f.key, e.target.value)}
                        style="flex:1;padding:6px 8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;" />
                    `}
                  </div>
                `;
    })}
              </div>
            ` : null}
          </div>
        `;
  })}
    </div>
    <p class="text-sm text-muted mt-16">Changes are applied after reloading settings from the Configuration page.</p>
  `;

  const renderMcpServers = () => html`
    <div class="card-list mb-16">
      ${loadingMcp ? html`<div class="loading-center"><div class="spinner" /></div>` :
      mcpServers.length === 0 ? html`<div class="empty-state" style="padding:24px;"><div class="empty-state-icon">🔌</div><p>No MCP servers installed</p></div>` :
        mcpServers.map(s => html`
          <div class="card mb-12" key=${s.id || s.name}>
            <div class="flex justify-between items-center mb-8">
      <div>
                <div style="font-weight:600;font-size:14px;">${s.name || s.id}</div>
                <div class="text-sm text-muted">${s.source || s.url || ''}</div>
              </div>
              <div class="flex gap-8 items-center">
                <span class="badge badge-blue">${s.transport || 'stdio'}</span>
                ${s.tools?.length ? html`<span class="badge badge-purple">${s.tools.length} tool${s.tools.length !== 1 ? 's' : ''}</span>` : null}
                <span class="badge ${s.connected ? 'badge-green' : s.enabled ? 'badge-yellow' : 'badge-red'}">${s.connected ? 'connected' : s.enabled ? 'disconnected' : 'off'}</span>
              </div>
            </div>
            ${s.userArgs?.length ? html`<div class="text-sm text-muted mb-8">Args: <code>${s.userArgs.join(' ')}</code></div>` : null}
            ${s.tools?.length ? html`
              <details style="margin-bottom:8px;">
                <summary class="text-sm" style="cursor:pointer;color:var(--text-secondary);user-select:none;">Show tools</summary>
                <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">
                  ${s.tools.map(t => html`<code style="font-size:11px;padding:2px 6px;background:var(--bg-tertiary);border-radius:4px;">${t}</code>`)}
                </div>
              </details>
            ` : s.enabled && !s.connected ? html`<div class="text-sm text-muted mb-8" style="color:var(--warning);">Not connected — try reconnecting</div>` : null}
            <div class="flex gap-8">
              <button class="btn btn-secondary btn-sm" onClick=${() => handleReconnect(s.id)}>↻ Reconnect</button>
              <button class="btn btn-danger btn-sm" onClick=${() => handleRemove(s.id || s.name)}>✕ Remove</button>
            </div>
          </div>
        `)
    }
    </div>
        <div class="card">
      <div style="font-weight:600;font-size:14px;margin-bottom:12px;">Install MCP Server</div>
      <div class="flex gap-12 mb-12" style="flex-wrap:wrap;">
        <label class="flex items-center gap-8" style="cursor:pointer;font-size:13px;">
          <input type="radio" name="transport" value="stdio" checked=${!isSse && !isCommand}
            onChange=${() => setInstallForm(f => ({ ...f, transport: 'stdio' }))} /> npm Package
        </label>
        <label class="flex items-center gap-8" style="cursor:pointer;font-size:13px;">
          <input type="radio" name="transport" value="command" checked=${isCommand}
            onChange=${() => setInstallForm(f => ({ ...f, transport: 'command' }))} /> Custom Command
        </label>
        <label class="flex items-center gap-8" style="cursor:pointer;font-size:13px;">
          <input type="radio" name="transport" value="sse" checked=${isSse}
            onChange=${() => setInstallForm(f => ({ ...f, transport: 'sse' }))} /> Remote (SSE)
        </label>
      </div>
      <div class="flex-col gap-8">
        ${isCommand ? html`
          <input type="text" placeholder="Command (e.g. uvx, docker, python)"
            value=${installForm.command} onInput=${(e) => setInstallForm(f => ({ ...f, command: e.target.value }))} />
          <input type="text" placeholder="Arguments (space-separated, e.g. minimax-coding-plan-mcp)"
            value=${installForm.args} onInput=${(e) => setInstallForm(f => ({ ...f, args: e.target.value }))} />
          <input type="text" placeholder="Display name (optional)"
            value=${installForm.commandName} onInput=${(e) => setInstallForm(f => ({ ...f, commandName: e.target.value }))} />
        ` : isSse ? html`
          <input type="text" placeholder="http://host:port/sse"
            value=${installForm.url} onInput=${(e) => setInstallForm(f => ({ ...f, url: e.target.value, source: e.target.value }))} />
        ` : html`
          <input type="text" placeholder="npm package or local path"
            value=${installForm.source} onInput=${(e) => setInstallForm(f => ({ ...f, source: e.target.value }))} />
          <input type="text" placeholder="Arguments (space-separated, e.g. /path/to/dir --read-only)"
            value=${installForm.args} onInput=${(e) => setInstallForm(f => ({ ...f, args: e.target.value }))} />
        `}
        <textarea rows="2" placeholder="Environment (KEY=VALUE per line)" style="font-family:var(--font-mono);font-size:12px;"
          value=${installForm.env} onInput=${(e) => setInstallForm(f => ({ ...f, env: e.target.value }))} />
        <button class="btn btn-primary w-full" onClick=${handleInstall} disabled=${installing || (isCommand ? !installForm.command.trim() : !(installForm.source.trim() || installForm.url.trim()))}>
          ${installing ? 'Installing…' : '+ Install Server'}
        </button>
      </div>
    </div>
  `;

  const [skills, setSkills] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [skillName, setSkillName] = useState('');
  const [skillError, setSkillError] = useState('');
  const [skillSuccess, setSkillSuccess] = useState('');
  const fileRef = useRef(null);

  const loadSkills = useCallback(() => {
    api('/skills')
      .then(data => { setSkills(Array.isArray(data) ? data : []); })
      .catch(() => { })
      .finally(() => setLoadingSkills(false));
  }, []);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const handleSkillUpload = useCallback(async (e) => {
    e.preventDefault();
    setSkillError(''); setSkillSuccess('');
    const name = skillName.trim();
    if (!name) { setSkillError('Skill name is required'); return; }
    const file = fileRef.current?.files?.[0];
    if (!file) { setSkillError('Please select a zip file'); return; }
    if (!file.name.endsWith('.zip')) { setSkillError('File must be a .zip archive'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('name', name);
      fd.append('file', file);
      const res = await fetch('/admin/api/skills/upload', { method: 'POST', body: fd, credentials: 'include' });
      const data = await res.json();
      if (!res.ok || data.error) { setSkillError(data.error || 'Upload failed'); }
      else {
        setSkillSuccess(`Skill "${data.name}" installed successfully`);
        setSkillName(''); if (fileRef.current) fileRef.current.value = '';
        setShowUpload(false); loadSkills();
      }
    } catch (err) { setSkillError(err.message); }
    setUploading(false);
  }, [skillName, loadSkills]);

  const handleSkillDelete = useCallback(async (name) => {
    if (!confirm(`Delete skill "${name}"? This cannot be undone.`)) return;
    try {
      await api(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      showToast(`Skill "${name}" deleted`, 'success'); loadSkills();
    } catch (err) { showToast(`Delete failed: ${err.message}`, 'error'); }
  }, [loadSkills]);

  const renderSkills = () => html`
    <div style="margin-bottom:16px;display:flex;justify-content:flex-end;">
      <button class="btn btn-primary btn-sm" onClick=${() => setShowUpload(!showUpload)}>
        ${showUpload ? 'Cancel' : '+ Install Skill'}
      </button>
    </div>
    ${skillError ? html`<div class="card mb-12" style="padding:12px;background:rgba(248,81,73,.12);border-color:var(--danger);color:var(--danger);">${skillError}</div>` : null}
    ${skillSuccess ? html`<div class="card mb-12" style="padding:12px;background:rgba(63,185,80,.12);border-color:var(--accent-green);color:var(--accent-green);">${skillSuccess}</div>` : null}
    ${showUpload ? html`
      <div class="card mb-16">
        <div style="font-weight:600;font-size:14px;margin-bottom:12px;">Install Skill from Zip</div>
        <p class="text-sm text-muted mb-12">
          Upload a zip file containing a <code>SKILL.md</code> and optionally scripts/, references/, and assets/ directories.
        </p>
        <form onSubmit=${handleSkillUpload}>
          <div class="flex-col gap-8">
            <input type="text" value=${skillName} onInput=${e => setSkillName(e.target.value)} placeholder="Skill name (e.g. web-scraper)" required />
            <input type="file" accept=".zip" ref=${fileRef} required style="font-size:13px;" />
            <button type="submit" class="btn btn-primary" disabled=${uploading}>
              ${uploading ? 'Uploading…' : 'Upload & Install'}
            </button>
          </div>
        </form>
      </div>
    ` : null}
    ${loadingSkills ? html`<div class="loading-center"><div class="spinner" /></div>` :
      skills.length === 0 ? html`<div class="empty-state" style="padding:24px;"><div class="empty-state-icon">🧩</div><p>No skills installed</p></div>` :
        html`
        <div class="card-list">
          ${skills.map(s => html`
            <div class="card mb-12" key=${s.name}>
              <div class="flex justify-between items-center mb-8">
                <div>
                  <div style="font-weight:600;font-size:14px;">${s.emoji ? s.emoji + ' ' : ''}${s.name}</div>
                  <div class="text-sm text-muted">${s.description || 'No description'}</div>
                </div>
                ${s.version ? html`<span class="badge badge-blue">v${s.version}</span>` : null}
              </div>
              ${s.author ? html`<div class="text-sm text-muted mb-8">Author: ${s.author}</div>` : null}
              ${s.homepage ? html`<div class="text-sm text-muted mb-8"><a href=${s.homepage} target="_blank" rel="noopener">${s.homepage}</a></div>` : null}
              <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">
                ${s.hasInstructions ? html`<span class="badge badge-green">Has Instructions</span>` : null}
                ${s.requires?.bins?.length ? html`<span class="badge badge-yellow">bins: ${s.requires.bins.join(', ')}</span>` : null}
                ${s.requires?.env?.length ? html`<span class="badge badge-yellow">env: ${s.requires.env.join(', ')}</span>` : null}
              </div>
              <div class="flex justify-end">
                <button class="btn btn-danger btn-sm" onClick=${() => handleSkillDelete(s.name)}>✕ Delete</button>
              </div>
            </div>
          `)}
        </div>
      `
    }
  `;

  return html`
    <div class="page-header"><h2>Tools & MCP</h2><p>Enable, disable, and configure tools</p></div>
    <div class="tabs mb-16">
      <button class="tab ${activeTab === 'builtin' ? 'active' : ''}" onClick=${() => setActiveTab('builtin')}>Built-in Tools</button>
      <button class="tab ${activeTab === 'mcp' ? 'active' : ''}" onClick=${() => setActiveTab('mcp')}>MCP Servers (${mcpServers.length})</button>
      <button class="tab ${activeTab === 'skills' ? 'active' : ''}" onClick=${() => setActiveTab('skills')}>Skills (${skills.length})</button>
      ${!__multiUserEnabled ? html`<button class="tab ${activeTab === 'delegation' ? 'active' : ''}" onClick=${() => setActiveTab('delegation')}>📬 Mail Delegation</button>` : null}
    </div>
    ${loading ? html`<div class="loading-center"><div class="spinner" /></div>` :
      activeTab === 'builtin' ? renderBuiltinTools() :
        activeTab === 'mcp' ? renderMcpServers() :
          activeTab === 'skills' ? renderSkills() :
            activeTab === 'delegation' ? html`<${MailDelegationPanel} />` :
              renderSkills()
    }
  `;
}

// ─── Tasks Management ────────────────────────────────────────────────────────

function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    api('/tasks')
      .then(data => { setTasks(Array.isArray(data) ? data : []); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete task "${name}"?`)) return;
    try {
      await api(`/tasks/${id}`, { method: 'DELETE' });
      showToast('Task deleted', 'success');
      load();
    } catch (e) { showToast(`Delete failed: ${e.message}`, 'error'); }
  };

  const handleToggle = async (id, enabled) => {
    try {
      await api(`/tasks/${id}`, { method: 'PUT', body: { enabled: !enabled } });
      showToast(enabled ? 'Task paused' : 'Task resumed', 'success');
      load();
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  const [runningTaskId, setRunningTaskId] = useState(null);
  const handleRunNow = async (id) => {
    setRunningTaskId(id);
    try {
      await api(`/tasks/${id}/run`, { method: 'POST' });
      showToast('Task triggered successfully! Check Sessions for progress.', 'success');
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setTimeout(() => setRunningTaskId(null), 3000); }
  };

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;
  if (error && tasks.length === 0) return html`<div class="error-card">Failed to load tasks: ${error}</div>`;

  return html`
    <div class="page-header flex justify-between items-center">
      <div><h2>Scheduled Tasks</h2><p>${tasks.length} task(s) configured</p></div>
      <div class="flex gap-8">
        <button class="btn btn-secondary btn-sm" onClick=${load}>↻ Refresh</button>
        <button class="btn btn-primary btn-sm" onClick=${() => { setShowCreate(true); setEditingTask(null); }}>+ New Task</button>
      </div>
    </div>

    ${(showCreate || editingTask) && html`
      <${TaskForm}
        task=${editingTask}
        onSave=${() => { setShowCreate(false); setEditingTask(null); load(); }}
        onCancel=${() => { setShowCreate(false); setEditingTask(null); }}
      />
    `}

    ${tasks.length === 0 && !showCreate ? html`
              <div class="empty-state">
        <div class="empty-state-icon">📅</div>
        <p>No scheduled tasks yet</p>
        <button class="btn btn-primary mt-16" onClick=${() => setShowCreate(true)}>Create Task</button>
              </div>
    ` : html`
      <div class="task-list">
        ${tasks.map(t => html`
          <div key=${t.id} class="card mb-16" style="border-left:3px solid ${t.enabled ? 'var(--accent-green)' : 'var(--border-color)'};">
            <div class="flex justify-between items-center mb-8">
              <div class="flex items-center gap-8">
                <span style="font-size:18px;">${t.enabled ? '🟢' : '⏸'}</span>
                <div>
                  <h3 style="font-size:16px;font-weight:600;margin:0;">${t.name}</h3>
                  <span class="text-mono text-sm text-muted">${t.id}</span>
                </div>
              </div>
              <div class="flex gap-8">
                <button class="btn btn-secondary btn-sm" onClick=${() => handleToggle(t.id, t.enabled)}>
                  ${t.enabled ? '⏸ Pause' : '▶ Resume'}
                </button>
                <button class="btn btn-secondary btn-sm" onClick=${() => handleRunNow(t.id)} disabled=${runningTaskId === t.id}>${runningTaskId === t.id ? '⏳ Running...' : '🚀 Run'}</button>
                <button class="btn btn-secondary btn-sm" onClick=${() => { setEditingTask(t); setShowCreate(false); }}>✏ Edit</button>
                <button class="btn btn-danger btn-sm" onClick=${() => handleDelete(t.id, t.name)}>🗑</button>
              </div>
            </div>
            <div class="entry-meta-grid">
              <div class="entry-meta-item"><span class="entry-meta-label">Schedule</span><span class="entry-meta-value">${cronToHumanJs(t.cronExpression)} <span class="text-muted">(${t.cronExpression})</span></span></div>
              <div class="entry-meta-item"><span class="entry-meta-label">Status</span><span class="entry-meta-value badge ${t.enabled ? 'badge-green' : 'badge-yellow'}">${t.enabled ? 'Active' : 'Paused'}</span></div>
              ${t.lastRun ? html`<div class="entry-meta-item"><span class="entry-meta-label">Last Run</span><span class="entry-meta-value">${relativeTime(t.lastRun)}</span></div>` : null}
              ${t.createdAt ? html`<div class="entry-meta-item"><span class="entry-meta-label">Created</span><span class="entry-meta-value">${formatTime(t.createdAt)}</span></div>` : null}
            </div>
            ${t.prompt ? html`<div class="mt-8" style="background:var(--bg-primary);border-radius:var(--radius-md);padding:10px 12px;font-size:13px;color:var(--text-secondary);white-space:pre-wrap;">${t.prompt}</div>` : null}
              </div>
            `)}
        </div>
    `}
  `;
}

function cronToHumanJs(expr) {
  if (!expr) return '';
  const p = expr.trim().split(/\s+/);
  if (p.length < 5) return expr;
  const [min, hour, dom, mon, dow] = p;
  const pad = s => String(s).padStart(2, '0');
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  try {
    if (dom === '*' && mon === '*' && dow === '*') {
      if (hour === '*' && min.startsWith('*/')) return `Every ${min.slice(2)} minutes`;
      if (hour === '*') return `Hourly at :${pad(min)}`;
      return `Daily at ${pad(hour)}:${pad(min)}`;
    }
    if (dom === '*' && mon === '*' && dow !== '*') {
      const names = dow.split(',').map(d => dayNames[parseInt(d, 10)] || d).join(', ');
      return `${names} at ${pad(hour)}:${pad(min)}`;
    }
    if (dom !== '*' && mon === '*') return `Day ${dom} of month at ${pad(hour)}:${pad(min)}`;
    return expr;
  } catch { return expr; }
}

const CRON_PRESETS = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily at 9:00', value: '0 9 * * *' },
  { label: 'Daily at 12:00', value: '0 12 * * *' },
  { label: 'Weekdays at 9:00', value: '0 9 * * 1-5' },
  { label: 'Weekly (Mon 9:00)', value: '0 9 * * 1' },
  { label: 'Monthly (1st at 9:00)', value: '0 9 1 * *' },
];

function TaskForm({ task, onSave, onCancel }) {
  const [name, setName] = useState(task?.name || '');
  const [cron, setCron] = useState(task?.cronExpression || '');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (task?.id) {
        await api(`/tasks/${task.id}`, { method: 'PUT', body: { name, cronExpression: cron, prompt, enabled } });
        showToast('Task updated', 'success');
      } else {
        await api('/tasks', { method: 'POST', body: { name, cronExpression: cron, prompt } });
        showToast('Task created', 'success');
      }
      onSave();
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    }
    setSaving(false);
  };

  return html`
    <div class="card mb-16" style="border:1px solid var(--accent-blue);">
      <h3 style="font-size:16px;font-weight:600;margin-bottom:16px;">${task?.id ? 'Edit Task' : 'New Task'}</h3>
      <form onSubmit=${handleSubmit}>
        <div class="flex gap-16 mb-16" style="flex-wrap:wrap;">
          <div style="flex:1;min-width:200px;">
            <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;">Task Name</label>
            <input type="text" value=${name} onInput=${e => setName(e.target.value)} placeholder="Daily report" required />
      </div>
          <div style="flex:1;min-width:200px;">
            <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;">Schedule</label>
            <select value="" onChange=${e => { if (e.target.value) setCron(e.target.value); e.target.value = ''; }}
              style="margin-bottom:6px;">
              <option value="">Quick presets...</option>
              ${CRON_PRESETS.map(p => html`<option key=${p.value} value=${p.value}>${p.label}</option>`)}
            </select>
            <input type="text" value=${cron} onInput=${e => setCron(e.target.value)} placeholder="0 9 * * *" required />
            ${cron ? html`<div class="text-sm text-muted" style="margin-top:4px;">= ${cronToHumanJs(cron)}</div>` : null}
          </div>
        </div>
        <div class="mb-16">
          <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;">Prompt</label>
          <textarea value=${prompt} onInput=${e => setPrompt(e.target.value)} placeholder="What should the agent do?"
            style="min-height:100px;font-family:var(--font-sans);resize:vertical;" required />
        </div>
        ${task?.id ? html`
          <div class="mb-16">
            <label class="flex items-center gap-8" style="cursor:pointer;">
              <input type="checkbox" checked=${enabled} onChange=${e => setEnabled(e.target.checked)} style="width:auto;" />
              <span>Enabled</span>
            </label>
          </div>
        ` : null}
        <div class="flex gap-8 justify-between">
          <button type="button" class="btn btn-secondary" onClick=${onCancel}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled=${saving}>${saving ? 'Saving…' : (task?.id ? 'Update' : 'Create')}</button>
        </div>
      </form>
    </div>
  `;
}

// ─── Security ────────────────────────────────────────────────────────────────

function SecurityPage() {
  const [unlimited, setUnlimited] = useState(false);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [shellSaving, setShellSaving] = useState(false);
  const [envVars, setEnvVars] = useState([]);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [envSaving, setEnvSaving] = useState(false);

  const [sbStatus, setSbStatus] = useState(null);
  const [sbEnabled, setSbEnabled] = useState(false);
  const [sbBackend, setSbBackend] = useState('auto');
  const [sbDockerImage, setSbDockerImage] = useState('ubuntu:22.04');
  const [sbMounts, setSbMounts] = useState([]);
  const [sbNetwork, setSbNetwork] = useState(false);
  const [sbMemory, setSbMemory] = useState(512);
  const [sbSaving, setSbSaving] = useState(false);
  const [newMountHost, setNewMountHost] = useState('');
  const [newMountContainer, setNewMountContainer] = useState('');
  const [newMountMode, setNewMountMode] = useState('ro');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api('/security/unlimited'),
      api('/security/permissions'),
      api('/status'),
      api('/config/settings').catch(() => ({})),
      api('/security/sandbox-status').catch(() => null),
    ])
      .then(([u, p, s, cfg, sb]) => {
        setUnlimited(u.unlimited);
        setPermissions(Array.isArray(p) ? p : []);
        setStatus(s);
        if (cfg?.shell_sandbox) {
          const ce = cfg.shell_sandbox.customEnv || {};
          setEnvVars(Object.entries(ce).map(([k, v]) => ({ key: k, value: v })));
          setSbEnabled(!!cfg.shell_sandbox.containerEnabled);
          setSbBackend(cfg.shell_sandbox.backend || 'auto');
          setSbDockerImage(cfg.shell_sandbox.dockerImage || 'ubuntu:22.04');
          setSbMounts(cfg.shell_sandbox.mounts || []);
          setSbNetwork(!!cfg.shell_sandbox.networkAccess);
          setSbMemory(cfg.shell_sandbox.memoryLimitMb || 512);
        }
        if (sb) setSbStatus(sb);
      })
      .catch(e => showToast(`Failed: ${e.message}`, 'error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const buildShellSandbox = () => {
    const customEnv = {};
    for (const { key, value } of envVars) {
      if (key.trim()) customEnv[key.trim()] = value;
    }
    return {
      allowedPaths: [],
      customEnv: Object.keys(customEnv).length > 0 ? customEnv : undefined,
      containerEnabled: sbEnabled,
      backend: sbBackend,
      dockerImage: sbDockerImage,
      mounts: sbMounts,
      networkAccess: sbNetwork,
      memoryLimitMb: sbMemory,
    };
  };

  const saveAll = async () => {
    setSbSaving(true);
    try {
      await api('/config/settings', { method: 'PUT', body: { shell_sandbox: buildShellSandbox() } });
      showToast('Security settings saved', 'success');
      window.dispatchEvent(new Event('config-saved'));
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setSbSaving(false); }
  };

  const addMount = () => {
    const host = newMountHost.trim();
    if (!host) return;
    const container = newMountContainer.trim() || host;
    if (sbMounts.some(m => m.hostPath === host)) { showToast('Mount already exists', 'error'); return; }
    setSbMounts([...sbMounts, { hostPath: host, containerPath: container, mode: newMountMode }]);
    setNewMountHost('');
    setNewMountContainer('');
    setNewMountMode('ro');
  };

  const removeMount = (hostPath) => setSbMounts(sbMounts.filter(m => m.hostPath !== hostPath));

  const addEnvVar = () => {
    const k = newEnvKey.trim();
    if (!k) return;
    if (envVars.some(e => e.key === k)) { showToast(`"${k}" already exists`, 'error'); return; }
    setEnvVars([...envVars, { key: k, value: newEnvValue }]);
    setNewEnvKey('');
    setNewEnvValue('');
  };

  const removeEnvVar = (key) => setEnvVars(envVars.filter(e => e.key !== key));

  const toggleUnlimited = async () => {
    const newVal = !unlimited;
    if (newVal && !confirm('WARNING: Unlimited mode bypasses ALL tool approval checks. The agent will be able to execute any command without your permission. Are you sure?')) return;
    try {
      await api('/security/unlimited', { method: 'POST', body: { enabled: newVal } });
      setUnlimited(newVal);
      showToast(newVal ? 'Unlimited mode ACTIVATED' : 'Unlimited mode deactivated', newVal ? 'error' : 'success');
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  const revokePermission = async (tool) => {
    if (!confirm(`Revoke permission for "${tool}"?`)) return;
    try {
      await api(`/security/permissions/${encodeURIComponent(tool)}`, { method: 'DELETE' });
      showToast('Permission revoked', 'success');
      load();
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;

  const sensitiveTools = ['shell_exec', 'file_write_text', 'file_edit_text', 'file_delete', 'process_kill', 'settings_update'];

  return html`
    <div class="page-header"><h2>Security</h2><p>Tool permissions, sandbox, and access controls</p></div>

    <div class="card mb-16 ${unlimited ? 'security-danger-card' : ''}">
      <div class="flex justify-between items-center">
      <div>
          <h3 style="font-size:16px;font-weight:600;margin-bottom:4px;">
            ${unlimited ? '🔓 Unlimited Mode ACTIVE' : '🔒 Unlimited Mode'}
          </h3>
          <p class="text-sm text-muted">
            ${unlimited
      ? 'All tool approvals are bypassed. The agent can execute any tool without asking.'
      : 'Tools that require approval will prompt you before execution.'}
          </p>
        </div>
        <label class="toggle" style="cursor:pointer;position:relative;display:inline-block;width:52px;height:28px;flex-shrink:0;">
          <input type="checkbox" checked=${unlimited} onChange=${toggleUnlimited}
            style="opacity:0;width:0;height:0;position:absolute;" />
          <span style="position:absolute;inset:0;background:${unlimited ? 'var(--accent-red)' : 'var(--bg-tertiary)'};border-radius:14px;transition:var(--transition-fast);cursor:pointer;">
            <span style="position:absolute;top:2px;left:${unlimited ? '26px' : '2px'};width:24px;height:24px;background:white;border-radius:50%;transition:var(--transition-fast);" />
          </span>
        </label>
      </div>
      ${unlimited && html`
        <div class="security-warning mt-12">
          <strong>Security Risk:</strong> With unlimited mode on, the agent can run shell commands, delete files, and modify settings without approval. Only enable this if you trust the agent completely.
        </div>
      `}
    </div>

        <div class="card mb-16">
      <h3 style="font-size:16px;font-weight:600;margin-bottom:12px;">Granted Permissions</h3>
      ${permissions.length === 0 ? html`
        <div class="text-sm text-muted" style="padding:16px 0;text-align:center;">No stored permissions. Permissions are saved when you "Allow Always" for a tool.</div>
      ` : html`
        <div class="flex-col gap-8">
          ${permissions.map(p => html`
            <div class="flex justify-between items-center" key=${p.tool} style="padding:8px 12px;background:var(--bg-primary);border-radius:var(--radius-md);">
              <div>
                <span class="text-mono" style="font-size:13px;font-weight:600;color:var(--accent-cyan);">${p.tool}</span>
                <span class="badge badge-green" style="margin-left:8px;font-size:11px;">${p.decision}</span>
              </div>
              <button class="btn btn-danger btn-sm" onClick=${() => revokePermission(p.tool)}>Revoke</button>
            </div>
          `)}
        </div>
      `}
    </div>

    <div class="card mb-16">
      <h3 style="font-size:16px;font-weight:600;margin-bottom:12px;">Sensitive Tools</h3>
      <p class="text-sm text-muted mb-12">These tools require explicit approval before execution (unless unlimited mode is on).</p>
      <div class="flex gap-8" style="flex-wrap:wrap;">
        ${sensitiveTools.map(t => html`
          <span key=${t} class="badge badge-yellow" style="font-size:12px;padding:4px 10px;">${t}</span>
        `)}
      </div>
    </div>

    <div class="card mb-16">
      <h3 style="font-size:16px;font-weight:600;margin-bottom:12px;">Container Sandbox</h3>
      <p class="text-sm text-muted mb-12">
        Run shell_exec commands inside an isolated sandbox (Firejail, Docker, or macOS native sandbox).
        Commands cannot access the host filesystem except through explicitly configured mounts.
      </p>

      ${sbStatus && html`
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
          <div style="padding:8px 14px;background:var(--bg-primary);border-radius:var(--radius-md);font-size:12px;">
            Firejail: <span class="badge ${sbStatus.firejailAvailable ? 'badge-green' : 'badge-yellow'}">${sbStatus.firejailAvailable ? 'available' : 'not found'}</span>
          </div>
          <div style="padding:8px 14px;background:var(--bg-primary);border-radius:var(--radius-md);font-size:12px;">
            Docker: <span class="badge ${sbStatus.dockerAvailable ? 'badge-green' : 'badge-yellow'}">${sbStatus.dockerAvailable ? 'available' : 'not found'}</span>
          </div>
          <div style="padding:8px 14px;background:var(--bg-primary);border-radius:var(--radius-md);font-size:12px;">
            macOS Seatbelt: <span class="badge ${sbStatus.seatbeltAvailable ? 'badge-green' : 'badge-yellow'}">${sbStatus.seatbeltAvailable ? 'available' : 'not available'}</span>
          </div>
          ${sbStatus.activeBackend && html`
            <div style="padding:8px 14px;background:var(--bg-primary);border-radius:var(--radius-md);font-size:12px;">
              Active: <span class="badge badge-green">${sbStatus.activeBackend}</span>
            </div>
          `}
        </div>
      `}

      <div class="flex justify-between items-center" style="margin-bottom:16px;padding:12px;background:var(--bg-primary);border-radius:var(--radius-md);">
                <div>
          <strong style="font-size:14px;">${sbEnabled ? 'Sandbox Enabled' : 'Sandbox Disabled'}</strong>
          <div class="text-sm text-muted">${sbEnabled ? 'Shell commands run inside an isolated container' : 'Shell commands run directly on the host'}</div>
                </div>
        <label style="cursor:pointer;position:relative;display:inline-block;width:52px;height:28px;flex-shrink:0;">
          <input type="checkbox" checked=${sbEnabled} onChange=${() => setSbEnabled(!sbEnabled)}
            style="opacity:0;width:0;height:0;position:absolute;" />
          <span style="position:absolute;inset:0;background:${sbEnabled ? 'var(--accent-green,#2ea043)' : 'var(--bg-tertiary)'};border-radius:14px;transition:var(--transition-fast);cursor:pointer;">
            <span style="position:absolute;top:2px;left:${sbEnabled ? '26px' : '2px'};width:24px;height:24px;background:white;border-radius:50%;transition:var(--transition-fast);" />
          </span>
        </label>
      </div>

      ${sbEnabled && html`
        <div class="form-grid" style="gap:12px;">
          <div class="form-field">
            <label>Backend</label>
            <select value=${sbBackend} onChange=${e => setSbBackend(e.target.value)}>
              <option value="auto">Auto-detect</option>
              <option value="firejail">Firejail</option>
              <option value="docker">Docker</option>
              <option value="macos_seatbelt">macOS Seatbelt</option>
            </select>
          </div>
          <div class="form-field">
            <label>Docker Image</label>
            <input type="text" value=${sbDockerImage} onInput=${e => setSbDockerImage(e.target.value)}
              placeholder="ubuntu:22.04" style="font-family:var(--font-mono);font-size:12px;" />
          </div>
          <div class="form-field">
            <label>Memory Limit (MB)</label>
            <input type="number" value=${sbMemory} onInput=${e => setSbMemory(parseInt(e.target.value) || 512)}
              min="64" max="8192" />
          </div>
          <div class="form-field">
            <label>Network Access</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;font-size:13px;">
              <input type="checkbox" checked=${sbNetwork} onChange=${() => setSbNetwork(!sbNetwork)} />
              Allow network access from sandbox
            </label>
          </div>
        </div>

        <div style="margin-top:20px;">
          <h4 style="font-size:14px;font-weight:600;margin-bottom:8px;">Filesystem Mounts</h4>
          <p class="text-sm text-muted mb-8">Host directories accessible inside the sandbox. Use read-only (ro) for reference data and read-write (rw) for workspaces.</p>
          <div style="padding:10px 14px;background:rgba(56,139,253,.08);border:1px solid rgba(56,139,253,.2);border-radius:var(--radius-md);margin-bottom:12px;">
            <p class="text-sm" style="color:var(--accent-blue,#58a6ff);margin:0;">
              <strong>Note:</strong> Each user automatically gets read-write access to their own workspace folder. These additional mounts are <strong>shared across all users</strong> — any path added here will be accessible by every user's sandbox.
            </p>
          </div>
          ${sbMounts.length > 0 ? html`
            <div class="flex-col gap-8 mb-12">
              ${sbMounts.map(m => html`
                <div key=${m.hostPath} class="flex items-center gap-8" style="padding:8px 12px;background:var(--bg-primary);border-radius:var(--radius-md);">
                  <span class="text-mono" style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;">${m.hostPath}</span>
                  <span class="text-mono text-muted" style="font-size:11px;">→ ${m.containerPath}</span>
                  <span class="badge ${m.mode === 'rw' ? 'badge-yellow' : 'badge-green'}" style="font-size:10px;">${m.mode}</span>
                  <button class="btn btn-danger btn-sm" onClick=${() => removeMount(m.hostPath)} style="flex-shrink:0;padding:2px 8px;">✕</button>
                </div>
              `)}
            </div>
          ` : html`<p class="text-sm text-muted mb-12" style="text-align:center;">No additional mounts configured.</p>`}
          <div class="flex gap-8 items-end" style="flex-wrap:wrap;">
            <div class="form-field" style="flex:2;min-width:180px;">
              <label>Host Path</label>
              <input type="text" value=${newMountHost} onInput=${e => { setNewMountHost(e.target.value); if (!newMountContainer) setNewMountContainer(''); }}
                placeholder="/home/user/project" style="font-family:var(--font-mono);font-size:12px;" />
            </div>
            <div class="form-field" style="flex:2;min-width:180px;">
              <label>Container Path <span class="text-muted">(defaults to host)</span></label>
              <input type="text" value=${newMountContainer} onInput=${e => setNewMountContainer(e.target.value)}
                placeholder=${newMountHost || '/container/path'} style="font-family:var(--font-mono);font-size:12px;" />
            </div>
            <div class="form-field" style="flex:0;min-width:80px;">
              <label>Mode</label>
              <select value=${newMountMode} onChange=${e => setNewMountMode(e.target.value)}>
                <option value="ro">ro</option>
                <option value="rw">rw</option>
              </select>
            </div>
            <button class="btn btn-secondary btn-sm" onClick=${addMount} style="flex-shrink:0;margin-bottom:0;">+ Add</button>
          </div>
        </div>
      `}

      <button class="btn btn-primary mt-16" onClick=${saveAll} disabled=${sbSaving}>
        ${sbSaving ? 'Saving...' : 'Save Sandbox Settings'}
                </button>
    </div>

    <div class="card mb-16">
      <h3 style="font-size:14px;font-weight:600;margin-bottom:12px;">Environment Variables</h3>
      <p class="text-sm text-muted mb-12">Custom environment variables injected into shell_exec commands (both sandboxed and non-sandboxed).</p>
      ${envVars.length > 0 ? html`
        <div class="flex-col gap-8 mb-12">
          ${envVars.map(e => html`
            <div key=${e.key} class="flex items-center gap-8" style="padding:6px 12px;background:var(--bg-primary);border-radius:var(--radius-md);">
              <span class="text-mono" style="font-size:12px;font-weight:600;color:var(--accent-cyan);min-width:160px;">${e.key}</span>
              <span class="text-mono text-sm text-muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.value ? '••••••••' : '(empty)'}</span>
              <button class="btn btn-danger btn-sm" onClick=${() => removeEnvVar(e.key)} style="flex-shrink:0;">✕</button>
              </div>
            `)}
        </div>
      ` : html`<p class="text-sm text-muted mb-12" style="text-align:center;">No custom environment variables configured.</p>`}
      <div class="flex gap-8 items-end" style="flex-wrap:wrap;">
        <div class="form-field" style="flex:1;min-width:140px;">
          <label>Key</label>
          <input type="text" value=${newEnvKey} onInput=${e => setNewEnvKey(e.target.value.toUpperCase())}
            placeholder="TAVILY_API_KEY" style="font-family:var(--font-mono);font-size:12px;" />
        </div>
        <div class="form-field" style="flex:2;min-width:200px;">
          <label>Value</label>
          <input type="password" value=${newEnvValue} onInput=${e => setNewEnvValue(e.target.value)}
            placeholder="sk-..." style="font-family:var(--font-mono);font-size:12px;" />
        </div>
        <button class="btn btn-secondary btn-sm" onClick=${addEnvVar} style="flex-shrink:0;margin-bottom:0;">+ Add</button>
      </div>
      <button class="btn btn-primary btn-sm mt-12" onClick=${saveAll} disabled=${sbSaving}>${sbSaving ? 'Saving...' : 'Save All Settings'}</button>
        </div>

        <div class="card">
      <div style="padding:12px;background:var(--bg-tertiary);border-radius:8px;border:1px solid var(--border);">
        <p class="text-sm" style="margin-bottom:8px;"><strong>Protection Summary</strong></p>
        <ul class="text-sm text-muted" style="margin:0;padding-left:20px;line-height:1.6;">
          <li><strong>Tool Approval:</strong> Sensitive tools require explicit user approval before execution</li>
          <li><strong>Dangerous Command Blocking:</strong> Commands like <code>rm -rf /</code>, <code>mkfs</code>, fork bombs are blocked outright</li>
          ${sbEnabled ? html`<li><strong>Container Sandbox:</strong> Shell commands run in an isolated ${sbStatus?.activeBackend || sbBackend} container with restricted filesystem access</li>` : ''}
          <li><strong>MCP Servers:</strong> Installation requires explicit approval; servers run as separate processes</li>
        </ul>
      </div>
    </div>
  `;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

function MemoryPage() {
  const [entries, setEntries] = useState([]);
  const [rawContent, setRawContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('entries');
  const [newEntry, setNewEntry] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWs, setSelectedWs] = useState('default');

  const wsParam = selectedWs && selectedWs !== 'default' ? `?workspace=${selectedWs}` : '';

  const loadEntries = useCallback(() => {
    setLoading(true);
    Promise.all([
      api(`/memory${wsParam}`).catch(() => []),
      api(`/memory/raw${wsParam}`).catch(() => ({ content: '' })),
      api('/workspaces').catch(() => []),
    ]).then(([ents, raw, ws]) => {
      setEntries(Array.isArray(ents) ? ents : []);
      setRawContent(raw?.content || '');
      setWorkspaces(Array.isArray(ws) ? ws : []);
    }).finally(() => setLoading(false));
  }, [wsParam]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  const handleAdd = async () => {
    if (!newEntry.trim()) return;
    setSaving(true);
    try {
      await api('/memory', { method: 'POST', body: { content: newEntry.trim(), workspace: selectedWs } });
      setNewEntry('');
      loadEntries();
      showToast('Memory entry added', 'success');
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setSaving(false); }
  };

  const handleRemove = async (id) => {
    if (!confirm('Remove this memory entry?')) return;
    try {
      await api(`/memory/${id}${wsParam}`, { method: 'DELETE' });
      loadEntries();
      showToast('Entry removed', 'success');
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  const handleEdit = (entry) => {
    setEditingId(entry.id);
    setEditContent(entry.content);
  };

  const handleSaveEdit = async () => {
    if (!editContent.trim()) return;
    setSaving(true);
    try {
      await api(`/memory/${editingId}`, { method: 'PUT', body: { content: editContent.trim(), workspace: selectedWs } });
      setEditingId(null);
      setEditContent('');
      loadEntries();
      showToast('Entry updated', 'success');
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setSaving(false); }
  };

  const handleSaveRaw = async () => {
    setSaving(true);
    try {
      await api('/memory/raw', { method: 'PUT', body: { content: rawContent, workspace: selectedWs } });
      loadEntries();
      showToast('Memory saved', 'success');
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setSaving(false); }
  };

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;

  return html`
    <div class="page-header">
      <h2>🧠 Memory</h2>
      <p>Long-term memory is injected into every LLM prompt. The agent can read and update it autonomously.</p>
    </div>

    ${workspaces.length > 1 ? html`
      <div class="form-field mb-16">
        <label>Workspace</label>
        <select value=${selectedWs} onChange=${e => setSelectedWs(e.target.value)}>
          ${workspaces.map(ws => html`<option value=${ws.id} key=${ws.id}>${ws.name}${ws.isDefault ? ' (default)' : ''}</option>`)}
        </select>
      </div>
    ` : null}

    <div class="flex gap-8 mb-16">
      <button class="btn ${viewMode === 'entries' ? 'btn-primary' : 'btn-secondary'} btn-sm" onClick=${() => setViewMode('entries')}>Entries (${entries.length})</button>
      <button class="btn ${viewMode === 'raw' ? 'btn-primary' : 'btn-secondary'} btn-sm" onClick=${() => setViewMode('raw')}>Raw Markdown</button>
    </div>

    ${viewMode === 'entries' ? html`
      <div class="card mb-16" style="border-left:3px solid var(--accent-green);">
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <textarea style="flex:1;min-height:60px;resize:vertical;" placeholder="Add a new memory entry..." value=${newEntry} onInput=${e => setNewEntry(e.target.value)} />
          <button class="btn btn-primary" onClick=${handleAdd} disabled=${saving || !newEntry.trim()} style="white-space:nowrap;">${saving ? 'Adding...' : '+ Add'}</button>
        </div>
      </div>

      ${entries.length === 0
        ? html`<div class="empty-state"><div class="empty-state-icon">🧠</div><p>No memory entries yet</p><p class="text-sm text-muted">The agent will save important context here automatically, or you can add entries manually.</p></div>`
        : [...entries].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')).map(e => html`
          <div class="card mb-8" key=${e.id} style="padding:12px 16px;">
            ${editingId === e.id ? html`
              <div>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                  <span class="badge badge-blue" style="font-size:11px;">mem-${e.id}</span>
                  <span class="text-sm text-muted">Editing</span>
                </div>
                <textarea style="width:100%;min-height:80px;resize:vertical;margin-bottom:8px;" value=${editContent} onInput=${ev => setEditContent(ev.target.value)} />
                <div class="flex gap-8">
                  <button class="btn btn-primary btn-sm" onClick=${handleSaveEdit} disabled=${saving || !editContent.trim()}>${saving ? 'Saving...' : 'Save'}</button>
                  <button class="btn btn-secondary btn-sm" onClick=${() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            ` : html`
              <div class="flex justify-between items-center" style="gap:12px;">
                <div style="flex:1;min-width:0;">
                  <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;">
                    <span class="badge badge-blue" style="font-size:11px;">mem-${e.id}</span>
                    ${e.timestamp ? html`<span class="text-sm text-muted">${new Date(e.timestamp).toLocaleString()}</span>` : null}
                  </div>
                  <div class="text-sm" style="white-space:pre-wrap;word-break:break-word;">${e.content}</div>
                </div>
                <div class="flex gap-4" style="flex-shrink:0;">
                  <button class="btn btn-secondary btn-sm" onClick=${() => handleEdit(e)}>Edit</button>
                  <button class="btn btn-danger btn-sm" onClick=${() => handleRemove(e.id)}>Remove</button>
                </div>
              </div>
            `}
          </div>
        `)
      }
    ` : html`
      <textarea class="code-editor w-full" value=${rawContent} onInput=${e => setRawContent(e.target.value)} spellcheck=${false} style="min-height:300px;font-family:monospace;" />
      <div class="flex justify-between items-center mt-16">
        <button class="btn btn-secondary" onClick=${loadEntries}>↻ Reload</button>
        <button class="btn btn-primary" onClick=${handleSaveRaw} disabled=${saving}>${saving ? 'Saving...' : '💾 Save Memory'}</button>
      </div>
    `}

    <div class="card mt-16" style="background:var(--bg-tertiary);">
      <p class="text-sm" style="margin:0;"><strong>How memory works:</strong> The agent's long-term memory is stored in <code>MEMORY.md</code> per workspace. It is automatically injected into every system prompt (main agent, heartbeats, scheduled tasks, sub-agents). The agent can use <code>memory_append</code>, <code>memory_remove</code>, <code>memory_list</code>, <code>memory_write</code>, and <code>memory_read</code> tools to manage its own memory.</p>
    </div>
  `;
}

// ─── Sub-Agents ─────────────────────────────────────────────────────────────

function SubAgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [runPrompt, setRunPrompt] = useState('');
  const [runningId, setRunningId] = useState(null);
  const workspaces = useWorkspaces();

  const load = useCallback(() => {
    api('/subagents')
      .then(data => setAgents(Array.isArray(data) ? data : []))
      .catch(e => showToast(`Failed: ${e.message}`, 'error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); const interval = setInterval(load, 10000); return () => clearInterval(interval); }, [load]);

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete sub-agent "${name}"?`)) return;
    try { await api(`/subagents/${id}`, { method: 'DELETE' }); showToast('Deleted', 'success'); load(); } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  };

  const handleRun = async (id) => {
    if (!runPrompt.trim()) return;
    setRunningId(id);
    try {
      const res = await api(`/subagents/${id}/run`, { method: 'POST', body: { task: runPrompt.trim() } });
      showToast('Task completed', 'success');
      setRunPrompt('');
      load();
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    finally { setRunningId(null); }
  };

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;

  return html`
    <div class="page-header flex justify-between items-center">
      <div><h2>Sub-Agents</h2><p>Create and manage autonomous sub-agents</p></div>
      <button class="btn btn-primary btn-sm" onClick=${() => { setShowCreate(true); setEditingAgent(null); }}>+ New Agent</button>
    </div>

    ${(showCreate || editingAgent) ? html`
      <${SubAgentForm} agent=${editingAgent} workspaces=${workspaces} onSave=${() => { setShowCreate(false); setEditingAgent(null); load(); }}
        onCancel=${() => { setShowCreate(false); setEditingAgent(null); }} />
    ` : null}

    ${agents.length === 0 && !showCreate ? html`
      <div class="empty-state"><div class="empty-state-icon">🤖</div><p>No sub-agents yet</p>
        <button class="btn btn-primary mt-16" onClick=${() => setShowCreate(true)}>Create Sub-Agent</button>
      </div>
    ` : html`
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${agents.map(a => {
    const statusColor = a.status === 'running' ? 'badge-green' : a.status === 'completed' ? 'badge-blue' : a.status === 'failed' ? 'badge-red' : 'badge-yellow';
    const isExpanded = expandedId === a.id;
    return html`
            <div class="card" key=${a.id} style="border-left:3px solid var(--accent-purple);padding:12px 16px;">
              <div class="flex justify-between items-center cursor-pointer" onClick=${() => setExpandedId(isExpanded ? null : a.id)}>
                <div class="flex items-center" style="gap:10px;">
                  <span style="font-size:20px;">🤖</span>
                  <div>
                    <div style="font-weight:600;font-size:14px;">${a.name || a.id?.slice(0, 8)}</div>
                    <div class="text-muted" style="font-size:12px;">${a.description ? truncate(a.description, 60) : 'No description'}</div>
                  </div>
                </div>
                <div class="flex items-center gap-8">
                  <span class="badge ${statusColor}">${a.status || 'idle'}</span>
                  <span style="font-size:12px;">${isExpanded ? '▾' : '▸'}</span>
                </div>
              </div>
              ${isExpanded ? html`
                <div style="margin-top:12px;border-top:1px solid var(--border-color);padding-top:12px;">
                  <div class="entry-meta-grid">
                    <div class="entry-meta-item"><span class="entry-meta-label">Workspace</span><span class="entry-meta-value">${workspaceDisplayName(a.workspaceId, workspaces)}</span></div>
                    <div class="entry-meta-item"><span class="entry-meta-label">Model</span><span class="entry-meta-value">${a.model || 'Default'}</span></div>
                    <div class="entry-meta-item"><span class="entry-meta-label">Max Iterations</span><span class="entry-meta-value">${a.maxIterations ?? 5}</span></div>
                    <div class="entry-meta-item"><span class="entry-meta-label">Created</span><span class="entry-meta-value">${a.createdAt ? relativeTime(a.createdAt) : '—'}</span></div>
                    ${a.lastRunAt ? html`<div class="entry-meta-item"><span class="entry-meta-label">Last Run</span><span class="entry-meta-value">${relativeTime(a.lastRunAt)}</span></div>` : null}
                  </div>
                  ${a.lastResult ? html`<div style="background:var(--bg-primary);border-radius:var(--radius-md);padding:10px 12px;font-size:13px;margin-top:8px;max-height:200px;overflow-y:auto;white-space:pre-wrap;">${truncate(a.lastResult, 500)}</div>` : null}
                  <div style="margin-top:12px;">
                    <textarea value=${runPrompt} onInput=${e => setRunPrompt(e.target.value)} placeholder="Run a task..." style="min-height:60px;resize:vertical;margin-bottom:8px;" />
                  </div>
                  <div class="flex gap-8">
                    <button class="btn btn-primary btn-sm" onClick=${() => handleRun(a.id)} disabled=${runningId === a.id || !runPrompt.trim()}>
                      ${runningId === a.id ? '⏳ Running...' : '🚀 Run'}
            </button>
                    <button class="btn btn-secondary btn-sm" onClick=${() => { setEditingAgent(a); setShowCreate(false); }}>✏ Edit</button>
                    <button class="btn btn-danger btn-sm" onClick=${() => handleDelete(a.id, a.name)}>🗑 Delete</button>
          </div>
        </div>
              ` : null}
      </div>
          `;
  })}
      </div>
    `}
  `;
}

function SubAgentForm({ agent, workspaces, onSave, onCancel }) {
  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '');
  const [model, setModel] = useState(agent?.model || '');
  const [maxIter, setMaxIter] = useState(agent?.maxIterations ?? 5);
  const [wsId, setWsId] = useState(agent?.workspaceId || (workspaces?.find(w => w.isDefault)?.id || ''));
  const [saving, setSaving] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);

  useEffect(() => {
    api('/config/providers').then(data => {
      const providers = Array.isArray(data) ? data : [];
      const models = [];
      for (const p of providers) {
        for (const m of (p.models || [])) {
          models.push({ id: m.id, label: `${m.id} (${p.id})` });
        }
      }
      setAvailableModels(models);
    }).catch(() => { });
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { name, description, systemPrompt, model: model || undefined, maxIterations: maxIter, workspaceId: wsId };
      if (agent?.id) {
        await api(`/subagents/${agent.id}`, { method: 'PUT', body });
        showToast('Agent updated', 'success');
      } else {
        await api('/subagents', { method: 'POST', body });
        showToast('Agent created', 'success');
      }
      onSave();
    } catch (err) { showToast(`Failed: ${err.message}`, 'error'); }
    setSaving(false);
  };

  return html`
    <div class="card mb-16" style="border:1px solid var(--accent-purple);">
      <h3 style="font-size:16px;font-weight:600;margin-bottom:16px;">${agent?.id ? 'Edit Agent' : 'New Sub-Agent'}</h3>
      <form onSubmit=${handleSubmit}>
        <div class="flex gap-16 mb-16" style="flex-wrap:wrap;">
          <div style="flex:1;min-width:200px;">
            <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;">Name</label>
            <input type="text" value=${name} onInput=${e => setName(e.target.value)} placeholder="Research Agent" required />
          </div>
          <div style="flex:1;min-width:120px;">
            <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;">Model</label>
            <select value=${model} onChange=${e => setModel(e.target.value)}>
              <option value="">Default model</option>
              ${availableModels.map(m => html`<option key=${m.id} value=${m.id}>${m.label}</option>`)}
            </select>
          </div>
          <div style="width:100px;">
            <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;">Max Iters</label>
            <input type="number" value=${maxIter} onInput=${e => setMaxIter(parseInt(e.target.value) || 5)} min="1" max="100" />
          </div>
        </div>
        ${workspaces && workspaces.length > 1 ? html`
          <div class="mb-16">
            <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;">Workspace</label>
            <select value=${wsId} onChange=${e => setWsId(e.target.value)}>
              ${workspaces.map(w => html`<option key=${w.id} value=${w.id}>${w.displayName || w.name}${w.isDefault ? ' (default)' : ''}</option>`)}
            </select>
          </div>
        ` : null}
        <div class="mb-16">
          <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;">Description</label>
          <input type="text" value=${description} onInput=${e => setDescription(e.target.value)} placeholder="What does this agent do?" />
        </div>
        <div class="mb-16">
          <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;">System Prompt</label>
          <textarea value=${systemPrompt} onInput=${e => setSystemPrompt(e.target.value)} placeholder="Instructions for the sub-agent..."
            style="min-height:100px;font-family:var(--font-mono);font-size:12px;resize:vertical;" required />
        </div>
        <div class="flex gap-8 justify-between">
          <button type="button" class="btn btn-secondary" onClick=${onCancel}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled=${saving}>${saving ? 'Saving…' : (agent?.id ? 'Update' : 'Create')}</button>
        </div>
      </form>
    </div>
  `;
}

// ─── App (Router + Layout) ───────────────────────────────────────────────────

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [twoFAState, setTwoFAState] = useState(null);

  const apiPost = async (path, body) => {
    const res = await fetch('/admin/api' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.json();
  };

  const handleCredentialsLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await apiPost('/login', { username, password });
      if (data.needs2FASetup) {
        setTwoFAState({ step: 'setup-choose', tempToken: data.tempToken });
      } else if (data.needs2FA) {
        setTwoFAState({ step: 'verify', method: data.method, tempToken: data.tempToken, challengeKey: data.challengeKey, options: data.options });
      } else if (data.ok) {
        onLogin();
      } else {
        setError(data.error || 'Login failed');
      }
    } catch { setError('Connection error'); }
    setLoading(false);
  };

  const handleSetupTotp = async () => {
    setLoading(true); setError('');
    try {
      const data = await apiPost('/2fa/setup/totp', { tempToken: twoFAState.tempToken });
      if (data.ok) {
        setTwoFAState({ step: 'setup-totp-verify', tempToken: data.tempToken, qrCodeDataUrl: data.qrCodeDataUrl, secret: data.secret });
      } else { setError(data.error || 'Failed to generate TOTP'); }
    } catch { setError('Connection error'); }
    setLoading(false);
  };

  const handleSetupPasskey = async () => {
    setLoading(true); setError('');
    try {
      const data = await apiPost('/2fa/setup/passkey/register-options', { tempToken: twoFAState.tempToken });
      if (!data.ok) { setError(data.error || 'Failed'); setLoading(false); return; }
      const { startRegistration } = await import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/dist/bundle/index.js');
      const credential = await startRegistration({ optionsJSON: data.options });
      const verify = await apiPost('/2fa/setup/passkey/register', { tempToken: data.tempToken, challengeKey: data.challengeKey, credential });
      if (verify.verified) { onLogin(); } else { setError(verify.error || 'Registration failed'); }
    } catch (err) { setError(err.message || 'Passkey registration failed'); }
    setLoading(false);
  };

  const handleSkip2FA = async () => {
    setLoading(true); setError('');
    try {
      const data = await apiPost('/2fa/setup/skip', { tempToken: twoFAState.tempToken });
      if (data.ok || data.verified) { onLogin(); } else { setError(data.error || 'Failed to skip'); }
    } catch { setError('Connection error'); }
    setLoading(false);
  };

  const [totpCode, setTotpCode] = useState('');
  const handleVerifyTotp = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    try {
      const endpoint = twoFAState.step === 'setup-totp-verify' ? '/2fa/setup/totp/verify' : '/2fa/verify/totp';
      const data = await apiPost(endpoint, { tempToken: twoFAState.tempToken, code: totpCode });
      if (data.verified || data.ok) { onLogin(); }
      else {
        setError(data.error || 'Invalid code');
        if (data.tempToken) setTwoFAState(s => ({ ...s, tempToken: data.tempToken }));
      }
    } catch { setError('Connection error'); }
    setLoading(false);
  };

  const handleVerifyPasskey = async () => {
    setLoading(true); setError('');
    try {
      const { startAuthentication } = await import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/dist/bundle/index.js');
      const credential = await startAuthentication({ optionsJSON: twoFAState.options });
      const data = await apiPost('/2fa/verify/passkey', { tempToken: twoFAState.tempToken, challengeKey: twoFAState.challengeKey, credential });
      if (data.ok) { onLogin(); } else { setError(data.error || 'Verification failed'); }
    } catch (err) { setError(err.message || 'Passkey auth failed'); }
    setLoading(false);
  };

  const inputStyle = 'width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);box-sizing:border-box;';

  if (twoFAState) {
    return html`
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;width:100%;background:var(--bg);">
        <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:12px;padding:40px;width:400px;">
          <h2 style="text-align:center;margin:0 0 8px;">Kora</h2>
          ${error && html`<div style="background:#f8514926;color:#f85149;padding:8px 12px;border-radius:6px;margin-bottom:16px;font-size:14px;">${error}</div>`}

          ${twoFAState.step === 'setup-choose' && html`
            <p style="text-align:center;color:var(--muted);margin:0 0 24px;">Set up Two-Factor Authentication</p>
            <p style="font-size:14px;color:var(--text-muted);margin-bottom:24px;text-align:center;">Please add a 2FA method to secure your account:</p>
            <div style="display:flex;flex-direction:column;gap:12px;">
              <button class="btn btn-primary" style="width:100%;padding:14px;" onClick=${handleSetupPasskey} disabled=${loading}>
                Passkey (Recommended)
              </button>
              <button class="btn btn-primary" style="width:100%;padding:14px;" onClick=${handleSetupTotp} disabled=${loading}>
                Authenticator App (TOTP)
              </button>
            </div>
            <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
              <button class="btn" style="color:var(--text-muted);background:transparent;font-size:13px" onClick=${handleSkip2FA} disabled=${loading}>
                Skip for now
              </button>
            </div>
          `}

          ${twoFAState.step === 'setup-totp-verify' && html`
            <p style="text-align:center;color:var(--muted);margin:0 0 16px;">Scan QR Code</p>
            <div style="text-align:center;margin-bottom:16px;">
              <img src=${twoFAState.qrCodeDataUrl} alt="TOTP QR Code" style="border-radius:8px;max-width:200px;" />
            </div>
            <p style="font-size:12px;color:var(--text-muted);text-align:center;margin-bottom:16px;word-break:break-all;">
              Manual entry: <code>${twoFAState.secret}</code>
            </p>
            <form onSubmit=${handleVerifyTotp}>
              <div style="margin-bottom:16px;">
                <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--muted);">Enter 6-digit code</label>
                <input type="text" value=${totpCode} onInput=${e => setTotpCode(e.target.value)}
                  maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" style=${inputStyle} />
              </div>
              <button type="submit" class="btn btn-primary" style="width:100%;" disabled=${loading || totpCode.length !== 6}>
                ${loading ? 'Verifying...' : 'Verify & Activate'}
              </button>
            </form>
          `}

          ${twoFAState.step === 'verify' && twoFAState.method === 'totp' && html`
            <p style="text-align:center;color:var(--muted);margin:0 0 24px;">Enter your authenticator code</p>
            <form onSubmit=${handleVerifyTotp}>
              <div style="margin-bottom:16px;">
                <input type="text" value=${totpCode} onInput=${e => setTotpCode(e.target.value)}
                  maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="6-digit code" style=${inputStyle} />
              </div>
              <button type="submit" class="btn btn-primary" style="width:100%;" disabled=${loading || totpCode.length !== 6}>
                ${loading ? 'Verifying...' : 'Verify'}
              </button>
            </form>
          `}

          ${twoFAState.step === 'verify' && twoFAState.method === 'passkey' && html`
            <p style="text-align:center;color:var(--muted);margin:0 0 24px;">Authenticate with your passkey</p>
            <button class="btn btn-primary" style="width:100%;padding:14px;" onClick=${handleVerifyPasskey} disabled=${loading}>
              ${loading ? 'Waiting for passkey...' : 'Use Passkey'}
            </button>
          `}

          <p style="text-align:center;margin:16px 0 0;">
            <a href="#" onClick=${(e) => { e.preventDefault(); setTwoFAState(null); setError(''); }}
              style="font-size:12px;color:var(--muted);">Back to login</a>
          </p>
        </div>
      </div>
    `;
  }

  return html`
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;width:100%;background:var(--bg);">
      <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:12px;padding:40px;width:360px;">
        <h2 style="text-align:center;margin:0 0 8px;">Kora</h2>
        <p style="text-align:center;color:var(--muted);margin:0 0 24px;">Web Admin Login</p>
        ${error && html`<div style="background:#f8514926;color:#f85149;padding:8px 12px;border-radius:6px;margin-bottom:16px;font-size:14px;">${error}</div>`}

        <form onSubmit=${handleCredentialsLogin}>
          <div style="margin-bottom:16px;">
            <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--muted);">Username</label>
            <input type="text" value=${username} onInput=${(e) => setUsername(e.target.value)} style=${inputStyle} />
          </div>
          <div style="margin-bottom:24px;">
            <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--muted);">Password</label>
            <input type="password" value=${password} onInput=${(e) => setPassword(e.target.value)} style=${inputStyle} />
          </div>
          <button type="submit" disabled=${loading} class="btn btn-primary" style="width:100%;">
            ${loading ? 'Logging in...' : 'Log In'}
    </button>
          <p style="text-align:center;margin:16px 0 0;font-size:12px;color:var(--muted);">
            Set credentials via Telegram: <code>/webadmin</code>
          </p>
        </form>
      </div>
    </div>
  `;
}

// ─── Users Page (Multi-User Mode) ────────────────────────────────────────────

function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    const qs = searchDebounced ? `?q=${encodeURIComponent(searchDebounced)}` : '';
    api(`/users${qs}`)
      .then(d => setUsers(Array.isArray(d) ? d : []))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, [searchDebounced]);

  const statusBadge = (s) => {
    const colors = { active: 'var(--green)', suspended: 'var(--red)', pending_verification: 'var(--yellow,orange)' };
    return html`<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:${colors[s] || 'var(--muted)'};color:#fff">${s}</span>`;
  };

  return html`
    <div class="page-header"><h2>Users</h2><p>${users.length} registered user(s)</p></div>
    <div style="margin-bottom:16px;">
      <input type="text" placeholder="Search by email, name, or Telegram ID..."
        value=${search} onInput=${(e) => setSearch(e.target.value)}
        style="width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:14px;" />
    </div>
    ${loading ? html`<div class="loading-center"><div class="spinner" /></div>` : html`
      <div class="card" style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border);text-align:left;">
              <th style="padding:8px 12px;">Email</th>
              <th style="padding:8px 12px;">Name</th>
              <th style="padding:8px 12px;">Role</th>
              <th style="padding:8px 12px;">Status</th>
              <th style="padding:8px 12px;">Subscription</th>
              <th style="padding:8px 12px;">Created</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => html`
              <tr key=${u.id} style="border-bottom:1px solid var(--border);cursor:pointer;" onClick=${() => navigate('/users/' + u.id)}>
                <td style="padding:8px 12px;"><code>${u.email || '—'}</code></td>
                <td style="padding:8px 12px;">${u.displayName || '—'}</td>
                <td style="padding:8px 12px;"><span style="font-size:11px;text-transform:uppercase;">${u.role}</span></td>
                <td style="padding:8px 12px;">${statusBadge(u.status)}</td>
                <td style="padding:8px 12px;">${u.subscriptionStatus || '—'}</td>
                <td style="padding:8px 12px;">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
              </tr>
            `)}
            ${users.length === 0 && html`<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--muted);">No users found</td></tr>`}
          </tbody>
        </table>
      </div>
    `}
  `;
}

function UserDetailPage({ userId }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('sessions');
  const [tabData, setTabData] = useState(null);
  const [tabLoading, setTabLoading] = useState(false);
  const [togglingRole, setTogglingRole] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);

  useEffect(() => {
    setLoading(true);
    api('/users/' + userId)
      .then(d => setUser(d))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setTabLoading(true);
    setTabData(null);
    api('/users/' + userId + '/' + activeTab)
      .then(d => { if (!cancelled) setTabData(d); })
      .catch(() => { if (!cancelled) setTabData([]); })
      .finally(() => { if (!cancelled) setTabLoading(false); });
    return () => { cancelled = true; };
  }, [userId, activeTab]);

  if (loading) return html`<div class="loading-center"><div class="spinner" /></div>`;
  if (!user) return html`<div class="error-card">User not found</div>`;

  const tabs = ['sessions', 'memory', 'kyu', 'tasks', 'subagents', 'delegation'];
  if (__billingEnabled) tabs.push('subscription');

  const statusColor = { active: 'var(--green)', suspended: 'var(--red)', pending_verification: 'orange' };

  return html`
    <div class="page-header">
      <a href="#/users" style="color:var(--muted);font-size:13px;text-decoration:none;margin-bottom:8px;display:inline-block;">← Back to Users</a>
      <h2>${user.displayName || user.email || 'User'}</h2>
      <p>${user.email || ''}</p>
    </div>
    <div class="grid grid-3" style="margin-bottom:24px;">
      <div class="stat-card">
        <div class="stat-value">
          ${user.role}
        </div>
        <div class="stat-label">Role</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:${statusColor[user.status] || 'var(--fg)'}">${user.status}</div>
        <div class="stat-label">Status</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${user.telegramChatId || '—'}</div>
        <div class="stat-label">Telegram ID</div>
      </div>
    </div>
    ${user.workspace && html`
      <div class="card" style="margin-bottom:16px;padding:12px 16px;">
        <strong>Workspace:</strong> ${user.workspace.name} <code style="font-size:11px;margin-left:8px;">${user.workspace.id}</code>
      </div>
    `}
    ${html`
      <div class="card" style="margin-bottom:16px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="font-size:13px;font-weight:600;">Account Actions</span>
          
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
        ${html`<button class="btn" style="background:${user.role === 'admin' ? 'var(--red)' : 'var(--accent)'};opacity:${togglingRole ? 0.5 : 1};color:#fff;border:none;padding:6px 16px;font-size:13px;border-radius:6px;cursor:pointer;"
            disabled=${togglingRole}
            onClick=${async () => {
          const newRole = user.role === 'admin' ? 'user' : 'admin';
          if (!window.confirm('Change role to ' + newRole + '?')) return;
          setTogglingRole(true);
          try {
            await api('/users/' + userId + '/role', { method: 'PATCH', body: { role: newRole } });
            setUser({ ...user, role: newRole });
            showToast('Role updated to ' + newRole, 'success');
          } catch (e) { showToast('Failed: ' + e.message, 'error'); }
          setTogglingRole(false);
        }}>
            ${user.role === 'admin' ? 'Revoke' : 'Grant Admin'}
          </button>`}
          <button class="btn ${user.status === 'suspended' ? 'btn-primary' : ''}" style="${user.status !== 'suspended' ? 'background:var(--accent-orange);color:#fff;border:none;' : ''}padding:6px 16px;font-size:13px;border-radius:6px;cursor:pointer;opacity:${togglingStatus ? 0.5 : 1};"
            disabled=${togglingStatus}
            onClick=${async () => {
        const action = user.status === 'suspended' ? 'activate' : 'suspend';
        if (!window.confirm(action === 'suspend' ? 'Suspend this user? They will be unable to use the bot.' : 'Reactivate this user?')) return;
        setTogglingStatus(true);
        try {
          await api('/users/' + userId + '/' + action, { method: 'POST' });
          setUser({ ...user, status: action === 'suspend' ? 'suspended' : 'active' });
          showToast('User ' + (action === 'suspend' ? 'suspended' : 'activated'), 'success');
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
        setTogglingStatus(false);
      }}>
            ${user.status === 'suspended' ? 'Activate User' : 'Suspend User'}
          </button>
        <button class="btn" style="background:var(--accent-red);color:#fff;border:none;padding:6px 16px;font-size:13px;border-radius:6px;cursor:pointer;"
          onClick=${async () => {
        if (!window.confirm('Permanently delete this user and all their data? This cannot be undone.')) return;
        if (!window.confirm('Are you absolutely sure? Type the user email or click OK to confirm.')) return;
        try {
          await api('/users/' + userId, { method: 'DELETE' });
          showToast('User deleted', 'success');
          window.location.hash = '#/users';
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
      }}>
          Delete User
        </button>
        </div>
      </div>
    `}
    ${user.usage && user.usage.length > 0 && html`
      <div class="card" style="margin-bottom:16px;padding:12px 16px;">
        <strong>Usage (current month):</strong>
        <div style="margin-top:8px;display:flex;gap:16px;flex-wrap:wrap;font-size:13px;">
          ${user.usage.map(u => html`
            <span key=${u.model}><code>${u.model}</code>: ${u.call_count} calls, ${((u.input_tokens || 0) + (u.output_tokens || 0)).toLocaleString()} tokens</span>
          `)}
        </div>
      </div>
    `}
    <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:16px;">
      ${tabs.map(t => html`
        <button key=${t} onClick=${() => setActiveTab(t)}
          style="padding:10px 20px;border:none;cursor:pointer;background:none;color:${activeTab === t ? 'var(--accent)' : 'var(--muted)'};border-bottom:2px solid ${activeTab === t ? 'var(--accent)' : 'transparent'};font-size:13px;text-transform:capitalize;">
          ${t}
        </button>
      `)}
    </div>
    ${tabLoading ? html`<div class="loading-center"><div class="spinner" /></div>` :
      activeTab === 'sessions' ? html`<${UserTabSessions} data=${tabData} />` :
        activeTab === 'memory' ? html`<${UserTabMemory} data=${tabData} />` :
          activeTab === 'kyu' ? html`<${UserTabKyu} userId=${userId} data=${tabData} />` :
            activeTab === 'tasks' ? html`<${UserTabTasks} data=${tabData} />` :
              activeTab === 'subagents' ? html`<${UserTabSubagents} data=${tabData} />` :
                activeTab === 'delegation' ? html`<${UserTabDelegation} data=${tabData} userId=${userId} />` :
                  activeTab === 'subscription' ? html`<${UserTabSubscription} user=${user} />` :
                    null
    }
  `;
}

function UserTabDelegation({ data, userId }) {
  const delegations = Array.isArray(data?.delegations) ? data.delegations : [];
  const indexing = Array.isArray(data?.indexing) ? data.indexing : [];

  const statusBadge = (s) => {
    const colors = { completed: 'var(--accent-green)', running: 'var(--accent-blue)', error: 'var(--text-danger)', paused: 'var(--text-muted)' };
    return html`<span class="badge" style="background:${colors[s] || '#555'};font-size:11px">${s}</span>`;
  };
  const pct = (p) => p.totalMessages > 0 ? Math.round((p.indexedCount / p.totalMessages) * 100) : 0;

  const startIdx = async (wsId) => {
    await api('/mail-indexing/start', { method: 'POST', body: { workspaceId: wsId } });
    showToast('Indexing started', 'success');
  };
  const stopIdx = async (wsId) => {
    await api('/mail-indexing/stop', { method: 'POST', body: { workspaceId: wsId } });
    showToast('Indexing paused', 'success');
  };
  const resetIdx = async (wsId, delegationId) => {
    if (!confirm('Reset indexing? This will delete all indexed emails and restart from scratch.')) return;
    await api('/mail-indexing/reset', { method: 'POST', body: { workspaceId: wsId, delegationId } });
    showToast('Indexing reset initiated', 'success');
  };

  return html`
    <div>
      <h3 style="margin:0 0 12px;">📬 Delegated Email Accounts</h3>
      ${delegations.length === 0 ? html`<div class="empty-state"><p>No delegated email accounts for this user.</p></div>` : html`
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:20px;">
          ${delegations.map(d => html`
            <div class="card" key=${d.id} style="padding:10px 14px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                  <div style="font-weight:600;">${d.email}</div>
                  <div class="text-sm text-muted">
                    ${d.provider === 'gmail' ? 'Gmail API' : 'IMAP/SMTP'} · 
                    ${d.permissions?.read ? '📖 Read' : ''} ${d.permissions?.send ? '✍️ Send' : ''} · 
                    Workspace: ${d.workspaceId?.slice(0, 8)}
                  </div>
                </div>
              </div>
            </div>
          `)}
        </div>
      `}

      ${indexing.length > 0 && html`
        <h3 style="margin:0 0 12px;">🔍 Email Indexing</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${indexing.map(p => html`
            <div class="card" key=${p.delegationId} style="padding:12px 14px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <div>
                  <span style="font-weight:600;">${p.accountEmail}</span>
                  <span class="text-sm text-muted" style="margin-left:8px;">ws:${p.workspaceId?.slice(0, 8)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  ${statusBadge(p.status)}
                  ${p.status === 'running'
      ? html`<button class="btn btn-sm" onClick=${() => stopIdx(p.workspaceId)}>⏸ Pause</button>`
      : html`<button class="btn btn-sm btn-primary" onClick=${() => startIdx(p.workspaceId)}>▶ Start</button>`}
                  <button class="btn btn-sm" style="color:var(--text-danger)" onClick=${() => resetIdx(p.workspaceId, p.delegationId)}>🔄 Reset</button>
                </div>
              </div>
              <div style="width:100%;height:6px;background:var(--bg-secondary);border-radius:3px;overflow:hidden;margin-bottom:4px;">
                <div style="width:${pct(p)}%;height:100%;background:var(--accent-blue);transition:width 0.5s;"></div>
              </div>
              <div class="text-sm text-muted" style="display:flex;justify-content:space-between;">
                <span>${p.indexedCount} / ${p.totalMessages} indexed${p.skippedSensitive ? `, ${p.skippedSensitive} sensitive skipped` : ''}</span>
                <span>${pct(p)}%</span>
              </div>
              ${p.error && html`<div class="text-sm" style="color:var(--text-danger);margin-top:4px;">${p.error}</div>`}
            </div>
          `)}
        </div>
      `}
    </div>
  `;
}

function UserTabSessions({ data }) {
  if (!Array.isArray(data) || data.length === 0) return html`<div class="empty-state"><p>No sessions found</p></div>`;
  const sessions = data.filter(s => s && s.sessionId);
  if (sessions.length === 0) return html`<div class="empty-state"><p>No sessions found</p></div>`;
  return html`
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${sessions.map(s => {
    const info = sessionDisplayInfo(s);
    return html`
          <div key=${s.sessionId} class="card cursor-pointer" style="padding:10px 14px;" onClick=${() => navigate('/sessions/' + s.sessionId)}>
            <div class="flex justify-between items-center">
              <div class="flex items-center" style="gap:10px;">
                <span style="font-size:18px;">${info.icon}</span>
                <div>
                  <div style="font-weight:600;font-size:13px;">${info.label}</div>
                  <div class="text-muted" style="font-size:11px;">${info.chLabel} · ${relativeTime(s.lastActivityAt || s.startedAt)}</div>
                </div>
              </div>
              <span class="badge badge-blue" style="font-size:11px;">${s.entryCount ?? s.messageCount ?? 0}</span>
            </div>
          </div>`;
  })}
    </div>
  `;
}

function UserTabMemory({ data }) {
  if (!Array.isArray(data) || data.length === 0) return html`<div class="empty-state"><p>No memory entries</p></div>`;
  return html`
    <div class="card">
      ${data.map((m, i) => html`
        <div key=${m.id || i} style="padding:12px 16px;border-bottom:1px solid var(--border);">
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">[${m.id || ''}] ${m.timestamp || ''}</div>
          <div style="font-size:13px;white-space:pre-wrap;">${m.content}</div>
        </div>
      `)}
    </div>
  `;
}

function UserTabKyu({ userId, data }) {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (data && typeof data === 'object' && data.content !== undefined) {
      setContent(data.content || '');
      setLoaded(true);
    }
  }, [data]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api('/users/' + userId + '/kyu', { method: 'PUT', body: { content } });
      showToast('KYU profile saved', 'success');
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    finally { setSaving(false); }
  };

  if (!loaded) return html`<div class="loading-center"><div class="spinner" /></div>`;

  return html`
    <div class="card" style="padding:16px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <span style="font-size:18px;">👤</span>
        <h3 style="margin:0;font-size:15px;">Know Your User (KYU) Profile</h3>
      </div>
      <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">
        This profile is automatically built by the KYU agent after each conversation. It captures user preferences, interests, goals, and personality traits to help the assistant personalize its responses.
      </p>
      ${content ? html`
        <textarea class="code-editor w-full" value=${content} onInput=${e => setContent(e.target.value)} spellcheck=${false} style="min-height:300px;" />
        <div class="flex justify-between items-center mt-16">
          <span style="font-size:11px;color:var(--muted);">${content.length} chars</span>
          <button class="btn btn-primary" onClick=${handleSave} disabled=${saving}>${saving ? 'Saving...' : 'Save'}</button>
        </div>
      ` : html`
        <div class="empty-state"><p>No KYU profile yet. It will be created automatically after conversations with this user.</p></div>
      `}
    </div>
  `;
}

function UserTabTasks({ data }) {
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null);

  if (!Array.isArray(data) || data.length === 0) return html`<div class="empty-state"><p>No scheduled tasks</p></div>`;

  const viewDetail = async (id) => {
    if (expandedId === id) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(id);
    try {
      const d = await api('/tasks/' + id);
      setDetail(d);
    } catch { setDetail(null); }
  };

  return html`
    <div class="card">
      ${data.map(t => html`
        <div key=${t.id} style="padding:12px 16px;border-bottom:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onClick=${() => viewDetail(t.id)}>
            <div>
              <div style="font-weight:600;font-size:14px;">${t.name}</div>
              <div style="font-size:12px;color:var(--muted);margin-top:2px;">
                ${cronToHumanJs(t.cronExpression)} <span style="opacity:0.6">(${t.cronExpression})</span> · ${t.enabled ? '🟢 Active' : '⏸ Paused'}${t.lastRun ? ` · Last: ${new Date(t.lastRun).toLocaleString()}` : ''}
              </div>
            </div>
            <span style="font-size:14px;color:var(--muted);">${expandedId === t.id ? '▼' : '▶'}</span>
          </div>
          ${t.prompt ? html`<div style="margin-top:6px;font-size:12px;color:var(--muted);white-space:pre-wrap;">${t.prompt.length > 120 ? t.prompt.slice(0, 120) + '…' : t.prompt}</div>` : ''}
          ${expandedId === t.id && detail ? html`
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
              <div style="font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:600;">Full Prompt</div>
              <pre style="background:var(--bg-tertiary);padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap;max-height:200px;overflow:auto;">${detail.prompt || '(none)'}</pre>
              ${detail.logs?.length ? html`
                <div style="font-size:12px;color:var(--muted);margin:12px 0 6px;font-weight:600;">Recent Runs (${detail.logs.length})</div>
                ${detail.logs.map(log => html`
                  <div style="padding:6px 8px;margin-bottom:4px;background:var(--bg-tertiary);border-radius:4px;font-size:12px;display:flex;justify-content:space-between;gap:12px;">
                    <span><span class="badge ${log.status === 'success' ? 'badge-green' : 'badge-yellow'}" style="font-size:10px;">${log.status}</span> ${new Date(log.startedAt || log.started_at).toLocaleString()}</span>
                    <span style="color:var(--muted);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(log.output || log.error || '').slice(0, 100)}</span>
                  </div>
                `)}
              ` : html`<div style="font-size:12px;color:var(--muted);margin-top:8px;">No execution history.</div>`}
            </div>
          ` : ''}
        </div>
      `)}
    </div>
  `;
}

function UserTabSubagents({ data }) {
  if (!Array.isArray(data) || data.length === 0) return html`<div class="empty-state"><p>No sub-agents</p></div>`;
  return html`
    <div class="card">
      ${data.map(a => html`
        <div key=${a.id} style="padding:12px 16px;border-bottom:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>${a.name}</strong>
            <span style="font-size:11px;color:var(--muted);">${a.status}</span>
          </div>
          <div style="font-size:13px;color:var(--muted);margin-top:4px;">${a.description || ''}</div>
          ${a.model && html`<div style="font-size:11px;margin-top:4px;">Model: <code>${a.model}</code></div>`}
        </div>
      `)}
    </div>
  `;
}

function UserTabSubscription({ user }) {
  if (!user) return null;
  return html`
    <div class="card" style="padding:20px;">
      <div class="grid grid-2" style="gap:16px;">
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">Subscription Status</div>
          <div style="font-size:16px;font-weight:600;">${user.subscriptionStatus || 'none'}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">Plan</div>
          <div style="font-size:16px;font-weight:600;">${user.planId || '—'}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">Stripe Customer</div>
          <div style="font-size:13px;"><code>${user.stripeCustomerId || '—'}</code></div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">Stripe Subscription</div>
          <div style="font-size:13px;"><code>${user.stripeSubscriptionId || '—'}</code></div>
        </div>
      </div>
    </div>
  `;
}

// ─── Main App ────────────────────────────────────────────────────────────────

function App() {
  const { path, segments } = useRoute();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [modeReady, setModeReady] = useState(false);
  const [pendingReload, setPendingReload] = useState(false);

  useEffect(() => {
    const handler = () => setPendingReload(true);
    window.addEventListener('config-saved', handler);
    return () => window.removeEventListener('config-saved', handler);
  }, []);

  const handleReload = async () => {
    if (!confirm('Reload Kora settings? Active connections will not be interrupted.')) return;
    try {
      const r = await api('/reload', { method: 'POST' });
      showToast(r.message || 'Settings reloaded successfully', 'success');
      setPendingReload(false);
    } catch (e) { showToast('Reload failed: ' + e.message, 'error'); }
  };

  useEffect(() => {
    fetch('/admin/api/auth/check', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(async (d) => {
        setAuthenticated(d.authenticated);
        if (d.authenticated) {
          try {
            const s = await api('/status');
            if (s && s.multiUserEnabled !== undefined) __multiUserEnabled = !!s.multiUserEnabled;
            if (s && s.billingEnabled !== undefined) __billingEnabled = !!s.billingEnabled;
          } catch { }
        }
        setModeReady(true);
        setAuthChecked(true);
      })
      .catch(() => {
        setAuthenticated(false);
        setModeReady(true);
        setAuthChecked(true);
      });
  }, []);

  if (!authChecked || !modeReady) return html`<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:var(--muted);">Loading...</div>`;
  if (!authenticated) return html`<${LoginPage} onLogin=${async () => {
    try {
      const s = await api('/status');
      if (s && s.multiUserEnabled !== undefined) __multiUserEnabled = !!s.multiUserEnabled;
      if (s && s.billingEnabled !== undefined) __billingEnabled = !!s.billingEnabled;
    } catch { }
    setAuthenticated(true);
  }} />`;

  let content;
  if (path === '/' || path === '') content = html`<${Dashboard} />`;
  else if (path === '/live') content = html`<${LiveLog} />`;
  else if (path === '/users' && segments.length === 1) content = html`<${UsersPage} />`;
  else if (segments[0] === 'users' && segments[1] && segments.length === 2) content = html`<${UserDetailPage} userId=${segments[1]} />`;
  else if (path === '/sessions' && segments.length === 1) content = html`<${Sessions} />`;
  else if (segments[0] === 'sessions' && segments[1]) content = html`<${SessionDetail} sessionId=${segments[1]} />`;
  else if (path === '/tasks') content = html`<${Tasks} />`;
  else if (path === '/config') content = html`<${ConfigEditor} />`;
  else if (path === '/tools') content = html`<${ToolsAndMcp} />`;
  else if (path === '/memory') content = html`<${MemoryPage} />`;
  else if (path === '/security') content = html`<${SecurityPage} />`;
  else if (path === '/agents') content = html`<${SubAgentsPage} />`;
  else content = html`<div class="empty-state"><div class="empty-state-icon">🔍</div><p>Page not found</p><a href="#/" class="btn btn-secondary mt-16">Dashboard</a></div>`;

  const handleLogout = async () => {
    try { await api('/logout', { method: 'POST' }); } catch { }
    document.cookie = 'korabot_session=; Max-Age=0; path=/';
    window.location.reload();
  };

  return html`
    <${ToastContainer} />
    <${Sidebar} currentPath=${path} open=${sidebarOpen} onToggle=${setSidebarOpen} onLogout=${handleLogout} />
    <main class="main-content">
      ${pendingReload && html`
        <div class="reload-bar">
          <span>Settings saved — reload required to apply changes.</span>
          <button class="btn" onClick=${handleReload}>↻ Reload Now</button>
        </div>
      `}
      ${content}
    </main>
    <${BottomNav} currentPath=${path} onLogout=${handleLogout} />
  `;
}

render(html`<${App} />`, document.getElementById('app'));
