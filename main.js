import * as THREE from 'three';

// --- Сцена ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8a9a8a);
scene.fog = new THREE.Fog(0x8a9a8a, 10, 80);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 1.7, 0);
camera.rotation.order = 'YXZ';
scene.add(camera); // нужно, чтобы оружие в руках было видно

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const hemi = new THREE.HemisphereLight(0xffffff, 0x445544, 1.2);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(20, 40, 10);
scene.add(sun);

// --- Мир ---
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x5a6b45 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Столкновения: colliders - плоские коробки (вид сверху), blockers - то, что останавливает пули
const colliders = [];
const blockers = [];

const box = (w, h, d, color, x, y, z, solid = false) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  m.position.set(x, y, z);
  scene.add(m);
  if (solid) {
    colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
    blockers.push(m);
  }
  return m;
};

// Выталкивает позицию из всех препятствий (r - радиус тела)
function resolveCollisions(pos, r) {
  for (const c of colliders) {
    const px = Math.max(c.minX, Math.min(pos.x, c.maxX));
    const pz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
    const dx = pos.x - px, dz = pos.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 0) {
      const d = Math.sqrt(d2), k = (r - d) / d;
      pos.x += dx * k;
      pos.z += dz * k;
    } else {
      // центр внутри коробки: выталкиваем через ближайшую сторону
      const left = pos.x - c.minX, right = c.maxX - pos.x, up = pos.z - c.minZ, down = c.maxZ - pos.z;
      const m = Math.min(left, right, up, down);
      if (m === left) pos.x = c.minX - r;
      else if (m === right) pos.x = c.maxX + r;
      else if (m === up) pos.z = c.minZ - r;
      else pos.z = c.maxZ + r;
    }
  }
}

// Деревья (ствол твёрдый, крона нет)
const trees = []; // деревья, которые можно рубить
for (let i = 0; i < 150; i++) {
  const x = (Math.random() - 0.5) * 300, z = (Math.random() - 0.5) * 300;
  if (Math.abs(x) < 8 && Math.abs(z) < 8) continue;
  const trunk = box(0.6, 3, 0.6, 0x5b3a1e, x, 1.5, z, true);
  const collider = colliders[colliders.length - 1];
  const crown = box(3, 2.5, 3, 0x2f5a2a, x, 4, z);
  trees.push({ trunk, crown, collider, hp: 4 });
}

// Дома: 4 стены, дверь с южной стороны (+Z), крыша
const housePositions = [];
for (let i = 0; i < 8; i++) {
  const x = (Math.random() - 0.5) * 200, z = (Math.random() - 0.5) * 200;
  if (Math.abs(x) < 15 && Math.abs(z) < 15) continue;
  const wall = 0x8a8074;
  box(8, 4, 0.4, wall, x, 2, z - 3.8, true);          // северная стена
  box(0.4, 4, 8, wall, x - 3.8, 2, z, true);          // западная стена
  box(0.4, 4, 8, wall, x + 3.8, 2, z, true);          // восточная стена
  box(3, 4, 0.4, wall, x - 2.5, 2, z + 3.8, true);    // южная стена, левая часть
  box(3, 4, 0.4, wall, x + 2.5, 2, z + 3.8, true);    // южная стена, правая часть
  box(9, 0.6, 9, 0x4a3a35, x, 4.3, z, false);         // крыша
  blockers.push(scene.children[scene.children.length - 1]);
  housePositions.push({ x, z });
}

// --- Зомби ---
const zombies = [];
function spawnZombie() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.4), new THREE.MeshStandardMaterial({ color: 0x3a4a6a }));
  body.position.y = 1.2;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x6b8f5a }));
  head.position.y = 2.05;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.35), new THREE.MeshStandardMaterial({ color: 0x2a2a2a }));
  legs.position.y = 0.3;
  g.add(body, head, legs);
  const a = Math.random() * Math.PI * 2, r = 25 + Math.random() * 40;
  g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
  resolveCollisions(g.position, 0.6);
  scene.add(g);
  zombies.push({ mesh: g, hp: 3, cooldown: 0 });
}
for (let i = 0; i < 12; i++) spawnZombie();

// --- Игрок ---
let health = 100, hunger = 100, thirst = 100;
let yaw = 0, pitch = 0, kills = 0;
let ammo = 12, reserve = 24, reloading = false;
const keys = {};

