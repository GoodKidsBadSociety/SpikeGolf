/* ============================================================
   Spikegolf — Alpine Topographic Sport-Tech
   3D map (map.glb) as the hero canvas, glass HUD floats over it.
   ============================================================ */

import * as THREE from 'three';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { initSync, pushState, flushState, syncEnabled } from './sync.js';

const STORE_KEY = 'spikegolf.v2';
const LEGACY_KEY = 'spikegolf.v1';

const OBSTACLE_TYPES = [
  { key: 'baum',  emoji: '🌲', label: 'Baum' },
  { key: 'dach',  emoji: '🏠', label: 'Dach' },
  { key: 'stein', emoji: '🪨', label: 'Stein' },
  { key: 'zaun',  emoji: '🚧', label: 'Zaun' },
  { key: 'wasser',emoji: '💧', label: 'Wasser' },
  { key: 'sonst', emoji: '🎯', label: 'Sonstiges' },
];
const AVATAR_COLORS = [
  '#ffb547', // amber
  '#64c294', // moss
  '#e07856', // clay
  '#ff6b6b', // coral red
  '#7ab8ff', // sky blue
  '#c896ff', // lavender
  '#4fd1c5', // teal
  '#f8e16c', // yellow
  '#d977a6', // pink
  '#a8e061', // lime
];
const ROUTE_COLORS = ['#ffb547','#64c294','#7ab8ff','#c896ff','#e07856','#ffd18a','#4fd1c5','#ff6b6b'];

/* ============================================================
   State + persistence
   ============================================================ */
const defaultState = () => ({
  players: [],
  courses: [],
  rounds: [],              // {id, name, startedAt, endedAt?, playerIds, scores}
  activeRoundId: null,
  activeCourseId: null,
  tab: 'leaderboard',
  playSub: 'route',
});

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = Object.assign(defaultState(), JSON.parse(raw));
      migrateStateShape(parsed);
      return parsed;
    }
    // Migrate legacy v1: keep players, keep par/name/obstacle labels, drop old 2D positions.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy);
      const migrated = Object.assign(defaultState(), old);
      migrated.courses = (old.courses || []).map(c => ({
        ...c,
        startPos: null, endPos: null,
        obstacles: (c.obstacles || []).map(o => ({ ...o, pos: null })),
      }));
      migrateStateShape(migrated);
      return migrated;
    }
    return defaultState();
  } catch (e) { console.warn('load failed', e); return defaultState(); }
}

// Migrate flat state.scores → a single legacy round with all players/courses.
function migrateStateShape(s) {
  if (!Array.isArray(s.rounds)) s.rounds = [];
  if (s.scores && Object.keys(s.scores).length && !s.rounds.length) {
    s.rounds.push({
      id: uid(),
      name: 'Erste Runde',
      startedAt: Date.now(),
      endedAt: null,
      playerIds: (s.players || []).map(p => p.id),
      courseIds: (s.courses || []).map(c => c.id),
      scores: s.scores,
    });
    s.activeRoundId = s.rounds[0].id;
  }
  delete s.scores;
  // Backfill courseIds for older rounds
  s.rounds.forEach(r => {
    if (!Array.isArray(r.courseIds)) r.courseIds = (s.courses || []).map(c => c.id);
  });
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('save failed', e); }
  pushState(state);
}

function applyRemoteState(remote) {
  if (!remote || typeof remote !== 'object') return;
  // Preserve the user's current UI position (tab, active course, sub, selection).
  const uiKeep = {
    tab: state.tab,
    activeCourseId: state.activeCourseId,
    activeRoundId: state.activeRoundId,
    selectedCourseId: state.selectedCourseId,
    playSub: state.playSub,
  };
  const merged = Object.assign(defaultState(), remote, uiKeep);
  migrateStateShape(merged);
  state = merged;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
  if (typeof rebuildAllRoutes === 'function') rebuildAllRoutes();
  if (typeof render === 'function') render();
}

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

/* ---------------- helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const initials = (name) => name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';

function activeRound() { return state.rounds.find(r => r.id === state.activeRoundId) || null; }
function roundPlayers(round) {
  if (!round) return [];
  return round.playerIds.map(pid => state.players.find(p => p.id === pid)).filter(Boolean);
}
function roundCourses(round) {
  if (!round) return [];
  return (round.courseIds || []).map(cid => state.courses.find(c => c.id === cid)).filter(Boolean);
}
function isRoundComplete(round) {
  if (!round) return false;
  const courses = roundCourses(round);
  const players = roundPlayers(round);
  if (!courses.length || !players.length) return false;
  return courses.every(c => {
    const s = round.scores[c.id] || {};
    return players.every(p => (s[p.id] || 0) > 0);
  });
}

function scoreFor(cid, pid) {
  const r = activeRound(); if (!r) return 0;
  return (r.scores[cid] && r.scores[cid][pid]) || 0;
}
function setScore(cid, pid, v) {
  const r = activeRound(); if (!r) return;
  const wasComplete = isRoundComplete(r);
  if (!r.scores[cid]) r.scores[cid] = {};
  r.scores[cid][pid] = Math.max(0, v);
  save();
  const nowComplete = isRoundComplete(r);
  if (!wasComplete && nowComplete) {
    setTimeout(() => { toast('🏆 Runde komplett!'); go('leaderboard'); }, 300);
  }
}
function coursePlayed(cid) {
  const r = activeRound(); if (!r) return false;
  const s = r.scores[cid] || {};
  return roundPlayers(r).some(p => (s[p.id] || 0) > 0);
}
function totalPar() {
  const r = activeRound();
  const cs = r ? roundCourses(r) : state.courses;
  return cs.reduce((a, c) => a + (Number(c.par) || 0), 0);
}

function leaderboard() {
  const r = activeRound();
  if (!r) return [];
  const players = roundPlayers(r);
  const courses = roundCourses(r);
  const rows = players.map(p => {
    let total = 0, played = 0, parPlayed = 0;
    courses.forEach(c => {
      const s = scoreFor(c.id, p.id);
      if (s > 0) { total += s; played++; parPlayed += Number(c.par) || 0; }
    });
    return { player: p, total, played, parPlayed, toPar: total - parPlayed, courseCount: courses.length };
  });
  rows.sort((a, b) => {
    if (a.played === 0 && b.played === 0) return 0;
    if (a.played === 0) return 1;
    if (b.played === 0) return -1;
    return a.total - b.total;
  });
  return rows;
}

const hasRoute = (c) => !!(c.startPos && c.endPos);
const waypointsOf = (c) => {
  if (!hasRoute(c)) return null;
  const pts = [c.startPos];
  (c.obstacles || []).forEach(o => { if (o.pos) pts.push(o.pos); });
  pts.push(c.endPos);
  return pts;
};

/* ============================================================
   3D scene
   ============================================================ */
const scene3 = {
  renderer: null, scene: null, camera: null, controls: null,
  terrain: null, terrainMeshes: [], center: new THREE.Vector3(), radius: 30,
  raycaster: new THREE.Raycaster(),
  routeGroup: null, markerGroup: null,
  ready: false,
  clock: new THREE.Clock(),
  idleOrbit: true,
  orbitCenter: new THREE.Vector3(),  // where the idle-orbit camera revolves around
  orbitRadius: 30,                    // distance from that center
  focusCourseId: null,
  placementMode: null,     // null | 'start' | 'end' | 'obs'
  placementCallback: null, // function(hitPoint)
  markerClickCallback: null,
  labelSprites: [],
};

function initScene() {
  const canvas = $('#stage');
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  scene3.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1c17);
  scene.fog = null; // no distance-darkening — user wants zoom-out to stay bright
  scene3.scene = scene;

  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 40, 60);
  scene3.camera = camera;

  // Warm alpine sun + cool sky fill
  const sun = new THREE.DirectionalLight(0xffe4b3, 2.6);
  sun.position.set(80, 120, 40);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0x88b0ff, 0x111a14, 0.9);
  scene.add(hemi);

  // Subtle rim from the opposite side
  const rim = new THREE.DirectionalLight(0x88c9ff, 0.4);
  rim.position.set(-60, 40, -80);
  scene.add(rim);

  scene3.routeGroup = new THREE.Group();
  scene3.markerGroup = new THREE.Group();
  scene.add(scene3.routeGroup);
  scene.add(scene3.markerGroup);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.7; controls.zoomSpeed = 0.8; controls.panSpeed = 0.7;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.enablePan = true;
  controls.screenSpacePanning = false;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  scene3.controls = controls;

  // any user interaction pauses idle orbit
  ['start'].forEach(evt => controls.addEventListener(evt, () => { scene3.idleOrbit = false; }));

  window.addEventListener('resize', onResize, { passive: true });
  wirePlacementPointer(canvas);

  animate();
}

/* ---------------- Placement pointer handling ----------------
   Placement uses a 700ms long-press so casual rotate/pan taps
   don't accidentally spawn markers. Quick tap on an existing
   marker still deletes it (fast feedback for corrections).
   ------------------------------------------------------------- */
const PRESS_HOLD_MS = 700;
const PRESS_MOVE_TOLERANCE = 12;
let pressTimer = null;
let pressStart = null;
let pressRing = null;

