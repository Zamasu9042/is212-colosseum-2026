/* ConnectSphere web GUI.
 *
 * A dependency-free single-page app served by Express from /public. It only
 * talks to the existing REST API under /api, so every rule (RBAC, conflict
 * checks, SCRUM-21/22/24 equipment rules) is enforced server-side; the UI
 * just presents it. All user data is inserted with textContent via h(),
 * never innerHTML.
 */
'use strict';

// =====================================================================
// Core helpers
// =====================================================================
const $app = document.getElementById('app');

/** Tiny DOM builder: h('div', {class:'x', onclick: fn}, 'text', child, [more]) */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required') el[k] = !!v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

const ROLE_LABELS = {
  event_organiser: 'Event Organiser',
  event_coordinator: 'Event Coordinator',
  event_coordinator_lead: 'Event Coordinator Lead',
  venue_staff: 'Venue Staff',
  technical_support_staff: 'Technical Support Staff',
  safety_officer: 'Safety Officer',
  attendee: 'Attendee',
};
const STATUS_LABELS = {
  in_repair: 'In repair', under_review: 'Under review', awaiting_arrangements: 'Awaiting arrangements',
  needs_replacement: 'Needs replacement', tentative_hold: 'Tentative hold', confirmed_booking: 'Confirmed booking',
  temporarily_unavailable: 'Unavailable', expired_hold: 'Expired hold',
};
const label = (s) => STATUS_LABELS[s] || (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/_/g, ' ') : '—');
const pill = (status, text) => h('span', { class: `pill pill-${status}` }, text || label(status));

// ---------- Dates ----------
const DT = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const D = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const T = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtDT = (v) => (v ? DT.format(new Date(v)) : '—');
function fmtRange(a, b) {
  if (!a || !b) return '—';
  const s = new Date(a); const e = new Date(b);
  if (s.toDateString() === e.toDateString()) return `${D.format(s)}, ${T.format(s)}–${T.format(e)}`;
  return `${fmtDT(s)} → ${fmtDT(e)}`;
}
function toLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '—');

// =====================================================================
// Session + API client
// =====================================================================
const session = {
  get token() { return sessionStorage.getItem('cs_token'); },
  get user() { try { return JSON.parse(sessionStorage.getItem('cs_user')); } catch { return null; } },
  set(token, user) {
    if (token) sessionStorage.setItem('cs_token', token);
    if (user) sessionStorage.setItem('cs_user', JSON.stringify(user));
  },
  clear() { sessionStorage.removeItem('cs_token'); sessionStorage.removeItem('cs_user'); },
};
const role = () => session.user?.role;
const is = (...roles) => roles.includes(role());

class ApiError extends Error {
  constructor(status, data) {
    super(formatApiError(data, status));
    this.status = status;
    this.data = data || {};
  }
}
function formatApiError(data, status) {
  if (!data) return `Request failed (${status}).`;
  let msg = data.error || data.message || `Request failed (${status}).`;
  const list = [];
  if (Array.isArray(data.details)) {
    for (const d of data.details) list.push(typeof d === 'string' ? d : `${d.path || d.param || ''}: ${d.msg}`.replace(/^: /, ''));
  }
  if (Array.isArray(data.missingFields)) list.push(`Missing: ${data.missingFields.map(fieldLabel).join(', ')}`);
  if (Array.isArray(data.missingDetails)) list.push(`Missing: ${data.missingDetails.join(', ')}`);
  if (list.length) msg += ` — ${list.join('; ')}`;
  return msg;
}

let refreshing = null;
async function tryRefresh() {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) return false;
        const { accessToken } = await r.json();
        session.set(accessToken);
        return true;
      })
      .catch(() => false)
      .finally(() => setTimeout(() => { refreshing = null; }, 0));
  }
  return refreshing;
}

async function api(path, { method = 'GET', body, query } = {}) {
  let url = `/api${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const send = () => fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let res = await send();
  if (res.status === 401 && session.token && !path.startsWith('/auth/')) {
    if (await tryRefresh()) res = await send();
    else { session.clear(); go('/login'); throw new ApiError(401, { error: 'Your session has expired. Please sign in again.' }); }
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// =====================================================================
// UI feedback: toasts, dialogs, alerts
// =====================================================================
function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}
function alertBox(kind, msg, items) {
  return h('div', { class: `alert alert-${kind}`, role: kind === 'error' ? 'alert' : null },
    msg, items && items.length ? h('ul', null, items.map((i) => h('li', null, i))) : null);
}
/** Error box for an ApiError; lists equipment conflicts when present. */
function errorBox(err) {
  const items = [];
  const d = err.data || {};
  if (Array.isArray(d.conflicts)) {
    for (const c of d.conflicts) items.push(`${c.eventName || c.eventId}: ${fmtRange(c.startDatetime, c.endDatetime)} (${c.quantity} unit${c.quantity === 1 ? '' : 's'})`);
  }
  if (d.summary && Array.isArray(d.summary.outstanding)) {
    for (const l of d.summary.outstanding) items.push(`${l.equipmentType}: ${l.quantityAllocated} of ${l.quantityRequested} allocated`);
  }
  return alertBox('error', err.message, items);
}

/**
 * Modal form. build(body) fills the body; onSubmit(close) does the work.
 * Errors thrown by onSubmit are shown inside the dialog, which stays open.
 */
function openDialog({ title, build, submitLabel = 'Save', danger = false, onSubmit, wide = false }) {
  const errorSlot = h('div');
  const body = h('div', { class: 'dlg-body' }, errorSlot);
  const submit = h('button', { class: danger ? 'danger solid' : 'primary', type: 'submit' }, submitLabel);
  const dlg = h('dialog', { style: wide ? { width: 'min(760px, 96vw)' } : null },
    h('form', { method: 'dialog', onsubmit: async (e) => {
      e.preventDefault();
      clear(errorSlot);
      submit.disabled = true;
      try { await onSubmit(() => dlg.close()); } catch (err) {
        errorSlot.appendChild(err instanceof ApiError ? errorBox(err) : alertBox('error', err.message));
        body.scrollTop = 0;
      } finally { submit.disabled = false; }
    } },
    h('div', { class: 'dlg-head' }, h('h2', null, title), h('button', { type: 'button', class: 'x', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')),
    body,
    h('div', { class: 'dlg-foot' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), onSubmit ? submit : null)));
  build(body, errorSlot);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

// ---------- form field helpers ----------
function field(lbl, input, hint) {
  return h('div', { class: 'field' }, h('label', null, lbl), input, hint ? h('div', { class: 'hint' }, hint) : null);
}
const input = (name, attrs = {}) => h('input', { name, ...attrs });
function select(name, options, value, attrs = {}) {
  return h('select', { name, ...attrs }, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, t)));
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());

function table(columns, rows, { onRow, empty = 'Nothing to show.', rowClass } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.class }, c.title)))),
    h('tbody', null, rows.map((r) => h('tr', {
      class: [onRow ? 'clickable' : '', rowClass ? rowClass(r) : ''].join(' ').trim() || null,
      onclick: onRow ? (e) => { if (!e.target.closest('button, a, select, input')) onRow(r); } : null,
    }, columns.map((c) => h('td', { class: c.class }, c.render(r))))))));
}

// =====================================================================
// Router
// =====================================================================
const go = (path) => { if (location.hash !== `#${path}`) location.hash = path; else render(); };
const ROUTES = [];
const route = (pattern, view, opts = {}) => ROUTES.push({
  pattern, view, ...opts,
  re: new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`),
});

function navFor(r) {
  const n = (path, text, key) => ({ path, text, key });
  const common = [n('/', 'Dashboard')];
  const tail = [n('/notifications', 'Notifications', 'notifications'), n('/help', 'Help & tutorials')];
  const byRole = {
    event_organiser: [n('/requests', 'My event requests'), n('/requests/new', 'New request'), n('/venues', 'Venues')],
    event_coordinator: [n('/review', 'Review queue'), n('/events', 'My events'), n('/venues', 'Venues'), n('/venue-schedule', 'Venue schedule'), n('/equipment', 'Equipment')],
    event_coordinator_lead: [n('/assign', 'Assign requests'), n('/events', 'Events'), n('/equipment', 'Equipment'), n('/venues', 'Venues')],
    venue_staff: [n('/venue-bookings', 'Booking queue'), n('/venues', 'Venues'), n('/venue-schedule', 'Venue schedule')],
    technical_support_staff: [n('/equipment', 'Equipment catalogue'), n('/events', 'Events & reservations')],
    safety_officer: [n('/events', 'Events'), n('/equipment', 'Equipment'), n('/venues', 'Venues')],
    attendee: [n('/profile', 'My profile'), n('/venues', 'Venues')],
  };
  return [...common, ...(byRole[r] || []), ...tail];
}

let unreadCount = 0;
async function refreshUnread() {
  try { unreadCount = (await api('/notifications', { query: { unread: true } })).count; } catch { unreadCount = 0; }
  const b = document.querySelector('[data-badge=notifications]');
  if (b) { b.textContent = unreadCount; b.style.display = unreadCount ? '' : 'none'; }
}

function layout(currentPath) {
  const user = session.user;
  const shell = h('div', { class: 'shell' });
  const main = h('main', { class: 'main', id: 'main' });
  const items = navFor(user.role);
  // Highlight the item with the longest path that prefixes the current one.
  const activePath = items
    .map((i) => i.path)
    .filter((p) => (p === '/' ? currentPath === '/' : currentPath === p || currentPath.startsWith(`${p}/`)))
    .sort((a, b) => b.length - a.length)[0];
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main', 'data-tour': 'nav' }, items.map((item) => {
    const active = item.path === activePath;
    return h('a', { href: `#${item.path}`, class: active ? 'active' : null, 'data-tour': `nav-${item.path.replace(/\W+/g, '') || 'home'}`, onclick: () => shell.classList.remove('nav-open') },
      h('span', null, item.text),
      item.key === 'notifications' ? h('span', { class: 'badge', 'data-badge': 'notifications', style: { display: unreadCount ? '' : 'none' } }, unreadCount) : null);
  }));
  append(shell, [
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-dot' }), 'ConnectSphere'),
      nav,
      h('div', { class: 'who', 'data-tour': 'who' }, h('strong', null, fullName(user)), h('span', null, ROLE_LABELS[user.role] || user.role),
        h('div', { class: 'actions', style: { marginTop: '.6rem' } },
          h('button', { class: 'small', 'data-tour': 'help-button', onclick: () => go('/help') }, '? Help'),
          h('button', { class: 'small', onclick: logout }, 'Sign out')))),
    h('div', null,
      h('div', { class: 'topbar' }, h('button', { class: 'small', onclick: () => shell.classList.toggle('nav-open'), 'aria-label': 'Menu' }, '☰'), h('strong', null, 'ConnectSphere')),
      main),
  ]);
  return { shell, main };
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  session.clear();
  go('/login');
}