// Инвентарь: сколько предметов у игрока
const inv = { food: 0, water: 0, medkit: 0, wood: 0, scrap: 0 };

// Пистолет в руках (прикреплён к камере)
const gun = new THREE.Group();
const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.4), new THREE.MeshStandardMaterial({ color: 0x222222 }));
const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.1), new THREE.MeshStandardMaterial({ color: 0x4a2f1a }));
grip.position.set(0, -0.12, 0.12);
gun.add(barrel, grip);
gun.position.set(0.3, -0.25, -0.6);
camera.add(gun);

// Фонарик (клавиша F)
const flash = new THREE.SpotLight(0xfff2cc, 0, 45, Math.PI / 6, 0.4, 1);
flash.position.set(0, 0, 0);
flash.target.position.set(0, 0, -5);
camera.add(flash, flash.target);
let flashOn = false;

// Время суток: сутки длятся 4 минуты реального времени
let gameHour = 8;
const dayColor = new THREE.Color(0x8a9a8a);
const nightColor = new THREE.Color(0x04060a);
let daylight = 1;

// Патроны на земле
const ammoBoxes = [];
function spawnAmmoBox(x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.35), new THREE.MeshStandardMaterial({ color: 0xd4a017 }));
  m.position.set(x ?? (Math.random() - 0.5) * 200, 0.15, z ?? (Math.random() - 0.5) * 200);
  scene.add(m);
  ammoBoxes.push(m);
}
for (let i = 0; i < 15; i++) spawnAmmoBox();

// Предметы на земле: еда (коричневая), вода (синяя), аптечка (белая)
const itemColors = { food: 0xb5651d, water: 0x3a8fd6, medkit: 0xf2f2f2, scrap: 0x8a8a92 };
const items = [];
function spawnItem(type, x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: itemColors[type] }));
  m.position.set(x ?? (Math.random() - 0.5) * 200, 0.3, z ?? (Math.random() - 0.5) * 200);
  scene.add(m);
  items.push({ mesh: m, type });
}
for (let i = 0; i < 10; i++) { spawnItem('food'); spawnItem('water'); }
for (let i = 0; i < 5; i++) spawnItem('medkit');
for (let i = 0; i < 20; i++) spawnItem('scrap'); // лом для крафта

// Лут внутри каждого дома
for (const h of housePositions) {
  spawnItem('medkit', h.x - 2, h.z - 2);
  spawnItem('food', h.x + 2, h.z - 2);
  spawnItem('water', h.x, h.z - 2.5);
  spawnAmmoBox(h.x + 2, h.z + 1);
  spawnItem('scrap', h.x - 2.5, h.z + 1);
  spawnItem('scrap', h.x + 2.5, h.z - 1);
}

// HUD
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:10px;left:10px;color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;white-space:pre';
document.body.appendChild(hud);
const hotbar = document.createElement('div');
hotbar.style.cssText = 'position:fixed;bottom:15px;left:50%;transform:translateX(-50%);color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;background:rgba(0,0,0,0.4);padding:8px 16px;border-radius:6px;white-space:pre;text-align:center';
document.body.appendChild(hotbar);
const cross = document.createElement('div');
cross.textContent = '+';
cross.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font:24px monospace';
document.body.appendChild(cross);

// Использование предметов
function useItem(type) {
  if (health <= 0 || inv[type] <= 0) return;
  if (type === 'food' && hunger < 100) { hunger = Math.min(100, hunger + 30); inv.food--; }
  if (type === 'water' && thirst < 100) { thirst = Math.min(100, thirst + 30); inv.water--; }
  if (type === 'medkit' && health < 100) { health = Math.min(100, health + 40); inv.medkit--; }
}


// --- Строительство и крафт ---
const notice = document.createElement('div');
notice.style.cssText = 'position:fixed;top:30%;left:50%;transform:translateX(-50%);color:#ffe9a0;font:22px monospace;text-shadow:1px 1px 3px #000';
document.body.appendChild(notice);
let noticeT = 0;
function notify(t) { notice.textContent = t; noticeT = 2; }

const pieces = {
  wall: { name: 'Стена', cost: 4, color: 0x8b6b3e },
  roof: { name: 'Крыша', cost: 3, color: 0x6b4f2e },
  fire: { name: 'Костёр', cost: 5, color: 0xff7a2a },
};
const pieceKeys = ['wall', 'roof', 'fire'];
const MAX_FIRES = 4;
let buildMode = false, selPiece = 'wall', rot = 0, chopCd = 0;
const built = [];        // все постройки игрока
const builtMeshes = [];