function wirePlacementPointer(canvas) {
  canvas.addEventListener('pointerdown', (e) => {
    if (!scene3.placementMode) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Block iOS text-selection callout during long-press
    if (e.pointerType === 'touch' && e.cancelable) e.preventDefault();
    pressStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    showPressRing(e.clientX, e.clientY);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      hidePressRing();
      const s = pressStart; pressStart = null;
      if (s) placementRaycast(s.x, s.y, 'terrain');
    }, PRESS_HOLD_MS);
  }, { passive: false });

  canvas.addEventListener('pointermove', (e) => {
    if (!pressStart) return;
    const dx = e.clientX - pressStart.x, dy = e.clientY - pressStart.y;
    if (Math.hypot(dx, dy) > PRESS_MOVE_TOLERANCE) cancelPress();
  }, { passive: true });

  canvas.addEventListener('pointerup', (e) => {
    if (!pressStart) return;                       // long-press already fired or was cancelled
    const dt = performance.now() - pressStart.t;
    const s = pressStart;
    cancelPress();
    // Short tap: still allow removing a marker (raycast against draft sprites only).
    if (dt < PRESS_HOLD_MS) placementRaycast(s.x, s.y, 'marker');
  }, { passive: true });

  canvas.addEventListener('pointercancel', cancelPress, { passive: true });
  canvas.addEventListener('pointerleave', cancelPress, { passive: true });
}

function cancelPress() {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  pressStart = null;
  hidePressRing();
}

function showPressRing(x, y) {
  hidePressRing();
  pressRing = document.createElement('div');
  pressRing.className = 'press-ring';
  pressRing.style.left = x + 'px';
  pressRing.style.top = y + 'px';
  document.body.appendChild(pressRing);
}
function hidePressRing() {
  if (pressRing) { pressRing.remove(); pressRing = null; }
}

// mode: 'terrain' (long-press) or 'marker' (quick tap)
function placementRaycast(clientX, clientY, mode) {
  if (!scene3.placementMode) return;
  const rect = scene3.renderer.domElement.getBoundingClientRect();
  const mx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const my = -((clientY - rect.top) / rect.height) * 2 + 1;
  scene3.raycaster.setFromCamera(new THREE.Vector2(mx, my), scene3.camera);

  if (mode === 'marker') {
    if (!draftGroup || !scene3.markerClickCallback) return;
    const sprites = draftGroup.children.filter(o => o.isSprite);
    const hit = scene3.raycaster.intersectObjects(sprites, false)[0];
    if (hit) scene3.markerClickCallback(hit.object.userData.wp);
    return;
  }
  // terrain
  if (!scene3.placementCallback) return;
  const hits = scene3.raycaster.intersectObjects(scene3.terrainMeshes, true);
  if (!hits.length) { toast('Kein Boden getroffen'); return; }
  const p = hits[0].point;
  scene3.placementCallback({ x: p.x, y: p.y, z: p.z });
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  scene3.renderer.setSize(w, h, false);
  scene3.camera.aspect = w / h;
  scene3.camera.updateProjectionMatrix();
}

function loadTerrain() {
  const boot = $('#boot');
  const bar = $('#bootBar');
  const ring = $('#bootRing');
  const bootSub = $('#bootSub');

  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load('map.glb',
      (gltf) => {
        const model = gltf.scene;
        // Compute bounding box, center, scale to a manageable size.
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3(); box.getSize(size);
        const center = new THREE.Vector3(); box.getCenter(center);
        const maxDim = Math.max(size.x, size.y, size.z);
        const targetSize = 120;
        const scale = maxDim > 0 ? targetSize / maxDim : 1;
        model.scale.setScalar(scale);
        model.position.set(-center.x * scale, -center.y * scale + size.y * scale * 0.05, -center.z * scale);

        // Collect meshes for raycasting; enable frustum culling.
        model.traverse(o => {
          if (o.isMesh) {
            o.frustumCulled = true;
            o.castShadow = false; o.receiveShadow = false;
            scene3.terrainMeshes.push(o);
            if (o.material && 'roughness' in o.material) {
              o.material.roughness = Math.max(o.material.roughness, 0.85);
            }
          }
        });

        scene3.terrain = model;
        scene3.scene.add(model);

        // Camera framing
        const rescaledBox = new THREE.Box3().setFromObject(model);
        const rSize = new THREE.Vector3(); rescaledBox.getSize(rSize);
        const rCenter = new THREE.Vector3(); rescaledBox.getCenter(rCenter);
        scene3.center.copy(rCenter);
        scene3.radius = Math.max(rSize.x, rSize.z) * 0.55;
        scene3.orbitCenter.copy(rCenter);
        scene3.orbitRadius = scene3.radius * 1.8;

        scene3.controls.target.copy(rCenter);
        const dist = scene3.radius * 1.8;
        scene3.camera.position.set(rCenter.x + dist * 0.6, rCenter.y + dist * 0.9, rCenter.z + dist * 0.8);
        scene3.controls.minDistance = scene3.radius * 0.35;
        scene3.controls.maxDistance = scene3.radius * 2.4;
        scene3.controls.update();

        scene3.ready = true;
        rebuildAllRoutes();

        // fade out boot
        boot.classList.add('hide');
        setTimeout(() => { boot.style.display = 'none'; }, 700);
        resolve();
      },
      (evt) => {
        if (!evt.total) {
          bootSub.textContent = `Lade Alm-Modell … ${(evt.loaded / 1048576).toFixed(1)} MB`;
          return;
        }
        const pct = evt.loaded / evt.total;
        bar.style.width = `${(pct * 100).toFixed(0)}%`;
        const circumference = 188.5;
        ring.setAttribute('stroke-dashoffset', String(circumference * (1 - pct)));
        bootSub.textContent = `Alm-Modell wird geladen · ${(pct * 100).toFixed(0)} %`;
      },
      (err) => { console.error('gltf load failed', err); bootSub.textContent = 'Karte konnte nicht geladen werden.'; reject(err); }
    );
  });
}

function animate() {
  requestAnimationFrame(animate);
  const dt = scene3.clock.getDelta();
  const t = scene3.clock.elapsedTime;

  // Idle slow orbit around whatever we're currently focused on (courses > map).
  if (scene3.ready && scene3.idleOrbit && !scene3.placementMode) {
    const angle = t * 0.04;
    const c = scene3.orbitCenter;
    const r = scene3.orbitRadius;
    const cy = scene3.camera.position.y;
    scene3.camera.position.x = c.x + Math.cos(angle) * r * 0.72;
    scene3.camera.position.z = c.z + Math.sin(angle) * r * 0.72;
    scene3.camera.position.y = cy;
    scene3.controls.target.copy(c);
  }

  // Pulse route material offsets
  scene3.routeGroup.children.forEach((mesh) => {
    if (mesh.material && mesh.material.map) {
      mesh.material.map.offset.x = (mesh.material.map.offset.x - dt * 0.6) % 1;
    }
  });

  // Marker floats: subtle bob
  scene3.markerGroup.children.forEach((sprite) => {
    if (sprite.userData.baseY != null) {
      sprite.position.y = sprite.userData.baseY + Math.sin(t * 2.2 + sprite.userData.phase) * 0.25;
    }
    if (sprite.isSprite) sprite.lookAt(scene3.camera.position);
  });

  scene3.controls.update();
  scene3.renderer.render(scene3.scene, scene3.camera);
}

// Legacy onCanvasTap removed — placement now handled by wirePlacementPointer.

