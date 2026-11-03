/* ConnectSphere — tutorial system.
 *
 * 1. Guided tours: a spotlight + popover that walks through real screens,
 *    navigating between pages as needed. Tours never change data — they
 *    point things out and the user acts afterwards.
 * 2. Help page (#/help): every tour for the user's role, written quick
 *    guides, a status glossary and FAQs.
 *
 * The "Getting started" tour for the user's role starts automatically on
 * their first sign-in (remembered per user in localStorage) and can be
 * replayed from Help at any time.
 *
 * Loaded after app.js and uses its helpers (h, api, go, route, ...).
 */
'use strict';

// =====================================================================
// Progress storage (per user, per browser)
// =====================================================================
const tourStore = {
  key() { return `cs_tours_${session.user?.id || 'anon'}`; },
  read() { try { return JSON.parse(localStorage.getItem(this.key())) || { done: [], autoShown: false }; } catch { return { done: [], autoShown: false }; } },
  write(v) { try { localStorage.setItem(this.key(), JSON.stringify(v)); } catch { /* storage unavailable: tours still work */ } },
  markDone(id) { const v = this.read(); if (!v.done.includes(id)) v.done.push(id); this.write(v); },
  isDone(id) { return this.read().done.includes(id); },
  markAutoShown() { const v = this.read(); v.autoShown = true; this.write(v); },
  reset() { this.write({ done: [], autoShown: true }); },
};

// =====================================================================
// Route helpers used by tour steps (read-only API lookups)
// =====================================================================
const LIVE = 'planning,awaiting_arrangements,confirmed';
async function firstLiveEventPath() {
  try {
    const { events } = await api('/events', { query: { status: LIVE } });
    return events.length ? `/events/${events[0].id}` : '/events';
  } catch { return '/events'; }
}
async function equipmentPathWithStatus(status) {
  try {
    const { equipment } = await api('/equipment', { query: status ? { status } : {} });
    return equipment.length ? `/equipment/${equipment[0].id}` : '/equipment';
  } catch { return '/equipment'; }
}
async function equipmentPathWithReservation() {
  try {
    const { reservations } = await api('/equipment-reservations', { query: { status: 'active' } });
    return reservations.length ? `/equipment/${reservations[0].equipmentId}` : equipmentPathWithStatus('');
  } catch { return '/equipment'; }
}

// =====================================================================
// Tour content
// =====================================================================
// step: { route?: string | () => Promise<string>, target?: data-tour id,
//         title, body: string | string[], placement?: 'auto' | 'center' }
const helpStep = { target: 'help-button', title: 'Replay any time', body: 'Open Help to replay this tour, start the feature tutorials, or read the written guides and FAQs.' };
const notifStep = { target: 'nav-notifications', title: 'Notifications', body: 'Approvals, assignments, booking decisions, reservations and other changes that affect you appear here. The badge shows how many are unread.' };

