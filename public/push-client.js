// Crew page: the 🔔 Reminders button. Turns phone notifications on/off and keeps the sign-up in the database.
(function () {
  const fromB64u = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, ch => ch.charCodeAt(0)); };
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  async function save(c, me, sub) {
    const j = sub.toJSON();
    return c.from('push_subs').upsert({ endpoint: j.endpoint, person_key: me.personKey, p256dh: j.keys.p256dh, auth: j.keys.auth });
  }

  window.mutosPush = {
    async button(btn, me, c, toast) {
      const key = (window.MUTOS_CONFIG || {}).vapidPublicKey;
      if (!key || !('serviceWorker' in navigator) || !me.personKey) return;
      btn.hidden = false;
      let reg = null, sub = null;
      const label = () => { btn.textContent = sub ? '🔔 Reminders on' : '🔕 Reminders'; btn.classList.toggle('primary', !sub); };
      try {
        reg = await navigator.serviceWorker.register('/sw.js');
        if (reg.pushManager) sub = await reg.pushManager.getSubscription();
        if (sub) await save(c, me, sub); // keep the sign-up fresh
      } catch (e) { /* not supported here */ }
      label();
      // when on: a small menu to test or switch off
      function menu() {
        let m = document.getElementById('push-menu');
        if (m) { m.remove(); return; }
        m = document.createElement('div'); m.id = 'push-menu'; m.className = 'push-menu';
        m.innerHTML = '<button type="button" class="chip" data-p="test">Send me a test</button><button type="button" class="chip" data-p="off">Turn reminders off</button>';
        btn.closest('.topbar').after(m);
        m.querySelector('[data-p="test"]').addEventListener('click', async () => {
          m.remove();
          const s = await c.auth.getSession();
          const r = await fetch('/api/push-test', { method: 'POST', headers: { Authorization: 'Bearer ' + (s.data.session && s.data.session.access_token) } }).catch(() => null);
          const j = r ? await r.json().catch(() => ({})) : {};
          toast(r && r.ok ? 'Test sent. It should appear in a few seconds.' : 'Test failed: ' + (j.error || 'no connection'), !(r && r.ok));
        });
        m.querySelector('[data-p="off"]').addEventListener('click', async () => {
          m.remove();
          const ep = sub.endpoint; try { await sub.unsubscribe(); } catch (e) {}
          await c.from('push_subs').delete().eq('endpoint', ep); sub = null; label(); toast('Reminders turned off on this phone.');
        });
      }
      btn.addEventListener('click', async () => {
        if (isIOS() && !standalone()) { toast('On iPhone: tap Share → Add to Home Screen, open the app from that icon, then turn reminders on.'); return; }
        if (!reg || !reg.pushManager || !('Notification' in window)) { toast('This browser cannot show reminders. Open the app in Chrome (Android) or from the Home Screen (iPhone).', true); return; }
        if (sub) { menu(); return; }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Notifications are blocked. Allow them for this app in your phone settings, then try again.', true); return; }
        try {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
          const { error } = await save(c, me, sub);
          if (error) throw new Error(error.message);
          label(); toast('Reminders on. You will get a message at 7 pm the evening before each shoot.');
        } catch (e) { sub = null; label(); toast('Could not turn on reminders: ' + (e.message || e), true); }
      });
    }
  };
})();