/* ---------------- Marker sprite factory ---------------- */
function makeLabelTexture(emoji, badge, colorHex) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  // background disc
  const grad = ctx.createRadialGradient(128, 128, 30, 128, 128, 120);
  grad.addColorStop(0, colorHex || '#ffb547');
  grad.addColorStop(0.7, colorHex ? colorHex + 'cc' : '#ff9a1acc');
  grad.addColorStop(1, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(128, 128, 118, 0, Math.PI * 2); ctx.fill();
  // inner disc
  ctx.fillStyle = 'rgba(10,20,15,0.9)';
  ctx.beginPath(); ctx.arc(128, 128, 78, 0, Math.PI * 2); ctx.fill();
  // outline
  ctx.strokeStyle = colorHex || '#ffb547';
  ctx.lineWidth = 3;
  ctx.stroke();
  // emoji
  ctx.font = '80px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 128, 132);
  if (badge != null) {
    // small badge top-right
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(200, 60, 30, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a0e02';
    ctx.font = 'bold 30px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(badge), 200, 62);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeMarkerSprite(emoji, colorHex, badge) {
  const tex = makeLabelTexture(emoji, badge, colorHex);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  const scale = scene3.radius * 0.05;
  sp.scale.set(scale, scale, scale);
  return sp;
}

function makeBeacon(colorHex, height) {
  const geo = new THREE.CylinderGeometry(0.02, 0.02, height, 6, 1, false);
  const mat = new THREE.MeshBasicMaterial({
    color: colorHex, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.scale.setScalar(scene3.radius * 0.04);
  return m;
}

/* ---------------- Route + markers rebuild ---------------- */
function makeDashTexture(colorHex) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 8;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillRect(0, 0, 128, 8);
  ctx.fillStyle = colorHex;
  // solid dashes with gaps
  for (let x = 0; x < 128; x += 24) ctx.fillRect(x, 2, 14, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildRoute(course, colorIdx) {
  const pts = waypointsOf(course);
  if (!pts || pts.length < 2) return;
  const v3s = pts.map(p => new THREE.Vector3(p.x, p.y + 0.5, p.z));
  const curve = new THREE.CatmullRomCurve3(v3s, false, 'catmullrom', 0.5);
  const segs = Math.max(64, v3s.length * 32);
  const tubeR = scene3.radius * 0.008;
  const geo = new THREE.TubeGeometry(curve, segs, tubeR, 8, false);
  const color = ROUTE_COLORS[colorIdx % ROUTE_COLORS.length];
  const tex = makeDashTexture(color);
  // repeat along the tube
  const length = curve.getLength();
  tex.repeat.set(Math.max(6, length / (scene3.radius * 0.06)), 1);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const tube = new THREE.Mesh(geo, mat);
  tube.userData.courseId = course.id;
  scene3.routeGroup.add(tube);
}

function buildMarkers(course, colorIdx) {
  const color = ROUTE_COLORS[colorIdx % ROUTE_COLORS.length];
  const add = (pos, emoji, badge, kind) => {
    if (!pos) return;
    const anchor = new THREE.Vector3(pos.x, pos.y, pos.z);
    const beacon = makeBeacon(color, 4);
    beacon.position.copy(anchor);
    beacon.position.y += 2;
    beacon.userData.courseId = course.id;
    scene3.markerGroup.add(beacon);

    const sprite = makeMarkerSprite(emoji, color, badge);
    sprite.position.set(anchor.x, anchor.y + scene3.radius * 0.05, anchor.z);
    sprite.userData.courseId = course.id;
    sprite.userData.kind = kind;
    sprite.userData.baseY = sprite.position.y;
    sprite.userData.phase = Math.random() * Math.PI * 2;
    scene3.markerGroup.add(sprite);
  };
  add(course.startPos, '🚩', null, 'start');
  add(course.endPos, '🏁', null, 'end');
  (course.obstacles || []).forEach((o, i) => {
    if (!o.pos) return;
    const t = OBSTACLE_TYPES.find(x => x.key === o.type) || OBSTACLE_TYPES[5];
    add(o.pos, t.emoji, i + 1, 'obs');
  });
}

function clearGroup(g) {
  while (g.children.length) {
    const child = g.children.pop();
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  }
}

function rebuildAllRoutes() {
  if (!scene3.ready) return;
  clearGroup(scene3.routeGroup);
  clearGroup(scene3.markerGroup);
  state.courses.forEach((c, i) => {
    buildRoute(c, i);
    buildMarkers(c, i);
  });
  updateVisibleCourses();
}

// In Play we isolate the active course, in Kurse the selected preview,
// otherwise we show the full overview.
function updateVisibleCourses() {
  if (!scene3.ready) return;
  let only = null;
  if (state.tab === 'play') only = state.activeCourseId;
  else if (state.tab === 'courses' && state.selectedCourseId) only = state.selectedCourseId;
  const apply = (o) => { o.visible = !only || o.userData.courseId === only; };
  scene3.routeGroup.children.forEach(apply);
  scene3.markerGroup.children.forEach(apply);
}

// Draft preview for the editor (single course being edited).
// Sprites carry userData.wp = {kind, index?} so we can identify them via raycaster.
let draftGroup = null;
function drawDraft(course, colorIdx) {
  if (draftGroup) { scene3.scene.remove(draftGroup); clearGroup(draftGroup); draftGroup = null; }
  draftGroup = new THREE.Group();
  scene3.scene.add(draftGroup);

  const pts = waypointsOf(course);
  const color = ROUTE_COLORS[colorIdx % ROUTE_COLORS.length];
  if (pts && pts.length >= 2) {
    const v3s = pts.map(p => new THREE.Vector3(p.x, p.y + 0.5, p.z));
    const curve = new THREE.CatmullRomCurve3(v3s, false, 'catmullrom', 0.5);
    const segs = Math.max(64, v3s.length * 32);
    const geo = new THREE.TubeGeometry(curve, segs, scene3.radius * 0.008, 8, false);
    const tex = makeDashTexture(color);
    const length = curve.getLength();
    tex.repeat.set(Math.max(6, length / (scene3.radius * 0.06)), 1);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    draftGroup.add(new THREE.Mesh(geo, mat));
  }
  const add = (pos, emoji, badge, wp) => {
    if (!pos) return;
    const beacon = makeBeacon(color, 4);
    beacon.position.set(pos.x, pos.y + 2, pos.z);
    draftGroup.add(beacon);
    const sprite = makeMarkerSprite(emoji, color, badge);
    sprite.position.set(pos.x, pos.y + scene3.radius * 0.05, pos.z);
    sprite.userData.baseY = sprite.position.y;
    sprite.userData.phase = Math.random() * Math.PI * 2;
    sprite.userData.wp = wp;
    draftGroup.add(sprite);
  };
  add(course.startPos, '🚩', null, { kind: 'start' });
  add(course.endPos, '🏁', null, { kind: 'end' });
  (course.obstacles || []).forEach((o, i) => {
    if (!o.pos) return;
    const t = OBSTACLE_TYPES.find(x => x.key === o.type) || OBSTACLE_TYPES[5];
    add(o.pos, t.emoji, i + 1, { kind: 'obs', index: i });
  });
}
function clearDraft() {
  if (draftGroup) { scene3.scene.remove(draftGroup); clearGroup(draftGroup); draftGroup = null; }
}

/* ---------------- Camera focus animation ---------------- */
function focusCourse(course, duration = 900) {
  const pts = waypointsOf(course) || (course.startPos ? [course.startPos] : null);
  if (!pts || !pts.length) return;
  const box = new THREE.Box3();
  pts.forEach(p => box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z)));
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  const dist = Math.max(size.length() * 1.6, scene3.radius * 0.6);
  const camTo = new THREE.Vector3(
    center.x + dist * 0.5,
    Math.max(center.y + dist * 0.55, size.y + dist * 0.4),
    center.z + dist * 0.9
  );
  scene3.orbitCenter.copy(center);
  scene3.orbitRadius = dist;
  animateCamera(camTo, center.clone(), duration);
}

// Frame the camera on all courses that already have a route.
// If none exist, fall back to the map center.
function focusOnCourses(courses, duration = 800) {
  const withRoute = (courses || []).filter(c => hasRoute(c));
  if (withRoute.length === 0) {
    scene3.orbitCenter.copy(scene3.center);
    scene3.orbitRadius = scene3.radius * 1.6;
    animateCamera(
      new THREE.Vector3(
        scene3.center.x + scene3.radius * 1.1,
        scene3.center.y + scene3.radius * 1.2,
        scene3.center.z + scene3.radius * 1.3),
      scene3.center.clone(), duration);
    return;
  }
  const box = new THREE.Box3();
  withRoute.forEach(c => {
    const pts = waypointsOf(c);
    if (pts) pts.forEach(p => box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z)));
  });
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  const dist = Math.max(size.length() * 1.35, scene3.radius * 0.55);
  scene3.orbitCenter.copy(center);
  scene3.orbitRadius = dist;
  const camTo = new THREE.Vector3(
    center.x + dist * 0.5,
    Math.max(center.y + dist * 0.7, size.y + dist * 0.4),
    center.z + dist * 0.9
  );
  animateCamera(camTo, center.clone(), duration);
}

function animateCamera(camTo, targetTo, duration) {
  scene3.idleOrbit = false;
  const camFrom = scene3.camera.position.clone();
  const targetFrom = scene3.controls.target.clone();
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    scene3.camera.position.lerpVectors(camFrom, camTo, e);
    scene3.controls.target.lerpVectors(targetFrom, targetTo, e);
    scene3.controls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ============================================================
   Placement mode HUD — sidebar sequence + mode-bar + type-picker
   ============================================================ */
function enterPlacement(course, editorApi) {
  document.body.classList.add('placing');
  // Isolate the draft: hide already-saved routes/markers so the map only shows this course.
  scene3.routeGroup.visible = false;
  scene3.markerGroup.visible = false;

  const side = el(`<aside class="place-side" id="placeSide">
    <div class="place-side-head">Sequenz</div>
    <div id="placeList"></div>
    <div class="place-side-hint">Marker antippen zum Löschen · Reihenfolge mit ▲▼ · Neuer Punkt fragt nach Typ</div>
  </aside>`);
  const modes = el(`<div class="place-mode-bar" id="placeModes">
    <button class="place-mode-btn" data-mode="start">🚩 Start</button>
    <button class="place-mode-btn" data-mode="end">🏁 Ziel</button>
    <button class="place-mode-btn" data-mode="obs">＋ Hindernis</button>
  </div>`);
  const cancel = el(`<button class="place-cancel" id="placeCancel">← Zurück</button>`);
  const done = el(`<button class="place-done" id="placeDone">✓ Fertig</button>`);
  document.body.append(side, modes, cancel, done);

  let mode = course.startPos ? (course.endPos ? 'obs' : 'end') : 'start';

  function setMode(m) {
    mode = m;
    scene3.placementMode = m;
    modes.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  }

  function refreshSide() {
    const list = $('#placeList', side);
    list.innerHTML = '';
    const startRow = el(`<div class="wp-item anchor ${course.startPos ? 'has' : 'no'}">
      <div class="wp-badge">🚩</div>
      <div class="wp-label">Start</div>
      <div class="wp-status">${course.startPos ? 'gesetzt' : 'fehlt'}</div>
      ${course.startPos ? `<button class="wp-btn wp-del" data-act="clear-start" title="Start löschen">✕</button>` : ''}
    </div>`);
    list.appendChild(startRow);

    (course.obstacles || []).forEach((o, i) => {
      const t = OBSTACLE_TYPES.find(x => x.key === o.type) || OBSTACLE_TYPES[5];
      const row = el(`<div class="wp-item ${o.pos ? 'has' : 'no'}">
        <div class="wp-num">${i + 1}</div>
        <div class="wp-emoji">${t.emoji}</div>
        <div class="wp-label">${esc(o.text || t.label)}</div>
        <button class="wp-btn" data-act="up-${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="wp-btn" data-act="down-${i}" ${i === course.obstacles.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="wp-btn wp-del" data-act="del-${i}">✕</button>
      </div>`);
      list.appendChild(row);
    });

    const endRow = el(`<div class="wp-item anchor ${course.endPos ? 'has' : 'no'}">
      <div class="wp-badge">🏁</div>
      <div class="wp-label">Ziel</div>
      <div class="wp-status">${course.endPos ? 'gesetzt' : 'fehlt'}</div>
      ${course.endPos ? `<button class="wp-btn wp-del" data-act="clear-end" title="Ziel löschen">✕</button>` : ''}
    </div>`);
    list.appendChild(endRow);
  }

  side.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const [op, val] = b.dataset.act.split('-');
    if (op === 'up') {
      const i = +val;
      if (i > 0) [course.obstacles[i-1], course.obstacles[i]] = [course.obstacles[i], course.obstacles[i-1]];
    } else if (op === 'down') {
      const i = +val;
      if (i < course.obstacles.length - 1) [course.obstacles[i+1], course.obstacles[i]] = [course.obstacles[i], course.obstacles[i+1]];
    } else if (op === 'del') {
      course.obstacles.splice(+val, 1);
    } else if (op === 'clear' && val === 'start') {
      course.startPos = null;
      if (mode !== 'start') setMode('start');
    } else if (op === 'clear' && val === 'end') {
      course.endPos = null;
      if (mode === 'obs') setMode('end');
    }
    refreshSide();
    editorApi.redraw();
    editorApi.notifyChange && editorApi.notifyChange();
  });

  modes.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  scene3.placementCallback = (p) => {
    if (mode === 'start') {
      course.startPos = p;
      setMode(course.endPos ? 'obs' : 'end');
      refreshSide(); editorApi.redraw(); editorApi.notifyChange && editorApi.notifyChange();
    } else if (mode === 'end') {
      course.endPos = p;
      setMode('obs');
      refreshSide(); editorApi.redraw(); editorApi.notifyChange && editorApi.notifyChange();
    } else {
      openTypePicker((typeKey, text) => {
        if (!typeKey) return;
        const t = OBSTACLE_TYPES.find(x => x.key === typeKey);
        course.obstacles.push({
          id: uid(), type: typeKey,
          text: text || t.label,
          pos: p,
        });
        refreshSide(); editorApi.redraw(); editorApi.notifyChange && editorApi.notifyChange();
      });
    }
  };

  scene3.markerClickCallback = (wp) => {
    if (!wp) return;
    if (wp.kind === 'start') { course.startPos = null; if (mode !== 'start') setMode('start'); }
    else if (wp.kind === 'end') { course.endPos = null; if (mode !== 'end') setMode('end'); }
    else if (wp.kind === 'obs') { course.obstacles.splice(wp.index, 1); }
    refreshSide(); editorApi.redraw(); editorApi.notifyChange && editorApi.notifyChange();
    toast('Gelöscht');
  };

  function cleanup() {
    document.body.classList.remove('placing');
    scene3.routeGroup.visible = true;
    scene3.markerGroup.visible = true;
    side.remove(); modes.remove(); cancel.remove(); done.remove();
    scene3.placementMode = null;
    scene3.placementCallback = null;
    scene3.markerClickCallback = null;
    editorApi.onExitPlacement && editorApi.onExitPlacement();
  }
  cancel.addEventListener('click', cleanup);
  done.addEventListener('click', cleanup);

  setMode(mode);
  refreshSide();
  editorApi._cleanup = cleanup;
}

