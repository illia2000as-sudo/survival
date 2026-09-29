import * as THREE from 'three';

// --- Сцена ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8a9a8a);
scene.fog = new THREE.Fog(0x8a9a8a, 10, 80);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 1.7, 0);
camera.rotation.order = 'YXZ';

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

const box = (w, h, d, color, x, y, z) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  m.position.set(x, y, z);
  scene.add(m);
  return m;
};

// Деревья
for (let i = 0; i < 150; i++) {
  const x = (Math.random() - 0.5) * 300, z = (Math.random() - 0.5) * 300;
  if (Math.abs(x) < 8 && Math.abs(z) < 8) continue;
  box(0.6, 3, 0.6, 0x5b3a1e, x, 1.5, z);
  box(3, 2.5, 3, 0x2f5a2a, x, 4, z);
}
// Заброшенные дома
for (let i = 0; i < 8; i++) {
  const x = (Math.random() - 0.5) * 200, z = (Math.random() - 0.5) * 200;
  if (Math.abs(x) < 15 && Math.abs(z) < 15) continue;
  box(8, 4, 8, 0x8a8074, x, 2, z);
  box(9, 0.6, 9, 0x4a3a35, x, 4.3, z);
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
  scene.add(g);
  zombies.push({ mesh: g, hp: 3, cooldown: 0 });
}
for (let i = 0; i < 12; i++) spawnZombie();

// --- Игрок ---
let health = 100, yaw = 0, pitch = 0, kills = 0;
const keys = {};
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:10px;left:10px;color:#fff;font:20px monospace;text-shadow:1px 1px 3px #000';
document.body.appendChild(hud);
const cross = document.createElement('div');
cross.textContent = '+';
cross.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font:24px monospace';
document.body.appendChild(cross);

addEventListener('keydown', e => keys[e.code] = true);
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

// Удар: бьём зомби перед собой
function attack() {
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  for (const z of zombies) {
    const to = z.mesh.position.clone().sub(camera.position).setY(0);
    if (to.length() < 3 && to.normalize().dot(fwd) > 0.7) {
      z.hp--;
      z.mesh.position.addScaledVector(fwd, 1);
    }
  }
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
  }
  camera.rotation.set(pitch, yaw, 0);

  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    if (z.hp <= 0) { scene.remove(z.mesh); zombies.splice(i, 1); kills++; spawnZombie(); continue; }
    const to = camera.position.clone().sub(z.mesh.position).setY(0);
    const dist = to.length();
    if (dist < 35 && dist > 1.2) {
      to.normalize();
      z.mesh.position.addScaledVector(to, 2 * dt);
      z.mesh.rotation.y = Math.atan2(to.x, to.z);
    }
    z.cooldown -= dt;
    if (dist <= 1.5 && z.cooldown <= 0 && health > 0) { health -= 10; z.cooldown = 1; }
  }

  hud.textContent = health > 0
    ? `Здоровье: ${health}   Убито: ${kills}`
    : `Ты умер. Убито: ${kills}. Нажми F5, чтобы начать заново`;
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
