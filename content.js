// content.js — Injected into the active page by StudySnap
// Builds and manages the floating answer overlay.

(function () {
  'use strict';

  if (window.__studySnapLoaded) return;
  window.__studySnapLoaded = true;

  // i18n helper — localizes the overlay to the user's browser language
  const t = (k) => chrome.i18n.getMessage(k) || '';

  let overlayEl = null;

  // ── Listen for messages from the background service worker ──────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'showOverlay') {
      renderOverlay(message.data);
      sendResponse({ ok: true });
    }
    if (message.action === 'hideOverlay') {
      if (overlayEl) { overlayEl.remove(); overlayEl = null; }
      sendResponse({ ok: true });
    }
    return false;
  });

  // ── Render (or replace) the overlay ─────────────────────────────────────────

  function renderOverlay(data) {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }

    overlayEl = buildOverlay(data);
    document.body.appendChild(overlayEl);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlayEl.classList.add('ss-visible');
        // Animate every confidence bar (one per question card)
        overlayEl.querySelectorAll('.ss-conf-fill').forEach(fill => {
          fill.style.width = fill.dataset.target;
        });
      });
    });
  }

  function closeOverlay() {
    if (!overlayEl) return;
    overlayEl.classList.remove('ss-visible');
    const el = overlayEl;
    overlayEl = null;
    setTimeout(() => el.remove(), 320);
  }

  // ── Build the overlay DOM ────────────────────────────────────────────────────

  function buildOverlay(data) {
    const questions = data.questions ?? [];
    const entryIds  = data.entryIds  ?? [];

    const root = document.createElement('div');
    root.id = 'studysnap-overlay';

    // ── Header ──────────────────────────────────────────────────────────────
    root.innerHTML = `
      <div class="ss-header">
        <div class="ss-brand">
          <span class="ss-brand-icon">&#x26A1;</span>
          <span class="ss-brand-name">StudySnap</span>
        </div>
        <button class="ss-close" aria-label="Close StudySnap">&times;</button>
      </div>
      <div class="ss-body"></div>
    `;

    const body = root.querySelector('.ss-body');

    if (questions.length === 0) {
      const p = document.createElement('p');
      p.className = 'ss-no-q';
      p.textContent = t('ovNoQuestions');
      body.appendChild(p);
    } else {
      questions.forEach((q, idx) => {
        const conf    = confidenceInfo(q.confidence);
        const entryId = entryIds[idx] ?? null;
        const card    = document.createElement('div');
        card.className = 'ss-q-card';

        // Number badge when more than one question
        const badge = questions.length > 1
          ? `<span class="ss-q-num">Q${idx + 1}</span>` : '';

        // Free-text answers (essay / short / fill-in) need to be COPIED and
        // pasted; multiple-choice answers are SELECTED from the options on page.
        const qType      = (q.questionType || '').toLowerCase();
        const isFreeText = qType === 'writing' || qType === 'short' || qType === 'fillin';
        const answerTag  = isFreeText
          ? `<button class="ss-copy-btn" type="button" aria-label="Copy answer">&#x1F4CB; ${t('ovCopy')}</button>`
          : `<span class="ss-answer-tag">${t('ovSelectOnPage')}</span>`;
        const answerClass = isFreeText ? 'ss-answer-type' : 'ss-answer-select';

        card.innerHTML = `
          <div class="ss-section">
            <div class="ss-answer-header">
              ${badge}
              <div class="ss-label">${t('ovAnswer')}</div>
              ${answerTag}
            </div>
            <div class="ss-answer-text ${answerClass}"></div>
          </div>
          <div class="ss-section">
            <div class="ss-label">${t('ovWhy')}</div>
            <div class="ss-why-text"></div>
          </div>
          <div class="ss-conf-section">
            <div class="ss-conf-row">
              <span class="ss-label">${t('ovConfidence')}</span>
              <span class="ss-conf-value" style="color:${conf.color}">${q.confidence}%</span>
            </div>
            <div class="ss-conf-track">
              <div class="ss-conf-fill" data-target="${q.confidence}%" style="width:0%;background:${conf.color}"></div>
            </div>
            <div class="ss-conf-label" style="color:${conf.color}">${conf.label}</div>
          </div>
          <div class="ss-feedback-row">
            <span class="ss-feedback-label">${t('ovWasCorrect')}</span>
            <div class="ss-feedback-btns">
              <button class="ss-thumb ss-thumb-up"   aria-label="Yes, correct">&#x1F44D;</button>
              <button class="ss-thumb ss-thumb-down" aria-label="No, incorrect">&#x1F44E;</button>
            </div>
          </div>
          ${idx < questions.length - 1 ? '<hr class="ss-q-divider">' : ''}
        `;

        // Set text safely (no innerHTML for AI content — prevents XSS)
        card.querySelector('.ss-answer-text').textContent = q.answer ?? '';
        card.querySelector('.ss-why-text').textContent    = q.why    ?? '';

        // ── Per-card feedback thumbs ─────────────────────────────────────────
        const thumbUp   = card.querySelector('.ss-thumb-up');
        const thumbDown = card.querySelector('.ss-thumb-down');
        const feedLabel = card.querySelector('.ss-feedback-label');

        const applyFeedback = (type) => {
          thumbUp.classList.toggle('ss-thumb-active-up',    type === 'correct');
          thumbUp.classList.toggle('ss-thumb-dimmed',       type === 'incorrect');
          thumbDown.classList.toggle('ss-thumb-active-down', type === 'incorrect');
          thumbDown.classList.toggle('ss-thumb-dimmed',      type === 'correct');
          feedLabel.textContent = type === 'correct' ? t('ovMarkedCorrect') : t('ovMarkedIncorrect');
          feedLabel.style.color = type === 'correct' ? '#22c55e' : '#f87171';
          if (entryId) {
            chrome.runtime.sendMessage({ action: 'saveFeedback', entryId, feedback: type });
          }
        };

        thumbUp.addEventListener('click',   () => applyFeedback('correct'));
        thumbDown.addEventListener('click', () => applyFeedback('incorrect'));

        // ── Copy button (free-text answers) ──────────────────────────────────
        const copyBtn = card.querySelector('.ss-copy-btn');
        if (copyBtn) {
          copyBtn.addEventListener('click', async () => {
            const text = q.answer ?? '';
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              // Fallback for pages that block the async clipboard API
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity  = '0';
              document.body.appendChild(ta);
              ta.select();
              try { document.execCommand('copy'); } catch {}
              ta.remove();
            }
            copyBtn.innerHTML = t('ovCopied');
            copyBtn.classList.add('ss-copy-done');
            setTimeout(() => {
              copyBtn.innerHTML = '\u{1F4CB} ' + t('ovCopy');
              copyBtn.classList.remove('ss-copy-done');
            }, 2000);
          });
        }

        body.appendChild(card);
      });
    }

    // ── Close ──────────────────────────────────────────────────────────────────
    root.querySelector('.ss-close').addEventListener('click', closeOverlay);

    return root;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function confidenceInfo(score) {
    if (score >= 80) return { label: t('ovHigh'),   color: '#22c55e' };
    if (score >= 60) return { label: t('ovMedium'), color: '#f59e0b' };
    return                   { label: t('ovLow'),   color: '#ef4444' };
  }

})();