/* Type picker modal — appears after tapping the terrain in Hindernis mode. */
function openTypePicker(callback) {
  const modal = el(`<div class="type-picker" id="typePicker">
    <div class="type-picker-card">
      <div class="type-picker-title">Was ist das für ein Hindernis?</div>
      <div class="type-picker-sub">Typ wählen · optional beschriften · platzieren</div>
      <div class="type-picker-grid" id="tpGrid"></div>
      <input type="text" id="tpText" placeholder="Beschreibung (optional)">
      <button class="btn btn-primary btn-block" id="tpConfirm" style="margin-top:12px" disabled>Platzieren</button>
      <button class="btn btn-ghost btn-block" id="tpCancel" style="margin-top:6px">Abbrechen</button>
    </div>
  </div>`);
  document.body.appendChild(modal);
  let chosen = null;
  const grid = $('#tpGrid', modal);
  OBSTACLE_TYPES.forEach(t => {
    const b = el(`<button class="type-picker-btn" data-t="${t.key}">
      <span class="tp-emoji">${t.emoji}</span>
      <span class="tp-label">${t.label}</span>
    </button>`);
    b.addEventListener('click', () => {
      chosen = t.key;
      grid.querySelectorAll('.type-picker-btn').forEach(x => x.classList.toggle('on', x === b));
      $('#tpConfirm', modal).disabled = false;
    });
    grid.appendChild(b);
  });
  const cleanup = () => modal.remove();
  $('#tpConfirm', modal).addEventListener('click', () => {
    const text = $('#tpText', modal).value.trim();
    cleanup(); callback(chosen, text);
  });
  $('#tpCancel', modal).addEventListener('click', () => { cleanup(); callback(null, null); });
  modal.addEventListener('click', (e) => { if (e.target === modal) { cleanup(); callback(null, null); } });
}

/* ============================================================
   VIEWS
   ============================================================ */
const view = $('#view');

function render() {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
  view.scrollTop = 0;
  const map = {
    leaderboard: renderLeaderboard,
    play: renderPlay,
    map: renderMap,
    courses: renderCourses,
    players: renderPlayers,
  };
  view.classList.toggle('compact', state.tab === 'map');
  view.classList.toggle('play-route', state.tab === 'play' && state.playSub !== 'scores');
  view.classList.toggle('play-scores', state.tab === 'play' && state.playSub === 'scores');
  (map[state.tab] || renderLeaderboard)();
  updateVisibleCourses();

  // Camera behavior per tab
  if (state.tab === 'play' && state.activeCourseId) {
    scene3.idleOrbit = false;
    const c = state.courses.find(x => x.id === state.activeCourseId);
    if (c && hasRoute(c)) focusCourse(c, 700);
    else focusOnCourses(state.courses, 700);
  } else if (state.tab === 'courses' && state.selectedCourseId) {
    scene3.idleOrbit = false;
    const c = state.courses.find(x => x.id === state.selectedCourseId);
    if (c && hasRoute(c)) focusCourse(c, 700);
    else focusOnCourses(state.courses, 700);
  } else {
    focusOnCourses(state.courses, 700);
    scene3.idleOrbit = (state.tab === 'leaderboard');
  }
}

/* ---------- Leaderboard ---------- */
function renderLeaderboard() {
  const round = activeRound();
  if (round && (isRoundComplete(round) || round.endedAt)) { renderWinner(round); return; }
  const rows = leaderboard();
  const anyPlayed = rows.some(r => r.played > 0);
  const parTotal = totalPar();

  let html = `<div class="view-head">
    <div>
      <h1 class="view-title">Rang<em>liste</em></h1>
      <p class="view-desc">${round ? esc(round.name) : 'Keine aktive Runde'}</p>
    </div>
    ${round ? `<span class="tag tag-live">Live</span>` : `<span class="tag">—</span>`}
  </div>`;

  if (state.players.length === 0) {
    html += emptyState('S', 'Noch keine Spieler', 'Lege zuerst ein paar Spieler an, dann kann das Turnier starten.', 'Spieler anlegen', "go('players')");
    view.innerHTML = html; return;
  }
  if (!round) {
    html += `<div class="card"><div class="empty">
      <span class="empty-emoji">§</span>
      <h3>Keine Runde gestartet</h3>
      <p>Starte eine neue Runde und wähle, wer diesmal mitspielt.</p>
      <button class="btn btn-primary" onclick="go('play')">Runde starten</button>
    </div></div>`;
    // Show past rounds
    const past = state.rounds.filter(r => r.endedAt);
    if (past.length) {
      html += `<div class="section-label">Vergangene Runden</div>`;
      past.slice().reverse().forEach(r => {
        html += `<div class="rank-row tap" onclick="resumeRound('${r.id}')">
          <div class="rank-badge">✓</div>
          <div class="grow">
            <div class="rank-name truncate">${esc(r.name)}</div>
            <div class="rank-meta">${r.playerIds.length} Spieler · ${new Date(r.startedAt).toLocaleDateString('de-DE')}</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteRound('${r.id}')">✕</button>
        </div>`;
      });
    }
    view.innerHTML = html; return;
  }
  if (!anyPlayed) {
    html += `<div class="card"><div class="empty">
      <span class="empty-emoji">§</span>
      <h3>Runde läuft — noch keine Schläge</h3>
      <p>Tippt auf „Spielen" um mit dem ersten Kurs zu starten.</p>
      <button class="btn btn-primary" onclick="go('play')">Zum ersten Kurs →</button>
    </div></div>`;
  }

  html += `<div>`;
  rows.forEach((r, i) => {
    const rankClass = r.played === 0 ? '' : `rank-${i + 1}`;
    const badge = r.played === 0 ? '—' : String(i + 1).padStart(2, '0');
    const toPar = r.played === 0 ? '' : toParLabel(r.toPar);
    html += `<div class="rank-row ${i === 0 && r.played ? 'gold' : ''}">
      <div class="rank-badge ${rankClass}">${badge}</div>
      <div class="avatar" style="background:${r.player.color}">${esc(initials(r.player.name))}</div>
      <div class="grow">
        <div class="rank-name truncate">${esc(r.player.name)}</div>
        <div class="rank-meta">${r.played}/${r.courseCount} Kurse · ${r.played ? r.total + ' Schläge' : 'noch nicht gestartet'}</div>
      </div>
      <div class="rank-score">
        <div class="rank-total">${r.played ? r.total : '—'}</div>
        ${toPar}
      </div>
    </div>`;
  });
  html += `</div>`;

  if (round) {
    html += `<div class="section-label">Runde</div>
    <div class="card row-between">
      <div>
        <div class="mono small muted" style="letter-spacing:0.16em;text-transform:uppercase">Gesamt-Par</div>
        <div class="mono" style="font-size:22px;font-weight:500">${parTotal} <span class="muted small">Schläge</span></div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-sm" onclick="finishRound()">Abschließen</button>
        <button class="btn btn-danger btn-sm" onclick="endRound()">Archivieren</button>
      </div>
    </div>`;
  }
  html += `<button class="btn btn-primary btn-block" style="margin-top:14px" onclick="newRound()">＋ Neues Spiel starten</button>`;
  view.innerHTML = html;
}
function toParLabel(t) {
  if (t === 0) return `<div class="rank-topar topar-even">± Par</div>`;
  if (t < 0)   return `<div class="rank-topar topar-under">${t} unter</div>`;
  return `<div class="rank-topar topar-over">+${t} über</div>`;
}

