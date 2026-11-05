import * as THREE from 'three';
import { initCutscenes } from './scenes/index.js'; // вступление и финал (папка scenes)

// --- Сохранения: мир строится от числа (зерна), поэтому его можно воссоздать точно таким же ---
let bootInfo = null;
try { bootInfo = JSON.parse(localStorage.getItem('dz_boot') || 'null'); localStorage.removeItem('dz_boot'); } catch (e) { /* первый запуск */ }
const WORLD_SEED = bootInfo && bootInfo.seed ? bootInfo.seed : Math.floor(Math.random() * 4294967295);
const _realRandom = Math.random;
{
  let a = WORLD_SEED;
  Math.random = function () { // воспроизводимый генератор на время создания мира
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let zombieUid = 0;

// --- Безопасное удаление из массива: splice(indexOf(x), 1) при indexOf = -1 удаляет ПОСЛЕДНИЙ элемент массива ---
function removeFrom(arr, item) { const i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); return i >= 0; }
// --- Освобождение памяти видеокарты: у каждого зомби свои геометрии и материалы ---
function disposeObject(o) { // общие (userData.shared) материалы и геометрии не трогаем: они нужны остальным
  o.traverse(c => {
    if (c.geometry && !c.geometry.userData?.shared) c.geometry.dispose();
    const m = c.material;
    if (m) (Array.isArray(m) ? m : [m]).forEach(x => { if (!x.userData?.shared) x.dispose(); });
  });
}
let uidCounter = 0, initDone = false, gameStarted = false, currentSlot = 0, day = 1;

// --- Рельеф ---
// Внутри квадрата ±FLAT_HALF (дороги, дома, лут, машины) земля ровная, как раньше. За ним начинается дикая местность:
// холмы растут с расстоянием, а у края мира поднимаются горами, через которые не пройти.
// Высота считается из зерна мира без Math.random, поэтому у всех игроков комнаты рельеф одинаковый.
const FLAT_HALF = 200;    // половина стороны ровной зоны
const WORLD_HALF = 700;   // половина стороны всего мира
const WORLD_WALK = 650;   // дальше игрок не пройдёт (горы)
const _nSeed = (WORLD_SEED ^ 0x9E3779B9) | 0;
function _hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + _nSeed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function _vnoise(x, z) { // гладкий шум 0..1
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = _hash2(ix, iz), b = _hash2(ix + 1, iz), c = _hash2(ix, iz + 1), d = _hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function rawTerrainY(x, z) { // высота земли без озёр
  const edge = Math.max(Math.abs(x), Math.abs(z));
  if (edge <= FLAT_HALF) return 0;
  const d = edge - FLAT_HALF;
  const k = Math.min(1, d / 80), ramp = k * k * (3 - 2 * k);          // плавный подъём от границы зоны
  let n = 0, amp = 1, f = 1 / 240, sum = 0;
  for (let o = 0; o < 4; o++) { n += _vnoise(x * f, z * f) * amp; sum += amp; amp *= 0.5; f *= 2.1; }
  n /= sum;
  let h = ramp * n * n * (24 + 36 * Math.min(1, d / 300));            // холмы, дальше от центра выше
  const round = Math.pow(Math.pow(Math.abs(x), 8) + Math.pow(Math.abs(z), 8), 0.125); // скруглённый край: горы без шва по диагонали
  const w = Math.max(0, (round - 500) / 200);
  return h + w * w * 55;                                              // стена гор у края мира
}

// --- Озёра (1.9.0): впадины в диких землях за ровной зоной ---
// Места и размеры считаются из зерна мира без Math.random, поэтому у всех игроков комнаты озёра одинаковые, а мир из старых сохранений не сдвигается.
const WATER_Y = -0.45;           // уровень воды
const SWIM_Y = WATER_Y - 1.05;   // глубже ноги не опускаются: игрок плывёт у поверхности
const LAKE_BEACH = 1.6;          // пляж тянется от берега (q = 1) до q = 1.6
const LAKES = [];                // { x, z, r, asp, rot, nx, nz, depth, reach, reach2 }
function lakeQ(l, x, z) {        // < 1 - вода, 1 - берег, дальше - пляж; берег неровный
  const dx = x - l.x, dz = z - l.z, c = Math.cos(l.rot), s = Math.sin(l.rot);
  const u = (dx * c + dz * s) / (l.r * l.asp), v = (-dx * s + dz * c) / l.r;
  return Math.hypot(u, v) / (1 + 0.28 * (_vnoise(x / 22 + l.nx, z / 22 + l.nz) * 2 - 1));
}
(function pickLakes() {
  for (let i = 0; i < 700 && LAKES.length < 7; i++) {
    const x = (_hash2(i * 3 + 101, 7) * 2 - 1) * 430, z = (_hash2(i * 5 + 7, 211) * 2 - 1) * 430;
    const pond = i % 3 === 2, r = pond ? 9 + _hash2(i, 977) * 6 : 20 + _hash2(i, 977) * 17;
    const asp = 0.75 + _hash2(i, 31) * 0.55, rot = _hash2(i, 57) * Math.PI;
    const reach = r * Math.max(asp, 1) * LAKE_BEACH * 1.4;
    const edge = Math.max(Math.abs(x), Math.abs(z)), round = Math.pow(Math.pow(Math.abs(x), 8) + Math.pow(Math.abs(z), 8), 0.125);
    if (edge - reach < FLAT_HALF + 12 || round + reach > 470) continue;      // не заходит в ровную зону и в горы
    if (rawTerrainY(x, z) > 7) continue;
    let steep = false; for (let k = 0; k < 8; k++) { const an = k / 8 * Math.PI * 2; if (rawTerrainY(x + Math.cos(an) * reach * 0.7, z + Math.sin(an) * reach * 0.7) > 16) steep = true; }
    if (steep) continue;                                                       // на крутых холмах озёра не копаем
    if (LAKES.some(o => Math.hypot(o.x - x, o.z - z) < (o.reach + reach) * 0.8)) continue;
    LAKES.push({ x, z, r, asp, rot, nx: _hash2(i, 401) * 100, nz: _hash2(i, 503) * 100, depth: 2.0 + r * 0.06, reach, reach2: reach * reach });
  }
})();
function terrainY(x, z) { // высота земли в точке (с озёрами)
  const h = rawTerrainY(x, z);
  if (!LAKES.length || Math.max(Math.abs(x), Math.abs(z)) <= FLAT_HALF) return h;
  let out = h;
  for (const l of LAKES) {
    const dx = x - l.x, dz = z - l.z; if (dx * dx + dz * dz > l.reach2) continue;
    const q = lakeQ(l, x, z); if (q >= LAKE_BEACH) continue;
    let v;
    if (q >= 1) { const t = (q - 1) / (LAKE_BEACH - 1), k = t * t * (3 - 2 * t); v = WATER_Y + (h - WATER_Y) * k; }
    else v = WATER_Y - l.depth * (1 - q * q);
    if (v < out) out = v;
  }
  return out;
}
function lakeShore(x, z) { // наименьшее q среди озёр (для песка и ила на земле, тростника)
  let m = 99;
  for (const l of LAKES) { const dx = x - l.x, dz = z - l.z; if (dx * dx + dz * dz > l.reach2) continue; const q = lakeQ(l, x, z); if (q < m) m = q; }
  return m;
}
// Деревья и валуны дикой местности: коллайдеры лежат в сетке, чтобы проверять только соседние клетки
const WILD_CELL = 24, wildGrid = new Map();
const wildKey = (ix, iz) => ix * 4096 + iz;

// --- Сцена ---
const scene = new THREE.Scene();

// --- Графика: тени для крупных предметов ---
const SHADOWS = true; // false - выключить тени, если игра тормозит
function shade(o) {
  o.traverse(c => {
    if (!c.isMesh || !c.material) return;
    const m = Array.isArray(c.material) ? c.material[0] : c.material;
    if (!m.isMeshStandardMaterial || (m.transparent && m.opacity < 0.6)) return;
    c.receiveShadow = true;
    if (c.geometry.type === 'PlaneGeometry' || c.geometry.type === 'CircleGeometry') return; // плоскости только принимают тени
    if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
    const sz = new THREE.Vector3(); c.geometry.boundingBox.getSize(sz);
    if (Math.max(sz.x * Math.abs(c.scale.x), sz.y * Math.abs(c.scale.y), sz.z * Math.abs(c.scale.z)) >= 0.4) c.castShadow = true;
  });
}
const _sceneAdd = scene.add.bind(scene);
scene.add = (...objs) => { if (SHADOWS) objs.forEach(shade); return _sceneAdd(...objs); };
scene.background = new THREE.Color(0x8a9a8a);
scene.fog = new THREE.Fog(0x8a9a8a, 10, 80);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 260);
camera.position.set(0, 1.7, 0);
camera.rotation.order = 'YXZ';
scene.add(camera); // нужно, чтобы оружие в руках было видно

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // кинематографичная цветокоррекция
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = SHADOWS;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
sun.castShadow = SHADOWS;                      // тени от солнца следуют за игроком
sun.shadow.mapSize.set(2048, 2048);
const shCam = sun.shadow.camera;
shCam.near = 1; shCam.far = 160; shCam.left = -45; shCam.right = 45; shCam.top = 45; shCam.bottom = -45;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
scene.add(sun.target);

// --- Настройки (сохраняются на компьютере) ---
const DEFAULT_SETTINGS = { shadows: true, fov: 75, sens: 1, exposure: 1.15, volume: 0.8, fog: 1, res: Math.min(window.devicePixelRatio || 1, 2) };
const SETTINGS = Object.assign({}, DEFAULT_SETTINGS);
try { Object.assign(SETTINGS, JSON.parse(localStorage.getItem('dz_settings') || '{}')); } catch (e) { /* первый запуск */ }
const SET_FMT = {
  fov: v => Math.round(v) + '°', sens: v => v.toFixed(2) + 'x', exposure: v => v.toFixed(2),
  volume: v => Math.round(v * 100) + '%', fog: v => Math.round(v * 100) + '%', res: v => Math.round(v * 100) + '%',
};
function saveSettings() { try { localStorage.setItem('dz_settings', JSON.stringify(SETTINGS)); } catch (e) { /* нет доступа */ } }
function applySettings() {
  sun.castShadow = SHADOWS && SETTINGS.shadows;
  camera.fov = SETTINGS.fov; camera.updateProjectionMatrix();
  renderer.toneMappingExposure = SETTINGS.exposure;
  renderer.setPixelRatio(SETTINGS.res);
  renderer.setSize(innerWidth, innerHeight);
}
applySettings();

// --- Мир ---
const groundTex = (() => { // пиксельная трава
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const x = c.getContext('2d');
  const cols = ['#5a6b45', '#566840', '#5f7049', '#52623d', '#647650', '#4f5e3a'];
  for (let i = 0; i < 32; i++) for (let j = 0; j < 32; j++) { x.fillStyle = cols[Math.floor(Math.random() * cols.length)]; x.fillRect(i, j, 1, 1); }
  for (let k = 0; k < 24; k++) { x.fillStyle = 'rgba(40,32,18,.22)'; x.fillRect(Math.floor(Math.random() * 32), Math.floor(Math.random() * 32), 2, 1); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(WORLD_HALF / 2, WORLD_HALF / 2); // клетка 4 м, как раньше
  t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
})();
// Земля: сетка 3,3 м, высоты из terrainY; цвет вершин: трава внизу, серая порода на крутых склонах и вершинах
const groundGeo = new THREE.PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2, 420, 420);
groundGeo.rotateX(-Math.PI / 2);
{
  const pos = groundGeo.attributes.position, colors = new Float32Array(pos.count * 3), shore = new Float32Array(pos.count * 2); // shore: песок, ил
  const rockCol = new THREE.Color(0.58, 0.56, 0.54), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = terrainY(x, z);
    pos.setY(i, h);
    const slope = Math.hypot(terrainY(x + 3, z) - h, terrainY(x, z + 3) - h) / 3;
    const rocky = Math.min(1, Math.max(0, (slope - 0.3) / 0.5) + Math.max(0, (h - 45) / 40));
    c.setRGB(1, 1, 1).lerp(rockCol, rocky).multiplyScalar(0.94 + _vnoise(x / 35, z / 35) * 0.12); // светлые и тёмные пятна
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    if (LAKES.length) { const q = lakeShore(x, z); shore[i * 2] = q < 1.1 ? 1 : Math.max(0, (LAKE_BEACH - q) / (LAKE_BEACH - 1.1)); shore[i * 2 + 1] = q < 1 ? Math.min(1, (1 - q) / 0.4) : 0; }
  }
  groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  groundGeo.setAttribute('shore', new THREE.BufferAttribute(shore, 2));
  groundGeo.computeVertexNormals();
}
const ground = new THREE.Mesh(
  groundGeo,
  new THREE.MeshStandardMaterial({ color: 0xffffff, map: groundTex, roughness: 1, vertexColors: true })
);
ground.material.onBeforeCompile = sh => { // песок на пляжах и тёмный ил на дне озёр поверх травяной текстуры
  sh.vertexShader = 'attribute vec2 shore;\nvarying vec2 vShore;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvShore = shore;');
  sh.fragmentShader = 'varying vec2 vShore;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    float gl = dot(diffuseColor.rgb, vec3(0.33));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.66, 0.47) * (0.7 + gl * 1.1), vShore.x * 0.92);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.22, 0.17) * (0.7 + gl * 0.8), vShore.y);`);
};
scene.add(ground);

// --- Небо: градиент, солнце, звёзды ночью, облака ---
const SKY_DAY_TOP = new THREE.Color(0x5f8fc0), SKY_DAY_BOT = new THREE.Color(0xb7c6c8);
const SKY_WARM_TOP = new THREE.Color(0x3a4f78), SKY_WARM_BOT = new THREE.Color(0xf09050);
const SKY_NIGHT_TOP = new THREE.Color(0x03060d), SKY_NIGHT_BOT = new THREE.Color(0x0a1019);
const WHITE = new THREE.Color(0xffffff), skyTop = new THREE.Color(), skyBot = new THREE.Color();
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() }, night: { value: 0 } },
  vertexShader: 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunCol; uniform float night;
    varying vec3 vP;
    void main() {
      vec3 d = normalize(vP);
      float h = clamp(d.y * 1.25 + 0.12, 0.0, 1.0);
      vec3 col = mix(bottom, top, pow(h, 0.65));
      float s = max(dot(d, normalize(sunDir)), 0.0);
      col += sunCol * (pow(s, 700.0) * 4.0 + pow(s, 14.0) * 0.28);
      vec3 q = floor(d * 160.0);
      float st = step(0.9985, fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453)) * night * smoothstep(0.05, 0.35, d.y);
      col += vec3(st);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(150, 24, 12), skyMat);
sky.frustumCulled = false; sky.renderOrder = -10;
scene.add(sky);

const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.88, fog: false, depthWrite: false });
const clouds = [];
for (let i = 0; i < 18; i++) {
  const c = new THREE.Group();
  const n = 3 + Math.floor(Math.random() * 3);
  for (let k = 0; k < n; k++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(8 + Math.random() * 12, 2.2 + Math.random() * 1.5, 6 + Math.random() * 6), cloudMat);
    m.position.set((k - n / 2) * 9 + Math.random() * 3, Math.random() * 1.5, (Math.random() - 0.5) * 6);
    c.add(m);
  }
  c.position.set((Math.random() - 0.5) * 280, 62 + Math.random() * 18, (Math.random() - 0.5) * 280);
  clouds.push(c); scene.add(c);
}
function updateClouds(dt) { // облака плывут; ночью тёмные
  cloudMat.color.setRGB(0.1 + 0.9 * daylight, 0.11 + 0.89 * daylight, 0.16 + 0.84 * daylight);
  for (const c of clouds) {
    c.position.x += 1.6 * dt;
    const dx = c.position.x - camera.position.x, dz = c.position.z - camera.position.z;
    if (dx > 140) c.position.x -= 280; else if (dx < -140) c.position.x += 280;
    if (dz > 140) c.position.z -= 280; else if (dz < -140) c.position.z += 280;
  }
}

// Виньетка: лёгкое затемнение углов экрана
const vig = document.createElement('div');
vig.style.cssText = 'position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, rgba(0,0,0,0) 58%, rgba(0,0,0,0.38) 100%)';
document.body.appendChild(vig);

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

// Выталкивает позицию из препятствий списка (r - радиус тела)
function resolveAgainst(list, pos, r, feet) {
  for (const c of list) {
    if (c.top !== undefined && feet > c.top - 0.3) continue;
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
// Выталкивает позицию из всех препятствий (r - радиус тела)
function resolveCollisions(pos, r) {
  const feet = pos.y !== undefined ? pos.y - 1.7 : 0; // высота ног: стоя на крыше стены ниже ног не мешают
  resolveAgainst(colliders, pos, r, feet);
  if (Math.abs(pos.x) > FLAT_HALF - 4 || Math.abs(pos.z) > FLAT_HALF - 4) { // дикая местность: смотрим только соседние клетки
    const ix = Math.floor(pos.x / WILD_CELL), iz = Math.floor(pos.z / WILD_CELL);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const l = wildGrid.get(wildKey(ix + a, iz + b));
      if (l) resolveAgainst(l, pos, r, feet);
    }
  }
}

// Деревья (ствол твёрдый, крона нет)
function makeCrown(x, z) { // крона из трёх ярусов
  const g = new THREE.Group();
  [[1.75, 1.9, 3.0], [1.4, 1.7, 4.0], [1.0, 1.5, 4.9]].forEach(([r, h, y], i) => {
    const green = new THREE.Color(0x2f5a2a).offsetHSL((Math.random() - 0.5) * 0.04, 0, (Math.random() - 0.5) * 0.06 + i * 0.015);
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), new THREE.MeshStandardMaterial({ color: green, roughness: 1, flatShading: true }));
    m.position.y = y; m.rotation.y = Math.random() * 6; g.add(m);
  });
  g.position.set(x, 0, z); g.scale.setScalar(0.9 + Math.random() * 0.35);
  scene.add(g);
  return g;
}
const trees = []; // деревья, которые можно рубить
for (let i = 0; i < 150; i++) {
  const x = (Math.random() - 0.5) * 300, z = (Math.random() - 0.5) * 300;
  if ((Math.abs(x) < 8 && Math.abs(z) < 8) || Math.abs(x) < 4.5 || Math.abs(z) < 4.5) continue; // не на дороге
  const trunk = box(0.6, 3, 0.6, 0x5b3a1e, x, 1.5, z, true);
  const collider = colliders[colliders.length - 1];
  const crown = makeCrown(x, z);
  trees.push({ trunk, crown, collider, hp: 4, id: uidCounter++ });
}

// --- Дома: стены с окнами, дверь с южной стороны (+Z), двускатная крыша, крыльцо, мебель ---
// Каждый дом собирается из сотен коробок, но склеивается в 4 меша (стены, крыша, мелочи, стёкла): видеокарте почти не тяжело.
// Повреждения, ставни, цвета считаются из координат дома, а не через Math.random: мир из сохранений не сдвигается.
const housePositions = [];
const HOUSE_STYLES = [
  { wall: 0xd8cdb4, trim: 0x5a4632, roof: 0x8a3b2e, door: 0x5a3a20, base: 0x7d7b75, floor: 0x8a6a45, accent: 0x3f5f7a }, // светлый дом с красной крышей
  { wall: 0x8a6a45, trim: 0x3f2c1a, roof: 0x3b3f44, door: 0x3a2614, base: 0x6a645c, floor: 0x7a5a38, accent: 0x4a6a3a }, // деревянный сруб
  { wall: 0xa9b0ad, trim: 0x4a4f50, roof: 0x4d6a46, door: 0x6a4a2a, base: 0x77797a, floor: 0x806343, accent: 0x8a3b2e }, // серый дом с зелёной крышей
];
const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd0e8, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.3, depthWrite: false });
const houseMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92 });

// Матрицы 4x4 по столбцам, как в three.js: сдвиг + поворот Эйлера XYZ
function m4(px, py, pz, rx = 0, ry = 0, rz = 0) {
  const a = Math.cos(rx), b = Math.sin(rx), c = Math.cos(ry), d = Math.sin(ry), e = Math.cos(rz), f = Math.sin(rz);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return [c * e, af + be * d, bf - ae * d, 0, -c * f, ae - bf * d, be + af * d, 0, d, -b * c, a * c, 0, px, py, pz, 1];
}
function m4mul(A, B) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const mulCol = (hex, f) => { // осветлить или затемнить цвет
  const r = Math.min(255, Math.round((hex >> 16 & 255) * f)), g = Math.min(255, Math.round((hex >> 8 & 255) * f)), b = Math.min(255, Math.round((hex & 255) * f));
  return r << 16 | g << 8 | b;
};

// Набор для сборки дома: коробки складываются в четыре кучи, из каждой получается один меш.
// solid - стены (держат пули), roof - крыша (держит пули), decor - мелочи (пули летят сквозь), glass - стёкла.
function houseKit(ox, oz) {
  const bk = () => ({ p: [], n: [], c: [] });
  const B = { solid: bk(), roof: bk(), decor: bk(), glass: bk() };
  const cc = new THREE.Color();
  let count = 0;
  const jitter = () => { count++; const s = Math.sin((count + ox * 0.37 + oz * 0.71) * 12.9898) * 43758.5453; return 1 + ((s - Math.floor(s)) - 0.5) * 0.06; };
  const ao = y => 0.78 + 0.22 * Math.min(1, Math.max(0, y / 1.4)); // низ темнее: грязь и тень у земли
  function face(b, pts, cen, rgb) { // грань из точек по кругу; нормаль направляем от центра тела
    const ux = pts[1][0] - pts[0][0], uy = pts[1][1] - pts[0][1], uz = pts[1][2] - pts[0][2];
    const vx = pts[2][0] - pts[0][0], vy = pts[2][1] - pts[0][1], vz = pts[2][2] - pts[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    let mx = 0, my = 0, mz = 0; pts.forEach(p => { mx += p[0]; my += p[1]; mz += p[2]; });
    mx /= pts.length; my /= pts.length; mz /= pts.length;
    if (nx * (mx - cen[0]) + ny * (my - cen[1]) + nz * (mz - cen[2]) < 0) { pts = pts.slice().reverse(); nx = -nx; ny = -ny; nz = -nz; }
    for (let i = 1; i < pts.length - 1; i++) for (const p of [pts[0], pts[i], pts[i + 1]]) {
      b.p.push(p[0], p[1], p[2]); b.n.push(nx, ny, nz);
      const k = ao(p[1]); b.c.push(rgb[0] * k, rgb[1] * k, rgb[2] * k);
    }
  }
  const CORNERS = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const QUADS = [[1, 2, 6, 5], [0, 4, 7, 3], [3, 7, 6, 2], [0, 1, 5, 4], [4, 5, 6, 7], [0, 3, 2, 1]];
  function addM(b, w, h, d, color, M) {
    cc.setHex(color); const j = jitter(), rgb = [cc.r * j, cc.g * j, cc.b * j];
    const P = CORNERS.map(([sx, sy, sz]) => {
      const x = sx * w / 2, y = sy * h / 2, z = sz * d / 2;
      return [M[0] * x + M[4] * y + M[8] * z + M[12] + ox, M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14] + oz];
    });
    const cen = [M[12] + ox, M[13], M[14] + oz];
    for (const q of QUADS) face(b, q.map(i => P[i]), cen, rgb);
  }
  const at = b => (w, h, d, color, x, y, z, rx, ry, rz) => addM(b, w, h, d, color, m4(x, y, z, rx, ry, rz));
  const atM = b => (w, h, d, color, M) => addM(b, w, h, d, color, M);
  function prism(b, x0, x1, yb, zh, rise, color) { // фронтон: треугольник в плоскости YZ, выдавленный по X
    cc.setHex(color); const j = jitter(), rgb = [cc.r * j, cc.g * j, cc.b * j];
    const P = (x, y, z) => [x + ox, y, z + oz];
    const A = P(x0, yb, -zh), Bb = P(x0, yb, zh), C = P(x0, yb + rise, 0), A2 = P(x1, yb, -zh), B2 = P(x1, yb, zh), C2 = P(x1, yb + rise, 0);
    const cen = [(x0 + x1) / 2 + ox, yb + rise / 3, oz];
    [[A, Bb, C], [A2, B2, C2], [A, Bb, B2, A2], [A, C, C2, A2], [Bb, C, C2, B2]].forEach(f => face(b, f, cen, rgb));
  }
  function finish() {
    const make = (b, mat, part, blocks) => {
      if (!b.p.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
      if (mat === houseMat) g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
      const m = new THREE.Mesh(g, mat);
      m.userData.part = part;
      scene.add(m);
      if (part === 'decor') m.castShadow = false; // тени от мелочей слишком дорогие
      if (blocks) blockers.push(m);
    };
    make(B.solid, houseMat, 'walls', true); make(B.roof, houseMat, 'roof', true);
    make(B.decor, houseMat, 'decor', false); make(B.glass, glassMat, 'glass', false);
  }
  return { sol: at(B.solid), rf: at(B.roof), dc: at(B.decor), gl: at(B.glass), solM: atM(B.solid), rfM: atM(B.roof), dcM: atM(B.decor), prism: (...a) => prism(B.solid, ...a), finish };
}

function buildHouse(x, z, st) {
  const H = 3.4, T = 0.4, L = 8, S = HOUSE_STYLES[st];
  const { sol, rf, dc, gl, solM, rfM, dcM, prism, finish } = houseKit(x, z);
  const hs = n => { const s = Math.sin(n * 127.1 + x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); }; // 0..1 из координат дома
  const col = (minX, maxX, minZ, maxZ) => colliders.push({ minX, maxX, minZ, maxZ });
  const dmg = hs(1);                       // насколько дом разрушен
  const sx = st % 2 ? 1 : -1;              // сторона, где стоит камин
  const trimLight = mulCol(S.trim, 1.35);
  const wallDark = mulCol(S.wall, 0.86), wallLight = mulCol(S.wall, 1.08);
  const woodOld = 0x6b5438;
  let wi = 0;                              // номер окна: от него зависят ставни, доски, занавески

  // Стена с проёмами. along: 'x' или 'z'; out: куда смотрит наружу (+1 или -1). openings: { c, w, sill, h, door }
  function wall(cx, cz, along, out, openings) {
    const pos = (s, d) => along === 'x' ? [cx + s, cz + d * out] : [cx + d * out, cz + s]; // s - вдоль стены, d - от стены наружу
    const dims = (len, h, th) => along === 'x' ? [len, h, th] : [th, h, len];
    const rot = a => along === 'x' ? [0, 0, a] : [a, 0, 0];                                  // поворот вокруг нормали стены
    const piece = (s0, s1, y0, y1) => {
      const len = s1 - s0, h = y1 - y0;
      if (len < 0.01 || h < 0.01) return;
      const [px, pz] = pos((s0 + s1) / 2, 0), [w, hh, d] = dims(len, h, T);
      sol(w, hh, d, S.wall, px, (y0 + y1) / 2, pz);
    };
    const strip = (s0, s1, y, h, th, d, color) => { // горизонтальная полоса обшивки
      if (s1 - s0 < 0.05) return;
      const [px, pz] = pos((s0 + s1) / 2, d), [w, hh, dd] = dims(s1 - s0, h, th);
      dc(w, hh, dd, color, px, y, pz);
    };
    const free = y => { // свободные от проёмов участки стены на высоте y
      let segs = [[-L / 2, L / 2]];
      for (const o of openings) {
        const lo = o.door ? 0 : o.sill - 0.12, hi = o.door ? o.h + 0.15 : o.sill + o.h + 0.12;
        if (y < lo || y > hi) continue;
        const a = o.c - o.w / 2 - 0.08, b = o.c + o.w / 2 + 0.08, next = [];
        for (const [s0, s1] of segs) { if (b <= s0 || a >= s1) next.push([s0, s1]); else { if (a > s0) next.push([s0, a]); if (b < s1) next.push([b, s1]); } }
        segs = next;
      }
      return segs;
    };
    // обшивка снаружи: доски (дом 0), брёвна (сруб), рейки (дом 2)
    if (st === 0) for (let y = 0.55; y < H - 0.1; y += 0.36) free(y).forEach(([a, b]) => strip(a, b, y, 0.04, 0.04, T / 2 + 0.015, wallDark));
    if (st === 1) for (let y = 0.3; y < H - 0.1; y += 0.3) {
      free(y).forEach(([a, b]) => { strip(a, b, y, 0.05, 0.04, T / 2 + 0.015, mulCol(S.wall, 0.7)); strip(a, b, y, 0.05, 0.04, -T / 2 - 0.015, mulCol(S.wall, 0.7)); });
    }
    if (st === 2) for (let s = -L / 2 + 0.5; s < L / 2 - 0.3; s += 0.66) {
      if (openings.some(o => Math.abs(o.c - s) < o.w / 2 + 0.15)) continue;
      const [px, pz] = pos(s, T / 2 + 0.015), [w, hh, d] = dims(0.07, H - 0.5, 0.04);
      dc(w, hh, d, wallDark, px, 0.35 + (H - 0.5) / 2, pz);
    }
    // проёмы
    let cur = -L / 2;
    for (const o of openings.slice().sort((a, b) => a.c - b.c)) {
      const a = o.c - o.w / 2, b = o.c + o.w / 2;
      piece(cur, a, 0, H);
      if (o.door) { piece(a, b, o.h, H); cur = b; continue; }
      piece(a, b, 0, o.sill);
      piece(a, b, o.sill + o.h, H);
      const i = wi++, gy = o.sill + o.h / 2;
      const broken = hs(100 + i) < 0.18 + dmg * 0.3, boarded = hs(200 + i) < 0.1 + dmg * 0.4, shut = hs(300 + i) < 0.55, curtain = hs(400 + i) < 0.5 && !broken;
      if (!broken) { const [px, pz] = pos(o.c, 0), [w, hh, d] = dims(o.w, o.h, 0.04); gl(w, hh, d, 0x9fd0e8, px, gy, pz); }
      else { // осколки по краям рамы
        for (let k = 0; k < 3; k++) { const [px, pz] = pos(o.c + (k - 1) * o.w * 0.3, 0.02), [w, hh, d] = dims(0.16, 0.22 + k * 0.08, 0.02); dc(w, hh, d, 0xbfdce6, px, o.sill + 0.15 + k * 0.04, pz); }
      }
      const fr = (len, h, dx, dy, th = T + 0.1) => { const [px, pz] = pos(o.c + dx, 0), [w, hh, d] = dims(len, h, th); dc(w, hh, d, S.trim, px, gy + dy, pz); };
      fr(o.w + 0.2, 0.1, 0, o.h / 2 + 0.05); fr(o.w + 0.2, 0.1, 0, -o.h / 2 - 0.05);
      fr(0.1, o.h, o.w / 2 + 0.05, 0); fr(0.1, o.h, -o.w / 2 - 0.05, 0);
      if (!broken) { fr(0.05, o.h, 0, 0); fr(o.w, 0.05, 0, 0); }
      { const [px, pz] = pos(o.c, T / 2 + 0.1), [w, hh, d] = dims(o.w + 0.34, 0.07, 0.26); dc(w, hh, d, trimLight, px, o.sill - 0.04, pz); } // подоконник
      { const [px, pz] = pos(o.c, T / 2 + 0.04), [w, hh, d] = dims(o.w + 0.36, 0.13, 0.14); dc(w, hh, d, S.trim, px, o.sill + o.h + 0.17, pz); } // перемычка
      if (curtain) { const [px, pz] = pos(o.c, -T / 2 + 0.03), [w, hh, d] = dims(o.w * 0.92, o.h * 0.85, 0.03); dc(w, hh, d, [0xb55a4a, 0xd9cfae, 0x6a8aa5][i % 3], px, gy + 0.05, pz); }
      if (boarded) for (let k = 0; k < 3; k++) {
        const [px, pz] = pos(o.c, T / 2 + 0.12), [w, hh, d] = dims(o.w + 0.5, 0.14, 0.05), r = rot((k % 2 ? -1 : 1) * (0.22 + k * 0.06));
        dc(w, hh, d, mulCol(woodOld, 0.85 + k * 0.12), px, gy + (k - 1) * o.h * 0.32, pz, r[0], r[1], r[2]);
      } else if (shut) for (const sg of [-1, 1]) { // ставни; один висит на одной петле
        const hang = sg === 1 && hs(500 + i) < 0.35 ? 0.55 : 0, [px, pz] = pos(o.c + sg * (o.w / 2 + 0.3), T / 2 + 0.07), [w, hh, d] = dims(0.52, o.h + 0.05, 0.05), r = rot(hang * sg);
        dc(w, hh, d, S.accent, px, gy - hang * 0.12, pz, r[0], r[1], r[2]);
      }
      if (!boarded && o.sill < 1.1 && out === 1 && st !== 1) { // ящик с цветами на южных окнах
        const dead = hs(600 + i) < 0.5, [px, pz] = pos(o.c, T / 2 + 0.22), [w, hh, d] = dims(o.w * 0.9, 0.17, 0.26);
        dc(w, hh, d, 0x5a4026, px, o.sill - 0.17, pz);
        dc(w * 0.94, 0.07, d * 0.8, dead ? 0x6b5a3a : 0x3f7a34, px, o.sill - 0.06, pz);
      }
      cur = b;
    }
    piece(cur, L / 2, 0, H);
  }

  // Пол: доски, плинтус, каменный цоколь снаружи
  dc(7.2, 0.03, 7.2, S.floor, 0, 0.015, 0);
  for (let i = -7; i <= 7; i++) dc(0.03, 0.012, 7.2, mulCol(S.floor, 0.82), i * 0.48, 0.036, 0);
  [[0, -3.58, 7.2, 0.04], [0, 3.58, 7.2, 0.04], [-3.58, 0, 0.04, 7.2], [3.58, 0, 0.04, 7.2]].forEach(([px, pz, w, d]) => dc(w, 0.14, d, trimLight, px, 0.1, pz));
  { // цоколь из камней: сегменты по ~0.9 м разного оттенка; перед дверью проход
    const stone = (cx, cz, w, d, k) => dc(w, 0.34, d, mulCol(S.base, 0.88 + hs(700 + k) * 0.26), cx, 0.17, cz);
    let k = 0;
    for (let s = -4.15; s < 4.15 - 0.2; s += 0.92) { const w = Math.min(0.92, 4.15 - s); stone(s + w / 2, -3.925, w, 0.45, k++); if (!(s + w / 2 > -1.1 && s + w / 2 < 1.1)) stone(s + w / 2, 3.925, w, 0.45, k++); }
    for (let s = -3.7; s < 3.7 - 0.1; s += 0.92) { const w = Math.min(0.92, 3.7 - s); stone(-3.925, s + w / 2, 0.45, w, k++); stone(3.925, s + w / 2, 0.45, w, k++); }
    dc(2.0, 0.08, 0.6, mulCol(S.base, 1.1), 0, 0.04, 3.85); // порог
  }

  // Стены с окнами, колонны в углах
  const win = c => ({ c, w: 1.4, sill: 1.0, h: 1.2 });
  wall(0, -3.8, 'x', -1, [win(-2.2), win(2.2)]);
  wall(-3.8, 0, 'z', -1, [win(0)]);
  wall(3.8, 0, 'z', 1, [win(0)]);
  wall(0, 3.8, 'x', 1, [{ c: 0, w: 2, h: 2.4, door: true }, { c: -2.6, w: 1.2, sill: 1.0, h: 1.2 }, { c: 2.6, w: 1.2, sill: 1.0, h: 1.2 }]);
  col(x - 4, x + 4, z - 4, z - 3.6);
  col(x - 4, x - 3.6, z - 4, z + 4);
  col(x + 3.6, x + 4, z - 4, z + 4);
  col(x - 4, x - 1, z + 3.6, z + 4);
  col(x + 1, x + 4, z + 3.6, z + 4);
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => {
    sol(0.5, H, 0.5, S.trim, a * 4, H / 2, b * 4);
    if (st === 1) for (let y = 0.15; y < H; y += 0.3) { // торцы брёвен выступают из углов
      const o = (y * 10 | 0) % 2 ? 0.2 : -0.2;
      dc(0.36, 0.26, 0.36, mulCol(S.wall, 1.15), a * 4 + a * 0.12, y, b * 4 + b * 0.12 + o * 0.2);
    }
  });

  // Дверь: рама, перемычка, створка с филёнками, ручка, петли
  dc(0.12, 2.4, 0.5, S.trim, -1.06, 1.2, 3.8); dc(0.12, 2.4, 0.5, S.trim, 1.06, 1.2, 3.8);
  dc(2.3, 0.14, 0.5, S.trim, 0, 2.47, 3.8);
  { const P = m4(1.0, 0, 3.8, 0, 1.3, 0), at2 = (px, py, pz) => m4mul(P, m4(px, py, pz));
    dcM(1.0, 2.3, 0.08, S.door, at2(-0.5, 1.15, 0));
    [[1.7, 0.8], [0.6, 0.7]].forEach(([py, h]) => [-1, 1].forEach(sg => dcM(0.7, h, 0.02, mulCol(S.door, 1.25), at2(-0.5, py, sg * 0.045))));
    dcM(0.08, 0.08, 0.14, 0xc9a227, at2(-0.85, 1.05, 0));
    [0.4, 1.8].forEach(py => dcM(0.12, 0.1, 0.12, 0x2f3236, at2(-0.04, py, 0)));
    if (hs(4) < 0.6) { // краска на стене: красный крест, «проверено»
      dc(0.8, 0.07, 0.02, 0xb02020, -1.58, 1.55, 4.03, 0, 0, Math.PI / 4); dc(0.8, 0.07, 0.02, 0xb02020, -1.58, 1.55, 4.03, 0, 0, -Math.PI / 4);
    }
  }

  // Двускатная крыша: плиты, черепица рядами, свесы, коньковая доска, желоба, фронтоны
  const rise = 1.8, half = 4.5, ang = Math.atan2(rise, half), slope = Math.hypot(half, rise) + 0.3;
  [-1, 1].forEach(sg => {
    const M = m4(0, H + rise / 2 + 0.05, sg * half / 2, sg * ang, 0, 0);
    rfM(9.6, 0.18, slope, mulCol(S.roof, 0.75), M);
    const rows = 10, rowH = slope / rows, miss = 0.03 + dmg * 0.12;
    for (let r = 0; r < rows; r++) for (let t = 0; t < 8; t++) {
      const off = (r % 2) * 0.6, lx = -4.2 + t * 1.2 + off;
      if (Math.abs(lx) + 0.58 > 4.82) continue;
      const q = hs(800 + sg * 100 + r * 9 + t);
      if (q < miss) continue; // выпавшая черепица
      dcM(1.16, 0.05, rowH * 0.92, mulCol(S.roof, 0.88 + q * 0.28), m4mul(M, m4(lx, 0.115, -slope / 2 + rowH * (r + 0.5))));
    }
    dcM(9.8, 0.24, 0.08, S.trim, m4mul(M, m4(0, 0, sg * slope / 2)));              // доска на краю свеса
    dcM(9.5, 0.1, 0.14, 0x5a5f61, m4mul(M, m4(0, -0.12, sg * (slope / 2 + 0.08)))); // водосточный желоб
    [-1, 1].forEach(e => dcM(0.08, 0.24, slope, S.trim, m4mul(M, m4(e * 4.82, 0.03, 0)))); // боковые доски
    if (hs(8) < 0.45 && sg === (hs(9) < 0.5 ? -1 : 1)) { // синий брезент на дыре
      const px = (hs(10) - 0.5) * 4.5;
      dcM(2.4, 0.04, 1.8, 0x3a6f9a, m4mul(M, m4(px, 0.15, -0.3)));
      dcM(2.5, 0.05, 0.05, 0x2a2a2a, m4mul(M, m4(px, 0.17, 0.4))); dcM(2.5, 0.05, 0.05, 0x2a2a2a, m4mul(M, m4(px, 0.17, -1.0)));
    }
  });
  rf(9.8, 0.14, 0.3, S.trim, 0, H + rise + 0.12, 0);
  [-1, 1].forEach(e => {
    prism(e * 3.8 - 0.2, e * 3.8 + 0.2, H, 4.2, rise + 0.05, S.wall);
    for (let zz = -3.3; zz <= 3.3; zz += 0.6) { // вертикальные доски на фронтоне
      const hh = (rise + 0.05) * (1 - Math.abs(zz) / 4.2) - 0.1;
      if (hh > 0.1) dc(0.05, hh, 0.06, wallDark, e * 4.02, H + hh / 2, zz);
    }
    dc(0.08, 0.7, 0.6, S.trim, e * 4.02, H + 0.85, 0); dc(0.1, 0.62, 0.52, 0x1f2326, e * 4.04, H + 0.85, 0); // чердачное окно
  });

  // Камень снаружи у фронтона: кирпичная труба с оголовком
  { const cz = st === 2 ? -2.3 : 2.4, cxx = sx * 4.55;
    for (let y = 0; y < 5.9; y += 0.5) { const w = y < 1.0 ? 1.1 : 0.9; dc(w, 0.5, w, mulCol(0x77716a, 0.82 + hs(900 + (y * 2 | 0)) * 0.3), cxx, y + 0.25, cz); }
    dc(1.15, 0.12, 1.15, 0x55504a, cxx, 5.96, cz); dc(0.5, 0.3, 0.5, 0x3a3835, cxx, 6.17, cz);
    col(x + cxx - 0.55, x + cxx + 0.55, z + cz - 0.55, z + cz + 0.55);
  }

  // Крыльцо: настил, ступени, столбы с перилами, навес на подкосах
  dc(3.4, 0.14, 1.8, S.floor, 0, 0.07, 4.7);
  for (let i = -3; i <= 3; i++) dc(0.03, 0.02, 1.8, mulCol(S.floor, 0.8), i * 0.48, 0.15, 4.7);
  dc(2.0, 0.07, 0.4, S.floor, 0, 0.035, 5.8); dc(2.2, 0.07, 0.35, mulCol(S.floor, 0.92), 0, 0.105, 5.65);
  [-1, 1].forEach(e => {
    dc(0.16, 2.5, 0.16, S.trim, e * 1.55, 1.25, 5.5);
    dc(0.07, 0.07, 1.5, S.trim, e * 1.62, 0.95, 4.75); // поручень
    for (let k = 0; k < 6; k++) dc(0.05, 0.8, 0.05, trimLight, e * 1.62, 0.55, 4.1 + k * 0.28);
    dc(0.06, 0.06, 0.8, S.trim, e * 1.4, 2.2, 5.1, 0.7, 0, 0); // подкос навеса
  });
  rf(3.8, 0.12, 2.1, S.roof, 0, 2.75, 4.8, 0.1); // навес над крыльцом
  dc(3.8, 0.2, 0.08, S.trim, 0, 2.66, 5.85);
  dc(1.2, 0.02, 0.7, 0x4a3a2a, 0, 0.16, 4.7); // коврик
  { const d2 = hs(11); if (d2 < 0.5) { dc(0.5, 0.45, 0.5, 0x7a4a32, -1.2, 0.37, 5.2); dc(0.42, 0.06, 0.42, 0x3a2a1e, -1.2, 0.62, 5.2); } } // горшок

  // Бочка для дождя с водостоком
  dc(0.1, 3.0, 0.1, 0x5a5f61, 4.2, 1.9, -4.7); dc(0.1, 0.1, 0.4, 0x5a5f61, 4.2, 0.55, -4.85);
  dc(0.62, 0.9, 0.62, 0x3d5a6b, 4.2, 0.45, -5.0); dc(0.62, 0.9, 0.62, 0x3d5a6b, 4.2, 0.45, -5.0, 0, Math.PI / 4, 0);
  dc(0.66, 0.06, 0.66, 0x2a2a2a, 4.2, 0.3, -5.0); dc(0.66, 0.06, 0.66, 0x2a2a2a, 4.2, 0.7, -5.0);

  // Плющ на стене и оборванные провода: больше разрухи у сильно повреждённых домов
  if (hs(12) < 0.6) for (let k = 0; k < 7; k++) {
    const vx = -3.8 + hs(1000 + k) * 0.5, vy = 0.5 + k * 0.38;
    dc(0.5 + hs(1100 + k) * 0.4, 0.3, 0.06, [0x3f6a2f, 0x4a7a35, 0x355a28][k % 3], vx, vy, -4.04 - 0.03, 0, 0, (hs(1200 + k) - 0.5) * 0.8);
  }

  // Балки под крышей и лампа
  [-2.8, 0, 2.8].forEach(px => dc(0.18, 0.22, 7.8, S.trim, px, H - 0.12, 0));
  dc(0.02, 0.9, 0.02, 0x222222, 0, H - 0.57, -0.4); dc(0.34, 0.2, 0.34, 0xd9c27a, 0, H - 1.1, -0.4);

  // Мебель: кровать с изголовьем и тумбой, стол со стульями или печь, стеллаж или кресло, шкаф, кухонный уголок
  dc(1.0, 0.3, 1.95, S.trim, -3.0, 0.15, 2.55);
  dc(0.92, 0.16, 1.8, 0xb9b2a0, -3.0, 0.38, 2.55);
  dc(0.94, 0.06, 1.1, [0x7a3a3a, 0x3a5a7a, 0x5a6a3a][(hs(13) * 3 | 0) % 3], -3.0, 0.5, 2.25);
  dc(0.6, 0.12, 0.35, 0xe6e0d0, -3.0, 0.55, 3.2);
  dc(1.0, 0.85, 0.08, S.trim, -3.0, 0.65, 3.55);
  col(x - 3.5, x - 2.5, z + 1.6, z + 3.5);
  dc(0.45, 0.5, 0.45, S.trim, -2.15, 0.25, 3.3); dc(0.38, 0.03, 0.01, 0x222222, -2.15, 0.35, 3.07); dc(0.12, 0.2, 0.12, 0xd9c27a, -2.15, 0.6, 3.3);
  col(x - 2.38, x - 1.92, z + 3.07, z + 3.53);
  if (st !== 1) { // стол и два стула
    dc(1.0, 0.08, 1.0, 0x7a5a38, 2.9, 0.78, 2.8);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => dc(0.08, 0.75, 0.08, 0x5a4026, 2.9 + a * 0.42, 0.375, 2.8 + b * 0.42));
    col(x + 2.4, x + 3.4, z + 2.3, z + 3.3);
    dc(0.4, 0.05, 0.4, 0x6a4a2a, 2.0, 0.45, 2.8); dc(0.05, 0.5, 0.4, 0x6a4a2a, 1.82, 0.72, 2.8);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => dc(0.04, 0.45, 0.04, 0x5a4026, 2.0 + a * 0.17, 0.225, 2.8 + b * 0.17));
    dc(0.4, 0.05, 0.4, 0x6a4a2a, 2.9, 0.45, 1.95); dc(0.4, 0.5, 0.05, 0x6a4a2a, 2.9, 0.72, 1.77);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => dc(0.04, 0.45, 0.04, 0x5a4026, 2.9 + a * 0.17, 0.225, 1.95 + b * 0.17));
    dc(0.35, 0.18, 0.35, 0xc9c0a8, 2.9, 0.91, 2.8); // тарелка с чем-то
  } else { // дровяная печь с трубой через крышу
    dc(0.7, 0.8, 0.7, 0x2a2a2c, 3.0, 0.4, 2.8); dc(0.5, 0.35, 0.02, 0x6a3a1a, 2.64, 0.4, 2.8, 0, Math.PI / 2, 0); dc(0.74, 0.05, 0.74, 0x3a3a3c, 3.0, 0.82, 2.8);
    dc(0.14, 4.3, 0.14, 0x2a2a2c, 3.0, 3.0, 2.8); dc(0.3, 0.12, 0.3, 0x2a2a2c, 3.0, 5.2, 2.8);
    col(x + 2.65, x + 3.35, z + 2.45, z + 3.15);
  }
  if (st !== 0) { // стеллаж с банками
    [0.3, 0.8, 1.3, 1.8].forEach(yy => dc(0.5, 0.06, 2.0, 0x6a4a2a, -3.3, yy, -2.0));
    [-1, 1].forEach(sz => dc(0.5, 1.85, 0.06, 0x5a4026, -3.3, 0.92, -2.0 + sz));
    for (let i = 0; i < 7; i++) dc(0.12, 0.16, 0.12, [0xc2552a, 0x6b8f3a, 0xc9a227][i % 3], -3.3, 0.38 + (i % 3) * 0.5, -2.7 + i * 0.22);
    col(x - 3.55, x - 3.05, z - 3.0, z - 1.0);
  } else { // кресло и торшер
    dc(0.8, 0.4, 0.8, [0x6a4a3a, 0x4a5a3a, 0x5a3a3a][(hs(14) * 3 | 0) % 3], -3.0, 0.2, -2.2); dc(0.15, 0.75, 0.8, 0x5a3a2a, -3.35, 0.65, -2.2); dc(0.8, 0.3, 0.12, 0x5a3a2a, -3.0, 0.5, -1.85);
    dc(0.05, 1.5, 0.05, 0x2a2a2a, -3.4, 0.75, -3.1); dc(0.35, 0.3, 0.35, 0xd9c27a, -3.4, 1.6, -3.1);
    col(x - 3.4, x - 2.6, z - 2.6, z - 1.8);
  }
  dc(0.8, 1.9, 1.3, 0x5a4026, 3.15, 0.95, -2.9); dc(0.02, 1.8, 0.6, 0x4a3420, 2.74, 0.95, -3.2); dc(0.02, 1.8, 0.6, 0x4a3420, 2.74, 0.95, -2.6);
  dc(0.05, 0.14, 0.05, 0xc9a227, 2.72, 1.0, -2.95); dc(0.05, 0.14, 0.05, 0xc9a227, 2.72, 1.0, -2.85);
  col(x + 2.75, x + 3.55, z - 3.55, z - 2.25);
  dc(1.5, 0.88, 0.6, 0x6a5a48, 1.95, 0.44, -3.3); dc(1.56, 0.05, 0.66, 0xb9b2a0, 1.95, 0.9, -3.3); dc(0.5, 0.02, 0.36, 0x2f3236, 1.6, 0.935, -3.3);
  dc(0.04, 0.2, 0.04, 0x9aa0a4, 1.6, 1.05, -3.45); dc(0.3, 0.02, 0.3, 0x2a2a2a, 2.35, 0.935, -3.3);
  col(x + 1.2, x + 2.7, z - 3.6, z - 3.0);
  dc(3.0, 0.02, 2.0, [0x6a2f2a, 0x2f4a5a, 0x4a4a2a][(hs(15) * 3 | 0) % 3], 0.2, 0.04, 0.3); dc(2.8, 0.025, 1.8, 0xc9b38a, 0.2, 0.045, 0.3); // ковёр
  dc(0.04, 0.6, 0.8, 0x4a3a2a, 3.56, 1.7, 0.6); dc(0.045, 0.5, 0.7, 0x7a8a6a, 3.57, 1.7, 0.6); // картина на стене

  finish();
}

for (let i = 0; i < 8; i++) {
  const x = (Math.random() - 0.5) * 200, z = (Math.random() - 0.5) * 200;
  if ((Math.abs(x) < 15 && Math.abs(z) < 15) || Math.abs(x) < 8 || Math.abs(z) < 8) continue;
  buildHouse(x, z, i % 3);
  // деревья внутри дома и на крыльце убираем
  for (let k = trees.length - 1; k >= 0; k--) {
    const t = trees[k];
    if (Math.abs(t.trunk.position.x - x) < 6.5 && Math.abs(t.trunk.position.z - z) < 7.5) {
      scene.remove(t.trunk); scene.remove(t.crown);
      removeFrom(colliders, t.collider); removeFrom(blockers, t.trunk);
      trees.splice(k, 1);
    }
  }
  housePositions.push({ x, z });
}

// --- Дороги, пятна травы, камни и кусты ---
{
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x6f6350, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  [[400, 7], [7, 400]].forEach(([w, d]) => {
    const r = new THREE.Mesh(new THREE.PlaneGeometry(w, d), roadMat);
    r.rotation.x = -Math.PI / 2; r.position.y = 0.02; scene.add(r);
  });
  const greens = [0x566a41, 0x5f7249, 0x4f6339, 0x66784c];
  for (let i = 0; i < 90; i++) {
    const mt = new THREE.MeshStandardMaterial({ color: greens[i % 4], roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false });
    const p = new THREE.Mesh(new THREE.CircleGeometry(3 + Math.random() * 7, 9), mt);
    p.rotation.x = -Math.PI / 2; p.position.set((Math.random() - 0.5) * 300, 0.01, (Math.random() - 0.5) * 300); scene.add(p);
  }
  const free = (x, z) => !colliders.some(c => x > c.minX - 1 && x < c.maxX + 1 && z > c.minZ - 1 && z < c.maxZ + 1);
  for (let i = 0; i < 80; i++) {
    const x = (Math.random() - 0.5) * 300, z = (Math.random() - 0.5) * 300;
    if ((Math.abs(x) < 8 && Math.abs(z) < 8) || !free(x, z)) continue;
    const r = 0.3 + Math.random() * 0.7;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), new THREE.MeshStandardMaterial({ color: 0x77777a + Math.floor(Math.random() * 4) * 0x080808, roughness: 1, flatShading: true }));
    rock.scale.set(1, 0.6, 1); rock.position.set(x, r * 0.35, z); rock.rotation.y = Math.random() * 6; scene.add(rock);
  }
  for (let i = 0; i < 110; i++) {
    const x = (Math.random() - 0.5) * 300, z = (Math.random() - 0.5) * 300;
    if ((Math.abs(x) < 8 && Math.abs(z) < 8) || !free(x, z)) continue;
    const r = 0.4 + Math.random() * 0.5;
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), new THREE.MeshStandardMaterial({ color: 0x2f5a2a + (Math.floor(Math.random() * 3) << 8), roughness: 1, flatShading: true }));
    bush.scale.y = 0.8; bush.position.set(x, r * 0.6, z); scene.add(bush);
  }
}

// --- Зомби ---
const zombies = [];
// --- Типы зомби: обычный, бегун, громила, вздутый (взрывается), солдат (броня) ---
const ZTYPES = {
  normal:  { name: 'Зомби',   hp: 3,  speed: 2.0, dmg: 10, sx: 1.0,  sy: 1.0,  skin: 0x6b8f5a, eye: 0xff2a1a },
  runner:  { name: 'Бегун',   hp: 2,  speed: 4.3, dmg: 7,  sx: 0.86, sy: 0.96, skin: 0x9a7a62, eye: 0xff9a1a },
  brute:   { name: 'Громила', hp: 10, speed: 1.5, dmg: 25, sx: 1.45, sy: 1.38, skin: 0x5a7a4a, eye: 0xff4a1a },
  bloater: { name: 'Вздутый', hp: 4,  speed: 1.8, dmg: 8,  sx: 1.12, sy: 1.08, skin: 0xb0bf4a, eye: 0xd8ff30, explode: 3.5 },
  soldier: { name: 'Солдат',  hp: 6,  speed: 2.2, dmg: 12, sx: 1.0,  sy: 1.02, skin: 0x6b8f5a, eye: 0xff2a1a, armor: true },
};
function pickZombieType(night) { // ночью больше опасных
  const r = Math.random();
  if (night) return r < 0.4 ? 'normal' : r < 0.65 ? 'runner' : r < 0.8 ? 'brute' : r < 0.92 ? 'bloater' : 'normal';
  return r < 0.65 ? 'normal' : r < 0.82 ? 'runner' : r < 0.9 ? 'brute' : r < 0.97 ? 'bloater' : 'normal';
}
// --- Зомби: части тела склеены в меши с цветами вершин, материалы общие для всех зомби ---
// Вариации (волосы, раны, рюкзак, босые ноги) считаются из чисел, которые spawnZombie и так получает от Math.random:
// количество и порядок вызовов Math.random не менялись, поэтому мир из сохранений не сдвигается.
const zombieMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
const zombieEyeMat = new THREE.MeshBasicMaterial({ vertexColors: true });
const bellyGeo = new THREE.SphereGeometry(0.5, 10, 8);
const bellyMat = new THREE.MeshStandardMaterial({ color: 0xc8d45a, roughness: 0.5, flatShading: true });
[zombieMat, zombieEyeMat, bellyGeo, bellyMat].forEach(o => { o.userData.shared = true; }); // их не освобождаем вместе с зомби

const Z_CORNERS = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const Z_QUADS = [[1, 2, 6, 5], [0, 4, 7, 3], [3, 7, 6, 2], [0, 1, 5, 4], [4, 5, 6, 7], [0, 3, 2, 1]];
function zBoxes(rnd, ao) { // набор коробок одной части тела -> один меш; ao(y) затемняет низ части (грязь)
  const P = [], N = [], C = [], cc = new THREE.Color();
  function face(pts, cen, rgb) { // нормаль наружу, порядок вершин против часовой
    const ux = pts[1][0] - pts[0][0], uy = pts[1][1] - pts[0][1], uz = pts[1][2] - pts[0][2];
    const vx = pts[2][0] - pts[0][0], vy = pts[2][1] - pts[0][1], vz = pts[2][2] - pts[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    let mx = 0, my = 0, mz = 0; pts.forEach(p => { mx += p[0]; my += p[1]; mz += p[2]; });
    mx /= pts.length; my /= pts.length; mz /= pts.length;
    if (nx * (mx - cen[0]) + ny * (my - cen[1]) + nz * (mz - cen[2]) < 0) { pts = pts.slice().reverse(); nx = -nx; ny = -ny; nz = -nz; }
    for (let i = 1; i < pts.length - 1; i++) for (const p of [pts[0], pts[i], pts[i + 1]]) {
      P.push(p[0], p[1], p[2]); N.push(nx, ny, nz);
      const k = ao ? ao(p[1]) : 1; C.push(rgb[0] * k, rgb[1] * k, rgb[2] * k);
    }
  }
  const api = {
    base: null, // общая матрица (для зданий и техники: можно собрать деталь в своих осях и повернуть целиком)
    boxM(w, h, d, color, M) { // коробка по готовой матрице 4x4 (нужна для деталей вдоль произвольного направления)
      if (api.base) M = m4mul(api.base, M);
      const j = 1 + (rnd() - 0.5) * 0.08;
      cc.setHex(color); const rgb = [cc.r * j, cc.g * j, cc.b * j];
      const pts = Z_CORNERS.map(([sx, sy, sz]) => {
        const px = sx * w / 2, py = sy * h / 2, pz = sz * d / 2;
        return [M[0] * px + M[4] * py + M[8] * pz + M[12], M[1] * px + M[5] * py + M[9] * pz + M[13], M[2] * px + M[6] * py + M[10] * pz + M[14]];
      });
      for (const q of Z_QUADS) face(q.map(i => pts[i]), [M[12], M[13], M[14]], rgb);
    },
    box(w, h, d, color, x, y, z, rx = 0, ry = 0, rz = 0) { api.boxM(w, h, d, color, m4(x, y, z, rx, ry, rz)); },
    prism(pts, depth, color, x, y, z, rx = 0, ry = 0, rz = 0) { // многоугольник (выпуклый или звёздчатый) в плоскости XY, выдавленный на depth по Z
      let M = m4(x, y, z, rx, ry, rz); if (api.base) M = m4mul(api.base, M);
      const j = 1 + (rnd() - 0.5) * 0.08;
      cc.setHex(color); const rgb = [cc.r * j, cc.g * j, cc.b * j];
      const tr = (u, v, w) => [M[0] * u + M[4] * v + M[8] * w + M[12], M[1] * u + M[5] * v + M[9] * w + M[13], M[2] * u + M[6] * v + M[10] * w + M[14]];
      let cu = 0, cv = 0; pts.forEach(q => { cu += q[0]; cv += q[1]; }); cu /= pts.length; cv /= pts.length;
      const cen = [M[12] + M[4] * cv + M[0] * cu, M[13] + M[5] * cv + M[1] * cu, M[14] + M[6] * cv + M[2] * cu], hd = depth / 2;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        face([tr(cu, cv, hd), tr(a[0], a[1], hd), tr(b[0], b[1], hd)], cen, rgb);
        face([tr(cu, cv, -hd), tr(a[0], a[1], -hd), tr(b[0], b[1], -hd)], cen, rgb);
        face([tr(a[0], a[1], hd), tr(b[0], b[1], hd), tr(b[0], b[1], -hd), tr(a[0], a[1], -hd)], cen, rgb);
      }
    },
    frustum(r0, r1, h, seg, color, M, cap = true) { // усечённый конус вдоль оси Y, центр в начале M (r1 = 0 даёт конус)
      if (api.base) M = m4mul(api.base, M);
      const j = 1 + (rnd() - 0.5) * 0.08;
      cc.setHex(color); const rgb = [cc.r * j, cc.g * j, cc.b * j];
      const tr = (px, py, pz) => [M[0] * px + M[4] * py + M[8] * pz + M[12], M[1] * px + M[5] * py + M[9] * pz + M[13], M[2] * px + M[6] * py + M[10] * pz + M[14]];
      const cen = [M[12], M[13], M[14]], hh = h / 2;
      for (let i = 0; i < seg; i++) {
        const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const b0 = tr(c0 * r0, -hh, s0 * r0), b1 = tr(c1 * r0, -hh, s1 * r0), t0 = tr(c0 * r1, hh, s0 * r1), t1 = tr(c1 * r1, hh, s1 * r1);
        face([b0, b1, t1, t0], cen, rgb);
        if (cap) { if (r1 > 0) face([tr(0, hh, 0), t0, t1], cen, rgb); if (r0 > 0) face([tr(0, -hh, 0), b0, b1], cen, rgb); }
      }
    },
    cyl(r, h, color, x, y0, z, seg = 10, cap = true) { api.frustum(r, r, h, seg, color, m4(x, y0 + h / 2, z), cap); }, // вертикальный цилиндр, y0 - низ
    cone(r0, r1, h, color, x, y0, z, seg = 10) { api.frustum(r0, r1, h, seg, color, m4(x, y0 + h / 2, z)); },
    cylX(r, len, color, x, y, z, seg = 10, cap = true) { api.frustum(r, r, len, seg, color, m4(x, y, z, 0, 0, Math.PI / 2), cap); }, // лежит вдоль X, центр в (x,y,z)
    cylZ(r, len, color, x, y, z, seg = 10, cap = true) { api.frustum(r, r, len, seg, color, m4(x, y, z, Math.PI / 2, 0, 0), cap); }, // лежит вдоль Z
    tube(p1, p2, r, color, seg = 6, cap = false) { // труба или стержень между двумя точками
      const dx = p2[0] - p1[0], dy = p2[1] - p1[1], dz = p2[2] - p1[2], len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) return;
      const y = [dx / len, dy / len, dz / len], hp = Math.abs(y[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
      let x = [hp[1] * y[2] - hp[2] * y[1], hp[2] * y[0] - hp[0] * y[2], hp[0] * y[1] - hp[1] * y[0]]; const lx = Math.hypot(x[0], x[1], x[2]); x = x.map(v => v / lx);
      const zz = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
      api.frustum(r, r, len, seg, color, [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, zz[0], zz[1], zz[2], 0, (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2, 1], cap);
    },
    gable(W, D, rise, color, x, y, z, ov = 0) { // призма двускатной крыши: коньком вдоль X, низ на высоте y
      api.prism([[-D / 2 - ov, 0], [D / 2 + ov, 0], [0, rise]], W, color, x, y, z, 0, Math.PI / 2, 0);
    },
    blob(r, color, M, sx = 1, sy = 1, sz = 1, detail = 0, jit = 0.18) { // бугристый шар (кроны, кусты, валуны); color - число или функция(ny, номер грани) -> число
      if (api.base) M = m4mul(api.base, M);
      const gp = new THREE.IcosahedronGeometry(1, detail).attributes.position, vs = [];
      for (let i = 0; i < gp.count; i++) {
        const x = gp.getX(i), y = gp.getY(i), z = gp.getZ(i), hh = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453, k = r * (1 + ((hh - Math.floor(hh)) - 0.5) * 2 * jit);
        const px = x * k * sx, py = y * k * sy, pz = z * k * sz;
        vs.push([M[0] * px + M[4] * py + M[8] * pz + M[12], M[1] * px + M[5] * py + M[9] * pz + M[13], M[2] * px + M[6] * py + M[10] * pz + M[14]]);
      }
      const cen = [M[12], M[13], M[14]];
      for (let i = 0; i < vs.length; i += 3) {
        const a = vs[i], b = vs[i + 1], c = vs[i + 2];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; ny /= l;
        const mx = (a[0] + b[0] + c[0]) / 3 - cen[0], my = (a[1] + b[1] + c[1]) / 3 - cen[1], mz = (a[2] + b[2] + c[2]) / 3 - cen[2];
        if (nx * mx + ny * l * my + nz * mz < 0) ny = -ny;
        const hex = typeof color === 'function' ? color(ny, i / 3) : color, hh = Math.sin(i * 12.9898 + vs[i][0] * 78.233) * 43758.5453, j = 0.93 + (hh - Math.floor(hh)) * 0.14;
        cc.setHex(hex); face([a, b, c], cen, [cc.r * j, cc.g * j, cc.b * j]);
      }
    },
    count() { return P.length / 3; },
    mesh(mat) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      return new THREE.Mesh(geo, mat);
    },
  };
  return api;
}
function mulberry(seed) { // маленький генератор случайных чисел: не трогает Math.random
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Собирает зомби: g -> torso (голова и руки на нём, наклоняются вместе) и ноги. Начало координат у ног, лицо смотрит в +Z.
function buildZombie(type, rnd, skinHex, shirtHex, pantsHex, eyeHex) {
  const g = new THREE.Group();
  g.rotation.order = 'YXZ'; // наклон при падении считается относительно направления взгляда, а не мировой оси
  const isRun = type === 'runner', isBrute = type === 'brute', isSold = type === 'soldier', isBloat = type === 'bloater';
  const sk = skinHex, skD = mulCol(sk, 0.7), skL = mulCol(sk, 1.12);
  const shD = mulCol(shirtHex, 0.72), shL = mulCol(shirtHex, 1.22), pnD = mulCol(pantsHex, 0.72);
  const BONE = 0xd8d0b8, BLOOD = 0x6a1010, BLOOD_D = 0x3f0a0a;
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const grp = (x, y, z) => { const o = new THREE.Group(); o.position.set(x, y, z); return o; };
  const dirt = lo => y => lo + (1 - lo) * Math.min(1, Math.max(0, (y + 0.95) / 0.95)); // внизу темнее
  const lw = isRun ? 0.82 : 1; // бегун худой

  // --- Торс (начало координат на уровне y=1.45) ---
  const torso = grp(0, 1.45, 0), T = zBoxes(rnd, y => 0.84 + 0.16 * Math.min(1, Math.max(0, (y + 0.55) / 1.1)));
  const cw = isRun ? 0.62 : isSold ? 0.74 : 0.7;
  if (isRun) { // тощий: рёбра и позвоночник, лохмотья вместо рубашки
    T.box(cw, 0.56, 0.38, sk, 0, 0.2, 0); T.box(cw - 0.08, 0.46, 0.34, skD, 0, -0.26, 0);
    for (let k = 0; k < 4; k++) T.box(cw - 0.14, 0.04, 0.02, BONE, 0, 0.38 - k * 0.12, 0.2);
    for (let k = 0; k < 5; k++) T.box(0.07, 0.06, 0.05, BONE, 0, 0.42 - k * 0.15, -0.2);
    [-1, 0, 1].forEach(k => T.box(0.14, 0.34 + rnd() * 0.2, 0.04, shirtHex, k * 0.2, 0.15, 0.19)); // лохмотья спереди
    T.box(0.5, 0.3, 0.04, shD, -0.04, 0.2, -0.19);
  } else {
    T.box(cw, 0.56, 0.4, shirtHex, 0, 0.2, 0); T.box(cw - 0.08, isBloat ? 0.3 : 0.46, 0.36, shirtHex, 0, isBloat ? -0.18 : -0.26, 0);
    [-1, 1].forEach(sd => T.box(0.27, 0.18, 0.32, shirtHex, sd * 0.4, 0.42, 0));     // плечи
    T.box(0.16, 0.14, 0.02, shL, -0.2, 0.1, 0.205);                                    // карман
    T.box(0.22, 0.3, 0.02, skD, 0.18, -0.05, 0.205); T.box(0.12, 0.18, 0.02, BLOOD, 0.18, -0.05, 0.215); T.box(0.14, 0.03, 0.02, BONE, 0.18, 0.04, 0.222); // дыра в рубашке, рана
    T.box(0.16, 0.14, 0.02, sk, -0.2, 0.36, 0.205);                                    // дыра на плече
    for (let k = 0; k < 3; k++) T.box(0.1 + rnd() * 0.14, 0.1 + rnd() * 0.16, 0.02, BLOOD_D, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.6, 0.208); // кровь
    for (let k = -3; k <= 3; k++) T.box(0.1, 0.05 + rnd() * 0.12, 0.38, shD, k * 0.095, -0.5, 0);        // рваный подол
  }
  T.box(0.34, 0.08, 0.3, isRun ? sk : shD, 0, 0.5, 0.02); T.box(0.2, 0.16, 0.2, sk, 0, 0.58, 0.02);   // воротник, шея
  if (!isBloat) { T.box(cw + 0.02, 0.1, 0.4, 0x1f2a1f, 0, -0.52, 0); T.box(0.1, 0.07, 0.02, 0xc9a227, 0, -0.52, 0.21); } // ремень
  if (isSold) { // бронежилет, подсумки, рюкзак со скаткой
    T.box(0.8, 0.62, 0.46, 0x2f3a22, 0, 0.1, 0); T.box(0.42, 0.3, 0.05, 0x3a4a32, 0, 0.2, 0.25);
    [-1, 1].forEach(sd => { T.box(0.16, 0.14, 0.08, 0x55603a, sd * 0.2, -0.14, 0.26); T.box(0.12, 0.1, 0.44, 0x2f3a22, sd * 0.25, 0.44, 0); });
    T.box(0.5, 0.5, 0.24, 0x3a4228, 0, 0.05, -0.34); T.box(0.5, 0.14, 0.14, 0x55603a, 0, 0.42, -0.4);
  } else if (isBrute) { // горб, цепь вместо ремня, наплечники с шипами
    T.box(0.56, 0.32, 0.3, shirtHex, 0, 0.5, -0.28);
    T.box(0.78, 0.06, 0.44, 0x555555, 0, -0.2, 0); T.box(0.1, 0.16, 0.04, 0x666666, 0.2, -0.3, 0.22);
    [-1, 1].forEach(sd => { T.box(0.4, 0.22, 0.4, 0x2a2a2a, sd * 0.52, 0.52, 0); T.box(0.07, 0.2, 0.07, 0xa0a0a0, sd * 0.52, 0.72, 0); T.box(0.05, 0.14, 0.05, 0xa0a0a0, sd * 0.62, 0.68, 0.08, 0, 0, sd * -0.5); });
  } else if (!isRun && !isBloat && rnd() < 0.3) { // рюкзак
    T.box(0.5, 0.52, 0.22, pick([0x4a3a2a, 0x3a4a5a, 0x5a2a2a]), 0, 0.1, -0.3); T.box(0.04, 0.4, 0.04, 0x1a1a1a, -0.18, 0.2, 0.2); T.box(0.04, 0.4, 0.04, 0x1a1a1a, 0.18, 0.2, 0.2);
  }
  torso.add(T.mesh(zombieMat));

  // --- Голова (центр головы, локально от торса y=+0.7) ---
  const head = grp(0, 0.7, 0.02), Hd = zBoxes(rnd), Ey = zBoxes(rnd);
  Hd.box(0.44, 0.36, 0.44, sk, 0, 0.04, 0);
  if (isRun) Hd.box(0.36, 0.2, 0.34, skL, 0.04, -0.22, 0.05, 0, 0, 0.12); // вывихнутая челюсть
  else Hd.box(0.38, 0.15, 0.38, skL, 0, -0.18, 0.03);
  Hd.box(0.46, 0.06, 0.08, skD, 0, 0.1, 0.22);                              // надбровья
  [-1, 1].forEach(sd => { Hd.box(0.14, 0.1, 0.04, 0x1a0f0f, sd * 0.11, 0.04, 0.225); Hd.box(0.03, 0.14, 0.02, mulCol(sk, 0.6), sd * 0.19, -0.08, 0.222); }); // глазницы, вены
  Hd.box(0.07, 0.12, 0.08, skD, 0, -0.04, 0.235);                           // нос
  [-1, 1].forEach(sd => { if (sd === 1 && rnd() < 0.35) Hd.box(0.05, 0.1, 0.07, BLOOD, 0.245, -0.02, 0); else Hd.box(0.05, 0.12, 0.09, sk, sd * 0.245, -0.02, 0); }); // уши, одно может быть оторвано
  Hd.box(0.26, 0.08, 0.04, 0x1a0f0f, 0, -0.17, 0.205);                      // рот
  for (let k = 0; k < 4; k++) Hd.box(0.04, 0.05, 0.03, 0xe6dfc8, -0.09 + k * 0.06, -0.14, 0.2);
  for (let k = 0; k < 3; k++) Hd.box(0.04, 0.04, 0.03, 0xe6dfc8, -0.06 + k * 0.06, -0.2, 0.2);
  Hd.box(0.12, 0.16, 0.03, BLOOD, (rnd() - 0.5) * 0.1, -0.3, 0.2);          // кровь на подбородке
  if (rnd() < 0.3) Hd.box(0.16, 0.1, 0.02, BONE, (rnd() - 0.5) * 0.2, 0.2, 0.225); // видна кость
  Ey.box(0.1, 0.07, 0.03, eyeHex, -0.11, 0.04, 0.245); Ey.box(0.1, 0.07, 0.03, eyeHex, 0.11, 0.04, 0.245);
  if (isBrute) { [-1, 1].forEach(sd => Hd.box(0.05, 0.14, 0.05, 0xe0d8c0, sd * 0.1, -0.22, 0.22)); Hd.box(0.04, 0.3, 0.02, 0x7a2a2a, 0.18, 0.1, 0.228); } // клыки, шрам
  if (isBloat) { for (let k = 0; k < 3; k++) Hd.box(0.08, 0.08, 0.06, 0xd8d060, (k - 1) * 0.14, 0.18 - k * 0.04, 0.23); }       // нарывы
  if (isSold) { // каска, ремешок, козырёк
    Hd.box(0.52, 0.2, 0.52, 0x3f4a2c, 0, 0.27, 0); Hd.box(0.54, 0.06, 0.56, 0x343d24, 0, 0.18, 0.02); Hd.box(0.4, 0.06, 0.04, 0x14181a, 0, 0.14, 0.27);
    [-1, 1].forEach(sd => Hd.box(0.04, 0.2, 0.04, 0x14181a, sd * 0.2, -0.06, 0.18));
  } else {
    const hair = pick([0x2b2118, 0x1a1a1a, 0x4a3a28, 0x6a5a3a, 0x7a7a72]), style = isRun ? 2 : Math.floor(rnd() * 4);
    if (style === 1 || style === 2) { Hd.box(0.48, 0.1, 0.48, hair, 0, 0.25, 0); Hd.box(0.5, 0.2, 0.1, hair, 0, 0.14, -0.21); }
    if (style === 2) { Hd.box(0.46, 0.5, 0.08, hair, 0, -0.08, -0.25); [-1, 1].forEach(sd => Hd.box(0.06, 0.4, 0.14, hair, sd * 0.25, -0.02, -0.08)); }
    if (style === 3) { Hd.box(0.3, 0.08, 0.3, hair, (rnd() - 0.5) * 0.15, 0.25, 0); }
    if (style === 0) { [-1, 1].forEach(sd => Hd.box(0.05, 0.1, 0.1, hair, sd * 0.24, 0.1, -0.02)); }
  }
  head.add(Hd.mesh(zombieMat), Ey.mesh(zombieEyeMat));
  torso.add(head);

  // --- Руки: плечо с рукавом и предплечье с кистью на локте; вращаются вокруг плеча и локтя ---
  const arm = sd => {
    const a = grp(sd * (0.46 * (isBrute ? 1.04 : 1)), 0.37, 0), fo = grp(0, -0.36, 0);
    const A = zBoxes(rnd, dirt(0.7)), F = zBoxes(rnd, y => dirt(0.7)(y - 0.36)), short = !isSold && rnd() < 0.3;
    const sleeve = isRun ? skD : shirtHex;
    A.box(0.2 * lw, 0.36, 0.2 * lw, short ? sk : sleeve, 0, -0.18, 0);
    if (short) A.box(0.22 * lw, 0.12, 0.22 * lw, sleeve, 0, -0.06, 0);
    else A.box(0.22 * lw, 0.06, 0.22 * lw, shD, 0, -0.33, 0);                    // рваный край рукава
    F.box(0.17 * lw, 0.12, 0.17 * lw, sk, 0, 0, 0);                                // локоть: скрывает стык
    F.box(0.17 * lw, 0.36, 0.17 * lw, sk, 0, -0.18, 0);
    if (rnd() < 0.5) { F.box(0.19 * lw, 0.12, 0.19 * lw, BLOOD, 0, -0.14, 0); F.box(0.05, 0.14, 0.05, BONE, 0.04, -0.3, 0.06); } // рана с костью
    const hand = isSold ? 0x1a1a1a : sk, hs = isBrute ? 1.35 : 1;
    F.box(0.15 * hs, 0.14, 0.15 * hs, hand, 0, -0.41, 0);
    for (let k = 0; k < 3; k++) F.box(0.035 * hs, 0.12, 0.04 * hs, isSold ? 0x111111 : skD, (-0.045 + k * 0.045) * hs, -0.54, 0.03, 0.35, 0, 0);
    if (isBrute) { F.box(0.24, 0.08, 0.24, 0x3a3a3a, 0, -0.34, 0); F.box(0.05, 0.16, 0.05, 0x555555, 0, -0.46, 0.14); } // кандалы
    fo.add(F.mesh(zombieMat)); a.add(A.mesh(zombieMat), fo); a.fore = fo; torso.add(a); return a;
  };
  const armL = arm(-1), armR = arm(1);
  g.add(torso);

  // --- Ноги: бедро и голень на колене; штанины, дыры на коленях, ботинки или босые ступни ---
  const leg = sd => {
    const l = grp(sd * 0.17, 0.95, 0), sh = grp(0, -0.5, 0);
    const L = zBoxes(rnd, dirt(0.62)), S2 = zBoxes(rnd, y => dirt(0.62)(y - 0.5)), shorts = isBrute || rnd() < 0.15, bare = !isSold && rnd() < 0.2;
    L.box(0.27 * lw, 0.5, 0.29 * lw, pantsHex, 0, -0.25, 0);
    S2.box(0.26 * lw, 0.1, 0.28 * lw, shorts ? sk : pantsHex, 0, 0, 0);          // колено: скрывает стык
    S2.box(0.25 * lw, 0.4, 0.27 * lw, shorts ? sk : pantsHex, 0, -0.2, 0);
    if (!shorts) { S2.box(0.2, 0.13, 0.02, sk, 0, -0.04, 0.145 * lw); S2.box(0.28 * lw, 0.06, 0.3 * lw, pnD, 0, -0.36, 0); }
    if (isSold) S2.box(0.27, 0.15, 0.08, 0x2a2e24, 0, 0, 0.17);                    // наколенник
    if (bare) { S2.box(0.26, 0.1, 0.34, sk, 0, -0.41, 0.04); for (let k = 0; k < 3; k++) S2.box(0.06, 0.05, 0.06, skD, -0.08 + k * 0.08, -0.43, 0.23); }
    else { S2.box(0.28, 0.14, 0.38, isSold ? 0x14110d : 0x1a1410, 0, -0.4, 0.05); S2.box(0.29, 0.04, 0.39, 0x0e0a08, 0, -0.46, 0.05); }
    sh.add(S2.mesh(zombieMat)); l.add(L.mesh(zombieMat), sh); l.shin = sh; g.add(l); return l;
  };
  const legL = leg(-1), legR = leg(1);

  const parts = { body: torso, head, headY: 0.7, armL, armR, legL, legR };
  armL.rotation.x = armR.rotation.x = -1.35;
  if (isBloat) { // раздутый живот и светящиеся волдыри
    const belly = new THREE.Mesh(bellyGeo, bellyMat);
    belly.position.set(0, 1.25, 0.1); belly.scale.set(1.2, 1, 0.9); g.add(belly); parts.belly = belly;
    const G = zBoxes(rnd);
    [[-0.3, 1.4, 0.5], [0.25, 1.1, 0.52], [0.05, 1.55, 0.45], [0.38, 1.35, 0.4], [-0.15, 1.15, 0.56]].forEach(([bx, by, bz]) => G.box(0.14, 0.14, 0.14, 0xe8f08a, bx, by, bz, 0.5, 0.6, 0));
    [-0.32, 0.3].forEach(bx => G.box(0.03, 0.22, 0.03, 0x9acc2a, bx, 0.95, 0.5)); // стекающая слизь
    g.add(G.mesh(zombieEyeMat));
  }
  return { group: g, parts };
}
function spawnZombie(ax, az, forcedType) {
  const type = forcedType && ZTYPES[forcedType] ? forcedType : pickZombieType(false);
  const cfg = ZTYPES[type];
  const shirts = type === 'runner' ? [0x7a2f2f, 0x5a2a2a, 0x6a3a2a] : type === 'soldier' ? [0x4a5230, 0x55603a] : type === 'brute' ? [0x3a3a3a, 0x4a3a2a] : type === 'bloater' ? [0x6a6a3a, 0x7a7a4a] : [0x3a4a6a, 0x6a3a3a, 0x4a5a3a, 0x55504a, 0x3a3a55];
  const skin = new THREE.Color(cfg.skin).offsetHSL((Math.random() - 0.5) * 0.05, 0, (Math.random() - 0.5) * 0.08);
  const shirt = shirts[Math.floor(Math.random() * shirts.length)];
  const a = Math.random() * Math.PI * 2, r = 25 + Math.random() * 40;
  const phase = Math.random() * 6;           // порядок и число вызовов Math.random прежние (мир из сохранений от них зависит)
  const rnd = mulberry((Math.imul(Math.floor(a * 1e6), 2654435761) ^ Math.floor(phase * 1e6) ^ (Math.floor(r * 1e4) << 7) ^ Math.imul(zombieUid, 40503)) >>> 0);
  const model = buildZombie(type, rnd, skin.getHex(), shirt, type === 'soldier' ? 0x3f4a2c : 0x2a2a2a, cfg.eye);
  const g = model.group;
  g.scale.set(cfg.sx, cfg.sy, cfg.sx);
  if (ax !== undefined) g.position.set(ax, terrainY(ax, az), az); else g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
  resolveCollisions(g.position, 0.6 * cfg.sx);
  scene.add(g);
  const zo = { mesh: g, hp: cfg.hp, cooldown: 0, parts: model.parts, phase, id: zombieUid++, mv: 0, type, cfg };
  zombies.push(zo);
  return zo;
}
// Походка по типам: stride - размах ног, knee - сгиб колена, lean - наклон вперёд, bob - подпрыгивание корпуса, arm - размах рук, speed - темп шага
const ZGAIT = {
  normal:  { stride: 0.55, knee: 0.8,  lean: 0.12, bob: 0.03,  arm: 0.12, speed: 1.0 },
  runner:  { stride: 0.95, knee: 1.25, lean: 0.34, bob: 0.05,  arm: 0.45, speed: 1.0 },
  brute:   { stride: 0.42, knee: 0.55, lean: 0.10, bob: 0.06,  arm: 0.08, speed: 0.8 },
  bloater: { stride: 0.40, knee: 0.5,  lean: 0.06, bob: 0.04,  arm: 0.10, speed: 0.8 },
  soldier: { stride: 0.55, knee: 0.9,  lean: 0.07, bob: 0.025, arm: 0.10, speed: 1.0 },
};
const ssm = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); }; // плавная ступенька
const ZOMBIE_ATTACK = 0.55; // длительность замаха и удара
function animateZombie(z, moving, dt) { // ходьба с коленями и локтями, раскачивание, взгляд по сторонам, замах при укусе, вздрагивание от попаданий
  const p = z.parts, cfg = z.cfg, G = ZGAIT[z.type] || ZGAIT.normal;
  z.phase += dt * (moving ? 7 * Math.max(0.7, Math.min(2.0, cfg.speed / 2)) * G.speed : 1.5);
  const ph = z.phase, s = Math.sin(ph), c = Math.cos(ph), m = moving ? 1 : 0;
  let up = 0, hit = 0, flinch = 0;                       // замах (руки вверх), удар (руки вниз), вздрагивание
  if (z.attackT > 0) { z.attackT -= dt; const t = 1 - Math.max(0, z.attackT) / ZOMBIE_ATTACK; up = ssm(0, 0.3, t) * (1 - ssm(0.3, 0.45, t)); hit = ssm(0.3, 0.45, t) * (1 - ssm(0.55, 1, t)); }
  if (z.hitT > 0) { z.hitT -= dt; flinch = Math.max(0, z.hitT) / 0.28; }
  // ноги: бедро качается, колено сгибается, когда нога идёт вперёд
  p.legL.rotation.x = s * G.stride * m + 0.02 * Math.sin(ph * 0.5) * (1 - m);
  p.legR.rotation.x = -s * G.stride * m;
  p.legL.shin.rotation.x = 0.06 + Math.max(0, -c) * G.knee * m;
  p.legR.shin.rotation.x = 0.06 + Math.max(0, c) * G.knee * m;
  // корпус: наклон, покачивание, скручивание; при ударе подаётся вперёд
  p.body.position.y = 1.45 + (moving ? Math.abs(s) * G.bob : Math.sin(ph) * 0.008);
  p.body.rotation.x = (moving ? G.lean : 0.05) + 0.28 * hit - 0.2 * up - 0.3 * flinch + (moving ? 0 : Math.sin(ph * 1.3) * 0.012);
  p.body.rotation.z = moving ? s * 0.06 : Math.sin(ph * 0.7) * 0.025;
  p.body.rotation.y = moving ? s * 0.09 : 0;
  // голова: свешена вперёд, в покое осматривается, при ударе бросается вперёд
  p.head.position.y = p.headY + (moving ? Math.abs(s) * 0.03 : 0);
  p.head.rotation.x = (moving ? 0.12 : 0.22) + 0.4 * hit - 0.3 * up - 0.5 * flinch;
  p.head.rotation.z = Math.sin(ph * 0.6) * 0.07 + (moving ? s * 0.05 : 0);
  p.head.rotation.y = moving ? 0 : Math.sin(ph * 0.35) * 0.35;
  // руки: тянутся вперёд (бегун бежит с согнутыми и качает ими в такт ногам)
  const run = z.type === 'runner' && moving, base = run ? -0.95 : -1.35, flex = run ? -1.15 : -0.22, act = G.arm * (moving ? 1 : 0.6);
  [[p.armL, 1, 0], [p.armR, -1, 0.5]].forEach(([a, sd, off]) => {
    const w = run ? -s * sd : Math.sin(ph * 0.9 + off * 3);
    a.rotation.x = base + w * act - 0.9 * up + 0.75 * hit + 0.45 * flinch;
    a.rotation.z = -sd * (0.06 + 0.05 * w);
    a.fore.rotation.x = flex + w * 0.1 - 0.5 * up + 0.35 * hit - 0.3 * flinch;
  });
  if (p.belly) { const k = 1 + 0.06 * Math.sin(ph * 1.3); p.belly.scale.set(1.2 * k, k, 0.9 * k); }
}
// Тела убитых зомби падают, лежат несколько секунд и уходят в землю (сам зомби из игры убирается сразу)
const corpses = [];
function startCorpse(z) {
  if (corpses.length >= 10) { const o = corpses.shift(); scene.remove(o.mesh); disposeObject(o.mesh); }
  corpses.push({ mesh: z.mesh, parts: z.parts, cfg: z.cfg, t: 0, y0: z.mesh.position.y, side: z.id % 2 ? 1 : -1 });
}
function updateCorpses(dt) {
  for (let i = corpses.length - 1; i >= 0; i--) {
    const c = corpses[i], m = c.mesh, p = c.parts, t = (c.t += dt), f = Math.min(1, t / 0.6), e = f * f, l = Math.min(1, t / 0.8);
    m.rotation.x = -Math.PI / 2 * e * 0.98; m.rotation.z = c.side * 0.18 * e;           // падает на спину
    m.position.y = c.y0 + 0.18 * c.cfg.sy * e - (t > 5 ? (t - 5) * 0.6 : 0);             // потом уходит в землю
    p.body.rotation.set(0.05 * (1 - l), 0, 0); p.head.rotation.set(0.22 - 0.5 * l, 0, 0);
    p.armL.rotation.set(-1.35 + 1.1 * l, 0, -0.6 * l); p.armR.rotation.set(-1.35 + 1.1 * l, 0, 0.6 * l);
    p.armL.fore.rotation.x = p.armR.fore.rotation.x = -0.2 * (1 - l);
    p.legL.rotation.set(0.1 * l, 0, -0.18 * l); p.legR.rotation.set(-0.1 * l, 0, 0.22 * l);
    p.legL.shin.rotation.x = p.legR.shin.rotation.x = 0.15 * l;
    if (t > 6.6) { scene.remove(m); disposeObject(m); corpses.splice(i, 1); }
  }
}
function hitDamage(z, y) { // в голову сильнее; броня солдата гасит попадания в тело
  const head = y - z.mesh.position.y > 1.8 * z.cfg.sy; // высота над ногами зомби, а не над нулём: на холме он стоит выше
  let d = head ? 2 : 1;
  if (z.cfg.armor && !head) d = 0.4;
  return d;
}
const toxicMat = new THREE.MeshBasicMaterial({ color: 0x9acc2a, transparent: true, opacity: 0.4, depthWrite: false });
function toxicPuffs(px, pz) {
  for (let i = 0; i < 16; i++) {
    addPuff(new THREE.Vector3(px + (Math.random() - 0.5) * 2.5, 0.4 + Math.random() * 1.4, pz + (Math.random() - 0.5) * 2.5),
      new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.6 + Math.random(), (Math.random() - 0.5) * 1.5), toxicMat, 1.4, 1.6);
  }
}
function explodeBloater(z) { // вздутый лопается: ядовитое облако ранит всех рядом
  const R = z.cfg.explode, px = z.mesh.position.x, pz = z.mesh.position.z;
  toxicPuffs(px, pz);
  const dl = Math.hypot(camera.position.x - px, camera.position.z - pz);
  if (dl < R && health > 0) { health -= Math.round(20 * (1 - dl / R) + 5); notify('Ядовитый взрыв!'); }
  if (net.role === 'host') {
    net.players.forEach(p => { const d = Math.hypot(p.x - px, p.z - pz); if (d < R) netSendTo(net.conns.get(p.id), { t: 'hurt', d: Math.round(20 * (1 - d / R) + 5) }); });
    netBroadcast({ t: 'boom', x: px, z: pz });
  }
}
function zombieOf(o) { // зомби по любой его части (рука, нога, голова)
  while (o) { for (const z of zombies) if (z.mesh === o) return z; o = o.parent; }
  return null;
}
for (let i = 0; i < 12; i++) spawnZombie();

// --- Игрок ---
let health = 100, hunger = 100, thirst = 100;
let yaw = 0, pitch = 0, kills = 0;
let shotCount = 0, axeCount = 0; // счётчики выстрелов и ударов топором: по ним другие игроки видят отдачу и замах
const MAG = 7;                       // патронов в магазине
const RELOAD = 2.4;                  // длительность перезарядки, сек
let ammo = MAG, reserve = 21, reloading = false;
let rT = 0, loaded = false, lockAtStart = false, lock = false;
let cool = 0, recoil = 0, kick = 0, slidePulse = 0, mzT = 0, gunT = 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = x => 1 - Math.pow(1 - x, 3);
const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
// Дробовик и смена оружия
const SG_MAG = 5;                          // патронов в магазине дробовика
let weapon = 'pistol', hasShotgun = false, drawT = 1;
let sgAmmo = SG_MAG, sgReserve = 0, sgRecoil = 0, sgFlashT = 0;
let sgReloading = false, sgRT = 0, sgReloadN = 0, sgLoadedIn = -1, sgLhBlend = 0;
let sgRacking = false, sgRackT = 0, sgClack1 = false;
let hasAxe = false, swingT = -1, swingHitDone = false; // топор
// Автомат Калашникова (АК-47)
const AK_MAG = 30;                          // патронов в магазине
let hasAK = false, akAmmo = AK_MAG, akReserve = 0, akRecoil = 0, akFlashT = 0, mouseDown = false;
let akReloading = false, akRT = 0, akLoaded = false;
const sgLastLh = new THREE.Vector3();
const casings = [];                        // вылетевшие гильзы
const keys = {};

// --- Инвентарь: 35 слотов (0-4 быстрые слоты игрока, 5-34 рюкзак) ---
const HOTBAR = 5, SLOTS = 35;
const ITEMS = {
  food:   { name: 'Еда',     color: 0xb5651d, stack: 6,  use: 'eat' },
  water:  { name: 'Вода',    color: 0x3a8fd6, stack: 6,  use: 'drink' },
  medkit: { name: 'Аптечка', color: 0xf2f2f2, stack: 3,  use: 'heal' },
  wood:   { name: 'Дерево',  color: 0x8b6b3e, stack: 20 },
  scrap:  { name: 'Лом',     color: 0x8a8a92, stack: 20 },
  rubber: { name: 'Резина',  color: 0x202020, stack: 10 },
  fuel:   { name: 'Бензин',  color: 0xb02a1a, stack: 3,  use: 'fuel' },
  tank:   { name: 'Бензобак', color: 0x8f2b21, stack: 1 },
  wheel:  { name: 'Колесо',  color: 0x333333, stack: 2 },
  bars:   { name: 'Руль',    color: 0xc9ced4, stack: 1 },
};
const slots = new Array(SLOTS).fill(null); // каждый слот: null или { type, n }
const hex = c => '#' + c.toString(16).padStart(6, '0');

// Пиксельные иконки 16x16 для слотов (рисуются кодом)
function makeIcons() {
  const out = {};
  const mk = draw => {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const x = c.getContext('2d');
    draw((col, px, py, w, h) => { x.fillStyle = col; x.fillRect(px, py, w || 1, h || 1); });
    return c.toDataURL();
  };
  out.wood = mk(f => { // бревно: торец с годовыми кольцами
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const r = Math.hypot(x - 7.5, y - 7.5);
      if (r > 7.5) continue;
      let col = '#e0b878';
      if (r > 6.3) col = '#4e2f15'; else if (r > 5.4) col = '#7a4a24';
      else if (r > 3.6 && r < 4.3) col = '#b8884a';
      else if (r > 1.7 && r < 2.4) col = '#b8884a';
      else if (r < 0.9) col = '#8a5a2b';
      f(col, x, y);
    }
    f('#f0cf96', 4, 4); f('#f0cf96', 5, 3);
  });
  out.scrap = mk(f => { // шестерёнка (железо)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const dx = x - 7.5, dy = y - 7.5, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
      const outer = Math.cos(a * 8) > 0.15 ? 7.6 : 6.0;
      if (r <= outer && r > 2.4) f(x + y < 15 ? '#b4bbc3' : '#7d848c', x, y);
      else if (r <= 2.4 && r > 1.6) f('#4a4f55', x, y);
    }
    f('#8a4b2a', 4, 9); f('#8a4b2a', 10, 5); f('#a35a30', 11, 10);
  });
  out.food = mk(f => { // консервная банка
    f('#e6eaee', 3, 2, 10, 2); f('#aeb4bb', 3, 4, 10, 10);
    f('#c9532b', 3, 6, 10, 5); f('#f3d9a0', 5, 7, 6, 3); f('#8f2a12', 7, 8, 2, 1);
    f('#8a9097', 3, 14, 10, 1); f('#eef1f4', 4, 4, 1, 10); f('#6f757c', 12, 4, 1, 10);
  });
  out.water = mk(f => { // бутылка воды
    f('#1f5f9e', 6, 0, 4, 2); f('#cfe8f5', 7, 2, 2, 2); f('#cfe8f5', 5, 4, 6, 2);
    f('#cfe8f5', 4, 6, 8, 2); f('#4aa3e8', 4, 8, 8, 6); f('#2f7fc4', 4, 8, 1, 6); f('#2f7fc4', 11, 8, 1, 6);
    f('#f4f4f4', 4, 9, 8, 3); f('#2f7fc4', 5, 10, 6, 1); f('#bfe3fa', 5, 6, 1, 7); f('#2f7fc4', 4, 14, 8, 1);
  });
  out.medkit = mk(f => { // аптечка с красным крестом
    f('#2b2b2b', 5, 2, 6, 1); f('#2b2b2b', 5, 3, 1, 1); f('#2b2b2b', 10, 3, 1, 1);
    f('#2b2b2b', 1, 4, 14, 10); f('#f4f4f4', 2, 5, 12, 8); f('#d9d9d9', 2, 12, 12, 1);
    f('#d63030', 7, 6, 2, 6); f('#d63030', 5, 8, 6, 2); f('#8a8f96', 2, 8, 1, 2); f('#8a8f96', 13, 8, 1, 2);
  });
  out.rubber = mk(f => { // старая покрышка
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const r = Math.hypot(x - 7.5, y - 7.5);
      if (r > 7.6 || r < 3.4) continue;
      f(r > 6.4 ? '#101010' : r > 5.0 ? '#262626' : '#1a1a1a', x, y);
    }
    for (let a = 0; a < 12; a++) { const t = a / 12 * Math.PI * 2; f('#3c3c3c', Math.round(7.5 + Math.cos(t) * 6.9), Math.round(7.5 + Math.sin(t) * 6.9)); }
    f('#555555', 5, 4); f('#555555', 4, 6);
  });
  out.fuel = mk(f => { // канистра с бензином
    f('#7a1a10', 5, 2, 5, 1); f('#7a1a10', 5, 3, 1, 1); f('#7a1a10', 9, 3, 1, 1);
    f('#d9d9d9', 11, 2, 2, 2); f('#e0b020', 11, 4, 2, 1);
    f('#2b0a06', 2, 4, 12, 11); f('#b02a1a', 3, 5, 10, 9); f('#d04030', 3, 5, 10, 1);
    f('#7a1a10', 3, 13, 10, 1); f('#e8e0c8', 5, 8, 6, 3); f('#b02a1a', 7, 8, 2, 3); f('#b02a1a', 5, 9, 6, 1);
  });
  out.tank = mk(f => { // бензобак
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const e = Math.pow((x - 7.5) / 7.2, 2) + Math.pow((y - 9) / 4.6, 2);
      if (e <= 1) f(e > 0.72 ? '#5c1913' : '#8f2b21', x, y);
    }
    f('#c2493a', 4, 7, 7, 1); f('#c2493a', 5, 6, 5, 1); f('#c9ced4', 7, 3, 2, 2); f('#8a8f96', 7, 5, 2, 1);
  });
  out.wheel = mk(f => { // колесо: покрышка и диск со спицами
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const dx = x - 7.5, dy = y - 7.5, r = Math.hypot(dx, dy);
      if (r > 7.6) continue;
      if (r > 5.3) f(r > 6.6 ? '#101010' : '#262626', x, y);
      else if (r > 1.6) f(Math.abs(Math.sin(Math.atan2(dy, dx) * 4)) < 0.22 ? '#6f757c' : '#aeb4bb', x, y);
      else f('#555555', x, y);
    }
  });
  out.bars = mk(f => { // руль
    f('#c9ced4', 4, 7, 8, 1); f('#8a8f96', 4, 8, 8, 1);
    f('#c9ced4', 3, 5, 1, 3); f('#c9ced4', 12, 5, 1, 3);
    f('#111111', 1, 3, 2, 4); f('#111111', 13, 3, 2, 4); f('#444444', 7, 6, 2, 3);
  });
  return out;
}
const ICONS = makeIcons();

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
  else if (u === 'fuel') { if (!refuelNearest(40)) return false; }
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
    (s ? `<img src="${ICONS[s.type]}" style="position:absolute;left:50%;top:44%;width:34px;height:34px;transform:translate(-50%,-50%);image-rendering:pixelated">` +
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

// Патрон для дробовика: красный пластиковый корпус и латунная гильза. Ось - Z, носик смотрит в -Z.
function makeShell(full) {
  const g = new THREE.Group();
  const m = (c, r, mt) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: mt, flatShading: true });
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0105, full ? 0.055 : 0.045, 8), m(full ? 0xb02a22 : 0x8f231c, 0.7, 0));
  hull.rotation.x = Math.PI / 2; hull.position.z = -0.005;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.0113, 0.0113, 0.018, 8), m(0xc9a227, 0.35, 0.8));
  base.rotation.x = Math.PI / 2; base.position.z = full ? 0.0325 : 0.0265;
  g.add(hull, base);
  return g;
}

// Помповый дробовик DeadZone. Оси: ствол смотрит в -Z, вверх +Y.
function createShotgun(opts) {
  opts = opts || {};
  const root = new THREE.Group();
  const pump = new THREE.Group();     // цевьё (ездит вперёд-назад)
  const PUMP_Z = -0.31;
  pump.position.z = PUMP_Z;
  root.add(pump);

  const mat = (color, rough, metal) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, flatShading: true });
  const M = {
    metal: mat(0x1f2226, 0.45, 0.6), barrel: mat(0x2a2e33, 0.4, 0.7), tube: mat(0x3a3f45, 0.5, 0.6),
    wood: mat(0x6b4423, 0.85, 0), woodD: mat(0x4e3119, 0.9, 0), black: mat(0x0b0c0d, 0.9, 0),
    pad: mat(0x1a1a1a, 0.95, 0), brass: mat(0xc9a227, 0.35, 0.8), steel: mat(0x8a8f96, 0.35, 0.8),
    skin: mat(0xd9a67a, 0.9, 0), sleeve: mat(0x3a4a6a, 0.95, 0),
  };
  const box = (w, h, d, m, x, y, z, parent) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z); (parent || root).add(b); return b;
  };
  const cyl = (r, len, m, x, y, z, parent) => { // цилиндр вдоль Z
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), m);
    c.rotation.x = Math.PI / 2; c.position.set(x, y, z); (parent || root).add(c); return c;
  };
  function extrude(pts, width, m, bevel) {
    bevel = bevel === undefined ? 0.003 : bevel;
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
    const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, steps: 1 });
    g.translate(0, 0, -width / 2); g.rotateY(Math.PI / 2);
    return new THREE.Mesh(g, m);
  }
  const limb = (parent, sx, sy, sz, dx, dy, dz, parts) => { // рука-рукав от запястья
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    parts.forEach(([len, off, w, m]) => {
      const c = new THREE.Vector3(sx, sy, sz).addScaledVector(dir, off + len / 2);
      const b = box(w, w, len, m, c.x, c.y, c.z, parent); b.quaternion.copy(q);
    });
  };

  // --- Ствольная коробка ---
  box(0.056, 0.092, 0.28, M.metal, 0, 0, 0.05);
  box(0.05, 0.01, 0.2, M.barrel, 0, 0.051, 0.06);
  box(0.004, 0.032, 0.1, M.black, 0.029, 0.014, 0.03);   // окно выброса
  box(0.034, 0.004, 0.075, M.black, 0, -0.047, 0.05);    // окно заряжания снизу
  box(0.012, 0.012, 0.03, M.steel, 0.032, -0.02, 0.09);  // кнопка предохранителя

  // --- Ствол, магазинная трубка, мушка ---
  cyl(0.0175, 0.66, M.barrel, 0, 0.032, -0.51);
  box(0.01, 0.006, 0.5, M.barrel, 0, 0.052, -0.45);
  cyl(0.011, 0.004, M.black, 0, 0.032, -0.842);
  box(0.006, 0.014, 0.006, M.brass, 0, 0.058, -0.82);
  cyl(0.0135, 0.52, M.tube, 0, -0.01, -0.42);
  cyl(0.017, 0.03, M.metal, 0, -0.01, -0.68);
  box(0.03, 0.055, 0.02, M.metal, 0, 0.011, -0.66);

  // --- Приклад и затылок ---
  root.add(extrude([[-0.12, 0.045], [-0.30, 0.04], [-0.44, 0.025], [-0.455, -0.115], [-0.30, -0.10], [-0.19, -0.06], [-0.12, -0.075]], 0.05, M.wood));
  const pad = box(0.052, 0.14, 0.02, M.pad, 0, -0.045, 0.463); pad.rotation.x = -0.1;

  // --- Спуск ---
  box(0.014, 0.006, 0.1, M.metal, 0, -0.075, 0.10);
  box(0.014, 0.028, 0.006, M.metal, 0, -0.061, 0.05);
  const trg = box(0.008, 0.026, 0.008, M.metal, 0, -0.058, 0.085); trg.rotation.x = 0.2;

  // --- Цевьё (помпа) ---
  box(0.058, 0.054, 0.23, M.wood, 0, -0.012, 0, pump);
  for (let i = 0; i < 6; i++) box(0.06, 0.006, 0.01, M.woodD, 0, -0.04, -0.09 + i * 0.035, pump);
  [-1, 1].forEach(s => box(0.008, 0.008, 0.3, M.metal, s * 0.022, -0.018, 0.2, pump)); // тяги (видны, когда помпа впереди)

  // --- Точки для эффектов ---
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.032, -0.85); root.add(muzzle);
  const port = new THREE.Object3D(); port.position.set(0.035, 0.014, 0.03); root.add(port);

  // --- Правая рука на шейке приклада ---
  const rightHand = new THREE.Group(); root.add(rightHand);
  box(0.022, 0.11, 0.11, M.skin, 0.04, -0.03, 0.245, rightHand);
  box(0.022, 0.1, 0.06, M.skin, -0.04, -0.03, 0.28, rightHand);
  box(0.022, 0.022, 0.09, M.skin, -0.028, 0.05, 0.24, rightHand);
  box(0.075, 0.02, 0.09, M.skin, 0, -0.09, 0.235, rightHand);
  box(0.08, 0.03, 0.06, M.skin, 0, 0.052, 0.29, rightHand);
  box(0.016, 0.016, 0.12, M.skin, 0.02, -0.062, 0.145, rightHand);  // палец на спуске
  limb(rightHand, 0.01, -0.09, 0.31, 0.28, -0.7, 0.66, [[0.2, 0, 0.085, M.skin], [0.8, 0.2, 0.125, M.sleeve]]);

  // --- Левая рука: держит цевьё, а при заряжании ходит за патронами ---
  const leftHand = new THREE.Group(); root.add(leftHand);
  box(0.085, 0.035, 0.11, M.skin, 0, -0.052, 0, leftHand);
  [-1, 1].forEach(s => box(0.02, 0.06, 0.1, M.skin, s * 0.048, -0.02, 0, leftHand));
  box(0.02, 0.02, 0.07, M.skin, -0.03, 0.032, 0, leftHand);
  limb(leftHand, 0, -0.07, 0.07, -0.45, -0.7, 0.55, [[0.2, 0, 0.085, M.skin], [0.8, 0.2, 0.125, M.sleeve]]);
  const shellCarry = makeShell(true);       // патрон в пальцах при заряжании
  shellCarry.position.set(0, -0.005, 0);
  shellCarry.visible = false;
  leftHand.add(shellCarry);
  leftHand.position.set(0, 0, PUMP_Z);

  if (opts.hands === false) { rightHand.visible = false; leftHand.visible = false; }
  return { root, pump, PUMP_Z, muzzle, port, rightHand, leftHand, shellCarry };
}

// Военный ящик. Перед ящиком +Z, крышка крепится сзади (-Z) и откидывается вверх.
function createMilCase() {
  const root = new THREE.Group();
  const mat = (c, r, m) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, flatShading: true });
  const olive = mat(0x4a5230, 0.85, 0.05), oliveD = mat(0x3a4126, 0.9, 0.05), metal = mat(0x2f332a, 0.55, 0.5);
  const steel = mat(0x8d9288, 0.4, 0.7), foam = mat(0x1b1e19, 1, 0);
  const L = 1.4, H = 0.3, D = 0.5, T = 0.03;
  const box = (w, h, d, m, x, y, z, parent) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z); (parent || root).add(b); return b;
  };

  // Корпус (открытая коробка с поролоном внутри)
  box(L, T, D, olive, 0, T / 2, 0);
  box(L, H, T, olive, 0, H / 2, D / 2 - T / 2);
  box(L, H, T, olive, 0, H / 2, -D / 2 + T / 2);
  [-1, 1].forEach(s => box(T, H, D - 2 * T, olive, s * (L / 2 - T / 2), H / 2, 0));
  box(L - 2 * T, 0.02, D - 2 * T, foam, 0, T + 0.01, 0);
  [0.09, 0.19].forEach(y => box(L * 0.92, 0.02, 0.008, oliveD, 0, y, D / 2 + 0.002)); // рёбра жёсткости
  [-1, 1].forEach(sx => [-1, 1].forEach(sz => box(0.06, H, 0.06, metal, sx * (L / 2 - 0.02), H / 2, sz * (D / 2 - 0.02)))); // углы
  [-1, 1].forEach(s => {                                                                         // боковые ручки
    box(0.012, 0.05, 0.14, metal, s * (L / 2 + 0.01), 0.17, 0);
    box(0.02, 0.02, 0.16, steel, s * (L / 2 + 0.03), 0.145, 0);
  });
  const latches = [];
  [-0.4, 0.4].forEach(x => {                                                                      // замки
    box(0.09, 0.09, 0.02, steel, x, 0.235, D / 2 + 0.012);
    latches.push(box(0.06, 0.035, 0.028, metal, x, 0.19, D / 2 + 0.026));
  });

  // Крышка на шарнире
  const lid = new THREE.Group();
  lid.position.set(0, H, -D / 2);
  box(L, 0.07, D, olive, 0, 0.035, D / 2, lid);
  box(L * 0.94, 0.02, 0.01, oliveD, 0, 0.03, D - 0.005, lid);
  [-1, 1].forEach(s => box(0.05, 0.012, D * 0.8, oliveD, s * L * 0.3, 0.076, D / 2, lid));         // рёбра на крышке
  [-1, 1].forEach(s => box(0.03, 0.03, 0.03, metal, s * 0.09, 0.085, D / 2, lid));                   // ручка сверху
  box(0.21, 0.02, 0.03, metal, 0, 0.105, D / 2, lid);
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 180;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#e9e6cf'; cx.textAlign = 'center';
  cx.font = 'bold 44px monospace'; cx.fillText('ВОЕННЫЙ ЯЩИК', 256, 56);
  cx.font = 'bold 30px monospace'; cx.fillText('ОРУЖИЕ · ПАТРОНЫ', 256, 102);
  cx.font = '26px monospace'; cx.fillText('№ 12-DZ   ★', 256, 146);
  const stencil = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.22), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
  stencil.rotation.x = -Math.PI / 2; stencil.position.set(0, 0.0715, D / 2 + 0.06); lid.add(stencil);
  root.add(lid);

  // Содержимое: дробовик и коробки с патронами (добавляется снаружи)
  const loot = new THREE.Group();
  loot.position.y = T + 0.02;
  root.add(loot);
  const cartonMat = mat(0xa62a22, 0.8, 0), stripMat = mat(0xc9a227, 0.5, 0.5);
  [[-0.5, 0.13], [-0.32, 0.13]].forEach(([x, z]) => {
    box(0.16, 0.07, 0.1, cartonMat, x, 0.035, z, loot);
    box(0.165, 0.012, 0.105, stripMat, x, 0.06, z, loot);
  });
  return { root, lid, loot, latches, L, H, D };
}

// --- Топор: самодельный, но добротный. Изогнутая рукоять с обмоткой, головка с бородой и скошенным лезвием, кисти с пальцами ---
// Модель склеена из коробок в 3-4 меша. Лезвие смотрит вперёд, в -Z, рукоять вдоль +Y, начало у нижнего конца рукояти.
const axeWoodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true });
const axeSteelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.75, flatShading: true });
const axeSoftMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true });
const weaponMixMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.35, flatShading: true }); // оружие в руках других игроков
[axeWoodMat, axeSteelMat, axeSoftMat, weaponMixMat].forEach(m => { m.userData.shared = true; });

function dirM(c, d) { // матрица 4x4: ось Z вдоль направления d, начало в точке c (для деталей вдоль руки)
  const l = Math.hypot(d[0], d[1], d[2]), z = [d[0] / l, d[1] / l, d[2] / l];
  let x = [z[2], 0, -z[0]]; const lx = Math.hypot(x[0], x[2]) || 1; x = [x[0] / lx, 0, x[2] / lx];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, c[0], c[1], c[2], 1];
}
function createAxe(opts) {
  opts = opts || {};
  const root = new THREE.Group(), rnd = mulberry(20240731);
  const W = zBoxes(rnd, y => 0.78 + 0.22 * Math.min(1, Math.max(0, y / 0.35))); // дерево: низ темнее от грязи
  const S = zBoxes(rnd), K = zBoxes(rnd), Hn = zBoxes(rnd);                     // сталь, обмотки, кисти
  const WOOD = 0x7a5230, WOOD_D = 0x4e3119, STEEL = 0x9aa1a8, STEEL_D = 0x6c7279, STEEL_L = 0xc7ced4;
  const SKIN = 0xd9a67a, SKIN_D = 0xc08e63, SKIN_L = 0xe7b88e, SLEEVE = 0x3a4a6a, SLEEVE_D = 0x2c3a56;

  // рукоять: овальное сечение, лёгкий изгиб, утолщение у низа
  for (let i = 0; i < 8; i++) {
    const t = i / 7, sw = 1 + 0.4 * Math.max(0, 0.3 - t) / 0.3;
    W.box(0.034 * sw, 0.1, 0.05 * sw, WOOD, 0, i * 0.1 + 0.05, -0.016 * Math.sin(Math.PI * t));
  }
  W.box(0.064, 0.05, 0.072, WOOD_D, 0, 0.018, 0); W.box(0.05, 0.02, 0.058, WOOD_D, 0, -0.004, 0); // набалдашник
  [-1, 1].forEach(sd => W.box(0.003, 0.4, 0.04, WOOD_D, sd * 0.0175, 0.58, -0.006));              // волокна дерева
  W.box(0.012, 0.014, 0.05, WOOD_D, 0, 0.808, 0);                                                    // клин в проушине
  for (let k = 0; k < 8; k++) K.box(0.054, 0.022, 0.068, k % 2 ? 0x2a2a2a : 0x3a3a3a, 0, 0.11 + k * 0.034, -0.004); // обмотка изолентой
  K.box(0.012, 0.11, 0.012, 0x4a3320, 0.032, -0.03, 0.025, 0.2, 0, 0.3);                           // кожаная петля
  for (let k = 0; k < 4; k++) K.box(0.058, 0.012, 0.062, 0x8a7a50, 0, 0.596 + k * 0.014, 0);         // бечёвка под головкой

  // головка: проушина, обух, щека, лезвие с бородой, блик на кромке
  S.box(0.054, 0.19, 0.115, STEEL_D, 0, 0.71, 0.016);
  S.box(0.056, 0.17, 0.045, STEEL, 0, 0.71, 0.085);
  S.prism([[-0.04, 0.80], [-0.10, 0.885], [-0.125, 0.865], [-0.125, 0.545], [-0.10, 0.525], [-0.04, 0.62]], 0.036, STEEL, 0, 0, 0, 0, -Math.PI / 2, 0);   // щека
  S.prism([[-0.12, 0.885], [-0.15, 0.915], [-0.19, 0.865], [-0.205, 0.765], [-0.205, 0.665], [-0.185, 0.575], [-0.145, 0.515], [-0.12, 0.54]], 0.014, STEEL, 0, 0, 0, 0, -Math.PI / 2, 0); // лезвие
  const edge = [[-0.19, 0.865], [-0.205, 0.765], [-0.205, 0.665], [-0.185, 0.575], [-0.145, 0.515]];
  for (let i = 0; i < edge.length - 1; i++) {
    const [z0, y0] = edge[i], [z1, y1] = edge[i + 1], dz = z1 - z0, dy = y1 - y0, len = Math.hypot(dz, dy);
    S.box(0.017, 0.012, len + 0.004, STEEL_L, 0, (y0 + y1) / 2, (z0 + z1) / 2, Math.atan2(-dy, dz), 0, 0);
  }
  S.box(0.0025, 0.07, 0.09, 0x5a1a14, 0.0082, 0.72, -0.165); S.box(0.0025, 0.07, 0.09, 0x5a1a14, -0.0082, 0.66, -0.15); // кровь на лезвии
  S.box(0.0025, 0.03, 0.03, 0x6a4a32, 0.0195, 0.6, -0.08); S.box(0.0025, 0.03, 0.03, 0x6a4a32, -0.0195, 0.78, -0.09);   // ржавчина
  S.box(0.018, 0.022, 0.012, STEEL_D, 0, 0.705, -0.205); S.box(0.018, 0.016, 0.012, STEEL_D, 0, 0.8, -0.18);           // зазубрины
  [-1, 1].forEach(sd => S.box(0.01, 0.016, 0.016, STEEL_L, sd * 0.03, 0.745, 0.016));                                    // заклёпки

  // кисти: тыльная сторона к камере, пальцы обхватывают рукоять; предплечья идут к камере
  const hand = (y0, dir) => {
    Hn.box(0.084, 0.076, 0.036, SKIN, 0, y0, 0.05);                                      // тыльная сторона ладони
    [-1, 1].forEach(sd => Hn.box(0.024, 0.076, 0.075, SKIN_D, sd * 0.043, y0, 0.0));      // пальцы по бокам рукояти
    Hn.box(0.092, 0.076, 0.03, SKIN_D, 0, y0, -0.045);                                    // кончики пальцев спереди
    for (let k = 0; k < 3; k++) Hn.box(0.094, 0.003, 0.032, 0x8a5a38, 0, y0 - 0.025 + k * 0.025, -0.046); // складки между пальцами
    for (let k = 0; k < 4; k++) Hn.box(0.016, 0.014, 0.018, SKIN_L, (k - 1.5) * 0.021, y0 + 0.042, 0.054); // костяшки
    Hn.box(0.022, 0.024, 0.065, SKIN, 0.05, y0 + 0.022, 0.03, 0.5, 0, 0);                  // большой палец
    const wrist = [0, y0 - 0.03, 0.04];
    Hn.boxM(0.085, 0.085, 0.2, SKIN, dirM([wrist[0] + dir[0] / Math.hypot(...dir) * 0.1, wrist[1] + dir[1] / Math.hypot(...dir) * 0.1, wrist[2] + dir[2] / Math.hypot(...dir) * 0.1], dir));
    const n = Math.hypot(...dir), at = o => [wrist[0] + dir[0] / n * o, wrist[1] + dir[1] / n * o, wrist[2] + dir[2] / n * o];
    Hn.boxM(0.12, 0.12, 0.8, SLEEVE, dirM(at(0.2 + 0.4), dir));                           // рукав
    Hn.boxM(0.13, 0.13, 0.035, SLEEVE_D, dirM(at(0.2 + 0.018), dir));                     // манжета
    Hn.boxM(0.125, 0.125, 0.03, SLEEVE_D, dirM(at(0.55), dir));                           // складка
  };
  root.add(W.mesh(axeWoodMat), S.mesh(axeSteelMat), K.mesh(axeSoftMat));
  if (opts.hands !== false) { hand(0.12, [0.3, -0.7, 0.65]); hand(0.4, [-0.5, -0.6, 0.6]); root.add(Hn.mesh(axeSoftMat)); }
  return { root };
}
const axeRig = createAxe().root;
axeRig.position.set(0.26, -0.5, -0.5);
axeRig.rotation.set(-0.35, 0, 0.3);
axeRig.visible = false;

// Автомат Калашникова. Оси: ствол смотрит в -Z, вверх +Y.
function createAK(opts) {
  opts = opts || {};
  const root = new THREE.Group();
  const mat = (c, r, m) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, flatShading: true });
  const M = {
    steel: mat(0x2a2d30, 0.45, 0.7), steelL: mat(0x4a5057, 0.4, 0.75), wood: mat(0x7a4a22, 0.8, 0), black: mat(0x0d0e10, 0.9, 0.1),
    skin: mat(0xd9a67a, 0.9, 0), sleeve: mat(0x3a4a6a, 0.95, 0),
  };
  const box = (w, h, d, m, x, y, z, parent) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); (parent || root).add(b); return b; };
  const cyl = (r, len, m, x, y, z, parent, seg) => { const g = new THREE.CylinderGeometry(r, r, len, seg || 8); g.rotateX(Math.PI / 2); const c = new THREE.Mesh(g, m); c.position.set(x, y, z); (parent || root).add(c); return c; };
  function extrude(pts, width, m, bevel) {
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
    const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, steps: 1 });
    g.translate(0, 0, -width / 2); g.rotateY(Math.PI / 2);
    return new THREE.Mesh(g, m);
  }
  const limb = (parent, sx, sy, sz, dx, dy, dz, parts) => {
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    parts.forEach(([len, off, w, m]) => {
      const c = new THREE.Vector3(sx, sy, sz).addScaledVector(dir, off + len / 2);
      const b = box(w, w, len, m, c.x, c.y, c.z, parent); b.quaternion.copy(q);
    });
  };
  // ствольная коробка, ствол, газовая трубка
  box(0.05, 0.075, 0.34, M.steel, 0, 0, 0);
  box(0.046, 0.02, 0.3, M.steelL, 0, 0.046, 0);
  box(0.03, 0.018, 0.07, M.steel, 0, 0.064, -0.14);
  cyl(0.0115, 0.44, M.steel, 0, 0.012, -0.39);
  cyl(0.0155, 0.05, M.black, 0, 0.012, -0.635);
  box(0.022, 0.05, 0.03, M.steel, 0, 0.042, -0.57); box(0.006, 0.03, 0.006, M.steel, 0, 0.07, -0.57);
  box(0.03, 0.04, 0.04, M.steel, 0, 0.025, -0.5);
  cyl(0.011, 0.27, M.steel, 0, 0.047, -0.365);
  // дерево: накладки, рукоять, приклад
  box(0.052, 0.032, 0.26, M.wood, 0, 0.062, -0.33);
  box(0.058, 0.055, 0.26, M.wood, 0, -0.008, -0.33);
  const grip = box(0.04, 0.1, 0.05, M.wood, 0, -0.095, 0.1); grip.rotation.x = 0.35;
  box(0.012, 0.006, 0.1, M.steel, 0, -0.052, 0.045); box(0.012, 0.025, 0.006, M.steel, 0, -0.04, 0.0);
  root.add(extrude([[-0.17, 0.034], [-0.5, 0.03], [-0.52, -0.085], [-0.42, -0.09], [-0.17, -0.03]], 0.045, M.wood, 0.003));
  box(0.05, 0.13, 0.015, M.black, 0, -0.028, 0.527);
  const bolt = box(0.014, 0.02, 0.04, M.steelL, 0.032, 0.02, -0.02);   // рукоятка затвора ходит при стрельбе
  // магазин-«банан»
  const mag = new THREE.Group(); root.add(mag);
  const m1 = box(0.04, 0.12, 0.075, M.steel, 0, -0.1, -0.03, mag); m1.rotation.x = -0.06;
  const m2 = box(0.04, 0.12, 0.075, M.steel, 0, -0.215, -0.07, mag); m2.rotation.x = -0.3;
  for (let i = 0; i < 3; i++) box(0.042, 0.008, 0.077, M.steelL, 0, -0.07 - i * 0.07, -0.03 - i * 0.02, mag);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.012, -0.67); root.add(muzzle);
  // руки: правая на рукояти, левая на цевье (уходит за магазином при перезарядке)
  const rightHand = new THREE.Group(); root.add(rightHand);
  box(0.07, 0.08, 0.03, M.skin, 0, -0.11, 0.075, rightHand); box(0.075, 0.09, 0.04, M.skin, 0, -0.1, 0.14, rightHand);
  box(0.022, 0.08, 0.09, M.skin, 0.04, -0.1, 0.105, rightHand); box(0.02, 0.02, 0.08, M.skin, -0.03, -0.04, 0.09, rightHand);
  box(0.014, 0.014, 0.06, M.skin, 0.0, -0.05, 0.03, rightHand);
  limb(rightHand, 0.01, -0.15, 0.15, 0.3, -0.75, 0.6, [[0.2, 0, 0.085, M.skin], [0.8, 0.2, 0.12, M.sleeve]]);
  const leftHand = new THREE.Group(); root.add(leftHand);
  box(0.085, 0.04, 0.12, M.skin, 0, -0.055, 0, leftHand);
  [-1, 1].forEach(s2 => box(0.02, 0.06, 0.1, M.skin, s2 * 0.048, -0.02, 0, leftHand));
  box(0.02, 0.02, 0.07, M.skin, -0.03, 0.032, 0, leftHand);
  limb(leftHand, 0, -0.07, 0.07, -0.45, -0.7, 0.55, [[0.2, 0, 0.085, M.skin], [0.8, 0.2, 0.12, M.sleeve]]);
  leftHand.position.set(0, 0, -0.33);
  if (opts.hands === false) { rightHand.visible = false; leftHand.visible = false; }
  return { root, mag, bolt, muzzle, leftHand, rightHand };
}
const ak = createAK();
const akRig = ak.root;
akRig.position.set(0.22, -0.26, -0.5);
akRig.rotation.y = 0.1;
akRig.visible = false;
camera.add(akRig);
const akFlashMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0 });
const akFlashG = new THREE.Group();
akFlashG.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.03), akFlashMat));
const akFa = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.014, 0.014), akFlashMat);
const akFb = akFa.clone(); akFb.rotation.z = Math.PI / 2;
akFlashG.add(akFa, akFb); akFlashG.visible = false;
ak.muzzle.add(akFlashG);
const akLight = new THREE.PointLight(0xffb060, 0, 5, 2);
ak.muzzle.add(akLight);
const _akLh = new THREE.Vector3(), _akT = new THREE.Vector3();
const AK_F = new THREE.Vector3(0, 0, -0.33);     // левая рука на цевье
const AK_M = new THREE.Vector3(0, -0.1, -0.04);  // левая рука у магазина
const AK_B = new THREE.Vector3(-0.28, -0.5, 0.2);// за кадром: берёт новый магазин
camera.add(axeRig);

// Дробовик в руках (камера), показывается только после находки в ящике
const sg = createShotgun();
const sgun = sg.root;
sgun.position.set(0.2, -0.24, -0.42);
sgun.rotation.y = 0.12;
sgun.visible = false;
camera.add(sgun);
const sgFlashMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0 });
const sgFlashG = new THREE.Group();
sgFlashG.add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.03), sgFlashMat));
const sgFa = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.018, 0.018), sgFlashMat);
const sgFb = sgFa.clone(); sgFb.rotation.z = Math.PI / 2;
sgFlashG.add(sgFa, sgFb);
sgFlashG.visible = false;
sg.muzzle.add(sgFlashG);
const sgLight = new THREE.PointLight(0xffb060, 0, 5, 2);
sg.muzzle.add(sgLight);
const _sgFollow = new THREE.Vector3(), _sgLh = new THREE.Vector3();
const SG_B = new THREE.Vector3(-0.24, -0.42, 0.30);   // где левая рука берёт патроны (за кадром)
const SG_P0 = new THREE.Vector3(0, -0.085, 0.06);     // под окном заряжания
const SG_P1 = new THREE.Vector3(0, -0.045, 0.06);     // патрон вставлен

function ejectCasing() { // гильза вылетает из окна при передёргивании помпы
  const m = makeShell(false);
  scene.add(m);
  const wp = new THREE.Vector3(); sg.port.getWorldPosition(wp); m.position.copy(wp);
  const q = new THREE.Quaternion(); sgun.getWorldQuaternion(q);
  const v = new THREE.Vector3(1.7 + Math.random() * 0.6, 1.5 + Math.random() * 0.5, 0.5 + Math.random() * 0.6).applyQuaternion(q);
  casings.push({ m, v, spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12), life: 4 });
}

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

// --- Склад: большое здание с заколоченным люком в подвал (люк надо прорубить топором) ---
const warehouses = [];
let inBasement = false, curW = null;
const basementLamp = new THREE.PointLight(0xffc88a, 0, 30, 1); // свет подвала (одна лампа на оба подвала)
scene.add(basementLamp);
const splinterMat = new THREE.MeshBasicMaterial({ color: 0x8a6a3a });
const fadeEl = document.createElement('div'); // затемнение при спуске и подъёме
fadeEl.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:9';
document.body.appendChild(fadeEl);

function corrugated(base, dark, rep) { // гофрированный металл
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const g = c.getContext('2d');
  for (let i = 0; i < 8; i++) { g.fillStyle = (i % 4 < 2) ? base : dark; g.fillRect(i, 0, 1, 8); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, 1);
  t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// --- Набор для сборки зданий и декора (1.9.0): тысячи деталей склеиваются в несколько мешей с цветами вершин ---
// Все координаты мировые. Детали складываются в кучи: s - стены (держат пули), r - крыша (держит пули), d - мелочи (пули летят сквозь),
// m - металл (мелочи), ms - металл (держит пули), g - светящееся (лампы), gl - стёкла. Из каждой кучи получается один меш.
// Внешний вид считается из координат здания (mulberry и h01), а не через Math.random: мир из сохранений не сдвигается.
const bMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
const bMetalMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.65, flatShading: true });
const bGlowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
[bMat, bMetalMat, bGlowMat].forEach(m => { m.userData.shared = true; });
const h01 = (n, a, b) => { const v = Math.sin(n * 127.1 + a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); }; // 0..1 из чисел, без Math.random
function bKit(x, z, tag) {
  const rnd = mulberry(((Math.round(x * 64) * 73856093) ^ (Math.round(z * 64) * 19349663) ^ ((tag || 0) * 83492791)) | 1);
  const ao = y => 0.72 + 0.28 * Math.min(1, Math.max(0, y / 1.6)); // низ темнее: грязь и тень у земли
  const bs = { s: zBoxes(rnd, ao), r: zBoxes(rnd, ao), d: zBoxes(rnd, ao), m: zBoxes(rnd, ao), ms: zBoxes(rnd, ao), g: zBoxes(rnd), gl: zBoxes(rnd) };
  const list = Object.values(bs);
  return Object.assign({ rnd, x, z }, bs, {
    xf(M0, fn) { list.forEach(b => { b.base = M0; }); try { fn(); } finally { list.forEach(b => { b.base = null; }); } }, // собрать часть в своих осях и повернуть целиком
    finish() {
      const out = [];
      const make = (b, mat, block, shadow) => {
        if (!b.count()) return;
        const mesh = b.mesh(mat); scene.add(mesh); mesh.castShadow = shadow;
        if (block) blockers.push(mesh);
        out.push(mesh);
      };
      make(bs.s, bMat, true, true); make(bs.r, bMat, true, true); make(bs.d, bMat, false, false);
      make(bs.m, bMetalMat, false, false); make(bs.ms, bMetalMat, true, true); make(bs.g, bGlowMat, false, false); make(bs.gl, glassMat, false, false);
      return out;
    },
  });
}
const colBox = (cx, cz, hx, hz, top) => colliders.push({ minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz, top });
function crateK(b, w, h, d, col, x, y0, z) { // деревянный ящик: каркас, рейки, крышка, трафарет
  b.box(w, h, d, col, x, y0 + h / 2, z);
  const dk = mulCol(col, 0.72);
  [-1, 1].forEach(sx => [-1, 1].forEach(sz => b.box(0.05, h + 0.01, 0.05, dk, x + sx * (w / 2 - 0.02), y0 + h / 2, z + sz * (d / 2 - 0.02))));
  b.box(w + 0.02, 0.04, d + 0.02, mulCol(col, 0.85), x, y0 + h + 0.005, z);
  [0.3, 0.7].forEach(k => b.box(w + 0.015, 0.035, d + 0.015, dk, x, y0 + h * k, z));
  b.box(w * 0.45, 0.07, 0.008, 0xd8d0b0, x, y0 + h * 0.5, z + d / 2 + 0.006);
}
function rackK(K, cx, cz, along, len, solid) { // стеллаж с ящиками. Случайные числа те же и в том же порядке, что в 1.8.0
  const depth = 0.8, H = 3.4, crates = [0x7a5c34, 0x5e6b4a, 0x6b4f2e, 0x4a5a6a, 0x8a6a3a];
  K.xf(m4(cx, 0, cz, 0, along === 'z' ? Math.PI / 2 : 0, 0), () => {
    const { m, d } = K;
    [-len / 2, len / 2].forEach(px => {
      [-depth / 2, depth / 2].forEach(pz => { m.box(0.08, H, 0.08, 0x3c5a7a, px, H / 2, pz); m.box(0.16, 0.03, 0.16, 0x2c4260, px, 0.015, pz); });
      m.tube([px, 0.3, -depth / 2], [px, 2.9, depth / 2], 0.016, 0x4a6a8a); m.tube([px, 0.3, depth / 2], [px, 2.9, -depth / 2], 0.016, 0x4a6a8a); // раскосы
    });
    m.box(len + 0.08, 0.05, 0.05, 0x3c5a7a, 0, H, -depth / 2); m.box(len + 0.08, 0.05, 0.05, 0x3c5a7a, 0, H, depth / 2);
    [0.45, 1.5, 2.55].forEach(y => {
      d.box(len, 0.05, depth, 0x7a5c34, 0, y, 0);
      [-1, 1].forEach(sd => m.box(len, 0.08, 0.04, 0x3c5a7a, 0, y - 0.05, sd * depth / 2));
      let px = -len / 2 + 0.5;
      while (px < len / 2 - 0.4) {
        const w = 0.5 + Math.random() * 0.5, h = 0.35 + Math.random() * 0.4, dd = 0.45 + Math.random() * 0.25;
        if (px + w / 2 > len / 2 - 0.1) break;
        if (Math.random() < 0.8) {
          const col = crates[Math.floor(Math.random() * crates.length)], oz = (Math.random() - 0.5) * 0.1;
          crateK(d, w, h, dd, col, px, y + 0.025, oz);
        }
        px += w + 0.12;
      }
    });
  });
  if (solid) {
    const hw = along === 'x' ? len / 2 : depth / 2, hd = along === 'x' ? depth / 2 : len / 2;
    colliders.push({ minX: cx - hw, maxX: cx + hw, minZ: cz - hd, maxZ: cz + hd });
  }
}
function barrelsK(K, cx, cz, n) { // бочки кучкой: рёбра жёсткости, крышка с пробкой, потёки
  const cols = [0x8a2b20, 0x2b4a7a, 0x4a5a3a, 0x6a6a2a], { m } = K;
  for (let i = 0; i < n; i++) {
    const bx = cx + (i % 3) * 0.7, bz = cz + Math.floor(i / 3) * 0.7, c = cols[i % cols.length];
    m.cyl(0.3, 0.9, c, bx, 0, bz, 10);
    m.cyl(0.304, 0.22, mulCol(c, 0.72), bx, 0, bz, 10);                                    // грязь у основания
    [0.12, 0.45, 0.78].forEach(y => m.cyl(0.314, 0.05, 0x242424, bx, y - 0.025, bz, 10)); // рёбра
    m.cyl(0.27, 0.03, mulCol(c, 0.65), bx, 0.9, bz, 10); m.cyl(0.04, 0.05, 0x151515, bx + 0.12, 0.93, bz - 0.06, 6);
    if (h01(i, cx, cz) > 0.5) m.box(0.07, 0.42, 0.012, 0x3a2a1c, bx + 0.1, 0.62, bz + 0.305);   // потёк
  }
  colliders.push({ minX: cx - 0.4, maxX: cx + 0.7 * Math.min(n, 3) - 0.3, minZ: cz - 0.4, maxZ: cz + 0.7 * Math.ceil(n / 3) - 0.3 });
}
function makeHatch() { // заколоченный люк: доски, железные полосы, крест из досок, замок
  const g = new THREE.Group();
  const wood = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, flatShading: true });
  const iron = new THREE.MeshStandardMaterial({ color: 0x2f3236, roughness: 0.5, metalness: 0.7, flatShading: true });
  const bx = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); return o; };
  for (let i = 0; i < 5; i++) bx(2.0, 0.1, 0.38, wood([0x7a5c34, 0x6e5230, 0x80613a][i % 3]), 0, 0.05, -0.8 + i * 0.4);
  [-0.55, 0.55].forEach(x => bx(0.14, 0.04, 2.05, iron, x, 0.12, 0));
  const c1 = bx(2.6, 0.06, 0.2, wood(0x5e4528), 0, 0.15, 0); c1.rotation.y = 0.78;
  const c2 = bx(2.6, 0.06, 0.2, wood(0x5e4528), 0, 0.18, 0); c2.rotation.y = -0.78;
  bx(0.22, 0.12, 0.16, iron, 0, 0.22, 0);
  [-1.1, 1.1].forEach(s => { bx(0.12, 0.08, 2.3, iron, s, 0.04, 0); bx(2.3, 0.08, 0.12, iron, 0, 0.04, s); });
  return g;
}
function makeHole() { // проём с лестницей (после того как люк разрублен)
  const g = new THREE.Group();
  const bx = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); return o; };
  const black = new THREE.MeshBasicMaterial({ color: 0x050505 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x2f3236, roughness: 0.5, metalness: 0.7, flatShading: true });
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a5c34, roughness: 0.9, flatShading: true });
  bx(2.0, 0.02, 2.0, black, 0, 0.02, 0);
  [-1.1, 1.1].forEach(s => { bx(0.12, 0.08, 2.3, iron, s, 0.04, 0); bx(2.3, 0.08, 0.12, iron, 0, 0.04, s); });
  [-0.35, 0.35].forEach(x => bx(0.07, 0.6, 0.07, wood, x, 0.3, 0.7));
  [0.1, 0.4].forEach(y => bx(0.8, 0.05, 0.06, wood, 0, y, 0.7));
  return g;
}
function hitHatch(w) { // удар топором по люку
  if (w.state !== 'closed') return false;
  if (adm('fastChop')) w.hp = 1;
  w.hp--;
  w.hatch.position.x = w.hx + (Math.random() - 0.5) * 0.08; w.hatch.position.z = w.hz + (Math.random() - 0.5) * 0.08;
  for (let i = 0; i < 4; i++) {
    addPuff(new THREE.Vector3(w.hx + (Math.random() - 0.5), 0.25, w.hz + (Math.random() - 0.5)),
      new THREE.Vector3((Math.random() - 0.5) * 2, 2 + Math.random() * 1.5, (Math.random() - 0.5) * 2), splinterMat, 0.6, 0.35);
  }
  if (w.hp <= 0) {
    w.state = 'open'; scene.remove(w.hatch); w.hole.visible = true;
    for (let i = 0; i < 7; i++) { // щепки и доски разлетаются
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.12), new THREE.MeshStandardMaterial({ color: 0x7a5c34, roughness: 0.95, flatShading: true }));
      m.position.set(w.hx + (Math.random() - 0.5) * 1.5, 0.3, w.hz + (Math.random() - 0.5) * 1.5); scene.add(m);
      casings.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 4, 2 + Math.random() * 2, (Math.random() - 0.5) * 4), spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8), life: 12 });
    }
    notify('Люк разрублен! Внизу темно: нажми E и спустись');
  } else notify('Люк трещит... осталось ударов: ' + w.hp);
  kick += 0.02;
  return true;
}

function buildWarehouse(x, z, idx) {
  const W = 16, D = 12, H = 5.4, T = 0.4, seg = (W - 5) / 2;
  clearTrees(x, z, W / 2 + 5, D / 2 + 6); // деревья внутри участка убираем
  const K = bKit(x, z, 1), { s, r, d, m, g } = K;
  const WALL = 0x8f9aa3, RIB = 0x7d8892, CONC = 0x6e6e68, DARK = 0x353a3f, RUST = 0x7a5238;
  // Гофрированная стена: основа, рёбра с обеих сторон, потёки ржавчины от стыков
  function panel(along, cx, cz, len, y0, y1) {
    const h = y1 - y0, cy = (y0 + y1) / 2, n = Math.floor(len / 0.5), off = (len - n * 0.5) / 2;
    if (along === 'x') s.box(len, h, T, WALL, cx, cy, cz); else s.box(T, h, len, WALL, cx, cy, cz);
    for (let i = 0; i < n; i++) {
      const o = -len / 2 + off + 0.25 + i * 0.5, c = i % 2 ? RIB : mulCol(WALL, 1.06), streak = h01(i, cx, cz) > 0.72, sh = 0.5 + h01(i + 9, cx, cz) * 1.3;
      if (along === 'x') { s.box(0.18, h - 0.04, T + 0.09, c, cx + o, cy, cz); if (streak) s.box(0.07, sh, T + 0.11, RUST, cx + o, y1 - sh / 2, cz); }
      else { s.box(T + 0.09, h - 0.04, 0.18, c, cx, cy, cz + o); if (streak) s.box(T + 0.11, sh, 0.07, RUST, cx, y1 - sh / 2, cz + o); }
    }
  }
  const band = (along, cx, cz, len) => [2.3, 4.0].forEach(y => along === 'x' ? m.box(len, 0.12, T + 0.16, 0x6c7780, cx, y, cz) : m.box(T + 0.16, 0.12, len, 0x6c7780, cx, y, cz));
  const plinth = (along, cx, cz, len) => {
    if (along === 'x') { s.box(len + 0.2, 1.0, T + 0.12, CONC, cx, 0.5, cz); s.box(len + 0.24, 0.06, T + 0.16, mulCol(CONC, 1.15), cx, 1.03, cz); }
    else { s.box(T + 0.12, 1.0, len, CONC, cx, 0.5, cz); s.box(T + 0.16, 0.06, len, mulCol(CONC, 1.15), cx, 1.03, cz); }
  };
  panel('x', x, z - D / 2, W, 0, H); colBox(x, z - D / 2, W / 2, T / 2); band('x', x, z - D / 2, W); plinth('x', x, z - D / 2, W);
  panel('z', x - W / 2, z, D, 0, H); colBox(x - W / 2, z, T / 2, D / 2); band('z', x - W / 2, z, D); plinth('z', x - W / 2, z, D);
  panel('z', x + W / 2, z, D, 0, H); colBox(x + W / 2, z, T / 2, D / 2); band('z', x + W / 2, z, D); plinth('z', x + W / 2, z, D);
  [-1, 1].forEach(sg => { const cx = x + sg * (2.5 + seg / 2); panel('x', cx, z + D / 2, seg, 0, H); colBox(cx, z + D / 2, seg / 2, T / 2); band('x', cx, z + D / 2, seg); plinth('x', cx, z + D / 2, seg); });
  panel('x', x, z + D / 2, 5, 4.2, H); // перемычка над воротами
  // угловые стойки, стойки ворот
  [-1, 1].forEach(sx => [-1, 1].forEach(sz => {
    const cx = x + sx * W / 2, cz = z + sz * D / 2;
    m.box(0.6, H + 0.2, 0.6, DARK, cx, (H + 0.2) / 2, cz); m.box(0.8, 0.12, 0.8, 0x24282b, cx, 0.06, cz);
    [1.2, 3.0, 4.8].forEach(y => [-1, 1].forEach(q => m.box(0.06, 0.06, 0.04, 0x9aa0a8, cx + q * 0.18, y, cz + sz * 0.31)));
  }));
  [-2.5, 2.5].forEach(ox => { m.box(0.4, 4.4, 0.5, DARK, x + ox, 2.2, z + D / 2); m.box(0.5, 0.1, 0.6, 0x24282b, x + ox, 0.05, z + D / 2); });
  // пол и разметка
  d.box(W - 0.4, 0.04, D - 0.4, 0x5e5e58, x, 0.02, z);
  [-2.6, 1.9].forEach(ox => d.box(0.12, 0.01, D - 1.4, 0xb89a24, x + ox, 0.045, z));
  d.box(W - 1.6, 0.01, 0.12, 0xb89a24, x, 0.045, z + D / 2 - 1.0);
  for (let i = 0; i < 5; i++) d.box(0.05, 0.01, 0.6 + h01(i, x, z) * 1.6, 0x3a3a36, x - 6 + i * 2.7 + h01(i + 4, x, z), 0.046, z - 3 + h01(i + 7, x, z) * 6, 0, h01(i + 2, x, z) - 0.5, 0); // трещины
  // крыша: два ската из рифлёного листа, конёк, желоба, ржавые пятна
  const hs = D / 2 + 0.7, rise = 2.5, a = Math.atan2(rise, hs), L = Math.hypot(hs, rise), RW = W + 1.4;
  [-1, 1].forEach(sg => {
    K.xf(m4(x, H + rise / 2, z + sg * hs / 2, sg * a, 0, 0), () => {
      r.box(RW, 0.12, L, 0x7a4636, 0, 0, 0);
      for (let i = 0; i < Math.floor(RW / 0.55); i++) r.box(0.1, 0.07, L, i % 2 ? 0x6a3a2c : 0x84503e, -RW / 2 + 0.3 + i * 0.55, 0.08, 0);
      for (let i = 0; i < 4; i++) { const px = (h01(i, x + sg, z) - 0.5) * (RW - 3), pz = (h01(i + 5, x, z + sg) - 0.5) * (L - 2); r.box(0.8 + h01(i + 1, z, x), 0.02, 0.6 + h01(i + 3, z, x) * 0.8, 0x4a2a20, px, 0.075, pz); }
      m.box(RW, 0.1, 0.2, 0x4a4f55, 0, -0.05, sg * L / 2); m.box(RW, 0.14, 0.04, 0x3a3f45, 0, 0.0, sg * (L / 2 + 0.1)); // желоб
    });
  });
  m.box(W + 1.6, 0.14, 0.4, DARK, x, H + rise + 0.05, z);
  [-1, 1].forEach(sx => s.prism([[-D / 2 - 0.02, 0], [D / 2 + 0.02, 0], [0, rise - 0.05]], T, WALL, x + sx * W / 2, H, z, 0, Math.PI / 2, 0)); // фронтоны
  [[-1, -1], [1, 1]].forEach(([sx, sz]) => m.tube([x + sx * (W / 2 + 0.55), 0.2, z + sz * (D / 2 + 0.75)], [x + sx * (W / 2 + 0.55), H - 0.1, z + sz * (D / 2 + 0.75)], 0.07, 0x4a4f55, 6)); // водостоки
  [-8, -4, 0, 4, 8].forEach(ox => { // турбинные вентиляторы на коньке
    const vx = x + ox * 0.9, vy = H + rise + 0.12;
    m.cyl(0.34, 0.12, 0x8a8f94, vx, vy - 0.1, z, 10); m.cyl(0.32, 0.45, 0x9aa0a8, vx, vy, z, 10);
    for (let k = 0; k < 6; k++) { const an = k / 6 * Math.PI * 2; m.box(0.04, 0.42, 0.18, 0x6a6f75, vx + Math.cos(an) * 0.3, vy + 0.22, z + Math.sin(an) * 0.3, 0, -an, 0.0); }
    m.cone(0.4, 0.04, 0.28, 0x7a8086, vx, vy + 0.45, z, 10);
  });
  // стропильные фермы, лампы
  [-6, -2, 2, 6].forEach(tx => {
    const fx = x + tx;
    m.tube([fx, H - 0.15, z - D / 2 + 0.2], [fx, H - 0.15, z + D / 2 - 0.2], 0.05, 0x4a5058, 6);
    [-1, 1].forEach(sg => m.tube([fx, H - 0.1, z + sg * (D / 2 - 0.1)], [fx, H + rise - 0.08, z], 0.05, 0x4a5058, 6));
    m.tube([fx, H - 0.15, z], [fx, H + rise - 0.08, z], 0.045, 0x4a5058, 6);
    [-3, 3].forEach(oz => {
      m.tube([fx, H - 0.15, z + oz], [fx, H - 0.8, z + oz], 0.012, 0x1a1a1a, 4);
      m.cone(0.42, 0.12, 0.26, 0x2a2d2a, fx, H - 1.05, z + oz, 10); g.box(0.22, 0.08, 0.22, 0xfff0cc, fx, H - 1.08, z + oz);
    });
  });
  // окна под крышей: рама, тёмное стекло, часть разбита
  const win = (px, pz, alongX, out, n) => {
    const broken = h01(n, px, pz) > 0.62, ox = alongX ? 0 : out * 0.015, oz = alongX ? out * 0.015 : 0;
    m.box(alongX ? 1.7 : 0.08, 0.95, alongX ? 0.08 : 1.7, DARK, px, 3.9, pz);
    d.box(alongX ? 1.5 : 0.1, 0.75, alongX ? 0.1 : 1.5, broken ? 0x070b0e : 0x1a232b, px + ox, 3.9, pz + oz);
    m.box(alongX ? 0.05 : 0.12, 0.75, alongX ? 0.12 : 0.05, DARK, px + ox, 3.9, pz + oz);
    m.box(alongX ? 1.9 : 0.2, 0.06, alongX ? 0.2 : 1.9, 0x5a5f64, px + out * (alongX ? 0 : 0.06), 3.38, pz + out * (alongX ? 0.06 : 0));
    if (!broken) d.box(alongX ? 0.7 : 0.11, 0.05, alongX ? 0.11 : 0.7, 0x3a4a58, px + ox, 4.0, pz + oz, 0, 0, 0.5);
    else for (let k = 0; k < 3; k++) d.box(alongX ? 0.2 : 0.11, 0.05, alongX ? 0.11 : 0.2, 0x6a8090, px + ox + (alongX ? (k - 1) * 0.45 : 0), 3.6 + k * 0.05, pz + oz + (alongX ? 0 : (k - 1) * 0.45), 0, 0, 0.8 * (k - 1));
  };
  for (let i = -2; i <= 2; i++) win(x + i * 3, z - D / 2 - T / 2 - 0.04, true, -1, i + 3);
  [-1, 1].forEach(sx => [-3.5, 0, 3.5].forEach((oz, k) => win(x + sx * (W / 2 + T / 2 + 0.04), z + oz, false, sx, k + 7)));
  // ворота: направляющая, сдвинутая створка с рёбрами и роликами, пандус с полосами
  const gz = z + D / 2 + 0.32;
  m.box(8, 0.18, 0.2, DARK, x - 1.5, 4.5, z + D / 2 + 0.3);
  [-4.6, -2.6, -0.6, 1.4, 2.4].forEach(ox => m.box(0.1, 0.3, 0.14, DARK, x + ox, 4.3, z + D / 2 + 0.26));
  m.box(3.2, 4.0, 0.16, WALL, x - 4.1, 2.0, gz);
  for (let i = 0; i < 6; i++) m.box(0.2, 3.9, 0.22, i % 2 ? RIB : mulCol(WALL, 1.06), x - 5.5 + i * 0.55, 2.0, gz);
  [0.9, 2.4, 3.6].forEach(y => m.box(3.3, 0.14, 0.26, 0x6c7780, x - 4.1, y, gz));
  m.box(0.1, 0.5, 0.1, 0x24282b, x - 2.8, 1.2, gz + 0.16); [-1.6, -0.2].forEach(o => m.cylZ(0.12, 0.1, 0x24282b, x - 4.1 + o - 0.1, 4.4, z + D / 2 + 0.3, 8));
  m.box(7, 0.06, 0.2, 0x24282b, x - 2.1, 0.04, gz); // нижняя направляющая
  const sc = document.createElement('canvas'); sc.width = 256; sc.height = 64;
  const sx2 = sc.getContext('2d'); sx2.fillStyle = '#23282c'; sx2.fillRect(0, 0, 256, 64);
  sx2.fillStyle = '#e8dfc8'; sx2.font = 'bold 40px monospace'; sx2.textAlign = 'center'; sx2.fillText('СКЛАД №' + (idx + 1), 128, 46);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc) }));
  sign.position.set(x, 4.85, z + D / 2 + T / 2 + 0.02); scene.add(sign);
  m.box(3.8, 1.1, 0.03, DARK, x, 4.85, z + D / 2 + T / 2 - 0.0); [-1.75, 1.75].forEach(o => m.box(0.06, 1.1, 0.1, 0x24282b, x + o, 4.85, z + D / 2 + T / 2 + 0.03));
  s.box(6, 0.2, 2.6, CONC, x, 0.1, z + D / 2 + 1.5); s.box(6.1, 0.06, 2.7, mulCol(CONC, 1.12), x, 0.21, z + D / 2 + 1.5);
  for (let i = 0; i < 15; i++) d.box(0.4, 0.012, 0.16, i % 2 ? 0x151515 : 0xe0b020, x - 2.8 + i * 0.4, 0.232, z + D / 2 + 2.75);
  [[-3.2, 7.6], [3.2, 7.6], [-3.2, 9.6], [3.2, 9.6]].forEach(([ox, oz]) => { m.cyl(0.1, 0.9, 0xe0b020, x + ox, 0, z + oz, 8); m.cyl(0.104, 0.12, 0x151515, x + ox, 0.55, z + oz, 8); m.cyl(0.11, 0.03, 0x24282b, x + ox, 0.9, z + oz, 8); }); // столбики у ворот
  // труба вдоль задней стены с кронштейнами, прожектор на столбе
  m.cylX(0.07, 12, 0x6a6f75, x, 3.0, z - 6.5, 8); [-5, -1.7, 1.7, 5].forEach(ox => m.box(0.08, 0.08, 0.38, DARK, x + ox, 3.0, z - 6.35)); [-6, 6].forEach(ox => m.cylX(0.1, 0.12, 0x4a4f55, x + ox, 3.0, z - 6.5, 8));
  m.tube([x - 10, 0, z + 7], [x - 10, 7, z + 7], 0.09, 0x4a4f55, 6); m.box(1.0, 0.12, 0.6, DARK, x - 10, 7.0, z + 6.9); g.box(0.9, 0.3, 0.5, 0xfff0cc, x - 10, 7.1, z + 6.8); colBox(x - 10, z + 7, 0.2, 0.2);
  // внутри: стеллажи (порядок и числа как в 1.8.0), бочки, штабели ящиков
  rackK(K, x - W / 2 + 0.9, z - 3.4, 'z', 3.6, true); rackK(K, x - W / 2 + 0.9, z + 0.5, 'z', 3.6, true);
  rackK(K, x + W / 2 - 0.9, z - 3.4, 'z', 3.6, true); rackK(K, x + W / 2 - 0.9, z + 0.5, 'z', 3.6, true);
  rackK(K, x - 3.8, z - D / 2 + 0.9, 'x', 4.0, true); rackK(K, x + 0.4, z - D / 2 + 0.9, 'x', 4.0, true);
  barrelsK(K, x + 5.4, z + 3.6, 5);
  for (let i = 0; i < 2; i++) { // штабели ящиков на поддонах
    const cx = x - 5.4 + i * 1.7, cz = z + 4.2;
    s.box(1.5, 0.1, 1.3, 0x8a6a3a, cx, 0.05, cz); crateK(s, 1.4, 0.8, 1.2, 0x7a5c34, cx, 0.1, cz); colBox(cx, cz, 0.7, 0.6);
    crateK(d, 1.0, 0.7, 0.9, 0x5e6b4a, cx, 0.9, cz);
  }
  K.finish();
  // люк в подвал
  const hx = x + 3.6, hz = z - 2.2;
  const hatch = makeHatch(); hatch.position.set(hx, 0.04, hz); scene.add(hatch);
  const hole = makeHole(); hole.position.set(hx, 0.04, hz); hole.visible = false; scene.add(hole);
  const bx = 600 + idx * 60, bz = 600;
  const lad = buildBasement(bx, bz);
  return { id: idx, x, z, hx, hz, hatch, hole, hp: 7, state: 'closed', bx, bz, ladderX: lad.x, ladderZ: lad.z };
}

function buildBasement(bx, bz) { // подземное помещение (далеко за краем карты, туда попадают через люк)
  const W = 18, D = 12, H = 3.4, T = 0.5, K = bKit(bx, bz, 3), { s, d, m, g } = K;
  const WALL = 0x5a5c58;
  [[bx, bz - D / 2, W + T, T], [bx, bz + D / 2, W + T, T], [bx - W / 2, bz, T, D], [bx + W / 2, bz, T, D]].forEach(([cx, cz, w, dd]) => {
    s.box(w, H, dd, WALL, cx, H / 2, cz); colBox(cx, cz, w / 2, dd / 2);
  });
  // следы опалубки, сырость, трещины на внутренних стенах
  for (let i = -3; i <= 3; i++) {
    [-1, 1].forEach(sd => d.box(0.1, H, 0.06, 0x4e504c, bx + i * 2.6, H / 2, bz + sd * (D / 2 - T / 2 - 0.02)));
    if (h01(i, bx, bz) > 0.45) d.box(1.4 + h01(i + 3, bx, bz), 0.7 + h01(i + 5, bx, bz) * 0.6, 0.03, 0x3e4a3e, bx + i * 2.6 + 0.6, 0.4, bz - D / 2 + T / 2 + 0.02); // зелёная плесень внизу
    if (h01(i + 8, bx, bz) > 0.55) m.tube([bx + i * 2.4, H - 0.1, bz + D / 2 - T / 2 - 0.03], [bx + i * 2.4 + 0.25, H - 1.0, bz + D / 2 - T / 2 - 0.03], 0.012, 0x24282b, 4);
  }
  d.box(W, 0.1, D, 0x474846, bx, -0.05, bz);
  for (let i = 0; i < 6; i++) d.box(0.8 + h01(i, bx, bz) * 1.4, 0.012, 0.6 + h01(i + 4, bx, bz) * 0.9, 0x2e3436, bx - 6 + i * 2.3, 0.006, bz - 2 + h01(i + 2, bx, bz) * 4); // лужи
  d.box(W, 0.2, D, 0x3a3b3a, bx, H + 0.1, bz);
  d.box(0.9, 0.02, 0.9, 0x1a1c1a, bx + 2.5, 0.01, bz + 0.2); [-0.3, 0, 0.3].forEach(o => d.box(0.8, 0.02, 0.04, 0x55585a, bx + 2.5, 0.02, bz + 0.2 + o)); // сливная решётка
  [-1, 1].forEach(sx => [-1, 1].forEach(sz => { // колонны с плинтусом, капителью и предупреждающей полосой
    const cx = bx + sx * 4.5, cz = bz + sz * 1.8;
    s.box(0.7, H, 0.7, 0x6a6c68, cx, H / 2, cz); colBox(cx, cz, 0.35, 0.35);
    s.box(0.9, 0.18, 0.9, 0x5a5c58, cx, 0.09, cz); s.box(0.86, 0.22, 0.86, 0x5a5c58, cx, H - 0.11, cz);
    for (let k = 0; k < 5; k++) d.box(0.74, 0.12, 0.74, k % 2 ? 0x151515 : 0xe0b020, cx, 1.0 + k * 0.12, cz);
  }));
  for (let i = 0; i < 5; i++) { s.box(0.35, 0.3, D, 0x2f302f, bx - 8 + i * 4, H - 0.15, bz); m.box(0.5, 0.04, D, 0x4a4b4a, bx - 8 + i * 4, H - 0.32, bz); } // балки
  [[-5.4, 2.85], [-5.4, 2.55], [5.4, 2.85]].forEach(([oz, y]) => { // трубы с фланцами, кронштейнами и вентилем
    m.cylX(0.08, W - 1, 0x6b5a48, bx, y, bz + oz, 8);
    for (let k = -3; k <= 3; k++) { m.cylX(0.115, 0.06, 0x3a3a3a, bx + k * 2.5, y, bz + oz, 8); m.box(0.05, 0.05, 0.3, 0x2a2a2a, bx + k * 2.5 + 0.3, y, bz + oz + Math.sign(oz) * 0.15); }
  });
  m.cyl(0.04, 0.3, 0x8a2b20, bx + 2.2, 2.95, bz - 5.4, 6); m.cylX(0.16, 0.05, 0x8a2b20, bx + 2.2, 3.25, bz - 5.4, 8);
  m.tube([bx - 8.4, 2.85, bz - 5.4], [bx - 8.4, 0.1, bz - 5.4], 0.07, 0x6b5a48, 8); // стояк
  [-5, 0, 5].forEach(ox => { // подвесные лампы
    m.tube([bx + ox, H - 0.3, bz], [bx + ox, H - 0.5, bz], 0.01, 0x6b5a48, 4);
    m.cone(0.34, 0.1, 0.24, 0x2a2d2a, bx + ox, H - 0.74, bz, 8); g.box(0.16, 0.12, 0.16, 0xffd9a0, bx + ox, H - 0.74, bz);
  });
  // щиток с проводами у западной стены
  m.box(0.1, 0.9, 0.7, 0x4a5a4a, bx - W / 2 + T / 2 + 0.07, 1.5, bz - 3.2); m.box(0.04, 0.5, 0.5, 0x2a2d2a, bx - W / 2 + T / 2 + 0.14, 1.5, bz - 3.2); g.box(0.02, 0.04, 0.04, 0x3aff3a, bx - W / 2 + T / 2 + 0.17, 1.65, bz - 3.0);
  // лестница вверх у восточной стены и светлое пятно люка
  const lx = bx + W / 2 - 0.45;
  [-0.35, 0.35].forEach(oz => d.box(0.07, H, 0.07, 0x7a5c34, lx, H / 2, bz + oz));
  for (let i = 0; i < 9; i++) d.box(0.05, 0.05, 0.7, 0x7a5c34, lx, 0.3 + i * 0.34, bz);
  g.box(1.0, 0.02, 1.0, 0xcfe6ff, lx - 0.1, H - 0.01, bz);
  m.box(1.3, 0.06, 0.1, 0x2f3236, lx - 0.1, H - 0.05, bz - 0.55); m.box(1.3, 0.06, 0.1, 0x2f3236, lx - 0.1, H - 0.05, bz + 0.55);
  // стеллажи и бочки (порядок и числа как в 1.8.0)
  rackK(K, bx - 4.5, bz - 5.1, 'x', 4.2, true); rackK(K, bx + 1.0, bz - 5.1, 'x', 4.2, true);
  rackK(K, bx - 4.5, bz + 5.1, 'x', 4.2, true); rackK(K, bx + 1.0, bz + 5.1, 'x', 4.2, true);
  barrelsK(K, bx + 6.4, bz + 4.2, 4);
  K.finish();
  return { x: lx - 1.1, z: bz };
}

(function placeWarehouses() {
  const spots = [];
  for (let tries = 0; tries < 500 && spots.length < 2; tries++) {
    const x = (Math.random() - 0.5) * 260, z = (Math.random() - 0.5) * 260;
    if (Math.abs(x) < 24 || Math.abs(z) < 24) continue;                         // не на дорогах и не у старта
    if (housePositions.some(h => Math.hypot(h.x - x, h.z - z) < 26)) continue;   // не вплотную к домам
    if (spots.some(p => Math.hypot(p.x - x, p.z - z) < 60)) continue;
    spots.push({ x, z });
  }
  spots.forEach((p, i) => warehouses.push(buildWarehouse(p.x, p.z, i)));
})();

// --- Новые здания: заправка, автосервис (гараж) и водонапорная башня ---
const stations = [], garages = [], towers = [], outposts = [], armories = [];
const specials = warehouses.map(w => ({ x: w.x, z: w.z, r: 20 }));
const std = (c, r, m) => new THREE.MeshStandardMaterial({ color: c, roughness: r === undefined ? 0.9 : r, metalness: m || 0, flatShading: true });
function slab(w, h, d, mat, px, py, pz, solid, bullet) { // коробка с коллизией и защитой от пуль по желанию
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(px, py, pz); scene.add(m);
  if (solid) colliders.push({ minX: px - w / 2, maxX: px + w / 2, minZ: pz - d / 2, maxZ: pz + d / 2 });
  if (solid || bullet) blockers.push(m);
  return m;
}
function clearTrees(x, z, hw, hd) { // убираем деревья на участке
  for (let i = trees.length - 1; i >= 0; i--) {
    const t = trees[i], p = t.trunk.position;
    if (Math.abs(p.x - x) < hw && Math.abs(p.z - z) < hd) {
      scene.remove(t.trunk); scene.remove(t.crown);
      removeFrom(colliders, t.collider); removeFrom(blockers, t.trunk); trees.splice(i, 1);
    }
  }
}
function findSpot(r) { // свободное место: не у дорог, не у домов и других построек
  for (let t = 0; t < 700; t++) {
    const x = (Math.random() - 0.5) * 270, z = (Math.random() - 0.5) * 270;
    if (Math.abs(x) < 24 || Math.abs(z) < 24) continue;
    if (housePositions.some(h => Math.hypot(h.x - x, h.z - z) < r + 8)) continue;
    if (specials.some(s => Math.hypot(s.x - x, s.z - z) < r + s.r)) continue;
    specials.push({ x, z, r });
    return { x, z };
  }
  return null;
}
function textPlane(text, w, h, bg, fg, px, py, pz, rotY) { // вывеска с надписью
  const c = document.createElement('canvas'); c.width = 256; c.height = Math.round(256 * h / w);
  const g = c.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = fg; g.font = 'bold ' + Math.round(c.height * 0.58) + 'px monospace'; g.textAlign = 'center'; g.fillText(text, 128, c.height * 0.72);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) }));
  m.position.set(px, py, pz); m.rotation.y = rotY || 0; scene.add(m);
  return m;
}
function gable(W, D, rise, mat, x, y, z) { // двускатная крыша, конёк вдоль X
  const sh = new THREE.Shape(); sh.moveTo(-D / 2 - 0.5, 0); sh.lineTo(D / 2 + 0.5, 0); sh.lineTo(0, rise); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: W + 1, bevelEnabled: false });
  g.translate(0, 0, -(W + 1) / 2); g.rotateY(Math.PI / 2);
  const m = new THREE.Mesh(g, mat); m.material.side = THREE.DoubleSide; m.position.set(x, y, z); scene.add(m); blockers.push(m);
  return m;
}

// --- Техника и мелкие конструкции (1.9.0): всё собирается в кучи деталей здания, у которого стоит ---
const ctr = (a, z, rotY) => ({ al: Math.abs(Math.sin(rotY)) < 0.5, M: m4(a, 0, z, 0, rotY, 0) }); // ось техники: вдоль X (al) или вдоль Z
function carK(K, x, z, rotY, color, flip) { // ржавый остов легковой машины: кузов, провалы окон, открытая дверь, одно колесо снято
  const dark = 0x1a1a1a, rust = 0x6b4a2a, glass = 0x141b21, chrome = 0x777c82, { al } = ctr(x, z, rotY);
  K.xf(m4(x, 0, z, 0, rotY, 0), () => {
    const { ms, m, d } = K;
    ms.box(1.8, 0.5, 4.2, color, 0, 0.62, 0); ms.box(1.7, 0.1, 4.0, mulCol(color, 0.7), 0, 0.3, 0);
    ms.box(1.72, 0.1, 1.35, color, 0, 0.93, -1.45, -0.09, 0, 0); ms.box(1.72, 0.1, 0.9, color, 0, 0.93, 1.6, 0.05, 0, 0); // капот и багажник
    ms.box(1.6, 0.5, 1.8, color, 0, 1.28, 0.1);                       // салон
    d.box(1.52, 0.04, 1.6, rust, 0, 1.56, 0.1);                       // ржавая крыша
    m.box(1.5, 0.46, 0.05, glass, 0, 1.3, -0.82, 0.45, 0, 0);          // лобовое (стекла нет)
    [-1, 1].forEach(sd => { [-0.7, 0.1, 0.9].forEach(pz => m.box(0.07, 0.52, 0.07, mulCol(color, 0.8), sd * 0.78, 1.28, pz)); d.box(0.03, 0.4, 0.7, glass, sd * 0.805, 1.28, -0.3); d.box(0.03, 0.4, 0.7, glass, sd * 0.805, 1.28, 0.5); });
    m.box(0.07, 0.5, 0.95, color, -1.28, 0.78, -0.15, 0, flip ? -1.0 : 1.0, 0);   // открытая дверь
    m.box(1.9, 0.14, 0.2, 0x555a60, 0, 0.42, -2.15); m.box(1.9, 0.14, 0.2, 0x555a60, 0, 0.42, 2.15);
    d.box(0.95, 0.22, 0.04, dark, 0, 0.74, -2.11); [-0.7, 0.7].forEach(sx => { d.box(0.28, 0.18, 0.06, 0x8a9096, sx, 0.75, -2.1); d.box(0.26, 0.14, 0.06, 0x6a1a14, sx, 0.78, 2.1); });
    d.box(0.5, 0.12, 0.02, 0xc8c2a8, 0, 0.56, 2.115); d.box(0.3, 0.03, 0.02, 0x3a3a3a, 0, 0.56, 2.12);
    [[-0.9, -1.3], [0.9, -1.3], [-0.9, 1.3]].forEach(([wx, wz]) => { m.cylX(0.38, 0.28, dark, wx, 0.38, wz, 10); m.cylX(0.2, 0.3, chrome, wx, 0.38, wz, 8); });
    m.cylX(0.1, 0.18, 0x6a4a2a, 0.82, 0.38, 1.3, 8); m.cyl(0.38, 0.28, dark, 1.9, 0, 0.7, 10); m.cyl(0.2, 0.3, chrome, 1.9, 0, 0.7, 8); // ступица и снятое колесо рядом
    d.box(0.5, 0.02, 0.8, rust, 0.4, 0.99, -1.3); d.box(0.6, 0.02, 0.5, rust, -0.5, 0.99, 1.7); d.box(0.04, 0.4, 0.9, rust, 0.9, 0.62, 0.6);
  });
  colBox(x, z, al ? 0.95 : 2.1, al ? 2.1 : 0.95);
}
function tankerK(K, x, z, rotY) { // ржавая цистерна на шасси (длинная ось Z при rotY = 0)
  const silver = 0x8a9096, rust = 0x6b4a2a, dark = 0x1a1a1a, cab = 0xa83222, { al } = ctr(x, z, rotY);
  K.xf(m4(x, 0, z, 0, rotY, 0), () => {
    const { ms, m, d } = K;
    ms.frustum(1.1, 1.1, 6.5, 14, silver, m4(0, 1.95, 0.6, Math.PI / 2, 0, 0));
    [-2, 0, 2, 3.6].forEach(zz => ms.frustum(1.14, 1.14, 0.18, 14, rust, m4(0, 1.95, zz, Math.PI / 2, 0, 0)));
    m.frustum(1.0, 0.8, 0.22, 14, 0x6a6f75, m4(0, 1.95, 3.9, Math.PI / 2, 0, 0)); m.frustum(0.8, 1.0, 0.22, 14, 0x6a6f75, m4(0, 1.95, -2.7, Math.PI / 2, 0, 0)); // днища
    m.box(1.6, 0.35, 8.2, 0x2f3438, 0, 0.8, 0.4);
    ms.box(2.1, 1.7, 1.9, cab, 0, 1.7, -4.2); ms.box(2.0, 0.5, 0.9, mulCol(cab, 0.85), 0, 0.9, -5.05); m.box(1.9, 0.6, 0.06, 0x1a232b, 0, 2.1, -5.17);
    m.box(1.7, 0.3, 0.12, 0x555a60, 0, 0.55, -5.55); d.box(1.1, 0.4, 0.04, dark, 0, 1.0, -5.52);
    [-0.7, 0.7].forEach(sx => { d.box(0.3, 0.2, 0.05, 0x9a9a88, sx, 1.15, -5.53); d.box(0.1, 0.4, 0.1, 0x3a3f45, sx * 1.6, 2.0, -5.1); });
    m.tube([0.8, 0.9, -3.3], [0.8, 3.6, -3.3], 0.07, 0x555a60, 6);                         // выхлопная труба
    m.cyl(0.32, 0.25, silver, 0, 3.0, 0.6, 10); m.cyl(0.36, 0.05, 0x444a50, 0, 3.22, 0.6, 10); // люк
    [-1, 1].forEach(sd => m.tube([sd * 0.7, 0.9, 3.9], [sd * 0.7, 2.9, 3.9], 0.03, 0x6a6f75, 4));
    for (let k = 0; k < 6; k++) m.tube([-0.65, 0.9 + k * 0.3, 3.95], [0.65, 0.9 + k * 0.3, 3.95], 0.02, 0x6a6f75, 4); // лесенка сзади
    [-1, 1].forEach(sd => { d.box(0.02, 0.5, 0.5, 0xc9a227, sd * 1.11, 2.1, 0.6, Math.PI / 4, 0, 0); d.box(0.02, 0.12, 1.6, 0xd8d0b0, sd * 1.11, 1.45, 0.6); }); // знак опасности и полоса
    [-3.9, -0.5, 1.1, 2.7].forEach(wz => [-1, 1].forEach(sx => { m.cylX(0.45, 0.32, dark, sx * 0.95, 0.45, wz, 10); m.cylX(0.22, 0.34, 0x6a6f75, sx * 0.95, 0.45, wz, 8); }));
  });
  colBox(x, z, al ? 1.2 : 4.6, al ? 4.6 : 1.2);
}
function milTruckK(K, x, z, rotY) { // военный грузовик-остов с тентом
  const olive = 0x4a5230, tent = 0x55603a, dark = 0x1a1a1a, { al } = ctr(x, z, rotY);
  K.xf(m4(x, 0, z, 0, rotY, 0), () => {
    const { ms, m, d } = K;
    ms.box(2.2, 1.5, 1.9, olive, 0, 1.55, -2.1); ms.box(1.9, 0.6, 0.9, mulCol(olive, 0.9), 0, 1.0, -3.4); m.box(1.9, 0.5, 0.06, 0x1a232b, 0, 1.9, -3.07);
    m.box(2.0, 0.22, 0.2, 0x555a60, 0, 0.55, -3.9); [-0.7, 0.7].forEach(sx => d.box(0.26, 0.18, 0.05, 0x9a9a80, sx, 1.1, -3.87));
    ms.box(2.3, 0.4, 4.4, 0x3a4226, 0, 0.95, 1.2);
    for (let k = 0; k < 5; k++) ms.box(2.3, 1.7, 0.1, mulCol(tent, 0.9), 0, 2.0, -0.7 + k * 1.0); // каркас тента
    ms.box(2.3, 1.6, 4.2, tent, 0, 2.0, 1.2); ms.box(2.2, 0.15, 4.2, mulCol(tent, 1.12), 0, 2.85, 1.2);
    m.box(2.0, 0.9, 0.06, mulCol(tent, 0.7), 0, 1.8, 3.34); m.box(2.3, 0.06, 0.2, 0x555a60, 0, 0.7, 3.5);                // задний полог и подножка
    [-1, 1].forEach(sd => d.box(0.02, 0.45, 0.45, 0xd8d0b0, sd * 1.11, 1.55, -2.1, Math.PI / 4, 0, 0));                    // звезда (знак)
    m.cylX(0.3, 0.2, 0x3a3f45, 0, 0.8, -4.1, 8);                                                                          // лебёдка
    [-3.0, 0.2, 2.2].forEach(wz => [-1, 1].forEach(sx => { m.cylX(0.5, 0.36, dark, sx * 1.05, 0.5, wz, 10); m.cylX(0.26, 0.38, 0x4a4f55, sx * 1.05, 0.5, wz, 8); }));
    m.cyl(0.4, 0.3, dark, 1.5, 1.1, 3.2, 10);                                                                              // запаска
  });
  colBox(x, z, al ? 1.3 : 3.4, al ? 3.4 : 1.3);
}
function containerK(K, x, z, rotY, colors, stack) { // грузовой контейнер: гофра, угловые фитинги, запорные штанги; можно стопкой
  const L = 6.0, W2 = 2.4, H2 = 2.6, c0 = parseInt(colors[0].slice(1), 16), c1 = parseInt(colors[1].slice(1), 16);
  K.xf(m4(x, 0, z, 0, rotY, 0), () => {
    const { ms, m, d } = K;
    for (let k = 0; k < stack; k++) {
      const y0 = k * H2;
      ms.box(L, H2 - 0.14, W2 - 0.1, c0, 0, y0 + H2 / 2, 0);
      for (let i = 0; i < 20; i++) [-1, 1].forEach(sd => ms.box(0.14, H2 - 0.3, 0.07, i % 2 ? c1 : mulCol(c0, 1.07), -L / 2 + 0.55 + i * 0.26, y0 + H2 / 2, sd * (W2 / 2 - 0.02))); // гофра
      for (let i = 0; i < 8; i++) ms.box(0.14, 0.05, W2 - 0.2, i % 2 ? c1 : mulCol(c0, 1.07), -L / 2 + 0.8 + i * 0.6, y0 + H2 - 0.07, 0);                                          // гофра на крыше
      [-1, 1].forEach(sx => [-1, 1].forEach(sz => [0.07, H2 - 0.07].forEach(yy => m.box(0.2, 0.14, 0.2, 0x2a2d30, sx * (L / 2 - 0.1), y0 + yy, sz * (W2 / 2 - 0.1)))));
      [-1, 1].forEach(sd => { m.box(L, 0.1, 0.14, 0x2f3438, 0, y0 + 0.07, sd * (W2 / 2 - 0.05)); m.box(L, 0.1, 0.14, 0x2f3438, 0, y0 + H2 - 0.07, sd * (W2 / 2 - 0.05)); });
      for (let i = 0; i < 4; i++) m.box(0.06, H2 - 0.3, 0.06, 0x8a8f94, -L / 2 - 0.02, y0 + H2 / 2, -0.8 + i * 0.53); // запорные штанги на торце
      m.box(0.1, 0.18, 0.1, 0x2a2d30, -L / 2 - 0.05, y0 + 1.2, -0.8); m.box(0.1, 0.18, 0.1, 0x2a2d30, -L / 2 - 0.05, y0 + 1.2, 0.8);
      d.box(0.02, 0.4, 0.9, 0xd8d0b0, 1.0, y0 + 1.9, W2 / 2 + 0.03); d.box(0.9, 0.04, 0.02, 0xd8d0b0, 1.0, y0 + 1.6, W2 / 2 + 0.03);          // маркировка
      for (let i = 0; i < 3; i++) d.box(0.5 + h01(i + k, x, z) * 0.5, 0.9 + h01(i + 3, x, z) * 0.8, 0.012, 0x6a3a22, -2 + i * 1.7, y0 + 1.0, W2 / 2 + 0.035); // ржавые потёки
    }
  });
  const al = Math.abs(Math.sin(rotY)) < 0.5; colBox(x, z, al ? L / 2 : W2 / 2, al ? W2 / 2 : L / 2);
}
function forkliftK(K, x, z, rotY) { // погрузчик: рама, защитная клетка, сиденье, руль, мачта с цепями, вилы, маячок
  const yel = 0xd9a21b, blk = 0x1a1a1a, steel = 0x6a6f75, { al } = ctr(x, z, rotY);
  K.xf(m4(x, 0, z, 0, rotY, 0), () => {
    const { ms, m, d, g } = K;
    ms.box(1.1, 0.7, 1.9, yel, 0, 0.75, 0.2); ms.box(1.1, 0.5, 0.7, blk, 0, 0.95, 1.2); ms.box(1.0, 0.35, 0.5, mulCol(yel, 0.85), 0, 1.15, 1.45);   // корпус, противовес
    d.box(0.5, 0.1, 0.45, blk, 0, 1.15, 0.35); d.box(0.5, 0.4, 0.1, blk, 0, 1.4, 0.55);                                                              // сиденье
    m.tube([0, 1.2, -0.2], [0, 1.6, -0.45], 0.025, blk, 5); m.cylX(0.16, 0.03, blk, 0, 1.62, -0.48, 10);                                               // руль
    [-0.5, 0.5].forEach(sx => { m.box(0.06, 1.1, 0.06, steel, sx, 1.7, 0.1); m.box(0.06, 1.1, 0.06, steel, sx, 1.7, -0.5); });                        // клетка
    m.box(1.15, 0.06, 0.7, steel, 0, 2.25, -0.2); [-0.5, 0, 0.5].forEach(sx => m.box(0.04, 0.04, 0.7, steel, sx, 2.29, -0.2));
    g.box(0.16, 0.14, 0.16, 0xffa020, 0.45, 2.38, 0.0);                                                                                               // маячок
    [-0.35, 0.35].forEach(sx => m.box(0.08, 2.4, 0.08, steel, sx, 1.4, -0.95)); m.box(0.9, 0.08, 0.1, steel, 0, 1.1, -0.9); m.box(0.9, 0.06, 0.1, steel, 0, 2.5, -0.95);
    m.tube([-0.12, 2.5, -0.95], [-0.12, 1.3, -0.95], 0.012, 0x222222, 4); m.tube([0.12, 2.5, -0.95], [0.12, 1.3, -0.95], 0.012, 0x222222, 4);               // цепи
    [-0.3, 0.3].forEach(sx => { m.box(0.12, 0.06, 1.2, steel, sx, 0.25, -1.55); m.box(0.12, 0.9, 0.05, steel, sx, 0.7, -0.98); });                   // вилы
    m.tube([0.3, 0.9, 0.9], [0.3, 2.0, 0.9], 0.03, 0x444444, 5);
    [[-0.55, -0.5], [0.55, -0.5], [-0.5, 1.0], [0.5, 1.0]].forEach(([wx, wz]) => { m.cylX(0.3, 0.22, blk, wx, 0.3, wz, 10); m.cylX(0.14, 0.24, 0x8a8f94, wx, 0.3, wz, 8); });
  });
  colBox(x, z, al ? 0.7 : 1.9, al ? 1.9 : 0.7);
}
function mastK(K, x, z, h) { // мачта связи: решётка, красная лампа, антенны и растяжки
  const steel = 0x6a6f75, { m, g } = K;
  [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1]].forEach(([ox, oz]) => m.tube([x + ox, 0, z + oz], [x + ox * 0.5, h, z + oz * 0.5], 0.02, steel, 5));
  for (let y = 0.8; y < h; y += 0.8) { const k = 1 - y / h * 0.5, q = 0.1 * k; m.tube([x - q, y, z - q], [x + q, y + 0.4, z - q], 0.012, steel, 4); m.tube([x - q, y, z + q], [x + q, y + 0.4, z + q], 0.012, steel, 4); }
  m.box(0.3, 0.2, 0.3, 0x2a2d30, x, 0.1, z); g.box(0.14, 0.14, 0.14, 0xff2a1a, x, h + 0.1, z);
  m.box(0.6, 0.04, 0.04, steel, x, h * 0.8, z); m.tube([x + 0.3, h * 0.8, z], [x + 0.3, h * 0.8 + 0.7, z], 0.01, steel, 4); m.cylX(0.3, 0.04, 0x9aa0a8, x - 0.3, h * 0.72, z, 10);
  m.box(0.3, 0.4, 0.2, 0x4a5a4a, x + 0.3, 1.0, z);
  [[1, 1], [-1, 1], [0, -1.4]].forEach(([dx, dz]) => m.tube([x, h * 0.85, z], [x + dx * 3, 0, z + dz * 3], 0.008, steel, 3));
  colBox(x, z, 0.2, 0.2);
}
function sandWallK(K, x1, z1, x2, z2, h) { // стена из мешков с песком: ряды со сдвигом, завязки, местами осыпавшиеся верхние мешки
  const L = Math.hypot(x2 - x1, z2 - z1), cx = (x1 + x2) / 2, cz = (z1 + z2) / 2, alongX = Math.abs(x2 - x1) > Math.abs(z2 - z1);
  const rows = Math.max(3, Math.round(h / 0.27)), rh = h / rows, n = Math.max(1, Math.round(L / 0.62)), bl = L / n, sand = [0xb8a37a, 0xc7b285, 0xa8946a, 0x9a8a62];
  for (let row = 0; row < rows; row++) {
    const half = row % 2, cnt = n + half;
    for (let i = 0; i < cnt; i++) {
      let c0 = -L / 2 + (i - half * 0.5) * bl, c1 = c0 + bl; c0 = Math.max(c0, -L / 2); c1 = Math.min(c1, L / 2);
      const len = c1 - c0; if (len < 0.15) continue;
      if (row === rows - 1 && h01(row * 37 + i, cx, cz) > 0.9) continue;
      const mid = (c0 + c1) / 2, col = sand[Math.floor(h01(row * 31 + i, cx, cz) * sand.length)], y = rh * (row + 0.5);
      if (alongX) { K.s.box(len * 0.97, rh * 0.96, 0.7, col, cx + mid, y, cz); K.s.box(0.05, rh * 0.5, 0.5, mulCol(col, 0.7), cx + c1 - 0.03, y, cz); }
      else { K.s.box(0.7, rh * 0.96, len * 0.97, col, cx, y, cz + mid); K.s.box(0.5, rh * 0.5, 0.05, mulCol(col, 0.7), cx, y, cz + c1 - 0.03); }
    }
  }
  colliders.push({ minX: cx - (alongX ? L / 2 : 0.35), maxX: cx + (alongX ? L / 2 : 0.35), minZ: cz - (alongX ? 0.35 : L / 2), maxZ: cz + (alongX ? 0.35 : L / 2) });
}
function addRazorWire(segs, K) { // колючая проволока: колья, две нити и ряд витков одним объектом
  const pts = [];
  segs.forEach(([x1, z1, x2, z2]) => {
    const L = Math.hypot(x2 - x1, z2 - z1), n = Math.round(L / 0.6);
    for (let i = 0; i <= n; i++) pts.push([x1 + (x2 - x1) * i / n, z1 + (z2 - z1) * i / n, Math.abs(x2 - x1) > Math.abs(z2 - z1)]);
    if (K) {
      const ns = Math.max(1, Math.round(L / 3));
      for (let i = 0; i <= ns; i++) K.m.tube([x1 + (x2 - x1) * i / ns, 0, z1 + (z2 - z1) * i / ns], [x1 + (x2 - x1) * i / ns, 1.5, z1 + (z2 - z1) * i / ns], 0.03, 0x4a4f55, 5);
      [0.6, 1.1].forEach(y => K.m.tube([x1, y, z1], [x2, y, z2], 0.006, 0x6a6f75, 3));
    }
  });
  const im = new THREE.InstancedMesh(new THREE.TorusGeometry(0.22, 0.012, 4, 10), std(0x8a9096, 0.4, 0.8), pts.length), dm = new THREE.Object3D();
  pts.forEach((p, i) => { dm.position.set(p[0], 1.32, p[1]); dm.rotation.set(0, p[2] ? Math.PI / 2 : 0, 0); dm.updateMatrix(); im.setMatrixAt(i, dm.matrix); });
  scene.add(im);
}
function fenceK(K, x1, z1, x2, z2, h, colorHex) { // забор из досок (часть выбита, лежит на земле), перекладины и столбы. Случайные числа те же, что в 1.8.0
  const L = Math.hypot(x2 - x1, z2 - z1), n = Math.max(2, Math.round(L / 0.35)), rotY = Math.atan2(-(z2 - z1), x2 - x1), { d } = K;
  const posts = Math.max(2, Math.round(L / 2.4) + 1);
  K.xf(m4((x1 + x2) / 2, 0, (z1 + z2) / 2, 0, rotY, 0), () => {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), sy = 0.85 + Math.random() * 0.3, gone = Math.random() < 0.12, lx = (t - 0.5) * (L);
      if (!gone) { d.box(0.1, h * sy, 0.04, colorHex, lx, h * sy / 2, 0, 0, 0, (h01(i, x1, z1) - 0.5) * 0.04); if (h01(i + 3, x1, z1) > 0.7) d.box(0.1, 0.02, 0.05, mulCol(colorHex, 0.6), lx, h * sy - 0.1, 0); }
      else d.box(0.1, h * 0.8, 0.04, mulCol(colorHex, 0.85), lx + 0.2, 0.03, 0.35, Math.PI / 2, 0.3, 0.1); // выбитая доска на земле
    }
    [0.3, 0.75].forEach(k => d.box(L, 0.08, 0.05, colorHex, 0, h * k, -0.045));
    for (let i = 0; i < posts; i++) { const lx = (i / (posts - 1) - 0.5) * L; d.box(0.12, h + 0.12, 0.1, mulCol(colorHex, 0.8), lx, (h + 0.12) / 2, -0.08); d.box(0.14, 0.04, 0.12, mulCol(colorHex, 0.65), lx, h + 0.14, -0.08); }
  });
  colliders.push({ minX: (x1 + x2) / 2 - (Math.abs(x2 - x1) / 2 + 0.1), maxX: (x1 + x2) / 2 + (Math.abs(x2 - x1) / 2 + 0.1), minZ: (z1 + z2) / 2 - (Math.abs(z2 - z1) / 2 + 0.1), maxZ: (z1 + z2) / 2 + (Math.abs(z2 - z1) / 2 + 0.1), top: h });
}

function buildGasStation(x, z) {
  clearTrees(x, z, 16, 14);
  const K = bKit(x, z, 11), { s, r, d, m, ms, g } = K;
  const WHITE = 0xe6e2d6, RED = 0xb02a1a, CONC = 0x6e6e68, STEEL = 0x8a9096, BLUE = 0x2f6fa8, WALL = 0xc9b99a;
  // асфальт: трещины с травой, масляные пятна, стёртая разметка, бордюр с разрывами
  d.box(26, 0.06, 20, 0x2c2e30, x, 0.03, z);
  for (let i = 0; i < 9; i++) {
    const px = x + (h01(i, x, z) - 0.5) * 22, pz = z + (h01(i + 11, x, z) - 0.5) * 17, rot = h01(i + 5, x, z) * 3, len = 1.5 + h01(i + 2, x, z) * 3;
    d.box(0.05, 0.012, len, 0x16181a, px, 0.066, pz, 0, rot, 0);
    if (i % 2) for (let k = 0; k < 3; k++) d.box(0.06, 0.16 + k * 0.04, 0.06, 0x4a6a34, px + Math.sin(rot) * (k - 1) * 0.5, 0.14, pz + Math.cos(rot) * (k - 1) * 0.5);
  }
  [[-4, 3.2], [0.5, 5.2], [4.2, 4.4], [8, -2], [-8, -3]].forEach(([ox, oz]) => d.box(1.4, 0.012, 1.0, 0x16181a, x + ox, 0.067, z + oz, 0, ox * 0.2, 0));
  [-8, -4, 4, 8].forEach((ox, i) => d.box(0.12, 0.02, h01(i, x, z) > 0.7 ? 1.4 : 2.4, WHITE, x + ox, 0.07, z - 1.1));
  [[0, -10, 26, 0.2], [0, 10, 26, 0.2]].forEach(([ox, oz, w, t]) => { for (let i = 0; i < 6; i++) if (h01(i + 20, x, z + oz) > 0.2) d.box(w / 6 - 0.2, 0.14, t, 0x8a8a84, x + ox - w / 2 + (i + 0.5) * w / 6, 0.07, z + oz); });
  // навес на четырёх опорах: бетонные пятки, красные пояса, капители, красно-белый борт, лампы
  [[-5.8, 1.2], [5.8, 1.2], [-5.8, 6.8], [5.8, 6.8]].forEach(([ox, oz]) => {
    s.box(0.5, 4.2, 0.5, WHITE, x + ox, 2.1, z + oz); colBox(x + ox, z + oz, 0.25, 0.25);
    s.box(0.8, 0.3, 0.8, CONC, x + ox, 0.15, z + oz); d.box(0.54, 0.22, 0.54, RED, x + ox, 1.1, z + oz); d.box(0.54, 0.22, 0.54, RED, x + ox, 3.7, z + oz);
    m.box(0.72, 0.14, 0.72, 0x6a6f75, x + ox, 4.12, z + oz);
  });
  r.box(12.8, 0.45, 7.8, WHITE, x, 4.45, z + 4);
  s.box(13.0, 0.5, 0.14, RED, x, 4.45, z + 0.05); s.box(13.0, 0.5, 0.14, RED, x, 4.45, z + 7.95); s.box(0.14, 0.5, 7.9, RED, x - 6.5, 4.45, z + 4); s.box(0.14, 0.5, 7.9, RED, x + 6.5, 4.45, z + 4);
  d.box(13.0, 0.1, 0.02, WHITE, x, 4.45, z - 0.03); d.box(13.0, 0.1, 0.02, WHITE, x, 4.45, z + 8.03); // белая полоса на красном борту
  d.box(12.4, 0.04, 7.4, 0xb8b4a8, x, 4.215, z + 4);
  d.box(2.4, 0.02, 1.6, 0x7a4a32, x - 3, 4.69, z + 3); d.box(1.6, 0.02, 2.2, 0x5a3a2a, x + 3.5, 4.69, z + 5.5);
  [-4, 0, 4].forEach(ox => [2.4, 5.6].forEach(oz => { g.box(0.9, 0.05, 0.3, 0xfff6dd, x + ox, 4.2, z + oz); m.box(1.0, 0.04, 0.4, 0x4a4f55, x + ox, 4.23, z + oz); }));
  // колонки: остров, корпус, экран, пистолет, шланг
  const pumps = [];
  [-4, 0, 4].forEach((ox, k) => {
    const px = x + ox, pz = z + 4;
    s.box(1.6, 0.18, 1.1, CONC, px, 0.09, pz); colBox(px, pz, 0.8, 0.55); [-1, 1].forEach(sd => { d.box(1.62, 0.03, 0.08, 0xe0b020, px, 0.195, pz + sd * 0.52); d.box(0.08, 0.03, 1.12, 0xe0b020, px + sd * 0.77, 0.195, pz); }); // жёлтая кромка острова
    m.box(0.8, 0.1, 0.55, 0x2a2d30, px, 0.23, pz);
    m.box(0.7, 1.55, 0.45, RED, px, 0.955, pz); m.box(0.72, 0.5, 0.02, mulCol(RED, 0.8), px, 0.5, pz - 0.23); d.box(0.72, 0.14, 0.02, WHITE, px, 1.62, pz + 0.235);
    m.box(0.78, 0.12, 0.52, WHITE, px, 1.78, pz); m.box(0.46, 0.3, 0.03, 0x1a1a1a, px, 1.35, pz + 0.235); g.box(0.4, 0.22, 0.02, 0x6dff6d, px, 1.35, pz + 0.255);
    m.box(0.12, 0.34, 0.1, STEEL, px + 0.42, 1.0, pz); m.tube([px + 0.42, 1.15, pz], [px + 0.42, 0.88, pz + 0.06], 0.03, 0x2a2a2a, 5);
    m.tube([px + 0.42, 0.88, pz + 0.06], [px + 0.55, 0.5, pz + 0.12], 0.02, 0x151515, 4); m.tube([px + 0.55, 0.5, pz + 0.12], [px + 0.35, 0.22, pz - 0.15], 0.02, 0x151515, 4);
    d.box(0.2, 0.2, 0.02, 0xc9a227, px - 0.2, 0.75, pz + 0.235, 0, 0, Math.PI / 4);
    pumps.push({ x: px, z: pz, fuel: 300 });
  });
  // магазин: стены с цоколем и пилястрами, крыша с парапетом, окна, навес, дверь
  const H = 3.4, T = 0.3, sz = z - 5.5;
  const sw = (cx, cz, w, dd) => { s.box(w, H, dd, WALL, cx, H / 2, cz); s.box(w + (w > dd ? 0 : 0.04), 1.0, dd + (w > dd ? 0.04 : 0), 0x8a6a55, cx, 0.5, cz); };
  sw(x, sz - 3, 12, T); colBox(x, sz - 3, 6, T / 2);
  sw(x - 6, sz, T, 6); colBox(x - 6, sz, T / 2, 3); sw(x + 6, sz, T, 6); colBox(x + 6, sz, T / 2, 3);
  sw(x - 3.45, sz + 3, 5.1, T); colBox(x - 3.45, sz + 3, 2.55, T / 2); sw(x + 3.45, sz + 3, 5.1, T); colBox(x + 3.45, sz + 3, 2.55, T / 2);
  s.box(1.8, H - 2.6, T, WALL, x, 2.6 + (H - 2.6) / 2, sz + 3);
  for (let i = 0; i < 9; i++) { d.box(5.1, 0.03, T + 0.03, mulCol(WALL, 0.88), x - 3.45, 1.4 + i * 0.22, sz + 3); d.box(5.1, 0.03, T + 0.03, mulCol(WALL, 0.88), x + 3.45, 1.4 + i * 0.22, sz + 3); } // обшивка
  [-1, 1].forEach(sx => [-1, 1].forEach(sg => s.box(0.4, H, 0.4, 0xa89878, x + sx * 6, H / 2, sz + sg * 3)));
  r.box(12.4, 0.3, 6.4, 0x4a4d50, x, H + 0.15, sz);
  r.box(12.6, 0.25, 0.2, 0x5a5d60, x, H + 0.42, sz - 3.1); r.box(12.6, 0.25, 0.2, 0x5a5d60, x, H + 0.42, sz + 3.1); r.box(0.2, 0.25, 6.4, 0x5a5d60, x - 6.2, H + 0.42, sz); r.box(0.2, 0.25, 6.4, 0x5a5d60, x + 6.2, H + 0.42, sz);
  m.box(1.2, 0.7, 0.9, 0xb0b4b8, x + 3, H + 0.65, sz - 0.5); m.cyl(0.34, 0.04, 0x2a2d30, x + 3, H + 1.0, sz - 0.5, 10); m.box(1.0, 0.5, 0.8, 0xa0a4a8, x - 3.2, H + 0.55, sz + 0.8);
  m.cyl(0.1, 0.8, 0x6a6f75, x - 1.2, H + 0.3, sz - 1.5, 6); m.cyl(0.16, 0.06, 0x4a4f55, x - 1.2, H + 1.1, sz - 1.5, 6); m.tube([x + 5, H + 0.3, sz + 2], [x + 5, H + 2.3, sz + 2], 0.02, 0x6a6f75, 4);
  d.box(2.0, 0.02, 1.4, 0x2a2c2e, x - 4, H + 0.31, sz - 1.4);
  [-3.45, 3.45].forEach((ox, k) => { // окна: рамы, средник, постеры, осколки
    const wx = x + ox, wz = sz + 3.18;
    d.box(3.4, 1.4, 0.06, 0x1a232b, wx, 1.9, wz); m.box(3.5, 0.08, 0.1, 0x3a3f45, wx, 2.62, wz); m.box(3.5, 0.08, 0.1, 0x3a3f45, wx, 1.18, wz);
    [-1.7, 0, 1.7].forEach(o => m.box(0.08, 1.5, 0.1, 0x3a3f45, wx + o, 1.9, wz)); m.box(3.7, 0.06, 0.28, 0x7a6a55, wx, 1.1, wz + 0.1);
    [[-0.8, 0xc9a227], [0.7, 0x2f6fa8], [1.1, 0xa02a1a]].forEach(([o, c], i) => { if ((i + k) % 2 === 0) d.box(0.5, 0.7, 0.01, c, wx + o, 1.95, wz - 0.04); });
    if (k === 1) for (let i = 0; i < 3; i++) d.box(0.3, 0.04, 0.01, 0x6a8090, wx - 0.6 + i * 0.5, 1.5 + i * 0.2, wz + 0.04, 0, 0, 0.7 * (i - 1)); // выбитое стекло
    for (let i = 0; i < 12; i++) r.box(0.28, 0.04, 1.2, i % 2 ? 0xb02a1a : 0xe6e2d6, wx - 1.54 + i * 0.28, 2.58 + 0.0, sz + 3.75, 0.16, 0, 0);  // полосатый навес
    [-1.6, 1.6].forEach(o => m.tube([wx + o, 2.4, sz + 3.2], [wx + o, 2.65, sz + 4.3], 0.02, 0x4a4f55, 4));
  });
  m.box(0.1, 2.6, 0.2, 0x3a3f45, x - 0.9, 1.3, sz + 3); m.box(0.1, 2.6, 0.2, 0x3a3f45, x + 0.9, 1.3, sz + 3); m.box(1.9, 0.1, 0.2, 0x3a3f45, x, 2.6, sz + 3); // рама двери
  m.box(0.85, 2.4, 0.05, 0x3a3f45, x - 0.5, 1.2, sz + 3.55, 0, -1.0, 0); d.box(0.6, 1.0, 0.03, 0x1a232b, x - 0.5, 1.7, sz + 3.55, 0, -1.0, 0);                      // дверь приоткрыта
  [-2.1, 2.1].forEach(o => m.box(0.06, 0.9, 0.06, 0x3a3f45, x + o, 3.0, sz + 3.17)); m.box(4.5, 0.06, 0.06, 0x3a3f45, x, 3.45, sz + 3.17);
  textPlane('ЗАПРАВКА', 4.2, 0.8, '#b02a1a', '#fff6dd', x, 3.0, sz + 3.2, 0);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 12; j++) d.box(0.98, 0.02, 0.98, (i + j) % 2 ? 0xb8b0a0 : 0x8a8478, x - 5.5 + j, 0.012, sz - 2.5 + i); // плитка пола
  s.box(3.0, 1.0, 0.8, 0x7a5c34, x + 4, 0.5, sz - 0.5); colBox(x + 4, sz - 0.5, 1.5, 0.4); // прилавок
  d.box(3.1, 0.06, 0.9, 0x3a2a1a, x + 4, 1.03, sz - 0.5); for (let i = 0; i < 4; i++) d.box(0.7, 0.8, 0.02, mulCol(0x7a5c34, 0.8), x + 2.9 + i * 0.75, 0.5, sz - 0.08);
  m.box(0.4, 0.25, 0.4, 0x2a2d30, x + 3.2, 1.2, sz - 0.5); d.box(0.3, 0.16, 0.02, 0x2a5a2a, x + 3.2, 1.34, sz - 0.3, -0.3, 0, 0); g.box(0.12, 0.04, 0.01, 0x6dff6d, x + 3.2, 1.35, sz - 0.29);
  [0, 1, 2].forEach(i => { m.cyl(0.08, 0.2, [0xc9402a, 0x2f8a4a, 0xc9a227][i], x + 4.4 + i * 0.25, 1.06, sz - 0.4, 6); m.cyl(0.085, 0.03, 0x2a2a2a, x + 4.4 + i * 0.25, 1.26, sz - 0.4, 6); }); // банки со сладостями
  rackK(K, x - 4.6, sz - 2.5, 'x', 3.6, true); rackK(K, x + 0.4, sz - 2.5, 'x', 3.6, true);
  [-3, 0, 3].forEach(ox => { g.box(1.2, 0.04, 0.3, 0xfff6dd, x + ox, H - 0.08, sz); m.box(1.3, 0.05, 0.4, 0x4a4f55, x + ox, H - 0.04, sz); });
  s.box(1.4, 0.9, 0.7, 0xe6e2d6, x + 5.2, 0.45, sz + 1.8); colBox(x + 5.2, sz + 1.8, 0.7, 0.35); d.box(1.3, 0.04, 0.6, 0x1a232b, x + 5.2, 0.92, sz + 1.8); // морозильный ларь
  // столб с вывеской «ТОПЛИВО»
  m.box(0.3, 7, 0.3, STEEL, x - 11.5, 3.5, z + 6); colBox(x - 11.5, z + 6, 0.15, 0.15); m.box(0.7, 0.2, 0.7, 0x3a3f45, x - 11.5, 0.1, z + 6);
  m.box(2.4, 1.7, 0.25, WHITE, x - 11.5, 6.6, z + 6); m.box(2.5, 0.12, 0.3, RED, x - 11.5, 7.5, z + 6); m.box(2.5, 0.12, 0.3, RED, x - 11.5, 5.7, z + 6);
  textPlane('ТОПЛИВО', 2.2, 0.9, '#b02a1a', '#fff6dd', x - 11.5, 6.6, z + 6.14, 0);
  // мусорный бак, бочки, машина-остов, цистерна, воздух, телефон, стол
  s.box(0.8, 0.8, 0.8, 0x2f5a2a, x + 8.5, 0.5, z - 1.5); s.box(0.8, 0.2, 0.8, 0x2f5a2a, x + 8.5, 0.9, z - 1.5); colBox(x + 8.5, z - 1.5, 0.4, 0.4);
  m.box(0.86, 0.06, 0.86, 0x24401f, x + 8.5, 1.02, z - 1.5, -0.25, 0, 0); [-0.3, 0.3].forEach(o => m.cylX(0.07, 0.06, 0x151515, x + 8.5 + o, 0.07, z - 1.1, 6));
  barrelsK(K, x + 9, z - 7, 4);
  carK(K, x - 9, z - 3, 0, 0x6b4a2a);
  tankerK(K, x + 12, z - 6, 0);
  m.box(0.4, 1.3, 0.4, BLUE, x - 6.5, 0.65, z + 9); g.box(0.3, 0.3, 0.02, 0x6dff6d, x - 6.5, 1.1, z + 9.21); m.cylZ(0.1, 0.04, 0x1a1a1a, x - 6.5, 0.8, z + 9.22, 8); colBox(x - 6.5, z + 9, 0.3, 0.3);
  m.tube([x - 6.3, 0.6, z + 9.2], [x - 6.0, 0.15, z + 9.5], 0.02, 0x151515, 4);
  [-1, 1].forEach(sx => [-1, 1].forEach(sg => m.box(0.06, 2.2, 0.06, BLUE, x + 6.5 + sx * 0.42, 1.1, z + 9.5 + sg * 0.42)));                                      // телефонная будка
  m.box(0.95, 0.1, 0.95, 0x24558a, x + 6.5, 2.25, z + 9.5); m.box(0.9, 0.1, 0.9, 0x24558a, x + 6.5, 0.05, z + 9.5);
  d.box(0.7, 1.2, 0.04, 0x1a232b, x + 6.5, 1.3, z + 9.95); d.box(0.04, 1.2, 0.7, 0x1a232b, x + 6.95, 1.3, z + 9.5); d.box(0.04, 1.2, 0.7, 0x1a232b, x + 6.05, 1.3, z + 9.5);
  m.box(0.2, 0.3, 0.1, 0x3a3f45, x + 6.5, 1.3, z + 9.1); colBox(x + 6.5, z + 9.5, 0.5, 0.5);
  d.box(1.8, 0.1, 0.8, 0x7a5c34, x - 8, 0.8, z + 10); [-0.7, 0.7].forEach(ox => d.box(0.1, 0.8, 0.8, 0x5e4528, x - 8 + ox, 0.4, z + 10)); [-1, 1].forEach(sd => d.box(1.8, 0.08, 0.3, 0x7a5c34, x - 8, 0.45, z + 10 + sd * 0.7));
  textPlane('ОТКРЫТО', 1.7, 0.5, '#0a2a0a', '#6dff6d', x + 4.3, 3.0, sz + 3.2, 0);
  K.finish();
  const rec = { x, z, pumps, shopZ: sz };
  stations.push(rec);
  return rec;
}

function buildGarage(x, z) {
  const W = 16, D = 10, H = 4.6, T = 0.4;
  clearTrees(x, z, W / 2 + 5, D / 2 + 8);
  const K = bKit(x, z, 12), { s, r, d, m, g } = K;
  const BRICK = 0x8a4a3a, TRIM = 0xdad4c4, CONC = 0x6e6e68, DARK = 0x2f3438, METAL = 0x9aa0a8;
  d.box(W - 0.4, 0.04, D - 0.4, CONC, x, 0.02, z); d.box(18, 0.05, 6, 0x2c2e30, x, 0.025, z + D / 2 + 3.2);
  for (let i = 0; i < 4; i++) d.box(0.5, 0.012, 5 - i * 0.6, 0x16181a, x - 4.6 + i * 0.35 + (i > 1 ? 7 : 0), 0.056, z + D / 2 + 2.8, 0, (i - 1.5) * 0.04, 0); // следы шин
  [[-2, -1.5], [3, 1.2]].forEach(([ox, oz]) => [[0, 0, 1.2, 0.8, 0], [0.4, 0.2, 0.8, 0.6, 0.6], [-0.3, -0.2, 0.7, 0.9, -0.4]].forEach(([a, b, w, dd, rot]) => d.box(w, 0.012, dd, 0x15171a, x + ox + a, 0.046, z + oz + b, 0, rot, 0))); // масляные пятна
  // кирпичные стены: кладка рядами, выгоревшие кирпичи, цоколь
  function brick(along, cx, cz, len, y0, y1) {
    const h = y1 - y0, cy = (y0 + y1) / 2;
    if (along === 'x') s.box(len, h, T, BRICK, cx, cy, cz); else s.box(T, h, len, BRICK, cx, cy, cz);
    for (let y = y0 + (y0 === 0 ? 0.65 : 0.1); y < y1; y += 0.22) { if (along === 'x') d.box(len, 0.025, T + 0.03, 0xa89888, cx, y, cz); else d.box(T + 0.03, 0.025, len, 0xa89888, cx, y, cz); }
    for (let i = 0; i < Math.max(2, Math.floor(len / 1.2)); i++) {
      const o = (h01(i, cx, cz) - 0.5) * (len - 0.8), yy = y0 + 1.0 + h01(i + 6, cx, cz) * Math.max(0.2, h - 1.4), c = mulCol(BRICK, 0.78 + h01(i + 2, cx, cz) * 0.4);
      if (along === 'x') d.box(0.5, 0.22, T + 0.045, c, cx + o, yy, cz); else d.box(T + 0.045, 0.22, 0.5, c, cx, yy, cz + o);
    }
    if (y0 === 0) { if (along === 'x') s.box(len + 0.1, 0.6, T + 0.1, CONC, cx, 0.3, cz); else s.box(T + 0.1, 0.6, len, CONC, cx, 0.3, cz); }
  }
  brick('x', x, z - D / 2, W, 0, H); colBox(x, z - D / 2, W / 2, T / 2);
  brick('z', x - W / 2, z, D, 0, H); colBox(x - W / 2, z, T / 2, D / 2); brick('z', x + W / 2, z, D, 0, H); colBox(x + W / 2, z, T / 2, D / 2);
  brick('x', x - 7.1, z + D / 2, 1.8, 0, H); colBox(x - 7.1, z + D / 2, 0.9, T / 2); brick('x', x, z + D / 2, 4.0, 0, H); colBox(x, z + D / 2, 2.0, T / 2); brick('x', x + 7.1, z + D / 2, 1.8, 0, H); colBox(x + 7.1, z + D / 2, 0.9, T / 2);
  [-4.1, 4.1].forEach(ox => { // поднятые рулонные ворота: короб, барабан, планки, направляющие
    brick('x', x + ox, z + D / 2, 4.2, 3.6, H);
    m.box(4.3, 0.5, 0.14, METAL, x + ox, 3.35, z + D / 2); m.cylX(0.26, 4.1, 0x8a9096, x + ox, 3.4, z + D / 2 + 0.2, 10);
    for (let k = 0; k < 4; k++) m.box(4.2, 0.05, 0.1, METAL, x + ox, 3.65 - k * 0.12, z + D / 2 + 0.02);
    [-1, 1].forEach(sd => { d.box(0.18, 3.6, 0.2, TRIM, x + ox + sd * 2.2, 1.8, z + D / 2 + 0.05); m.box(0.08, 3.5, 0.1, 0x6a6f75, x + ox + sd * 2.05, 1.8, z + D / 2 + 0.12); });
    d.box(4.2, 0.08, 0.6, CONC, x + ox, 0.04, z + D / 2 + 0.3);
  });
  s.box(W + 0.3, 0.3, T + 0.2, TRIM, x, H + 0.15, z - D / 2); s.box(W + 0.3, 0.3, T + 0.2, TRIM, x, H + 0.15, z + D / 2);
  [-1, 1].forEach(sx => [-1, 1].forEach(sz2 => s.box(0.5, H, 0.5, 0x6b3a2c, x + sx * W / 2, H / 2, z + sz2 * D / 2)));
  // крыша: два ската листового железа, фронтоны, конёк, желоба, труба, люк
  const hs = D / 2 + 0.5, rise = 1.4, a = Math.atan2(rise, hs), L = Math.hypot(hs, rise), RW = W + 1;
  [-1, 1].forEach(sg => K.xf(m4(x, H + 0.3 + rise / 2, z + sg * hs / 2, sg * a, 0, 0), () => {
    r.box(RW, 0.12, L, 0x4a4f55, 0, 0, 0);
    for (let i = 0; i < Math.floor(RW / 0.5); i++) r.box(0.08, 0.06, L, i % 2 ? 0x41464b : 0x555b61, -RW / 2 + 0.3 + i * 0.5, 0.08, 0);
    r.box(2.2, 0.02, 1.6, 0x6a4a32, (sg > 0 ? -3 : 3), 0.075, 0.4); m.box(RW, 0.1, 0.2, 0x3a3f45, 0, -0.05, sg * L / 2);
  }));
  m.box(W + 1.1, 0.14, 0.4, 0x3a3f45, x, H + 0.3 + rise + 0.04, z);
  [-1, 1].forEach(sx => s.prism([[-D / 2, 0], [D / 2, 0], [0, rise + 0.3 - 0.07]], T, BRICK, x + sx * W / 2, H, z, 0, Math.PI / 2, 0));
  r.box(0.8, 1.9, 0.8, 0x7a3a2c, x - 5, H + 1.15, z - 1.5); r.box(1.0, 0.15, 1.0, 0x5a5d60, x - 5, H + 2.15, z - 1.5); m.cyl(0.18, 0.5, 0x3a3f45, x - 5, H + 2.2, z - 1.5, 8);
  m.box(1.0, 0.1, 0.7, 0x3a3f45, x + 3, H + 0.95, z + 1.6, -0.2, 0, 0); d.box(0.8, 0.02, 0.5, 0x1a232b, x + 3, H + 1.0, z + 1.6, -0.2, 0, 0);
  textPlane('АВТОСЕРВИС', 3.6, 0.9, '#23282c', '#e8dfc8', x, 2.4, z + D / 2 + T / 2 + 0.02, 0);
  m.box(3.8, 1.1, 0.04, DARK, x, 2.4, z + D / 2 + T / 2); m.tube([x, 3.1, z + D / 2 + 0.3], [x, 3.4, z + D / 2 + 0.8], 0.02, 0x3a3f45, 4); g.box(0.3, 0.12, 0.2, 0xfff6dd, x, 3.38, z + D / 2 + 0.85);
  textPlane('ШИНЫ', 1.5, 0.5, '#a02a1a', '#fff6dd', x - 7.1, 2.6, z + 5.22, 0); m.box(1.6, 0.6, 0.04, DARK, x - 7.1, 2.6, z + D / 2 + 0.2);
  [-1, 1].forEach(sx => { // боковые окна с решётками, часть выбита
    const wx = x + sx * (W / 2 + T / 2 + 0.04);
    m.box(0.1, 1.0, 1.7, DARK, wx, 2.6, z - 1.5); d.box(0.08, 0.9, 1.6, sx > 0 ? 0x070b0e : 0x1a232b, wx, 2.6, z - 1.5);
    for (let i = 0; i < 4; i++) m.box(0.06, 0.9, 0.04, 0x4a4f55, wx + sx * 0.05, 2.6, z - 2.1 + i * 0.4); m.box(0.22, 0.06, 1.9, 0x6a6f75, wx + sx * 0.08, 2.1, z - 1.5);
  });
  [-4.1, 0, 4.1].forEach(ox => { g.box(2.2, 0.05, 0.3, 0xfff6dd, x + ox, H - 0.1, z); m.box(2.3, 0.05, 0.4, 0x4a4f55, x + ox, H - 0.05, z); });
  for (let i = -2; i <= 2; i++) m.box(0.2, 0.3, D - 0.4, 0x4a4f55, x + i * 3, H - 0.2, z);
  // внутри: стеллажи, бочки, ящик с инструментом, подъёмник, шины, доска с инструментом
  rackK(K, x - W / 2 + 0.9, z - 1.8, 'z', 4.4, true); rackK(K, x + W / 2 - 0.9, z + 1.2, 'z', 4.0, true);
  barrelsK(K, x + 6.4, z - 3.6, 5);
  s.box(1.1, 0.9, 0.7, 0xa83222, x - 6.3, 0.45, z - 3.8); colBox(x - 6.3, z - 3.8, 0.55, 0.35);
  for (let i = 0; i < 3; i++) d.box(0.9, 0.2, 0.02, mulCol(0xa83222, 0.8), x - 6.3, 0.3 + i * 0.25, z - 3.44); m.box(0.9, 0.04, 0.5, 0x555a60, x - 6.3, 0.92, z - 3.8);
  d.box(2.6, 1.2, 0.04, 0x6a5a42, x - 3.6, 2.2, z - D / 2 + T / 2 + 0.04);
  [[-1.0, 0x8a8f94], [-0.5, 0xa83222], [0, 0x8a8f94], [0.5, 0x2f6fa8], [1.0, 0x8a8f94]].forEach(([o, c]) => m.box(0.08, 0.5, 0.03, c, x - 3.6 + o, 2.2, z - D / 2 + T / 2 + 0.08));
  [2.7, 5.5].forEach(ox => { m.box(0.25, 2.6, 0.25, 0xd9a21b, x + ox, 1.3, z + 0.5); m.box(0.5, 0.06, 0.5, 0x3a3f45, x + ox, 0.03, z + 0.5); colBox(x + ox, z + 0.5, 0.2, 0.2); m.cyl(0.07, 1.4, 0x8a8f94, x + ox + (ox < 4 ? -0.18 : 0.18), 0, z + 0.5, 6); });
  m.box(3.1, 0.2, 0.3, 0xd9a21b, x + 4.1, 2.6, z + 0.5);
  [[2.7, -1], [5.5, 1]].forEach(([ox, sg]) => [-1, 1].forEach(q => { m.box(1.5, 0.08, 0.14, 0x555a60, x + ox + sg * -0.8 + 0.0, 0.8, z + 0.5 + q * 0.3); m.box(0.2, 0.06, 0.2, 0x151515, x + ox - sg * 1.3, 0.86, z + 0.5 + q * 0.3); }));
  m.box(0.3, 0.5, 0.2, 0x3a4a3a, x + 6.2, 1.0, z + 0.5);
  barrelsK(K, x + 9.5, z + 1.5, 4);
  K.finish();
  const rec = { x, z, carX: x - 4.1, carZ: z - 0.6, benchX: x + 3.8, benchZ: z - D / 2 + 0.8 };
  garages.push(rec);
  return rec;
}

function buildWaterTower(x, z) {
  clearTrees(x, z, 6, 6); clearTrees(x + 6, z - 4, 3, 3);
  const K = bKit(x, z, 14), { s, r, d, m, ms } = K;
  const STEEL = 0x6f7479, RUST = 0x7a4a32, TANK = 0x7a8288;
  const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  legs.forEach(([sx, sz]) => {
    m.tube([x + sx * 2.5, 0, z + sz * 2.5], [x + sx * 1.9, 9, z + sz * 1.9], 0.14, STEEL, 6);
    s.box(0.9, 0.3, 0.9, 0x6e6e68, x + sx * 2.5, 0.15, z + sz * 2.5); m.box(0.4, 0.06, 0.4, 0x3a3f45, x + sx * 2.5, 0.33, z + sz * 2.5);
    colBox(x + sx * 2.5, z + sz * 2.5, 0.35, 0.35);
  });
  [3, 6].forEach(y => {
    const k = 2.5 - y * 0.0667;
    [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]].forEach(([ax, az, bx, bz]) => m.tube([x + ax * k, y, z + az * k], [x + bx * k, y, z + bz * k], 0.06, STEEL, 5));
  });
  [[-2.5, -2.5, 2.2, -2.2, 0, 3], [2.5, 2.5, -2.2, 2.2, 0, 3], [2.2, -2.2, -2.0, -2.0, 3, 6], [-2.2, 2.2, 2.0, 2.0, 3, 6], [2.5, -2.5, 2.2, 2.2, 0, 3], [-2.5, 2.5, -2.2, -2.2, 0, 3]].forEach(([ax, az, bx, bz, y0, y1]) => m.tube([x + ax, y0, z + az], [x + bx, y1, z + bz], 0.05, RUST, 4));
  m.cyl(0.25, 9, 0x5a6066, x, 0, z, 10); [1.5, 4.5, 7.5].forEach(y => m.cyl(0.34, 0.1, 0x3a3f45, x, y, z, 10));       // стояк в центре
  m.cyl(0.4, 0.4, 0x2f5a8a, x, 0.4, z, 10); m.cylX(0.18, 0.05, 0x8a2b20, x + 0.45, 0.9, z, 8);                          // вентиль
  m.cyl(2.45, 0.2, TANK, x, 9.14, z, 14); m.cyl(3.0, 0.14, STEEL, x, 9.03, z, 14);                                       // днище бака и площадка
  ms.cyl(2.4, 3.2, TANK, x, 9.2, z, 16);
  for (let k = 0; k < 4; k++) m.cyl(2.46, 0.08, k % 2 ? RUST : 0x5a6066, x, 9.55 + k * 0.8, z, 16);                       // клёпаные пояса
  for (let k = 0; k < 16; k++) { const an = k / 16 * Math.PI * 2; if (h01(k, x, z) > 0.55) d.box(0.14, 0.9 + h01(k + 3, x, z) * 1.6, 0.04, 0x6a4a34, x + Math.cos(an) * 2.42, 11.6 - h01(k + 3, x, z) * 0.5, z + Math.sin(an) * 2.42, 0, -an + Math.PI / 2, 0); } // потёки
  m.cone(2.7, 0.1, 1.5, 0x5a3f2c, x, 12.4, z, 14); m.cyl(0.3, 0.25, 0x6a6f75, x, 13.5, z, 8); m.tube([x, 13.9, z], [x, 15.2, z], 0.02, 0x3a3f45, 4); // крыша и громоотвод
  for (let i = 0; i < 14; i++) { const an = i / 14 * Math.PI * 2, cx = x + Math.cos(an) * 2.9, cz = z + Math.sin(an) * 2.9; m.tube([cx, 9.1, cz], [cx, 10.1, cz], 0.03, STEEL, 4); const an2 = (i + 1) / 14 * Math.PI * 2; if (i % 5 !== 4) m.tube([cx, 10.1, cz], [x + Math.cos(an2) * 2.9, 10.1, z + Math.sin(an2) * 2.9], 0.025, STEEL, 4); }
  // лестница с ограждением
  m.tube([x - 2.5, 0, z + 3.0], [x - 2.5, 9.1, z + 3.0], 0.05, STEEL, 4); m.tube([x - 1.9, 0, z + 3.0], [x - 1.9, 9.1, z + 3.0], 0.05, STEEL, 4);
  for (let i = 0; i < 22; i++) m.tube([x - 2.5, 0.4 + i * 0.4, z + 3.0], [x - 1.9, 0.4 + i * 0.4, z + 3.0], 0.025, STEEL, 4);
  textPlane('ВОДА', 2.6, 0.9, '#2b4a7a', '#e8dfc8', x, 10.8, z + 2.45, 0);
  // насосная будка: блоки, двускатная крыша, дверь с табличкой, счётчик, трубы с вентилями
  const px = x + 6, pz = z - 4;
  s.box(3, 2.4, 3, 0x77786f, px, 1.2, pz); colBox(px, pz, 1.5, 1.5); s.box(3.08, 0.5, 3.08, 0x5a5b54, px, 0.25, pz);
  for (let i = 0; i < 7; i++) { d.box(3.04, 0.025, 3.04, 0x66675f, px, 0.7 + i * 0.28, pz); }
  r.gable(3.6, 3.2, 0.7, 0x4a4d50, px, 2.4, pz, 0.2); m.box(3.7, 0.08, 0.1, 0x3a3f45, px, 2.43, pz + 1.62);
  m.box(1.0, 1.8, 0.1, 0x2f3438, px - 0.8, 0.9, pz + 1.5); m.box(1.1, 0.1, 0.14, 0x3a3f45, px - 0.8, 1.85, pz + 1.5); m.box(0.06, 0.2, 0.06, 0x9aa0a8, px - 0.5, 0.9, pz + 1.58);
  m.box(0.5, 0.3, 0.12, 0x4a5a4a, px + 0.6, 1.5, pz + 1.55); m.cylZ(0.1, 0.05, 0x1a1a1a, px + 0.6, 1.5, pz + 1.62, 8);
  d.box(0.8, 0.4, 0.04, 0x1a1c1e, px + 0.8, 1.7, pz - 1.52); [0, 1, 2].forEach(i => m.box(0.7, 0.04, 0.05, 0x3a3f45, px + 0.8, 1.6 + i * 0.1, pz - 1.54));
  m.cylZ(0.1, 5.5, 0x6b5a48, x + 3.7, 0.6, z - 4, 8); m.cylX(0.1, 4.5, 0x6b5a48, x + 3.8 + 0.0, 0.6, z - 1.4, 8);
  [-6.2, -4, -2].forEach(o => m.cylZ(0.15, 0.06, 0x3a3a3a, x + 3.7, 0.6, z + o, 8));
  m.cyl(0.04, 0.35, 0x8a2b20, x + 3.7, 0.7, z - 3.2, 6); m.cylX(0.14, 0.04, 0x8a2b20, x + 3.7, 1.05, z - 3.2, 8);
  textPlane('ОПАСНО', 1.3, 0.5, '#e0b020', '#111111', x + 2.5, 1.7, z + 2.9, 0); m.tube([x + 2.5, 0, z + 2.88], [x + 2.5, 1.45, z + 2.88], 0.04, 0x4a4f55, 4);
  K.finish();
  const rec = { x, z };
  towers.push(rec);
  return rec;
}

function buildOutpost(x, z) { // военный блокпост: мешки с песком, вышка, казарма, палатка, флаг, колючка, мачта, грузовик
  clearTrees(x, z, 19, 16);
  const K = bKit(x, z, 15), { s, r, d, m, ms, g } = K;
  const OLIVE = 0x55603a, OLIVE_D = 0x3f4a2c, CONC = 0x777770, STEEL = 0x5a5f64, WOOD = 0x6b4f2e, CANVAS = 0x6a7048, CRATE = 0x4a5230;
  // земля: утоптанный гравий, колеи, лужи, пучки травы
  d.box(30, 0.05, 24, 0x6a6458, x, 0.025, z);
  for (let i = 0; i < 6; i++) d.box(0.5, 0.012, 8 + h01(i, x, z) * 6, 0x4a463c, x - 5 + i * 2 + (i > 2 ? 3 : 0), 0.056, z + 4 + h01(i + 3, x, z) * 2, 0, (h01(i + 7, x, z) - 0.5) * 0.1, 0); // колеи
  for (let i = 0; i < 5; i++) d.box(1.2 + h01(i, z, x), 0.012, 0.8 + h01(i + 4, z, x), 0x2e3436, x - 9 + i * 4.5, 0.058, z + 8 - h01(i + 9, x, z) * 14);                             // лужи
  for (let i = 0; i < 14; i++) { const px = x + (h01(i, x, z) - 0.5) * 28, pz = z + (h01(i + 13, x, z) - 0.5) * 22; for (let k = 0; k < 3; k++) d.box(0.05, 0.2 + k * 0.05, 0.05, 0x5a7a3a, px + k * 0.07, 0.15, pz + (k % 2) * 0.06); }
  // периметр из мешков (вход с юга шириной 6 м)
  sandWallK(K, x - 14.5, z - 11.5, x + 14.5, z - 11.5, 1.1); sandWallK(K, x - 14.5, z - 11.5, x - 14.5, z + 11.5, 1.1); sandWallK(K, x + 14.5, z - 11.5, x + 14.5, z + 11.5, 1.1);
  sandWallK(K, x - 14.5, z + 11.5, x - 3, z + 11.5, 1.1); sandWallK(K, x + 3, z + 11.5, x + 14.5, z + 11.5, 1.1);
  [[-1.8, 8.5], [1.8, 6.5]].forEach(([ox, oz]) => { // бетонные блоки (профиль «Нью-Джерси») у входа
    s.prism([[-0.275, 0], [0.275, 0], [0.2, 0.3], [0.12, 0.85], [-0.12, 0.85], [-0.2, 0.3]], 2.2, CONC, x + ox, 0, z + oz, 0, Math.PI / 2, 0); colBox(x + ox, z + oz, 1.1, 0.275);
    d.box(0.5, 0.18, 0.03, 0xb02a1a, x + ox - 0.6, 0.55, z + oz + 0.17); d.box(0.5, 0.18, 0.03, 0xd8d0b0, x + ox + 0.1, 0.55, z + oz + 0.17);
  });
  textPlane('ВОЕННАЯ ЗОНА', 4.2, 0.9, '#a02a1a', '#f0ead8', x, 2.2, z + 11.9, 0); m.box(4.4, 1.1, 0.05, 0x24282b, x, 2.2, z + 11.86);
  m.box(0.2, 2.6, 0.2, WOOD, x - 2.1, 1.3, z + 11.8); m.box(0.2, 2.6, 0.2, WOOD, x + 2.1, 1.3, z + 11.8);
  m.box(0.4, 1.1, 0.4, 0x3a3f45, x - 3.2, 0.55, z + 10.6); // шлагбаум поднят
  for (let i = 0; i < 6; i++) m.tube([x - 3.2 + i * 0.12, 1.0 + i * 0.4, z + 10.6], [x - 3.2 + (i + 1) * 0.12, 1.0 + (i + 1) * 0.4, z + 10.6], 0.05, i % 2 ? 0xd8d0b0 : 0xb02a1a, 5);
  // вышка: стойки с раскосами, настил, бойницы, мешки, пулемёт, крыша, лестница, прожектор
  const tx = x + 10.5, tz = z - 7.5;
  [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]].forEach(([ox, oz]) => { s.box(0.32, 5.2, 0.32, WOOD, tx + ox, 2.6, tz + oz); colBox(tx + ox, tz + oz, 0.16, 0.16); s.box(0.5, 0.2, 0.5, CONC, tx + ox, 0.1, tz + oz); });
  [[-1.5, -1.5, 1.5, -1.5], [-1.5, 1.5, 1.5, 1.5], [-1.5, -1.5, -1.5, 1.5], [1.5, -1.5, 1.5, 1.5]].forEach(([ax, az, bx, bz]) => [[0.5, 2.6], [2.8, 4.9]].forEach(([y0, y1]) => {
    m.tube([tx + ax, y0, tz + az], [tx + bx, y1, tz + bz], 0.04, 0x5a4228, 5); m.tube([tx + ax, y1, tz + az], [tx + bx, y0, tz + bz], 0.04, 0x5a4228, 5);
  }));
  r.box(3.8, 0.2, 3.8, WOOD, tx, 5.2, tz); for (let i = 0; i < 8; i++) d.box(3.7, 0.02, 0.02, 0x3f2f1c, tx, 5.31, tz - 1.7 + i * 0.5);
  [-1, 1].forEach(sx => { s.box(0.15, 0.9, 3.8, OLIVE, tx + sx * 1.9, 5.75, tz); s.box(3.8, 0.9, 0.15, OLIVE, tx, 5.75, tz + sx * 1.9); });
  for (let i = 0; i < 6; i++) d.box(0.5, 0.22, 0.4, [0xb8a37a, 0xc7b285, 0xa8946a][i % 3], tx - 1.4 + i * 0.5, 6.31, tz - 1.9, 0, 0, 0); // мешки на бруствере
  m.tube([tx, 5.9, tz - 1.6], [tx - 0.35, 5.3, tz - 1.9], 0.02, 0x2a2d30, 4); m.tube([tx, 5.9, tz - 1.6], [tx + 0.35, 5.3, tz - 1.9], 0.02, 0x2a2d30, 4); m.box(0.12, 0.14, 0.5, 0x2a2d30, tx, 6.0, tz - 1.6); m.tube([tx, 6.0, tz - 1.85], [tx, 6.0, tz - 2.5], 0.025, 0x2a2d30, 5);
  r.box(4.6, 0.18, 4.6, OLIVE, tx, 7.6, tz); r.box(4.7, 0.08, 4.7, OLIVE_D, tx, 7.72, tz); [[-1.5, 1.0, 1.4, 1.0], [1.0, -1.2, 1.3, 1.2]].forEach(([ox, oz, w, dd]) => d.box(w, 0.02, dd, 0x3a4528, tx + ox, 7.77, tz + oz));
  [[-2, -2], [2, -2], [-2, 2], [2, 2]].forEach(([ox, oz]) => m.box(0.18, 2.4, 0.18, WOOD, tx + ox, 6.4, tz + oz));
  m.tube([tx - 0.45, 0.2, tz + 1.62], [tx - 0.45, 5.4, tz + 1.62], 0.04, 0x5a4228, 5); m.tube([tx + 0.45, 0.2, tz + 1.62], [tx + 0.45, 5.4, tz + 1.62], 0.04, 0x5a4228, 5);
  for (let i = 0; i < 12; i++) m.box(0.8, 0.07, 0.07, WOOD, tx, 0.4 + i * 0.42, tz + 1.62);
  g.box(0.7, 0.35, 0.7, 0xfff0cc, tx, 7.9, tz); m.cyl(0.38, 0.12, 0x2a2d30, tx, 7.72, tz, 8); m.box(0.8, 0.06, 0.8, 0x2a2d30, tx, 8.1, tz);
  // казарма: доски внахлёст, окна со ставнями, пологая крыша, печка, двухъярусные койки, шкафчики, карта
  const bx = x - 7.5, bz = z - 1, H = 3.3, T = 0.3;
  const bw = (cx, cz, w, dd, along, y0 = 0, y1 = H) => {
    s.box(w, y1 - y0, dd, OLIVE, cx, (y0 + y1) / 2, cz);
    for (let i = 0; y0 + 0.2 + i * 0.26 < y1 - 0.1; i++) { const yy = y0 + 0.2 + i * 0.26; if (along === 'x') d.box(w, 0.03, dd + 0.04, mulCol(OLIVE, 0.88), cx, yy, cz); else d.box(w + 0.04, 0.03, dd, mulCol(OLIVE, 0.88), cx, yy, cz); }
  };
  bw(bx, bz - 3, 10, T, 'x'); colBox(bx, bz - 3, 5, T / 2);
  bw(bx - 5, bz, T, 6, 'z'); colBox(bx - 5, bz, T / 2, 3); bw(bx + 5, bz, T, 6, 'z'); colBox(bx + 5, bz, T / 2, 3);
  bw(bx - 2.95, bz + 3, 4.1, T, 'x'); colBox(bx - 2.95, bz + 3, 2.05, T / 2); bw(bx + 2.95, bz + 3, 4.1, T, 'x'); colBox(bx + 2.95, bz + 3, 2.05, T / 2);
  bw(bx, bz + 3, 1.8, T, 'x', 2.5, H);
  [-1, 1].forEach(sx => [-1, 1].forEach(sg => d.box(0.4, H, 0.4, mulCol(OLIVE, 0.72), bx + sx * 5, H / 2, bz + sg * 3)));
  d.box(10.2, 0.04, 6.2, 0x5a5a54, bx, 0.02, bz); for (let i = 0; i < 10; i++) d.box(0.03, 0.01, 6.2, 0x3f3f3a, bx - 4.5 + i, 0.046, bz);
  { const hs = 3.2, rise = 0.9, a = Math.atan2(rise, hs), L = Math.hypot(hs, rise);
    [-1, 1].forEach(sg => K.xf(m4(bx, H + 0.1 + rise / 2, bz + sg * hs / 2, sg * a, 0, 0), () => { r.box(10.8, 0.12, L, OLIVE_D, 0, 0, 0); for (let i = 0; i < 18; i++) r.box(0.08, 0.05, L, i % 2 ? mulCol(OLIVE_D, 0.85) : mulCol(OLIVE_D, 1.1), -5.1 + i * 0.6, 0.08, 0); r.box(1.6, 0.02, 1.2, 0x2a2e1c, sg * 2, 0.075, 0.3); }));
    m.box(10.9, 0.12, 0.3, 0x2f351f, bx, H + 0.1 + rise + 0.03, bz);
    [-1, 1].forEach(sx => s.prism([[-3.15, 0], [3.15, 0], [0, rise - 0.05]], T, OLIVE, bx + sx * 5, H, bz, 0, Math.PI / 2, 0)); }
  m.cyl(0.12, 1.4, 0x3a3f45, bx - 4, H + 0.4, bz - 1.5, 8); m.cyl(0.18, 0.06, 0x2a2d30, bx - 4, H + 1.8, bz - 1.5, 8); m.tube([bx + 3, H + 0.5, bz + 1], [bx + 3, H + 3.2, bz + 1], 0.02, 0x3a3f45, 4);
  [-3, 3].forEach((ox, k) => {
    const wx = bx + ox, wz = bz + 3.18;
    m.box(2.3, 1.1, 0.08, 0x2f351f, wx, 1.9, wz); d.box(2.2, 1.0, 0.06, k ? 0x070b0e : 0x1a232b, wx, 1.9, wz + 0.01); m.box(0.06, 1.0, 0.08, 0x2f351f, wx, 1.9, wz + 0.02);
    s.box(0.5, 1.0, 0.04, OLIVE_D, wx - 1.45, 1.9, wz + 0.1); if (k) s.box(0.5, 1.0, 0.04, OLIVE_D, wx + 1.45, 1.9, wz + 0.1, 0, 0.0, 0.0); else m.box(0.5, 1.0, 0.04, OLIVE_D, wx + 1.55, 1.9, wz + 0.3, 0, -0.9, 0); // одна ставня висит
  });
  m.box(0.1, 2.5, 0.2, 0x2f351f, bx - 0.9, 1.25, bz + 3); m.box(0.1, 2.5, 0.2, 0x2f351f, bx + 0.9, 1.25, bz + 3); m.box(0.85, 2.3, 0.06, WOOD, bx - 0.5, 1.15, bz + 3.4, 0, -1.2, 0);
  [-3, 0, 3].forEach(ox => { // койки в два яруса
    const cx = bx + ox, cz = bz + 2.2;
    [[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]].forEach(([a, b]) => m.box(0.06, 1.3, 0.06, STEEL, cx + a, 0.65, cz + b));
    [0.3, 0.95].forEach((y, lv) => { m.box(1.7, 0.05, 0.8, STEEL, cx, y, cz); d.box(1.6, 0.1, 0.72, lv ? 0x4a5a3a : 0x5a5a4a, cx, y + 0.07, cz); d.box(0.4, 0.1, 0.5, 0xb8b4a0, cx - 0.55, y + 0.17, cz); if ((lv + ox) % 2) d.box(1.0, 0.06, 0.74, 0x6a6a5a, cx + 0.25, y + 0.14, cz); });
  });
  [-3.5, -1.2].forEach(ox => { s.box(0.9, 1.9, 0.5, STEEL, bx + ox + 3.2, 0.95, bz - 2.6); colBox(bx + ox + 3.2, bz - 2.6, 0.45, 0.25); d.box(0.02, 1.8, 0.02, 0x2a2d30, bx + ox + 3.2, 0.95, bz - 2.34); for (let i = 0; i < 4; i++) d.box(0.3, 0.03, 0.01, 0x2a2d30, bx + ox + 3.0, 1.6 + i * 0.07, bz - 2.34); });
  d.box(2.0, 1.2, 0.04, 0x6a5a42, bx + 1.2, 1.9, bz - 2.8); d.box(1.8, 1.0, 0.01, 0xc8c0a0, bx + 1.2, 1.9, bz - 2.77); for (let i = 0; i < 4; i++) d.box(0.06, 0.06, 0.02, 0xb02a1a, bx + 0.7 + i * 0.35, 1.8 + (i % 2) * 0.25, bz - 2.75);
  m.box(0.5, 0.9, 0.5, 0x2a2d30, bx - 4.4, 0.45, bz - 2.2); m.tube([bx - 4.4, 0.9, bz - 2.2], [bx - 4.4, H + 0.4, bz - 2.2], 0.06, 0x2a2d30, 6);
  [-2.2, 2.2].forEach(ox => { m.tube([bx + ox, H - 0.1, bz], [bx + ox, H - 0.4, bz], 0.01, 0x1a1a1a, 3); m.cone(0.3, 0.1, 0.2, 0x2a2d1c, bx + ox, H - 0.62, bz, 8); g.box(0.14, 0.08, 0.14, 0xfff0cc, bx + ox, H - 0.64, bz); });
  // палатка: ската из брезента, торцевая стенка, шесты и растяжки, походные койки
  { const tcx = x + 8, tcz = z + 5, a = Math.atan2(2.0, 1.7), L = Math.hypot(1.7, 2.0);
    d.box(5.0, 0.02, 3.2, 0x3a3f2a, tcx, 0.01, tcz);
    [-1, 1].forEach(sg => K.xf(m4(tcx, 1.0, tcz + sg * 0.85, sg * a, 0, 0), () => { r.box(5.2, 0.06, L, CANVAS, 0, 0, 0); for (let i = 0; i < 6; i++) r.box(0.04, 0.04, L, mulCol(CANVAS, 0.78), -2.5 + i, 0.04, 0); }));
    m.box(5.3, 0.1, 0.1, 0x4a4f3a, tcx, 2.02, tcz); s.prism([[-1.7, 0], [1.7, 0], [0, 1.98]], 0.05, mulCol(CANVAS, 0.85), tcx + 2.5, 0, tcz, 0, Math.PI / 2, 0);
    [-1, 1].forEach(sg => { m.tube([tcx + 2.6, 0, tcz], [tcx + 2.6, 2.0, tcz], 0.03, 0x5a4228, 4); m.tube([tcx - 2.6, 0, tcz], [tcx - 2.6, 2.0, tcz], 0.03, 0x5a4228, 4); m.tube([tcx + 3.3 * sg * 0.0 + 2.6, 2.0, tcz], [tcx + 3.5, 0, tcz + sg * 2.2], 0.008, 0x8a7a50, 3); m.tube([tcx - 2.6, 2.0, tcz], [tcx - 3.5, 0, tcz + sg * 2.2], 0.008, 0x8a7a50, 3); });
    m.box(1.8, 0.25, 0.7, STEEL, x + 7, 0.3, z + 5); m.box(1.8, 0.25, 0.7, STEEL, x + 9.2, 0.3, z + 5); d.box(1.7, 0.06, 0.62, 0x5a5a4a, x + 7, 0.45, z + 5); d.box(1.7, 0.06, 0.62, 0x4a5a3a, x + 9.2, 0.45, z + 5);
    [[-3, -2.5], [3, -2.5], [-3, 2.5], [3, 2.5]].forEach(([ox, oz]) => m.tube([tcx + ox, 0, tcz + oz], [tcx + ox, 2.6, tcz + oz], 0.04, 0x5a4228, 4)); }
  // флагшток со звездой, бочки, ящики с боеприпасами, мачта связи, камуфляжная сеть, грузовик
  m.tube([x - 12, 0, z + 8], [x - 12, 8, z + 8], 0.06, STEEL, 6); m.cyl(0.12, 0.3, 0x6a6f75, x - 12, 8, z + 8, 8); s.box(0.5, 0.3, 0.5, CONC, x - 12, 0.15, z + 8);
  const fc = document.createElement('canvas'); fc.width = 96; fc.height = 64; const fg = fc.getContext('2d');
  fg.fillStyle = '#4a5530'; fg.fillRect(0, 0, 96, 64); fg.fillStyle = '#d8d0b0'; fg.font = 'bold 44px monospace'; fg.textAlign = 'center'; fg.fillText('★', 48, 46);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(fc), side: THREE.DoubleSide })); flag.position.set(x - 11.1, 7.2, z + 8); scene.add(flag);
  barrelsK(K, x + 10, z + 8, 4);
  [[x + 4, z - 9], [x + 5.1, z - 9]].forEach(([cx, cz]) => { crateK(s, 1.0, 0.9, 1.0, CRATE, cx, 0, cz); colBox(cx, cz, 0.5, 0.5); });
  crateK(d, 1.0, 0.9, 1.0, CRATE, x + 4.5, 0.9, z - 9);
  [[x + 8, z - 9.5], [x + 9.2, z - 9.5], [x + 8.6, z - 9.5]].forEach(([cx, cz], k) => crateK(d, 1.0, 0.8, 0.8, CRATE, cx, k === 2 ? 0.8 : 0, cz));
  addRazorWire([[x - 14.5, z - 11.5, x + 14.5, z - 11.5], [x - 14.5, z - 11.5, x - 14.5, z + 11.5], [x + 14.5, z - 11.5, x + 14.5, z + 11.5], [x - 14.5, z + 11.5, x - 3, z + 11.5], [x + 3, z + 11.5, x + 14.5, z + 11.5]], K);
  mastK(K, x + 1, z - 9.5, 10);
  const net2 = new THREE.Mesh(new THREE.PlaneGeometry(6, 5), new THREE.MeshStandardMaterial({ color: 0x4a5530, roughness: 1, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
  net2.rotation.x = -Math.PI / 2; net2.position.set(x + 8, 2.6, z + 5); scene.add(net2);
  milTruckK(K, x - 8, z + 7.5, Math.PI / 2);
  K.finish();
  const rec = { x, z, bx, bz };
  outposts.push(rec);
  return rec;
}

function buildArmory(x, z) { // арсенал: бетонный бункер с земляной насыпью, стальная дверь, вентиляция, антенна
  const W = 9, D = 7, H = 3.4, T = 0.5;
  clearTrees(x, z, 9, 9);
  const K = bKit(x, z, 16), { s, r, d, m, g } = K;
  const CONC = 0x7c7d78, DARK = 0x2b2f33;
  d.box(W - 0.4, 0.04, D - 0.4, 0x55565a, x, 0.02, z); for (let i = 0; i < 2; i++) d.box(0.12, 0.012, D - 1.2, 0xb89a24, x - 1.4 + i * 2.8, 0.046, z);
  const cp = (cx, cz, w, dd, y0, y1) => { // бетонная стена: опалубка, подтёки
    s.box(w, y1 - y0, dd, CONC, cx, (y0 + y1) / 2, cz);
    const alongX = w > dd, len = alongX ? w : dd;
    for (let i = 1; i < Math.floor(len / 1.5); i++) { const o = -len / 2 + i * 1.5; if (alongX) d.box(0.05, y1 - y0, dd + 0.03, 0x6a6b66, cx + o, (y0 + y1) / 2, cz); else d.box(w + 0.03, y1 - y0, 0.05, 0x6a6b66, cx, (y0 + y1) / 2, cz + o); }
    for (let i = 0; i < Math.floor(len / 1.8); i++) { const o = (h01(i, cx, cz) - 0.5) * (len - 0.6), hh = 0.5 + h01(i + 4, cx, cz) * 1.2; if (alongX) d.box(0.1, hh, dd + 0.04, 0x55564f, cx + o, y1 - hh / 2, cz); else d.box(w + 0.04, hh, 0.1, 0x55564f, cx, y1 - hh / 2, cz + o); }
  };
  cp(x, z - D / 2, W, T, 0, H); colBox(x, z - D / 2, W / 2, T / 2);
  cp(x - W / 2, z, T, D, 0, H); colBox(x - W / 2, z, T / 2, D / 2); cp(x + W / 2, z, T, D, 0, H); colBox(x + W / 2, z, T / 2, D / 2);
  cp(x - 2.7, z + D / 2, 3.6, T, 0, H); colBox(x - 2.7, z + D / 2, 1.8, T / 2); cp(x + 2.7, z + D / 2, 3.6, T, 0, H); colBox(x + 2.7, z + D / 2, 1.8, T / 2);
  cp(x, z + D / 2, 1.8, T, 2.5, H);
  r.box(W + 0.6, 0.5, D + 0.6, CONC, x, H + 0.25, z);
  r.box(W + 3, 1.0, D + 3, 0x5c5036, x, H + 1.0, z); r.box(W - 1, 0.8, D - 1, 0x66583c, x, H + 1.9, z);
  for (let i = 0; i < 14; i++) { const px = x + (h01(i, x, z) - 0.5) * (W - 1.5), pz = z + (h01(i + 9, x, z) - 0.5) * (D - 1.5); for (let k = 0; k < 3; k++) d.box(0.05, 0.2 + k * 0.06, 0.05, 0x5a7a3a, px + k * 0.07, H + 2.4, pz); }
  for (let i = 0; i < 5; i++) d.box(0.5 + h01(i, z, x) * 0.5, 0.35, 0.45, 0x6a6a64, x - W / 2 - 1.3 + (i % 2) * 0.4, H + 0.7 - i * 0.0, z - 3 + i * 1.3);
  // стальная дверь: рама, петли, запорное колесо, приоткрыта
  m.box(0.18, 2.5, 1.0, DARK, x - 1.2, 1.25, z + D / 2 + 0.6, 0, 1.15, 0); m.cylX(0.14, 0.06, 0x6a6f75, x - 1.2, 1.3, z + D / 2 + 0.55, 8);
  m.box(0.16, 2.5, 0.2, 0x3a3f45, x - 0.9, 1.25, z + D / 2); m.box(0.16, 2.5, 0.2, 0x3a3f45, x + 0.9, 1.25, z + D / 2); m.box(1.96, 0.16, 0.2, 0x3a3f45, x, 2.5, z + D / 2);
  textPlane('АРСЕНАЛ', 3.0, 0.5, '#23282c', '#d8d0b0', x, 2.85, z + D / 2 + T / 2 + 0.02, 0); textPlane('ВХОД ВОСПРЕЩЁН', 3.0, 0.3, '#a02a1a', '#f0ead8', x, 3.28, z + D / 2 + T / 2 + 0.03, 0);
  rackK(K, x - W / 2 + 0.9, z - 0.5, 'z', 3.6, true); rackK(K, x + W / 2 - 0.9, z - 0.5, 'z', 3.6, true);
  [-2, 2].forEach(ox => { g.box(1.2, 0.05, 0.3, 0xfff0cc, x + ox, H - 0.1, z); m.box(1.3, 0.05, 0.4, 0x3a3f45, x + ox, H - 0.05, z); });
  crateK(s, 2.0, 0.9, 0.8, 0x4a5230, x, 0, z - 2.3); colBox(x, z - 2.3, 1.0, 0.4);
  // снаружи: предупреждающие полосы, вентиляционные грибки, антенна, ящики, мешки с песком
  for (let i = 0; i < 8; i++) d.box(0.4, 0.012, 0.7, i % 2 ? 0x151515 : 0xe0b020, x - 1.4 + i * 0.4, 0.052, z + 4.7);
  [-2.5, 2.5].forEach(ox => { m.cyl(0.22, 0.9, 0x8a8f94, x + ox, 4.9, z + 1, 8); m.cyl(0.3, 0.1, 0x4a4f55, x + ox, 5.8, z + 1, 8); m.cone(0.4, 0.05, 0.2, 0x5a5f64, x + ox, 5.95, z + 1, 8); });
  m.tube([x + 2, 5.7, z - 1], [x + 2, 8.9, z - 1], 0.05, 0x6a6f75, 5); m.cylX(0.3, 0.04, 0x9aa0a8, x + 2, 8.3, z - 1, 10); [[1, 0], [-1, 0], [0, 1.2]].forEach(([dx, dz]) => m.tube([x + 2, 8.5, z - 1], [x + 2 + dx * 2, 5.7, z - 1 + dz * 2], 0.008, 0x6a6f75, 3));
  crateK(s, 1.0, 0.9, 1.0, 0x4a5230, x + 7.5, 0, z + 3); crateK(s, 1.0, 0.9, 1.0, 0x4a5230, x + 7.5, 0.9, z + 3); colBox(x + 7.5, z + 3, 0.5, 0.5);
  sandWallK(K, x - 6.5, z + 5.5, x - 3.0, z + 5.5, 0.9); sandWallK(K, x + 3.0, z + 5.5, x + 6.5, z + 5.5, 0.9);
  K.finish();
  const rec = { x, z };
  armories.push(rec);
  return rec;
}

(function placeNewBuildings() {
  const g = findSpot(16); if (g) buildGasStation(g.x, g.z);
  const a = findSpot(14); if (a) buildGarage(a.x, a.z);
  const t = findSpot(7); if (t) buildWaterTower(t.x, t.z);
  const o = findSpot(18); if (o) buildOutpost(o.x, o.z);
  const ar = findSpot(9); if (ar) buildArmory(ar.x, ar.z);
})();

// --- Улучшения зданий: заборы, машины-остовы, контейнеры, погрузчик, цистерна, колючка, мачты, вывески ---
// --- Декор мира (1.9.0): заборы и дворы домов, контейнеры и погрузчик у складов, шины у гаражей ---
// Остальной декор (бочки, машины, цистерна, мачта, колючка, вывески) теперь собирается внутри самих зданий.
// Порядок и число вызовов Math.random те же, что в 1.8.0: заборы, пятна крови, шины.
(function decorateWorld() {
  const carColors = [0x5a6a7a, 0x7a3a2a, 0x6a6a3a, 0x3a5a4a];
  housePositions.forEach((h, i) => {
    clearTrees(h.x, h.z + 7.5, 8, 1.8);
    const K = bKit(h.x, h.z, 21), { d, m, g } = K;
    fenceK(K, h.x - 6.5, h.z + 7, h.x - 1.6, h.z + 7, 1.1, 0x7a6a4a); fenceK(K, h.x + 1.6, h.z + 7, h.x + 6.5, h.z + 7, 1.1, 0x7a6a4a);
    // почтовый ящик на столбе, фонарь у крыльца
    m.box(0.08, 1.0, 0.08, 0x4a3a2a, h.x + 1.3, 0.5, h.z + 7.3); m.box(0.4, 0.25, 0.22, 0x2f6fa8, h.x + 1.3, 1.1, h.z + 7.3); m.cyl(0.11, 0.4, 0x2f6fa8, h.x + 1.3, 1.1, h.z + 7.3, 8, true);
    m.box(0.02, 0.12, 0.1, 0xb02a1a, h.x + 1.52, 1.25, h.z + 7.3);
    g.box(0.16, 0.22, 0.16, 0xffd58a, h.x + 1.3, 2.7, h.z + 3.98);
    const blood = new THREE.Mesh(new THREE.CircleGeometry(0.5 + Math.random() * 0.5, 9), new THREE.MeshBasicMaterial({ color: 0x4a0f0f, transparent: true, opacity: 0.7 }));
    blood.rotation.x = -Math.PI / 2; blood.position.set(h.x + (Math.random() - 0.5) * 1.6, 0.04, h.z + 4.9); scene.add(blood);
    // грядка: земля в раме, ростки, колышки
    d.box(2.2, 0.25, 1.0, 0x4a3a24, h.x - 1.5, 0.12, h.z - 5.3); d.box(2.2, 0.35, 0.5, 0x3f7a34, h.x - 1.5, 0.35, h.z - 5.3);
    [-1, 1].forEach(sx => d.box(0.08, 0.3, 1.1, 0x6a5a3a, h.x - 1.5 + sx * 1.1, 0.15, h.z - 5.3));
    for (let k = 0; k < 6; k++) d.box(0.1, 0.3 + (k % 3) * 0.08, 0.1, 0x4f9a3a, h.x - 2.4 + k * 0.36, 0.55, h.z - 5.3 + (k % 2 ? 0.15 : -0.1));
    if (i % 3 === 0) { clearTrees(h.x + 9, h.z + 2, 3.5, 3.5); carK(K, h.x + 9, h.z + 2, 0, carColors[i % carColors.length]); }
    else barrelsK(K, h.x - 9, h.z + 1, 2 + (i % 3));
    K.finish();
  });
  warehouses.forEach((w, i) => { // контейнеры и погрузчик
    clearTrees(w.x + 13, w.z, 4, 9);
    const K = bKit(w.x, w.z, 22);
    containerK(K, w.x + 13, w.z - 3, Math.PI / 2, i ? ['#2f6fa8', '#1f4f7a'] : ['#a8442f', '#7a2f20'], 2);
    containerK(K, w.x + 13, w.z + 3.5, Math.PI / 2, i ? ['#c9a227', '#9a7a1a'] : ['#3f8a4a', '#2a6a34'], 1);
    forkliftK(K, w.x - 3.2, w.z - 1.2, 0);
    K.finish();
  });
  garages.forEach(g => { // шины: числа Math.random как раньше
    clearTrees(g.x + 9.5, g.z, 3, 6);
    const tires = makeTires(4); tires.group.position.set(g.x + 9.5, 0, g.z - 3); scene.add(tires.group);
  });
})();

function usePump(p) { // колонка: заправляет транспорт рядом или наливает канистру
  if (p.fuel <= 0) return notify('Колонка пуста');
  let target = null, bd = 8;
  const list = [];
  if (bike) list.push({ v: bike, pos: bike.rig.root.position });
  cars.forEach(c => list.push({ v: c, pos: c.rig.root.position }));
  list.forEach(o => { const d = Math.hypot(o.pos.x - p.x, o.pos.z - p.z); if (d < bd) { bd = d; target = o.v; } });
  if (target && target.fuel < 99) {
    const add = Math.min(100 - target.fuel, p.fuel);
    target.fuel += add; p.fuel -= add;
    return notify(`Заправлено +${Math.round(add)}% (в колонке осталось ${Math.round(p.fuel)})`);
  }
  if (freeRoom('fuel') < 1) return notify('Инвентарь полон');
  if (p.fuel < 40) return notify('Слишком мало топлива в колонке');
  p.fuel -= 40; addItem('fuel', 1);
  notify(`Налита канистра бензина (в колонке осталось ${Math.round(p.fuel)})`);
}
function registerGarageBench(g) { // верстак в гараже работает как обычный
  const hit = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.7), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.set(g.benchX, 0.45, g.benchZ); scene.add(hit);
  const vis = makeWorkbench(); vis.position.set(g.benchX, 0, g.benchZ); scene.add(vis);
  const collider = { minX: g.benchX - 0.8, maxX: g.benchX + 0.8, minZ: g.benchZ - 0.35, maxZ: g.benchZ + 0.35 };
  colliders.push(collider); blockers.push(hit);
  built.push({ key: 'garage', type: 'bench', mesh: hit, collider, vis });
}
function stockExtras() { // машины, верстак и припасы новых зданий
  for (const st of stations) {
    const sz = st.shopZ;
    [[-4.6, -1], [-3.2, -1], [0.6, -1], [2.0, -1]].forEach(([ox, oz], i) => spawnItem(i % 2 ? 'water' : 'food', st.x + ox, sz + oz, true));
    spawnItem('medkit', st.x - 1.5, sz + 1.2, true); spawnItem('medkit', st.x + 1.0, sz + 1.4, true);
    for (let i = 0; i < 3; i++) spawnItem('fuel', st.x + 4.8 + i * 0.6, sz - 1.8, true);
    spawnAmmoBox(st.x - 5.0, sz + 1.2, true);
    spawnPile('scrap', st.x - 9, st.z + 3, 3, true); spawnPile('rubber', st.x + 10, st.z + 4, 3, true);
    spawnCar(st.x + 9.5, st.z + 3, Math.PI, 20); // джип у заправки
  }
  for (const g of garages) {
    spawnCar(g.carX, g.carZ, Math.PI, 30); // джип в гараже (смотрит на выезд)
    registerGarageBench(g);
    spawnPile('rubber', g.x - 6.5, g.z + 3.2, 3, true); spawnPile('rubber', g.x - 5.0, g.z + 3.6, 3, true);
    spawnPile('scrap', g.x + 6.5, g.z + 2.5, 3, true); spawnPile('scrap', g.x + 3.0, g.z - 3.2, 3, true);
    spawnItem('fuel', g.x - 7.0, g.z - 4.0, true); spawnItem('fuel', g.x + 7.0, g.z - 4.0, true);
    spawnAmmoBox(g.x + 0.5, g.z - 4.0, true);
  }
  for (const o of outposts) { // блокпост: ящики с автоматами, патроны, охрана-зомби
    spawnCase(o.bx - 2.6, o.bz - 1.7, 0, true, 'ak'); spawnCase(o.bx + 2.6, o.bz - 1.7, 0, true, 'ak');
    spawnCase(o.x + 6, o.z + 2, Math.PI / 2, true, 'ak');
    spawnAmmoBox(o.bx, o.bz - 2.2, true); spawnAmmoBox(o.x + 3, o.z + 2, true); spawnAmmoBox(o.x + 3.8, o.z + 2.4, true);
    spawnItem('medkit', o.bx - 1.5, o.bz + 0.5, true); spawnItem('medkit', o.bx + 1.5, o.bz + 0.5, true);
    spawnItem('food', o.bx - 3.5, o.bz + 1.0, true); spawnItem('water', o.bx + 3.5, o.bz + 1.0, true);
    spawnPile('scrap', o.x + 5, o.z - 5, 3, true);
    for (let i = 0; i < 6; i++) spawnZombie(o.x + (Math.random() - 0.5) * 22, o.z + (Math.random() - 0.5) * 18, i < 4 ? 'soldier' : i === 4 ? 'brute' : 'normal');
  }
  for (const a of armories) { // арсенал
    spawnCase(a.x - 0.8, a.z - 0.4, 0, true, 'ak');
    spawnCase(a.x + 0.8, a.z + 1.4, 0, true);
    spawnAmmoBox(a.x - 2.5, a.z - 2.5, true); spawnAmmoBox(a.x + 2.5, a.z - 2.5, true); spawnAmmoBox(a.x, a.z + 2.2, true);
    spawnItem('medkit', a.x + 3.0, a.z + 2.0, true);
    for (let i = 0; i < 2; i++) spawnZombie(a.x + (Math.random() - 0.5) * 10, a.z + 8 + Math.random() * 3, 'soldier');
  }
  for (const t of towers) {
    spawnItem('food', t.x - 1.5, t.z + 1.0, true); spawnItem('water', t.x + 1.2, t.z + 1.4, true);
    spawnPile('wood', t.x + 3.6, t.z - 1.0, 4, true); spawnPile('scrap', t.x + 3.6, t.z + 1.4, 3, true);
  }
}

function teleport(x, z, w, down, newYaw) { // переход между складом и подвалом с затемнением
  fadeEl.style.transition = 'none'; fadeEl.style.opacity = '1';
  void fadeEl.offsetWidth;
  fadeEl.style.transition = 'opacity 0.8s'; fadeEl.style.opacity = '0';
  inBasement = down; curW = down ? w : null;
  camera.position.set(x, 1.7, z);
  resolveCollisions(camera.position, 0.4);
  yaw = newYaw; pitch = 0;
}
function useBasementPortal(p) { // клавиша E у люка или у лестницы
  const w = p.w;
  if (p.kind === 'hatch') {
    if (w.state !== 'open') return notify(hasAxe ? 'Люк заколочен: руби его топором (ЛКМ)' : 'Люк заколочен досками. Нужен топор');
    teleport(w.ladderX - 1.4, w.ladderZ, w, true, Math.PI / 2);
    notify('Подвал склада: здесь много припасов. Лестница вверх - у восточной стены');
  } else teleport(w.hx, w.hz + 2.4, w, false, Math.PI);
}
function stockWarehouses() { // раскладываем припасы (они не появляются заново)
  for (const w of warehouses) {
    spawnAmmoBox(w.x - 6.2, w.z + 2.8, true); spawnAmmoBox(w.x + 6.2, w.z + 2.0, true);
    spawnPile('scrap', w.x - 3.2, w.z + 3.0, 3, true); spawnPile('rubber', w.x + 2.2, w.z + 3.6, 3, true); spawnPile('wood', w.x + 6.3, w.z - 0.8, 4, true);
    spawnItem('food', w.x - 1.5, w.z + 1.8, true); spawnItem('water', w.x - 0.5, w.z + 2.0, true); spawnItem('fuel', w.x + 0.8, w.z + 1.6, true);
    const cx = w.bx, cz = w.bz;
    for (let i = 0; i < 5; i++) spawnPile('scrap', cx - 6 + i * 3, cz - 3.7, 3, true);
    for (let i = 0; i < 4; i++) spawnPile('rubber', cx - 6 + i * 4, cz + 3.7, 3, true);
    [[-5.8, -1.0], [-5.8, 1.0], [5.6, 0.0]].forEach(([ox, oz]) => spawnPile('wood', cx + ox, cz + oz, 5, true));
    const loose = ['food', 'food', 'food', 'food', 'food', 'water', 'water', 'water', 'water', 'water', 'medkit', 'medkit', 'medkit', 'fuel', 'fuel', 'fuel'];
    loose.forEach((t, i) => spawnItem(t, cx - 3.0 + (i % 5) * 1.5, cz - 0.6 + Math.floor(i / 5) * 0.6, true));
    [-2.2, -0.8, 0.8, 2.2].forEach(oz => spawnAmmoBox(cx + 6.6, cz + oz, true));
    spawnCase(cx - 7.6, cz, Math.PI / 2, true);
  }
}

// --- Мотоцикл: собирается на верстаке из бензобака, двух колёс и руля ---
// Мотоцикл DeadZone. Оси: вперёд -Z, вверх +Y, вправо +X. Начало координат - на земле посередине колёсной базы.
function createMotorcycle(opts) {
  opts = opts || {};
  const root = new THREE.Group();   // позиция и курс
  const tilt = new THREE.Group();   // крен и наклон (от земли)
  root.add(tilt);

  const mat = (color, rough, metal, extra) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: rough, metalness: metal, flatShading: true }, extra || {}));
  const M = {
    frame: mat(0x1a1c1e, 0.5, 0.6), tank: mat(0x8f2b21, 0.32, 0.45), dark: mat(0x1b1b1b, 0.8, 0.1),
    chrome: mat(0xc9ced4, 0.18, 0.95), steel: mat(0x7d838a, 0.4, 0.8), engine: mat(0x2f3338, 0.55, 0.65),
    engineHi: mat(0x4a5057, 0.45, 0.7), black: mat(0x0e0f10, 0.9, 0.05), rubber: mat(0x141414, 0.95, 0),
    tread: mat(0x0b0b0b, 1, 0), seat: mat(0x2a1d15, 0.9, 0), gold: mat(0xc99a2e, 0.35, 0.8), cream: mat(0xe8dfc8, 0.6, 0.1),
    lens: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0b0, emissiveIntensity: 0, roughness: 0.1 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x7a0d0d, emissive: 0xff1a1a, emissiveIntensity: 0.3, roughness: 0.4 }),
    mirror: mat(0x20262c, 0.15, 0.9), skin: mat(0xd9a67a, 0.9, 0), jacket: mat(0x2d3a2a, 0.95, 0),
    pants: mat(0x3a3d44, 0.95, 0), helmet: mat(0x2b2f33, 0.3, 0.3), visor: mat(0x0f1620, 0.1, 0.6), glove: mat(0x1b1b1b, 0.8, 0),
    boot: mat(0x2a2018, 0.85, 0),
  };

  const box = (w, h, d, m, x, y, z, parent) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z); (parent || tilt).add(b); return b;
  };
  const cyl = (r, len, m, x, y, z, axis, parent, seg) => { // axis: 'x' | 'y' | 'z'
    const g = new THREE.CylinderGeometry(r, r, len, seg || 12);
    if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
    const c = new THREE.Mesh(g, m); c.position.set(x, y, z); (parent || tilt).add(c); return c;
  };
  const tube = (p1, p2, r, m, parent, seg) => {
    const a = new THREE.Vector3(p1[0], p1[1], p1[2]), b = new THREE.Vector3(p2[0], p2[1], p2[2]);
    const d = b.clone().sub(a), len = d.length();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg || 8), m);
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    (parent || tilt).add(mesh); return mesh;
  };
  // Профиль (u вперёд, v вверх) выдавливается на ширину width. u вперёд = -Z.
  function extrude(pts, width, m, bevel, segs) {
    bevel = bevel === undefined ? 0.01 : bevel;
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
    const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: segs || 1, steps: 1 });
    g.translate(0, 0, -width / 2); g.rotateY(Math.PI / 2);
    return new THREE.Mesh(g, m);
  }
  function arcBand(r0, r1, a0, a1, width, m) { // дуга вокруг колеса (крыло)
    const pts = [], n = Math.max(3, Math.round((a1 - a0) / 0.18));
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([r1 * Math.cos(a), r1 * Math.sin(a)]); }
    for (let i = n; i >= 0; i--) { const a = a0 + (a1 - a0) * i / n; pts.push([r0 * Math.cos(a), r0 * Math.sin(a)]); }
    return extrude(pts, width, m, 0.004);
  }
  function makeWheel() { // колесо вращается вокруг оси X
    const g = new THREE.Group();
    const tireGeo = new THREE.TorusGeometry(0.295, 0.068, 8, 24); tireGeo.rotateY(Math.PI / 2);
    g.add(new THREE.Mesh(tireGeo, M.rubber));
    const N = 24;
    for (let i = 0; i < N; i++) { // блоки протектора
      const a = (i / N) * Math.PI * 2;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.028, 0.05), M.tread);
      b.position.set(0, Math.sin(a) * 0.366, Math.cos(a) * 0.366);
      b.rotation.x = Math.PI / 2 - a;
      g.add(b);
    }
    cyl(0.235, 0.1, M.steel, 0, 0, 0, 'x', g, 20);
    cyl(0.2, 0.108, M.black, 0, 0, 0, 'x', g, 20);
    cyl(0.05, 0.17, M.chrome, 0, 0, 0, 'x', g, 10);
    for (let i = 0; i < 16; i++) { // спицы
      const a = (i / 16) * Math.PI * 2;
      tube([0, Math.sin(a) * 0.05, Math.cos(a) * 0.05], [0, Math.sin(a) * 0.225, Math.cos(a) * 0.225], 0.005, M.chrome, g, 4);
    }
    cyl(0.15, 0.008, M.steel, 0.042, 0, 0, 'x', g, 18); // тормозной диск
    return g;
  }

  // ===== Рама и подвеска =====
  const HEAD = new THREE.Vector3(0, 0.998, -0.402);
  const RAKE = 0.49;
  tube([0, 0.94, -0.36], [0, 0.9, 0.34], 0.026, M.frame);                       // верхняя труба
  tube([0, 0.92, -0.36], [0, 0.44, -0.2], 0.028, M.frame);                      // передняя труба
  [-1, 1].forEach(s => {
    tube([s * 0.075, 0.44, -0.2], [s * 0.075, 0.36, 0.1], 0.024, M.frame);      // нижняя колыбель
    tube([s * 0.075, 0.36, 0.1], [s * 0.075, 0.52, 0.34], 0.024, M.frame);
    tube([s * 0.065, 0.52, 0.34], [s * 0.065, 0.88, 0.34], 0.024, M.frame);     // стойка сиденья
    tube([s * 0.07, 0.88, 0.34], [s * 0.09, 0.86, 0.82], 0.02, M.frame);        // подрамник
    tube([s * 0.07, 0.62, 0.34], [s * 0.09, 0.86, 0.62], 0.018, M.frame);       // косынка
    tube([s * 0.1, 0.46, 0.3], [s * 0.11, 0.36, 0.68], 0.03, M.frame);          // маятник
    cyl(0.016, 0.1, M.chrome, s * 0.22, 0.36, 0.1, 'x');                         // подножка
    tube([s * 0.075, 0.38, 0.08], [s * 0.2, 0.36, 0.1], 0.014, M.frame);
    const topP = [s * 0.12, 0.88, 0.5], botP = [s * 0.13, 0.46, 0.66];          // амортизатор
    tube(topP, botP, 0.017, M.chrome);
    tube([topP[0] + (botP[0] - topP[0]) * 0.2, topP[1] + (botP[1] - topP[1]) * 0.2, topP[2] + (botP[2] - topP[2]) * 0.2],
         [topP[0] + (botP[0] - topP[0]) * 0.85, topP[1] + (botP[1] - topP[1]) * 0.85, topP[2] + (botP[2] - topP[2]) * 0.85], 0.03, M.gold, null, 10);
  });

  // ===== Двигатель =====
  box(0.25, 0.27, 0.38, M.engine, 0, 0.5, 0);                                     // картер
  box(0.27, 0.12, 0.2, M.engineHi, 0, 0.45, 0.12);                                // крышка коробки передач
  cyl(0.05, 0.03, M.chrome, 0.135, 0.5, 0.08, 'x');                               // крышка генератора
  const cylG = new THREE.Group(); cylG.position.set(0, 0.62, -0.05); cylG.rotation.x = -0.35; tilt.add(cylG);
  cyl(0.085, 0.24, M.engine, 0, 0.14, 0, 'y', cylG, 10);                          // гильза
  for (let i = 0; i < 6; i++) cyl(0.115, 0.014, M.engineHi, 0, 0.04 + i * 0.037, 0, 'y', cylG, 10); // рёбра охлаждения
  box(0.21, 0.1, 0.21, M.engineHi, 0, 0.29, 0, cylG);                             // головка
  box(0.17, 0.04, 0.17, M.engine, 0, 0.35, 0, cylG);                              // крышка клапанов
  cyl(0.045, 0.1, M.chrome, 0.1, 0.72, 0.17, 'z');                                // карбюратор
  box(0.18, 0.14, 0.2, M.black, 0.1, 0.75, 0.28);                                 // воздушный фильтр
  cyl(0.075, 0.07, M.chrome, 0.1, 0.75, 0.39, 'z');

  // ===== Выхлоп (справа) =====
  const ex = [[0.06, 0.82, -0.26], [0.14, 0.62, -0.35], [0.17, 0.42, -0.2], [0.17, 0.4, 0.2], [0.17, 0.45, 0.4]];
  for (let i = 0; i < ex.length - 1; i++) tube(ex[i], ex[i + 1], 0.02, M.chrome, null, 8);
  tube([0.17, 0.45, 0.36], [0.2, 0.6, 0.86], 0.052, M.chrome, null, 10);          // глушитель
  [0.45, 0.62].forEach(f => tube([0.17 + 0.03 * f, 0.45 + 0.15 * f, 0.36 + 0.5 * f], [0.17 + 0.03 * f + 0.01, 0.45 + 0.15 * f + 0.02, 0.36 + 0.5 * f + 0.02], 0.058, M.gold, null, 10)); // хомуты
  cyl(0.04, 0.02, M.black, 0.2, 0.6, 0.87, 'z');
  const exhaustPos = new THREE.Object3D(); exhaustPos.position.set(0.2, 0.61, 0.9); tilt.add(exhaustPos);

  // ===== Бак, сиденье, хвост =====
  const tank = extrude([[0.32, 0.97], [0.3, 1.1], [0.2, 1.19], [0.0, 1.21], [-0.1, 1.15], [-0.14, 1.03], [-0.12, 0.97]], 0.24, M.tank, 0.035, 2);
  tilt.add(tank);
  cyl(0.036, 0.02, M.chrome, 0, 1.25, -0.03, 'y');                                // крышка бака
  [-1, 1].forEach(s => {
    box(0.014, 0.13, 0.2, M.dark, s * 0.152, 1.08, -0.02);                        // накладки под колени
    cyl(0.04, 0.008, M.gold, s * 0.158, 1.1, -0.1, 'x');                          // значок
  });
  const seat = extrude([[-0.12, 1.06], [-0.14, 1.17], [-0.4, 1.18], [-0.62, 1.14], [-0.68, 1.09], [-0.66, 1.02], [-0.4, 1.0], [-0.14, 1.0]], 0.2, M.seat, 0.03, 2);
  tilt.add(seat);
  box(0.2, 0.025, 0.58, M.black, 0, 0.99, 0.4);                                   // основание сиденья
  const rf = arcBand(0.4, 0.416, 0.9, 2.35, 0.15, M.dark); rf.position.set(0, 0.36, 0.68); tilt.add(rf); // заднее крыло
  const tailMount = box(0.17, 0.03, 0.3, M.dark, 0, 0.9, 0.78); tailMount.rotation.x = 0.22;
  box(0.11, 0.05, 0.04, M.tail, 0, 0.86, 0.94);                                   // стоп-сигнал
  const tailLamp = M.tail;
  const pc = document.createElement('canvas'); pc.width = 128; pc.height = 64;
  const pctx = pc.getContext('2d'); pctx.fillStyle = '#e8e4d0'; pctx.fillRect(0, 0, 128, 64);
  pctx.fillStyle = '#222'; pctx.font = 'bold 34px monospace'; pctx.textAlign = 'center'; pctx.fillText('DZ-777', 64, 44);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(pc) }));
  plate.position.set(0, 0.78, 0.945); plate.rotation.x = -0.1; tilt.add(plate);

  // ===== Задняя вилка с колесом, цепь =====
  const wheelR = makeWheel(); wheelR.position.set(0, 0.36, 0.68); tilt.add(wheelR);
  cyl(0.12, 0.016, M.steel, -0.11, 0, 0, 'x', wheelR, 14);                        // задняя звезда
  cyl(0.06, 0.02, M.steel, -0.115, 0.44, 0.18, 'x');                              // передняя звезда
  tube([-0.115, 0.5, 0.18], [-0.115, 0.48, 0.68], 0.006, M.black, null, 4);       // цепь (верх)
  tube([-0.115, 0.38, 0.18], [-0.115, 0.24, 0.68], 0.006, M.black, null, 4);      // цепь (низ)

  // ===== Рулевая колонка и передняя вилка =====
  const head = new THREE.Group(); head.position.copy(HEAD); head.rotation.x = RAKE; tilt.add(head);
  cyl(0.045, 0.26, M.frame, 0, -0.02, 0, 'y', head);                              // рулевой стакан
  const steer = new THREE.Group(); head.add(steer);                               // вращается руль + вилка
  [-1, 1].forEach(s => tube([s * 0.095, -0.46, 0], [s * 0.095, 0.1, 0], 0.024, M.chrome, steer));
  box(0.28, 0.045, 0.085, M.frame, 0, 0.075, 0, steer);
  box(0.25, 0.04, 0.08, M.frame, 0, -0.115, 0, steer);
  const forkLower = new THREE.Group(); steer.add(forkLower);                      // нижние перья (идут вверх при сжатии)
  [-1, 1].forEach(s => tube([s * 0.095, -0.78, 0], [s * 0.095, -0.36, 0], 0.034, M.engineHi, forkLower));
  const wheelF = makeWheel(); wheelF.position.set(0, -0.72, 0); forkLower.add(wheelF);
  cyl(0.014, 0.3, M.chrome, 0, -0.72, 0, 'x', forkLower, 8);
  const ff = arcBand(0.385, 0.4, 0.45, 2.7, 0.13, M.tank); ff.position.set(0, -0.72, 0); forkLower.add(ff); // переднее крыло
  box(0.035, 0.08, 0.07, M.gold, 0.065, -0.58, -0.03, forkLower);                 // тормозной суппорт

  // Руль
  const barL = [-0.12, 0.17, -0.0], barR = [0.12, 0.17, -0.0];
  tube(barL, [-0.38, 0.2, 0.08], 0.014, M.chrome, steer);
  tube(barR, [0.38, 0.2, 0.08], 0.014, M.chrome, steer);
  tube(barL, barR, 0.014, M.chrome, steer);
  box(0.12, 0.03, 0.06, M.frame, 0, 0.14, 0, steer);
  const gripL = new THREE.Object3D(), gripR = new THREE.Object3D();
  gripL.position.set(-0.4, 0.2, 0.09); gripR.position.set(0.4, 0.2, 0.09); steer.add(gripL, gripR);
  [-1, 1].forEach(s => {
    cyl(0.019, 0.13, M.black, s * 0.4, 0.2, 0.09, 'x', steer);                    // рукоятки
    box(0.012, 0.012, 0.12, M.chrome, s * 0.35, 0.215, 0.0, steer);               // рычаги
    tube([s * 0.33, 0.22, 0.06], [s * 0.36, 0.42, 0.08], 0.006, M.chrome, steer, 5);
    cyl(0.05, 0.012, M.mirror, s * 0.36, 0.45, 0.08, 'z', steer, 12);            // зеркала
  });
  // Фара и приборка
  cyl(0.115, 0.13, M.chrome, 0, 0.0, -0.19, 'z', steer, 14);
  const lens = cyl(0.098, 0.008, M.lens, 0, 0.0, -0.257, 'z', steer, 14);
  tube([-0.1, 0.07, -0.08], [-0.095, 0.1, -0.15], 0.01, M.frame, steer, 5);
  tube([0.1, 0.07, -0.08], [0.095, 0.1, -0.15], 0.01, M.frame, steer, 5);
  cyl(0.048, 0.03, M.black, 0, 0.21, -0.03, 'z', steer, 12);
  cyl(0.04, 0.006, M.cream, 0, 0.21, -0.047, 'z', steer, 12);
  const headlight = new THREE.SpotLight(0xfff2d0, 0, 45, 0.5, 0.5, 1);
  headlight.position.set(0, 0.0, -0.24); steer.add(headlight);
  const hlTarget = new THREE.Object3D(); hlTarget.position.set(0, -4.3, -7); steer.add(hlTarget);
  headlight.target = hlTarget;

  // ===== Подставка =====
  const stand = new THREE.Group(); stand.position.set(-0.14, 0.4, 0.12); tilt.add(stand);
  tube([0, 0, 0], [-0.14, -0.3, 0.02], 0.014, M.frame, stand, 6);
  box(0.07, 0.015, 0.08, M.frame, -0.15, -0.31, 0.02, stand);

  // ===== Гонщик =====
  const rider = new THREE.Group(); tilt.add(rider);
  const body = new THREE.Group(); rider.add(body);   // то, что скрывается в виде от первого лица
  const torso = box(0.4, 0.52, 0.24, M.jacket, 0, 1.28, 0.105, body); torso.rotation.x = -0.38;
  box(0.34, 0.1, 0.2, M.pants, 0, 1.06, 0.2, body);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 10, 8), M.helmet); helmet.position.set(0, 1.74, -0.04); body.add(helmet);
  box(0.2, 0.065, 0.1, M.visor, 0, 1.745, -0.14, body);
  box(0.16, 0.06, 0.1, M.helmet, 0, 1.66, -0.1, body);
  [-1, 1].forEach(s => {
    const hip = [s * 0.13, 1.04, 0.2], knee = [s * 0.27, 0.86, -0.06], foot = [s * 0.2, 0.42, 0.1];
    tube(hip, knee, 0.07, M.pants, body, 8); tube(knee, foot, 0.06, M.pants, body, 8);
    box(0.1, 0.09, 0.26, M.boot, foot[0], 0.4, 0.04, body);
  });
  // Руки считаются каждый кадр (следуют за рулём)
  const armParts = [];
  [-1, 1].forEach(s => {
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), M.jacket);
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 1, 8), M.jacket);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.11), M.glove);
    rider.add(upper, fore, hand);
    armParts.push({ s, upper, fore, hand });
  });
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  function place(mesh, p, q) { // растянуть цилиндр между двумя точками
    const d = _b.copy(q).sub(p), len = d.length();
    mesh.position.copy(p).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(_up, d.normalize());
    mesh.scale.set(1, len, 1);
  }
  const shoulderL = new THREE.Vector3(-0.22, 1.5, 0.0), shoulderR = new THREE.Vector3(0.22, 1.5, 0.0);
  const _elb = new THREE.Vector3(), _hand = new THREE.Vector3();
  function updateRider() {
    root.updateMatrixWorld(true);
    armParts.forEach(a => {
      (a.s < 0 ? gripL : gripR).getWorldPosition(_hand);
      tilt.worldToLocal(_hand);                       // рука в системе мотоцикла
      const sh = a.s < 0 ? shoulderL : shoulderR;
      _elb.copy(sh).add(_hand).multiplyScalar(0.5).add(new THREE.Vector3(a.s * 0.1, -0.07, 0.08));
      place(a.upper, sh, _elb);
      place(a.fore, _elb, _hand);
      a.hand.position.copy(_hand);
    });
  }
  const eye = new THREE.Object3D(); eye.position.set(0, 1.64, -0.08); tilt.add(eye);   // глаза гонщика (вид от первого лица)

  updateRider();
  return {
    root, tilt, steer, forkLower, wheelF, wheelR, stand, headlight, lens, tailLamp, exhaustPos, eye,
    body, rider, updateRider, M,
  };
}

let bike = null, riding = false, camView = 'fp';
let drive = null;                              // чем управляем: 'bike' (мотоцикл) или 'car' (джип)
const rb = () => riding && drive === 'bike';
let lookedBike = false;
const puffs = [];
const smokeMat = new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.3, depthWrite: false });
const dustMat = new THREE.MeshBasicMaterial({ color: 0xb59b72, transparent: true, opacity: 0.35, depthWrite: false });
const puffGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
const _p = new THREE.Vector3(), _eye = new THREE.Vector3();
function addPuff(pos, vel, mat, life, size) { // дым из выхлопа и пыль из-под колеса
  if (puffs.length > 60) return;
  const m = new THREE.Mesh(puffGeo, mat);
  m.position.copy(pos); scene.add(m);
  puffs.push({ m, v: vel, life, max: life, size });
}
function updatePuffs(dt) {
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    p.life -= dt;
    if (p.life <= 0) { scene.remove(p.m); puffs.splice(i, 1); continue; }
    p.m.position.addScaledVector(p.v, dt);
    const k = 1 - p.life / p.max, fade = p.life / p.max < 0.3 ? p.life / p.max / 0.3 : 1;
    p.m.scale.setScalar(Math.max(0.01, p.size * (1 + k * 2.5) * fade));
  }
}

// Звук двигателя (простой синтез)
let bActx = null, bEng = null;
function bikeSound(active, rpm, thr) {
  if (!bActx) return;
  if (!bEng) {
    const o1 = bActx.createOscillator(), o2 = bActx.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'square';
    const f = bActx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const g = bActx.createGain(); g.gain.value = 0;
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(bActx.destination);
    o1.start(); o2.start();
    bEng = { o1, o2, f, g };
  }
  const t = bActx.currentTime;
  bEng.o1.frequency.setTargetAtTime(rpm / 60 * 2 + 18, t, 0.04);
  bEng.o2.frequency.setTargetAtTime(rpm / 60 + 9, t, 0.04);
  bEng.f.frequency.setTargetAtTime(350 + thr * 900 + rpm * 0.12, t, 0.05);
  bEng.g.gain.setTargetAtTime(active ? (0.035 + thr * 0.06) * SETTINGS.volume : 0, t, 0.08);
}

function parkBikeCollider() {
  const p = bike.rig.root.position;
  bike.collider = { minX: p.x - 0.55, maxX: p.x + 0.55, minZ: p.z - 0.55, maxZ: p.z + 0.55 };
  colliders.push(bike.collider);
}
function spawnBike(x, z, heading) {
  const rig = createMotorcycle();
  rig.root.position.set(x, 0, z);
  rig.root.rotation.y = heading;
  rig.rider.visible = false;
  scene.add(rig.root);
  bike = { rig, heading, v: 0, steer: 0, lean: 0.12, leanT: 0, pitch: 0, comp: 0, standA: 0, fuel: 40, on: false, light: false, collider: null, rpm: 0, accel: 0, gas: 0, puffT: 0, dustT: 0 };
  parkBikeCollider();
}
function mountBike() {
  if (!bike || riding || health <= 0) return;
  riding = true; drive = 'bike';
  if (bike.collider) { removeFrom(colliders, bike.collider); bike.collider = null; }
  bike.rig.rider.visible = true;
  bike.on = bike.fuel > 0;
  yaw = bike.heading; pitch = -0.15;
  try { bActx = bActx || new (window.AudioContext || window.webkitAudioContext)(); if (bActx.state === 'suspended') bActx.resume(); } catch (err) { bActx = null; }
  notify(bike.on ? 'W - газ, S - тормоз, A/D - поворот, Пробел - ручник. E - слезть' : 'Нет бензина! Найди канистру и заправь (слоты 1-5)');
}
function dismountBike() {
  if (!rb()) return;
  if (Math.abs(bike.v) > 5) return notify('Сначала остановись');
  riding = false; drive = null;
  const r = bike.rig.root, h = bike.heading;
  camera.position.set(r.position.x + Math.cos(h) * 1.1, 1.7, r.position.z - Math.sin(h) * 1.1);
  resolveCollisions(camera.position, 0.4);
  yaw = h; pitch = 0; camera.rotation.z = 0;
  bike.rig.rider.visible = false; bike.on = false; bike.v = 0; bike.gas = 0;
  parkBikeCollider();
}

function updateBike(dt) { // физика: газ, тормоз, поворот, столкновения
  const b = bike, root = b.rig.root;
  if (b.fuel <= 0 && b.on) { b.on = false; notify('Бензин кончился!'); }
  const fuelOk = b.fuel > 0 && b.on;
  const gas = keys.KeyW && fuelOk ? 1 : 0, brk = keys.KeyS ? 1 : 0, hand = keys.Space ? 1 : 0;
  const steerIn = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
  const VMAX = adm('turbo') ? 60 : 30;
  let v = b.v;
  if (gas) v += 8.5 * (adm('turbo') ? 2.2 : 1) * (1 - Math.max(0, v) / VMAX) * dt;
  if (brk) { if (v > 0.3) v -= 18 * dt; else if (fuelOk) v = Math.max(-4, v - 3.5 * dt); }
  if (hand) v -= Math.sign(v) * Math.min(Math.abs(v), 24 * dt);
  if (!gas && !brk && !hand) v -= Math.sign(v) * Math.min(Math.abs(v), (1.3 + 0.012 * v * v) * dt);
  v = clamp(v, -4, VMAX);
  b.accel = dt > 0 ? (v - b.v) / dt : 0;
  b.v = v; b.gas = gas;
  const target = steerIn * 0.62 / (1 + Math.abs(v) / 9);
  b.steer += (target - b.steer) * Math.min(1, 7 * dt);
  const w = v / 1.42 * Math.tan(b.steer);          // скорость поворота
  const oldH = b.heading;
  b.heading += w * dt;
  yaw += b.heading - oldH;                          // взгляд поворачивается вместе с мотоциклом
  const ix = root.position.x - Math.sin(b.heading) * v * dt, iz = root.position.z - Math.cos(b.heading) * v * dt;
  root.position.x = ix; root.position.z = iz;
  resolveCollisions(root.position, 0.65);
  if (Math.hypot(root.position.x - ix, root.position.z - iz) > 0.02 && Math.abs(v) > 2) { // удар о препятствие
    if (Math.abs(v) > 12) health -= (Math.abs(v) - 12) * 1.6;
    b.v *= 0.3; notify('Столкновение!');
  }
  root.position.x = clamp(root.position.x, -190, 190); root.position.z = clamp(root.position.z, -190, 190);
  for (const z of zombies) { // сбиваем зомби
    const dx = z.mesh.position.x - root.position.x, dz = z.mesh.position.z - root.position.z;
    if (dx * dx + dz * dz < 1.5 && Math.abs(b.v) > 4) { damageZombie(z, 3); b.v *= 0.85; }
  }
  b.leanT = clamp(w * v * 0.045, -0.6, 0.6);
  b.pitch += (clamp(b.accel * 0.012, -0.12, 0.2) - b.pitch) * Math.min(1, 6 * dt);
  b.comp = clamp(Math.max(0, -b.accel) * 0.004, 0, 0.07);
  if (b.on) b.fuel = Math.max(0, b.fuel - (0.04 + gas * 0.2) * dt);
  if (adm('infFuel')) b.fuel = 100;
  const G = [0, 6, 12, 19, 26, 34], av = Math.abs(v);
  let gear = 1; while (gear < 5 && av > G[gear]) gear++;
  b.rpm = b.on ? 1100 + clamp((av - G[gear - 1]) / (G[gear] - G[gear - 1]), 0, 1) * 5000 + gas * 500 : 0;
}

function updateBikeVisuals(dt) { // положение, крен, колёса, свет, дым
  const b = bike, rig = b.rig;
  b.lean += ((rb() ? b.leanT : 0.12) - b.lean) * Math.min(1, 6 * dt);
  b.standA += ((rb() ? 1.4 : 0) - b.standA) * Math.min(1, 5 * dt);
  if (!rb()) { const k = Math.exp(-dt * 6); b.pitch *= k; b.steer *= k; b.comp *= k; }
  rig.root.rotation.y = b.heading;
  rig.tilt.rotation.set(b.pitch, 0, b.lean);
  if (rb() && b.on) rig.tilt.position.set(Math.sin(gunT * 70) * 0.0012, Math.sin(gunT * 83) * 0.0012, 0);
  else rig.tilt.position.set(0, 0, 0);
  rig.steer.rotation.y = b.steer;
  rig.forkLower.position.y = b.comp;
  rig.stand.rotation.z = b.standA;
  rig.wheelF.rotation.x -= b.v / 0.365 * dt;
  rig.wheelR.rotation.x -= b.v / 0.365 * dt;
  rig.headlight.intensity = b.light ? 45 : 0;
  rig.lens.material.emissiveIntensity = b.light ? 1.8 : 0;
  rig.M.tail.emissiveIntensity = rb() && (keys.KeyS || keys.Space) && b.v > 0.5 ? 1.8 : 0.35;
  rig.body.visible = !(rb() && camView === 'fp');
  rig.root.updateMatrixWorld(true);
  if (rb()) rig.updateRider();
  if (rb() && b.on && dt > 0) {
    b.puffT -= dt; b.dustT -= dt;
    if (b.puffT <= 0) {
      b.puffT = 0.09 - b.gas * 0.04;
      rig.exhaustPos.getWorldPosition(_p);
      addPuff(_p, new THREE.Vector3(Math.sin(b.heading) * 0.8 + (Math.random() - 0.5) * 0.3, 0.5, Math.cos(b.heading) * 0.8 + (Math.random() - 0.5) * 0.3), smokeMat, 0.9, 0.7);
    }
    if (Math.abs(b.v) > 6 && b.dustT <= 0) {
      b.dustT = 0.06;
      _p.set(rig.root.position.x + Math.sin(b.heading) * 0.7, 0.08, rig.root.position.z + Math.cos(b.heading) * 0.7);
      addPuff(_p, new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.8, (Math.random() - 0.5) * 0.8), dustMat, 0.8, 1.1);
    }
  }
}
function updateBikeCamera() { // вид от первого лица (C - сменить на вид сзади)
  if (!rb()) return;
  const rig = bike.rig;
  if (camView === 'fp') {
    rig.eye.getWorldPosition(_eye);
    camera.position.copy(_eye);
    camera.rotation.z = bike.lean * 0.5;
  } else {
    const h = bike.heading, p = rig.root.position;
    camera.position.set(p.x + Math.sin(h) * 4.2, 2.1, p.z + Math.cos(h) * 4.2);
    camera.lookAt(p.x - Math.sin(h) * 2, 1.0, p.z - Math.cos(h) * 2);
  }
}

// --- Джип: четырёхколёсный транспорт (найди в гараже или у заправки) ---
function createJeep() {
  const root = new THREE.Group(), tilt = new THREE.Group();
  root.add(tilt);
  const mat = (c, r, m, ex) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: r, metalness: m, flatShading: true }, ex || {}));
  const M = {
    body: mat(0x5a6a3a, 0.65, 0.25), bodyD: mat(0x46532c, 0.7, 0.25), rust: mat(0x6b4a2a, 0.9, 0.1), frame: mat(0x1c1e20, 0.6, 0.5),
    steel: mat(0x8a9096, 0.35, 0.8), black: mat(0x0e0f10, 0.9, 0.05), rubber: mat(0x141414, 0.95, 0), tread: mat(0x0b0b0b, 1, 0),
    seat: mat(0x3a2f26, 0.9, 0), cream: mat(0xe8dfc8, 0.6, 0.1), red: mat(0xa83222, 0.55, 0.15), skin: mat(0xd9a67a, 0.9, 0),
    jacket: mat(0x2d3a2a, 0.95, 0), glove: mat(0x1b1b1b, 0.8, 0), hair: mat(0x2b2118, 0.9, 0),
    glass: mat(0x9fc4d8, 0.1, 0.2, { transparent: true, opacity: 0.2, side: THREE.DoubleSide }),
    lens: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0b0, emissiveIntensity: 0, roughness: 0.1 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x7a0d0d, emissive: 0xff1a1a, emissiveIntensity: 0.3, roughness: 0.4 }),
  };
  const box = (w, h, d, m, x, y, z, parent) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); (parent || tilt).add(b); return b; };
  const cyl = (r, len, m, x, y, z, axis, parent, seg) => {
    const g = new THREE.CylinderGeometry(r, r, len, seg || 12);
    if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
    const c = new THREE.Mesh(g, m); c.position.set(x, y, z); (parent || tilt).add(c); return c;
  };
  const tube = (p1, p2, r, m, parent, seg) => {
    const a = new THREE.Vector3(p1[0], p1[1], p1[2]), b = new THREE.Vector3(p2[0], p2[1], p2[2]);
    const d = b.clone().sub(a), len = d.length();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg || 8), m);
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    (parent || tilt).add(mesh); return mesh;
  };
  function makeWheel(side) { // колесо вращается вокруг оси X
    const g = new THREE.Group();
    const tg = new THREE.TorusGeometry(0.32, 0.1, 8, 20); tg.rotateY(Math.PI / 2);
    g.add(new THREE.Mesh(tg, M.rubber));
    for (let i = 0; i < 20; i++) { // протектор
      const a = (i / 20) * Math.PI * 2;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.045, 0.08), M.tread);
      b.position.set(0, Math.sin(a) * 0.425, Math.cos(a) * 0.425); b.rotation.x = Math.PI / 2 - a; g.add(b);
    }
    cyl(0.23, 0.22, M.steel, 0, 0, 0, 'x', g, 14);
    cyl(0.1, 0.26, M.black, side * 0.03, 0, 0, 'x', g, 10);
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; cyl(0.016, 0.05, M.steel, side * 0.13, Math.sin(a) * 0.15, Math.cos(a) * 0.15, 'x', g, 5); }
    return g;
  }
  // шасси и оси
  [-1, 1].forEach(s => box(0.14, 0.18, 3.7, M.frame, s * 0.55, 0.5, 0.1));
  [-1.3, 0, 1.3].forEach(z => box(1.2, 0.12, 0.16, M.frame, 0, 0.48, z));
  cyl(0.06, 1.9, M.frame, 0, 0.42, -1.3, 'x'); cyl(0.06, 1.9, M.frame, 0, 0.42, 1.3, 'x');
  box(0.35, 0.3, 0.35, M.steel, 0, 0.42, 1.3);
  box(1.7, 0.08, 2.5, M.frame, 0, 0.62, 0.55);
  // кузов
  [-1, 1].forEach(s => {
    box(0.1, 0.45, 2.3, M.body, s * 0.9, 1.12, 0.55); box(0.12, 0.08, 2.3, M.bodyD, s * 0.9, 1.38, 0.55);
    box(0.12, 0.2, 1.2, M.bodyD, s * 0.9, 0.78, 0.0);                                    // порог
    box(0.34, 0.08, 1.05, M.bodyD, s * 0.9, 1.0, -1.3);                                  // крылья над колёсами
    box(0.34, 0.08, 0.95, M.bodyD, s * 0.93, 0.98, 1.3);
  });
  box(1.9, 0.5, 0.1, M.body, 0, 1.1, 1.75); box(1.9, 0.08, 0.14, M.bodyD, 0, 1.38, 1.75);
  box(1.7, 0.42, 1.4, M.body, 0, 1.05, -1.35); box(1.5, 0.06, 1.1, M.bodyD, 0, 1.28, -1.35);
  box(0.5, 0.01, 0.4, M.rust, 0.3, 1.315, -1.2); box(0.01, 0.2, 0.5, M.rust, 0.955, 1.12, 0.4); box(0.3, 0.01, 0.25, M.rust, -0.4, 1.315, -1.7);
  // решётка, фары, бамперы
  box(1.0, 0.45, 0.08, M.black, 0, 1.02, -2.06);
  for (let i = -2; i <= 2; i++) box(0.05, 0.4, 0.05, M.steel, i * 0.2, 1.02, -2.1);
  const lenses = [];
  [-1, 1].forEach(s => { cyl(0.14, 0.1, M.steel, s * 0.62, 1.08, -2.04, 'z', null, 12); lenses.push(cyl(0.115, 0.012, M.lens, s * 0.62, 1.08, -2.1, 'z', null, 12)); });
  box(1.95, 0.2, 0.28, M.frame, 0, 0.62, -2.14); box(1.95, 0.2, 0.28, M.frame, 0, 0.62, 1.98);
  cyl(0.1, 0.5, M.steel, 0, 0.62, -2.3, 'x', null, 10);                                  // лебёдка
  // лобовое стекло, дуга безопасности
  [-1, 1].forEach(s => {
    tube([s * 0.84, 1.38, -0.75], [s * 0.8, 1.88, -0.48], 0.03, M.black);
    tube([s * 0.82, 1.4, 0.95], [s * 0.82, 1.95, 0.95], 0.03, M.black);
    tube([s * 0.82, 1.95, 0.95], [s * 0.86, 1.4, 1.7], 0.025, M.black);
    tube([s * 0.8, 1.88, -0.48], [s * 0.82, 1.95, 0.95], 0.028, M.black);
  });
  tube([-0.8, 1.88, -0.48], [0.8, 1.88, -0.48], 0.03, M.black); tube([-0.82, 1.95, 0.95], [0.82, 1.95, 0.95], 0.03, M.black);
  const wsh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.55), M.glass); wsh.position.set(0, 1.62, -0.62); wsh.rotation.x = 0.28; tilt.add(wsh);
  // салон
  [-0.42, 0.42].forEach(x => { box(0.5, 0.12, 0.5, M.seat, x, 0.86, 0.4); box(0.5, 0.62, 0.12, M.seat, x, 1.2, 0.68); });
  box(1.6, 0.12, 0.5, M.seat, 0, 0.86, 1.3); box(1.6, 0.55, 0.1, M.seat, 0, 1.17, 1.58);
  box(1.7, 0.3, 0.4, M.black, 0, 1.18, -0.55);
  cyl(0.08, 0.04, M.cream, -0.42, 1.34, -0.34, 'z', null, 12); cyl(0.06, 0.04, M.cream, 0, 1.34, -0.34, 'z', null, 10);
  const steerPivot = new THREE.Group(); steerPivot.position.set(-0.42, 1.28, -0.12); steerPivot.rotation.x = -0.6; tilt.add(steerPivot);
  const steerWheel = new THREE.Group(); steerPivot.add(steerWheel);
  steerWheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 6, 16), M.black));
  for (let i = 0; i < 3; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.02, 0.02), M.black); sp.rotation.z = i * Math.PI / 3; steerWheel.add(sp); }
  steerWheel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.04, 8).rotateX(Math.PI / 2), M.steel));
  tube([-0.42, 1.12, -0.42], [-0.42, 1.28, -0.12], 0.025, M.frame);
  // боковые зеркала, запаска, фонари, номер, выхлоп, канистра
  [-1, 1].forEach(s => { box(0.2, 0.03, 0.03, M.black, s * 0.98, 1.5, -0.8); box(0.04, 0.14, 0.18, M.black, s * 1.08, 1.5, -0.8); box(0.14, 0.2, 0.06, M.tail, s * 0.78, 1.08, 1.82); });
  const spare = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.1, 8, 18), M.rubber); spare.position.set(0, 1.0, 2.0); tilt.add(spare);
  cyl(0.2, 0.12, M.steel, 0, 1.0, 2.0, 'z', null, 12);
  box(0.14, 0.34, 0.22, M.red, -0.97, 1.2, 1.35);
  tube([0.55, 0.4, 1.55], [0.6, 0.42, 2.15], 0.04, M.steel);
  const exhaustPos = new THREE.Object3D(); exhaustPos.position.set(0.6, 0.42, 2.2); tilt.add(exhaustPos);
  const pc = document.createElement('canvas'); pc.width = 128; pc.height = 64;
  const px = pc.getContext('2d'); px.fillStyle = '#e8e4d0'; px.fillRect(0, 0, 128, 64); px.fillStyle = '#222'; px.font = 'bold 34px monospace'; px.textAlign = 'center'; px.fillText('DZ-4X4', 64, 44);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.16), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(pc) })); plate.position.set(0, 0.78, 2.01); tilt.add(plate);
  // колёса: передние поворачиваются
  const steerL = new THREE.Group(), steerR = new THREE.Group();
  steerL.position.set(-0.88, 0.42, -1.3); steerR.position.set(0.88, 0.42, -1.3); tilt.add(steerL, steerR);
  const fl = makeWheel(-1), fr = makeWheel(1), rl = makeWheel(-1), rr = makeWheel(1);
  steerL.add(fl); steerR.add(fr);
  rl.position.set(-0.88, 0.42, 1.3); rr.position.set(0.88, 0.42, 1.3); tilt.add(rl, rr);
  // водитель (виден только в виде сзади)
  const driver = new THREE.Group(); tilt.add(driver);
  box(0.42, 0.58, 0.26, M.jacket, -0.42, 1.38, 0.5, driver);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), M.skin); head.position.set(-0.42, 1.82, 0.47); driver.add(head);
  box(0.28, 0.08, 0.28, M.hair, -0.42, 1.93, 0.47, driver);
  tube([-0.64, 1.55, 0.5], [-0.56, 1.3, -0.04], 0.05, M.jacket, driver); tube([-0.2, 1.55, 0.5], [-0.28, 1.3, -0.04], 0.05, M.jacket, driver);
  box(0.09, 0.09, 0.1, M.glove, -0.56, 1.28, -0.04, driver); box(0.09, 0.09, 0.1, M.glove, -0.28, 1.28, -0.04, driver);
  tube([-0.52, 1.0, 0.55], [-0.52, 0.85, 0.1], 0.07, M.jacket, driver); tube([-0.32, 1.0, 0.55], [-0.32, 0.85, 0.1], 0.07, M.jacket, driver);
  driver.visible = false;
  const eye = new THREE.Object3D(); eye.position.set(-0.42, 1.62, 0.38); tilt.add(eye);
  return { root, tilt, steerL, steerR, steerWheel, spins: [fl, fr, rl, rr], lenses, exhaustPos, eye, driver, M };
}

const cars = [];
let curCar = null;
const carLight = new THREE.SpotLight(0xfff2d0, 0, 70, 0.6, 0.5, 1); // одна фара на машину, которой управляешь
scene.add(carLight); scene.add(carLight.target);
function parkCarCollider(c) {
  const p = c.rig.root.position;
  c.collider = { minX: p.x - 1.3, maxX: p.x + 1.3, minZ: p.z - 1.3, maxZ: p.z + 1.3 };
  colliders.push(c.collider);
}
function spawnCar(x, z, heading, fuel) {
  const rig = createJeep();
  rig.root.position.set(x, 0, z); rig.root.rotation.y = heading;
  scene.add(rig.root);
  const c = { rig, heading, v: 0, steer: 0, lean: 0, leanT: 0, pitch: 0, fuel: fuel === undefined ? 35 : fuel, on: false, light: false, collider: null, rpm: 0, accel: 0, gas: 0, puffT: 0, dustT: 0 };
  cars.push(c); parkCarCollider(c);
  return c;
}
function mountCar(c) {
  if (riding || health <= 0) return;
  riding = true; drive = 'car'; curCar = c;
  if (c.collider) { removeFrom(colliders, c.collider); c.collider = null; }
  c.on = c.fuel > 0;
  yaw = c.heading; pitch = -0.1;
  try { bActx = bActx || new (window.AudioContext || window.webkitAudioContext)(); if (bActx.state === 'suspended') bActx.resume(); } catch (err) { bActx = null; }
  notify(c.on ? 'W - газ, S - тормоз и задний ход, A/D - руль, Пробел - ручник. E - выйти' : 'Нет бензина! Заправь джип (колонка или канистра из слотов 1-5)');
}
function dismountCar() {
  if (!riding || drive !== 'car' || !curCar) return;
  const c = curCar;
  if (Math.abs(c.v) > 6) return notify('Сначала остановись');
  riding = false; drive = null;
  const r = c.rig.root, h = c.heading;
  camera.position.set(r.position.x - Math.cos(h) * 1.9, 1.7, r.position.z + Math.sin(h) * 1.9); // выходим влево
  resolveCollisions(camera.position, 0.4);
  yaw = h; pitch = 0; camera.rotation.z = 0;
  c.on = false; c.v = 0; c.gas = 0; curCar = null;
  parkCarCollider(c);
}
function updateCar(dt) { // физика джипа
  const c = curCar, root = c.rig.root;
  if (c.fuel <= 0 && c.on) { c.on = false; notify('Бензин кончился!'); }
  const ok = c.fuel > 0 && c.on;
  const gas = keys.KeyW && ok ? 1 : 0, brk = keys.KeyS ? 1 : 0, hand = keys.Space ? 1 : 0;
  const steerIn = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
  const VMAX = adm('turbo') ? 45 : 22;
  let v = c.v;
  if (gas) v += 5.5 * (adm('turbo') ? 2 : 1) * (1 - Math.max(0, v) / VMAX) * dt;
  if (brk) { if (v > 0.3) v -= 14 * dt; else if (ok) v = Math.max(-5, v - 3 * dt); }
  if (hand) v -= Math.sign(v) * Math.min(Math.abs(v), 20 * dt);
  if (!gas && !brk && !hand) v -= Math.sign(v) * Math.min(Math.abs(v), (1.0 + 0.01 * v * v) * dt);
  v = clamp(v, -5, VMAX);
  c.accel = dt > 0 ? (v - c.v) / dt : 0; c.v = v; c.gas = gas;
  const target = steerIn * 0.55 / (1 + Math.abs(v) / 12);
  c.steer += (target - c.steer) * Math.min(1, 6 * dt);
  const w = v / 2.6 * Math.tan(c.steer);
  const oldH = c.heading;
  c.heading += w * dt;
  yaw += c.heading - oldH;
  root.position.x += -Math.sin(c.heading) * v * dt; root.position.z += -Math.cos(c.heading) * v * dt;
  // столкновения: две точки (передняя и задняя часть кузова)
  const sx = Math.sin(c.heading), cz = Math.cos(c.heading);
  const fx = root.position.x - sx * 1.1, fz = root.position.z - cz * 1.1, bx = root.position.x + sx * 1.1, bz = root.position.z + cz * 1.1;
  const pf = { x: fx, z: fz }, pb = { x: bx, z: bz };
  resolveCollisions(pf, 1.0); resolveCollisions(pb, 1.0);
  const dxm = ((pf.x - fx) + (pb.x - bx)) / 2, dzm = ((pf.z - fz) + (pb.z - bz)) / 2;
  if (Math.hypot(dxm, dzm) > 0.02) {
    root.position.x += dxm; root.position.z += dzm;
    if (Math.abs(v) > 3) { if (Math.abs(v) > 11) health -= (Math.abs(v) - 11) * 1.2; c.v *= 0.3; notify('Столкновение!'); }
  }
  root.position.x = clamp(root.position.x, -190, 190); root.position.z = clamp(root.position.z, -190, 190);
  for (const z of zombies) { // сбиваем зомби
    const dx = z.mesh.position.x - root.position.x, dz = z.mesh.position.z - root.position.z;
    if (dx * dx + dz * dz < 3.6 && Math.abs(c.v) > 4) { damageZombie(z, 3); c.v *= 0.9; }
  }
  c.leanT = clamp(-w * v * 0.012, -0.12, 0.12);
  c.pitch += (clamp(c.accel * 0.006, -0.05, 0.05) - c.pitch) * Math.min(1, 6 * dt);
  if (c.on) c.fuel = Math.max(0, c.fuel - (0.05 + gas * 0.35) * dt);
  if (adm('infFuel')) c.fuel = 100;
  const G = [0, 4, 8, 12, 17, 24], av = Math.abs(v);
  let gear = 1; while (gear < 5 && av > G[gear]) gear++;
  c.rpm = c.on ? 800 + clamp((av - G[gear - 1]) / (G[gear] - G[gear - 1]), 0, 1) * 3800 + gas * 400 : 0;
}
function updateCarVisuals(dt) { // положение, руль, колёса, свет, дым
  for (const c of cars) {
    const rig = c.rig, driving = riding && drive === 'car' && curCar === c;
    c.lean += ((driving ? c.leanT : 0) - c.lean) * Math.min(1, 6 * dt);
    if (!driving) { const k = Math.exp(-dt * 6); c.pitch *= k; c.steer *= k; }
    rig.root.rotation.y = c.heading;
    rig.tilt.rotation.set(c.pitch, 0, c.lean);
    if (driving && c.on) rig.tilt.position.set(Math.sin(gunT * 60) * 0.002, Math.sin(gunT * 77) * 0.002, 0); else rig.tilt.position.set(0, 0, 0);
    rig.steerL.rotation.y = c.steer; rig.steerR.rotation.y = c.steer;
    rig.steerWheel.rotation.z = c.steer * 3;
    const spin = c.v / 0.42 * dt;
    rig.spins.forEach(w => { w.rotation.x -= spin; });
    rig.M.lens.emissiveIntensity = c.light ? 1.8 : 0;
    rig.M.tail.emissiveIntensity = driving && (keys.KeyS || keys.Space) && c.v > 0.5 ? 1.8 : 0.35;
    rig.driver.visible = driving && camView !== 'fp';
    if (driving) {
      rig.root.updateMatrixWorld(true);
      if (c.on && dt > 0) {
        c.puffT -= dt; c.dustT -= dt;
        if (c.puffT <= 0) {
          c.puffT = 0.1 - c.gas * 0.05;
          rig.exhaustPos.getWorldPosition(_p);
          addPuff(_p, new THREE.Vector3(Math.sin(c.heading) * 0.8 + (Math.random() - 0.5) * 0.3, 0.5, Math.cos(c.heading) * 0.8 + (Math.random() - 0.5) * 0.3), smokeMat, 0.9, 0.8);
        }
        if (Math.abs(c.v) > 5 && c.dustT <= 0) {
          c.dustT = 0.06;
          _p.set(rig.root.position.x + Math.sin(c.heading) * 1.4, 0.08, rig.root.position.z + Math.cos(c.heading) * 1.4);
          addPuff(_p, new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.8, (Math.random() - 0.5) * 0.8), dustMat, 0.8, 1.3);
        }
      }
    }
  }
  if (riding && drive === 'car' && curCar && curCar.light) { // фары
    const h = curCar.heading, p = curCar.rig.root.position;
    carLight.position.set(p.x - Math.sin(h) * 2.0, 1.1, p.z - Math.cos(h) * 2.0);
    carLight.target.position.set(p.x - Math.sin(h) * 25, 0.2, p.z - Math.cos(h) * 25);
    carLight.intensity = 70;
  } else carLight.intensity = 0;
}
function updateCarCamera() { // вид из кабины (C - вид сзади)
  if (!(riding && drive === 'car' && curCar)) return;
  const c = curCar, rig = c.rig;
  if (camView === 'fp') {
    rig.eye.getWorldPosition(_eye);
    camera.position.copy(_eye);
    camera.rotation.z = c.lean * 0.5;
  } else {
    const h = c.heading, p = rig.root.position;
    camera.position.set(p.x + Math.sin(h) * 6.5, 3.0, p.z + Math.cos(h) * 6.5);
    camera.lookAt(p.x - Math.sin(h) * 2.5, 1.1, p.z - Math.cos(h) * 2.5);
  }
}
function refuelNearest(amount) { // канистра: заправляет ближайший транспорт
  const list = [];
  if (bike) list.push({ v: bike, p: bike.rig.root.position });
  cars.forEach(c => list.push({ v: c, p: c.rig.root.position }));
  let best = null, bd = 5.5;
  list.forEach(o => { const d = Math.hypot(o.p.x - camera.position.x, o.p.z - camera.position.z); if (d < bd) { bd = d; best = o.v; } });
  if (!best) { notify('Подойди к транспорту, чтобы заправить'); return false; }
  if (best.fuel >= 99) { notify('Бак уже полный'); return false; }
  best.fuel = Math.min(100, best.fuel + amount); notify('Транспорт заправлен'); return true;
}
function vehicleHud() {
  const v = drive === 'car' ? curCar : bike, name = drive === 'car' ? 'Джип' : 'Мотоцикл';
  return `${name}: ${Math.round(Math.abs(v.v) * 3.6)} км/ч   Бензин: ${Math.ceil(v.fuel)}%   [E] Выйти  [F] Фара  [C] Вид`;
}

// --- Кучи ресурсов: брёвна (дерево) и куча железа (лом). Подойди, смотри на кучу, жми E: берётся по 1 ---
const piles = [];
const barkMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 1, flatShading: true });
const endMat = new THREE.MeshStandardMaterial({ color: 0xd2ab6f, roughness: 1, flatShading: true });
const metalMat = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.5, flatShading: true });

function makeLogs(n) { // от 2 до 5 брёвен горкой
  const group = new THREE.Group();
  const layouts = { // [x, y, z]; верхние брёвна идут первыми на вынос
    1: [[0, 0.14, 0]],
    2: [[0, 0.14, -0.145], [0, 0.14, 0.145]],
    3: [[0, 0.38, 0], [0, 0.14, -0.145], [0, 0.14, 0.145]],
    4: [[0, 0.38, -0.145], [0, 0.14, -0.29], [0, 0.14, 0.29], [0, 0.14, 0]],
    5: [[0, 0.38, -0.145], [0, 0.38, 0.145], [0, 0.14, -0.29], [0, 0.14, 0.29], [0, 0.14, 0]],
  };
  const parts = layouts[clamp(n, 1, 5)].map(([x, y, z]) => {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.05, 8), [barkMat, endMat, endMat]);
    log.position.set(x + (Math.random() - 0.5) * 0.08, y, z);
    log.rotation.set(0, (Math.random() - 0.5) * 0.14, Math.PI / 2); // кладём бревно на бок
    group.add(log);
    return log;
  });
  return { group, parts };
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

function makeTires(n) { // стопка старых покрышек (резина)
  const group = new THREE.Group(), parts = [];
  const mat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 1, flatShading: true });
  for (let i = 0; i < n; i++) {
    const geo = new THREE.TorusGeometry(0.27, 0.1, 6, 12); geo.rotateX(Math.PI / 2);
    const t = new THREE.Mesh(geo, mat);
    t.position.set((Math.random() - 0.5) * 0.06, 0.1 + i * 0.19, (Math.random() - 0.5) * 0.06);
    t.rotation.y = Math.random() * 6;
    group.add(t); parts.unshift(t); // верхняя покрышка забирается первой
  }
  return { group, parts };
}

function spawnPile(type, x, z, n, stash) {
  if (n === undefined) n = type === 'wood' ? 2 + Math.floor(Math.random() * 4) : 3; // дерево: от 2 до 5
  if (x === undefined) { // случайное место, не внутри деревьев и домов
    for (let tries = 0; tries < 30; tries++) {
      x = (Math.random() - 0.5) * 200; z = (Math.random() - 0.5) * 200;
      if (Math.abs(x) < 6 && Math.abs(z) < 6) continue;
      if (!colliders.some(c => x > c.minX - 0.8 && x < c.maxX + 0.8 && z > c.minZ - 0.8 && z < c.maxZ + 0.8)) break;
    }
  }
  const model = type === 'wood' ? makeLogs(n) : type === 'rubber' ? makeTires(n) : makeScrap();
  model.group.position.set(x, 0, z);
  model.group.rotation.y = Math.random() * Math.PI * 2;
  scene.add(model.group);
  piles.push({ type, n, stash, id: uidCounter++, dyn: initDone, x, z, group: model.group, parts: model.parts });
}
for (let i = 0; i < 16; i++) spawnPile('wood');
for (let i = 0; i < 18; i++) spawnPile('scrap');
for (let i = 0; i < 12; i++) spawnPile('rubber'); // старые покрышки

function takeFromPile(p) { // берём одну штуку, модель уменьшается
  if (chopCd > 0) return;
  if (freeRoom(p.type) < 1) return notify('Инвентарь полон');
  addItem(p.type, 1);
  chopCd = 0.25;
  p.group.remove(p.parts.shift());
  p.n--;
  if (p.n <= 0) { scene.remove(p.group); removeFrom(piles, p); if (!p.stash) spawnPile(p.type); } // где-то появится новая
}

// Подсказка «[E] ...» и поиск кучи или ящика, на которые смотрит игрок
let lookedPile = null, lookedCase = null, lookedBench = null, lookedPortal = null, lookedCar = null, lookedPump = null, lookedBuilt = null;
const promptEl = document.createElement('div');
promptEl.style.cssText = 'position:fixed;top:58%;left:50%;transform:translateX(-50%);color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;background:rgba(0,0,0,.35);padding:4px 12px;border-radius:6px;display:none';
document.body.appendChild(promptEl);
const _fwd = new THREE.Vector3(), _to = new THREE.Vector3();
function updatePrompt() {
  lookedPile = null; lookedCase = null; lookedBench = null; lookedBike = false; lookedPortal = null; lookedCar = null; lookedPump = null; lookedBuilt = null;
  if (!menuOpen && !buildMode && !riding && health > 0) {
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    let best = 0.88; // конус примерно 28 градусов
    for (const p of piles) {
      _to.set(p.group.position.x - camera.position.x, 0.25 - camera.position.y, p.group.position.z - camera.position.z);
      const d = _to.length();
      if (d > 3.5) continue;
      const c = _to.normalize().dot(_fwd);
      if (c > best) { best = c; lookedPile = p; }
    }
    for (const k of cases) {
      if (k.state !== 'closed' && k.state !== 'open') continue;
      _to.set(k.x - camera.position.x, 0.3 - camera.position.y, k.z - camera.position.z);
      const d = _to.length();
      if (d > 3.8) continue;
      const c = _to.normalize().dot(_fwd);
      if (c > best) { best = c; lookedCase = k; lookedPile = null; }
    }
    for (const b of built) { // верстак
      if (b.type !== 'bench') continue;
      _to.set(b.mesh.position.x - camera.position.x, 0.6 - camera.position.y, b.mesh.position.z - camera.position.z);
      if (_to.length() > 3.8) continue;
      const c = _to.normalize().dot(_fwd);
      if (c > best) { best = c; lookedBench = b; lookedCase = null; lookedPile = null; }
    }
    if (bike) { // мотоцикл
      const rp = bike.rig.root.position;
      _to.set(rp.x - camera.position.x, 0.6 - camera.position.y, rp.z - camera.position.z);
      if (_to.length() <= 3.8) {
        const c = _to.normalize().dot(_fwd);
        if (c > best) { best = c; lookedBike = true; lookedBench = null; lookedCase = null; lookedPile = null; }
      }
    }
    for (const w of warehouses) { // люк склада (наверху) и лестница (в подвале)
      let px = null, pz = null, kind = null;
      if (inBasement) { if (curW === w) { px = w.ladderX; pz = w.ladderZ; kind = 'up'; } }
      else { px = w.hx; pz = w.hz; kind = 'hatch'; }
      if (kind === null) continue;
      _to.set(px - camera.position.x, 0.4 - camera.position.y, pz - camera.position.z);
      if (_to.length() > 3.8) continue;
      const c = _to.normalize().dot(_fwd);
      if (c > best) { best = c; lookedPortal = { kind, w }; lookedBench = null; lookedCase = null; lookedPile = null; lookedBike = false; }
    }
    for (const c of cars) { // джипы
      const rp = c.rig.root.position;
      _to.set(rp.x - camera.position.x, 0.8 - camera.position.y, rp.z - camera.position.z);
      if (_to.length() > 4.6) continue;
      const cs = _to.normalize().dot(_fwd);
      if (cs > best) { best = cs; lookedCar = c; lookedPump = null; lookedPortal = null; lookedBike = false; lookedBench = null; lookedCase = null; lookedPile = null; }
    }
    for (const st of stations) for (const p of st.pumps) { // колонки заправки
      _to.set(p.x - camera.position.x, 1.0 - camera.position.y, p.z - camera.position.z);
      if (_to.length() > 3.6) continue;
      const cs = _to.normalize().dot(_fwd);
      if (cs > best) { best = cs; lookedPump = p; lookedCar = null; lookedPortal = null; lookedBike = false; lookedBench = null; lookedCase = null; lookedPile = null; }
    }
    for (const b of built) { // двери, ворота и кровати
      if (b.type !== 'door' && b.type !== 'gate' && b.type !== 'bed') continue;
      _to.set(b.mesh.position.x - camera.position.x, b.mesh.position.y - camera.position.y, b.mesh.position.z - camera.position.z);
      if (_to.length() > 4.2) continue;
      const cs = _to.normalize().dot(_fwd);
      if (cs > best) { best = cs; lookedBuilt = b; lookedCar = null; lookedPump = null; lookedPortal = null; lookedBike = false; lookedBench = null; lookedCase = null; lookedPile = null; }
    }
    const tx = lookedBuilt ? lookedBuilt.mesh.position.x : lookedCar ? lookedCar.rig.root.position.x : lookedPump ? lookedPump.x : lookedPortal ? (lookedPortal.kind === 'up' ? lookedPortal.w.ladderX : lookedPortal.w.hx) : lookedBike ? bike.rig.root.position.x : lookedBench ? lookedBench.mesh.position.x : lookedCase ? lookedCase.x : lookedPile ? lookedPile.group.position.x : null;
    const tz = lookedBuilt ? lookedBuilt.mesh.position.z : lookedCar ? lookedCar.rig.root.position.z : lookedPump ? lookedPump.z : lookedPortal ? (lookedPortal.kind === 'up' ? lookedPortal.w.ladderZ : lookedPortal.w.hz) : lookedBike ? bike.rig.root.position.z : lookedBench ? lookedBench.mesh.position.z : lookedCase ? lookedCase.z : lookedPile ? lookedPile.group.position.z : null;
    if (tx !== null) { // через стену не берём
      _to.set(tx - camera.position.x, 0.25 - camera.position.y, tz - camera.position.z);
      const d = _to.length();
      raycaster.set(camera.position, _to.normalize());
      const selfMesh = lookedBench ? lookedBench.mesh : lookedBuilt ? lookedBuilt.mesh : null; // свою же коробку (верстак, дверь) за стену не считаем
      const wall = raycaster.intersectObjects(blockers, false).find(h => h.object !== selfMesh);
      if (wall && wall.distance < d) { lookedBuilt = null; lookedPile = null; lookedCase = null; lookedBench = null; lookedBike = false; lookedPortal = null; lookedCar = null; lookedPump = null; }
    }
  }
  if (riding) {
    promptEl.textContent = drive === 'car' ? '[E] Выйти из джипа' : '[E] Слезть с мотоцикла';
    promptEl.style.display = 'block';
  } else if (lookedBuilt) {
    promptEl.textContent = lookedBuilt.type === 'bed' ? '[E] Кровать: сохранить игру или лечь спать' : lookedBuilt.type === 'gate' ? (lookedBuilt.open ? '[E] Закрыть ворота' : '[E] Открыть ворота') : (lookedBuilt.open ? '[E] Закрыть дверь' : '[E] Открыть дверь');
    promptEl.style.display = 'block';
  } else if (lookedCar) {
    promptEl.textContent = `[E] Сесть в джип (бензин ${Math.ceil(lookedCar.fuel)}%)`;
    promptEl.style.display = 'block';
  } else if (lookedPump) {
    promptEl.textContent = `[E] Колонка: заправить транспорт рядом или налить канистру (осталось ${Math.round(lookedPump.fuel)})`;
    promptEl.style.display = 'block';
  } else if (lookedPortal) {
    const w = lookedPortal.w;
    promptEl.textContent = lookedPortal.kind === 'up' ? '[E] Подняться наверх'
      : w.state === 'open' ? '[E] Спуститься в подвал'
      : hasAxe ? 'Люк заколочен: руби топором (ЛКМ), ударов осталось: ' + w.hp : 'Люк заколочен досками. Нужен топор (Tab - Крафт)';
    promptEl.style.display = 'block';
  } else if (lookedBike) {
    promptEl.textContent = `[E] Сесть на мотоцикл (бензин ${Math.ceil(bike.fuel)}%)`;
    promptEl.style.display = 'block';
  } else if (lookedBench) {
    promptEl.textContent = '[E] Верстак: делать детали и собирать мотоцикл';
    promptEl.style.display = 'block';
  } else if (lookedCase) {
    promptEl.textContent = lookedCase.state === 'closed' ? '[E] Открыть военный ящик' : lookedCase.kind === 'ak' ? '[E] Взять: автомат Калашникова + 30 патронов (+90 в запас)' : '[E] Взять: дробовик (5 патронов) + 20 патронов в запас';
    promptEl.style.display = 'block';
  } else if (lookedPile) {
    promptEl.textContent = `[E] Взять: ${ITEMS[lookedPile.type].name} (осталось ${lookedPile.n})`;
    promptEl.style.display = 'block';
  } else promptEl.style.display = 'none';
}
function treeHint() { // E у дерева: подсказка, рубить надо топором
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hit = raycaster.intersectObjects(trees.map(t => t.trunk), false)[0];
  if (hit && hit.distance < 3.5) notify(hasAxe ? 'Достань топор клавишей Q и бей левой кнопкой мыши' : 'Нужен топор: Tab, вкладка Крафт');
}
function interact() {
  if (sleeping) return; // клавиша E: слезть/сесть, верстак, ящик, куча, иначе подсказка про дерево
  if (riding) return drive === 'car' ? dismountCar() : dismountBike();
  if (lookedCar) return mountCar(lookedCar);
  if (lookedPump) return usePump(lookedPump);
  if (lookedBuilt) return lookedBuilt.type === 'bed' ? openBedMenu(lookedBuilt) : toggleDoor(lookedBuilt);
  if (lookedPortal) return useBasementPortal(lookedPortal);
  if (lookedBike) return mountBike();
  if (lookedBench) { menuTab = 'bench'; return toggleMenu(true); }
  if (lookedCase) caseInteract(lookedCase);
  else if (lookedPile) takeFromPile(lookedPile);
  else treeHint();
}

// --- Военные ящики: в каждом дробовик (5 патронов в магазине) + 20 патронов в запас ---
const cases = [];
function spawnCase(x, z, rotY, stash, kind) {
  if (x === undefined) { // случайное место вне домов и деревьев
    for (let tries = 0; tries < 40; tries++) {
      x = (Math.random() - 0.5) * 220; z = (Math.random() - 0.5) * 220;
      if (Math.abs(x) < 10 && Math.abs(z) < 10) continue;
      if (!colliders.some(c => x > c.minX - 1.5 && x < c.maxX + 1.5 && z > c.minZ - 1.5 && z < c.maxZ + 1.5)) break;
    }
    rotY = Math.random() < 0.5 ? 0 : Math.PI / 2;
  }
  const mc = createMilCase();
  mc.root.position.set(x, 0, z);
  mc.root.rotation.y = rotY;
  const lootGun = kind === 'ak' ? createAK({ hands: false }) : createShotgun({ hands: false });
  lootGun.root.rotation.y = Math.PI / 2;
  lootGun.root.position.set(0.05, kind === 'ak' ? 0.16 : 0.14, -0.05);
  if (kind === 'ak') { // магазины лежат рядом с автоматом
    lootGun.mag.visible = false;
    [0.1, 0.22].forEach(oz => { const mg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.045, 0.075), new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.5, metalness: 0.7, flatShading: true })); mg.position.set(0.45, 0.04, oz); mc.loot.add(mg); });
  }
  mc.loot.add(lootGun.root);
  scene.add(mc.root);
  const along = Math.abs(Math.sin(rotY)) < 0.5;
  const hw = along ? mc.L / 2 : mc.D / 2, hd = along ? mc.D / 2 : mc.L / 2;
  const collider = { minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd };
  colliders.push(collider);
  cases.push({ root: mc.root, lid: mc.lid, loot: mc.loot, latches: mc.latches, x, z, state: 'closed', t: 0, collider, stash, kind, id: uidCounter++, dyn: initDone, rotY });
}
function caseInteract(c) {
  if (c.state === 'closed') { c.state = 'opening'; c.t = 0; }
  else if (c.state === 'open') {
    c.state = 'taking'; c.t = 0;
    if (c.kind === 'ak') {
      if (!hasAK) {
        hasAK = true; akAmmo = AK_MAG; akReserve += 90;
        weapon = 'ak'; drawT = 0;
        notify('Получен автомат Калашникова: 30 в магазине + 90 в запас. ЛКМ зажать - очередь, [Q] - сменить оружие');
      } else { akReserve += 120; notify('+120 патронов для АК'); }
    } else if (!hasShotgun) {
      hasShotgun = true; sgAmmo = SG_MAG; sgReserve += 20;
      weapon = 'shotgun'; drawT = 0;
      notify('Получен дробовик: 5 патронов в магазине + 20 в запас. [Q] - сменить оружие');
    } else { sgReserve += SG_MAG + 20; notify('+25 патронов для дробовика'); }
    if (!c.stash) spawnCase(); // где-то на карте появится новый ящик
  }
}
function updateCases(dt) {
  for (let i = cases.length - 1; i >= 0; i--) {
    const c = cases[i];
    if (c.state === 'opening') {
      c.t += dt;
      const u = clamp(c.t / 1.0, 0, 1);
      c.lid.rotation.x = -1.95 * easeOut(u) + (u > 0.7 ? 0.06 * Math.sin(((u - 0.7) / 0.3) * Math.PI) : 0);
      c.latches.forEach(l => { l.rotation.x = -easeOut(clamp(c.t / 0.25, 0, 1)) * 1.2; });
      if (u >= 1) c.state = 'open';
    } else if (c.state === 'taking') {
      c.t += dt;
      const u = clamp(c.t / 0.6, 0, 1), e = easeOut(u);
      c.loot.position.set(0, 0.05 + 0.5 * e, 1.0 * e);
      c.loot.scale.setScalar(Math.max(0.001, 1 - e));
      if (u >= 1) { c.loot.visible = false; c.state = 'empty'; c.t = 0; }
    } else if (c.state === 'empty') {
      c.t += dt; // пустой ящик исчезает через 90 секунд
      if (c.t > 90) { scene.remove(c.root); removeFrom(colliders, c.collider); cases.splice(i, 1); }
    }
  }
}

// Патроны на земле
const ammoBoxes = [];
function spawnAmmoBox(x, z, stash) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.35), new THREE.MeshStandardMaterial({ color: 0xd4a017 }));
  const px = x ?? (Math.random() - 0.5) * 200, pz = z ?? (Math.random() - 0.5) * 200;
  m.position.set(px, 0.15, pz);
  scene.add(m);
  m.userData.stash = stash; m.userData.id = uidCounter++; m.userData.dyn = initDone; m.userData.px = px; m.userData.pz = pz;
  ammoBoxes.push(m);
}
for (let i = 0; i < 15; i++) spawnAmmoBox();

// Предметы на земле: консервы (еда), бутылки (вода), аптечка с красным крестом
const items = [];
function makeItemModel(type) {
  const g = new THREE.Group();
  const mat = (c, r, m, extra) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: r, metalness: m, flatShading: true }, extra || {}));
  const add = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); return o; };
  const cyl = (rt, rb, h, seg) => new THREE.CylinderGeometry(rt, rb, h, seg || 10);
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  if (type === 'medkit') {
    const red = mat(0xd63030, 0.6, 0), white = mat(0xf2f2f2, 0.6, 0), dark = mat(0x2b2b2b, 0.8, 0.2);
    add(box(0.42, 0.26, 0.3), white, 0, 0.13, 0);
    add(box(0.44, 0.03, 0.32), mat(0xd0d0d0, 0.6, 0), 0, 0.17, 0);      // шов крышки
    add(box(0.16, 0.012, 0.05), red, 0, 0.266, 0); add(box(0.05, 0.012, 0.16), red, 0, 0.266, 0); // крест сверху
    add(box(0.16, 0.05, 0.012), red, 0, 0.13, 0.151); add(box(0.05, 0.16, 0.012), red, 0, 0.13, 0.151); // крест спереди
    add(box(0.16, 0.03, 0.03), dark, 0, 0.29, 0);                           // ручка
    add(box(0.03, 0.05, 0.03), dark, -0.075, 0.275, 0); add(box(0.03, 0.05, 0.03), dark, 0.075, 0.275, 0);
    [-1, 1].forEach(s => add(box(0.03, 0.06, 0.02), mat(0x8a8f96, 0.4, 0.7), s * 0.17, 0.18, 0.155)); // замки
  } else if (type === 'food') {
    const can = (x, z, label, lying) => {
      const c = new THREE.Group();
      const add2 = (geo, m, y) => { const o = new THREE.Mesh(geo, m); o.position.y = y; c.add(o); };
      add2(cyl(0.085, 0.085, 0.13), mat(0xb9bec4, 0.4, 0.7), 0.065);
      add2(cyl(0.0875, 0.0875, 0.075), mat(label, 0.8, 0), 0.065);
      add2(cyl(0.09, 0.09, 0.012), mat(0xe2e6ea, 0.35, 0.8), 0.134);
      add2(cyl(0.09, 0.09, 0.012), mat(0x8a9097, 0.4, 0.7), 0.006);
      if (lying) { c.rotation.z = Math.PI / 2; c.position.set(x, 0.085, z); c.rotation.y = 0.5; }
      else c.position.set(x, 0, z);
      g.add(c);
    };
    can(-0.1, 0, 0xc2552a, false); can(0.12, 0.04, 0x6b8f3a, false); can(0.0, -0.17, 0xc9a227, true);
  } else if (type === 'water') {
    const bottle = (x, z, lying) => {
      const b = new THREE.Group();
      const water = mat(0x5fb0ec, 0.25, 0, { transparent: true, opacity: 0.82 });
      const add2 = (geo, m, y) => { const o = new THREE.Mesh(geo, m); o.position.y = y; b.add(o); };
      add2(cyl(0.07, 0.07, 0.22), water, 0.11);
      add2(cyl(0.035, 0.07, 0.06), water, 0.25);       // плечи
      add2(cyl(0.032, 0.032, 0.04), water, 0.30);      // горлышко
      add2(cyl(0.036, 0.036, 0.035), mat(0x1f5f9e, 0.6, 0), 0.337); // крышка
      add2(cyl(0.0715, 0.0715, 0.07), mat(0xf4f4f4, 0.7, 0), 0.11); // этикетка
      add2(cyl(0.0722, 0.0722, 0.018), mat(0x2f7fc4, 0.7, 0), 0.11);
      if (lying) { b.rotation.z = Math.PI / 2; b.position.set(x, 0.07, z); b.rotation.y = 0.4; }
      else b.position.set(x, 0, z);
      g.add(b);
    };
    bottle(-0.08, 0, false); bottle(0.04, 0.2, true);
  } else if (type === 'fuel') { // канистра с бензином
    const red = mat(0xa83222, 0.55, 0.15), dark = mat(0x5a1a12, 0.7, 0.1), yellow = mat(0xe0b020, 0.5, 0.2);
    add(box(0.32, 0.42, 0.15), red, 0, 0.21, 0);
    add(box(0.34, 0.03, 0.17), dark, 0, 0.05, 0); add(box(0.34, 0.03, 0.17), dark, 0, 0.37, 0);
    add(box(0.14, 0.06, 0.05), dark, -0.06, 0.45, 0);
    add(box(0.04, 0.1, 0.04), dark, -0.12, 0.43, 0); add(box(0.04, 0.1, 0.04), dark, 0.0, 0.43, 0);
    add(cyl(0.025, 0.025, 0.06, 8), yellow, 0.1, 0.45, 0);
    add(box(0.18, 0.12, 0.012), mat(0xe8e0c8, 0.8, 0), 0, 0.2, 0.082);
    add(box(0.05, 0.05, 0.014), dark, 0, 0.2, 0.084);
  }
  return g;
}
function spawnItem(type, x, z, stash) {
  const m = makeItemModel(type);
  const px = x ?? (Math.random() - 0.5) * 200, pz = z ?? (Math.random() - 0.5) * 200;
  m.position.set(px, 0, pz);
  m.rotation.y = Math.random() * Math.PI * 2;
  scene.add(m);
  items.push({ mesh: m, type, stash, id: uidCounter++, dyn: initDone, x: px, z: pz });
}
for (let i = 0; i < 10; i++) { spawnItem('food'); spawnItem('water'); }
for (let i = 0; i < 5; i++) spawnItem('medkit');
for (let i = 0; i < 8; i++) spawnItem('fuel'); // канистры с бензином

// Лут внутри каждого дома
for (const h of housePositions) {
  spawnItem('medkit', h.x - 2, h.z - 2);
  spawnItem('food', h.x + 2, h.z - 2);
  spawnItem('water', h.x, h.z - 2.5);
  spawnAmmoBox(h.x + 2, h.z + 1);
  spawnPile('scrap', h.x - 2.5, h.z + 1);
  spawnPile('scrap', h.x + 2.5, h.z - 1);
  spawnPile('wood', h.x + 6, h.z + 5); // дрова у входа
  spawnPile('rubber', h.x - 6, h.z + 5); // покрышки
  spawnItem('fuel', h.x - 2.8, h.z + 2.6);
}

// Военные ящики: по одному в первых трёх домах и ещё три снаружи
housePositions.slice(0, 3).forEach(h => spawnCase(h.x, h.z - 3.3, 0));
for (let i = 0; i < 3; i++) spawnCase();
stockWarehouses();

// HUD
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:10px;left:86px;color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;white-space:pre';
document.body.appendChild(hud);
const avatar = document.createElement('img'); // аватарка игрока
avatar.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAC6klEQVR42u1bS2sTURS+88yjKfYhNIWIdWFRFxW0Cv4AF4LVhShYQUFcuPHXCCKUags+8I26d+mmPjaupIJUpSkptmrSzGQyc11/59ZOEwcR8t3dl3tz7vDlnO+ec+7EKlfKWvXwsFWPD3eryV0lH9nS6Cxa/R/OY1sW4EQhXqq36AEkgASQgM5F0BEilyt6HW/wL2RStxPAURTTA0gACchAA/z+PODxqQlkT2iCTsyIt8RnVopGWNt46LbAy59XAK8vfMUF9YgeQAJIQBcasFfEfH4ANcFr4nmrNwngKO91HuQpiUQhRBUojY0A/jU6DPjTzGt6AAkgAV1ogF3A+HUDjL2Tt9+mxveLS4cAh0ITnATz+NjG3yQXmGf41Nw7tOHixo/OTdADSAAJIAF/L4JadIEt0X1NK2y6TXTSRmoulWh6AAkgAVkkQiKWAh/5ei6SHNsx+UxyrthQxKfn4LzQnaTgGzblvvKGqtVBxcUQIAHUgD+PuI0Nj++r64CHR4dwfWyev/HPDSxcHIz5RBRDtiiGZC6ilFKeaMbWltcAD+zooweQABKQRR4gzvVyZSc2Nxr45sWruQXDhmPjFkEYAC4WC4Dr9SbgwaF+w+aRU/vxucqDmAeEbXoACSABGWiAEc8eLm/rEOctx/jOtcvTgGfmHwO+cvGMmH8C+OqFs4bN2afPAE+e3idyDZseQAJIAAnIQARFE1THWBz5kbjV0WYCcv3WvS0ToRvz9zERauD8zTsPDJtHT4wDzoumSdiM6AEkgARkoAGJvBgRxc/uh+8BHz9/2LDRKoimKMqGimVDxMf11o+mYXPPyw+AV6Yn0abixQgJIAFZaED12yrgsRFsgiqhEaVN6AxLORn0MtlAk+JtD9dYr5TbwHM+jjD/qNbW6AEkgARkoAGBOIMXWzXAXw7iG5oH7r4xbHw8VsG8QFyWyrfJtYMa4DfN+qIvwZpkabEKeMOiB5AAEkACtjcs/nu8x8dvuWTToXhbGWMAAAAASUVORK5CYII=';
avatar.style.cssText = 'position:fixed;top:10px;left:10px;width:64px;height:64px;image-rendering:pixelated;border:2px solid #5a6b45;border-radius:8px;background:#181c18';
document.body.appendChild(avatar);
const hotbar = document.createElement('div');
hotbar.style.cssText = 'position:fixed;bottom:15px;left:50%;transform:translateX(-50%);color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;background:rgba(0,0,0,0.4);padding:8px 16px;border-radius:6px;white-space:normal;max-width:94vw;text-align:center';
document.body.appendChild(hotbar);
let lastHot = '';
const cross = document.createElement('div');
cross.textContent = '+';
cross.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font:24px monospace';
document.body.appendChild(cross);

// --- Костёр: камни, поленья, угли, живое пламя, искры и дым ---
function makeCampfire() {
  const g = new THREE.Group();
  const flat = (c, r) => new THREE.MeshStandardMaterial({ color: c, roughness: r === undefined ? 1 : r, flatShading: true });
  for (let i = 0; i < 9; i++) { // кольцо камней
    const a = i / 9 * Math.PI * 2, sz = 0.14 + Math.random() * 0.1;
    const st = new THREE.Mesh(new THREE.DodecahedronGeometry(sz, 0), flat(0x6e6e6a + Math.floor(Math.random() * 3) * 0x0a0a0a));
    st.position.set(Math.cos(a) * 0.45, sz * 0.6, Math.sin(a) * 0.45);
    st.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3); st.scale.y = 0.75;
    g.add(st);
  }
  const ash = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.38, 0.05, 10), flat(0x24201c)); ash.position.y = 0.025; g.add(ash);
  const coalMat = new THREE.MeshBasicMaterial({ color: 0xff5a1a });
  const coals = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.04, 8), coalMat); coals.position.y = 0.06; g.add(coals);
  for (let i = 0; i < 4; i++) { // поленья шалашиком
    const pivot = new THREE.Object3D(); pivot.rotation.y = i * Math.PI / 2 + 0.4; g.add(pivot);
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.62, 7), flat(i % 2 ? 0x4a2f18 : 0x3a2412));
    log.position.set(0.3, 0.14, 0); log.rotation.z = 1.1; pivot.add(log);
  }
  const fire = [], smoke = [], sparks = [];
  const part = (mat, list, life) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); g.add(m);
    list.push({ m, mat, life, age: Math.random() * life, vx: 0, vy: 0, vz: 0, x0: 0, z0: 0, size: 0.2 });
  };
  for (let i = 0; i < 12; i++) part(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), fire, 0.55 + Math.random() * 0.4);
  for (let i = 0; i < 7; i++) part(new THREE.MeshBasicMaterial({ color: 0x555555, transparent: true, depthWrite: false }), smoke, 2 + Math.random());
  for (let i = 0; i < 6; i++) part(new THREE.MeshBasicMaterial({ color: 0xffcc55, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), sparks, 0.8 + Math.random() * 0.8);
  let tt = 0;
  g.userData.update = dt => {
    tt += dt;
    coalMat.color.setRGB(1, 0.25 + 0.15 * Math.sin(tt * 9) + Math.random() * 0.05, 0.05);
    for (const p of fire) {
      p.age += dt;
      if (p.age >= p.life) { p.age = 0; p.x0 = (Math.random() - 0.5) * 0.28; p.z0 = (Math.random() - 0.5) * 0.28; p.vx = -p.x0 * 0.5; p.vz = -p.z0 * 0.5; p.vy = 0.7 + Math.random() * 0.5; p.size = 0.13 + Math.random() * 0.1; }
      const t = p.age / p.life, sz = p.size * (1 - t * 0.85) + 0.02;
      p.m.position.set(p.x0 + p.vx * p.age, 0.12 + p.vy * p.age, p.z0 + p.vz * p.age);
      p.m.scale.set(sz, sz * 1.7, sz); p.m.rotation.y += dt * 3;
      p.mat.color.setRGB(1, 0.85 - t * 0.65, 0.3 - t * 0.25);
      p.mat.opacity = (1 - t) * 0.9;
    }
    for (const p of smoke) {
      p.age += dt;
      if (p.age >= p.life) { p.age = 0; p.x0 = (Math.random() - 0.5) * 0.2; p.z0 = (Math.random() - 0.5) * 0.2; p.vx = (Math.random() - 0.3) * 0.25; p.vz = (Math.random() - 0.5) * 0.15; p.vy = 0.5 + Math.random() * 0.3; }
      const t = p.age / p.life, sz = 0.12 + t * 0.5;
      p.m.position.set(p.x0 + p.vx * p.age, 0.6 + p.vy * p.age, p.z0 + p.vz * p.age);
      p.m.scale.set(sz, sz, sz); p.m.rotation.y += dt;
      p.mat.opacity = 0.28 * (1 - t) * Math.min(1, t * 8);
    }
    for (const p of sparks) {
      p.age += dt;
      if (p.age >= p.life) { p.age = 0; p.x0 = (Math.random() - 0.5) * 0.2; p.z0 = (Math.random() - 0.5) * 0.2; p.vx = (Math.random() - 0.5) * 0.8; p.vz = (Math.random() - 0.5) * 0.8; p.vy = 1 + Math.random() * 1.2; }
      const t = p.age / p.life;
      p.m.position.set(p.x0 + p.vx * p.age, 0.3 + p.vy * p.age - 0.5 * 1.2 * p.age * p.age, p.z0 + p.vz * p.age);
      p.m.scale.set(0.03, 0.03, 0.03); p.mat.opacity = 1 - t;
    }
  };
  return g;
}

// --- Строительство и крафт ---
const notice = document.createElement('div');
notice.style.cssText = 'position:fixed;top:30%;left:50%;transform:translateX(-50%);color:#ffe9a0;font:22px monospace;text-shadow:1px 1px 3px #000';
document.body.appendChild(notice);
let noticeT = 0;
function notify(t) { notice.textContent = t; noticeT = 2; }

const pieces = {
  wall: { name: 'Стена', cost: 4, color: 0x8b6b3e },
  door: { name: 'Дверь', cost: 5, color: 0x8b6b3e },
  gate: { name: 'Ворота', cost: 8, color: 0x7a5c34 },
  roof: { name: 'Крыша/пол', cost: 3, color: 0x6b4f2e },
  stairs: { name: 'Лестница', cost: 8, color: 0x7a5c34 },
  fire: { name: 'Костёр', cost: 5, color: 0xff7a2a },
  bench: { name: 'Верстак', cost: 6, color: 0x8b6b3e },
  bed: { name: 'Кровать', cost: 6, color: 0x8b6b3e },
};
const pieceKeys = ['wall', 'door', 'gate', 'roof', 'stairs', 'fire', 'bench', 'bed'];
const floors = [];        // поверхности, по которым можно ходить: крыши-полы и ступени лестниц
let fallV = 0, sleeping = false;
const MAX_BENCHES = 2;
function surfaceAt(x, z, feet) { // на какой высоте стоять в этой точке
  let best = Math.max(terrainY(x, z), SWIM_Y); // в озере ноги не глубже SWIM_Y: игрок плывёт
  for (const f of floors) {
    if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
    if (f.y <= feet + 0.6 && f.y > best) best = f.y; // ступенька не выше 0,6 м
  }
  return best;
}
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
  const a = r % 2;
  if (type === 'wall' || type === 'door') return a === 0 ? [2, 3, 0.3, 1.5] : [0.3, 3, 2, 1.5];
  if (type === 'gate') return a === 0 ? [4, 2.7, 0.3, 1.35] : [0.3, 2.7, 4, 1.35];
  if (type === 'roof') return [2, 0.2, 2, 3.1];
  if (type === 'stairs') return a === 0 ? [1.8, 3.2, 4, 1.6] : [4, 3.2, 1.8, 1.6];
  if (type === 'bench') return a === 0 ? [1.6, 0.9, 0.7, 0.45] : [0.7, 0.9, 1.6, 0.45];
  if (type === 'bed') return a === 0 ? [1.0, 0.5, 2.0, 0.25] : [2.0, 0.5, 1.0, 0.25];
  return [0.8, 0.4, 0.8, 0.2];
}

// Привязка к сетке, чтобы детали стыковались
function targetPos() {
  const px = camera.position.x - Math.sin(yaw) * 4;
  const pz = camera.position.z - Math.cos(yaw) * 4;
  const a = rot % 2;
  if (selPiece === 'wall' || selPiece === 'door' || selPiece === 'stairs') {
    return a === 0
      ? [2 * Math.floor(px / 2) + 1, 2 * Math.round(pz / 2)]
      : [2 * Math.round(px / 2), 2 * Math.floor(pz / 2) + 1];
  }
  if (selPiece === 'gate') return [2 * Math.round(px / 2), 2 * Math.round(pz / 2)];
  if (selPiece === 'roof') return [2 * Math.floor(px / 2) + 1, 2 * Math.floor(pz / 2) + 1];
  return [Math.round(px * 2) / 2, Math.round(pz * 2) / 2];
}

function aabbSeg(x, z, a, lo, hi, thick) { // отрезок стены вдоль её оси
  return a === 0
    ? { minX: x + lo, maxX: x + hi, minZ: z - thick / 2, maxZ: z + thick / 2 }
    : { minX: x - thick / 2, maxX: x + thick / 2, minZ: z + lo, maxZ: z + hi };
}

function placePieceAt(type, rotv, x, z, free) {
  if (health <= 0) return null;
  if (!free && (Math.abs(x) > FLAT_HALF - 2 || Math.abs(z) > FLAT_HALF - 2)) return notify('На холмах строить нельзя');
  const p = pieces[type];
  const [w, h, d, y] = pieceGeometry(type, rotv);
  const a = rotv % 2;
  const usesRot = ['wall', 'door', 'gate', 'bench', 'bed'].includes(type);
  const key = `${type}:${type === 'stairs' ? rotv : usesRot ? a : 0}:${x}:${z}`;
  if (built.some(b => b.key === key)) return notify('Тут уже занято');
  if (!free && !adm('freeBuild') && countOf('wood') < p.cost) return notify(`Нужно дерева: ${p.cost}`);
  if (!free && type === 'fire' && built.filter(b => b.type === 'fire').length >= MAX_FIRES) return notify('Костров не больше 4');
  if (!free && type === 'bench' && built.filter(b => b.type === 'bench').length >= MAX_BENCHES) return notify('Верстаков не больше 2');
  if (!free && !adm('freeBuild')) takeItem('wood', p.cost);

  const invisible = ['fire', 'bench', 'door', 'gate', 'bed', 'stairs'].includes(type); // у них своя модель, а коробка нужна для прицела (V)
  const mat = invisible
    ? new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    : new THREE.MeshStandardMaterial({ color: p.color });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  scene.add(mesh);

  const b = { key, type: type, mesh, collider: null, light: null, colliders: [], open: false, ang: 0, px: x, pz: z, prot: rotv };
  const addCol = (c, top) => { c.top = top; colliders.push(c); b.colliders.push(c); return c; };
  if (type === 'wall') {
    b.collider = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top: 3.0 };
    colliders.push(b.collider);
    blockers.push(mesh);
  }
  if (type === 'roof') { // крышу можно использовать как пол второго этажа
    blockers.push(mesh);
    b.floor = { minX: x - 1, maxX: x + 1, minZ: z - 1, maxZ: z + 1, y: 3.2 };
    floors.push(b.floor);
  }
  if (type === 'fire') {
    b.vis = makeCampfire(); b.vis.position.set(x, 0, z); scene.add(b.vis);
    b.light = new THREE.PointLight(0xff8a3a, 8, 20, 1);
    b.light.position.set(x, 1, z);
    scene.add(b.light);
  }
  if (type === 'bench') {
    b.collider = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
    colliders.push(b.collider);
    blockers.push(mesh);
    b.vis = makeWorkbench(); b.vis.position.set(x, 0, z); b.vis.rotation.y = a === 0 ? 0 : Math.PI / 2; scene.add(b.vis);
  }
  if (type === 'door') {
    b.vis = makeDoor(); b.vis.position.set(x, 0, z); b.vis.rotation.y = a === 0 ? 0 : Math.PI / 2; scene.add(b.vis);
    b.leaf = b.vis.userData.leaf;
    addCol(aabbSeg(x, z, a, -1, -0.55, 0.3), 3.0); addCol(aabbSeg(x, z, a, 0.55, 1, 0.3), 3.0);
    b.doorCol = addCol(aabbSeg(x, z, a, -0.55, 0.55, 0.3), 2.4);
    blockers.push(mesh);
  }
  if (type === 'gate') {
    b.vis = makeGate(); b.vis.position.set(x, 0, z); b.vis.rotation.y = a === 0 ? 0 : Math.PI / 2; scene.add(b.vis);
    b.leaves = b.vis.userData.leaves;
    addCol(aabbSeg(x, z, a, -2, -1.7, 0.3), 2.8); addCol(aabbSeg(x, z, a, 1.7, 2, 0.3), 2.8);
    b.doorCol = addCol(aabbSeg(x, z, a, -1.7, 1.7, 0.3), 2.6);
    blockers.push(mesh);
  }
  if (type === 'bed') {
    b.collider = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top: 0.55 };
    colliders.push(b.collider);
    b.vis = makeBed(); b.vis.position.set(x, 0, z); b.vis.rotation.y = a === 0 ? 0 : Math.PI / 2; scene.add(b.vis);
  }
  if (type === 'stairs') { // 16 ступеней по 0,2 м: по ним можно подняться на крышу-пол
    b.vis = makeStairs(); b.vis.position.set(x, 0, z); b.vis.rotation.y = -rotv * Math.PI / 2; scene.add(b.vis);
    const th = -rotv * Math.PI / 2, cs = Math.round(Math.cos(th)), sn = Math.round(Math.sin(th));
    b.floorEntries = [];
    for (let i = 0; i < 16; i++) {
      const lz = 2 - 0.125 - i * 0.25;
      const wx = x + lz * sn, wz = z + lz * cs;
      const hx = a === 0 ? 0.9 : 0.125, hz = a === 0 ? 0.125 : 0.9, top = (i + 1) * 0.2;
      const box2 = { minX: wx - hx, maxX: wx + hx, minZ: wz - hz, maxZ: wz + hz };
      addCol(Object.assign({}, box2), top);
      const fl = Object.assign({ y: top }, box2); floors.push(fl); b.floorEntries.push(fl);
    }
  }
  built.push(b);
  builtMeshes.push(mesh);
  return b;
}

function placePiece() { // ставит деталь перед игроком
  const [x, z] = targetPos();
  return placePieceAt(selPiece, rot, x, z, false);
}

// Модели новых деталей
function makeDoor() { // дверь на петлях: рама и полотно
  const g = new THREE.Group();
  const wood = std(0x8b6b3e, 0.9), woodD = std(0x5e4528, 0.95), iron = std(0x2f3236, 0.5, 0.7);
  const add = (w2, h2, d2, m, x2, y2, z2, parent) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2), m); o.position.set(x2, y2, z2); (parent || g).add(o); return o; };
  add(0.45, 3, 0.3, wood, -0.775, 1.5, 0); add(0.45, 3, 0.3, wood, 0.775, 1.5, 0);
  add(1.1, 0.8, 0.3, wood, 0, 2.6, 0);
  add(1.2, 0.06, 0.34, woodD, 0, 0.03, 0);
  const pivot = new THREE.Group(); pivot.position.set(-0.55, 0, 0); g.add(pivot);
  add(1.06, 2.2, 0.08, std(0x7a5c34), 0.55, 1.1, 0, pivot);
  [0.4, 1.1, 1.8].forEach(y2 => add(1.0, 0.1, 0.1, woodD, 0.55, y2, 0.05, pivot));
  add(0.06, 0.06, 0.12, iron, 1.0, 1.05, 0.06, pivot);
  [0.4, 1.8].forEach(y2 => add(0.12, 0.08, 0.12, iron, 0.04, y2, 0.02, pivot));
  g.userData.leaf = pivot;
  return g;
}
function makeGate() { // двустворчатые ворота
  const g = new THREE.Group();
  const wood = std(0x7a5c34, 0.9), woodD = std(0x4e3825, 0.95), iron = std(0x2f3236, 0.5, 0.7);
  const add = (w2, h2, d2, m, x2, y2, z2, parent, rz) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2), m); o.position.set(x2, y2, z2); if (rz) o.rotation.z = rz; (parent || g).add(o); return o; };
  add(0.3, 2.8, 0.3, woodD, -1.85, 1.4, 0); add(0.3, 2.8, 0.3, woodD, 1.85, 1.4, 0);
  add(4, 0.2, 0.22, woodD, 0, 2.7, 0);
  const leaves = [];
  [-1, 1].forEach(s => {
    const pivot = new THREE.Group(); pivot.position.set(s * 1.7, 0, 0); g.add(pivot);
    const cx = -s * 0.85;
    add(1.7, 2.4, 0.08, wood, cx, 1.25, 0, pivot);
    [0.35, 1.2, 2.05].forEach(y2 => add(1.7, 0.12, 0.1, woodD, cx, y2, 0.06, pivot));
    add(2.1, 0.1, 0.1, woodD, cx, 1.25, 0.07, pivot, s * 0.7);
    add(0.1, 0.4, 0.12, iron, -s * 1.6, 1.25, 0.08, pivot);
    leaves.push(pivot);
  });
  g.userData.leaves = leaves;
  return g;
}
function makeBed() { // кровать: рама, матрас, подушка, одеяло
  const g = new THREE.Group();
  const wood = std(0x6b4f2e, 0.9), mat = std(0xd8d4c8, 1), pillow = std(0xf0eee6, 1), blanket = std(0x4a5a3a, 1), stripe = std(0x7a8a5a, 1);
  const add = (w2, h2, d2, m, x2, y2, z2) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2), m); o.position.set(x2, y2, z2); g.add(o); return o; };
  [-1, 1].forEach(sx => [-1, 1].forEach(sz => add(0.08, 0.28, 0.08, wood, sx * 0.46, 0.14, sz * 0.96)));
  add(1.0, 0.1, 2.0, wood, 0, 0.3, 0);
  add(1.0, 0.55, 0.08, wood, 0, 0.58, -1.0); add(1.0, 0.3, 0.07, wood, 0, 0.45, 1.0);
  add(0.9, 0.16, 1.86, mat, 0, 0.43, 0);
  add(0.6, 0.1, 0.32, pillow, 0, 0.56, -0.72);
  add(0.92, 0.06, 1.1, blanket, 0, 0.54, 0.36);
  add(0.92, 0.065, 0.1, stripe, 0, 0.54, 0.0);
  return g;
}
function makeStairs() { // 16 ступеней, подъём к -Z, перила
  const g = new THREE.Group();
  const wood = std(0x7a5c34, 0.9), woodD = std(0x5e4528, 0.95);
  for (let i = 0; i < 16; i++) {
    const top = (i + 1) * 0.2;
    const st = new THREE.Mesh(new THREE.BoxGeometry(1.8, top, 0.25), i % 2 ? wood : std(0x84643a, 0.9));
    st.position.set(0, top / 2, 2 - 0.125 - i * 0.25); g.add(st);
  }
  [-1, 1].forEach(sx => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 5.12), woodD);
    rail.position.set(sx * 0.9, 2.5, 0); rail.rotation.x = 0.675; g.add(rail);
    [-1.9, 0, 1.9].forEach(zz => { const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.06), woodD); post.position.set(sx * 0.9, (1.6 - zz * 0.8) + 0.5, zz); g.add(post); });
  });
  return g;
}

// Дверь и ворота открываются на E; кровать - сон ночью
function toggleDoor(b) {
  b.open = !b.open;
  const i = colliders.indexOf(b.doorCol);
  if (b.open) { if (i >= 0) colliders.splice(i, 1); } else if (i < 0) colliders.push(b.doorCol);
}
function sleepInBed(b) {
  if (sleeping) return;
  if (net.active) return notify('В мультиплеере спать нельзя');
  const night = gameHour >= 19.5 || gameHour < 5.5;
  if (!night && !admin.on) return notify('Не хочется спать. Спать можно с 19:30 до 05:30');
  if (zombies.some(z => Math.hypot(z.mesh.position.x - camera.position.x, z.mesh.position.z - camera.position.z) < 25)) return notify('Рядом зомби: уснуть не получится');
  sleeping = true;
  fadeEl.style.transition = 'opacity 0.9s'; fadeEl.style.opacity = '1';
  setTimeout(() => {
    if (gameHour >= 19.5) day++;
    gameHour = 7; health = Math.min(100, health + 50); hunger = Math.max(0, hunger - 15); thirst = Math.max(0, thirst - 20);
    fadeEl.style.opacity = '0';
    setTimeout(() => {
      sleeping = false;
      if (currentSlot) { saveGame(currentSlot, true); notify('Ты выспался: утро, 07:00. Здоровье +50. Сохранение обновлено'); }
      else notify('Ты выспался: утро, 07:00. Здоровье +50');
    }, 900);
  }, 1300);
}

function makeWorkbench() { // верстак: столешница, тиски, инструменты, доска с инструментами, запчасти
  const g = new THREE.Group();
  const mat = (c, r, m) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, flatShading: true });
  const wood = mat(0x8b6b3e, 0.9, 0), wood2 = mat(0x7a5c34, 0.9, 0), woodD = mat(0x5e4528, 0.95, 0);
  const iron = mat(0x4a4f55, 0.45, 0.7), steel = mat(0x9aa0a8, 0.35, 0.8);
  const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const add = (geo, m, x, y, z, rx, ry, rz) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(rx || 0, ry || 0, rz || 0); g.add(o); return o; };
  for (let i = 0; i < 5; i++) add(B(1.6, 0.07, 0.136), i % 2 ? wood : wood2, 0, 0.865, -0.28 + i * 0.14);   // доски столешницы
  [-1, 1].forEach(sx => [-1, 1].forEach(sz => add(B(0.09, 0.83, 0.09), woodD, sx * 0.72, 0.415, sz * 0.27))); // ножки
  add(B(1.5, 0.045, 0.56), woodD, 0, 0.28, 0);                                                                 // нижняя полка
  add(B(1.5, 0.06, 0.05), woodD, 0, 0.7, 0.3); add(B(1.5, 0.06, 0.05), woodD, 0, 0.7, -0.3);                  // царги
  add(B(0.16, 0.12, 0.18), iron, 0.62, 0.96, 0.3); add(B(0.04, 0.1, 0.12), steel, 0.62, 1.02, 0.43);          // тиски
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 6), steel, 0.62, 0.96, 0.52, Math.PI / 2, 0, 0);
  add(B(0.12, 0.025, 0.025), steel, 0.62, 0.96, 0.63);
  add(B(0.03, 0.03, 0.3), woodD, -0.5, 0.92, -0.05, 0, 0.4, 0); add(B(0.12, 0.06, 0.05), iron, -0.54, 0.95, -0.17, 0, 0.4, 0); // молоток
  add(B(0.4, 0.06, 0.012), steel, -0.1, 0.915, 0.15, 0, -0.15, 0); add(B(0.12, 0.06, 0.04), woodD, -0.28, 0.935, 0.1, 0, -0.15, 0); // пила
  add(B(0.08, 0.75, 0.05), woodD, -0.7, 1.22, -0.3); add(B(0.08, 0.75, 0.05), woodD, 0.7, 1.22, -0.3);        // стойки
  add(B(1.48, 0.06, 0.05), woodD, 0, 1.6, -0.3);
  add(B(1.4, 0.45, 0.03), mat(0x6b4f2e, 0.95, 0), 0, 1.25, -0.31);                                             // доска для инструментов
  [-0.5, -0.2, 0.1, 0.4].forEach((x, i) => add(B(0.04, 0.2 + (i % 2) * 0.08, 0.03), i % 2 ? steel : iron, x, 1.2, -0.28));
  add(B(0.4, 0.2, 0.3), mat(0x4a5230, 0.85, 0.1), -0.4, 0.4, 0);                                               // ящик с запчастями
  add(new THREE.TorusGeometry(0.17, 0.05, 6, 12), mat(0x151515, 1, 0), 0.35, 0.34, 0);                         // покрышка на полке
  return g;
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
  if (b.vis) scene.remove(b.vis);
  if (b.collider) removeFrom(colliders, b.collider);
  if (b.colliders) b.colliders.forEach(c => { const ci = colliders.indexOf(c); if (ci >= 0) colliders.splice(ci, 1); });
  if (b.floor) removeFrom(floors, b.floor);
  if (b.floorEntries) b.floorEntries.forEach(f => { const fi = floors.indexOf(f); if (fi >= 0) floors.splice(fi, 1); });
  const bi = blockers.indexOf(b.mesh);
  if (bi >= 0) blockers.splice(bi, 1);
  removeFrom(builtMeshes, b.mesh);
  built.splice(i, 1);
  addItem('wood', Math.floor(pieces[b.type].cost / 2));
}

// Рубка дерева (E)
function chop(quiet) {
  if (health <= 0 || chopCd > 0) return;
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hit = raycaster.intersectObjects(trees.map(t => t.trunk), false)[0];
  if (!hit || hit.distance > 3.5) { if (!quiet) notify('Подойди ближе и смотри на ствол дерева'); return; }
  chopCd = 0.4;
  const ti = trees.findIndex(t => t.trunk === hit.object);
  const t = trees[ti];
  if (adm('fastChop')) t.hp = 1;
  t.hp--;
  if (t.hp > 0) notify('Рублю... осталось ударов: ' + t.hp);
  if (t.hp <= 0) {
    scene.remove(t.trunk);
    scene.remove(t.crown);
    removeFrom(colliders, t.collider);
    removeFrom(blockers, t.trunk);
    trees.splice(ti, 1);
    const n = 2 + Math.floor(Math.random() * 4); // выпадает от 2 до 5 брёвен
    spawnPile('wood', t.trunk.position.x, t.trunk.position.z, n);
    notify(`Дерево срублено, выпало брёвен: ${n} (E - взять)`);
  }
}

// Крафт из лома
function craft(type) {
  if (health <= 0) return;
  if (adm('freeCraft')) {
    if (type === 'ammo') { reserve += 7; return notify('Сделано (админ): +7 патронов'); }
    if (type === 'axe') { hasAxe = true; weapon = 'axe'; drawT = 0; return notify('Топор выдан (админ)'); }
    if (type === 'medkit') { addItem('medkit', 1); return notify('Сделано (админ): +1 аптечка'); }
  }
  if (type === 'ammo') {
    if (countOf('scrap') < 2) return notify('Нужно 2 лома');
    takeItem('scrap', 2); reserve += 7; notify('Сделано: +7 патронов');
  }
  if (type === 'axe') {
    if (hasAxe) return notify('Топор уже есть');
    if (countOf('wood') < 3 || countOf('scrap') < 2) return notify('Нужно 3 дерева и 2 лома');
    takeItem('wood', 3); takeItem('scrap', 2);
    hasAxe = true; weapon = 'axe'; drawT = 0; notify('Сделан топор! Рубить: ЛКМ у дерева. [Q] - сменить оружие');
  }
  if (type === 'medkit') {
    if (countOf('scrap') < 4) return notify('Нужно 4 лома');
    if (freeRoom('medkit') < 1) return notify('Инвентарь полон');
    takeItem('scrap', 4); addItem('medkit', 1); notify('Сделано: +1 аптечка');
  }
}

// --- Верстак: детали мотоцикла и сборка ---
const BENCH_RECIPES = [
  { id: 'wheel', name: 'Колесо', need: { rubber: 2, scrap: 3 }, give: 'wheel' },
  { id: 'tank', name: 'Бензобак', need: { scrap: 6 }, give: 'tank' },
  { id: 'bars', name: 'Руль', need: { scrap: 3, rubber: 1 }, give: 'bars' },
  { id: 'bike', name: 'Мотоцикл (сборка)', need: { tank: 1, wheel: 2, bars: 1, scrap: 8, wood: 2 }, give: null },
];
function nearBench() {
  return built.some(b => b.type === 'bench' && Math.hypot(b.mesh.position.x - camera.position.x, b.mesh.position.z - camera.position.z) < 4.5);
}
function benchCraft(id) {
  const r = BENCH_RECIPES.find(x => x.id === id);
  if (!r || health <= 0) return;
  if (!nearBench() && !adm('freeCraft')) return notify('Подойди к верстаку');
  if (!adm('freeCraft')) for (const k in r.need) if (countOf(k) < r.need[k]) return notify('Не хватает: ' + ITEMS[k].name);
  if (id === 'bike') {
    if (bike) return notify('Мотоцикл уже собран');
    if (!adm('freeCraft')) for (const k in r.need) takeItem(k, r.need[k]);
    const sp = { x: camera.position.x - Math.sin(yaw) * 2.6, z: camera.position.z - Math.cos(yaw) * 2.6 };
    resolveCollisions(sp, 0.9);
    spawnBike(sp.x, sp.z, yaw);
    toggleMenu(false);
    return notify('Мотоцикл собран! Подойди, смотри на него и нажми E');
  }
  if (freeRoom(r.give) < 1) return notify('Инвентарь полон');
  if (!adm('freeCraft')) for (const k in r.need) takeItem(k, r.need[k]);
  addItem(r.give, 1);
  notify('Сделано: ' + r.name);
}

// Обновление каждый кадр: призрак, костры, подсказки
function updateBuild(dt) {
  noticeT -= dt;
  if (noticeT <= 0) notice.textContent = '';
  chopCd -= dt;
  gun.visible = !buildMode && !riding && weapon === 'pistol';
  sgun.visible = !buildMode && !riding && weapon === 'shotgun';
  axeRig.visible = !buildMode && !riding && weapon === 'axe';
  akRig.visible = !buildMode && !riding && weapon === 'ak';
  ghost.visible = buildMode && health > 0;
  if (ghost.visible) {
    const [x, z] = targetPos();
    const [w, h, d, y] = pieceGeometry(selPiece, rot);
    ghost.scale.set(w, h, d);
    ghost.position.set(x, y, z);
    ghost.material.color.set(adm('freeBuild') || countOf('wood') >= pieces[selPiece].cost ? 0x44ff44 : 0xff4444);
  }
  for (const b of built) { // створки дверей и ворот плавно открываются
    if (b.type !== 'door' && b.type !== 'gate') continue;
    b.ang += ((b.open ? 1 : 0) - b.ang) * Math.min(1, 9 * dt);
    if (b.type === 'door') b.leaf.rotation.y = b.ang * 1.6;
    else { b.leaves[0].rotation.y = b.ang * 1.5; b.leaves[1].rotation.y = -b.ang * 1.5; }
  }
  for (const b of built) {
    if (b.type !== 'fire') continue;
    b.vis.userData.update(dt);
    b.light.intensity = 7 + Math.sin(gunT * 13 + b.mesh.position.x) * 1.2 + Math.random() * 1.5; // мерцание
    b.light.position.y = 0.9 + Math.random() * 0.25;
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
  if (menuTab === 'bed') { renderBedMenu(); return; }
  const tabs = [['inv', 'Инвентарь'], ['craft', 'Крафт'], ['bench', 'Верстак'], ['build', 'Стройка'], ['settings', '⚙ Настройки']];
  if (admin.on) tabs.push(['admin', '🛠 Админ']);
  if (!gameStarted) { tabs.length = 0; tabs.push(['settings', '⚙ Настройки']); } // из главного меню доступны только настройки
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
    body += `<div style="opacity:.85">Пистолет: ${ammo} в обойме, ${reserve} в запасе` + (hasShotgun ? `<br>Дробовик: ${sgAmmo} в магазине, ${sgReserve} в запасе` : '') + (hasAK ? `<br>АК-47: ${akAmmo} в магазине, ${akReserve} в запасе` : '') + `</div>`;
  }
  if (menuTab === 'craft') {
    body += row('Патроны x7 <small>(2 лома)</small>', btn('Создать', 'craft:ammo', countOf('scrap') >= 2));
    body += row('Топор <small>(3 дерева + 2 лома)</small>', hasAxe ? '<span style="opacity:.7">есть</span>' : btn('Создать', 'craft:axe', countOf('wood') >= 3 && countOf('scrap') >= 2));
    body += row('Аптечка <small>(4 лома)</small>', btn('Создать', 'craft:medkit', countOf('scrap') >= 4));
    body += `<div style="margin-top:12px;opacity:.8">У тебя: лом x${countOf('scrap')}. Лом лежит на земле и в домах.</div>`;
  }
  if (menuTab === 'bench') {
    const near = nearBench() || adm('freeCraft');
    body += near ? '<div style="margin-bottom:8px;color:#9fd36a">Ты у верстака</div>'
      : '<div style="margin-bottom:8px;color:#e07a6a">Подойди к верстаку. Построить: B, затем 4 (Верстак, 6 дерева)</div>';
    for (const r of BENCH_RECIPES) {
      const req = Object.keys(r.need).map(k => `<span style="color:${countOf(k) >= r.need[k] ? '#9fd36a' : '#e07a6a'}">${ITEMS[k].name} ${countOf(k)}/${r.need[k]}</span>`).join(' · ');
      const done = r.id === 'bike' && bike;
      const can = near && !done && (adm('freeCraft') || Object.keys(r.need).every(k => countOf(k) >= r.need[k]));
      body += row(`${r.name}<br><small>${req}</small>`, done ? '<span style="opacity:.7">собран</span>' : btn('Создать', 'bench:' + r.id, can));
    }
    body += `<div style="margin-top:12px;opacity:.8;font-size:14px">Резина: кучи старых покрышек (E). Лом: железные кучи. Бензин: канистры, заправка - слот 1-5 рядом с мотоциклом.</div>`;
  }
  if (menuTab === 'settings') {
    const sl = (k, label, min, max, step) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid #3a4530"><span>${label}: <b id="v-${k}">${SET_FMT[k](SETTINGS[k])}</b></span><input type="range" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${SETTINGS[k]}" style="width:240px;max-width:50%"></div>`;
    body += row('Тени', btn(SETTINGS.shadows ? 'Включены' : 'Выключены', 'tog:shadows'));
    body += sl('fov', 'Поле зрения', 60, 100, 1) + sl('sens', 'Чувствительность мыши', 0.3, 2.5, 0.05) + sl('exposure', 'Яркость', 0.6, 1.8, 0.05);
    body += sl('volume', 'Громкость', 0, 1, 0.05) + sl('fog', 'Дальность видимости', 0.6, 1.6, 0.05) + sl('res', 'Разрешение картинки', 0.5, 2, 0.25);
    body += row('Окно', btn('Полный экран', 'fs') + btn('Сбросить настройки', 'resetset'));
    body += row('Игра', btn('Выйти из игры', 'quit'));
    body += gameStarted ? row('Главное меню', btn('Выйти в главное меню', 'tomenu')) : row('Меню', btn('Назад', 'mmback'));
    if (admin.on) body += row('Админ-панель', btn('Открыть', 'admopen') + btn('Выйти из админки', 'admlogout'));
    else {
      body += row('Админ-панель', `<input id="admpass" type="password" placeholder="пароль" autocomplete="off" style="font:inherit;padding:6px 8px;width:120px;background:#111;color:#fff;border:2px solid #5a6b45;border-radius:6px"> ` + btn('Войти', 'admlogin'));
      if (adminMsg) body += `<div style="color:#e07a6a;font-size:14px">${adminMsg}</div>`;
    }
    body += `<div style="margin-top:10px;opacity:.7;font-size:14px">Настройки сохраняются сами. Esc открывает это меню (игра на паузе).</div>`;
  }
  if (menuTab === 'admin' && admin.on) {
    const sec = t => `<div style="margin:14px 0 6px;color:#c8e07a;font-weight:bold">${t}</div>`;
    const wrap = html => `<div style="display:flex;flex-wrap:wrap;gap:2px">${html}</div>`;
    const sl = (k, label, min, max, step, val) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:5px 0;border-bottom:1px solid #3a4530"><span>${label}: <b id="va-${k}">${ADM_FMT[k](val)}</b></span><input type="range" data-adm="${k}" min="${min}" max="${max}" step="${step}" value="${val}" style="width:240px;max-width:50%"></div>`;
    body += sec('Режимы') + wrap(Object.keys(ADM_LABELS).map(k => btn(ADM_LABELS[k] + ': ' + (admin[k] ? 'ВКЛ' : 'выкл'), 'admtog:' + k, true, admin[k])).join(''));
    body += `<div style="opacity:.7;font-size:13px;margin-top:4px">Полёт: W/A/S/D по взгляду, Пробел вверх, C вниз, Shift быстрее. Сквозь стены: проходишь любые препятствия.</div>`;
    body += sl('speedMul', 'Скорость ходьбы', 1, 5, 0.25, admin.speedMul) + sl('flySpeed', 'Скорость полёта', 0.5, 10, 0.5, admin.flySpeed) + sl('hour', 'Время суток', 0, 24, 0.25, gameHour);
    body += sec('Выдать предметы') + Object.keys(ITEMS).map(t => row(`<img src="${ICONS[t]}" style="width:22px;height:22px;image-rendering:pixelated;vertical-align:middle"> ${ITEMS[t].name}`, btn('+1', `admgive:${t}:1`) + btn('+стак', `admgive:${t}:max`))).join('');
    body += sec('Оружие и патроны') + wrap(btn('Дробовик', 'admweapon:shotgun') + btn('Топор', 'admweapon:axe') + btn('АК-47', 'admweapon:ak') + btn('Всё оружие', 'admweapon:all') + btn('+50 патр. пистолета', 'admammo:pistol') + btn('+50 патр. дробовика', 'admammo:shotgun') + btn('+90 патр. АК', 'admammo:ak'));
    body += sec('Игрок') + wrap(btn('Вылечить и накормить', 'admheal') + btn('Очистить инвентарь', 'admclear'));
    body += sec('Транспорт') + wrap(btn('Мотоцикл рядом', 'admbike:spawn') + btn('Притянуть мотоцикл', 'admbike:come') + btn('Заправить', 'admbike:fuel') + btn('Убрать мотоцикл', 'admbike:remove') + btn('Джип рядом', 'admcar:spawn') + btn('Притянуть джип', 'admcar:come') + btn('Заправить джип', 'admcar:fuel') + btn('Убрать джип', 'admcar:remove'));
    body += sec('Зомби') + wrap(btn('Бегун', 'admzombie:t:runner') + btn('Громила', 'admzombie:t:brute') + btn('Вздутый', 'admzombie:t:bloater') + btn('Солдат', 'admzombie:t:soldier') + btn('+1', 'admzombie:1') + btn('+5', 'admzombie:5') + btn('+10', 'admzombie:10') + btn('Убить всех', 'admzombie:kill'));
    body += sec('Мир') + wrap(btn('Открыть все ящики', 'admworld:cases') + btn('Ящик рядом', 'admworld:case') + btn('Рассыпать ресурсы', 'admworld:resources') + btn('Верстак рядом', 'admworld:bench') + btn('Костёр рядом', 'admworld:fire'));
    body += sec('Время') + wrap(btn('Утро 06:00', 'admtime:6') + btn('День 12:00', 'admtime:12') + btn('Вечер 19:00', 'admtime:19') + btn('Ночь 00:00', 'admtime:0'));
    body += sec('Телепорт') + wrap(btn('На старт', 'admtp:home') + btn('Склад 1', 'admtp:w1') + btn('Склад 2', 'admtp:w2') + btn('Подвал 1', 'admtp:b1') + btn('Подвал 2', 'admtp:b2') + btn('Ближайший ящик', 'admtp:case') + btn('К мотоциклу', 'admtp:bike') + btn('Заправка', 'admtp:gs') + btn('Гараж', 'admtp:gar') + btn('Водокачка', 'admtp:wt') + btn('К джипу', 'admtp:car') + btn('Блокпост', 'admtp:op') + btn('Арсенал', 'admtp:ar'));
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
  if (!open) { pick = null; if (menuTab === 'bed') menuTab = 'inv'; }
  menuOpen = open;
  if (open && net.active) Object.keys(keys).forEach(k => { keys[k] = false; }); // мир идёт дальше, персонаж стоит
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

menu.addEventListener('input', e => { // ползунки настроек
  const ak = e.target.dataset && e.target.dataset.adm;
  if (ak) { // ползунки админки
    admin[ak] = parseFloat(e.target.value);
    if (ak === 'hour') gameHour = admin[ak];
    const alab = document.getElementById('va-' + ak);
    if (alab) alab.textContent = ADM_FMT[ak](admin[ak]);
    return;
  }
  const k = e.target.dataset && e.target.dataset.set;
  if (!k) return;
  SETTINGS[k] = parseFloat(e.target.value);
  const lab = document.getElementById('v-' + k);
  if (lab) lab.textContent = SET_FMT[k](SETTINGS[k]);
  applySettings(); saveSettings();
});
menu.addEventListener('keydown', e => { // Enter в поле пароля
  if (e.target && e.target.id === 'admpass' && e.key === 'Enter') { adminAction('admlogin'); renderMenu(); }
});
// Esc (или потеря курсора) ставит игру на паузу и открывает настройки
document.addEventListener('pointerlockchange', () => {
  if (gameStarted && !cutscenes.cut.active && !chatOpen && document.pointerLockElement !== renderer.domElement && !menuOpen && health > 0) { menuTab = 'settings'; toggleMenu(true); }
});
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
  const [act, arg, arg2] = t.dataset.act.split(':');
  if (act.startsWith('adm')) adminAction(act, arg, arg2);
  if (act === 'tab') menuTab = arg;
  if (act === 'use' && pick !== null) { useSlot(pick); if (!slots[pick]) pick = null; }
  if (act === 'drop' && pick !== null && slots[pick]) {
    if (arg === 'all') slots[pick] = null; else { slots[pick].n--; if (slots[pick].n <= 0) slots[pick] = null; }
    if (!slots[pick]) pick = null;
  }
  if (act === 'craft') craft(arg);
  if (act === 'bench') benchCraft(arg);
  if (act === 'tog') { SETTINGS[arg] = !SETTINGS[arg]; applySettings(); saveSettings(); }
  if (act === 'fs') { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch (err) { /* не поддерживается */ } }
  if (act === 'resetset') { Object.assign(SETTINGS, DEFAULT_SETTINGS); applySettings(); saveSettings(); }
  if (act === 'quit') window.close();
  if (act === 'save') { saveGame(+arg); renderMenu(); return; }
  if (act === 'sleep') { toggleMenu(false); if (bedMenuBed) sleepInBed(bedMenuBed); return; }
  if (act === 'closebed') { toggleMenu(false); return; }
  if (act === 'tomenu') { if (confirm('Выйти в главное меню? Несохранённый прогресс будет потерян.')) location.reload(); return; }
  if (act === 'mmback') { menuOpen = false; menu.style.display = 'none'; mainMenu.style.display = 'flex'; renderMainMenu('main'); return; }
  if (act === 'build') { selPiece = arg; buildMode = true; toggleMenu(false); return; }
  renderMenu();
});

// --- Сохранения и главное меню ---
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
function readSaves() { try { return JSON.parse(localStorage.getItem('dz_saves') || '{}'); } catch (e) { return {}; } }
const fmtH = h => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor((h % 1) * 60)).padStart(2, '0');
function slotInfo(d) {
  const when = new Date(d.time).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `День ${d.day}, ${fmtH(d.hour)} · здоровье ${Math.ceil(d.player.health)} · ${when}` + (d.v === 2 ? '' : ' · <span style="color:#e07a6a">старая версия</span>');
}
function makeSave() { // всё, что нужно, чтобы вернуть игру точно такой же
  const here = { items: new Set(items.map(i => i.id)), ammo: new Set(ammoBoxes.map(m => m.userData.id)), trees: new Set(trees.map(t => t.id)), piles: new Map(piles.map(p => [p.id, p])), cases: new Map(cases.map(c => [c.id, c])) };
  return {
    v: 2, seed: WORLD_SEED, time: Date.now(), day, hour: gameHour,
    player: { x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw, health, hunger, thirst, kills },
    inv: slots.map(sl => sl ? [sl.type, sl.n] : null),
    w: { weapon, hasShotgun, hasAxe, hasAK, ammo, reserve, lock, sgAmmo, sgReserve, akAmmo, akReserve },
    basement: curW ? curW.id : -1,
    takenItems: [...initSnap.items].filter(id => !here.items.has(id)),
    takenAmmo: [...initSnap.ammo].filter(id => !here.ammo.has(id)),
    felled: [...initSnap.trees].filter(id => !here.trees.has(id)),
    pileDiff: [...initSnap.piles].map(([id, n0]) => [id, here.piles.has(id) ? here.piles.get(id).n : 0, n0]).filter(([id, n, n0]) => n !== n0).map(([id, n]) => [id, n]),
    caseState: [...initSnap.cases].map(id => { const c = here.cases.get(id); return [id, !c ? 'gone' : c.state === 'empty' ? 'empty' : (c.state === 'open' || c.state === 'taking') ? 'open' : 'closed']; }).filter(([id, st]) => st !== 'closed'),
    dyn: {
      piles: piles.filter(p => p.dyn).map(p => [p.type, p.x, p.z, p.n, p.stash ? 1 : 0]),
      items: items.filter(i => i.dyn).map(i => [i.type, i.x, i.z, i.stash ? 1 : 0]),
      ammo: ammoBoxes.filter(m => m.userData.dyn).map(m => [m.userData.px, m.userData.pz, m.userData.stash ? 1 : 0]),
      cases: cases.filter(c => c.dyn).map(c => [c.x, c.z, c.rotY, c.stash ? 1 : 0, c.kind || '', c.state === 'empty' ? 2 : (c.state === 'closed' ? 0 : 1)]),
    },
    built: built.filter(b => b.key !== 'garage').map(b => [b.type, b.px, b.pz, b.prot, b.open ? 1 : 0]),
    bike: bike ? [bike.rig.root.position.x, bike.rig.root.position.z, bike.heading, bike.fuel] : null,
    cars: cars.map(c => [c.rig.root.position.x, c.rig.root.position.z, c.heading, c.fuel]),
    wh: warehouses.map(w => [w.state, w.hp]),
    pumps: stations.map(st => st.pumps.map(p => p.fuel)),
    evac: cutscenes.serialize(),
  };
}
function saveGame(slot, quiet) {
  if (net.active) { notify('В мультиплеере сохранения отключены'); return false; }
  try {
    const all = readSaves();
    all[slot] = makeSave();
    localStorage.setItem('dz_saves', JSON.stringify(all));
    localStorage.setItem('dz_lastSlot', String(slot));
    currentSlot = slot;
    if (!quiet) notify(`Игра сохранена в слот ${slot}`);
    return true;
  } catch (e) { notify('Не удалось сохранить игру'); return false; }
}
function setCaseOpen(c, empty) { // ящик сразу открыт (после загрузки)
  c.lid.rotation.x = -1.95; c.latches.forEach(l => { l.rotation.x = -1.2; });
  c.state = empty ? 'empty' : 'open'; c.t = 0;
  if (empty) c.loot.visible = false;
}
function applySave(sv) { // накладываем сохранение на только что созданный мир с тем же зерном
  const P = sv.player;
  camera.position.set(P.x, P.y, P.z); yaw = P.yaw; pitch = 0;
  health = P.health; hunger = P.hunger; thirst = P.thirst; kills = P.kills; day = sv.day; gameHour = sv.hour;
  slots.fill(null); sv.inv.forEach((sl, i) => { slots[i] = sl ? { type: sl[0], n: sl[1] } : null; });
  const W = sv.w;
  weapon = W.weapon; hasShotgun = W.hasShotgun; hasAxe = W.hasAxe; hasAK = W.hasAK;
  ammo = W.ammo; reserve = W.reserve; lock = W.lock; sgAmmo = W.sgAmmo; sgReserve = W.sgReserve; akAmmo = W.akAmmo; akReserve = W.akReserve;
  drawT = 0;
  // собранный лут и срубленные деревья
  const tI = new Set(sv.takenItems); for (let i = items.length - 1; i >= 0; i--) if (tI.has(items[i].id)) { scene.remove(items[i].mesh); items.splice(i, 1); }
  const tA = new Set(sv.takenAmmo); for (let i = ammoBoxes.length - 1; i >= 0; i--) if (tA.has(ammoBoxes[i].userData.id)) { scene.remove(ammoBoxes[i]); ammoBoxes.splice(i, 1); }
  const fe = new Set(sv.felled);
  for (let i = trees.length - 1; i >= 0; i--) {
    const t = trees[i]; if (!fe.has(t.id)) continue;
    scene.remove(t.trunk); scene.remove(t.crown); removeFrom(colliders, t.collider); removeFrom(blockers, t.trunk); trees.splice(i, 1);
  }
  sv.pileDiff.forEach(([id, n]) => {
    const p = piles.find(q => q.id === id); if (!p) return;
    while (p.n > n && p.parts.length) { p.group.remove(p.parts.shift()); p.n--; }
    if (n <= 0) { scene.remove(p.group); removeFrom(piles, p); }
  });
  sv.caseState.forEach(([id, st]) => {
    const c = cases.find(q => q.id === id); if (!c) return;
    if (st === 'gone') { scene.remove(c.root); const ci = colliders.indexOf(c.collider); if (ci >= 0) colliders.splice(ci, 1); removeFrom(cases, c); }
    else setCaseOpen(c, st === 'empty');
  });
  // объекты, появившиеся уже во время игры
  sv.dyn.piles.forEach(([t, x, z, n, st]) => spawnPile(t, x, z, n, !!st));
  sv.dyn.items.forEach(([t, x, z, st]) => spawnItem(t, x, z, !!st));
  sv.dyn.ammo.forEach(([x, z, st]) => spawnAmmoBox(x, z, !!st));
  sv.dyn.cases.forEach(([x, z, r, st, kind, state]) => { spawnCase(x, z, r, !!st, kind || undefined); const c = cases[cases.length - 1]; if (state === 1) setCaseOpen(c, false); else if (state === 2) setCaseOpen(c, true); });
  // транспорт
  cars.slice().forEach(c => { if (c.collider) removeFrom(colliders, c.collider); scene.remove(c.rig.root); }); cars.length = 0;
  sv.cars.forEach(([x, z, h, f]) => spawnCar(x, z, h, f));
  if (sv.bike) { spawnBike(sv.bike[0], sv.bike[1], sv.bike[2]); bike.fuel = sv.bike[3]; }
  // постройки игрока
  sv.built.forEach(([type, x, z, r, open]) => { const b = placePieceAt(type, r, x, z, true); if (b && open) { toggleDoor(b); b.ang = 1; } });
  // склады, колонки, подвал
  sv.wh.forEach(([state, hp], i) => { const w = warehouses[i]; if (!w) return; w.hp = hp; if (state === 'open') { w.state = 'open'; scene.remove(w.hatch); w.hole.visible = true; } });
  sv.pumps.forEach((arr, i) => { const st = stations[i]; if (st) arr.forEach((f, j) => { if (st.pumps[j]) st.pumps[j].fuel = f; }); });
  cutscenes.restore(sv.evac);     // финал: уже был (4) или объявлен (1)
  if (sv.basement >= 0 && warehouses[sv.basement]) { inBasement = true; curW = warehouses[sv.basement]; }
}

const mainMenu = document.createElement('div');
mainMenu.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;font:18px monospace;color:#fff;z-index:20;background:radial-gradient(ellipse at center, rgba(0,0,0,.15), rgba(0,0,0,.7))';
document.body.appendChild(mainMenu);
function renderMainMenu(view) {
  const sv = readSaves(), last = parseInt(lsGet('dz_lastSlot') || '0', 10);
  const B = (label, act, on = true) => `<button ${on ? `data-mm="${act}"` : 'disabled'} style="font:inherit;font-size:20px;color:#fff;width:300px;padding:12px;margin:6px;border:2px solid #5a6b45;border-radius:8px;background:#2a3324;cursor:${on ? 'pointer' : 'not-allowed'};opacity:${on ? 1 : 0.4}">${label}</button>`;
  const Bs = (label, act) => `<button data-mm="${act}" style="font:inherit;color:#fff;padding:10px 14px;border:2px solid #5a6b45;border-radius:8px;background:#2a3324;cursor:pointer">${label}</button>`;
  let body = '';
  if (view === 'main') {
    const hasLast = last && sv[last] && sv[last].v === 2;
    body = B('Продолжить' + (hasLast ? ` (слот ${last})` : ''), 'continue', !!hasLast) + B('Новая игра', 'new') + B('Загрузить игру', 'load', Object.keys(sv).length > 0) + B('Мультиплеер', 'mp') + B('Настройки', 'settings') + B('Выйти', 'quit');
  } else if (view === 'mp') {
    const inp = 'font:inherit;font-size:18px;color:#fff;background:#111;border:2px solid #5a6b45;border-radius:6px;padding:8px 10px;width:220px;text-align:center';
    body = `<div style="margin:6px">Твоё имя: <input id="mpName" value="${mpNameVal}" maxlength="12" style="${inp}"></div>` + B('Создать комнату', 'mp-host') +
      `<div style="margin:16px 6px 4px">Код комнаты друга: <input id="mpCode" value="${mpCodeVal}" maxlength="8" style="${inp};text-transform:uppercase"></div>` + B('Подключиться', 'mp-join') +
      `<div id="mpStatus" style="min-height:26px;margin:8px;color:#e0d28a">${net.status}</div>` + B('Назад', 'back');
  } else {
    body = [1, 2, 3].map(i => {
      const d = sv[i];
      return `<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin:6px"><div style="width:520px;max-width:55vw;padding:10px 14px;border:2px solid #4a5a3a;border-radius:8px;background:rgba(20,26,18,.85);text-align:left">Слот ${i}: ${d ? slotInfo(d) : '<span style="opacity:.6">пусто</span>'}</div>${d ? (d.v === 2 ? Bs('Загрузить', 'slot:' + i) : '') + Bs('Удалить', 'del:' + i) : ''}</div>`;
    }).join('') + B('Назад', 'back');
  }
  mainMenu.innerHTML = `<div style="text-align:center"><div style="font-size:72px;letter-spacing:10px;color:#c8e07a;text-shadow:0 4px 12px #000">DEADZONE</div><div style="opacity:.8;margin-bottom:24px">Постапокалиптическое выживание</div>${body}</div><div style="position:absolute;right:14px;bottom:10px;opacity:.6;font-size:14px">версия 1.8.0 · сохраняться можно на кровати</div>`;
}
function startGame(isNew, lock) {
  gameStarted = true; mainMenu.style.display = 'none';
  Object.keys(keys).forEach(k => { keys[k] = false; });
  if (isNew) { gameHour = 8; day = 1; camera.position.set(0, 1.7, 0); yaw = 0; pitch = 0; }
  if (lock) { try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* клик по экрану захватит мышь */ } }
  notify(isNew ? 'Выживи. Построй кровать (B, 8), чтобы сохраняться' : 'Игра загружена' + (lock ? '' : '. Кликни по экрану, чтобы управлять'));
}
function startNewGame(gate) { // новая игра: вступительная сцена, потом обычный старт (параметр ?nointro в адресе её отключает)
  const begin = () => { startGame(true, true); gameHour = 6.4; };   // после вступления начинается раннее утро
  if (/[?&]nointro\b/.test(location.search)) { startGame(true, true); return; }
  cutscenes.startIntro(begin, { gate });
}
function loadSlot(slot) {
  const sv = readSaves()[slot];
  if (!sv || sv.v !== 2) return;
  if (sv.seed === WORLD_SEED) { applySave(sv); currentSlot = slot; startGame(false, true); }
  else { try { localStorage.setItem('dz_boot', JSON.stringify({ seed: sv.seed, slot })); location.reload(); } catch (e) { notify('Не удалось загрузить'); } }
}
mainMenu.addEventListener('click', e => {
  const t = e.target.closest('[data-mm]'); if (!t) return;
  const [act, arg] = t.dataset.mm.split(':');
  if (act === 'new') startNewGame(false);
  else if (act === 'continue') loadSlot(parseInt(lsGet('dz_lastSlot') || '0', 10));
  else if (act === 'load') renderMainMenu('load');
  else if (act === 'back') renderMainMenu('main');
  else if (act === 'slot') loadSlot(+arg);
  else if (act === 'del') {
    const all = readSaves(); delete all[arg];
    try { localStorage.setItem('dz_saves', JSON.stringify(all)); } catch (err) { /* нет доступа */ }
    renderMainMenu(Object.keys(all).length ? 'load' : 'main');
  }
  else if (act === 'settings') { menuTab = 'settings'; mainMenu.style.display = 'none'; menuOpen = true; menu.style.display = 'flex'; renderMenu(); }
  else if (act === 'mp') renderMainMenu('mp');
  else if (act === 'mp-host') hostCreate(document.getElementById('mpName').value);
  else if (act === 'mp-join') peekRoom(document.getElementById('mpCode').value, document.getElementById('mpName').value);
  else if (act === 'quit') window.close();
});
mainMenu.addEventListener('input', e => {
  if (e.target.id === 'mpName') mpNameVal = e.target.value;
  if (e.target.id === 'mpCode') mpCodeVal = e.target.value;
});

let bedMenuBed = null;
function openBedMenu(b) { if (sleeping) return;
  if (net.active) return notify('В мультиплеере сон и сохранения отключены'); bedMenuBed = b; menuTab = 'bed'; toggleMenu(true); }
function renderBedMenu() { // кровать: сохранить игру (3 слота) или лечь спать
  const sv = readSaves();
  const night = gameHour >= 19.5 || gameHour < 5.5;
  let rows = '';
  for (let i = 1; i <= 3; i++) {
    const d = sv[i];
    rows += row(`Слот ${i}: ${d ? slotInfo(d) : '<span style="opacity:.6">пусто</span>'}${currentSlot === i ? ' <b style="color:#c8e07a">(текущий)</b>' : ''}`, btn(d ? 'Перезаписать' : 'Сохранить', 'save:' + i));
  }
  menu.innerHTML = `<div style="width:min(720px,94vw);max-height:92vh;overflow:auto;background:#1d231c;border:2px solid #5a6b45;border-radius:10px;padding:18px">` +
    `<div style="font-size:24px;margin-bottom:6px">Кровать</div><div style="opacity:.75;font-size:14px;margin-bottom:8px">Здесь можно сохранить игру. Спать можно с 19:30 до 05:30, после сна сохранение текущего слота обновляется само.</div>` +
    rows + row('Спать до утра' + (night ? '' : ' <small>(сейчас не ночь)</small>'), btn('Лечь спать', 'sleep', night || admin.on)) +
    `<div style="margin-top:14px">${btn('Закрыть', 'closebed')}</div></div>`;
}
function bootGame() { // автозапуск после перезагрузки из-за загрузки сохранения или входа в комнату, иначе главное меню
  if (mpBoot) { // зашли в комнату друга: мир уже создан по его зерну
    gameHour = 9; mpNameVal = mpBoot.name; mpCodeVal = mpBoot.code;
    mainMenu.style.display = 'flex'; renderMainMenu('mp'); setMpStatus('Подключаюсь к комнате ' + mpBoot.code + '...');
    joinRoom(mpBoot.code, mpBoot.name, true);
    return;
  }
  if (bootInfo && bootInfo.slot) {
    const sv = readSaves()[bootInfo.slot];
    if (sv && sv.v === 2 && sv.seed === WORLD_SEED) { applySave(sv); currentSlot = bootInfo.slot; startGame(false, false); return; }
  }
  if (bootInfo && bootInfo.newGame) { gameHour = 9; startNewGame(true); return; }   // «Новая игра» из финала: вступление с ожиданием нажатия
  gameHour = 9; // красивый фон для меню
  mainMenu.style.display = 'flex'; renderMainMenu('main');
}

// --- Мультиплеер: кооператив по коду комнаты (WebRTC через PeerJS, свой сервер не нужен) ---
const net = { active: false, role: null, peer: null, hostConn: null, conns: new Map(), id: 'p0', name: 'Игрок', code: '', nextId: 1, players: new Map(), tPlayers: 0, tZombies: 0, tTime: 0, tHud: 0, status: '', lastChat: null };
let mpNameVal = 'Игрок', mpCodeVal = '', chatOpen = false;
const mpBoot = bootInfo && bootInfo.mp ? bootInfo.mp : null;      // после перезагрузки: куда подключаться
const sanitizeName = n => (String(n || '').trim().slice(0, 12)) || 'Игрок';
function setMpStatus(t) { net.status = t; const el = document.getElementById('mpStatus'); if (el) el.textContent = t; }
function netSendTo(conn, msg) { try { if (conn && conn.open) conn.send(msg); } catch (e) { /* связь оборвалась */ } }
function netBroadcast(msg, exceptConn) { net.conns.forEach(c => { if (c !== exceptConn) netSendTo(c, msg); }); }

// Чат: Enter открывает строку ввода
const chatLog = document.createElement('div');
chatLog.style.cssText = 'position:fixed;left:10px;bottom:110px;max-width:42vw;font:16px monospace;color:#fff;text-shadow:1px 1px 2px #000;pointer-events:none';
document.body.appendChild(chatLog);
const chatInput = document.createElement('input');
chatInput.maxLength = 120; chatInput.placeholder = 'Сообщение (Enter - отправить, Esc - отмена)';
chatInput.style.cssText = 'position:fixed;left:10px;bottom:76px;width:min(420px,60vw);font:16px monospace;padding:6px 10px;background:rgba(0,0,0,.75);color:#fff;border:2px solid #5a6b45;border-radius:6px;display:none;z-index:8';
document.body.appendChild(chatInput);
function addChat(name, text) {
  net.lastChat = { name, text };
  const d = document.createElement('div');
  d.textContent = name ? `${name}: ${text}` : text;
  d.style.cssText = 'background:rgba(0,0,0,.4);padding:2px 8px;margin-top:2px;border-radius:4px;' + (name ? '' : 'color:#e0d28a');
  chatLog.appendChild(d);
  while (chatLog.children.length > 7) chatLog.removeChild(chatLog.firstChild);
  setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 15000);
}
function openChat() {
  chatOpen = true; Object.keys(keys).forEach(k => { keys[k] = false; });
  chatInput.style.display = 'block'; chatInput.value = ''; document.exitPointerLock(); chatInput.focus();
}
function closeChat() {
  chatOpen = false; chatInput.style.display = 'none'; chatInput.blur();
  try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* клик по экрану вернёт мышь */ }
}
function sendChat(text) {
  text = text.slice(0, 120);
  if (net.role === 'host') { addChat(net.name, text); netBroadcast({ t: 'chat', name: net.name, text }); }
  else netSendTo(net.hostConn, { t: 'chat', text });
}
chatInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { const t = chatInput.value.trim(); if (t) sendChat(t); closeChat(); }
  else if (e.key === 'Escape') closeChat();
});

// Список игроков и код комнаты
const mpHud = document.createElement('div');
mpHud.style.cssText = 'position:fixed;top:10px;right:10px;color:#fff;font:15px monospace;text-shadow:1px 1px 2px #000;background:rgba(0,0,0,.4);padding:4px 10px;border-radius:6px;display:none;text-align:right;white-space:pre';
document.body.appendChild(mpHud);

// --- Оружие в руках других игроков: упрощённые модели (ствол смотрит в +Z, начало координат у рукояти) ---
function buildWorldGun(kind) {
  const B = zBoxes(mulberry(7 + kind.length));
  const STEEL = 0x2a2d30, STEEL_L = 0x4a5057, WOOD = 0x7a4a22, WOOD_D = 0x4e3119, BLACK = 0x0d0e10, FRAME = 0x26292d;
  let gy = 0.06, gz = 0.04; // смещение: центр рукояти попадает в начало координат
  if (kind === 'pistol') {
    gz = 0.01; gy = 0.06;
    B.box(0.03, 0.04, 0.21, 0x2d3136, 0, 0.045, 0.07); B.box(0.032, 0.044, 0.03, STEEL_L, 0, 0.045, -0.02);       // затвор
    B.box(0.014, 0.014, 0.03, BLACK, 0, 0.04, 0.19); B.box(0.008, 0.014, 0.01, 0xf2f2f2, 0, 0.072, 0.165); B.box(0.018, 0.012, 0.01, BLACK, 0, 0.072, -0.03); // дуло, мушка, целик
    B.box(0.03, 0.032, 0.18, FRAME, 0, 0.008, 0.07);                                                               // рама
    B.box(0.032, 0.12, 0.05, 0x5a3a20, 0, -0.06, -0.01, -0.2); B.box(0.032, 0.012, 0.056, BLACK, 0, -0.122, -0.035); // рукоять, дно магазина
    B.box(0.008, 0.012, 0.05, FRAME, 0, -0.022, 0.06); B.box(0.008, 0.022, 0.008, STEEL_L, 0, -0.012, 0.05);        // скоба и курок
  } else if (kind === 'shotgun') {
    B.box(0.05, 0.085, 0.28, 0x1f2226, 0, 0.03, 0.12); B.box(0.004, 0.03, 0.08, BLACK, 0.026, 0.035, 0.1);        // ствольная коробка, окно выброса
    B.box(0.034, 0.034, 0.6, STEEL, 0, 0.058, 0.56); B.box(0.03, 0.03, 0.46, STEEL_L, 0, 0.012, 0.5);              // ствол, трубка магазина
    B.box(0.052, 0.05, 0.22, WOOD, 0, 0.002, 0.46); B.box(0.04, 0.04, 0.025, BLACK, 0, 0.058, 0.87); B.box(0.008, 0.012, 0.008, 0xc9a227, 0, 0.082, 0.86); // цевьё, дульный срез, мушка
    B.box(0.04, 0.1, 0.05, WOOD_D, 0, -0.06, -0.04, -0.3); B.box(0.045, 0.11, 0.34, WOOD, 0, 0.0, -0.27, 0.1);       // рукоять, приклад
    B.box(0.048, 0.13, 0.025, BLACK, 0, -0.015, -0.45); B.box(0.008, 0.012, 0.07, STEEL, 0, -0.025, 0.06);          // затылок приклада, скоба
  } else { // ak
    B.box(0.05, 0.075, 0.34, STEEL, 0, 0.03, 0.12); B.box(0.046, 0.02, 0.3, STEEL_L, 0, 0.078, 0.14); B.box(0.03, 0.018, 0.07, STEEL, 0, 0.092, 0.24); // коробка, крышка, целик
    B.box(0.058, 0.055, 0.26, WOOD, 0, 0.012, 0.4); B.box(0.052, 0.032, 0.26, WOOD, 0, 0.06, 0.4);                  // цевьё
    B.box(0.024, 0.024, 0.3, STEEL, 0, 0.04, 0.68); B.box(0.022, 0.022, 0.28, STEEL_L, 0, 0.082, 0.52);            // ствол, газовая трубка
    B.box(0.022, 0.05, 0.03, STEEL, 0, 0.075, 0.82); B.box(0.032, 0.032, 0.05, BLACK, 0, 0.04, 0.85);               // мушка, дульный тормоз
    B.box(0.04, 0.12, 0.075, STEEL, 0, -0.07, 0.13, 0.05); B.box(0.04, 0.12, 0.075, STEEL, 0, -0.18, 0.17, 0.3);    // магазин-«банан»
    B.box(0.042, 0.008, 0.077, STEEL_L, 0, -0.07, 0.13, 0.05);
    B.box(0.04, 0.1, 0.05, WOOD, 0, -0.06, -0.04, -0.35); B.box(0.045, 0.12, 0.38, WOOD, 0, 0.0, -0.33, 0.1);        // рукоять, приклад
    B.box(0.05, 0.13, 0.015, BLACK, 0, -0.01, -0.53); B.box(0.008, 0.012, 0.06, STEEL, 0, -0.02, 0.07);            // затылок, скоба
  }
  const g = new THREE.Group(), m = B.mesh(weaponMixMat);
  m.position.set(0, gy, gz); g.add(m);
  return g;
}
// --- Выжившие (аватары других игроков) ---
// Скелет: таз с бёдрами и коленями, корпус на поясе, плечи с локтями, голова. Оружие держат руки через обратную кинематику
// (две кости: плечо и предплечье), поэтому кисти лежат на рукояти и цевье при любом наклоне головы и отдаче.
const SURV_SKINS = [0xd9a67a, 0xc68642, 0xf1c27d, 0x8d5524];
const SURV_STYLE = [ // куртка, головной убор, рюкзак, волосы
  { jacket: 0x2f6fa8, hat: 'beanie', hatCol: 0x1f3550, pack: 0xc9742a, hair: 0x4a3322, beard: false, goggles: false },
  { jacket: 0xa8442f, hat: 'cap', hatCol: 0x1a1a1a, pack: 0x5a5f61, hair: 0x2b2118, beard: true, goggles: false },
  { jacket: 0x3f8a4a, hat: 'none', hatCol: 0, pack: 0x8a7a52, hair: 0x6a5a3a, beard: false, goggles: true },
  { jacket: 0x8a6fa8, hat: 'bandana', hatCol: 0xb02a2a, pack: 0x2f7a7a, hair: 0x1a1a1a, beard: true, goggles: false },
];
const SURV_L1 = 0.30, SURV_L2 = 0.29;      // длина плеча и предплечья (до центра кисти)
const SURV_SH = [0.28, 0.44];              // плечо: сдвиг от оси и высота над поясом
function buildSurvivor(idx) {
  const st = SURV_STYLE[idx % 4], skin = SURV_SKINS[(idx + (idx >> 2)) % 4], rnd = mulberry(9000 + idx * 17);
  const jk = st.jacket, jkD = mulCol(jk, 0.72), jkL = mulCol(jk, 1.18), skD = mulCol(skin, 0.78), hair = st.hair;
  const pants = idx % 2 ? 0x6a6048 : 0x3a4252, pantsD = mulCol(pants, 0.72), boot = 0x2a2018, glove = 0x2f2f33;
  const grp = (x, y, z) => { const o = new THREE.Group(); o.position.set(x, y, z); return o; };
  const cl = v => Math.min(1, Math.max(0, v));
  const g = new THREE.Group(), body = new THREE.Group(), upper = grp(0, 1.08, 0);
  g.add(body); body.add(upper);

  // корпус: куртка, пояс с подсумком и флягой, рюкзак
  const U = zBoxes(rnd, y => 0.8 + 0.2 * cl((y + 0.2) / 0.6));
  U.box(0.34, 0.2, 0.22, pants, 0, -0.1, 0);
  U.box(0.34, 0.24, 0.22, jkD, 0, 0.08, 0); U.box(0.42, 0.3, 0.25, jk, 0, 0.32, 0);
  [-1, 1].forEach(sd => U.box(0.14, 0.1, 0.2, jk, sd * 0.27, 0.44, 0));
  U.box(0.24, 0.05, 0.2, jkL, 0, 0.5, 0); U.box(0.1, 0.1, 0.1, skin, 0, 0.55, 0);
  U.box(0.012, 0.46, 0.01, 0x222222, 0, 0.27, 0.128);
  [-1, 1].forEach(sd => { U.box(0.1, 0.09, 0.012, jkD, sd * 0.12, 0.28, 0.13); U.box(0.05, 0.34, 0.02, 0x222222, sd * 0.13, 0.32, 0.128); });
  U.box(0.37, 0.05, 0.235, jkD, 0, 0.0, 0);
  U.box(0.36, 0.06, 0.23, 0x2a2018, 0, -0.04, 0); U.box(0.06, 0.04, 0.012, 0xc9a227, 0, -0.04, 0.12);
  U.box(0.1, 0.12, 0.07, 0x3a3a2a, -0.2, -0.12, 0.06); U.box(0.07, 0.2, 0.07, 0x3a6a8a, 0.21, -0.08, -0.04);
  U.box(0.34, 0.42, 0.18, st.pack, 0, 0.28, -0.21); U.box(0.32, 0.12, 0.2, mulCol(st.pack, 0.8), 0, 0.5, -0.21); U.box(0.34, 0.1, 0.1, 0x5a5a3a, 0, 0.6, -0.21);
  upper.add(U.mesh(zombieMat));

  // голова: лицо, глаза, волосы, головной убор, борода, очки
  const head = grp(0, 0.62, 0), Hd = zBoxes(rnd), Ey = zBoxes(rnd);
  Hd.box(0.24, 0.26, 0.25, skin, 0, 0.02, 0); Hd.box(0.22, 0.08, 0.22, skin, 0, -0.12, 0.01);
  Hd.box(0.2, 0.025, 0.02, hair, 0, 0.085, 0.126); Hd.box(0.04, 0.07, 0.04, skD, 0, -0.02, 0.14); Hd.box(0.08, 0.015, 0.01, 0x6a2a2a, 0, -0.08, 0.128);
  [-1, 1].forEach(sd => { Hd.box(0.02, 0.07, 0.04, skin, sd * 0.125, 0, 0); Ey.box(0.045, 0.03, 0.01, 0xf2f2f2, sd * 0.055, 0.04, 0.128); Ey.box(0.02, 0.025, 0.012, 0x1a1a1a, sd * 0.055, 0.04, 0.131); });
  if (st.hat === 'beanie') { Hd.box(0.27, 0.12, 0.27, st.hatCol, 0, 0.13, 0); Hd.box(0.28, 0.04, 0.28, mulCol(st.hatCol, 0.8), 0, 0.07, 0); Hd.box(0.06, 0.06, 0.06, 0xd9d9d9, 0, 0.21, 0); Hd.box(0.25, 0.1, 0.06, hair, 0, 0.0, -0.13); }
  else if (st.hat === 'cap') { Hd.box(0.26, 0.07, 0.26, st.hatCol, 0, 0.14, 0); Hd.box(0.24, 0.015, 0.12, st.hatCol, 0, 0.1, 0.18); Hd.box(0.25, 0.1, 0.06, hair, 0, 0.04, -0.12); }
  else if (st.hat === 'bandana') { Hd.box(0.27, 0.07, 0.27, st.hatCol, 0, 0.12, 0); Hd.box(0.06, 0.08, 0.05, st.hatCol, 0.06, 0.08, -0.15); Hd.box(0.08, 0.2, 0.07, hair, 0, -0.02, -0.16); Hd.box(0.26, 0.05, 0.27, hair, 0, 0.17, 0); }
  else { Hd.box(0.26, 0.07, 0.27, hair, 0, 0.13, 0); Hd.box(0.26, 0.12, 0.06, hair, 0, 0.06, -0.12); }
  if (st.beard) Hd.box(0.2, 0.09, 0.06, hair, 0, -0.1, 0.11);
  if (st.goggles) { Hd.box(0.26, 0.05, 0.03, 0x222222, 0, 0.11, 0.12); [-1, 1].forEach(sd => Hd.box(0.08, 0.035, 0.012, 0x88c0d8, sd * 0.055, 0.11, 0.14)); }
  head.add(Hd.mesh(zombieMat), Ey.mesh(zombieEyeMat)); upper.add(head);

  // руки: плечо и предплечье на локте; перчатки
  const arm = sd => {
    const a = grp(sd * SURV_SH[0], SURV_SH[1], 0), fo = grp(0, -SURV_L1, 0);
    const A = zBoxes(rnd, y => 0.86 + 0.14 * cl((y + 0.62) / 0.62)), F = zBoxes(rnd, y => 0.86 + 0.14 * cl((y - SURV_L1 + 0.62) / 0.62));
    A.box(0.11, 0.3, 0.11, jk, 0, -0.15, 0);
    F.box(0.1, 0.12, 0.1, jk, 0, -0.01, 0); F.box(0.1, 0.22, 0.1, jk, 0, -0.11, 0); F.box(0.108, 0.04, 0.108, jkD, 0, -0.23, 0);
    F.box(0.09, 0.1, 0.1, glove, 0, -0.29, 0); F.box(0.085, 0.045, 0.05, glove, 0, -0.35, 0.03); F.box(0.025, 0.05, 0.04, glove, -sd * 0.05, -0.28, 0.03);
    fo.add(F.mesh(zombieMat)); a.add(A.mesh(zombieMat), fo); a.fore = fo; upper.add(a); return a;
  };
  const armL = arm(-1), armR = arm(1);   // armL у плеча с лицевой стороны - это правая рука аватара: ею он держит оружие

  // ноги: бедро и голень на колене; наколенники, ботинки
  const leg = sd => {
    const l = grp(sd * 0.13, 0.93, 0), sh = grp(0, -0.45, 0);
    const L = zBoxes(rnd, y => 0.8 + 0.2 * cl((y + 0.93) / 0.93)), S2 = zBoxes(rnd, y => 0.7 + 0.3 * cl((y + 0.93 + 0.45) / 0.93));
    L.box(0.16, 0.45, 0.17, pants, 0, -0.225, 0); L.box(0.03, 0.14, 0.1, pantsD, sd * 0.09, -0.2, 0.02);
    S2.box(0.15, 0.08, 0.16, pants, 0, 0, 0); S2.box(0.13, 0.1, 0.02, 0x2a2a2a, 0, 0, 0.09);
    S2.box(0.14, 0.4, 0.15, pants, 0, -0.2, 0); S2.box(0.15, 0.05, 0.16, pantsD, 0, -0.37, 0);
    S2.box(0.155, 0.11, 0.27, boot, 0, -0.405, 0.04); S2.box(0.16, 0.03, 0.28, 0x151210, 0, -0.465, 0.04);
    sh.add(S2.mesh(zombieMat)); l.add(L.mesh(zombieMat), sh); l.shin = sh; body.add(l); return l;
  };
  const legL = leg(-1), legR = leg(1);
  return { g, body, parts: { upper, head, armL, armR, legL, legR } };
}

// --- Обратная кинематика руки: плечо и предплечье тянутся к точке T (в пространстве корпуса), локоть смотрит по подсказке pole ---
function quatFromBasis(X, Y, Z) {
  const m11 = X[0], m12 = Y[0], m13 = Z[0], m21 = X[1], m22 = Y[1], m23 = Z[1], m31 = X[2], m32 = Y[2], m33 = Z[2], tr = m11 + m22 + m33;
  let x, y, z, w;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s; }
  else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s; }
  else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s; }
  else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s; }
  return [x, y, z, w];
}
const v3len = a => Math.hypot(a[0], a[1], a[2]) || 1, v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3norm = a => { const l = v3len(a); return [a[0] / l, a[1] / l, a[2] / l]; };
function solveArm(arm, S, T, pole) {
  const L1 = SURV_L1, L2 = SURV_L2;
  const v = [T[0] - S[0], T[1] - S[1], T[2] - S[2]], d = v3len(v), u = [v[0] / d, v[1] / d, v[2] / d];
  const dd = Math.min(L1 + L2 - 0.004, Math.max(Math.abs(L1 - L2) + 0.02, d));            // дотянуться можно только в пределах длины руки
  const cosA = (L1 * L1 + dd * dd - L2 * L2) / (2 * L1 * dd), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const pd = v3dot(pole, u), n = v3norm([pole[0] - u[0] * pd, pole[1] - u[1] * pd, pole[2] - u[2] * pd]);
  const a = [u[0] * cosA + n[0] * sinA, u[1] * cosA + n[1] * sinA, u[2] * cosA + n[2] * sinA]; // куда смотрит плечо
  const E = [S[0] + a[0] * L1, S[1] + a[1] * L1, S[2] + a[2] * L1], Tt = [S[0] + u[0] * dd, S[1] + u[1] * dd, S[2] + u[2] * dd];
  const w = v3norm([Tt[0] - E[0], Tt[1] - E[1], Tt[2] - E[2]]);                           // куда смотрит предплечье
  let h = v3cross(a, w); if (v3len(h) < 1e-4) h = v3cross(a, pole); h = v3norm(h);          // ось сгиба локтя
  const beta = Math.acos(Math.min(1, Math.max(-1, v3dot(a, w))));
  const X = h, Y = [-a[0], -a[1], -a[2]], Z = v3cross(X, Y);
  const q = quatFromBasis(X, Y, Z);
  arm.quaternion.set(q[0], q[1], q[2], q[3]); arm.fore.rotation.x = beta;
}
function freeArm(arm, side, swing, flex) { arm.rotation.set(swing, 0, side * 0.06); arm.fore.rotation.x = -flex; } // свободная рука: качается, локоть согнут вперёд

// --- Оружие в руках: где держать, куда класть вторую руку, где дульный срез. Координаты в пространстве корпуса (начало на поясе) ---
const WEAPON_HOLD = {
  pistol:  { pos: [-0.10, 0.38, 0.40], gun: true,  sup: [0.05, -0.05, 0.01], muzzle: [0, 0.10, 0.20] },
  shotgun: { pos: [-0.10, 0.30, 0.10], gun: true,  sup: [0, 0.03, 0.42], muzzle: [0, 0.118, 0.91] },
  ak:      { pos: [-0.10, 0.30, 0.10], gun: true,  sup: [0, 0.03, 0.40], muzzle: [0, 0.10, 0.89] },
  axe:     { pos: [-0.30, 0.02, 0.14], gun: false, rot: 0.5, sup: [0, 0.34, 0] },
};
const IK_POLE_R = [-0.6, -1, -0.3], IK_POLE_L = [0.6, -1, -0.3]; // локоть смотрит вниз и в сторону
const flashMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0 }), flashGeo = new THREE.BoxGeometry(0.16, 0.014, 0.014), flashGeo2 = new THREE.BoxGeometry(0.014, 0.16, 0.014), flashGeo3 = new THREE.BoxGeometry(0.05, 0.05, 0.08);
[flashMat, flashGeo, flashGeo2, flashGeo3].forEach(o => { o.userData.shared = true; });
function avatarWeapon(av, kind) { // модель создаётся при первом показе и остаётся у аватара
  let h = av.holders[kind];
  if (h) return h;
  h = new THREE.Group();
  if (kind === 'axe') { const a = createAxe({ hands: false }).root; a.position.y = -0.14; h.add(a); }
  else {
    h.add(buildWorldGun(kind));
    const f = new THREE.Group(), mz = WEAPON_HOLD[kind].muzzle;
    f.add(new THREE.Mesh(flashGeo, flashMat), new THREE.Mesh(flashGeo2, flashMat), new THREE.Mesh(flashGeo3, flashMat));
    f.position.set(mz[0], mz[1], mz[2] + 0.04); f.visible = false; h.add(f); h.userData.flash = f; // вспышка выстрела
  }
  av.parts.upper.add(h); av.holders[kind] = h;
  return h;
}

// --- Анимация выжившего: походка и бег с коленями и локтями, дыхание, оружие (наклон, отдача, вспышка, замах топора), вздрагивание, падение ---
function animateSurvivor(av, p, dt) {
  const P = av.parts, s = av.s, up = P.upper, cv = (v, a, b) => Math.max(a, Math.min(b, v));
  const dead = p.hp <= 0;
  if (s.lastSc === undefined) { s.lastSc = p.sc || 0; s.lastAc = p.ac || 0; s.lastHp = p.hp; s.lastW = p.w; }
  if ((p.sc || 0) > s.lastSc) { s.recoil = 1; s.flashT = 0.06; }                      // выстрел: счётчик на сервере вырос
  if ((p.ac || 0) > s.lastAc && s.swingT < 0) s.swingT = 0;                            // замах топором
  if (p.hp < s.lastHp) s.hitT = 0.3;                                                   // получил урон
  if (p.w !== s.lastW) { s.low = 1; s.lastW = p.w; }                                   // достал другое оружие: поднимает из-под низа
  s.lastSc = p.sc || 0; s.lastAc = p.ac || 0; s.lastHp = p.hp;
  s.recoil = Math.max(0, s.recoil - dt * 8); s.flashT = Math.max(0, s.flashT - dt); s.hitT = Math.max(0, s.hitT - dt);
  const moving = !!p.mv && !dead, sprint = moving && !!p.sp;
  s.gait += ((moving ? 1 : 0) - s.gait) * Math.min(1, 10 * dt);
  s.run += ((sprint ? 1 : 0) - s.run) * Math.min(1, 8 * dt);
  s.low += (((sprint && p.w !== 'axe') ? 0.7 : 0) - s.low) * Math.min(1, 6 * dt);     // на бегу ствол опущен
  s.phase += dt * (moving ? 7.5 + 3.5 * s.run : 0); s.idle += dt * 1.4;
  const ph = s.phase, sw = Math.sin(ph), cw = Math.cos(ph), G = s.gait, R = s.run, amp = (0.5 + 0.4 * R) * G, kn = (0.7 + 0.7 * R) * G, flinch = s.hitT / 0.3;
  // ноги
  P.legL.rotation.x = sw * amp; P.legR.rotation.x = -sw * amp;
  P.legL.shin.rotation.x = 0.06 + Math.max(0, -cw) * kn; P.legR.shin.rotation.x = 0.06 + Math.max(0, cw) * kn;
  const H = WEAPON_HOLD[p.w], armed = !!H && !dead;
  // корпус и голова
  up.position.y = 1.08 + Math.abs(sw) * 0.035 * G * (1 + 0.6 * R) + Math.sin(s.idle) * 0.004 * (1 - G);
  up.rotation.x = 0.03 + 0.05 * G + 0.16 * R * G - 0.28 * flinch + Math.sin(s.idle * 1.3) * 0.008;
  up.rotation.y = sw * 0.12 * G * (armed ? 0.3 : 1);
  // оружие и руки
  for (const k in av.holders) av.holders[k].visible = armed && k === p.w;
  if (armed) {
    const holder = avatarWeapon(av, p.w); holder.visible = true;
    let px = H.pos[0], py = H.pos[1], pz = H.pos[2], rx = 0, ry = 0;
    if (H.gun) {
      const th = -cv(p.pt || 0, -1.1, 1.1) * 0.8 + 0.5 * s.low - 0.09 * s.recoil;       // вверх и вниз по взгляду, опущено на бегу, подброс от отдачи
      const cy = py - 0.40;                                                              // поворот вокруг груди
      py = 0.40 + cy * Math.cos(th) - pz * Math.sin(th); pz = cy * Math.sin(th) + pz * Math.cos(th);
      rx = th; pz -= 0.05 * s.recoil; py += Math.sin(s.idle) * 0.004 * (1 - G) + sw * 0.01 * G;
    } else { // топор: на отдыхе опущен, при ударе замах и рубящий удар
      rx = H.rot; ry = Math.PI; py += Math.sin(s.idle) * 0.004 * (1 - G);
      if (s.swingT >= 0) {
        s.swingT += dt; const t = s.swingT / 0.55;
        const wind = ssm(0, 0.35, t) * (1 - ssm(0.35, 0.5, t)), strike = ssm(0.35, 0.55, t) * (1 - ssm(0.6, 1, t));
        rx = H.rot - 1.7 * wind + 1.4 * strike; py += 0.30 * wind - 0.05 * strike; pz += -0.10 * wind + 0.25 * strike;
        up.rotation.x += 0.25 * strike - 0.1 * wind;
        if (s.swingT > 0.55) s.swingT = -1;
      }
    }
    holder.position.set(px, py, pz); holder.rotation.set(rx, ry, 0);
    if (holder.userData.flash) holder.userData.flash.visible = s.flashT > 0;
    const M = m4(px, py, pz, rx, ry, 0), T = v => [M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12], M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13], M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14]];
    solveArm(P.armL, [-SURV_SH[0], SURV_SH[1], 0], T([0, 0, 0]), IK_POLE_R);             // правая рука на рукояти
    if (H.gun || s.swingT >= 0) solveArm(P.armR, [SURV_SH[0], SURV_SH[1], 0], T(H.sup), IK_POLE_L); // левая на цевье, у топора только при ударе
    else freeArm(P.armR, 1, sw * amp * 0.9, 0.12 + 0.2 * G + 0.9 * R * G);
  } else if (!dead && (p.w === 'bike' || p.w === 'car')) { // руль: обе руки вперёд
    solveArm(P.armL, [-SURV_SH[0], SURV_SH[1], 0], [-0.20, 0.24, 0.40], IK_POLE_R); solveArm(P.armR, [SURV_SH[0], SURV_SH[1], 0], [0.20, 0.24, 0.40], IK_POLE_L);
  } else { // руки свободны: качаются навстречу ногам, на бегу согнуты
    const flex = 0.12 + 0.2 * G + 0.9 * R * G;
    freeArm(P.armL, -1, -sw * amp * 0.9, flex); freeArm(P.armR, 1, sw * amp * 0.9, flex);
  }
  P.head.rotation.x = -cv(p.pt || 0, -1.1, 1.1) * 0.7 - up.rotation.x * 0.8 - 0.25 * flinch;
  P.head.rotation.y = Math.sin(s.idle * 0.4) * 0.15 * (1 - G) - up.rotation.y * 0.6;
  // смерть: падает на спину, руки и ноги расслаблены; если здоровье вернулось - встаёт
  s.deadT = cv(s.deadT + (dead ? dt : -3 * dt), 0, 0.7);
  const e = (s.deadT / 0.7) * (s.deadT / 0.7);
  av.body.rotation.x = -Math.PI / 2 * 0.98 * e; av.body.position.y = 0.14 * e;
  if (dead) {
    freeArm(P.armL, -1, -0.3 - 0.5 * e, 0.2); freeArm(P.armR, 1, -0.3 - 0.5 * e, 0.2);
    P.armL.rotation.z = -0.5 * e; P.armR.rotation.z = 0.5 * e; P.legL.rotation.z = -0.15 * e; P.legR.rotation.z = 0.2 * e;
  } else { P.legL.rotation.z = P.legR.rotation.z = 0; }
}

// Аватары других игроков
function makeAvatar(name, idx) {
  const sv = buildSurvivor(idx), g = sv.g;
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d'); x.font = 'bold 34px monospace'; x.textAlign = 'center'; x.lineWidth = 6; x.strokeStyle = '#000'; x.strokeText(name, 128, 44); x.fillStyle = '#fff'; x.fillText(name, 128, 44);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
  label.scale.set(2.4, 0.6, 1); label.position.set(0, 2.35, 0); g.add(label);
  scene.add(g);
  return { g, body: sv.body, parts: sv.parts, holders: {}, s: { phase: 0, idle: 0, gait: 0, run: 0, low: 0, recoil: 0, flashT: 0, swingT: -1, hitT: 0, deadT: 0 } };
}
function upsertPlayer(id, name) {
  let p = net.players.get(id);
  if (!p) { p = { id, name: name || '?', x: 0, y: 1.7, z: 0, yaw: 0, w: 'pistol', mv: 0, hp: 100, av: null }; net.players.set(id, p); }
  if (name) p.name = name;
  return p;
}
function updateAvatars(dt) {
  net.players.forEach(p => {
    if (!p.av) { p.av = makeAvatar(p.name, parseInt(String(p.id).slice(1), 10) || 0); p.av.g.position.set(p.x, p.y - 1.7, p.z); }
    const av = p.av, k = Math.min(1, 12 * dt);
    av.g.position.x += (p.x - av.g.position.x) * k; av.g.position.z += (p.z - av.g.position.z) * k; av.g.position.y += ((p.y - 1.7) - av.g.position.y) * k;
    let dr = (p.yaw + Math.PI) - av.g.rotation.y; dr = Math.atan2(Math.sin(dr), Math.cos(dr)); av.g.rotation.y += dr * k;
    animateSurvivor(av, p, dt);
  });
}
function removePlayer(id) {
  const p = net.players.get(id);
  if (!p) return;
  if (p.av) { scene.remove(p.av.g); disposeObject(p.av.g); }
  net.players.delete(id); net.conns.delete(id);
  addChat('', `${p.name} вышел из игры`);
}
function ownState() {
  const v = riding ? (drive === 'car' ? curCar : bike) : null;
  return {
    x: +camera.position.x.toFixed(2), y: +camera.position.y.toFixed(2), z: +camera.position.z.toFixed(2), yaw: +yaw.toFixed(2),
    w: riding ? drive : weapon, hp: Math.ceil(health),
    mv: (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD || (v && Math.abs(v.v) > 1)) ? 1 : 0,
    pt: +pitch.toFixed(2), sp: (keys.ShiftLeft && !riding && (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD)) ? 1 : 0, sc: shotCount, ac: axeCount,
  };
}
// Зомби: хозяин считает, клиенты показывают
function pickTarget(z) { // ближайший игрок (у хозяина - и удалённые тоже)
  let best = { x: camera.position.x, z: camera.position.z, y: camera.position.y, remote: null };
  let bd = Math.hypot(best.x - z.mesh.position.x, best.z - z.mesh.position.z);
  if (net.role === 'host') net.players.forEach(p => { const d = Math.hypot(p.x - z.mesh.position.x, p.z - z.mesh.position.z); if (d < bd) { bd = d; best = { x: p.x, z: p.z, y: p.y, remote: p }; } });
  return best;
}
function damageZombie(z, dmg) { // у клиента урон идёт хозяину комнаты
  z.hitT = 0.28; // вздрагивание при попадании
  if (net.role === 'client') { netSendTo(net.hostConn, { t: 'zh', id: z.id, d: dmg }); z.lastHit = performance.now(); return; }
  z.hp -= dmg;
}
function clientZombie(z, dt) {
  if (z.tx !== undefined) {
    const k = Math.min(1, 10 * dt);
    z.mesh.position.x += (z.tx - z.mesh.position.x) * k; z.mesh.position.z += (z.tz - z.mesh.position.z) * k;
    z.mesh.position.y = terrainY(z.mesh.position.x, z.mesh.position.z);
    let dr = z.try - z.mesh.rotation.y; dr = Math.atan2(Math.sin(dr), Math.cos(dr)); z.mesh.rotation.y += dr * k;
  }
  z.atkCd = (z.atkCd || 0) - dt; // у клиента о укусах не сообщают: замах, если зомби стоит вплотную к тебе
  if (!z.mv && z.atkCd <= 0 && Math.hypot(camera.position.x - z.mesh.position.x, camera.position.z - z.mesh.position.z) < 1.7 * Math.max(1, z.cfg.sx)) { z.attackT = ZOMBIE_ATTACK; z.atkCd = z.type === 'runner' ? 0.7 : 1; }
  animateZombie(z, !!z.mv, dt);
}
function applyZombieSnapshot(list) {
  const seen = new Set();
  for (const [id, x, zz, ry, hp, mv, ty] of list) {
    seen.add(id);
    let z = zombies.find(q => q.id === id);
    if (!z) { z = spawnZombie(x, zz, ty); z.id = id; }
    z.tx = x; z.tz = zz; z.try = ry; z.hp = hp; z.mv = mv;
  }
  for (let i = zombies.length - 1; i >= 0; i--) {
    if (seen.has(zombies[i].id)) continue;
    if (performance.now() - (zombies[i].lastHit || -1e9) < 2500) kills++; // зомби, которого добил ты
    startCorpse(zombies[i]); zombies.splice(i, 1);
  }
}

// Приём сообщений
function handleHostConn(conn) {
  conn.on('data', m => handleHostMsg(conn, m));
  conn.on('close', () => { if (conn.__pid) { removePlayer(conn.__pid); netBroadcast({ t: 'left', id: conn.__pid }); } });
}
function handleHostMsg(conn, m) {
  if (m.t === 'peek') { netSendTo(conn, { t: 'info', seed: WORLD_SEED, name: net.name, count: net.players.size + 1 }); return; }
  if (m.t === 'hello') {
    if (net.players.size >= 3) { netSendTo(conn, { t: 'full' }); return; }
    const id = 'p' + (net.nextId++);
    conn.__pid = id; net.conns.set(id, conn);
    const name = sanitizeName(m.name);
    upsertPlayer(id, name);
    const list = [{ id: 'p0', name: net.name }]; net.players.forEach(p => list.push({ id: p.id, name: p.name }));
    netSendTo(conn, { t: 'welcome', id, seed: WORLD_SEED, hour: gameHour, day, players: list });
    netBroadcast({ t: 'joined', id, name }, conn);
    addChat('', `${name} зашёл в игру`);
    return;
  }
  const pid = conn.__pid, p = pid ? net.players.get(pid) : null;
  if (!p) return;
  if (m.t === 'ps') { p.x = m.x; p.y = m.y; p.z = m.z; p.yaw = m.yaw; p.w = m.w; p.mv = m.mv; p.hp = m.hp; p.pt = m.pt || 0; p.sp = m.sp || 0; p.sc = m.sc || 0; p.ac = m.ac || 0; }
  else if (m.t === 'zh') { const z = zombies.find(q => q.id === m.id); if (z) z.hp -= Math.min(5, m.d || 0); }
  else if (m.t === 'chat') { const text = String(m.text || '').slice(0, 120); addChat(p.name, text); netBroadcast({ t: 'chat', name: p.name, text }); }
}
function handleClientMsg(m) {
  if (m.t === 'welcome') {
    if (m.seed !== WORLD_SEED) { setMpStatus('Мир не совпал, попробуй подключиться ещё раз'); return; }
    net.id = m.id; net.role = 'client'; net.active = true;
    startGame(true, false);
    gameHour = m.hour; day = m.day;
    camera.position.set(1.5 * (parseInt(m.id.slice(1), 10) || 1), 1.7, 0);
    m.players.forEach(pl => { if (pl.id !== net.id) upsertPlayer(pl.id, pl.name); });
    notify('Подключено! Enter - чат. Мир общий: зомби и игроки, лут пока у каждого свой');
  }
  else if (m.t === 'full') setMpStatus('В комнате нет мест (максимум 4 игрока)');
  else if (m.t === 'pl') {
    const ids = new Set();
    m.list.forEach(e => { if (e.id === net.id) return; ids.add(e.id); const p = upsertPlayer(e.id, e.name); p.x = e.x; p.y = e.y; p.z = e.z; p.yaw = e.yaw; p.w = e.w; p.mv = e.mv; p.hp = e.hp; p.pt = e.pt || 0; p.sp = e.sp || 0; p.sc = e.sc || 0; p.ac = e.ac || 0; });
    [...net.players.keys()].forEach(id => { if (!ids.has(id)) removePlayer(id); });
  }
  else if (m.t === 'zs') applyZombieSnapshot(m.list);
  else if (m.t === 'time') { gameHour = m.hour; day = m.day; }
  else if (m.t === 'chat') addChat(m.name, m.text);
  else if (m.t === 'joined') { upsertPlayer(m.id, m.name); addChat('', `${m.name} зашёл в игру`); }
  else if (m.t === 'left') removePlayer(m.id);
  else if (m.t === 'hurt') { if (health > 0) health -= m.d; }
  else if (m.t === 'boom') toxicPuffs(m.x, m.z);
}
function onHostLost() {
  if (!net.active) return;
  net.active = false; net.role = null; net.hostConn = null;
  net.players.forEach(p => { if (p.av) scene.remove(p.av.g); }); net.players.clear();
  notify('Связь с хозяином комнаты потеряна. Дальше игра идёт одиночная');
}

// Создание комнаты и вход
function hostCreate(name) {
  if (!window.Peer) return setMpStatus('Библиотека PeerJS не найдена. Выполни: npm install peerjs');
  net.name = sanitizeName(name); mpNameVal = net.name;
  setMpStatus('Создаю комнату...');
  const tryId = attempt => {
    const code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    const peer = new window.Peer('dz-' + code);
    peer.on('open', () => {
      net.peer = peer; net.code = code; net.role = 'host'; net.active = true; net.id = 'p0';
      startGame(true, true);
      notify('Комната создана. Код: ' + code + ' (виден справа вверху). Enter - чат');
    });
    peer.on('connection', handleHostConn);
    peer.on('error', err => {
      if (err.type === 'unavailable-id' && attempt < 5) tryId(attempt + 1);
      else if (!net.active) setMpStatus('Не удалось создать комнату: ' + err.type);
    });
  };
  tryId(0);
}
function peekRoom(code, name) { // сначала узнаём зерно мира хозяина, потом перезагружаемся с ним
  if (!window.Peer) return setMpStatus('Библиотека PeerJS не найдена. Выполни: npm install peerjs');
  code = String(code || '').trim().toUpperCase();
  if (!code) return setMpStatus('Введи код комнаты');
  setMpStatus('Ищу комнату...');
  const peer = new window.Peer();
  let done = false;
  const fail = msg => { if (done) return; done = true; try { peer.destroy(); } catch (e) { /* уже закрыт */ } setMpStatus(msg); };
  const timer = setTimeout(() => fail('Комната не отвечает. Проверь код'), 12000);
  peer.on('error', err => { clearTimeout(timer); fail('Ошибка соединения: ' + err.type); });
  peer.on('open', () => {
    const conn = peer.connect('dz-' + code, { reliable: true, serialization: 'json' });
    conn.on('open', () => conn.send({ t: 'peek' }));
    conn.on('data', m => {
      if (m.t !== 'info' || done) return;
      done = true; clearTimeout(timer);
      try { peer.destroy(); } catch (e) { /* уже закрыт */ }
      if (m.seed === WORLD_SEED) joinRoom(code, name, false); // мир уже тот же, перезагрузка не нужна
      else { try { localStorage.setItem('dz_boot', JSON.stringify({ seed: m.seed, mp: { code, name: sanitizeName(name) } })); location.reload(); } catch (e) { setMpStatus('Не удалось перезапустить игру'); } }
    });
  });
}
function joinRoom(code, name, auto) {
  net.name = sanitizeName(name); net.code = code;
  setMpStatus('Подключаюсь...');
  const peer = new window.Peer();
  net.peer = peer;
  peer.on('error', err => { if (!net.active) { setMpStatus('Не удалось подключиться: ' + err.type); mainMenu.style.display = 'flex'; renderMainMenu('mp'); } });
  peer.on('open', () => {
    const conn = peer.connect('dz-' + code, { reliable: true, serialization: 'json' });
    net.hostConn = conn;
    conn.on('open', () => conn.send({ t: 'hello', name: net.name }));
    conn.on('data', handleClientMsg);
    conn.on('close', onHostLost);
  });
}

// Каждый кадр: отправка своего состояния, зомби и времени; аватары
function netTick(dt) {
  if (!net.active) { mpHud.style.display = 'none'; return; }
  net.tPlayers += dt; net.tZombies += dt; net.tTime += dt; net.tHud += dt;
  if (net.role === 'host') {
    if (net.tPlayers >= 0.08) {
      net.tPlayers = 0;
      const list = [Object.assign({ id: 'p0', name: net.name }, ownState())];
      net.players.forEach(p => list.push({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, w: p.w, mv: p.mv, hp: p.hp, pt: p.pt, sp: p.sp, sc: p.sc, ac: p.ac }));
      netBroadcast({ t: 'pl', list });
    }
    if (net.tZombies >= 0.1) {
      net.tZombies = 0;
      netBroadcast({ t: 'zs', list: zombies.map(z => [z.id, +z.mesh.position.x.toFixed(2), +z.mesh.position.z.toFixed(2), +z.mesh.rotation.y.toFixed(2), z.hp, z.mv ? 1 : 0, z.type]) });
    }
    if (net.tTime >= 2) { net.tTime = 0; netBroadcast({ t: 'time', hour: gameHour, day }); }
  } else if (net.role === 'client' && net.hostConn && net.tPlayers >= 0.08) {
    net.tPlayers = 0; netSendTo(net.hostConn, Object.assign({ t: 'ps' }, ownState()));
  }
  updateAvatars(dt);
  if (net.tHud >= 1) {
    net.tHud = 0;
    mpHud.style.display = gameStarted ? 'block' : 'none';
    const names = [net.name + ' (ты)']; net.players.forEach(p => names.push(p.name));
    mpHud.textContent = (net.role === 'host' ? 'Код комнаты: ' + net.code + '\n' : '') + 'Игроки: ' + names.join(', ') + '\nEnter - чат';
  }
}

// --- Админ-панель: Настройки -> Админ-панель, пароль 1234 (это замок от случайного входа, а не настоящая защита) ---
const ADMIN_PASSWORD = '1234';
const admin = { on: false, fly: false, noclip: false, god: false, infAmmo: false, infFuel: false, turbo: false, fastChop: false, freeBuild: false, freeCraft: false, noZombies: false, freezeTime: false, debug: false, speedMul: 1, flySpeed: 1 };
const ADM_LABELS = { fly: 'Полёт', noclip: 'Сквозь стены', god: 'Бессмертие', infAmmo: 'Бесконечные патроны', infFuel: 'Бесконечный бензин', turbo: 'Турбо мотоцикла', fastChop: 'Мгновенная рубка', freeBuild: 'Бесплатная стройка', freeCraft: 'Бесплатный крафт', noZombies: 'Без зомби', freezeTime: 'Заморозить время', debug: 'Отладка (координаты, FPS)' };
const ADM_FMT = {
  speedMul: v => v.toFixed(2) + 'x', flySpeed: v => v.toFixed(1) + 'x',
  hour: v => String(Math.floor(v)).padStart(2, '0') + ':' + String(Math.floor((v % 1) * 60)).padStart(2, '0'),
};
let adminMsg = '', fpsSmooth = 60;
const adm = k => admin.on && admin[k];
const dbgEl = document.createElement('div'); // отладочная строка внизу слева
dbgEl.style.cssText = 'position:fixed;left:10px;bottom:10px;color:#9fe870;font:14px monospace;text-shadow:1px 1px 2px #000;background:rgba(0,0,0,.45);padding:3px 8px;border-radius:4px;display:none';
document.body.appendChild(dbgEl);
const front = d => ({ x: camera.position.x - Math.sin(yaw) * d, z: camera.position.z - Math.cos(yaw) * d });

function adminAction(act, arg, arg2) {
  if (act === 'admlogin') {
    const el = document.getElementById('admpass');
    if (el && el.value === ADMIN_PASSWORD) { admin.on = true; adminMsg = ''; menuTab = 'admin'; notify('Админ-панель открыта'); }
    else adminMsg = 'Неверный пароль';
    return;
  }
  if (!admin.on) return;
  if (act === 'admlogout') {
    Object.keys(admin).forEach(k => { if (typeof admin[k] === 'boolean') admin[k] = false; });
    admin.speedMul = 1; admin.flySpeed = 1; menuTab = 'settings'; return;
  }
  if (act === 'admopen') { menuTab = 'admin'; return; }
  if (act === 'admtog') {
    admin[arg] = !admin[arg];
    if (arg === 'noZombies') {
      if (admin.noZombies) zombies.forEach(z => { z.hp = 0; });
      else for (let i = zombies.length; i < 12; i++) spawnZombie();
    }
    return;
  }
  if (act === 'admgive') {
    const n = arg2 === 'max' ? ITEMS[arg].stack : parseInt(arg2);
    const left = addItem(arg, n);
    notify(left ? 'Инвентарь полон' : 'Выдано: ' + ITEMS[arg].name + ' x' + n);
    return;
  }
  if (act === 'admweapon') {
    if (arg === 'shotgun' || arg === 'all') { hasShotgun = true; sgReserve += 20; weapon = 'shotgun'; drawT = 0; }
    if (arg === 'axe' || arg === 'all') { hasAxe = true; if (arg === 'axe') { weapon = 'axe'; drawT = 0; } }
    if (arg === 'ak' || arg === 'all') { hasAK = true; akReserve += 90; if (arg === 'ak') { weapon = 'ak'; drawT = 0; } }
    notify('Оружие выдано');
    return;
  }
  if (act === 'admammo') {
    if (arg === 'pistol') reserve += 50; else if (arg === 'ak') { hasAK = true; akReserve += 90; } else { hasShotgun = true; sgReserve += 50; }
    notify('+50 патронов');
    return;
  }
  if (act === 'admheal') { health = 100; hunger = 100; thirst = 100; notify('Здоровье, еда и вода восстановлены'); return; }
  if (act === 'admclear') { slots.fill(null); notify('Инвентарь очищен'); return; }
  if (act === 'admtime') { gameHour = parseFloat(arg); return; }
  if (act === 'admzombie') {
    if (arg === 'kill') { zombies.forEach(z => { z.hp = 0; }); return notify('Зомби убиты'); }
    if (inBasement) return notify('В подвале зомби не нужны');
    if (arg === 't') { const a = Math.random() * 6.283; spawnZombie(camera.position.x + Math.cos(a) * 10, camera.position.z + Math.sin(a) * 10, arg2); return notify('Зомби: ' + (ZTYPES[arg2] ? ZTYPES[arg2].name : '?')); }
    for (let i = 0; i < parseInt(arg); i++) {
      const a = Math.random() * 6.283, r = 8 + Math.random() * 8;
      spawnZombie(camera.position.x + Math.cos(a) * r, camera.position.z + Math.sin(a) * r);
    }
    notify('Зомби добавлены рядом');
    return;
  }
  if (act === 'admbike') {
    if (arg === 'spawn' || arg === 'come') {
      if (riding) return notify('Ты уже на мотоцикле');
      const p = front(2.6); resolveCollisions(p, 0.9);
      if (!bike) { spawnBike(p.x, p.z, yaw); bike.fuel = 100; }
      else {
        if (bike.collider) { removeFrom(colliders, bike.collider); bike.collider = null; }
        bike.rig.root.position.set(p.x, 0, p.z); bike.heading = yaw; bike.v = 0;
        parkBikeCollider();
      }
      notify('Мотоцикл рядом (E - сесть)');
    } else if (!bike) return notify('Мотоцикла нет');
    else if (arg === 'fuel') { bike.fuel = 100; notify('Бак полный'); }
    else if (arg === 'remove') {
      if (riding) dismountBike();
      if (bike.collider) removeFrom(colliders, bike.collider);
      scene.remove(bike.rig.root); bike = null; notify('Мотоцикл убран');
    }
    return;
  }
  if (act === 'admcar') {
    if (riding && drive === 'car' && arg !== 'fuel') return notify('Сначала выйди из джипа');
    const nearest = () => { let b = null, bd = 1e9; cars.forEach(c => { const d = Math.hypot(c.rig.root.position.x - camera.position.x, c.rig.root.position.z - camera.position.z); if (d < bd) { bd = d; b = c; } }); return b; };
    if (arg === 'spawn') { const p = front(4.5); resolveCollisions(p, 1.5); spawnCar(p.x, p.z, yaw, 100); notify('Джип рядом (E - сесть)'); }
    else if (arg === 'come') {
      const c = nearest(); if (!c) return notify('Джипов нет');
      const p = front(4.5); resolveCollisions(p, 1.5);
      if (c.collider) { removeFrom(colliders, c.collider); c.collider = null; }
      c.rig.root.position.set(p.x, 0, p.z); c.heading = yaw; c.v = 0; parkCarCollider(c); notify('Джип притянут');
    } else if (arg === 'fuel') { const c = riding && drive === 'car' ? curCar : nearest(); if (c) { c.fuel = 100; notify('Джип заправлен'); } else notify('Джипов нет'); }
    else if (arg === 'remove') {
      const c = nearest(); if (!c) return notify('Джипов нет');
      if (c.collider) removeFrom(colliders, c.collider);
      scene.remove(c.rig.root); removeFrom(cars, c); notify('Джип убран');
    }
    return;
  }
  if (act === 'admworld') {
    if (arg === 'cases') { cases.forEach(c => { if (c.state === 'closed') { c.state = 'opening'; c.t = 0; } }); notify('Все ящики открываются'); }
    else if (arg === 'case') { const p = front(4); spawnCase(p.x, p.z, 0, true); notify('Ящик поставлен впереди'); }
    else if (arg === 'resources') {
      const kinds = [['wood', 5], ['wood', 5], ['scrap', 3], ['scrap', 3], ['rubber', 3], ['rubber', 3]];
      kinds.forEach(([t, n], i) => { const a = i / kinds.length * 6.283; spawnPile(t, camera.position.x + Math.cos(a) * 5, camera.position.z + Math.sin(a) * 5, n, true); });
      ['food', 'water', 'medkit', 'fuel'].forEach((t, i) => { const a = i / 4 * 6.283 + 0.4; spawnItem(t, camera.position.x + Math.cos(a) * 3, camera.position.z + Math.sin(a) * 3, true); });
      notify('Ресурсы рассыпаны вокруг');
    } else if (arg === 'bench' || arg === 'fire') {
      const keep = admin.freeBuild; admin.freeBuild = true; selPiece = arg; placePiece(); admin.freeBuild = keep;
    }
    return;
  }
  if (act === 'admtp') {
    if (riding) return notify('Сначала слезь с мотоцикла');
    const tp = (x, z) => teleport(x, z, null, false, yaw);
    if (arg === 'home') tp(0, 6);
    else if (arg === 'w1' || arg === 'w2') { const w = warehouses[arg === 'w1' ? 0 : 1]; if (w) tp(w.x, w.z + 9); else notify('Такого склада нет'); }
    else if (arg === 'b1' || arg === 'b2') { const w = warehouses[arg === 'b1' ? 0 : 1]; if (w) teleport(w.ladderX - 1.4, w.ladderZ, w, true, Math.PI / 2); else notify('Такого склада нет'); }
    else if (arg === 'case') {
      let best = null, bd = 1e9;
      cases.forEach(c => { const d = Math.hypot(c.x - camera.position.x, c.z - camera.position.z); if (c.state !== 'empty' && d < bd) { bd = d; best = c; } });
      if (best) tp(best.x, best.z + 3); else notify('Ящиков нет');
    } else if (arg === 'bike') { if (bike) tp(bike.rig.root.position.x + 2, bike.rig.root.position.z + 2); else notify('Мотоцикла нет'); }
    else if (arg === 'gs') { const g = stations[0]; if (g) tp(g.x, g.z + 13); else notify('Заправки нет'); }
    else if (arg === 'gar') { const g = garages[0]; if (g) tp(g.x, g.z + 12); else notify('Гаража нет'); }
    else if (arg === 'wt') { const t = towers[0]; if (t) tp(t.x + 6, t.z + 6); else notify('Башни нет'); }
    else if (arg === 'op') { const o = outposts[0]; if (o) tp(o.x, o.z + 17); else notify('Блокпоста нет'); }
    else if (arg === 'ar') { const a = armories[0]; if (a) tp(a.x, a.z + 9); else notify('Арсенала нет'); }
    else if (arg === 'car') { const c = cars[0]; if (c) tp(c.rig.root.position.x + 3, c.rig.root.position.z + 3); else notify('Джипов нет'); }
    return;
  }
}

// Управление
addEventListener('keydown', e => {
  if (!gameStarted || cutscenes.cut.active) return;
  if (chatOpen) return;                                   // печатаем сообщение
  if (net.active && e.code === 'Enter' && !menuOpen) { e.preventDefault(); openChat(); return; }
  if (e.code === 'Tab') { e.preventDefault(); toggleMenu(!menuOpen); return; }
  if (menuOpen) { if (e.code === 'Escape') toggleMenu(false); return; }
  keys[e.code] = true;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'KeyB' && !riding) buildMode = !buildMode;
  if (e.code === 'KeyC' && riding) camView = camView === 'fp' ? 'chase' : 'fp';
  if (buildMode) {
    if (e.code >= 'Digit1' && e.code <= 'Digit8') selPiece = pieceKeys[+e.code.slice(5) - 1];
    if (e.code === 'KeyQ') rot = (rot + 1) % 4;
    if (e.code === 'KeyV') removePiece();
  } else {
    if (e.code >= 'Digit1' && e.code <= 'Digit5') useSlot(+e.code.slice(5) - 1); // быстрые слоты
    if (e.code === 'KeyZ') craft('ammo');
    if (e.code === 'KeyX') craft('medkit');
    if (e.code === 'KeyQ') switchWeapon();
  }
  if (e.code === 'KeyE') interact();
  if (e.code === 'KeyF') {
    if (riding) { if (drive === 'car' && curCar) curCar.light = !curCar.light; else if (bike) bike.light = !bike.light; } // фары
    else { flashOn = !flashOn; flash.intensity = flashOn ? 25 : 0; }
  }
});
addEventListener('keyup', e => keys[e.code] = false);
renderer.domElement.addEventListener('click', () => {
  if (!gameStarted || cutscenes.cut.active) return;
  if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
  else if (buildMode) placePiece();
  else if (weapon !== 'ak') attack();
});
renderer.domElement.addEventListener('mousedown', e => { if (e.button === 0 && document.pointerLockElement === renderer.domElement) mouseDown = true; });
addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; });
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.002 * SETTINGS.sens;
  pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.002 * SETTINGS.sens));
});

// Стрельба (пули останавливаются о стены и деревья)
const raycaster = new THREE.Raycaster();
function switchWeapon() { // клавиша Q
  if (riding) return;
  const owned = ['pistol'];
  if (hasShotgun) owned.push('shotgun');
  if (hasAxe) owned.push('axe');
  if (hasAK) owned.push('ak');
  if (owned.length < 2 || reloading || sgReloading || akReloading || sgRacking || swingT >= 0 || cool > 0.3) return;
  weapon = owned[(owned.indexOf(weapon) + 1) % owned.length];
  drawT = 0;
}

function startReload() { // клавиша R
  if (health <= 0 || menuOpen || riding || weapon === 'axe') return;
  if (weapon === 'shotgun') { // дробовик заряжается по одному патрону
    if (sgReloading || sgRacking || sgAmmo >= SG_MAG) return;
    if (sgReserve <= 0) return notify('Нет патронов для дробовика');
    sgReloading = true; sgRT = 0; sgLoadedIn = -1; sgReloadN = Math.min(SG_MAG - sgAmmo, sgReserve);
    return;
  }
  if (weapon === 'ak') {
    if (akReloading || akAmmo >= AK_MAG) return;
    if (akReserve <= 0) return notify('Нет патронов для АК');
    akReloading = true; akRT = 0; akLoaded = false;
    return;
  }
  if (reloading) return;
  if (ammo >= MAG && !lock) return;
  if (reserve <= 0) return notify('Нет запасных патронов');
  reloading = true; rT = 0; loaded = false; lockAtStart = lock;
}

function startSwing() { // ЛКМ с топором: замах, удар, возврат
  if (swingT >= 0) return;
  swingT = 0; swingHitDone = false; cool = 0.6; axeCount++;
}
function axeHit() { // момент удара: дерево перед тобой и зомби рядом
  chopCd = 0; chop(true);
  const fwd2 = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  for (const w of warehouses) { // удар по заколоченному люку
    if (inBasement || w.state !== 'closed') continue;
    const dx = w.hx - camera.position.x, dz = w.hz - camera.position.z, d = Math.hypot(dx, dz);
    if (d < 3.6 && (d < 1.4 || (dx / d) * fwd2.x + (dz / d) * fwd2.z > 0.45)) { hitHatch(w); break; }
  }
  for (const z of zombies) {
    const to = z.mesh.position.clone().sub(camera.position).setY(0);
    const d = to.length();
    if (d < 2.6 && to.normalize().dot(fwd2) > 0.6) { damageZombie(z, 2); z.mesh.position.addScaledVector(to, 0.8); }
  }
  kick += 0.03;
}

function attackShotgun() { // 6 дробинок с разбросом
  if (sgReloading) { if (sgAmmo <= 0) return; sgReloading = false; sgLhBlend = 1; } // выстрел прерывает заряжание
  if (sgAmmo <= 0) return notify('Дробовик пуст, нажми R');
  sgAmmo--; shotCount++;
  cool = 0.95; sgRecoil = 1; kick += 0.05; sgFlashT = 0.08;
  sgRacking = true; sgRackT = 0; sgClack1 = false;
  for (let i = 0; i < 6; i++) {
    raycaster.setFromCamera(new THREE.Vector2((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08), camera);
    const zHits = raycaster.intersectObjects(zombies.map(z => z.mesh), true);
    if (!zHits.length || zHits[0].distance > 22) continue;
    const wallHits = raycaster.intersectObjects(blockers, false);
    if (wallHits.length && wallHits[0].distance < zHits[0].distance) continue;
    const z = zombieOf(zHits[0].object);
    if (z) damageZombie(z, hitDamage(z, zHits[0].point.y));
  }
}

function attackAK() { // автомат: очередь при зажатой кнопке мыши
  if (akReloading) return;
  if (akAmmo <= 0) { if (noticeT <= 0) notify('Магазин пуст, нажми R'); return; }
  akAmmo--; shotCount++;
  cool = 0.1; akRecoil = 1; kick += 0.009; akFlashT = 0.05;
  raycaster.setFromCamera(new THREE.Vector2((Math.random() - 0.5) * 0.014, (Math.random() - 0.5) * 0.014), camera);
  const zHits = raycaster.intersectObjects(zombies.map(z => z.mesh), true);
  if (!zHits.length) return;
  const wallHits = raycaster.intersectObjects(blockers, false);
  if (wallHits.length && wallHits[0].distance < zHits[0].distance) return;
  const z = zombieOf(zHits[0].object);
  if (z) damageZombie(z, hitDamage(z, zHits[0].point.y));
}

function attack() {
  if (health <= 0 || riding || sleeping || cool > 0 || drawT < 0.7) return;
  if (weapon === 'shotgun') return attackShotgun();
  if (weapon === 'axe') return startSwing();
  if (weapon === 'ak') return attackAK();
  if (reloading) return;
  if (ammo <= 0) return notify('Магазин пуст, нажми R');
  ammo--; shotCount++;
  cool = 0.22; recoil = 1; kick += 0.02; mzT = 0.06; slidePulse = 1; // отдача, вспышка, затвор
  if (ammo === 0) lock = true;                                       // затвор остаётся отведённым

  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const zHits = raycaster.intersectObjects(zombies.map(z => z.mesh), true);
  if (!zHits.length) return;
  const wallHits = raycaster.intersectObjects(blockers, false);
  if (wallHits.length && wallHits[0].distance < zHits[0].distance) return; // пуля попала в стену

  const z = zombieOf(zHits[0].object);
  if (z) damageZombie(z, hitDamage(z, zHits[0].point.y)); // в голову урон x2
}

// --- Экран смерти: раньше нужно было жать F5, но в собранной игре (Electron, меню отключено) F5 не работает ---
const deathScreen = document.createElement('div');
deathScreen.style.cssText = 'position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;font:18px monospace;color:#fff;z-index:30;background:rgba(60,0,0,.6)';
document.body.appendChild(deathScreen);
let deathShown = false;
function showDeathScreen() {
  deathShown = true;
  try { document.exitPointerLock(); } catch (e) { /* курсор и так свободен */ }
  const last = parseInt(lsGet('dz_lastSlot') || '0', 10), sv = last ? readSaves()[last] : null;
  const canLoad = !net.active && sv && sv.v === 2;
  const B = (label, act) => `<button data-death="${act}" style="font:inherit;font-size:20px;color:#fff;width:320px;padding:12px;margin:6px;border:2px solid #7a3a3a;border-radius:8px;background:#3a2424;cursor:pointer">${label}</button>`;
  deathScreen.innerHTML = `<div style="font-size:64px;letter-spacing:8px;color:#e05a4a;text-shadow:0 4px 12px #000">ТЫ УМЕР</div>` +
    `<div style="opacity:.85;margin:10px 0 22px">День ${day} · убито зомби: ${kills}</div>` +
    (canLoad ? B(`Загрузить сохранение (слот ${last})`, 'load') : '') + B('В главное меню', 'menu');
  deathScreen.style.display = 'flex';
}
deathScreen.addEventListener('click', e => {
  const t = e.target.closest('[data-death]'); if (!t) return;
  if (t.dataset.death === 'load') {
    const last = parseInt(lsGet('dz_lastSlot') || '0', 10), sv = readSaves()[last];
    if (sv && sv.v === 2) { try { localStorage.setItem('dz_boot', JSON.stringify({ seed: sv.seed, slot: last })); } catch (err) { /* без сохранения откроется меню */ } }
  }
  location.reload();
});

// --- Цикл ---
const clock = new THREE.Clock();
function loop() {
  const rawDt = clock.getDelta();
  const dt = ((menuOpen && !net.active) || sleeping || !gameStarted || cutscenes.cut.active) ? 0 : Math.min(rawDt, 0.1); // в меню и во сне игра на паузе
  if (rawDt > 0) fpsSmooth = fpsSmooth * 0.95 + (1 / rawDt) * 0.05;
  if (adm('god')) { health = 100; hunger = 100; thirst = 100; }
  if (adm('infAmmo')) { ammo = MAG; sgAmmo = SG_MAG; reserve = Math.max(reserve, 30); if (hasShotgun) sgReserve = Math.max(sgReserve, 30); akAmmo = AK_MAG; if (hasAK) akReserve = Math.max(akReserve, 60); }

  // День и ночь
  if (!adm('freezeTime')) { const prevH = gameHour; gameHour = (gameHour + dt * 0.1) % 24; if (gameHour < prevH) day++; }
  const ang = (gameHour - 6) / 24 * Math.PI * 2;
  daylight = Math.max(0, Math.min(1, (Math.sin(ang) + 0.2) / 0.6));
  {
    const px = camera.position.x, pz = camera.position.z; // солнце и его тени следуют за игроком
    sun.position.set(px + Math.cos(ang) * 40, Math.max(9, Math.sin(ang) * 40), pz + 12);
    sun.target.position.set(px, 0, pz); sun.target.updateMatrixWorld();
  }
  sun.intensity = 1.5 * daylight;
  hemi.intensity = 0.12 + 1.08 * daylight;
  const elev = Math.sin(ang), warm = clamp(1 - Math.abs(elev - 0.08) / 0.32, 0, 1) * (elev > -0.25 ? 1 : 0); // рассвет и закат
  skyTop.copy(SKY_NIGHT_TOP).lerp(SKY_DAY_TOP, daylight).lerp(SKY_WARM_TOP, warm * 0.35);
  skyBot.copy(SKY_NIGHT_BOT).lerp(SKY_DAY_BOT, daylight).lerp(SKY_WARM_BOT, warm * 0.75);
  skyMat.uniforms.top.value.copy(skyTop); skyMat.uniforms.bottom.value.copy(skyBot);
  skyMat.uniforms.sunDir.value.set(Math.cos(ang) * 40, Math.sin(ang) * 40, 12).normalize();
  skyMat.uniforms.sunCol.value.setRGB(1.0, 0.85 - warm * 0.25, 0.6 - warm * 0.3).multiplyScalar(daylight);
  skyMat.uniforms.night.value = 1 - daylight;
  sky.position.copy(camera.position);
  scene.background.copy(skyBot); scene.fog.color.copy(skyBot);
  scene.fog.near = 12; scene.fog.far = (55 + 70 * daylight) * SETTINGS.fog;
  hemi.color.copy(skyTop).lerp(WHITE, 0.45); hemi.groundColor.setRGB(0.24, 0.27, 0.2);
  sun.color.setRGB(1, 0.94 - warm * 0.3, 0.84 - warm * 0.5);
  if (inBasement && curW) { // подвал: темно, светят только лампа и фонарик
    hemi.intensity = 0.3; sun.intensity = 0;
    scene.background.setRGB(0.01, 0.01, 0.012); scene.fog.color.setRGB(0.01, 0.01, 0.012); scene.fog.near = 3; scene.fog.far = 28;
    sky.visible = false;
    basementLamp.position.set(curW.bx, 2.6, curW.bz);
    basementLamp.intensity = 26 + Math.sin(gunT * 9) * 2 + Math.random() * 3;
  } else { sky.visible = true; basementLamp.intensity = 0; }
  updateClouds(dt);

  if (health > 0 && !cutscenes.cut.active) {
    if (!riding) {
      const flying = adm('fly');
      const wet = !flying && terrainY(camera.position.x, camera.position.z) < WATER_Y - 0.3; // глубже колена: плывём медленнее и не бежим
      const speed = flying ? (keys.ShiftLeft ? 18 : 9) * dt * admin.flySpeed : (keys.ShiftLeft && !wet ? 8 : 4.5) * dt * (wet ? 0.55 : 1) * (adm('speedMul') ? admin.speedMul : 1);
      if (wet && pitch < -0.8 && thirst < 100) { thirst = Math.min(100, thirst + 14 * dt); if (!window.__drinkT || performance.now() - window.__drinkT > 4000) { window.__drinkT = performance.now(); notify('Ты пьёшь воду из озера'); } } // посмотри вниз, стоя в воде: пьёшь
      const fwd = flying
        ? new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
        : new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      if (keys.KeyW) camera.position.addScaledVector(fwd, speed);
      if (keys.KeyS) camera.position.addScaledVector(fwd, -speed);
      if (keys.KeyD) camera.position.addScaledVector(right, speed);
      if (keys.KeyA) camera.position.addScaledVector(right, -speed);
      if (flying) { // Пробел - вверх, C - вниз
        if (keys.Space) camera.position.y += speed;
        if (keys.KeyC) camera.position.y -= speed;
        const floorY = terrainY(camera.position.x, camera.position.z) + 0.5;
        if (camera.position.y < floorY) camera.position.y = floorY;
      } else { // ходьба по земле, ступеням и крышам-полам; падение вниз
        const ty = 1.7 + surfaceAt(camera.position.x, camera.position.z, camera.position.y - 1.7);
        if (ty > camera.position.y) { camera.position.y += Math.min(ty - camera.position.y, 14 * dt); fallV = 0; }
        else { fallV = Math.min(fallV + 22 * dt, 25); camera.position.y = Math.max(ty, camera.position.y - fallV * dt); if (camera.position.y <= ty + 0.0001) fallV = 0; }
      }
      if (!adm('noclip') && !(flying && camera.position.y > 8)) resolveCollisions(camera.position, 0.4);
      camera.position.x = clamp(camera.position.x, -WORLD_WALK, WORLD_WALK); camera.position.z = clamp(camera.position.z, -WORLD_WALK, WORLD_WALK); // край мира: горы
    }

    // Голод и жажда
    hunger = Math.max(0, hunger - 0.4 * dt);
    thirst = Math.max(0, thirst - 0.6 * dt);
    if (hunger <= 0 || thirst <= 0) health -= 2 * dt;          // урон от голода/жажды
    else if (hunger > 70 && thirst > 70) health = Math.min(100, health + 0.5 * dt); // медленное лечение
  }
  if (bike && rb() && health > 0) updateBike(dt);
  if (curCar && riding && drive === 'car' && health > 0) updateCar(dt);
  camera.rotation.set(pitch + kick, yaw, 0);
  if (bike) updateBikeVisuals(dt);
  updateCarVisuals(dt);
  { const dv = riding ? (drive === 'car' ? curCar : bike) : null; bikeSound(!!dv && dv.on && health > 0, dv ? dv.rpm : 0, dv ? dv.gas : 0); }
  updatePuffs(dt);
  updateBikeCamera();
  updateCarCamera();
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
    { const dd = Math.pow(1 - drawT, 3); py -= dd * 0.4; rx -= dd * 0.7; } // достаём пистолет
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

  // Анимация дробовика: помпа, гильзы, заряжание по одному патрону
  drawT = Math.min(1, drawT + dt * 2.6);
  sgRecoil *= Math.exp(-dt * 9); sgFlashT = Math.max(0, sgFlashT - dt);
  {
    let off = 0;
    if (sgRacking) { // после выстрела помпа уезжает назад (гильза вылетает) и возвращается
      sgRackT += dt;
      const u = clamp((sgRackT - 0.22) / 0.6, 0, 1);
      off = 0.11 * Math.sin(u * Math.PI);
      if (u >= 0.45 && !sgClack1) { sgClack1 = true; ejectCasing(); }
      if (sgRackT >= 0.82) sgRacking = false;
    }
    sg.pump.position.z = sg.PUMP_Z + off;
    const follow = _sgFollow.set(0, 0, sg.PUMP_Z + off);
    const lh = _sgLh.copy(follow);
    let tiltR = 0, carry = false;
    if (sgReloading) {
      sgRT += dt;
      const inner = sgReloadN * 0.55, total = 0.3 + inner + 0.3;
      if (sgRT < 0.3) { const k = sstep(0, 1, sgRT / 0.3); lh.lerpVectors(follow, SG_B, k); tiltR = k; }
      else if (sgRT < 0.3 + inner) {
        const tt = sgRT - 0.3, c = Math.floor(tt / 0.55), u = (tt - c * 0.55) / 0.55;
        tiltR = 1;
        if (u < 0.45) { lh.lerpVectors(SG_B, SG_P0, sstep(0, 1, u / 0.45)); carry = true; }
        else if (u < 0.6) {
          lh.lerpVectors(SG_P0, SG_P1, Math.sin(((u - 0.45) / 0.15) * Math.PI)); carry = u < 0.55;
          if (u >= 0.5 && sgLoadedIn !== c) { sgLoadedIn = c; sgAmmo++; sgReserve--; }
        } else { lh.lerpVectors(SG_P0, SG_B, sstep(0, 1, (u - 0.6) / 0.4)); carry = u > 0.88; }
      } else { const k = sstep(0, 1, (sgRT - 0.3 - inner) / 0.3); lh.lerpVectors(SG_B, follow, k); tiltR = 1 - k; }
      sgLastLh.copy(lh);
      if (sgRT >= total) sgReloading = false;
    } else if (sgLhBlend > 0.01) {
      sgLhBlend *= Math.exp(-dt * 10);
      lh.lerpVectors(follow, sgLastLh, sgLhBlend);
    }
    sg.leftHand.position.copy(lh);
    sg.shellCarry.visible = carry;
    let px = 0.2, py = -0.24, pz = -0.42, rx = 0, rz = 0;
    px += Math.sin(gunT * 0.8) * 0.003; py += Math.sin(gunT * 1.6) * 0.004;
    if (health > 0 && (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD)) {
      const st = gunT * (keys.ShiftLeft ? 12 : 9);
      px += Math.sin(st) * 0.012; py += Math.abs(Math.cos(st)) * 0.014 - 0.007; rz += Math.sin(st) * 0.02;
    }
    const dd = Math.pow(1 - drawT, 3); py -= dd * 0.45; rx -= dd * 0.7;
    pz += sgRecoil * 0.1; rx += sgRecoil * 0.26; py += sgRecoil * 0.012;
    rz -= tiltR * 0.5; rx -= tiltR * 0.08; px -= tiltR * 0.03; py -= tiltR * 0.03;
    sgun.position.set(px, py, pz);
    sgun.rotation.set(rx, 0.12, rz);
    sgFlashG.visible = sgFlashT > 0;
    sgLight.intensity = sgFlashT > 0 ? 10 : 0;
    if (sgFlashT > 0) sgFlashG.rotation.z = Math.random() * 6;
  }

  // Анимация топора: замах, удар по дереву, возврат
  {
    let px = 0.26, py = -0.5, pz = -0.5, rx = -0.35, rz = 0.3;
    px += Math.sin(gunT * 0.8) * 0.003; py += Math.sin(gunT * 1.6) * 0.005;
    if (health > 0 && (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD)) {
      const st = gunT * (keys.ShiftLeft ? 12 : 9);
      px += Math.sin(st) * 0.012; py += Math.abs(Math.cos(st)) * 0.014 - 0.007; rz += Math.sin(st) * 0.02;
    }
    if (swingT >= 0) {
      swingT += dt;
      if (!swingHitDone && swingT >= 0.3) { swingHitDone = true; axeHit(); }
      const w = sstep(0, 0.2, swingT), s = sstep(0.2, 0.32, swingT), r = sstep(0.36, 0.6, swingT);
      rx += 0.9 * w - 2.25 * s + 1.35 * r;
      py += 0.12 * w - 0.28 * s + 0.16 * r;
      pz += -0.18 * s + 0.18 * r;
      rz += -0.5 * s + 0.5 * r;
      if (swingT >= 0.6) swingT = -1;
    }
    const dd = Math.pow(1 - drawT, 3); py -= dd * 0.5; rx -= dd * 0.6;
    axeRig.position.set(px, py, pz);
    axeRig.rotation.set(rx, 0, rz);
  }

  // Анимация автомата: отдача, затвор, перезарядка с левой рукой
  akRecoil *= Math.exp(-dt * 12); akFlashT = Math.max(0, akFlashT - dt);
  if (menuOpen) mouseDown = false;
  if (mouseDown && weapon === 'ak' && !menuOpen && !buildMode && health > 0) attack();
  {
    let px = 0.22, py = -0.26, pz = -0.5, rx = 0, rz = 0;
    px += Math.sin(gunT * 0.8) * 0.003; py += Math.sin(gunT * 1.6) * 0.004;
    if (health > 0 && (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD)) {
      const st = gunT * (keys.ShiftLeft ? 12 : 9);
      px += Math.sin(st) * 0.012; py += Math.abs(Math.cos(st)) * 0.014 - 0.007; rz += Math.sin(st) * 0.02;
    }
    const dd = Math.pow(1 - drawT, 3); py -= dd * 0.45; rx -= dd * 0.7;
    pz += akRecoil * 0.045; rx += akRecoil * 0.07; py += akRecoil * 0.006;
    ak.bolt.position.z = -0.02 + akRecoil * 0.05;
    const lh = _akLh.copy(AK_F);
    ak.mag.visible = true; ak.mag.position.set(0, 0, 0); ak.mag.rotation.set(0, 0, 0);
    if (akReloading) {
      akRT += dt;
      const p = Math.min(1, akRT / 2.3);
      const tilt = sstep(0, 0.15, p) - sstep(0.88, 1, p);
      rz += tilt * 0.35; rx -= tilt * 0.12; py -= tilt * 0.04;
      if (p < 0.15) lh.lerpVectors(AK_F, AK_M, sstep(0, 0.15, p));                       // рука к магазину
      else if (p < 0.3) { lh.copy(AK_M); lh.y -= 0.1 * sstep(0.15, 0.3, p); }             // вытягивает магазин
      else if (p < 0.5) { _akT.copy(AK_M); _akT.y -= 0.1; lh.lerpVectors(_akT, AK_B, sstep(0.3, 0.5, p)); } // за новым
      else if (p < 0.72) lh.lerpVectors(AK_B, AK_M, sstep(0.5, 0.72, p));                // несёт новый
      else if (p < 0.9) lh.lerpVectors(AK_M, AK_F, sstep(0.72, 0.9, p));                 // назад на цевьё
      if (p >= 0.15 && p < 0.3) ak.mag.position.set(0, -0.1 * sstep(0.15, 0.3, p), 0);
      else if (p >= 0.3 && p < 0.5) { const f = (p - 0.3) / 0.2; ak.mag.position.set(0.02 * f, -0.1 - 0.7 * f * f, 0.03 * f); ak.mag.rotation.z = f * 1.1; }
      else if (p >= 0.5 && p < 0.72) ak.mag.position.set(lh.x - AK_M.x, lh.y - AK_M.y, lh.z - AK_M.z);
      ak.mag.visible = !(p >= 0.49 && p < 0.52);
      if (p >= 0.72 && !akLoaded) { akLoaded = true; const take = Math.min(AK_MAG - akAmmo, akReserve); akAmmo += take; akReserve -= take; }
      const bq = clamp((p - 0.8) / 0.12, 0, 1);
      ak.bolt.position.z = -0.02 + 0.07 * Math.sin(bq * Math.PI);                        // передёргивание затвора
      if (akRT >= 2.3) akReloading = false;
    }
    ak.leftHand.position.copy(lh);
    akRig.position.set(px, py, pz);
    akRig.rotation.set(rx, 0.1, rz);
    akFlashG.visible = akFlashT > 0;
    akLight.intensity = akFlashT > 0 ? 8 : 0;
    if (akFlashT > 0) akFlashG.rotation.z = Math.random() * 6;
  }

  // Гильзы падают на землю
  for (let i = casings.length - 1; i >= 0; i--) {
    const c = casings[i];
    c.v.y -= 9.8 * dt;
    c.m.position.addScaledVector(c.v, dt);
    c.m.rotation.x += c.spin.x * dt; c.m.rotation.y += c.spin.y * dt; c.m.rotation.z += c.spin.z * dt;
    if (c.m.position.y < 0.012) { c.m.position.y = 0.012; c.v.y *= -0.35; c.v.x *= 0.6; c.v.z *= 0.6; c.spin.multiplyScalar(0.6); }
    c.life -= dt;
    if (c.life <= 0) { scene.remove(c.m); casings.splice(i, 1); }
  }
  updateCases(dt);

  // Подбор патронов
  for (let i = ammoBoxes.length - 1; i >= 0; i--) {
    const p = ammoBoxes[i].position;
    if (Math.hypot(p.x - camera.position.x, p.z - camera.position.z) < 1.5) {
      reserve += 14;
      if (hasShotgun) sgReserve += 4;
      if (hasAK) akReserve += 15;
      const stashBox = ammoBoxes[i].userData.stash;
      scene.remove(ammoBoxes[i]);
      ammoBoxes.splice(i, 1);
      if (!stashBox) spawnAmmoBox();
    }
  }

  // Подбор еды, воды, аптечек, лома
  for (let i = items.length - 1; i >= 0; i--) {
    items[i].mesh.rotation.y += dt; // предметы медленно вращаются
    const p = items[i].mesh.position;
    if (Math.hypot(p.x - camera.position.x, p.z - camera.position.z) < 1.5) {
      const type = items[i].type, stashItem = items[i].stash;
      if (freeRoom(type) < 1) { if (noticeT <= 0) notify('Инвентарь полон'); continue; }
      addItem(type, 1);
      scene.remove(items[i].mesh);
      items.splice(i, 1);
      if (!stashItem) spawnItem(type);
    }
  }

  // Зомби
  updateCorpses(dt);
  updateWater(dt); updateWild(dt);
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    if (net.role === 'client') { clientZombie(z, dt); continue; } // у клиента зомби двигает хозяин комнаты
    if (z.hp <= 0) {
      if (z.cfg.explode) explodeBloater(z);
      startCorpse(z); zombies.splice(i, 1); kills++;
      if (!adm('noZombies')) spawnZombie(undefined, undefined, pickZombieType(daylight < 0.4));
      continue;
    }
    const tgt = pickTarget(z);
    const to = new THREE.Vector3(tgt.x - z.mesh.position.x, 0, tgt.z - z.mesh.position.z);
    const dist = to.length();
    const sc = z.cfg.sx;
    const chase = dist < 35 && dist > 1.2 * sc;
    z.mv = chase ? 1 : 0;
    if (chase) {
      to.normalize();
      const zx0 = z.mesh.position.x, zz0 = z.mesh.position.z;
      z.mesh.position.addScaledVector(to, (z.cfg.speed + (1 - daylight) * (z.type === 'runner' ? 0.8 : 1.0)) * dt); // ночью быстрее
      z.mesh.rotation.y = Math.atan2(to.x, to.z);
      resolveCollisions(z.mesh.position, 0.6 * sc);
      if (LAKES.length && terrainY(z.mesh.position.x, z.mesh.position.z) < WATER_Y - 0.5) { // зомби не лезут в глубокую воду: скользят вдоль берега или стоят
        const nx = z.mesh.position.x, nz = z.mesh.position.z;
        if (terrainY(nx, zz0) >= WATER_Y - 0.5) z.mesh.position.set(nx, z.mesh.position.y, zz0);
        else if (terrainY(zx0, nz) >= WATER_Y - 0.5) z.mesh.position.set(zx0, z.mesh.position.y, nz);
        else z.mesh.position.set(zx0, z.mesh.position.y, zz0);
      }
      z.mesh.position.y = terrainY(z.mesh.position.x, z.mesh.position.z);
    }
    animateZombie(z, chase, dt);
    z.cooldown -= dt;
    if (dist <= 1.5 * Math.max(1, sc) && z.cooldown <= 0 && tgt.y - terrainY(tgt.x, tgt.z) < 2.9) { // высота над землёй, а не над нулём (на холме тоже кусают)
      if (tgt.remote) { netSendTo(net.conns.get(tgt.remote.id), { t: 'hurt', d: z.cfg.dmg }); z.cooldown = 1; z.attackT = ZOMBIE_ATTACK; } // укус другого игрока
      else if (health > 0 && (!menuOpen || net.active)) { health -= z.cfg.dmg; z.cooldown = z.type === 'runner' ? 0.7 : 1; z.attackT = ZOMBIE_ATTACK; }
    }
  }

  netTick(Math.min(rawDt, 0.1));

  if (health <= 0) {
    health = 0;
    hud.textContent = `Ты умер. Убито: ${kills}`;
    if (!deathShown) showDeathScreen();
  } else {
    if (deathShown) { deathShown = false; deathScreen.style.display = 'none'; }
    hud.textContent =
      `День ${day}   Здоровье: ${Math.ceil(health)}   Еда: ${Math.ceil(hunger)}   Вода: ${Math.ceil(thirst)}\n` +
      `Убито: ${kills}   ` + (riding ? vehicleHud() : weapon === 'pistol' ? `Пистолет: ${reloading ? 'перезарядка...' : ammo} / ${reserve}` : weapon === 'shotgun' ? `Дробовик: ${sgReloading ? 'заряжаю... ' : ''}${sgAmmo} / ${sgReserve}` : weapon === 'ak' ? `АК-47: ${akReloading ? 'перезарядка... ' : ''}${akAmmo} / ${akReserve}` : 'Топор: ЛКМ - рубить и бить');
  }
  const hh = String(Math.floor(gameHour)).padStart(2, '0');
  const mm = String(Math.floor((gameHour % 1) * 60)).padStart(2, '0');
  const slotsRow = `<div style="display:flex;gap:6px;justify-content:center">${[0, 1, 2, 3, 4].map(i => slotHtml(i, false, false)).join('')}</div>`;
  const info = buildMode
    ? 'СТРОЙКА: ' + pieceKeys.map((k, i) => `${selPiece === k ? '▶' : ''}[${i + 1}] ${pieces[k].name} (${pieces[k].cost} дер.)`).join('  ') + `   Дерево: ${countOf('wood')}<br>[Q] поворот   [клик] поставить   [V] убрать   [B] выйти`
    : `[F] Фонарик ${flashOn ? 'вкл' : 'выкл'}   [R] Перезарядка${hasShotgun || hasAxe ? '   [Q] Оружие' : ''}   [E] Взять   [B] Строить   [Tab] Меню   ${hh}:${mm}<br>Дерево: ${countOf('wood')}   Лом: ${countOf('scrap')}`;
  const hotHtml = slotsRow + `<div style="margin-top:6px;font-size:16px">${info}</div>`;
  if (hotHtml !== lastHot) { hotbar.innerHTML = hotHtml; lastHot = hotHtml; }

  if (adm('debug')) {
    dbgEl.style.display = 'block';
    dbgEl.textContent = `X ${camera.position.x.toFixed(1)}  Y ${camera.position.y.toFixed(1)}  Z ${camera.position.z.toFixed(1)}   FPS ${Math.round(fpsSmooth)}   зомби ${zombies.length}  кучи ${piles.length}  объектов ${scene.children.length}`;
  } else dbgEl.style.display = 'none';
  const uiShow = gameStarted ? '' : 'none'; // в главном меню игровой интерфейс скрыт, камера облетает базу
  hud.style.display = uiShow; hotbar.style.display = uiShow; avatar.style.display = uiShow; cross.style.display = uiShow;
  if (!gameStarted) {
    gun.visible = false; sgun.visible = false; axeRig.visible = false; akRig.visible = false;
    promptEl.style.display = 'none'; notice.textContent = '';
    const tt = performance.now() / 1000 * 0.07;
    camera.position.set(Math.cos(tt) * 34, 13, Math.sin(tt) * 34); camera.rotation.set(0, 0, 0); camera.lookAt(0, 3, 0);
  }
  cutscenes.update(rawDt);       // кат-сцены управляют камерой после остального кадра
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
// --- Озёра и дикая местность (1.9.0) ---
// Всё считается из зерна мира собственными генераторами (Math.random не трогаем): мир из старых сохранений не сдвигается, у игроков комнаты всё одинаково.
const lakeState = { t: 0, tex: null, mat: null, group: null };
function makeWaterNormal() { // бесшовная карта нормалей: наложение синусов с периодом в размер картинки
  const N = 128, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), img = g.createImageData(N, N), TAU = Math.PI * 2;
  const hgt = (x, y) => { const u = x / N * TAU, v = y / N * TAU; return Math.sin(u * 3 + Math.sin(v * 2) * 1.3) * 0.5 + Math.sin(v * 4 + u) * 0.35 + Math.sin(u * 7 + v * 5) * 0.18 + Math.sin(u * 2 - v * 6) * 0.25; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = hgt(x + 1, y) - hgt(x - 1, y), dy = hgt(x, y + 1) - hgt(x, y - 1), k = 2.2;
    let nx = -dx * k, ny = -dy * k, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * N + x) * 4; img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
function buildLakes() {
  if (!LAKES.length) return;
  const tex = makeWaterNormal();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, roughness: 0.07, metalness: 0.12, normalMap: tex, normalScale: new THREE.Vector2(0.5, 0.5), depthWrite: false });
  mat.userData.shared = true;
  const group = new THREE.Group();
  LAKES.forEach(l => { // вода: сетка 2,5 м; цвет и прозрачность из глубины, у берега светлая пена
    const half = l.reach / LAKE_BEACH, step = 2.5, n = Math.ceil(2 * half / step) + 1, pos = [], col = [], uv = [], idx = [], dep = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = l.x - half + i * step, z = l.z - half + j * step, depth = WATER_Y - terrainY(x, z);
      dep.push(depth); pos.push(x, WATER_Y, z); uv.push(x / 9, z / 9);
      const k = Math.min(1, Math.max(0, depth / 3.2)), foam = depth > 0 && depth < 0.2 ? (1 - depth / 0.2) * 0.55 : 0;
      let r = 0.20 + (0.03 - 0.20) * k, g = 0.46 + (0.16 - 0.46) * k, b = 0.44 + (0.22 - 0.44) * k;
      r += (0.9 - r) * foam; g += (0.95 - g) * foam; b += (0.92 - b) * foam;
      col.push(r, g, b, depth <= 0 ? 0 : Math.max(Math.min(1, Math.pow(Math.min(1, depth / 0.9), 0.6)) * 0.9, foam * 0.7));
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      if (Math.max(dep[a], dep[b], dep[c], dep[d]) <= 0) continue; // клетка целиком на суше
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals(); geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat); m.renderOrder = 2; m.castShadow = false; group.add(m);
  });
  scene.add(group); group.traverse(c => { if (c.isMesh) c.castShadow = false; }); // тени вода не отбрасывает
  lakeState.tex = tex; lakeState.mat = mat; lakeState.group = group;

  // --- жизнь у воды: тростник с рогозом, кувшинки, камешки, коряги, лодка ---
  let sd = (WORLD_SEED ^ 0x1A4E5EED) | 0;
  const lr = () => { sd = (sd + 0x6D2B79F5) | 0; let t = Math.imul(sd ^ (sd >>> 15), 1 | sd); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const stdMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }); stdMat.userData.shared = true;
  const gb = zBoxes(mulberry(701), y => 0.8 + 0.2 * Math.min(1, y / 1.0));
  for (let k = 0; k < 9; k++) { // пучок: стебли и три рогозовые головки
    const an = k / 9 * 6.283 + 0.4, rr = 0.1 + ((k * 37) % 10) / 55, h = 1.1 + ((k * 13) % 7) / 7, tipx = Math.cos(an) * rr * 1.8, tipz = Math.sin(an) * rr * 1.8;
    gb.tube([Math.cos(an) * rr, 0, Math.sin(an) * rr], [tipx, h, tipz], 0.017, k % 2 ? 0x5a7a34 : 0x6f8a3c, 4);
    if (k % 3 === 0) gb.tube([tipx * 0.98, h - 0.22, tipz * 0.98], [tipx, h + 0.02, tipz], 0.04, 0x5a3a22, 5);
  }
  const reedGeo = gb.mesh(stdMat).geometry;
  const pb = zBoxes(mulberry(702), null); pb.frustum(0.4, 0.38, 0.025, 9, 0x3f7a34, m4(0, 0.0, 0), true); pb.box(0.2, 0.012, 0.03, 0x2f5a28, 0.22, 0.016, 0);
  const padGeo = pb.mesh(stdMat).geometry;
  const fb = zBoxes(mulberry(703), null); fb.frustum(0.4, 0.38, 0.025, 9, 0x3f7a34, m4(0, 0.0, 0), true); for (let k = 0; k < 6; k++) fb.frustum(0.09, 0.0, 0.14, 5, k % 2 ? 0xf0b8d0 : 0xf6dce8, m4(Math.cos(k) * 0.07, 0.09, Math.sin(k) * 0.07, 0.5 * Math.cos(k), 0, 0.5 * Math.sin(k)));
  const flowerGeo = fb.mesh(stdMat).geometry;
  const sb = zBoxes(mulberry(704), null); sb.blob(0.28, ny => ny > 0.4 ? 0x9a948a : 0x6a665e, m4(0, 0.1, 0), 1, 0.55, 0.85, 0, 0.2);
  const pebbleGeo = sb.mesh(stdMat).geometry;
  const wb = zBoxes(mulberry(705), y => 0.8 + 0.2 * Math.min(1, y / 0.5)); // коряга
  wb.cylZ(0.14, 2.8, 0x7a6a56, 0, 0.14, 0, 6); wb.cylZ(0.1, 0.05, 0xc8b898, 0, 0.14, 1.4, 6); wb.tube([0.0, 0.2, -0.6], [0.35, 0.6, -0.95], 0.05, 0x6a5a48, 4); wb.tube([0.0, 0.2, 0.5], [-0.3, 0.55, 0.85], 0.045, 0x6a5a48, 4);
  const woodGeo = wb.mesh(stdMat).geometry;
  const dm = new THREE.Object3D(), tint = new THREE.Color();
  const shorePoint = (l, an, f) => { // точка на луче от центра озера: f - во сколько раз ближе/дальше берега (1 = берег)
    const c = Math.cos(an), s = Math.sin(an); let lo = 0, hi = l.reach;
    for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (lakeQ(l, l.x + c * mid, l.z + s * mid) < 1) lo = mid; else hi = mid; }
    const t = lo * f; return [l.x + c * t, l.z + s * t];
  };
  LAKES.forEach((l, li) => {
    const reeds = [], pads = [], flowers = [], pebbles = [], woods = [];
    const tries = Math.round(l.r * 9);
    for (let i = 0; i < tries; i++) {
      const an = lr() * 6.283, [x, z] = shorePoint(l, an, 0.9 + lr() * 0.22), h = terrainY(x, z);
      if (h < WATER_Y - 0.55 || h > WATER_Y + 0.5) continue;
      if (_vnoise(x / 13 + 5.1, z / 13 + 8.3) < 0.42) continue;                        // тростник растёт полосами
      reeds.push([x + (lr() - 0.5) * 2, z + (lr() - 0.5) * 2, 0.8 + lr() * 0.8, lr() * 6.283]);
    }
    for (let c = 0; c < Math.max(2, Math.round(l.r / 5)); c++) { // кувшинки: острова с цветами
      const [cx, cz] = shorePoint(l, lr() * 6.283, 0.55 + lr() * 0.3), n = 5 + Math.floor(lr() * 8);
      for (let k = 0; k < n; k++) { const x = cx + (lr() - 0.5) * 6, z = cz + (lr() - 0.5) * 6; if (WATER_Y - terrainY(x, z) < 0.35) continue; (lr() < 0.22 ? flowers : pads).push([x, z, 0.7 + lr() * 0.9, lr() * 6.283]); }
    }
    for (let i = 0; i < l.r * 2; i++) { const [x, z] = shorePoint(l, lr() * 6.283, 0.93 + lr() * 0.5); const h = terrainY(x, z); if (h > WATER_Y + 1.2) continue; pebbles.push([x, z, 0.5 + lr() * 1.3, lr() * 6.283]); }
    for (let i = 0; i < 2 + Math.floor(l.r / 12); i++) { const an = lr() * 6.283, [x, z] = shorePoint(l, an, 1.02 + lr() * 0.18); if (terrainY(x, z) > WATER_Y + 1.0) continue; woods.push([x, z, 0.8 + lr() * 0.6, an + 1.57 + (lr() - 0.5)]); }
    const put = (geo, list, y0, rotate) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, stdMat, list.length);
      list.forEach(([x, z, s, ry], i) => { dm.position.set(x, y0 === null ? terrainY(x, z) - 0.03 : y0, z); dm.rotation.set(0, ry, 0); dm.scale.set(s, s * (rotate ? 1 : 1), s); dm.updateMatrix(); im.setMatrixAt(i, dm.matrix); im.setColorAt(i, tint.setRGB(0.9 + lr() * 0.2, 0.9 + lr() * 0.2, 0.9 + lr() * 0.15)); });
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; im.computeBoundingSphere(); scene.add(im); im.castShadow = false; group.add(im);
    };
    put(reedGeo, reeds, null); put(padGeo, pads, WATER_Y + 0.025); put(flowerGeo, flowers, WATER_Y + 0.025); put(pebbleGeo, pebbles, null); put(woodGeo, woods, null);
    if (li % 2 === 0 && l.r > 15) { // старая лодка на берегу, носом к воде
      const an = lr() * 6.283, [bx, bz] = shorePoint(l, an, 1.12), by = terrainY(bx, bz);
      const b = zBoxes(mulberry(710 + li), y => 0.8 + 0.2 * Math.min(1, y / 0.5)), wood = 0x6a7a80, wood2 = 0x7a5a3a;
      K_BOAT(b, wood, wood2);
      const mesh = b.mesh(stdMat); mesh.position.set(bx, by + 0.08, bz); mesh.rotation.y = -an + Math.PI / 2 + 3.14159 * 0; mesh.rotation.z = 0.06; scene.add(mesh); mesh.castShadow = false; group.add(mesh);
    }
  });
}
function K_BOAT(b, wood, wood2) { // дощатая лодка с вёслами, длинная ось - Z, нос в -Z
  b.box(1.0, 0.08, 2.6, wood2, 0, 0.1, 0.1);
  [-1, 1].forEach(sd => { b.box(0.07, 0.42, 2.6, wood, sd * 0.52, 0.34, 0.1, 0, 0, -sd * 0.16); b.box(0.07, 0.42, 1.2, wood, sd * 0.28, 0.34, -1.55, 0, sd * 0.5, -sd * 0.12); b.box(0.05, 0.05, 2.6, wood2, sd * 0.6, 0.55, 0.1); });
  b.box(0.9, 0.42, 0.07, wood, 0, 0.34, 1.4); b.box(0.9, 0.05, 0.3, wood2, 0, 0.36, 0.55); b.box(0.9, 0.05, 0.3, wood2, 0, 0.36, -0.5);
  b.tube([0.45, 0.5, 0.1], [1.3, 0.2, 0.7], 0.025, 0x8a6a46, 5); b.box(0.5, 0.02, 0.18, 0x8a6a46, 1.55, 0.14, 0.82, 0, 0.5, 0);
  b.tube([-0.2, 0.15, -0.3], [-0.4, 0.1, 0.5], 0.01, 0x8a8a7a, 3);
}
function updateWater(dt) {
  if (!lakeState.mat) return;
  lakeState.t += dt;
  const t = lakeState.t;
  lakeState.tex.offset.set(t * 0.011, t * 0.007);
  lakeState.mat.normalScale.setScalar(0.45 + Math.sin(t * 0.7) * 0.08);
  lakeState.group.position.y = Math.sin(t * 0.8) * 0.02;
}

// --- Дикая местность: лес, кусты, коряги и валуны на холмах за ровной зоной ---
// Свой генератор случайных чисел: Math.random тут не трогаем. Каждый вид рисуется через InstancedMesh по клеткам 140 м, дальние клетки скрываются.
const wildCells = [];
function makeNatureGeos() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }); mat.userData.shared = true;
  const mk = seed => zBoxes(mulberry(seed), y => 0.78 + 0.22 * Math.min(1, y / 2.5));
  const geo = b => b.mesh(mat).geometry;
  const out = { mat, trees: [], bushes: [], rocks: [] };
  { // ель: ярусы конусов с подпушкой
    const b = mk(11); b.frustum(0.34, 0.12, 6.6, 6, 0x4a3320, m4(0, 3.3, 0));
    for (let i = 0; i < 7; i++) {
      const t = i / 6, y = 1.4 + t * 4.7, r = 1.95 * (1 - t * 0.8) + 0.25, h = 1.6 + (1 - t) * 0.5, col = [0x2a4f26, 0x2f5a2a, 0x264a22][i % 3];
      b.frustum(r, 0, h, 7, col, m4(0, y + h / 2, 0, 0, i * 0.7, 0));
      if (i % 2 === 0) b.frustum(r * 0.62, 0, h * 0.85, 6, mulCol(col, 1.18), m4(0, y + h * 0.62, 0, 0, i * 1.3 + 0.5, 0));
    }
    b.frustum(0.32, 0, 1.0, 6, 0x2f5a2a, m4(0, 6.9, 0)); out.trees.push(geo(b));
  }
  { // сосна: высокий голый ствол с ржавой корой и плоскими шапками хвои
    const b = mk(12); b.frustum(0.32, 0.14, 8.8, 6, 0x6b4a2e, m4(0, 4.4, 0));
    for (let i = 0; i < 5; i++) b.tube([0, 2.4 + i * 0.8, 0], [Math.cos(i * 2.4) * 0.7, 2.6 + i * 0.8, Math.sin(i * 2.4) * 0.7], 0.03, 0x4a3420, 4);
    [[0.2, 7.0, 0, 1.7], [-0.3, 7.9, 0.2, 1.3], [0.1, 8.7, -0.1, 0.9], [0.9, 6.5, 0.6, 0.9], [-0.9, 6.7, -0.5, 0.95]].forEach(([x, y, z, r], i) => b.blob(r, ny => ny > 0.4 ? 0x3f7034 : 0x2f5a2a, m4(x, y, z, 0, i, 0), 1, 0.5, 1, 0, 0.2));
    out.trees.push(geo(b));
  }
  { // берёза: белый ствол с чёрными метинами, светлая крона из шаров
    const b = mk(13); b.frustum(0.22, 0.1, 5.8, 6, 0xe6e2d4, m4(0, 2.9, 0));
    for (let i = 0; i < 9; i++) b.box(0.2, 0.05, 0.05, 0x2a2a2a, Math.cos(i * 2.1) * 0.15, 0.7 + i * 0.5, Math.sin(i * 2.1) * 0.15, 0, -i * 2.1, 0);
    [[0.7, 4.0, 0.2], [-0.5, 4.4, -0.5]].forEach(([x, y, z]) => b.tube([0, y - 0.6, 0], [x, y, z], 0.06, 0xd8d4c6, 4));
    [[0, 5.6, 0, 1.4], [0.9, 4.6, 0.4, 1.1], [-0.8, 4.4, -0.5, 1.2], [0.2, 4.2, -1.0, 0.9], [-0.3, 6.4, 0.3, 0.8], [0.3, 4.5, 1.0, 0.9]].forEach(([x, y, z, r], i) => b.blob(r, ny => ny > 0.45 ? 0x86ae48 : 0x5f8a34, m4(x, y, z, 0, i, 0), 1, 0.9, 1, 0, 0.22));
    out.trees.push(geo(b));
  }
  { // дуб: толстый ствол с корнями, массивная тёмная крона
    const b = mk(14); b.frustum(0.85, 0.5, 0.7, 7, 0x4a3524, m4(0, 0.35, 0)); b.frustum(0.5, 0.32, 3.2, 7, 0x4a3524, m4(0, 2.3, 0));
    [[1.4, 4.4, 0.6], [-1.3, 4.2, -0.5], [0.3, 4.6, -1.4]].forEach(([x, y, z]) => b.tube([0, 2.6, 0], [x, y, z], 0.17, 0x4a3524, 5));
    [[0, 5.4, 0, 2.0], [1.7, 4.8, 0.7, 1.6], [-1.6, 4.7, -0.6, 1.7], [0.4, 4.9, -1.7, 1.5], [-0.5, 4.6, 1.6, 1.5], [0.2, 6.4, 0.2, 1.2]].forEach(([x, y, z, r], i) => b.blob(r, ny => ny > 0.5 ? 0x578a38 : 0x3a6a2a, m4(x, y, z, 0, i * 1.1, 0), 1, 0.8, 1, 1, 0.2));
    out.trees.push(geo(b));
  }
  { // сухое дерево: серые ветви без листвы
    const b = mk(15); b.frustum(0.3, 0.1, 5.4, 6, 0x6a6258, m4(0, 2.7, 0));
    for (let i = 0; i < 7; i++) { const an = i * 2.4, y = 2.2 + i * 0.5, L = 1.4 - i * 0.1; b.tube([0, y, 0], [Math.cos(an) * L, y + 0.9, Math.sin(an) * L], 0.07, 0x5e564c, 4); b.tube([Math.cos(an) * L, y + 0.9, Math.sin(an) * L], [Math.cos(an + 0.5) * L * 1.5, y + 1.6, Math.sin(an + 0.5) * L * 1.5], 0.035, 0x5e564c, 4); }
    out.trees.push(geo(b));
  }
  { const b = mk(21); [[0, 0.4, 0, 0.55], [0.5, 0.32, 0.2, 0.42], [-0.4, 0.3, -0.3, 0.45]].forEach(([x, y, z, r], i) => b.blob(r, ny => ny > 0.5 ? 0x55803a : 0x3a6a2a, m4(x, y, z, 0, i, 0), 1, 0.85, 1, 0, 0.22)); out.bushes.push(geo(b)); }
  { const b = mk(22); [[0, 0.4, 0, 0.55], [0.5, 0.32, 0.2, 0.42], [-0.4, 0.3, -0.3, 0.45]].forEach(([x, y, z, r], i) => b.blob(r, ny => ny > 0.5 ? 0x55803a : 0x3a6a2a, m4(x, y, z, 0, i, 0), 1, 0.85, 1, 0, 0.22)); for (let i = 0; i < 9; i++) b.blob(0.05, 0xb02a3a, m4(Math.cos(i * 2.4) * 0.5, 0.3 + (i % 3) * 0.12, Math.sin(i * 2.4) * 0.5), 1, 1, 1, 0, 0.1); out.bushes.push(geo(b)); }
  const rockCol = (ny, i) => ny > 0.55 ? (i % 3 === 0 ? 0x5a6e44 : 0x86837e) : ny < -0.2 ? 0x4e4d4a : 0x7c7b78;
  { const b = mk(31); b.blob(1, rockCol, m4(0, 0.5, 0), 1, 0.7, 0.9, 1, 0.2); out.rocks.push(geo(b)); }
  { const b = mk(32); b.blob(0.8, rockCol, m4(0, 0.95, 0), 0.8, 1.4, 0.8, 0, 0.25); out.rocks.push(geo(b)); }
  { const b = mk(33); b.blob(1, rockCol, m4(0, 0.3, 0), 1.4, 0.34, 1.0, 0, 0.18); out.rocks.push(geo(b)); }
  { const b = mk(34); [[-0.7, 0.4, 0.2, 0.8], [0.6, 0.3, -0.3, 0.6], [0.1, 0.25, 0.8, 0.5]].forEach(([x, y, z, r], i) => b.blob(r, rockCol, m4(x, y, z, 0, i, 0), 1, 0.75, 1, 0, 0.22)); out.rocks.push(geo(b)); }
  { const b = mk(41); b.cylZ(0.28, 3.6, 0x5a4028, 0, 0.28, 0, 7); b.cylZ(0.24, 0.03, 0xc8a878, 0, 0.28, 1.8, 7); b.cylZ(0.24, 0.03, 0xc8a878, 0, 0.28, -1.8, 7); b.tube([0.1, 0.4, -0.5], [0.5, 0.75, -0.8], 0.05, 0x4a3420, 4); b.blob(0.3, 0x4a6a34, m4(0, 0.52, 0.4), 1.3, 0.35, 1, 0, 0.2); out.log = geo(b); }
  { const b = mk(42); b.frustum(0.4, 0.3, 0.5, 8, 0x5a4028, m4(0, 0.25, 0)); b.frustum(0.3, 0.3, 0.03, 8, 0xc8a878, m4(0, 0.51, 0)); for (let i = 0; i < 4; i++) b.tube([Math.cos(i * 1.6) * 0.3, 0.2, Math.sin(i * 1.6) * 0.3], [Math.cos(i * 1.6) * 0.65, 0.0, Math.sin(i * 1.6) * 0.65], 0.07, 0x4a3420, 4); out.stump = geo(b); }
  return out;
}
function buildWilderness() {
  let seed = (WORLD_SEED ^ 0x5EED5EED) | 0;
  const wr = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const CELL = 140, cells = new Map();
  const cellOf = (x, z) => {
    const kx = Math.floor((x + WORLD_HALF) / CELL), kz = Math.floor((z + WORLD_HALF) / CELL), k = kx * 64 + kz;
    let c = cells.get(k);
    if (!c) { c = { cx: (kx + 0.5) * CELL - WORLD_HALF, cz: (kz + 0.5) * CELL - WORLD_HALF, trees: [[], [], [], [], []], bushes: [[], []], rocks: [[], [], [], []], logs: [], stumps: [] }; cells.set(k, c); }
    return c;
  };
  const slopeAt = (x, z, h) => Math.hypot(terrainY(x + 2, z) - h, terrainY(x, z + 2) - h) / 2;
  const addCollider = (x, z, half) => {
    const ix = Math.floor(x / WILD_CELL), iz = Math.floor(z / WILD_CELL), k = wildKey(ix, iz);
    let l = wildGrid.get(k); if (!l) { l = []; wildGrid.set(k, l); }
    l.push({ minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half });
  };
  const inWild = (x, z) => Math.max(Math.abs(x), Math.abs(z)) >= FLAT_HALF + 10 && Math.min(Math.abs(x), Math.abs(z)) >= 7; // у дорог просека

  let nTrees = 0;
  for (let i = 0; i < 9000 && nTrees < 3500; i++) {
    const x = (wr() * 2 - 1) * (WORLD_WALK - 20), z = (wr() * 2 - 1) * (WORLD_WALK - 20);
    if (!inWild(x, z)) continue;
    const h = terrainY(x, z);
    if (h > 58 || slopeAt(x, z, h) > 0.75 || h < WATER_Y + 0.6 || lakeShore(x, z) < 1.7) continue; // крутизна, высота, вода и пляж
    if (_vnoise(x / 50 + 91.7, z / 50 - 33.1) < 0.45 && wr() > 0.1) continue; // лес растёт островами
    const bio = _vnoise(x / 90 + 13, z / 90 + 7), w = [0.40 + (0.5 - bio) * 0.3, 0.18, 0.17 + (bio - 0.5) * 0.25, 0.19 + (bio - 0.5) * 0.2, 0.06];
    let u = wr() * (w[0] + w[1] + w[2] + w[3] + w[4]), sp = 0; while (sp < 4 && u > w[sp]) { u -= w[sp]; sp++; }
    cellOf(x, z).trees[sp].push({ x, z, h, s: 0.85 + wr() * 0.7, ry: wr() * 6.283, j1: wr(), j2: wr() });
    nTrees++;
  }
  for (let i = 0; i < 1800; i++) { // кусты, чаще у леса
    const x = (wr() * 2 - 1) * (WORLD_WALK - 10), z = (wr() * 2 - 1) * (WORLD_WALK - 10);
    if (!inWild(x, z)) continue;
    const h = terrainY(x, z); if (h > 50 || h < WATER_Y + 0.4 || lakeShore(x, z) < 1.3) continue;
    if (_vnoise(x / 40 + 3.3, z / 40 + 9.1) < 0.4 && wr() > 0.15) continue;
    cellOf(x, z).bushes[wr() < 0.25 ? 1 : 0].push({ x, z, h, s: 0.8 + wr() * 0.9, ry: wr() * 6.283, j1: wr(), j2: wr() });
  }
  for (let i = 0; i < 700; i++) { // коряги и пни у леса
    const x = (wr() * 2 - 1) * (WORLD_WALK - 20), z = (wr() * 2 - 1) * (WORLD_WALK - 20);
    if (!inWild(x, z)) continue;
    const h = terrainY(x, z), isLog = wr() < 0.45; if (h > 50 || h < WATER_Y + 0.5 || lakeShore(x, z) < 1.5 || slopeAt(x, z, h) > 0.5) continue;
    if (_vnoise(x / 50 + 91.7, z / 50 - 33.1) < 0.5) continue;
    (isLog ? cellOf(x, z).logs : cellOf(x, z).stumps).push({ x, z, h, s: 0.8 + wr() * 0.5, ry: wr() * 6.283, j1: wr(), j2: wr() });
  }
  for (let i = 0; i < 2200; i++) {
    const x = (wr() * 2 - 1) * (WORLD_WALK - 10), z = (wr() * 2 - 1) * (WORLD_WALK - 10);
    if (!inWild(x, z)) continue;
    const h = terrainY(x, z); if (h < WATER_Y - 0.1) continue;
    const u = wr(), type = u < 0.5 ? 0 : u < 0.72 ? 1 : u < 0.88 ? 2 : 3;
    cellOf(x, z).rocks[type].push({ x, z, h, s: 0.5 + wr() * wr() * 2.6, ry: wr() * 6.283, g: wr(), type });
  }

  const geos = makeNatureGeos(), mat = geos.mat;
  const trunkBlock = new THREE.BoxGeometry(0.6, 3, 0.6), hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
  const dummy = new THREE.Object3D(), col = new THREE.Color();
  const finish = (mesh, list) => {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
    mesh.castShadow = false;            // тени от тысяч деревьев слишком дорогие
    list.push(mesh);
  };
  const place = (geo, items, cell, yOff, tintFn) => {
    if (!items.length) return;
    const im = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((t, i) => {
      dummy.position.set(t.x, t.h + (yOff || 0), t.z); dummy.rotation.set(0, t.ry, 0); dummy.scale.setScalar(t.s);
      dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, tintFn(t));
    });
    finish(im, cell.meshes);
  };
  const treeTint = t => col.setRGB(0.9 + t.j1 * 0.2, 0.92 + t.j2 * 0.16, 0.9 + t.j1 * 0.12);
  const rockTint = t => { const v = 0.82 + t.g * 0.3; return col.setRGB(v, v, v * 0.98); };
  for (const c of cells.values()) {
    c.meshes = [];
    c.trees.forEach((list, sp) => {
      place(geos.trees[sp], list, c, 0, treeTint);
      list.forEach(t => addCollider(t.x, t.z, (sp === 3 ? 0.45 : 0.3) * t.s + 0.1));
    });
    c.bushes.forEach((list, k) => place(geos.bushes[k], list, c, 0, treeTint));
    place(geos.log, c.logs, c, 0, treeTint); place(geos.stump, c.stumps, c, 0, treeTint);
    c.rocks.forEach((list, k) => {
      place(geos.rocks[k], list, c, 0, rockTint);
      if (k !== 2) list.forEach(r => { if (r.s >= 1.3) addCollider(r.x, r.z, r.s * 0.75); }); // большие валуны твёрдые
    });
    const all = c.trees.flat(); // невидимые стволы только для пуль: пули не пролетают сквозь деревья, но кроны их не держат
    if (all.length) {
      const tb = new THREE.InstancedMesh(trunkBlock, hiddenMat, all.length);
      all.forEach((t, i) => { dummy.position.set(t.x, t.h + 1.5 * t.s, t.z); dummy.rotation.set(0, t.ry, 0); dummy.scale.setScalar(t.s); dummy.updateMatrix(); tb.setMatrixAt(i, dummy.matrix); });
      tb.instanceMatrix.needsUpdate = true; tb.computeBoundingSphere(); scene.add(tb); tb.castShadow = false; blockers.push(tb);
    }
    wildCells.push(c);
  }
}
let wildTimer = 0;
function updateWild(dt) { // дальние клетки леса не рисуем: туман их всё равно скрывает
  wildTimer -= dt; if (wildTimer > 0) return; wildTimer = 0.3;
  const px = camera.position.x, pz = camera.position.z;
  for (const c of wildCells) { const vis = Math.hypot(px - c.cx, pz - c.cz) < 230; c.meshes.forEach(m => { m.visible = vis; }); }
}

stockExtras();
buildLakes();
buildWilderness();
initDone = true;                 // дальше всё, что появляется, считается «новым» и сохраняется отдельно
Math.random = _realRandom;       // обычная случайность для игры
const initSnap = {               // что было в мире с самого начала
  items: new Set(items.map(i => i.id)), ammo: new Set(ammoBoxes.map(m => m.userData.id)),
  piles: new Map(piles.map(p => [p.id, p.n])), cases: new Set(cases.map(c => c.id)), trees: new Set(trees.map(t => t.id)),
};
// Кат-сцены: вступление и финал живут в папке scenes/. Им отдаются только нужные куски движка и состояния игры.
const cutscenes = initCutscenes({
  THREE, scene, camera, renderer, zBoxes, mulberry, m4, m4mul, mulCol, bKit, h01, colliders, blockers,
  carK, milTruckK, sandWallK, crateK, barrelsK, mastK, textPlane, clearTrees, terrainY, WATER_Y,
  hash: n => _hash2(n, 733),                       // число 0..1 из зерна мира: точка эвакуации у всех игроков одна
  get yaw() { return yaw; }, set yaw(v) { yaw = v; }, get pitch() { return pitch; }, set pitch(v) { pitch = v; },
  get hour() { return gameHour; }, set hour(v) { gameHour = v; },
  get day() { return day; }, get health() { return health; }, get gameStarted() { return gameStarted; },
  net, menuOpen: () => menuOpen, riding: () => riding, inBasement: () => inBasement,
  notify, mainMenu,
  requestLock: () => { try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* клик по экрану вернёт мышь */ } },
  hudEls: [hud, avatar, hotbar, cross, notice, promptEl, chatLog],
  houses: housePositions, stations, warehouses, garages, towers, outposts, armories,
});
bootGame();
loop();
