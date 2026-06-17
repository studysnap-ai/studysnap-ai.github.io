// i18n.js — lightweight runtime i18n for the popup, with a manual EN/ES override.
//
// Chrome's built-in chrome.i18n is locked to the browser UI language, so to let
// the user flip languages inside the popup we load the _locales message files
// ourselves and pick the language from a saved preference (falling back to the
// browser language). No second copy of the translations — same _locales files.

(function () {
  const SUPPORTED = ['en', 'es'];
  const STORE_KEY = 'ss_lang';
  const state = { dict: {}, lang: 'en' };

  async function loadDict(lang) {
    if (state.dict[lang]) return;
    try {
      const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
      state.dict[lang] = await res.json();
    } catch { state.dict[lang] = {}; }
  }

  async function detectLang() {
    try {
      const got = await chrome.storage.local.get(STORE_KEY);
      if (SUPPORTED.includes(got[STORE_KEY])) return got[STORE_KEY];
    } catch {}
    const ui = (chrome.i18n.getUILanguage() || 'en').toLowerCase();
    return ui.startsWith('es') ? 'es' : 'en';
  }

  function lookup(lang, key) {
    const e = state.dict[lang] && state.dict[lang][key];
    return e ? e.message : null;
  }

  function lookupEntry(lang, key) {
    return (state.dict[lang] && state.dict[lang][key]) || null;
  }

  function ssT(key, subs) {
    let entry = lookupEntry(state.lang, key) || lookupEntry('en', key);
    if (!entry) return '';
    let m = entry.message;
    // Resolve Chrome named placeholders ($name$) using the placeholders field
    if (entry.placeholders) {
      Object.keys(entry.placeholders).forEach(name => {
        const content = entry.placeholders[name].content; // e.g. "$1"
        m = m.replace(new RegExp('\\$' + name + '\\$', 'gi'), content);
      });
    }
    // Resolve positional substitutions ($1, $2, …)
    if (Array.isArray(subs)) subs.forEach((v, i) => { m = m.replace('$' + (i + 1), v); });
    return m;
  }

  function ssApplyI18n(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => { const m = ssT(el.dataset.i18n); if (m) el.innerHTML = m; });
    root.querySelectorAll('[data-i18n-ph]').forEach(el => { const m = ssT(el.dataset.i18nPh); if (m) el.placeholder = m; });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { const m = ssT(el.dataset.i18nTitle); if (m) el.title = m; });
  }

  async function ssInitI18n() {
    state.lang = await detectLang();
    await loadDict('en');        // fallback always available
    await loadDict(state.lang);
    ssApplyI18n();
  }

  async function ssSetLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    await loadDict(lang);
    state.lang = lang;
    try { await chrome.storage.local.set({ [STORE_KEY]: lang }); } catch {}
    ssApplyI18n();
  }

  window.ssT = ssT;
  window.ssApplyI18n = ssApplyI18n;
  window.ssInitI18n = ssInitI18n;
  window.ssSetLang = ssSetLang;
  window.ssGetLang = () => state.lang;
})();
