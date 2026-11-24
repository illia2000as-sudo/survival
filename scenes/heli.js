// Вертолёт для кат-сцен: корпус с кабиной и сдвижной дверью, хвостовая балка, несущий и хвостовой винты,
// навигационные огни и мигалки, поисковый прожектор. Собран из коробок (zBoxes), нос смотрит в локальный -Z, земля y = 0.
// createHelicopter(G, { seed, spool }) -> { group, update(dt), spool, spoolTarget, setDoor(k), setSearch(on), beam }
// createDust(G, n) -> { sprites, update(dt, x, z, groundY, k) }: пыль от винта, разлетается кольцом.
export function createHelicopter(G, opts = {}) {
  const { THREE, zBoxes, mulberry } = G, PI = Math.PI, clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = mulberry(opts.seed || 77);
  const OL = 0x4a5530, OLD = 0x3b4426, DK = 0x24272a, MT = 0x6a6f75, GL = 0x1c2c3a, WH = 0xe8e4d8, RD = 0xb02a1a, YL = 0xc89a28;
  const B = zBoxes(rnd), T = zBoxes(rnd), GS = zBoxes(rnd), LI = zBoxes(rnd), R = zBoxes(rnd), TR = zBoxes(rnd), DR = zBoxes(rnd);
  const matBody = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.25, flatShading: true });
  const matGlass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.65, flatShading: true, transparent: true, opacity: 0.72 });
  const matLamp = new THREE.MeshBasicMaterial({ vertexColors: true });
  [matBody, matGlass, matLamp].forEach(m => { m.userData.shared = true; });

  // --- нос и кабина ---
  B.box(2.3, 1.1, 2.7, OL, 0, 1.3, -3.05);                                   // нижняя часть носа
  B.box(2.3, 0.14, 2.5, OL, 0, 2.95, -3.0);                                  // крыша кабины экипажа
  GS.box(2.2, 1.05, 2.5, GL, 0, 2.4, -3.0, 0.1);                             // остекление пилотов
  [-1.12, 0, 1.12].forEach(x => B.box(0.08, 1.05, 0.08, DK, x, 2.4, -4.2));  // стойки остекления
  B.box(2.5, 2.2, 5.0, OL, 0, 1.85, 0.8);                                    // грузовая кабина
  B.box(1.9, 1.7, 1.4, OL, 0, 2.1, 3.9);                                     // переход к хвосту
  B.box(2.3, 0.3, 6.2, OLD, 0, 0.75, 0.2);                                   // днище
  T.box(2.52, 0.16, 5.02, YL, 0, 1.2, 0.8);                                  // полоса вдоль борта
  [-1, 1].forEach(s => {                                                     // красный крест на белом по бортам носа
    T.box(0.03, 0.7, 0.7, WH, s * 1.17, 1.3, -3.0); T.box(0.035, 0.5, 0.14, RD, s * 1.18, 1.3, -3.0); T.box(0.035, 0.14, 0.5, RD, s * 1.18, 1.3, -3.0);
  });
  // --- двигатель и мачта ---
  B.box(1.7, 0.7, 2.6, OL, 0, 3.3, 0.8); T.box(1.2, 0.4, 0.05, DK, 0, 3.4, -0.52);
  [-0.6, 0.6].forEach(x => { B.box(0.4, 0.4, 0.8, DK, x, 3.35, 2.3); B.box(0.3, 0.3, 0.3, 0x15171a, x, 3.35, 2.8); });
  B.cyl(0.16, 0.9, DK, 0, 3.6, 0.8, 8);
  // --- хвост ---
  B.cone(0.8, 0.28, 6.8, OL, 0, -1.25, 7.0, 10, PI / 2, 0);                  // хвостовая балка (вдоль +Z)
  B.box(0.2, 2.3, 1.5, OL, 0, 3.3, 10.0, 0.28, 0, 0); B.box(0.22, 0.3, 0.6, DK, 0, 4.45, 10.6); // киль
  B.box(3.2, 0.12, 0.9, OL, 0, 2.35, 9.6);                                   // стабилизатор
  [-1.6, 1.6].forEach(x => B.box(0.1, 0.5, 0.9, OLD, x, 2.35, 9.6));
  // --- шасси: полозья со стойками ---
  [-1, 1].forEach(s => {
    B.box(0.14, 0.14, 6.4, DK, s * 1.25, 0.07, 0.4); B.box(0.14, 0.14, 0.9, DK, s * 1.25, 0.2, -3.6, -0.45);
    [-1.4, 2.6].forEach(z => B.box(0.12, 0.7, 0.12, DK, s * 1.2, 0.45, z, 0, 0, s * 0.12));
  });
  // --- левый борт: окна, правый: проём двери (дверь отдельно, она ездит) ---
  GS.box(0.05, 0.7, 0.9, GL, -1.27, 2.3, 0.4); GS.box(0.05, 0.7, 0.9, GL, -1.27, 2.3, 1.8);
  T.box(0.06, 1.3, 1.8, 0x15181a, 1.27, 1.75, 0.9);                          // тёмный проём
  T.box(0.04, 0.9, 0.5, 0x55584a, 1.265, 1.75, 0.5); T.box(0.04, 0.9, 0.5, 0x55584a, 1.265, 1.75, 1.3); // спинки сидений видны из проёма
  GS.box(0.05, 0.7, 0.9, GL, 1.27, 2.3, 1.8);
  // --- прожектор и огни ---
  T.box(0.5, 0.4, 0.6, DK, 0, 0.62, -3.9); LI.box(0.34, 0.2, 0.1, 0xfff4dc, 0, 0.55, -4.22);
  LI.box(0.14, 0.14, 0.14, 0xff2a1a, -1.3, 1.6, -2.0); LI.box(0.14, 0.14, 0.14, 0x2aff4a, 1.3, 1.6, -2.0);
  const strobe = zBoxes(rnd), beacon = zBoxes(rnd);
  strobe.box(0.18, 0.18, 0.18, 0xffffff, 0, 4.6, 10.55); beacon.box(0.2, 0.14, 0.2, 0xff2a1a, 0, 0.62, 2.9);

  const group = new THREE.Group(), body = new THREE.Group(); group.add(body);
  body.add(B.mesh(matBody), T.mesh(matBody), GS.mesh(matGlass), LI.mesh(matLamp));
  const strobeM = strobe.mesh(matLamp), beaconM = beacon.mesh(matLamp); body.add(strobeM, beaconM);
  // дверь: отдельная группа, едет по борту вперёд и закрывает проём
  const door = new THREE.Group(); door.position.set(1.3, 1.75, 2.55); body.add(door);
  DR.box(0.08, 1.25, 1.7, OLD, 0, 0, 0); DR.box(0.1, 0.5, 0.8, GL, 0.0, 0.25, 0); DR.box(0.09, 0.06, 1.7, DK, 0, -0.4, 0);
  door.add(DR.mesh(matBody));
  // несущий винт: 4 лопасти крестом, цветные законцовки, ступица, размытый диск при раскрутке
  const rotor = new THREE.Group(); rotor.position.set(0, 4.55, 0.8); body.add(rotor);
  R.box(14.6, 0.06, 0.5, DK, 0, 0, 0); R.box(0.5, 0.06, 14.6, DK, 0, 0, 0); R.ball(0.32, MT, 0, 0.05, 0, 1, 0.7, 1, 0.02);
  [-6.9, 6.9].forEach(x => R.box(0.9, 0.07, 0.52, YL, x, 0, 0)); [-6.9, 6.9].forEach(z => R.box(0.52, 0.07, 0.9, YL, 0, 0, z));
  rotor.add(R.mesh(matBody));
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(7.3, 7.3, 0.02, 40), new THREE.MeshBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  disc.position.copy(rotor.position); body.add(disc);
  // хвостовой винт
  const tail = new THREE.Group(); tail.position.set(0.38, 3.3, 10.2); body.add(tail);
  TR.box(0.05, 2.0, 0.22, DK, 0, 0, 0); TR.box(0.05, 0.22, 2.0, DK, 0, 0, 0); TR.cyl(0.1, 0.12, MT, 0.0, -0.06, 0, 8);
  tail.add(TR.mesh(matBody));
  // луч прожектора: конус с вершиной у носа, включается setSearch(true)
  const bg = new THREE.CylinderGeometry(0.2, 4.2, 30, 18, 1, true); bg.translate(0, -15, 0);
  const beam = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: 0xcfe4ff, transparent: true, opacity: 0.14, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
  beam.position.set(0, 0.55, -4.2); beam.rotation.x = 0.5; beam.visible = false; body.add(beam);

  const H = { group, body, rotor, tail, door, beam, spool: opts.spool || 0, spoolTarget: opts.spool || 0, doorK: 0, t: 0, ang: 0 };
  H.setDoor = k => { H.doorK = k; door.position.z = 2.55 + (0.9 - 2.55) * k; }; // 0 - открыта, 1 - закрыта
  H.setSearch = on => { beam.visible = !!on; };
  H.update = dt => {
    H.t += dt; H.spool += (H.spoolTarget - H.spool) * (1 - Math.exp(-dt * 0.55));
    const s = H.spool; H.ang += dt * s * 32;
    rotor.rotation.y = H.ang; tail.rotation.x = H.ang * 1.9; disc.material.opacity = 0.17 * s * s;
    strobeM.visible = (H.t % 1.1) < 0.09; beaconM.visible = (H.t % 1.5) < 0.14;
    body.rotation.z = Math.sin(H.t * 23) * 0.004 * s; body.position.y = Math.sin(H.t * 31) * 0.012 * s; // вибрация на оборотах
  };
  return H;
}

