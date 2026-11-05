// Финальная сцена «Эвакуация»: утро 15-го дня, сигнал по радио, отметка на карте, точка сбора с военными,
// посадка в грузовик, отъезд камеры, надпись «ВЫ ВЫЖИЛИ» и меню.
// Запускается один раз, только после 14 полных игровых дней (день >= 15, утро), только в одиночной игре.
export const FINALE_LINES = [
  'Внимание всем выжившим!',
  'Эвакуация начинается.',
  'Повторяем: эвакуация начинается.',
  'Направляйтесь к обозначенной точке сбора.',
  'Спасательные подразделения уже в пути.',
];
export function createFinale(G, ui, audio, cut, people) {
  const { THREE, scene, camera, renderer } = G;
  const PI = Math.PI, clamp = (v, a, b) => Math.min(b, Math.max(a, v)), smooth = t => t * t * (3 - 2 * t), lerp = (a, b, t) => a + (b - a) * t;
  const wait = s => new Promise(r => setTimeout(r, s * 1000));
  const ENDS = [[0, -172, 0, -1], [0, 172, 0, 1], [172, 0, 1, 0], [-172, 0, -1, 0]]; // конец дороги: x, z, наружу x, наружу z
  const MAP_HALF = 420;
  // st: 0 не начиналось, 1 объявлено (идём к точке), 2 посадка, 3 титры и меню, 4 завершено
  const st = { state: 0, silent: false, site: null, cin: null, near: false, spoke: false };

  // --- Интерфейс: маркер на экране и карта ---
  const mk = (css, tag = 'div') => { const d = document.createElement(tag); d.style.cssText = css; document.body.appendChild(d); d.classList.add('dz-h'); return d; };
  const wpEl = mk('position:fixed;left:0;top:0;z-index:20;pointer-events:none;display:none;font:bold 14px monospace;color:#ffb347;text-shadow:0 0 6px #000,0 0 3px #000;text-align:center;transform:translate(-50%,-50%)');
  const miniEl = mk('position:fixed;right:12px;top:12px;z-index:19;display:none;border:2px solid #3a4a30;border-radius:6px;background:#10140c;pointer-events:none', 'canvas'); miniEl.width = miniEl.height = 190;
  const bigEl = mk('position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:30;display:none;border:3px solid #5a6b45;border-radius:8px;background:#10140c;pointer-events:none', 'canvas');
  let mapBase = null, bigOn = false;

  function endPoint() { const e = ENDS[Math.floor(G.hash(61) * 4) % 4]; return { x: e[0], z: e[1], ox: e[2], oz: e[3], ry: Math.atan2(-e[2], -e[3]) }; }
  function lw(S, lx, lz) { const c = Math.cos(S.ry), s = Math.sin(S.ry); return [S.x + lx * c + lz * s, S.z - lx * s + lz * c]; } // локальные координаты площадки -> мир
  function colLocal(S, lx, lz, hx, hz) { // коллайдер площадки: оси совпадают с мировыми
    const [x, z] = lw(S, lx, lz), sw = Math.abs(Math.sin(S.ry)) > 0.5; const a = sw ? hz : hx, b = sw ? hx : hz;
    G.colliders.push({ minX: x - a, maxX: x + a, minZ: z - b, maxZ: z + b });
  }

  // --- Площадка эвакуации ---
  function buildSite() {
    const S = endPoint(); st.site = S; S.people = []; S.extra = []; S.smoke = []; S.colliders0 = G.colliders.length;
    G.clearTrees(S.x, S.z, 32, 32);
    const K = G.bKit(S.x, S.z, 51), { s, d, m, g } = K;
    K.xf(G.m4(S.x, 0, S.z, 0, S.ry, 0), () => {
      d.box(40, 0.04, 46, 0x6a6458, 0, 0.02, 0);                                                      // утоптанная площадка
      for (let i = 0; i < 4; i++) d.box(0.5, 0.012, 30, 0x4a463c, -6 + i * 4, 0.045, -2, 0, (i - 1.5) * 0.02, 0);   // колеи
      [-5, 5].forEach(x => m.box(0.3, 5, 0.3, 0x3a3f45, x, 2.5, 17)); m.box(10.6, 0.7, 0.3, 0x2f3438, 0, 5.2, 17);   // арка у въезда
      [-6.5, 6.5].forEach(x => { s.box(1.0, 0.85, 3.2, 0x777770, x, 0.42, 14.5); d.box(0.9, 0.2, 0.03, 0xb02a1a, x, 0.6, 16.12); });
      for (let i = 0; i < 6; i++) m.box(0.6, 0.18, 0.1, i % 2 ? 0xd8d0b0 : 0xb02a1a, -1.8 + i * 0.6, 1.05, 15.5);                // шлагбаум поднят
      [[-14, -12, 0x55603a, 6, 4, 2.2], [-14, -3, 0x55603a, 6, 4, 2.2], [13, 4, 0xe8e4d8, 7, 4.4, 2.5]].forEach(([x, z, c, w, dd, h], i) => { // палатки
        s.gable(w, dd, h, c, x, 0, z, 0.1); d.box(w - 0.4, 0.02, dd - 0.2, 0x3a3f2a, x, 0.02, z); d.box(1.2, h * 0.7, 0.03, 0x14140e, x, h * 0.35, z + dd / 2 + 0.02);
        if (i === 2) { d.box(0.9, 0.2, 0.02, 0xb02a1a, x, 1.7, z + dd / 2 + 0.05); d.box(0.2, 0.9, 0.02, 0xb02a1a, x, 1.7, z + dd / 2 + 0.05); }
        [-1, 1].forEach(sx => m.tube([x + sx * (w / 2 + 0.2), 0, z + dd / 2 + 1.6], [x + sx * (w / 2 - 0.2), h * 0.5, z + dd / 2], 0.01, 0x8a7a50, 3));
      });
      [[-12, 10], [12, 10], [-12, -16], [12, -16]].forEach(([x, z]) => { m.tube([x, 0, z], [x, 7, z], 0.08, 0x4a4f55, 5); m.box(1.0, 0.12, 0.6, 0x2f3438, x, 7.0, z); g.box(0.9, 0.3, 0.5, 0xfff4dc, x, 6.9, z); }); // прожекторы
      for (let i = 0; i < 3; i++) { G.crateK(s, 1.0, 0.9, 1.0, 0x4a5230, 8 + i * 1.1, 0, -14); if (i === 1) G.crateK(d, 1.0, 0.9, 1.0, 0x4a5230, 9.1, 0.9, -14); }
      m.cyl(0.3, 0.9, 0x6a3a22, 6, 0, 6, 8); g.box(0.4, 0.08, 0.4, 0xff8a20, 6, 0.95, 6); m.box(0.05, 0.05, 0.05, 0x2a2a2a, 6, 0.9, 6);   // бочка с огнём
      // автобус для гражданских
      s.box(2.5, 2.3, 9.0, 0x6a7048, 11, 1.45, -9); d.box(2.52, 0.9, 8.6, 0x4a5030, 11, 0.6, -9); for (let i = 0; i < 6; i++) d.box(2.54, 0.7, 1.0, 0x141b21, 11, 1.9, -12.5 + i * 1.4);
      m.box(2.3, 0.08, 8.6, 0x555a60, 11, 2.64, -9); [-1, 1].forEach(sx => [-3.2, 3.2].forEach(z => { m.cylX(0.5, 0.3, 0x1a1a1a, 11 + sx * 1.15, 0.5, -9 + z, 10); m.cylX(0.25, 0.32, 0x6a6f75, 11 + sx * 1.15, 0.5, -9 + z, 8); }));
      d.box(0.5, 0.3, 0.02, 0x9a2a1a, 11, 1.05, -4.52);
    });
    colLocal(S, 11, -9, 1.3, 4.6); [-6.5, 6.5].forEach(x => colLocal(S, x, 14.5, 0.5, 1.6));
    colLocal(S, -14, -12, 3, 2); colLocal(S, -14, -3, 3, 2); colLocal(S, 13, 4, 3.5, 2.2);
    // стоянки грузовиков (техника собирается в мировых координатах)
    const [bx, bz] = lw(S, 3.5, -9), [cx2, cz2] = lw(S, -8, -3);
    G.milTruckK(K, bx, bz, S.ry); G.milTruckK(K, cx2, cz2, S.ry + PI / 2);
    G.barrelsK(K, ...lw(S, -4, 8), 3); G.mastK(K, ...lw(S, 14, -16), 10);
    const [s1x, s1z] = lw(S, -13, 13), [s2x, s2z] = lw(S, 13, 13); G.sandWallK(K, s1x, s1z, ...lw(S, -8, 13), 1.0); G.sandWallK(K, ...lw(S, 8, 13), s2x, s2z, 1.0);
    S.extra.push(...K.finish());
    const [sx, sz] = lw(S, 0, 17.3); G.textPlane('ЭВАКУАЦИОННЫЙ ПУНКТ', 9.0, 0.9, '#1f2a1a', '#f0ead8', sx, 5.2, sz, S.ry);
    // рабочий грузовик: отдельный объект, он уедет
    const c0 = G.colliders.length, KT = G.bKit(0, 0, 52); G.milTruckK(KT, 0, 0, 0); G.colliders.length = c0;
    const grp = new THREE.Group(); KT.finish().forEach(mm => grp.add(mm)); const [tx, tz] = lw(S, -2.2, -8); grp.position.set(tx, 0, tz); grp.rotation.y = S.ry; scene.add(grp); S.truck = grp; S.extra.push(grp);
    colLocal(S, -2.2, -8, 1.3, 3.4); S.truckCol = G.colliders[G.colliders.length - 1];
    S.board = lw(S, -2.2, -3.3); S.inside = lw(S, -2.2, -6.4);
    // люди: солдаты и выжившие
    const face = (lx, lz, tx2, tz2) => S.ry + Math.atan2(tx2 - lx, tz2 - lz);
    [[-6, 14, 'soldier', 0, 40, 'rifle'], [6, 14, 'soldier', 0, 40, 'rifle'], [-5, 3, 'soldier', 0, 30, 'rifle'], [4.5, 2, 'soldier', 0, 30, 'rifle'], [-4.6, -3.2, 'soldier', 0, 30, 'wave'], [-0.2, -3.4, 'officer', 0, 20, 'stand'], [8, -6, 'soldier', 0, 10, 'rifle'], [-9, -9, 'soldier', 0, 10, 'rifle'],
      [2.2, -2.6, 'survivor', -2, -8, 'stand'], [3.2, -2.0, 'survivor', -2, -8, 'stand'], [4.2, -2.8, 'survivor', -2, -8, 'stand'], [5.1, -3.5, 'survivor', -2, -8, 'stand'], [-7, -6, 'survivor', 6, 6, 'stand'], [-7.8, -5.2, 'survivor', 6, 6, 'stand']].forEach(([lx, lz, kind, fx, fz, pose], i) => {
      const pe = people.build(kind, 70 + i, pose), [wx, wz] = lw(S, lx, lz); pe.group.position.set(wx, 0, wz); pe.group.rotation.y = face(lx, lz, fx, fz); scene.add(pe.group); S.people.push({ pe, x: wx, z: wz, ry: pe.group.rotation.y, ph: i * 1.3 }); S.extra.push(pe.group);
    });
    // дымовая шашка и световой столб видны издалека
    const pf = lw(S, 5, -4); S.flare = { x: pf[0], z: pf[1] };
    const tex = new THREE.CanvasTexture((() => { const c = document.createElement('canvas'); c.width = c.height = 64; const q = c.getContext('2d'), gr = q.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); q.fillStyle = gr; q.fillRect(0, 0, 64, 64); return c; })());
    for (let i = 0; i < 34; i++) { const mat = new THREE.SpriteMaterial({ map: tex, color: 0xff7a28, transparent: true, depthWrite: false, opacity: 0, fog: false }), sp = new THREE.Sprite(mat); scene.add(sp); S.extra.push(sp); S.smoke.push({ sp, mat, age: i / 34 * 12 }); }
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.4, 90, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.18, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    beam.position.set(S.flare.x, 45, S.flare.z); scene.add(beam); S.extra.push(beam); S.beam = beam;
    // флаг
    const fc = document.createElement('canvas'); fc.width = 96; fc.height = 64; const fg = fc.getContext('2d'); fg.fillStyle = '#4a5530'; fg.fillRect(0, 0, 96, 64); fg.fillStyle = '#d8d0b0'; fg.font = 'bold 44px monospace'; fg.textAlign = 'center'; fg.fillText('★', 48, 46);
    const [fx, fz] = lw(S, -10, 12); const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 8, 6), new THREE.MeshStandardMaterial({ color: 0x6a6f75 })); pole.position.set(fx, 4, fz); scene.add(pole); S.extra.push(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(fc), side: THREE.DoubleSide })); flag.position.set(fx + 0.9, 7.2, fz); flag.rotation.y = S.ry; scene.add(flag); S.extra.push(flag);
  }
  function removeSite() {
    const S = st.site; if (!S) return;
    S.extra.forEach(o => { scene.remove(o); if (o.traverse) o.traverse(c => { if (c.geometry && !(c.geometry.userData && c.geometry.userData.shared)) c.geometry.dispose(); }); });
    st.site = null;
  }

  // --- Карта: рельеф, озёра, дороги, постройки, игрок и точка эвакуации ---
  function makeMapBase() {
    const N = 256, c = document.createElement('canvas'); c.width = c.height = N; const g = c.getContext('2d'), img = g.createImageData(N, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N * MAP_HALF * 2 - MAP_HALF, z = (j + 0.5) / N * MAP_HALF * 2 - MAP_HALF, h = G.terrainY(x, z), k = (j * N + i) * 4;
      let r, gg, b; if (h < G.WATER_Y + 0.05) { const dp = clamp((G.WATER_Y - h) / 4, 0, 1); r = 40 - 20 * dp; gg = 90 - 30 * dp; b = 130 - 20 * dp; }
      else if (Math.max(Math.abs(x), Math.abs(z)) <= 200) { r = 52; gg = 64; b = 38; } else { const t = clamp(h / 50, 0, 1); r = 44 + 70 * t; gg = 62 + 50 * t; b = 36 + 40 * t; }
      img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0); return c;
  }
  function drawMap(cv, cx, cz, span, big) {
    const g = cv.getContext('2d'), size = cv.width, k = size / span, X = x => (x - cx) * k + size / 2, Y = z => (z - cz) * k + size / 2;
    g.clearRect(0, 0, size, size); g.imageSmoothingEnabled = true;
    const sx = (cx - span / 2 + MAP_HALF) / (MAP_HALF * 2) * 256, sy = (cz - span / 2 + MAP_HALF) / (MAP_HALF * 2) * 256, sw = span / (MAP_HALF * 2) * 256;
    g.fillStyle = '#10140c'; g.fillRect(0, 0, size, size); g.drawImage(mapBase, sx, sy, sw, sw, 0, 0, size, size);
    g.strokeStyle = '#8a8472'; g.lineWidth = Math.max(2, 5 * k); g.beginPath(); g.moveTo(X(-200), Y(0)); g.lineTo(X(200), Y(0)); g.moveTo(X(0), Y(-200)); g.lineTo(X(0), Y(200)); g.stroke();
    const dot = (list, col, r) => { g.fillStyle = col; (list || []).forEach(o => { const x = X(o.x), y = Y(o.z); g.fillRect(x - r * k, y - r * k, 2 * r * k, 2 * r * k); }); };
    dot(G.houses, '#c9c0a8', 4); dot(G.stations, '#ff9a3a', 7); dot(G.warehouses, '#b07a4a', 8); dot(G.garages, '#8a9aa8', 6); dot(G.towers, '#5ac8ff', 5); dot(G.outposts, '#6ac84a', 8); dot(G.armories, '#2f8a2f', 6);
    // игрок
    const px = X(camera.position.x), py = Y(camera.position.z), f = [-Math.sin(G.yaw), -Math.cos(G.yaw)], an = Math.atan2(f[1], f[0]);
    g.save(); g.translate(px, py); g.rotate(an); g.fillStyle = '#ffffff'; g.strokeStyle = '#000'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(8, 0); g.lineTo(-5, 5); g.lineTo(-3, 0); g.lineTo(-5, -5); g.closePath(); g.fill(); g.stroke(); g.restore();
    // точка эвакуации
    const S = st.site; if (S) {
      let ex = X(S.x), ey = Y(S.z); const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300), inside = ex > 8 && ex < size - 8 && ey > 8 && ey < size - 8;
      if (!inside) { const dx = ex - size / 2, dy = ey - size / 2, m = Math.max(Math.abs(dx), Math.abs(dy)) / (size / 2 - 10); ex = size / 2 + dx / m; ey = size / 2 + dy / m; }
      g.fillStyle = '#ffa030'; g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.arc(ex, ey, 6 + pulse * 3, 0, 7); g.stroke(); g.fill(); g.fillStyle = '#fff'; g.fillRect(ex - 1, ey - 4, 2, 8); g.fillRect(ex - 4, ey - 1, 8, 2);
      if (big) { g.font = 'bold 15px monospace'; g.fillStyle = '#ffd080'; g.strokeStyle = '#000'; g.lineWidth = 3; g.strokeText('ЭВАКУАЦИЯ', ex + 12, ey + 5); g.fillText('ЭВАКУАЦИЯ', ex + 12, ey + 5); }
    }
    if (big) { g.font = '13px monospace'; g.fillStyle = '#ddd'; g.fillText('N', size / 2 - 4, 14); g.fillText('M - закрыть', 10, size - 10); }
  }
  function sizeBig() { const v = Math.min(innerWidth, innerHeight) * 0.82 | 0; if (bigEl.width !== v) bigEl.width = bigEl.height = v; }

  // --- Объявление: радио в то же утро, игра не останавливается ---
  async function announce(silent) {
    if (st.state !== 0) return; st.state = 1; st.silent = !!silent;
    buildSite(); mapBase = makeMapBase(); miniEl.style.display = 'block';
    if (silent) { G.notify('Точка эвакуации отмечена на карте (M)'); return; }
    audio.unlock(); audio.radioStatic(true, 0.2); audio.radioTune(1.8); await wait(2.0);
    const file = await audio.loadFile('finaleVoice');
    if (file) { const total = FINALE_LINES.reduce((a, t) => a + t.length, 0); audio.playFile(file, 1); for (const l of FINALE_LINES) { ui.sub(l); await wait(Math.max(1.4, (file.duration || 14) * l.length / total)); } }
    else for (let i = 0; i < FINALE_LINES.length; i++) { ui.sub(FINALE_LINES[i]); if (i === 2) audio.crackle(); await audio.speak(FINALE_LINES[i]); await wait(0.3); }
    ui.sub(''); audio.radioStatic(false); G.notify('На карте отмечена точка эвакуации (M - карта)');
  }

  // --- Каждый кадр, пока идёт обычная игра ---
  function tick(dt) {
    const S = st.site;
    if (st.state === 0) {
      if (G.day >= 15 && (G.hour >= 6 || G.day > 15) && G.gameStarted && !cut.active && G.health > 0 && !G.net.active && !G.inBasement() && !G.menuOpen()) announce(st.silent);
    }
    if (st.state === 1 && S && !cut.active) {
      const t = performance.now() / 1000;
      // маркер на экране
      const v = new THREE.Vector3(S.flare.x, 14, S.flare.z).project(camera); let nx = v.x, ny = v.y; if (v.z > 1) { nx = -nx; ny = -ny; }
      const W = innerWidth, H = innerHeight; let x = (nx * 0.5 + 0.5) * W, y = (-ny * 0.5 + 0.5) * H; const edge = v.z > 1 || x < 40 || x > W - 40 || y < 40 || y > H - 40;
      x = clamp(x, 44, W - 44); y = clamp(y, 44, H - 44); const dist = Math.hypot(camera.position.x - S.flare.x, camera.position.z - S.flare.z);
      wpEl.style.display = G.menuOpen() ? 'none' : 'block'; wpEl.style.left = x + 'px'; wpEl.style.top = y + 'px';
      wpEl.innerHTML = '<div style="font-size:26px;line-height:20px">' + (edge ? '◆' : '▼') + '</div>' + 'ЭВАКУАЦИЯ<br>' + Math.round(dist) + ' м';
      if (Math.floor(t) !== st.lastObj) { st.lastObj = Math.floor(t); ui.objective('Эвакуация: дойди до отмеченной точки (' + Math.round(dist) + ' м, M - карта)'); }
      miniEl.style.display = G.menuOpen() ? 'none' : 'block'; drawMap(miniEl, camera.position.x, camera.position.z, 360, false);
      if (bigOn) { sizeBig(); bigEl.style.display = 'block'; drawMap(bigEl, 0, 0, MAP_HALF * 2, true); } else bigEl.style.display = 'none';
      // подход: окрик солдата, подсказка посадки
      const bd = Math.hypot(camera.position.x - S.board[0], camera.position.z - S.board[1]);
      if (bd < 45 && !st.spoke) { st.spoke = true; ui.sub('Сюда! Быстрее к грузовику!'); audio.heli(true, 0.07); setTimeout(() => ui.sub(''), 3200); }
      st.near = bd < 3.2 && G.health > 0;
      ui.hint(st.near ? (G.riding() ? 'Сначала выйди из транспорта' : 'E - сесть в транспорт') : '');
      animateSite(dt);
    } else if (st.state === 4 && S) animateSite(dt);
    if (st.state !== 1) { if (wpEl.style.display !== 'none') wpEl.style.display = 'none'; if (st.state >= 2 || st.state === 4) { miniEl.style.display = 'none'; bigEl.style.display = 'none'; } }
    audio.tick(dt);
  }
  function animateSite(dt) {
    const S = st.site; if (!S) return; const t = performance.now() / 1000;
    S.people.forEach(p => { p.pe.group.rotation.y = p.ry + Math.sin(t * 0.4 + p.ph) * 0.12; p.pe.group.position.y = Math.sin(t * 1.5 + p.ph) * 0.01; });
    S.smoke.forEach(q => { q.age += dt; if (q.age > 12) q.age -= 12; const a = q.age; q.sp.position.set(S.flare.x + a * 0.5 + Math.sin(a * 0.8) * 1.2, 1 + a * 3.6, S.flare.z); const sc = 3 + a * 1.4; q.sp.scale.set(sc, sc, 1); q.mat.opacity = 0.6 * (1 - a / 12) * Math.min(1, a / 0.8); });
    if (S.beam) S.beam.material.opacity = 0.14 + 0.05 * Math.sin(t * 2);
  }
  function onKey(e) {
    if (st.state !== 1 || cut.active || !G.gameStarted) return;
    if (e.code === 'KeyM' && !G.menuOpen()) { bigOn = !bigOn; return; }
    if (e.code === 'KeyE' && st.near && !G.riding() && !G.menuOpen()) board();
  }
  window.addEventListener('keydown', onKey);

  // --- Посадка и отъезд (кинематографическая часть) ---
  function board() {
    const S = st.site; if (!S || st.state !== 1) return;
    st.state = 2; cut.active = 'final'; ui.hideHud(true); ui.hint(''); ui.objective(''); ui.sub(''); bigOn = false; bigEl.style.display = 'none'; wpEl.style.display = 'none'; miniEl.style.display = 'none';
    const hero = people.build('hero', 5), yaw = G.yaw, hp = [camera.position.x, camera.position.z];
    hero.group.position.set(hp[0], 0, hp[1]); hero.group.rotation.y = yaw + PI; scene.add(hero.group);
    st.cin = { t: 0, hero, hp, p0: camera.position.clone(), yaw0: yaw, pitch0: G.pitch, dir: new THREE.Vector3(S.board[0] - hp[0], 0, S.board[1] - hp[1]), done: false, menuShown: false, tpos: new THREE.Vector3(S.truck.position.x, 0, S.truck.position.z), v: 0, look: new THREE.Vector3() };
    st.cin.dist = st.cin.dir.length(); st.cin.dir.normalize(); if (st.cin.dist < 0.3) st.cin.dir.set(-Math.sin(S.ry), 0, -Math.cos(S.ry));
    audio.unlock(); audio.heli(true, 0.05); audio.wind(true, 0.08);
  }
  function setCam(px, py, pz, lx, ly, lz) { camera.position.set(px, py, pz); camera.lookAt(lx, ly, lz); }
  function update(dt) {
    const c = st.cin; if (st.state < 2 || !c) return; const S = st.site; c.t += dt; const t = c.t; audio.tick(dt);
    const dir = c.dir, perp = new THREE.Vector3(-dir.z, 0, dir.x);
    ui.letterbox(smooth(clamp(t / 1.2, 0, 1)));
    if (t < 6.6) {
      // идём к борту грузовика
      const u = smooth(clamp((t - 1.2) / 3.8, 0, 1)), hx = lerp(c.hp[0], S.board[0], u), hz = lerp(c.hp[1], S.board[1], u), walking = t > 1.2 && t < 5.0;
      let hy = 0, hxx = hx, hzz = hz;
      if (t >= 5.0) { const w = smooth(clamp((t - 5.0) / 1.6, 0, 1)); hxx = lerp(S.board[0], S.inside[0], w); hzz = lerp(S.board[1], S.inside[1], w); hy = Math.sin(w * PI) * 0.35 + w * 0.8; }
      c.hero.group.position.set(hxx, hy + c.hero.update(t, walking), hzz);
      const hv = t < 5.0 ? dir : new THREE.Vector3(S.inside[0] - S.board[0], 0, S.inside[1] - S.board[1]).normalize(); c.hero.group.rotation.y = Math.atan2(hv.x, hv.z);
      if (t >= 6.5) c.hero.group.visible = false;
      const chest = [hxx, hy + 1.3, hzz];
      if (t < 1.2) { // из глаз героя в вид сзади-сбоку
        const k = smooth(t / 1.2), tx = c.hp[0] - dir.x * 3.0 + perp.x * 1.2, tz = c.hp[1] - dir.z * 3.0 + perp.z * 1.2;
        setCam(lerp(c.p0.x, tx, k), lerp(c.p0.y, 2.0, k), lerp(c.p0.z, tz, k), lerp(c.p0.x - Math.sin(c.yaw0) * 5, chest[0], k), lerp(c.p0.y, chest[1], k), lerp(c.p0.z - Math.cos(c.yaw0) * 5, chest[2], k));
      } else { // облёт: камера уходит вперёд-вправо, чтобы показать солдат и колонну
        const ang = lerp(0.35, 1.45, clamp((t - 1.2) / 5.4, 0, 1)), r = 3.4, cs = Math.cos(ang), sn = Math.sin(ang);
        const bx = -dir.x * cs + perp.x * sn, bz = -dir.z * cs + perp.z * sn;
        setCam(hxx + bx * r, 1.9 - Math.min(0.9, (t - 5.0) * 0.4 * (t > 5 ? 1 : 0)), hzz + bz * r, chest[0], chest[1], chest[2]);
      }
      audio.heli(true, 0.05);
    } else {
      // грузовик трогается, камера отдаляется и поднимается
      const tt = t - 6.6; if (tt > 1.6) audio.engine(true, clamp(c.v / 13, 0, 1)); else audio.engine(true, 0.05);
      const move = tt > 1.6 ? clamp((tt - 1.6) * 2.1, 0, 13) : 0; c.v = move;
      const fwd = new THREE.Vector3(Math.sin(S.ry) * -1, 0, Math.cos(S.ry) * -1); // перед кузова - локальный -Z
      c.tpos.addScaledVector(fwd, move * dt); S.truck.position.set(c.tpos.x, G.terrainY(c.tpos.x, c.tpos.z), c.tpos.z);
      const u = smooth(clamp(tt / 12, 0, 1)), R = S.ry, cr = Math.cos(R), sr = Math.sin(R);
      const off = [lerp(6.5, 0, u), lerp(2.2, 22, u), lerp(-2.5, 46, u)];             // в осях грузовика; +Z - позади
      const wx = c.tpos.x + off[0] * cr + off[2] * sr, wz = c.tpos.z - off[0] * sr + off[2] * cr, wy = Math.max(S.truck.position.y + off[1], G.terrainY(wx, wz) + 2.5);
      setCam(wx, wy, wz, c.tpos.x, S.truck.position.y + 1.6, c.tpos.z);
      if (tt > 11.5) ui.setFade(smooth(clamp((tt - 11.5) / 2.2, 0, 1)));
      if (tt > 14 && !c.done) { c.done = true; st.state = 3; ui.setFade(1); ui.letterbox(0); audio.engine(false); audio.heli(false); audio.wind(false); audio.pad(true); c.tt = 0; }
    }
    if (c.done) {
      c.tt += dt; const a1 = smooth(clamp(c.tt / 1.6, 0, 1)), a2 = smooth(clamp((c.tt - 1.4) / 1.4, 0, 1));
      ui.title('ВЫ ВЫЖИЛИ', '14 дней позади. Но это только начало...', a1, a2);
      if (c.tt > 5.5 && !c.menuShown) { c.menuShown = true; document.exitPointerLock && document.exitPointerLock(); ui.menu([{ label: 'Продолжить игру', cb: continueGame }, { label: 'Новая игра', cb: newGame }, { label: 'Выход в главное меню', cb: toMenu }]); }
    }
  }
  function continueGame() { // остаёмся на площадке эвакуации, финал больше не повторится
    const S = st.site, c = st.cin; audio.stopAll(); ui.reset(); G.menuClose && G.menuClose();
    if (c && c.hero) { scene.remove(c.hero.group); }
    if (S && S.truck) { scene.remove(S.truck); const i = G.colliders.indexOf(S.truckCol); if (i >= 0) G.colliders.splice(i, 1); }
    const sx = S ? S.board[0] : 0, sz = S ? S.board[1] : 0; camera.position.set(sx + Math.sin(S.ry) * 0, G.terrainY(sx, sz) + 1.7, sz + 2.5 * Math.cos(S.ry)); G.yaw = S.ry; G.pitch = 0; camera.rotation.set(0, S.ry, 0, 'YXZ');
    st.state = 4; st.cin = null; cut.active = null; renderer.domElement.style.filter = ''; G.requestLock(); G.notify('Ты в безопасности. Пока.');
  }
  function newGame() { try { localStorage.setItem('dz_boot', JSON.stringify({ newGame: true })); } catch (e) { /* без хранилища */ } location.reload(); }
  function toMenu() { location.reload(); }

  return {
    tick, update,
    serialize() { return { s: st.state >= 2 ? 4 : st.state }; },
    restore(o) { st.state = 0; st.silent = false; if (o && o.s === 4) st.state = 4; else if (o && o.s === 1) st.silent = true; },
    get state() { return st.state; },
    get site() { return st.site; },
    debugAnnounce() { announce(false); },
    debugContinue() { continueGame(); },
  };
}
