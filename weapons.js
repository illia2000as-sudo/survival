// Модели нового оружия (1.13.0, часть 2): охотничья винтовка и мачете.
// Как и у топора, всё собрано из деталей zBoxes с цветами вершин и склеено в несколько мешей (дерево, металл, кожа и обмотки).
// Винтовка строится «стволом вперёд» (+Z, начало - центр рукояти), для вида от первого лица внутренняя группа поворачивается на 180°
// (ствол смотрит в -Z, как у остального оружия в руках). Подвижные части: затвор (bolt) и левая рука (leftHand).
// Здесь нет Math.random: детали идут от mulberry с фиксированным зерном.
export function createWeaponModels(env) {
  const { THREE, zBoxes, mulberry } = env;
  const mk = (r, m) => { const x = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: r, metalness: m, flatShading: true }); x.userData.shared = true; return x; };
  const matWood = mk(0.72, 0.05), matMetal = mk(0.42, 0.7), matSoft = mk(0.9, 0);
  const STEEL = 0x2a2d30, STEEL_L = 0x4a5057, STEEL_B = 0x8a9096, BLACK = 0x0d0e10, RUBBER = 0x1a1a1c;
  const WOOD = 0x7a4a22, WOOD_D = 0x4e3119, WOOD_L = 0x9a6a3a;
  const SKIN = 0xd9a67a, SKIN_D = 0xc08e63, SKIN_L = 0xe7b88e, SLEEVE = 0x3a4a6a, SLEEVE_D = 0x2c3a56;

  function dirM(c, d) { // матрица 4x4: ось Z вдоль направления d, начало в точке c (детали вдоль руки)
    const l = Math.hypot(d[0], d[1], d[2]), z = [d[0] / l, d[1] / l, d[2] / l];
    let x = [z[2], 0, -z[0]]; const lx = Math.hypot(x[0], x[2]) || 1; x = [x[0] / lx, 0, x[2] / lx];
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, c[0], c[1], c[2], 1];
  }
  const arm = (K, wrist, dir) => { // предплечье (кожа) и рукав с манжетой, уходят от кисти по направлению dir
    const n = Math.hypot(...dir), at = o => [wrist[0] + dir[0] / n * o, wrist[1] + dir[1] / n * o, wrist[2] + dir[2] / n * o];
    K.boxM(0.07, 0.07, 0.17, SKIN, dirM(at(0.08), dir));
    K.boxM(0.115, 0.115, 0.8, SLEEVE, dirM(at(0.17 + 0.4), dir));
    K.boxM(0.125, 0.125, 0.035, SLEEVE_D, dirM(at(0.17 + 0.018), dir));
  };
  const meshes = (g, list) => { list.forEach(([K, mat]) => { if (K.count()) g.add(K.mesh(mat)); }); return g; };

  // --- Охотничья винтовка с оптикой. opts.hands === false - без рук; opts.world === true - модель для аватара (ствол в +Z) ---
  function createRifle(opts) {
    opts = opts || {};
    const rnd = mulberry(5150), W = zBoxes(rnd), M = zBoxes(rnd), S = zBoxes(rnd), Bm = zBoxes(rnd), Hr = zBoxes(rnd), Hl = zBoxes(rnd);

    // ствольная коробка с окном выброса и мостиком
    M.box(0.044, 0.058, 0.24, STEEL, 0, 0.035, 0.07);
    M.box(0.036, 0.012, 0.2, STEEL_L, 0, 0.07, 0.08);
    M.box(0.04, 0.024, 0.036, STEEL, 0, 0.062, -0.05);
    M.box(0.003, 0.026, 0.07, BLACK, -0.0225, 0.04, 0.09); M.box(0.003, 0.02, 0.05, STEEL_L, 0.0225, 0.04, 0.1); // окно выброса справа (для стрелка -X)
    [[0.0225, 0.058, 0.15], [-0.0225, 0.058, 0.15], [0.0225, 0.058, 0.0], [-0.0225, 0.058, 0.0]].forEach(([x, y, z]) => M.box(0.004, 0.005, 0.005, STEEL_B, x, y, z));
    M.box(0.0022, 0.012, 0.06, STEEL_B, 0.0235, 0.025, 0.12); M.box(0.0022, 0.006, 0.03, STEEL_B, -0.0235, 0.015, 0.05); // гравировка
    // ствол: хомут, ствол, бандажное кольцо, дульный срез, мушка на пандусе
    M.cylZ(0.0175, 0.05, STEEL_L, 0, 0.05, 0.215, 8); M.cylZ(0.0135, 0.54, STEEL, 0, 0.05, 0.46, 8);
    M.cylZ(0.0165, 0.014, STEEL_L, 0, 0.05, 0.42, 8); M.cylZ(0.0145, 0.02, BLACK, 0, 0.05, 0.74, 8);
    M.box(0.01, 0.012, 0.04, STEEL, 0, 0.071, 0.69); M.box(0.004, 0.014, 0.004, 0xe8e0c8, 0, 0.082, 0.70);
    // оптика: труба, раструб, окуляр, линзы, кольцо, барабанчики и крепления
    M.cylZ(0.0185, 0.26, 0x1b1d20, 0, 0.122, 0.09, 10);
    M.frustum(0.0185, 0.027, 0.05, 10, 0x1b1d20, m4x(0, 0.122, 0.245));
    M.frustum(0.026, 0.0185, 0.045, 10, 0x1b1d20, m4x(0, 0.122, -0.06));
    M.cylZ(0.0235, 0.004, 0x24506e, 0, 0.122, 0.272, 10); M.cylZ(0.0215, 0.004, 0x1a2a3a, 0, 0.122, -0.0825, 10);
    M.cylZ(0.0215, 0.02, STEEL, 0, 0.122, -0.03, 10); M.cyl(0.009, 0.022, STEEL_L, 0, 0.14, 0.09, 8); M.cylX(0.009, 0.022, STEEL_L, -0.026, 0.122, 0.09, 8);
    [0.02, 0.17].forEach(z => { M.cylZ(0.0235, 0.022, STEEL, 0, 0.122, z, 10); M.box(0.026, 0.04, 0.03, STEEL, 0, 0.092, z); });
    // спуск, скоба, магазин с донной крышкой
    M.box(0.006, 0.008, 0.075, STEEL_L, 0, -0.048, 0.03); M.box(0.006, 0.034, 0.008, STEEL_L, 0, -0.032, 0.068); M.box(0.006, 0.034, 0.008, STEEL_L, 0, -0.032, -0.008);
    M.box(0.006, 0.024, 0.006, STEEL_B, 0, -0.028, 0.028, 0.3, 0, 0);
    M.box(0.034, 0.03, 0.1, STEEL, 0, -0.005, 0.11); M.box(0.036, 0.008, 0.104, STEEL_L, 0, -0.024, 0.11);
    // дерево: приклад профилем сбоку, щека, рукоять, цевьё с насечкой
    W.prism([[-0.04, 0.045], [-0.25, 0.042], [-0.43, 0.025], [-0.44, -0.12], [-0.36, -0.13], [-0.2, -0.075], [-0.08, -0.06], [-0.04, -0.02]], 0.04, WOOD, 0, 0, 0, 0, -Math.PI / 2, 0);
    W.box(0.034, 0.014, 0.1, WOOD_L, 0, 0.05, -0.2); W.box(0.036, 0.1, 0.045, WOOD, 0, -0.07, -0.03, 0.35, 0, 0);
    W.box(0.05, 0.045, 0.3, WOOD, 0, 0.013, 0.36); W.box(0.052, 0.004, 0.18, WOOD_D, 0, -0.006, 0.36);
    [-1, 1].forEach(sd => { for (let i = 0; i < 6; i++) W.box(0.003, 0.028, 0.006, WOOD_D, sd * 0.0255, 0.013, 0.3 + i * 0.02); }); // насечка на цевье
    [-1, 1].forEach(sd => W.box(0.0025, 0.03, 0.26, WOOD_D, sd * 0.026, 0.0, 0.08, 0, 0, 0)); // линия стыка по бокам
    W.box(0.0025, 0.1, 0.004, WOOD_D, 0.0185, -0.07, -0.03, 0.35, 0, 0);
    S.box(0.042, 0.15, 0.02, RUBBER, 0, -0.048, -0.445, 0.07, 0, 0); S.box(0.052, 0.047, 0.012, 0x1a1a1a, 0, 0.013, 0.516);
    M.box(0.012, 0.012, 0.012, STEEL_B, 0, -0.1, -0.4); M.box(0.012, 0.012, 0.012, STEEL_B, 0, -0.012, 0.47); // антабки
    // затвор: корпус, колпачок, стебель и шарик рукоятки (двигается при перезарядке и между выстрелами)
    Bm.cylZ(0.0105, 0.11, STEEL_B, 0, 0, 0.02, 8); Bm.cylZ(0.0125, 0.03, STEEL_L, 0, 0, -0.05, 8);
    Bm.tube([0, 0, -0.03], [-0.04, -0.018, -0.036], 0.004, STEEL_L, 6); Bm.cyl(0.011, 0.026, BLACK, -0.046, -0.035, -0.038, 8); // рукоятка справа
    // кисти и рукава (в кадре от первого лица)
    if (opts.hands !== false) {
      Hr.box(0.065, 0.085, 0.028, SKIN, 0, -0.08, -0.062); Hr.box(0.07, 0.07, 0.04, SKIN_D, 0, -0.095, 0.0);
      Hr.box(0.022, 0.022, 0.075, SKIN, 0.038, -0.035, -0.045, 0, 0.2, 0); Hr.box(0.012, 0.016, 0.055, SKIN_D, 0.012, -0.04, 0.035);
      for (let k = 0; k < 3; k++) Hr.box(0.016, 0.012, 0.02, SKIN_L, -0.018 + k * 0.018, -0.052, -0.07);
      arm(Hr, [0, -0.1, -0.07], [-0.35, -0.7, -0.6]);
      Hl.box(0.085, 0.04, 0.12, SKIN, 0, -0.02, 0); [-1, 1].forEach(sd => Hl.box(0.02, 0.06, 0.1, SKIN_D, sd * 0.048, 0.012, 0));
      Hl.box(0.02, 0.02, 0.07, SKIN, 0.03, 0.045, 0.01);
      arm(Hl, [0, -0.04, -0.06], [0.45, -0.7, -0.55]);
    }

    const root = new THREE.Group(), inner = new THREE.Group(), core = new THREE.Group();
    core.position.set(0, 0.075, 0.03);                     // центр рукояти - в начало координат
    inner.add(core); root.add(inner);
    if (!opts.world) inner.rotation.y = Math.PI;           // от первого лица ствол смотрит в -Z
    meshes(core, [[W, matWood], [M, matMetal], [S, matSoft]]);
    const bolt = new THREE.Group(); bolt.position.set(0, 0.045, 0); bolt.add(Bm.mesh(matMetal)); core.add(bolt);
    const leftHand = new THREE.Group(); leftHand.position.set(0, -0.01, 0.40); if (Hl.count()) leftHand.add(Hl.mesh(matSoft)); core.add(leftHand);
    if (Hr.count()) core.add(Hr.mesh(matSoft));
    const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.05, 0.75); core.add(muzzle);
    return { root, inner, core, bolt, leftHand, muzzle };
  }
  function m4x(x, y, z) { // фрустум вдоль Z: поворот на 90° вокруг X и сдвиг
    const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, x, y, z, 1];
  }

  // --- Мачете. Рукоять вдоль +Y (низ в 0), лезвие вверх, кромка смотрит в -Z. opts.hands === false - без рук ---
  function createMachete(opts) {
    opts = opts || {};
    const rnd = mulberry(5151), M = zBoxes(rnd), S = zBoxes(rnd), Hn = zBoxes(rnd);
    const BLADE = 0xb4bcc2, BLADE_D = 0x7a8288, EDGE = 0xdde3e8;
    // рукоять: обмотка кольцами, колпачок и темляк
    for (let i = 0; i < 7; i++) S.box(0.034, 0.016, 0.046, i % 2 ? 0x1c1c1e : 0x2c2c30, 0, 0.012 + i * 0.02, 0);
    S.box(0.03, 0.15, 0.036, 0x141416, 0, 0.085, 0);
    M.box(0.04, 0.022, 0.05, STEEL, 0, -0.006, 0); M.box(0.052, 0.012, 0.09, STEEL_L, 0, 0.158, -0.004);
    [[0, -0.012, 0.028], [0, -0.07, 0.045], [0, -0.1, 0.02], [0, -0.075, 0.0]].forEach((p, i, a) => { if (i) S.tube(a[i - 1], p, 0.004, 0x5a6240, 5); });
    // клинок: профиль (z, y) с острием, выдавлен тонко по X
    M.prism([[0.025, 0.165], [0.025, 0.5], [-0.01, 0.62], [-0.06, 0.65], [-0.072, 0.58], [-0.078, 0.42], [-0.06, 0.26], [-0.03, 0.165]], 0.006, BLADE, 0, 0, 0, 0, -Math.PI / 2, 0);
    const edge = [[-0.03, 0.165], [-0.06, 0.26], [-0.078, 0.42], [-0.072, 0.58], [-0.06, 0.65]];
    for (let i = 0; i < edge.length - 1; i++) { // блик на кромке
      const [z0, y0] = edge[i], [z1, y1] = edge[i + 1], dz = z1 - z0, dy = y1 - y0, len = Math.hypot(dz, dy);
      M.box(0.0085, 0.012, len + 0.004, EDGE, 0, (y0 + y1) / 2, (z0 + z1) / 2, Math.atan2(-dy, dz), 0, 0);
    }
    M.box(0.0075, 0.36, 0.012, BLADE_D, 0, 0.36, -0.008);                       // долы
    M.box(0.0078, 0.34, 0.006, 0xd0d6da, 0, 0.34, 0.022);                       // фаска на обухе
    M.box(0.0069, 0.07, 0.03, 0x5a1a14, 0, 0.5, -0.03); M.box(0.0069, 0.05, 0.02, 0x5a1a14, 0, 0.33, -0.045); // кровь
    M.box(0.0069, 0.03, 0.02, 0x7a4a2e, 0, 0.23, 0.0); M.box(0.0069, 0.02, 0.015, 0x7a4a2e, 0, 0.56, 0.0);   // ржавчина
    [0.2, 0.27, 0.34].forEach(y => M.box(0.0072, 0.01, 0.004, BLADE_D, 0, y, 0.019));
    M.box(0.0069, 0.014, 0.012, BLADE_D, 0, 0.45, -0.076);                      // зазубрина
    if (opts.hands !== false) {
      Hn.box(0.084, 0.076, 0.036, SKIN, 0, 0.085, 0.05); [-1, 1].forEach(sd => Hn.box(0.024, 0.076, 0.075, SKIN_D, sd * 0.043, 0.085, 0.0));
      Hn.box(0.092, 0.076, 0.03, SKIN_D, 0, 0.085, -0.045);
      for (let k = 0; k < 3; k++) Hn.box(0.094, 0.003, 0.032, 0x8a5a38, 0, 0.06 + k * 0.025, -0.046);
      for (let k = 0; k < 4; k++) Hn.box(0.016, 0.014, 0.018, SKIN_L, (k - 1.5) * 0.021, 0.127, 0.054);
      Hn.box(0.022, 0.024, 0.065, SKIN, 0.05, 0.107, 0.03, 0.5, 0, 0);
      arm(Hn, [0, 0.055, 0.04], [0.3, -0.7, 0.65]);
    }
    const root = new THREE.Group(), blade = new THREE.Group();
    blade.rotation.y = 0.7; meshes(blade, [[M, matMetal], [S, matSoft]]); root.add(blade); // клинок и обмотка повёрнуты вокруг рукояти
    if (Hn.count()) root.add(Hn.mesh(matSoft));
    return { root };
  }

  return { createRifle, createMachete };
}