const TOURS = {
  // ---------------- Technical Support Staff ----------------
  'tech-start': {
    role: 'technical_support_staff', title: 'Getting started', summary: 'Where everything is for Technical Support Staff.', auto: true,
    steps: [
      { title: 'Welcome to ConnectSphere', body: ['You look after equipment: keeping the catalogue’s status accurate, reserving items for approved events, and confirming each event is technically ready.', 'This one-minute tour shows where everything lives. Use the arrow keys or the buttons below.'] },
      { route: '/', target: 'dash-stats', title: 'Your dashboard', body: 'At-a-glance counts: available, reserved and out-of-service items, and events still waiting for technical readiness. Click a number to jump straight to that list.' },
      { target: 'nav-equipment', title: 'Equipment catalogue', body: 'Every item, its status and its reservations. You can add items and mark them in repair or unavailable here.' },
      { target: 'nav-events', title: 'Events & reservations', body: 'Approved events. Open one to reserve equipment for its time window and to complete technical readiness.' },
      notifStep,
      helpStep,
      { title: 'Next: the feature tutorials', body: ['Three short tutorials cover your main jobs:', '• Manage equipment status (SCRUM-22)', '• Reserve equipment for an event (SCRUM-21)', '• Complete technical readiness (SCRUM-24)', 'Start them from Help & tutorials.'] },
    ],
  },
  'tech-status': {
    role: 'technical_support_staff', title: 'Manage equipment status', story: 'SCRUM-22', summary: 'Filter the catalogue by status and take items out of service.',
    steps: [
      { route: '/equipment', target: 'eq-status-filter', title: 'Filter by status', body: 'Each chip shows how many items have that status. “Available” shows only working, unreserved items; “In repair” and “Unavailable” show what is out of service.' },
      { target: 'eq-type-filter', title: 'Narrow it down', body: 'Combine the status filter with a type (e.g. Projector) or a search on name, type, description or location.' },
      { target: 'eq-selectable', title: 'Reservable items only', body: 'Shows exactly what a reservation picker would offer: items in repair, unavailable, or with no units in service are left out.' },
      { target: 'eq-set-status', title: 'Change an item’s status', body: ['Use this column to mark an item In repair or Unavailable, or put it back in service.', '“Reserved” is never set by hand. It turns on while an item has an upcoming reservation and clears when the last one ends or is cancelled.'] },
      { route: () => equipmentPathWithStatus('in_repair'), target: 'eqd-status', title: 'Out-of-service items are protected', body: ['An item in repair or unavailable disappears from every reservation list, and any attempt to reserve it is blocked with an error.', 'If it already had reservations, they are kept so you can swap in a replacement. The coordinator is notified, and technical readiness goes back to pending if it depended on this item.'] },
      { title: 'That’s SCRUM-22', body: 'Try it: open an available item, mark it In repair, then look for it in an event’s “Reserve equipment” picker. It won’t be there.' },
    ],
  },
  'tech-reserve': {
    role: 'technical_support_staff', title: 'Reserve equipment for an event', story: 'SCRUM-21', summary: 'Reserve items for an approved event’s time window without double-booking.',
    steps: [
      { route: '/events?status=live', target: 'events-list', title: 'Pick an approved event', body: 'Only events that are planning, awaiting arrangements or confirmed can have equipment reserved. Completed and cancelled events cannot.' },
      { route: firstLiveEventPath, target: 'ev-overview', title: 'The event’s time window', body: 'A reservation covers this window by default. You can also reserve for a slot inside it, such as one session.' },
      { target: 'ev-reserve', title: 'Reserve equipment', body: ['This opens the reservation form. The item list only shows working items with free units in the chosen window.', 'Reserving switches the item from Available to Reserved.'] },
      { target: 'ev-reservations', title: 'Reservation records', body: 'Every reservation records the event, the item, the organiser’s name, when it was made and by whom. Cancel releases the item. It goes back to Available if nothing else holds it, and the cancelled record is kept.' },
      { route: equipmentPathWithReservation, target: 'eqd-reservations', title: 'Also on the equipment page', body: 'The same reservations appear on each item’s page, so you can see everywhere it is committed.' },
      { title: 'No double-booking', body: ['If the item is already reserved for an overlapping time, the reservation is refused with a conflict message naming the clashing event.', 'Back-to-back times (one ends at 12:00, the next starts at 12:00) are fine.'] },
    ],
  },
  'tech-readiness': {
    role: 'technical_support_staff', title: 'Complete technical readiness', story: 'SCRUM-24', summary: 'Allocate every requested item by time slot, then mark the event ready.',
    steps: [
      { route: firstLiveEventPath, target: 'ev-requests', title: 'What the event needs', body: 'Each line is a requirement, such as “2 × Projector” or a specific mic set. The bar shows how much has been allocated. Allocate opens the reservation form pre-linked to that line.' },
      { target: 'ev-add-line', title: 'Add a requirement', body: 'Coordinators usually record needs, but you can add lines too: a type, a quantity, an optional specific item and any technical notes.' },
      { target: 'ev-readiness', title: 'Technical readiness', body: ['Readiness can only be marked complete when every line is fully allocated. Until then this card lists exactly what is missing.', 'If a covering reservation is later cancelled, its item goes into repair, or a new line is added, readiness drops back to pending automatically.'] },
      { title: 'Time slots only, no travel time', body: 'Equipment is allocated purely by time slot. No travel or buffer time is added between venues, so an item can go from a 9–12 event at one venue to a 12–3 event at another.' },
    ],
  },

  // ---------------- Event Coordinator ----------------
  'coord-start': {
    role: 'event_coordinator', title: 'Getting started', summary: 'Review requests and plan your events.', auto: true,
    steps: [
      { title: 'Welcome, Coordinator', body: 'You review event requests assigned to you, then plan each approved event: book a venue and record the equipment it needs.' },
      { route: '/', target: 'dash-stats', title: 'Your dashboard', body: 'Requests waiting for your review, your active events, and events not yet technically ready. Click any number to open that list.' },
      { route: '/review', target: 'review-list', title: 'Review queue', body: 'Submitted requests assigned to you. Open one to Approve, Return it for amendment, or Reject it with a reason. Approving creates the event so planning can start.' },
      { route: firstLiveEventPath, target: 'ev-venues', title: 'Book a venue', body: '“Request a venue” lists venues big enough for the attendance and shows which are free once setup/turnaround time is included. Venue Staff then approve or reject it.' },
      { target: 'ev-requests', title: 'Record equipment needs', body: 'Add requirements such as “2 × Projector”. Technical Support reserves items against them and marks the event technically ready once all are allocated.' },
      { route: '/venue-schedule', target: 'schedule', title: 'Venue schedule', body: 'Every venue’s day at a glance: tentative holds, confirmed bookings and unavailable periods, with setup/turnaround included.' },
      notifStep,
      helpStep,
    ],
  },

  // ---------------- Event Organiser ----------------
  'org-start': {
    role: 'event_organiser', title: 'Getting started', summary: 'Draft, save and submit an event request.', auto: true,
    steps: [
      { title: 'Welcome to ConnectSphere', body: 'Tell ConnectSphere about your event, and follow it from draft to approval.' },
      { route: '/', target: 'dash-stats', title: 'Your requests at a glance', body: 'Drafts, requests awaiting review, approved requests, and ones returned for changes.' },
      { route: '/requests/new', target: 'req-form', title: 'Create a request', body: 'Fill in what you know: name, dates, attendance, venue, accessibility and equipment needs. You don’t need everything at once.' },
      { target: 'req-actions', title: 'Save a draft or submit', body: ['“Save draft” keeps it private so you can come back later.', '“Save & submit” sends it for review, but only once every field is filled in. You’ll be told exactly what’s missing.'] },
      { route: '/requests', target: 'req-list', title: 'Track your requests', body: 'Every request with its status: Draft, Submitted, Under review, Approved, Returned or Rejected. Click one to open it. Drafts stay editable.' },
      { target: 'nav-venues', title: 'Browse venues', body: 'See ConnectSphere venues, their capacity and facilities, and check availability for your dates.' },
      notifStep,
      helpStep,
    ],
  },

  // ---------------- Event Coordinator Lead ----------------
  'lead-start': {
    role: 'event_coordinator_lead', title: 'Getting started', summary: 'Assign requests and oversee active events.', auto: true,
    steps: [
      { title: 'Welcome, Coordinator Lead', body: 'You make sure every submitted request has an Event Coordinator, and you oversee active events.' },
      { route: '/', target: 'dash-stats', title: 'Your dashboard', body: 'Unassigned requests and active events. Click a number to open the list.' },
      { route: '/assign', target: 'assign-unassigned', title: 'Assign a coordinator', body: 'Pick a coordinator and press Assign. They get notified and the request appears in their review queue. Every Lead sees the same queue.' },
      { target: 'assign-current', title: 'Reassign when needed', body: 'If availability or responsibilities change, reassign a request or event here.' },
      { target: 'nav-events', title: 'Oversee events', body: 'All events with their status and technical readiness, including equipment reservations.' },
      helpStep,
    ],
  },

  // ---------------- Venue Staff ----------------
  'venue-start': {
    role: 'venue_staff', title: 'Getting started', summary: 'Decide bookings and keep venue schedules accurate.', auto: true,
    steps: [
      { title: 'Welcome, Venue Staff', body: 'You decide venue booking requests and keep venue information and availability accurate.' },
      { route: '/venue-bookings', target: 'vb-queue', title: 'Booking queue', body: ['Approve or reject coordinators’ venue requests. Every approval is re-checked against the latest schedule first, so a clash is caught even if something changed since the request.', 'A rejection needs a reason, which is sent to the coordinator.'] },
      { target: 'vb-requests', title: 'Event booking requests', body: 'Submitted event requests waiting for a booking decision. You can only accept one once every operational detail is provided. Missing details are listed.' },
      { route: '/venue-schedule', target: 'schedule', title: 'Venue schedule', body: 'Each venue’s day: tentative holds, confirmed bookings and unavailable periods. Setup and turnaround time are included in each block. Hover a block for details.' },
      { target: 'schedule-date', title: 'Pick a day', body: 'Change the date to check any day’s schedule.' },
      { route: '/venues', target: 'venues-search', title: 'Venue catalogue', body: 'Search venues, check availability for a time range, and add new venues with their capacity, layouts, facilities and setup/turnaround minutes.' },
      helpStep,
    ],
  },

  // ---------------- Safety Officer ----------------
  'safety-start': {
    role: 'safety_officer', title: 'Getting started', summary: 'Read-only access to events, venues and equipment.', auto: true,
    steps: [
      { title: 'Welcome, Safety Officer', body: 'You have read-only access to event planning information for safety checks. Nothing you open here can be changed by mistake.' },
      { route: '/events?status=live', target: 'events-list', title: 'Events', body: 'Open any event to see its time window, venue, coordinator, equipment requirements and reservations.' },
      { target: 'nav-equipment', title: 'Equipment', body: 'The catalogue with each item’s status, including what is in repair or unavailable.' },
      { target: 'nav-venues', title: 'Venues', body: 'Capacity, layouts, facilities and accessibility features of every venue.' },
      helpStep,
    ],
  },

  // ---------------- Attendee ----------------
  'attendee-start': {
    role: 'attendee', title: 'Getting started', summary: 'Your profile and notifications.', auto: true,
    steps: [
      { title: 'Welcome to ConnectSphere', body: 'Keep your details up to date so event organisers can reach you.' },
      { route: '/profile', target: 'profile', title: 'Your profile', body: 'Update your name, phone and organisation. Your email is your sign-in and can’t be changed here.' },
      { target: 'nav-venues', title: 'Venues', body: 'Browse ConnectSphere venues and their facilities.' },
      notifStep,
      helpStep,
    ],
  },
};

