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

scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.2));
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
for (let i = 0; i < 150; i++) {
  const x = (Math.random() - 0.5) * 300, z = (Math.random() - 0.5) * 300;
  if (Math.abs(x) < 8 && Math.abs(z) < 8) continue;
  box(0.6, 3, 0.6, 0x5b3a1e, x, 1.5, z, true);
  box(3, 2.5, 3, 0x2f5a2a, x, 4, z);
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
const inv = { food: 0, water: 0, medkit: 0 };

// Пистолет в руках (прикреплён к камере)
const gun = new THREE.Group();
const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.4), new THREE.MeshStandardMaterial({ color: 0x222222 }));
const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.1), new THREE.MeshStandardMaterial({ color: 0x4a2f1a }));
grip.position.set(0, -0.12, 0.12);
gun.add(barrel, grip);
gun.position.set(0.3, -0.25, -0.6);
camera.add(gun);

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
const itemColors = { food: 0xb5651d, water: 0x3a8fd6, medkit: 0xf2f2f2 };
const items = [];
function spawnItem(type, x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: itemColors[type] }));
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
}

// HUD
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:10px;left:10px;color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;white-space:pre';
document.body.appendChild(hud);
const hotbar = document.createElement('div');
hotbar.style.cssText = 'position:fixed;bottom:15px;left:50%;transform:translateX(-50%);color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000;background:rgba(0,0,0,0.4);padding:8px 16px;border-radius:6px';
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

// Управление
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Digit1') useItem('food');
  if (e.code === 'Digit2') useItem('water');
  if (e.code === 'Digit3') useItem('medkit');
});
addEventListener('keyup', e => keys[e.code] = false);
renderer.domElement.addEventListener('click', () => {
  if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
  else attack();
});
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.002;
  pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.002));
});

// Перезарядка на клавишу R
addEventListener('keydown', e => {
  if (e.code !== 'KeyR' || reloading || ammo >= 12 || reserve <= 0) return;
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
  const dt = Math.min(clock.getDelta(), 0.1);

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
      z.mesh.position.addScaledVector(to, 2 * dt);
      z.mesh.rotation.y = Math.atan2(to.x, to.z);
      resolveCollisions(z.mesh.position, 0.6);
    }
    z.cooldown -= dt;
    if (dist <= 1.5 && z.cooldown <= 0 && health > 0) { health -= 10; z.cooldown = 1; }
  }

  if (health <= 0) {
    health = 0;
    hud.textContent = `Ты умер. Убито: ${kills}. Нажми F5, чтобы начать заново`;
  } else {
    hud.textContent =
      `Здоровье: ${Math.ceil(health)}   Еда: ${Math.ceil(hunger)}   Вода: ${Math.ceil(thirst)}\n` +
      `Убито: ${kills}   Патроны: ${reloading ? 'перезарядка...' : ammo} / ${reserve}`;
  }
  hotbar.textContent = `[1] Еда x${inv.food}    [2] Вода x${inv.water}    [3] Аптечка x${inv.medkit}`;

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
