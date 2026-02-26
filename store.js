/**
 * store.js — The Agora
 * In-memory data store. All posts, arguments, tags, and votes live here.
 * Designed to be swapped out for Firebase with minimal changes.
 * All pages communicate through window.AgoraStore.
 */

(function () {
  'use strict';

  // ── STORAGE KEYS ──
  const POSTS_KEY   = 'agora_posts';
  const ARGS_KEY    = 'agora_arguments';
  const TAGS_KEY    = 'agora_tags';
  const VOTES_KEY   = 'agora_votes';
  const CURRENT_KEY = 'agora_current_post';

  // ── HELPERS ──
  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn('Store save failed:', e); }
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function timeAgo(iso) {
    const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (diff < 60)  return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
    return Math.floor(diff / 86400) + ' days ago';
  }

  // ── DATA ──
  let posts     = load(POSTS_KEY, []);
  let args      = load(ARGS_KEY, {});   // { postId: [argument, ...] }
  let allTags   = load(TAGS_KEY, [
    'democracy', 'free speech', 'ethics', 'economics', 'philosophy',
    'technology', 'AI', 'climate', 'justice', 'history', 'law', 'policy',
    'science', 'religion', 'capitalism', 'equality', 'rights', 'education'
  ]);
  let votes     = load(VOTES_KEY, {}); // { argId: { up: 0, down: 0 } }

  // ── POST CRUD ──

  /**
   * Create a new post (debate, discussion, or question).
   * Returns the new post object.
   */
  function createPost({ type, title, body, tags, position, confidence, openingArgument, whatWouldChangeMyMind }) {
    const post = {
      id:          uid(),
      type,        // 'debate' | 'discussion' | 'question'
      title,
      body,
      tags:        tags || [],
      position:    position || null,   // 'for' | 'against' | 'undecided' | null
      confidence:  confidence || null,
      whatWouldChangeMyMind: whatWouldChangeMyMind || null,
      author:      'You',             // Replace with real user when auth exists
      createdAt:   new Date().toISOString(),
      argCount:    0,
      forCount:    0,
      againstCount: 0,
      mindChanges: 0,
    };

    posts.unshift(post);
    save(POSTS_KEY, posts);

    // Register new tags
    tags.forEach(t => { if (!allTags.includes(t)) allTags.push(t); });
    save(TAGS_KEY, allTags);

    // If there's an opening argument, add it
    if (openingArgument && openingArgument.trim()) {
      createArgument(post.id, {
        side: position === 'for' || position === 'against' ? position : 'for',
        body: openingArgument,
        author: 'You',
        whatWouldChangeMyMind,
      });
    }

    return post;
  }

  function getPost(id) {
    return posts.find(p => p.id === id) || null;
  }

  function getAllPosts() {
    return [...posts];
  }

  function getPostsByType(type) {
    return posts.filter(p => p.type === type);
  }

  // ── ARGUMENT CRUD ──

  function createArgument(postId, { side, body, author, whatWouldChangeMyMind }) {
    const arg = {
      id:          uid(),
      postId,
      side,        // 'for' | 'against'
      body,
      author:      author || 'You',
      createdAt:   new Date().toISOString(),
      steelmanned: false,
      steelmanCount: 0,
    };

    if (!args[postId]) args[postId] = [];
    args[postId].unshift(arg);
    save(ARGS_KEY, args);

    // Update post counts
    const post = getPost(postId);
    if (post) {
      post.argCount++;
      if (side === 'for')     post.forCount++;
      if (side === 'against') post.againstCount++;
      save(POSTS_KEY, posts);
    }

    // Init votes
    votes[arg.id] = { up: 0, down: 0, userVote: null };
    save(VOTES_KEY, votes);

    return arg;
  }

  function getArguments(postId) {
    return args[postId] || [];
  }

  // ── VOTES ──

  function vote(argId, dir) {
    if (!votes[argId]) votes[argId] = { up: 0, down: 0, userVote: null };
    const v = votes[argId];
    if (v.userVote === dir) {
      // undo
      v[dir]--;
      v.userVote = null;
    } else {
      if (v.userVote) v[v.userVote]--;
      v[dir]++;
      v.userVote = dir;
    }
    save(VOTES_KEY, votes);
    return v;
  }

  function getVotes(argId) {
    return votes[argId] || { up: 0, down: 0, userVote: null };
  }

  // ── STEELMAN ──

  function toggleSteelman(argId) {
    for (const postId in args) {
      const arg = args[postId].find(a => a.id === argId);
      if (arg) {
        arg.steelmanned = !arg.steelmanned;
        arg.steelmanCount += arg.steelmanned ? 1 : -1;
        save(ARGS_KEY, args);
        return arg.steelmanned;
      }
    }
    return false;
  }

  // ── MIND CHANGE ──

  function declareMindChange(postId, text) {
    const post = getPost(postId);
    if (post) {
      post.mindChanges++;
      save(POSTS_KEY, posts);
    }
    // In real app: store mind change record for Hall of Fame
    console.log('Mind change declared for post', postId, ':', text);
  }

  // ── CURRENT POST (cross-page navigation) ──
  // submit.html sets this; debate.html reads it.

  function setCurrentPost(postId) {
    save(CURRENT_KEY, postId);
  }

  function getCurrentPost() {
    const id = load(CURRENT_KEY, null);
    return id ? getPost(id) : null;
  }

  // ── TAGS ──

  function getAllTags() {
    return [...allTags];
  }

  // ── RENDER HELPERS ──
  // Shared rendering logic used by both index.html and debate.html

  function renderPostCard(post) {
    const typeColors = {
      debate:     { border: 'var(--red)',   badge: 'rgba(164,22,35,0.08)',   color: 'var(--red)' },
      discussion: { border: 'var(--blue)',  badge: 'rgba(113,169,247,0.1)',  color: 'var(--blue)' },
      question:   { border: 'var(--green)', badge: 'rgba(53,143,101,0.08)', color: 'var(--green)' },
    };
    const t = typeColors[post.type] || typeColors.discussion;
    const tagHtml = post.tags.slice(0, 3).map(tag =>
      `<span style="font-family:'Cinzel',serif;font-size:10px;letter-spacing:0.08em;padding:3px 8px;border-radius:2px;background:rgba(46,80,119,0.08);color:var(--navy);">${tag}</span>`
    ).join('');

    return `
      <a class="post-card" href="debate.html" onclick="AgoraStore.setCurrentPost('${post.id}')" style="
        display:block; text-decoration:none; color:inherit;
        background:white;
        border:1px solid rgba(46,80,119,0.12);
        border-left:4px solid ${t.border};
        border-radius:3px;
        padding:28px;
        transition:all 0.25s;
        cursor:pointer;
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
              <span style="font-family:'Cinzel',serif;font-size:10px;padding:3px 10px;border-radius:20px;background:rgba(53,143,101,0.1);color:var(--green);">${post.forCount} For</span>
              <span style="font-family:'Cinzel',serif;font-size:10px;padding:3px 10px;border-radius:20px;background:rgba(164,22,35,0.08);color:var(--red);">${post.againstCount} Against</span>
            ` : `<span style="color:#aaa;">${post.argCount} ${post.argCount === 1 ? 'reply' : 'replies'}</span>`}
          </div>
          <span style="color:#bbb;font-family:'Cinzel',serif;font-size:11px;letter-spacing:0.05em;">${timeAgo(post.createdAt)}</span>
        </div>
      </a>`;
  }

  function renderArgCard(arg, postId) {
    const v = getVotes(arg.id);
    const isFor = arg.side === 'for';
    const borderColor = isFor ? 'var(--green)' : 'var(--red)';
    const borderBg    = isFor ? 'rgba(53,143,101,0.15)' : 'rgba(164,22,35,0.12)';
    const badgeClass  = isFor ? 'badge-for' : 'badge-against';
    const sideLabel   = isFor ? 'For' : 'Against';
    const initials    = arg.author.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const avatarBg    = isFor ? 'var(--green)' : 'var(--red)';

    const steelHtml = arg.steelmanned
      ? `<span class="steelman-badge">★ Steelmanned ×${arg.steelmanCount}</span>`
      : '';

    return `
      <div class="arg-card ${arg.side}" id="arg-${arg.id}" style="border-left-color:${borderColor};border-color:${borderBg};">
        <div class="arg-header">
          <div class="arg-author">
            <div class="avatar" style="background:${avatarBg};">${initials}</div>
            <div class="arg-meta">
              <span class="arg-name">${escHtml(arg.author)}</span>
              <span class="arg-time">${timeAgo(arg.createdAt)}</span>
            </div>
          </div>
          <span class="arg-side-badge ${badgeClass}">${sideLabel}</span>
        </div>
        <p class="arg-body">${escHtml(arg.body).replace(/\n/g, '<br>')}</p>
        <div class="arg-footer">
          <button class="arg-action steelman ${arg.steelmanned ? 'active' : ''}"
            onclick="handleSteelman('${arg.id}', this)">⭐ ${arg.steelmanned ? 'Steelmanned' : 'Steelman'}</button>
          ${steelHtml}
          <div class="arg-votes">
            <button class="vote-btn up ${v.userVote === 'up' ? 'active-up' : ''}"
              onclick="handleVote('${arg.id}', 'up', this)">▲</button>
            <span class="vote-count" id="votes-${arg.id}">${v.up - v.down}</span>
            <button class="vote-btn down ${v.userVote === 'down' ? 'active-down' : ''}"
              onclick="handleVote('${arg.id}', 'down', this)">▼</button>
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
    // Posts
    createPost,
    getPost,
    getAllPosts,
    getPostsByType,
    setCurrentPost,
    getCurrentPost,

    // Arguments
    createArgument,
    getArguments,

    // Votes & steelman
    vote,
    getVotes,
    toggleSteelman,

    // Mind change
    declareMindChange,

    // Tags
    getAllTags,

    // Render helpers
    renderPostCard,
    renderArgCard,
    timeAgo,
    escHtml,
  };

  console.log('AgoraStore ready. Posts:', posts.length);
})();