const toursForRole = (r) => Object.entries(TOURS).filter(([, t]) => t.role === r).map(([id, t]) => ({ id, ...t }));

// =====================================================================
// Tour engine
// =====================================================================
const tour = { id: null, index: 0, els: null, target: null, token: 0 };

const currentPath = () => location.hash.replace(/^#/, '') || '/';
const samePath = (a, b) => a.split('?')[0] === b.split('?')[0] && (!b.includes('?') || a === b);

function waitFor(selector, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    (function poll() {
      const el = selector ? document.querySelector(selector) : null;
      // Wait until the page has finished loading (no "Loading…" placeholder).
      const loading = document.querySelector('#main > p.muted');
      if (el && !loading) return resolve(el);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(poll, 80);
    }());
  });
}

function ensureTourEls() {
  if (tour.els) return tour.els;
  const blocker = h('div', { class: 'tour-blocker', onclick: (e) => e.stopPropagation() });
  const spot = h('div', { class: 'tour-spot' });
  const pop = h('div', { class: 'tour-pop', role: 'dialog', 'aria-modal': 'true', 'aria-live': 'polite' });
  document.body.append(blocker, spot, pop);
  tour.els = { blocker, spot, pop };
  window.addEventListener('resize', positionTour);
  window.addEventListener('scroll', positionTour, true);
  document.addEventListener('keydown', onTourKey);
  return tour.els;
}

