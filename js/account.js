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
    if (!sess) { loaded = { uid: null, at: 0 }; section.hidden = true; $('#acctBody').replaceChildren(); resetChip(); return; }
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

  const render = (d, client) => {
    const body = $('#acctBody');
    const profile = d.profile || {}, stats = d.stats || {};
    const coins = num(stats.coins);
    const display = profile.display_name || profile.username || 'Runner';
    setChip(coins, profile.username || null);

    /* identity + coins */
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
        h('p', { class: 'acct__coins-n', text: nf.format(coins) }),
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

    const mapHost = h('div', { class: 'acct__map' }, empty('Loading your last claim…'));
    const mapCard = card('Last claim', 'Live hex map', mapHost,
      h('ul', { class: 'legend legend--inline' }, [['mine', 'You'], ['rival', 'Rival'], ['clan', 'Clan'], ['neutral', 'Neutral']].map(([c, l]) => h('li', {}, h('i', { class: `sw sw--${c}` }), l))));

    body.replaceChildren(...[
      head, stat, goalRow,
      wk ? h('p', { class: 'acct__week', text: `This week’s net area: ${wk.net_m2 >= 0 ? '+' : '−'}${fmtArea(Math.abs(num(wk.net_m2))).join(' ')}  ·  rank #${wk.rank}` }) : null,
      h('div', { class: 'acct__grid' }, mapCard, heroCard),
      h('div', { class: 'acct__cols' }, runsCard, badgesCard, coinsCard),
      h('p', { class: 'acct__foot', text: 'Run in the app and it all updates here — territory, coins and hero forms are the same data.' }),
    ].filter(Boolean));

    drawLastClaim(client, mapHost, d);
  };

  /* ───────────── Last-claim hex map (latest run's route + the hexes around it) ───────────── */
  const KLAT = 110540, HEX_R = 43.2, ASPECT = 1.4;
  const drawLastClaim = async (client, host, d) => {
    try {
      const latest = (d.runs || [])[0];
      if (!latest) { host.replaceChildren(empty('Close a loop in the app and your claim appears here.')); return; }
      const { data: row } = await client.from('runs').select('route_data,title,run_date').eq('id', latest.id).maybeSingle();
      const coords = ((row && row.route_data && row.route_data.coordinates) || []).filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
      if (coords.length < 2) { host.replaceChildren(empty('Your latest run has no saved route yet.')); return; }

      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      coords.forEach((p) => { minLat = Math.min(minLat, p.latitude); maxLat = Math.max(maxLat, p.latitude); minLng = Math.min(minLng, p.longitude); maxLng = Math.max(maxLng, p.longitude); });
      const cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2, kx = 111320 * Math.cos((cLat * Math.PI) / 180);
      let w = Math.max((maxLng - minLng) * kx * 1.3, 520), hh = Math.max((maxLat - minLat) * KLAT * 1.3, 520 / ASPECT);
      if (w / hh > ASPECT) hh = w / ASPECT; else w = hh * ASPECT;
      if (w > 2400) { w = 2400; hh = w / ASPECT; }                     // keep the hex query small
      const f = { minLat: cLat - hh / 2 / KLAT, maxLat: cLat + hh / 2 / KLAT, minLng: cLng - w / 2 / kx, maxLng: cLng + w / 2 / kx };
      const P = (lat, lng) => [(lng - f.minLng) * kx, (f.maxLat - lat) * KLAT];

      const { data: hexes } = await client.rpc('get_hexes_in_bounds', { min_lat: f.minLat, min_lng: f.minLng, max_lat: f.maxLat, max_lng: f.maxLng });
      const me = d.profile || {};
      const svg = s('svg', { viewBox: `0 0 ${w.toFixed(0)} ${hh.toFixed(0)}`, role: 'img', 'aria-label': 'Hex map around your latest run' });
      s('rect', { width: w, height: hh, fill: '#0E120A' }, svg);
      const gHex = s('g', {}, svg), gLbl = s('g', {}, svg);
      const rows = Array.isArray(hexes) ? hexes : [];
      const ownedOnly = rows.length > 1400;
      let mine = 0;
      rows.forEach((r) => {
        let g; try { g = JSON.parse(r.geojson); } catch { return; }
        g = (g && g.geometry) || g;
        const ring = g && (g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null);
        if (!ring) return;
        const ally = r.user_id && (r.owner_group_id ? r.owner_group_id === me.active_group_id : r.user_id === me.id);
        const kind = ally ? 'mine' : r.owner_group_id ? 'clan' : r.user_id ? 'rival' : null;
        if (!kind && ownedOnly) return;
        if (ally) mine += 1;
        const pts = ring.map(([lng, lat]) => P(lat, lng));
        const poly = s('polygon', { class: `hx${kind ? ` is-${kind}` : ''}`, points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '), 'vector-effect': 'non-scaling-stroke' }, gHex);
        if (kind) {
          const lvl = num(r.level) || 1;
          poly.style.setProperty('--fo', (0.18 + 0.7 * ((lvl - 1) / 9)).toFixed(3));
          const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
          const t = s('text', { class: 'lv is-on', x: cx.toFixed(1), y: cy.toFixed(1), 'font-size': (HEX_R * 0.4).toFixed(1) }, gLbl);
          t.textContent = String(lvl);
        }
      });
      const step = Math.max(1, Math.floor(coords.length / 500));
      const line = coords.filter((_, i) => i % step === 0 || i === coords.length - 1).map((p, i) => { const q = P(p.latitude, p.longitude); return `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`; }).join('');
      s('path', { class: 'route', d: line, 'vector-effect': 'non-scaling-stroke' }, svg);
      const st = P(coords[0].latitude, coords[0].longitude);
      s('circle', { class: 'start-ring', cx: st[0].toFixed(1), cy: st[1].toFixed(1), r: 9 }, svg);

      host.replaceChildren(svg, h('p', { class: 'acct__map-cap' },
        h('b', { text: (row && row.title) || latest.title || 'Latest run' }),
        h('span', { text: [fmtDay(parseDay(latest.run_date)), `${num(latest.distance_km).toFixed(2)} km`, mine ? `${mine} of your hexes in frame` : 'no held hexes in frame'].filter(Boolean).join(' · ') })));
    } catch (e) {
      host.replaceChildren(empty('Couldn’t draw the map right now.'));
    }
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
