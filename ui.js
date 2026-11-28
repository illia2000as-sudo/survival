// Слой интерфейса кат-сцен: затемнение, веки, субтитры, подсказки, титры, кнопки, чёрные полосы.
// Всё рисуется поверх игры обычными div; своих данных игры тут нет.
export function createUI(hudEls) {
  const st = document.createElement('style');
  st.textContent = 'body.dz-cut .dz-h{display:none!important}' +
    '.dz-btn{font:inherit;font-size:20px;color:#fff;width:320px;padding:12px;margin:6px;border:2px solid #5a6b45;border-radius:8px;background:#2a3324;cursor:pointer}' +
    '.dz-btn:hover{background:#3a4a30}';
  document.head.appendChild(st);
  hudEls.forEach(e => { if (e && e.classList) e.classList.add('dz-h'); }); // эти элементы прячутся на время сцены

  const mk = css => { const d = document.createElement('div'); d.style.cssText = css; document.body.appendChild(d); return d; };
  const txt = 'position:fixed;left:0;right:0;pointer-events:none;font-family:monospace;color:#fff;text-align:center;';
  const vignette = mk('position:fixed;inset:0;pointer-events:none;z-index:25;opacity:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 38%,rgba(0,0,0,.8) 100%)');
  const fade = mk('position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:26;display:none');
  const barT = mk('position:fixed;left:0;right:0;top:0;height:0;background:#000;pointer-events:none;z-index:27');
  const barB = mk('position:fixed;left:0;right:0;bottom:0;height:0;background:#000;pointer-events:none;z-index:27');
  const subs = mk(txt + 'bottom:12vh;font-size:23px;line-height:1.35;text-shadow:0 2px 6px #000,0 0 14px #000;z-index:28;padding:0 14vw;opacity:0;transition:opacity .25s');
  const hint = mk(txt + 'bottom:24vh;font-size:20px;text-shadow:0 2px 6px #000;z-index:28;opacity:0;transition:opacity .25s');
  const obj = mk('position:fixed;top:16px;left:50%;transform:translateX(-50%);font:17px monospace;color:#e8dfa8;background:rgba(0,0,0,.45);padding:6px 16px;border-radius:6px;pointer-events:none;z-index:28;opacity:0;transition:opacity .4s;white-space:nowrap');
  const title = mk('position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:29;pointer-events:none;font-family:monospace;color:#fff');
  const skip = mk('position:fixed;right:18px;bottom:16px;z-index:32;font:15px monospace;color:#ddd;background:rgba(0,0,0,.55);border:1px solid #777;border-radius:6px;padding:8px 14px;cursor:pointer;display:none;pointer-events:auto');
  const menu = mk('position:fixed;inset:0;z-index:31;display:none;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:12vh;font-family:monospace;color:#fff;pointer-events:none');
  const cache = new Map();
  const set = (name, el, prop, v) => { const k = name + prop; if (cache.get(k) !== v) { cache.set(k, v); el.style[prop] = v; } };
  let skipCb = null;
  skip.addEventListener('click', e => { e.stopPropagation(); if (skipCb) skipCb(); });

  const ui = {
    setFade(a) { set('fade', fade, 'display', a > 0.001 ? 'block' : 'none'); set('fade', fade, 'opacity', String(Math.min(1, Math.max(0, a)))); },
    setVignette(a) { set('vig', vignette, 'opacity', String(a)); },
    letterbox(a) { const h = (a * 11).toFixed(2) + 'vh'; set('bt', barT, 'height', h); set('bb', barB, 'height', h); },
    blur(px) { return px > 0.05 ? 'blur(' + px.toFixed(1) + 'px)' : ''; },
    sub(t) { if (t) { subs.textContent = t; set('subs', subs, 'opacity', '1'); } else set('subs', subs, 'opacity', '0'); },
    hint(t) { if (t) { if (hint.textContent !== t) hint.textContent = t; set('hint', hint, 'opacity', '1'); } else set('hint', hint, 'opacity', '0'); },
    objective(t) { if (t) { if (obj.textContent !== t) obj.textContent = t; set('obj', obj, 'opacity', '1'); } else set('obj', obj, 'opacity', '0'); },
    title(h1, h2, a1, a2) { // два текста по центру; a1, a2 - прозрачность
      if (title.dataset.h !== h1 + '|' + h2) {
        title.dataset.h = h1 + '|' + h2;
        title.innerHTML = '<div id="dzT1" style="font-size:min(11vw,110px);letter-spacing:.14em;text-shadow:0 4px 18px #000;opacity:0">' + h1 + '</div>' +
          '<div id="dzT2" style="font-size:min(3vw,26px);font-style:italic;opacity:0;margin-top:18px;letter-spacing:.06em;color:#d8d2b4">' + h2 + '</div>';
      }
      const t1 = title.firstChild, t2 = title.lastChild;
      if (t1 && t2) { t1.style.opacity = String(a1); t2.style.opacity = String(a2); }
    },
    clearTitle() { title.innerHTML = ''; title.dataset.h = ''; },
    showSkip(label, cb) { skipCb = cb; skip.textContent = label; skip.style.display = cb ? 'block' : 'none'; },
    menu(buttons) { // buttons: [{label, cb}]
      menu.innerHTML = ''; menu.style.display = buttons && buttons.length ? 'flex' : 'none';
      (buttons || []).forEach(b => {
        const e = document.createElement('button'); e.className = 'dz-btn'; e.textContent = b.label; e.style.pointerEvents = 'auto';
        e.addEventListener('click', ev => { ev.stopPropagation(); b.cb(); }); menu.appendChild(e);
      });
    },
    hideHud(on) { document.body.classList.toggle('dz-cut', !!on); },
    reset() { ui.setFade(0); ui.setVignette(0); ui.letterbox(0); ui.sub(''); ui.hint(''); ui.objective(''); ui.clearTitle(); ui.showSkip('', null); ui.menu(null); ui.hideHud(false); },
    el: { fade, subs },
  };
  return ui;
}