function removeTourEls() {
  if (!tour.els) return;
  Object.values(tour.els).forEach((el) => el.remove());
  tour.els = null;
  window.removeEventListener('resize', positionTour);
  window.removeEventListener('scroll', positionTour, true);
  document.removeEventListener('keydown', onTourKey);
}

function onTourKey(e) {
  if (!tour.id) return;
  if (e.key === 'Escape') endTour(false);
  else if (e.key === 'ArrowRight') tourNext();
  else if (e.key === 'ArrowLeft') tourBack();
}

function isUsable(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  // On small screens the sidebar is off-canvas; point at the menu instead.
  if (el.closest('.side') && window.innerWidth <= 860) return false;
  return true;
}

function positionTour() {
  if (!tour.els) return;
  const { spot, pop } = tour.els;
  const el = tour.target;
  const vw = window.innerWidth; const vh = window.innerHeight;
  const mobile = vw <= 640;
  if (!isUsable(el)) {
    spot.classList.add('none');
    pop.classList.add('centered');
    pop.style.left = ''; pop.style.top = '';
    return;
  }
  spot.classList.remove('none');
  pop.classList.remove('centered');
  const pad = 6;
  const r = el.getBoundingClientRect();
  const top = Math.max(r.top - pad, 4);
  const left = Math.max(r.left - pad, 4);
  const height = Math.min(r.height + pad * 2, vh - top - 4);
  Object.assign(spot.style, { top: `${top}px`, left: `${left}px`, width: `${Math.min(r.width + pad * 2, vw - left - 4)}px`, height: `${height}px` });
  if (mobile) { pop.style.left = ''; pop.style.top = ''; pop.classList.add('sheet'); return; }
  pop.classList.remove('sheet');
  const pw = pop.offsetWidth; const ph = pop.offsetHeight; const gap = 12;
  let y;
  if (r.bottom + gap + ph < vh) y = r.bottom + gap;
  else if (r.top - gap - ph > 0) y = r.top - gap - ph;
  else y = Math.max(8, Math.min(vh - ph - 8, r.top + 20));
  let x = r.left;
  // Sidebar items: put the popover to the right of the sidebar.
  if (el.closest('.side')) { x = r.right + gap; y = Math.max(8, Math.min(vh - ph - 8, r.top - 10)); }
  x = Math.max(8, Math.min(vw - pw - 8, x));
  pop.style.left = `${x}px`; pop.style.top = `${y}px`;
}

