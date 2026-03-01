/**
 * store.js — The Agora
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

  // ── POSTS ──

  async function createPost({ type, title, body, tags, position, confidence, openingArgument, whatWouldChangeMyMind }) {
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

    const { error } = await db.from('posts').insert([post]);
    if (error) { console.error('createPost:', error.message); return null; }

    // Upsert tags
    if (tags && tags.length) {
      const rows = tags.map(t => ({ tag: String(t).toLowerCase() }));
      await db.from('tags').upsert(rows, { onConflict: 'tag', ignoreDuplicates: true });
    }

    // Opening argument
    if (openingArgument && openingArgument.trim()) {
      await createArgument(post.id, {
        side:   position === 'for' || position === 'against' ? position : 'for',
        body:   openingArgument,
        author: post.author,
      });
    }

    return post;
  }

  async function getPost(id) {
    const { data, error } = await db.from('posts').select('*').eq('id', id).single();
    if (error) return null;
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

  // ── ARGUMENTS ──

  async function createArgument(postId, { side, body, author }) {
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

    const { error } = await db.from('arguments').insert([arg]);
    if (error) { console.error('createArgument:', error.message); return null; }

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
    await db.from('mindchanges').insert([{
      id:        uid(),
      postid:    postId,
      text,
      createdat: new Date().toISOString(),
    }]);
    const post = await getPost(postId);
    if (post) {
      await db.from('posts').update({ mindchanges: (post.mindchanges || 0) + 1 }).eq('id', postId);
    }
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

    return `
      <a class="post-card" href="debate.html" onclick="AgoraStore.setCurrentPost('${post.id}')" style="
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
        <div style="font-size:14px;color:#777;line-height:1.6;margin-bottom:18px;">${escHtml(post.body.slice(0, 140))}${post.body.length > 140 ? '…' : ''}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid rgba(0,0,0,0.06);padding-top:14px;font-size:13px;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;gap:8px;">
            ${post.type === 'debate' ? `
              <span style="font-family:'Cinzel',serif;font-size:10px;padding:3px 10px;border-radius:20px;background:rgba(53,143,101,0.1);color:var(--green);">${post.forcount || 0} For</span>
              <span style="font-family:'Cinzel',serif;font-size:10px;padding:3px 10px;border-radius:20px;background:rgba(164,22,35,0.08);color:var(--red);">${post.againstcount || 0} Against</span>
            ` : `<span style="color:#aaa;">${post.argcount || 0} ${post.argcount === 1 ? 'reply' : 'replies'}</span>`}
          </div>
          <span style="color:#bbb;font-family:'Cinzel',serif;font-size:11px;letter-spacing:0.05em;">${timeAgo(post.createdat)}</span>
        </div>
      </a>`;
  }

  // voteMap = { [argId]: { up, down, userVote } } — pre-fetched by renderThread
  function renderArgCard(arg, voteMap) {
    const v           = (voteMap && voteMap[arg.id]) || { up: 0, down: 0, userVote: null };
    const side        = arg.side || 'for';
    const badgeClass  = side === 'for' ? 'badge-for' : side === 'against' ? 'badge-against' : 'badge-undecided';
    const sideLabel   = side === 'for' ? 'For' : side === 'against' ? 'Against' : 'Undecided';
    const initials    = arg.author.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const bodyEsc     = escHtml(arg.body);

    const bodyHtml = (function () {
      const raw = arg.body;
      if (raw.startsWith('> ')) {
        const newlineIdx = raw.indexOf('\n\n');
        const quotePart  = newlineIdx > -1 ? raw.slice(0, newlineIdx) : raw;
        const replyPart  = newlineIdx > -1 ? raw.slice(newlineIdx + 2) : '';
        const match      = quotePart.match(/^> (.+?): "(.+)"$/s);
        if (match) {
          const qAttr = escHtml(match[1]);
          const qText = escHtml(match[2]);
          const rText = escHtml(replyPart).replace(/\n/g, '<br>');
          return '<div class="quote-block"><span class="quote-attr">' + qAttr + ' said:</span>' + qText + '</div>' +
                 (rText ? '<p class="arg-body">' + rText + '</p>' : '');
        }
      }
      return '<p class="arg-body">' + bodyEsc.replace(/\n/g, '<br>') + '</p>';
    })();

    return `
      <div class="arg-card ${side}" id="arg-${arg.id}">
        <div class="arg-header">
          <div class="arg-author">
            <div class="avatar" style="background:var(--navy);">${initials}</div>
            <div class="arg-meta">
              <span class="arg-name">${escHtml(arg.author)}</span>
              <span class="arg-time">${timeAgo(arg.createdat)}</span>
            </div>
          </div>
          <span class="arg-side-badge ${badgeClass}">${sideLabel}</span>
        </div>
        ${bodyHtml}
        <div class="arg-footer">
          <button class="arg-action quote-btn" onclick="quoteArg('${arg.id}', '${escHtml(arg.author).replace(/'/g, "\\'")}')">❝ Quote</button>
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
      .replace(/"/g, '&quot;');
  }

  // ── PUBLIC API ──
  window.AgoraStore = {
    createPost, getPost, getAllPosts, getPostsByType,
    setCurrentPost, getCurrentPost,
    createArgument, getArguments,
    vote, getVotes, getVotesBatch,
    toggleSteelman,
    declareMindChange,
    getAllTags,
    renderPostCard, renderArgCard,
    timeAgo, escHtml,
  };

  console.log('AgoraStore ready (Supabase)');
})();
