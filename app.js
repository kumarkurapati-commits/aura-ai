// ================= AURA AI — app =================
import { firebaseConfig } from './firebase-config.js';

// ---- Settings ----
const LOCAL_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC'; // on-device fallback (~0.9 GB, one-time download)
const BASE_PROMPT = 'You are AURA AI, a helpful, friendly and concise assistant.';
const CLOUD_RETRY_MS = 5 * 60 * 1000;
const FB_VERSION = '11.0.2';
const USE_FIREBASE = !!(firebaseConfig && firebaseConfig.apiKey);

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
    return window.DOMPurify.sanitize(html);
  }
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML.replace(/\n/g, '<br>');
}

// ================= STATE =================
const S = {
  user: null,
  store: null,
  projects: [],
  chats: [],
  currentId: null,        // open chat id (null = new, unsaved chat)
  draftProjectId: null,   // project for the new unsaved chat
  expanded: new Set(lsGet('aura:expanded', [])),
  search: '',
  streaming: null,        // { chatId, text }
  localUntil: 0,
  authMode: 'signin',
};
const currentChat = () => S.chats.find((c) => c.id === S.currentId) || null;
const projectById = (id) => S.projects.find((p) => p.id === id) || null;

// ================= FIREBASE =================
let fb = null;
async function initFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
  const [appM, A, F] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js'),
  ]);
  const app = appM.initializeApp(firebaseConfig);
  fb = { auth: A.getAuth(app), db: F.getFirestore(app), A, F };
}

function clean(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj)) if (k !== 'id' && v !== undefined) o[k] = v;
  return o;
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
  };
}

function localStore(userId) {
  const kp = `aura:${userId}:projects`, kc = `aura:${userId}:chats`;
  const upsert = (key, item) => { const a = lsGet(key, []); const i = a.findIndex((x) => x.id === item.id); if (i >= 0) a[i] = item; else a.push(item); lsSet(key, a); };
  const remove = (key, id) => lsSet(key, lsGet(key, []).filter((x) => x.id !== id));
  return {
    listProjects: async () => lsGet(kp, []),
    listChats: async () => lsGet(kc, []),
    saveProject: async (p) => upsert(kp, p),
    deleteProject: async (id) => remove(kp, id),
    saveChat: async (c) => upsert(kc, c),
    deleteChat: async (id) => remove(kc, id),
  };
}

async function persist(fn, ...args) {
  try { await S.store[fn](...args); }
  catch (e) { console.error(e); toast("Couldn't save. Check your connection and try again."); }
}

// ================= VIEWS / ROUTING =================
function show(view) {
  for (const v of ['loading', 'home', 'auth', 'app']) $('#view-' + v).hidden = v !== view;
  document.title = view === 'app' ? 'AURA AI' : view === 'auth' ? (S.authMode === 'signup' ? 'Sign up · AURA AI' : 'Log in · AURA AI') : 'AURA AI · Free AI assistant';
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
  if (USE_FIREBASE) await fb.A.signOut(fb.auth);
  else { lsDel('aura:demo-user'); leaveApp(); }
}

async function enterApp(user) {
  S.user = user;
  S.store = USE_FIREBASE ? firebaseStore(user.uid) : localStore(user.uid);
  show('loading');
  try {
    const [projects, chats] = await Promise.all([S.store.listProjects(), S.store.listChats()]);
    S.projects = projects; S.chats = chats.map((c) => ({ ...c, messages: c.messages || [] }));
  } catch (e) {
    console.error(e);
    S.projects = []; S.chats = [];
    toast("Couldn't load your chats. Check that Firestore is set up.", 6000);
  }
  S.view = 'app';
  show('app');
  if (window.innerWidth <= 760) $('#view-app').classList.add('side-closed');
  renderUser();
  const m = location.hash.match(/^#c\/(.+)$/);
  if (m && S.chats.some((c) => c.id === m[1])) openChat(m[1], false);
  else newChat(null);
}

function leaveApp() {
  S.user = null; S.store = null; S.projects = []; S.chats = []; S.currentId = null; S.view = null;
  history.replaceState(null, '', '#');
  show('home');
}

// ================= SIDEBAR =================
function sortByRecent(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }
function matches(c) {
  if (!S.search) return true;
  const q = S.search.toLowerCase();
  return (c.title || '').toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q));
}

