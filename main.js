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
const MAG = 7;                       // патронов в магазине
const RELOAD = 2.4;                  // длительность перезарядки, сек
let ammo = MAG, reserve = 21, reloading = false;
let rT = 0, loaded = false, lockAtStart = false, lock = false;
let cool = 0, recoil = 0, kick = 0, slidePulse = 0, mzT = 0, gunT = 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const keys = {};

// --- Инвентарь: 35 слотов (0-4 быстрые слоты игрока, 5-34 рюкзак) ---
const HOTBAR = 5, SLOTS = 35;
const ITEMS = {
  food:   { name: 'Еда',     color: 0xb5651d, stack: 6,  use: 'eat' },
  water:  { name: 'Вода',    color: 0x3a8fd6, stack: 6,  use: 'drink' },
  medkit: { name: 'Аптечка', color: 0xf2f2f2, stack: 3,  use: 'heal' },
  wood:   { name: 'Дерево',  color: 0x8b6b3e, stack: 20 },
  scrap:  { name: 'Лом',     color: 0x8a8a92, stack: 20 },
};
const slots = new Array(SLOTS).fill(null); // каждый слот: null или { type, n }
const hex = c => '#' + c.toString(16).padStart(6, '0');

function countOf(type) {
  let n = 0;
  for (const s of slots) if (s && s.type === type) n += s.n;
  return n;
}
function freeRoom(type) { // сколько таких предметов ещё поместится
  const st = ITEMS[type].stack;
  let room = 0;
  for (const s of slots) { if (!s) room += st; else if (s.type === type) room += st - s.n; }
  return room;
}
function addItem(type, n = 1) { // возвращает, сколько не поместилось
  const st = ITEMS[type].stack;
  for (let i = 0; i < SLOTS && n > 0; i++) {
    const s = slots[i];
    if (s && s.type === type && s.n < st) { const t = Math.min(st - s.n, n); s.n += t; n -= t; }
  }
  // съедобное и аптечки идут в быстрые слоты, ресурсы - в рюкзак
  const order = [];
  if (ITEMS[type].use) for (let i = 0; i < SLOTS; i++) order.push(i);
  else { for (let i = HOTBAR; i < SLOTS; i++) order.push(i); for (let i = 0; i < HOTBAR; i++) order.push(i); }
  for (const i of order) {
    if (n <= 0) break;
    if (!slots[i]) { const t = Math.min(st, n); slots[i] = { type, n: t }; n -= t; }
  }
  return n;
}
function takeItem(type, n) {
  if (countOf(type) < n) return false;
  for (let i = SLOTS - 1; i >= 0 && n > 0; i--) {
    const s = slots[i];
    if (s && s.type === type) { const t = Math.min(s.n, n); s.n -= t; n -= t; if (s.n <= 0) slots[i] = null; }
  }
  return true;
}
function moveSlot(a, b) { // переложить или объединить
  const A = slots[a], B = slots[b];
  if (!A) return;
  if (B && B.type === A.type) {
    const t = Math.min(ITEMS[A.type].stack - B.n, A.n);
    B.n += t; A.n -= t;
    if (A.n <= 0) slots[a] = null;
  } else { slots[a] = B; slots[b] = A; }
}
function useSlot(i) {
  const s = slots[i];
  if (!s || health <= 0) return false;
  const u = ITEMS[s.type].use;
  if (u === 'eat' && hunger < 100) hunger = Math.min(100, hunger + 30);
  else if (u === 'drink' && thirst < 100) thirst = Math.min(100, thirst + 30);
  else if (u === 'heal' && health < 100) health = Math.min(100, health + 40);
  else return false;
  s.n--;
  if (s.n <= 0) slots[i] = null;
  return true;
}
// Один слот в виде HTML (для панели внизу и для меню)
function slotHtml(i, picked, clickable) {
  const s = slots[i], def = s && ITEMS[s.type];
  const border = picked ? '#c8e07a' : (i < HOTBAR ? '#8a9a5a' : '#4a5a3a');
  return `<div ${clickable ? `data-slot="${i}"` : ''} title="${def ? def.name : ''}" style="position:relative;width:56px;height:56px;box-sizing:border-box;border:2px solid ${border};background:${picked ? '#3d4a2a' : 'rgba(20,26,18,.85)'};border-radius:6px;cursor:${clickable ? 'pointer' : 'default'};flex:none">` +
    (i < HOTBAR ? `<div style="position:absolute;left:4px;top:1px;font-size:12px;opacity:.8">${i + 1}</div>` : '') +
    (s ? `<div style="position:absolute;left:50%;top:44%;width:26px;height:26px;transform:translate(-50%,-50%);background:${hex(def.color)};border:2px solid rgba(255,255,255,.55);border-radius:5px"></div>` +
         `<div style="position:absolute;right:4px;top:1px;font-size:14px">${s.n > 1 ? s.n : ''}</div>` +
         `<div style="position:absolute;left:0;right:0;bottom:2px;text-align:center;font-size:10px;opacity:.85">${def.name}</div>` : '') +
    `</div>`;
}
// Стартовые припасы
addItem('food', 2); addItem('water', 2); addItem('medkit', 1);

