// Люди для кат-сцен: солдаты, выжившие, герой, силуэты заражённых. Собираются из коробок с цветами вершин (как здания и зомби).
// Модели-заглушки: их можно заменить своими, пока сохраняется возвращаемая форма { group, legL, legR, update(t, walking) }.
export function createPeople(G) {
  const { THREE, zBoxes, mulberry, m4, m4mul } = G;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }); mat.userData.shared = true;
  const LOOKS = {
    soldier: { shirt: 0x4a5230, pants: 0x3f4a2c, skin: 0xc9a584, cap: 0x3f4a2c, vest: 0x2f3626, boots: 0x1a1a1a, helmet: true, rifle: true },
    officer: { shirt: 0x55603a, pants: 0x3f4a2c, skin: 0xb98f6e, cap: 0x2f3626, vest: 0x3f4a2c, boots: 0x1a1a1a, helmet: false, rifle: false },
    survivor: { shirt: 0x6a5a4a, pants: 0x3a4250, skin: 0xd2ad8a, cap: 0x4a3a2a, vest: 0, boots: 0x2a2420, helmet: false, rifle: false, pack: true },
    hero: { shirt: 0x5a3a2a, pants: 0x2f3a4a, skin: 0xcaa586, cap: 0x2a2a2a, vest: 0, boots: 0x2a2018, helmet: false, rifle: false, pack: true },
    ghoul: { shirt: 0x1d1d1d, pants: 0x151515, skin: 0x161616, cap: 0x101010, vest: 0, boots: 0x101010, helmet: false, rifle: false, ghoul: true },
  };
  const SHIRTS = [0x6a5a4a, 0x4a5a6a, 0x7a3a3a, 0x3a5a4a, 0x8a7a5a, 0x5a4a6a];
  function build(kind, seed = 1, pose = 'stand') {
    const L = Object.assign({}, LOOKS[kind] || LOOKS.survivor), rnd = mulberry((seed * 2654435761) >>> 0 || 1);
    if (kind === 'survivor') L.shirt = SHIRTS[Math.floor(rnd() * SHIRTS.length)];
    const body = zBoxes(rnd, y => 0.8 + 0.2 * Math.min(1, y / 1.2)), group = new THREE.Group();
    const lean = L.ghoul ? 0.45 : 0, ty = 1.17;
    // верх: туловище, голова, головной убор, руки, рюкзак, винтовка
    body.box(0.44, 0.58, 0.26, L.shirt, 0, ty, 0, lean, 0, 0);
    if (L.vest) { body.box(0.48, 0.42, 0.3, L.vest, 0, ty + 0.03, 0); [-0.14, 0, 0.14].forEach(o => body.box(0.1, 0.12, 0.06, mulCol(L.vest, 1.2), o, ty - 0.1, 0.17)); }
    const headY = L.ghoul ? 1.5 : 1.6, headZ = L.ghoul ? 0.22 : 0;
    body.box(0.2, 0.23, 0.22, L.skin, 0, headY, headZ, lean * 0.6, 0, 0);
    if (L.helmet) body.blob(0.17, 0x3f4a2c, m4(0, headY + 0.1, headZ), 1.1, 0.8, 1.15, 0, 0.06); else if (!L.ghoul) body.box(0.22, 0.07, 0.24, L.cap, 0, headY + 0.13, headZ);
    if (L.ghoul) body.box(0.05, 0.03, 0.01, 0x9a2a1a, 0, headY + 0.02, headZ + 0.115);
    const arm = (sx, rx, rz, col) => body.boxM(0.11, 0.55, 0.12, col, m4mul(m4(sx, 1.42, 0, rx, 0, rz), m4(0, -0.27, 0)));
    const sleeve = L.shirt;
    if (L.ghoul) { arm(-0.27, -1.35, -0.1, sleeve); arm(0.27, -1.2, 0.1, sleeve); }
    else if (pose === 'rifle' && L.rifle) { arm(-0.27, -1.0, 0.25, sleeve); arm(0.27, -1.25, -0.3, sleeve); }
    else if (pose === 'wave') { arm(-0.27, 0.05, -0.05, sleeve); arm(0.27, 0, 2.6, sleeve); }
    else { arm(-0.27, 0.04, -0.05, sleeve); arm(0.27, 0.04, 0.05, sleeve); }
    if (L.rifle) { body.box(0.06, 0.1, 0.78, 0x1f1f1f, 0.06, 1.2, 0.3, 0.1, 0.1, 0); body.box(0.05, 0.16, 0.12, 0x2a2a2a, 0.06, 1.1, 0.25); body.tube([0.06, 1.22, 0.65], [0.06, 1.24, 0.95], 0.018, 0x1a1a1a, 5); }
    if (L.pack) body.box(0.34, 0.46, 0.18, kind === 'hero' ? 0x4a5a3a : 0x5a4a30, 0, ty + 0.05, -0.2);
    if (kind === 'officer') body.box(0.1, 0.05, 0.02, 0xb8a040, 0.12, ty + 0.2, 0.14);
    group.add(body.mesh(mat));
    // ноги отдельными мешами: можно качать при ходьбе
    const leg = sx => { const b = zBoxes(rnd, null); b.box(0.17, 0.86, 0.2, L.pants, 0, -0.43, 0); b.box(0.18, 0.12, 0.3, L.boots, 0, -0.9, 0.05); const m = b.mesh(mat); m.position.set(sx, 0.9, 0); group.add(m); return m; };
    const legL = leg(-0.1), legR = leg(0.1);
    const P = { group, legL, legR, kind, t0: rnd() * 6, update(t, walking) { // качает ноги и возвращает подпрыгивание корпуса (его прибавляет вызывающий к высоте)
      if (walking) { const s = Math.sin(t * 7) * 0.55; legL.rotation.x = s; legR.rotation.x = -s; return Math.abs(Math.sin(t * 7)) * 0.04; }
      legL.rotation.x = legR.rotation.x = 0; return 0;
    } };
    return P;
  }
  function mulCol(c, k) { const r = Math.min(255, ((c >> 16) & 255) * k), g = Math.min(255, ((c >> 8) & 255) * k), b = Math.min(255, (c & 255) * k); return (r << 16) | (g << 8) | b; }
  return { build, mat };
}
