/* ============================================================
   Spikegolf Tracker — GKBS / Obiralm
   Vanilla JS, offline-first, localStorage persistence.
   ============================================================ */

(() => {
  'use strict';

  const STORE_KEY = 'spikegolf.v1';
  const OBSTACLE_TYPES = [
    { key: 'baum',  emoji: '🌲', label: 'Baum' },
    { key: 'dach',  emoji: '🏠', label: 'Dach' },
    { key: 'stein', emoji: '🪨', label: 'Stein' },
    { key: 'zaun',  emoji: '🚧', label: 'Zaun' },
    { key: 'wasser',emoji: '💧', label: 'Wasser' },
    { key: 'sonst', emoji: '🎯', label: 'Sonstiges' },
  ];
  const AVATAR_COLORS = ['#2d6a4f','#40916c','#e08e0b','#c0392b','#2f6fb3','#7b4fb3','#0e8a7f','#b3532f'];

  // Aerial map of the alm (cropped from the satellite screenshot).
  // Positions are stored as fractions (0..1) of the image, so the
  // image can be swapped for a higher-res version later.
  const MAP = { src: 'map.jpg', aspect: 1065 / 990 };
  const ROUTE_COLORS = ['#ffd23f','#4dabf7','#ff6b35','#da77f2','#63e6be','#ffa94d','#74c0fc','#f783ac'];

  /* ---------------- State ---------------- */
  const defaultState = () => ({
    players: [],   // {id, name, color}
    courses: [],   // {id, name, par, start, end, elevation, obstacles:[{id,type,text}]}
    scores: {},    // { [courseId]: { [playerId]: strokes } }
    activeCourseId: null,
    tab: 'leaderboard',
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      return Object.assign(defaultState(), JSON.parse(raw));
    } catch (e) {
      console.warn('Load failed', e);
      return defaultState();
    }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('Save failed', e); }
  }

  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

  /* ---------------- Helpers ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const initials = (name) => name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';

  function scoreFor(courseId, playerId) {
    return (state.scores[courseId] && state.scores[courseId][playerId]) || 0;
  }
  function setScore(courseId, playerId, val) {
    if (!state.scores[courseId]) state.scores[courseId] = {};
    state.scores[courseId][playerId] = Math.max(0, val);
    save();
  }
  function coursePlayed(courseId) {
    const s = state.scores[courseId] || {};
    return state.players.some(p => (s[p.id] || 0) > 0);
  }
  function totalPar() { return state.courses.reduce((a, c) => a + (Number(c.par) || 0), 0); }

  // Leaderboard: total strokes across ALL courses per player (golf: fewer = better)
  function leaderboard() {
    const rows = state.players.map(p => {
      let total = 0, played = 0, parPlayed = 0;
      state.courses.forEach(c => {
        const s = scoreFor(c.id, p.id);
        if (s > 0) { total += s; played++; parPlayed += (Number(c.par) || 0); }
      });
      return { player: p, total, played, parPlayed, toPar: total - parPlayed };
    });
    rows.sort((a, b) => {
      if (b.played !== a.played) {
        // players who've played more courses aren't penalised in ordering:
        // rank by total, but people with 0 played go last
      }
      if (a.played === 0 && b.played === 0) return 0;
      if (a.played === 0) return 1;
      if (b.played === 0) return -1;
      return a.total - b.total;
    });
    return rows;
  }

  /* ---------------- Map rendering ---------------- */
  const hasRoute = (c) => !!(c.startPos && c.endPos);

  // Geometry of a course route in SVG viewBox units (1000 x 1000*aspect).
  function routeGeom(c) {
    const W = 1000, H = Math.round(1000 * MAP.aspect);
    const x1 = c.startPos.x * W, y1 = c.startPos.y * H;
    const x2 = c.endPos.x * W, y2 = c.endPos.y * H;
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const off = Math.min(60, len * 0.18); // gentle arc
    const cx = (x1 + x2) / 2 - dy / len * off;
    const cy = (y1 + y2) / 2 + dx / len * off;
    return { x1, y1, x2, y2, cx, cy, W, H };
  }

  function routeSvg(c, colorIdx) {
    if (!hasRoute(c)) return '';
    const g = routeGeom(c);
    const d = `M${g.x1.toFixed(1)},${g.y1.toFixed(1)} Q${g.cx.toFixed(1)},${g.cy.toFixed(1)} ${g.x2.toFixed(1)},${g.y2.toFixed(1)}`;
    const col = ROUTE_COLORS[colorIdx % ROUTE_COLORS.length];
    return `<path d="${d}" fill="none" stroke="rgba(10,25,15,0.55)" stroke-width="11" stroke-linecap="round" stroke-dasharray="1 16"/>
      <path d="${d}" fill="none" stroke="${col}" stroke-width="6.5" stroke-linecap="round" stroke-dasharray="1 16"/>`;
  }

  function mapMarkers(c, opts = {}) {
    const pct = (p) => `left:${(p.x * 100).toFixed(2)}%;top:${(p.y * 100).toFixed(2)}%`;
    let h = '';
    if (c.startPos) h += `<span class="mk mk-flag" style="${pct(c.startPos)}">🚩</span>`;
    if (c.endPos) h += `<span class="mk mk-finish" style="${pct(c.endPos)}">🏁</span>`;
    (c.obstacles || []).forEach(o => {
      if (!o.pos) return;
      const t = OBSTACLE_TYPES.find(x => x.key === o.type) || OBSTACLE_TYPES[5];
      h += `<span class="mk mk-obs" data-obs="${o.id}" style="${pct(o.pos)}">${t.emoji}</span>`;
    });
    if (opts.badge != null && hasRoute(c)) {
      const g = routeGeom(c);
      const bx = (0.25 * g.x1 + 0.5 * g.cx + 0.25 * g.x2) / g.W * 100;
      const by = (0.25 * g.y1 + 0.5 * g.cy + 0.25 * g.y2) / g.H * 100;
      h += `<button class="mk mk-badge ${coursePlayed(c.id) ? 'done' : ''}" data-badge="${c.id}"
        style="left:${bx.toFixed(2)}%;top:${by.toFixed(2)}%">${opts.badge}</button>`;
    }
    return h;
  }

  // items: [{ course, n?, colorIdx? }] — renders the aerial map with routes/markers.
  function mapBlock(items, opts = {}) {
    const H = Math.round(1000 * MAP.aspect);
    let svg = '', marks = '';
    items.forEach((it, i) => {
      svg += routeSvg(it.course, it.colorIdx ?? i);
      marks += mapMarkers(it.course, { badge: it.n });
    });
    return `<div class="map-frame">
      <div class="map-scroll" style="${opts.maxHeight ? `max-height:${opts.maxHeight}` : ''}">
        <div class="map-wrap ${opts.editing ? 'editing' : ''}" ${opts.id ? `id="${opts.id}"` : ''}>
          <img src="${MAP.src}" alt="Karte der Alm">
          <svg viewBox="0 0 1000 ${H}" preserveAspectRatio="none">${svg}</svg>
          ${marks}
        </div>
      </div>
      ${opts.zoom ? `<button class="map-zoom" data-zoom aria-label="Zoom">⊕</button>` : ''}
    </div>`;
  }

  // Wire zoom toggle for a rendered mapBlock (call after inserting into DOM).
  function wireMapZoom(frame) {
    const btn = frame.querySelector('[data-zoom]');
    if (!btn) return;
    const wrap = frame.querySelector('.map-wrap');
    btn.addEventListener('click', () => {
      const zoomed = wrap.style.width === '220%';
      wrap.style.width = zoomed ? '100%' : '220%';
      btn.textContent = zoomed ? '⊕' : '⊖';
    });
  }

  /* ---------------- Toast ---------------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1900);
  }

  /* ---------------- Bottom sheet ---------------- */
  function openSheet(html) {
    $('#sheetBody').innerHTML = '';
    $('#sheetBody').appendChild(typeof html === 'string' ? el(`<div>${html}</div>`) : html);
    $('#sheet').hidden = false;
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheetBody').innerHTML = ''; }
  $('#sheet').addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) closeSheet(); });

  /* ============================================================
     VIEWS
     ============================================================ */
  const view = $('#view');

  function render() {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
    view.scrollTop = 0;
    window.scrollTo(0, 0);
    ({
      leaderboard: renderLeaderboard,
      play: renderPlay,
      map: renderMap,
      courses: renderCourses,
      players: renderPlayers,
    }[state.tab] || renderLeaderboard)();
  }

  /* ---------- Leaderboard ---------- */
  function renderLeaderboard() {
    const rows = leaderboard();
    const anyPlayed = rows.some(r => r.played > 0);
    let html = `<div class="hero">
      <img src="hero.jpg" alt="Obiralmhütte">
      <div class="hero-grad"></div>
      <div class="hero-text">
        <h1>Rangliste</h1>
        <p>Obiralm-Turnier · Gesamtschläge über alle Kurse — wenig gewinnt.</p>
      </div>
    </div>`;

    if (state.players.length === 0) {
      html += emptyState('🏆', 'Noch keine Spieler', 'Lege zuerst ein paar Spieler an, dann kann das Turnier starten.', 'Spieler anlegen', "go('players')");
      view.innerHTML = html;
      return;
    }

    if (!anyPlayed) {
      html += `<div class="card"><div class="empty" style="padding:24px 8px">
        <span class="empty-emoji">🎬</span>
        <h3>Turnier noch nicht gestartet</h3>
        <p>Sobald ihr auf den Kursen Schläge eintragt, erscheint hier die Rangliste.</p>
        <button class="btn btn-primary" onclick="go('play')">Jetzt spielen</button>
      </div></div>`;
    }

    html += `<div>`;
    rows.forEach((r, i) => {
      const rankClass = r.played === 0 ? '' : `rank-${i + 1}`;
      const badge = r.played === 0 ? '–' : (i + 1);
      const toPar = r.played === 0 ? '' : topArLabel(r.toPar);
      html += `<div class="rank-row ${i === 0 && r.played ? 'gold' : ''}">
        <div class="rank-badge ${rankClass}">${badge}</div>
        <div class="avatar" style="background:${r.player.color}">${esc(initials(r.player.name))}</div>
        <div class="grow">
          <div class="rank-name truncate">${esc(r.player.name)}</div>
          <div class="rank-meta">${r.played} / ${state.courses.length} Kurse gespielt</div>
        </div>
        <div class="rank-score">
          <div class="rank-total">${r.played ? r.total : '–'}</div>
          ${toPar}
        </div>
      </div>`;
    });
    html += `</div>`;

    if (anyPlayed) {
      html += `<div class="section-label">Turnier</div>
      <div class="card row-between">
        <div><div class="small muted">Gesamt-Par aller Kurse</div><div style="font-weight:800;font-size:18px">${totalPar()} Schläge</div></div>
        <button class="btn btn-danger btn-sm" onclick="resetScores()">Zurücksetzen</button>
      </div>`;
    }

    view.innerHTML = html;
  }

  function topArLabel(toPar) {
    if (toPar === 0) return `<div class="rank-topar topar-even">Par</div>`;
    if (toPar < 0) return `<div class="rank-topar topar-under">${toPar} unter Par</div>`;
    return `<div class="rank-topar topar-over">+${toPar} über Par</div>`;
  }

  /* ---------- Play ---------- */
  function renderPlay() {
    let html = `<div class="view-head">
      <h1 class="view-title">Spielen</h1>
      <p class="view-desc">Kurs wählen und die Schläge jedes Spielers zählen.</p>
    </div>`;

    if (state.courses.length === 0) {
      html += emptyState('⛳', 'Keine Kurse', 'Erstelle zuerst einen Kurs mit Start, Ziel und Hindernissen.', 'Kurs erstellen', "go('courses')");
      view.innerHTML = html; return;
    }
    if (state.players.length === 0) {
      html += emptyState('👤', 'Keine Spieler', 'Lege Spieler an, damit ihr Schläge tracken könnt.', 'Spieler anlegen', "go('players')");
      view.innerHTML = html; return;
    }

    // course selector
    if (!state.activeCourseId || !state.courses.find(c => c.id === state.activeCourseId)) {
      state.activeCourseId = state.courses[0].id;
    }
    const active = state.courses.find(c => c.id === state.activeCourseId);

    html += `<div class="section-label">Kurs auswählen</div><div class="pill-select" id="courseTabs">`;
    state.courses.forEach((c, i) => {
      const done = coursePlayed(c.id);
      html += `<button class="type-opt ${c.id === active.id ? 'on' : ''}" data-course="${c.id}">
        ${done ? '✅' : '⛳'} ${esc(c.name)}
      </button>`;
    });
    html += `</div>`;

    // active course card
    html += `<div class="section-label">Schläge zählen</div>`;
    html += `<div class="card course-card">
      <div class="course-top">
        <div class="grow">
          <h3 class="course-name">${esc(active.name)}</h3>
          <div class="route"><b>🚩 ${esc(active.start || 'Start')}</b><span class="dots"></span><b>${esc(active.end || 'Ziel')} 🏁</b></div>
        </div>
        <span class="par-pill">Par ${Number(active.par) || 0}</span>
      </div>
      ${obstaclesHtml(active.obstacles)}
      ${hasRoute(active) ? `<div style="margin-top:12px">${mapBlock([{ course: active, colorIdx: state.courses.indexOf(active) }], { zoom: true, maxHeight: '260px' })}</div>` : ''}
    </div>`;

    // player steppers
    state.players.forEach(p => {
      const s = scoreFor(active.id, p.id);
      html += `<div class="card row-between" data-player="${p.id}">
        <div class="row grow" style="min-width:0">
          <div class="avatar" style="background:${p.color}">${esc(initials(p.name))}</div>
          <div class="grow"><div style="font-weight:750;font-size:16px" class="truncate">${esc(p.name)}</div>
          <div class="small muted">${parDiffText(s, active.par)}</div></div>
        </div>
        <div class="stepper">
          <button class="step-btn step-minus" data-act="dec">−</button>
          <div class="step-val ${s === 0 ? 'zero' : ''}" data-val>${s}</div>
          <button class="step-btn step-plus" data-act="inc">+</button>
        </div>
      </div>`;
    });

    // hole done -> next course
    const idx = state.courses.findIndex(c => c.id === active.id);
    if (idx < state.courses.length - 1) {
      html += `<button class="btn btn-primary btn-block" style="margin-top:6px" onclick="nextCourse()">Nächster Kurs →</button>`;
    } else {
      html += `<button class="btn btn-primary btn-block" style="margin-top:6px" onclick="go('leaderboard')">🏆 Zur Rangliste</button>`;
    }

    view.innerHTML = html;

    const mapFrame = $('.map-frame', view);
    if (mapFrame) wireMapZoom(mapFrame);

    // wire course tabs
    $('#courseTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-course]');
      if (!b) return;
      state.activeCourseId = b.dataset.course; save(); render();
    });
    // wire steppers
    view.querySelectorAll('[data-player]').forEach(rowEl => {
      const pid = rowEl.dataset.player;
      const valEl = rowEl.querySelector('[data-val]');
      const update = (delta) => {
        const nv = Math.max(0, scoreFor(active.id, pid) + delta);
        setScore(active.id, pid, nv);
        valEl.textContent = nv;
        valEl.classList.toggle('zero', nv === 0);
        rowEl.querySelector('.small.muted').textContent = parDiffText(nv, active.par);
        if (navigator.vibrate) navigator.vibrate(8);
      };
      rowEl.querySelector('[data-act=inc]').addEventListener('click', () => update(1));
      rowEl.querySelector('[data-act=dec]').addEventListener('click', () => update(-1));
      valEl.addEventListener('click', () => editScorePrompt(active, pid, valEl, rowEl));
    });
  }

  function parDiffText(strokes, par) {
    par = Number(par) || 0;
    if (strokes === 0) return 'noch nicht gespielt';
    if (!par) return `${strokes} Schläge`;
    const d = strokes - par;
    if (d === 0) return `${strokes} Schläge · Par`;
    return `${strokes} Schläge · ${d > 0 ? '+' + d : d}`;
  }

  function editScorePrompt(course, pid, valEl, rowEl) {
    const cur = scoreFor(course.id, pid);
    const v = prompt('Schläge eingeben:', cur);
    if (v === null) return;
    const n = Math.max(0, parseInt(v, 10) || 0);
    setScore(course.id, pid, n);
    valEl.textContent = n; valEl.classList.toggle('zero', n === 0);
    rowEl.querySelector('.small.muted').textContent = parDiffText(n, course.par);
  }

  /* ---------- Map overview ---------- */
  function renderMap() {
    const placed = state.courses
      .map((c, i) => ({ course: c, n: i + 1, colorIdx: i }))
      .filter(x => hasRoute(x.course));

    let html = `<div class="view-head">
      <h1 class="view-title">Karte</h1>
      <p class="view-desc">Alle Bahnen auf der Alm — Nummer antippen, um sie zu spielen.</p>
    </div>`;

    html += mapBlock(placed, { zoom: true });

    if (placed.length === 0) {
      html += `<div class="card" style="margin-top:14px"><div class="empty" style="padding:20px 8px">
        <span class="empty-emoji">🗺️</span>
        <h3>Noch keine Bahn eingezeichnet</h3>
        <p>Beim Anlegen oder Bearbeiten eines Kurses kannst du Start 🚩, Ziel 🏁 und Hindernisse direkt auf der Karte platzieren.</p>
        <button class="btn btn-primary" onclick="editCourse()">Kurs einzeichnen</button>
      </div></div>`;
    } else {
      html += `<div class="map-legend">`;
      placed.forEach(({ course: c, n, colorIdx }) => {
        const done = coursePlayed(c.id);
        html += `<div class="rank-row tap" onclick="playCourse('${c.id}')">
          <div class="rank-badge" style="background:${ROUTE_COLORS[colorIdx % ROUTE_COLORS.length]};color:#1b2a20">${n}</div>
          <div class="grow">
            <div class="rank-name truncate">${esc(c.name)}</div>
            <div class="rank-meta">${esc(c.start || 'Start')} → ${esc(c.end || 'Ziel')} · Par ${Number(c.par) || 0}</div>
          </div>
          <span>${done ? '✅' : '▶️'}</span>
        </div>`;
      });
      html += `</div>`;
      const unplaced = state.courses.filter(c => !hasRoute(c));
      if (unplaced.length) {
        html += `<p class="map-hint">📍 ${unplaced.length} Kurs${unplaced.length > 1 ? 'e' : ''} noch ohne Position — beim Bearbeiten auf der Karte einzeichnen.</p>`;
      }
    }

    view.innerHTML = html;
    wireMapZoom($('.map-frame', view));
    view.querySelectorAll('[data-badge]').forEach(b =>
      b.addEventListener('click', () => playCourse(b.dataset.badge)));
  }

  function playCourse(id) {
    state.activeCourseId = id;
    go('play');
  }

  /* ---------- Courses ---------- */
  function renderCourses() {
    let html = `<div class="view-head">
      <h1 class="view-title">Kurse</h1>
      <p class="view-desc">Eigene Strecken mit Start, Ziel und Hindernissen.</p>
    </div>`;

    if (state.courses.length === 0) {
      html += emptyState('⛳', 'Noch keine Kurse', 'Definiert eure Spikegolf-Bahnen: von wo nach wo, welche Hindernisse, und das Par (Ziel-Schlagzahl).', 'Ersten Kurs erstellen', 'editCourse()');
      view.innerHTML = html; return;
    }

    state.courses.forEach((c, i) => {
      html += `<div class="card course-card tap" onclick="editCourse('${c.id}')">
        <div class="course-top">
          <div class="grow">
            <div class="small muted" style="font-weight:700">Kurs ${i + 1}</div>
            <h3 class="course-name">${esc(c.name)}</h3>
          </div>
          <span class="par-pill">Par ${Number(c.par) || 0}</span>
        </div>
        <div class="route"><b>🚩 ${esc(c.start || 'Start')}</b><span class="dots"></span><b>${esc(c.end || 'Ziel')} 🏁</b></div>
        ${c.elevation ? `<div class="small muted" style="margin-top:6px">⛰️ ${esc(c.elevation)}</div>` : ''}
        ${hasRoute(c) ? `<div class="small muted" style="margin-top:6px">📍 Auf der Karte eingezeichnet</div>` : ''}
        ${obstaclesHtml(c.obstacles)}
      </div>`;
    });
    html += `<button class="fab-add" onclick="editCourse()">＋ Kurs hinzufügen</button>`;
    view.innerHTML = html;
  }

  function obstaclesHtml(obstacles) {
    if (!obstacles || !obstacles.length) return '';
    let h = `<div class="chips">`;
    obstacles.forEach(o => {
      const t = OBSTACLE_TYPES.find(x => x.key === o.type) || OBSTACLE_TYPES[5];
      h += `<span class="chip">${t.emoji} ${esc(o.text || t.label)}</span>`;
    });
    return h + `</div>`;
  }

  /* ---------- Players ---------- */
  function renderPlayers() {
    let html = `<div class="view-head">
      <h1 class="view-title">Spieler</h1>
      <p class="view-desc">Wer spielt heute mit?</p>
    </div>`;

    if (state.players.length === 0) {
      html += emptyState('👤', 'Noch keine Spieler', 'Fügt alle Mitspieler hinzu — jede Person bekommt eine eigene Farbe.', 'Ersten Spieler anlegen', 'editPlayer()');
      view.innerHTML = html; return;
    }

    state.players.forEach(p => {
      let total = 0, played = 0;
      state.courses.forEach(c => { const s = scoreFor(c.id, p.id); if (s > 0) { total += s; played++; } });
      html += `<div class="card row-between tap" onclick="editPlayer('${p.id}')">
        <div class="row grow" style="min-width:0">
          <div class="avatar" style="background:${p.color}">${esc(initials(p.name))}</div>
          <div class="grow"><div style="font-weight:750;font-size:16px" class="truncate">${esc(p.name)}</div>
          <div class="small muted">${played ? `${total} Schläge · ${played} Kurse` : 'noch nicht gespielt'}</div></div>
        </div>
        <span class="muted" style="font-size:20px">›</span>
      </div>`;
    });
    html += `<button class="fab-add" onclick="editPlayer()">＋ Spieler hinzufügen</button>`;
    view.innerHTML = html;
  }

  /* ============================================================
     EDIT SHEETS
     ============================================================ */
  function editPlayer(id) {
    const p = id ? state.players.find(x => x.id === id) : null;
    const box = el(`<div>
      <div class="sheet-handle"></div>
      <h2 class="sheet-title">${p ? 'Spieler bearbeiten' : 'Neuer Spieler'}</h2>
      <p class="sheet-sub">Name eingeben und speichern.</p>
      <label class="field"><span>Name</span>
        <input type="text" id="pName" placeholder="z. B. Max" value="${p ? esc(p.name) : ''}" autocomplete="off"></label>
      <label class="field"><span>Farbe</span>
        <div class="pill-select" id="pColors"></div></label>
      <button class="btn btn-primary btn-block" id="pSave">Speichern</button>
      ${p ? `<button class="btn btn-danger btn-block" id="pDel" style="margin-top:10px">Spieler löschen</button>` : ''}
    </div>`);

    const colorBox = $('#pColors', box);
    let chosen = p ? p.color : AVATAR_COLORS[state.players.length % AVATAR_COLORS.length];
    AVATAR_COLORS.forEach(col => {
      const dot = el(`<button class="type-opt" style="width:44px;height:44px;padding:0;justify-content:center">
        <span style="width:24px;height:24px;border-radius:50%;background:${col};display:block"></span></button>`);
      const mark = () => colorBox.querySelectorAll('.type-opt').forEach(d => d.classList.toggle('on', d === dot));
      if (col === chosen) dot.classList.add('on');
      dot.addEventListener('click', () => { chosen = col; mark(); });
      colorBox.appendChild(dot);
    });

    $('#pSave', box).addEventListener('click', () => {
      const name = $('#pName', box).value.trim();
      if (!name) { toast('Bitte einen Namen eingeben'); return; }
      if (p) { p.name = name; p.color = chosen; }
      else state.players.push({ id: uid(), name, color: chosen });
      save(); closeSheet(); render(); toast(p ? 'Gespeichert' : 'Spieler hinzugefügt');
    });
    if (p) $('#pDel', box).addEventListener('click', () => {
      if (!confirm(`"${p.name}" wirklich löschen? Alle Schläge dieser Person gehen verloren.`)) return;
      state.players = state.players.filter(x => x.id !== p.id);
      Object.values(state.scores).forEach(s => delete s[p.id]);
      save(); closeSheet(); render(); toast('Spieler gelöscht');
    });

    openSheet(box);
    setTimeout(() => $('#pName', box).focus(), 250);
  }

  function editCourse(id) {
    const c = id ? state.courses.find(x => x.id === id) : null;
    let obstacles = c ? c.obstacles.map(o => ({ ...o })) : [];

    const box = el(`<div>
      <div class="sheet-handle"></div>
      <h2 class="sheet-title">${c ? 'Kurs bearbeiten' : 'Neuer Kurs'}</h2>
      <p class="sheet-sub">Start, Ziel, Par und Hindernisse festlegen.</p>
      <label class="field"><span>Name des Kurses</span>
        <input type="text" id="cName" placeholder="z. B. Bahn 1 – Über die Hütte" value="${c ? esc(c.name) : ''}" autocomplete="off"></label>
      <div class="row" style="gap:12px">
        <label class="field grow"><span>Start</span>
          <input type="text" id="cStart" placeholder="Terrasse" value="${c ? esc(c.start || '') : ''}"></label>
        <label class="field grow"><span>Ziel</span>
          <input type="text" id="cEnd" placeholder="Brunnen" value="${c ? esc(c.end || '') : ''}"></label>
      </div>
      <div class="row" style="gap:12px">
        <label class="field grow"><span>Par (Ziel-Schläge)</span>
          <input type="number" id="cPar" inputmode="numeric" min="1" placeholder="3" value="${c ? (c.par || '') : ''}"></label>
        <label class="field grow"><span>Höhenmeter (optional)</span>
          <input type="text" id="cElev" placeholder="+8 m" value="${c ? esc(c.elevation || '') : ''}"></label>
      </div>

      <div class="section-label" style="margin-top:2px">Auf der Karte einzeichnen</div>
      <div class="map-modes" id="mapModes">
        <button class="type-opt on" data-mode="start">🚩 Start</button>
        <button class="type-opt" data-mode="end">🏁 Ziel</button>
        <button class="type-opt" data-mode="obs">🌲 Hindernis</button>
      </div>
      <div id="edMap"></div>
      <p class="map-hint" id="mapHint"></p>

      <label class="field" style="margin-top:16px"><span>Hindernisse</span></label>
      <div id="obsList"></div>
      <div class="section-label" style="margin-top:4px">Hindernis hinzufügen</div>
      <div class="pill-select" id="obsTypes"></div>
      <input type="text" id="obsText" placeholder="Beschreibung (z. B. zwischen den Bäumen durch)" style="margin-top:10px">
      <button class="btn btn-sm btn-block" id="obsAdd" style="margin-top:10px">＋ Hinzufügen</button>

      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="cSave">Kurs speichern</button>
      ${c ? `<button class="btn btn-danger btn-block" id="cDel" style="margin-top:10px">Kurs löschen</button>` : ''}
    </div>`);

    // obstacle type picker
    let selType = 'baum';
    const typesBox = $('#obsTypes', box);
    OBSTACLE_TYPES.forEach(t => {
      const b = el(`<button class="type-opt ${t.key === selType ? 'on' : ''}" data-t="${t.key}">${t.emoji} ${t.label}</button>`);
      b.addEventListener('click', () => {
        selType = t.key;
        typesBox.querySelectorAll('.type-opt').forEach(x => x.classList.toggle('on', x === b));
        const mo = $('#mapModes [data-mode="obs"]', box);
        if (mo) mo.innerHTML = `${t.emoji} Hindernis`;
      });
      typesBox.appendChild(b);
    });

    const renderObs = () => {
      const list = $('#obsList', box);
      if (!obstacles.length) { list.innerHTML = `<p class="small muted" style="margin:2px 2px 12px">Noch keine Hindernisse.</p>`; return; }
      list.innerHTML = '';
      obstacles.forEach((o, i) => {
        const t = OBSTACLE_TYPES.find(x => x.key === o.type) || OBSTACLE_TYPES[5];
        const chip = el(`<span class="chip" style="margin:0 6px 8px 0">${t.emoji} ${esc(o.text || t.label)}${o.pos ? ' 📍' : ''} <span class="x">✕</span></span>`);
        chip.querySelector('.x').addEventListener('click', () => { obstacles.splice(i, 1); renderObs(); redrawMap(); });
        list.appendChild(chip);
      });
    };
    renderObs();

    /* --- map editor: tap to place start / end / obstacles --- */
    const draft = {
      startPos: c && c.startPos ? { ...c.startPos } : null,
      endPos: c && c.endPos ? { ...c.endPos } : null,
      obstacles, // shared reference — chips and map stay in sync
    };
    const colorIdx = c ? state.courses.indexOf(c) : state.courses.length;
    let mapMode = draft.startPos ? (draft.endPos ? 'obs' : 'end') : 'start';
    let mapZoomed = false;
    const HINTS = {
      start: 'Tippe auf die Karte, um den Start 🚩 zu setzen.',
      end: 'Tippe auf die Karte, um das Ziel 🏁 zu setzen.',
      obs: 'Tippe auf die Karte, um das unten gewählte Hindernis zu platzieren. Marker antippen = entfernen.',
    };

    function setMode(m) {
      mapMode = m;
      box.querySelectorAll('#mapModes .type-opt').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
      $('#mapHint', box).textContent = HINTS[m];
    }

    function redrawMap() {
      const holder = $('#edMap', box);
      holder.innerHTML = mapBlock([{ course: draft, colorIdx }], { editing: true, zoom: true });
      const frame = holder.firstElementChild;
      const wrap = frame.querySelector('.map-wrap');
      const zoomBtn = frame.querySelector('[data-zoom]');
      if (mapZoomed) { wrap.style.width = '220%'; zoomBtn.textContent = '⊖'; }
      zoomBtn.addEventListener('click', () => {
        mapZoomed = !mapZoomed;
        wrap.style.width = mapZoomed ? '220%' : '100%';
        zoomBtn.textContent = mapZoomed ? '⊖' : '⊕';
      });
      wrap.addEventListener('click', (e) => {
        const obsEl = e.target.closest('[data-obs]');
        if (obsEl) {
          const idx = obstacles.findIndex(o => o.id === obsEl.dataset.obs);
          if (idx >= 0) { obstacles.splice(idx, 1); renderObs(); redrawMap(); }
          return;
        }
        const r = wrap.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
        if (mapMode === 'start') {
          draft.startPos = { x, y };
          setMode(draft.endPos ? 'obs' : 'end');
        } else if (mapMode === 'end') {
          draft.endPos = { x, y };
          setMode('obs');
        } else {
          const t = OBSTACLE_TYPES.find(z => z.key === selType);
          obstacles.push({ id: uid(), type: selType, text: $('#obsText', box).value.trim() || t.label, pos: { x, y } });
          $('#obsText', box).value = '';
          renderObs();
        }
        redrawMap();
      });
    }

    $('#mapModes', box).addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) setMode(b.dataset.mode);
    });
    setMode(mapMode);
    redrawMap();

    $('#obsAdd', box).addEventListener('click', () => {
      const txt = $('#obsText', box).value.trim();
      const t = OBSTACLE_TYPES.find(x => x.key === selType);
      obstacles.push({ id: uid(), type: selType, text: txt || t.label });
      $('#obsText', box).value = '';
      renderObs();
    });
    $('#obsText', box).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#obsAdd', box).click(); } });

    $('#cSave', box).addEventListener('click', () => {
      const name = $('#cName', box).value.trim();
      if (!name) { toast('Bitte einen Kursnamen eingeben'); return; }
      const data = {
        name,
        start: $('#cStart', box).value.trim(),
        end: $('#cEnd', box).value.trim(),
        par: Math.max(0, parseInt($('#cPar', box).value, 10) || 0),
        elevation: $('#cElev', box).value.trim(),
        obstacles,
        startPos: draft.startPos || null,
        endPos: draft.endPos || null,
      };
      if (c) Object.assign(c, data);
      else state.courses.push({ id: uid(), ...data });
      save(); closeSheet(); render(); toast(c ? 'Kurs gespeichert' : 'Kurs erstellt');
    });
    if (c) $('#cDel', box).addEventListener('click', () => {
      if (!confirm(`Kurs "${c.name}" löschen? Die Schläge auf diesem Kurs gehen verloren.`)) return;
      state.courses = state.courses.filter(x => x.id !== c.id);
      delete state.scores[c.id];
      save(); closeSheet(); render(); toast('Kurs gelöscht');
    });

    openSheet(box);
  }

  /* ============================================================
     Empty state + global actions
     ============================================================ */
  function emptyState(emoji, title, text, btnLabel, onclick) {
    return `<div class="card"><div class="empty">
      <span class="empty-emoji">${emoji}</span>
      <h3>${title}</h3><p>${text}</p>
      <button class="btn btn-primary" onclick="${onclick}">${btnLabel}</button>
    </div></div>`;
  }

  function go(tab) { state.tab = tab; save(); render(); }
  function nextCourse() {
    const idx = state.courses.findIndex(c => c.id === state.activeCourseId);
    if (idx < state.courses.length - 1) { state.activeCourseId = state.courses[idx + 1].id; save(); render(); }
  }
  function resetScores() {
    if (!confirm('Alle Schläge zurücksetzen und neue Runde starten? Spieler und Kurse bleiben erhalten.')) return;
    state.scores = {}; save(); render(); toast('Neue Runde – viel Erfolg!');
  }

  // menu (export / import / reset all)
  function openMenu() {
    const box = el(`<div>
      <div class="sheet-handle"></div>
      <h2 class="sheet-title">Menü</h2>
      <p class="sheet-sub">Daten & Turnier verwalten.</p>
      <button class="btn btn-block" id="mExport">📤 Daten exportieren (Backup)</button>
      <button class="btn btn-block" id="mImport" style="margin-top:10px">📥 Daten importieren</button>
      <button class="btn btn-danger btn-block" id="mWipe" style="margin-top:10px">🗑 Alles löschen</button>
      <p class="small muted" style="text-align:center;margin-top:16px">Spikegolf · GKBS · Obiralm · offline gespeichert</p>
    </div>`);
    $('#mExport', box).addEventListener('click', exportData);
    $('#mImport', box).addEventListener('click', importData);
    $('#mWipe', box).addEventListener('click', () => {
      if (!confirm('Wirklich ALLE Spieler, Kurse und Schläge löschen?')) return;
      state = defaultState(); save(); closeSheet(); render(); toast('Alles gelöscht');
    });
    openSheet(box);
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `spikegolf-backup.json`; a.click();
    URL.revokeObjectURL(url);
    toast('Backup exportiert');
  }
  function importData() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json';
    inp.addEventListener('change', () => {
      const f = inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          state = Object.assign(defaultState(), data);
          save(); closeSheet(); render(); toast('Daten importiert');
        } catch (e) { toast('Import fehlgeschlagen'); }
      };
      r.readAsText(f);
    });
    inp.click();
  }

  // expose for inline onclick handlers
  Object.assign(window, { go, nextCourse, resetScores, editPlayer, editCourse, playCourse });

  /* ============================================================
     Wire up + boot
     ============================================================ */
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => go(t.dataset.tab)));
  $('#menuBtn').addEventListener('click', openMenu);

  render();

  // service worker for offline use
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
