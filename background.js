// background.js — StudySnap v2.0 Service Worker
//
// Flow:
//   popup.js  ->  [captureAndAnalyze]  ->  background.js
//                                            | captureVisibleTab
//                                            | callBackendAPI  (Vercel + OpenAI)
//                                            | inject content.js + overlay.css
//                                            v
//                                         content.js  ->  overlay shown on page
//
//   popup.js  ->  [signIn]  ->  background.js
//                                | chrome.identity.launchWebAuthFlow
//                                | parse tokens from redirect URL
//                                | store in chrome.storage.local

const BACKEND_URL  = 'https://study-snap-tau.vercel.app';
const SUPABASE_URL = 'https://vmoqyntmuyrehrtzubmj.supabase.co';

// ── Message listener ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'captureAndAnalyze') {
    runCaptureFlow(sendResponse);
    return true; // keep channel open for async response
  }
  if (message.action === 'signIn') {
    signInWithGoogle(sendResponse);
    return true;
  }
  if (message.action === 'signOut') {
    chrome.storage.local.remove(['ss_access_token', 'ss_refresh_token', 'ss_user']);
    sendResponse({ success: true });
    return false;
  }
  if (message.action === 'saveFeedback') {
    updateHistoryFeedback(message.entryId, message.feedback);
    return false;
  }
});

// ── Google Sign-In ────────────────────────────────────────────

async function signInWithGoogle(sendResponse) {
  try {
    // chrome.identity.getRedirectURL() returns the exact URL Chrome expects
    // e.g. https://<extension-id>.chromiumapp.org/
    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl =
      `${SUPABASE_URL}/auth/v1/authorize` +
      `?provider=google` +
      `&redirect_to=${encodeURIComponent(redirectUrl)}`;

    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        (url) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!url) return reject(new Error('Auth window closed'));
          resolve(url);
        }
      );
    });

    // Tokens are in the URL hash after Supabase redirects back
    const hash   = new URL(responseUrl).hash.substring(1); // strip leading '#'
    const params = new URLSearchParams(hash);

    const access_token  = params.get('access_token');
    const refresh_token = params.get('refresh_token');

    if (!access_token) throw new Error('No access token in redirect URL');

    // Decode user info from the JWT payload (no extra fetch needed)
    const user = parseJwtPayload(access_token);

    await chrome.storage.local.set({
      ss_access_token:  access_token,
      ss_refresh_token: refresh_token,
      ss_user:          user,
    });

    sendResponse({ success: true, user });

  } catch (err) {
    console.error('[StudySnap] Sign-in error:', err);
    sendResponse({ success: false, error: err.message || 'Sign-in failed' });
  }
}

function parseJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    // Base64-URL decode
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const data = JSON.parse(json);
    return {
      id:     data.sub,
      email:  data.email,
      name:   data.user_metadata?.full_name  || data.email,
      avatar: data.user_metadata?.avatar_url || null,
    };
  } catch {
    return {};
  }
}

// ── Main capture flow ─────────────────────────────────────────

async function runCaptureFlow(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      return sendResponse({ success: false, error: 'No active tab found.' });
    }

    // Capture the visible area of the page as a PNG data URL
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // Send to backend for AI analysis
    const result = await callBackendAPI(screenshotDataUrl);

    // Generate a shared ID so overlay and history entry stay linked
    const entryId = Date.now();

    // Inject overlay stylesheet and content script into the page
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['overlay.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

    // Give content script a moment to initialize before messaging it
    await delay(150);

    await chrome.tabs.sendMessage(tab.id, { action: 'showOverlay', data: { ...result, entryId } });

    // Save to history (non-blocking)
    saveToHistory(result, entryId);

    sendResponse({ success: true });

  } catch (err) {
    console.error('[StudySnap]', err);

    if (err.limitReached) {
      return sendResponse({
        success: false,
        error: err.message,
        limitReached: true,
      });
    }

    sendResponse({ success: false, error: friendlyError(err.message) });
  }
}

// ── Backend API call ──────────────────────────────────────────

async function callBackendAPI(screenshotDataUrl) {
  const { ss_access_token: token } = await chrome.storage.local.get('ss_access_token');

  const response = await fetch(`${BACKEND_URL}/api/analyze`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ imageDataUrl: screenshotDataUrl, token }),
  });

  const data = await response.json();

  if (response.status === 429 && data.limitReached) {
    const err = new Error(data.error || 'Daily limit reached. Upgrade to Pro for unlimited captures.');
    err.limitReached = true;
    throw err;
  }

  if (!response.ok) {
    throw new Error(data.error || `Server error ${response.status}`);
  }

  return data;
}

// ── History ───────────────────────────────────────────────────

async function saveToHistory(result, id = Date.now()) {
  try {
    const { studysnap_history: history = [] } = await chrome.storage.local.get('studysnap_history');
    const entry = {
      id,
      ts:           id,
      questionType: result.questionType,
      answer:       result.answer,
      why:          result.why,
      confidence:   result.confidence,
      feedback:     null,
    };
    const updated = [entry, ...history].slice(0, 50);
    await chrome.storage.local.set({ studysnap_history: updated });
  } catch (err) {
    console.warn('[StudySnap] History save failed:', err);
  }
}

async function updateHistoryFeedback(entryId, feedback) {
  try {
    const { studysnap_history: history = [] } = await chrome.storage.local.get('studysnap_history');
    const updated = history.map(e => e.id === entryId ? { ...e, feedback } : e);
    await chrome.storage.local.set({ studysnap_history: updated });
  } catch (err) {
    console.warn('[StudySnap] Feedback save failed:', err);
  }
}

// ── Helpers ───────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function friendlyError(raw = '') {
  const r = raw.toLowerCase();

  if (r.includes('failed to fetch') || r.includes('networkerror') || r.includes('load failed')) {
    return 'Network error — check your internet connection.';
  }
  if (raw.includes('Cannot access') || raw.includes('chrome://') || raw.includes('extension://')) {
    return 'Cannot capture this page. Navigate to a regular website first.';
  }
  if (raw.includes('Content Security Policy')) {
    return 'This page blocks script injection. Try a different website.';
  }
  if (r.includes('json') || r.includes('unexpected token') || r.includes('syntaxerror')) {
    return 'AI returned an unexpected response. Try again.';
  }
  if (raw.includes('Auth window closed')) {
    return 'Sign-in was cancelled.';
  }

  console.warn('[StudySnap] Unmatched error:', raw);
  return raw.slice(0, 100) || 'Something went wrong. Please try again.';
}
