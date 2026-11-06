// Город многоквартирных домов (1.12.0).
// Блоки ставятся на сетку улиц вокруг центра карты там, где нет других построек, поэтому мир из сохранений не меняется.
// Каждый дом: 4-5 этажей, лестничная клетка (двухмаршевая лестница), по две квартиры на этаж с мебелью, окнами и запасами.
// Все места и вид считаются из координат (h01), Math.random не нужен. Игрок на новой игре просыпается в квартире на втором этаже.
export function buildCity(G) {
  const { bKit, colliders, blockers, floors, scene, h01, mulCol } = G;
  const T = 0.3, FH = 3.0, HX = 13, HZ = 6, MAXB = 26;
  const treeCols = new Set(G.trees.map(t => t.collider));
  const overlap = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
  const blocked = rect => {
    for (const c of colliders) { if (treeCols.has(c)) continue; if (overlap(rect, c)) return true; }
    const at = p => (p.x !== undefined ? [p.x, p.z] : p.mesh ? [p.mesh.position.x, p.mesh.position.z] : [NaN, NaN]);
    for (const p of [...G.piles, ...G.cases]) { const [x, z] = at(p); if (x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ) return true; }
    return false;
  };

  // --- 1. Где ставить дома: сетка улиц, ближние к центру первыми ---
  const slots = [];
  for (let i = -4; i <= 3; i++) for (let j = -6; j <= 5; j++) {
    const cx = (i < 0 ? -1 : 1) * (34 + 46 * (i < 0 ? -i - 1 : i)), cz = (j < 0 ? -1 : 1) * (28 + 32 * (j < 0 ? -j - 1 : j)), row = j < 0 ? -j - 1 : j;
    if ((Math.abs(cz) > 135 && Math.abs(cx) < 48) || (Math.abs(cx) > 135 && Math.abs(cz) < 48)) continue;   // у концов дорог площадка эвакуации
    if (Math.abs(cx) + HX > 196 || Math.abs(cz) + HZ > 194) continue;
    slots.push({ cx, cz, ry: (row % 2 === 0) === (cz > 0) ? Math.PI : 0, d: Math.hypot(cx, cz) });  // фасадом к ближайшей улице между рядами
  }
  slots.sort((a, b) => a.d - b.d);
  const blocks = [];
  for (const sl of slots) {
    if (blocks.length >= MAXB) break;
    const rect = { minX: sl.cx - HX - 5, maxX: sl.cx + HX + 5, minZ: sl.cz - HZ - 5, maxZ: sl.cz + HZ + 5 };
    if (blocked(rect)) continue;
    blocks.push(sl);
  }
  if (!blocks.length) return { spawn: null, count: 0 };

  // --- 2. Постройка одного дома ---
  const WALLC = [0xb8b2a2, 0xa8a8a0, 0xbdb08c, 0x9aa4a8, 0xb4a898, 0xa8b0a0];
  const FLOORC = [0x6a4a2e, 0x7a6a50, 0x5a5a52], CURT = [0x7a4a3a, 0x4a5a6a, 0x6a6a4a, 0x5a4a62, 0x8a8a7a];
  function house(bl, idx) {
    const { cx, cz, ry } = bl, sg = ry === 0 ? 1 : -1, N = idx === 0 ? 4 : 4 + (h01(idx, cx, cz) > 0.5 ? 1 : 0);
    const WC = WALLC[Math.floor(h01(idx + 3, cx, cz) * WALLC.length)], K = bKit(cx, cz, 60 + idx), B = { s: K.s, d: K.d, m: K.m, g: K.g, gl: K.gl, r: K.r };
    const lw = (lx, lz) => [cx + sg * lx, cz + sg * lz];
    const wr = (lx0, lx1, lz0, lz1) => { const [a, c] = lw(lx0, lz0), [b, d] = lw(lx1, lz1); return { minX: Math.min(a, b), maxX: Math.max(a, b), minZ: Math.min(c, d), maxZ: Math.max(c, d) }; };
    const col = (lx0, lx1, lz0, lz1, top, bottom) => { const c = wr(lx0, lx1, lz0, lz1); if (top !== undefined) c.top = top; if (bottom !== undefined) c.bottom = bottom; colliders.push(c); };
    const flo = (lx0, lx1, lz0, lz1, y) => floors.push(Object.assign(wr(lx0, lx1, lz0, lz1), { y }));
    const TOP = FH * N - 0.2;
    // стена по линии с проёмами: axis 'x' - вдоль X на z = c, 'z' - вдоль Z на x = c
    function wall(axis, c, a0, a1, y0, y1, ops, color, glass) {
      const seg = (p, q, ya, yb) => { if (q - p < 0.02 || yb - ya < 0.02) return; const mid = (p + q) / 2, my = (ya + yb) / 2; if (axis === 'x') B.s.box(q - p, yb - ya, T, color, mid, my, c); else B.s.box(T, yb - ya, q - p, color, c, my, mid); };
      let cur = a0; ops.slice().sort((a, b) => a.c - b.c).forEach(o => {
        const p = o.c - o.w / 2, q = o.c + o.w / 2; seg(cur, p, y0, y1); seg(p, q, y1 > o.y1 ? o.y1 : y1, y1); if (o.y0 > y0) seg(p, q, y0, o.y0); cur = q;
        if (o.win) { // окно: рама, крестовина, стекло, подоконник; часть окон разбита или с занавеской
          const wy = (o.y0 + o.y1) / 2, hh = o.y1 - o.y0, br = h01(Math.round(o.c * 10) + Math.round(y0), cx, cz), px = axis === 'x' ? o.c : c, pz = axis === 'x' ? c : o.c;
          const dir = axis === 'x' ? [1, 0] : [0, 1];
          const bx = (w, h, d2, cc, ox, oy, oz) => axis === 'x' ? B.d.box(w, h, d2, cc, px + ox, wy + oy, pz + oz) : B.d.box(d2, h, w, cc, px + oz, wy + oy, pz + ox);
          bx(o.w + 0.1, 0.08, T + 0.16, 0x5a5a54, 0, -hh / 2 - 0.04, 0); bx(o.w, 0.05, 0.06, 0xd8d4c8, 0, 0, 0); bx(0.05, hh, 0.06, 0xd8d4c8, 0, 0, 0);
          if (br < 0.82 && glass) (axis === 'x' ? B.gl.box(o.w - 0.06, hh - 0.06, 0.03, 0xa8bcc4, px, wy, pz) : B.gl.box(0.03, hh - 0.06, o.w - 0.06, 0xa8bcc4, px, wy, pz));
          if (br > 0.45 && br < 0.7) bx(o.w * 0.45, hh * 0.9, 0.05, CURT[Math.floor(br * 40) % CURT.length], o.w * 0.2, 0, 0.1 * (axis === 'x' ? -sg * Math.sign(c) : 1) * 0);
          if (br > 0.93) { for (let k = 0; k < 3; k++) bx(o.w * 0.95, 0.12, 0.05, 0x6a5030, 0, -hh * 0.3 + k * hh * 0.3, 0.18 * Math.sign(c || 1)); }   // забито досками
        }
      });
      seg(cur, a1, y0, y1);
    }
    const winsX = (levelY0, door) => { // окна вдоль фасада
      const o = [-11.2, -8.0, -4.8, 4.8, 8.0, 11.2].map(c => ({ c, w: 1.6, y0: levelY0 + 0.9, y1: levelY0 + 2.3, win: true }));
      o.push(door ? { c: 0, w: 2.2, y0: levelY0, y1: levelY0 + 2.3, win: false } : { c: 0, w: 1.6, y0: levelY0 + 0.9, y1: levelY0 + 2.3, win: true }); return o;
    };
    for (let k = 0; k < N; k++) {
      const y0 = FH * k, y1 = y0 + FH;
      wall('x', HZ, -HX, HX, y0, y1, winsX(y0, k === 0), WC, true);                                              // фасад
      wall('x', -HZ, -HX, HX, y0, y1, [-11.2, -8.0, -4.8, 4.8, 8.0, 11.2, 0].map(c => ({ c, w: c === 0 ? 1.4 : 1.6, y0: y0 + 0.9, y1: y0 + 2.3, win: true })), WC, true);   // задняя стена
      [-HX, HX].forEach(x => wall('z', x, -HZ, HZ, y0, y1, [-3.0, 3.0].map(c => ({ c, w: 1.6, y0: y0 + 0.9, y1: y0 + 2.3, win: true })), WC, true));
      [-2.5, 2.5].forEach(x => wall('z', x, -HZ, HZ, y0, y1, [{ c: 3.0, w: 1.6, y0: y0, y1: y0 + 2.2, win: false }], mulCol(WC, 0.92), false));  // стены лестничной клетки с дверью в квартиру
      [-1, 1].forEach(sx => { const a = sx > 0 ? 2.5 : -HX, b = sx > 0 ? HX : -2.5; wall('x', -1, a, b, y0, y1, [{ c: sx * 6.0, w: 1.2, y0: y0, y1: y0 + 2.1, win: false }], mulCol(WC, 1.06), false); }); // перегородка комнат
      // пол этажа (кроме первого) и потолок: плиты по крыльям и передней части клетки; над лестницей остаётся проём
      if (k > 0) {
        [-1, 1].forEach(sx => { B.s.box(10.6, 0.25, 12.0, 0x8f8f88, sx * 7.75, y0 - 0.125, 0); flo(sx > 0 ? 2.45 : -13.05, sx > 0 ? 13.05 : -2.45, -6.15, 6.15, y0); });
        B.s.box(5.0, 0.25, 5.5, 0x8f8f88, 0, y0 - 0.125, 3.25); flo(-2.5, 2.5, 0.5, 6.15, y0);
        // балконные плиты на фасаде
        [-8.0, 8.0].forEach(x => { B.d.box(3.4, 0.14, 1.1, 0x8a8a84, x, y0 - 0.07, HZ + 0.65); B.m.box(3.4, 0.06, 0.05, 0x4a4f55, x, y0 + 0.95, HZ + 1.17); B.m.box(0.05, 1.0, 1.1, 0x4a4f55, x - 1.7, y0 + 0.45, HZ + 0.65); B.m.box(0.05, 1.0, 1.1, 0x4a4f55, x + 1.7, y0 + 0.45, HZ + 0.65); });
      }
      furnish(k, y0);
    }
    // крыша: плиты, парапет, надстройки
    const yR = FH * N;
    [-1, 1].forEach(sx => { B.s.box(10.6, 0.3, 12.0, 0x4a4d50, sx * 7.75, yR - 0.15, 0); flo(sx > 0 ? 2.45 : -13.05, sx > 0 ? 13.05 : -2.45, -6.15, 6.15, yR); });
    B.s.box(5.0, 0.3, 5.5, 0x4a4d50, 0, yR - 0.15, 3.25); flo(-2.5, 2.5, 0.5, 6.15, yR);
    B.r.box(26.6, 0.9, 0.25, mulCol(WC, 0.9), 0, yR + 0.45, HZ + 0.05); B.r.box(26.6, 0.9, 0.25, mulCol(WC, 0.9), 0, yR + 0.45, -HZ - 0.05);
    B.r.box(0.25, 0.9, 12.4, mulCol(WC, 0.9), HX + 0.05, yR + 0.45, 0); B.r.box(0.25, 0.9, 12.4, mulCol(WC, 0.9), -HX - 0.05, yR + 0.45, 0);
    [[-7, 0, 1.4, 0.8, 1.0], [8, -2, 1.4, 0.8, 1.0], [10.5, 3, 1.0, 0.8, 0.9]].forEach(([x, z, w, h, d2]) => { B.m.box(w, h, d2, 0xb0b4b8, x, yR + h / 2, z); B.m.cyl(0.32, 0.04, 0x2a2d30, x, yR + h, z, 8); });
    B.m.cyl(1.0, 1.8, 0x6a6f75, -10, yR, -3.5, 10); B.m.cyl(1.05, 0.12, 0x3a3f45, -10, yR + 1.8, -3.5, 10);
    B.m.tube([4, yR, -4.5], [4, yR + 3.5, -4.5], 0.03, 0x4a4f55, 4); B.m.tube([3.5, yR + 3.0, -4.5], [4.5, yR + 3.0, -4.5], 0.02, 0x4a4f55, 3);
    // вход: козырёк, ступень, табличка с номером
    B.m.box(3.6, 0.12, 1.6, 0x4a4f55, 0, 2.7, HZ + 0.8); [-1.6, 1.6].forEach(x => B.m.box(0.1, 2.7, 0.1, 0x3a3f45, x, 1.35, HZ + 1.5)); B.s.box(3.4, 0.15, 1.6, 0x77776f, 0, 0.075, HZ + 0.9);
    B.d.box(0.9, 0.5, 0.05, 0x2a2d30, 3.2, 1.4, HZ + 0.18);
    // лестница в подъезде: маршами с площадкой, как «буква П»
    for (let k = 0; k < N; k++) {
      const y0 = FH * k;
      for (let i = 0; i < 8; i++) {
        const zh = 0.5 - 0.4 * i, zl = zh - 0.4, yt = y0 + 0.1875 * (i + 1), zm = (zl + zh) / 2;
        flo(-2.3, 0, zl, zh, yt);
        if (k === 0) { B.s.box(2.3, yt, 0.4, 0x8a8a84, -1.15, yt / 2, zm); col(-2.3, 0, zl, zh, yt); }
        else { B.d.box(2.3, 0.1, 0.4, 0x8a8a84, -1.15, yt - 0.05, zm); B.d.box(2.3, 0.19, 0.04, 0x6a6a64, -1.15, yt - 0.14, zh); }
        const zl2 = -2.7 + 0.4 * i, zh2 = zl2 + 0.4, yt2 = y0 + 1.5 + 0.1875 * (i + 1), zm2 = (zl2 + zh2) / 2;
        flo(0, 2.3, zl2, zh2, yt2);
        B.d.box(2.3, 0.1, 0.4, 0x8a8a84, 1.15, yt2 - 0.05, zm2); B.d.box(2.3, 0.19, 0.04, 0x6a6a64, 1.15, yt2 - 0.14, zl2);
      }
      B.s.box(4.6, 0.2, 3.3, 0x8a8a84, 0, y0 + 1.4, -4.35); flo(-2.3, 2.3, -6, -2.7, y0 + 1.5);
      B.g.box(0.5, 0.05, 0.25, 0xfff0cc, 0, y0 + 2.8, -4.5); B.g.box(0.5, 0.05, 0.25, 0xfff0cc, 0, y0 + 2.8, 3.2);
    }
    col(0, 2.3, -2.7, 0.5, 1.7); col(-2.3, 2.3, -6, -2.7, 1.7);  // под лестницей и площадкой внизу пройти нельзя
    // стены и двери: столкновения
    col(-HX - 0.15, -1.1, HZ - 0.15, HZ + 0.15, TOP); col(1.1, HX + 0.15, HZ - 0.15, HZ + 0.15, TOP); col(-1.1, 1.1, HZ - 0.15, HZ + 0.15, TOP, FH);  // фасад, над дверью - только для верхних этажей
    col(-HX - 0.15, HX + 0.15, -HZ - 0.15, -HZ + 0.15, TOP); col(-HX - 0.15, -HX + 0.15, -HZ, HZ, TOP); col(HX - 0.15, HX + 0.15, -HZ, HZ, TOP);
    [-2.5, 2.5].forEach(x => { col(x - 0.15, x + 0.15, -HZ, 2.2, TOP); col(x - 0.15, x + 0.15, 3.8, HZ, TOP); });
    col(2.5, 5.4, -1.15, -0.85, TOP); col(6.6, HX, -1.15, -0.85, TOP); col(-5.4, -2.5, -1.15, -0.85, TOP); col(-HX, -6.6, -1.15, -0.85, TOP);

    // --- квартиры: мебель, беспорядок, запасы ---
    function furnish(k, y0) {
      [-1, 1].forEach(sx => {
        const ax = a => sx * a, tag = k * 17 + (sx > 0 ? 5 : 0) + idx * 3, hv = n => h01(tag + n, cx, cz);
        B.d.box(10.3, 0.02, 11.7, FLOORC[Math.floor(hv(1) * 3)], sx * 7.75, y0 + 0.011, 0);                               // пол
        B.d.box(2.6, 0.015, 1.8, CURT[Math.floor(hv(2) * 5)], ax(8.2), y0 + 0.027, 2.4, 0, hv(3) * 0.4, 0);                // ковёр
        // спальня: кровать, тумбочка, шкаф
        const bz = -4.6, bxx = ax(11.8);
        B.d.box(1.1, 0.25, 2.0, 0x5a3a22, bxx, y0 + 0.3, bz); B.d.box(1.0, 0.2, 1.95, 0xc8c0b0, bxx, y0 + 0.5, bz); B.d.box(0.95, 0.12, 1.0, CURT[Math.floor(hv(4) * 5)], bxx, y0 + 0.66, bz + 0.45, 0, 0.05, 0);
        B.d.box(0.6, 0.12, 0.4, 0xe0dccc, bxx, y0 + 0.66, bz - 0.7); B.d.box(1.1, 0.7, 0.06, 0x4a2e1a, bxx, y0 + 0.65, bz - 1.02);
        B.d.box(0.45, 0.5, 0.4, 0x5a4026, ax(11.8), y0 + 0.25, -2.9); B.d.box(1.2, 2.0, 0.55, 0x4a3220, ax(3.4), y0 + 1.0, -5.65); B.d.box(0.02, 1.8, 0.4, 0x2a1a10, ax(3.4), y0 + 1.0, -5.37);
        col(sx > 0 ? 11.2 : -12.4, sx > 0 ? 12.4 : -11.2, -5.6, -3.6, y0 + 1.1, y0); col(sx > 0 ? 2.8 : -4.0, sx > 0 ? 4.0 : -2.8, -5.9, -5.35, y0 + 1.5, y0);
        // гостиная и кухня: стол, стулья, диван, столешница, холодильник
        B.d.box(1.3, 0.06, 0.8, 0x7a5a38, ax(9.0), y0 + 0.75, 3.6); [[-0.55, -0.3], [0.55, -0.3], [-0.55, 0.3], [0.55, 0.3]].forEach(([a, b]) => B.d.box(0.06, 0.72, 0.06, 0x5a4026, ax(9.0) + a, y0 + 0.36, 3.6 + b));
        B.d.box(0.4, 0.05, 0.4, 0x6a4a2a, ax(9.0), y0 + 0.45, 4.35); B.d.box(0.4, 0.5, 0.05, 0x6a4a2a, ax(9.0), y0 + 0.7, 4.55); B.d.box(0.4, 0.05, 0.4, 0x6a4a2a, ax(9.0) + 0.3, y0 + 0.45, 2.7, 0, 0.6, 0);
        B.d.box(0.9, 0.45, 2.0, CURT[Math.floor(hv(5) * 5)], ax(12.4), y0 + 0.25, 2.6); B.d.box(0.2, 0.5, 2.0, mulCol(CURT[Math.floor(hv(5) * 5)], 0.8), ax(12.75), y0 + 0.6, 2.6);
        B.d.box(2.4, 0.9, 0.6, 0x7a7a70, ax(4.5), y0 + 0.45, -0.4); B.d.box(2.44, 0.05, 0.64, 0x3a3a38, ax(4.5), y0 + 0.92, -0.4); B.m.box(0.5, 0.02, 0.4, 0x9aa0a4, ax(4.0), y0 + 0.94, -0.4); B.m.cyl(0.07, 0.15, 0x8a8f94, ax(5.2), y0 + 0.94, -0.4, 8);
        B.m.box(0.7, 1.8, 0.7, 0xd8d6cc, ax(3.1), y0 + 0.9, 0.7); B.d.box(0.02, 0.5, 0.04, 0x8a8f94, ax(3.1) + (sx > 0 ? 0.36 : -0.36), y0 + 1.3, 0.4);
        col(sx > 0 ? 3.2 : -5.7, sx > 0 ? 5.7 : -3.2, -0.75, -0.1, y0 + 1.1, y0); col(sx > 0 ? 2.75 : -3.45, sx > 0 ? 3.45 : -2.75, 0.35, 1.05, y0 + 1.9, y0);
        if (k === 0) col(sx > 0 ? 11.9 : -12.9, sx > 0 ? 12.9 : -11.9, 1.6, 3.6, y0 + 0.5, y0);
        // свет, занавески, картины, беспорядок
        g(ax(7.5), y0 + 2.92, -3.5); g(ax(7.5), y0 + 2.92, 2.5);
        [4.8, 8.0, 11.2].forEach((a, i) => { if (hv(10 + i) > 0.4) { const c = CURT[Math.floor(hv(20 + i) * 5)]; B.d.box(0.3, 1.5, 0.05, c, ax(a) - 0.7, y0 + 1.55, HZ - 0.28); B.d.box(0.3, 1.5, 0.05, c, ax(a) + 0.7, y0 + 1.55, HZ - 0.28); } });
        B.d.box(0.9, 0.6, 0.04, [0x6a7a8a, 0x8a6a4a, 0x5a7a5a][Math.floor(hv(6) * 3)], ax(6.0), y0 + 1.7, -0.92); B.d.box(0.5, 0.7, 0.04, 0x8a7a5a, ax(12.9), y0 + 1.7, -2.5, 0, sx > 0 ? -1.57 : 1.57, 0);
        for (let m = 0; m < 5; m++) B.d.box(0.2 + hv(30 + m) * 0.4, 0.012, 0.15 + hv(35 + m) * 0.4, [0xe0dcc8, 0x6a5a4a, 0x4a5a6a, 0x8a3a3a][m % 4], ax(3.5 + hv(40 + m) * 8.5), y0 + 0.035, -5 + hv(45 + m) * 10, 0, hv(50 + m) * 3, 0);
        if (hv(7) > 0.82) { B.d.box(1.4, 0.012, 1.0, 0x4a0f0f, ax(7 + hv(8) * 4), y0 + 0.032, 3 + hv(9)); B.d.box(0.4, 0.5, 0.012, 0x4a0f0f, ax(12.95), y0 + 1.3, 0.2, 0, sx > 0 ? -1.57 : 1.57, 0); }
        if (hv(11) > 0.7) B.d.box(0.45, 0.45, 0.45, 0x7a5c34, ax(6.3 + hv(12) * 3), y0 + 0.23, 4.8);
        // запасы: еда, вода, аптечки, патроны на столе, столешнице и полу (места фиксированы по зерну)
        const loot = hv(13);
        if (loot > 0.58 && !(idx === 0 && k === 1 && sx < 0)) {
          const n = 1 + Math.floor(hv(14) * 2.6);
          for (let q = 0; q < n; q++) {
            const r = hv(60 + q), type = r < 0.38 ? 'food' : r < 0.7 ? 'water' : r < 0.86 ? 'medkit' : 'ammo';
            const spot = [[ax(9.0 + (q - 1) * 0.35), 3.6, y0 + 0.78], [ax(4.2 + q * 0.5), -0.4, y0 + 0.94], [ax(11.8), -3.2, y0 + 0.52], [ax(6.5 + q), 5.2, y0 + 0.02]][Math.floor(hv(70 + q) * 4)];
            const [wx, wz] = lw(spot[0], spot[1]);
            if (type === 'ammo') G.spawnAmmoBox(wx, wz, true, spot[2]); else G.spawnItem(type, wx, wz, true, spot[2]);
          }
        }
      });
      function g(x, y, z) { B.g.box(0.7, 0.05, 0.25, 0xfff0cc, x, y, z); }
    }
    G.clearTrees(cx, cz, HX + 4, HZ + 4);
    return { K, lw, N, sg, wr, col };
  }

  // --- 3. Постройка всех домов, улицы, зомби ---
  const ground = bKit(0, 0, 59), GD = ground.d;
  const built = [], carCols = [0x5a6a7a, 0x7a3a2a, 0x6a6a3a, 0x3a5a4a, 0x7a7a7a, 0x4a4a52];
  blocks.forEach((bl, i) => {
    // чистим площадь от старых предметов ДО постройки, чтобы не выбросить собственные запасы
    const cl = (x, z) => Math.abs(x - bl.cx) < HX + 3 && Math.abs(z - bl.cz) < HZ + 3;
    for (let q = G.items.length - 1; q >= 0; q--) { const p = G.items[q].mesh.position; if (cl(p.x, p.z)) { scene.remove(G.items[q].mesh); G.items.splice(q, 1); } }
    for (let q = G.ammoBoxes.length - 1; q >= 0; q--) { const p = G.ammoBoxes[q].position; if (cl(p.x, p.z)) { scene.remove(G.ammoBoxes[q]); G.ammoBoxes.splice(q, 1); } }
    const H = house(bl, i); built.push(Object.assign({ bl }, H));
    const { sg } = H, w = (lx, lz) => H.lw(lx, lz);
    // тротуар и асфальт перед домом
    const apron = H.wr(-18, 18, HZ + 2, HZ + 11);
    const free = !colliders.some(c => !treeCols.has(c) && overlap(apron, c) && c.minX < apron.maxX && !(c.top !== undefined && c.bottom !== undefined));
    GD.box(HX * 2 + 3, 0.05, HZ * 2 + 3, 0x8a8a84, bl.cx, 0.025, bl.cz);                                       // тротуар вокруг
    if (free) { const [ax, az] = w(0, HZ + 6.5); GD.box(36, 0.04, 9, 0x2c2e30, ax, 0.02 + i * 0.0004, az); for (let k = -3; k <= 3; k++) { const [lx2, lz2] = w(k * 5, HZ + 6.5); GD.box(1.6, 0.015, 0.14, 0xd8d4c4, lx2, 0.045 + i * 0.0004, lz2); } }
    // фонари у входа, бак, машины на асфальте (если нет препятствий)
    const dress = (lx, lz, hx2, hz2) => !colliders.some(c => !treeCols.has(c) && overlap(H.wr(lx - hx2, lx + hx2, lz - hz2, lz + hz2), c) && c.bottom === undefined);
    [-1, 1].forEach(sd => { const [lx, lz] = w(sd * 15, HZ + 3); H.K.m.tube([lx, 0, lz], [lx, 5.5, lz], 0.07, 0x4a4f55, 5); H.K.g.box(0.5, 0.15, 0.3, 0xfff4dc, lx, 5.55, lz); H.K.m.box(0.9, 0.1, 0.5, 0x2f3438, lx, 5.45, lz); colliders.push({ minX: lx - 0.15, maxX: lx + 0.15, minZ: lz - 0.15, maxZ: lz + 0.15 }); });
    if (dress(-16, 2, 1, 1)) { const [lx, lz] = w(-16, 2); H.K.m.box(1.6, 1.1, 0.9, 0x2f5a2a, lx, 0.65, lz); H.K.m.box(1.7, 0.08, 1.0, 0x24401f, lx, 1.22, lz); colliders.push(H.wr(-16.8, -15.2, 1.5, 2.5)); }
    for (let c = 0; c < 2; c++) { const lx = (c ? 1 : -1) * (6 + 3 * h01(i + c, 3, 5)), lz = HZ + 6.5 + (c ? 1.5 : -1); if (dress(lx, lz, 2.4, 2.4) && h01(i * 3 + c, 8, 8) > 0.35) { const [wx, wz] = w(lx, lz); G.carK(H.K, wx, wz, (c ? 0.2 : -0.15) + (sg < 0 ? Math.PI : 0) + Math.PI / 2 * (h01(i, c, 1) > 0.5 ? 1 : 0), carCols[(i + c * 3) % carCols.length]); } }
    // номер дома над подъездом
    const [nx, nz] = w(0, HZ + 0.2); G.textPlane('ДОМ ' + (i + 1), 1.6, 0.5, '#23282c', '#e8dfc8', nx, 3.3, nz + (sg > 0 ? 0.05 : -0.05), sg > 0 ? 0 : Math.PI);
  });
  ground.finish();
  built.forEach(b => { b.meshes = b.K.finish(); });   // меши домов вместе с уличной обстановкой

  // --- 4. Точка появления и зомби ---
  const first = built[0], [sx0, sz0] = first.lw(-8.0, 3.2);
  const spawn = { x: sx0, y: FH, z: sz0, yaw: first.sg > 0 ? Math.PI : 0, block: first.bl };
  // стол в стартовой квартире с запасами: еда, вода, аптечка
  ['food', 'food', 'water', 'water', 'medkit'].forEach((tp, q) => { const [wx, wz] = first.lw(-(8.5 + q * 0.28), 3.6 + (q % 2) * 0.12); G.spawnItem(tp, wx, wz, true, FH + 0.78); });
  let nz = 0;
  built.forEach((b, i) => {
    const bl = b.bl; if (Math.hypot(bl.cx - sx0, bl.cz - sz0) < 24) return;
    const n = 1 + (h01(i, 21, 9) > 0.45 ? 1 : 0);
    for (let q = 0; q < n && nz < 34; q++) { const [wx, wz] = b.lw((q ? 1 : -1) * (6 + 6 * h01(i + q, 4, 4)), HZ + 8 + 3 * h01(i, q, 5)); G.spawnZombie(wx, wz, h01(i, q, 6) > 0.85 ? 'runner' : undefined); nz++; }
    if (h01(i, 77, 3) > 0.62) { const [wx, wz] = b.lw((h01(i, 1, 1) > 0.5 ? 1 : -1) * 8, 2.5); G.spawnZombie(wx, wz); nz++; }   // один бродит в квартире на первом этаже
  });
  return { spawn, count: built.length, zombies: nz, cells: built.map(b => ({ x: b.bl.cx, z: b.bl.cz, meshes: b.meshes })) };  // cells: для скрытия далёких домов
}