// Призрак: показывает, куда встанет постройка
const ghost = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x44ff44, transparent: true, opacity: 0.4 })
);
ghost.visible = false;
scene.add(ghost);

// Размеры детали: ширина, высота, глубина, высота центра
function pieceGeometry(type, r) {
  if (type === 'wall') return r === 0 ? [2, 3, 0.3, 1.5] : [0.3, 3, 2, 1.5];
  if (type === 'roof') return [2, 0.2, 2, 3.1];
  return [0.8, 0.4, 0.8, 0.2];
}

// Привязка к сетке, чтобы стены стыковались
function targetPos() {
  const px = camera.position.x - Math.sin(yaw) * 4;
  const pz = camera.position.z - Math.cos(yaw) * 4;
  if (selPiece === 'wall') {
    return rot === 0
      ? [2 * Math.floor(px / 2) + 1, 2 * Math.round(pz / 2)]
      : [2 * Math.round(px / 2), 2 * Math.floor(pz / 2) + 1];
  }
  if (selPiece === 'roof') return [2 * Math.floor(px / 2) + 1, 2 * Math.floor(pz / 2) + 1];
  return [Math.round(px * 2) / 2, Math.round(pz * 2) / 2];
}

function placePiece() {
  if (health <= 0) return;
  const p = pieces[selPiece];
  const [x, z] = targetPos();
  const [w, h, d, y] = pieceGeometry(selPiece, rot);
  const key = `${selPiece}:${selPiece === 'wall' ? rot : 0}:${x}:${z}`;
  if (built.some(b => b.key === key)) return notify('Тут уже занято');
  if (inv.wood < p.cost) return notify(`Нужно дерева: ${p.cost}`);
  if (selPiece === 'fire' && built.filter(b => b.type === 'fire').length >= MAX_FIRES) return notify('Костров не больше 4');
  inv.wood -= p.cost;

  const mat = new THREE.MeshStandardMaterial({ color: p.color });
  if (selPiece === 'fire') { mat.emissive = new THREE.Color(0xff5500); mat.emissiveIntensity = 1; }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  scene.add(mesh);

  const b = { key, type: selPiece, mesh, collider: null, light: null };
  if (selPiece === 'wall') {
    b.collider = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
    colliders.push(b.collider);
    blockers.push(mesh);
  }
  if (selPiece === 'roof') blockers.push(mesh);
  if (selPiece === 'fire') {
    b.light = new THREE.PointLight(0xff8a3a, 8, 20, 1);
    b.light.position.set(x, 1, z);
    scene.add(b.light);
  }
  built.push(b);
  builtMeshes.push(mesh);
}

// Убрать постройку (V) - возвращается половина дерева
function removePiece() {
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hit = raycaster.intersectObjects(builtMeshes, false)[0];
  if (!hit || hit.distance > 6) return;
  const i = built.findIndex(b => b.mesh === hit.object);
  if (i < 0) return;
  const b = built[i];
  scene.remove(b.mesh);
  if (b.light) scene.remove(b.light);
  if (b.collider) colliders.splice(colliders.indexOf(b.collider), 1);
  const bi = blockers.indexOf(b.mesh);
  if (bi >= 0) blockers.splice(bi, 1);
  builtMeshes.splice(builtMeshes.indexOf(b.mesh), 1);
  built.splice(i, 1);
  inv.wood += Math.floor(pieces[b.type].cost / 2);
}

// Рубка дерева (E)
function chop() {
  if (health <= 0 || chopCd > 0) return;
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hit = raycaster.intersectObjects(trees.map(t => t.trunk), false)[0];
  if (!hit || hit.distance > 3.5) return notify('Подойди ближе и смотри на ствол дерева');
  chopCd = 0.4;
  const ti = trees.findIndex(t => t.trunk === hit.object);
  const t = trees[ti];
  t.hp--;
  inv.wood++;
  if (t.hp <= 0) {
    scene.remove(t.trunk);
    scene.remove(t.crown);
    colliders.splice(colliders.indexOf(t.collider), 1);
    blockers.splice(blockers.indexOf(t.trunk), 1);
    trees.splice(ti, 1);
    inv.wood += 3;
    notify('Дерево срублено, +3 дерева');
  }
}