function chatRow(c, sub = false) {
  const row = h('div', {
    class: 'row' + (sub ? ' sub' : '') + (c.id === S.currentId ? ' active' : ''),
    role: 'button', tabindex: '0', 'data-chat': c.id, title: c.title,
    onclick: (e) => { if (e.target.closest('.more') || e.target.closest('input')) return; openChat(c.id); },
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openChat(c.id); },
    ondblclick: (e) => { e.preventDefault(); startRename(c.id); },
  },
    h('span', { class: 'label', text: c.title || 'New chat' }),
    h('button', { class: 'more', 'aria-label': 'Chat options', onclick: (e) => { e.stopPropagation(); chatMenu(c, e.currentTarget); } }, svg(ICON.dots)),
  );
  return row;
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

  // Unfiled chats grouped by date
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
  const btn = h('button', { class: 'user-btn', onclick: (e) => userMenu(e.currentTarget) },
    avatar,
    h('span', { class: 'user-meta' },
      h('div', { class: 'user-name', text: u.name || 'You' }),
      h('div', { class: 'user-sub' }, u.demo ? h('span', { class: 'tag', text: 'Demo mode' }) : (u.email || ''))),
  );
  $('#side-user').replaceChildren(btn);
}

// ================= MENUS =================
let menuAnchorRow = null;
function openMenu(anchor, items) {
  closeMenu();
  const m = $('#menu');
  m.replaceChildren();
  for (const it of items) {
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
    { label: 'Home page', icon: ICON.home, onClick: () => window.open(location.pathname + '?home', '_blank') },
    { label: 'Log out', icon: ICON.out, onClick: signOutUser },
  ]);
}

