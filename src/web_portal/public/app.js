import { html, render, useState, useEffect, useCallback } from 'https://esm.sh/htm@3/preact/standalone?bundle';

const API = '/api';

async function api(path, opts = {}) {
  const headers = { ...opts.headers };
  if (opts.body && typeof opts.body === 'object') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  if (opts.csrf) headers['X-CSRF-Token'] = opts.csrf;
  const res = await fetch(`${API}${path}`, { ...opts, headers, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !opts.rawErrors) {
    window.__portalLogout?.();
    return null;
  }
  return data;
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
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n/g, '<br/>');
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

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('login');
  const [deviceCode] = useState(() => new URLSearchParams(window.location.search).get('device_code'));
  const [subscriptionSuccess] = useState(() => new URLSearchParams(window.location.search).get('subscription') === 'active');

  const checkAuth = useCallback(async () => {
    const r = await fetch(`${API}/auth/check`, { credentials: 'same-origin' });
    const d = await r.json();
    if (d.authenticated) {
      if (deviceCode) {
        try { await api('/device/approve', { method: 'POST', body: { deviceCode } }); } catch { }
        setView('device-approved');
        setLoading(false);
        return;
      }
      const me = await api('/me');
      if (me) { setUser(me); setView('dashboard'); }
      else setView('login');
    } else { setView('login'); }
    setLoading(false);
  }, [deviceCode]);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  window.__portalLogout = () => { setUser(null); setView('login'); };

  const handleLogin = async (u) => {
    if (deviceCode) {
      try {
        await api('/device/approve', { method: 'POST', body: { deviceCode } });
      } catch { }
      setView('device-approved');
      return;
    }
    setUser(u); setView('dashboard');
  };
  const handleLogout = async () => {
    await api('/logout', { method: 'POST', csrf: user?.csrfToken });
    setUser(null); setView('login');
  };

  if (loading) return html`<div class="login-page"><p style="color:#7d8590">Loading...</p></div>`;
  if (subscriptionSuccess && view === 'login') return html`
    <div class="login-page">
      <div class="auth-card" style="text-align:center">
        <div style="font-size:48px;margin-bottom:16px">✅</div>
        <h2 style="margin-bottom:8px">Subscription Activated!</h2>
        <p style="color:#7d8590;margin-bottom:16px">Your subscription is now active. You can start using the AI agent on Telegram.</p>
        <p style="color:#7d8590;font-size:13px;margin-bottom:16px">Use <b>/link</b> in Telegram to set up your web portal account.</p>
        <button class="btn btn-secondary" onClick=${() => { window.history.replaceState({}, '', '/'); window.location.reload(); }}>Go to Portal</button>
      </div>
    </div>`;
  if (view === 'device-approved') return html`
    <div class="login-page">
      <div class="auth-card" style="text-align:center">
        <div style="font-size:48px;margin-bottom:16px">✅</div>
        <h2 style="margin-bottom:8px">Login Successful</h2>
        <p style="color:#7d8590;margin-bottom:16px">Your desktop app has been authorized. You can close this tab.</p>
      </div>
    </div>`;
  if (view === 'login') return html`<${AuthPage} onLogin=${handleLogin} deviceCode=${deviceCode} />`;
  return html`<${Portal} user=${user} onLogout=${handleLogout} />`;
}