async function render() {
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const match = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  if (!match) return go('/');
  const { r, m } = match;
  if (!r.public && !session.token) return go('/login');
  if (r.public && session.token && (path === '/login' || path === '/register')) return go('/');
  if (r.roles && !r.roles.includes(role())) {
    const { shell, main } = layout(path);
    clear($app).appendChild(shell);
    main.appendChild(alertBox('warn', 'Your role does not have access to this page.'));
    return;
  }
  window.scrollTo(0, 0);
  if (r.public) {
    clear($app);
    return r.view($app, ...m.slice(1));
  }
  const { shell, main } = layout(path);
  clear($app).appendChild(shell);
  main.appendChild(h('p', { class: 'muted' }, 'Loading…'));
  refreshUnread();
  try {
    const node = h('div');
    await r.view(node, ...m.slice(1).map(decodeURIComponent));
    clear(main).appendChild(node);
    if (typeof onPageRendered === 'function') onPageRendered(path); // tutorial.js
  } catch (err) {
    clear(main).appendChild(err instanceof ApiError ? errorBox(err) : alertBox('error', err.message));
    if (!(err instanceof ApiError)) console.error(err);
  }
}
window.addEventListener('hashchange', render);

function pageHead(title, subtitle, actions, crumbs) {
  return h('div', null,
    crumbs ? h('div', { class: 'crumbs' }, crumbs.map(([href, t], i) => [i ? ' / ' : '', href ? h('a', { href: `#${href}` }, t) : t])) : null,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, title), subtitle ? h('p', null, subtitle) : null),
      actions ? h('div', { class: 'actions' }, actions) : null));
}

// =====================================================================
// Auth views
// =====================================================================
const DEMO_ACCOUNTS = [
  ['organiser', 'Event Organiser'], ['coordinator', 'Event Coordinator'], ['lead', 'Coordinator Lead'],
  ['venue', 'Venue Staff'], ['tech', 'Technical Support'], ['safety', 'Safety Officer'], ['attendee', 'Attendee'],
];

function authCard(...children) {
  return h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-dot' }), 'ConnectSphere'), children));
}

route('/login', (root) => {
  const errorSlot = h('div');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    clear(errorSlot);
    const { email, password } = formData(form);
    try {
      const data = await api('/auth/login', { method: 'POST', body: { email, password } });
      session.set(data.accessToken, data.user);
      go('/');
    } catch (err) { errorSlot.appendChild(errorBox(err)); }
  } },
  h('h1', null, 'Sign in'),
  h('p', { class: 'muted' }, 'Event planning & venue booking for ConnectSphere staff, organisers and attendees.'),
  errorSlot,
  field('Email', input('email', { type: 'email', required: true, autocomplete: 'username' })),
  field('Password', input('password', { type: 'password', required: true, autocomplete: 'current-password' })),
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Sign in'), h('a', { href: '#/register' }, 'Create an account')));

  const fill = (key) => {
    form.email.value = `${key}@demo.connectsphere.sg`;
    form.password.value = 'Passw0rd1';
    form.requestSubmit();
  };
  root.appendChild(authCard(form,
    h('details', { style: { marginTop: '1.2rem' } },
      h('summary', { class: 'small muted' }, 'Demo accounts (after running npm run setup)'),
      h('div', { class: 'demo-list' }, DEMO_ACCOUNTS.map(([k, t]) => h('button', { type: 'button', onclick: () => fill(k) }, t))),
      h('p', { class: 'small muted' }, 'All demo accounts use the password Passw0rd1.'))));
}, { public: true });

route('/register', (root) => {
  const errorSlot = h('div');
  const orgField = field('Organisation', input('organisationName', { placeholder: 'e.g. Acme Asia Pte Ltd' }), 'Event Organisers only');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    clear(errorSlot);
    const body = formData(form);
    try {
      await api('/auth/register', { method: 'POST', body });
      const data = await api('/auth/login', { method: 'POST', body: { email: body.email, password: body.password } });
      session.set(data.accessToken, data.user);
      toast('Account created. Welcome!', 'ok');
      go('/');
    } catch (err) { errorSlot.appendChild(errorBox(err)); }
  } },
  h('h1', null, 'Create an account'),
  h('p', { class: 'muted small' }, 'Internal staff accounts are provisioned by ConnectSphere administrators.'),
  errorSlot,
  h('div', { class: 'form-grid' },
    field('First name', input('firstName', { required: true })),
    field('Last name', input('lastName', { required: true }))),
  field('Email', input('email', { type: 'email', required: true })),
  field('Password', input('password', { type: 'password', required: true, minlength: 8 }), 'At least 8 characters with a letter and a number'),
  field('I am an…', select('role', [['event_organiser', 'Event Organiser'], ['attendee', 'Attendee']], 'event_organiser', {
    onchange: (e) => { orgField.style.display = e.target.value === 'event_organiser' ? '' : 'none'; },
  })),
  orgField,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Create account'), h('a', { href: '#/login' }, 'I already have an account')));
  root.appendChild(authCard(form));
}, { public: true });

// =====================================================================
// Dashboard
// =====================================================================
const stat = (num, lbl, href) => h(href ? 'a' : 'div', { class: 'stat', href: href ? `#${href}` : null }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, lbl));
const safe = (p) => p.catch(() => null);

route('/', async (root) => {
  const user = session.user;
  root.appendChild(pageHead(`Hello, ${user.firstName}`, `Signed in as ${ROLE_LABELS[user.role]}.`));
  const stats = h('div', { class: 'stats', 'data-tour': 'dash-stats' });
  const next = h('div', { class: 'card', 'data-tour': 'dash-next' }, h('h2', null, 'What you can do here'));
  root.append(stats, next);
  const tips = [];
  const r = user.role;

  if (r === 'event_organiser') {
    const data = await api('/event-requests', { query: { scope: 'all' } });
    const by = (s) => data.eventRequests.filter((x) => s.includes(x.status)).length;
    append(stats, [stat(by(['draft']), 'Drafts', '/requests'), stat(by(['submitted', 'under_review']), 'Awaiting review', '/requests'),
      stat(by(['approved']), 'Approved', '/requests'), stat(by(['returned', 'rejected']), 'Returned / rejected', '/requests')]);
    tips.push(['/requests/new', 'Start a new event request — save it as a draft and submit when it is complete.'], ['/venues', 'Browse ConnectSphere venues.']);
  } else if (r === 'event_coordinator') {
    const [queue, events] = await Promise.all([api('/event-requests/review-queue'), api('/events')]);
    const live = events.events.filter((e) => !['completed', 'cancelled'].includes(e.status));
    append(stats, [stat(queue.eventRequests.length, 'Requests to review', '/review'), stat(live.length, 'Active events', '/events'),
      stat(live.filter((e) => e.technicalReadiness !== 'complete').length, 'Events not technically ready', '/events')]);
    tips.push(['/review', 'Review submitted requests: approve, return for amendment, or reject.'], ['/events', 'Plan your events: book venues and record equipment needs.']);
  } else if (r === 'event_coordinator_lead') {
    const [unassigned, active] = await Promise.all([api('/event-requests/unassigned'), api('/events/active')]);
    append(stats, [stat(unassigned.count, 'Unassigned requests', '/assign'), stat(active.count, 'Active events', '/events')]);
    tips.push(['/assign', 'Assign submitted requests to an Event Coordinator.']);
  } else if (r === 'venue_staff') {
    const [bookings, flagged] = await Promise.all([api('/venue-bookings', { query: { status: 'pending' } }), safe(api('/venue-bookings', { query: { flagged: true } }))]);
    append(stats, [stat(bookings.count, 'Pending venue bookings', '/venue-bookings'), flagged ? stat(flagged.count, 'Bookings flagged for conflicts', '/venue-bookings') : null]);
    tips.push(['/venue-bookings', 'Approve or reject venue booking requests.'], ['/venue-schedule', 'See every venue’s schedule for a day.']);
  } else if (r === 'technical_support_staff') {
    const [eq, events] = await Promise.all([api('/equipment'), api('/events', { query: { status: 'planning,awaiting_arrangements,confirmed' } })]);
    const c = (s) => eq.equipment.filter((e) => e.status === s).length;
    append(stats, [stat(c('available'), 'Available items', '/equipment?status=available'), stat(c('reserved'), 'Reserved items', '/equipment?status=reserved'),
      stat(c('in_repair') + c('unavailable'), 'Out of service', '/equipment?status=in_repair,unavailable'),
      stat(events.events.filter((e) => e.technicalReadiness !== 'complete').length, 'Events awaiting technical readiness', '/events')]);
    tips.push(['/events', 'Open an event to reserve equipment for its time window and complete technical readiness.'], ['/equipment', 'Keep equipment status up to date — in-repair and unavailable items cannot be reserved.']);
  } else if (r === 'safety_officer') {
    tips.push(['/events', 'Read-only view of events, their venues and equipment.']);
  } else if (r === 'attendee') {
    tips.push(['/profile', 'Keep your profile details up to date.']);
  }
  append(stats, [stat(unreadCount, 'Unread notifications', '/notifications')]);
  next.appendChild(h('ul', null, tips.map(([href, t]) => h('li', null, h('a', { href: `#${href}` }, t)))));
});

