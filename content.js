// content.js — Injected into the active page by StudySnap
// Builds and manages the floating answer overlay.

(function () {
  'use strict';

  if (window.__studySnapLoaded) return;
  window.__studySnapLoaded = true;

  let overlayEl      = null;
  let currentEntryId = null;

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

    currentEntryId = data.entryId ?? null;
    overlayEl = buildOverlay(data);
    document.body.appendChild(overlayEl);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlayEl.classList.add('ss-visible');
        const fill = overlayEl.querySelector('.ss-conf-fill');
        if (fill) fill.style.width = fill.dataset.target;
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
    const { answer, why, deepExplanation, confidence, questionType } = data;
    const conf      = confidenceInfo(confidence);
    const isType    = questionType === 'type';
    const isWriting = questionType === 'writing';

    const root = document.createElement('div');
    root.id = 'studysnap-overlay';

    root.innerHTML = `
      <div class="ss-header">
        <div class="ss-brand">
          <span class="ss-brand-icon">&#x26A1;</span>
          <span class="ss-brand-name">StudySnap</span>
        </div>
        <button class="ss-close" aria-label="Close StudySnap">&times;</button>
      </div>

      <div class="ss-body">

        <div class="ss-section">
          <div class="ss-answer-header">
            <div class="ss-label">${isWriting ? 'Your Paragraph' : 'Answer'}</div>
            ${isWriting
              ? `<button class="ss-copy-btn ss-copy-writing" title="Copy with formatting">&#x1F4CB; Copy</button>`
              : isType
                ? `<button class="ss-copy-btn" title="Copy answer to clipboard">Copy</button>`
                : `<span class="ss-answer-tag">Select on page</span>`
            }
          </div>
          <div class="ss-answer-text ${isWriting ? 'ss-answer-writing' : isType ? 'ss-answer-type' : 'ss-answer-select'}"></div>
          ${isWriting ? `
            <div class="ss-writing-legend">
              <span class="ss-legend-item"><span class="ss-blue-sample">A</span> Subordinate conj.</span>
              <span class="ss-legend-item"><span class="ss-green-sample">A</span> Coordinate conj.</span>
              <span class="ss-legend-item"><span class="ss-red-sample">A</span> Transitional adv.</span>
              <span class="ss-legend-item"><strong>Bold</strong> = Tenses &nbsp; <u>Underline</u> = Topic</span>
            </div>
          ` : ''}
        </div>

        <div class="ss-section">
          <div class="ss-label">Why</div>
          <div class="ss-why-text"></div>
        </div>

        ${deepExplanation ? `
          <button class="ss-expand-btn" aria-expanded="false">
            <span class="ss-expand-icon">&#x1F4D6;</span>
            <span>Deep Explanation</span>
            <span class="ss-chevron" aria-hidden="true">&#x25BE;</span>
          </button>
          <div class="ss-deep-panel" role="region"></div>
        ` : ''}

        <div class="ss-conf-section">
          <div class="ss-conf-row">
            <span class="ss-label">Confidence</span>
            <span class="ss-conf-value"></span>
          </div>
          <div class="ss-conf-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">
            <div class="ss-conf-fill" data-target="${confidence}%" style="width:0%"></div>
          </div>
          <div class="ss-conf-label"></div>
        </div>

        <div class="ss-feedback-row">
          <span class="ss-feedback-label">Was this correct?</span>
          <div class="ss-feedback-btns">
            <button class="ss-thumb ss-thumb-up"   aria-label="Yes, correct">&#x1F44D;</button>
            <button class="ss-thumb ss-thumb-down" aria-label="No, incorrect">&#x1F44E;</button>
          </div>
        </div>

      </div>
    `;

    // ── Answer content ─────────────────────────────────────────────────────────
    const answerEl = root.querySelector('.ss-answer-text');
    if (isWriting) {
      answerEl.innerHTML = sanitizeWritingHTML(answer);
    } else {
      answerEl.textContent = answer;
    }

    root.querySelector('.ss-why-text').textContent = why;
    if (deepExplanation) root.querySelector('.ss-deep-panel').textContent = deepExplanation;

    // ── Confidence ─────────────────────────────────────────────────────────────
    const confValue = root.querySelector('.ss-conf-value');
    const confFill  = root.querySelector('.ss-conf-fill');
    const confLabel = root.querySelector('.ss-conf-label');
    confValue.textContent     = `${confidence}%`;
    confValue.style.color     = conf.color;
    confLabel.textContent     = conf.label;
    confLabel.style.color     = conf.color;
    confFill.style.background = conf.color;

    // ── Close ──────────────────────────────────────────────────────────────────
    root.querySelector('.ss-close').addEventListener('click', closeOverlay);

    // ── Copy button ────────────────────────────────────────────────────────────
    const copyBtn = root.querySelector('.ss-copy-btn');
    if (copyBtn) {
      if (isWriting) {
        copyBtn.addEventListener('click', () => {
          // Build HTML with inline styles so colors survive paste into any editor.
          // CSS classes (ss-blue etc.) only exist inside our extension overlay.
          const inlineHtml = buildInlineHtml(answerEl);
          const plain      = answerEl.textContent;

          const tmp = document.createElement('div');
          tmp.setAttribute('contenteditable', 'true');
          tmp.setAttribute('tabindex', '-1');
          tmp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;white-space:pre-wrap;';
          tmp.innerHTML = inlineHtml;
          document.body.appendChild(tmp);
          tmp.focus({ preventScroll: true });

          const range = document.createRange();
          range.selectNodeContents(tmp);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);

          const ok = document.execCommand('copy');
          sel.removeAllRanges();
          document.body.removeChild(tmp);

          if (ok) {
            copyBtn.textContent = '✓ Copied!';
            copyBtn.classList.add('ss-copy-success');
            setTimeout(() => {
              copyBtn.innerHTML = '&#x1F4CB; Copy';
              copyBtn.classList.remove('ss-copy-success');
            }, 2000);
          } else {
            // execCommand failed — try Clipboard API (requires clipboardWrite permission)
            navigator.clipboard.write([
              new ClipboardItem({
                'text/html':  new Blob([inlineHtml], { type: 'text/html' }),
                'text/plain': new Blob([plain],      { type: 'text/plain' }),
              }),
            ]).then(() => {
              copyBtn.textContent = '✓ Copied!';
              copyBtn.classList.add('ss-copy-success');
              setTimeout(() => {
                copyBtn.innerHTML = '&#x1F4CB; Copy';
                copyBtn.classList.remove('ss-copy-success');
              }, 2000);
            }).catch(() => {
              navigator.clipboard.writeText(plain).then(() => {
                copyBtn.textContent = '✓ Text only';
                setTimeout(() => { copyBtn.innerHTML = '&#x1F4CB; Copy'; }, 2000);
              }).catch(() => {
                copyBtn.textContent = '✗ Failed';
                setTimeout(() => { copyBtn.innerHTML = '&#x1F4CB; Copy'; }, 1500);
              });
            });
          }
        });
      } else {
        // Plain text copy for type questions
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(answer);
            copyBtn.textContent = '✓ Copied!';
            copyBtn.classList.add('ss-copy-success');
            setTimeout(() => {
              copyBtn.textContent = 'Copy';
              copyBtn.classList.remove('ss-copy-success');
            }, 2000);
          } catch {
            copyBtn.textContent = 'Failed';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
          }
        });
      }
    }

    // ── Deep explanation expand/collapse ───────────────────────────────────────
    const expandBtn = root.querySelector('.ss-expand-btn');
    if (expandBtn) {
      const panel   = root.querySelector('.ss-deep-panel');
      const chevron = root.querySelector('.ss-chevron');
      expandBtn.addEventListener('click', () => {
        const isOpen = panel.classList.toggle('ss-deep-open');
        chevron.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
        expandBtn.setAttribute('aria-expanded', String(isOpen));
      });
    }

    // ── Thumbs up / down feedback ──────────────────────────────────────────────
    const thumbUp   = root.querySelector('.ss-thumb-up');
    const thumbDown = root.querySelector('.ss-thumb-down');
    const feedLabel = root.querySelector('.ss-feedback-label');

    function applyFeedback(type) {
      thumbUp.classList.toggle('ss-thumb-active-up',    type === 'correct');
      thumbUp.classList.toggle('ss-thumb-dimmed',       type === 'incorrect');
      thumbDown.classList.toggle('ss-thumb-active-down', type === 'incorrect');
      thumbDown.classList.toggle('ss-thumb-dimmed',      type === 'correct');
      feedLabel.textContent = type === 'correct' ? '✓ Marked correct' : '✗ Marked incorrect';
      feedLabel.style.color = type === 'correct' ? '#22c55e' : '#f87171';

      if (currentEntryId) {
        chrome.runtime.sendMessage({ action: 'saveFeedback', entryId: currentEntryId, feedback: type });
      }
    }

    thumbUp.addEventListener('click',   () => applyFeedback('correct'));
    thumbDown.addEventListener('click', () => applyFeedback('incorrect'));

    return root;
  }

  // ── Build copy-ready HTML with inline styles ─────────────────────────────────
  // Converts ss-blue/green/red classes to inline color styles so the formatting
  // survives when pasted into any editor (Google Docs, Word, etc.).

  function buildInlineHtml(el) {
    const COLOR = { 'ss-blue': '#0000FF', 'ss-green': '#008000', 'ss-red': '#FF0000' };

    function processNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag      = node.tagName.toLowerCase();
      const children = Array.from(node.childNodes).map(processNode).join('');

      if (tag === 'strong') return `<strong>${children}</strong>`;
      if (tag === 'u')      return `<u>${children}</u>`;
      if (tag === 'span') {
        const color = COLOR[node.className];
        if (color) return `<span style="color:${color};font-weight:bold;">${children}</span>`;
      }
      return children;
    }

    return Array.from(el.childNodes).map(processNode).join('');
  }

  // ── Writing HTML sanitizer ───────────────────────────────────────────────────
  // Only allows: <u>, <strong>, <span class="ss-blue|ss-green|ss-red">
  // Everything else is stripped to plain text — prevents XSS from AI output.

  function sanitizeWritingHTML(dirty) {
    const tmp = document.createElement('div');
    tmp.innerHTML = dirty;

    function cleanNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
      if (node.nodeType !== Node.ELEMENT_NODE) return null;

      const tag = node.tagName.toLowerCase();
      let el;

      if (tag === 'u' || tag === 'strong') {
        el = document.createElement(tag);
      } else if (tag === 'span') {
        const cls = (node.getAttribute('class') || '').trim();
        if (/^ss-(blue|green|red)$/.test(cls)) {
          el = document.createElement('span');
          el.className = cls;
        } else {
          el = document.createDocumentFragment(); // unwrap unknown spans
        }
      } else {
        el = document.createDocumentFragment(); // strip unknown tags, keep text
      }

      for (const child of node.childNodes) {
        const cleaned = cleanNode(child);
        if (cleaned) el.appendChild(cleaned);
      }
      return el;
    }

    const out = document.createElement('div');
    for (const child of tmp.childNodes) {
      const cleaned = cleanNode(child);
      if (cleaned) out.appendChild(cleaned);
    }
    return out.innerHTML;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function confidenceInfo(score) {
    if (score >= 80) return { label: 'High confidence',   color: '#22c55e' };
    if (score >= 60) return { label: 'Medium confidence', color: '#f59e0b' };
    return                   { label: 'Low confidence',   color: '#ef4444' };
  }

})();