function AuthPage({ onLogin, deviceCode }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [verificationUserId, setVerificationUserId] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  const [twoFAState, setTwoFAState] = useState(null);
  const [totpCode, setTotpCode] = useState('');
  const [passkeyResetData, setPasskeyResetData] = useState(null);

  const switchMode = (m) => { setMode(m); setError(''); setInfo(''); setTwoFAState(null); };

  const finishLogin = async () => {
    const me = await api('/me');
    if (me) onLogin(me);
  };

  const handleLogin = async (e) => {
    e.preventDefault(); setError(''); setLoading(true);
    const r = await api('/login', { method: 'POST', body: { email, password }, rawErrors: true });
    setLoading(false);
    if (!r) { setError('Connection error. Please try again.'); return; }
    if (r.error) { setError(r.error); return; }
    if (r.needs2FASetup) {
      setTwoFAState({ step: 'setup-choose', tempToken: r.tempToken });
      setMode('2fa');
      return;
    }
    if (r.needs2FA) {
      setTwoFAState({ step: 'verify', method: r.method, tempToken: r.tempToken, challengeKey: r.challengeKey, options: r.options });
      setMode('2fa');
      return;
    }
    await finishLogin();
  };

  const handleRegister = async (e) => {
    e.preventDefault(); setError(''); setLoading(true);
    const r = await api('/register', { method: 'POST', body: { code, email, password, displayName }, rawErrors: true });
    setLoading(false);
    if (!r) { setError('Connection error. Please try again.'); return; }
    if (r.error) { setError(r.error); return; }
    if (r.requiresVerification) { setVerificationUserId(r.userId); switchMode('verify'); return; }
    await finishLogin();
  };

  const handleVerify = async (e) => {
    e.preventDefault(); setError(''); setLoading(true);
    const r = await api('/verify-email', { method: 'POST', body: { code: verifyCode }, rawErrors: true });
    setLoading(false);
    if (!r) { setError('Connection error. Please try again.'); return; }
    if (r.error) { setError(r.error); return; }
    await finishLogin();
  };

  const handleResendVerification = async () => {
    setError(''); setInfo(''); setLoading(true);
    const r = await api('/resend-verification', { method: 'POST', body: { userId: verificationUserId }, rawErrors: true });
    setLoading(false);
    if (r?.ok) setInfo('Verification code resent. Check your inbox.');
    else setError(r?.error || 'Failed to resend code.');
  };

  const handleForgotRequest = async (e) => {
    e.preventDefault(); setError(''); setInfo(''); setLoading(true);
    const r = await api('/password-reset/request', { method: 'POST', body: { email }, rawErrors: true });
    setLoading(false);
    if (!r) { setError('Connection error.'); return; }
    if (r.error) { setError(r.error); return; }
    setInfo('If an account exists with that email, a reset code has been sent. You can also request a code via Telegram with /resetpassword.');
    switchMode('reset-confirm');
  };

  const handleResetConfirm = async (e) => {
    e.preventDefault(); setError(''); setLoading(true);
    const r = await api('/password-reset/confirm', { method: 'POST', body: { code: resetCode, newPassword }, rawErrors: true });
    setLoading(false);
    if (!r) { setError('Connection error.'); return; }
    if (r.error) { setError(r.error); return; }
    setInfo('Password reset successfully. You can now log in. (Note: 2FA has been cleared and will need to be set up again.)');
    switchMode('login');
  };

  const handlePasskeyResetStart = async () => {
    setError(''); setLoading(true);
    const r = await api('/password-reset/passkey-start', { method: 'POST', body: { email }, rawErrors: true });
    setLoading(false);
    if (!r) { setError('Connection error.'); return; }
    if (r.hasPasskey) {
      setPasskeyResetData(r);
      switchMode('reset-passkey');
    } else {
      setInfo('No passkey found for this account. Use email reset instead.');
    }
  };

  const handlePasskeyResetComplete = async () => {
    if (!passkeyResetData || !newPassword) return;
    setError(''); setLoading(true);
    try {
      const { startAuthentication } = await import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/dist/bundle/index.js');
      const credential = await startAuthentication({ optionsJSON: passkeyResetData.options });
      const r = await api('/password-reset/passkey-complete', {
        method: 'POST',
        body: { tempToken: passkeyResetData.tempToken, challengeKey: passkeyResetData.challengeKey, credential, newPassword },
        rawErrors: true,
      });
      setLoading(false);
      if (!r) { setError('Connection error.'); return; }
      if (r.error) { setError(r.error); return; }
      setInfo('Password reset successfully. You can now log in.');
      switchMode('login');
    } catch (err) { setError(err.message || 'Passkey authentication failed.'); setLoading(false); }
  };

  const handleSetupTotp = async () => {
    setLoading(true); setError('');
    const r = await api('/2fa/setup/totp', { method: 'POST', body: { tempToken: twoFAState.tempToken }, rawErrors: true });
    setLoading(false);
    if (r?.ok) {
      setTwoFAState({ step: 'setup-totp-verify', tempToken: r.tempToken, qrCodeDataUrl: r.qrCodeDataUrl, secret: r.secret });
    } else { setError(r?.error || 'Failed to generate TOTP'); }
  };

  const handleSetupPasskey = async () => {
    setLoading(true); setError('');
    try {
      const r = await api('/2fa/setup/passkey/register-options', { method: 'POST', body: { tempToken: twoFAState.tempToken }, rawErrors: true });
      if (!r?.ok) { setError(r?.error || 'Failed'); setLoading(false); return; }
      const { startRegistration } = await import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/dist/bundle/index.js');
      const credential = await startRegistration({ optionsJSON: r.options });
      const verify = await api('/2fa/setup/passkey/register', { method: 'POST', body: { tempToken: r.tempToken, challengeKey: r.challengeKey, credential }, rawErrors: true });
      if (verify?.verified) { await finishLogin(); } else { setError(verify?.error || 'Registration failed'); }
    } catch (err) { setError(err.message || 'Passkey registration failed'); }
    setLoading(false);
  };

  const handleSkip2FA = async () => {
    setLoading(true); setError('');
    const r = await api('/2fa/setup/skip', { method: 'POST', body: { tempToken: twoFAState.tempToken }, rawErrors: true });
    setLoading(false);
    if (r?.ok) { await finishLogin(); } else { setError(r?.error || 'Failed to skip 2FA setup'); }
  };

  const handleVerifyTotp = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    const endpoint = twoFAState.step === 'setup-totp-verify' ? '/2fa/setup/totp/verify' : '/2fa/verify/totp';
    const r = await api(endpoint, { method: 'POST', body: { tempToken: twoFAState.tempToken, code: totpCode }, rawErrors: true });
    setLoading(false);
    if (r?.verified || r?.ok) { await finishLogin(); }
    else {
      setError(r?.error || 'Invalid code');
      if (r?.tempToken) setTwoFAState(s => ({ ...s, tempToken: r.tempToken }));
    }
  };

  const handleVerifyPasskey = async () => {
    setLoading(true); setError('');
    try {
      const { startAuthentication } = await import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/dist/bundle/index.js');
      const credential = await startAuthentication({ optionsJSON: twoFAState.options });
      const r = await api('/2fa/verify/passkey', { method: 'POST', body: { tempToken: twoFAState.tempToken, challengeKey: twoFAState.challengeKey, credential }, rawErrors: true });
      if (r?.ok) { await finishLogin(); } else { setError(r?.error || 'Verification failed'); }
    } catch (err) { setError(err.message || 'Passkey auth failed'); }
    setLoading(false);
  };

  const titleMap = {
    login: 'User Portal Login', register: 'Create Account', verify: 'Verify Your Email',
    forgot: 'Reset Password', 'reset-confirm': 'Enter Reset Code', 'reset-passkey': 'Reset with Passkey',
    '2fa': twoFAState?.step === 'setup-choose' ? 'Set Up 2FA' : twoFAState?.step === 'setup-totp-verify' ? 'Scan QR Code' : 'Two-Factor Auth',
  };

  return html`
    <div class="login-page">
      <div class="login-card">
        <h2>Kora</h2>
        <p class="subtitle">${titleMap[mode] || ''}</p>
        ${deviceCode && mode === 'login' && html`<div class="info" style="margin-bottom:12px">🖥️ Log in to authorize your desktop app.</div>`}
        ${error && html`<div class="error">${error}</div>`}
        ${info && html`<div class="info">${info}</div>`}

        ${mode === 'login' && html`
          <form onSubmit=${handleLogin}>
            <div class="form-group"><label>Email</label><input type="email" value=${email} onInput=${e => setEmail(e.target.value)} required /></div>
            <div class="form-group"><label>Password</label><input type="password" value=${password} onInput=${e => setPassword(e.target.value)} required /></div>
            <button class="btn btn-primary" style="width:100%" disabled=${loading}>${loading ? 'Logging in...' : 'Log In'}</button>
          </form>
          <div class="switch-link"><a href="#" onClick=${() => switchMode('forgot')}>Forgot password?</a></div>
          <div class="switch-link">New user? <a href="#" onClick=${() => switchMode('register')}>Register with code from Telegram</a></div>
        `}

        ${mode === 'register' && html`
          <form onSubmit=${handleRegister}>
            <div class="form-group"><label>Registration Code (from Telegram /link)</label><input type="text" value=${code} onInput=${e => setCode(e.target.value)} placeholder="e.g. ABC123" required /></div>
            <div class="form-group"><label>Email</label><input type="email" value=${email} onInput=${e => setEmail(e.target.value)} required /></div>
            <div class="form-group"><label>Display Name</label><input type="text" value=${displayName} onInput=${e => setDisplayName(e.target.value)} /></div>
            <div class="form-group"><label>Password (min 8 chars)</label><input type="password" value=${password} onInput=${e => setPassword(e.target.value)} required minlength="8" /></div>
            <button class="btn btn-primary" style="width:100%" disabled=${loading}>${loading ? 'Creating account...' : 'Create Account'}</button>
          </form>
          <div class="switch-link">Already registered? <a href="#" onClick=${() => switchMode('login')}>Log in</a></div>
        `}

        ${mode === 'verify' && html`
          <p style="color:#7d8590;font-size:13px;margin-bottom:16px">A verification code has been sent to <strong>${email}</strong>. Enter it below to activate your account.</p>
          <form onSubmit=${handleVerify}>
            <div class="form-group"><label>Verification Code</label><input type="text" value=${verifyCode} onInput=${e => setVerifyCode(e.target.value)} placeholder="e.g. ABC123" required maxlength="6" style="text-transform:uppercase;letter-spacing:4px;text-align:center;font-size:18px" /></div>
            <button class="btn btn-primary" style="width:100%" disabled=${loading}>${loading ? 'Verifying...' : 'Verify Email'}</button>
          </form>
          <div class="switch-link"><a href="#" onClick=${handleResendVerification}>Resend code</a></div>
        `}

        ${mode === 'forgot' && html`
          <p style="color:#7d8590;font-size:13px;margin-bottom:16px">Choose how to reset your password:</p>
          <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
            <button class="btn btn-secondary" style="width:100%" onClick=${handlePasskeyResetStart} disabled=${loading || !email}>
              Reset with Passkey
            </button>
          </div>
          <p style="color:#7d8590;font-size:13px;margin-bottom:8px">Or receive a reset code via email:</p>
          <form onSubmit=${handleForgotRequest}>
            <div class="form-group"><label>Email</label><input type="email" value=${email} onInput=${e => setEmail(e.target.value)} required /></div>
            <button class="btn btn-primary" style="width:100%" disabled=${loading}>${loading ? 'Sending...' : 'Send Reset Code'}</button>
          </form>
          <div class="switch-link"><a href="#" onClick=${() => switchMode('reset-confirm')}>I already have a code</a> · <a href="#" onClick=${() => switchMode('login')}>Back to login</a></div>
        `}

        ${mode === 'reset-passkey' && html`
          <p style="color:#7d8590;font-size:13px;margin-bottom:16px">Authenticate with your passkey and set a new password.</p>
          <div class="form-group"><label>New Password (min 8 chars)</label><input type="password" value=${newPassword} onInput=${e => setNewPassword(e.target.value)} required minlength="8" /></div>
          <button class="btn btn-primary" style="width:100%" onClick=${handlePasskeyResetComplete} disabled=${loading || !newPassword || newPassword.length < 8}>
            ${loading ? 'Authenticating...' : 'Reset with Passkey'}
          </button>
          <div class="switch-link"><a href="#" onClick=${() => switchMode('forgot')}>Back</a></div>
        `}

        ${mode === 'reset-confirm' && html`
          <p style="color:#7d8590;font-size:13px;margin-bottom:16px">Enter the reset code you received via email or Telegram, along with your new password.</p>
          <form onSubmit=${handleResetConfirm}>
            <div class="form-group"><label>Reset Code</label><input type="text" value=${resetCode} onInput=${e => setResetCode(e.target.value)} placeholder="e.g. ABC123" required maxlength="6" style="text-transform:uppercase;letter-spacing:4px;text-align:center;font-size:18px" /></div>
            <div class="form-group"><label>New Password (min 8 chars)</label><input type="password" value=${newPassword} onInput=${e => setNewPassword(e.target.value)} required minlength="8" /></div>
            <button class="btn btn-primary" style="width:100%" disabled=${loading}>${loading ? 'Resetting...' : 'Reset Password'}</button>
          </form>
          <div class="switch-link"><a href="#" onClick=${() => switchMode('login')}>Back to login</a></div>
        `}

        ${mode === '2fa' && twoFAState?.step === 'setup-choose' && html`
          <p style="color:#7d8590;font-size:13px;margin-bottom:16px;text-align:center;">Choose your preferred 2FA method:</p>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <button class="btn btn-primary" style="width:100%;padding:14px;" onClick=${handleSetupTotp} disabled=${loading}>
              Authenticator App (TOTP)
            </button>
            <button class="btn btn-secondary" style="width:100%;padding:14px;" onClick=${handleSetupPasskey} disabled=${loading}>
              Passkey (WebAuthn)
            </button>
          </div>
          <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #21262d">
            <button class="btn" style="color:#7d8590;background:transparent;font-size:13px" onClick=${handleSkip2FA} disabled=${loading}>
              Skip for now
            </button>
          </div>
        `}

        ${mode === '2fa' && twoFAState?.step === 'setup-totp-verify' && html`
          <div style="text-align:center;margin-bottom:16px;">
            <img src=${twoFAState.qrCodeDataUrl} alt="TOTP QR Code" style="border-radius:8px;max-width:200px;" />
          </div>
          <p style="font-size:12px;color:#7d8590;text-align:center;margin-bottom:16px;word-break:break-all;">
            Manual entry: <code>${twoFAState.secret}</code>
          </p>
          <form onSubmit=${handleVerifyTotp}>
            <div class="form-group"><label>Enter 6-digit code</label>
              <input type="text" value=${totpCode} onInput=${e => setTotpCode(e.target.value)}
                maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" style="text-align:center;letter-spacing:4px;font-size:18px;" />
            </div>
            <button class="btn btn-primary" style="width:100%;" disabled=${loading || totpCode.length !== 6}>
              ${loading ? 'Verifying...' : 'Verify & Activate'}
            </button>
          </form>
        `}

        ${mode === '2fa' && twoFAState?.step === 'verify' && twoFAState?.method === 'totp' && html`
          <form onSubmit=${handleVerifyTotp}>
            <div class="form-group"><label>Enter your authenticator code</label>
              <input type="text" value=${totpCode} onInput=${e => setTotpCode(e.target.value)}
                maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="6-digit code"
                style="text-align:center;letter-spacing:4px;font-size:18px;" />
            </div>
            <button class="btn btn-primary" style="width:100%;" disabled=${loading || totpCode.length !== 6}>
              ${loading ? 'Verifying...' : 'Verify'}
            </button>
          </form>
        `}

        ${mode === '2fa' && twoFAState?.step === 'verify' && twoFAState?.method === 'passkey' && html`
          <p style="color:#7d8590;font-size:13px;margin-bottom:16px;text-align:center;">Authenticate with your passkey</p>
          <button class="btn btn-primary" style="width:100%;padding:14px;" onClick=${handleVerifyPasskey} disabled=${loading}>
            ${loading ? 'Waiting for passkey...' : 'Use Passkey'}
          </button>
        `}

        ${mode === '2fa' && html`
          <div class="switch-link"><a href="#" onClick=${() => switchMode('login')}>Back to login</a></div>
        `}
      </div>
    </div>`;
}

