// ================= AURA AI — app (v3) =================
import { firebaseConfig } from './firebase-config.js';

// ---- Settings ----
const LOCAL_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC'; // on-device fallback (~0.9 GB, one-time download)
const BASE_PROMPT = 'You are AURA AI, a helpful, friendly and concise assistant.';
const FB_VERSION = '11.0.2';
const USE_FIREBASE = !!(firebaseConfig && firebaseConfig.apiKey);
const MAX_FILES = 4;
const MAX_PDF_BYTES = 2.5 * 1024 * 1024;
const MAX_TEXT_CHARS = 60000;
const FILE_HISTORY = 6;                 // only attach file data for the last N messages
const DEFAULT_SETTINGS = { theme: 'system', model: 'smart', about: '', autoSpeak: false, search: false };

// ---- Tiny DOM helpers ----
const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
  return n;
}
const svg = (inner, size = 16) =>
  h('span', { class: 'ico', html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>` });
const ICON = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5 12 16l2.5-2.5"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/>',
  share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4M12 2v14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  install: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const lsGet = (k, d = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(text, { breaks: true, gfm: true });
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  }
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML.replace(/\n/g, '<br>');
}

function enhanceBubble(bubble) {
  bubble.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  bubble.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement.classList.contains('pre-wrap')) return;
    const wrap = h('div', { class: 'pre-wrap' });
    pre.replaceWith(wrap);
    wrap.append(pre, h('button', { class: 'copy-code', type: 'button', onclick: async (e) => {
      try { await navigator.clipboard.writeText(pre.innerText); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1400); }
      catch { toast('Copy failed'); }
    } }, 'Copy'));
  });
}

function plainText(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|#-]{1,3}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ================= STATE =================
const S = {
  user: null,
  store: null,
  view: null,
  projects: [],
  chats: [],
  settings: { ...DEFAULT_SETTINGS },
  currentId: null,
  draftProjectId: null,
  expanded: new Set(lsGet('aura:expanded', [])),
  search: '',
  streaming: null,        // { chatId, text }
  abort: null,            // AbortController for the active reply
  pending: [],            // files attached to the next message
  authMode: 'signin',
  speakingIdx: null,
};
const fileCache = new Map(); // file id -> { mimeType, data } (kept in memory only)
const currentChat = () => S.chats.find((c) => c.id === S.currentId) || null;
const projectById = (id) => S.projects.find((p) => p.id === id) || null;

// ================= THEME =================
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  lsSet('aura:theme', theme || 'system');
}

// ================= FIREBASE =================
let fb = null;
async function initFirebase() {
  if (fb) return fb;
  const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
  const [appM, A, F] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js'),
  ]);
  const app = appM.initializeApp(firebaseConfig);
  fb = { auth: A.getAuth(app), db: F.getFirestore(app), A, F };
  return fb;
}

function clean(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj)) if (k !== 'id' && v !== undefined) o[k] = v;
  return JSON.parse(JSON.stringify(o)); // drops undefined deep inside (Firestore rejects it)
}

function firebaseStore(userId) {
  const { F, db } = fb;
  const ref = (col, id) => F.doc(db, 'users', userId, col, id);
  const list = async (col) => (await F.getDocs(F.collection(db, 'users', userId, col))).docs.map((d) => ({ id: d.id, ...d.data() }));
  return {
    listProjects: () => list('projects'),
    listChats: () => list('chats'),
    saveProject: (p) => F.setDoc(ref('projects', p.id), clean(p)),
    deleteProject: (id) => F.deleteDoc(ref('projects', id)),
    saveChat: (c) => F.setDoc(ref('chats', c.id), clean(c)),
    deleteChat: (id) => F.deleteDoc(ref('chats', id)),
    getSettings: async () => { const d = await F.getDoc(ref('settings', 'prefs')); return d.exists() ? d.data() : null; },
    saveSettings: (s) => F.setDoc(ref('settings', 'prefs'), clean(s)),
    deleteSettings: () => F.deleteDoc(ref('settings', 'prefs')),
    saveShare: (id, data) => F.setDoc(F.doc(db, 'shares', id), clean(data)),
    deleteShare: (id) => F.deleteDoc(F.doc(db, 'shares', id)),
  };
}

function localStore(userId) {
  const kp = `aura:${userId}:projects`, kc = `aura:${userId}:chats`, ks = `aura:${userId}:settings`;
  const upsert = (key, item) => { const a = lsGet(key, []); const i = a.findIndex((x) => x.id === item.id); if (i >= 0) a[i] = item; else a.push(item); lsSet(key, a); };
  const remove = (key, id) => lsSet(key, lsGet(key, []).filter((x) => x.id !== id));
  return {
    listProjects: async () => lsGet(kp, []),
    listChats: async () => lsGet(kc, []),
    saveProject: async (p) => upsert(kp, p),
    deleteProject: async (id) => remove(kp, id),
    saveChat: async (c) => upsert(kc, c),
    deleteChat: async (id) => remove(kc, id),
    getSettings: async () => lsGet(ks, null),
    saveSettings: async (s) => lsSet(ks, s),
    deleteSettings: async () => lsDel(ks),
    saveShare: async () => { throw new Error('demo'); },
    deleteShare: async () => {},
  };
}

async function persist(fn, ...args) {
  try { await S.store[fn](...args); return true; }
  catch (e) { console.error(e); toast("Couldn't save. Check your connection and try again."); return false; }
}

// ================= VIEWS / ROUTING =================
function show(view) {
  for (const v of ['loading', 'home', 'auth', 'app', 'share']) $('#view-' + v).hidden = v !== view;
  document.title = view === 'app' ? 'AURA AI' : view === 'auth' ? (S.authMode === 'signup' ? 'Sign up · AURA AI' : 'Log in · AURA AI') : view === 'share' ? document.title : 'AURA AI · Free AI assistant';
}

function route() {
  const hash = location.hash.replace(/^#/, '');
  if (S.user) {
    if (S.view !== 'app') return;
    const m = hash.match(/^c\/(.+)$/);
    if (m && S.chats.some((c) => c.id === m[1])) { if (S.currentId !== m[1]) openChat(m[1], false); }
    else if (!m && hash !== '' && hash !== 'new') { history.replaceState(null, '', '#'); }
    return;
  }
  if (hash === 'signin' || hash === 'signup') { setAuthMode(hash); show('auth'); }
  else show('home');
}
window.addEventListener('hashchange', route);

// ================= AUTH =================
function setAuthMode(mode) {
  S.authMode = mode;
  const up = mode === 'signup';
  $('#auth-title').textContent = up ? 'Create your account' : 'Welcome back';
  $('#auth-sub').textContent = up ? 'Free forever. Takes 30 seconds.' : 'Log in to continue to AURA AI.';
  $('#field-name').hidden = !up;
  $('#auth-submit').textContent = up ? 'Create account' : 'Log in';
  $('#in-pass').setAttribute('autocomplete', up ? 'new-password' : 'current-password');
  $('#btn-forgot').hidden = up || !USE_FIREBASE;
  $('#auth-switch-text').textContent = up ? 'Already have an account?' : 'New to AURA?';
  $('#auth-switch').textContent = up ? 'Log in' : 'Create an account';
  $('#auth-switch').setAttribute('href', up ? '#signin' : '#signup');
  $('#auth-demo').hidden = USE_FIREBASE;
  $('#field-pass').hidden = !USE_FIREBASE;
  authMsg();
}
function authMsg(err = '', ok = '') {
  $('#auth-error').textContent = err; $('#auth-error').hidden = !err;
  $('#auth-ok').textContent = ok; $('#auth-ok').hidden = !ok;
}
function friendlyAuthError(e) {
  const c = (e && e.code) || '';
  const map = {
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/missing-password': 'Please enter your password.',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/email-already-in-use': 'An account with this email already exists. Try logging in.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/wrong-password': 'Email or password is incorrect.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/too-many-requests': 'Too many attempts. Please wait a minute and try again.',
    'auth/popup-closed-by-user': '',
    'auth/cancelled-popup-request': '',
    'auth/popup-blocked': 'Your browser blocked the sign-in popup. Allow popups for this site and try again.',
    'auth/unauthorized-domain': 'This website isn\'t authorised for sign-in yet. Add it under Firebase → Authentication → Settings → Authorized domains.',
    'auth/operation-not-allowed': 'This sign-in method isn\'t switched on yet in Firebase → Authentication → Sign-in method.',
    'auth/network-request-failed': 'Network problem. Check your connection.',
  };
  return c in map ? map[c] : 'Something went wrong. Please try again.';
}

function wireAuth() {
  $('#btn-google').addEventListener('click', async () => {
    authMsg();
    if (!USE_FIREBASE) return authMsg('Google sign-in becomes available once Firebase is connected. In demo mode, enter your email below.');
    try { await fb.A.signInWithPopup(fb.auth, new fb.A.GoogleAuthProvider()); }
    catch (e) { const m = friendlyAuthError(e); if (m) authMsg(m); }
  });

  $('#auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    authMsg();
    const name = $('#in-name').value.trim();
    const email = $('#in-email').value.trim();
    const pass = $('#in-pass').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) return authMsg('Please enter a valid email address.');
    const btn = $('#auth-submit');
    if (!USE_FIREBASE) {
      const g = { uid: 'demo-' + email.toLowerCase(), name: name || email.split('@')[0], email, demo: true };
      lsSet('aura:demo-user', g);
      return enterApp(g);
    }
    btn.disabled = true;
    try {
      if (S.authMode === 'signup') {
        const cred = await fb.A.createUserWithEmailAndPassword(fb.auth, email, pass);
        const displayName = name || email.split('@')[0];
        await fb.A.updateProfile(cred.user, { displayName });
        if (S.user) { S.user.name = displayName; renderUser(); renderChat(); }
      } else {
        await fb.A.signInWithEmailAndPassword(fb.auth, email, pass);
      }
    } catch (e) { authMsg(friendlyAuthError(e)); }
    finally { btn.disabled = false; }
  });

  $('#btn-forgot').addEventListener('click', async () => {
    authMsg();
    const email = $('#in-email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return authMsg('Type your email above first, then click "Forgot password?".');
    try { await fb.A.sendPasswordResetEmail(fb.auth, email); authMsg('', 'Check your inbox for a link to reset your password.'); }
    catch (e) { authMsg(friendlyAuthError(e)); }
  });
}

async function signOutUser() {
  closeMenu();
  stopSpeaking();
  if (USE_FIREBASE) await fb.A.signOut(fb.auth);
  else { lsDel('aura:demo-user'); leaveApp(); }
}

async function enterApp(user) {
  S.user = user;
  S.store = USE_FIREBASE ? firebaseStore(user.uid) : localStore(user.uid);
  show('loading');
  try {
    const [projects, chats, settings] = await Promise.all([
      S.store.listProjects(), S.store.listChats(), S.store.getSettings().catch(() => null),
    ]);
    S.projects = projects;
    S.chats = chats.map((c) => ({ ...c, messages: c.messages || [] }));
    S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}), search: !!lsGet('aura:search', false) };
  } catch (e) {
    console.error(e);
    S.projects = []; S.chats = [];
    toast("Couldn't load your chats. Check that Firestore is set up.", 6000);
  }
  applyTheme(S.settings.theme);
  S.view = 'app';
  show('app');
  if (window.innerWidth <= 760) $('#view-app').classList.add('side-closed');
  renderUser();
  renderSearchToggle();
  const m = location.hash.match(/^#c\/(.+)$/);
  if (m && S.chats.some((c) => c.id === m[1])) openChat(m[1], false);
  else newChat(null);
}

function leaveApp() {
  S.user = null; S.store = null; S.projects = []; S.chats = []; S.currentId = null; S.view = null; S.pending = [];
  fileCache.clear();
  history.replaceState(null, '', '#');
  show('home');
}

// ================= SIDEBAR =================
function sortByRecent(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }
function matches(c) {
  if (!S.search) return true;
  const q = S.search.toLowerCase();
  return (c.title || '').toLowerCase().includes(q) || c.messages.some((m) => (m.content || '').toLowerCase().includes(q));
}

function chatRow(c, sub = false) {
  return h('div', {
    class: 'row' + (sub ? ' sub' : '') + (c.id === S.currentId ? ' active' : ''),
    role: 'button', tabindex: '0', 'data-chat': c.id, title: c.title,
    onclick: (e) => { if (e.target.closest('.more') || e.target.closest('input')) return; openChat(c.id); },
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openChat(c.id); },
    ondblclick: (e) => { e.preventDefault(); startRename(c.id); },
  },
    h('span', { class: 'label', text: c.title || 'New chat' }),
    c.shareId ? h('span', { class: 'ico', title: 'Shared', html: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICON.share}</svg>` }) : null,
    h('button', { class: 'more', 'aria-label': 'Chat options', onclick: (e) => { e.stopPropagation(); chatMenu(c, e.currentTarget); } }, svg(ICON.dots)),
  );
}