// Модель пистолета DeadZone. Оси: ствол смотрит в -Z, вверх +Y.
function createPistol(opts) {
  opts = opts || {};
  const root = new THREE.Group();
  const slideGroup = new THREE.Group();   // затвор (отъезжает при выстреле)
  const magGroup = new THREE.Group();     // магазин (выезжает при перезарядке)
  root.add(slideGroup, magGroup);

  const mat = (color, rough, metal) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, flatShading: true });
  const M = {
    slide: mat(0x2d3136, 0.38, 0.65),
    frame: mat(0x26292d, 0.85, 0.05),
    grip: mat(0x5a3a20, 0.9, 0.0),
    metal: mat(0x8a8f96, 0.35, 0.8),
    black: mat(0x0d0e10, 0.9, 0.0),
    plate: mat(0x50555b, 0.7, 0.3),
    white: new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }),
    skin: mat(0xd9a67a, 0.9, 0.0),
    sleeve: mat(0x3a4a6a, 0.95, 0.0),
  };

  // Плоский профиль (u вперёд, v вверх) выдавливается на ширину width
  function extrude(pts, width, m, holes, bevel) {
    bevel = bevel === undefined ? 0.003 : bevel;
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
    (holes || []).forEach(h => shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1])))));
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: width, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, steps: 1,
    });
    g.translate(0, 0, -width / 2);
    g.rotateY(Math.PI / 2); // u -> -Z (вперёд), глубина -> X (ширина)
    return new THREE.Mesh(g, m);
  }
  const box = (w, h, d, m, x, y, z, parent) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    (parent || root).add(b);
    return b;
  };
  const cyl = (r, len, m, x, y, z, parent) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), m);
    c.rotation.x = Math.PI / 2;
    c.position.set(x, y, z);
    (parent || root).add(c);
    return c;
  };

  // --- Рама с рукоятью и скобой курка ---
  root.add(extrude(
    [[.17, 0], [.17, -.03], [.085, -.03], [.085, -.072], [.06, -.085], [.02, -.085],
     [-.045, -.22], [-.145, -.22], [-.115, -.02], [-.17, 0]],
    0.058, M.frame,
    [[[.025, -.034], [.025, -.06], [.058, -.06], [.058, -.034]]]
  ));
  // Накладки рукояти
  root.add(extrude([[-.113, -.03], [0, -.03], [0, -.075], [-.038, -.21], [-.14, -.21]], 0.06, M.grip));
  // Курок
  const trigger = box(.01, .03, .012, M.metal, 0, -.047, -.04);
  trigger.rotation.x = -0.2;
  // Фиксатор затвора
  box(.006, .012, .045, M.metal, -.038, -.006, .02);

  // --- Ствол (виден, когда затвор отъезжает) ---
  cyl(.0105, .18, M.metal, 0, .026, -.11);
  cyl(.006, .004, M.black, 0, .026, -.2015);

  // --- Затвор ---
  slideGroup.add(extrude(
    [[-.17, -.004], [-.17, .05], [-.155, .056], [.175, .056], [.19, .046], [.19, -.004]],
    0.068, M.slide
  ));
  for (let i = 0; i < 6; i++) box(.076, .04, .005, M.black, 0, .028, .155 - i * .012, slideGroup); // насечки
  box(.004, .02, .07, M.black, .038, .034, .01, slideGroup);                                       // окно выброса
  box(.008, .014, .012, M.slide, 0, .063, -.172, slideGroup);                                      // мушка
  box(.004, .004, .002, M.white, 0, .064, -.179, slideGroup);
  [-1, 1].forEach(s => {                                                                            // целик
    box(.013, .013, .012, M.slide, s * .011, .063, .155, slideGroup);
    box(.004, .004, .002, M.white, s * .011, .064, .1615, slideGroup);
  });

  // --- Магазин ---
  box(.05, .19, .085, M.black, 0, -.125, .095, magGroup);
  box(.06, .014, .11, M.plate, 0, -.227, .098, magGroup);

  // --- Дульный срез для вспышки ---
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, .026, -.21);
  root.add(muzzle);

  // --- Рука (правая) с рукавом ---
  const hand = new THREE.Group();
  root.add(hand);
  const tilt = -0.15;
  const palm = box(.076, .105, .04, M.skin, 0, -.12, .158, hand); palm.rotation.x = tilt;
  const fingers = box(.07, .085, .035, M.skin, 0, -.15, -.008, hand); fingers.rotation.x = tilt;
  const side = box(.02, .085, .17, M.skin, .04, -.14, .075, hand); side.rotation.x = tilt;
  box(.02, .02, .09, M.skin, -.04, -.045, .0, hand);          // большой палец
  box(.018, .018, .075, M.skin, .036, -.048, -.045, hand);    // указательный вдоль рамы
  box(.06, .03, .05, M.skin, 0, -.03, .14, hand);             // перепонка между пальцами
  const dir = new THREE.Vector3(.3, -.7, .65).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  const wrist = new THREE.Vector3(.005, -.185, .175);
  [[.2, 0, .085, M.skin], [.8, .2, .12, M.sleeve]].forEach(([len, off, w, m]) => {
    const c = wrist.clone().addScaledVector(dir, off + len / 2);
    const b = box(w, w, len, m, c.x, c.y, c.z, hand);
    b.quaternion.copy(q);
  });

  // --- Левая рука (появляется только при перезарядке) ---
  const lhand = new THREE.Group();
  root.add(lhand);
  box(.09, .03, .12, M.skin, 0, 0, 0, lhand);              // ладонь (снизу под магазином)
  box(.09, .06, .025, M.skin, 0, .035, -.065, lhand);      // пальцы спереди
  box(.02, .05, .07, M.skin, .05, .02, .0, lhand);         // большой палец
  const ldir = new THREE.Vector3(-.45, -.7, .55).normalize();
  const lq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), ldir);
  const lwrist = new THREE.Vector3(0, -.02, .07);
  [[.18, 0, .08, M.skin], [.8, .18, .115, M.sleeve]].forEach(([len, off, w, m]) => {
    const c = lwrist.clone().addScaledVector(ldir, off + len / 2);
    const b = box(w, w, len, m, c.x, c.y, c.z, lhand);
    b.quaternion.copy(lq);
  });
  lhand.position.set(-.3, -.6, .35);
  lhand.visible = false;

  return { root, slideGroup, magGroup, muzzle, hand, lhand };
}

