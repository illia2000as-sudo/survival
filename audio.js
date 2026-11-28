// Звук кат-сцен: всё синтезируется WebAudio, файлов не нужно. Если положить настоящие записи в assets/audio/
// (см. assets/audio/README.txt), они подхватятся автоматически вместо заглушек.
export const CUT_FILES = {
  siren: 'assets/audio/siren.mp3',               // воздушная тревога (зациклится)
  introVoice: 'assets/audio/intro_radio.mp3',    // голос диктора во вступлении
  finaleVoice: 'assets/audio/finale_radio.mp3',  // голос диктора в финале
};
export function createAudio() {
  let ctx = null, master = null, noiseBuf = null, reverbIn = null;
  const AC = window.AudioContext || window.webkitAudioContext;
  const A = { files: {}, sirenNodes: null, windNodes: null, radioNodes: null, cityOn: false, cityT: 0, engineNodes: null, padNodes: null, speaking: false };

  function makeNoise() { const n = ctx.sampleRate * 2, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0); let last = 0; for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = (w * 0.6 + last * 6) * 0.5; } return b; }
  function makeReverb() { // импульс из затухающего шума: сирена звучит как над всем городом
    const len = ctx.sampleRate * 2.6, b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    const cv = ctx.createConvolver(); cv.buffer = b; const g = ctx.createGain(); g.gain.value = 0.9; g.connect(cv); cv.connect(master); return g;
  }
  A.unlock = () => {
    if (!AC) return false;
    try {
      if (!ctx) { ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.85; master.connect(ctx.destination); noiseBuf = makeNoise(); reverbIn = makeReverb(); }
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    } catch (e) { ctx = null; return false; }
  };
  A.ok = () => !!ctx;
  const noiseSrc = () => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random() * 1.5); return s; };
  const ramp = (p, v, t) => { const n = ctx.currentTime; p.cancelScheduledValues(n); p.setValueAtTime(p.value, n); p.linearRampToValueAtTime(v, n + Math.max(0.02, t)); };

  // --- Файлы-замены ---
  A.loadFile = key => new Promise(res => { // подхватывает запись, если она лежит в assets/audio; иначе null
    if (A.files[key] !== undefined) return res(A.files[key]);
    try {
      const a = new Audio(); a.preload = 'auto'; let done = false;
      const fin = v => { if (!done) { done = true; A.files[key] = v; res(v); } };
      a.addEventListener('canplaythrough', () => fin(a), { once: true }); a.addEventListener('error', () => fin(null), { once: true });
      setTimeout(() => fin(null), 1200); a.src = CUT_FILES[key];
    } catch (e) { res(null); }
  });
  A.playFile = (a, vol = 1) => new Promise(res => { a.volume = vol; a.currentTime = 0; a.onended = () => res(true); a.onerror = () => res(false); const p = a.play(); if (p && p.catch) p.catch(() => res(false)); });

  // --- Сирена воздушной тревоги: три слегка расстроенных голоса, вой вверх и вниз, эхо ---
  A.siren = (on, vol = 0.5, muffle = 650) => {
    if (!ctx) return;
    if (!on) { if (A.sirenNodes) { const n = A.sirenNodes; ramp(n.out.gain, 0, 2.5); setTimeout(() => { n.oscs.forEach(o => { try { o.stop(); } catch (e) { /* уже остановлен */ } }); }, 2800); A.sirenNodes = null; } return; }
    if (A.sirenNodes) return;
    const out = ctx.createGain(); out.gain.value = 0; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = muffle; lp.Q.value = 0.7;
    out.connect(lp); lp.connect(master); const send = ctx.createGain(); send.gain.value = 0.55; lp.connect(send); send.connect(reverbIn);
    const oscs = [];
    [0, 1, 2].forEach(i => {
      const o = ctx.createOscillator(); o.type = i === 1 ? 'square' : 'sawtooth'; const g = ctx.createGain(); g.gain.value = i === 1 ? 0.05 : 0.09; o.connect(g); g.connect(out);
      const t0 = ctx.currentTime + i * 0.9, det = 1 + i * 0.011; o.frequency.setValueAtTime(420 * det, ctx.currentTime);
      for (let c = 0; c < 14; c++) { o.frequency.linearRampToValueAtTime(820 * det, t0 + c * 9 + 4.5); o.frequency.linearRampToValueAtTime(420 * det, t0 + c * 9 + 9); }
      o.start(); oscs.push(o);
    });
    ramp(out.gain, vol, 3); A.sirenNodes = { out, lp, oscs };
  };
  A.sirenVol = (v, t = 1.5) => { if (A.sirenNodes) ramp(A.sirenNodes.out.gain, v, t); };
  A.sirenMuffle = (f, t = 1) => { if (A.sirenNodes) ramp(A.sirenNodes.lp.frequency, f, t); };

  // --- Ветер ---
  A.wind = (on, vol = 0.18) => {
    if (!ctx) return;
    if (!on) { if (A.windNodes) { const n = A.windNodes; ramp(n.g.gain, 0, 2); setTimeout(() => { try { n.src.stop(); n.lfo.stop(); } catch (e) { /* уже остановлен */ } }, 2300); A.windNodes = null; } return; }
    if (A.windNodes) return;
    const src = noiseSrc(), bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 380; bp.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0; src.connect(bp); bp.connect(g); g.connect(master);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11; const lg = ctx.createGain(); lg.gain.value = vol * 0.5; lfo.connect(lg); lg.connect(g.gain); lfo.start();
    ramp(g.gain, vol, 3); A.windNodes = { g, src, lfo };
  };

  // --- Далёкие звуки города ---
  function thud(vol = 0.5) { // взрыв вдали
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.4);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8); o.connect(g); g.connect(master); const s = g; const send = ctx.createGain(); send.gain.value = 0.6; s.connect(send); send.connect(reverbIn); o.start(t); o.stop(t + 2);
    const n = noiseSrc(), lp = ctx.createBiquadFilter(), ng = ctx.createGain(); lp.type = 'lowpass'; lp.frequency.value = 220; ng.gain.setValueAtTime(vol * 0.9, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 1.2); n.connect(lp); lp.connect(ng); ng.connect(master); n.stop(t + 1.3);
  }
  function shots(vol = 0.18) { // несколько хлопков
    const n = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + i * (0.12 + Math.random() * 0.25), s = noiseSrc(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 900 + Math.random() * 500; bp.Q.value = 0.8; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      s.connect(bp); bp.connect(g); g.connect(master); const r = ctx.createGain(); r.gain.value = 0.7; g.connect(r); r.connect(reverbIn); s.stop(t + 0.2);
    }
  }
  function carAlarm(vol = 0.05) { // автосигнализация вдалеке
    const t0 = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter(); o.type = 'square'; lp.type = 'lowpass'; lp.frequency.value = 1400;
    for (let i = 0; i < 16; i++) o.frequency.setValueAtTime(i % 2 ? 1250 : 900, t0 + i * 0.25);
    g.gain.setValueAtTime(vol, t0); g.gain.linearRampToValueAtTime(0, t0 + 4.2); o.connect(lp); lp.connect(g); g.connect(master); const r = ctx.createGain(); r.gain.value = 0.5; g.connect(r); r.connect(reverbIn); o.start(t0); o.stop(t0 + 4.3);
  }
  A.city = on => { A.cityOn = on; A.cityT = 2.5; };
  A.tick = dt => { // вызывать каждый кадр
    if (!ctx || !A.cityOn) return;
    A.cityT -= dt;
    if (A.cityT <= 0) { A.cityT = 2.5 + Math.random() * 5; const r = Math.random(); if (r < 0.4) thud(0.35 + Math.random() * 0.3); else if (r < 0.8) shots(); else carAlarm(); }
  };

  // --- Радио: шум эфира, треск, настройка, щелчок, голос ---
  A.radioStatic = (on, vol = 0.22) => {
    if (!ctx) return;
    if (!on) { if (A.radioNodes) { const n = A.radioNodes; ramp(n.g.gain, 0, 1.2); setTimeout(() => { try { n.src.stop(); n.lfo.stop(); } catch (e) { /* уже остановлен */ } }, 1500); A.radioNodes = null; } return; }
    if (A.radioNodes) { ramp(A.radioNodes.g.gain, vol, 0.3); return; }
    const src = noiseSrc(), hp = ctx.createBiquadFilter(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 500; bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.6; g.gain.value = 0;
    src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(master);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 7; const lg = ctx.createGain(); lg.gain.value = vol * 0.4; lfo.connect(lg); lg.connect(g.gain); lfo.start(); // «дрожание» эфира
    ramp(g.gain, vol, 0.4); A.radioNodes = { g, src, bp, lfo, lg };
  };
  A.radioLevel = (v, t = 0.5) => { if (A.radioNodes) { ramp(A.radioNodes.g.gain, v, t); A.radioNodes.lg.gain.value = v * 0.4; } };
  A.radioTune = (sec = 2.2) => { // ручка настройки: поиск станции
    if (!ctx || !A.radioNodes) return;
    const n = A.radioNodes, t = ctx.currentTime; n.bp.frequency.cancelScheduledValues(t); n.bp.frequency.setValueAtTime(500, t); n.bp.frequency.exponentialRampToValueAtTime(3200, t + sec * 0.6); n.bp.frequency.exponentialRampToValueAtTime(1500, t + sec);
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(500, t); o.frequency.exponentialRampToValueAtTime(2200, t + sec * 0.5); o.frequency.exponentialRampToValueAtTime(700, t + sec);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05, t + 0.3); g.gain.linearRampToValueAtTime(0.0001, t + sec); o.connect(g); g.connect(master); o.start(t); o.stop(t + sec + 0.1);
  };
  A.click = (vol = 0.4) => { // щелчок тумблера
    if (!ctx) return; const t = ctx.currentTime, s = noiseSrc(), hp = ctx.createBiquadFilter(), g = ctx.createGain(); hp.type = 'highpass'; hp.frequency.value = 1500;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07); s.connect(hp); hp.connect(g); g.connect(master); s.stop(t + 0.1);
    const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = 140; og.gain.setValueAtTime(vol * 0.7, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1); o.connect(og); og.connect(master); o.start(t); o.stop(t + 0.12);
  };
  A.crackle = () => { if (!ctx) return; const t = ctx.currentTime, s = noiseSrc(), bp = ctx.createBiquadFilter(), g = ctx.createGain(); bp.type = 'bandpass'; bp.frequency.value = 2500 + Math.random() * 2000; g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); s.connect(bp); bp.connect(g); g.connect(master); s.stop(t + 0.06); };
  A.babble = (sec, vol = 0.07) => { // заглушка голоса: «бормотание» через радиофильтр, пока нет записи
    if (!ctx) return; const t0 = ctx.currentTime, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(), bp = ctx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.value = 105; bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 0.8; f.type = 'bandpass'; f.Q.value = 4; g.gain.value = 0;
    for (let t = 0; t < sec; t += 0.09 + Math.random() * 0.08) { f.frequency.setValueAtTime(350 + Math.random() * 1700, t0 + t); g.gain.setValueAtTime(Math.random() < 0.15 ? 0 : vol, t0 + t); o.frequency.setValueAtTime(95 + Math.random() * 30, t0 + t); }
    g.gain.setValueAtTime(0, t0 + sec); o.connect(f); f.connect(g); g.connect(bp); bp.connect(master); o.start(t0); o.stop(t0 + sec + 0.1);
  };

  // Диктор: сначала запись (если есть), потом речь браузера (ru), потом бормотание-заглушка. Возвращает Promise, когда фраза закончилась.
  A.speak = (text, opts = {}) => new Promise(res => {
    const est = Math.max(1.8, text.length * 0.075 + 0.6);
    let done = false, timer = null; const fin = () => { if (!done) { done = true; clearTimeout(timer); A.speaking = false; res(); } };
    A.speaking = true; A.cancel = () => { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* нет речи */ } fin(); };
    try {
      const ss = window.speechSynthesis;
      if (ss && window.SpeechSynthesisUtterance) {
        const voices = ss.getVoices ? ss.getVoices() : [], ru = voices.find(v => /^ru/i.test(v.lang));
        if (ru || voices.length === 0) {
          const u = new SpeechSynthesisUtterance(text); u.lang = 'ru-RU'; if (ru) u.voice = ru; u.rate = opts.rate || 0.92; u.pitch = opts.pitch || 0.72; u.volume = opts.volume === undefined ? 1 : opts.volume;
          u.onend = fin; u.onerror = () => { A.babble(est); timer = setTimeout(fin, est * 1000); };
          timer = setTimeout(fin, est * 1000 * 2.2 + 3000); ss.speak(u); return;
        }
      }
    } catch (e) { /* речь недоступна */ }
    A.babble(est); timer = setTimeout(fin, est * 1000);
  });
  A.cancel = () => {};

  // --- Мотор грузовика, лопасти вертолёта вдали, пэд-музыка для титров ---
  A.engine = (on, load = 0) => {
    if (!ctx) return;
    if (!on) { if (A.engineNodes) { const n = A.engineNodes; ramp(n.g.gain, 0, 2); setTimeout(() => { try { n.o.stop(); n.l.stop(); } catch (e) { /* уже остановлен */ } }, 2300); A.engineNodes = null; } return; }
    if (!A.engineNodes) {
      const o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), l = ctx.createOscillator(), lg = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = 42; lp.type = 'lowpass'; lp.frequency.value = 220; g.gain.value = 0; l.frequency.value = 16; lg.gain.value = 0.05; l.connect(lg); lg.connect(g.gain);
      o.connect(lp); lp.connect(g); g.connect(master); o.start(); l.start(); A.engineNodes = { o, lp, g, l };
    }
    const n = A.engineNodes; ramp(n.g.gain, 0.12 + load * 0.1, 0.4); ramp(n.o.frequency, 42 + load * 55, 0.5); ramp(n.lp.frequency, 220 + load * 500, 0.5); n.l.frequency.value = 16 + load * 22;
  };
  A.heli = (on, vol = 0.1) => { // далёкие лопасти
    if (!ctx) return; if (!on) { A.heliOn = false; return; } if (A.heliOn) return; A.heliOn = true;
    const beat = () => { if (!A.heliOn || !ctx) return; const t = ctx.currentTime, s = noiseSrc(), lp = ctx.createBiquadFilter(), g = ctx.createGain(); lp.type = 'lowpass'; lp.frequency.value = 160; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); s.connect(lp); lp.connect(g); g.connect(master); s.stop(t + 0.15); setTimeout(beat, 95); };
    beat();
  };
  A.pad = on => { // тихий минорный аккорд под титры
    if (!ctx) return;
    if (!on) { if (A.padNodes) { const n = A.padNodes; ramp(n.g.gain, 0, 3); setTimeout(() => n.oscs.forEach(o => { try { o.stop(); } catch (e) { /* уже остановлен */ } }), 3200); A.padNodes = null; } return; }
    if (A.padNodes) return; const g = ctx.createGain(); g.gain.value = 0; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; g.connect(lp); lp.connect(master); const send = ctx.createGain(); send.gain.value = 0.7; lp.connect(send); send.connect(reverbIn);
    const oscs = [110, 130.8, 164.8, 220].map((f, i) => { const o = ctx.createOscillator(); o.type = i % 2 ? 'triangle' : 'sine'; o.frequency.value = f; o.detune.value = (i - 1.5) * 4; const og = ctx.createGain(); og.gain.value = 0.25; o.connect(og); og.connect(g); o.start(); return o; });
    ramp(g.gain, 0.18, 5); A.padNodes = { g, oscs };
  };
  A.stopAll = () => {
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* нет речи */ }
    A.cancel(); A.cityOn = false; A.heliOn = false; A.siren(false); A.wind(false); A.radioStatic(false); A.engine(false); A.pad(false);
    Object.values(A.files).forEach(a => { try { a && a.pause(); } catch (e) { /* не играет */ } });
  };
  return A;
}