function Portal({ user, onLogout }) {
  const [page, setPage] = useState('dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const csrf = user?.csrfToken;

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'profile', label: 'Profile', icon: '👤' },
    { id: 'tools', label: 'Tools', icon: '🔧' },
    { id: 'tasks', label: 'Tasks', icon: '📅' },
    { id: 'personalization', label: 'Personalization', icon: '✨' },
    { id: 'memory', label: 'Memory', icon: '🧠' },
    { id: 'kyu', label: 'My KYU Profile', icon: '🪪' },
    { id: 'subscription', label: 'Subscription', icon: '💳' },
  ];

  const navigate = (id) => { setPage(id); setMenuOpen(false); };

  const closeMenu = (e) => {
    if (!e.target.closest('.user-menu')) setMenuOpen(false);
  };

  useEffect(() => {
    if (menuOpen) document.addEventListener('click', closeMenu);
    return () => document.removeEventListener('click', closeMenu);
  }, [menuOpen]);

  const initials = (user.displayName || user.email || '?').slice(0, 2).toUpperCase();

  return html`
    <div class="header">
      <h1 style="cursor:pointer" onClick=${() => navigate('dashboard')}>⬡ Kora Portal</h1>
      <div class="user-info">
        <span class="badge ${user.subscriptionStatus === 'active' ? 'badge-green' : user.subscriptionStatus === 'none' ? 'badge-gray' : 'badge-yellow'}">${user.subscriptionStatus}</span>
        <div class="user-menu" style="position:relative">
          <button onClick=${(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            style="width:36px;height:36px;border-radius:50%;background:#238636;color:#fff;border:none;cursor:pointer;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0">
            ${initials}
          </button>
          ${menuOpen && html`
            <div style="position:absolute;right:0;top:44px;background:#161b22;border:1px solid #30363d;border-radius:10px;min-width:220px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:100;overflow:hidden;animation:fadeIn 0.15s ease">
              <div style="padding:14px 16px;border-bottom:1px solid #21262d">
                <div style="font-weight:600;font-size:14px;color:#e6edf3">${user.displayName || 'User'}</div>
                <div style="font-size:12px;color:#7d8590;margin-top:2px">${user.email}</div>
              </div>
              ${menuItems.map(m => html`
                <button onClick=${() => navigate(m.id)}
                  style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;background:${page === m.id ? '#21262d' : 'transparent'};border:none;color:#e6edf3;cursor:pointer;font-size:13px;text-align:left"
                  onMouseEnter=${e => e.target.style.background = '#21262d'}
                  onMouseLeave=${e => e.target.style.background = page === m.id ? '#21262d' : 'transparent'}>
                  <span style="width:20px;text-align:center">${m.icon}</span> ${m.label}
                </button>
              `)}
              <div style="border-top:1px solid #21262d">
                <button onClick=${onLogout}
                  style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;background:transparent;border:none;color:#f85149;cursor:pointer;font-size:13px;text-align:left"
                  onMouseEnter=${e => e.target.style.background = '#21262d'}
                  onMouseLeave=${e => e.target.style.background = 'transparent'}>
                  <span style="width:20px;text-align:center">🚪</span> Logout
                </button>
              </div>
            </div>
          `}
        </div>
      </div>
    </div>
    <div class="container">
      ${page === 'dashboard' && html`<${DashboardTab} user=${user} csrf=${csrf} />`}
      ${page === 'profile' && html`<${ProfileTab} user=${user} csrf=${csrf} />`}
      ${page === 'tools' && html`<${ToolsPage} csrf=${csrf} />`}
      ${page === 'tasks' && html`<${TasksPage} csrf=${csrf} />`}
      ${page === 'personalization' && html`<${PersonalizationPage} csrf=${csrf} />`}
      ${page === 'memory' && html`<${MemoryTab} csrf=${csrf} />`}
      ${page === 'kyu' && html`<${KyuProfileTab} csrf=${csrf} />`}
      ${page === 'subscription' && html`<${SubscriptionTab} user=${user} csrf=${csrf} billingEnabled=${user.billingEnabled} />`}
    </div>`;
}

function DashboardTab({ user, csrf }) {
  const [usage, setUsage] = useState(null);
  useEffect(() => { api('/usage').then(setUsage); }, []);

  return html`
    <div class="card">
      <h2>📊 Dashboard</h2>
      <div class="stats-grid">
        <div class="stat"><div class="label">Workspace</div><div class="value">${user.workspaceName}</div></div>
        <div class="stat"><div class="label">Subscription</div><div class="value"><span class="badge ${user.subscriptionStatus === 'active' ? 'badge-green' : 'badge-gray'}">${user.subscriptionStatus === 'active' ? 'Active' : 'Not subscribed'}</span></div></div>
      </div>
    </div>
    <div class="card">
      <h2>📈 Usage Today</h2>
      ${!usage ? html`<p style="color:#7d8590">Loading...</p>` : html`
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
            <span style="color:#c9d1d9">${usage.totalCalls ?? 0} / ${usage.limit ?? 1000} requests</span>
            <span style="color:#7d8590">${Math.round(((usage.totalCalls ?? 0) / (usage.limit ?? 1000)) * 100)}%</span>
          </div>
          <div style="background:#21262d;border-radius:6px;height:8px;overflow:hidden">
            <div style="background:${(usage.totalCalls ?? 0) >= (usage.limit ?? 1000) ? '#f85149' : '#238636'};height:100%;width:${Math.min(100, ((usage.totalCalls ?? 0) / (usage.limit ?? 1000)) * 100)}%;transition:width 0.3s"></div>
          </div>
        </div>
        ${!usage.models?.length ? html`<p class="empty">No usage data yet</p>` : html`
          <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
            <thead><tr style="border-bottom:1px solid #21262d">
              <th style="text-align:left;padding:8px;color:#7d8590;font-size:12px">Model</th>
              <th style="text-align:right;padding:8px;color:#7d8590;font-size:12px">Calls</th>
              <th style="text-align:right;padding:8px;color:#7d8590;font-size:12px">Input Tokens</th>
              <th style="text-align:right;padding:8px;color:#7d8590;font-size:12px">Output Tokens</th>
            </tr></thead>
            <tbody>${usage.models.map(m => html`<tr style="border-bottom:1px solid #21262d">
              <td style="padding:8px"><code>${m.model}</code></td>
              <td style="text-align:right;padding:8px">${m.callCount}</td>
              <td style="text-align:right;padding:8px">${Number(m.inputTokens).toLocaleString()}</td>
              <td style="text-align:right;padding:8px">${Number(m.outputTokens).toLocaleString()}</td>
            </tr>`)}</tbody>
          </table></div>`}
      `}
    </div>`;
}