/* ---------- Winner overview ---------- */
function renderWinner(round) {
  const rows = leaderboard();
  const winner = rows[0];
  const runners = rows.slice(1);
  const parTotal = totalPar();

  let html = `<div class="winner-hero">
    <div class="winner-crown">🏆</div>
    <div class="winner-label">Sieger · ${esc(round.name)}</div>
    <div class="winner-name">${esc(winner.player.name)}</div>
    <div class="winner-score">
      <span class="mono" style="font-size:34px;font-weight:500;letter-spacing:-0.03em">${winner.total}</span>
      <span class="mono small muted" style="letter-spacing:0.14em;text-transform:uppercase;margin-left:6px">Schläge</span>
    </div>
    <div class="mono small" style="color:${winner.toPar <= 0 ? 'var(--moss-200)' : 'var(--clay)'};letter-spacing:0.14em;text-transform:uppercase;margin-top:4px">
      ${winner.toPar === 0 ? '± Par' : (winner.toPar < 0 ? `${winner.toPar} unter Par` : `+${winner.toPar} über Par`)}
    </div>
  </div>`;

  if (runners.length) {
    html += `<div class="section-label">Auch dabei</div>`;
    runners.forEach((r, i) => {
      html += `<div class="rank-row">
        <div class="rank-badge rank-${i + 2}">${String(i + 2).padStart(2, '0')}</div>
        <div class="avatar" style="background:${r.player.color}">${esc(initials(r.player.name))}</div>
        <div class="grow">
          <div class="rank-name truncate">${esc(r.player.name)}</div>
          <div class="rank-meta">${r.total} Schläge · ${r.courseCount} Kurse</div>
        </div>
        <div class="rank-score">
          <div class="rank-total">${r.total}</div>
          ${toParLabel(r.toPar)}
        </div>
      </div>`;
    });
  }

  html += `<div class="section-label">Bahn-für-Bahn</div>`;
  const courses = roundCourses(round);
  const players = roundPlayers(round);
  html += `<div class="course-grid">`;
  courses.forEach((c, i) => {
    // Sort scores per course to find hole winner(s)
    const holeScores = players.map(p => ({ p, s: scoreFor(c.id, p.id) })).sort((a,b) => a.s - b.s);
    const bestS = holeScores[0].s;
    const best = holeScores.filter(x => x.s === bestS);
    html += `<div class="course-row">
      <div class="course-row-head">
        <span class="mono" style="font-size:10px;letter-spacing:0.2em;color:var(--amber-300)">${String(i + 1).padStart(2, '0')}</span>
        <span style="font-family:var(--font-display);font-size:15px">${esc(c.name)}</span>
        <span class="mono small muted" style="letter-spacing:0.14em">Par ${Number(c.par) || 0}</span>
      </div>
      <div class="course-row-scores">
        ${holeScores.map(x => `
          <div class="course-row-score ${best.some(b => b.p.id === x.p.id) ? 'best' : ''}">
            <div class="avatar" style="background:${x.p.color};width:22px;height:22px;font-size:9.5px">${esc(initials(x.p.name))}</div>
            <span class="mono">${x.s}</span>
          </div>
        `).join('')}
      </div>
    </div>`;
  });
  html += `</div>`;

  const wasManual = !!round.endedAt && !isRoundComplete(round);
  const reopenLabel = wasManual ? 'Wieder öffnen' : 'Weiter tracken';
  const reopenCall = wasManual ? 'reopenRound()' : "go('play')";
  html += `<div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">
    <button class="btn btn-primary btn-block" onclick="newRound()">＋ Neues Spiel</button>
  </div>
  <div class="row" style="gap:8px;margin-top:8px">
    <button class="btn btn-danger btn-block" onclick="endRound()">Archivieren</button>
    <button class="btn btn-block" onclick="${reopenCall}">${reopenLabel}</button>
  </div>`;

  view.innerHTML = html;
}

/* ---------- Play ---------- */
function renderPlay() {
  if (state.courses.length === 0) {
    view.innerHTML = `<div class="view-head"><div>
      <h1 class="view-title">Spielen</h1>
      <p class="view-desc">Schläge zählen · Kurs für Kurs</p>
    </div></div>` + emptyState('§', 'Keine Kurse', 'Erstelle zuerst einen Kurs mit Start, Ziel und Hindernissen.', 'Kurs erstellen', "go('courses')");
    return;
  }
  if (state.players.length === 0) {
    view.innerHTML = `<div class="view-head"><div>
      <h1 class="view-title">Spielen</h1>
      <p class="view-desc">Schläge zählen · Kurs für Kurs</p>
    </div></div>` + emptyState('S', 'Keine Spieler', 'Lege Spieler an, damit ihr Schläge tracken könnt.', 'Spieler anlegen', "go('players')");
    return;
  }

  // No active round → start-screen with participant picker
  const round = activeRound();
  if (!round) { renderRoundStart(); return; }

  const courses = roundCourses(round);
  if (courses.length === 0) {
    view.innerHTML = `<div class="view-head"><div>
      <h1 class="view-title">Runde</h1>
      <p class="view-desc">Keine Kurse in dieser Runde</p>
    </div></div>` + emptyState('§', 'Keine Kurse in dieser Runde', 'Beende die Runde und starte eine neue mit Kursen.', 'Runde beenden', 'endRound()');
    return;
  }
  if (!state.activeCourseId || !courses.find(c => c.id === state.activeCourseId)) {
    state.activeCourseId = courses[0].id;
  }
  if (!state.playSub) state.playSub = 'route';
  const active = courses.find(c => c.id === state.activeCourseId);
  const idx = courses.indexOf(active);
  const players = roundPlayers(round);

  // Header row (single line, tight) + end-round quick action
  let html = `<div class="play-course-head">
    <span class="num">Bahn ${String(idx + 1).padStart(2, '0')}</span>
    <span class="name">${esc(active.name)}</span>
    <span class="par-pill">Par ${Number(active.par) || 0}</span>
    <button class="play-end" onclick="finishRound()" title="Runde abschließen · Sieger anzeigen">✕</button>
  </div>`;

  // Kurs-Auswahl nur bei > 1 Bahn in der Runde
  if (courses.length > 1) {
    html += `<div class="play-tabs" id="courseTabs">`;
    courses.forEach((c, i) => {
      const done = coursePlayed(c.id);
      const cls = ['play-tab', c.id === active.id ? 'on' : '', done ? 'done' : ''].filter(Boolean).join(' ');
      html += `<button class="${cls}" data-course="${c.id}">${done ? '✓' : String(i + 1).padStart(2, '0')} · ${esc(c.name)}</button>`;
    });
    html += `</div>`;
  }

  // Sub-tabs: Route (3D fokus) vs Schläge
  html += `<div class="play-subtabs" id="playSubs">
    <button class="play-subtab ${state.playSub === 'route' ? 'on' : ''}" data-sub="route">Route</button>
    <button class="play-subtab ${state.playSub === 'scores' ? 'on' : ''}" data-sub="scores">Schläge</button>
  </div>`;

  if (state.playSub === 'route') {
    // ROUTE: nur die Chip-Kette. Kein Button, kein Summary. Karte dominiert.
    if (hasRoute(active)) {
      html += renderSequenceStrip(active);
    } else {
      html += `<div class="seq-none">— keine Route · <a onclick="editCourse('${active.id}')" style="color:var(--amber-300);cursor:pointer;text-decoration:underline">jetzt einzeichnen</a></div>`;
    }
  } else {
    // SCHLÄGE: nur teilnehmende Spieler der aktuellen Runde
    players.forEach(p => {
      const s = scoreFor(active.id, p.id);
      html += `<div class="play-row" data-player="${p.id}">
        <div class="row grow" style="min-width:0">
          <div class="avatar" style="background:${p.color}">${esc(initials(p.name))}</div>
          <div class="grow" style="min-width:0">
            <div class="play-name truncate">${esc(p.name)}</div>
            <div class="play-meta">${parDiffText(s, active.par)}</div>
          </div>
        </div>
        <div class="stepper">
          <button class="step-btn step-minus" data-act="dec">−</button>
          <div class="step-val ${s === 0 ? 'zero' : ''}" data-val>${s}</div>
          <button class="step-btn step-plus" data-act="inc">+</button>
        </div>
      </div>`;
    });
    html += idx < courses.length - 1
      ? `<button class="btn btn-primary btn-block btn-sm" style="margin-top:4px" onclick="nextCourse()">Nächster Kurs →</button>`
      : `<button class="btn btn-primary btn-block btn-sm" style="margin-top:4px" onclick="go('leaderboard')">→ Rangliste</button>`;
  }

  view.innerHTML = html;

  const ctabs = $('#courseTabs');
  if (ctabs) ctabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-course]');
    if (!b) return;
    state.activeCourseId = b.dataset.course; save(); render();
  });
  const psubs = $('#playSubs');
  if (psubs) psubs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sub]');
    if (!b) return;
    setPlaySub(b.dataset.sub);
  });

  if (state.playSub === 'scores') {
    view.querySelectorAll('[data-player]').forEach(rowEl => {
      const pid = rowEl.dataset.player;
      const valEl = rowEl.querySelector('[data-val]');
      const metaEl = rowEl.querySelector('.play-meta');
      const update = (delta) => {
        const nv = Math.max(0, scoreFor(active.id, pid) + delta);
        setScore(active.id, pid, nv);
        valEl.textContent = nv;
        valEl.classList.toggle('zero', nv === 0);
        metaEl.textContent = parDiffText(nv, active.par);
        if (navigator.vibrate) navigator.vibrate(8);
      };
      rowEl.querySelector('[data-act=inc]').addEventListener('click', () => update(1));
      rowEl.querySelector('[data-act=dec]').addEventListener('click', () => update(-1));
      valEl.addEventListener('click', () => {
        const v = prompt('Schläge eingeben:', scoreFor(active.id, pid));
        if (v === null) return;
        const n = Math.max(0, parseInt(v, 10) || 0);
        setScore(active.id, pid, n);
        valEl.textContent = n; valEl.classList.toggle('zero', n === 0);
        metaEl.textContent = parDiffText(n, active.par);
      });
    });
  }
}