// Пистолет в руках (модель из кода, прикреплена к камере)
const gp = createPistol();
const gun = gp.root;
gun.position.set(0.24, -0.2, -0.5);
camera.add(gun);
const magBaseY = gp.magGroup.position.y;

// Вспышка выстрела
const mzMat = new THREE.MeshBasicMaterial({ color: 0xffe6a0 });
const mzG = new THREE.Group();
mzG.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), mzMat));
const mzA = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.012, 0.012), mzMat);
const mzB = mzA.clone(); mzB.rotation.z = Math.PI / 2;
mzG.add(mzA, mzB);
mzG.visible = false;
gp.muzzle.add(mzG);
const mzLight = new THREE.PointLight(0xffb060, 0, 4, 2);
gp.muzzle.add(mzLight);

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

// --- Кучи ресурсов: брёвна (дерево) и куча железа (лом). Подойди, смотри на кучу, жми E: берётся по 1 ---
const piles = [];
const barkMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 1, flatShading: true });
const endMat = new THREE.MeshStandardMaterial({ color: 0xd2ab6f, roughness: 1, flatShading: true });
const metalMat = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.5, flatShading: true });

function makeLogs() { // 3 бревна: два внизу, одно сверху
  const group = new THREE.Group();
  const spots = [[0.0, 0.39, 0.0, 0.05], [-0.04, 0.14, 0.15, -0.08], [0.03, 0.14, -0.15, 0.06]];
  const parts = spots.map(([x, y, z, ry]) => {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.05, 8), [barkMat, endMat, endMat]);
    log.position.set(x, y, z);
    log.rotation.set(0, ry, Math.PI / 2); // кладём бревно на бок
    group.add(log);
    return log;
  });
  return { group, parts }; // порядок: верхнее бревно забирается первым
}

