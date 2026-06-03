// selector.js — Injected by StudySnap when Pro user clicks "Select Area"
// Renders a full-screen crosshair overlay; user draws a rectangle.
// Sends the selected region coordinates back to background.js, then removes itself.

(function () {
  'use strict';

  if (window.__studySnapSelectorActive) return;
  window.__studySnapSelectorActive = true;

  // ── Overlay ──────────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'studysnap-selector-overlay';
  overlay.style.cssText = `
    position: fixed !important; inset: 0 !important;
    z-index: 2147483647 !important; cursor: crosshair !important;
    background: rgba(0,0,0,0.38) !important; user-select: none !important;
  `;

  // ── Selection rectangle ───────────────────────────────────────────────────
  const box = document.createElement('div');
  box.style.cssText = `
    position: absolute !important; display: none !important;
    border: 2px solid #6366f1 !important;
    background: rgba(99,102,241,0.12) !important;
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.25) !important;
    pointer-events: none !important;
  `;

  // ── Hint label ────────────────────────────────────────────────────────────
  const hint = document.createElement('div');
  hint.textContent = 'Draw a box around the question  •  Esc to cancel';
  hint.style.cssText = `
    position: absolute !important; top: 50% !important; left: 50% !important;
    transform: translate(-50%,-50%) !important;
    background: rgba(15,15,26,0.88) !important; color: #e8e8f5 !important;
    padding: 12px 22px !important; border-radius: 10px !important;
    font: 600 14px/-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important;
    letter-spacing: 0.1px !important; pointer-events: none !important;
    white-space: nowrap !important; border: 1px solid rgba(99,102,241,0.3) !important;
  `;

  overlay.appendChild(box);
  overlay.appendChild(hint);
  document.body.appendChild(overlay);

  // ── Drag state ────────────────────────────────────────────────────────────
  let startX = 0, startY = 0, drawing = false;

  function cleanup() {
    overlay.remove();
    window.__studySnapSelectorActive = false;
  }

  overlay.addEventListener('mousedown', (e) => {
    drawing = true;
    startX = e.clientX;
    startY = e.clientY;
    hint.style.display = 'none';
    box.style.display = 'block';
    updateBox(e.clientX, e.clientY);
    e.preventDefault();
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!drawing) return;
    updateBox(e.clientX, e.clientY);
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!drawing) return;
    drawing = false;

    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    cleanup();

    if (w < 20 || h < 20) {
      // Too small — cancel
      chrome.runtime.sendMessage({ action: 'selectionCancelled' });
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    chrome.runtime.sendMessage({
      action: 'selectionComplete',
      rect: {
        x:      Math.round(x * dpr),
        y:      Math.round(y * dpr),
        width:  Math.round(w * dpr),
        height: Math.round(h * dpr),
      },
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cleanup();
      chrome.runtime.sendMessage({ action: 'selectionCancelled' });
    }
  }, { once: true });

  function updateBox(cx, cy) {
    const x = Math.min(cx, startX);
    const y = Math.min(cy, startY);
    const w = Math.abs(cx - startX);
    const h = Math.abs(cy - startY);
    box.style.left   = x + 'px';
    box.style.top    = y + 'px';
    box.style.width  = w + 'px';
    box.style.height = h + 'px';
  }
})();