// =====================================================================
// Event requests (Organiser, Coordinator)
// =====================================================================
const REQUEST_FIELDS = [
  ['eventName', 'Event name', 'text'], ['category', 'Category', 'select'],
  ['preferredStart', 'Preferred start', 'datetime'], ['preferredEnd', 'Preferred end', 'datetime'],
  ['expectedAttendance', 'Expected attendance', 'number'], ['description', 'Description', 'textarea'],
  ['purpose', 'Purpose', 'textarea'], ['venueRequirements', 'Venue requirements', 'textarea'],
  ['requestedLayout', 'Requested layout', 'layout'], ['layout', 'Layout notes', 'text'],
  ['accessibilityRequirements', 'Accessibility needs', 'textarea'], ['facilityRequirements', 'Facility requirements', 'textarea'],
  ['setupRequirements', 'Setup requirements', 'textarea'], ['equipmentRequirements', 'Equipment requirements', 'textarea'],
  ['registrationSetup', 'Registration setup', 'textarea'], ['registrationRequired', 'Attendee registration required', 'checkbox'],
];
function fieldLabel(name) {
  const f = REQUEST_FIELDS.find(([n]) => n === name);
  return f ? f[1].toLowerCase() : name;
}
const CATEGORIES = ['', 'conference', 'workshop', 'training', 'exhibition', 'meeting', 'seminar', 'networking', 'other'];
const LAYOUTS = ['', 'theatre', 'classroom', 'boardroom', 'banquet', 'exhibition', 'cabaret'];

function requestForm(req = {}) {
  const wide = new Set(['description', 'purpose', 'venueRequirements', 'equipmentRequirements', 'registrationSetup', 'accessibilityRequirements', 'facilityRequirements', 'setupRequirements']);
  const grid = h('div', { class: 'form-grid' });
  const full = h('div');
  for (const [name, lbl, type] of REQUEST_FIELDS) {
    const v = req[name];
    let el;
    if (type === 'textarea') el = h('textarea', { name }, v || '');
    else if (type === 'datetime') el = input(name, { type: 'datetime-local', value: toLocalInput(v) });
    else if (type === 'number') el = input(name, { type: 'number', min: 1, value: v ?? '' });
    else if (type === 'select') el = select(name, CATEGORIES.map((c) => [c, c ? label(c) : '— choose —']), v);
    else if (type === 'layout') el = select(name, LAYOUTS.map((c) => [c, c ? label(c) : '— choose —']), v);
    else if (type === 'checkbox') { full.appendChild(h('div', { class: 'field' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked: !!v }), lbl))); continue; }
    else el = input(name, { value: v || '' });
    (wide.has(name) ? full : grid).appendChild(field(lbl, el));
  }
  return h('form', { class: 'request-form' }, grid, full);
}
function readRequestForm(form) {
  const out = {};
  for (const [name, , type] of REQUEST_FIELDS) {
    const el = form.elements[name];
    if (type === 'checkbox') out[name] = el.checked;
    else if (type === 'datetime') out[name] = fromLocalInput(el.value);
    else if (type === 'number') out[name] = el.value ? Number(el.value) : null;
    else out[name] = el.value.trim() ? el.value : null;
  }
  return out;
}

route('/requests', async (root) => {
  const { eventRequests } = await api('/event-requests', { query: { scope: 'all' } });
  root.appendChild(pageHead('My event requests', 'Drafts stay private until you submit them.', [h('a', { class: 'btn primary', href: '#/requests/new', 'data-tour': 'req-new' }, '+ New request')]));
  root.appendChild(h('div', { class: 'card', 'data-tour': 'req-list' }, table([
    { title: 'Event', render: (r) => h('strong', null, r.eventName || '(untitled draft)') },
    { title: 'When', render: (r) => fmtRange(r.preferredStart, r.preferredEnd) },
    { title: 'Attendance', render: (r) => r.expectedAttendance ?? '—' },
    { title: 'Status', render: (r) => pill(r.status) },
    { title: 'Last updated', class: 'nowrap', render: (r) => fmtDT(r.updated_at) },
  ], eventRequests, { onRow: (r) => go(`/requests/${r.id}`), empty: 'You have no event requests yet.' })));
}, { roles: ['event_organiser'] });

route('/requests/new', async (root) => {
  const form = requestForm();
  const errorSlot = h('div');
  const save = async (submit) => {
    clear(errorSlot);
    try {
      const { eventRequest } = await api('/event-requests', { method: 'POST', body: readRequestForm(form) });
      if (submit) {
        try { await api(`/event-requests/${eventRequest.id}/submit`, { method: 'POST' }); toast('Request submitted for review.', 'ok'); }
        catch (err) { sessionStorage.setItem('cs_flash', `Saved as a draft, but not submitted yet. ${err.message}`); go(`/requests/${eventRequest.id}`); return; }
      } else toast('Draft saved.', 'ok');
      go(`/requests/${eventRequest.id}`);
    } catch (err) { errorSlot.appendChild(errorBox(err)); window.scrollTo(0, 0); }
  };
  root.append(pageHead('New event request', 'Save a draft at any time. Every field is needed before you can submit.', null, [['/requests', 'My event requests'], [null, 'New']]),
    errorSlot, h('div', { class: 'card', 'data-tour': 'req-form' }, form,
      h('div', { class: 'actions', 'data-tour': 'req-actions' }, h('button', { onclick: () => save(false) }, 'Save draft'), h('button', { class: 'primary', onclick: () => save(true) }, 'Save & submit'))));
}, { roles: ['event_organiser'] });

function requestDetails(r) {
  const rows = [
    ['Status', pill(r.status)], ['Organiser', r.organiser ? `${fullName(r.organiser)} (${r.organiser.email})` : '—'],
    ['Assigned coordinator', r.assignedCoordinator ? fullName(r.assignedCoordinator) : 'Not yet assigned'],
    ['When', fmtRange(r.preferredStart, r.preferredEnd)],
    ...REQUEST_FIELDS.filter(([n]) => !['preferredStart', 'preferredEnd', 'eventName'].includes(n))
      .map(([n, l, t]) => [l, t === 'checkbox' ? (r[n] ? 'Yes' : 'No') : (r[n] ?? '—')]),
  ];
  if (r.reviewReason) rows.push(['Review note', r.reviewReason]);
  if (r.submittedAt) rows.push(['Submitted', fmtDT(r.submittedAt)]);
  return h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, typeof v === 'string' || typeof v === 'number' ? String(v) : v)]));
}

route('/requests/:id', async (root, id) => {
  const { eventRequest: r } = await api(`/event-requests/${id}`);
  const crumbs = is('event_organiser') ? [['/requests', 'My event requests'], [null, r.eventName || 'Draft']] : [['/review', 'Review queue'], [null, r.eventName]];

  if (is('event_organiser') && r.status === 'draft') {
    const form = requestForm(r);
    const errorSlot = h('div');
    const flash = sessionStorage.getItem('cs_flash');
    if (flash) { sessionStorage.removeItem('cs_flash'); errorSlot.appendChild(alertBox('warn', flash)); }
    const save = async () => api(`/event-requests/${r.id}`, { method: 'PATCH', body: readRequestForm(form) });
    root.append(pageHead(r.eventName || 'Untitled draft', 'This request is a draft — only you can see it.', [pill('draft')], crumbs), errorSlot,
      h('div', { class: 'card' }, form, h('div', { class: 'actions' },
        h('button', { onclick: async () => { clear(errorSlot); try { await save(); toast('Draft saved.', 'ok'); } catch (err) { errorSlot.appendChild(errorBox(err)); } } }, 'Save draft'),
        h('button', { class: 'primary', onclick: async () => {
          clear(errorSlot);
          try { await save(); await api(`/event-requests/${r.id}/submit`, { method: 'POST' }); toast('Request submitted for review.', 'ok'); render(); }
          catch (err) { errorSlot.appendChild(errorBox(err)); window.scrollTo(0, 0); }
        } }, 'Submit for review'))));
    return;
  }

  const actions = [];
  if (is('event_coordinator') && ['submitted', 'under_review'].includes(r.status)) {
    const decide = (status, reasonRequired) => openDialog({
      title: { approved: 'Approve request', returned: 'Return for amendment', rejected: 'Reject request' }[status],
      submitLabel: label(status === 'returned' ? 'return' : status === 'approved' ? 'approve' : 'reject'),
      danger: status === 'rejected',
      build: (b) => b.appendChild(field(reasonRequired ? 'Reason (required)' : 'Note to organiser (optional)', h('textarea', { name: 'reviewReason', required: reasonRequired }))),
      onSubmit: async (close) => {
        const reviewReason = document.querySelector('dialog textarea[name=reviewReason]').value;
        const res = await api(`/event-requests/${r.id}/status`, { method: 'PATCH', body: { status, reviewReason } });
        close();
        toast(`Request ${label(status).toLowerCase()}.`, 'ok');
        if (res.event) go(`/events/${res.event.id}`); else render();
      },
    });
    actions.push(h('button', { class: 'primary', onclick: () => decide('approved', false) }, 'Approve'),
      h('button', { onclick: () => decide('returned', false) }, 'Return'),
      h('button', { class: 'danger', onclick: () => decide('rejected', true) }, 'Reject'));
  }
  root.append(pageHead(r.eventName || 'Event request', null, actions, crumbs), h('div', { class: 'card' }, requestDetails(r)));
});