function makeScrap() { // 3 детали: ржавая труба, балка, лист металла
  const group = new THREE.Group();
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.42), metalMat(0x7d838a));
  plate.position.set(0, 0.03, 0); plate.rotation.y = 0.5;
  const beam = new THREE.Group();
  beam.add(new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.08, 0.1), metalMat(0x5b6068)));
  const flange = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.02, 0.2), metalMat(0x5b6068));
  flange.position.y = -0.04; beam.add(flange);
  beam.position.set(0.05, 0.1, 0.08); beam.rotation.set(0, -0.6, 0.08);
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.65, 8), metalMat(0x8a5a3a));
  pipe.position.set(-0.05, 0.19, -0.05); pipe.rotation.set(0, 0.9, Math.PI / 2);
  group.add(plate, beam, pipe);
  return { group, parts: [pipe, beam, plate] };
}

function spawnPile(type, x, z) {
  if (x === undefined) { // случайное место, не внутри деревьев и домов
    for (let tries = 0; tries < 30; tries++) {
      x = (Math.random() - 0.5) * 200; z = (Math.random() - 0.5) * 200;
      if (Math.abs(x) < 6 && Math.abs(z) < 6) continue;
      if (!colliders.some(c => x > c.minX - 0.8 && x < c.maxX + 0.8 && z > c.minZ - 0.8 && z < c.maxZ + 0.8)) break;
    }
  }
  const model = type === 'wood' ? makeLogs() : makeScrap();
  model.group.position.set(x, 0, z);
  model.group.rotation.y = Math.random() * Math.PI * 2;
  scene.add(model.group);
  piles.push({ type, n: 3, group: model.group, parts: model.parts });
}
for (let i = 0; i < 16; i++) spawnPile('wood');
for (let i = 0; i < 18; i++) spawnPile('scrap');

function takeFromPile(p) { // берём одну штуку, модель уменьшается
  if (chopCd > 0) return;
  if (freeRoom(p.type) < 1) return notify('Инвентарь полон');
  addItem(p.type, 1);
  chopCd = 0.25;
  p.group.remove(p.parts.shift());
  p.n--;
  if (p.n <= 0) { scene.remove(p.group); piles.splice(piles.indexOf(p), 1); spawnPile(p.type); } // где-то появится новая
}