function TasksPage({ csrf }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = () => api('/tasks').then(d => { setTasks(Array.isArray(d) ? d : []); setLoading(false); });
  useEffect(() => { load(); }, []);

  const toggle = async (task) => {
    await fetch(`/api/tasks/${task.id}`, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ enabled: !task.enabled }),
    });
    load();
  };

  const [runningIds, setRunningIds] = useState({});

  const runNow = async (id) => {
    setRunningIds(prev => ({ ...prev, [id]: true }));
    try {
      const r = await fetch(`/api/tasks/${id}/run`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrf },
      });
      if (!r.ok) alert('Failed to run task');
    } catch {
      alert('Failed to run task');
    } finally {
      setTimeout(() => {
        setRunningIds(prev => { const n = { ...prev }; delete n[id]; return n; });
        load();
      }, 2000);
    }
  };

  const remove = async (id) => {
    if (!confirm('Delete this task?')) return;
    await fetch(`/api/tasks/${id}`, {
      method: 'DELETE', credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf },
    });
    load();
  };

  const viewDetail = async (id) => {
    if (expandedId === id) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(id);
    const d = await api(`/tasks/${id}`);
    setDetail(d);
  };

  if (loading) return html`<p>Loading...</p>`;

  return html`
    <div class="card">
      <h2>📅 Scheduled Tasks</h2>
      <p style="font-size:13px;color:#7d8590;margin-bottom:16px">Tasks created by the agent on your behalf. You can pause, resume, run, or remove them.</p>
      ${tasks.length === 0 ? html`<p class="empty">No scheduled tasks yet. Ask the agent to create one, e.g. "Schedule a daily summary at 9am".</p>` :
      tasks.map(t => html`
          <div class="list-item" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <div class="name" style="cursor:pointer" onClick=${() => viewDetail(t.id)}>${t.name}</div>
                <div class="meta">${cronToHumanJs(t.cronExpression)} <span style="opacity:0.6">(${t.cronExpression})</span>${t.lastRun ? ` · Last run: ${new Date(t.lastRun).toLocaleString()}` : ''}</div>
              </div>
              <div style="display:flex;gap:6px;align-items:center">
                <span class="badge ${t.enabled ? 'badge-green' : 'badge-gray'}">${t.enabled ? 'Active' : 'Paused'}</span>
                <button class="btn btn-sm" onClick=${() => toggle(t)} title="${t.enabled ? 'Pause' : 'Resume'}">${t.enabled ? '⏸' : '▶'}</button>
                <button class="btn btn-sm" onClick=${() => runNow(t.id)} title="Run now" disabled=${!!runningIds[t.id]}>${runningIds[t.id] ? '⏳ Running...' : '🚀'}</button>
                <button class="btn btn-sm" style="color:#f85149" onClick=${() => remove(t.id)} title="Delete">✕</button>
              </div>
            </div>
            ${t.prompt ? html`<div style="margin-top:6px;font-size:12px;color:#7d8590;white-space:pre-wrap">${t.prompt.length > 150 ? t.prompt.slice(0, 150) + '…' : t.prompt}</div>` : ''}
            ${expandedId === t.id && detail ? html`
              <div style="margin-top:12px;padding-top:12px;border-top:1px solid #21262d">
                <div style="font-size:12px;color:#7d8590;margin-bottom:8px"><strong>Full prompt:</strong></div>
                <pre style="background:#161b22;padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap;color:#e6edf3;max-height:200px;overflow:auto">${detail.prompt || '(none)'}</pre>
                ${detail.logs?.length ? html`
                  <div style="font-size:12px;color:#7d8590;margin:10px 0 6px"><strong>Recent runs:</strong></div>
                  ${detail.logs.map(log => html`
                    <div style="padding:6px 8px;margin-bottom:4px;background:#161b22;border-radius:4px;font-size:12px;display:flex;justify-content:space-between">
                      <span><span class="badge ${log.status === 'success' ? 'badge-green' : 'badge-yellow'}" style="font-size:10px">${log.status}</span> ${new Date(log.startedAt || log.started_at).toLocaleString()}</span>
                      <span style="color:#7d8590;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(log.output || '').slice(0, 80)}</span>
                    </div>
                  `)}
                ` : html`<div style="font-size:12px;color:#7d8590;margin-top:8px">No execution history yet.</div>`}
              </div>
            ` : ''}
          </div>
        `)}
    </div>`;
}

function formatIdentity(id) {
  const cuid = id.channelUserId || '';
  if (id.channel === 'telegram') {
    const chatId = cuid.replace('telegram:', '');
    return { icon: '💬', name: 'Telegram', detail: `Chat ID: ${chatId}` };
  }
  if (id.channel === 'api') {
    return { icon: '🖥️', name: 'Desktop App / API', detail: null };
  }
  if (id.channel === 'email') {
    const addr = cuid.replace('email:', '');
    return { icon: '📧', name: 'Email', detail: addr };
  }
  if (cuid.startsWith('scheduler:')) {
    return { icon: '⏰', name: 'Scheduled Task', detail: null };
  }
  if (id.channel === 'internal') {
    return { icon: '⚙️', name: 'Internal Process', detail: null };
  }
  return { icon: '🔗', name: id.channel, detail: cuid };
}

function ProfileTab({ user, csrf }) {
  const [identities, setIdentities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/profile/identities').then(d => {
      if (d) setIdentities(Array.isArray(d) ? d : []);
      setLoading(false);
    });
  }, []);

  return html`
    <div class="card">
      <h2>👤 Profile</h2>
      <div class="stats-grid" style="margin-bottom:20px">
        <div class="stat"><div class="label">Display Name</div><div class="value" style="font-size:16px">${user.displayName || '—'}</div></div>
        <div class="stat"><div class="label">Email</div><div class="value" style="font-size:16px">${user.email}</div></div>
        <div class="stat"><div class="label">Workspace</div><div class="value" style="font-size:16px">${user.workspaceName}</div></div>
      </div>
    </div>
    <div class="card">
      <h2>🔗 Connected Identities</h2>
      <p style="font-size:13px;color:#7d8590;margin-bottom:16px">Channels connected to your account (Telegram, Email, etc.)</p>
      ${loading ? html`<p style="color:#7d8590">Loading...</p>` :
      identities.length === 0 ? html`<p class="empty">No connected identities found. Interact with the bot via Telegram or email to connect an identity.</p>` :
        identities.map(id => {
          const info = formatIdentity(id);
          return html`
          <div class="list-item">
            <div>
              <div class="name">${info.icon} ${info.name}</div>
              <div class="meta">${info.detail || ''}${id.linkedAt ? `${info.detail ? ' · ' : ''}Linked: ${new Date(id.linkedAt).toLocaleDateString()}` : ''}</div>
            </div>
            <span class="badge badge-green">${info.name}</span>
          </div>
        `})}
    </div>`;
}

function ToolsPage({ csrf }) {
  const [subTab, setSubTab] = useState('builtin');
  const subTabs = [
    { id: 'builtin', label: 'Built-in Tools' },
    { id: 'mcp', label: 'MCP Servers' },
    { id: 'skills', label: 'Skills' },
    { id: 'subagents', label: 'Sub-Agents' },
    { id: 'mail', label: 'Mail Delegation' },
  ];

  return html`
    <div class="tabs">
      ${subTabs.map(t => html`<button class="tab ${subTab === t.id ? 'active' : ''}" onClick=${() => setSubTab(t.id)}>${t.label}</button>`)}
    </div>
    ${subTab === 'builtin' && html`<${ToolsTab} csrf=${csrf} />`}
    ${subTab === 'mcp' && html`<${McpTab} csrf=${csrf} />`}
    ${subTab === 'skills' && html`<${SkillsTab} csrf=${csrf} />`}
    ${subTab === 'subagents' && html`<${SubAgentsTab} csrf=${csrf} />`}
    ${subTab === 'mail' && html`<${MailDelegationTab} csrf=${csrf} />`}
  `;
}

