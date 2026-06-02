// popup.js — StudySnap v2.0 Popup Controller

const BACKEND_URL = 'https://study-snap-tau.vercel.app';

document.addEventListener('DOMContentLoaded', async () => {

  // ── View refs ───────────────────────────────────────────────
  const viewLogin   = document.getElementById('viewLogin');
  const viewMain    = document.getElementById('viewMain');
  const viewHistory = document.getElementById('viewHistory');
  const viewAccount = document.getElementById('viewAccount');

  // ── Login view ──────────────────────────────────────────────
  const signInBtn   = document.getElementById('signInBtn');
  const loginError  = document.getElementById('loginError');

  // ── Main view ───────────────────────────────────────────────
  const captureBtn     = document.getElementById('captureBtn');
  const loadingEl      = document.getElementById('loading');
  const statusEl       = document.getElementById('status');
  const btnText        = captureBtn.querySelector('.btn-text');
  const historyBtn     = document.getElementById('historyBtn');
  const accountBtn     = document.getElementById('accountBtn');
  const usageWrap      = document.getElementById('usageWrap');
  const usageLabel     = document.getElementById('usageLabel');
  const usageCount     = document.getElementById('usageCount');
  const usageFill      = document.getElementById('usageFill');
  const proBadgeWrap   = document.getElementById('proBadgeWrap');
  const upgradePrompt  = document.getElementById('upgradePrompt');
  const upgradeBtn     = document.getElementById('upgradeBtn');

  // ── History view ────────────────────────────────────────────
  const historyBackBtn  = document.getElementById('historyBackBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const historyList     = document.getElementById('historyList');

  // ── Account view ────────────────────────────────────────────
  const accountBackBtn = document.getElementById('accountBackBtn');
  const accountAvatar  = document.getElementById('accountAvatar');
  const accountName    = document.getElementById('accountName');
  const accountEmail   = document.getElementById('accountEmail');
  const accountPlan    = document.getElementById('accountPlan');
  const signOutBtn     = document.getElementById('signOutBtn');

  // ────────────────────────────────────────────────────────────
  // Boot: decide which view to show
  // ────────────────────────────────────────────────────────────

  const { ss_access_token: token, ss_user: cachedUser } =
    await chrome.storage.local.get(['ss_access_token', 'ss_user']);

  if (token) {
    showView(viewMain);
    loadUsage(token);            // async — updates bar when it resolves
  } else {
    showView(viewLogin);
  }

  // ────────────────────────────────────────────────────────────
  // View switching
  // ────────────────────────────────────────────────────────────

  function showView(target, direction = 'right') {
    document.querySelectorAll('.view').forEach(v => { v.hidden = true; });
    target.hidden = false;
    const cls = direction === 'right' ? 'slide-in-right' : 'slide-in-left';
    target.classList.add(cls);
    target.addEventListener('animationend', () => target.classList.remove(cls), { once: true });
  }

  historyBtn.addEventListener('click', () => {
    showView(viewHistory, 'right');
    loadHistory();
  });

  historyBackBtn.addEventListener('click', () => showView(viewMain, 'left'));

  accountBtn.addEventListener('click', () => {
    showView(viewAccount, 'right');
    populateAccountView();
  });

  accountBackBtn.addEventListener('click', () => showView(viewMain, 'left'));

  // ────────────────────────────────────────────────────────────
  // Sign In
  // ────────────────────────────────────────────────────────────

  signInBtn.addEventListener('click', async () => {
    signInBtn.disabled = true;
    signInBtn.querySelector('span').textContent = 'Opening…';
    loginError.hidden = true;

    chrome.runtime.sendMessage({ action: 'signIn' }, async (response) => {
      signInBtn.disabled = false;
      signInBtn.querySelector('span').textContent = 'Continue with Google';

      if (chrome.runtime.lastError || !response?.success) {
        const msg = response?.error || 'Sign-in failed. Please try again.';
        loginError.textContent = msg;
        loginError.hidden = false;
        return;
      }

      // Signed in — switch to main and load usage
      showView(viewMain, 'right');
      const { ss_access_token: newToken } = await chrome.storage.local.get('ss_access_token');
      if (newToken) loadUsage(newToken);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Sign Out
  // ────────────────────────────────────────────────────────────

  signOutBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'signOut' }, () => {
      showView(viewLogin, 'left');
    });
  });

  // ────────────────────────────────────────────────────────────
  // Usage stats
  // ────────────────────────────────────────────────────────────

  async function loadUsage(accessToken) {
    try {
      const res  = await fetch(`${BACKEND_URL}/api/usage`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (!res.ok) return;

      const data = await res.json();

      // Save fresh user info
      if (data.user) {
        await chrome.storage.local.set({ ss_user: data.user });
      }

      if (data.isPro) {
        usageWrap.hidden    = true;
        proBadgeWrap.hidden = false;
      } else {
        const used  = data.usedToday ?? 0;
        const limit = data.limit     ?? 10;
        const pct   = Math.min(100, Math.round((used / limit) * 100));

        usageLabel.textContent = `${limit - used} capture${(limit - used) !== 1 ? 's' : ''} left today`;
        usageCount.textContent = `${used} / ${limit}`;
        usageFill.style.width  = `${pct}%`;
        usageFill.style.background =
          pct >= 100 ? '#f87171' :
          pct >= 70  ? '#fb923c' :
                       'linear-gradient(90deg, #6366f1, #8b5cf6)';

        usageWrap.hidden    = false;
        proBadgeWrap.hidden = true;

        // Auto-show upgrade prompt if limit is hit
        if (used >= limit) {
          upgradePrompt.hidden = false;
          captureBtn.disabled  = true;
        }
      }

    } catch (err) {
      console.warn('[StudySnap] Could not load usage:', err);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Upgrade to Pro
  // ────────────────────────────────────────────────────────────

  upgradeBtn.addEventListener('click', async () => {
    upgradeBtn.disabled = true;
    upgradeBtn.textContent = 'Opening checkout…';

    try {
      const { ss_access_token: token } = await chrome.storage.local.get('ss_access_token');
      const res = await fetch(`${BACKEND_URL}/api/subscribe`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (data.url) {
        chrome.tabs.create({ url: data.url });
        window.close();
      } else {
        upgradeBtn.textContent = 'Could not open checkout. Try again.';
        upgradeBtn.disabled = false;
      }
    } catch {
      upgradeBtn.textContent = 'Network error. Try again.';
      upgradeBtn.disabled = false;
    }
  });

  // ────────────────────────────────────────────────────────────
  // Capture flow
  // ────────────────────────────────────────────────────────────

  captureBtn.addEventListener('click', () => {
    setLoading(true);
    clearStatus();
    upgradePrompt.hidden = true;

    chrome.runtime.sendMessage({ action: 'captureAndAnalyze' }, (response) => {
      if (chrome.runtime.lastError) {
        setLoading(false);
        showStatus('error', 'Extension error — please try again.');
        return;
      }

      setLoading(false);

      if (response?.success) {
        showStatus('success', '✓ Answer ready — check the page!');
        setTimeout(() => window.close(), 1800);
      } else if (response?.limitReached) {
        upgradePrompt.hidden = false;
        captureBtn.disabled  = true;
        showStatus('error', 'Daily limit reached.');
        // Reload usage bar
        chrome.storage.local.get('ss_access_token').then(({ ss_access_token: t }) => {
          if (t) loadUsage(t);
        });
      } else {
        showStatus('error', response?.error || 'Something went wrong.');
      }
    });
  });

  function setLoading(active) {
    captureBtn.disabled = active;
    loadingEl.hidden    = !active;
    btnText.textContent = active ? 'Analyzing…' : 'Capture Question';
  }

  function showStatus(type, msg) {
    statusEl.textContent = msg;
    statusEl.className   = `status ${type}`;
  }

  function clearStatus() {
    statusEl.textContent = '';
    statusEl.className   = 'status';
  }

  // ────────────────────────────────────────────────────────────
  // Account view
  // ────────────────────────────────────────────────────────────

  async function populateAccountView() {
    const { ss_user: user, ss_access_token: token } =
      await chrome.storage.local.get(['ss_user', 'ss_access_token']);

    if (user?.avatar) {
      accountAvatar.src     = user.avatar;
      accountAvatar.hidden  = false;
    } else {
      accountAvatar.hidden = true;
    }

    accountName.textContent  = user?.name  || 'StudySnap User';
    accountEmail.textContent = user?.email || '';

    // Fetch up-to-date plan info
    if (token) {
      try {
        const res  = await fetch(`${BACKEND_URL}/api/usage`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json();

        if (data.isPro) {
          accountPlan.innerHTML = `
            <div class="plan-badge pro">⚡ Pro Plan</div>
            <p class="plan-note">Unlimited captures — thank you for supporting StudySnap!</p>`;
        } else {
          const used  = data.usedToday ?? 0;
          const limit = data.limit     ?? 10;
          accountPlan.innerHTML = `
            <div class="plan-badge free">Free Plan</div>
            <p class="plan-note">${used} of ${limit} captures used today.</p>
            <button class="upgrade-btn" id="acctUpgradeBtn">Upgrade to Pro — $4.99/mo</button>`;

          document.getElementById('acctUpgradeBtn')?.addEventListener('click', () => {
            upgradeBtn.click();
          });
        }
      } catch {
        accountPlan.innerHTML = `<p class="plan-note" style="color:#f87171">Could not load plan info.</p>`;
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // History: load & render
  // ────────────────────────────────────────────────────────────

  async function loadHistory() {
    const { studysnap_history: history = [] } =
      await chrome.storage.local.get('studysnap_history');
    renderHistory(history);
  }

  function renderHistory(history) {
    if (history.length === 0) {
      historyList.innerHTML = `
        <div class="history-empty">
          <span class="history-empty-icon">📋</span>
          No answers yet.<br>Capture a question to get started!
        </div>`;
      return;
    }

    historyList.innerHTML = history.map(entry => {
      const conf          = getConfidenceInfo(entry.confidence);
      const time          = formatTime(entry.ts);
      const feedbackBadge = entry.feedback === 'correct'
        ? '<span class="history-badge correct">👍</span>'
        : entry.feedback === 'incorrect'
          ? '<span class="history-badge incorrect">👎</span>'
          : '';
      return `
        <div class="history-item">
          <div class="history-item-header">
            <span class="history-time">${time}</span>
            <div class="history-item-meta">
              ${feedbackBadge}
              <span class="history-conf" style="color:${conf.color}">${entry.confidence}%</span>
            </div>
          </div>
          <div class="history-answer" data-answer></div>
          <div class="history-why"   data-why></div>
        </div>`;
    }).join('');

    // Set text safely (XSS — no innerHTML for user/AI data)
    const items = historyList.querySelectorAll('.history-item');
    history.forEach((entry, i) => {
      items[i].querySelector('[data-answer]').textContent = entry.answer;
      items[i].querySelector('[data-why]').textContent   = entry.why;
    });
  }

  function formatTime(ts) {
    const date      = new Date(ts);
    const now       = new Date();
    const isToday   = date.toDateString() === now.toDateString();
    const time      = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (isToday) return `Today, ${time}`;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;

    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${time}`;
  }

  // ────────────────────────────────────────────────────────────
  // History: clear with double-tap confirmation
  // ────────────────────────────────────────────────────────────

  let clearPending = false;
  let clearTimer   = null;

  clearHistoryBtn.addEventListener('click', async () => {
    if (!clearPending) {
      clearPending = true;
      clearHistoryBtn.textContent = 'Tap again to clear';
      clearHistoryBtn.classList.add('confirming');
      clearTimer = setTimeout(resetClearBtn, 2500);
      return;
    }
    clearTimeout(clearTimer);
    await chrome.storage.local.remove('studysnap_history');
    resetClearBtn();
    renderHistory([]);
  });

  function resetClearBtn() {
    clearPending = false;
    clearHistoryBtn.textContent = '🗑';
    clearHistoryBtn.classList.remove('confirming');
  }

});