// Крафт из лома
function craft(type) {
  if (health <= 0) return;
  if (type === 'ammo') {
    if (inv.scrap < 2) return notify('Нужно 2 лома');
    inv.scrap -= 2; reserve += 6; notify('Сделано: +6 патронов');
  }
  if (type === 'medkit') {
    if (inv.scrap < 4) return notify('Нужно 4 лома');
    inv.scrap -= 4; inv.medkit++; notify('Сделано: +1 аптечка');
  }
}

// Обновление каждый кадр: призрак, костры, подсказки
function updateBuild(dt) {
  noticeT -= dt;
  if (noticeT <= 0) notice.textContent = '';
  chopCd -= dt;
  gun.visible = !buildMode;
  ghost.visible = buildMode && health > 0;
  if (ghost.visible) {
    const [x, z] = targetPos();
    const [w, h, d, y] = pieceGeometry(selPiece, rot);
    ghost.scale.set(w, h, d);
    ghost.position.set(x, y, z);
    ghost.material.color.set(inv.wood >= pieces[selPiece].cost ? 0x44ff44 : 0xff4444);
  }
  for (const b of built) {
    if (b.type !== 'fire') continue;
    b.light.intensity = 7 + Math.random() * 2; // мерцание
    const near = Math.hypot(b.mesh.position.x - camera.position.x, b.mesh.position.z - camera.position.z) < 4;
    if (near && health > 0 && health < 100) health = Math.min(100, health + 1.5 * dt); // у костра лечишься
  }
}

// --- Меню с вкладками: Инвентарь / Крафт / Стройка (клавиша Tab) ---
let menuOpen = false, menuTab = 'inv';
const menu = document.createElement('div');
menu.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:none;align-items:center;justify-content:center;font:18px monospace;color:#fff;z-index:10';
document.body.appendChild(menu);

const btn = (label, act, on = true, active = false) =>
  `<button ${on ? `data-act="${act}"` : 'disabled'} style="font:inherit;color:#fff;padding:8px 14px;margin:2px;border:2px solid ${active ? '#c8e07a' : '#5a6b45'};border-radius:6px;background:${active ? '#3d4a2a' : '#2a3324'};cursor:${on ? 'pointer' : 'not-allowed'};opacity:${on ? 1 : 0.4}">${label}</button>`;
const row = (name, right) =>
  `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #3a4530"><span>${name}</span><span>${right}</span></div>`;
const bar = (label, v, color) =>
  `<div style="margin:4px 0">${label}: ${Math.ceil(v)}<div style="height:10px;background:#111;border-radius:5px"><div style="height:10px;width:${Math.max(0, Math.min(100, v))}%;background:${color};border-radius:5px"></div></div></div>`;

function renderMenu() {
  const tabs = [['inv', 'Инвентарь'], ['craft', 'Крафт'], ['build', 'Стройка']];
  let body = '';
  if (menuTab === 'inv') {
    body += bar('Здоровье', health, '#d64040') + bar('Еда', hunger, '#d19a3a') + bar('Вода', thirst, '#3a8fd6');
    body += '<div style="margin-top:12px"></div>';
    body += row('Еда', `x${inv.food} ` + btn('Съесть', 'use:food', inv.food > 0 && hunger < 100));
    body += row('Вода', `x${inv.water} ` + btn('Выпить', 'use:water', inv.water > 0 && thirst < 100));
    body += row('Аптечка', `x${inv.medkit} ` + btn('Лечиться', 'use:medkit', inv.medkit > 0 && health < 100));
    body += row('Дерево', `x${inv.wood}`);
    body += row('Лом', `x${inv.scrap}`);
    body += row('Патроны', `${ammo} в обойме, ${reserve} в запасе`);
  }
  if (menuTab === 'craft') {
    body += row('Патроны x6 <small>(2 лома)</small>', btn('Создать', 'craft:ammo', inv.scrap >= 2));
    body += row('Аптечка <small>(4 лома)</small>', btn('Создать', 'craft:medkit', inv.scrap >= 4));
    body += `<div style="margin-top:12px;opacity:.8">У тебя: лом x${inv.scrap}. Лом лежит на земле и в домах.</div>`;
  }
  if (menuTab === 'build') {
    for (const k of pieceKeys) {
      body += row(`${pieces[k].name} <small>(${pieces[k].cost} дерева)</small>`, btn('Строить', `build:${k}`, true));
    }
    body += `<div style="margin-top:12px;opacity:.8">У тебя: дерево x${inv.wood}. Дерево добывается рубкой деревьев (клавиша E).</div>`;
  }
  menu.innerHTML =
    `<div style="width:min(680px,92vw);background:#1d231c;border:2px solid #5a6b45;border-radius:10px;padding:18px">` +
    `<div style="margin-bottom:12px">${tabs.map(([id, n]) => btn(n, 'tab:' + id, true, menuTab === id)).join('')}</div>` +
    body +
    `<div style="margin-top:14px;opacity:.7;font-size:14px">[Tab] или [Esc] - закрыть меню. Игра на паузе.</div></div>`;
}

