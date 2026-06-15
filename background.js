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

const BACKEND_URL      = 'https://trystudysnap.com';
const SUPABASE_URL     = 'https://vmoqyntmuyrehrtzubmj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZtb3F5bnRtdXlyZWhydHp1Ym1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTE5ODAsImV4cCI6MjA5NTkyNzk4MH0.C3GfsbAabrLKIil8GZ6ICEmXgV5n1-W-oDPppFhgI20';

// ── Message listener ──────────────────────────────────────────

// Resolves the pending region selection promise (set by runSelectionFlow)
let pendingSelectionResolve = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'captureAndAnalyze') {
    runCaptureFlow(sendResponse);
    return true;
  }
  if (message.action === 'captureSelection') {
    runSelectionFlow(sendResponse);
    return true;
  }
  if (message.action === 'selectionComplete') {
    pendingSelectionResolve?.(message.rect);
    return false;
  }
  if (message.action === 'selectionCancelled') {
    pendingSelectionResolve?.(null);
    return false;
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
  if (message.action === 'askQuestion') {
    runTextQuestionFlow(message.question, sendResponse);
    return true;
  }
});

// ── Keyboard shortcut (Ctrl/Cmd+Shift+K) ──────────────────────
// Fires the same capture flow as clicking "Capture Question". There is no
// popup to respond to, so we pass a no-op callback — the answer overlay appears
// on the page on success.
chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-question') {
    runCaptureFlow(() => {});
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

    // If a referral code was entered on the login screen, claim it now
    const { pending_referral_code: refCode } = await chrome.storage.local.get('pending_referral_code');
    if (refCode) {
      chrome.storage.local.remove('pending_referral_code');
      fetch(`${BACKEND_URL}/api/referrals`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${access_token}`,
        },
        body: JSON.stringify({ referralCode: refCode }),
      }).catch(() => {});
    }

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

    // Extract visible text from the DOM including selection state for better accuracy.
    // Inject into ALL frames — some quizzes render inside an iframe, so the top
    // document only holds nav/cookie chrome.
    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        try {
          const lines = [];

          // Detect all option elements — native inputs AND ARIA-based custom elements
          const optionSelector = [
            'input[type="radio"]', 'input[type="checkbox"]',
            '[role="radio"]', '[role="checkbox"]',
            '[role="option"]', '[role="menuitemradio"]',
          ].join(', ');
          const inputs = document.querySelectorAll(optionSelector);
          const questionGroups = new Map();

          inputs.forEach(input => {
            const isNativeInput = input instanceof HTMLInputElement;
            const el  = input.closest('li, div, label, tr') || input.parentElement;

            // Get the label text
            const label = isNativeInput
              ? (document.querySelector(`label[for="${input.id}"]`)?.innerText ||
                 input.closest('label')?.innerText ||
                 input.parentElement?.innerText || '')
              : (input.innerText || input.textContent || '');

            // CSS class answered detection — scope to the OPTION itself (its own
            // class + nearest label/li/role element), never a broad container, and
            // match WHOLE words so generic classes like "normal" (contains "mal"),
            // "active", or validation "error" classes can't trigger a false positive.
            const optCls = (
              (input.closest('label, li, [role]')?.className || '') + ' ' +
              (input.className || '')
            ).toString().toLowerCase();
            const cssSelected =
              /\b(selected|checked|chosen|correct|incorrect|wrong|answered|correcto|incorrecto|acierto)\b/.test(optCls);

            // ARIA answered detection — covers custom quiz elements
            const ariaSelected =
              input.getAttribute('aria-checked')  === 'true' ||
              input.getAttribute('aria-selected') === 'true' ||
              input.getAttribute('aria-pressed')  === 'true' ||
              input.getAttribute('data-selected') === 'true' ||
              input.getAttribute('data-state') === 'checked' ||
              input.getAttribute('data-state') === 'selected' ||
              el?.getAttribute('aria-selected')  === 'true';

            // Color-based grading detection (green = correct, red = wrong, shown
            // AFTER a question is answered). Inspect ONLY this option's own label
            // element and its direct children — never the question title, which can
            // carry a red required-field "*" that would falsely flag the question.
            let colorAnswered = false;
            try {
              // The element holding THIS option's label text (option-scoped, so we
              // never climb up to the shared question container).
              const labelEl =
                (isNativeInput && input.id && document.querySelector(`label[for="${input.id}"]`)) ||
                input.closest('label') ||
                input.parentElement;

              const toCheck = [labelEl, ...Array.from(labelEl?.children || [])];
              for (const node of toCheck) {
                if (!node) continue;
                const txt    = (node.textContent || '').trim();
                const isIcon = /^(svg|i|img|use|path|span)$/i.test(node.tagName) && txt === '';
                // Ignore empty/asterisk-only text nodes (a red "*" is a required
                // marker, not a graded answer). Real grading colors the option's
                // words, or shows a dedicated icon — both still pass.
                if (!isIcon && (txt === '' || /^[*\s]+$/.test(txt))) continue;
                const rgb     = (window.getComputedStyle(node).color.match(/\d+/g) || [0,0,0]).map(Number);
                const isGreen = rgb[1] > 100 && rgb[1] > rgb[0] * 1.5 && rgb[1] > rgb[2] * 1.5;
                const isRed   = rgb[0] > 100 && rgb[0] > rgb[1] * 1.5 && rgb[0] > rgb[2] * 1.5;
                if (isGreen || isRed) { colorAnswered = true; break; }
              }
            } catch {}

            const nativeChecked = isNativeInput && input.checked;
            const isSelected    = nativeChecked || cssSelected || ariaSelected || colorAnswered;

            // Group by name attr, ARIA group, or position bucket
            const name     = isNativeInput ? input.name : null;
            const groupKey = name ||
              input.closest('fieldset, [role="radiogroup"], [role="group"], .question, .pregunta, li')?.id ||
              input.parentElement?.parentElement?.id ||
              'group_' + Math.round(input.getBoundingClientRect().top / 70);

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
    }).catch(() => []);

    // Combine text across frames. The quiz frame (with real questions) is usually
    // the largest, so order by length and let it lead; cap the total payload.
    const pageText = (frameResults || [])
      .map(r => r?.result)
      .filter(t => typeof t === 'string' && t.trim())
      .sort((a, b) => b.length - a.length)
      .join('\n\n----- (next frame) -----\n\n')
      .slice(0, 6000) || null;

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

// ── Typed question flow (no screenshot) ───────────────────────

async function runTextQuestionFlow(question, sendResponse) {
  try {
    const q = (question || '').trim();
    if (!q) return sendResponse({ success: false, error: 'Please type a question.' });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return sendResponse({ success: false, error: 'No active tab found.' });

    const result    = await callBackendAPI(null, null, { question: q });
    const now        = Date.now();
    const questions  = result.questions ?? [];
    const entryIds   = questions.map((_, i) => now + i);

    // Show the answer in the same overlay, on the current page
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['overlay.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await delay(150);
    await chrome.tabs.sendMessage(tab.id, { action: 'showOverlay', data: { questions, entryIds } });

    questions.forEach((q, i) => saveToHistory(q, entryIds[i]));
    sendResponse({ success: true });

  } catch (err) {
    console.error('[StudySnap] Text question error:', err);
    if (err.limitReached) return sendResponse({ success: false, error: err.message, limitReached: true });
    sendResponse({ success: false, error: friendlyError(err.message) });
  }
}

// ── Pro: region selection capture ────────────────────────────

async function runSelectionFlow(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return sendResponse({ success: false, error: 'No active tab found.' });

    // Hide any existing overlay so it doesn't interfere with selection
    await chrome.tabs.sendMessage(tab.id, { action: 'hideOverlay' }).catch(() => {});

    // Inject the selection crosshair UI
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selector.js'] });

    // Wait for the user to draw a rectangle (or cancel)
    const rect = await new Promise((resolve) => {
      pendingSelectionResolve = resolve;
      setTimeout(() => resolve(null), 60000); // 60s timeout
    });
    pendingSelectionResolve = null;

    if (!rect) return sendResponse({ success: false, error: 'Selection cancelled.' });

    // Small pause so the selector overlay is fully gone before capturing
    await delay(120);

    // Capture the full visible tab, then crop to the selected region
    const fullScreenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    const croppedDataUrl = await cropScreenshot(fullScreenshot, rect);

    // Region capture: skip gpt-4o-mini entirely — user drew a box for precision
    const result = await callBackendAPI(croppedDataUrl, null, { precise: true });

    const now       = Date.now();
    const questions = result.questions ?? [];
    const entryIds  = questions.map((_, i) => now + i);

    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['overlay.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await delay(150);

    await chrome.tabs.sendMessage(tab.id, { action: 'showOverlay', data: { questions, entryIds } });
    questions.forEach((q, i) => saveToHistory(q, entryIds[i]));

    sendResponse({ success: true });

  } catch (err) {
    console.error('[StudySnap] Selection flow error:', err);
    if (err.limitReached) return sendResponse({ success: false, error: err.message, limitReached: true });
    sendResponse({ success: false, error: friendlyError(err.message) });
  }
}

// Crops a PNG data URL to the given pixel rectangle using OffscreenCanvas
async function cropScreenshot(dataUrl, rect) {
  const blob   = await fetch(dataUrl).then(r => r.blob());
  const bitmap = await createImageBitmap(blob);

  const x = Math.max(0, Math.min(rect.x, bitmap.width  - 1));
  const y = Math.max(0, Math.min(rect.y, bitmap.height - 1));
  const w = Math.min(rect.width,  bitmap.width  - x);
  const h = Math.min(rect.height, bitmap.height - y);

  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, x, y, w, h, 0, 0, w, h);

  const cropped  = await canvas.convertToBlob({ type: 'image/png' });
  const ab       = await cropped.arrayBuffer();
  const uint8    = new Uint8Array(ab);
  let binary = '';
  for (let i = 0; i < uint8.length; i += 8192) {
    binary += String.fromCharCode(...uint8.subarray(i, i + 8192));
  }
  return `data:image/png;base64,${btoa(binary)}`;
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

async function callBackendAPI(screenshotDataUrl, pageText = null, options = {}) {
  const token = await getValidToken();

  const response = await fetch(`${BACKEND_URL}/api/analyze`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      imageDataUrl: screenshotDataUrl,
      token,
      pageText,
      precise:  options.precise  ?? false,
      question: options.question ?? null,
    }),
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
