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

const BACKEND_URL      = 'https://study-snap-tau.vercel.app';
const SUPABASE_URL     = 'https://vmoqyntmuyrehrtzubmj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZtb3F5bnRtdXlyZWhydHp1Ym1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTE5ODAsImV4cCI6MjA5NTkyNzk4MH0.C3GfsbAabrLKIil8GZ6ICEmXgV5n1-W-oDPppFhgI20';

// ── Message listener ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'captureAndAnalyze') {
    runCaptureFlow(sendResponse);
    return true; // keep channel open for async response
  }
  if (message.action === 'getValidToken') {
    getValidToken().then(token => sendResponse({ token }));
    return true;
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

// ── PKCE helpers ─────────────────────────────────────────────

function base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generatePKCE() {
  const verifierBytes = new Uint8Array(56);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = base64urlEncode(verifierBytes);

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier)
  );
  const codeChallenge = base64urlEncode(digest);

  return { codeVerifier, codeChallenge };
}

// ── Google Sign-In (PKCE flow) ────────────────────────────────

async function signInWithGoogle(sendResponse) {
  try {
    const redirectUrl = chrome.identity.getRedirectURL();
    const { codeVerifier, codeChallenge } = await generatePKCE();

    const authUrl =
      `${SUPABASE_URL}/auth/v1/authorize` +
      `?provider=google` +
      `&redirect_to=${encodeURIComponent(redirectUrl)}` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=s256`;

    console.log('[StudySnap] Redirect URL:', redirectUrl);
    console.log('[StudySnap] Auth URL:', authUrl);

    // Open the Google sign-in popup
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

    console.log('[StudySnap] Auth redirect URL:', responseUrl);

    // Supabase PKCE returns ?code=... in the query string
    const code = new URL(responseUrl).searchParams.get('code');
    if (!code) throw new Error('No auth code in redirect URL.');

    // Exchange the code for tokens at Supabase's token endpoint
    const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
    });

    const tokens = await tokenRes.json();
    console.log('[StudySnap] Token exchange response:', tokenRes.status, JSON.stringify(tokens));

    if (!tokenRes.ok || !tokens.access_token) {
      throw new Error(tokens.error_description || tokens.message || 'Token exchange failed.');
    }

    const { access_token, refresh_token } = tokens;
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

    // Hide any existing overlay before capturing so it doesn't appear in the screenshot
    await chrome.tabs.sendMessage(tab.id, { action: 'hideOverlay' }).catch(() => {});

    // Capture the visible area of the page as a PNG data URL
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // Extract visible text from the DOM including selection state for better accuracy
    const [{ result: pageText }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          const lines = [];

          // Group inputs by question — mark entire question as answered if any option is selected
          const inputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
          const questionGroups = new Map();

          inputs.forEach(input => {
            const el    = input.closest('li, div, label, tr') || input.parentElement;
            const cls   = (el?.className || '') + ' ' + (input.className || '');
            const label =
              document.querySelector(`label[for="${input.id}"]`)?.innerText ||
              input.closest('label')?.innerText ||
              input.parentElement?.innerText || '';

            const cssSelected  = /selected|active|checked|correct|incorrect|wrong|answered|chosen|marked|correcto|incorrecto|verdadero|falso|acierto|error|bien|mal/i.test(cls);
            const ariaSelected = input.getAttribute('aria-checked') === 'true' ||
                                 el?.getAttribute('aria-selected') === 'true';

            // Color-based detection: green or red text means answered
            let colorAnswered = false;
            try {
              const optEl = input.closest('li, label, div') || input.parentElement;
              const rgb   = (window.getComputedStyle(optEl).color.match(/\d+/g) || [0,0,0]).map(Number);
              const isGreen = rgb[1] > 100 && rgb[1] > rgb[0] * 1.5 && rgb[1] > rgb[2] * 1.5;
              const isRed   = rgb[0] > 100 && rgb[0] > rgb[1] * 1.5 && rgb[0] > rgb[2] * 1.5;
              colorAnswered = isGreen || isRed;
            } catch {}

            const isSelected = input.checked || cssSelected || ariaSelected || colorAnswered;

            const groupKey = input.name || input.closest('fieldset, .question, .pregunta, li')?.id || input.parentElement?.parentElement?.id || 'group_' + Math.round(input.getBoundingClientRect().top / 70);
            if (!questionGroups.has(groupKey)) questionGroups.set(groupKey, { answered: false, options: [] });
            const g = questionGroups.get(groupKey);
            if (isSelected) g.answered = true;
            if (label.trim()) g.options.push({ label: label.trim(), isSelected });
          });

          questionGroups.forEach(({ answered, options }) => {
            if (answered) {
              lines.push('<<QUESTION ALREADY ANSWERED BY USER — SKIP THIS ENTIRE QUESTION>>');
            }
            options.forEach(({ label, isSelected }) => {
              lines.push(`${isSelected ? '[USER CHOSE THIS]' : '[ ]'} ${label}`);
            });
            lines.push('');
          });

          // Also grab the main content text (for question wording)
          const selectors = ['main', 'article', '[role="main"]', 'form', '.quiz', '.question', '#content', '.content'];
          let mainText = '';
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) { mainText = el.innerText.slice(0, 3000); break; }
          }
          if (!mainText) mainText = document.body.innerText.slice(0, 3000);

          return lines.length > 0
            ? `${mainText}\n\n--- Answer state ---\n${lines.join('\n')}`
            : mainText;
        } catch {
          return document.body.innerText.slice(0, 3000);
        }
      },
    }).catch(() => [{ result: null }]);

    // Send to backend for AI analysis
    const result = await callBackendAPI(screenshotDataUrl, pageText);

    // One unique ID per question so history entries and feedback stay correctly linked
    const now      = Date.now();
    const questions = result.questions ?? [];
    const entryIds  = questions.map((_, i) => now + i);

    // Inject overlay stylesheet and content script into the page
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['overlay.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

    // Give content script a moment to initialize before messaging it
    await delay(150);

    // Send all questions + their IDs to the content script
    await chrome.tabs.sendMessage(tab.id, {
      action: 'showOverlay',
      data:   { questions, entryIds }
    });

    // Save every question to history (non-blocking)
    questions.forEach((q, i) => saveToHistory(q, entryIds[i]));

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

// ── Token refresh ─────────────────────────────────────────────

async function getValidToken() {
  const { ss_access_token: token, ss_refresh_token: refreshToken } =
    await chrome.storage.local.get(['ss_access_token', 'ss_refresh_token']);

  if (!token) return null;

  // Check if the token expires within the next 60 seconds
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const expiresIn = payload.exp - Math.floor(Date.now() / 1000);
    if (expiresIn > 60) return token; // Still valid
  } catch {
    return token; // Can't decode — use as-is
  }

  // Token expired (or expiring soon) — refresh it
  if (!refreshToken) return token;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body:    JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) return token; // Refresh failed — fall back to old token

    const tokens = await res.json();
    if (!tokens.access_token) return token;

    await chrome.storage.local.set({
      ss_access_token:  tokens.access_token,
      ss_refresh_token: tokens.refresh_token || refreshToken,
    });

    return tokens.access_token;
  } catch {
    return token;
  }
}

// ── Backend API call ──────────────────────────────────────────

async function callBackendAPI(screenshotDataUrl, pageText = null) {
  const token = await getValidToken();

  const response = await fetch(`${BACKEND_URL}/api/analyze`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ imageDataUrl: screenshotDataUrl, token, pageText }),
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