async function showTourStep(index) {
  const t = TOURS[tour.id];
  if (!t) return endTour(false);
  tour.index = index;
  const step = t.steps[index];
  const token = ++tour.token;
  const { pop } = ensureTourEls();
  clear(pop).appendChild(h('div', { class: 'tour-body' }, h('p', { class: 'muted' }, 'Loading…')));

  if (step.route) {
    const path = typeof step.route === 'function' ? await step.route() : step.route;
    if (token !== tour.token) return;
    if (!samePath(currentPath(), path)) go(path);
  }
  let el = null;
  if (step.target) {
    el = await waitFor(`[data-tour="${step.target}"]`);
    if (token !== tour.token) return;
    if (el && isUsable(el)) {
      el.scrollIntoView({ block: el.getBoundingClientRect().height > window.innerHeight * 0.6 ? 'start' : 'center', behavior: 'auto' });
    }
  }
  tour.target = el;

  const paragraphs = Array.isArray(step.body) ? step.body : [step.body];
  const last = index === t.steps.length - 1;
  clear(pop).append(
    h('div', { class: 'tour-top' },
      h('span', { class: 'tour-count' }, `${t.story ? `${t.story} · ` : ''}Step ${index + 1} of ${t.steps.length}`),
      h('button', { class: 'x', 'aria-label': 'Close tutorial', onclick: () => endTour(false) }, '×')),
    h('h3', null, step.title),
    h('div', { class: 'tour-body' }, paragraphs.map((p) => h('p', null, p)),
      step.target && !el ? h('p', { class: 'small muted' }, 'This part of the screen isn’t available right now (for example, there is no matching record yet), so here’s the explanation on its own.') : null),
    h('div', { class: 'tour-dots' }, t.steps.map((_, i) => h('span', { class: i === index ? 'on' : (i < index ? 'past' : '') }))),
    h('div', { class: 'tour-actions' },
      h('button', { class: 'small', onclick: () => endTour(false) }, 'Skip tour'),
      h('span', { style: { flex: 1 } }),
      index > 0 ? h('button', { class: 'small', onclick: tourBack }, 'Back') : null,
      h('button', { class: 'small primary', onclick: tourNext, 'data-autofocus': 'true' }, last ? 'Finish' : 'Next')),
  );
  positionTour();
  requestAnimationFrame(positionTour);
  pop.querySelector('[data-autofocus]')?.focus({ preventScroll: true });
}

