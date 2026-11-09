/* FLOW service worker
   - Offline: app shell is cached; the page itself is network-first so new deploys show up immediately.
   - Notifications: clicking one focuses / opens FLOW.
   - Periodic Background Sync (installed app, Chromium): checks today's unfinished
     routines while FLOW is closed, using the snapshot the page stores in Cache Storage. */
const VERSION = 'flow-v2';
const SHELL = ['./', './index.html', './manifest.json', './logo.svg', './vendor/jspdf.umd.min.js'];
const REM_CACHE = 'flow-reminders';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== REM_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !fonts) return;
  if (url.pathname.endsWith('/__reminders.json')) return;

  // stale-while-revalidate
  e.respondWith(
    caches.open(VERSION).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    }))
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./');
    })
  );
});

/* ---------- background reminders ---------- */
const pad = n => String(n).padStart(2, '0');
const dateKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const mins = t => { const p = t.split(':').map(Number); return p[0] * 60 + p[1]; };

async function readJSON(cache, key) {
  const r = await cache.match(key);
  if (!r) return null;
  try { return await r.json(); } catch (e) { return null; }
}

async function checkReminders() {
  const cache = await caches.open(REM_CACHE);
  const snap = await readJSON(cache, './__reminders.json');
  if (!snap || !snap.enabled) return;

  const now = new Date(), tk = dateKey(now), dow = now.getDay();
  const nowM = now.getHours() * 60 + now.getMinutes();
  const sameDay = snap.date === tk;
  const done = new Set(sameDay ? snap.done : []);
  const skipped = new Set(sameDay ? (snap.skipped || []) : []);

  let swFired = await readJSON(cache, './__sw-fired.json');
  if (!swFired || swFired.date !== tk) swFired = { date: tk, ids: [] };
  const fired = new Set([].concat(sameDay ? snap.fired : [], swFired.ids));

  const pending = snap.routines.filter(r =>
    r.createdKey <= tk && (!r.days || r.days.indexOf(dow) !== -1) && !done.has(r.id) && !skipped.has(r.id));
  if (!pending.length) return;

  const show = (title, body, tag) => self.registration.showNotification(title, {
    body, tag, icon: './logo.svg', badge: './logo.svg', data: { url: './' } });

  for (const r of pending) {
    if (!r.remindAt || fired.has(r.id)) continue;
    const m = mins(r.remindAt);
    if (nowM < m || nowM - m > 180) continue;
    const left = pending.length - 1;
    await show('⏰ ' + r.name,
      'Still pending today. ' + (left ? left + ' more routine' + (left === 1 ? '' : 's') + ' left today.' : 'This is the last one for today!'),
      'flow-r-' + r.id);
    swFired.ids.push(r.id);
  }
  if (snap.checkin && !fired.has('checkin') && nowM >= mins(snap.checkin)) {
    const names = pending.map(r => r.name);
    await show(pending.length + ' routine' + (pending.length === 1 ? '' : 's') + ' left today',
      names.slice(0, 4).join(', ') + (names.length > 4 ? ' +' + (names.length - 4) + ' more' : '') + ' — you’ve got this 💪',
      'flow-checkin');
    swFired.ids.push('checkin');
  }
  await cache.put('./__sw-fired.json', new Response(JSON.stringify(swFired), { headers: { 'Content-Type': 'application/json' } }));
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'flow-reminders') e.waitUntil(checkReminders());
});
self.addEventListener('message', e => {
  if (e.data === 'check-reminders') e.waitUntil(checkReminders());
});