// ================= MODAL =================
function modal({ title, text, fields = [], confirm = 'Save', danger = false }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const inputs = {};
    const form = h('form', { class: 'modal', onsubmit: (e) => {
      e.preventDefault();
      const vals = {};
      for (const f of fields) {
        vals[f.name] = inputs[f.name].value.trim();
        if (f.required && !vals[f.name]) { inputs[f.name].focus(); return; }
      }
      done(vals);
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
        h('button', { class: 'btn ghost', type: 'button', onclick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'submit' }, confirm)),
    );
    function done(v) { root.hidden = true; root.replaceChildren(); document.removeEventListener('keydown', esc); resolve(v); }
    function esc(e) { if (e.key === 'Escape') done(null); }
    root.replaceChildren(form);
    root.hidden = false;
    root.onclick = (e) => { if (e.target === root) done(null); };
    document.addEventListener('keydown', esc);
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

function renameChat(id, title) {
  const c = S.chats.find((x) => x.id === id);
  if (!c) return;
  c.title = title.slice(0, 80);
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
  const ok = await modal({ title: 'Delete chat?', text: `"${c.title}" will be permanently deleted.`, confirm: 'Delete', danger: true });
  if (!ok) return;
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

// ================= CHAT VIEW =================
function renderCrumbs() {
  const c = currentChat();
  const pid = c ? c.projectId : S.draftProjectId;
  const p = pid ? projectById(pid) : null;
  const el = $('#crumbs');
  el.replaceChildren();
  if (p) el.append(h('span', { class: 'proj', text: p.name }), h('span', { class: 'sep', text: '/' }));
  el.append(h('span', { class: 'title', text: c ? c.title : 'New chat' }));
}

const STARTERS = [
  ['Explain a topic', 'like I\'m 10 years old', 'Explain how rainbows form, like I\'m 10 years old.'],
  ['Plan something', 'a weekend with the family', 'Plan a fun, low-cost weekend for a family of four.'],
  ['Write for me', 'a polite email', 'Write a short, polite email asking my manager for a day off next Friday.'],
  ['Brainstorm', 'ideas for a science project', 'Give me 5 creative science fair project ideas for a 12-year-old.'],
];

function messageEl(m, streaming = false) {
  if (m.role === 'user') return h('div', { class: 'msg user' }, h('div', { class: 'bubble', text: m.content }));
  const bubble = h('div', { class: 'bubble' });
  if (streaming && !m.content) bubble.append(h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
  else bubble.innerHTML = renderMarkdown(m.content);
  const wrap = h('div', { class: 'msg assistant' + (m.error ? ' error' : ''), id: streaming ? 'streaming' : null }, bubble);
  if (!streaming && !m.error) {
    wrap.append(h('div', { class: 'tools' }, h('button', { type: 'button', onclick: async (e) => {
      try { await navigator.clipboard.writeText(m.content); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1400); }
      catch { toast('Copy failed'); }
    } }, 'Copy')));
  }
  return wrap;
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
      h('p', { text: p && p.instructions ? 'This project has custom instructions. AURA will follow them.' : 'Ask anything. AURA is free for everyone.' }),
      h('div', { class: 'starters' }, STARTERS.map(([t, s, prompt]) =>
        h('button', { class: 'starter', type: 'button', onclick: () => send(prompt) }, h('b', { text: t }), h('span', { text: s })))),
    ));
  } else {
    for (const m of c.messages) log.append(messageEl(m));
    if (S.streaming && S.streaming.chatId === c.id) log.append(messageEl({ role: 'assistant', content: S.streaming.text }, true));
  }
  updateComposer();
  scrollDown(true);
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
  el.title = mode === 'local' ? 'Cloud is busy, so answers come from a model running on your device' : 'Answers come from the cloud (Google Gemini)';
}

function updateComposer() {
  const busy = !!S.streaming;
  $('#btn-send').disabled = busy || !$('#in-msg').value.trim();
}