function tourNext() {
  const t = TOURS[tour.id];
  if (!t) return;
  if (tour.index >= t.steps.length - 1) return endTour(true);
  showTourStep(tour.index + 1);
}
function tourBack() { if (tour.index > 0) showTourStep(tour.index - 1); }

function startTour(id) {
  if (!TOURS[id]) return;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  document.querySelector('.shell')?.classList.remove('nav-open');
  tour.id = id;
  tourStore.markAutoShown();
  showTourStep(0);
}

function endTour(completed) {
  const id = tour.id;
  tour.id = null;
  tour.token += 1;
  tour.target = null;
  removeTourEls();
  if (!id) return;
  if (completed) {
    tourStore.markDone(id);
    toast(`Tutorial complete: ${TOURS[id].title}.`, 'ok');
  } else {
    toast('Tutorial closed. You can restart it any time from Help & tutorials.');
  }
  if (currentPath().startsWith('/help')) render();
}

// Called by app.js after every page render. Starts the role's
// "Getting started" tour on a user's first sign-in.
function onPageRendered() {
  if (tour.id || !session.user) return;
  const state = tourStore.read();
  if (state.autoShown) return;
  const first = toursForRole(session.user.role).find((t) => t.auto);
  if (!first) return;
  tourStore.markAutoShown();
  setTimeout(() => { if (!tour.id) startTour(first.id); }, 500);
}

// =====================================================================
// Help page
// =====================================================================
const QUICK_GUIDES = {
  technical_support_staff: [
    ['Reserve equipment for an event (SCRUM-21)', ['Open Events & reservations and choose an upcoming event.', 'Press “+ Reserve equipment” (or “Allocate” on a requirement line).', 'Keep “Whole event” or choose a time slot inside the event.', 'Pick an item from the list (only free, working items appear) and a quantity, then press Reserve.', 'To release it, press Cancel on the reservation and give an optional reason.']],
    ['Mark an item in repair or unavailable (SCRUM-22)', ['Open Equipment catalogue.', 'In the item’s “Set status” column choose In repair or Unavailable. Or open the item and use the Status buttons.', 'To bring it back, choose Available / In service. It shows as Reserved again if it still has upcoming reservations.']],
    ['Complete technical readiness (SCRUM-24)', ['Open the event and check “Equipment requested”.', 'Press Allocate on each line until every bar is full.', 'Press “Mark technical readiness complete”. If anything is missing, the card lists it.']],
  ],
  event_coordinator: [
    ['Review a request', ['Open Review queue and click a request.', 'Approve to create the event, Return to ask the organiser for changes, or Reject with a reason.']],
    ['Book a venue', ['Open My events, then the event.', 'Press “+ Request a venue”, choose a venue marked available, check the times and attendance, then Send request.', 'Venue Staff approve or reject it. You’ll get a notification.']],
    ['Record equipment needs', ['On the event page press “+ Add requirement”.', 'Enter a type (e.g. Projector) or choose a specific item, the quantity and any technical notes.']],
  ],
  event_organiser: [
    ['Create and submit a request', ['Press New request.', 'Fill in what you know and press “Save draft” to come back later.', 'When everything is filled in, press “Submit for review”. If something is missing, you’ll see a list.']],
    ['Check progress', ['Open My event requests to see each request’s status.', 'Returned requests include a note explaining what to change.']],
  ],
  event_coordinator_lead: [
    ['Assign a request', ['Open Assign requests.', 'Pick a coordinator next to the request and press Assign.']],
    ['Reassign', ['Under “Current assignments”, choose another coordinator and press Reassign.']],
  ],
  venue_staff: [
    ['Decide a venue booking', ['Open Booking queue (Pending).', 'Press Approve, or Reject and give a reason.', 'An approval is refused if the venue is no longer free. The reason is shown.']],
    ['Check a venue’s day', ['Open Venue schedule and pick a date.', 'Hover a coloured block to see what occupies it.']],
    ['Add a venue', ['Open Venues and press “+ Add venue”.', 'Enter capacity, layouts, facilities and setup/turnaround minutes.']],
  ],
  safety_officer: [['Inspect an event', ['Open Events and click an event to see its venue, equipment requirements and reservations.']]],
  attendee: [['Update your details', ['Open My profile, change your details and press Save profile.']]],
};