route('/review', async (root) => {
  const { eventRequests } = await api('/event-requests/review-queue');
  root.append(pageHead('Review queue', 'Submitted requests assigned to you.'), h('div', { class: 'card', 'data-tour': 'review-list' }, table([
    { title: 'Event', render: (r) => h('strong', null, r.eventName) },
    { title: 'Organiser', render: (r) => fullName(r.organiser) },
    { title: 'When', render: (r) => fmtRange(r.preferredStart, r.preferredEnd) },
    { title: 'Attendance', render: (r) => r.expectedAttendance },
    { title: 'Status', render: (r) => pill(r.status) },
  ], eventRequests, { onRow: (r) => go(`/requests/${r.id}`), empty: 'Nothing waiting for your review.' })));
}, { roles: ['event_coordinator'] });

route('/assign', async (root) => {
  const [unassigned, assigned, coords] = await Promise.all([
    api('/event-requests/unassigned'), api('/event-requests/assignments'), api('/users', { query: { role: 'event_coordinator' } }),
  ]);
  const opts = [['', '— choose coordinator —'], ...coords.users.map((u) => [u.id, fullName(u)])];
  const assignCell = (r) => {
    const replacementOpts = r.assignedCoordinatorId
      ? opts.filter(([id]) => id !== r.assignedCoordinatorId)
      : opts;
    const sel = select('coordinatorId', replacementOpts, '');
    return h('div', { class: 'actions' }, sel, h('button', { class: 'small primary', onclick: async () => {
      if (!sel.value) return toast('Choose a coordinator first.', 'error');
      try { await api(`/event-requests/${r.id}/assignment`, { method: 'PATCH', body: { coordinatorId: sel.value } }); toast(r.assignedCoordinatorId ? 'Coordinator reassigned.' : 'Coordinator assigned.', 'ok'); render(); }
      catch (err) { toast(err.message, 'error'); }
    } }, r.assignedCoordinatorId ? 'Reassign' : 'Assign'));
  };
  const cols = [
    { title: 'Event', render: (r) => h('strong', null, r.eventName) },
    { title: 'Organiser', render: (r) => fullName(r.organiser) },
    { title: 'When', render: (r) => fmtRange(r.preferredStart, r.preferredEnd) },
    { title: 'Status', render: (r) => pill(r.status) },
    { title: 'Current coordinator', render: (r) => r.assignedCoordinator ? fullName(r.assignedCoordinator) : 'Unassigned' },
  ];
  root.append(pageHead('Assign & reassign coordinators', 'Every Coordinator Lead sees the same queue. Reassignments take effect immediately; existing venue and technical arrangements remain with the event.'),
    h('div', { class: 'card', 'data-tour': 'assign-unassigned' }, h('h2', null, `Unassigned requests (${unassigned.count})`), table([...cols, { title: 'Assign coordinator', render: assignCell }], unassigned.eventRequests, { empty: 'No unassigned requests.' })),
    h('div', { class: 'card', 'data-tour': 'assign-current' }, h('h2', null, 'Current assignments and active events'), table([...cols, { title: 'Replacement coordinator', render: assignCell }], assigned.eventRequests, { empty: 'No assignments yet.' })));
}, { roles: ['event_coordinator_lead'] });

// =====================================================================
// Events (SCRUM-21 reservations, SCRUM-24 readiness live here)
// =====================================================================
const hashQuery = () => new URLSearchParams((location.hash.split('?')[1]) || '');
const eventName = (e) => e.EventRequest?.eventName || e.eventName || 'Event';
const RESERVABLE_EVENT = ['planning', 'awaiting_arrangements', 'confirmed'];