function toggleMenu(open) {
  if (health <= 0) return;
  menuOpen = open;
  menu.style.display = open ? 'flex' : 'none';
  if (open) {
    document.exitPointerLock();
    renderMenu();
  } else {
    try {
      const p = renderer.domElement.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (err) { /* клик по игре захватит мышь */ }
  }
}

menu.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const [act, arg] = t.dataset.act.split(':');
  if (act === 'tab') menuTab = arg;
  if (act === 'use') useItem(arg);
  if (act === 'craft') craft(arg);
  if (act === 'build') { selPiece = arg; buildMode = true; toggleMenu(false); return; }
  renderMenu();
});

// Управление
addEventListener('keydown', e => {
  if (e.code === 'Tab') { e.preventDefault(); toggleMenu(!menuOpen); return; }
  if (menuOpen) { if (e.code === 'Escape') toggleMenu(false); return; }
  keys[e.code] = true;
  if (e.code === 'KeyB') buildMode = !buildMode;
  if (buildMode) {
    if (e.code === 'Digit1') selPiece = 'wall';
    if (e.code === 'Digit2') selPiece = 'roof';
    if (e.code === 'Digit3') selPiece = 'fire';
    if (e.code === 'KeyQ') rot = 1 - rot;
    if (e.code === 'KeyV') removePiece();
  } else {
    if (e.code === 'Digit1') useItem('food');
    if (e.code === 'Digit2') useItem('water');
    if (e.code === 'Digit3') useItem('medkit');
    if (e.code === 'KeyZ') craft('ammo');
    if (e.code === 'KeyX') craft('medkit');
  }
  if (e.code === 'KeyE') chop();
  if (e.code === 'KeyF') { flashOn = !flashOn; flash.intensity = flashOn ? 25 : 0; }
});
addEventListener('keyup', e => keys[e.code] = false);
renderer.domElement.addEventListener('click', () => {
  if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
  else if (buildMode) placePiece();
  else attack();
});
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.002;
  pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.002));
});

// Перезарядка на клавишу R
addEventListener('keydown', e => {
  if (e.code !== 'KeyR' || menuOpen || reloading || ammo >= 12 || reserve <= 0) return;
  reloading = true;
  setTimeout(() => {
    const need = 12 - ammo, take = Math.min(need, reserve);
    ammo += take; reserve -= take; reloading = false;
  }, 1500);
});

// Стрельба (пули останавливаются о стены и деревья)
const raycaster = new THREE.Raycaster();
function attack() {
  if (health <= 0 || reloading || ammo <= 0) return;
  ammo--;
  gun.position.z += 0.1; // отдача

  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const zHits = raycaster.intersectObjects(zombies.map(z => z.mesh), true);
  if (!zHits.length) return;
  const wallHits = raycaster.intersectObjects(blockers, false);
  if (wallHits.length && wallHits[0].distance < zHits[0].distance) return; // пуля попала в стену

  const z = zombies.find(z => z.mesh === zHits[0].object.parent);
  if (z) z.hp -= zHits[0].point.y > 1.8 ? 2 : 1; // в голову урон x2
}

