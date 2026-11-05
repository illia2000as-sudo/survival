// Вступительная сцена «Начало конца»: квартира, сирена, радио, окно, титры DEADZONE.
// Комната собирается из деталей прямо в мире (висит над перекрёстком на высоте 9 м), поэтому за окном настоящий город игры.
// После сцены всё лишнее (комната, машины, дым, силуэты) удаляется, а игра начинается как обычно.
export const INTRO_LINES = [
  'Внимание! Внимание! Всем оставшимся в городе гражданам!',
  'Ситуация продолжает ухудшаться.',
  'Инфраструктура города разрушена, безопасные зоны больше не гарантируют защиту.',
  'Всем выжившим необходимо продержаться 14 дней.',
  'Через 14 дней начнётся эвакуация оставшихся граждан.',
  'Повторяем: продержитесь 14 дней.',
  'Не покидайте укрытия без необходимости. Сохраняйте запасы и избегайте заражённых.',
];
export function createIntro(G, ui, audio, cut, people) {
  const { THREE, scene, camera, renderer } = G;
  const BX = 0, BY = 9, BZ = -12, PI = Math.PI;
  const RADIO = { x: BX + 2.3, y: BY + 0.95, z: BZ - 2.4 };   // мировая точка радио
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), smooth = t => t * t * (3 - 2 * t), lerp = (a, b, t) => a + (b - a) * t;
  const wait = s => new Promise(r => setTimeout(r, s * 1000));
  let S = null, fadeIn = null;

  // Ключевые кадры пробуждения: время, x, y, z (в комнате), рыскание, наклон, крен. Сплайн Катмулла-Рома даёт плавное движение.
  const WAKE = [
    [0, -2.40, 0.78, -3.95, PI + 0.15, 1.30, 0.10], [4.0, -2.40, 0.80, -3.95, PI + 0.10, 1.25, 0.08], [6.5, -2.38, 0.84, -3.90, PI, 0.55, 0.04],
    [8.5, -2.35, 0.90, -3.85, PI - 0.10, 0.25, 0.02], [10.5, -2.30, 1.02, -3.70, 1.5 * PI - 0.35, 0.10, 0.0], [12.5, -2.10, 1.15, -3.50, 1.9, 0.05, 0.0],
    [15.0, -1.60, 1.55, -3.00, 3.0, -0.05, 0.0], [17.0, -1.45, 1.65, -2.85, PI - 0.35, -0.05, 0.0], [17.6, -1.45, 1.65, -2.85, PI - 0.35, -0.05, 0.0],
  ];
  function sample(K, t) {
    let i = 0; while (i < K.length - 2 && t >= K[i + 1][0]) i++;
    const a = K[i], b = K[i + 1], u = clamp((t - a[0]) / (b[0] - a[0]), 0, 1), p0 = K[i - 1] || a, p3 = K[i + 2] || b, out = [];
    for (let c = 1; c < 7; c++) { const P0 = p0[c], P1 = a[c], P2 = b[c], P3 = p3[c]; out.push(0.5 * (2 * P1 + (-P0 + P2) * u + (2 * P0 - 5 * P1 + 4 * P2 - P3) * u * u + (-P0 + 3 * P1 - 3 * P2 + P3) * u * u * u)); }
    return out;
  }
  const EYES = [[0, 0], [1.6, 0], [2.0, 0.35], [2.6, 0.35], [2.9, 0], [3.5, 0], [3.9, 0.7], [4.4, 0.7], [4.6, 0.15], [4.9, 0.15], [5.4, 1]];
  const eyeOpen = t => { if (t >= EYES[EYES.length - 1][0]) return 1; for (let i = 0; i < EYES.length - 1; i++) if (t < EYES[i + 1][0]) return lerp(EYES[i][1], EYES[i + 1][1], smooth((t - EYES[i][0]) / (EYES[i + 1][0] - EYES[i][0]))); return 1; };

  function canvasPlane(w, h, draw, x, y, z, ry) { // картинка на стене (календарь, часы, плакат)
    const c = document.createElement('canvas'); c.width = 256; c.height = Math.round(256 * h / w); const g = c.getContext('2d'); draw(g, c.width, c.height);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) })); m.position.set(x, y, z); m.rotation.y = ry || 0; return m;
  }
  function puffTexture() { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); }

  function buildRoom(P) { // комната: стены, пол, мебель, радио, окно
    const K = G.bKit(BX, BZ, 41), { s, d, m, g } = K, WALL = 0x9a9078, TRIM = 0x5a4a38;
    K.xf(G.m4(BX, BY, BZ), () => {
      s.box(6.4, 2.9, 0.2, WALL, 0, 1.45, -5.1); s.box(0.2, 2.9, 5.4, WALL, -3.1, 1.45, -2.5); s.box(0.2, 2.9, 5.4, WALL, 3.1, 1.45, -2.5);
      s.box(1.7, 2.9, 0.2, WALL, -2.25, 1.45, 0.1); s.box(1.7, 2.9, 0.2, WALL, 2.25, 1.45, 0.1); s.box(2.8, 1.0, 0.2, WALL, 0, 0.5, 0.1); s.box(2.8, 0.6, 0.2, WALL, 0, 2.6, 0.1);
      s.box(6.4, 0.2, 5.4, 0xb0a890, 0, 3.0, -2.5); s.box(6.4, 0.2, 5.4, 0x4a3a28, 0, -0.1, -2.5);
      for (let i = 0; i < 12; i++) d.box(0.48, 0.012, 5.0, [0x5a4026, 0x4f3822, 0x634a2c][i % 3], -2.75 + i * 0.5, 0.006, -2.5);
      for (let i = 0; i < 21; i++) d.box(0.14, 2.8, 0.01, i % 2 ? 0xa89e84 : 0x908670, -3.0 + i * 0.3, 1.45, -4.99);
      d.box(6.0, 0.14, 0.05, TRIM, 0, 0.07, -4.97); d.box(0.05, 0.14, 5.0, TRIM, -2.97, 0.07, -2.5); d.box(0.05, 0.14, 5.0, TRIM, 2.97, 0.07, -2.5);
      [[-2.2, 2.0, 0.7, 0.5], [1.0, 2.3, 0.5, 0.6], [2.4, 1.4, 0.4, 0.8]].forEach(([x, y, w, h]) => d.box(w, h, 0.012, 0x7a705a, x, y, -4.985));                      // облупившаяся краска
      for (let i = 0; i < 4; i++) d.box(0.012, 0.6 + i * 0.2, 0.01, 0x3a3228, 0.2 + i * 0.5, 2.1, -4.985, 0, 0, (i - 1.5) * 0.2);                                          // трещины
      // окно: рама, подоконник, переплёт, треснувшее стекло слева, шторы, мёртвый цветок
      m.box(2.9, 0.1, 0.28, TRIM, 0, 2.35, 0.1); m.box(3.1, 0.08, 0.4, TRIM, 0, 1.0, 0.18); [-1.45, 1.45].forEach(x => m.box(0.1, 1.4, 0.28, TRIM, x, 1.65, 0.1)); m.box(0.06, 1.3, 0.06, TRIM, 0, 1.65, 0.1);
      K.gl.box(1.3, 1.25, 0.02, 0xa8bcc4, -0.72, 1.65, 0.1); [[0.3, 0.3], [-0.2, 0.5], [0.1, -0.4]].forEach(([a, b], i) => d.box(0.012, 0.9, 0.01, 0xe8f0f4, -0.72 + a, 1.65 + b * 0.2, 0.115, 0, 0, 0.6 + i * 0.7));
      [-1.78, 1.78].forEach(x => [0, 1, 2].forEach(i => d.box(0.18, 1.8, 0.07, i % 2 ? 0x5a4a3a : 0x4e3f31, x + (i - 1) * 0.17, 1.55, -0.12)));
      m.cyl(0.1, 0.16, 0x7a4a30, 0.9, 1.04, 0.2, 8); [[0, 0.3], [0.1, 0.4], [-0.1, 0.25]].forEach(([a, h], i) => m.tube([0.9, 1.2, 0.2], [0.9 + a, 1.2 + h, 0.2 + a * 0.5], 0.01, 0x4a3a20, 3));
      // кровать, тумбочка с будильником
      d.box(1.1, 0.22, 2.1, 0x5a3a22, -2.4, 0.3, -3.7); [[-0.5, -0.95], [0.5, -0.95], [-0.5, 0.95], [0.5, 0.95]].forEach(([a, b]) => d.box(0.08, 0.2, 0.08, 0x3a2412, -2.4 + a, 0.1, -3.7 + b));
      d.box(1.1, 0.7, 0.08, 0x4a2e1a, -2.4, 0.7, -4.76); d.box(1.0, 0.2, 1.95, 0xb8b0a0, -2.4, 0.51, -3.7); d.box(0.98, 0.04, 1.2, 0x8a9098, -2.4, 0.64, -3.3);
      d.box(1.0, 0.12, 1.0, 0x5a6a4a, -2.4, 0.68, -3.0, 0, 0.1, 0); d.box(0.5, 0.1, 0.6, 0x4a5a3a, -2.5, 0.76, -3.4, 0.2, 0.3, 0.1); d.box(0.6, 0.14, 0.36, 0xd8d2c4, -2.4, 0.66, -4.45, 0, 0.1, 0);
      d.box(0.04, 0.4, 1.2, 0x8a9098, -1.88, 0.4, -3.4);
      d.box(0.45, 0.5, 0.4, 0x5a4026, -1.55, 0.25, -4.5); m.box(0.16, 0.1, 0.07, 0x2a2a2a, -1.55, 0.55, -4.45); g.box(0.1, 0.04, 0.01, 0xff2a1a, -1.55, 0.56, -4.41); m.box(0.07, 0.01, 0.14, 0x1a1a1a, -1.45, 0.51, -4.6, 0, 0.5, 0);
      m.cyl(0.04, 0.2, 0x4a4a42, -1.4, 0.5, -4.35, 6); d.cone(0.12, 0.05, 0.14, 0xd9c27a, -1.4, 0.68, -4.35, 8);
      // стол со стулом, рюкзак и ботинки у двери, полка с книгами
      d.box(0.9, 0.05, 0.6, 0x7a5a38, -0.8, 0.75, -1.0); [[-0.4, -0.25], [0.4, -0.25], [-0.4, 0.25], [0.4, 0.25]].forEach(([a, b]) => d.box(0.06, 0.73, 0.06, 0x5a4026, -0.8 + a, 0.37, -1.0 + b));
      d.box(0.3, 0.01, 0.22, 0xe0dcc8, -0.9, 0.79, -1.0, 0, 0.3, 0); d.box(0.2, 0.01, 0.3, 0xc8c0a0, -0.6, 0.79, -0.95, 0, -0.2, 0); m.cylX(0.025, 0.2, 0x3a3a3a, -1.05, 0.81, -0.8, 6); d.cyl(0.04, 0.09, 0xcfcfc4, -0.5, 0.78, -1.1, 8);
      d.box(0.4, 0.05, 0.4, 0x6a4a2a, -0.8, 0.45, -0.38); d.box(0.4, 0.5, 0.05, 0x6a4a2a, -0.8, 0.72, -0.18); [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => d.box(0.04, 0.45, 0.04, 0x5a4026, -0.8 + a * 0.17, 0.22, -0.38 + b * 0.17));
      d.box(0.4, 0.55, 0.25, 0x4a5a3a, -2.7, 0.28, -0.7); d.box(0.3, 0.2, 0.05, 0x3a4a2a, -2.7, 0.35, -0.55); d.box(0.14, 0.12, 0.3, 0x2a2018, -2.55, 0.06, -1.3, 0, 0.3, 0); d.box(0.14, 0.12, 0.3, 0x2a2018, -2.75, 0.06, -1.35, 0, -0.2, 0);
      d.box(0.04, 2.1, 0.9, 0x6a4a30, -2.99, 1.05, -1.2); d.box(0.03, 0.9, 0.3, 0x5a3a22, -2.97, 1.5, -1.2); m.box(0.05, 0.05, 0.12, 0xb0a070, -2.96, 1.05, -0.88); d.box(0.4, 0.8, 0.08, 0x3a4a3a, -2.9, 1.5, -0.45);
      d.box(0.25, 0.04, 1.4, 0x5a4026, -2.95, 1.9, -3.4); [0x7a3a3a, 0x3a5a7a, 0x5a6a3a, 0x8a7a4a, 0x4a3a5a].forEach((c, i) => d.box(0.16, 0.22, 0.05, c, -2.92, 2.02, -3.95 + i * 0.12));
      // радио на столике, шкаф, кухня
      d.box(0.9, 0.05, 0.5, 0x6a4a2a, 2.4, 0.72, -2.5); [[-0.4, -0.2], [0.4, -0.2], [-0.4, 0.2], [0.4, 0.2]].forEach(([a, b]) => d.box(0.06, 0.72, 0.06, 0x4a3420, 2.4 + a, 0.36, -2.5 + b));
      d.box(0.28, 0.3, 0.5, 0x6a4020, 2.4, 0.9, -2.5); d.box(0.01, 0.22, 0.22, 0x2a2218, 2.255, 0.9, -2.62); for (let i = 0; i < 5; i++) d.box(0.01, 0.01, 0.2, 0x4a3a28, 2.25, 0.82 + i * 0.045, -2.62);
      m.cylX(0.03, 0.04, 0xc8c0a0, 2.255, 0.84, -2.4, 8); m.cylX(0.03, 0.04, 0xc8c0a0, 2.255, 0.84, -2.3, 8); m.tube([2.4, 1.05, -2.3], [2.15, 1.65, -2.15], 0.008, 0x9aa0a4, 4); d.box(0.2, 0.01, 0.12, 0xe0dcc8, 2.6, 0.755, -2.7);
      d.box(1.1, 2.1, 0.55, 0x4a3220, 2.4, 1.05, -4.72); d.box(0.5, 1.95, 0.04, 0x55392a, 1.95, 1.0, -4.4, 0, 0.9, 0); [0x3a4a5a, 0x5a3a3a, 0x4a4a3a].forEach((c, i) => d.box(0.1, 0.7, 0.2, c, 2.2 + i * 0.2, 1.3, -4.75));
      d.box(2.0, 0.88, 0.55, 0x7a7a70, 0.4, 0.44, -4.72); d.box(2.04, 0.05, 0.6, 0x3a3a38, 0.4, 0.9, -4.72); m.box(0.5, 0.02, 0.4, 0x9aa0a4, 0.0, 0.92, -4.72); m.tube([0.0, 0.92, -4.9], [0.0, 1.15, -4.85], 0.015, 0x9aa0a4, 4);
      m.cyl(0.09, 0.16, 0x8a8f94, 0.9, 0.92, -4.7, 8); m.cyl(0.05, 0.05, 0xc9402a, 0.5, 0.92, -4.6, 8); m.box(0.4, 0.04, 0.3, 0x2a2a2a, 1.1, 0.93, -4.62); d.box(2.0, 0.7, 0.3, 0x6a5a46, 0.4, 1.9, -4.84); [0.1, 0.4, 0.7].forEach((o, i) => d.cyl(0.04, 0.1, [0xcfcfc4, 0xb04a3a, 0x7a8a5a][i], o, 0.95, -4.55, 6));
      m.cyl(0.07, 0.04, 0xc9a227, 0.7, 0.92, -4.5, 6); // консервная банка
    });
    const meshes = K.finish();
    const dial = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.07, 0.2), new THREE.MeshBasicMaterial({ color: 0x2a1a0a })); dial.position.set(BX + 2.248, BY + 0.97, BZ - 2.37); scene.add(dial); P.dial = dial;
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.12), new THREE.MeshBasicMaterial({ color: 0xffd9a0 })); bulb.position.set(BX, BY + 2.32, BZ - 2.5); scene.add(bulb); P.bulb = bulb;
    const cal = canvasPlane(0.42, 0.56, (g, w, h) => { // календарь: дни зачёркнуты, четырнадцатое обведено
      g.fillStyle = '#d8d0b4'; g.fillRect(0, 0, w, h); g.fillStyle = '#8a2a1a'; g.fillRect(0, 0, w, 36); g.fillStyle = '#fff'; g.font = 'bold 22px monospace'; g.textAlign = 'center'; g.fillText('ОКТЯБРЬ', w / 2, 26);
      g.font = '15px monospace'; g.fillStyle = '#2a2a2a'; for (let i = 0; i < 31; i++) { const cx = 20 + (i % 7) * 31, cy = 62 + Math.floor(i / 7) * 34; g.fillText(String(i + 1), cx, cy); if (i < 9) { g.strokeStyle = '#8a1a1a'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx - 10, cy - 12); g.lineTo(cx + 10, cy + 3); g.stroke(); } if (i === 13) { g.strokeStyle = '#1a4a8a'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy - 5, 14, 0, 7); g.stroke(); } }
    }, BX - 0.9, BY + 1.75, BZ - 4.98, 0); scene.add(cal);
    const clk = canvasPlane(0.34, 0.34, (g, w) => { g.fillStyle = '#e0dcc8'; g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 6, 0, 7); g.fill(); g.strokeStyle = '#222'; g.lineWidth = 6; g.stroke(); g.lineWidth = 6; g.beginPath(); g.moveTo(w / 2, w / 2); g.lineTo(w / 2 + 28, w / 2 - 44); g.stroke(); g.lineWidth = 4; g.beginPath(); g.moveTo(w / 2, w / 2); g.lineTo(w / 2 - 50, w / 2 + 6); g.stroke(); }, BX + 0.9, BY + 2.35, BZ - 4.98, 0); scene.add(clk);
    P.extra.push(dial, bulb, cal, clk); P.meshes.push(...meshes);
    P.lampL = new THREE.PointLight(0xffc888, 0, 7, 2); P.lampL.position.set(BX, BY + 2.1, BZ - 2.5); scene.add(P.lampL);
    P.sirenL = new THREE.PointLight(0xff3a20, 0, 10, 2); P.sirenL.position.set(BX, BY + 1.8, BZ - 0.4); scene.add(P.sirenL);
    P.coldL = new THREE.PointLight(0x8aa0c0, 0.5, 8, 2); P.coldL.position.set(BX, BY + 1.7, BZ - 0.8); scene.add(P.coldL);
    P.lights.push(P.lampL, P.sirenL, P.coldL);
  }
  function buildStreet(P) { // за окном: пустые машины, полицейская мигалка, дым, силуэты заражённых
    const c0 = G.colliders.length, K = G.bKit(0, 25, 42);
    [[2.0, 14, 0.1, 0x5a6a7a], [-2.2, 22, 3.2, 0x7a3a2a], [1.8, 31, 0.5, 0x6a6a3a], [-1.6, 41, -0.1, 0x3a5a4a], [5.5, 9, 1.4, 0x7a7a7a], [-7, 17, 1.6, 0x4a4a52], [3.5, 52, 2.9, 0x6a4a3a]].forEach(([x, z, r, c]) => G.carK(K, x, z, r, c));
    G.carK(K, 0.2, 27, 3.1, 0xdadada);
    P.meshes.push(...K.finish()); G.colliders.length = c0;                                  // временные машины не должны остаться препятствиями
    const mkPuff = puffTexture(); P.puffTex = mkPuff;
    P.flash = [];
    [[-0.45, 27.4, 0xff2010], [0.85, 27.4, 0x2a50ff]].forEach(([x, z, col]) => { const b = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.22), new THREE.MeshBasicMaterial({ color: col })); b.position.set(x, 1.62, z); scene.add(b); const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: mkPuff, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); h.scale.set(7, 7, 1); h.position.set(x, 1.7, z); scene.add(h); P.flash.push({ b, h, ph: x < 0 ? 0 : 1 }); P.extra.push(b, h); });
    [[-30, 62, 0xff2010], [38, 80, 0xff8a10], [-12, 110, 0xff2010]].forEach(([x, z, col], i) => { const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: mkPuff, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); h.scale.set(10, 10, 1); h.position.set(x, 1.5, z); scene.add(h); P.flash.push({ h, ph: i % 2 }); P.extra.push(h); });
    P.smoke = [];
    [[28, 48], [-52, 30], [70, 72], [-20, 96]].forEach(([sx, sz], k) => {
      for (let i = 0; i < 26; i++) { const mat = new THREE.SpriteMaterial({ map: mkPuff, color: 0x3a3632, transparent: true, depthWrite: false, opacity: 0 }), sp = new THREE.Sprite(mat); scene.add(sp); P.extra.push(sp); P.smoke.push({ sp, mat, sx, sz, age: (i / 26) * 10 + k * 0.7 }); }
      const fire = new THREE.Sprite(new THREE.SpriteMaterial({ map: mkPuff, color: 0xff7a20, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 })); fire.scale.set(9, 5, 1); fire.position.set(sx, 3, sz); scene.add(fire); P.extra.push(fire); P.flash.push({ h: fire, ph: k % 2, fire: true });
    });
    P.ghouls = [];
    for (let i = 0; i < 9; i++) {
      const pe = people.build('ghoul', 300 + i), a = (i % 2 ? 1 : -1) * (1 + (i % 4) * 1.4), z = 38 + i * 7;
      pe.group.position.set(a, 0, z); pe.group.rotation.y = PI + (i % 3 - 1) * 0.4; scene.add(pe.group); P.extra.push(pe.group); P.ghouls.push({ pe, x: a, z, sp: i % 3 === 0 ? 0 : 0.3 + (i % 3) * 0.12 });
    }
  }
  function destroyProps(P) {
    const dead = new Set(P.meshes);
    P.meshes.forEach(m => { scene.remove(m); m.geometry && m.geometry.dispose(); });
    for (let i = G.blockers.length - 1; i >= 0; i--) if (dead.has(G.blockers[i])) G.blockers.splice(i, 1);
    P.extra.forEach(o => { scene.remove(o); if (o.traverse) o.traverse(c => { if (c.geometry && !(c.geometry.userData && c.geometry.userData.shared)) c.geometry.dispose(); if (c.material && !(c.material.userData && c.material.userData.shared)) c.material.dispose(); }); });
    P.lights.forEach(l => scene.remove(l)); if (P.puffTex) P.puffTex.dispose();
  }

  // --- управление в комнате: ходьба с простыми столкновениями ---
  const BOXES = [[-3.0, -1.85, -4.75, -2.65], [-1.8, -1.3, -4.7, -4.3], [1.9, 2.95, -2.8, -2.2], [1.85, 3.0, -4.8, -4.1], [-0.65, 1.45, -4.8, -4.2], [-1.3, -0.3, -1.35, -0.65]];
  function walk(dt) {
    const k = S.keys, yaw = G.yaw, f = [-Math.sin(yaw), -Math.cos(yaw)], r = [Math.cos(yaw), -Math.sin(yaw)];
    let mx = 0, mz = 0; if (k.KeyW) { mx += f[0]; mz += f[1]; } if (k.KeyS) { mx -= f[0]; mz -= f[1]; } if (k.KeyD) { mx += r[0]; mz += r[1]; } if (k.KeyA) { mx -= r[0]; mz -= r[1]; }
    const l = Math.hypot(mx, mz); S.moving = l > 0;
    if (l > 0) { const sp = (k.ShiftLeft ? 3.2 : 2.0) * dt / l; S.px += mx * sp; S.pz += mz * sp; S.step += dt * (k.ShiftLeft ? 9 : 6); }
    S.px = clamp(S.px, -2.8, 2.8); S.pz = clamp(S.pz, -4.75, -0.35);
    for (const [x0, x1, z0, z1] of BOXES) {
      const e = 0.3; if (S.px > x0 - e && S.px < x1 + e && S.pz > z0 - e && S.pz < z1 + e) {
        const dl = S.px - (x0 - e), dr = (x1 + e) - S.px, dt2 = S.pz - (z0 - e), db = (z1 + e) - S.pz, m = Math.min(dl, dr, dt2, db);
        if (m === dl) S.px = x0 - e; else if (m === dr) S.px = x1 + e; else if (m === dt2) S.pz = z0 - e; else S.pz = z1 + e;
      }
    }
  }
  function pose(x, y, z, yaw, pitch, roll) { camera.position.set(BX + x, BY + y, BZ + z); camera.rotation.set(pitch, yaw, roll || 0, 'YXZ'); G.yaw = yaw; G.pitch = pitch; }

  async function playRadio() { // диктор: помехи, настройка, фразы с субтитрами, потеря сигнала
    const tok = S.token; S.phase = 'radio'; ui.hint(''); ui.objective('');
    audio.click(); S.dialOn = true; audio.radioStatic(true, 0.25); audio.sirenVol(0.12, 1.5); audio.sirenMuffle(450, 1.5); audio.radioTune(2.4);
    await wait(2.8); if (S.token !== tok) return;
    const file = await audio.loadFile('introVoice');
    if (file) { // настоящая запись: субтитры по длине строк
      const total = INTRO_LINES.reduce((a, t) => a + t.length, 0); let done = false; audio.playFile(file, 1).then(() => { done = true; });
      for (const line of INTRO_LINES) { ui.sub(line); const dur = (file.duration || 40) * line.length / total; await wait(Math.max(1.5, dur)); if (S.token !== tok) return; }
      while (!done && S.token === tok) await wait(0.2);
    } else {
      for (let i = 0; i < INTRO_LINES.length; i++) {
        ui.sub(INTRO_LINES[i]); if (i === INTRO_LINES.length - 1) audio.radioLevel(0.4, 3.5); else if (Math.random() < 0.6) audio.crackle();
        await audio.speak(INTRO_LINES[i]); if (S.token !== tok) return; await wait(0.35); audio.crackle();
      }
    }
    if (S.token !== tok) return;
    ui.sub('[ сигнал потерян ]'); audio.radioLevel(0.5, 0.2); await wait(1.0); if (S.token !== tok) return;
    audio.radioStatic(false); audio.siren(false); S.dialOn = false; await wait(1.4); if (S.token !== tok) return;
    ui.sub(''); S.phase = 'free2'; ui.objective('Подойди к окну');
  }
  function startWindow() {
    S.phase = 'window'; S.wt = 0; S.from = { x: S.px, z: S.pz, yaw: G.yaw, pitch: G.pitch }; ui.objective(''); ui.hint(''); audio.wind(true, 0.2); audio.city(true);
  }

  function update(dt) {
    if (fadeIn) { fadeIn.t += dt; ui.setFade(1 - smooth(clamp(fadeIn.t / fadeIn.dur, 0, 1))); if (fadeIn.t >= fadeIn.dur) { fadeIn = null; ui.setFade(0); } }
    if (!S) return;
    S.t += dt; audio.tick(dt);
    const P = S.props;
    // освещение утра: тусклое, дымное
    if (scene.fog) { scene.fog.near = 3; scene.fog.far = Math.min(scene.fog.far, 85); scene.fog.color.lerp(S.smokeCol, 0.5); }
    if (S.phase === 'gate') { ui.setFade(1); ui.hint('Нажми любую клавишу или кликни, чтобы начать'); if (S.gateOk) { S.phase = 'wake'; S.t = 0; ui.hint(''); audio.unlock(); G.requestLock(); audio.siren(true, 0.55, 650); audio.wind(true, 0.1); audio.city(true); ui.showSkip('Пропустить (Enter)', skip); } return animateProps(dt); }
    if (S.phase === 'wake') {
      const t = S.t, v = sample(WAKE, Math.min(t, WAKE[WAKE.length - 1][0] - 0.01)); pose(v[0], v[1] + Math.sin(t * 1.6) * 0.004, v[2], v[3], v[4], v[5]);
      ui.setFade(1 - eyeOpen(t)); renderer.domElement.style.filter = ui.blur(t < 1.6 ? 14 : Math.max(0, 14 * (1 - (t - 1.6) / 6))); ui.setVignette(clamp(0.9 - t * 0.04, 0.25, 0.9));
      if (t > 17) { S.phase = 'free'; S.px = -1.45; S.pz = -2.85; renderer.domElement.style.filter = ''; ui.setFade(0); ui.objective('Подойди к радио и включи его (E)'); ui.setVignette(0.25); }
    } else if (S.phase === 'free' || S.phase === 'free2' || S.phase === 'radio') {
      if (S.phase !== 'radio') walk(dt);
      const bob = S.moving ? Math.sin(S.step) * 0.025 : 0; G.pitch = clamp(G.pitch, -1.3, 1.3);
      pose(S.px, 1.65 + bob, S.pz, G.yaw, G.pitch, 0);
      const dr = Math.hypot(BX + S.px - RADIO.x, BZ + S.pz - RADIO.z);
      if (S.phase === 'free') { ui.hint(dr < 1.5 ? 'E - включить радио' : ''); if (S.keys.KeyE && dr < 1.5) { S.keys.KeyE = false; playRadio(); } }
      if (S.phase === 'free2') { const nearW = S.pz > -1.05 && Math.abs(S.px) < 1.5; ui.hint(nearW ? 'E - выглянуть в окно' : ''); if (nearW && (S.keys.KeyE || S.pz > -0.7)) startWindow(); }
      if (!document.pointerLockElement) { if (S.phase !== 'radio' && S.t > 18) ui.hint('Кликни по экрану, чтобы вернуть мышь'); }
    } else if (S.phase === 'window') {
      S.wt += dt; const t = S.wt, u = smooth(clamp(t / 2.2, 0, 1)); let dy = S.from.yaw; const target = PI; while (dy - target > PI) dy -= 2 * PI; while (target - dy > PI) dy += 2 * PI;
      if (t < 2.2) pose(lerp(S.from.x, 0.0, u), 1.65 + (S.moving ? 0 : 0) - 0.02 * u, lerp(S.from.z, -0.6, u), lerp(dy, PI, u), lerp(S.from.pitch, -0.1, u));
      else { const w = t - 2.2; pose(Math.sin(w * 0.25) * 0.08, 1.63 + Math.sin(w * 0.9) * 0.005, -0.6 + w * 0.045, PI + Math.sin(w * 0.22) * 0.35 + w * 0.02, -0.1 - Math.min(0.14, w * 0.03)); }
      if (t > 9) ui.setFade(smooth(clamp((t - 9) / 2.2, 0, 1)));
      if (t > 11.6) { S.phase = 'title'; S.tt = 0; renderer.domElement.style.filter = ''; ui.showSkip('', null); ui.setFade(1); audio.pad(true); }
    } else if (S.phase === 'title') {
      S.tt += dt; const a1 = smooth(clamp(S.tt / 1.6, 0, 1)), a2 = smooth(clamp((S.tt - 1.4) / 1.4, 0, 1)), out = 1 - smooth(clamp((S.tt - 6.0) / 1.2, 0, 1));
      ui.title('DEADZONE', '14 дней до эвакуации.', a1 * out, a2 * out); audio.wind(false);
      if (S.tt > 7.4) return finish(false);
    }
    // лампа и сирена: мерцание, красные вспышки в комнате
    const siren = audio.sirenNodes ? 1 : 0, ph = (S.t * 1.25) % 1, pulse = Math.pow(Math.max(0, Math.sin(ph * PI * 2)), 2);
    P.lampL.intensity = S.phase === 'title' ? 0 : (0.9 + (Math.random() < 0.06 ? -0.7 : 0.1 * Math.sin(S.t * 9))) * 1.6; P.bulb.material.color.setHex(P.lampL.intensity > 0.9 ? 0xffd9a0 : 0x6a5a40);
    P.sirenL.intensity = siren ? pulse * 3.2 : 0.2;
    P.dial.material.color.setHex(S.dialOn ? (Math.random() < 0.08 ? 0x8a5a20 : 0xffb040) : 0x2a1a0a);
    animateProps(dt);
  }
  function animateProps(dt) {
    const P = S && S.props; if (!P) return;
    P.smoke.forEach(q => { q.age += dt; if (q.age > 10) q.age -= 10; const a = q.age, k = a / 10; q.sp.position.set(q.sx + a * 0.9 + Math.sin(a + q.sz) * 1.5, a * 3.4 + 1, q.sz); const sc = 7 + a * 2.8; q.sp.scale.set(sc, sc, 1); q.mat.opacity = 0.5 * (1 - k) * Math.min(1, a / 1.2); });
    const blink = Math.floor(S.t * 2.6) % 2; P.flash.forEach(f => { const on = f.fire ? 1 : (blink === f.ph ? 1 : 0); f.h.visible = !!on; if (f.fire) f.h.material.opacity = 0.6 + 0.2 * Math.sin(S.t * 7 + f.ph); if (f.b) f.b.visible = !!on; });
    P.ghouls.forEach((g, i) => { g.z -= g.sp * dt; g.pe.group.position.set(g.x + Math.sin(S.t * 0.6 + i) * 0.15, g.pe.update(S.t + i, g.sp > 0), g.z); });
  }

  function onKey(e) { if (!S) return; S.keys[e.code] = e.type === 'keydown'; if (e.type === 'keydown') { S.gateOk = true; if (e.code === 'Enter' && S.phase !== 'gate') skip(); if (e.code === 'Space' || e.code === 'Tab') e.preventDefault(); } }
  function onClick() { if (!S) return; S.gateOk = true; if (S.phase !== 'gate' && !document.pointerLockElement) G.requestLock(); }
  function start(onDone, opts = {}) {
    if (S) return;
    cut.active = 'intro'; G.mainMenu.style.display = 'none'; ui.hideHud(true); G.hour = 5.6; G.yaw = PI; G.pitch = 1.3;
    if (!audio.unlock) return onDone();
    audio.unlock(); G.requestLock();
    const P = { meshes: [], extra: [], lights: [], dial: null, bulb: null };
    buildRoom(P); buildStreet(P);
    S = { phase: opts.gate ? 'gate' : 'wake', t: 0, token: 1, keys: {}, px: 0, pz: 0, step: 0, moving: false, onDone, props: P, gateOk: !opts.gate, smokeCol: new THREE.Color(0x4a4640), dialOn: false };
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey); document.addEventListener('click', onClick);
    { const v = WAKE[0]; pose(v[1], v[2], v[3], v[4], v[5], v[6]); }
    ui.setFade(1); ui.setVignette(0.9);
    if (!opts.gate) { audio.siren(true, 0.55, 650); audio.wind(true, 0.1); audio.city(true); ui.showSkip('Пропустить (Enter)', skip); }
  }
  function skip() { if (!S) return; if (S.phase === 'title' || S.phase === 'gate') return finish(true); ui.setFade(1); finish(true); }
  function finish(skipped) {
    if (!S) return; const cb = S.onDone, P = S.props; S.token++; audio.stopAll();
    window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); document.removeEventListener('click', onClick);
    destroyProps(P); renderer.domElement.style.filter = ''; ui.reset(); ui.setFade(1); S = null; cut.active = null;
    fadeIn = { t: 0, dur: 2.6 }; try { localStorage.setItem('dz_introSeen', '1'); } catch (e) { /* без хранилища */ }
    cb(skipped);
  }
  return { start, update, skip, get active() { return !!S; }, get phase() { return S ? S.phase : null; } };
}