// Подсказка «[E] Взять» и поиск кучи, на которую смотрит игрок
let lookedPile = null;
const promptEl = document.createElement('div');
promptEl.style.cssText = 'position:fixed;top:58%;left:50%;transform:translateX(-50%);color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;background:rgba(0,0,0,.35);padding:4px 12px;border-radius:6px;display:none';
document.body.appendChild(promptEl);
const _fwd = new THREE.Vector3(), _to = new THREE.Vector3();
function updatePrompt() {
  lookedPile = null;
  if (!menuOpen && !buildMode && health > 0) {
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    let best = 0.88; // конус примерно 28 градусов
    for (const p of piles) {
      _to.set(p.group.position.x - camera.position.x, 0.25 - camera.position.y, p.group.position.z - camera.position.z);
      const d = _to.length();
      if (d > 3.5) continue;
      const c = _to.normalize().dot(_fwd);
      if (c > best) { best = c; lookedPile = p; }
    }
    if (lookedPile) { // через стену не берём
      _to.set(lookedPile.group.position.x - camera.position.x, 0.25 - camera.position.y, lookedPile.group.position.z - camera.position.z);
      const d = _to.length();
      raycaster.set(camera.position, _to.normalize());
      const wall = raycaster.intersectObjects(blockers, false)[0];
      if (wall && wall.distance < d) lookedPile = null;
    }
  }
  if (lookedPile) {
    promptEl.textContent = `[E] Взять: ${ITEMS[lookedPile.type].name} (осталось ${lookedPile.n})`;
    promptEl.style.display = 'block';
  } else promptEl.style.display = 'none';
}
function interact() { // клавиша E: куча рядом - берём, иначе рубим дерево
  if (lookedPile) takeFromPile(lookedPile);
  else chop();
}

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
const items = [];
function spawnItem(type, x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: ITEMS[type].color }));
  m.position.set(x ?? (Math.random() - 0.5) * 200, 0.3, z ?? (Math.random() - 0.5) * 200);
  scene.add(m);
  items.push({ mesh: m, type });
}
for (let i = 0; i < 10; i++) { spawnItem('food'); spawnItem('water'); }
for (let i = 0; i < 5; i++) spawnItem('medkit');

// Лут внутри каждого дома
for (const h of housePositions) {
  spawnItem('medkit', h.x - 2, h.z - 2);
  spawnItem('food', h.x + 2, h.z - 2);
  spawnItem('water', h.x, h.z - 2.5);
  spawnAmmoBox(h.x + 2, h.z + 1);
  spawnPile('scrap', h.x - 2.5, h.z + 1);
  spawnPile('scrap', h.x + 2.5, h.z - 1);
  spawnPile('wood', h.x + 6, h.z + 5); // дрова у входа
}

// HUD
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:10px;left:10px;color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;white-space:pre';
document.body.appendChild(hud);
const hotbar = document.createElement('div');
hotbar.style.cssText = 'position:fixed;bottom:15px;left:50%;transform:translateX(-50%);color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;background:rgba(0,0,0,0.4);padding:8px 16px;border-radius:6px;white-space:pre;text-align:center';
document.body.appendChild(hotbar);
let lastHot = '';
const cross = document.createElement('div');
cross.textContent = '+';
cross.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font:24px monospace';
document.body.appendChild(cross);

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
  if (countOf('wood') < p.cost) return notify(`Нужно дерева: ${p.cost}`);
  if (selPiece === 'fire' && built.filter(b => b.type === 'fire').length >= MAX_FIRES) return notify('Костров не больше 4');
  takeItem('wood', p.cost);

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
  addItem('wood', Math.floor(pieces[b.type].cost / 2));
}

// Рубка дерева (E)
function chop() {
  if (health <= 0 || chopCd > 0) return;
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hit = raycaster.intersectObjects(trees.map(t => t.trunk), false)[0];
  if (!hit || hit.distance > 3.5) return notify('Подойди ближе и смотри на ствол дерева');
  if (freeRoom('wood') < 1) return notify('Инвентарь полон');
  chopCd = 0.4;
  const ti = trees.findIndex(t => t.trunk === hit.object);
  const t = trees[ti];
  t.hp--;
  addItem('wood', 1);
  if (t.hp <= 0) {
    scene.remove(t.trunk);
    scene.remove(t.crown);
    colliders.splice(colliders.indexOf(t.collider), 1);
    blockers.splice(blockers.indexOf(t.trunk), 1);
    trees.splice(ti, 1);
    spawnPile('wood', t.trunk.position.x, t.trunk.position.z);
    notify('Дерево срублено, подбери брёвна (E)');
  }
}