// --- Цикл ---
const clock = new THREE.Clock();
function loop() {
  const rawDt = clock.getDelta();
  const dt = menuOpen ? 0 : Math.min(rawDt, 0.1); // в меню игра на паузе

  // День и ночь
  gameHour = (gameHour + dt * 0.1) % 24;
  const ang = (gameHour - 6) / 24 * Math.PI * 2;
  daylight = Math.max(0, Math.min(1, (Math.sin(ang) + 0.2) / 0.6));
  sun.position.set(Math.cos(ang) * 40, Math.max(5, Math.sin(ang) * 40), 10);
  sun.intensity = 1.5 * daylight;
  hemi.intensity = 0.12 + 1.08 * daylight;
  scene.background.copy(nightColor).lerp(dayColor, daylight);
  scene.fog.color.copy(scene.background);
  scene.fog.far = 35 + 45 * daylight;

  if (health > 0) {
    const speed = (keys.ShiftLeft ? 8 : 4.5) * dt;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    if (keys.KeyW) camera.position.addScaledVector(fwd, speed);
    if (keys.KeyS) camera.position.addScaledVector(fwd, -speed);
    if (keys.KeyD) camera.position.addScaledVector(right, speed);
    if (keys.KeyA) camera.position.addScaledVector(right, -speed);
    resolveCollisions(camera.position, 0.4);

    // Голод и жажда
    hunger = Math.max(0, hunger - 0.4 * dt);
    thirst = Math.max(0, thirst - 0.6 * dt);
    if (hunger <= 0 || thirst <= 0) health -= 2 * dt;          // урон от голода/жажды
    else if (hunger > 70 && thirst > 70) health = Math.min(100, health + 0.5 * dt); // медленное лечение
  }
  camera.rotation.set(pitch, yaw, 0);
  updateBuild(dt);

  // Оружие возвращается на место после отдачи
  gun.position.z += (-0.6 - gun.position.z) * 12 * dt;

  // Подбор патронов
  for (let i = ammoBoxes.length - 1; i >= 0; i--) {
    const p = ammoBoxes[i].position;
    if (Math.hypot(p.x - camera.position.x, p.z - camera.position.z) < 1.5) {
      reserve += 12;
      scene.remove(ammoBoxes[i]);
      ammoBoxes.splice(i, 1);
      spawnAmmoBox();
    }
  }

  // Подбор еды, воды, аптечек
  for (let i = items.length - 1; i >= 0; i--) {
    items[i].mesh.rotation.y += dt; // предметы медленно вращаются
    const p = items[i].mesh.position;
    if (Math.hypot(p.x - camera.position.x, p.z - camera.position.z) < 1.5) {
      const type = items[i].type;
      inv[type]++;
      scene.remove(items[i].mesh);
      items.splice(i, 1);
      spawnItem(type);
    }
  }

  // Зомби
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    if (z.hp <= 0) { scene.remove(z.mesh); zombies.splice(i, 1); kills++; spawnZombie(); continue; }
    const to = camera.position.clone().sub(z.mesh.position).setY(0);
    const dist = to.length();
    if (dist < 35 && dist > 1.2) {
      to.normalize();
      z.mesh.position.addScaledVector(to, (2 + (1 - daylight) * 1.0) * dt); // ночью быстрее
      z.mesh.rotation.y = Math.atan2(to.x, to.z);
      resolveCollisions(z.mesh.position, 0.6);
    }
    z.cooldown -= dt;
    if (dist <= 1.5 && z.cooldown <= 0 && health > 0 && !menuOpen) { health -= 10; z.cooldown = 1; }
  }

  if (health <= 0) {
    health = 0;
    hud.textContent = `Ты умер. Убито: ${kills}. Нажми F5, чтобы начать заново`;
  } else {
    hud.textContent =
      `Здоровье: ${Math.ceil(health)}   Еда: ${Math.ceil(hunger)}   Вода: ${Math.ceil(thirst)}\n` +
      `Убито: ${kills}   Патроны: ${reloading ? 'перезарядка...' : ammo} / ${reserve}`;
  }
  const hh = String(Math.floor(gameHour)).padStart(2, '0');
  const mm = String(Math.floor((gameHour % 1) * 60)).padStart(2, '0');
  const line1 = buildMode
    ? 'СТРОЙКА: ' + pieceKeys.map((k, i) => `${selPiece === k ? '>' : ' '}[${i + 1}] ${pieces[k].name} (${pieces[k].cost} дер.)`).join('  ') + '\n[Q] поворот   [клик] поставить   [V] убрать   [B] выйти'
    : `[1] Еда x${inv.food}    [2] Вода x${inv.water}    [3] Аптечка x${inv.medkit}    [F] Фонарик ${flashOn ? 'вкл' : 'выкл'}    [Tab] Меню    ${hh}:${mm}`;
  hotbar.textContent = line1 + `\nДерево: ${inv.wood}   Лом: ${inv.scrap}   [E] рубить   [B] строить`;

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
