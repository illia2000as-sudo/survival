// Админ-транспорт и админ-оружие (2.3.0): истребитель, РПГ-7 для вида от первого лица и ракета.
// Всё собрано из zBoxes (цвета вершин). Нос истребителя и РПГ смотрит в -Z, земля истребителя y = 0, в модулях нет Math.random.
// createJetModels({ THREE, zBoxes, mulberry }) -> { createJet(), createRPG(), createRocket() }
//   createJet() -> { root, front, gear, flame, flameCore, aileronL, aileronR, elevL, elevR, eye, muzzles[2], pods[4] }
//     front - нос с кабиной (в виде из кабины скрывается), gear - шасси (убирается в полёте), flame/flameCore - форсаж (scale.z = длина),
//     рули: aileron*.rotation.x и elev*.rotation.x, eye - глаза пилота, muzzles - стволы пушки, pods - узлы подвески ракет.
//   createRPG() -> { root, warhead, muzzle }: warhead - граната в стволе (скрывается, когда не заряжено)
//   createRocket() -> { root, flame }: ракета смотрит в +Z (для Object3D.lookAt)
export function createJetModels(env) {
  const { THREE, zBoxes, mulberry } = env, PI = Math.PI;
  const mk = (r, m, extra) => { const x = new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: r, metalness: m, flatShading: true }, extra || {})); x.userData.shared = true; return x; };
  const metal = mk(0.45, 0.55), glass = mk(0.1, 0.7, { transparent: true, opacity: 0.55 }), matte = mk(0.85, 0.05);
  const glow = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending });
  const glowCore = new THREE.MeshBasicMaterial({ color: 0xcfe4ff, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  [glow, glowCore].forEach(m => { m.userData.shared = true; });
  const coneGeo = (dir) => { const g = new THREE.ConeGeometry(0.5, 1, 14, 1, true); g.rotateX(dir * PI / 2); g.translate(0, 0, dir * 0.5); return g; }; // основание в начале, вершина по dir (+1: +Z, -1: -Z)
  const jetFlameGeo = coneGeo(1), rocketFlameGeo = coneGeo(-1);
  const BODY = 0x76808a, BELLY = 0x5c646c, DARK = 0x24272b, INT = 0x15171a, RED = 0xb02a1a, WH = 0xe8e4d8, OLV = 0x5a6048, GLS = 0x3a4a52;

  function createJet() {
    const rnd = mulberry(404), B = zBoxes(rnd), F = zBoxes(rnd), GL = zBoxes(rnd), G = zBoxes(rnd), M = zBoxes(rnd);
    // фюзеляж: средняя часть, днище, хребет, воздухозаборники
    B.box(1.7, 1.5, 7.6, BODY, 0, 1.9, 2.8); B.box(1.5, 0.25, 7.4, BELLY, 0, 1.15, 2.8); B.box(0.9, 0.3, 5.0, OLV, 0, 2.78, 3.4);
    [-1, 1].forEach(s => {
      B.box(0.8, 0.95, 3.6, BODY, s * 1.2, 1.5, -0.7); B.box(0.7, 0.8, 0.06, INT, s * 1.2, 1.5, -2.52); // воздухозаборник и тёмный зев
      B.box(0.08, 0.5, 2.0, RED, s * 0.86, 2.0, 5.4, 0, 0, 0);                                           // красная полоса у киля
    });
    // передняя часть (скрывается в виде из кабины): блок, длинный конус носа, кабина, фонарь с рамой
    F.box(1.7, 1.5, 2.0, BODY, 0, 1.9, -2.0); F.cone(0.85, 0.07, 4.6, BODY, 0, -0.4, -5.3, 12, -PI / 2, 0); F.box(0.05, 0.05, 0.5, DARK, 0, 1.9, -7.6);
    F.box(1.1, 0.12, 2.2, DARK, 0, 2.7, -1.9); [-0.5, 0.5].forEach(s => F.box(0.06, 0.55, 2.1, DARK, s, 2.95, -1.9));
    GL.ball(1.0, GLS, 0, 2.75, -2.0, 0.52, 0.5, 1.7, 0.01);
    // крылья: ступенчатая стреловидная дельта, законцовки, ракеты на подвеске, звёзды
    for (let i = 0; i < 5; i++) {
      const xc = 1.25 + i * 0.9, le = -0.5 + xc * 0.55, te = 5.2, ch = te - le;
      [-1, 1].forEach(s => B.box(0.9, 0.14, ch, i % 2 ? BODY : mulCol(BODY, 0.94), s * xc, 1.55, (le + te) / 2));
    }
    [-1, 1].forEach(s => {
      B.box(0.2, 0.3, 1.6, RED, s * 5.5, 1.62, 3.4); B.box(0.9, 0.02, 0.9, WH, s * 3.1, 1.635, 3.2); B.box(0.5, 0.025, 0.5, RED, s * 3.1, 1.64, 3.2);
      // стабилизаторы-киль: два наклонённых киля со стреловидностью
      B.box(0.12, 2.3, 2.4, BODY, s * 1.0, 3.25, 5.5, 0.25, 0, -s * 0.22); B.box(0.14, 0.4, 1.2, RED, s * 1.18, 4.25, 6.1, 0.25, 0, -s * 0.22);
      // сопло
    });
    B.cone(0.72, 0.6, 1.3, DARK, 0, 1.25, 6.9, 14, PI / 2, 0); B.cone(0.8, 0.72, 0.4, 0x3a3d42, 0, 1.45, 6.4, 14, PI / 2, 0);
    // шасси
    G.box(0.1, 1.0, 0.1, DARK, 0, 0.85, -3.4); G.box(0.16, 0.6, 0.6, 0x15171a, 0, 0.3, -3.4); G.box(0.04, 0.4, 0.12, 0x9aa0a4, 0, 0.9, -3.3);
    [-1, 1].forEach(s => { G.box(0.12, 1.1, 0.12, DARK, s * 1.5, 0.9, 2.2); G.box(0.22, 0.7, 0.7, 0x15171a, s * 1.5, 0.35, 2.2); G.box(0.05, 0.35, 0.05, 0x9aa0a4, s * 1.4, 0.9, 2.0, 0, 0, s * 0.3); });
    // ракеты под крыльями
    const pods = [], mkMissile = (x, y, z) => { M.box(0.16, 0.16, 2.0, WH, x, y, z); M.cone(0.1, 0, 0.4, RED, x, y - 0.2, z - 1.2, 8, -PI / 2, 0); M.box(0.02, 0.3, 0.3, DARK, x, y, z + 0.9); M.box(0.3, 0.02, 0.3, DARK, x, y, z + 0.9); };
    [[-2.6, 1.3, 1.2], [2.6, 1.3, 1.2], [-3.7, 1.35, 1.8], [3.7, 1.35, 1.8]].forEach(([x, y, z]) => { mkMissile(x, y, z); const o = new THREE.Object3D(); o.position.set(x, y - 0.1, z - 1.2); pods.push(o); });

    const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
    const front = F.mesh(metal), gl = GL.mesh(glass), gear = G.mesh(matte); const gearG = new THREE.Group(); gearG.add(gear);
    const frontG = new THREE.Group(); frontG.add(front, gl);
    body.add(B.mesh(metal), M.mesh(metal), frontG, gearG);
    pods.forEach(o => body.add(o));
    // рули: элероны на крыльях и цельноповоротные стабилизаторы (вращаются вокруг X)
    const surf = (w, d, col, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); const s = zBoxes(rnd); s.box(w, 0.1, d, col, 0, 0, d / 2); g.add(s.mesh(metal)); body.add(g); return g; };
    const aileronL = surf(1.6, 0.8, 0x6a727c, -4.4, 1.55, 4.4), aileronR = surf(1.6, 0.8, 0x6a727c, 4.4, 1.55, 4.4);
    const elevL = new THREE.Group(), elevR = new THREE.Group(); elevL.position.set(-1.4, 1.95, 5.9); elevR.position.set(1.4, 1.95, 5.9);
    [elevL, elevR].forEach((g, i) => { const s = zBoxes(rnd); s.box(2.4, 0.12, 1.7, BODY, (i ? 1 : -1) * 1.2, 0, 0.55); g.add(s.mesh(metal)); body.add(g); });
    // форсаж: два конуса (внешний оранжевый, внутренний белый)
    const flame = new THREE.Mesh(jetFlameGeo, glow), flameCore = new THREE.Mesh(jetFlameGeo, glowCore);
    flame.position.set(0, 1.35, 7.5); flameCore.position.set(0, 1.35, 7.5); flameCore.scale.set(0.55, 0.55, 1); body.add(flame, flameCore);
    const eye = new THREE.Object3D(); eye.position.set(0, 2.78, -1.7); body.add(eye);
    const muzzles = [-0.95, 0.95].map(x => { const o = new THREE.Object3D(); o.position.set(x, 1.7, -2.7); body.add(o); return o; });
    return { root, body, front: frontG, gear: gearG, flame, flameCore, aileronL, aileronR, elevL, elevR, eye, muzzles, pods };
  }

  function createRPG() {
    const rnd = mulberry(808), B = zBoxes(rnd), W = zBoxes(rnd), H = zBoxes(rnd);
    const OL = 0x4a5030, OLD = 0x383d24, DK = 0x1f2124, SKIN = 0xc79a76;
    B.cone(0.055, 0.055, 1.15, OL, 0, 0.0, -0.15, 12, PI / 2, 0);                       // труба
    B.cone(0.052, 0.09, 0.32, OLD, 0, 0.0, 0.58, 12, PI / 2, 0);                        // раструб сзади
    B.cone(0.062, 0.062, 0.1, DK, 0, 0.0, -0.66, 12, PI / 2, 0); B.cone(0.06, 0.06, 0.08, DK, 0, 0.0, 0.17, 12, PI / 2, 0); // кольца
    B.box(0.03, 0.09, 0.16, DK, 0.06, 0.12, -0.12); B.box(0.02, 0.03, 0.2, DK, 0.06, 0.07, -0.12);                     // прицел и планка
    B.box(0.04, 0.16, 0.06, DK, 0, -0.1, 0.12, -0.2); B.box(0.03, 0.03, 0.12, DK, 0, -0.05, 0.05);                      // рукоять и скоба
    B.box(0.04, 0.13, 0.05, DK, 0, -0.1, -0.35, 0.15);                                                                    // передняя рукоять
    B.box(0.05, 0.05, 0.08, 0x9aa0a4, 0.055, 0.0, 0.0);                                                                  // ушко
    H.box(0.075, 0.075, 0.1, SKIN, 0, -0.14, 0.12); H.box(0.075, 0.075, 0.1, SKIN, 0, -0.13, -0.35);                    // руки
    H.box(0.09, 0.05, 0.16, OLD, 0, -0.16, 0.2); H.box(0.09, 0.05, 0.16, OLD, 0, -0.15, -0.35);
    W.ball(0.085, 0x6a6a62, 0, 0.0, -0.78, 1, 1, 1.7, 0.02); W.cone(0.085, 0, 0.28, 0x8a2a1a, 0, -0.14, -1.0, 12, -PI / 2, 0); // граната
    const root = new THREE.Group(), warhead = W.mesh(metal), muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, 0.7);
    root.add(B.mesh(metal), H.mesh(matte), warhead, muzzle);
    return { root, warhead, muzzle };
  }

  function createRocket() {
    const rnd = mulberry(909), R = zBoxes(rnd);
    R.cone(0.07, 0.07, 0.9, 0xcfcfc4, 0, -0.45, 0, 10, PI / 2, 0); R.cone(0.07, 0, 0.32, RED, 0, -0.16, 0.61, 10, PI / 2, 0);
    for (let i = 0; i < 4; i++) { const a = i * PI / 2; R.box(0.012, 0.2, 0.22, DARK, Math.sin(a) * 0.1, Math.cos(a) * 0.1, -0.35, 0, 0, -a); }
    const root = new THREE.Group(); root.add(R.mesh(metal));
    const flame = new THREE.Mesh(rocketFlameGeo, glow); flame.position.set(0, 0, -0.45); flame.scale.set(0.5, 0.5, 1.2); root.add(flame);
    return { root, flame };
  }
  return { createJet, createRPG, createRocket };
}
// mulCol: затемнить или осветлить цвет (нет Math.random)
function mulCol(hex, f) { const r = Math.min(255, Math.round((hex >> 16 & 255) * f)), g = Math.min(255, Math.round((hex >> 8 & 255) * f)), b = Math.min(255, Math.round((hex & 255) * f)); return (r << 16) | (g << 8) | b; }