function setPlaySub(sub) {
  state.playSub = sub;
  save();
  render();
}

/* ---------- Round start screen (pick players + courses) ---------- */
let roundDraft = null; // { playerIds:Set, courseIds:Set, name }
function renderRoundStart() {
  if (!roundDraft) {
    roundDraft = {
      playerIds: new Set(state.players.map(p => p.id)),
      courseIds: new Set(state.courses.map(c => c.id)),
      name: '',
    };
  }
  const now = new Date();
  const defaultName = `Runde ${now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;

  let html = `<div class="view-head"><div>
    <h1 class="view-title">Neue <em>Runde</em></h1>
    <p class="view-desc">Wer spielt mit · welche Bahnen</p>
  </div></div>`;

  html += `<label class="field"><span>Rundenname</span>
    <input type="text" id="rdName" placeholder="${esc(defaultName)}" value="${esc(roundDraft.name)}"></label>`;

  // ---- Players ----
  html += `<div class="section-label actions">
    <span>Spieler · ${roundDraft.playerIds.size}/${state.players.length}</span>
    <span style="display:inline-flex;gap:4px">
      <button class="btn btn-sm" style="padding:4px 10px" onclick="pickAllPlayers(true)">Alle</button>
      <button class="btn btn-sm" style="padding:4px 10px" onclick="pickAllPlayers(false)">Keine</button>
    </span>
  </div>`;
  html += `<div class="pick-grid" id="rdPlayers">`;
  if (state.players.length === 0) {
    html += `<p class="mono small muted" style="letter-spacing:0.14em;text-transform:uppercase">Noch keine Spieler · lege sie im Tab „Team" an</p>`;
  }
  state.players.forEach(p => {
    const on = roundDraft.playerIds.has(p.id);
    html += `<button class="pick-pill ${on ? 'on' : ''}" data-pick-p="${p.id}">
      <span class="avatar" style="background:${p.color}">${esc(initials(p.name))}</span>
      <span class="name">${esc(p.name)}</span>
    </button>`;
  });
  html += `</div>`;

  // ---- Courses ----
  html += `<div class="section-label actions">
    <span>Bahnen · ${roundDraft.courseIds.size}/${state.courses.length}</span>
    <span style="display:inline-flex;gap:4px">
      <button class="btn btn-sm" style="padding:4px 10px" onclick="pickAllCourses(true)">Alle</button>
      <button class="btn btn-sm" style="padding:4px 10px" onclick="pickAllCourses(false)">Keine</button>
    </span>
  </div>`;
  html += `<div class="pick-grid" id="rdCourses">`;
  if (state.courses.length === 0) {
    html += `<p class="mono small muted" style="letter-spacing:0.14em;text-transform:uppercase">Noch keine Kurse · lege sie im Tab „Kurse" an</p>`;
  }
  state.courses.forEach((c, i) => {
    const on = roundDraft.courseIds.has(c.id);
    html += `<button class="pick-pill ${on ? 'on' : ''}" data-pick-c="${c.id}">
      <span class="num-chip">${String(i + 1).padStart(2, '0')}</span>
      <span class="name">${esc(c.name)}</span>
      <span class="par-note">Par ${Number(c.par) || 0}</span>
    </button>`;
  });
  html += `</div>`;

  html += `<button class="btn btn-primary btn-block" style="margin-top:14px" id="rdStart">Runde starten →</button>`;

  view.innerHTML = html;

  $('#rdPlayers').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick-p]');
    if (!b) return;
    const pid = b.dataset.pickP;
    if (roundDraft.playerIds.has(pid)) roundDraft.playerIds.delete(pid);
    else roundDraft.playerIds.add(pid);
    renderRoundStart();
  });
  $('#rdCourses').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick-c]');
    if (!b) return;
    const cid = b.dataset.pickC;
    if (roundDraft.courseIds.has(cid)) roundDraft.courseIds.delete(cid);
    else roundDraft.courseIds.add(cid);
    renderRoundStart();
  });
  $('#rdName').addEventListener('input', (e) => { roundDraft.name = e.target.value; });
  $('#rdStart').addEventListener('click', () => {
    if (roundDraft.playerIds.size === 0) { toast('Mindestens eine Person auswählen'); return; }
    if (roundDraft.courseIds.size === 0) { toast('Mindestens eine Bahn auswählen'); return; }
    // Preserve course order as it appears in state.courses
    const orderedCourseIds = state.courses.map(c => c.id).filter(id => roundDraft.courseIds.has(id));
    const round = {
      id: uid(),
      name: (roundDraft.name || defaultName).trim(),
      startedAt: Date.now(),
      endedAt: null,
      playerIds: Array.from(roundDraft.playerIds),
      courseIds: orderedCourseIds,
      scores: {},
    };
    state.rounds.push(round);
    state.activeRoundId = round.id;
    state.activeCourseId = orderedCourseIds[0] || null;
    state.playSub = 'route';
    roundDraft = null;
    save(); render();
    toast('Runde gestartet');
  });
}

function pickAllPlayers(all) {
  if (!roundDraft) return;
  roundDraft.playerIds = new Set(all ? state.players.map(p => p.id) : []);
  renderRoundStart();
}
function pickAllCourses(all) {
  if (!roundDraft) return;
  roundDraft.courseIds = new Set(all ? state.courses.map(c => c.id) : []);
  renderRoundStart();
}

// Mark a round as finished but keep it active — leaderboard flips to
// the winner overview so the group can enjoy the result before it's
// archived.
function finishRound() {
  const r = activeRound(); if (!r) return;
  if (!confirm(`Runde "${r.name}" jetzt abschließen und Sieger zeigen?`)) return;
  r.endedAt = Date.now();
  save(); go('leaderboard');
  toast('Runde abgeschlossen');
}

// Fully archive: no more active round, land on the round-start screen.
function endRound() {
  const r = activeRound(); if (!r) return;
  if (!r.endedAt) {
    if (!confirm(`Runde "${r.name}" archivieren? Die Ergebnisse bleiben in der Historie.`)) return;
    r.endedAt = Date.now();
  }
  state.activeRoundId = null;
  save(); render();
  toast('Runde archiviert');
}

// Re-open a finished round for further edits/plays.
function reopenRound() {
  const r = activeRound(); if (!r) return;
  r.endedAt = null;
  save(); go('play');
  toast('Runde weiter offen');
}

// Start a fresh round from anywhere. If one is running, ask first.
function newRound() {
  const r = activeRound();
  if (r && !r.endedAt) {
    if (!confirm(`Aktuelle Runde "${r.name}" abschließen und neue starten?`)) return;
    r.endedAt = Date.now();
  }
  state.activeRoundId = null;
  roundDraft = null;
  save(); go('play');
}