const FAQ = [
  ['Why isn’t an item in the reservation list?', 'The list only offers working items with a free unit in the chosen time. Items that are in repair, unavailable, or already reserved for an overlapping time are hidden. The “Reservable items only” filter in the catalogue shows the same thing.', ['technical_support_staff', 'event_coordinator', 'event_coordinator_lead', 'safety_officer']],
  ['What does “Reserved” mean?', 'The item has at least one upcoming reservation. It can still be reserved for a different, non-overlapping time slot. It goes back to Available automatically when its reservations end or are cancelled.', ['technical_support_staff', 'event_coordinator', 'event_coordinator_lead', 'safety_officer']],
  ['Why can’t I mark technical readiness complete?', 'Every equipment requirement must be fully allocated first. The readiness card lists what is missing. Reservations on items that have since gone into repair don’t count.', ['technical_support_staff', 'event_coordinator']],
  ['Is travel time added between venues?', 'Not for equipment. It is allocated purely by time slot. Venues do have their own setup and turnaround time, which is applied to venue bookings.', ['technical_support_staff', 'event_coordinator', 'venue_staff']],
  ['Why was my request returned?', 'Your coordinator needs changes. Open the request to see their note.', ['event_organiser']],
  ['Why can’t I submit my request?', 'Every field must be filled in before submitting. The message lists exactly what is missing. Your draft is saved either way.', ['event_organiser']],
  ['My session expired. Did I lose my work?', 'Saved drafts are kept on the server. Sign in again and open My event requests.', null],
];

route('/help', async (root) => {
  const r = role();
  const tours = toursForRole(r);
  const store = tourStore.read();
  root.appendChild(pageHead('Help & tutorials', `Guides for ${ROLE_LABELS[r] || r}.`, [
    h('button', { onclick: () => { tourStore.reset(); toast('Tutorial progress reset.'); render(); } }, 'Reset progress'),
  ]));
  root.appendChild(h('div', { class: 'card' }, h('h2', null, 'Interactive tutorials'),
    h('p', { class: 'small muted' }, 'Each tutorial highlights the real screen step by step. Tutorials never change any data. Press Esc to leave at any time.'),
    h('div', { class: 'tour-cards' }, tours.map((t) => {
      const done = store.done.includes(t.id);
      return h('div', { class: 'tour-card' },
        h('div', null,
          h('div', { class: 'actions' }, h('strong', null, t.title), t.story ? pill('planning', t.story) : null, done ? pill('complete', 'Done') : null),
          h('p', { class: 'small muted', style: { margin: '.3rem 0 0' } }, `${t.summary} · ${t.steps.length} steps`)),
        h('button', { class: done ? '' : 'primary', 'data-tour-start': t.id, onclick: () => startTour(t.id) }, done ? 'Replay' : 'Start'));
    }))));
  const guides = QUICK_GUIDES[r] || [];
  if (guides.length) {
    root.appendChild(h('div', { class: 'card' }, h('h2', null, 'Quick guides'),
      h('div', { class: 'grid grid-2' }, guides.map(([title, steps]) => h('div', { class: 'guide' }, h('h3', null, title), h('ol', null, steps.map((s) => h('li', null, s))))))));
  }
  const glossary = r === 'technical_support_staff' || r === 'safety_officer' || r === 'event_coordinator' || r === 'event_coordinator_lead'
    ? [['available', 'Working, no upcoming reservation'], ['reserved', 'Has an upcoming reservation (set automatically)'], ['in_repair', 'Being repaired: hidden from reservation lists'], ['unavailable', 'Out of service: hidden from reservation lists']]
    : [['draft', 'Only you can see it'], ['submitted', 'Waiting for review'], ['approved', 'Accepted: planning has started'], ['returned', 'Changes requested'], ['rejected', 'Not going ahead']];
  root.appendChild(h('div', { class: 'grid grid-2' },
    h('div', { class: 'card' }, h('h2', null, 'Status glossary'), h('dl', { class: 'kv' }, glossary.map(([s, t]) => [h('dt', null, pill(s)), h('dd', null, t)]))),
    h('div', { class: 'card' }, h('h2', null, 'FAQ'), FAQ.filter(([, , roles]) => !roles || roles.includes(r)).map(([q, a]) => h('details', { class: 'faq' }, h('summary', null, q), h('p', null, a))))));
});