function renderSidebar() {
  const plist = $('#project-list');
  plist.replaceChildren();
  const projects = [...S.projects].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!projects.length) plist.append(h('div', { class: 'side-empty', text: 'Group chats and set custom instructions.' }));
  for (const p of projects) {
    const kids = S.chats.filter((c) => c.projectId === p.id && matches(c)).sort(sortByRecent);
    if (S.search && !kids.length && !p.name.toLowerCase().includes(S.search.toLowerCase())) continue;
    const open = S.expanded.has(p.id) || (S.search && kids.length);
    const active = !S.currentId && S.draftProjectId === p.id;
    plist.append(h('div', {
      class: 'row' + (open ? ' open' : '') + (active ? ' active' : ''), role: 'button', tabindex: '0', title: p.name,
      onclick: (e) => { if (e.target.closest('.more')) return; toggleProject(p.id); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) toggleProject(p.id); },
    },
      svg(ICON.folder),
      h('span', { class: 'label', text: p.name }),
      h('button', { class: 'more', 'aria-label': 'Project options', onclick: (e) => { e.stopPropagation(); projectMenu(p, e.currentTarget); } }, svg(ICON.dots)),
      h('span', { class: 'ico chev', html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICON.chev}</svg>` }),
    ));
    if (open) {
      plist.append(h('button', { class: 'row sub-new', onclick: () => newChat(p.id) }, svg(ICON.plus, 14), h('span', { class: 'label', text: 'New chat in project' })));
      for (const c of kids) plist.append(chatRow(c, true));
    }
  }

  const groupsEl = $('#chat-groups');
  groupsEl.replaceChildren();
  const loose = S.chats.filter((c) => !c.projectId || !projectById(c.projectId)).filter(matches).sort(sortByRecent);
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const t0 = startOfDay.getTime(), DAY = 86400000;
  const buckets = [['Today', (t) => t >= t0], ['Yesterday', (t) => t >= t0 - DAY], ['Previous 7 days', (t) => t >= t0 - 7 * DAY], ['Previous 30 days', (t) => t >= t0 - 30 * DAY], ['Older', () => true]];
  const grouped = new Map();
  for (const c of loose) {
    const label = buckets.find(([, test]) => test(c.updatedAt || 0))[0];
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(c);
  }
  if (!loose.length) {
    groupsEl.append(h('div', { class: 'side-section' }, h('div', { class: 'side-head' }, h('span', { text: 'Chats' })),
      h('div', { class: 'side-empty', text: S.search ? 'No chats match your search.' : 'Your chats will appear here.' })));
  }
  for (const [label, list] of grouped) {
    groupsEl.append(h('div', { class: 'side-section' }, h('div', { class: 'side-head' }, h('span', { text: label })), list.map((c) => chatRow(c))));
  }
}

function toggleProject(id) {
  if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
  lsSet('aura:expanded', [...S.expanded]);
  renderSidebar();
}

function renderUser() {
  const u = S.user;
  const initial = (u.name || u.email || '?').trim().charAt(0).toUpperCase();
  const avatar = h('span', { class: 'avatar' }, u.photo ? h('img', { src: u.photo, alt: '', referrerpolicy: 'no-referrer' }) : initial);
  $('#side-user').replaceChildren(h('button', { class: 'user-btn', onclick: (e) => userMenu(e.currentTarget) },
    avatar,
    h('span', { class: 'user-meta' },
      h('div', { class: 'user-name', text: u.name || 'You' }),
      h('div', { class: 'user-sub' }, u.demo ? h('span', { class: 'tag', text: 'Demo mode' }) : (u.email || ''))),
  ));
}

// ================= MENUS =================
let menuAnchorRow = null;
function openMenu(anchor, items) {
  closeMenu();
  const m = $('#menu');
  m.replaceChildren();
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('hr')); continue; }
    if (it.header) { m.append(h('div', { class: 'mhead', text: it.header })); continue; }
    m.append(h('button', { class: it.danger ? 'danger' : '', role: 'menuitem', onclick: () => { closeMenu(); it.onClick(); } },
      it.icon ? svg(it.icon) : null, h('span', { class: 'mlabel', text: it.label }), it.checked ? h('span', { class: 'check', text: '✓' }) : null));
  }
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = r.left, top = r.bottom + 4;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = Math.max(8, left) + 'px';
  m.style.top = top + 'px';
  menuAnchorRow = anchor.closest('.row');
  menuAnchorRow?.classList.add('menu-open');
  m.querySelector('button')?.focus();
}
function closeMenu() {
  $('#menu').hidden = true;
  menuAnchorRow?.classList.remove('menu-open');
  menuAnchorRow = null;
}
document.addEventListener('mousedown', (e) => { if (!$('#menu').hidden && !e.target.closest('#menu') && !e.target.closest('.more') && !e.target.closest('.user-btn')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('resize', closeMenu);

function chatMenu(c, anchor) {
  const items = [
    { label: 'Rename', icon: ICON.edit, onClick: () => startRename(c.id) },
    { label: c.shareId ? 'Shared link…' : 'Share', icon: ICON.share, onClick: () => shareChat(c.id) },
    '-',
    { header: 'Move to project' },
  ];
  for (const p of [...S.projects].sort((a, b) => a.name.localeCompare(b.name))) {
    items.push({ label: p.name, icon: ICON.folder, checked: c.projectId === p.id, onClick: () => moveChat(c.id, p.id) });
  }
  items.push({ label: 'New project…', icon: ICON.plus, onClick: () => createProject(c.id) });
  if (c.projectId) items.push({ label: 'Remove from project', icon: ICON.move, onClick: () => moveChat(c.id, null) });
  items.push('-', { label: 'Delete', icon: ICON.trash, danger: true, onClick: () => deleteChat(c.id) });
  openMenu(anchor, items);
}

function projectMenu(p, anchor) {
  openMenu(anchor, [
    { label: 'New chat in project', icon: ICON.plus, onClick: () => newChat(p.id) },
    { label: 'Rename & instructions', icon: ICON.sliders, onClick: () => editProject(p.id) },
    '-',
    { label: 'Delete project', icon: ICON.trash, danger: true, onClick: () => deleteProject(p.id) },
  ]);
}

function userMenu(anchor) {
  openMenu(anchor, [
    { label: 'Settings', icon: ICON.gear, onClick: openSettings },
    installPrompt ? { label: 'Install app', icon: ICON.install, onClick: doInstall } : null,
    { label: 'Home page', icon: ICON.home, onClick: () => window.open(location.pathname + '?home', '_blank') },
    '-',
    { label: 'Log out', icon: ICON.out, onClick: signOutUser },
  ]);
}

// ================= DIALOGS =================
function openDialog(node, onDismiss) {
  const root = $('#modal-root');
  const esc = (e) => { if (e.key === 'Escape') close(true); };
  function close(dismissed = false) {
    root.hidden = true; root.replaceChildren(); root.onclick = null;
    document.removeEventListener('keydown', esc);
    if (dismissed && onDismiss) onDismiss();
  }
  root.replaceChildren(node);
  root.hidden = false;
  root.onclick = (e) => { if (e.target === root) close(true); };
  document.addEventListener('keydown', esc);
  return close;
}

function modal({ title, text, fields = [], confirm = 'Save', danger = false }) {
  return new Promise((resolve) => {
    const inputs = {};
    let close;
    const form = h('form', { class: 'modal', onsubmit: (e) => {
      e.preventDefault();
      const vals = {};
      for (const f of fields) {
        vals[f.name] = inputs[f.name].value.trim();
        if (f.required && !vals[f.name]) { inputs[f.name].focus(); return; }
      }
      close(); resolve(vals);
    } },
      h('h3', { text: title }),
      text ? h('p', { text }) : null,
      fields.map((f) => {
        const input = f.textarea
          ? h('textarea', { maxlength: f.max || 2000, placeholder: f.placeholder || '' })
          : h('input', { type: 'text', maxlength: f.max || 80, placeholder: f.placeholder || '' });
        input.value = f.value || '';
        inputs[f.name] = input;
        return h('label', { class: 'field' }, h('span', { text: f.label }), input, f.help ? h('small', { text: f.help }) : null);
      }),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { close(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'submit' }, confirm)),
    );
    close = openDialog(form, () => resolve(null));
    (Object.values(inputs)[0] || form.querySelector('[type=submit]')).focus();
  });
}

// ================= CHAT & PROJECT ACTIONS =================
function setHash(id) {
  const want = id ? '#c/' + id : '#';
  if (location.hash !== want && !(want === '#' && location.hash === '')) history.pushState(null, '', want);
}
function closeSideOnMobile() { if (window.innerWidth <= 760) $('#view-app').classList.add('side-closed'); }

function newChat(projectId = null) {
  S.currentId = null;
  S.draftProjectId = projectId;
  if (projectId) { S.expanded.add(projectId); lsSet('aura:expanded', [...S.expanded]); }
  setHash(null);
  renderSidebar(); renderChat(); closeSideOnMobile();
  $('#in-msg').focus();
}

function openChat(id, push = true) {
  if (!S.chats.some((c) => c.id === id)) return newChat(null);
  stopSpeaking();
  S.currentId = id;
  if (push) setHash(id);
  renderSidebar(); renderChat(); closeSideOnMobile();
}

function startRename(id) {
  const c = S.chats.find((x) => x.id === id);
  if (!c) return;
  const row = document.querySelector(`.row[data-chat="${CSS.escape(id)}"]`);
  if (!row) {
    return modal({ title: 'Rename chat', fields: [{ name: 'title', label: 'Chat name', value: c.title, required: true }] })
      .then((v) => v && renameChat(id, v.title));
  }
  const label = row.querySelector('.label');
  const input = h('input', { class: 'rename', maxlength: 80, 'aria-label': 'Chat name' });
  input.value = c.title;
  label.replaceWith(input);
  input.focus(); input.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return; finished = true;
    if (save && input.value.trim() && input.value.trim() !== c.title) renameChat(id, input.value.trim());
    else renderSidebar();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function renameChat(id, title, auto = false) {
  const c = S.chats.find((x) => x.id === id);
  if (!c) return;
  c.title = title.slice(0, 80);
  if (!auto) c.titleAuto = false;
  persist('saveChat', c);
  renderSidebar(); renderCrumbs();
}

function moveChat(id, projectId) {
  const c = S.chats.find((x) => x.id === id);
  if (!c) return;
  c.projectId = projectId;
  if (projectId) { S.expanded.add(projectId); lsSet('aura:expanded', [...S.expanded]); }
  persist('saveChat', c);
  renderSidebar(); renderCrumbs();
  toast(projectId ? `Moved to "${projectById(projectId)?.name}"` : 'Removed from project');
}

async function deleteChat(id) {
  const c = S.chats.find((x) => x.id === id);
  if (!c) return;
  const ok = await modal({ title: 'Delete chat?', text: `"${c.title}" will be permanently deleted.` + (c.shareId ? ' Its shared link will stop working.' : ''), confirm: 'Delete', danger: true });
  if (!ok) return;
  if (c.shareId) persist('deleteShare', c.shareId);
  S.chats = S.chats.filter((x) => x.id !== id);
  persist('deleteChat', id);
  if (S.currentId === id) newChat(null); else renderSidebar();
}

async function createProject(moveChatId = null) {
  const v = await modal({
    title: 'New project',
    text: 'Projects keep related chats together, with their own instructions.',
    confirm: 'Create project',
    fields: [
      { name: 'name', label: 'Project name', placeholder: 'e.g. Trip to Japan', required: true },
      { name: 'instructions', label: 'Instructions (optional)', textarea: true, placeholder: 'e.g. Answer as a friendly maths tutor for a 12-year-old. Keep answers short.', help: 'AURA follows these in every chat in this project.' },
    ],
  });
  if (!v) return;
  const p = { id: uid(), name: v.name.slice(0, 80), instructions: v.instructions || '', createdAt: Date.now() };
  S.projects.push(p);
  S.expanded.add(p.id); lsSet('aura:expanded', [...S.expanded]);
  await persist('saveProject', p);
  if (moveChatId) moveChat(moveChatId, p.id);
  else newChat(p.id);
}

async function editProject(id) {
  const p = projectById(id);
  if (!p) return;
  const v = await modal({
    title: 'Project settings',
    fields: [
      { name: 'name', label: 'Project name', value: p.name, required: true },
      { name: 'instructions', label: 'Instructions', value: p.instructions, textarea: true, help: 'AURA follows these in every chat in this project.' },
    ],
  });
  if (!v) return;
  p.name = v.name.slice(0, 80); p.instructions = v.instructions || '';
  persist('saveProject', p);
  renderSidebar(); renderChat();
}

async function deleteProject(id) {
  const p = projectById(id);
  if (!p) return;
  const inside = S.chats.filter((c) => c.projectId === id);
  const ok = await modal({
    title: 'Delete project?',
    text: `"${p.name}" will be deleted.` + (inside.length ? ` Its ${inside.length} chat${inside.length > 1 ? 's' : ''} will move to your main chat list.` : ''),
    confirm: 'Delete project', danger: true,
  });
  if (!ok) return;
  for (const c of inside) { c.projectId = null; persist('saveChat', c); }
  S.projects = S.projects.filter((x) => x.id !== id);
  persist('deleteProject', id);
  if (S.draftProjectId === id) S.draftProjectId = null;
  renderSidebar(); renderChat();
}

// ================= SHARING =================
function shareSnapshot(c) {
  return {
    ownerUid: S.user.uid,
    title: c.title || 'Shared chat',
    updatedAt: Date.now(),
    messages: c.messages.map((m) => ({
      role: m.role,
      content: m.content || '',
      files: (m.files || []).map((f) => ({ name: f.name, kind: f.kind, ...(f.thumb ? { thumb: f.thumb } : {}) })),
      ...(m.sources ? { sources: m.sources } : {}),
    })),
  };
}

async function shareChat(id) {
  const c = S.chats.find((x) => x.id === id);
  if (!c || !c.messages.length) return toast('Send a message first, then share the chat.');
  if (!USE_FIREBASE) return toast('Sharing needs Firebase. It isn\'t available in demo mode.');
  const data = shareSnapshot(c);
  if (JSON.stringify(data).length > 900000) return toast('This chat is too long to share.');
  const shareId = c.shareId || uid().replace(/-/g, '').slice(0, 20);
  if (!c.shareId) data.createdAt = Date.now();
  const ok = await persist('saveShare', shareId, data);
  if (!ok) return;
  if (!c.shareId) { c.shareId = shareId; persist('saveChat', c); renderSidebar(); }
  const link = `${location.origin}${location.pathname}?s=${shareId}`;
  const input = h('input', { readonly: true, value: link, onfocus: (e) => e.target.select() });
  let close;
  const node = h('div', { class: 'modal' },
    h('h3', { text: 'Share this chat' }),
    h('p', { text: 'Anyone with this link can read this chat. It shows the chat as it is now; open Share again after new messages to update it.' }),
    h('div', { class: 'share-link' }, input,
      h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        try { await navigator.clipboard.writeText(link); e.target.textContent = 'Copied'; } catch { input.select(); toast('Press Cmd+C to copy'); }
      } }, 'Copy link')),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
        close();
        await persist('deleteShare', c.shareId);
        delete c.shareId; persist('saveChat', c); renderSidebar();
        toast('Link deleted. It no longer works.');
      } }, 'Stop sharing'),
      navigator.share ? h('button', { class: 'btn ghost', type: 'button', onclick: () => navigator.share({ title: c.title, url: link }).catch(() => {}) }, 'Send…') : null,
      h('button', { class: 'btn primary', type: 'button', onclick: () => close() }, 'Done')),
  );
  close = openDialog(node);
}

async function showSharedChat(shareId) {
  show('loading');
  try {
    await initFirebase();
    const snap = await fb.F.getDoc(fb.F.doc(fb.db, 'shares', shareId));
    if (!snap.exists()) throw new Error('missing');
    const d = snap.data();
    document.title = (d.title || 'Shared chat') + ' · AURA AI';
    $('#share-title').textContent = d.title || 'Shared chat';
    $('#share-sub').textContent = 'Shared from AURA AI' + (d.updatedAt ? ' · ' + new Date(d.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
    const log = $('#share-log');
    log.replaceChildren();
    for (const m of d.messages || []) log.append(messageEl(m, -1, null, { readOnly: true }));
  } catch (e) {
    console.error(e);
    $('#share-title').textContent = 'This chat isn\'t available';
    $('#share-sub').textContent = 'The link may be wrong, or the owner stopped sharing it.';
  }
  show('share');
}

// ================= SETTINGS =================
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
async function doInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
}

function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup' });
  const render = (v) => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  for (const [v, label] of options) {
    wrap.append(h('button', { type: 'button', 'data-v': v, role: 'radio', onclick: () => { render(v); onChange(v); } }, label));
  }
  render(value);
  return wrap;
}

function openSettings() {
  const draft = { ...S.settings };
  const original = S.settings.theme;
  const about = h('textarea', { maxlength: 1500, placeholder: 'e.g. I\'m Kumar, I work in tech governance in Abu Dhabi. I like short, structured answers.' });
  about.value = draft.about || '';
  const auto = h('input', { type: 'checkbox' });
  auto.checked = !!draft.autoSpeak;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  let close;
  const node = h('div', { class: 'modal wide' },
    h('h3', { text: 'Settings' }),
    h('div', { class: 'set-group' },
      h('div', { class: 'set-label', text: 'Appearance' }),
      seg([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], draft.theme, (v) => { draft.theme = v; applyTheme(v); })),
    h('div', { class: 'set-group' },
      h('div', { class: 'set-label', text: 'Model' }),
      h('p', { class: 'set-help', text: 'Smart gives better answers. Fast replies quicker and has more free capacity.' }),
      seg([['smart', 'Smart'], ['fast', 'Fast']], draft.model, (v) => { draft.model = v; })),
    h('div', { class: 'set-group' },
      h('div', { class: 'set-label', text: 'About you' }),
      h('p', { class: 'set-help', text: 'AURA keeps this in mind in every chat. Don\'t include anything sensitive.' }),
      h('label', { class: 'field', style: 'margin:0' }, about)),
    h('div', { class: 'set-group' },
      h('div', { class: 'switch-row' },
        h('div', {}, h('div', { class: 'set-label', text: 'Read answers aloud' }), h('p', { class: 'set-help', style: 'margin:0', text: 'Speak each new answer automatically.' })),
        h('label', { class: 'switch' }, auto, h('span')))),
    standalone ? null : h('div', { class: 'set-group' },
      h('div', { class: 'set-label', text: 'Install AURA on your phone or computer' }),
      installPrompt
        ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { doInstall(); close(); } }, svg(ICON.install), 'Install app')
        : h('p', { class: 'set-help', style: 'margin:0', text: isIOS
          ? 'On iPhone or iPad: tap the Share button in Safari, then "Add to Home Screen".'
          : 'In Chrome or Edge: use the install icon in the address bar. In Safari on Mac: File → Add to Dock. On iPhone: Share → Add to Home Screen.' })),
    h('div', { class: 'set-group' },
      h('div', { class: 'set-label', text: 'Your data' }),
      h('p', { class: 'set-help', text: 'Permanently delete all your chats, projects, shared links and settings.' }),
      h('button', { class: 'btn ghost', type: 'button', style: 'color:var(--danger)', onclick: () => { close(true); deleteAllData(); } }, 'Delete all my data')),
    h('div', { class: 'set-group set-links' }, h('a', { href: 'privacy.html', target: '_blank' }, 'Privacy Policy'), ' · ', h('a', { href: 'terms.html', target: '_blank' }, 'Terms of Use')),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => close(true) }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => {
        draft.about = about.value.trim();
        draft.autoSpeak = auto.checked;
        S.settings = { ...S.settings, ...draft };
        const { search, ...toSave } = S.settings;
        persist('saveSettings', toSave);
        close();
        toast('Settings saved');
      } }, 'Save')),
  );
  close = openDialog(node, () => applyTheme(original));
}

async function deleteAllData() {
  const ok = await modal({ title: 'Delete all your data?', text: 'All chats, projects, shared links and settings will be permanently deleted. This can\'t be undone.', confirm: 'Delete everything', danger: true });
  if (!ok) return;
  toast('Deleting…', 10000);
  try {
    const jobs = [];
    for (const c of S.chats) { if (c.shareId) jobs.push(S.store.deleteShare(c.shareId)); jobs.push(S.store.deleteChat(c.id)); }
    for (const p of S.projects) jobs.push(S.store.deleteProject(p.id));
    jobs.push(S.store.deleteSettings());
    await Promise.all(jobs);
    S.chats = []; S.projects = []; S.settings = { ...DEFAULT_SETTINGS }; fileCache.clear();
    applyTheme('system');
    newChat(null);
    toast('All your data was deleted.');
  } catch (e) {
    console.error(e);
    toast('Some items could not be deleted. Please try again.');
  }
}

// ================= ATTACHMENTS =================
const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|xml|log|yaml|yml)$/i;

function fileToDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function fileToText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
}
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function drawScaled(img, max, quality) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale)), hgt = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(img, 0, 0, w, hgt);
  return c.toDataURL('image/jpeg', quality);
}

async function addFiles(list) {
  for (const file of Array.from(list || [])) {
    if (S.pending.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files per message.`); break; }
    try {
      if (file.type.startsWith('image/')) {
        const img = await loadImage(file);
        const full = drawScaled(img, 1600, 0.85);
        S.pending.push({ id: uid(), name: file.name || 'image.jpg', kind: 'image', mimeType: 'image/jpeg', data: full.split(',')[1], thumb: drawScaled(img, 240, 0.7) });
      } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        if (file.size > MAX_PDF_BYTES) { toast(`"${file.name}" is too large. PDFs can be up to 2.5 MB.`); continue; }
        const url = await fileToDataURL(file);
        S.pending.push({ id: uid(), name: file.name, kind: 'pdf', mimeType: 'application/pdf', data: url.split(',')[1] });
      } else if (file.type.startsWith('text/') || TEXT_EXT.test(file.name) || file.type === 'application/json') {
        let text = await fileToText(file);
        if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); toast(`"${file.name}" is long, so only the first part was attached.`); }
        S.pending.push({ id: uid(), name: file.name, kind: 'text', text });
      } else {
        toast(`"${file.name}" isn't supported. Use images, PDFs or text files.`);
      }
    } catch (e) {
      console.error(e);
      toast(`Couldn't read "${file.name}".`);
    }
  }
  renderChips();
  updateComposer();
}

