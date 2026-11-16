// Spotiky's collection page (spotiky.com/account) and the label editor. index.html loads this
// file only when it's needed, and it uses that page's helpers (h, getWorker, postWorker, session,
// trackName, lookupCode, parseItem, writeLink and the rest), which classic scripts share.
(() => {
  'use strict';

  const KINDS = ['zh', 'eg', 'em', 'en'];
  const KIND_NAME = { zh: 'Chinese', eg: 'Hieroglyphs', em: 'Emoji', en: 'English' };
  const KIND_HINT = { zh: '2 or 3 Chinese characters', eg: '2 or 3 signs', em: '2 or 3 emoji', en: 'One or two words, like night-drive' };
  const SHOW_ORDER = ['em', 'zh', 'eg', 'en'];   // which label a sleeve shows when none is typed
  const LAYOUT_KEY = 'spotiky-collection-layout';

  // Sleeve inks: a printed sleeve color and the record label showing through its die-cut hole
  // [sleeve, record label, writing on the label, the ID printed on the sleeve]
  const INKS = [
    ['#2b4c7e', '#f2c14e', '#1a1a1a', '#f2c14e'], ['#7a2e3b', '#f4d6c6', '#1a1a1a', '#f4d6c6'], ['#1f5c4a', '#ece5cf', '#1a1a1a', '#ece5cf'],
    ['#5b3a82', '#f0a6c8', '#1a1a1a', '#f0a6c8'], ['#b8532c', '#1d1d1d', '#f5efe6', '#fbe9dc'], ['#233d3f', '#9ed9c9', '#1a1a1a', '#9ed9c9'],
    ['#8a6d1f', '#f7f0dc', '#1a1a1a', '#f7f0dc'], ['#2f2f2f', '#e2533d', '#fff7f0', '#f3c6bd'], ['#3e5f8a', '#e7eef6', '#1a1a1a', '#e7eef6'],
    ['#6b4f3a', '#e8c27a', '#1a1a1a', '#e8c27a'], ['#1d4b2c', '#d9f27a', '#1a1a1a', '#d9f27a'], ['#4a2545', '#ffb38a', '#1a1a1a', '#ffb38a'],
  ];

  const CSS = `
  body.wide { max-width: 980px; }
  #collectionView { margin-top: 4px; }
  .col-nav { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 0.85rem; margin: 0 0 18px; }
  .col-nav a { color: #1DB954; text-decoration: none; font-weight: 600; }
  .col-tabs { display: flex; gap: 4px; border-bottom: 1px solid #2a2a2a; margin: 0 0 18px; overflow-x: auto; }
  .col-tabs button { width: auto; margin: 0; padding: 10px 12px 9px; background: none; border-radius: 0; color: #b3b3b3; font-size: 0.95rem; font-weight: 600;
                     border-bottom: 2px solid transparent; white-space: nowrap; }
  .col-tabs button:hover { background: none; color: #fff; }
  .col-tabs button[aria-selected="true"] { color: #fff; border-bottom-color: #1DB954; }
  .col-tabs .count { color: #8a8a8a; font-weight: 500; margin-left: 6px; }
  .col-tabs .grow { flex: 1; }
  .col-new { align-self: center; flex: none; white-space: nowrap; background: #1DB954; color: #fff; border-radius: 999px; padding: 6px 14px; font-size: 0.85rem; font-weight: 600; text-decoration: none; }
  .col-new:hover { background: #1ed760; }
  .col-empty { background: #181818; border-radius: 12px; padding: 22px 18px; color: #b3b3b3; font-size: 0.95rem; }
  .col-empty strong { display: block; color: #fff; font-size: 1.05rem; margin-bottom: 6px; }
  .col-empty a, .col-empty button { display: inline-block; width: auto; margin-top: 14px; padding: 10px 16px; border-radius: 8px; background: #1DB954; color: #fff; font-weight: 600; text-decoration: none; font-size: 0.95rem; }

  /* The featured shelf: up to 4 sleeves standing on a ledge */
  .shelf { margin: 0 0 26px; }
  .shelf-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 0 0 10px; }
  .shelf-head h2 { font-size: 1.05rem; margin: 0; }
  .shelf-head span { font-size: 0.8rem; color: #8a8a8a; }
  .shelf-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; padding-bottom: 12px; border-bottom: 4px solid #262626; }
  .shelf-hint { font-size: 0.85rem; color: #8a8a8a; margin: 0; padding: 14px 0; border-bottom: 4px solid #262626; }

  .col-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 10px; }
  .col-tools input { flex: 1 1 200px; margin: 0; padding: 10px 12px; font-size: 16px; }
  .col-tools select, .col-sheet select { width: auto; margin: 0; padding: 10px 10px; border-radius: 8px; border: none; background: #282828; color: #fff; font-size: 0.9rem; font-family: inherit; }
  .col-layout { display: flex; background: #282828; border-radius: 8px; padding: 3px; }
  .col-layout button { width: auto; margin: 0; padding: 6px 10px; background: none; color: #b3b3b3; font-size: 0.85rem; border-radius: 6px; }
  .col-layout button[aria-pressed="true"] { background: #3e3e3e; color: #fff; }
  .crates { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 16px; }
  .crates button { width: auto; margin: 0; padding: 5px 12px; border-radius: 999px; background: #222; color: #ccc; font-size: 0.85rem; font-weight: 500; }
  .crates button[aria-pressed="true"] { background: #fff; color: #121212; }

  /* A sleeve: printed card stock, a die-cut hole, and the record label with the playlist's name */
  .sleeve { position: relative; aspect-ratio: 1; border-radius: 4px; overflow: hidden; container-type: inline-size;
            background: var(--ink); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06); }
  .sleeve .disc { position: absolute; left: 50%; top: 47%; width: 70%; aspect-ratio: 1; transform: translate(-50%, -50%); border-radius: 50%;
                  background: var(--label); display: grid; place-items: center; box-shadow: 0 0 0 1.6cqi rgba(0,0,0,0.18), inset 0 0 0 0.8cqi rgba(0,0,0,0.08); }
  .sleeve .glyph { color: var(--on); text-align: center; line-height: 1.05; max-width: 86%; overflow-wrap: anywhere; }
  .sleeve .glyph.zh, .sleeve .glyph.eg { font-size: 19cqi; letter-spacing: -0.02em; }
  .sleeve .glyph.zh.n3, .sleeve .glyph.eg.n3 { font-size: 14cqi; }
  .sleeve .glyph.eg { font-family: "Noto Sans Egyptian Hieroglyphs", "Segoe UI Historic", "Apple Symbols", sans-serif; }
  .sleeve .glyph.em { font-size: 20cqi; font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; }
  .sleeve .glyph.em.n3 { font-size: 15cqi; }
  .sleeve .glyph.en { font-size: 8.5cqi; font-weight: 800; letter-spacing: -0.01em; }
  .sleeve .sid { position: absolute; left: 6cqi; bottom: 4.5cqi; color: var(--sid); font-size: 6.5cqi; font-weight: 700; letter-spacing: 0.04em; opacity: 0.9; }
  .sleeve .pin { position: absolute; right: 5cqi; top: 4cqi; color: var(--sid); font-size: 7cqi; }
  .sleeve .draft { position: absolute; right: 5cqi; bottom: 4.5cqi; background: var(--label); color: var(--on); font-size: 5cqi; font-weight: 700; padding: 0.6cqi 2.4cqi; border-radius: 99px; }

  .sleeves.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 18px 14px; }
  .tile { display: block; width: 100%; margin: 0; padding: 0; background: none; text-align: left; color: #fff; border-radius: 6px; font-weight: 400; }
  .tile:hover { background: none; }
  .tile:hover .sleeve { transform: translateY(-2px); }
  .tile .sleeve { transition: transform 0.15s; }
  .tile:focus-visible { outline: 2px solid #1DB954; outline-offset: 3px; }
  .tile .cap { display: block; margin-top: 8px; font-size: 0.9rem; line-height: 1.3; overflow-wrap: anywhere; }
  .tile .sub { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 0.75rem; color: #8a8a8a; margin-top: 2px; }
  .typed-mark { color: #1DB954; }
  .sleeves.list { display: flex; flex-direction: column; gap: 2px; }
  .sleeves.list .tile { display: grid; grid-template-columns: 48px 1fr auto; gap: 12px; align-items: center; padding: 6px; border-radius: 8px; }
  .sleeves.list .tile:hover { background: #1c1c1c; }
  .sleeves.list .tile:hover .sleeve { transform: none; }
  .sleeves.list .cap { margin: 0; }
  .sleeves.list .sid, .sleeves.list .pin, .sleeves.list .draft { display: none; }
  .tile .when { display: none; }
  .sleeves.list .tile .when { display: inline; font-size: 0.75rem; color: #8a8a8a; }
  .no-match { color: #8a8a8a; font-size: 0.9rem; }

  /* Codes you named, and clips */
  .item-rows { display: flex; flex-direction: column; gap: 8px; }
  .item-row { display: grid; grid-template-columns: minmax(64px, auto) 1fr auto; gap: 4px 14px; align-items: center; background: #181818; border-radius: 10px; padding: 10px 12px; }
  .item-row .big { font-size: 1.7rem; line-height: 1.2; }
  .item-row .big.eg { font-family: "Noto Sans Egyptian Hieroglyphs", "Segoe UI Historic", "Apple Symbols", sans-serif; }
  .item-row .big.em { font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; }
  .item-row .big.clip { font-size: 1rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .item-row .what { min-width: 0; font-size: 0.9rem; overflow-wrap: anywhere; }
  .item-row .what small { display: block; font-size: 0.75rem; color: #8a8a8a; margin-top: 2px; }
  .item-row .acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .act { width: auto; margin: 0; padding: 7px 12px; border-radius: 8px; background: #282828; color: #fff; font-size: 0.85rem; font-weight: 500; text-decoration: none; display: inline-block; line-height: 1.3; }
  .act:hover { background: #3e3e3e; }
  .act.go { background: #1DB954; font-weight: 600; }
  .act.go:hover { background: #1ed760; }
  .act.warn { color: #f8a5ad; }
  .act:disabled { opacity: 0.45; cursor: default; }
  @media (max-width: 560px) {
    .item-row { grid-template-columns: auto 1fr; }
    .item-row .acts { grid-column: 1 / -1; justify-content: flex-start; }
    .shelf-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .sleeves.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  /* The detail sheet and the label editor: over the page, a bottom sheet on phones */
  .col-back { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 40; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .col-sheet { position: relative; background: #181818; border-radius: 14px; width: 100%; max-width: 560px; max-height: calc(100vh - 32px); overflow-y: auto; padding: 18px; color: #ddd; }
  .col-sheet:focus { outline: none; }
  @media (max-width: 560px) {
    .col-back { align-items: flex-end; padding: 0; }
    .col-sheet { max-height: 92vh; border-radius: 14px 14px 0 0; }
  }
  .sheet-close { position: absolute; right: 10px; top: 10px; width: 34px; height: 34px; margin: 0; padding: 0; background: rgba(0,0,0,0.35); color: #fff; font-weight: 400; border-radius: 50%; }
  .sheet-close:hover { background: rgba(0,0,0,0.55); }
  .sheet-top { display: grid; grid-template-columns: 132px 1fr; gap: 16px; align-items: end; margin-bottom: 16px; }
  .sheet-top h2 { margin: 0; font-size: 1.5rem; line-height: 1.2; overflow-wrap: anywhere; color: #fff; }
  .sheet-top p { margin: 4px 0 0; font-size: 0.85rem; color: #9a9a9a; }
  .sheet h3, .col-sheet h3 { font-size: 0.95rem; color: #fff; margin: 20px 0 8px; }
  .names { display: grid; grid-template-columns: max-content 1fr; gap: 8px 14px; align-items: baseline; }
  .names dt { font-size: 0.8rem; color: #8a8a8a; }
  .names dd { margin: 0; min-width: 0; }
  .names .code { font-size: 1.35rem; color: #fff; }
  .names .code.eg { font-family: "Noto Sans Egyptian Hieroglyphs", "Segoe UI Historic", "Apple Symbols", sans-serif; }
  .names .code.em { font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; }
  .names .code.en { font-size: 1.05rem; font-weight: 600; }
  .names small { display: block; font-size: 0.75rem; color: #8a8a8a; }
  .sheet-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .link-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; }
  .link-line code { flex: 1 1 220px; overflow-wrap: anywhere; padding: 8px 10px; font-size: 0.85rem; }
  .crate-new { display: flex; gap: 8px; margin-top: 8px; }
  .crate-new input { margin: 0; padding: 9px 10px; }
  .songs { margin: 0; padding-left: 22px; font-size: 0.9rem; }
  .songs li { margin: 4px 0; }
  .songs li small { color: #8a8a8a; margin-left: 6px; }
  .songs li em { display: block; color: #cfe9d6; font-size: 0.8rem; }
  .trail { list-style: none; margin: 0; padding: 0; font-size: 0.85rem; }
  .trail li { display: grid; grid-template-columns: 64px 1fr; gap: 10px; padding: 6px 0; border-top: 1px solid #262626; }
  .trail time { color: #8a8a8a; font-size: 0.8rem; }
  .sheet-msg { font-size: 0.85rem; color: #f15e6c; margin: 10px 0 0; }
  .sheet-msg.ok { color: #1DB954; }

  /* The label editor */
  .ed-intro { font-size: 0.9rem; color: #b3b3b3; margin: 0 0 14px; padding-right: 30px; }
  .ed-row { padding: 12px 0; border-top: 1px solid #262626; }
  .ed-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .ed-head label { margin: 0; font-size: 0.85rem; color: #fff; font-weight: 600; }
  .ed-head .hint { font-size: 0.75rem; color: #8a8a8a; flex: 1; }
  .badge { font-size: 0.72rem; padding: 1px 8px; border-radius: 99px; background: #262626; color: #b3b3b3; }
  .badge.yours { background: #15291c; color: #8ee0a8; }
  .badge.matched { background: #262033; color: #c9b8ff; }
  .ed-field { display: flex; gap: 6px; }
  .ed-field input { margin: 0; font-size: 20px; padding: 10px 12px; }
  .ed-field input.eg { font-family: "Noto Sans Egyptian Hieroglyphs", "Segoe UI Historic", "Apple Symbols", sans-serif; }
  .ed-field button { width: auto; margin: 0; padding: 0 12px; flex: none; background: #282828; font-size: 0.85rem; font-weight: 500; }
  .ed-field button:hover { background: #3e3e3e; }
  .ed-mean { font-size: 0.75rem; color: #8a8a8a; margin: 4px 2px 0; min-height: 1em; }
  .ed-err { font-size: 0.8rem; color: #f15e6c; margin: 4px 2px 0; }
  .ed-err:empty { display: none; }
  .ed-match { background: #202020; border-radius: 10px; padding: 12px; margin: 12px 0 0; font-size: 0.85rem; color: #ccc; }
  .ed-match p { margin: 0 0 10px; }
  .ed-match .row2 { display: flex; flex-wrap: wrap; gap: 8px; }
  .ed-foot { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-top: 16px; padding-top: 14px; border-top: 1px solid #262626; }
  .ed-foot .left { font-size: 0.8rem; color: #8a8a8a; flex: 1 1 200px; }
  .ed-foot .btns { display: flex; gap: 8px; }
  .ed-foot button { width: auto; margin: 0; padding: 10px 18px; }
  .ed-foot button:disabled { opacity: 0.45; cursor: default; }
  .picker { margin-top: 8px; background: #121212; border-radius: 10px; padding: 8px; }
  .picker input { margin: 0 0 8px; padding: 8px 10px; font-size: 16px; }
  .picker .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: 4px; max-height: 210px; overflow-y: auto; }
  .picker .grid button { margin: 0; padding: 4px 0; background: #222; font-size: 22px; font-weight: 400; line-height: 1.3; }
  .picker .grid button:hover { background: #333; }
  .picker .grid.eg button { font-family: "Noto Sans Egyptian Hieroglyphs", "Segoe UI Historic", "Apple Symbols", sans-serif; }
  .picker .grid.em button { font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; }
  .picker .under { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 0.75rem; color: #8a8a8a; align-items: center; }
  .picker .under button { width: auto; margin: 0; padding: 6px 12px; font-size: 0.8rem; background: #282828; }

  /* Menus and the toast */
  .menu { position: absolute; z-index: 50; background: #242424; border-radius: 10px; padding: 6px; min-width: 220px; max-height: 300px; overflow-y: auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
  .menu button, .menu a { display: block; width: 100%; margin: 0; padding: 9px 10px; background: none; color: #fff; text-align: left; font-size: 0.9rem; font-weight: 400; border-radius: 6px; text-decoration: none; }
  .menu button:hover, .menu a:hover { background: #333; }
  .menu .sep { height: 1px; background: #333; margin: 4px 0; }
  .col-toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 60; background: #f4f4f4; color: #121212; border-radius: 10px; padding: 10px 14px;
               display: flex; gap: 14px; align-items: center; font-size: 0.9rem; max-width: calc(100vw - 32px); box-shadow: 0 8px 24px rgba(0,0,0,0.45); }
  .col-toast button { width: auto; margin: 0; padding: 4px 10px; background: none; color: #0f7a35; font-weight: 700; }
  .col-toast button:hover { background: #e2e2e2; }
  @media (prefers-reduced-motion: reduce) { .tile .sleeve { transition: none; } .tile:hover .sleeve { transform: none; } }
  `;

  function injectStyle() {
    if (document.getElementById('collectionStyle')) return;
    const st = document.createElement('style');
    st.id = 'collectionStyle';
    st.textContent = CSS;
    document.head.append(st);
  }
  injectStyle();

  // ---- Small helpers ----------------------------------------------------------------------
  function el(tag, cls, text, attrs) {
    const n = h(tag, cls, text);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    return n;
  }
  function btn(text, cls, onClick, attrs) {
    const b = el('button', cls, text, attrs);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function link(text, cls, href) {
    const a = el('a', cls, text);
    a.href = href;
    return a;
  }
  const hashOf = s => { let x = 2166136261; for (const c of String(s)) x = Math.imul(x ^ c.codePointAt(0), 16777619); return x >>> 0; };
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const shortDate = at => { try { return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; } };
  const clock = at => { try { return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
  const songsIn = p => splitLinks(p.items).length;

  // The label a playlist goes by: the first one its owner typed, or else its emoji, Chinese, hieroglyphs, English
  function mainKind(p) {
    const typed = SHOW_ORDER.find(k => (p.typed || []).includes(k) && p.labels[k]);
    return typed || SHOW_ORDER.find(k => p.labels[k]) || null;
  }
  const isTyped = (p, k) => (p.typed || []).includes(k);
  // A typed label shows in quotes, like a name tag on a weapon
  const named = (p, k) => (isTyped(p, k) ? `“${p.labels[k].code}”` : p.labels[k].code);
  const linkPart = (p, k) => (k ? (k === 'en' ? '-' : '') + p.labels[k].code : '');
  const playlistUrl = (p, k = mainKind(p)) => `${SITE_BASE}/playlist/${p.id}${linkPart(p, k)}`;
  const playlistPathFor = (p, k = mainKind(p)) => `/playlist/${p.id}${linkPart(p, k)}`;

  function sleeve(p) {
    const [ink, label, on, sid] = INKS[hashOf(p.id) % INKS.length];
    const s = el('div', 'sleeve');
    s.style.setProperty('--ink', ink);
    s.style.setProperty('--label', label);
    s.style.setProperty('--on', on);
    s.style.setProperty('--sid', sid);
    s.setAttribute('aria-hidden', 'true');
    const k = mainKind(p);
    const disc = el('div', 'disc');
    if (k) {
      const code = p.labels[k].code;
      const n = k === 'en' ? 0 : [...code].length;
      disc.append(el('span', `glyph ${k}${n >= 3 ? ' n3' : ''}`, k === 'en' ? code.replace('-', ' ') : code));
    }
    s.append(disc, el('span', 'sid', p.id));
    if (p.pinned) s.append(el('span', 'pin', '★'));
    if (hasDraft(p.id)) s.append(el('span', 'draft', 'unsaved'));
    return s;
  }

  function hasDraft(id) {
    try { return !!(typeof readDrafts === 'function' && readDrafts()[id]); } catch (e) { return false; }
  }

  let toastTimer = null;
  function toast(text, action, onAction) {
    document.querySelectorAll('.col-toast').forEach(t => t.remove());
    clearTimeout(toastTimer);
    const t = el('div', 'col-toast', null, { role: 'status' });
    t.append(el('span', null, text));
    if (action) t.append(btn(action, null, () => { t.remove(); onAction(); }));
    document.body.append(t);
    toastTimer = setTimeout(() => t.remove(), action ? 8000 : 3500);
  }

  // A layer over the page; Escape or the backdrop closes it, and focus goes back where it was
  function overlay(label) {
    const before = document.activeElement;
    const back = el('div', 'col-back');
    const sheet = el('div', 'col-sheet', null, { role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' });
    back.append(sheet);
    const close = () => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      if (before && before.focus && document.contains(before)) before.focus();
    };
    const onKey = e => { if (e.key === 'Escape' && document.body.lastElementChild === back) close(); };
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    sheet.append(btn('✕', 'sheet-close', close, { 'aria-label': 'Close' }));
    document.body.append(back);
    setTimeout(() => sheet.focus(), 0);
    return { back, sheet, close };
  }

  function closeMenus() { document.querySelectorAll('.menu').forEach(m => m.remove()); }
  document.addEventListener('mousedown', e => { if (!e.target.closest('.menu') && !e.target.closest('[data-menu]')) closeMenus(); });

  function menuUnder(anchor, items) {
    closeMenus();
    const m = el('div', 'menu', null, { role: 'menu' });
    for (const it of items) {
      if (it === 'sep') { m.append(el('div', 'sep')); continue; }
      const b = it.href ? link(it.text, null, it.href) : btn(it.text, null, () => { closeMenus(); it.onClick(); });
      b.setAttribute('role', 'menuitem');
      m.append(b);
    }
    const r = anchor.getBoundingClientRect();
    document.body.append(m);
    const left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - m.offsetWidth - 8));
    m.style.left = left + 'px';
    m.style.top = (r.bottom + window.scrollY + 6) + 'px';
    const first = m.querySelector('button, a');
    if (first) first.focus();
  }

  // ---- Loading ------------------------------------------------------------------------------
  let lib = null;      // { playlists, crates, maxPinned, renamesPerDay }
  let myCodes = null;  // [{ code, script, track, at, chars }]
  const ui = { tab: 'playlists', q: '', sort: 'recent', crate: 'all', layout: savedLayout() };

  function savedLayout() {
    try { return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'; } catch (e) { return 'grid'; }
  }
  const root = () => document.getElementById('collectionView');

  async function start() {
    const box = root();
    if (!box) return;
    box.hidden = false;
    if (!session) return renderSignedOut();
    box.replaceChildren(nav(), el('p', 'no-match', 'Opening your collection…'));
    const [a, b] = await Promise.all([getWorker('/playlists/mine'), getWorker('/codes/mine')]);
    if (a.status === 401 || b.status === 401) {
      signedOutLocally();
      return renderSignedOut('Your sign-in has ended. Sign in again to see your collection.');
    }
    if (!a.ok) {
      return box.replaceChildren(nav(), emptyBox("Couldn't open your collection", a.status === 0 ? 'Check your connection, then reload this page.' : (a.data.error || 'Reload this page to try again.')));
    }
    lib = a.data;
    myCodes = b.ok ? b.data.codes : [];
    render();
  }

  function nav() {
    const n = el('div', 'col-nav');
    n.append(link('Play a song', null, '/'), link('Make a playlist', null, '/playlist'));
    return n;
  }

  function emptyBox(title, text, action) {
    const box = el('div', 'col-empty');
    box.append(el('strong', null, title), document.createTextNode(text));
    if (action) box.append(document.createElement('br'), action);
    return box;
  }

  function renderSignedOut(message) {
    const signInBtn = btn('Sign in', null, () => {
      const panel = document.getElementById('accountPanel');
      if (panel.hidden) toggleAccount();
      const f = panel.querySelector('input');
      if (f) f.focus();
    });
    root().replaceChildren(nav(), emptyBox('Your collection',
      message || 'Sign in to keep your playlists here: rename them, pin your favorites, sort them into crates, and see the song codes you named.', signInBtn));
  }

  // ---- The page -------------------------------------------------------------------------------
  function render() {
    if (!lib) return;
    closeMenus();
    const tabs = el('div', 'col-tabs', null, { role: 'tablist' });
    const clips = allClips();
    for (const [key, name, n] of [['playlists', 'Playlists', lib.playlists.length], ['codes', 'Codes you named', myCodes.length], ['clips', 'Clips', clips.length]]) {
      const b = btn(name, null, () => { ui.tab = key; render(); }, { role: 'tab', 'aria-selected': String(ui.tab === key), id: 'tab-' + key });
      b.append(el('span', 'count', String(n)));
      tabs.append(b);
    }
    tabs.append(el('span', 'grow'), link('New playlist', 'col-new', '/playlist'));
    const body = el('div', null, null, { role: 'tabpanel', 'aria-labelledby': 'tab-' + ui.tab });
    if (ui.tab === 'playlists') body.append(...playlistsTab());
    else if (ui.tab === 'codes') body.append(...codesTab());
    else body.append(...clipsTab(clips));
    root().replaceChildren(nav(), tabs, body);
  }

  function playlistsTab() {
    if (!lib.playlists.length) {
      return [emptyBox('No playlists yet', 'Make a playlist, press Share as a code, and copy a link: it saves to your account, ready to rename, pin and sort here.', link('Make a playlist', null, '/playlist'))];
    }
    const out = [];
    const pinned = lib.playlists.filter(p => p.pinned);
    const shelf = el('section', 'shelf', null, { 'aria-label': 'Featured' });
    const head = el('div', 'shelf-head');
    head.append(el('h2', null, 'Featured'), el('span', null, `${pinned.length} of ${lib.maxPinned}`));
    shelf.append(head);
    if (pinned.length) {
      const row = el('div', 'shelf-row');
      for (const p of pinned) row.append(tile(p));
      shelf.append(row);
    } else {
      shelf.append(el('p', 'shelf-hint', `Pin up to ${lib.maxPinned} playlists here. Open one and press Pin.`));
    }
    out.push(shelf);

    const tools = el('div', 'col-tools');
    const search = el('input', null, null, { type: 'search', placeholder: 'Search labels, IDs and songs', 'aria-label': 'Search your playlists' });
    search.value = ui.q;
    search.addEventListener('input', () => { ui.q = search.value; drawList(); });
    const sort = el('select', null, null, { 'aria-label': 'Sort' });
    for (const [v, t] of [['recent', 'Recently changed'], ['oldest', 'Oldest first'], ['name', 'Name'], ['songs', 'Most songs']]) {
      const o = el('option', null, t);
      o.value = v;
      o.selected = ui.sort === v;
      sort.append(o);
    }
    sort.addEventListener('change', () => { ui.sort = sort.value; drawList(); });
    const layout = el('div', 'col-layout', null, { role: 'group', 'aria-label': 'Layout' });
    for (const [v, t] of [['grid', 'Sleeves'], ['list', 'List']]) {
      layout.append(btn(t, null, () => {
        ui.layout = v;
        try { localStorage.setItem(LAYOUT_KEY, v); } catch (e) {}
        render();
      }, { 'aria-pressed': String(ui.layout === v) }));
    }
    tools.append(search, sort, layout);
    out.push(tools);

    if (lib.crates.length) {
      if (ui.crate !== 'all' && ui.crate !== 'none' && !lib.crates.includes(ui.crate)) ui.crate = 'all';
      const crates = el('div', 'crates', null, { role: 'group', 'aria-label': 'Crates' });
      for (const [v, t] of [['all', 'All'], ...lib.crates.map(c => [c, c]), ['none', 'Not in a crate']]) {
        crates.append(btn(t, null, () => { ui.crate = v; render(); }, { 'aria-pressed': String(ui.crate === v) }));
      }
      out.push(crates);
    }
    const list = el('div', 'sleeves ' + ui.layout, null, { id: 'colList' });
    drawList(list);
    out.push(list);
    return out;
  }

  function drawList(list = document.getElementById('colList')) {
    if (!list) return;
    const q = ui.q.trim().toLowerCase();
    let ps = lib.playlists.filter(p => ui.crate === 'all' || (ui.crate === 'none' ? !p.crate : p.crate === ui.crate));
    if (q) ps = ps.filter(p => searchText(p).includes(q));
    const nameOf = p => { const k = mainKind(p); return k ? p.labels[k].code : p.id; };
    const by = {
      recent: (a, b) => String(b.updated).localeCompare(String(a.updated)),
      oldest: (a, b) => String(a.created).localeCompare(String(b.created)),
      name: (a, b) => nameOf(a).localeCompare(nameOf(b)),
      songs: (a, b) => songsIn(b) - songsIn(a),
    }[ui.sort];
    ps.sort(by);
    if (!ps.length) return list.replaceChildren(el('p', 'no-match', q ? `Nothing matches “${ui.q.trim()}”.` : 'No playlists in this crate.'));
    list.replaceChildren(...ps.map(tile));
  }

  // Labels, ID, crate and any song names already looked up
  function searchText(p) {
    const parts = [p.id, p.crate || '', ...KINDS.map(k => (p.labels[k] ? p.labels[k].code : ''))];
    for (const t of splitLinks(p.items)) {
      const it = parseItem(t);
      if (it && it.code) parts.push(it.code);
      if (it && it.id && names.has(it.id)) parts.push(names.get(it.id));
    }
    return parts.join(' ').toLowerCase();
  }

  function tile(p) {
    const k = mainKind(p);
    const t = btn(null, 'tile', () => openDetail(p), { 'aria-label': `${k ? p.labels[k].code : p.id}, ${count(songsIn(p), 'song', 'songs')}. Open` });
    t.dataset.id = p.id;
    const cap = el('span', 'cap');
    if (k) {
      cap.append(el('span', isTyped(p, k) ? 'typed-mark' : null, named(p, k)));
    } else {
      cap.textContent = p.id;
    }
    const sub = el('span', 'sub');
    sub.append(el('span', null, count(songsIn(p), 'song', 'songs')));
    if (p.crate) sub.append(el('span', null, p.crate));
    const text = el('span');
    text.append(cap, sub);
    t.append(sleeve(p), text, el('span', 'when', shortDate(p.updated)));
    return t;
  }

  // ---- One playlist up close -------------------------------------------------------------------
  function openDetail(p) {
    const o = overlay(`Playlist ${p.id}`);
    const { sheet } = o;
    const draw = () => {
      const keep = sheet.querySelector('.sheet-close');
      sheet.replaceChildren(keep, ...detailParts(p, o, draw));
    };
    draw();
    loadSongs(p, sheet);
    loadTrail(p, sheet);
  }

  function detailParts(p, o, redraw) {
    const parts = [];
    const k = mainKind(p);
    const top = el('div', 'sheet-top');
    const titles = el('div');
    titles.append(el('h2', isTyped(p, k) ? 'typed-mark' : null, k ? named(p, k) : p.id));
    const meta = [`ID ${p.id}`, count(songsIn(p), 'song', 'songs')];
    if (p.crate) meta.push(`in ${p.crate}`);
    titles.append(el('p', null, meta.join(', ')));
    top.append(sleeve(p), titles);
    parts.push(top);

    // The four names
    parts.push(el('h3', null, 'Names'));
    const dl = el('dl', 'names');
    for (const kind of KINDS) {
      const l = p.labels[kind];
      if (!l) continue;
      dl.append(el('dt', null, KIND_NAME[kind]));
      const dd = el('dd');
      dd.append(el('span', 'code ' + kind, isTyped(p, kind) ? `“${l.code}”` : l.code));
      const meaning = meaningOf(kind, l);
      const note = [isTyped(p, kind) ? 'Named by you' : '', meaning].filter(Boolean).join('. ');
      if (note) dd.append(el('small', null, note));
      dl.append(dd);
    }
    parts.push(dl);

    // Its link, with whichever label
    parts.push(el('h3', null, 'Link'));
    const line = el('div', 'link-line');
    let pickKind = k;
    const code = el('code', null, playlistUrl(p, pickKind).replace('https://', ''));
    const which = el('select', null, null, { 'aria-label': 'Label in the link' });
    for (const kind of KINDS) {
      if (!p.labels[kind]) continue;
      const opt = el('option', null, `${KIND_NAME[kind]} label`);
      opt.value = kind;
      opt.selected = kind === pickKind;
      which.append(opt);
    }
    which.addEventListener('change', () => { pickKind = which.value; code.textContent = playlistUrl(p, pickKind).replace('https://', ''); });
    const msg = el('p', 'sheet-msg ok');
    line.append(code, which,
      btn('Copy link', 'act', () => writeLink(playlistUrl(p, pickKind)).then(ok => { msg.textContent = ok ? 'Link copied' : asciiLink(playlistUrl(p, pickKind)); })),
      btn('Copy for Discord', 'act', () => writeLink(playlistUrl(p, pickKind), true).then(ok => { msg.textContent = ok ? 'Copied for Discord. Paste it in a message.' : discordLink(playlistUrl(p, pickKind)); })));
    parts.push(line, msg);

    // What you can do with it
    const acts = el('div', 'sheet-acts');
    acts.append(link('Play', 'act go', playlistPathFor(p) + '#play'), link('Edit songs', 'act', playlistPathFor(p)));
    const renameBtn = btn(p.renamesLeft > 0 ? `Rename (${p.renamesLeft} left today)` : 'Rename (none left today)', 'act', () => {
      openLabelEditor({
        mode: 'rename', id: p.id, labels: p.labels, typed: p.typed || [], renamesLeft: p.renamesLeft, renamesPerDay: lib.renamesPerDay,
        onSave: data => { Object.assign(p, pick(data)); redraw(); drawBehind(); toast('Renamed'); },
      });
    });
    const pinBtn = btn(p.pinned ? 'Unpin' : 'Pin', 'act', async () => {
      pinBtn.disabled = true;
      const { ok, data } = await postWorker('/playlist/shelf', { id: p.id, pinned: !p.pinned });
      pinBtn.disabled = false;
      if (!ok) { errLine.textContent = data.error || "Couldn't change the featured shelf. Try again."; return; }
      p.pinned = data.pinned;
      redraw();
      drawBehind();
      toast(p.pinned ? 'Pinned to Featured' : 'Unpinned');
    });
    const crateBtn = btn(p.crate ? 'Move to crate' : 'Put in a crate', 'act', () => crateMenu(crateBtn, p, redraw));
    crateBtn.dataset.menu = '1';
    const delBtn = btn('Delete', 'act warn', async () => {
      delBtn.disabled = true;
      const { ok, data } = await postWorker('/playlist/delete', { id: p.id });
      if (!ok) { delBtn.disabled = false; errLine.textContent = data.error || "Couldn't delete it. Try again."; return; }
      o.close();
      lib.playlists = lib.playlists.filter(x => x !== p);
      refreshCrates();
      render();
      toast(`Deleted ${p.id}. Its links stop working.`, 'Undo', async () => {
        const back = await postWorker('/playlist/restore', { id: p.id });
        if (!back.ok) return toast("Couldn't bring it back. Try again from this page.");
        lib.playlists.push({ ...p, ...pick(back.data) });
        refreshCrates();
        render();
        toast(`Restored ${p.id}`);
      });
    });
    acts.append(renameBtn, pinBtn, crateBtn, delBtn);
    const errLine = el('p', 'sheet-msg');
    parts.push(acts, errLine);

    parts.push(el('h3', null, 'Songs'), el('ol', 'songs', null, { 'data-songs': '1' }));
    parts.push(el('h3', null, 'History'), el('ul', 'trail', null, { 'data-trail': '1' }));
    return parts;
  }

  // The playlist fields a Worker reply can change
  const pick = d => {
    const out = {};
    for (const key of ['labels', 'typed', 'items', 'notes', 'pinned', 'crate', 'renamesLeft', 'updated', 'created']) if (d[key] !== undefined) out[key] = d[key];
    return out;
  };

  // Redraws the page behind an open sheet
  function drawBehind() {
    if (root() && !root().hidden && lib) render();
  }

  function meaningOf(kind, l) {
    if (!l || !l.chars) return '';
    if (kind === 'zh') return l.chars.map(c => c.meaning).filter(Boolean).join(' + ') + (l.word ? ` (also a word: ${l.word})` : '');
    if (kind === 'eg' || kind === 'em') return l.chars.map(c => c.name).filter(Boolean).join(' + ');
    return '';
  }

  function crateMenu(anchor, p, redraw) {
    const move = async crate => {
      const { ok, data } = await postWorker('/playlist/shelf', { id: p.id, crate });
      if (!ok) return toast(data.error || "Couldn't move it. Try again.");
      p.crate = data.crate;
      refreshCrates();
      redraw();
      drawBehind();
      toast(p.crate ? `Moved to ${p.crate}` : 'Taken out of its crate');
    };
    const items = lib.crates.filter(c => c !== p.crate).map(c => ({ text: c, onClick: () => move(c) }));
    if (items.length) items.push('sep');
    items.push({ text: 'New crate…', onClick: () => newCrate(anchor, move) });
    if (p.crate) items.push({ text: 'Take out of its crate', onClick: () => move(null) });
    menuUnder(anchor, items);
  }

  function newCrate(anchor, move) {
    const row = el('div', 'crate-new');
    const input = el('input', null, null, { placeholder: 'Crate name, like Late night', maxlength: '24', 'aria-label': 'New crate name' });
    const go = () => { const v = input.value.trim(); if (v) move(v); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    row.append(input, btn('Move', 'act go', go));
    anchor.closest('.sheet-acts').after(row);
    input.focus();
  }

  function refreshCrates() {
    lib.crates = [...new Set(lib.playlists.map(p => p.crate).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  // Song names fill in as they arrive; liner notes show under their songs
  function loadSongs(p, sheet) {
    const ol = sheet.querySelector('[data-songs]');
    if (!ol) return;
    splitLinks(p.items).forEach((t, i) => {
      const it = parseItem(t);
      const li = el('li');
      const name = el('span', null, it && it.code ? it.code : 'Song');
      li.append(name, el('small', null, it && !it.error ? rangeLabel(it) : ''));
      const note = p.notes && p.notes[i];
      if (note) li.append(el('em', null, note));
      ol.append(li);
      songName(it).then(n => { if (n) name.textContent = it.code ? `${it.code} (${n})` : n; });
    });
  }

  async function loadTrail(p, sheet) {
    const ul = sheet.querySelector('[data-trail]');
    if (!ul) return;
    const { ok, data } = await getWorker('/playlist/history?id=' + p.id);
    if (!ok) return ul.replaceChildren(el('li', null, "Couldn't load its history."));
    const rows = data.history.map(ev => {
      const li = el('li');
      li.append(el('time', null, shortDate(ev.at), { datetime: ev.at }));
      let text;
      if (ev.kind === 'born') text = `Made as ${Object.values(ev.labels || {}).join(' ')}`;
      else if (ev.kind === 'rename') {
        const changed = KINDS.filter(k => (ev.from || {})[k] !== (ev.to || {})[k]);
        text = 'Renamed ' + (changed.length ? changed.map(k => `${(ev.from || {})[k] || 'nothing'} to ${(ev.to || {})[k] || 'nothing'}`).join(', ') : '(which labels are yours)');
      } else if (ev.kind === 'edit') text = `Songs changed (${count(ev.songs, 'song', 'songs')} now)`;
      else text = ev.kind;
      li.append(el('span', null, text));
      return li;
    });
    ul.replaceChildren(...(rows.length ? rows : [el('li', null, `Made ${shortDate(data.created)}`)]));
  }

  // ---- Song names ----------------------------------------------------------------------------
  const names = new Map();
  function songName(it) {
    if (!it || it.error) return Promise.resolve(null);
    const idP = it.id ? Promise.resolve(it.id) : it.code ? lookupCode(it.code).then(rec => rec && rec.id, () => null) : Promise.resolve(null);
    return idP.then(id => (id ? trackName(id).then(n => { if (n) names.set(id, n); return n; }) : null));
  }

  // ---- Codes you named ------------------------------------------------------------------------
  function codesTab() {
    if (!myCodes.length) {
      return [emptyBox('No codes yet', 'When you share a song as a code while signed in, the code you save shows up here. It stays everyone\'s to use, with you as its namer.', link('Share a song', null, '/'))];
    }
    const box = el('div', 'item-rows');
    for (const c of myCodes) {
      const row = el('div', 'item-row');
      row.append(el('span', 'big ' + c.script, c.code));
      const what = el('div', 'what');
      const title = el('span', null, 'Song');
      what.append(title, el('small', null, `${KIND_NAME[c.script]} code, named ${shortDate(c.at)}`));
      trackName(c.track).then(n => { if (n) title.textContent = n; });
      const acts = el('div', 'acts');
      const url = `${SITE_BASE}/${c.code}`;
      acts.append(link('Play', 'act go', `/${c.code}`), btn('Copy link', 'act', () => copied(writeLink(url))), addButton(c.code));
      row.append(what, acts);
      box.append(row);
    }
    return [box];
  }

  const copied = promise => promise.then(ok => toast(ok ? 'Link copied' : "Couldn't copy. Open it and copy the address instead."));

  // ---- Clips ------------------------------------------------------------------------------------
  // Every song and clip across your playlists, once each, with the playlists it's in
  function allClips() {
    if (!lib) return [];
    const seen = new Map();
    for (const p of lib.playlists) {
      for (const t of splitLinks(p.items)) {
        const it = parseItem(t);
        if (!it || it.error || it.list) continue;
        const key = itemToken(it);
        if (!seen.has(key)) seen.set(key, { token: key, item: it, lists: [] });
        if (!seen.get(key).lists.includes(p)) seen.get(key).lists.push(p);
      }
    }
    return [...seen.values()];
  }

  function clipsTab(clips) {
    if (!clips.length) {
      return [emptyBox('No clips yet', 'Every song and clip in your playlists shows up here, ready to add to another playlist.', link('Make a playlist', null, '/playlist'))];
    }
    const box = el('div', 'item-rows');
    for (const c of clips) {
      const it = c.item;
      const row = el('div', 'item-row');
      row.append(el('span', 'big clip', it.end != null ? `${formatTime(it.start)}–${formatTime(it.end)}` : it.start ? `from ${formatTime(it.start)}` : 'whole'));
      const what = el('div', 'what');
      const title = el('span', null, it.code || 'Song');
      what.append(title, el('small', null, 'In ' + c.lists.map(p => { const k = mainKind(p); return k ? `${p.id} ${named(p, k)}` : p.id; }).join(', ')));
      songName(it).then(n => { if (n) title.textContent = it.code ? `${it.code} (${n})` : n; });
      const url = it.code ? `${SITE_BASE}/${it.code}${codeSuffix(it.start, it.end)}` : buildShareUrl(it.id, it.start, it.end);
      const path = it.code ? `/${it.code}${codeSuffix(it.start, it.end)}` : `/track/${it.id}$${it.start}` + (it.end != null ? `-${it.end}` : '');
      const acts = el('div', 'acts');
      acts.append(link('Play', 'act go', path), btn('Copy link', 'act', () => copied(writeLink(url))), addButton(c.token));
      row.append(what, acts);
      box.append(row);
    }
    return [box];
  }

  // "Add to playlist": one of yours (it's saved right away), or a new playlist starting with it
  function addButton(token) {
    const b = btn('Add to playlist', 'act', () => {
      const items = lib.playlists.slice().sort((x, y) => String(y.updated).localeCompare(String(x.updated))).map(p => {
        const k = mainKind(p);
        return { text: k ? `${p.id}  ${named(p, k)}` : p.id, onClick: () => addTo(p, token) };
      });
      if (items.length) items.push('sep');
      items.push({ text: 'New playlist with this', href: `/playlist/${token}` });
      menuUnder(b, items);
    });
    b.dataset.menu = '1';
    return b;
  }

  async function addTo(p, token) {
    const items = `${p.items},${token}`;
    const body = { edit: p.id, items };
    if (p.notes) body.notes = [...p.notes, ''];
    const { ok, data } = await postWorker('/playlist/save', body);
    if (!ok) return toast(data.error || "Couldn't add it. Try again.");
    Object.assign(p, pick(data));
    const k = mainKind(p);
    toast(`Added to ${p.id}${k ? ' ' + named(p, k) : ''}`);
    render();
  }

  // ---- The label editor ----------------------------------------------------------------------
  // opts: { mode: 'rename' | 'new', id, items, labels, typed, renamesLeft, renamesPerDay, onSave }
  // Edit any of the four labels. The ones you change are yours; the rest can stay as they are,
  // or be matched by the AI to mean the same as your new name, with a reroll for each.
  let sets = null;
  function loadSets() {
    if (!sets) sets = getWorker('/sets').then(r => (r.ok ? r.data : null), () => null).then(d => { if (!d) sets = null; return d; });
    return sets;
  }

  function openLabelEditor(opts) {
    const o = overlay(opts.mode === 'rename' ? 'Rename playlist' : 'Name your playlist');
    const ed = { rows: {}, busy: false, msg: '', msgOk: false };
    for (const k of KINDS) {
      const l = opts.labels && opts.labels[k];
      ed.rows[k] = { start: l ? l.code : '', value: l ? l.code : '', label: l || null, wasTyped: (opts.typed || []).includes(k), matched: false, alts: [], at: 0, error: '' };
    }
    const norm = (k, v) => {
      v = String(v || '').trim();
      return k === 'en' ? v.toLowerCase().replace(/[\s_]+/g, '-') : v.replace(/\s+/g, '').replace(/[︎️]/g, '');
    };
    const dirty = k => norm(k, ed.rows[k].value) !== norm(k, ed.rows[k].start) && !ed.rows[k].matched;
    const changedAny = () => KINDS.some(k => norm(k, ed.rows[k].value) !== norm(k, ed.rows[k].start));
    // Yours: what you typed now, and labels you typed before that stay as they were
    const typedNow = () => KINDS.filter(k => norm(k, ed.rows[k].value) && (dirty(k) || (ed.rows[k].wasTyped && !ed.rows[k].matched && norm(k, ed.rows[k].value) === norm(k, ed.rows[k].start))));
    const typedChanged = () => JSON.stringify(typedNow()) !== JSON.stringify(KINDS.filter(k => ed.rows[k].wasTyped && ed.rows[k].start));
    // Matching rewrites every label that isn't yours, and fills empty boxes
    const matchable = () => KINDS.filter(k => !typedNow().includes(k));

    const { sheet } = o;
    const outOfRenames = opts.mode === 'rename' && opts.renamesLeft <= 0;

    function draw(focusKind) {
      const keep = sheet.querySelector('.sheet-close');
      const parts = [keep];
      parts.push(el('h3', null, opts.mode === 'rename' ? 'Rename' : 'Name it yourself'));
      parts.push(el('p', 'ed-intro', 'Change any label below: the ones you write are yours and show in quotes. The others can stay as they are, or be matched to mean the same as your name.'));
      for (const k of KINDS) parts.push(rowBox(k));
      const changed = KINDS.filter(dirty);
      if (changed.length && matchable().length) {
        const m = el('div', 'ed-match');
        m.append(el('p', null, `You changed ${changed.map(k => KIND_NAME[k]).join(' and ')}. Match ${matchable().map(k => KIND_NAME[k]).join(', ')} to your new name too?`));
        const row2 = el('div', 'row2');
        row2.append(btn(ed.busy ? 'Matching…' : 'Match the others', 'act go', matchOthers, { disabled: ed.busy ? '' : null }),
          el('span', 'small-note', 'Or save now to keep them as they are.'));
        m.append(row2);
        parts.push(m);
      }
      const foot = el('div', 'ed-foot');
      const left = el('div', 'left');
      if (opts.mode === 'rename') {
        left.textContent = outOfRenames ? 'No renames left today. You can rename this playlist again tomorrow.'
          : `${opts.renamesLeft} of ${opts.renamesPerDay || 3} renames left today. Saving uses one. Old links keep working.`;
      } else {
        left.textContent = 'Nothing is saved until you copy a link.';
      }
      if (ed.msg) left.append(el('p', ed.msgOk ? 'sheet-msg ok' : 'sheet-msg', ed.msg));
      const btns = el('div', 'btns');
      const canSave = !ed.busy && !outOfRenames && (changedAny() || typedChanged()) && KINDS.some(k => norm(k, ed.rows[k].value));
      btns.append(btn('Cancel', 'secondary', o.close),
        btn(opts.mode === 'rename' ? 'Save names' : 'Use these names', null, save, { disabled: canSave ? null : '' }));
      foot.append(left, btns);
      parts.push(foot);
      sheet.replaceChildren(...parts);
      if (focusKind) {
        const f = sheet.querySelector(`input[data-kind="${focusKind}"]`);
        if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
      }
    }

    function rowBox(k) {
      const r = ed.rows[k];
      const box = el('div', 'ed-row');
      box.dataset.kind = k;
      const head = el('div', 'ed-head');
      head.append(el('label', null, KIND_NAME[k], { for: 'ed-' + k }), el('span', 'hint', KIND_HINT[k]));
      if (norm(k, r.value) && typedNow().includes(k)) head.append(el('span', 'badge yours', 'yours'));
      else if (r.matched) head.append(el('span', 'badge matched', 'matched'));
      box.append(head);
      const field = el('div', 'ed-field');
      const input = el('input', k, null, { id: 'ed-' + k, autocomplete: 'off', spellcheck: 'false', 'data-kind': k, maxlength: k === 'en' ? '25' : '12' });
      input.value = r.value;
      if (outOfRenames) input.disabled = true;
      input.addEventListener('input', () => {
        r.value = input.value;
        r.matched = false;
        r.error = '';
        ed.msg = '';
        draw(k);
      });
      field.append(input);
      if (k === 'eg' || k === 'em') field.append(btn('Pick', null, () => togglePicker(k, box), { 'aria-expanded': 'false', disabled: outOfRenames ? '' : null }));
      if (r.matched && r.alts.length > 1) {
        field.append(btn('🎲', null, () => {
          r.at = (r.at + 1) % r.alts.length;
          r.label = r.alts[r.at];
          r.value = r.label.code;
          draw();
        }, { 'aria-label': `Another ${KIND_NAME[k]} match`, title: 'Try another match' }));
      }
      box.append(field);
      const sameAsLabel = r.label && norm(k, r.label.code) === norm(k, r.value);
      box.append(el('p', 'ed-mean', sameAsLabel ? meaningOf(k, r.label) || (r.label.why && r.matched ? r.label.why : '') : ''));
      box.append(el('p', 'ed-err', r.error));
      return box;
    }

    async function togglePicker(k, box) {
      const open = box.querySelector('.picker');
      if (open) { open.remove(); return; }
      const pk = el('div', 'picker');
      pk.append(el('p', 'small-note', 'Loading…'));
      box.append(pk);
      const data = await loadSets();
      if (!data) return pk.replaceChildren(el('p', 'small-note', "Couldn't load the signs. Type or paste them instead."));
      const list = k === 'eg' ? data.glyphs.map(g => ({ ch: g.c, name: `${g.name}: ${g.meaning}` })) : data.emoji.map(x => ({ ch: x.e, name: x.name }));
      const grid = el('div', 'grid ' + k);
      const search = el('input', null, null, { type: 'search', placeholder: k === 'eg' ? 'Find a sign: star, water, heart…' : 'Find an emoji: moon, car, fire…', 'aria-label': 'Find' });
      const fill = () => {
        const q = search.value.trim().toLowerCase();
        grid.replaceChildren(...list.filter(x => !q || x.name.toLowerCase().includes(q)).map(x => btn(x.ch, null, () => {
          const r = ed.rows[k];
          const now = [...norm(k, r.value)];
          if (now.length >= 3) return;
          r.value = now.join('') + x.ch;
          r.matched = false;
          r.error = '';
          const input = sheet.querySelector(`input[data-kind="${k}"]`);
          input.value = r.value;
          redrawRow(k);
        }, { title: x.name, 'aria-label': x.name })));
      };
      search.addEventListener('input', fill);
      const under = el('div', 'under');
      under.append(el('span', null, k === 'eg' ? 'Tap up to 3 signs' : 'Tap up to 3 emoji'),
        btn('Remove last', null, () => {
          const r = ed.rows[k];
          r.value = [...norm(k, r.value)].slice(0, -1).join('');
          r.matched = false;
          sheet.querySelector(`input[data-kind="${k}"]`).value = r.value;
          redrawRow(k);
        }),
        btn('Done', null, () => draw()));
      pk.replaceChildren(search, grid, under);
      fill();
      search.focus();
    }

    // Redraws the badges and buttons around a row without closing its picker
    function redrawRow(k) {
      const box = sheet.querySelector(`.ed-row[data-kind="${k}"]`);
      const pk = box && box.querySelector('.picker');
      draw();
      if (pk) {
        const again = sheet.querySelector(`.ed-row[data-kind="${k}"]`);
        again.append(pk);
      }
    }

    async function matchOthers() {
      const fixed = {};
      for (const k of typedNow()) fixed[k] = norm(k, ed.rows[k].value);
      if (!Object.keys(fixed).length) return;
      ed.busy = true;
      ed.msg = '';
      draw();
      const body = { fixed, match: true };
      if (opts.id) body.id = opts.id; else body.items = opts.items;
      const { ok, status, data } = await postWorker('/labels', body);
      ed.busy = false;
      if (!ok) {
        if (data.kind && ed.rows[data.kind]) ed.rows[data.kind].error = data.error;
        else { ed.msg = status === 0 ? "Couldn't reach Spotiky. Check your connection." : data.error || "Couldn't match the labels. Try again."; ed.msgOk = false; }
        return draw();
      }
      for (const k of KINDS) {
        const l = data.labels && data.labels[k];
        if (!l) continue;
        const r = ed.rows[k];
        if (l.matched) {
          r.alts = [l, ...(l.alternates || [])];
          r.at = 0;
          r.label = l;
          r.value = l.code;
          r.matched = true;
          r.error = '';
        } else if (fixed[k]) {
          r.label = { ...l, code: fixed[k] };   // your own label, with its characters described
        }
      }
      ed.msg = KINDS.some(k => ed.rows[k].matched) ? 'Matched. Tap 🎲 to try another.' : '';
      ed.msgOk = true;
      draw();
    }

    function labelsToSend() {
      const out = {};
      for (const k of KINDS) {
        const r = ed.rows[k];
        const code = norm(k, r.value);
        if (!code) continue;
        const l = r.label && norm(k, r.label.code) === code ? r.label : null;
        out[k] = k === 'zh' ? { code, chars: l ? l.chars : undefined, why: l && l.why } : { code, why: l && l.why };
      }
      return out;
    }

    async function save() {
      if (ed.busy) return;
      for (const k of KINDS) ed.rows[k].error = '';
      ed.busy = true;
      ed.msg = 'Saving…';
      ed.msgOk = true;
      draw();
      const labels = labelsToSend(), typed = typedNow();
      if (opts.mode === 'rename') {
        const { ok, status, data } = await postWorker('/playlist/rename', { id: opts.id, labels, typed });
        ed.busy = false;
        if (!ok) {
          if (status === 401) signedOutLocally();
          if (data.kind && ed.rows[data.kind]) { ed.rows[data.kind].error = data.error; ed.msg = ''; }
          else { ed.msg = status === 401 ? 'Sign in again to rename it.' : status === 0 ? "Couldn't reach Spotiky. Check your connection." : data.error || "Couldn't rename it. Try again."; ed.msgOk = false; }
          return draw();
        }
        o.close();
        opts.onSave(data);
        return;
      }
      // A playlist that isn't saved yet: check the labels you wrote, then hand all four back
      const mineOnly = {};
      for (const k of typed) if (dirty(k)) mineOnly[k] = labels[k].code;
      let described = {};
      if (Object.keys(mineOnly).length) {
        const { ok, status, data } = await postWorker('/labels', { fixed: mineOnly });
        if (!ok) {
          ed.busy = false;
          if (data.kind && ed.rows[data.kind]) { ed.rows[data.kind].error = data.error; ed.msg = ''; }
          else { ed.msg = status === 0 ? "Couldn't reach Spotiky. Check your connection." : data.error || "Couldn't check the labels. Try again."; ed.msgOk = false; }
          return draw();
        }
        described = data.labels || {};
      }
      ed.busy = false;
      const out = {};
      for (const k of KINDS) {
        const r = ed.rows[k], code = norm(k, r.value);
        if (!code) continue;
        if (described[k]) out[k] = { ...described[k], code };
        else if (r.label && norm(k, r.label.code) === code) out[k] = r.label;
        else out[k] = { code, chars: [...(k === 'en' ? code.split('-') : code)].map(c => ({ char: c })) };
      }
      o.close();
      opts.onSave({ labels: out, typed });
    }

    draw(KINDS.find(k => !outOfRenames));
  }

  window.SpotikyCollection = { start, openLabelEditor, render: () => render() };
})();
