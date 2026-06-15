// popup.js — StudySnap v2.0 Popup Controller

const BACKEND_URL = 'https://trystudysnap.com';

document.addEventListener('DOMContentLoaded', async () => {

  // ── View refs ───────────────────────────────────────────────
  const viewLogin   = document.getElementById('viewLogin');
  const viewMain    = document.getElementById('viewMain');
  const viewHistory = document.getElementById('viewHistory');
  const viewAccount = document.getElementById('viewAccount');

  // ── Login view ──────────────────────────────────────────────
  const signInBtn    = document.getElementById('signInBtn');
  const loginError   = document.getElementById('loginError');
  const refCodeInput = document.getElementById('refCodeInput');

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
  const upgradePrompt   = document.getElementById('upgradePrompt');
  const upgradeBtn      = document.getElementById('upgradeBtn');
  const shareToggleBtn  = document.getElementById('shareToggleBtn');
  const sharePlatforms  = document.getElementById('sharePlatforms');
  const selectBtn       = document.getElementById('selectBtn');
  const askInput        = document.getElementById('askInput');
  const askBtn          = document.getElementById('askBtn');
  const referralProgress = document.getElementById('referralProgress');
  const referralLink     = document.getElementById('referralLink');
  const referralCopyBtn  = document.getElementById('referralCopyBtn');

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

  const { ss_access_token: token } =
    await chrome.storage.local.get(['ss_access_token']);

  if (token) {
    showView(viewMain);
    // Ask background to refresh token if expired, then load usage
    chrome.runtime.sendMessage({ action: 'getValidToken' }, ({ token: freshToken } = {}) => {
      loadUsage(freshToken || token);
    });
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

    // Store referral code so background.js can claim it after sign-in
    const code = refCodeInput?.value?.trim();
    if (code) await chrome.storage.local.set({ pending_referral_code: code });

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

      // Ko-fi credits — show the badge whenever the user has any
      const creditsWrap  = document.getElementById('creditsWrap');
      const creditsCount = document.getElementById('creditsCount');
      if (creditsWrap && creditsCount) {
        if (data.credits > 0) {
          creditsCount.textContent = data.credits;
          creditsWrap.hidden = false;
        } else {
          creditsWrap.hidden = true;
        }
      }

      if (data.isPro) {
        const used = data.usedThisMonth ?? 0;
        proBadgeWrap.querySelector('.pro-badge').textContent =
          `⚡ Pro — ${used} captures this month`;
        usageWrap.hidden      = true;
        proBadgeWrap.hidden   = false;
        upgradePrompt.hidden  = true;
        captureBtn.disabled   = false;
        selectBtn.hidden      = false;
      } else {
        const used  = data.usedToday ?? 0;
        const limit = data.limit     ?? 5;
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

  // ── Share for +1 — multi-platform ─────────────────────────────────────────

  const SHARE_URL  = 'https://trystudysnap.com';
  const SHARE_TEXT = 'I\'m using StudySnap to get instant AI answers on any study question 📸⚡\n\nFree to try:';

  shareToggleBtn.addEventListener('click', () => {
    const open = sharePlatforms.hidden;
    sharePlatforms.hidden = !open;
    shareToggleBtn.classList.toggle('share-open', open);
  });

  sharePlatforms.addEventListener('click', async (e) => {
    const btn = e.target.closest('.platform-btn');
    if (!btn) return;

    const platform = btn.dataset.platform;
    const { ss_user: user } = await chrome.storage.local.get('ss_user');
    const refParam = user?.id ? `?ref=${user.id.slice(0, 8)}` : '';
    const url      = SHARE_URL + refParam;
    const text     = encodeURIComponent(`${SHARE_TEXT} ${url}`);

    const shareUrls = {
      twitter:  `https://twitter.com/intent/tweet?text=${text}`,
      whatsapp: `https://wa.me/?text=${text}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    };

    if (platform === 'copy') {
      await navigator.clipboard.writeText(`${SHARE_TEXT} ${url}`);
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.innerHTML = '📋 Copy link <span class="platform-note">(Instagram · TikTok)</span>'; }, 2000);
    } else {
      chrome.tabs.create({ url: shareUrls[platform] });
    }

    // Credit +1 immediately (honor system) — only once per day
    await claimShareReward();
  });

  async function claimShareReward() {
    try {
      const { ss_access_token: token } = await chrome.storage.local.get('ss_access_token');
      if (!token) return;
      const res  = await fetch(`${BACKEND_URL}/api/reward`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        shareToggleBtn.textContent = '✓ +1 capture added!';
        shareToggleBtn.classList.add('share-claimed');
        sharePlatforms.hidden = true;
        captureBtn.disabled   = false;
        if (token) loadUsage(token);
      } else {
        shareToggleBtn.textContent = '📢 Already shared today';
      }
    } catch { /* silent */ }
  }

  // ── Select Area (Pro) ──────────────────────────────────────────────────────

  selectBtn.addEventListener('click', () => {
    // Send message FIRST, then close — closing before sending kills the context
    chrome.runtime.sendMessage({ action: 'captureSelection' });
    window.close();
  });

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

  // ── Type-your-own-question ──────────────────────────────────
  function submitQuestion() {
    const q = askInput.value.trim();
    if (!q) { askInput.focus(); return; }

    setLoading(true);
    clearStatus();
    upgradePrompt.hidden = true;

    chrome.runtime.sendMessage({ action: 'askQuestion', question: q }, (response) => {
      if (chrome.runtime.lastError) {
        setLoading(false);
        showStatus('error', 'Extension error — please try again.');
        return;
      }

      setLoading(false);

      if (response?.success) {
        askInput.value = '';
        showStatus('success', '✓ Answer ready — check the page!');
        setTimeout(() => window.close(), 1800);
      } else if (response?.limitReached) {
        upgradePrompt.hidden = false;
        showStatus('error', 'Daily limit reached.');
        chrome.storage.local.get('ss_access_token').then(({ ss_access_token: t }) => {
          if (t) loadUsage(t);
        });
      } else {
        showStatus('error', response?.error || 'Something went wrong.');
      }
    });
  }

  askBtn.addEventListener('click', submitQuestion);
  askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQuestion(); });

  function setLoading(active) {
    captureBtn.disabled = active;
    askBtn.disabled     = active;
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

  // ── Referral copy button ───────────────────────────────────────────────────
  referralCopyBtn.addEventListener('click', async () => {
    const text = referralLink.textContent;
    if (!text || text === 'Loading…') return;
    await navigator.clipboard.writeText(text);
    referralCopyBtn.textContent = '✓ Copied';
    setTimeout(() => { referralCopyBtn.textContent = 'Copy'; }, 2000);
  });

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
          const limit = data.limit     ?? 5;
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

    // ── Referral link + progress ───────────────────────────────────────────
    if (user?.id) {
      const shortCode = user.id.slice(0, 8);
      const refUrl    = `https://trystudysnap.com?ref=${shortCode}`;
      referralLink.textContent = refUrl;

      // Fetch referral stats
      try {
        const refRes  = await fetch(`${BACKEND_URL}/api/referrals`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (refRes.ok) {
          const refData = await refRes.json();
          const paying  = refData.paying ?? 0;
          const next    = refData.nextMilestone ?? 3;

          if (refData.hasPendingDiscount) {
            referralProgress.textContent = '🎉 $1 discount ready!';
            referralProgress.style.background = 'rgba(34,197,94,0.12)';
            referralProgress.style.borderColor = 'rgba(34,197,94,0.3)';
            referralProgress.style.color = '#22c55e';
          } else {
            referralProgress.textContent = `${paying}/3 paying · ${next} to go`;
          }
        }
      } catch { /* silent */ }
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