function fileChip(f, onRemove) {
  const icon = f.kind === 'image' && f.thumb ? h('img', { src: f.thumb, alt: '' })
    : h('span', { class: 'fic' + (f.kind === 'text' ? ' txt' : ''), text: f.kind === 'pdf' ? 'PDF' : 'TXT' });
  return h('div', { class: 'chip', title: f.name }, icon, h('span', { class: 'cname', text: f.name }),
    onRemove ? h('button', { class: 'x', type: 'button', 'aria-label': 'Remove ' + f.name, onclick: onRemove }, '×') : null);
}

function renderChips() {
  $('#chips').replaceChildren(...S.pending.map((f) => fileChip(f, () => { S.pending = S.pending.filter((x) => x !== f); renderChips(); updateComposer(); })));
}

// ================= CHAT VIEW =================
function renderCrumbs() {
  const c = currentChat();
  const pid = c ? c.projectId : S.draftProjectId;
  const p = pid ? projectById(pid) : null;
  const el = $('#crumbs');
  el.replaceChildren();
  if (p) el.append(h('span', { class: 'proj', text: p.name }), h('span', { class: 'sep', text: '/' }));
  el.append(h('span', { class: 'title', text: c ? c.title : 'New chat' }));
  $('#btn-share').hidden = !(c && c.messages.length);
}