route('/events', async (root) => {
  const q = hashQuery();
  const status = q.get('status') || 'live';
  const query = status === 'live' ? { status: 'planning,awaiting_arrangements,confirmed' } : status === 'all' ? {} : { status };
  const { events } = await api('/events', { query });
  const chips = [['live', 'Upcoming & active'], ['planning', 'Planning'], ['confirmed', 'Confirmed'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']];
  root.append(
    pageHead(is('event_coordinator') ? 'My events' : 'Events', is('technical_support_staff') ? 'Open an event to reserve equipment for its time window.' : null),
    h('div', { class: 'card', 'data-tour': 'events-list' },
      h('div', { class: 'chips', style: { marginBottom: '.9rem' } }, chips.map(([v, t]) => h('button', { class: `chip ${v === status ? 'on' : ''}`, onclick: () => go(`/events?status=${v}`) }, t))),
      table([
        { title: 'Event', render: (e) => h('strong', null, eventName(e)) },
        { title: 'When', render: (e) => fmtRange(e.startDatetime, e.endDatetime) },
        { title: 'Venue', render: (e) => e.Venue?.name || h('span', { class: 'muted' }, 'Not set') },
        { title: 'Coordinator', render: (e) => fullName(e.coordinator) },
        { title: 'Status', render: (e) => pill(e.status) },
        { title: 'Technical readiness', render: (e) => pill(e.technicalReadiness === 'complete' ? 'complete' : 'pending', e.technicalReadiness === 'complete' ? 'Ready' : 'Pending') },
      ], events, { onRow: (e) => go(`/events/${e.id}`), empty: 'No events match this filter.' })));
}, { roles: ['technical_support_staff', 'event_coordinator', 'event_coordinator_lead', 'safety_officer'] });

function allocationBar(line) {
  const pct = Math.min(100, Math.round((line.quantityAllocated / line.quantityRequested) * 100));
  return h('div', { class: `bar ${line.fullyAllocated ? 'full' : ''}`, title: `${pct}%` }, h('span', { style: { width: `${pct}%` } }));
}

route('/events/:id', async (root, id) => {
  const [detail, reqs, bookings] = await Promise.all([
    api(`/events/${id}`),
    api(`/events/${id}/equipment-requests`),
    safe(api(`/events/${id}/venue-bookings`)),
  ]);
  const { event, equipmentReservations } = detail;
  const er = event.EventRequest || {};
  const canReserve = is('technical_support_staff') && RESERVABLE_EVENT.includes(event.status);
  const canEditLines = (is('technical_support_staff') || (is('event_coordinator') && event.coordinatorId === session.user.id)) && RESERVABLE_EVENT.includes(event.status);
  const allocation = reqs.allocation;
  const ready = event.technicalReadiness === 'complete';

  root.appendChild(pageHead(er.eventName || 'Event', fmtRange(event.startDatetime, event.endDatetime),
    [pill(event.status), pill(ready ? 'complete' : 'pending', ready ? 'Technically ready' : 'Technical readiness pending')],
    [['/events', 'Events'], [null, er.eventName || 'Event']]));

  // ----- Overview -----
  root.appendChild(h('div', { class: 'grid grid-2' },
    h('div', { class: 'card', 'data-tour': 'ev-overview' }, h('h2', null, 'Overview'), h('dl', { class: 'kv' },
      h('dt', null, 'Time window'), h('dd', null, fmtRange(event.startDatetime, event.endDatetime)),
      h('dt', null, 'Venue'), h('dd', null, event.Venue ? `${event.Venue.name} (${event.Venue.location})` : 'Not set'),
      h('dt', null, 'Coordinator'), h('dd', null, fullName(event.coordinator)),
      h('dt', null, 'Expected attendance'), h('dd', null, er.expectedAttendance ?? '—'),
      h('dt', null, 'Equipment notes'), h('dd', null, er.equipmentRequirements || '—'),
      h('dt', null, 'Event request'), h('dd', null, is('event_coordinator', 'safety_officer') ? h('a', { href: `#/requests/${er.id}` }, 'View original request') : (er.category ? label(er.category) : '—')))),
    readinessCard(event, allocation)));

  // ----- Equipment requests (SCRUM-24) -----
  const lineCard = h('div', { class: 'card', 'data-tour': 'ev-requests' }, h('div', { class: 'card-head' },
    h('div', null, h('h2', null, 'Equipment requested'), h('div', { class: 'muted small' }, 'What this event needs. Technical readiness requires every line to be fully allocated.')),
    canEditLines ? h('button', { 'data-tour': 'ev-add-line', onclick: () => addLineDialog(event) }, '+ Add requirement') : null),
  table([
    { title: 'Requirement', render: (l) => h('div', null, h('strong', null, `${l.quantityRequested} × ${l.equipmentType}`), l.Equipment ? h('div', { class: 'small muted' }, `Specific item: ${l.Equipment.name}`) : null) },
    { title: 'Technical requirements', render: (l) => l.technicalRequirements || '—' },
    { title: 'Allocated', render: (l) => h('div', null, h('div', { class: 'small' }, `${l.allocation.quantityAllocated} of ${l.quantityRequested}`), allocationBar(l.allocation),
      l.allocation.outOfServiceQuantity ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, `${l.allocation.outOfServiceQuantity} reserved unit(s) now out of service — allocate a replacement`) : null) },
    { title: '', render: (l) => h('div', { class: 'actions' },
      canReserve && !l.allocation.fullyAllocated ? h('button', { class: 'small primary', onclick: () => reserveDialog(event, reqs, { line: l }) }, 'Allocate') : null,
      canEditLines && l.allocation.quantityAllocated === 0 ? h('button', { class: 'small danger', onclick: async () => {
        try { await api(`/events/${event.id}/equipment-requests/${l.id}`, { method: 'DELETE' }); toast('Requirement removed.', 'ok'); render(); } catch (err) { toast(err.message, 'error'); }
      } }, 'Remove') : null) },
  ], reqs.equipmentRequests, { empty: 'No equipment has been requested for this event.' }));
  root.appendChild(lineCard);

  // ----- Reservations (SCRUM-21 AC4) -----
  root.appendChild(h('div', { class: 'card', 'data-tour': 'ev-reservations' }, h('div', { class: 'card-head' },
    h('div', null, h('h2', null, 'Equipment reservations'), h('div', { class: 'muted small' }, 'Items committed to this event. Overlapping reservations of the same item are blocked.')),
    canReserve ? h('button', { class: 'primary', 'data-tour': 'ev-reserve', onclick: () => reserveDialog(event, reqs) }, '+ Reserve equipment') : null),
  reservationTable(equipmentReservations, { showEvent: false, canCancel: is('technical_support_staff') })));

  // ----- Venue bookings -----
  if (bookings) {
    const canBook = is('event_coordinator') && event.coordinatorId === session.user.id && RESERVABLE_EVENT.includes(event.status);
    root.appendChild(h('div', { class: 'card', 'data-tour': 'ev-venues' }, h('div', { class: 'card-head' }, h('h2', null, 'Venue bookings'),
      canBook ? h('button', { 'data-tour': 'ev-request-venue', onclick: () => venueBookingDialog(event, er) }, '+ Request a venue') : null),
    table([
      { title: 'Venue', render: (b) => b.Venue?.name || '—' },
      { title: 'When', render: (b) => fmtRange(b.startDatetime, b.endDatetime) },
      { title: 'Attendance', render: (b) => b.expectedAttendance },
      { title: 'Status', render: (b) => [pill(b.status), b.conflictFlaggedAt ? [' ', pill('warn', 'Conflict flagged')] : null] },
      { title: 'Note', render: (b) => b.reviewReason || '—' },
    ], bookings.bookings, { empty: 'No venue has been requested yet.' })));
  }
}, { roles: ['technical_support_staff', 'event_coordinator', 'event_coordinator_lead', 'safety_officer'] });

function readinessCard(event, allocation) {
  const ready = event.technicalReadiness === 'complete';
  const slot = h('div');
  const card = h('div', { class: 'card', 'data-tour': 'ev-readiness' }, h('h2', null, 'Technical readiness'), slot);
  slot.appendChild(ready
    ? alertBox('ok', `Marked complete${event.technicalReadinessAt ? ` on ${fmtDT(event.technicalReadinessAt)}` : ''}. All requested equipment is allocated.`)
    : allocation.fullyAllocated
      ? alertBox('info', allocation.lines.length ? 'All requested equipment is allocated. Readiness can be marked complete.' : 'No equipment has been requested, so readiness can be marked complete.')
      : alertBox('warn', 'Not ready: some requested equipment still needs to be allocated.', allocation.outstanding.map((l) => `${l.equipmentType}: ${l.quantityAllocated} of ${l.quantityRequested} allocated`)));
  card.appendChild(h('div', { class: 'small muted', style: { marginBottom: '.7rem' } }, `${allocation.totalAllocated} of ${allocation.totalRequested} requested unit(s) allocated.`));
  if (is('technical_support_staff') && RESERVABLE_EVENT.includes(event.status)) {
    const errSlot = h('div');
    card.append(errSlot, h('div', { class: 'actions' }, ready
      ? h('button', { onclick: async () => { await api(`/events/${event.id}/technical-readiness`, { method: 'PATCH', body: { complete: false } }); toast('Readiness reset to pending.'); render(); } }, 'Reset to pending')
      : h('button', { class: 'primary', 'data-tour': 'ev-mark-ready', onclick: async () => {
        clear(errSlot);
        try { await api(`/events/${event.id}/technical-readiness`, { method: 'PATCH', body: { complete: true } }); toast('Technical readiness marked complete.', 'ok'); render(); }
        catch (err) { errSlot.appendChild(errorBox(err)); }
      } }, 'Mark technical readiness complete')));
  }
  return card;
}

function reservationTable(rows, { showEvent = true, canCancel = false } = {}) {
  const sorted = [...rows].sort((a, b) => (a.status === b.status ? new Date(a.startDatetime) - new Date(b.startDatetime) : a.status === 'active' ? -1 : 1));
  return table([
    showEvent
      ? { title: 'Event', render: (r) => h('a', { href: `#/events/${r.eventId}` }, r.eventName || r.eventId) }
      : { title: 'Item', render: (r) => h('div', null, h('a', { href: `#/equipment/${r.equipmentId}` }, r.equipmentName), h('div', { class: 'small muted' }, r.equipmentType)) },
    { title: 'Qty', render: (r) => r.quantity },
    { title: 'Time window', render: (r) => fmtRange(r.startDatetime, r.endDatetime) },
    { title: 'Organiser', render: (r) => r.organiserName || '—' },
    { title: 'Reserved', render: (r) => h('div', { class: 'small' }, fmtDT(r.reservedAt), h('div', { class: 'muted' }, r.reservedBy ? `by ${r.reservedBy.name}` : '')) },
    { title: 'Status', render: (r) => h('div', null, pill(r.status), r.status === 'cancelled' ? h('div', { class: 'small muted' }, `${fmtDT(r.cancelledAt)}${r.cancelledBy ? ` by ${r.cancelledBy.name}` : ''}${r.cancellationReason ? ` — ${r.cancellationReason}` : ''}`) : null) },
    { title: '', render: (r) => (canCancel && r.status === 'active' ? h('button', { class: 'small danger', onclick: () => cancelReservationDialog(r) }, 'Cancel') : null) },
  ], sorted, { empty: 'No reservations yet.', rowClass: (r) => (r.status === 'cancelled' ? 'dim' : '') });
}

function cancelReservationDialog(r) {
  openDialog({
    title: 'Cancel reservation', submitLabel: 'Cancel reservation', danger: true,
    build: (b) => append(b, [h('p', null, `Release ${r.quantity} × ${r.equipmentName} for ${r.eventName}? The item goes back to available if nothing else holds it.`),
      field('Reason (optional)', h('textarea', { name: 'reason' }))]),
    onSubmit: async (close) => {
      const reason = document.querySelector('dialog textarea[name=reason]').value || undefined;
      const res = await api(`/equipment-reservations/${r.id}/cancel`, { method: 'POST', body: { reason } });
      close();
      toast(`Reservation cancelled. ${res.equipment.name} is now ${label(res.equipment.status).toLowerCase()}.`, 'ok');
      if (res.readinessReverted) setTimeout(() => toast('Technical readiness went back to pending — a requirement is no longer fully allocated.'), 300);
      render();
    },
  });
}

/**
 * SCRUM-21/22/24 reservation dialog. The item list comes from
 * GET /equipment?selectable=true for the chosen window, so in-repair,
 * unavailable and already-booked items never appear (SCRUM-22 AC1).
 */
function reserveDialog(event, reqs, { line: presetLine } = {}) {
  const openLines = reqs.equipmentRequests.filter((l) => !l.allocation.fullyAllocated);
  openDialog({
    title: `Reserve equipment — ${eventName(event)}`,
    submitLabel: 'Reserve',
    build: (b) => {
      const lineSel = select('equipmentRequestId', [['', 'Not linked to a requirement'],
        ...openLines.map((l) => [l.id, `${l.equipmentType}${l.Equipment ? ` (${l.Equipment.name})` : ''} — ${l.allocation.shortfall} still needed`])], presetLine?.id || '');
      const windowMode = select('windowMode', [['event', `Whole event (${fmtRange(event.startDatetime, event.endDatetime)})`], ['custom', 'A time slot within the event']], 'event');
      const start = input('startDatetime', { type: 'datetime-local', value: toLocalInput(event.startDatetime), min: toLocalInput(event.startDatetime), max: toLocalInput(event.endDatetime) });
      const end = input('endDatetime', { type: 'datetime-local', value: toLocalInput(event.endDatetime), min: toLocalInput(event.startDatetime), max: toLocalInput(event.endDatetime) });
      const custom = h('div', { class: 'form-grid', style: { display: 'none' } }, field('From', start), field('To', end));
      const itemSel = h('select', { name: 'equipmentId', required: true });
      const qty = input('quantity', { type: 'number', min: 1, value: 1, required: true });
      const itemHint = h('div', { class: 'hint' });

      async function loadItems() {
        const line = openLines.find((l) => l.id === lineSel.value);
        const custom = windowMode.value === 'custom';
        const query = { selectable: true, ...(custom ? { startDatetime: fromLocalInput(start.value), endDatetime: fromLocalInput(end.value) } : { eventId: event.id }) };
        if (line && !line.equipmentId) query.type = line.equipmentType;
        clear(itemSel).appendChild(h('option', { value: '' }, 'Loading…'));
        try {
          let { equipment } = await api('/equipment', { query });
          if (line?.equipmentId) equipment = equipment.filter((e) => e.id === line.equipmentId);
          clear(itemSel);
          if (!equipment.length) {
            itemSel.appendChild(h('option', { value: '' }, 'No selectable items'));
            itemHint.textContent = 'Nothing matching is free in this window — items that are in repair, unavailable or already booked are not listed.';
            return;
          }
          itemHint.textContent = 'Only working items with free units in this window are listed.';
          for (const e of equipment) itemSel.appendChild(h('option', { value: e.id, 'data-free': e.availableQuantity }, `${e.name} · ${e.type} · ${e.availableQuantity} free`));
          syncQty();
        } catch (err) { clear(itemSel).appendChild(h('option', { value: '' }, 'Could not load items')); itemHint.textContent = err.message; }
      }
      let qtyTouched = false;
      qty.addEventListener('input', () => { qtyTouched = true; });
      function syncQty() {
        const free = Number(itemSel.selectedOptions[0]?.dataset.free || 1);
        const line = openLines.find((l) => l.id === lineSel.value);
        const max = line ? Math.min(free, line.allocation.shortfall) : free;
        qty.max = max;
        // Default to what the requirement still needs; respect a manual choice.
        const wanted = qtyTouched ? Number(qty.value) || 1 : (line ? max : 1);
        qty.value = Math.max(1, Math.min(wanted, max));
      }
      windowMode.addEventListener('change', () => { custom.style.display = windowMode.value === 'custom' ? '' : 'none'; loadItems(); });
      start.addEventListener('change', loadItems);
      end.addEventListener('change', loadItems);
      lineSel.addEventListener('change', () => { qtyTouched = false; loadItems(); });
      itemSel.addEventListener('change', syncQty);
      append(b, [
        openLines.length ? field('Allocate to requirement', lineSel, 'Linking counts this reservation towards technical readiness.') : null,
        field('Time window', windowMode), custom,
        field('Item', itemSel), itemHint,
        field('Quantity', qty),
      ]);
      loadItems();
    },
    onSubmit: async (close) => {
      const f = document.querySelector('dialog form');
      const d = formData(f);
      if (!d.equipmentId) throw new Error('Choose an item to reserve.');
      const body = { equipmentId: d.equipmentId, quantity: Number(d.quantity) };
      if (d.equipmentRequestId) body.equipmentRequestId = d.equipmentRequestId;
      if (d.windowMode === 'custom') { body.startDatetime = fromLocalInput(d.startDatetime); body.endDatetime = fromLocalInput(d.endDatetime); }
      const res = await api(`/events/${event.id}/equipment-reservations`, { method: 'POST', body });
      close();
      toast(`${res.reservation.quantity} × ${res.reservation.equipmentName} reserved. Item status: ${label(res.equipment.status)}.`, 'ok');
      render();
    },
  });
}

function addLineDialog(event) {
  openDialog({
    title: 'Add equipment requirement', submitLabel: 'Add',
    build: async (b) => {
      const typeList = h('datalist', { id: 'eq-types' });
      const itemSel = h('select', { name: 'equipmentId' }, h('option', { value: '' }, 'Any item of this type'));
      append(b, [
        field('Equipment type', input('equipmentType', { list: 'eq-types', placeholder: 'e.g. Projector' }), 'Leave blank if you pick a specific item below.'), typeList,
        field('Specific item (optional)', itemSel),
        field('Quantity needed', input('quantityRequested', { type: 'number', min: 1, value: 1, required: true })),
        field('Technical requirements', h('textarea', { name: 'technicalRequirements', placeholder: 'e.g. HDMI to stage, 2 handheld mics' })),
      ]);
      try {
        const { equipment } = await api('/equipment');
        [...new Set(equipment.map((e) => e.type))].sort().forEach((t) => typeList.appendChild(h('option', { value: t })));
        equipment.forEach((e) => itemSel.appendChild(h('option', { value: e.id }, `${e.name} (${e.type})`)));
      } catch { /* coordinators without catalogue access just type a type */ }
    },
    onSubmit: async (close) => {
      const d = formData(document.querySelector('dialog form'));
      const body = { quantityRequested: Number(d.quantityRequested), technicalRequirements: d.technicalRequirements || null };
      if (d.equipmentType) body.equipmentType = d.equipmentType.trim();
      if (d.equipmentId) body.equipmentId = d.equipmentId;
      await api(`/events/${event.id}/equipment-requests`, { method: 'POST', body });
      close();
      toast('Requirement added.', 'ok');
      render();
    },
  });
}

function venueBookingDialog(event, er) {
  openDialog({
    title: 'Request a venue', submitLabel: 'Send request', wide: true,
    build: async (b) => {
      const sel = h('select', { name: 'venueId', required: true }, h('option', { value: '' }, 'Loading venues…'));
      append(b, [
        h('p', { class: 'small muted' }, `For ${fmtRange(event.startDatetime, event.endDatetime)}. Availability below already accounts for each venue’s setup and turnaround time.`),
        field('Venue', sel),
        h('div', { class: 'form-grid' },
          field('Start', input('startDatetime', { type: 'datetime-local', value: toLocalInput(event.startDatetime) })),
          field('End', input('endDatetime', { type: 'datetime-local', value: toLocalInput(event.endDatetime) })),
          field('Expected attendance', input('expectedAttendance', { type: 'number', min: 1, value: er.expectedAttendance || '' }))),
        field('Requirements', h('textarea', { name: 'requirements' }, er.venueRequirements || '')),
      ]);
      const { venues } = await api('/venues', { query: { startDateTime: event.startDatetime, endDateTime: event.endDatetime, minCapacity: er.expectedAttendance, sortBy: 'availability' } });
      clear(sel).appendChild(h('option', { value: '' }, venues.length ? '— choose —' : 'No venue is large enough'));
      venues.forEach((v) => sel.appendChild(h('option', { value: v.id }, `${v.name} · ${v.location} · cap ${v.capacity} · ${v.isAvailable === false ? 'NOT available' : 'available'}`)));
    },
    onSubmit: async (close) => {
      const d = formData(document.querySelector('dialog form'));
      await api(`/events/${event.id}/venue-bookings`, { method: 'POST', body: {
        venueId: d.venueId, startDatetime: fromLocalInput(d.startDatetime), endDatetime: fromLocalInput(d.endDatetime),
        expectedAttendance: d.expectedAttendance ? Number(d.expectedAttendance) : undefined, requirements: d.requirements || null,
      } });
      close();
      toast('Venue booking requested. Venue Staff will review it.', 'ok');
      render();
    },
  });
}

// =====================================================================
// Equipment catalogue (SCRUM-22) and detail (SCRUM-21 AC4)
// =====================================================================
const EQ_STATUS_CHIPS = [['', 'All'], ['available', 'Available'], ['reserved', 'Reserved'], ['in_repair', 'In repair'], ['unavailable', 'Unavailable']];

route('/equipment', async (root) => {
  const q = hashQuery();
  const state = { status: q.get('status') || '', type: q.get('type') || '', search: q.get('search') || '', selectable: q.get('selectable') === 'true' };
  const setQ = (patch) => {
    const next = { ...state, ...patch };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v && v !== 'false'));
    go(`/equipment${qs.toString() ? `?${qs}` : ''}`);
  };
  const [all, filtered] = await Promise.all([
    api('/equipment'),
    api('/equipment', { query: { status: state.status, type: state.type, search: state.search, selectable: state.selectable || undefined } }),
  ]);
  const types = [...new Set(all.equipment.map((e) => e.type))].sort();
  const counts = Object.fromEntries(EQ_STATUS_CHIPS.map(([s]) => [s, s ? all.equipment.filter((e) => e.status === s).length : all.equipment.length]));
  const tech = is('technical_support_staff');

  const searchBox = input('search', { value: state.search, placeholder: 'Name, type, location…' });
  root.append(
    pageHead('Equipment catalogue', 'Only working, unreserved units can be assigned. In-repair and unavailable items are never offered for reservation.',
      tech ? [h('button', { class: 'primary', 'data-tour': 'eq-add', onclick: () => equipmentDialog() }, '+ Add equipment')] : null),
    h('div', { class: 'card', 'data-tour': 'eq-catalogue' },
      h('div', { class: 'filters', style: { marginBottom: '.9rem' } },
        h('div', { class: 'field', style: { minWidth: '100%' }, 'data-tour': 'eq-status-filter' }, h('label', null, 'Status'),
          h('div', { class: 'chips' }, EQ_STATUS_CHIPS.map(([v, t]) => {
            const on = (state.status || '') === v;
            return h('button', { class: `chip ${on ? 'on' : ''}`, onclick: () => setQ({ status: v }) }, `${t} (${counts[v]})`);
          }))),
        h('div', { 'data-tour': 'eq-type-filter' }, field('Type', select('type', [['', 'All types'], ...types.map((t) => [t, t])], state.type, { onchange: (e) => setQ({ type: e.target.value }) }))),
        h('form', { class: 'field', onsubmit: (e) => { e.preventDefault(); setQ({ search: searchBox.value.trim() }); } }, h('label', null, 'Search'), searchBox),
        h('div', { class: 'field', 'data-tour': 'eq-selectable' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.selectable, onchange: (e) => setQ({ selectable: e.target.checked ? 'true' : '' }) }), 'Reservable items only'))),
      table([
        { title: 'Item', render: (e) => h('div', null, h('strong', null, e.name), e.description ? h('div', { class: 'small muted' }, e.description) : null) },
        { title: 'Type', render: (e) => e.type },
        { title: 'Units in service', render: (e) => (e.quantityAvailable === e.quantityTotal ? String(e.quantityTotal) : `${e.quantityAvailable} of ${e.quantityTotal}`) },
        { title: 'Location', render: (e) => e.location || '—' },
        { title: 'Status', render: (e) => pill(e.status) },
        tech ? { title: h('span', { 'data-tour': 'eq-set-status' }, 'Set status'), render: (e) => statusSelect(e) } : null,
      ].filter(Boolean), filtered.equipment, { onRow: (e) => go(`/equipment/${e.id}`), empty: filtered.message || 'No equipment matches these filters.' })));
}, { roles: ['technical_support_staff', 'event_coordinator', 'event_coordinator_lead', 'safety_officer'] });