export function createDust(G, n = 20) {
  const { THREE } = G, c = document.createElement('canvas'); c.width = c.height = 64;
  const q = c.getContext('2d'), gr = q.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(255,255,255,0.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); q.fillStyle = gr; q.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c), sprites = [], st = [];
  for (let i = 0; i < n; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xb9aa8c, transparent: true, depthWrite: false, opacity: 0 })); sp.visible = true;
    sprites.push(sp); st.push({ a: i / n * Math.PI * 2 + (i % 3) * 0.4, age: (i * 0.37) % 1, sp: 0.8 + (i % 4) * 0.15 });
  }
  return {
    sprites,
    update(dt, cx, cz, gy, k) {
      for (let i = 0; i < n; i++) {
        const o = st[i], s = sprites[i]; o.age += dt * 0.55 * o.sp; if (o.age > 1) o.age -= 1; o.a += dt * 0.35;
        const r = 2 + o.age * 13; s.position.set(cx + Math.cos(o.a) * r, gy + 0.4 + o.age * 2.4, cz + Math.sin(o.a) * r);
        const sc = 2 + o.age * 7; s.scale.set(sc, sc * 0.7, 1); s.material.opacity = Math.max(0, k) * 0.5 * (1 - o.age) * Math.min(1, o.age * 6);
      }
    },
  };
}