const STARTERS = [
  ['Explain a topic', 'like I\'m 10 years old', 'Explain how rainbows form, like I\'m 10 years old.'],
  ['Plan something', 'a weekend with the family', 'Plan a fun, low-cost weekend for a family of four.'],
  ['Write for me', 'a polite email', 'Write a short, polite email asking my manager for a day off next Friday.'],
  ['What\'s new', 'search the web', '__search__What are the biggest technology news stories this week?'],
];

function toolBtn(label, onclick) { return h('button', { type: 'button', onclick }, label); }

function messageEl(m, idx, chat, opts = {}) {
  const { streaming = false, readOnly = false, isLast = false } = opts;
  if (m.role === 'user') {
    const wrap = h('div', { class: 'msg user', 'data-idx': idx });
    if (m.files?.length) {
      wrap.append(h('div', { class: 'msg-files' }, m.files.map((f) =>
        f.kind === 'image' && f.thumb ? h('img', { class: 'big', src: f.thumb, alt: f.name, title: f.name }) : fileChip(f))));
    }
    if (m.content) wrap.append(h('div', { class: 'bubble', text: m.content }));
    if (!readOnly && !S.streaming) {
      wrap.append(h('div', { class: 'tools' },
        toolBtn('Copy', (e) => copyText(m.content, e.target)),
        toolBtn('Edit', () => startEdit(chat, idx))));
    }
    return wrap;
  }
  const bubble = h('div', { class: 'bubble' });
  if (streaming && !m.content) bubble.append(h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
  else { bubble.innerHTML = renderMarkdown(m.content); if (!streaming) enhanceBubble(bubble); }
  const wrap = h('div', { class: 'msg assistant' + (m.error ? ' error' : ''), id: streaming ? 'streaming' : null, 'data-idx': idx }, bubble);
  if (m.sources?.length && !streaming) {
    wrap.append(h('div', { class: 'sources' }, m.sources.map((s, i) =>
      h('a', { class: 'src', href: s.uri, target: '_blank', rel: 'noopener noreferrer', title: s.title }, h('b', { text: String(i + 1) }), h('span', { text: s.title })))));
  }
  if (!streaming && !m.error) {
    const meta = [];
    if (m.via === 'local') meta.push(m.note || 'Answered on-device (smaller model)');
    if (m.stopped) meta.push('Stopped');
    if (meta.length) wrap.append(h('div', { class: 'msg-meta', text: meta.join(' · ') }));
    if (!readOnly) {
      wrap.append(h('div', { class: 'tools' },
        toolBtn('Copy', (e) => copyText(m.content, e.target)),
        'speechSynthesis' in window ? toolBtn(S.speakingIdx === idx && S.currentId === chat?.id ? 'Stop' : 'Listen', () => toggleSpeak(m.content, idx)) : null,
        isLast && !S.streaming ? toolBtn('Regenerate', () => regenerate(chat)) : null));
    }
  }
  return wrap;
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = t), 1400); }
  catch { toast('Copy failed'); }
}