function resumeRound(id) {
  const r = state.rounds.find(x => x.id === id); if (!r) return;
  r.endedAt = null;
  state.activeRoundId = id;
  save(); render();
  toast(`"${r.name}" fortgesetzt`);
}

function deleteRound(id) {
  const r = state.rounds.find(x => x.id === id); if (!r) return;
  if (!confirm(`Runde "${r.name}" endgültig löschen?`)) return;
  state.rounds = state.rounds.filter(x => x.id !== id);
  if (state.activeRoundId === id) state.activeRoundId = null;
  save(); render();
  toast('Runde gelöscht');
}
function parDiffText(strokes, par) {
  par = Number(par) || 0;
  if (strokes === 0) return 'noch nicht gespielt';
  if (!par) return `${strokes} Schläge`;
  const d = strokes - par;
  if (d === 0) return `${strokes} Schläge · Par`;
  return `${strokes} Schläge · ${d > 0 ? '+' + d : d}`;
}

/* ---------- Map overview ---------- */
function renderMap() {
  const placed = state.courses.map((c, i) => ({ c, i })).filter(x => hasRoute(x.c));
  let html = `<div class="view-head">
    <div>
      <h1 class="view-title">Karte</h1>
      <p class="view-desc">Alle Bahnen · 3D · tippen zum Spielen</p>
    </div>
    <span class="tag">${placed.length}/${state.courses.length}</span>
  </div>`;

  if (placed.length === 0) {
    html += `<div class="row-between" style="gap:10px">
      <p class="mono small muted" style="letter-spacing:0.14em;text-transform:uppercase;margin:2px 4px;flex:1">Keine Bahnen in 3D · tippe unten oder platziere jetzt</p>
      <button class="btn btn-primary btn-sm" onclick="editCourse()">＋ Kurs</button>
    </div>`;
  } else {
    placed.forEach(({ c, i }) => {
      const done = coursePlayed(c.id);
      const col = ROUTE_COLORS[i % ROUTE_COLORS.length];
      html += `<div class="rank-row tap" onclick="playCourse('${c.id}')">
        <div class="rank-badge" style="background:${col};color:#1a0e02;border-color:transparent">${String(i + 1).padStart(2, '0')}</div>
        <div class="grow">
          <div class="rank-name truncate">${esc(c.name)}</div>
          <div class="rank-meta">${esc(c.start || 'Start')} → ${esc(c.end || 'Ziel')} · Par ${Number(c.par) || 0}</div>
        </div>
        <span class="mono small" style="color:var(--amber-300)">${done ? '✓' : '▸'}</span>
      </div>`;
    });
    const unplaced = state.courses.filter(c => !hasRoute(c));
    if (unplaced.length) {
      html += `<p class="mono small muted" style="margin-top:12px;letter-spacing:0.14em;text-transform:uppercase">${unplaced.length} Kurs${unplaced.length > 1 ? 'e' : ''} noch ohne Position</p>`;
    }
  }
  view.innerHTML = html;
}

function playCourse(id) {
  state.activeCourseId = id;
  go('play');
}

/* ---------- Courses ---------- */
function renderCourses() {
  let html = `<div class="view-head">
    <div>
      <h1 class="view-title">Kurse</h1>
      <p class="view-desc">${state.selectedCourseId ? '3D-Fokus · Bearbeiten oder andere Bahn wählen' : 'Bahn antippen zur Vorschau'}</p>
    </div>
    <span class="tag">${state.courses.length}</span>
  </div>`;

  if (state.courses.length === 0) {
    html += emptyState('§', 'Noch keine Kurse', 'Definiere eure Spikegolf-Bahnen: von wo nach wo, welche Hindernisse, und das Par.', 'Ersten Kurs erstellen', 'editCourse()');
    view.innerHTML = html; return;
  }

  const selId = state.selectedCourseId;
  state.courses.forEach((c, i) => {
    const sel = c.id === selId;
    if (sel) {
      html += `<div class="card course-card selected">
        <div class="course-top">
          <div class="grow">
            <div class="course-num">Bahn ${String(i + 1).padStart(2, '0')}</div>
            <h3 class="course-name">${esc(c.name)}</h3>
          </div>
          <span class="par-pill">Par ${Number(c.par) || 0}</span>
        </div>
        <div class="route"><b>🚩 ${esc(c.start || 'Start')}</b><span class="dots"></span><b>${esc(c.end || 'Ziel')} 🏁</b></div>
        ${hasRoute(c) ? renderSequenceStrip(c) : `<div class="mono small muted" style="margin-top:6px;letter-spacing:0.14em;text-transform:uppercase">Noch nicht auf 3D-Karte platziert</div>`}
        <div class="row" style="gap:6px;margin-top:12px">
          <button class="btn btn-primary btn-sm grow" onclick="editCourse('${c.id}')">Bearbeiten</button>
          <button class="btn btn-sm" onclick="deselectCourse()">Schließen</button>
        </div>
      </div>`;
    } else {
      html += `<div class="course-slim tap" onclick="selectCourse('${c.id}')">
        <div class="course-slim-num">${String(i + 1).padStart(2, '0')}</div>
        <div class="grow" style="min-width:0">
          <div class="course-slim-name truncate">${esc(c.name)}</div>
          <div class="course-slim-meta">Par ${Number(c.par) || 0} · ${hasRoute(c) ? '3D verortet' : 'nicht verortet'}</div>
        </div>
        <span class="course-slim-chev">›</span>
      </div>`;
    }
  });
  html += `<button class="fab-add" onclick="editCourse()">＋ Kurs hinzufügen</button>`;
  view.innerHTML = html;
}
function selectCourse(id) {
  state.selectedCourseId = id;
  save(); render();
}
function deselectCourse() {
  state.selectedCourseId = null;
  save(); render();
}
function obstaclesHtml(obstacles) {
  if (!obstacles || !obstacles.length) return '';
  let h = `<div class="chips">`;
  obstacles.forEach((o, i) => {
    const t = OBSTACLE_TYPES.find(x => x.key === o.type) || OBSTACLE_TYPES[5];
    h += `<span class="chip"><b class="chip-num">${i + 1}</b>${t.emoji} ${esc(o.text || t.label)}</span>`;
  });
  return h + `</div>`;
}

