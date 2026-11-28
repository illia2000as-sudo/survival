// Кат-сцены DeadZone: вступление «Начало конца» и финал «Эвакуация».
// main.js вызывает initCutscenes(G) один раз и дальше только: startIntro(), update(dt), serialize()/restore().
import { createUI } from './ui.js';
import { createAudio } from './audio.js';
import { createPeople } from './people.js';
import { createIntro } from './intro.js';
import { createFinale } from './finale.js';

export function initCutscenes(G) {
  const cut = { active: null };                       // null | 'intro' | 'final': пока не null, игровое время стоит, ввод игры отключён
  const ui = createUI(G.hudEls), audio = createAudio(), people = createPeople(G);
  const intro = createIntro(G, ui, audio, cut, people), finale = createFinale(G, ui, audio, cut, people);
  try { if (window.speechSynthesis) window.speechSynthesis.getVoices(); } catch (e) { /* голоса подгрузятся позже */ }
  return {
    cut,
    startIntro: (onDone, opts) => intro.start(onDone, opts),
    update(rawDt) { intro.update(rawDt); finale.update(rawDt); finale.tick(rawDt); },   // в конце кадра, перед render
    serialize: () => finale.serialize(),
    restore: o => finale.restore(o),
    get finaleState() { return finale.state; },
    get introPhase() { return intro.phase; },
    get finaleSite() { return finale.site; },
    debugFinale: () => finale.debugAnnounce(),
    debugContinue: () => finale.debugContinue(),
  };
}