function renderChat() {
  renderCrumbs();
  const log = $('#chat-log');
  log.replaceChildren();
  const c = currentChat();
  if (!c || !c.messages.length) {
    const p = S.draftProjectId ? projectById(S.draftProjectId) : null;
    const first = (S.user?.name || '').split(' ')[0];
    log.append(h('div', { class: 'empty-state' },
      h('div', { class: 'orb' }),
      h('h2', { text: p ? `New chat in ${p.name}` : (first ? `What's on your mind, ${first}?` : 'What\'s on your mind?') }),
      h('p', { text: p && p.instructions ? 'This project has custom instructions. AURA will follow them.' : 'Ask anything, attach a photo or PDF, or turn on Search for the latest news.' }),
      h('div', { class: 'starters' }, STARTERS.map(([t, s, prompt]) =>
        h('button', { class: 'starter', type: 'button', onclick: () => {
          if (prompt.startsWith('__search__')) { S.settings.search = true; lsSet('aura:search', true); renderSearchToggle(); send(prompt.slice(10)); }
          else send(prompt);
        } }, h('b', { text: t }), h('span', { text: s })))),
    ));
  } else {
    const lastAssistant = c.messages.length - 1;
    c.messages.forEach((m, i) => log.append(messageEl(m, i, c, { isLast: i === lastAssistant && m.role === 'assistant' })));
    if (S.streaming && S.streaming.chatId === c.id) log.append(messageEl({ role: 'assistant', content: S.streaming.text }, -1, c, { streaming: true }));
  }
  updateComposer();
  scrollDown(true);
}