// Крафт из лома
function craft(type) {
  if (health <= 0) return;
  if (type === 'ammo') {
    if (countOf('scrap') < 2) return notify('Нужно 2 лома');
    takeItem('scrap', 2); reserve += 7; notify('Сделано: +7 патронов');
  }
  if (type === 'medkit') {
    if (countOf('scrap') < 4) return notify('Нужно 4 лома');
    if (freeRoom('medkit') < 1) return notify('Инвентарь полон');
    takeItem('scrap', 4); addItem('medkit', 1); notify('Сделано: +1 аптечка');
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
    ghost.material.color.set(countOf('wood') >= pieces[selPiece].cost ? 0x44ff44 : 0xff4444);
  }
  for (const b of built) {
    if (b.type !== 'fire') continue;
    b.light.intensity = 7 + Math.random() * 2; // мерцание
    const near = Math.hypot(b.mesh.position.x - camera.position.x, b.mesh.position.z - camera.position.z) < 4;
    if (near && health > 0 && health < 100) health = Math.min(100, health + 1.5 * dt); // у костра лечишься
  }
}

// --- Меню с вкладками: Инвентарь / Крафт / Стройка (клавиша Tab) ---
let menuOpen = false, menuTab = 'inv', pick = null;
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
    body += `<div style="margin:10px 0 4px;opacity:.8">Быстрые слоты (клавиши 1-5)</div>`;
    body += `<div style="display:flex;gap:6px">${[0, 1, 2, 3, 4].map(i => slotHtml(i, pick === i, true)).join('')}</div>`;
    body += `<div style="margin:10px 0 4px;opacity:.8">Рюкзак (30 слотов)</div>`;
    let grid = '';
    for (let i = HOTBAR; i < SLOTS; i++) grid += slotHtml(i, pick === i, true);
    body += `<div style="display:flex;flex-wrap:wrap;gap:6px">${grid}</div>`;
    const sel = pick !== null ? slots[pick] : null;
    body += `<div style="margin-top:10px;min-height:52px">` + (sel
      ? `<b>${ITEMS[sel.type].name}</b> x${sel.n} ` + btn('Использовать', 'use', !!ITEMS[sel.type].use) + btn('Выбросить 1', 'drop:1') + btn('Выбросить всё', 'drop:all') +
        ` <span style="opacity:.7;font-size:14px">или нажми на другой слот, чтобы переложить</span>`
      : `<span style="opacity:.7;font-size:14px">Нажми на предмет, чтобы выбрать, потом на другой слот, чтобы переложить. Одинаковые предметы объединяются.</span>`) + `</div>`;
    body += `<div style="opacity:.85">Патроны: ${ammo} в обойме, ${reserve} в запасе</div>`;
  }
  if (menuTab === 'craft') {
    body += row('Патроны x7 <small>(2 лома)</small>', btn('Создать', 'craft:ammo', countOf('scrap') >= 2));
    body += row('Аптечка <small>(4 лома)</small>', btn('Создать', 'craft:medkit', countOf('scrap') >= 4));
    body += `<div style="margin-top:12px;opacity:.8">У тебя: лом x${countOf('scrap')}. Лом лежит на земле и в домах.</div>`;
  }
  if (menuTab === 'build') {
    for (const k of pieceKeys) {
      body += row(`${pieces[k].name} <small>(${pieces[k].cost} дерева)</small>`, btn('Строить', `build:${k}`, true));
    }
    body += `<div style="margin-top:12px;opacity:.8">У тебя: дерево x${countOf('wood')}. Дерево добывается рубкой деревьев (клавиша E).</div>`;
  }
  menu.innerHTML =
    `<div style="width:min(720px,94vw);max-height:92vh;overflow:auto;background:#1d231c;border:2px solid #5a6b45;border-radius:10px;padding:18px">` +
    `<div style="margin-bottom:12px">${tabs.map(([id, n]) => btn(n, 'tab:' + id, true, menuTab === id)).join('')}</div>` +
    body +
    `<div style="margin-top:14px;opacity:.7;font-size:14px">[Tab] или [Esc] - закрыть меню. Игра на паузе.</div></div>`;
}