/* ---------- Players ---------- */
function renderPlayers() {
  let html = `<div class="view-head">
    <div>
      <h1 class="view-title">Team</h1>
      <p class="view-desc">Wer spielt heute mit?</p>
    </div>
    <span class="tag">${state.players.length}</span>
  </div>`;

  if (state.players.length === 0) {
    html += emptyState('S', 'Noch keine Spieler', 'Fügt alle Mitspieler hinzu — jede Person bekommt eine eigene Farbe.', 'Ersten Spieler anlegen', 'editPlayer()');
    view.innerHTML = html; return;
  }
  state.players.forEach(p => {
    let total = 0, played = 0;
    state.courses.forEach(c => { const s = scoreFor(c.id, p.id); if (s > 0) { total += s; played++; } });
    html += `<div class="card row-between tap" onclick="editPlayer('${p.id}')">
      <div class="row grow" style="min-width:0">
        <div class="avatar" style="background:${p.color}">${esc(initials(p.name))}</div>
        <div class="grow">
          <div style="font-family:var(--font-display);font-size:18px;font-weight:400" class="truncate">${esc(p.name)}</div>
          <div class="mono small muted" style="letter-spacing:0.14em;text-transform:uppercase">${played ? `${total} Schläge · ${played} Kurse` : 'noch nicht gespielt'}</div>
        </div>
      </div>
      <span class="muted mono" style="font-size:18px">›</span>
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
    <h2 class="sheet-title">${p ? 'Spieler bearbeiten' : 'Neuer Spieler'}</h2>
    <p class="sheet-sub">Name · Farbe · speichern</p>
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
    if (col === chosen) dot.classList.add('on');
    dot.addEventListener('click', () => {
      chosen = col;
      colorBox.querySelectorAll('.type-opt').forEach(d => d.classList.toggle('on', d === dot));
    });
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
    state.rounds.forEach(r => {
      r.playerIds = r.playerIds.filter(id => id !== p.id);
      Object.values(r.scores).forEach(s => delete s[p.id]);
    });
    save(); closeSheet(); render(); toast('Spieler gelöscht');
  });
  openSheet(box);
  setTimeout(() => $('#pName', box).focus(), 250);
}

function editCourse(id) {
  const c = id ? state.courses.find(x => x.id === id) : null;
  const draft = {
    id: c ? c.id : 'draft',
    startPos: c && c.startPos ? { ...c.startPos } : null,
    endPos: c && c.endPos ? { ...c.endPos } : null,
    obstacles: c ? c.obstacles.map(o => ({ ...o })) : [],
  };
  const colorIdx = c ? state.courses.indexOf(c) : state.courses.length;

  const box = el(`<div>
    <h2 class="sheet-title">${c ? 'Kurs bearbeiten' : 'Neuer Kurs'}</h2>
    <p class="sheet-sub">Name · Par · Route auf 3D-Karte platzieren</p>
    <label class="field"><span>Name</span>
      <input type="text" id="cName" placeholder="Bahn 1 – Über die Hütte" value="${c ? esc(c.name) : ''}"></label>
    <div class="row" style="gap:10px">
      <label class="field grow"><span>Start-Label</span>
        <input type="text" id="cStart" placeholder="Terrasse" value="${c ? esc(c.start || '') : ''}"></label>
      <label class="field grow"><span>Ziel-Label</span>
        <input type="text" id="cEnd" placeholder="Brunnen" value="${c ? esc(c.end || '') : ''}"></label>
    </div>
    <div class="row" style="gap:10px">
      <label class="field grow"><span>Par</span>
        <input type="number" id="cPar" inputmode="numeric" min="1" placeholder="3" value="${c ? (c.par || '') : ''}"></label>
      <label class="field grow"><span>Höhe (optional)</span>
        <input type="text" id="cElev" placeholder="+8 m" value="${c ? esc(c.elevation || '') : ''}"></label>
    </div>

    <div class="section-label">3D-Route</div>
    <div class="card" style="margin-bottom:12px;padding:14px">
      <div id="sheetSequence" style="margin-bottom:10px"></div>
      <p class="mono small muted" id="placeStatus" style="letter-spacing:0.12em;text-transform:uppercase;margin:2px 0 12px"></p>
      <button class="btn btn-primary btn-block" id="cPlace">📍 3D-Editor öffnen</button>
    </div>

    <div class="divider"></div>
    <button class="btn btn-primary btn-block" id="cSave">Kurs speichern</button>
    ${c ? `<button class="btn btn-danger btn-block" id="cDel" style="margin-top:10px">Kurs löschen</button>` : ''}
  </div>`);

  function refreshSheetSequence() {
    const seq = $('#sheetSequence', box);
    seq.innerHTML = renderSequenceStrip(draft);
    const s = $('#placeStatus', box);
    const placedObs = draft.obstacles.filter(o => o.pos).length;
    s.textContent = `${draft.startPos ? '🚩 ✓' : '🚩 fehlt'} · ${draft.obstacles.length} Hindernisse (${placedObs} verortet) · ${draft.endPos ? '🏁 ✓' : '🏁 fehlt'}`;
  }

  const editorApi = {
    redraw: () => drawDraft(draft, colorIdx),
    notifyChange: () => refreshSheetSequence(),
    onExitPlacement: () => { $('#sheet').hidden = false; document.body.classList.add('sheet-open'); refreshSheetSequence(); },
  };

  $('#cPlace', box).addEventListener('click', () => {
    $('#sheet').hidden = true;
    document.body.classList.remove('sheet-open');
    drawDraft(draft, colorIdx);
    if (hasRoute(draft)) focusCourse(draft, 600);
    enterPlacement(draft, editorApi);
  });

  $('#cSave', box).addEventListener('click', () => {
    const name = $('#cName', box).value.trim();
    if (!name) { toast('Bitte einen Kursnamen eingeben'); return; }
    const data = {
      name,
      start: $('#cStart', box).value.trim(),
      end: $('#cEnd', box).value.trim(),
      par: Math.max(0, parseInt($('#cPar', box).value, 10) || 0),
      elevation: $('#cElev', box).value.trim(),
      obstacles: draft.obstacles,
      startPos: draft.startPos,
      endPos: draft.endPos,
    };
    if (c) Object.assign(c, data);
    else state.courses.push({ id: uid(), ...data });
    save(); clearDraft(); closeSheet(); rebuildAllRoutes(); render();
    toast(c ? 'Kurs gespeichert' : 'Kurs erstellt');
  });
  if (c) $('#cDel', box).addEventListener('click', () => {
    if (!confirm(`Kurs "${c.name}" löschen?`)) return;
    state.courses = state.courses.filter(x => x.id !== c.id);
    state.rounds.forEach(r => {
      r.courseIds = (r.courseIds || []).filter(id => id !== c.id);
      delete r.scores[c.id];
    });
    save(); clearDraft(); closeSheet(); rebuildAllRoutes(); render();
    toast('Kurs gelöscht');
  });

  refreshSheetSequence();
  drawDraft(draft, colorIdx);
  openSheet(box);
}

/* Sequence strip (used in edit sheet and play view). */
function renderSequenceStrip(course) {
  const parts = [];
  parts.push(`<span class="seq-node anchor">🚩 Start</span>`);
  (course.obstacles || []).forEach((o, i) => {
    const t = OBSTACLE_TYPES.find(x => x.key === o.type) || OBSTACLE_TYPES[5];
    parts.push(`<span class="seq-arrow">›</span>`);
    parts.push(`<span class="seq-node"><b>${i + 1}</b>${t.emoji} ${esc(o.text || t.label)}</span>`);
  });
  parts.push(`<span class="seq-arrow">›</span>`);
  parts.push(`<span class="seq-node end">🏁 Ziel</span>`);
  return `<div class="seq-strip">${parts.join('')}</div>`;
}

/* ============================================================
   Utility UI
   ============================================================ */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1900);
}

function openSheet(html) {
  $('#sheetBody').innerHTML = '';
  const wrap = typeof html === 'string' ? el(`<div>${html}</div>`) : html;
  $('#sheetBody').appendChild(wrap);
  $('#sheet').hidden = false;
  document.body.classList.add('sheet-open');
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheetBody').innerHTML = '';
  document.body.classList.remove('sheet-open');
  clearDraft();
}
$('#sheet').addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) closeSheet(); });

function emptyState(emojiOrGlyph, title, text, btnLabel, onclick) {
  return `<div class="card"><div class="empty">
    <span class="empty-emoji">${emojiOrGlyph}</span>
    <h3>${title}</h3><p>${text}</p>
    <button class="btn btn-primary" onclick="${onclick}">${btnLabel}</button>
  </div></div>`;
}

function go(tab) { state.tab = tab; save(); render(); }
function nextCourse() {
  const r = activeRound();
  const courses = r ? roundCourses(r) : state.courses;
  const idx = courses.findIndex(c => c.id === state.activeCourseId);
  if (idx >= 0 && idx < courses.length - 1) {
    state.activeCourseId = courses[idx + 1].id;
    save(); render();
  }
}
function resetScores() {
  const r = activeRound(); if (!r) return;
  if (!confirm('Alle Schläge der laufenden Runde zurücksetzen?')) return;
  r.scores = {}; save(); render(); toast('Zurückgesetzt');
}

/* Menu */
function openMenu() {
  const box = el(`<div>
    <h2 class="sheet-title">Menü</h2>
    <p class="sheet-sub">Daten · Turnier · Ansicht</p>
    <button class="btn btn-primary btn-block" id="mNew">＋ Neues Spiel starten</button>
    <button class="btn btn-block" id="mCam" style="margin-top:10px">◎ Kamera zurücksetzen</button>
    <button class="btn btn-block" id="mExport" style="margin-top:10px">↓ Backup exportieren</button>
    <button class="btn btn-block" id="mImport" style="margin-top:10px">↑ Backup importieren</button>
    <button class="btn btn-danger btn-block" id="mWipe" style="margin-top:10px">✕ Alles löschen</button>
    <p class="mono small muted" style="text-align:center;margin-top:22px;letter-spacing:0.16em;text-transform:uppercase">Spikegolf · GKBS · Obiralm · ${syncEnabled() ? 'cloud sync' : 'offline'}</p>
  </div>`);
  $('#mNew', box).addEventListener('click', () => { closeSheet(); newRound(); });
  $('#mCam', box).addEventListener('click', () => { closeSheet(); resetCamera(); });
  $('#mExport', box).addEventListener('click', exportData);
  $('#mImport', box).addEventListener('click', importData);
  $('#mWipe', box).addEventListener('click', () => {
    if (!confirm('Wirklich ALLE Spieler, Kurse und Schläge löschen?')) return;
    state = defaultState(); save(); closeSheet(); rebuildAllRoutes(); render(); toast('Alles gelöscht');
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
        save(); closeSheet(); rebuildAllRoutes(); render(); toast('Daten importiert');
      } catch (e) { toast('Import fehlgeschlagen'); }
    };
    r.readAsText(f);
  });
  inp.click();
}
function resetCamera() {
  animateCamera(
    new THREE.Vector3(scene3.center.x + scene3.radius * 1.2, scene3.center.y + scene3.radius * 1.4, scene3.center.z + scene3.radius * 1.4),
    scene3.center.clone(), 800
  );
}

Object.assign(window, {
  go, nextCourse, resetScores, editPlayer, editCourse, playCourse, setPlaySub,
  pickAllPlayers, pickAllCourses, endRound, resumeRound, deleteRound,
  finishRound, reopenRound, newRound,
  selectCourse, deselectCourse,
});

/* ============================================================
   Boot
   ============================================================ */
$$('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.tab)));
$('#menuBtn').addEventListener('click', openMenu);
$('#camReset').addEventListener('click', resetCamera);

initScene();
loadTerrain().catch(() => {}).finally(() => { render(); });

// Cloud sync (Supabase). Runs only when config.js has URL + key.
// Silent if unconfigured — app stays local-only.
(async () => {
  if (!syncEnabled()) return;
  try {
    const { enabled, initialData } = await initSync({ applyRemote: applyRemoteState });
    if (!enabled) return;
    const remoteHasContent = initialData && (
      (Array.isArray(initialData.players) && initialData.players.length) ||
      (Array.isArray(initialData.courses) && initialData.courses.length) ||
      (Array.isArray(initialData.rounds) && initialData.rounds.length)
    );
    if (remoteHasContent) {
      applyRemoteState(initialData);
    } else {
      // Remote is fresh — seed it with our local snapshot right away.
      await flushState(state);
    }
    // Flush pending writes on suspend so we don't lose the last edit.
    const flush = () => flushState(state);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
  } catch (e) { console.warn('sync init failed', e); }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