function startEdit(chat, idx) {
  if (!chat || S.streaming) return;
  const m = chat.messages[idx];
  const el = document.querySelector(`#chat-log .msg.user[data-idx="${idx}"]`);
  if (!el) return;
  const ta = h('textarea', {});
  ta.value = m.content;
  const box = h('div', { class: 'edit-box' }, ta, h('div', { class: 'row-btns' },
    h('button', { class: 'btn ghost', type: 'button', onclick: () => renderChat() }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => {
      const text = ta.value.trim();
      if (!text && !m.files?.length) return;
      chat.messages = chat.messages.slice(0, idx);
      chat.messages.push({ ...m, content: text });
      chat.updatedAt = Date.now();
      persist('saveChat', chat);
      runAssistant(chat);
    } }, 'Save & send')));
  el.replaceWith(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') renderChat(); });
}

function regenerate(chat) {
  if (!chat || S.streaming) return;
  if (chat.messages[chat.messages.length - 1]?.role === 'assistant') chat.messages.pop();
  runAssistant(chat);
}

function scrollDown(force = false) {
  const sc = $('#chat-scroll');
  const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
  if (force || near) sc.scrollTop = sc.scrollHeight;
}

function updateStreaming(text) {
  if (!S.streaming) return;
  S.streaming.text = text;
  if (S.currentId !== S.streaming.chatId) return;
  const el = $('#streaming .bubble');
  if (el) { el.innerHTML = renderMarkdown(text); scrollDown(); }
}

function notice(text) {
  const n = h('div', { class: 'notice', text });
  $('#chat-log').append(n);
  scrollDown(true);
  return n;
}