/** Manual status control. 'reserved' is system-managed, so it is shown but cannot be chosen. */
function statusSelect(e) {
  const sel = h('select', { class: 'small', style: { width: 'auto' }, 'aria-label': `Status of ${e.name}` },
    h('option', { value: 'available', selected: e.status === 'available' || e.status === 'reserved' }, e.status === 'reserved' ? 'In service (reserved)' : 'Available'),
    h('option', { value: 'in_repair', selected: e.status === 'in_repair' }, 'In repair'),
    h('option', { value: 'unavailable', selected: e.status === 'unavailable' }, 'Unavailable'));
  sel.addEventListener('change', async () => {
    try {
      const res = await api(`/equipment/${e.id}/status`, { method: 'PATCH', body: { status: sel.value } });
      toast(`${e.name} is now ${label(res.equipment.status).toLowerCase()}.`, 'ok');
      if (res.warning) setTimeout(() => toast(res.warning, 'error'), 200);
      if (res.readinessRevertedEventIds?.length) setTimeout(() => toast(`Technical readiness went back to pending for ${res.readinessRevertedEventIds.length} event(s).`, 'error'), 400);
      render();
    } catch (err) { toast(err.message, 'error'); render(); }
  });
  return sel;
}

function equipmentDialog(existing) {
  openDialog({
    title: existing ? `Edit ${existing.name}` : 'Add equipment', submitLabel: existing ? 'Save' : 'Add',
    build: (b) => append(b, [
      field('Name', input('name', { required: true, value: existing?.name || '' })),
      h('div', { class: 'form-grid' },
        field('Type', input('type', { required: true, value: existing?.type || '', placeholder: 'e.g. Projector, Audio' })),
        field('Location', input('location', { value: existing?.location || '' }))),
      h('div', { class: 'form-grid' },
        field('Total units', input('quantityTotal', { type: 'number', min: 0, required: true, value: existing?.quantityTotal ?? 1 })),
        field('Units in service', input('quantityAvailable', { type: 'number', min: 0, value: existing?.quantityAvailable ?? '' }), 'Defaults to total units')),
      field('Description', h('textarea', { name: 'description' }, existing?.description || '')),
      existing ? null : field('Status', select('status', [['available', 'Available'], ['in_repair', 'In repair'], ['unavailable', 'Unavailable']], 'available')),
    ]),
    onSubmit: async (close) => {
      const d = formData(document.querySelector('dialog form'));
      const body = { name: d.name, type: d.type, location: d.location || null, description: d.description || null, quantityTotal: Number(d.quantityTotal) };
      if (d.quantityAvailable !== '') body.quantityAvailable = Number(d.quantityAvailable);
      if (d.status) body.status = d.status;
      const res = existing
        ? await api(`/equipment/${existing.id}`, { method: 'PATCH', body })
        : await api('/equipment', { method: 'POST', body });
      close();
      toast(existing ? 'Saved.' : 'Equipment added.', 'ok');
      if (existing) render(); else go(`/equipment/${res.equipment.id}`);
    },
  });
}