function toggleMenu(open) {
  if (health <= 0) return;
  if (!open) pick = null;
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
  const sl = e.target.closest('[data-slot]');
  if (sl) {
    const i = +sl.dataset.slot;
    if (pick === null) { if (slots[i]) pick = i; }
    else if (pick === i) pick = null;
    else { moveSlot(pick, i); pick = null; }
    renderMenu();
    return;
  }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const [act, arg] = t.dataset.act.split(':');
  if (act === 'tab') menuTab = arg;
  if (act === 'use' && pick !== null) { useSlot(pick); if (!slots[pick]) pick = null; }
  if (act === 'drop' && pick !== null && slots[pick]) {
    if (arg === 'all') slots[pick] = null; else { slots[pick].n--; if (slots[pick].n <= 0) slots[pick] = null; }
    if (!slots[pick]) pick = null;
  }
  if (act === 'craft') craft(arg);
  if (act === 'build') { selPiece = arg; buildMode = true; toggleMenu(false); return; }
  renderMenu();
});

// Управление
addEventListener('keydown', e => {
  if (e.code === 'Tab') { e.preventDefault(); toggleMenu(!menuOpen); return; }
  if (menuOpen) { if (e.code === 'Escape') toggleMenu(false); return; }
  keys[e.code] = true;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'KeyB') buildMode = !buildMode;
  if (buildMode) {
    if (e.code === 'Digit1') selPiece = 'wall';
    if (e.code === 'Digit2') selPiece = 'roof';
    if (e.code === 'Digit3') selPiece = 'fire';
    if (e.code === 'KeyQ') rot = 1 - rot;
    if (e.code === 'KeyV') removePiece();
  } else {
    if (e.code >= 'Digit1' && e.code <= 'Digit5') useSlot(+e.code.slice(5) - 1); // быстрые слоты
    if (e.code === 'KeyZ') craft('ammo');
    if (e.code === 'KeyX') craft('medkit');
  }
  if (e.code === 'KeyE') interact();
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

// Стрельба (пули останавливаются о стены и деревья)
const raycaster = new THREE.Raycaster();
function startReload() { // клавиша R
  if (health <= 0 || reloading || menuOpen) return;
  if (ammo >= MAG && !lock) return;
  if (reserve <= 0) return notify('Нет запасных патронов');
  reloading = true; rT = 0; loaded = false; lockAtStart = lock;
}

function attack() {
  if (health <= 0 || reloading || cool > 0) return;
  if (ammo <= 0) return notify('Магазин пуст, нажми R');
  ammo--;
  cool = 0.22; recoil = 1; kick += 0.02; mzT = 0.06; slidePulse = 1; // отдача, вспышка, затвор
  if (ammo === 0) lock = true;                                       // затвор остаётся отведённым

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
  camera.rotation.set(pitch + kick, yaw, 0);
  updateBuild(dt);
  updatePrompt();

  // Анимация пистолета: покачивание, отдача, затвор, перезарядка
  gunT += dt; cool = Math.max(0, cool - dt); mzT = Math.max(0, mzT - dt);
  recoil *= Math.exp(-dt * 13); kick *= Math.exp(-dt * 9); slidePulse *= Math.exp(-dt * 20);
  {
    let px = 0.24, py = -0.2, pz = -0.5, rx = 0, rz = 0;
    px += Math.sin(gunT * 0.8) * 0.003; py += Math.sin(gunT * 1.6) * 0.004;
    if (health > 0 && (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD)) {
      const st = gunT * (keys.ShiftLeft ? 12 : 9);
      px += Math.sin(st) * 0.012; py += Math.abs(Math.cos(st)) * 0.014 - 0.007; rz += Math.sin(st) * 0.02;
    }
    pz += recoil * 0.06; rx += recoil * 0.16; py += recoil * 0.008;
    let slideOff = Math.max(lock ? 0.05 : 0, 0.05 * slidePulse);
    gp.lhand.visible = false;
    gp.magGroup.visible = true;
    gp.magGroup.rotation.set(0, 0, 0);
    gp.magGroup.position.set(0, magBaseY, 0);
    if (reloading) {
      rT += dt;
      const p = Math.min(1, rT / RELOAD);
      const sm = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
      // 1) пистолет наклоняется к камере
      const tilt = sm(0, 0.15, p) - sm(0.85, 1, p);
      rz += tilt * 0.5; rx -= tilt * 0.3; py -= tilt * 0.05; px -= tilt * 0.05;
      // 2) левая рука подъезжает снизу, уходит за новым магазином и возвращается
      const w = sm(0.12, 0.28, p) - sm(0.36, 0.5, p) + sm(0.5, 0.7, p) - sm(0.8, 0.92, p);
      const hx = -0.3 + 0.27 * w, hy = -0.6 + 0.31 * w, hz = 0.35 - 0.252 * w;
      gp.lhand.position.set(hx, hy, hz);
      gp.lhand.rotation.z = (1 - w) * -0.4;
      gp.lhand.visible = true;
      // 3) старый магазин выпадает, новый приезжает с рукой
      if (p >= 0.33 && p < 0.5) {
        const f = (p - 0.33) / 0.17;
        gp.magGroup.position.set(-0.01 * f, magBaseY - 0.7 * f * f, 0.02 * f);
        gp.magGroup.rotation.z = f * 1.2;
      } else if (p >= 0.5 && p < 0.7) {
        gp.magGroup.position.set(hx + 0.03, magBaseY + (hy + 0.29), hz - 0.098);
      }
      gp.magGroup.visible = !(p >= 0.49 && p < 0.53);
      // 4) толчок при вставке магазина, патроны заряжаются
      const bump = Math.exp(-Math.pow((p - 0.7) / 0.025, 2));
      py -= bump * 0.03; rx += bump * 0.06;
      if (p >= 0.7 && !loaded) {
        loaded = true;
        const take = Math.min(MAG - ammo, reserve);
        ammo += take; reserve -= take;
      }
      // 5) затвор: отпускается или передёргивается
      const q = clamp((p - 0.8) / 0.12, 0, 1);
      if (p >= 0.8) slideOff = lockAtStart ? 0.05 * (1 - sm(0, 0.5, q)) : 0.055 * Math.sin(q * Math.PI);
      else slideOff = lockAtStart ? 0.05 : 0;
      if (rT >= RELOAD) { reloading = false; lock = false; }
    }
    gun.position.set(px, py, pz);
    gun.rotation.set(rx, 0, rz);
    gp.slideGroup.position.z = slideOff;
    mzG.visible = mzT > 0;
    mzLight.intensity = mzT > 0 ? 8 : 0;
    if (mzT > 0) mzG.rotation.z = Math.random() * 6;
  }

  // Подбор патронов
  for (let i = ammoBoxes.length - 1; i >= 0; i--) {
    const p = ammoBoxes[i].position;
    if (Math.hypot(p.x - camera.position.x, p.z - camera.position.z) < 1.5) {
      reserve += 14;
      scene.remove(ammoBoxes[i]);
      ammoBoxes.splice(i, 1);
      spawnAmmoBox();
    }
  }

  // Подбор еды, воды, аптечек, лома
  for (let i = items.length - 1; i >= 0; i--) {
    items[i].mesh.rotation.y += dt; // предметы медленно вращаются
    const p = items[i].mesh.position;
    if (Math.hypot(p.x - camera.position.x, p.z - camera.position.z) < 1.5) {
      const type = items[i].type;
      if (freeRoom(type) < 1) { if (noticeT <= 0) notify('Инвентарь полон'); continue; }
      addItem(type, 1);
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
  const slotsRow = `<div style="display:flex;gap:6px;justify-content:center">${[0, 1, 2, 3, 4].map(i => slotHtml(i, false, false)).join('')}</div>`;
  const info = buildMode
    ? 'СТРОЙКА: ' + pieceKeys.map((k, i) => `${selPiece === k ? '▶' : ''}[${i + 1}] ${pieces[k].name} (${pieces[k].cost} дер.)`).join('  ') + `   Дерево: ${countOf('wood')}<br>[Q] поворот   [клик] поставить   [V] убрать   [B] выйти`
    : `[F] Фонарик ${flashOn ? 'вкл' : 'выкл'}   [R] Перезарядка   [E] Взять / рубить   [B] Строить   [Tab] Меню   ${hh}:${mm}<br>Дерево: ${countOf('wood')}   Лом: ${countOf('scrap')}`;
  const hotHtml = slotsRow + `<div style="margin-top:6px;font-size:16px">${info}</div>`;
  if (hotHtml !== lastHot) { hotbar.innerHTML = hotHtml; lastHot = hotHtml; }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