function setMode(mode) {
  const el = $('#mode');
  el.className = 'mode' + (mode === 'local' ? ' local' : '');
  el.textContent = mode === 'local' ? 'On-device' : 'Cloud';
  el.title = mode === 'local' ? 'The cloud was unavailable, so this answer came from a smaller model on your device' : 'Answers come from the cloud (Google Gemini)';
}

function updateComposer() {
  const busy = !!S.streaming;
  const btn = $('#btn-send');
  const hasContent = !!$('#in-msg').value.trim() || S.pending.length > 0;
  btn.classList.toggle('stop', busy);
  btn.disabled = !busy && !hasContent;
  btn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  btn.title = busy ? 'Stop generating' : 'Send';
  btn.innerHTML = busy
    ? '<svg width="14" height="14" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
}

function renderSearchToggle() {
  const b = $('#btn-search');
  b.classList.toggle('on', !!S.settings.search);
  b.setAttribute('aria-pressed', String(!!S.settings.search));
}

// ================= VOICE =================
function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (S.speakingIdx !== null) { S.speakingIdx = null; if (S.view === 'app') renderChat(); }
}
function toggleSpeak(text, idx) {
  if (!('speechSynthesis' in window)) return;
  if (S.speakingIdx === idx) return stopSpeaking();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plainText(text));
  u.lang = navigator.language || 'en-US';
  u.onend = u.onerror = () => { if (S.speakingIdx === idx) { S.speakingIdx = null; renderChat(); } };
  S.speakingIdx = idx;
  speechSynthesis.speak(u);
  renderChat();
}

let recognition = null;
function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#btn-mic');
  if (!SR) return;
  btn.hidden = false;
  btn.addEventListener('click', () => {
    if (recognition) { recognition.stop(); return; }
    const input = $('#in-msg');
    const base = input.value ? input.value.replace(/\s*$/, ' ') : '';
    recognition = new SR();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (e) => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      input.value = base + t;
      autosize();
    };
    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone access was blocked. Allow it in your browser settings.');
      else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Voice input stopped: ' + e.error);
    };
    recognition.onend = () => { recognition = null; btn.classList.remove('recording'); input.focus(); };
    try { recognition.start(); btn.classList.add('recording'); }
    catch { recognition = null; }
  });
}