route('/equipment/:id', async (root, id) => {
  const { equipment: e, reservations } = await api(`/equipment/${id}`);
  const tech = is('technical_support_staff');
  const blocked = ['in_repair', 'unavailable'].includes(e.status);
  root.appendChild(pageHead(e.name, `${e.type}${e.location ? ` · ${e.location}` : ''}`,
    [pill(e.status), tech ? h('button', { onclick: () => equipmentDialog(e) }, 'Edit') : null,
      tech ? h('button', { class: 'primary', 'data-tour': 'eqd-reserve', onclick: () => reserveForEventDialog(e) }, 'Reserve for an event') : null],
    [['/equipment', 'Equipment'], [null, e.name]]));
  if (blocked) root.appendChild(alertBox('warn', `This item is ${label(e.status).toLowerCase()}. It is hidden from reservation lists and any attempt to reserve it is blocked until it is marked available again.`));
  root.appendChild(h('div', { class: 'grid grid-2' },
    h('div', { class: 'card' }, h('h2', null, 'Details'), h('dl', { class: 'kv' },
      h('dt', null, 'Status'), h('dd', null, pill(e.status)),
      h('dt', null, 'Units'), h('dd', null, `${e.quantityAvailable} in service of ${e.quantityTotal}`),
      h('dt', null, 'Location'), h('dd', null, e.location || '—'),
      h('dt', null, 'Description'), h('dd', null, e.description || '—'),
      h('dt', null, 'Upcoming reservations'), h('dd', null, String(reservations.filter((r) => r.status === 'active').length)))),
    tech ? h('div', { class: 'card', 'data-tour': 'eqd-status' }, h('h2', null, 'Status'),
      h('p', { class: 'small muted' }, '“Reserved” is set automatically while the item has an upcoming reservation, and clears when the last one is cancelled.'),
      h('div', { class: 'actions' },
        ['available', 'in_repair', 'unavailable'].map((s) => h('button', {
          class: (e.status === s || (s === 'available' && e.status === 'reserved')) ? 'primary' : '',
          onclick: async () => {
            try { const res = await api(`/equipment/${e.id}/status`, { method: 'PATCH', body: { status: s } }); toast(`Status: ${label(res.equipment.status)}.`, 'ok'); if (res.warning) setTimeout(() => toast(res.warning, 'error'), 200); if (res.readinessRevertedEventIds?.length) setTimeout(() => toast(`Technical readiness went back to pending for ${res.readinessRevertedEventIds.length} event(s).`, 'error'), 400); render(); }
            catch (err) { toast(err.message, 'error'); }
          },
        }, s === 'available' ? 'In service' : label(s))))) : null));
  root.appendChild(h('div', { class: 'card', 'data-tour': 'eqd-reservations' }, h('h2', null, 'Reservations'), reservationTable(reservations, { showEvent: true, canCancel: tech })));
}, { roles: ['technical_support_staff', 'event_coordinator', 'event_coordinator_lead', 'safety_officer'] });

/** From the equipment page: choose an event, reserve this item for its window. */
function reserveForEventDialog(item) {
  openDialog({
    title: `Reserve ${item.name}`, submitLabel: 'Reserve',
    build: async (b) => {
      const sel = h('select', { name: 'eventId', required: true }, h('option', { value: '' }, 'Loading events…'));
      append(b, [
        ['in_repair', 'unavailable'].includes(item.status) ? alertBox('warn', `${item.name} is ${label(item.status).toLowerCase()} — the reservation will be refused.`) : null,
        field('Event', sel, 'Reserved for the event’s whole time window.'),
        item.quantityAvailable > 1 ? field('Quantity', input('quantity', { type: 'number', min: 1, max: item.quantityAvailable, value: 1 })) : null,
      ]);
      const { events } = await api('/events', { query: { status: 'planning,awaiting_arrangements,confirmed' } });
      clear(sel).appendChild(h('option', { value: '' }, events.length ? '— choose an event —' : 'No upcoming events'));
      events.forEach((ev) => sel.appendChild(h('option', { value: ev.id }, `${eventName(ev)} · ${fmtRange(ev.startDatetime, ev.endDatetime)}`)));
    },
    onSubmit: async (close) => {
      const d = formData(document.querySelector('dialog form'));
      if (!d.eventId) throw new Error('Choose an event.');
      const res = await api(`/events/${d.eventId}/equipment-reservations`, { method: 'POST', body: { equipmentId: item.id, quantity: Number(d.quantity || 1) } });
      close();
      toast(`Reserved for ${res.reservation.eventName}.`, 'ok');
      render();
    },
  });
}

// =====================================================================
// Venues
// =====================================================================
const listText = (v) => (Array.isArray(v) && v.length ? v.map(label).join(', ') : '—');

