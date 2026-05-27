import Electrobun, { Electroview } from "electrobun/view";
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.use({ gfm: true, breaks: true });

type KoraRPC = {
  bun: {
    requests: {
      httpFetch: {
        params: {
          url: string;
          method: string;
          headers: Record<string, string>;
          body: string | null;
        };
        response: {
          ok: boolean;
          status: number;
          statusText: string;
          bodyText: string;
          contentType: string;
        };
      };
      openExternal: { params: { url: string }; response: { ok: boolean } };
      wsOpen: { params: { url: string }; response: { ok: boolean; error?: string } };
      wsSend: { params: { text: string }; response: { ok: boolean } };
      wsClose: { params: Record<string, never>; response: { ok: boolean } };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      wsEvent: { type: string; data?: string; error?: string };
    };
  };
};

let wsReady = false;
const wsOpenWaiters: Array<() => void> = [];

function flushWsOpenWaiters(): void {
  const w = wsOpenWaiters.splice(0, wsOpenWaiters.length);
  for (const fn of w) fn();
}

function waitForWsOpen(timeoutMs: number): Promise<boolean> {
  if (wsReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const i = wsOpenWaiters.indexOf(onOpen);
      if (i >= 0) wsOpenWaiters.splice(i, 1);
      resolve(ok);
    };
    const onOpen = () => finish(true);
    wsOpenWaiters.push(onOpen);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function updateConnectionStatus() {
  const dot = $("#connection-dot") as HTMLElement | null;
  const label = $("#connection-label") as HTMLElement | null;
  if (dot) dot.className = `conn-dot ${wsReady ? "connected" : "disconnected"}`;
  if (label) label.textContent = wsReady ? "Connected (WS)" : "Disconnected";
}

function resetSendState() {
  state.replyExpected = false;
  state.sending = false;
  updateSendBtn();
  if (messageInput) messageInput.placeholder = "Type a message...";
}

function handleWsEvent(msg: { type: string; data?: string }) {
  if (msg.type === "open") {
    wsReady = true;
    flushWsOpenWaiters();
    updateConnectionStatus();
  }
  if (msg.type === "close" || msg.type === "error") {
    wsReady = false;
    updateConnectionStatus();
  }
  if (msg.type === "message" && msg.data) {
    try {
      const parsed = JSON.parse(msg.data) as Record<string, unknown>;
      if (parsed.type === "notification") {
        removeWorkingStatus();
        appendMessage("assistant", String(parsed.content ?? ""));
        if (state.sending) showWorkingStatus(null);
      } else if (parsed.type === "tool_status") {
        const tool = String(parsed.tool ?? "");
        const phase = String(parsed.phase ?? "");
        if (phase === "start" && tool) {
          showWorkingStatus(tool);
        } /*else if (phase === "end") {
          showWorkingStatus(null);
        }*/
      } else if (parsed.type === "reply_requested") {
        removeWorkingStatus();
        state.replyExpected = true;
        state.sending = false;
        updateSendBtn();
        if (messageInput) messageInput.placeholder = "Agent is waiting for your reply...";
        messageInput?.focus();
      } else if (parsed.type === "set_typing") {
        if (parsed.active) {
          showWorkingStatus(null);
        } else {
          removeWorkingStatus();
        }
      } else if (parsed.type === "user_message") {
        if (!state.sending) {
          appendMessage("user", String(parsed.content ?? ""));
        }
      } else if (parsed.type === "assistant_message") {
        removeWorkingStatus();
        appendMessage("assistant", String(parsed.content ?? ""));
        resetSendState();
      } else if (parsed.type === "done") {
        removeWorkingStatus();
        resetSendState();
      } else if (parsed.type === "error") {
        removeWorkingStatus();
        appendMessage("notification", `Error: ${String(parsed.error ?? "")}`);
        resetSendState();
      }
    } catch {
      /* ignore */
    }
  }
}

const rpc = Electroview.defineRPC<KoraRPC>({
  maxRequestTime: Infinity,
  handlers: {
    requests: {},
    messages: {
      wsEvent: (payload) => {
        handleWsEvent(payload);
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

const state = {
  token: localStorage.getItem("korabot_token") || "",
  serverUrl: localStorage.getItem("korabot_server") || "http://localhost:3100",
  email: localStorage.getItem("korabot_email") || "",
  workspaceId: "",
  sessions: [] as Array<{ id: string; title?: string; last_message_at?: string; created_at?: string }>,
  activeSession: null as string | null,
  messages: [] as Array<{ role: string; content: string; created_at?: string }>,
  sending: false,
  replyExpected: false,
};

let devicePollTimer: ReturnType<typeof setInterval> | null = null;

const $ = (sel: string) => window.document.querySelector(sel);
const $$ = (sel: string) => window.document.querySelectorAll(sel);

async function httpViaBun(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<Response> {
  const raw = await electrobun.rpc!.request.httpFetch({
    url,
    method,
    headers,
    body,
  });
  return new Response(raw.bodyText, {
    status: raw.status,
    statusText: raw.statusText,
    headers: new Headers({ "content-type": raw.contentType || "application/json" }),
  });
}

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const url = `${state.serverUrl}/api/v1${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${state.token}`,
    ...(opts.headers as Record<string, string> | undefined),
  };
  let body: string | null = null;
  if (opts.body != null) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await httpViaBun(url, (opts.method || "GET").toUpperCase(), headers, body);
  if (res.status === 401) {
    logout();
    throw new Error("Session expired");
  }
  return res;
}

function showScreen(name: string) {
  $$(".screen").forEach((el) => el.classList.remove("active"));
  $(`#${name}-screen`)?.classList.add("active");
  if (name === "login") {
    const btn = $("#login-btn") as HTMLButtonElement;
    if (btn) {
      btn.style.display = "";
      btn.disabled = false;
    }
  }
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return formatTime(dateStr);
  if (diff < 7 * 86400000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

let messageInput: HTMLTextAreaElement | null = null;
let sendButton: HTMLButtonElement | null = null;

function logout() {
  state.token = "";
  state.sessions = [];
  state.activeSession = null;
  state.messages = [];
  wsReady = false;
  void electrobun.rpc!.request.wsClose({});
  localStorage.removeItem("korabot_token");
  showScreen("login");
}

async function initChat() {
  showScreen("chat");
  const userInfo = $("#user-info");
  if (userInfo) userInfo.textContent = state.email;
  await loadSessions();
}

async function loadSessions() {
  try {
    const res = await api("/sessions");
    const data = (await res.json()) as { sessions?: typeof state.sessions };
    state.sessions = data.sessions || [];
    renderSessions();
  } catch {
    /* ignore */
  }
}

function renderSessions() {
  const list = $("#session-list");
  if (!list) return;

  const mainEntry = `
    <div class="session-item ${state.activeSession === "main" ? "active" : ""}" data-id="main" style="border-left:3px solid var(--accent)">
      <div class="session-title">📱 Main Session (Telegram)</div>
      <div class="session-date">Shared conversation</div>
    </div>`;

  if (state.sessions.length === 0) {
    list.innerHTML = mainEntry +
      '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px">No other conversations</div>';
  } else {
    list.innerHTML = mainEntry + state.sessions
      .map(
        (s) => `
      <div class="session-item ${s.id === state.activeSession ? "active" : ""}" data-id="${s.id}">
        <div class="session-title">${escapeHtml(s.title || "")}</div>
        <div class="session-date">${formatDate(s.last_message_at || s.created_at || "")}</div>
      </div>
    `,
      )
      .join("");
  }

  list.querySelectorAll(".session-item").forEach((el) => {
    el.addEventListener("click", () => selectSession((el as HTMLElement).dataset.id || ""));
  });
}

async function selectSession(id: string) {
  state.activeSession = id;
  const isMain = id === "main";
  const session = !isMain ? state.sessions.find((s) => s.id === id) : null;
  const titleEl = $("#chat-title");
  if (titleEl) titleEl.textContent = isMain ? "Main Session (Telegram)" : (session?.title || "Chat");
  const inputArea = $("#chat-input-area") as HTMLElement;
  if (inputArea) inputArea.style.display = "";
  const delBtn = $("#delete-session-btn") as HTMLElement;
  if (delBtn) delBtn.style.display = isMain ? "none" : "";
  renderSessions();
  if (isMain) {
    state.messages = [];
    renderMessages();
  } else {
    await loadMessages(id);
  }
  await connectWebSocket(id);
}

async function loadMessages(sessionId: string) {
  try {
    const res = await api(`/sessions/${sessionId}/messages`);
    const data = (await res.json()) as { messages?: typeof state.messages };
    state.messages = data.messages || [];
    renderMessages();
  } catch {
    /* ignore */
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function messageBodyHtml(role: string, content: string): string {
  if (role === "user") return escapeHtml(content);
  const raw = marked(content, { async: false });
  return DOMPurify.sanitize(raw);
}

function renderMessages() {
  const container = $("#messages");
  if (!container) return;
  if (state.messages.length === 0) {
    container.innerHTML =
      '<div class="empty-state"><div class="empty-icon">✨</div><p>Send a message to start the conversation</p></div>';
    return;
  }
  container.innerHTML = state.messages
    .map((m) => {
      const displayRole = m.role === "notification" ? "assistant" : m.role;
      const md = displayRole === "assistant";
      const body = md ? messageBodyHtml(displayRole, m.content) : escapeHtml(m.content);
      const bodyClass = md ? "message-body markdown-body" : "message-body";
      return `
    <div class="message ${displayRole}">
      <div class="${bodyClass}">${body}</div>
      <div class="msg-time">${formatTime(m.created_at || new Date().toISOString())}</div>
    </div>`;
    })
    .join("");
  container.scrollTop = container.scrollHeight;
}

function appendMessage(role: string, content: string) {
  const container = $("#messages");
  if (!container) return;
  if (container.querySelector(".empty-state")) container.innerHTML = "";
  container.querySelector(".typing-indicator")?.remove();

  const md = role === "assistant" || role === "notification";
  const body = md ? messageBodyHtml(role, content) : escapeHtml(content);
  const bodyClass = md ? "message-body markdown-body" : "message-body";

  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `<div class="${bodyClass}">${body}</div><div class="msg-time">${formatTime(new Date().toISOString())}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showWorkingStatus(toolName: string | null) {
  const container = $("#messages");
  if (!container) return;
  let indicator = container.querySelector(".working-indicator") as HTMLElement | null;
  if (!indicator) {
    container.querySelector(".typing-indicator")?.remove();
    indicator = document.createElement("div");
    indicator.className = "working-indicator";
    container.appendChild(indicator);
  }
  if (toolName) {
    const displayName = toolName.replace(/_/g, " ");
    indicator.innerHTML = `<span class="working-spinner"></span> Running <strong>${escapeHtml(displayName)}</strong>`;
  } else {
    indicator.innerHTML = `<span class="working-spinner"></span> Working...`;
  }
  container.scrollTop = container.scrollHeight;
}

function removeWorkingStatus() {
  const container = $("#messages");
  if (!container) return;
  container.querySelector(".working-indicator")?.remove();
  container.querySelector(".typing-indicator")?.remove();
}

function showTyping() {
  const container = $("#messages");
  if (!container || container.querySelector(".working-indicator") || container.querySelector(".typing-indicator")) return;
  showWorkingStatus(null);
}

function removeTyping() {
  removeWorkingStatus();
}

async function connectWebSocket(sessionId: string) {
  wsReady = false;
  await electrobun.rpc!.request.wsClose({});
  const wsUrl = `${state.serverUrl.replace(/^http/, "ws")}/api/v1/ws?token=${encodeURIComponent(state.token)}&session=${encodeURIComponent(sessionId)}`;
  const opened = await electrobun.rpc!.request.wsOpen({ url: wsUrl });
  if (!opened.ok) {
    appendMessage("notification", `WebSocket failed: ${opened.error || "unknown"}`);
  }
}

function updateSendBtn() {
  if (sendButton && messageInput) sendButton.disabled = !messageInput.value.trim() || state.sending;
}

async function sendMessage() {
  if (!messageInput) return;
  const content = messageInput.value.trim();
  if (!content || !state.activeSession) return;
  if (state.sending && !state.replyExpected) return;

  const isReply = state.replyExpected;

  state.sending = true;
  state.replyExpected = false;
  messageInput.value = "";
  messageInput.style.height = "auto";
  messageInput.placeholder = "Type a message...";
  updateSendBtn();

  appendMessage("user", content);
  showTyping();

  if (!wsReady) {
    await waitForWsOpen(20000);
  }

  if (wsReady) {
    const msgType = isReply ? "reply" : "message";
    await electrobun.rpc!.request.wsSend({ text: JSON.stringify({ type: msgType, content }) });
  } else {
    try {
      const res = await api(`/sessions/${state.activeSession}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      const data = (await res.json()) as {
        notifications?: string[];
        assistantMessage?: { content: string };
      };
      removeTyping();
      if (data.notifications) {
        data.notifications.forEach((n) => appendMessage("assistant", n));
      }
      if (data.assistantMessage) {
        appendMessage("assistant", data.assistantMessage.content);
      }
    } catch (err) {
      removeTyping();
      appendMessage("notification", `Failed to send: ${(err as Error).message}`);
    }
    state.sending = false;
    updateSendBtn();
  }

  const session = state.sessions.find((s) => s.id === state.activeSession);
  if (session && session.title === "New Chat" && content.length > 0) {
    const newTitle = content.slice(0, 40) + (content.length > 40 ? "..." : "");
    session.title = newTitle;
    renderSessions();
    const titleEl = $("#chat-title");
    if (titleEl) titleEl.textContent = newTitle;
    api(`/sessions/${state.activeSession}`, {
      method: "PATCH",
      body: JSON.stringify({ title: newTitle }),
    }).catch(() => { });
  }
}

function finishLoginWith(data: Record<string, unknown>) {
  state.token = String(data.token || "");
  state.email = String(data.email || state.email);
  state.workspaceId = String(data.workspaceId || "");
  localStorage.setItem("korabot_token", state.token);
  localStorage.setItem("korabot_server", state.serverUrl);
  localStorage.setItem("korabot_email", state.email);
  void initChat();
}

function stopDevicePoll() {
  if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
}

async function startDeviceLogin() {
  const btn = $("#login-btn") as HTMLButtonElement;
  const error = $("#login-error") as HTMLElement;
  const waiting = $("#login-waiting") as HTMLElement;

  const serverUrl = ($("#server-url") as HTMLInputElement).value.replace(/\/$/, "");
  state.serverUrl = serverUrl;
  localStorage.setItem("korabot_server", serverUrl);

  btn.disabled = true;
  error.style.display = "none";

  try {
    const res = await httpViaBun(
      `${serverUrl}/api/v1/auth/device`,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({}),
    );
    const data = (await res.json()) as { deviceCode?: string; expiresIn?: number; error?: string };
    if (data.error || !data.deviceCode) throw new Error(data.error || "Failed to initiate login");

    const deviceCode = data.deviceCode;
    const portalUrl = `${serverUrl}/login?device_code=${encodeURIComponent(deviceCode)}`;
    console.log("portalUrl", portalUrl);
    await electrobun.rpc!.request.openExternal({ url: portalUrl });

    btn.style.display = "none";
    waiting.style.display = "";

    devicePollTimer = setInterval(async () => {
      try {
        const pollRes = await httpViaBun(
          `${serverUrl}/api/v1/auth/device/poll`,
          "POST",
          { "Content-Type": "application/json" },
          JSON.stringify({ deviceCode }),
        );
        const poll = (await pollRes.json()) as { pending?: boolean; token?: string; email?: string; workspaceId?: string; error?: string };
        if (poll.error === "expired") {
          stopDevicePoll();
          error.textContent = "Login timed out. Please try again.";
          error.style.display = "block";
          btn.style.display = "";
          btn.disabled = false;
          waiting.style.display = "none";
          return;
        }
        if (poll.token) {
          stopDevicePoll();
          waiting.style.display = "none";
          finishLoginWith(poll);
        }
      } catch { /* keep polling */ }
    }, 3000);
  } catch (err) {
    error.textContent = (err as Error).message;
    error.style.display = "block";
    btn.disabled = false;
  }
}

function wireDom(): void {
  $("#login-btn")?.addEventListener("click", () => void startDeviceLogin());

  $("#login-cancel")?.addEventListener("click", (e) => {
    e.preventDefault();
    stopDevicePoll();
    const btn = $("#login-btn") as HTMLElement;
    const waiting = $("#login-waiting") as HTMLElement;
    if (btn) { btn.style.display = ""; (btn as HTMLButtonElement).disabled = false; }
    if (waiting) waiting.style.display = "none";
  });

  $("#logout-btn")?.addEventListener("click", async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    logout();
  });

  $("#new-session-btn")?.addEventListener("click", async () => {
    try {
      const res = await api("/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "New Chat" }),
      });
      const data = (await res.json()) as { id: string };
      await loadSessions();
      await selectSession(data.id);
    } catch {
      /* ignore */
    }
  });

  $("#delete-session-btn")?.addEventListener("click", async () => {
    if (!state.activeSession) return;
    if (!confirm("Delete this conversation?")) return;
    try {
      await api(`/sessions/${state.activeSession}`, { method: "DELETE" });
      state.activeSession = null;
      const titleEl = $("#chat-title");
      if (titleEl) titleEl.textContent = "Select a conversation";
      const inputArea = $("#chat-input-area") as HTMLElement;
      if (inputArea) inputArea.style.display = "none";
      const delBtn = $("#delete-session-btn") as HTMLElement;
      if (delBtn) delBtn.style.display = "none";
      const messages = $("#messages");
      if (messages) {
        messages.innerHTML =
          '<div class="empty-state"><div class="empty-icon">💬</div><p>Start a new conversation or select one from the sidebar</p></div>';
      }
      await loadSessions();
    } catch {
      /* ignore */
    }
  });

  messageInput = $("#message-input") as HTMLTextAreaElement | null;
  sendButton = $("#send-btn") as HTMLButtonElement | null;

  messageInput?.addEventListener("input", () => {
    updateSendBtn();
    if (!messageInput) return;
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
  });

  messageInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  });

  sendButton?.addEventListener("click", () => void sendMessage());

  const su = document.querySelector("#server-url") as HTMLInputElement;
  if (su) su.value = state.serverUrl;

  $("#messages")?.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    if (href.includes("://")) {
      e.preventDefault();
      electrobun.rpc?.request.openExternal({ url: href }).catch(() => { });
    }
  });

  if (state.token) {
    api("/me")
      .then((r) => r.json())
      .then((d: { userId?: string; workspaceId?: string }) => {
        if (d.userId) {
          state.workspaceId = d.workspaceId || "";
          void initChat();
        } else {
          logout();
        }
      })
      .catch(() => logout());
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireDom);
} else {
  wireDom();
}