// ================= MODEL CALLS =================
async function askCloud(payload, onText, signal) {
  const headers = { 'content-type': 'application/json' };
  if (USE_FIREBASE && fb.auth.currentUser) headers.authorization = 'Bearer ' + (await fb.auth.currentUser.getIdToken());
  let res;
  try {
    res = await fetch('/api/chat', { method: 'POST', headers, body: JSON.stringify(payload), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const e = new Error('network'); e.fallback = true; e.reason = 'no connection to the cloud'; throw e;
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  if (!res.ok || isJson) {
    const info = isJson ? await res.json().catch(() => ({})) : {};
    const e = new Error(info.error || (res.status === 413 ? 'that file is too large' : 'cloud_failed'));
    e.fallback = info.fallback !== false && res.status !== 413;
    e.reason = info.error === 'quota_exceeded' || info.error === 'rate_limited' ? 'the free cloud limit was reached'
      : info.error === 'google_busy' ? "Google's servers were busy" : 'the cloud was unavailable';
    throw e;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let raw = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      const cut = raw.indexOf('\u0000');
      onText(cut >= 0 ? raw.slice(0, cut) : raw);
    }
  } catch (err) {
    if (err.name === 'AbortError') { const cut = raw.indexOf('\u0000'); err.partial = cut >= 0 ? raw.slice(0, cut) : raw; }
    throw err;
  }
  const cut = raw.indexOf('\u0000');
  const text = cut >= 0 ? raw.slice(0, cut) : raw;
  let meta = {};
  if (cut >= 0) { try { meta = JSON.parse(raw.slice(cut + 1)); } catch { /* ignore */ } }
  if (!text.trim()) { const e = new Error('empty'); e.fallback = true; e.reason = 'the cloud returned an empty answer'; throw e; }
  return { text, meta };
}

let engine = null, enginePromise = null;
async function getEngine() {
  if (engine) return engine;
  if (enginePromise) return enginePromise;
  if (!('gpu' in navigator)) throw new Error("the cloud is unavailable and this browser can't run the on-device model (needs a recent Chrome or Edge). Please try again in a minute");
  const n = notice('Downloading the on-device model (one-time, about 0.9 GB)…');
  const bar = $('#progress-bar');
  enginePromise = (async () => {
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    const e = await webllm.CreateMLCEngine(LOCAL_MODEL, {
      initProgressCallback: (p) => { bar.style.width = Math.round((p.progress || 0) * 100) + '%'; n.textContent = 'Preparing on-device model: ' + (p.text || ''); },
    });
    bar.style.width = '0';
    n.remove();
    engine = e;
    return e;
  })();
  try { return await enginePromise; }
  catch (err) { enginePromise = null; bar.style.width = '0'; n.remove(); throw err; }
}

async function askLocal(history, system, onText, signal) {
  const e = await getEngine();
  const onAbort = () => { try { e.interruptGenerate(); } catch { /* ignore */ } };
  signal.addEventListener('abort', onAbort);
  try {
    const stream = await e.chat.completions.create({
      messages: [{ role: 'system', content: system }, ...history.slice(-12)],
      stream: true, max_tokens: 768, temperature: 0.7,
    });
    let out = '';
    for await (const chunk of stream) { out += chunk.choices?.[0]?.delta?.content || ''; onText(out); }
    return out;
  } finally { signal.removeEventListener('abort', onAbort); }
}

function makeTitle(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 42 ? t.slice(0, 40).replace(/\s+\S*$/, '') + '…' : (t || 'New chat');
}

// Text sent to the AI for a message: its text plus any attached text files.
function contentForModel(m) {
  let text = m.content || '';
  for (const f of m.files || []) {
    if (f.kind === 'text' && f.text) text += `\n\n[Attached file: ${f.name}]\n\`\`\`\n${f.text}\n\`\`\``;
    else if ((f.kind === 'image' || f.kind === 'pdf') && !fileCache.has(f.id)) text += `\n\n[The user attached "${f.name}" earlier; it is no longer available.]`;
  }
  return text;
}

function buildCloudHistory(c) {
  const n = c.messages.length;
  return c.messages.map((m, i) => {
    const out = { role: m.role, content: contentForModel(m) };
    if (m.role === 'user' && i >= n - FILE_HISTORY) {
      const files = (m.files || []).filter((f) => fileCache.has(f.id)).map((f) => fileCache.get(f.id));
      if (files.length) out.files = files;
    }
    return out;
  });
}

async function send(text) {
  text = (text || '').trim();
  if ((!text && !S.pending.length) || S.streaming) return;
  stopSpeaking();
  if (recognition) recognition.stop();
  let c = currentChat();
  const now = Date.now();
  const files = S.pending.map((f) => {
    if (f.data) fileCache.set(f.id, { mimeType: f.mimeType, data: f.data });
    return { id: f.id, name: f.name, kind: f.kind, ...(f.thumb ? { thumb: f.thumb } : {}), ...(f.text ? { text: f.text } : {}) };
  });
  if (!c) {
    c = { id: uid(), title: makeTitle(text || files[0]?.name || 'New chat'), titleAuto: true, projectId: S.draftProjectId || null, createdAt: now, updatedAt: now, messages: [] };
    S.chats.push(c);
    S.currentId = c.id;
    setHash(c.id);
  }
  c.messages.push({ role: 'user', content: text, ...(files.length ? { files } : {}) });
  c.updatedAt = now;
  S.pending = [];
  renderChips();
  $('#in-msg').value = ''; autosize();
  persist('saveChat', c);
  runAssistant(c);
}

async function runAssistant(c) {
  S.streaming = { chatId: c.id, text: '' };
  S.abort = new AbortController();
  const signal = S.abort.signal;
  renderSidebar(); renderChat();

  const project = c.projectId ? projectById(c.projectId) : null;
  const instructions = project?.instructions || '';
  let reply = null;
  try {
    // 1) Always try the cloud first.
    try {
      setMode('cloud');
      const { text, meta } = await askCloud({
        messages: buildCloudHistory(c),
        instructions,
        about: S.settings.about || '',
        model: S.settings.model,
        search: !!S.settings.search,
      }, updateStreaming, signal);
      reply = { role: 'assistant', content: text, via: 'cloud' };
      if (meta.sources?.length) reply.sources = meta.sources;
      if (meta.searchUnavailable) toast('Web search wasn\'t available for this answer.');
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (!err.fallback) throw err;
      // 2) Fall back to the on-device model for this message only.
      updateStreaming('');
      setMode('local');
      const hadFiles = c.messages[c.messages.length - 1].files?.some((f) => f.kind !== 'text');
      const note = `Answered on-device because ${err.reason || 'the cloud was unavailable'}`
        + (hadFiles ? ". The on-device model can't see images or PDFs" : '')
        + '. Press Regenerate to try the cloud again.';
      const system = BASE_PROMPT
        + (S.settings.about ? '\n\nAbout the user:\n' + S.settings.about : '')
        + (instructions ? '\n\nFollow these project instructions from the user:\n' + instructions : '');
      const history = c.messages.map((m) => ({ role: m.role, content: contentForModel(m) }));
      const text = await askLocal(history, system, updateStreaming, signal);
      reply = { role: 'assistant', content: text, via: 'local', note };
      if (signal.aborted) { if (text.trim()) reply.stopped = true; else reply = null; }
    }
  } catch (err) {
    if (err.name === 'AbortError' || signal.aborted) {
      const partial = (err.partial ?? S.streaming?.text ?? '').trim();
      if (partial) reply = { role: 'assistant', content: partial, via: 'cloud', stopped: true };
    } else {
      console.error(err);
      S.streaming = null; S.abort = null;
      renderChat();
      $('#chat-log').append(messageEl({ role: 'assistant', content: 'Sorry, ' + (err.message || 'something went wrong') + '.', error: true }, -1, c));
      scrollDown(true);
      updateComposer();
      return;
    }
  }
  S.streaming = null; S.abort = null;
  if (reply) {
    c.messages.push(reply);
    c.updatedAt = Date.now();
    persist('saveChat', c);
  }
  renderSidebar();
  if (S.currentId === c.id) renderChat();
  updateComposer();
  if (reply && !reply.stopped && S.settings.autoSpeak && S.currentId === c.id) toggleSpeak(reply.content, c.messages.length - 1);
  if (reply && reply.via === 'cloud' && c.titleAuto !== false && c.messages.length <= 3) autoTitle(c);
  if (reply && c.shareId) { const ok = await S.store.saveShare(c.shareId, shareSnapshot(c)).then(() => true).catch(() => false); if (!ok) console.warn('share refresh failed'); }
}

async function autoTitle(c) {
  try {
    const headers = { 'content-type': 'application/json' };
    if (USE_FIREBASE && fb.auth.currentUser) headers.authorization = 'Bearer ' + (await fb.auth.currentUser.getIdToken());
    const res = await fetch('/api/chat', { method: 'POST', headers, body: JSON.stringify({
      mode: 'title', messages: c.messages.slice(0, 2).map((m) => ({ role: m.role, content: (m.content || '').slice(0, 1500) || '(attachment)' })),
    }) });
    if (!res.ok) return;
    const { title } = await res.json();
    if (title && c.titleAuto !== false) { renameChat(c.id, title, true); }
  } catch { /* keep the simple title */ }
}

// ================= WIRING =================
function autosize() { const t = $('#in-msg'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; updateComposer(); }

function wireApp() {
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (S.streaming) { S.abort?.abort(); return; }
    send($('#in-msg').value);
  });
  $('#in-msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!S.streaming) send($('#in-msg').value); }
  });
  $('#in-msg').addEventListener('input', autosize);
  $('#in-msg').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#btn-search').addEventListener('click', () => {
    S.settings.search = !S.settings.search;
    lsSet('aura:search', S.settings.search);
    renderSearchToggle();
    toast(S.settings.search ? 'Web search on: AURA will look up current information.' : 'Web search off');
  });
  $('#btn-share').addEventListener('click', () => S.currentId && shareChat(S.currentId));
  $('#btn-new-chat').addEventListener('click', () => newChat(null));
  $('#btn-new-project').addEventListener('click', () => createProject());
  $('#in-search').addEventListener('input', (e) => { S.search = e.target.value.trim(); renderSidebar(); });
  $('#btn-collapse').addEventListener('click', () => $('#view-app').classList.add('side-closed'));
  $('#btn-open-side').addEventListener('click', () => $('#view-app').classList.remove('side-closed'));
  $('#scrim').addEventListener('click', () => $('#view-app').classList.add('side-closed'));
  $('#side-brand').addEventListener('click', (e) => { e.preventDefault(); newChat(null); });
  $('#side-scroll').addEventListener('scroll', closeMenu);

  // Drag & drop files anywhere on the chat
  let dragDepth = 0;
  const main = $('#main');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  main.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
  main.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  main.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
  main.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; addFiles(e.dataTransfer.files); });

  setupMic();
}

async function boot() {
  applyTheme(lsGet('aura:theme', 'system'));
  $('#year').textContent = new Date().getFullYear();
  wireAuth();
  wireApp();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  const params = new URLSearchParams(location.search);

  if (params.get('s')) {
    if (!USE_FIREBASE) { show('home'); toast('Shared chats need Firebase.'); return; }
    return showSharedChat(params.get('s'));
  }

  if (params.has('home')) {
    document.querySelectorAll('#view-home a[href^="#"]').forEach((a) => a.setAttribute('href', location.pathname));
    show('home');
    return;
  }

  if (USE_FIREBASE) {
    try { await initFirebase(); }
    catch (e) { console.error(e); show('home'); toast('Could not load sign-in. Check your connection and refresh.', 6000); return; }
    fb.A.onAuthStateChanged(fb.auth, (u) => {
      if (u) {
        if (S.user && S.user.uid === u.uid) return;
        enterApp({ uid: u.uid, name: u.displayName || (u.email || '').split('@')[0], email: u.email, photo: u.photoURL });
      } else if (S.user) leaveApp();
      else route();
    });
  } else {
    const g = lsGet('aura:demo-user');
    if (g) enterApp(g); else route();
  }
}

boot();