route('/venues', async (root) => {
  const q = hashQuery();
  const query = Object.fromEntries([...q.entries()].filter(([, v]) => v));
  const { venues, message } = await api('/venues', { query });
  const f = h('form', { class: 'filters', onsubmit: (e) => {
    e.preventDefault();
    const d = formData(f);
    if (d.startDateTime) d.startDateTime = fromLocalInput(d.startDateTime);
    if (d.endDateTime) d.endDateTime = fromLocalInput(d.endDateTime);
    const qs = new URLSearchParams(Object.entries(d).filter(([, v]) => v));
    go(`/venues${qs.toString() ? `?${qs}` : ''}`);
  } },
  field('Search', input('search', { value: q.get('search') || '', placeholder: 'Name or location' })),
  field('Min. capacity', input('minCapacity', { type: 'number', min: 1, value: q.get('minCapacity') || '' })),
  field('Facilities', input('facilities', { value: q.get('facilities') || '', placeholder: 'projector,wifi' })),
  field('From', input('startDateTime', { type: 'datetime-local', value: toLocalInput(q.get('startDateTime')) })),
  field('To', input('endDateTime', { type: 'datetime-local', value: toLocalInput(q.get('endDateTime')) })),
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Search'), h('a', { class: 'btn', href: '#/venues' }, 'Clear')));

  root.append(
    pageHead('Venues', 'Give a date range to check availability (includes setup/turnaround time).',
      is('venue_staff') ? [h('button', { class: 'primary', onclick: () => venueDialog() }, '+ Add venue')] : null),
    h('div', { class: 'card', 'data-tour': 'venues-search' }, f),
    h('div', { class: 'card', 'data-tour': 'venues-list' }, table([
      { title: 'Venue', render: (v) => h('div', null, h('strong', null, v.name), h('div', { class: 'small muted' }, v.location)) },
      { title: 'Type', render: (v) => v.venueType || '—' },
      { title: 'Capacity', render: (v) => v.capacity },
      { title: 'Layouts', render: (v) => listText(v.supportedLayouts) },
      { title: 'Facilities', render: (v) => listText(v.facilities) },
      { title: 'Setup / turnaround', class: 'nowrap', render: (v) => `${v.setupMinutes ?? '—'} / ${v.turnaroundMinutes ?? v.teardownMinutes ?? '—'} min` },
      { title: 'Availability', render: (v) => (v.status && v.status !== 'available' ? pill(v.status) : v.isAvailable === false ? pill('unavailable', 'Unavailable') : pill('available')) },
    ], venues, { empty: message || 'No venues match.' })));
});

function venueDialog() {
  openDialog({
    title: 'Add venue', submitLabel: 'Add venue',
    build: (b) => append(b, [
      h('div', { class: 'form-grid' }, field('Name', input('name', { required: true })), field('Location', input('location', { required: true }))),
      h('div', { class: 'form-grid' }, field('Capacity', input('capacity', { type: 'number', min: 1, required: true })), field('Type', input('venueType', { placeholder: 'e.g. Ballroom' }))),
      field('Supported layouts', input('supportedLayouts', { placeholder: 'theatre,classroom' }), 'Comma-separated'),
      field('Facilities', input('facilities', { placeholder: 'projector,wifi,stage' }), 'Comma-separated'),
      field('Accessibility features', input('accessibilityFeatures', { placeholder: 'wheelchair_access' }), 'Comma-separated'),
      h('div', { class: 'form-grid' }, field('Setup minutes', input('setupMinutes', { type: 'number', min: 0, max: 1440, value: 30 })), field('Turnaround minutes', input('turnaroundMinutes', { type: 'number', min: 0, max: 1440, value: 30 }))),
    ]),
    onSubmit: async (close) => {
      const d = formData(document.querySelector('dialog form'));
      const arr = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
      await api('/venues', { method: 'POST', body: {
        name: d.name, location: d.location, capacity: Number(d.capacity), venueType: d.venueType || null,
        supportedLayouts: arr(d.supportedLayouts), facilities: arr(d.facilities), accessibilityFeatures: arr(d.accessibilityFeatures),
        setupMinutes: Number(d.setupMinutes), turnaroundMinutes: Number(d.turnaroundMinutes),
      } });
      close();
      toast('Venue added.', 'ok');
      render();
    },
  });
}

route('/venue-schedule', async (root) => {
  const q = hashQuery();
  const today = new Date();
  const date = q.get('date') || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const data = await api('/venues/availability', { query: { date } });
  const venues = data.availability || [];
  const picker = input('date', { 'data-tour': 'schedule-date', type: 'date', value: date, onchange: (e) => go(`/venue-schedule?date=${e.target.value}`), style: { width: 'auto' } });
  const legend = h('div', { class: 'legend' }, ['available', 'tentative_hold', 'confirmed_booking', 'temporarily_unavailable'].map((s) => h('span', null, h('i', { class: `tl-${s}` }), label(s))));
  root.append(pageHead('Venue schedule', 'One calendar day (UTC) per row. Each reservation block includes the venue’s setup and turnaround time — hover a block for details.', [picker]),
    h('div', { class: 'card', 'data-tour': 'schedule' }, legend, h('div', { style: { height: '.6rem' } }),
      venues.length ? venues.map((v) => {
        const slots = v.slots || [];
        const total = slots.reduce((s, x) => s + (new Date(x.end || x.endDateTime) - new Date(x.start || x.startDateTime)), 0) || 1;
        const first = slots[0]; const last = slots[slots.length - 1];
        return h('div', { style: { marginBottom: '1rem' } },
          h('div', { class: 'actions', style: { justifyContent: 'space-between' } }, h('strong', null, v.venue?.name), h('span', { class: 'small muted' }, [v.venue?.location, v.venue?.status && v.venue.status !== 'available' ? label(v.venue.status) : null].filter(Boolean).join(' · '))),
          h('div', { class: 'timeline' }, slots.map((s) => {
            const st = s.start || s.startDateTime; const en = s.end || s.endDateTime;
            return h('div', { class: `tl-${s.state}`, style: { flex: `${(new Date(en) - new Date(st)) / total}` }, title: `${s.displayState || label(s.state)}: ${fmtRange(st, en)}${s.eventName ? ` — ${s.eventName}` : ''}` });
          })),
          first ? h('div', { class: 'tl-axis' }, h('span', null, fmtDT(first.start || first.startDateTime)), h('span', null, fmtDT(last.end || last.endDateTime))) : null);
      }) : h('div', { class: 'empty' }, 'No venues.')));
}, { roles: ['venue_staff', 'event_coordinator', 'event_coordinator_lead'] });

route('/venue-bookings', async (root) => {
  const q = hashQuery();
  const status = q.get('status') || 'pending';
  const [vb, reqs] = await Promise.all([
    api('/venue-bookings', { query: status === 'flagged' ? { flagged: true } : { status } }),
    api('/event-requests/booking-requests/pending'),
  ]);
  const chips = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['flagged', 'Conflict flagged'], ['all', 'All']];
  const decide = (b, approve) => (approve
    ? api(`/venue-bookings/${b.id}/approve`, { method: 'POST' }).then(() => { toast('Booking approved.', 'ok'); render(); }).catch((err) => toast(err.message, 'error'))
    : openDialog({
      title: `Reject booking — ${b.Venue?.name}`, submitLabel: 'Reject', danger: true,
      build: (body) => body.appendChild(field('Reason (shared with the coordinator)', h('textarea', { name: 'reason', required: true }))),
      onSubmit: async (close) => {
        await api(`/venue-bookings/${b.id}/reject`, { method: 'POST', body: { reason: document.querySelector('dialog textarea[name=reason]').value } });
        close(); toast('Booking rejected.', 'ok'); render();
      },
    }));
  root.append(pageHead('Booking queue', 'Venue booking requests from Event Coordinators.'),
    h('div', { class: 'card', 'data-tour': 'vb-queue' },
      h('div', { class: 'chips', style: { marginBottom: '.9rem' } }, chips.map(([v, t]) => h('button', { class: `chip ${v === status ? 'on' : ''}`, onclick: () => go(`/venue-bookings?status=${v}`) }, t))),
      table([
        { title: 'Event', render: (b) => h('strong', null, b.Event?.EventRequest?.eventName || '—') },
        { title: 'Venue', render: (b) => b.Venue?.name || '—' },
        { title: 'When', render: (b) => fmtRange(b.startDatetime, b.endDatetime) },
        { title: 'Attendance', render: (b) => b.expectedAttendance },
        { title: 'Requested by', render: (b) => fullName(b.requester) },
        { title: 'Status', render: (b) => [pill(b.status), b.conflictFlaggedAt ? [' ', pill('warn', 'Conflict flagged')] : null] },
        { title: '', render: (b) => (b.status === 'pending' ? h('div', { class: 'actions' },
          h('button', { class: 'small primary', onclick: () => decide(b, true) }, 'Approve'),
          h('button', { class: 'small danger', onclick: () => decide(b, false) }, 'Reject')) : (b.reviewReason || '')) },
      ], vb.bookings, { empty: 'No bookings in this view.' })),
    h('div', { class: 'card', 'data-tour': 'vb-requests' }, h('h2', null, 'Event booking requests awaiting a decision'),
      h('p', { class: 'small muted' }, 'Submitted event requests. A request can only be accepted once every operational detail is provided.'),
      table([
        { title: 'Event', render: (r) => h('strong', null, r.eventName) },
        { title: 'Organiser', render: (r) => fullName(r.organiser) },
        { title: 'When', render: (r) => fmtRange(r.preferredStart, r.preferredEnd) },
        { title: 'Ready?', render: (r) => (r.isReadyForApproval ? pill('ok', 'Complete') : h('div', null, pill('warn', 'Incomplete'), h('div', { class: 'small muted' }, `Missing: ${r.missingDetails.join(', ')}`))) },
        { title: '', render: (r) => h('div', { class: 'actions' },
          h('button', { class: 'small primary', disabled: !r.isReadyForApproval, onclick: async () => {
            try { await api(`/event-requests/${r.id}/status`, { method: 'PATCH', body: { status: 'approved' } }); toast('Request accepted.', 'ok'); render(); } catch (err) { toast(err.message, 'error'); }
          } }, 'Accept'),
          h('button', { class: 'small danger', onclick: () => openDialog({
            title: `Reject — ${r.eventName}`, submitLabel: 'Reject', danger: true,
            build: (body) => body.appendChild(field('Reason', h('textarea', { name: 'reviewReason', required: true }))),
            onSubmit: async (close) => {
              await api(`/event-requests/${r.id}/status`, { method: 'PATCH', body: { status: 'rejected', reviewReason: document.querySelector('dialog textarea[name=reviewReason]').value } });
              close(); toast('Request rejected.', 'ok'); render();
            },
          }) }, 'Reject')) },
      ], reqs.eventRequests, { empty: 'No event requests awaiting a decision.' })));
}, { roles: ['venue_staff'] });

// =====================================================================
// Notifications, profile
// =====================================================================
route('/notifications', async (root) => {
  const { notifications } = await api('/notifications');
  const unread = notifications.filter((n) => !n.readAt);
  root.append(pageHead('Notifications', `${unread.length} unread`,
    unread.length ? [h('button', { onclick: async () => { await Promise.all(unread.map((n) => api(`/notifications/${n.id}/read`, { method: 'PATCH' }))); render(); } }, 'Mark all as read')] : null),
  h('div', { class: 'card', 'data-tour': 'notifications' }, table([
    { title: '', render: (n) => (n.readAt ? '' : pill('active', 'New')) },
    { title: 'Message', render: (n) => h('div', null, n.message, h('div', { class: 'small muted' }, label(n.type))) },
    { title: 'When', class: 'nowrap', render: (n) => fmtDT(n.created_at || n.createdAt) },
    { title: '', render: (n) => h('div', { class: 'actions' },
      n.eventId && is('technical_support_staff', 'event_coordinator', 'event_coordinator_lead', 'safety_officer') ? h('a', { class: 'btn small', href: `#/events/${n.eventId}` }, 'Open event') : null,
      n.readAt ? null : h('button', { class: 'small', onclick: async () => { await api(`/notifications/${n.id}/read`, { method: 'PATCH' }); render(); } }, 'Mark read')) },
  ], notifications, { empty: 'You have no notifications.', rowClass: (n) => (n.readAt ? 'dim' : '') })));
});

route('/profile', async (root) => {
  const { attendee: a } = await api('/attendees/profile');
  const errorSlot = h('div');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    clear(errorSlot);
    const d = formData(form);
    const body = {};
    for (const k of ['firstName', 'lastName', 'phone', 'organization']) if ((d[k] || '') !== (a[k] || '')) body[k] = d[k];
    if (!Object.keys(body).length) return toast('Nothing to save.');
    try {
      const res = await api('/attendees/profile', { method: 'PATCH', body });
      const u = session.user; session.set(null, { ...u, firstName: res.attendee?.firstName || u.firstName, lastName: res.attendee?.lastName || u.lastName });
      toast('Profile saved.', 'ok'); render();
    } catch (err) { errorSlot.appendChild(errorBox(err)); }
  } },
  errorSlot,
  h('div', { class: 'form-grid' }, field('First name', input('firstName', { value: a.firstName || '' })), field('Last name', input('lastName', { value: a.lastName || '' }))),
  h('div', { class: 'form-grid' }, field('Phone', input('phone', { value: a.phone || '' })), field('Organisation', input('organization', { value: a.organization || '' }))),
  field('Email', input('email', { value: a.email, disabled: true })),
  h('button', { class: 'primary', type: 'submit' }, 'Save profile'));
  root.append(pageHead('My profile'), h('div', { class: 'card', style: { maxWidth: '640px' }, 'data-tour': 'profile' }, form));
}, { roles: ['attendee'] });

// =====================================================================
// Boot — after every script (incl. tutorial.js, which adds routes) has loaded.
// =====================================================================
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
else setTimeout(render, 0);
