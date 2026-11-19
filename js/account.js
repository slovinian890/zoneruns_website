/* ZoneRuns web — sign in / sign up, then show the signed-in player's real data from the app's Supabase.
 *
 * Read-only on purpose: tables are read through RLS with the player's own session, and only `stable`
 * RPCs are called. Deliberately NOT called: get_my_heroes() (grants a starter hero on first call) and
 * claim_daily_login() (awards coins). The only writes are Supabase Auth itself (sign-up / sign-in).
 *
 * Everything that originates in the database is rendered with textContent, never innerHTML.
 */
(() => {
  'use strict';

  const cfg = window.ZONERUNS_CONFIG || {};
  const root = document.documentElement;
  const $ = (sel, r = document) => r.querySelector(sel);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ───────────── Config guard ───────────── */
  const keyProblem = (key) => {
    if (/^sb_secret_/i.test(key)) return 'a secret key';
    const parts = key.split('.');
    if (parts.length === 3) {
      try {
        const p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (p.role && p.role !== 'anon') return `a "${p.role}" key`;
      } catch { /* not decodable — let it through */ }
    }
    return null;
  };
  const isConfigured = () => {
    const { supabaseUrl: url, supabaseAnonKey: key } = cfg;
    if (!url || !key) return false;
    try { if (new URL(url).protocol !== 'https:') return false; } catch { return false; }
    const bad = keyProblem(key);
    if (bad) {
      console.error(`ZoneRuns: js/config.js holds ${bad}. Only the public anon key belongs on a website, so account features are disabled.`);
      return false;
    }
    return true;
  };

  const btn = $('#accountBtn'), dlg = $('#authDialog'), section = $('#account');
  if (!btn || !dlg || !section || !isConfigured()) { root.classList.add('no-account'); return; }
  btn.hidden = false;

  /* ───────────── Tiny safe DOM helpers ───────────── */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    kids.flat().forEach((c) => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  };
  const s = (tag, attrs = {}, parent) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  };
  const icon = (id) => { const svg = s('svg', { class: 'ico', 'aria-hidden': 'true' }); s('use', { href: `#i-${id}` }, svg); return svg; };
  const safeImg = (url) => { try { const u = new URL(url, location.href); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };

  /* ───────────── Formatting ───────────── */
  const nf = new Intl.NumberFormat('en-US');
  const pad2 = (n) => String(n).padStart(2, '0');
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const fmtArea = (m2) => (m2 >= 1e6 ? [(m2 / 1e6).toFixed(2), 'km²'] : m2 >= 1e4 ? [(m2 / 1e4).toFixed(1), 'ha'] : [nf.format(Math.round(m2)), 'm²']);
  const intervalSeconds = (iv) => {
    if (!iv) return 0;
    const m = /(\d+):(\d+):(\d+)/.exec(iv);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
  };
  const fmtDuration = (sec) => {
    if (!sec) return '—';
    const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
  };
  const parseDay = (v) => {
    if (!v) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
  };
  const fmtDay = (d) => (d && !Number.isNaN(+d) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
  const fmtMonthYear = (v) => { const d = new Date(v); return Number.isNaN(+d) ? '' : d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }); };
  const mondayISO = () => {
    const d = new Date(); const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const daysAgoISO = (n) => {
    const d = new Date(); d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const coinLabel = (t) => ({
    login: 'Daily reward', fortify: 'Hex fortified', bounty_place: 'Bounty placed', bounty_payout: 'Bounty payout', bounty_refund: 'Bounty refunded',
  }[t.kind] || `${num(t.distance_km).toFixed(1)} km run`);

  /* ───────────── Supabase client (self-hosted build, loaded on demand) ───────────── */
  const VENDOR_SRC = 'assets/vendor/supabase-js-2.93.3.min.js';
  const STORAGE_KEY = 'zoneruns-web-auth';
  let libPromise = null, clientPromise = null;
  const loadLib = () => libPromise || (libPromise = new Promise((resolve, reject) => {
    if (window.supabase && window.supabase.createClient) return resolve(window.supabase);
    const el = document.createElement('script');
    el.src = VENDOR_SRC; el.async = true;
    el.onload = () => resolve(window.supabase);
    el.onerror = () => { libPromise = null; reject(new Error('Could not load the sign-in library. Check your connection.')); };
    document.head.appendChild(el);
  }));
  const getClient = () => clientPromise || (clientPromise = loadLib().then((lib) => {
    const client = lib.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: STORAGE_KEY },
    });
    // never call supabase methods synchronously inside this callback (deadlock risk) — defer a tick
    client.auth.onAuthStateChange((event, sess) => setTimeout(() => onAuth(event, sess), 0));
    return client;
  }).catch((e) => { clientPromise = null; throw e; }));

  /* ───────────── State ───────────── */
  let mode = 'in', session = null, busy = false, pendingScroll = false, lastTrigger = null;
  let loaded = { uid: null, at: 0 };

  /* ───────────── Auth dialog ───────────── */
  const form = $('#authForm'), msg = $('#authMsg'), submit = $('#authSubmit');
  const fUser = $('#fUser'), fEmail = $('#fEmail'), fPass = $('#fPass');
  const tabs = { in: $('#tabIn'), up: $('#tabUp') };
  const userRow = $('#rowUser');

  const showMsg = (text, kind = 'err') => { msg.textContent = text; msg.dataset.kind = kind; };
  const setMode = (m) => {
    mode = m;
    Object.entries(tabs).forEach(([k, el]) => { el.setAttribute('aria-selected', String(k === m)); el.tabIndex = k === m ? 0 : -1; });
    userRow.hidden = m !== 'up';
    fUser.required = m === 'up';
    fPass.autocomplete = m === 'up' ? 'new-password' : 'current-password';
    $('#authTitle').textContent = m === 'up' ? 'Create your account.' : 'Welcome back.';
    $('#authTag').textContent = m === 'up' ? 'Create account' : 'Sign in';
    $('#authSub').textContent = m === 'up'
      ? 'One account for the app and the web. Pick a username — it’s what other runners see.'
      : 'Use the same email and password as the ZoneRuns app to see your coins, hero and territory.';
    submit.textContent = m === 'up' ? 'Create account' : 'Sign in';
    form.hidden = false; $('#authDone').hidden = true;
    showMsg('');
  };
  const openDialog = (m = 'in') => {
    lastTrigger = document.activeElement;
    setMode(m);
    if (!dlg.open) dlg.showModal();
    (m === 'up' ? fUser : fEmail).focus();
  };
  dlg.addEventListener('close', () => { fPass.value = ''; if (lastTrigger && lastTrigger.focus) lastTrigger.focus(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // backdrop (dialog has no padding of its own)
  $('#authClose').addEventListener('click', () => dlg.close());
  Object.entries(tabs).forEach(([k, el]) => el.addEventListener('click', () => { setMode(k); (k === 'up' ? fUser : fEmail).focus(); }));
  [tabs.in, tabs.up].forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const next = mode === 'in' ? 'up' : 'in'; setMode(next); tabs[next].focus(); }
  }));

  const friendly = (err) => {
    const m = String((err && err.message) || err || '');
    if (/invalid login credentials/i.test(m)) return 'That email and password don’t match.';
    if (/email not confirmed/i.test(m)) return 'Confirm your email first — check your inbox for the link.';
    if (/already (been )?registered/i.test(m)) return 'An account with this email already exists. Sign in instead.';
    if (/password should be at least/i.test(m)) return 'Password must be at least 6 characters.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Give it a minute and try again.';
    if (/database error saving new user/i.test(m)) return 'That username is probably taken. Try another one.';
    if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Can’t reach the server. Check your connection and try again.';
    return m || 'Something went wrong. Please try again.';
  };
  const validate = ({ email, password, username }) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ['Enter a valid email address.', fEmail];
    if (mode === 'up' && !/^[A-Za-z0-9_.-]{3,24}$/.test(username)) return ['Username: 3–24 characters — letters, numbers, _ . -', fUser];
    if (mode === 'up' && password.length < 6) return ['Password must be at least 6 characters.', fPass];
    if (!password) return ['Enter your password.', fPass];
    return null;
  };
  const setBusy = (v) => { busy = v; submit.disabled = v; submit.dataset.busy = String(v); form.setAttribute('aria-busy', String(v)); };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    [fUser, fEmail, fPass].forEach((i) => i.removeAttribute('aria-invalid'));
    const email = fEmail.value.trim(), password = fPass.value, username = fUser.value.trim();
    const bad = validate({ email, password, username });
    if (bad) { showMsg(bad[0]); bad[1].setAttribute('aria-invalid', 'true'); bad[1].focus(); return; }
    setBusy(true); showMsg('');
    try {
      const client = await getClient();
      if (mode === 'in') {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        pendingScroll = true;
        dlg.close();
      } else {
        const options = { data: { username, display_name: username } };
        if (/^https?:$/.test(location.protocol)) options.emailRedirectTo = location.origin + location.pathname;
        const { data, error } = await client.auth.signUp({ email, password, options });
        if (error) throw error;
        // With email confirmation on, an existing address comes back as a user with no identities
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new Error('already registered');
        if (data.session) { pendingScroll = true; dlg.close(); }
        else { form.hidden = true; $('#authDone').hidden = false; $('#authDoneEmail').textContent = email; }
      }
    } catch (err) { showMsg(friendly(err)); }
    finally { setBusy(false); }
  });

  btn.addEventListener('click', () => { if (session) section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); else openDialog('in'); });
  $$('[data-open-auth]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); openDialog(el.dataset.openAuth || 'in'); }));
  function $$(sel, r = document) { return [...r.querySelectorAll(sel)]; }

  /* ───────────── Header chip ───────────── */
  const setChip = (coins, username) => {
    btn.classList.add('is-chip');
    btn.replaceChildren(icon('coin'), h('b', { text: coins == null ? '—' : nf.format(coins) }), username ? h('span', { class: 'chip__name', text: `@${username}` }) : null);
    btn.setAttribute('aria-label', `Your account${coins == null ? '' : `, ${coins} coins`}`);
  };
  const resetChip = () => { btn.classList.remove('is-chip'); btn.replaceChildren(document.createTextNode('Sign in')); btn.removeAttribute('aria-label'); };

  /* ───────────── Auth state ───────────── */
  function onAuth(event, sess) {
    session = sess;
    if (!sess) { loaded = { uid: null, at: 0 }; dropMap(); section.hidden = true; $('#acctBody').replaceChildren(); resetChip(); return; }
    if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
    if (loaded.uid === sess.user.id && Date.now() - loaded.at < 60000) return;   // SIGNED_IN also fires on tab refocus
    load();
  }

  /* ───────────── Data (read-only) ───────────── */
  const ok = (r) => (r.status === 'fulfilled' && r.value && !r.value.error ? r.value.data : null);
  const status = (r) => (r.status === 'fulfilled' && r.value && r.value.error ? r.value.status : 0);

  const fetchAll = async (client, uid) => {
    const entries = {
      profile: client.from('profiles').select('id,username,display_name,avatar_url,active_hero_id,active_group_id,created_at').eq('id', uid).maybeSingle(),
      stats: client.from('user_stats').select('*').eq('user_id', uid).maybeSingle(),
      heroes: client.from('heroes').select('id,slug,name,rarity,unlock_cost,sort_order').order('sort_order'),
      owned: client.from('user_heroes').select('hero_id,tier').eq('user_id', uid),
      terr: client.rpc('get_my_territory_stats'),
      board: client.rpc('get_territory_leaderboard', { p_limit: 100 }),
      weekly: client.rpc('get_weekly_leaderboard', { p_limit: 100 }),
      runs: client.from('runs').select('id,title,run_date,distance_km,duration,pace').eq('user_id', uid).order('run_date', { ascending: false }).order('created_at', { ascending: false }).limit(5),
      weekRuns: client.from('runs').select('distance_km').eq('user_id', uid).gte('run_date', mondayISO()),
      yearRuns: client.from('runs').select('run_date,distance_km,duration').eq('user_id', uid).gte('run_date', daysAgoISO(370)).order('run_date'),
      badges: client.from('user_achievements').select('earned_at, achievements(title,category)').eq('user_id', uid).order('earned_at', { ascending: false }).limit(6),
      badgeCount: client.from('user_achievements').select('id', { count: 'exact', head: true }).eq('user_id', uid),
      badgeTotal: client.from('achievements').select('id', { count: 'exact', head: true }),
      coins: client.from('coin_transactions').select('id,amount,distance_km,kind,created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(8),
    };
    const keys = Object.keys(entries);
    const results = await Promise.allSettled(Object.values(entries));
    const out = {};
    keys.forEach((k, i) => { out[k] = ok(results[i]); });
    out.badgeCountN = results[keys.indexOf('badgeCount')].value && results[keys.indexOf('badgeCount')].value.count;
    out.badgeTotalN = results[keys.indexOf('badgeTotal')].value && results[keys.indexOf('badgeTotal')].value.count;
    out.unauthorized = [status(results[0]), status(results[1])].includes(401);
    return out;
  };

  async function load() {
    const sess = session;
    if (!sess) return;
    const uid = sess.user.id;
    loaded = { uid, at: Date.now() };
    section.hidden = false;
    section.setAttribute('aria-busy', 'true');
    if (!$('#acctBody').children.length) $('#acctBody').append(h('p', { class: 'acct__loading', text: 'Loading your sheet…' }));
    setChip(null, null);
    try {
      const client = await getClient();
      const data = await fetchAll(client, uid);
      if (!session || session.user.id !== uid) return;
      if (data.unauthorized) { await client.auth.signOut(); return; }
      render(data, client);
      loaded.at = Date.now();
      if (pendingScroll) { pendingScroll = false; section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); }
    } catch (e) {
      $('#acctBody').replaceChildren(h('p', { class: 'acct__loading', text: 'Couldn’t load your data right now. Try Refresh in a moment.' }));
    } finally { section.removeAttribute('aria-busy'); }
  }

  /* ───────────── Rendering ───────────── */
  const card = (label, note, ...children) => h('article', { class: 'acct__card' },
    h('header', { class: 'acct__card-head' }, h('span', { text: label }), note ? h('span', { text: note }) : null), ...children);
  const empty = (text) => h('p', { class: 'acct__empty', text });
  const statCell = (label, value, unit, desc) => h('div', { class: 'spec__cell' },
    h('p', { class: 'spec__label', text: label }),
    h('p', { class: 'spec__num' }, value, unit ? h('small', { text: unit }) : null),
    h('p', { class: 'spec__desc', text: desc }));

  /* ───────────── Activity card: a real GitHub-style calendar, month or year, shareable as an image ───────────── */
  const roundRectPath = (ctx, x, y, w, hh, r) => {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  };
  const HEAT_COLORS = ['rgba(255,255,255,0.06)', 'rgba(201,213,74,0.2)', 'rgba(201,213,74,0.42)', 'rgba(201,213,74,0.7)', '#C9D54A'];

  const buildActivityCard = (d, profile) => {
    const dayMap = new Map();
    (d.yearRuns || []).forEach((r) => {
      const day = parseDay(r.run_date); if (!day) return;
      const key = dayKey(day);
      const cur = dayMap.get(key) || { km: 0, sec: 0, n: 0 };
      cur.km += num(r.distance_km); cur.sec += intervalSeconds(r.duration); cur.n += 1;
      dayMap.set(key, cur);
    });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const lvOf = (km, maxKm) => (km <= 0 || maxKm <= 0 ? 0 : km / maxKm < 0.25 ? 1 : km / maxKm < 0.5 ? 2 : km / maxKm < 0.75 ? 3 : 4);
    const yearRange = () => {
      const endDow = (today.getDay() + 6) % 7;                         // Mon=0..Sun=6
      const start = new Date(today); start.setDate(start.getDate() - endDow - 7 * 51);
      const days = []; const cur = new Date(start);
      while (cur <= today) { days.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
      return days;
    };
    const monthRange = () => {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const days = []; const cur = new Date(first);
      while (cur.getMonth() === first.getMonth()) { days.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
      return days;
    };

    let heatViewMode = 'year';
    const btnMonth = h('button', { type: 'button', 'aria-pressed': 'false', text: 'Month' });
    const btnYear = h('button', { type: 'button', 'aria-pressed': 'true', text: 'Year' });
    const statA = h('b', { text: '0.0' }), statB = h('b', { text: '—' }), statC = h('b', { text: '0' });
    const statCLabel = h('span', { text: 'runs this year' });
    const activityStats = h('div', { class: 'statbar statbar--flat acct__activity-stats' },
      h('div', { class: 'stat' }, statA, h('span', { text: 'longest run km' })),
      h('div', { class: 'stat' }, statB, h('span', { text: 'longest time' })),
      h('div', { class: 'stat' }, statC, statCLabel));
    const heatGrid = h('div', { class: 'heat' });
    const heatCap = h('em', {});
    const legend = h('div', { class: 'heat__legend' },
      h('span', { text: 'Less' }), h('i', { class: 'l0' }), h('i', { class: 'l1' }), h('i', { class: 'l2' }), h('i', { class: 'l3' }), h('i', { class: 'l4' }), h('span', { text: 'More' }), heatCap);
    const exportNote = h('p', { class: 'acct__activity-note', hidden: true });
    const exportBtn = h('button', { type: 'button', class: 'gbtn gbtn--primary' }, icon('share'), 'Share recap');

    const paint = () => {
      const days = heatViewMode === 'year' ? yearRange() : monthRange();
      const maxKm = days.reduce((m, dd) => Math.max(m, (dayMap.get(dayKey(dd)) || { km: 0 }).km), 0);
      const rows = (d.yearRuns || []).filter((r) => { const dd = parseDay(r.run_date); return dd && days.some((x) => dayKey(x) === dayKey(dd)); });
      statA.textContent = rows.reduce((m, r) => Math.max(m, num(r.distance_km)), 0).toFixed(1);
      const longestSec = rows.reduce((m, r) => Math.max(m, intervalSeconds(r.duration)), 0);
      statB.textContent = longestSec ? fmtDuration(longestSec) : '—';
      statC.textContent = String(rows.length);
      statCLabel.textContent = heatViewMode === 'year' ? 'runs this year' : 'runs this month';

      heatGrid.replaceChildren();
      if (heatViewMode === 'year') {
        heatGrid.className = 'heat';
        days.forEach((dd) => {
          const rec = dayMap.get(dayKey(dd)), lv = lvOf(rec ? rec.km : 0, maxKm);
          const c = document.createElement('i');
          if (lv) c.className = `l${lv}`;
          c.title = `${dd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${rec ? ` · ${rec.km.toFixed(1)} km` : ' · no run'}`;
          heatGrid.appendChild(c);
        });
        heatCap.textContent = 'Activity calendar · full year';
      } else {
        heatGrid.className = 'heat-month';
        ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((w) => heatGrid.appendChild(h('span', { class: 'hd', text: w })));
        const pad = (days[0].getDay() + 6) % 7;
        for (let i = 0; i < pad; i++) heatGrid.appendChild(h('span', { class: 'dc is-pad' }));
        days.forEach((dd) => {
          const rec = dayMap.get(dayKey(dd)), lv = lvOf(rec ? rec.km : 0, maxKm);
          heatGrid.appendChild(h('span', { class: `dc${lv ? ` l${lv}` : ''}`, title: rec ? `${rec.km.toFixed(1)} km` : 'No run', text: String(dd.getDate()) }));
        });
        heatCap.textContent = `Activity calendar · ${today.toLocaleDateString('en-GB', { month: 'long' })}`;
      }
    };
    const setView = (v) => {
      if (v === heatViewMode) return;
      heatViewMode = v;
      btnMonth.setAttribute('aria-pressed', String(v === 'month'));
      btnYear.setAttribute('aria-pressed', String(v === 'year'));
      exportNote.hidden = true;
      paint();
    };
    btnMonth.addEventListener('click', () => setView('month'));
    btnYear.addEventListener('click', () => setView('year'));

    const buildRecapCanvas = () => {
      const W = 1080, H = 1080;
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#10140B'; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(236,234,214,0.14)'; ctx.lineWidth = 2; ctx.strokeRect(20, 20, W - 40, H - 40);
      ctx.fillStyle = '#C9D54A'; ctx.font = '700 34px Arial, sans-serif'; ctx.fillText('ZoneRuns', 64, 108);
      ctx.fillStyle = 'rgba(236,234,214,0.6)'; ctx.font = '500 22px monospace';
      ctx.fillText(heatViewMode === 'year' ? `${today.getFullYear()} recap` : today.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), 64, 142);
      ctx.fillStyle = '#ECEAD6'; ctx.font = '700 42px Arial, sans-serif';
      ctx.fillText(`@${profile.username || profile.display_name || 'runner'}`, 64, 200);

      const statsY = 300, colW = (W - 128) / 3;
      [[statA.textContent, 'LONGEST RUN KM'], [statB.textContent, 'LONGEST TIME'], [statC.textContent, statCLabel.textContent.toUpperCase()]]
        .forEach(([val, lab], i) => {
          const x = 64 + colW * i + colW / 2;
          ctx.textAlign = 'center';
          ctx.fillStyle = '#ECEAD6'; ctx.font = '700 54px Arial, sans-serif'; ctx.fillText(val, x, statsY);
          ctx.fillStyle = 'rgba(236,234,214,0.45)'; ctx.font = '600 16px monospace'; ctx.fillText(lab, x, statsY + 32);
        });
      ctx.textAlign = 'left';

      const days = heatViewMode === 'year' ? yearRange() : monthRange();
      const maxKm = days.reduce((m, dd) => Math.max(m, (dayMap.get(dayKey(dd)) || { km: 0 }).km), 0);
      const gridX = 64, gridY = 400, gridW = W - 128;
      if (heatViewMode === 'year') {
        const cols = Math.ceil(days.length / 7), gap = 6;
        const cell = Math.min((gridW - gap * (cols - 1)) / cols, 26);
        days.forEach((dd, i) => {
          const col = Math.floor(i / 7), row = i % 7, lv = lvOf((dayMap.get(dayKey(dd)) || { km: 0 }).km, maxKm);
          ctx.fillStyle = HEAT_COLORS[lv];
          roundRectPath(ctx, gridX + col * (cell + gap), gridY + row * (cell + gap), cell, cell, 4); ctx.fill();
        });
      } else {
        const pad = (days[0].getDay() + 6) % 7, gap = 10, cols = 7;
        const cell = (gridW - gap * (cols - 1)) / cols;
        days.forEach((dd, i) => {
          const idx = i + pad, col = idx % 7, row = Math.floor(idx / 7), lv = lvOf((dayMap.get(dayKey(dd)) || { km: 0 }).km, maxKm);
          ctx.fillStyle = HEAT_COLORS[lv];
          roundRectPath(ctx, gridX + col * (cell + gap), gridY + row * (cell + gap), cell, cell, 8); ctx.fill();
          ctx.fillStyle = lv >= 3 ? '#12160A' : 'rgba(236,234,214,0.6)'; ctx.font = '600 16px monospace'; ctx.textAlign = 'center';
          ctx.fillText(String(dd.getDate()), gridX + col * (cell + gap) + cell / 2, gridY + row * (cell + gap) + cell / 2 + 6);
          ctx.textAlign = 'left';
        });
      }
      ctx.fillStyle = 'rgba(236,234,214,0.4)'; ctx.font = '500 20px monospace';
      ctx.fillText(location.host || 'zoneruns.app', 64, H - 56);
      return canvas;
    };

    exportBtn.addEventListener('click', () => {
      exportNote.hidden = true;
      const canvas = buildRecapCanvas();
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const file = new File([blob], `zoneruns-${heatViewMode}-recap.png`, { type: 'image/png' });
        try {
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'My ZoneRuns recap', text: 'My ZoneRuns activity, captured in the app.' });
            return;
          }
        } catch (e) { if (e && e.name === 'AbortError') return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
        URL.revokeObjectURL(url);
        exportNote.hidden = false;
        exportNote.textContent = navigator.share
          ? 'Saved as an image — open it from your downloads to share.'
          : 'Saved as an image — open Instagram and share it from your gallery.';
      }, 'image/png');
    });

    paint();
    return h('article', { class: 'acct__card acct__activity' },
      h('header', { class: 'acct__card-head' }, h('span', { text: 'Activity' }), h('div', { class: 'seg', role: 'group', 'aria-label': 'Activity range' }, btnMonth, btnYear)),
      activityStats, heatGrid, legend,
      h('div', { class: 'acct__activity-export' }, exportBtn, exportNote));
  };

  const render = (d, client) => {
    const body = $('#acctBody');
    const profile = d.profile || {}, stats = d.stats || {};
    let coins = num(stats.coins);
    const display = profile.display_name || profile.username || 'Runner';
    setChip(coins, profile.username || null);

    /* identity + coins */
    const coinsNEl = h('p', { class: 'acct__coins-n', text: nf.format(coins) });
    const setCoins = (n) => { coins = n; coinsNEl.textContent = nf.format(n); setChip(n, profile.username || null); };
    const avatarUrl = profile.avatar_url ? safeImg(profile.avatar_url) : null;
    const avatar = h('span', { class: 'acct__avatar' }, h('span', {},
      avatarUrl ? h('img', { src: avatarUrl, alt: '', width: 104, height: 104, referrerpolicy: 'no-referrer', decoding: 'async' }) : h('b', { text: display.trim().charAt(0).toUpperCase() || 'Z' })));
    const head = h('div', { class: 'acct__head' },
      avatar,
      h('div', { class: 'acct__who' },
        h('h2', { class: 'acct__name', text: display }),
        h('p', { class: 'acct__meta' },
          profile.username ? h('span', { text: `@${profile.username}` }) : null,
          profile.created_at ? h('span', { text: `Member since ${fmtMonthYear(profile.created_at)}` }) : null)),
      h('div', { class: 'acct__coins' },
        coinsNEl,
        h('p', { class: 'acct__coins-l' }, icon('coin'), 'Coins'),
        stats.login_streak ? h('p', { class: 'acct__coins-s', text: `Login streak · ${stats.login_streak} day${stats.login_streak === 1 ? '' : 's'}` }) : null));

    /* stats table */
    const rankIdx = (d.board || []).findIndex((r) => r.user_id === profile.id);
    const [areaV, areaU] = fmtArea(num(d.terr && d.terr.area_m2));
    const stat = h('div', { class: 'acct__stats' },
      statCell('Runs', nf.format(num(stats.total_runs)), '', 'Logged in the app'),
      statCell('Distance', num(stats.total_distance_km).toFixed(1), 'km', 'Total, all time'),
      statCell('Best pace', stats.best_pace || '—', stats.best_pace ? '/km' : '', 'Fastest run average'),
      statCell('Streak', String(num(stats.current_streak)), 'days', `Longest ${num(stats.longest_streak)}`),
      statCell('Longest run', num(stats.longest_run_km).toFixed(1), 'km', 'Single run'),
      statCell('Territory', areaV, areaU, rankIdx >= 0 ? `Rank #${d.board[rankIdx].rank} of the top ${d.board.length}` : 'Not in the top 100 yet'));

    /* weekly goal */
    const weekKm = (d.weekRuns || []).reduce((a, r) => a + num(r.distance_km), 0);
    const goal = num(stats.weekly_goal_km);
    const goalRow = goal > 0 ? h('div', { class: 'acct__goal' },
      h('p', {}, h('span', { text: 'This week' }), h('b', { text: `${weekKm.toFixed(1)} / ${goal} km` })),
      h('i', { style: `--w:${Math.min(100, (weekKm / goal) * 100).toFixed(1)}%` })) : null;
    const wk = (d.weekly || []).find((r) => r.user_id === profile.id);

    /* hero + collection */
    const heroes = d.heroes || [], ownedMap = new Map((d.owned || []).map((o) => [o.hero_id, num(o.tier) || 1]));
    const active = heroes.find((x) => x.id === profile.active_hero_id && ownedMap.has(x.id))
      || [...heroes].filter((x) => ownedMap.has(x.id)).sort((a, b) => ownedMap.get(b.id) - ownedMap.get(a.id))[0];
    const sprite = (slug, tier) => (/^[a-z-]+$/.test(slug) ? `assets/heroes/${slug}/tier-${pad2(Math.min(15, Math.max(1, tier)))}.png` : '');
    const RARITY = { common: '#9BA28A', rare: '#5B9FE8', epic: '#B35BE8', legendary: '#E8C23C' };
    const heroCard = card('Your hero', `${ownedMap.size} of ${heroes.length || 25} collected`,
      active
        ? h('div', { class: 'acct__hero', style: `--rc:${RARITY[active.rarity] || '#E8C23C'}` },
            h('div', { class: 'acct__hero-art' }, h('img', { src: sprite(active.slug, ownedMap.get(active.id)), alt: `${active.name}, form ${ownedMap.get(active.id)} of 15`, width: 320, height: 320 })),
            h('div', { class: 'acct__hero-meta' },
              h('span', { class: 'rarity', text: active.rarity }),
              h('h3', { text: active.name }),
              h('p', { class: 'stage__unlock', text: `Form ${pad2(ownedMap.get(active.id))} / 15` }),
              ownedMap.get(active.id) < 15 ? h('p', { class: 'stage__cost', text: `Next form · ${10 + ownedMap.get(active.id) * 2} coins` }) : h('p', { class: 'stage__cost', text: 'Fully evolved' })))
        : empty('No hero yet — open the app once and you’ll receive your starter hero.'),
      heroes.length ? h('div', { class: 'acct__roster' }, heroes.map((x) => {
        const t = ownedMap.get(x.id);
        return h('span', { class: `acct__chip${t ? '' : ' is-locked'}${active && x.id === active.id ? ' is-active' : ''}`, title: t ? `${x.name} · form ${t}` : `${x.name} · ${x.unlock_cost} coins to unlock`, style: `--rc:${RARITY[x.rarity] || '#9BA28A'}` },
          h('img', { src: sprite(x.slug, t || 15), alt: '', width: 80, height: 80, loading: 'lazy', decoding: 'async' }));
      })) : null);

    /* recent runs, badges, coin ledger */
    const runsCard = card('Recent runs', d.runs && d.runs.length ? `Last ${d.runs.length}` : '',
      d.runs && d.runs.length
        ? h('ol', { class: 'acct__rows' }, d.runs.map((r) => h('li', {},
            h('div', {}, h('b', { text: r.title || 'Run' }), h('span', { text: fmtDay(parseDay(r.run_date)) })),
            h('div', { class: 'acct__right' }, h('b', { text: `${num(r.distance_km).toFixed(2)} km` }), h('span', { text: `${fmtDuration(intervalSeconds(r.duration))} · ${r.pace || '—'}/km` })))))
        : empty('No runs yet. Record one in the app and it shows up here.'));
    const badgeN = d.badgeCountN != null ? d.badgeCountN : (d.badges || []).length;
    const badgesCard = card('Badges', d.badgeTotalN ? `${badgeN} of ${d.badgeTotalN}` : String(badgeN),
      d.badges && d.badges.length
        ? h('ol', { class: 'acct__rows' }, d.badges.map((b) => h('li', {},
            h('div', {}, h('b', { text: (b.achievements && b.achievements.title) || 'Badge' }), h('span', { text: (b.achievements && b.achievements.category) || '' })),
            h('div', { class: 'acct__right' }, h('span', { text: fmtDay(new Date(b.earned_at)) })))))
        : empty('None yet — your first run earns your first badge.'));
    const coinsCard = card('Coin ledger', 'Latest', d.coins && d.coins.length
      ? h('ol', { class: 'acct__rows' }, d.coins.map((t) => {
          const a = num(t.amount);
          return h('li', {}, h('div', {}, h('b', { text: coinLabel(t) }), h('span', { text: fmtDay(new Date(t.created_at)) })),
            h('div', { class: 'acct__right' }, h('b', { class: a < 0 ? 'neg' : 'pos', text: `${a < 0 ? '−' : '+'}${nf.format(Math.abs(a))}` })));
        }))
      : empty('No coin activity yet.'));

    /* activity card: a real GitHub-style calendar (month/year) built from your own runs, shareable as an image */
    const activityCard = buildActivityCard(d, profile);

    dropMap();
    const glEl = h('div', { class: 'acct__gl', role: 'region', 'aria-label': 'Interactive map of your hexes' });
    const zIn = h('button', { type: 'button', 'aria-label': 'Zoom in', text: '+' }), zOut = h('button', { type: 'button', 'aria-label': 'Zoom out', text: '−' });
    const note = h('p', { class: 'acct__map-note', hidden: true }), capB = h('b'), capS = h('span');
    const hpTitle = h('b', {}), hpSub = h('span', {});
    const hpMsg = h('p', { class: 'acct__hp-msg', hidden: true });
    const hpPlace = h('button', { type: 'button', class: 'btn btn--primary btn--sm acct__hp-btn' }, icon('bounty'), `Place bounty · ${BOUNTY_STEP} coins`);
    const hpCancel = h('button', { type: 'button', class: 'textbtn', hidden: true, text: 'Cancel my bounty' });
    const hpClose = h('button', { type: 'button', class: 'acct__hp-close', 'aria-label': 'Close hex info', text: '×' });
    const hexPanel = h('div', { class: 'acct__hexpanel', hidden: true },
      h('div', { class: 'acct__hp-head' }, h('div', {}, hpTitle, hpSub), hpClose),
      hpMsg,
      h('div', { class: 'acct__hp-actions' }, hpPlace, hpCancel));
    const mapHost = h('div', { class: 'acct__map' }, h('div', { class: 'acct__mapview' }, glEl, h('div', { class: 'acct__zoom' }, zIn, zOut), hexPanel), note, h('p', { class: 'acct__map-cap' }, capB, capS));
    const btnRun = h('button', { type: 'button', 'aria-pressed': 'true', text: 'Last claim' });
    const btnHere = h('button', { type: 'button', 'aria-pressed': 'false', text: 'My location' });
    const mapCard = h('article', { class: 'acct__card' },
      h('header', { class: 'acct__card-head' }, h('span', { text: 'Map' }), h('div', { class: 'seg', role: 'group', 'aria-label': 'Map view' }, btnRun, btnHere)),
      mapHost,
      h('ul', { class: 'legend legend--inline' }, [['mine', 'You'], ['rival', 'Others'], ['clan', 'Clan'], ['neutral', 'Neutral']].map(([c, l]) => h('li', {}, h('i', { class: `sw sw--${c}` }), l))),
      h('p', { class: 'acct__hp-hint' }, 'Tap a hex that isn’t yours to put a bounty on it.'));

    const mv = { kind: 'run', title: '', sub: '', mine: 0, apply: null };
    let routeP = null, hexTimer = 0, hexToken = 0, viewToken = 0, mapP = null;
    const setNote = (text) => { note.textContent = text || ''; note.hidden = !text; };

    /* ───────────── Bounties: tap a hex that isn't yours ───────────── */
    let currentFc = EMPTY, selected = null, bountyBusy = false;
    const sessionBounty = new Map();                                 // "col,row" -> coins placed this session (so we can offer Cancel)
    const hexKey = (hc, hr) => `${hc},${hr}`;
    const ownerLabel = (k) => (k === 'c' ? 'Clan hex' : 'Rival hex');

    const renderPanel = () => {
      if (!selected) { hexPanel.hidden = true; return; }
      const { hc, hr, k, lv, b } = selected;
      hpTitle.textContent = ownerLabel(k);
      hpSub.textContent = `Level ${lv} · ${b > 0 ? `${nf.format(b)} coins riding on it` : 'no bounty yet'}`;
      const mine = sessionBounty.get(hexKey(hc, hr)) || 0;
      hpPlace.disabled = bountyBusy || coins < BOUNTY_STEP;
      hpCancel.hidden = mine <= 0;
      hpCancel.disabled = bountyBusy;
      hexPanel.hidden = false;
    };
    const deselectHex = () => { selected = null; if (activeMap) activeMap.getSource('sel').setData(EMPTY); renderPanel(); };
    const selectHex = (feature) => {
      const p = feature.properties;
      selected = { hc: p.hc, hr: p.hr, k: p.k, lv: num(p.lv), b: num(p.b) };
      hpMsg.hidden = true; hpMsg.textContent = '';
      if (activeMap) activeMap.getSource('sel').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: feature.geometry, properties: {} }] });
      renderPanel();
    };
    const patchFeature = (hc, hr, patch) => {
      const f = currentFc.features.find((x) => x.properties.hc === hc && x.properties.hr === hr);
      if (f) Object.assign(f.properties, patch);
      if (activeMap) activeMap.getSource('hexes').setData(currentFc);
    };
    const wireHexClicks = (map) => {
      const layers = ['hx-o-fill', 'hx-c-fill'];
      map.on('click', (e) => {
        const feats = map.queryRenderedFeatures(e.point, { layers });
        if (feats.length) selectHex(feats[0]); else deselectHex();
      });
      map.on('mousemove', (e) => { map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers }).length ? 'pointer' : ''; });
    };
    hpClose.addEventListener('click', deselectHex);
    hpPlace.addEventListener('click', async () => {
      if (!selected || bountyBusy || coins < BOUNTY_STEP) return;
      const { hc, hr } = selected;
      bountyBusy = true; renderPanel();
      try {
        const { error } = await client.rpc('place_bounty', { p_hex_col: hc, p_hex_row: hr, p_amount: BOUNTY_STEP });
        if (error) throw error;
        setCoins(coins - BOUNTY_STEP);
        selected.b += BOUNTY_STEP;
        sessionBounty.set(hexKey(hc, hr), (sessionBounty.get(hexKey(hc, hr)) || 0) + BOUNTY_STEP);
        patchFeature(hc, hr, { b: selected.b });
      } catch (err) { hpMsg.hidden = false; hpMsg.textContent = friendly(err); }
      finally { bountyBusy = false; renderPanel(); }
    });
    hpCancel.addEventListener('click', async () => {
      if (!selected || bountyBusy) return;
      const { hc, hr } = selected, mine = sessionBounty.get(hexKey(hc, hr)) || 0;
      if (!mine) return;
      bountyBusy = true; renderPanel();
      try {
        const { error } = await client.rpc('cancel_bounty', { p_hex_col: hc, p_hex_row: hr });
        if (error) throw error;
        setCoins(coins + mine);
        selected.b = Math.max(0, selected.b - mine);
        sessionBounty.delete(hexKey(hc, hr));
        patchFeature(hc, hr, { b: selected.b });
      } catch (err) { hpMsg.hidden = false; hpMsg.textContent = friendly(err); }
      finally { bountyBusy = false; renderPanel(); }
    });
    const getRoute = () => routeP || (routeP = (async () => {
      const latest = (d.runs || [])[0];
      if (!latest) return null;
      const { data: row } = await client.from('runs').select('route_data,title,run_date').eq('id', latest.id).maybeSingle();
      const coords = ((row && row.route_data && row.route_data.coordinates) || []).filter((q) => Number.isFinite(q.latitude) && Number.isFinite(q.longitude));
      if (coords.length < 2) return { latest, row, coords: [] };
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      coords.forEach((q) => { minLat = Math.min(minLat, q.latitude); maxLat = Math.max(maxLat, q.latitude); minLng = Math.min(minLng, q.longitude); maxLng = Math.max(maxLng, q.longitude); });
      return { latest, row, coords, bbox: [[minLng, minLat], [maxLng, maxLat]], center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2] };
    })());

    const updateCaption = (map) => {
      const z = map.getZoom(), scale = 2 ** (z - APP_ZOOM);
      capB.textContent = mv.title;
      capS.textContent = [mv.sub, mv.mine ? `${mv.mine} of your hexes in view` : 'none of your hexes in view', Math.abs(z - APP_ZOOM) < 0.05 ? 'app scale' : `${scale.toFixed(1)}× app scale`].filter(Boolean).join(' · ');
      zIn.disabled = z >= MAX_Z - 0.01; zOut.disabled = z <= MIN_Z + 0.01;
    };
    const refreshHexes = (map) => {
      clearTimeout(hexTimer);
      hexTimer = setTimeout(async () => {
        if (map !== activeMap || map.getZoom() < MIN_Z - 0.01) return;
        const my = ++hexToken, b = map.getBounds();
        let rows;
        try { rows = await fetchHexes(client, { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() }); }
        catch (e) { if (my === hexToken && map === activeMap) setNote('Couldn’t load the hexes for this area. Pan the map or press Refresh to try again.'); return; }
        if (my !== hexToken || map !== activeMap) return;
        setNote('');
        const { fc, mine } = hexCollection(rows, d.profile || {});
        currentFc = fc;
        map.getSource('hexes').setData(fc); glEl.dataset.hexes = String(fc.features.length); mv.mine = mine; updateCaption(map);
        if (selected) {
          const match = fc.features.find((x) => x.properties.hc === selected.hc && x.properties.hr === selected.hr);
          if (match) { selected.lv = num(match.properties.lv); selected.b = num(match.properties.b); renderPanel(); }
          else deselectHex();
        }
      }, 220);
    };
    const ensureMap = (center) => mapP || (mapP = (async () => {
      const ml = await loadMaplibre();
      const map = new ml.Map({
        container: glEl, style: MAP_STYLE, center, zoom: APP_ZOOM, minZoom: MIN_Z, maxZoom: MAX_Z,
        attributionControl: false, cooperativeGestures: true, dragRotate: false, pitchWithRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new ml.AttributionControl({ compact: true, customAttribution: '© OpenFreeMap © OpenStreetMap contributors' }));
      map.on('styleimagemissing', (e) => { if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });   // the style references a few sprites we don't need
      activeMap = map; glEl.__map = map;
      await new Promise((ok, no) => { map.once('load', ok); map.once('error', (e) => { if (!map.loaded()) no(e && e.error); }); });
      addMapLayers(map);
      wireHexClicks(map);
      if (glEl.clientWidth < 600) { const a = glEl.querySelector('.maplibregl-ctrl-attrib'); if (a) a.classList.remove('maplibregl-compact-show'); }   // small screens: credit starts collapsed behind the (i)
      map.on('moveend', () => refreshHexes(map));
      map.on('resize', () => refreshHexes(map));
      if ('ResizeObserver' in window) new ResizeObserver(() => map.resize()).observe(glEl);
      map.on('zoom', () => updateCaption(map));
      return map;
    })().catch((e) => { mapP = null; throw e; }));
    zIn.addEventListener('click', () => activeMap && activeMap.zoomIn({ duration: 250 }));
    zOut.addEventListener('click', () => activeMap && activeMap.zoomOut({ duration: 250 }));

    async function showMap(kind) {
      const my = ++viewToken, here = kind === 'here';
      mv.kind = kind; mv.mine = 0;
      deselectHex();
      btnRun.setAttribute('aria-pressed', String(!here)); btnHere.setAttribute('aria-pressed', String(here));
      setNote(here ? 'Finding you… allow location access when your browser asks.' : '');
      try {
        let center, apply;
        if (here) {
          if (!navigator.geolocation) { setNote('Your browser can’t share its location.'); return; }
          const pos = await new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, no, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }));
          if (my !== viewToken) return;
          const { latitude: lat, longitude: lng, accuracy } = pos.coords;
          center = [lng, lat];
          mv.title = 'You are here'; mv.sub = accuracy ? `±${Math.round(accuracy)} m` : '';
          apply = (map) => {
            map.getSource('route').setData(EMPTY);
            map.getSource('you').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: center }, properties: {} }, ...(accuracy && accuracy < 400 ? [circlePoly(lat, lng, accuracy)] : [])] });
          };
        } else {
          const route = await getRoute();
          if (my !== viewToken) return;
          if (!route) { setNote('Close a loop in the app and your claim appears here.'); return; }
          if (!route.coords.length) { setNote('Your latest run has no saved route yet.'); return; }
          center = route.center;
          mv.title = (route.row && route.row.title) || route.latest.title || 'Latest run';
          mv.sub = [fmtDay(parseDay(route.latest.run_date)), `${num(route.latest.distance_km).toFixed(2)} km`].join(' · ');
          const step = Math.max(1, Math.floor(route.coords.length / 600));
          const line = route.coords.filter((_, i) => i % step === 0 || i === route.coords.length - 1).map((q) => [q.longitude, q.latitude]);
          apply = (map) => {
            map.getSource('you').setData(EMPTY);
            map.getSource('route').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} }, { type: 'Feature', geometry: { type: 'Point', coordinates: line[0] }, properties: {} }] });
          };
        }
        const map = await ensureMap(center);
        if (my !== viewToken) return;
        apply(map);
        map.jumpTo({ center, zoom: APP_ZOOM });
        setNote('');
        updateCaption(map); refreshHexes(map);
      } catch (e) {
        if (my !== viewToken) return;
        const denied = e && e.code === 1;
        setNote(denied ? 'Location access was blocked. Allow it for this site in your browser settings to see where you are.'
          : here && e && e.code ? 'Couldn’t get your location. Try again outdoors or with Wi-Fi on.'
          : 'Couldn’t draw the interactive map here — your browser may have WebGL turned off.');
      }
    }
    btnRun.addEventListener('click', () => showMap('run'));
    btnHere.addEventListener('click', () => showMap('here'));

    body.replaceChildren(...[
      head, stat, goalRow,
      wk ? h('p', { class: 'acct__week', text: `This week’s net area: ${wk.net_m2 >= 0 ? '+' : '−'}${fmtArea(Math.abs(num(wk.net_m2))).join(' ')}  ·  rank #${wk.rank}` }) : null,
      h('div', { class: 'acct__grid' }, mapCard, heroCard),
      activityCard,
      h('div', { class: 'acct__cols' }, runsCard, badgesCard, coinsCard),
      h('p', { class: 'acct__foot', text: 'Run in the app and it all updates here — territory, coins and hero forms are the same data.' }),
    ].filter(Boolean));

    showMap('run');
  };

  /* ───────────── Real map: MapLibre + OpenFreeMap — the same stack and style as the app ─────────────
     The app runs Leaflet (256 px tiles) at zoom 16 on top of maplibre-gl 4.7.1 (512 px tiles); that is MapLibre
     zoom 15, so hexes here are exactly the app's size on screen. As in the app, hexes are loaded for whatever
     is in view, defense numbers appear at the closest zoom, and bounties show as amber tags. */
  const ML = { js: 'assets/vendor/maplibre-gl-csp-4.7.1.js', css: 'assets/vendor/maplibre-gl-4.7.1.css', worker: 'assets/vendor/maplibre-gl-csp-worker-4.7.1.js' };
  const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
  const APP_ZOOM = 15, MIN_Z = 14, MAX_Z = 17, LABEL_Z = 17;
  const BOUNTY_STEP = 50;   // coins per tap — mirrors the Compete demo board
  let mlPromise = null, activeMap = null;
  const loadMaplibre = () => mlPromise || (mlPromise = new Promise((resolve, reject) => {
    if (window.maplibregl) return resolve(window.maplibregl);
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ML.css; document.head.appendChild(link);
    const el = document.createElement('script'); el.src = ML.js; el.async = true;
    el.onload = () => { window.maplibregl.setWorkerUrl(ML.worker); resolve(window.maplibregl); };
    el.onerror = () => { mlPromise = null; reject(new Error('map library failed to load')); };
    document.head.appendChild(el);
  }));
  const dropMap = () => { if (activeMap) { try { activeMap.remove(); } catch { /* already gone */ } activeMap = null; } };

  const EMPTY = { type: 'FeatureCollection', features: [] };
  const colorOk = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null);
  const lvFrac = ['/', ['-', ['to-number', ['get', 'lv']], 1], 9];
  const kindIs = (k) => ['==', ['get', 'k'], k];

  const addMapLayers = (map) => {
    ['hexes', 'route', 'you', 'sel'].forEach((id) => map.addSource(id, { type: 'geojson', data: EMPTY }));
    const L = (o) => map.addLayer(o);
    // everyone else first …
    L({ id: 'hx-n', type: 'line', source: 'hexes', filter: kindIs('n'), paint: { 'line-color': 'rgba(236,234,214,0.2)', 'line-width': 1 } });
    L({ id: 'hx-o-fill', type: 'fill', source: 'hexes', filter: kindIs('o'), paint: { 'fill-color': ['get', 'col'], 'fill-opacity': ['+', 0.1, ['*', 0.3, lvFrac]] } });
    L({ id: 'hx-o-line', type: 'line', source: 'hexes', filter: kindIs('o'), paint: { 'line-color': ['get', 'col'], 'line-width': 1.1, 'line-opacity': 0.6 } });
    L({ id: 'hx-c-fill', type: 'fill', source: 'hexes', filter: kindIs('c'), paint: { 'fill-color': '#E8C23C', 'fill-opacity': ['+', 0.12, ['*', 0.3, lvFrac]] } });
    L({ id: 'hx-c-line', type: 'line', source: 'hexes', filter: kindIs('c'), paint: { 'line-color': '#E8C23C', 'line-width': 1.3, 'line-dasharray': [5, 3], 'line-opacity': 0.8 } });
    // … then yours on top: a glow, a bright fill and a near-white outline, so they can't be missed
    L({ id: 'hx-m-halo', type: 'line', source: 'hexes', filter: kindIs('m'), layout: { 'line-join': 'round' }, paint: { 'line-color': '#C9D54A', 'line-width': 9, 'line-opacity': 0.3, 'line-blur': 3 } });
    L({ id: 'hx-m-fill', type: 'fill', source: 'hexes', filter: kindIs('m'), paint: { 'fill-color': '#D9EE4C', 'fill-opacity': ['+', 0.5, ['*', 0.45, lvFrac]] } });
    L({ id: 'hx-m-line', type: 'line', source: 'hexes', filter: kindIs('m'), layout: { 'line-join': 'round' }, paint: { 'line-color': '#F6FFB0', 'line-width': 2.4 } });
    L({ id: 'route-line', type: 'line', source: 'route', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#C9D54A', 'line-width': 3 } });
    L({ id: 'route-start', type: 'circle', source: 'route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#0E120A', 'circle-stroke-color': '#C9D54A', 'circle-stroke-width': 2.5 } });
    L({ id: 'you-acc', type: 'fill', source: 'you', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#C9D54A', 'fill-opacity': 0.1 } });
    L({ id: 'you-halo', type: 'circle', source: 'you', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 17, 'circle-color': '#C9D54A', 'circle-opacity': 0.28 } });
    L({ id: 'you-dot', type: 'circle', source: 'you', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#C9D54A', 'circle-stroke-color': '#0A0D07', 'circle-stroke-width': 2.5 } });
    // defense level: every captured hex (mine, clan or rival), nudged up when a bounty tag sits below it
    L({ id: 'hx-level', type: 'symbol', source: 'hexes', minzoom: LABEL_Z, filter: ['!=', ['get', 'k'], 'n'],
      layout: {
        'text-field': ['to-string', ['get', 'lv']], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-allow-overlap': true,
        'text-offset': ['case', ['>', ['get', 'b'], 0], ['literal', [0, -0.75]], ['literal', [0, 0]]],
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.6 } });
    L({ id: 'hx-bounty', type: 'symbol', source: 'hexes', filter: ['>', ['get', 'b'], 0],
      layout: { 'text-field': ['concat', '◎ ', ['to-string', ['get', 'b']]], 'text-font': ['Noto Sans Bold'], 'text-size': 11.5, 'text-allow-overlap': true, 'text-offset': ['literal', [0, 0.85]] },
      paint: { 'text-color': '#12160A', 'text-halo-color': '#E8C23C', 'text-halo-width': 4 } });
    // selection outline — the hex a tap just picked
    L({ id: 'sel-line', type: 'line', source: 'sel', layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-dasharray': [2, 1.4], 'line-opacity': 0.95 } });
  };

  /* Supabase's API returns at most 1000 rows per request, and get_hexes_in_bounds returns one row per hex in
     the box (unordered), so a big view gets silently cut off at a straight edge. The app never hits this because
     a phone screen holds a few hundred hexes. Here: ask for strips that stay well under the cap, and if a
     response still comes back full, split that box in half and ask again. Hexes are merged by (col,row). */
  const HEX_S = 43.2, HEX_CAP = 1000, HEX_BUDGET = 600;
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 6378137;
  const boxSize = (b) => [((b.east - b.west) * Math.PI / 180) * 6378137, mercY(b.north) - mercY(b.south)];
  const estCells = (b) => { const [w, h] = boxSize(b); return (w / (1.5 * HEX_S)) * (h / (HEX_S * Math.sqrt(3))); };
  const fetchHexBox = async (client, b, depth = 0) => {
    const strips = Math.max(1, Math.ceil(estCells(b) / HEX_BUDGET));
    if (strips > 1 && depth < 6) {
      const step = (b.east - b.west) / strips;
      return (await Promise.all(Array.from({ length: strips }, (_, i) =>
        fetchHexBox(client, { south: b.south, north: b.north, west: b.west + step * i, east: b.west + step * (i + 1) }, depth + 1)))).flat();
    }
    const { data, error } = await client.rpc('get_hexes_in_bounds', { min_lat: b.south, min_lng: b.west, max_lat: b.north, max_lng: b.east });
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    if (rows.length >= HEX_CAP && depth < 6) {                      // full response = truncated: split the longer side
      const [w, h] = boxSize(b);
      const halves = w >= h
        ? [{ ...b, east: (b.west + b.east) / 2 }, { ...b, west: (b.west + b.east) / 2 }]
        : [{ ...b, north: (b.south + b.north) / 2 }, { ...b, south: (b.south + b.north) / 2 }];
      return (await Promise.all(halves.map((x) => fetchHexBox(client, x, depth + 1)))).flat();
    }
    return rows;
  };
  const fetchHexes = async (client, b) => {
    const seen = new Map();
    (await fetchHexBox(client, b)).forEach((r) => seen.set(`${r.hex_col}:${r.hex_row}`, r));
    return [...seen.values()];
  };

  /** database rows → GeoJSON. The polygons are the database's own, so their shape is the app's by construction. */
  const hexCollection = (rows, me) => {
    let mine = 0; const features = [];
    rows.forEach((r) => {
      let g; try { g = JSON.parse(r.geojson); } catch { return; }
      g = (g && g.geometry) || g;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return;
      const ally = r.user_id && (r.owner_group_id ? r.owner_group_id === me.active_group_id : r.user_id === me.id);
      if (ally) mine += 1;
      features.push({ type: 'Feature', geometry: g, properties: {
        k: ally ? 'm' : r.owner_group_id ? 'c' : r.user_id ? 'o' : 'n', lv: num(r.level) || 1, b: num(r.bounty_total), col: colorOk(r.trail_color) || '#C8572D',
        hc: r.hex_col, hr: r.hex_row } });
    });
    return { fc: { type: 'FeatureCollection', features }, mine };
  };
  const circlePoly = (lat, lng, meters) => {
    const dLat = meters / 110540, dLng = meters / (111320 * Math.cos((lat * Math.PI) / 180)), ring = [];
    for (let i = 0; i <= 48; i++) { const a = (i / 48) * 2 * Math.PI; ring.push([lng + Math.cos(a) * dLng, lat + Math.sin(a) * dLat]); }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
  };

  /* ───────────── Tools: refresh / sign out / refocus ───────────── */
  $('#acctRefresh').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await load(); } finally { b.disabled = false; }
  });
  $('#acctSignOut').addEventListener('click', async () => {
    try { const client = await getClient(); await client.auth.signOut(); } catch { /* onAuth handles UI */ }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && session && Date.now() - loaded.at > 60000) load(); });

  /* ───────────── Boot: restore a stored session, or finish an email-confirmation redirect ───────────── */
  const hasStored = () => { try { return !!localStorage.getItem(STORAGE_KEY); } catch { return false; } };
  const fromEmailLink = /[#&?](access_token|refresh_token|error_description|code)=/.test(location.hash + location.search);
  if (hasStored() || fromEmailLink) {
    const start = () => getClient().then(() => {
      const err = /error_description=([^&]+)/.exec(location.hash);
      if (err) { openDialog('in'); showMsg(decodeURIComponent(err[1].replace(/\+/g, ' '))); }
    }).catch(() => {});
    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 1500 }); else setTimeout(start, 300);
  }
})();