// ================= MODEL CALLS =================
async function askCloud(history, instructions, onText) {
  const headers = { 'content-type': 'application/json' };
  if (USE_FIREBASE && fb.auth.currentUser) headers.authorization = 'Bearer ' + (await fb.auth.currentUser.getIdToken());
  let res;
  try {
    res = await fetch('/api/chat', { method: 'POST', headers, body: JSON.stringify({ messages: history, instructions }) });
  } catch {
    const e = new Error('network'); e.fallback = true; throw e;
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  if (!res.ok || isJson) {
    const info = isJson ? await res.json().catch(() => ({})) : {};
    const e = new Error(info.error || 'cloud_failed');
    e.fallback = info.fallback !== false;
    throw e;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
    onText(out);
  }
  if (!out.trim()) { const e = new Error('empty'); e.fallback = true; throw e; }
  return out;
}

let engine = null, enginePromise = null;
async function getEngine() {
  if (engine) return engine;
  if (enginePromise) return enginePromise;
  if (!('gpu' in navigator)) throw new Error("the cloud is busy and this browser can't run the on-device model (needs a recent Chrome or Edge). Please try again in a few minutes");
  const n = notice('The cloud is busy right now. Downloading the on-device model (one-time, about 0.9 GB)…');
  const bar = $('#progress-bar');
  enginePromise = (async () => {
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    const e = await webllm.CreateMLCEngine(LOCAL_MODEL, {
      initProgressCallback: (p) => { bar.style.width = Math.round((p.progress || 0) * 100) + '%'; n.textContent = 'Preparing on-device model: ' + (p.text || ''); },
    });
    bar.style.width = '0';
    n.textContent = 'On-device model ready. These answers are generated privately on your device.';
    engine = e;
    return e;
  })();
  try { return await enginePromise; }
  catch (err) { enginePromise = null; bar.style.width = '0'; n.remove(); throw err; }
}

async function askLocal(history, instructions, onText) {
  const e = await getEngine();
  const system = BASE_PROMPT + (instructions ? '\n\nFollow these project instructions from the user:\n' + instructions : '');
  const stream = await e.chat.completions.create({
    messages: [{ role: 'system', content: system }, ...history.slice(-12).map(({ role, content }) => ({ role, content }))],
    stream: true, max_tokens: 768, temperature: 0.7,
  });
  let out = '';
  for await (const chunk of stream) { out += chunk.choices?.[0]?.delta?.content || ''; onText(out); }
  return out;
}

function makeTitle(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 42 ? t.slice(0, 40).replace(/\s+\S*$/, '') + '…' : t;
}

async function send(text) {
  text = (text || '').trim();
  if (!text || S.streaming) return;
  let c = currentChat();
  const now = Date.now();
  if (!c) {
    c = { id: uid(), title: makeTitle(text), projectId: S.draftProjectId || null, createdAt: now, updatedAt: now, messages: [] };
    S.chats.push(c);
    S.currentId = c.id;
    setHash(c.id);
  }
  c.messages.push({ role: 'user', content: text });
  c.updatedAt = now;
  persist('saveChat', c);

  S.streaming = { chatId: c.id, text: '' };
  $('#in-msg').value = ''; autosize();
  renderSidebar(); renderChat();

  const project = c.projectId ? projectById(c.projectId) : null;
  const instructions = project?.instructions || '';
  const history = c.messages.map(({ role, content }) => ({ role, content }));
  let reply = '';
  try {
    if (Date.now() >= S.localUntil) {
      try { setMode('cloud'); reply = await askCloud(history, instructions, updateStreaming); }
      catch (err) {
        if (!err.fallback) throw err;
        S.localUntil = Date.now() + CLOUD_RETRY_MS;
        updateStreaming('');
      }
    }
    if (!reply) { setMode('local'); reply = await askLocal(history, instructions, updateStreaming); }
    c.messages.push({ role: 'assistant', content: reply });
    c.updatedAt = Date.now();
    persist('saveChat', c);
  } catch (err) {
    console.error(err);
    S.streaming = null;
    renderChat();
    $('#chat-log').append(messageEl({ role: 'assistant', content: 'Sorry, ' + (err.message || 'something went wrong') + '.', error: true }));
    scrollDown(true);
    updateComposer();
    return;
  }
  S.streaming = null;
  renderSidebar();
  if (S.currentId === c.id) renderChat();
  updateComposer();
}

// ================= WIRING =================
function autosize() { const t = $('#in-msg'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; updateComposer(); }

function wireApp() {
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send($('#in-msg').value); });
  $('#in-msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#in-msg').value); }
  });
  $('#in-msg').addEventListener('input', autosize);
  $('#btn-new-chat').addEventListener('click', () => newChat(null));
  $('#btn-new-project').addEventListener('click', () => createProject());
  $('#in-search').addEventListener('input', (e) => { S.search = e.target.value.trim(); renderSidebar(); });
  $('#btn-collapse').addEventListener('click', () => $('#view-app').classList.add('side-closed'));
  $('#btn-open-side').addEventListener('click', () => $('#view-app').classList.remove('side-closed'));
  $('#scrim').addEventListener('click', () => $('#view-app').classList.add('side-closed'));
  $('#side-brand').addEventListener('click', (e) => { e.preventDefault(); newChat(null); });
  $('#side-scroll').addEventListener('scroll', closeMenu);
}

async function boot() {
  $('#year').textContent = new Date().getFullYear();
  wireAuth();
  wireApp();
  const forceHome = new URLSearchParams(location.search).has('home');

  if (forceHome) {
    // Opened from inside the app: send every call-to-action back to the app itself.
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