function SubAgentsTab({ csrf }) {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: '', description: '', systemPrompt: '', model: '', maxIterations: 5 });
  const [runningId, setRunningId] = useState(null);
  const [taskPrompt, setTaskPrompt] = useState('');
  const [availableModels, setAvailableModels] = useState([]);

  const emptyForm = () => ({ name: '', description: '', systemPrompt: '', model: '', maxIterations: 5 });

  const load = () => fetch('/api/subagents', { credentials: 'same-origin' })
    .then(r => r.json()).then(d => { setAgents(Array.isArray(d) ? d : []); setLoading(false); });
  useEffect(() => {
    load();
    fetch('/api/models', { credentials: 'same-origin' }).then(r => r.json()).then(d => {
      setAvailableModels(d.models || []);
    }).catch(() => { });
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setShowForm(true);
  };

  const openEdit = (a) => {
    setEditingId(a.id);
    setForm({
      name: a.name || '',
      description: a.description || '',
      systemPrompt: a.systemPrompt || '',
      model: a.model || '',
      maxIterations: a.maxIterations ?? 5,
    });
    setShowForm(true);
  };

  const cancelForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm());
  };

  const submitAgent = async (e) => {
    e.preventDefault();
    const url = editingId ? `/api/subagents/${editingId}` : '/api/subagents';
    const method = editingId ? 'PUT' : 'POST';
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(form),
    });
    if (r.ok) { cancelForm(); load(); }
  };

  const removeAgent = async (id) => {
    if (!confirm('Remove this sub-agent?')) return;
    await fetch(`/api/subagents/${id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } });
    load();
  };

  const runAgent = async (id) => {
    if (!taskPrompt.trim()) return;
    setRunningId(id);
    try {
      const r = await fetch(`/api/subagents/${id}/run`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ task: taskPrompt }),
      });
      const data = await r.json();
      if (data.ok) alert('Result: ' + (data.result || '(empty)').slice(0, 500));
      else alert('Error: ' + (data.error || 'Unknown'));
    } finally { setRunningId(null); setTaskPrompt(''); load(); }
  };

  if (loading) return html`<p>Loading...</p>`;

  return html`
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">Sub-Agents</h3>
        <button class="btn btn-sm" onClick=${() => (showForm ? cancelForm() : openCreate())}>${showForm ? 'Cancel' : '+ Create'}</button>
      </div>
      ${showForm && html`
        <form onSubmit=${submitAgent} style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;padding:12px;background:#161b22;border-radius:8px">
          <input class="input" placeholder="Name" value=${form.name} onInput=${e => setForm({ ...form, name: e.target.value })} required />
          <input class="input" placeholder="Description" value=${form.description} onInput=${e => setForm({ ...form, description: e.target.value })} />
          <textarea class="input" placeholder="System prompt" rows="3" value=${form.systemPrompt} onInput=${e => setForm({ ...form, systemPrompt: e.target.value })} required></textarea>
          <div style="display:flex;gap:8px">
            <select class="input" value=${form.model} onChange=${e => setForm({ ...form, model: e.target.value })} style="flex:1">
              <option value="">Default model</option>
              ${availableModels.map(m => html`
                <option value=${m.id}>${m.id} (${m.provider})${m.roles?.length ? ` [${m.roles.join(', ')}]` : ''}</option>
              `)}
            </select>
            <input class="input" type="number" min="1" max="50" placeholder="Max iter" value=${form.maxIterations} onInput=${e => setForm({ ...form, maxIterations: parseInt(e.target.value) || 5 })} style="width:80px" />
          </div>
          <button class="btn" type="submit">${editingId ? 'Save changes' : 'Create Sub-Agent'}</button>
        </form>
      `}
      ${agents.length === 0 ? html`<p style="color:#7d8590">No sub-agents created yet.</p>` : html`
        <div style="display:flex;flex-direction:column;gap:8px">
          ${agents.map(a => html`
            <div class="card" style="padding:12px">
              <div style="display:flex;justify-content:space-between;align-items:start">
                <div>
                  <strong>${a.name}</strong>
                  <span class="badge ${a.status === 'running' ? 'badge-yellow' : a.status === 'completed' ? 'badge-green' : 'badge-gray'}" style="margin-left:8px">${a.status || 'idle'}</span>
                  ${a.description && html`<div style="color:#7d8590;font-size:12px;margin-top:4px">${a.description}</div>`}
                  ${a.model && html`<div style="color:#7d8590;font-size:11px;margin-top:2px">Model: ${a.model}</div>`}
                  ${a.lastRunAt && html`<div style="color:#7d8590;font-size:11px;margin-top:2px">Last run: ${new Date(a.lastRunAt).toLocaleString()}</div>`}
                </div>
                <div style="display:flex;gap:4px">
                  <button class="btn btn-sm" onClick=${() => openEdit(a)} title="Edit">Edit</button>
                  <button class="btn btn-sm btn-danger" onClick=${() => removeAgent(a.id)} title="Remove">✕</button>
                </div>
              </div>
              <div style="display:flex;gap:6px;margin-top:8px">
                <input class="input" placeholder="Task prompt..." style="flex:1;font-size:12px" value=${runningId === a.id ? taskPrompt : ''} onInput=${e => { setRunningId(a.id); setTaskPrompt(e.target.value); }} />
                <button class="btn btn-sm" onClick=${() => runAgent(a.id)} disabled=${runningId === a.id && !taskPrompt.trim()}>
                  ${runningId === a.id ? 'Running...' : 'Run'}
                </button>
              </div>
            </div>
          `)}
        </div>
      `}
    </div>`;
}

function PersonalizationPage({ csrf }) {
  const [modelCount, setModelCount] = useState(null);
  const defaultTab = modelCount !== null && modelCount <= 1 ? 'prompt' : 'models';
  const [subTab, setSubTab] = useState(null);

  useEffect(() => {
    api('/models').then(data => {
      if (!data) return;
      const list = data.models || data;
      setModelCount(Array.isArray(list) ? list.length : 0);
    });
  }, []);

  const activeTab = subTab || defaultTab;
  const subTabs = [
    ...(modelCount === null || modelCount > 1 ? [{ id: 'models', label: 'Models' }] : []),
    { id: 'prompt', label: 'Agent Instructions' },
    { id: 'identity', label: 'Identity' },
  ];

  return html`
    <div class="tabs">
      ${subTabs.map(t => html`<button class="tab ${activeTab === t.id ? 'active' : ''}" onClick=${() => setSubTab(t.id)}>${t.label}</button>`)}
    </div>
    ${activeTab === 'models' && html`<${ModelsTab} csrf=${csrf} />`}
    ${activeTab === 'prompt' && html`<${PromptTab} csrf=${csrf} />`}
    ${activeTab === 'identity' && html`<${IdentityTab} csrf=${csrf} />`}
  `;
}

function KyuProfileTab({ csrf }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api('/kyu')
      .then(d => setContent(d?.content || ''))
      .catch(() => setContent(''))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return html`<div style="text-align:center;padding:40px"><div class="spinner"></div></div>`;

  return html`
    <div class="card" style="margin-top:16px">
      <div style="padding:20px">
        <h3 style="margin:0 0 8px 0;font-size:16px">My KYU Profile</h3>
        <p style="color:var(--text-secondary);font-size:13px;margin:0 0 16px 0">
          This is what your assistant knows about you. It is updated automatically after each conversation to help personalize your experience.
        </p>
        ${content ? html`
          <div class="markdown-content" style="font-size:13px;line-height:1.6;background:var(--bg-secondary);padding:16px;border-radius:8px;margin:0;max-height:600px;overflow-y:auto;" dangerouslySetInnerHTML=${{ __html: simpleMarkdown(content) }}></div>
        ` : html`
          <div style="text-align:center;padding:40px;color:var(--text-secondary)">
            <p style="font-size:14px">No profile yet</p>
            <p style="font-size:12px">Your assistant will start building your profile as you interact with it.</p>
          </div>
        `}
      </div>
    </div>
  `;
}

function MemoryTab({ csrf }) {
  const [entries, setEntries] = useState([]);
  const [raw, setRaw] = useState('');
  const [viewMode, setViewMode] = useState('entries');
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api('/memory'), api('/memory/raw')])
      .then(([e, r]) => {
        if (e) setEntries(e);
        if (r) setRaw(r.content || '');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (entry) => {
    setEditingId(entry.id);
    setEditContent(entry.content);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent('');
  };

  const saveEdit = async (id) => {
    setSaving(true);
    try {
      await api(`/memory/${id}`, { method: 'PUT', body: { content: editContent }, csrf });
      setEditingId(null);
      setEditContent('');
      load();
    } catch { }
    setSaving(false);
  };

  const deleteEntry = async (id) => {
    if (!confirm('Delete this memory entry?')) return;
    setSaving(true);
    try {
      await api(`/memory/${id}`, { method: 'DELETE', csrf });
      load();
    } catch { }
    setSaving(false);
  };

  if (loading) return html`<div class="card"><p style="color:#7d8590">Loading...</p></div>`;

  return html`
    <div class="card">
      <h2 style="display:flex;justify-content:space-between;align-items:center">
        🧠 Memory
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm ${viewMode === 'entries' ? 'btn-primary' : 'btn-secondary'}" onClick=${() => setViewMode('entries')}>Entries</button>
          <button class="btn btn-sm ${viewMode === 'raw' ? 'btn-primary' : 'btn-secondary'}" onClick=${() => setViewMode('raw')}>Raw</button>
        </div>
      </h2>
      ${viewMode === 'entries' ? html`
        ${entries.length === 0 ? html`<p class="empty">No memory entries yet. The agent will save memories as you interact with it.</p>` :
        entries.map(e => html`
            <div key=${e.id} style="padding:12px 0;border-bottom:1px solid #21262d">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <span style="font-size:11px;color:#7d8590">[${e.id}] ${e.timestamp || ''}</span>
                ${editingId !== e.id && html`
                  <div style="display:flex;gap:6px">
                    <button onClick=${() => startEdit(e)} style="background:none;border:1px solid #30363d;color:#7d8590;padding:2px 8px;border-radius:4px;font-size:11px;cursor:pointer" title="Edit">✏️</button>
                    <button onClick=${() => deleteEntry(e.id)} disabled=${saving} style="background:none;border:1px solid #30363d;color:#f85149;padding:2px 8px;border-radius:4px;font-size:11px;cursor:pointer" title="Delete">🗑</button>
                  </div>
                `}
              </div>
              ${editingId === e.id ? html`
                <div style="display:flex;flex-direction:column;gap:8px">
                  <textarea value=${editContent} onInput=${(ev) => setEditContent(ev.target.value)}
                    style="background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:8px;font-size:13px;min-height:80px;resize:vertical;font-family:inherit" />
                  <div style="display:flex;gap:6px;justify-content:flex-end">
                    <button class="btn btn-sm btn-secondary" onClick=${cancelEdit} disabled=${saving}>Cancel</button>
                    <button class="btn btn-sm btn-primary" onClick=${() => saveEdit(e.id)} disabled=${saving || !editContent.trim()}>
                      ${saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              ` : html`
                <div class="markdown-content" style="font-size:13px;line-height:1.5" dangerouslySetInnerHTML=${{ __html: simpleMarkdown(e.content) }}></div>
              `}
            </div>`)}
      ` : html`
        <div class="markdown-content" style="background:#0d1117;padding:16px;border-radius:8px;font-size:12px;max-height:500px;overflow:auto;color:#c9d1d9;line-height:1.5" dangerouslySetInnerHTML=${{ __html: simpleMarkdown(raw || '(empty)') }}></div>
      `}
    </div>`;
}

function ToolsTab({ csrf }) {
  const [tools, setTools] = useState({});
  const [locked, setLocked] = useState([]);
  const [delegations, setDelegations] = useState([]);
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(true);
  useEffect(() => {
    api('/tools').then(t => {
      if (!t) return;
      if (t.tools) { setTools(t.tools); setLocked(t.locked || []); }
      else setTools(t);
    });
    api('/mail-delegations').then(d => d && setDelegations(Array.isArray(d) ? d : []));
    api('/heartbeat').then(h => h && setHeartbeatEnabled(h.enabled !== false));
  }, []);

  const toggle = async (key) => {
    if (key === 'mail_delegation' || locked.includes(key)) return;
    const isActive = tools[key] === undefined ? true : !!tools[key];
    const updated = { [key]: !isActive };
    await api('/tools', { method: 'PUT', body: updated, csrf });
    setTools(prev => ({ ...prev, ...updated }));
  };

  const toggleHeartbeat = async () => {
    const newVal = !heartbeatEnabled;
    setHeartbeatEnabled(newVal);
    await api('/heartbeat', { method: 'PUT', body: { enabled: newVal }, csrf });
  };

  const toolList = [
    { key: 'browser', label: 'Browser', desc: 'Web browsing and screenshots' },
    { key: 'web_search', label: 'Web Search', desc: 'Search the internet' },
    { key: 'web_fetch', label: 'Web Fetch', desc: 'Fetch webpage content' },
    { key: 'mail_delegation', label: 'Mail Delegation', desc: 'Read/send user email via delegated accounts', readonly: true },
    { key: 'scheduler', label: 'Scheduler', desc: 'Schedule recurring tasks' },
    { key: 'shell', label: 'Shell', desc: 'Execute shell commands' },
    { key: 'identity', label: 'Identity / Evolve', desc: 'Allow the agent to read and evolve its own identity' },
  ];

  return html`
    <div class="card">
      <h2>Tool Settings</h2>
      <p style="font-size:13px;color:#7d8590;margin-bottom:16px">Toggle which tools the agent can use in your workspace.</p>
      ${toolList.map(t => {
    const isMailDelegation = t.key === 'mail_delegation';
    const isLocked = locked.includes(t.key);
    const isActive = isMailDelegation ? delegations.length > 0 : tools[t.key] === undefined ? true : !!tools[t.key];
    const isDisabled = isMailDelegation || isLocked;
    const lockHint = isLocked ? ' — disabled by administrator' : '';
    return html`
          <div class="toggle" style="${isDisabled ? 'opacity:0.7' : ''}">
            <div>
              <label>${t.label}${isLocked ? ' 🔒' : ''}</label>
              <div class="desc">${t.desc}${isMailDelegation && !isActive ? ' — configure in the Mail Delegation tab first' : ''}${lockHint}</div>
            </div>
            <label class="switch">
              <input type="checkbox" checked=${isActive} onChange=${() => toggle(t.key)} disabled=${isDisabled} />
              <span class="slider"></span>
            </label>
          </div>`;
  })}
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Agent Behavior</h2>
      <div class="toggle">
        <div>
          <label>Heartbeat</label>
          <div class="desc">Periodic background check-in where the agent reviews tasks, schedules, and memory. Disable to prevent the agent from running autonomously.</div>
        </div>
        <label class="switch">
          <input type="checkbox" checked=${heartbeatEnabled} onChange=${toggleHeartbeat} />
          <span class="slider"></span>
        </label>
      </div>
    </div>`;
}

function McpTab({ csrf }) {
  const [servers, setServers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [serverName, setServerName] = useState('');
  const [sseUrl, setSseUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api('/mcp').then(s => s && setServers(s)); }, []);

  const addServer = async (e) => {
    e.preventDefault();
    setError('');
    const r = await api('/mcp', { method: 'POST', body: { name: serverName, source: sseUrl, transport: 'sse', url: sseUrl, enabled: true }, csrf });
    if (r?.error) { setError(r.error); return; }
    setServerName(''); setSseUrl(''); setShowAdd(false);
    const s = await api('/mcp'); if (s) setServers(s);
  };

  const removeServer = async (id) => {
    await api(`/mcp/${encodeURIComponent(id)}`, { method: 'DELETE', csrf });
    const s = await api('/mcp'); if (s) setServers(s);
  };

  return html`
    <div class="card">
      <h2 style="display:flex;justify-content:space-between;align-items:center">MCP Servers <button class="btn btn-secondary btn-sm" onClick=${() => setShowAdd(!showAdd)}>+ Add</button></h2>
      <p style="font-size:13px;color:#7d8590;margin-bottom:16px">Connect remote MCP servers via SSE to extend agent capabilities.</p>
      ${error && html`<div class="error" style="margin-bottom:12px">${error}</div>`}
      ${showAdd && html`
        <form onSubmit=${addServer} style="margin-bottom:16px;padding:16px;background:#0d1117;border-radius:8px">
          <div class="form-group"><label>Server Name</label><input type="text" value=${serverName} onInput=${e => setServerName(e.target.value)} placeholder="e.g. my-mcp-server" required /></div>
          <div class="form-group"><label>SSE URL</label><input type="url" value=${sseUrl} onInput=${e => setSseUrl(e.target.value)} placeholder="e.g. https://my-server.example.com/mcp" required /></div>
          <div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" type="submit">Connect</button><button class="btn btn-secondary btn-sm" type="button" onClick=${() => { setShowAdd(false); setError(''); }}>Cancel</button></div>
        </form>`}
      ${servers.length === 0 && !showAdd ? html`<p class="empty">No MCP servers connected. Add a remote SSE server to extend agent capabilities.</p>` :
      servers.map(s => html`
        <div class="list-item">
          <div><div class="name">${s.name || s.id}</div><div class="meta">${s.transport === 'sse' ? s.url || s.source : s.source || s.command || 'N/A'} · ${s.transport || 'stdio'}</div></div>
          <div class="actions"><button class="btn btn-danger btn-sm" onClick=${() => removeServer(s.id || s.name)}>Remove</button></div>
        </div>`)}
    </div>`;
}

function SkillsTab({ csrf }) {
  const [skills, setSkills] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState('manual');
  const [skillName, setSkillName] = useState('');
  const [skillContent, setSkillContent] = useState('');
  const [zipFile, setZipFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api('/skills').then(s => s && setSkills(s)); }, []);

  const reload = async () => { const s = await api('/skills'); if (s) setSkills(s); };

  const addSkill = async (e) => {
    e.preventDefault();
    setError('');
    const r = await api('/skills', { method: 'POST', body: { name: skillName, content: skillContent }, csrf });
    if (r?.error) { setError(r.error); return; }
    setSkillName(''); setSkillContent(''); setShowAdd(false);
    await reload();
  };

  const uploadZip = async (e) => {
    e.preventDefault();
    if (!zipFile || !skillName) { setError('Both skill name and zip file are required'); return; }
    setError(''); setUploading(true);
    try {
      const form = new FormData();
      form.append('name', skillName);
      form.append('file', zipFile);
      const r = await fetch('/api/skills/upload', {
        method: 'POST', body: form,
        headers: { 'X-CSRF-Token': csrf },
        credentials: 'same-origin',
      });
      const data = await r.json();
      if (data.error) { setError(data.error); return; }
      setSkillName(''); setZipFile(null); setShowAdd(false);
      await reload();
    } catch (err) { setError(err.message); }
    finally { setUploading(false); }
  };

  const removeSkill = async (name) => {
    await api(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE', csrf });
    await reload();
  };

  return html`
    <div class="card">
      <h2 style="display:flex;justify-content:space-between;align-items:center">Skills <button class="btn btn-secondary btn-sm" onClick=${() => setShowAdd(!showAdd)}>+ Add</button></h2>
      <p style="font-size:13px;color:#7d8590;margin-bottom:16px">Install custom skills to extend agent capabilities in your workspace.</p>
      ${error && html`<div class="error" style="margin-bottom:12px">${error}</div>`}
      ${showAdd && html`
        <div style="margin-bottom:16px;padding:16px;background:#0d1117;border-radius:8px">
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="btn ${addMode === 'manual' ? 'btn-primary' : 'btn-secondary'} btn-sm" onClick=${() => setAddMode('manual')}>Write SKILL.md</button>
            <button class="btn ${addMode === 'zip' ? 'btn-primary' : 'btn-secondary'} btn-sm" onClick=${() => setAddMode('zip')}>Upload ZIP</button>
          </div>
          ${addMode === 'manual' ? html`
            <form onSubmit=${addSkill}>
              <div class="form-group"><label>Skill Name</label><input type="text" value=${skillName} onInput=${e => setSkillName(e.target.value)} placeholder="e.g. my-skill" required /></div>
              <div class="form-group"><label>SKILL.md Content</label><textarea rows="10" value=${skillContent} onInput=${e => setSkillContent(e.target.value)} placeholder="---\nname: my-skill\ndescription: A custom skill\n---\n\nInstructions..." required style="font-family:monospace;font-size:12px;"></textarea></div>
              <div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" type="submit">Install</button><button class="btn btn-secondary btn-sm" type="button" onClick=${() => { setShowAdd(false); setError(''); }}>Cancel</button></div>
            </form>` : html`
            <form onSubmit=${uploadZip}>
              <div class="form-group"><label>Skill Name</label><input type="text" value=${skillName} onInput=${e => setSkillName(e.target.value)} placeholder="e.g. my-skill" required /></div>
              <div class="form-group">
                <label>ZIP File</label>
                <p style="font-size:12px;color:#7d8590;margin:0 0 8px">The zip must contain a SKILL.md file at the root or in a single subfolder.</p>
                <input type="file" accept=".zip,application/zip" onChange=${e => setZipFile(e.target.files[0])} required style="color:#c9d1d9" />
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-primary btn-sm" type="submit" disabled=${uploading}>${uploading ? 'Uploading...' : 'Upload & Install'}</button>
                <button class="btn btn-secondary btn-sm" type="button" onClick=${() => { setShowAdd(false); setError(''); }}>Cancel</button>
              </div>
            </form>`}
        </div>`}
      ${skills.length === 0 && !showAdd ? html`<p class="empty">No workspace skills installed. Add a skill to extend agent capabilities.</p>` :
      skills.map(s => html`
        <div class="list-item">
          <div><div class="name">${s.name}</div>${s.description ? html`<div class="meta">${s.description}</div>` : ''}</div>
          <div class="actions"><button class="btn btn-danger btn-sm" onClick=${() => removeSkill(s.name)}>Remove</button></div>
        </div>`)}
    </div>`;
}

function ModelsTab({ csrf }) {
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState('');
  const [currentModel, setCurrentModel] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api('/models').then(data => {
      if (!data) return;
      const list = data.models || data;
      if (Array.isArray(list)) setModels(list);
      if (data.currentModel) {
        setSelected(data.currentModel);
        setCurrentModel(data.currentModel);
      }
    });
  }, []);

  const saveModel = async () => {
    if (!selected) return;
    const model = models.find(m => m.id === selected);
    if (model) {
      await api('/model', { method: 'PUT', body: { defaultModel: model.id, defaultProvider: model.provider }, csrf });
      setCurrentModel(model.id);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return html`
    <div class="card">
      <h2>🧠 Model Selection</h2>
      <p style="font-size:13px;color:#7d8590;margin-bottom:16px">Choose the default AI model for your workspace.</p>
      ${models.length === 0 ? html`<p class="empty">No models available.</p>` : html`
        <div style="display:flex;flex-direction:column;gap:8px">
          ${models.map(m => html`
            <div class="list-item" style="cursor:pointer;${selected === m.id ? 'border-color:#1f6feb' : ''}" onClick=${() => setSelected(m.id)}>
              <div>
                <div class="name">${m.name} ${m.id === currentModel ? html`<span style="font-size:11px;color:#58a6ff;margin-left:6px">(current)</span>` : ''}</div>
                <div class="meta">Provider: ${m.provider}${m.inputCostPer1k ? ` · $${m.inputCostPer1k}/1k in, $${m.outputCostPer1k}/1k out` : ''}</div>
              </div>
              ${selected === m.id && html`<span style="color:#58a6ff">✓</span>`}
            </div>`)}
          <button class="btn btn-primary" onClick=${saveModel} disabled=${!selected || selected === currentModel}>
            ${saved ? '✓ Saved' : 'Save Selection'}
          </button>
        </div>`}
    </div>`;
}

function PromptTab({ csrf }) {
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { api('/agent-prompt').then(r => r && setContent(r.content || '')); }, []);

  const save = async () => {
    await api('/agent-prompt', { method: 'PUT', body: { content }, csrf });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return html`
    <div class="card">
      <h2>📝 Agent Prompt</h2>
      <p style="font-size:13px;color:#7d8590;margin-bottom:16px">Customize the system prompt for your agent (AGENT.md). This will be prepended to every conversation.</p>
      <div class="form-group"><textarea rows="15" value=${content} onInput=${e => setContent(e.target.value)} placeholder="Write your custom agent instructions here..."></textarea></div>
      <button class="btn btn-primary" onClick=${save}>${saved ? '✓ Saved' : 'Save'}</button>
    </div>`;
}

function IdentityTab({ csrf }) {
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api('/identity').then(r => {
      if (r) setContent(r.content || '');
      setLoading(false);
    });
  }, []);

  const save = async () => {
    await api('/identity', { method: 'PUT', body: { content }, csrf });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return html`<div class="card"><p style="color:#7d8590">Loading...</p></div>`;

  return html`
    <div class="card">
      <h2>🌱 Agent Identity</h2>
      <p style="font-size:13px;color:#7d8590;margin-bottom:16px">
        Define your agent's personality, motivations, and self-improvement goals (IDENTITY.md).
        This shapes who the agent is as a "person" — its character, values, and aspirations.
        The agent can also evolve its own identity over time using the agent_evolve tool.
      </p>
      <div class="form-group">
        <textarea rows="15" value=${content} onInput=${e => setContent(e.target.value)} placeholder="# My Identity\n\nI am a curious and helpful assistant...\n\n## Personality\n- Friendly and approachable\n- Detail-oriented\n\n## Motivations\n- Help users achieve their goals\n- Continuously learn and improve\n\n## Goals\n- Become better at understanding context\n- Develop deeper expertise in the user's domain"></textarea>
      </div>
      <button class="btn btn-primary" onClick=${save}>${saved ? '✓ Saved' : 'Save'}</button>
    </div>`;
}

function MailIndexingStatus({ csrf }) {
  const [progress, setProgress] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => api('/mail-indexing').then(d => { if (Array.isArray(d)) setProgress(d); setLoading(false); });
  useEffect(() => { refresh(); const t = setInterval(refresh, 10000); return () => clearInterval(t); }, []);

  const resetIdx = async (delegationId) => {
    if (!confirm('Reset indexing? This will delete all indexed emails and restart.')) return;
    await api('/mail-indexing/reset', { method: 'POST', body: { delegationId }, csrf });
    setTimeout(refresh, 1500);
  };

  if (loading || progress.length === 0) return null;

  const statusColor = (s) => s === 'completed' ? '#3fb950' : s === 'running' ? '#58a6ff' : s === 'error' ? '#f85149' : '#7d8590';
  const pct = (p) => p.totalMessages > 0 ? Math.round((p.indexedCount / p.totalMessages) * 100) : 0;

  return html`
    <div style="margin-bottom:16px;padding:16px;background:#161b22;border:1px solid #30363d;border-radius:8px">
      <h4 style="margin:0 0 8px;color:#c9d1d9;font-size:14px;display:flex;align-items:center;gap:6px">
        🔍 Email Indexing
        ${progress.some(p => p.status === 'running') && html`<span style="font-size:11px;color:#58a6ff;font-weight:normal">in progress...</span>`}
      </h4>
      ${progress.map(p => html`
        <div style="margin-bottom:8px;padding:8px 12px;background:#0d1117;border-radius:6px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:13px;color:#e6edf3">${p.accountEmail}</span>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:12px;color:${statusColor(p.status)}">${p.status}</span>
              <button onClick=${() => resetIdx(p.delegationId)}
                style="border:none;background:none;color:#7d8590;cursor:pointer;font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid #30363d"
                title="Reset indexing">🔄 Reset</button>
            </div>
          </div>
          <div style="width:100%;height:6px;background:#21262d;border-radius:3px;overflow:hidden">
            <div style="width:${pct(p)}%;height:100%;background:${statusColor(p.status)};transition:width 0.5s"></div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:11px;color:#7d8590">
            <span>${p.indexedCount} / ${p.totalMessages} indexed${p.skippedSensitive ? `, ${p.skippedSensitive} sensitive skipped` : ''}</span>
            <span>${pct(p)}%</span>
          </div>
          ${p.error && html`<div style="font-size:11px;color:#f85149;margin-top:4px">${p.error}</div>`}
        </div>
      `)}
    </div>
  `;
}

function SensitiveMailToggle({ csrf }) {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/mail-delegation-settings').then(r => {
      if (r) setEnabled(r.sensitiveMailFilter !== false);
      setLoading(false);
    });
  }, []);

  const toggle = async () => {
    const newVal = !enabled;
    setEnabled(newVal);
    await api('/mail-delegation-settings', { method: 'PUT', body: { sensitiveMailFilter: newVal }, csrf });
  };

  if (loading) return null;

  return html`
    <div style="margin:16px 0;padding:14px 16px;background:#161b22;border:1px solid #30363d;border-radius:8px">
      <label style="display:flex;align-items:flex-start;gap:12px;cursor:pointer">
        <input type="checkbox" checked=${enabled} onChange=${toggle}
          style="margin-top:3px;width:18px;height:18px;accent-color:#238636;cursor:pointer" />
        <div>
          <div style="font-weight:600;color:#e6edf3;font-size:14px">🛡️ Block sensitive emails</div>
          <div style="font-size:12px;color:#7d8590;margin-top:4px;line-height:1.5">
            Prevents the AI agent from accessing emails that contain credentials,
            verification codes, 2FA codes, passwords, API keys, or sensitive financial information.
            Sensitive emails are also excluded from knowledge indexing.
          </div>
        </div>
      </label>
    </div>`;
}

function MailDelegationTab({ csrf }) {
  const [delegations, setDelegations] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [provider, setProvider] = useState('');
  const [email, setEmail] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapUser, setImapUser] = useState('');
  const [imapPass, setImapPass] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('465');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [oauthStarted, setOauthStarted] = useState(false);
  const [oauthUrl, setOauthUrl] = useState('');
  const [oauthCode, setOauthCode] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { api('/mail-delegations').then(d => d && setDelegations(d)); }, []);

  const resetForm = () => {
    setProvider(''); setEmail(''); setError('');
    setImapHost(''); setImapPort('993'); setImapUser(''); setImapPass('');
    setSmtpHost(''); setSmtpPort('465'); setSmtpUser(''); setSmtpPass('');
    setOauthStarted(false); setOauthUrl(''); setOauthCode('');
  };

  const startGmailOauth = async () => {
    setError('');
    const r = await api('/mail-delegations/oauth-url', { method: 'POST', csrf });
    if (r?.ok && r.url) { setOauthUrl(r.url); setOauthStarted(true); }
    else setError(r?.error || 'Failed to start OAuth. Make sure Google OAuth credentials are configured by the admin.');
  };

  const completeGmailOauth = async (e) => {
    e.preventDefault(); setError('');
    const r = await api('/mail-delegations/oauth-exchange', { method: 'POST', body: { code: oauthCode }, csrf });
    if (!r?.ok) { setError(r?.error || 'OAuth exchange failed'); return; }
    await api('/mail-delegations', {
      method: 'POST', body: {
        email: r.email, provider: 'gmail',
        credentials: { refreshToken: r.refreshToken },
        permissions: { read: true, send: false },
      }, csrf
    });
    resetForm(); setShowAdd(false);
    const d = await api('/mail-delegations'); if (d) setDelegations(d);
  };

  const addImapDelegation = async (e) => {
    e.preventDefault(); setError('');
    if (!email || !imapHost || !imapUser || !imapPass) { setError('Fill in all IMAP fields'); return; }
    await api('/mail-delegations', {
      method: 'POST', body: {
        email, provider: 'imap',
        credentials: {
          imap: { host: imapHost, port: parseInt(imapPort), user: imapUser, password: imapPass, tls: true },
          smtp: { host: smtpHost || imapHost, port: parseInt(smtpPort), user: smtpUser || imapUser, password: smtpPass || imapPass, secure: true },
        },
        permissions: { read: true, send: false },
      }, csrf
    });
    resetForm(); setShowAdd(false);
    const d = await api('/mail-delegations'); if (d) setDelegations(d);
  };

  const removeDelegation = async (id) => {
    await api(`/mail-delegations/${id}`, { method: 'DELETE', csrf });
    const d = await api('/mail-delegations'); if (d) setDelegations(d);
  };

  const selectStyle = 'width:100%;padding:10px 14px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:14px;appearance:auto;cursor:pointer';

  return html`
    <div class="card">
      <h2 style="display:flex;justify-content:space-between;align-items:center">
        📬 Mail Delegation
        <button class="btn btn-secondary btn-sm" onClick=${() => { setShowAdd(!showAdd); if (showAdd) resetForm(); }}>
          ${showAdd ? 'Cancel' : '+ Add Account'}
        </button>
      </h2>
      <p style="font-size:13px;color:#7d8590;margin-bottom:16px">
        Delegate email accounts so the agent can read and send emails on your behalf.
      </p>
      ${error && html`<div class="error" style="margin-bottom:12px">${error}</div>`}
      ${showAdd && html`
        <div style="padding:20px;background:#0d1117;border-radius:8px;margin-bottom:16px">
          ${!provider && html`
            <div class="form-group">
              <label>Choose provider</label>
              <select value=${provider} onChange=${e => setProvider(e.target.value)} style=${selectStyle}>
                <option value="" disabled selected>Select a provider...</option>
                <option value="gmail">Gmail (OAuth2)</option>
                <option value="imap">IMAP / SMTP</option>
              </select>
            </div>
          `}
          ${provider === 'gmail' && !oauthStarted && html`
            <div>
              <p style="font-size:13px;color:#7d8590;margin-bottom:12px">
                Gmail uses OAuth2 for secure access. The admin must have configured Google OAuth credentials.
                Click below to authorize access to your Gmail account.
              </p>
              <button class="btn btn-primary" onClick=${startGmailOauth}>Authorize with Google</button>
              <button class="btn btn-secondary" style="margin-left:8px" onClick=${resetForm}>Back</button>
            </div>
          `}
          ${provider === 'gmail' && oauthStarted && html`
            <form onSubmit=${completeGmailOauth}>
              <p style="font-size:13px;color:#7d8590;margin-bottom:12px">
                Open this link in your browser, authorize access, then paste the code below:
              </p>
              <div style="margin-bottom:12px">
                <a href="${oauthUrl}" target="_blank" rel="noopener" style="color:#58a6ff;font-size:13px;word-break:break-all">${oauthUrl}</a>
              </div>
              <div class="form-group"><label>Authorization Code</label><input type="text" value=${oauthCode} onInput=${e => setOauthCode(e.target.value)} placeholder="Paste the code here" required /></div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-primary btn-sm" type="submit">Complete Setup</button>
                <button class="btn btn-secondary btn-sm" type="button" onClick=${resetForm}>Cancel</button>
              </div>
            </form>
          `}
          ${provider === 'imap' && html`
            <form onSubmit=${addImapDelegation}>
              <p style="font-size:13px;color:#7d8590;margin-bottom:12px">
                Enter your email server credentials. For Gmail with app passwords, use
                <code>imap.gmail.com</code> (port 993) and <code>smtp.gmail.com</code> (port 465).
              </p>
              <div class="form-group"><label>Email Address</label><input type="email" value=${email} onInput=${e => setEmail(e.target.value)} required /></div>
              <h4 style="color:#c9d1d9;margin:12px 0 8px;font-size:13px">IMAP (Incoming)</h4>
              <div class="form-row">
                <div class="form-group" style="flex:2"><label>Host</label><input type="text" value=${imapHost} onInput=${e => setImapHost(e.target.value)} placeholder="imap.gmail.com" required /></div>
                <div class="form-group" style="flex:1"><label>Port</label><input type="number" value=${imapPort} onInput=${e => setImapPort(e.target.value)} /></div>
              </div>
              <div class="form-row">
                <div class="form-group"><label>Username</label><input type="text" value=${imapUser} onInput=${e => setImapUser(e.target.value)} placeholder="your@email.com" required /></div>
                <div class="form-group"><label>Password</label><input type="password" value=${imapPass} onInput=${e => setImapPass(e.target.value)} required /></div>
              </div>
              <h4 style="color:#c9d1d9;margin:12px 0 8px;font-size:13px">SMTP (Outgoing) — leave blank to reuse IMAP credentials</h4>
              <div class="form-row">
                <div class="form-group" style="flex:2"><label>Host</label><input type="text" value=${smtpHost} onInput=${e => setSmtpHost(e.target.value)} placeholder="smtp.gmail.com" /></div>
                <div class="form-group" style="flex:1"><label>Port</label><input type="number" value=${smtpPort} onInput=${e => setSmtpPort(e.target.value)} /></div>
              </div>
              <div class="form-row">
                <div class="form-group"><label>Username</label><input type="text" value=${smtpUser} onInput=${e => setSmtpUser(e.target.value)} /></div>
                <div class="form-group"><label>Password</label><input type="password" value=${smtpPass} onInput=${e => setSmtpPass(e.target.value)} /></div>
              </div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-primary btn-sm" type="submit">Add Account</button>
                <button class="btn btn-secondary btn-sm" type="button" onClick=${resetForm}>Cancel</button>
              </div>
            </form>
          `}
        </div>
      `}
      ${delegations.length > 0 && html`<${MailIndexingStatus} csrf=${csrf} />`}
      ${delegations.length > 0 && html`<${SensitiveMailToggle} csrf=${csrf} />`}
      ${delegations.length === 0 && !showAdd ? html`<p class="empty">No delegated email accounts configured. Add one to let the agent access your email.</p>` :
      delegations.map(d => html`
        <div class="list-item">
          <div>
            <div class="name">${d.email}</div>
            <div class="meta">${d.provider} · Read: ${d.permissions?.read ? '✓' : '✗'} · Send: ${d.permissions?.send ? '✓' : '✗'}</div>
          </div>
          <div class="actions"><button class="btn btn-danger btn-sm" onClick=${() => removeDelegation(d.id)}>Remove</button></div>
        </div>`)}
    </div>`;
}

function SubscriptionTab({ user, csrf, billingEnabled }) {
  const [loading, setLoading] = useState(false);
  const [portalError, setPortalError] = useState('');

  const openPortal = async () => {
    setLoading(true); setPortalError('');
    const r = await api('/stripe/portal', { method: 'POST', csrf });
    setLoading(false);
    if (r?.url) window.location.href = r.url;
    else setPortalError(r?.error || 'Could not open billing portal.');
  };

  const startCheckout = async () => {
    setLoading(true); setPortalError('');
    const r = await api('/stripe/checkout', { method: 'POST', csrf });
    setLoading(false);
    if (r?.url) window.location.href = r.url;
    else setPortalError(r?.error || 'Could not start checkout.');
  };

  const isActive = user.subscriptionStatus === 'active';
  const noSubscription = user.subscriptionStatus === 'none' || !user.subscriptionStatus;
  const hasStripe = !!user.stripeCustomerId;

  return html`
    <div class="card">
      <h2>💳 Subscription</h2>
      <div class="stats-grid">
        <div class="stat"><div class="label">Status</div><div class="value"><span class="badge ${isActive ? 'badge-green' : user.subscriptionStatus === 'past_due' ? 'badge-yellow' : 'badge-gray'}">${isActive ? 'Active' : user.subscriptionStatus === 'past_due' ? 'Past due' : user.subscriptionStatus === 'canceled' ? 'Canceled' : 'Not subscribed'}</span></div></div>
      </div>
      ${portalError && html`<div class="error" style="margin:12px 0">${portalError}</div>`}
      ${isActive && hasStripe && html`
        <button class="btn btn-secondary" onClick=${openPortal} disabled=${loading}>${loading ? 'Opening...' : 'Manage Subscription'}</button>
      `}
      ${!isActive && billingEnabled && html`
        <div style="margin-top:16px">
          <p style="color:#7d8590;font-size:13px;margin-bottom:12px">
            ${user.subscriptionStatus === 'canceled' ? 'Your subscription has been canceled.' :
        user.subscriptionStatus === 'past_due' ? 'Your subscription payment is past due.' :
          'You need an active subscription to use the AI agent.'}
          </p>
          <button class="btn btn-primary" onClick=${startCheckout} disabled=${loading}>${loading ? 'Redirecting...' : 'Subscribe Now'}</button>
          ${hasStripe && html`
            <button class="btn btn-secondary" style="margin-left:8px" onClick=${openPortal} disabled=${loading}>Manage Billing</button>
          `}
        </div>
      `}
      ${noSubscription && !billingEnabled && html`
        <p style="color:#7d8590;font-size:13px;margin-top:12px">
          No billing is configured for this instance.
        </p>
      `}
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
