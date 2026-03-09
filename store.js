/**
 * store.js — The Agorium
 * Supabase-backed data store. Swap SUPABASE_URL and SUPABASE_KEY below.
 * All data functions are async. Render helpers (renderPostCard, renderArgCard) stay sync.
 *
 * Postgres lowercases unquoted column names, so createdAt → createdat, etc.
 * The column map is: argCount→argcount, forCount→forcount, againstCount→againstcount,
 * mindChanges→mindchanges, whatWouldChangeMyMind→whatwouldchangemymind,
 * postId→postid, steelmanCount→steelmancount, createdAt→createdat
 */

(function () {
  'use strict';

  // ── CONFIG — paste your values from Supabase → Settings → API ──────────────
  const SUPABASE_URL = 'https://auboquhnqswseneeosyj.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_j13mrxvpNWC12QhJFSVPYQ_Q-kdsL0s';
  // ────────────────────────────────────────────────────────────────────────────

  const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  let lastError = '';

  function setLastError(context, error) {
    if (!error) {
      lastError = '';
      return;
    }
    const code = error.code ? ` (${error.code})` : '';
    lastError = `${context}${code}: ${error.message || String(error)}`;
  }

  // ── HELPERS ──
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function timeAgo(iso) {
    const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (diff < 60)    return 'Just now';
    if (diff < 3600)  return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
    return Math.floor(diff / 86400) + ' days ago';
  }

  function currentUser() {
    return localStorage.getItem('agora_user') || 'You';
  }

  function normalizeUsername(username) {
    return String(username || '').trim();
  }

  function usernameKey(username) {
    return normalizeUsername(username).toLowerCase();
  }

  function profileUrl(username) {
    return 'profile.html?u=' + encodeURIComponent(normalizeUsername(username));
  }

  function buildEmailConfirmRedirectUrl() {
    const url = new URL('auth.html', window.location.href);
    url.searchParams.set('mode', 'signin');
    url.searchParams.set('confirmed', '1');
    return url.toString();
  }

  function sanitizeProfileFields(fields) {
    const maxByField = {
      bio: 1200,
      tagline: 120,
      occupation: 80,
      goals: 400,
      belief: 400,
      hobbies: 160,
      avatar_url: 200000,  // supports base64-encoded images up to ~150KB
    };
    const out = {};
    Object.keys(maxByField).forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(fields || {}, k)) {
        out[k] = String(fields[k] || '').trim().slice(0, maxByField[k]);
      }
    });
    return out;
  }

  // ── USERS / PUBLIC PROFILE ──

  async function ensureUserProfile(username, seedFields, options) {
    const name = normalizeUsername(username);
    if (!name) return null;
    const payload = Object.assign(
      { username_lc: usernameKey(name), username: name },
      sanitizeProfileFields(seedFields || {})
    );
    const { data, error } = await db
      .from('users')
      .upsert(payload, { onConflict: 'username_lc' })
      .select('*')
      .single();
    if (error) {
      if (!options || !options.silent) setLastError('ensureUserProfile failed', error);
      console.error('ensureUserProfile:', error);
      return null;
    }
    return data;
  }

  async function getUserProfile(username) {
    const key = usernameKey(username);
    if (!key) return null;
    const { data, error } = await db.from('users').select('*').eq('username_lc', key).maybeSingle();
    if (error) {
      setLastError('getUserProfile failed', error);
      console.error('getUserProfile:', error);
      return null;
    }
    return data || null;
  }

  async function updateUserProfile(username, fields) {
    const key = usernameKey(username);
    if (!key) return null;
    const updates = sanitizeProfileFields(fields || {});
    updates.updatedat = new Date().toISOString();
    const { data, error } = await db
      .from('users')
      .update(updates)
      .eq('username_lc', key)
      .select('*')
      .single();
    if (error) {
      setLastError('updateUserProfile failed', error);
      console.error('updateUserProfile:', error);
      return null;
    }
    return data;
  }

  // ── AUTH (SUPABASE AUTH) ──

  function getUsernameFromAuthUser(user, opts) {
    const allowLocalFallback = !opts || opts.allowLocalFallback !== false;
    const fromMeta = normalizeUsername(user?.user_metadata?.username);
    if (fromMeta) return fromMeta;
    if (allowLocalFallback) {
      const fromLocal = localStorage.getItem('agora_user');
      if (fromLocal) return normalizeUsername(fromLocal);
    }
    const fromEmail = String(user?.email || '').split('@')[0];
    return normalizeUsername(fromEmail);
  }

  async function signUpAccount({ username, email, password }) {
    setLastError('', null);
    const name = normalizeUsername(username);
    const emailNorm = String(email || '').trim().toLowerCase();

    if (!/^[A-Za-z0-9_.-]{2,30}$/.test(name)) {
      setLastError('signUp failed', { message: 'Username must be 2-30 chars: letters, numbers, _, -, .' });
      return { ok: false, error: lastError };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      setLastError('signUp failed', { message: 'Please enter a valid email address.' });
      return { ok: false, error: lastError };
    }
    if (!password || password.length < 6) {
      setLastError('signUp failed', { message: 'Password must be at least 6 characters.' });
      return { ok: false, error: lastError };
    }

    const existing = await getUserProfile(name);
    if (existing) {
      setLastError('signUp failed', { message: 'That username is already taken.' });
      return { ok: false, error: lastError, code: 'username_taken' };
    }

    const { data, error } = await db.auth.signUp({
      email: emailNorm,
      password,
      options: {
        data: { username: name },
        emailRedirectTo: buildEmailConfirmRedirectUrl(),
      },
    });
    if (error) {
      setLastError('signUp failed', error);
      return { ok: false, error: lastError };
    }

    const hasSession = !!data?.session;
    const authUser = data?.user || null;
    const authName = getUsernameFromAuthUser(authUser) || name;
    if (hasSession) localStorage.setItem('agora_user', authName);

    // Insert (not upsert) profile row — fails on conflict to prevent race condition
    // where two signups grab the same username between the check and auth.signUp.
    const { error: profileErr } = await db
      .from('users')
      .insert([{ username_lc: usernameKey(authName), username: authName }]);
    if (profileErr && profileErr.code === '23505') {
      // username_lc PK conflict — username was taken between check and insert
      setLastError('signUp failed', { message: 'That username is already taken.' });
      return { ok: false, error: lastError, code: 'username_taken' };
    }
    if (profileErr) {
      // Non-conflict error — log but don't block signup
      console.error('signUp profile insert:', profileErr);
    }

    return {
      ok: true,
      username: authName,
      needsEmailConfirm: !hasSession,
    };
  }

  async function signInAccount({ email, password }) {
    setLastError('', null);
    const emailNorm = String(email || '').trim().toLowerCase();
    const { data, error } = await db.auth.signInWithPassword({ email: emailNorm, password });
    if (error) {
      setLastError('signIn failed', error);
      return { ok: false, error: lastError };
    }
    const authName = getUsernameFromAuthUser(data?.user, { allowLocalFallback: false });
    if (!authName) {
      setLastError('signIn failed', { message: 'Could not resolve username for this account.' });
      return { ok: false, error: lastError };
    }
    localStorage.setItem('agora_user', authName);
    await ensureUserProfile(authName, {}, { silent: true });
    return { ok: true, username: authName };
  }

  async function signOutAccount() {
    setLastError('', null);
    const { error } = await db.auth.signOut();
    localStorage.removeItem('agora_user');
    if (error) {
      setLastError('signOut failed', error);
      return { ok: false, error: lastError };
    }
    return { ok: true };
  }

  async function syncAuthUser() {
    setLastError('', null);
    const { data, error } = await db.auth.getUser();
    if (error || !data?.user) {
      localStorage.removeItem('agora_user');
      if (error && error.message && !/Auth session missing/i.test(error.message)) {
        setLastError('syncAuthUser failed', error);
      }
      return null;
    }
    const authName = getUsernameFromAuthUser(data.user);
    if (!authName) return null;
    localStorage.setItem('agora_user', authName);
    await ensureUserProfile(authName, {}, { silent: true });
    return authName;
  }

  // ── POSTS ──

  async function createPost({ type, title, body, tags, position, confidence, openingArgument, whatWouldChangeMyMind }) {
    setLastError('', null);
    const post = {
      id:                    uid(),
      type,
      title,
      body,
      tags:                  tags || [],
      position:              position || null,
      confidence:            confidence || null,
      whatwouldchangemymind: whatWouldChangeMyMind || null,
      author:                currentUser(),
      createdat:             new Date().toISOString(),
      argcount:              0,
      forcount:              0,
      againstcount:          0,
      mindchanges:           0,
    };

    // Best-effort profile row for public profile pages.
    await ensureUserProfile(post.author, {}, { silent: true });

    const { error } = await db.from('posts').insert([post]);
    if (error) {
      setLastError('createPost failed', error);
      console.error('createPost:', error);
      return null;
    }

    // Upsert tags
    if (tags && tags.length) {
      const rows = tags.map(t => ({ tag: String(t).toLowerCase() }));
      const { error: tagErr } = await db.from('tags').upsert(rows, { onConflict: 'tag', ignoreDuplicates: true });
      if (tagErr) {
        setLastError('tags upsert failed', tagErr);
        console.error('tags upsert:', tagErr);
      }
    }

    // For debates: always create an opening 'For' argument so the creator is
    // counted in the forcount and appears in the thread. Body is the explicit
    // opening argument if provided, otherwise the post body (the thesis).
    if (post.type === 'debate') {
      const argBody = (openingArgument && openingArgument.trim()) ? openingArgument.trim() : post.body;
      const openingArg = await createArgument(post.id, {
        side:   'for',
        body:   argBody,
        author: post.author,
      });
      if (!openingArg && !lastError) {
        setLastError('opening argument failed', { message: 'Could not save opening argument.' });
      }
    }

    return post;
  }

  async function getPost(id) {
    const { data, error } = await db.from('posts').select('*').eq('id', id).single();
    if (error) {
      console.error('getPost:', error.message);
      return null;
    }
    return data;
  }

  async function getAllPosts() {
    const { data, error } = await db.from('posts').select('*').order('createdat', { ascending: false });
    if (error) { console.error('getAllPosts:', error.message); return []; }
    return data || [];
  }

  async function getPostsByType(type) {
    const { data, error } = await db.from('posts').select('*').eq('type', type).order('createdat', { ascending: false });
    if (error) return [];
    return data || [];
  }

  async function getRecentDebates(limit) {
    setLastError('', null);
    const n = Number(limit || 100);
    const safeLimit = Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : 100;
    const { data, error } = await db
      .from('posts')
      .select('*')
      .eq('type', 'debate')
      .order('createdat', { ascending: false })
      .limit(safeLimit);
    if (error) {
      setLastError('getRecentDebates failed', error);
      console.error('getRecentDebates:', error.message);
      return [];
    }
    return data || [];
  }

  async function isBotUiAdmin() {
    setLastError('', null);
    const { data, error } = await db.rpc('is_bot_ui_admin');
    if (error) {
      setLastError('isBotUiAdmin failed', error);
      console.error('isBotUiAdmin:', error.message);
      return false;
    }
    return !!data;
  }

  async function enqueueBotUiAction({ persona, action, debateId, forcedSide, responseLength }) {
    setLastError('', null);
    const validLengths = ['1', '2-3', '4-5', '6+'];
    const payload = {
      persona: String(persona || '').trim(),
      action: String(action || '').trim().toLowerCase(),
      debate_id: debateId || null,
      forced_side: forcedSide || null,
      response_length: validLengths.includes(responseLength) ? responseLength : '2-3',
    };

    const { data, error } = await db
      .from('bot_ui_actions')
      .insert([payload])
      .select('*')
      .single();

    if (error) {
      setLastError('enqueueBotUiAction failed', error);
      console.error('enqueueBotUiAction:', error.message);
      return null;
    }
    return data;
  }

  async function getBotUiActions(limit) {
    setLastError('', null);
    const n = Number(limit || 40);
    const safeLimit = Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : 40;
    const { data, error } = await db
      .from('bot_ui_actions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (error) {
      setLastError('getBotUiActions failed', error);
      console.error('getBotUiActions:', error.message);
      return [];
    }
    return data || [];
  }

  async function triggerBotUiRunner(actionId) {
    setLastError('', null);
    const body = {};
    if (actionId !== undefined && actionId !== null) body.actionId = Number(actionId);
    try {
      // First try official SDK invoke.
      let invoke = await db.functions.invoke('agorium-bot', { body });
      if (!invoke.error) return invoke.data || {};

      // Retry once after refreshing auth session when auth seems stale/expired.
      const invokeErr = String(invoke.error?.message || '');
      if (/401|unauthorized|jwt|token/i.test(invokeErr)) {
        await db.auth.refreshSession();
        invoke = await db.functions.invoke('agorium-bot', { body });
        if (!invoke.error) return invoke.data || {};
      }

      // Last fallback: direct HTTP call with explicit auth header.
      const { data: sessionData } = await db.auth.getSession();
      const accessToken = sessionData?.session?.access_token || '';
      const headers = {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
      };
      if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
      const resp = await fetch(SUPABASE_URL + '/functions/v1/agorium-bot', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const raw = await resp.text();
      let parsed = {};
      if (raw) {
        try { parsed = JSON.parse(raw); }
        catch { parsed = { raw }; }
      }
      if (!resp.ok) {
        const msg = parsed?.error || parsed?.raw || ('HTTP ' + resp.status);
        setLastError('triggerBotUiRunner failed', { message: msg });
        console.error('triggerBotUiRunner:', msg);
        return null;
      }
      return parsed || {};
    } catch (error) {
      setLastError('triggerBotUiRunner failed', error);
      console.error('triggerBotUiRunner:', error?.message || String(error));
      return null;
    }
  }

  async function updatePost(postId, { title, body, tags }) {
    setLastError('', null);
    const updates = {};
    if (title !== undefined) updates.title = String(title).trim().slice(0, 220);
    if (body  !== undefined) updates.body  = String(body).trim();
    if (tags  !== undefined) updates.tags  = tags;

    const { data, error } = await db
      .from('posts')
      .update(updates)
      .eq('id', postId)
      .select('*')
      .single();
    if (error) {
      setLastError('updatePost failed', error);
      console.error('updatePost:', error);
      return null;
    }

    // Upsert any new tags
    if (tags && tags.length) {
      const rows = tags.map(t => ({ tag: String(t).toLowerCase() }));
      await db.from('tags').upsert(rows, { onConflict: 'tag', ignoreDuplicates: true });
    }

    return data;
  }

  // ── ARGUMENTS ──

  async function createArgument(postId, { side, body, author }) {
    setLastError('', null);
    const arg = {
      id:            uid(),
      postid:        postId,
      side,
      body,
      author:        author || currentUser(),
      createdat:     new Date().toISOString(),
      steelmanned:   false,
      steelmancount: 0,
    };

    // Best-effort profile row for public profile pages.
    await ensureUserProfile(arg.author, {}, { silent: true });

    const { error } = await db.from('arguments').insert([arg]);
    if (error) {
      setLastError('createArgument failed', error);
      console.error('createArgument:', error);
      return null;
    }

    // Init vote row for this argument
    await db.from('votes').insert([{ id: arg.id, argid: arg.id, up: 0, down: 0 }]);

    // Increment post counters
    const post = await getPost(postId);
    if (post) {
      const updates = { argcount: (post.argcount || 0) + 1 };
      if (side === 'for')     updates.forcount     = (post.forcount || 0) + 1;
      if (side === 'against') updates.againstcount = (post.againstcount || 0) + 1;
      await db.from('posts').update(updates).eq('id', postId);
    }

    return arg;
  }

  async function getArguments(postId) {
    const { data, error } = await db
      .from('arguments')
      .select('*')
      .eq('postid', postId)
      .order('createdat', { ascending: true });
    if (error) { console.error('getArguments:', error.message); return []; }
    return data || [];
  }

  // ── VOTES ──
  // Per-user vote direction is tracked in localStorage until real auth exists.

  async function vote(argId, dir) {
    const { data: existing } = await db.from('votes').select('*').eq('id', argId).single();
    const v = { up: existing?.up || 0, down: existing?.down || 0 };

    const key      = 'uv_' + argId;
    const userVote = localStorage.getItem(key);

    if (userVote === dir) {
      // toggle off
      v[dir] = Math.max(0, v[dir] - 1);
      localStorage.removeItem(key);
    } else {
      if (userVote) v[userVote] = Math.max(0, v[userVote] - 1);
      v[dir]++;
      localStorage.setItem(key, dir);
    }

    await db.from('votes').upsert({ id: argId, argid: argId, up: v.up, down: v.down });
    return { up: v.up, down: v.down, userVote: localStorage.getItem(key) };
  }

  async function getVotes(argId) {
    const { data } = await db.from('votes').select('*').eq('id', argId).single();
    return {
      up:       data?.up  || 0,
      down:     data?.down || 0,
      userVote: localStorage.getItem('uv_' + argId),
    };
  }

  // Fetch votes for many args in one query — used by renderThread
  async function getVotesBatch(argIds) {
    if (!argIds.length) return {};
    const { data } = await db.from('votes').select('*').in('id', argIds);
    const map = {};
    (data || []).forEach(v => {
      map[v.id] = { up: v.up || 0, down: v.down || 0, userVote: localStorage.getItem('uv_' + v.id) };
    });
    argIds.forEach(id => { if (!map[id]) map[id] = { up: 0, down: 0, userVote: null }; });
    return map;
  }

  // ── STEELMAN ──

  async function toggleSteelman(argId) {
    const { data } = await db.from('arguments').select('steelmanned, steelmancount').eq('id', argId).single();
    if (!data) return false;
    const newVal = !data.steelmanned;
    await db.from('arguments').update({
      steelmanned:   newVal,
      steelmancount: newVal ? (data.steelmancount || 0) + 1 : Math.max(0, (data.steelmancount || 0) - 1),
    }).eq('id', argId);
    return newVal;
  }

  // ── MIND CHANGE ──

  async function declareMindChange(postId, text) {
    setLastError('', null);
    const { error: insertErr } = await db.from('mindchanges').insert([{
      id:        uid(),
      postid:    postId,
      text,
      createdat: new Date().toISOString(),
    }]);
    if (insertErr) {
      setLastError('declareMindChange insert failed', insertErr);
      console.error('declareMindChange insert:', insertErr);
      return false;
    }
    const post = await getPost(postId);
    if (post) {
      const { error: updateErr } = await db.from('posts').update({ mindchanges: (post.mindchanges || 0) + 1 }).eq('id', postId);
      if (updateErr) {
        setLastError('declareMindChange update failed', updateErr);
        console.error('declareMindChange update:', updateErr);
        return false;
      }
    }
    return true;
  }

  // ── CURRENT POST — stays in localStorage (cross-page navigation only) ──

  function setCurrentPost(postId) {
    localStorage.setItem('agora_current_post', postId);
  }

  async function getCurrentPost() {
    const id = localStorage.getItem('agora_current_post');
    return id ? getPost(id) : null;
  }

  // ── TAGS ──

  async function getAllTags() {
    const { data } = await db.from('tags').select('tag');
    return (data || []).map(r => r.tag);
  }

  // ── RENDER HELPERS (sync — data is passed in, no DB calls) ──────────────────

  function renderPostCard(post) {
    const typeColors = {
      debate:     { border: 'var(--red)',   badge: 'rgba(164,22,35,0.08)',   color: 'var(--red)'   },
      discussion: { border: 'var(--blue)',  badge: 'rgba(113,169,247,0.1)',  color: 'var(--blue)'  },
      question:   { border: 'var(--green)', badge: 'rgba(53,143,101,0.08)', color: 'var(--green)' },
    };
    const t      = typeColors[post.type] || typeColors.discussion;
    const tags   = post.tags || [];
    const tagHtml = tags.slice(0, 3).map(tag =>
      `<span style="font-family:'Cinzel',serif;font-size:10px;letter-spacing:0.08em;padding:3px 8px;border-radius:2px;background:rgba(46,80,119,0.08);color:var(--navy);">${tag}</span>`
    ).join('');

    const body = post.body || '';
    return `
      <div class="post-card" onclick="AgoraStore.setCurrentPost('${post.id}');location.href='debate.html'" style="
        display:block; text-decoration:none; color:inherit;
        background:white; border:1px solid rgba(46,80,119,0.12);
        border-left:4px solid ${t.border}; border-radius:3px;
        padding:28px; transition:all 0.25s; cursor:pointer;
      " onmouseover="this.style.transform='translateY(-3px)';this.style.boxShadow='0 8px 30px rgba(46,80,119,0.1)'"
         onmouseout="this.style.transform='';this.style.boxShadow=''">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
          <span style="font-family:'Cinzel',serif;font-size:9px;letter-spacing:0.2em;text-transform:uppercase;padding:3px 10px;border-radius:20px;background:${t.badge};color:${t.color};">${post.type}</span>
          ${tagHtml}
        </div>
        <div style="font-family:'Cinzel',serif;font-size:17px;font-weight:600;color:var(--navy);line-height:1.3;margin-bottom:10px;">${escHtml(post.title)}</div>
        <div style="font-size:14px;color:#777;line-height:1.6;margin-bottom:18px;">${escHtml(body.slice(0, 140))}${body.length > 140 ? '…' : ''}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid rgba(0,0,0,0.06);padding-top:14px;font-size:13px;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;gap:8px;align-items:center;">
            ${post.type === 'debate' ? `
              <span style="font-family:'Cinzel',serif;font-size:10px;padding:3px 10px;border-radius:20px;background:rgba(53,143,101,0.1);color:var(--green);">${post.forcount || 0} For</span>
              <span style="font-family:'Cinzel',serif;font-size:10px;padding:3px 10px;border-radius:20px;background:rgba(164,22,35,0.08);color:var(--red);">${post.againstcount || 0} Against</span>
            ` : `<span style="color:#aaa;">${post.argcount || 0} ${post.argcount === 1 ? 'reply' : 'replies'}</span>`}
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <a href="${profileUrl(post.author || '')}" onclick="event.stopPropagation()" style="font-family:'Cinzel',serif;font-size:11px;letter-spacing:0.05em;color:var(--navy);text-decoration:none;opacity:0.7;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">${escHtml(post.author || 'unknown')}</a>
            <span style="color:#bbb;font-family:'Cinzel',serif;font-size:11px;letter-spacing:0.05em;">${timeAgo(post.createdat)}</span>
          </div>
        </div>
      </div>`;
  }

  // voteMap = { [argId]: { up, down, userVote } } — pre-fetched by renderThread
  function renderArgCard(arg, voteMap) {
    const v           = (voteMap && voteMap[arg.id]) || { up: 0, down: 0, userVote: null };
    const side        = arg.side || 'for';
    const badgeClass  = side === 'for' ? 'badge-for' : side === 'against' ? 'badge-against' : 'badge-undecided';
    const sideLabel   = side === 'for' ? 'For' : side === 'against' ? 'Against' : 'Undecided';
    const authorName  = String(arg.author || 'Unknown');
    const initials    = authorName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const bodyEsc     = escHtml(arg.body || '');
    const authorEsc   = escHtml(authorName);
    const authorHref  = profileUrl(authorName);

    const bodyHtml = (function () {
      const raw = String(arg.body || '');
      if (raw.startsWith('> ')) {
        const newlineIdx = raw.indexOf('\n\n');
        const quotePart  = newlineIdx > -1 ? raw.slice(0, newlineIdx) : raw;
        const replyPart  = newlineIdx > -1 ? raw.slice(newlineIdx + 2) : '';
        const match      = quotePart.match(/^> (.+?): "(.+)"$/s);
        if (match) {
          const qAttr = escHtml(match[1]);
          const qText = escHtml(match[2]);
          const rText = replyPart ? parseMarkdown(replyPart) : '';
          return '<div class="quote-block"><span class="quote-attr">' + qAttr + ' said:</span>' + qText + '</div>' +
                 (rText ? '<p class="arg-body">' + rText + '</p>' : '');
        }
      }
      return '<p class="arg-body">' + parseMarkdown(arg.body || '') + '</p>';
    })();

    return `
      <div class="arg-card ${side}" id="arg-${arg.id}">
        <div class="arg-header">
          <div class="arg-author">
            <div class="avatar" style="background:var(--navy);">${initials}</div>
            <div class="arg-meta">
              <a class="arg-name" href="${authorHref}" style="text-decoration:none;">${authorEsc}</a>
              <span class="arg-time">${timeAgo(arg.createdat)}</span>
            </div>
          </div>
          <span class="arg-side-badge ${badgeClass}">${sideLabel}</span>
        </div>
        ${bodyHtml}
        <div class="arg-footer">
          <button class="arg-action quote-btn" onclick="quoteArg('${escJsAttr(arg.id)}', '${escJsAttr(authorName)}')">❝ Quote</button>
          <button class="arg-action report-btn" onclick="openReport('${arg.id}')">⚑ Report</button>
          <div class="arg-votes">
            <button class="vote-btn up ${v.userVote === 'up' ? 'active-up' : ''}"
              onclick="handleVote('${arg.id}', 'up')">▲</button>
            <span class="vote-count" id="votes-${arg.id}">${v.up - v.down}</span>
            <button class="vote-btn down ${v.userVote === 'down' ? 'active-down' : ''}"
              onclick="handleVote('${arg.id}', 'down')">▼</button>
          </div>
        </div>
      </div>`;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Escape a string for use inside inline JS in HTML attributes (onclick, etc.)
  // Backslash-escapes quotes so the value is safe inside JS string literals.
  function escJsAttr(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
  }

  // Simple inline Markdown renderer.
  // Input must be pre-escaped with escHtml — patterns match only on escaped text.
  // Supported: **bold**, *italic*, _italic_, ~~strikethrough~~, newlines → <br>
  function parseMarkdown(rawStr) {
    let s = escHtml(rawStr);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/_(.+?)_/g, '<em>$1</em>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  // ── PUBLIC API ──
  window.AgoraStore = {
    signUpAccount, signInAccount, signOutAccount, syncAuthUser,
    createPost, getPost, getAllPosts, getPostsByType, updatePost,
    getRecentDebates,
    setCurrentPost, getCurrentPost,
    createArgument, getArguments,
    vote, getVotes, getVotesBatch,
    toggleSteelman,
    declareMindChange,
    isBotUiAdmin, enqueueBotUiAction, getBotUiActions, triggerBotUiRunner,
    getAllTags,
    ensureUserProfile, getUserProfile, updateUserProfile, profileUrl,
    getLastError: () => lastError,
    renderPostCard, renderArgCard,
    timeAgo, escHtml, escJsAttr, parseMarkdown,
  };

  console.log('AgoraStore ready (Supabase)');
})();
