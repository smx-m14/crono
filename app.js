(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');
  const body = document.body;

  // ---------- Configuració persistent ----------
  const DEFAULTS = {
    mode: 'clock',
    scale: 0.85,
    sound: true,
    clockSeconds: true,
    clockDate: true,
    duration: 60 * 60 * 1000,
    title: '',
    alerts: {
      half: true, m15: false, m10: false, m5: true, m1: false,
      custom: false, customMin: 20,
      flash: true, redLast: true, volume: 0.7,
    },
  };

  const cfg = (() => {
    try {
      const s = JSON.parse(localStorage.getItem('crono-cfg') || '{}');
      return { ...DEFAULTS, ...s, alerts: { ...DEFAULTS.alerts, ...(s.alerts || {}) } };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  })();
  const save = () => { try { localStorage.setItem('crono-cfg', JSON.stringify(cfg)); } catch {} };

  // ---------- Estat ----------
  const T = { state: 'idle', duration: cfg.duration, remaining: cfg.duration, endAt: 0, lastRem: 0 };
  const S = { state: 'idle', elapsed: 0, startAt: 0 };

  const el = {
    digits: $('#digits'), ghost: $('#ghost'), display: $('#display'),
    sub: $('#sub'), banner: $('#banner'), title: $('#title'),
    tStart: $('#tStart'), sStart: $('#sStart'), fill: $('#progressFill'),
    inH: $('#inH'), inM: $('#inM'), inS: $('#inS'), dlg: $('#alertsDlg'),
  };

  // ---------- Format ----------
  function fmt(totalSec, forceHours) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return (forceHours || h > 0) ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // ---------- So (generat, sense fitxers) ----------
  let ac = null;
  function unlockAudio() {
    if (!ac) {
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { ac = null; }
    }
    if (ac && ac.state === 'suspended') ac.resume();
  }
  function beep(t0, freq, dur, vol) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.004);
    g.gain.setValueAtTime(vol, t0 + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }
  function play(kind) {
    if (!cfg.sound) return;
    unlockAudio();
    if (!ac) return;
    const v = cfg.alerts.volume * 0.25;
    if (v <= 0) return;
    const t = ac.currentTime + 0.03;
    if (kind === 'warn') {
      // dos tons suaus + un de més agut
      beep(t, 1046, 0.14, v);
      beep(t + 0.22, 1046, 0.14, v);
      beep(t + 0.44, 1568, 0.32, v);
    } else if (kind === 'end') {
      // "bip-bip-bip-bip" estil Casio, dues vegades
      for (let r = 0; r < 2; r++)
        for (let i = 0; i < 4; i++) beep(t + r * 0.85 + i * 0.12, 2093, 0.06, v);
    }
  }

  // ---------- Avisos ----------
  let bannerTimer = 0;
  let alarmTimer = 0;

  function showBanner(text, ms) {
    clearTimeout(bannerTimer);
    el.banner.textContent = text;
    el.banner.hidden = false;
    if (ms) bannerTimer = setTimeout(() => { el.banner.hidden = true; }, ms);
  }
  function flash() {
    body.classList.remove('flash');
    void body.offsetWidth; // reinicia l'animació
    body.classList.add('flash');
  }
  function notify(msg) {
    play('warn');
    if (cfg.alerts.flash) {
      flash();
      showBanner(msg, 12000);
    }
  }
  function startAlarm() {
    stopAlarm();
    body.classList.add('alarm');
    showBanner('Temps esgotat');
    let n = 0;
    play('end');
    alarmTimer = setInterval(() => {
      if (++n >= 6) return stopAlarm(true);
      play('end');
    }, 2200);
  }
  function stopAlarm(keepVisual) {
    clearInterval(alarmTimer);
    alarmTimer = 0;
    if (!keepVisual) {
      body.classList.remove('alarm');
      el.banner.hidden = true;
    }
  }
  const alarmActive = () => body.classList.contains('alarm');
  function dismiss() {
    stopAlarm();
    body.classList.remove('flash');
    el.banner.hidden = true;
  }

  function thresholds() {
    const a = cfg.alerts;
    const list = [];
    if (a.half) list.push({ at: T.duration / 2, msg: 'Ha passat la meitat del temps' });
    for (const [m, k] of [[15, 'm15'], [10, 'm10'], [5, 'm5'], [1, 'm1']])
      if (a[k]) list.push({ at: m * 60000, msg: m === 1 ? 'Queda 1 minut' : `Queden ${m} minuts` });
    const c = Math.round(Number(a.customMin));
    if (a.custom && c > 0) list.push({ at: c * 60000, msg: c === 1 ? 'Queda 1 minut' : `Queden ${c} minuts` });
    return list;
  }

  // ---------- Temporitzador ----------
  const timerRemaining = () => (T.state === 'running' ? T.endAt - Date.now() : T.remaining);

  function setDuration(ms) {
    ms = Math.max(0, Math.min(ms, (23 * 3600 + 59 * 60 + 59) * 1000));
    cfg.duration = ms;
    save();
    if (T.state === 'idle') { T.duration = ms; T.remaining = ms; }
    syncInputs();
    render();
  }
  function syncInputs() {
    const s = Math.round(cfg.duration / 1000);
    el.inH.value = Math.floor(s / 3600);
    el.inM.value = Math.floor((s % 3600) / 60);
    el.inS.value = s % 60;
  }
  function readInputs() {
    const v = (i, max) => Math.max(0, Math.min(max, parseInt(i.value, 10) || 0));
    const ms = (v(el.inH, 23) * 3600 + v(el.inM, 59) * 60 + v(el.inS, 59)) * 1000;
    cfg.duration = ms;
    save();
    T.duration = T.remaining = ms;
    render();
  }

  function timerStart() {
    if (T.state === 'finished') timerReset();
    if (T.remaining <= 0) return;
    unlockAudio();
    keepAwake();
    T.endAt = Date.now() + T.remaining;
    T.lastRem = T.remaining;
    T.state = 'running';
    document.activeElement && document.activeElement.blur();
    render();
  }
  function timerPause() {
    T.remaining = Math.max(0, T.endAt - Date.now());
    T.state = 'paused';
    render();
  }
  function timerToggle() {
    if (T.state === 'running') timerPause();
    else if (T.state === 'finished' && alarmActive()) dismiss();
    else timerStart();
  }
  function timerReset() {
    dismiss();
    T.state = 'idle';
    T.duration = T.remaining = cfg.duration;
    render();
  }
  function timerAdjust(ms) {
    if (T.state === 'idle') return setDuration(cfg.duration + ms);
    const wasFinished = T.state === 'finished';
    if (wasFinished) {
      if (ms <= 0) return;
      dismiss();
      T.remaining = 0;
      T.state = 'paused';
    }
    const rem = timerRemaining();
    const next = Math.max(1000, rem + ms);
    const delta = next - rem;
    T.duration = Math.max(next, T.duration + delta);
    if (T.state === 'running') { T.endAt += delta; T.lastRem = next; }
    else T.remaining = next;
    if (wasFinished) timerStart();
    render();
  }
  function timerFinish() {
    T.state = 'finished';
    T.remaining = 0;
    if (cfg.mode !== 'timer') setMode('timer');
    startAlarm();
  }

  // ---------- Cronòmetre ----------
  const swElapsed = () => (S.state === 'running' ? S.elapsed + Date.now() - S.startAt : S.elapsed);
  function swToggle() {
    if (S.state === 'running') {
      S.elapsed += Date.now() - S.startAt;
      S.state = 'paused';
    } else {
      keepAwake();
      S.startAt = Date.now();
      S.state = 'running';
    }
    render();
  }
  function swReset() {
    S.state = 'idle';
    S.elapsed = 0;
    render();
  }

  // ---------- Pintar ----------
  let lastText = '', lastGhost = '';
  const cells = (t) => [...t].map((c) => (/\d/.test(c) ? `<span class="dg">${c}</span>` : `<span>${c}</span>`)).join('');
  function setText(t) {
    if (t === lastText) return;
    lastText = t;
    el.digits.innerHTML = cells(t);
    const g = t.replace(/\d/g, '8');
    if (g !== lastGhost) {
      lastGhost = g;
      el.ghost.innerHTML = cells(g);
      fit();
    }
  }
  function setSub(t) {
    if (el.sub.textContent !== t) el.sub.textContent = t;
  }

  function render() {
    const now = new Date();
    let text, sub = '';
    let paused = false, lastMinute = false;

    if (cfg.mode === 'clock') {
      text = `${pad(now.getHours())}:${pad(now.getMinutes())}` + (cfg.clockSeconds ? `:${pad(now.getSeconds())}` : '');
      if (cfg.clockDate)
        sub = now.toLocaleDateString('ca', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    } else if (cfg.mode === 'timer') {
      const rem = Math.max(0, timerRemaining());
      const secs = Math.ceil(rem / 1000);
      text = fmt(secs, T.duration >= 3600000);
      if (T.state === 'running') sub = `Acaba a les ${hhmm(new Date(T.endAt))}`;
      else if (T.state === 'paused') { sub = 'En pausa'; paused = true; }
      lastMinute = cfg.alerts.redLast && (T.state === 'running' || T.state === 'paused') && rem <= 60000;
      el.fill.style.width = T.duration > 0 ? `${(rem / T.duration) * 100}%` : '0%';
      el.tStart.textContent = T.state === 'running' ? 'Pausa' : T.state === 'paused' ? 'Continua' : 'Inicia';
    } else {
      text = fmt(Math.floor(swElapsed() / 1000), false);
      if (S.state === 'paused') { sub = 'En pausa'; paused = true; }
      el.sStart.textContent = S.state === 'running' ? 'Pausa' : S.state === 'paused' ? 'Continua' : 'Inicia';
    }

    setText(text);
    setSub(sub);
    body.classList.toggle('paused', paused);
    body.classList.toggle('last-minute', cfg.mode === 'timer' && lastMinute);
    body.classList.toggle('finished', cfg.mode === 'timer' && T.state === 'finished');
    for (const s of ['idle', 'running', 'paused', 'finished']) body.classList.toggle(`t-${s}`, T.state === s);
  }

  function tick() {
    if (T.state === 'running') {
      const rem = T.endAt - Date.now();
      const crossed = thresholds().filter((t) => T.lastRem > t.at && rem <= t.at && rem > 0);
      if (crossed.length) {
        crossed.sort((a, b) => a.at - b.at);
        notify(crossed[0].msg);
      }
      T.lastRem = rem;
      if (rem <= 0) timerFinish();
    }
    render();
  }

  // ---------- Mida de la lletra ----------
  function fit() {
    const cur = parseFloat(getComputedStyle(el.display).fontSize) || 100;
    const w8 = $('#m8').getBoundingClientRect().width;
    if (w8) el.display.style.setProperty('--dw', `${w8 / cur}em`);
    const g = el.ghost.getBoundingClientRect();
    if (!g.width) return;
    const w = g.width / cur, h = g.height / cur;
    const size = Math.min((innerWidth * 0.94) / w, (innerHeight * 0.6) / h) * cfg.scale;
    document.documentElement.style.setProperty('--d', `${Math.max(16, size)}px`);
  }
  function zoom(step) {
    cfg.scale = Math.round(Math.max(0.3, Math.min(1, cfg.scale + step)) * 100) / 100;
    save();
    fit();
  }

  // ---------- Modes ----------
  function setMode(m) {
    cfg.mode = m;
    save();
    body.classList.remove('mode-clock', 'mode-timer', 'mode-stopwatch');
    body.classList.add(`mode-${m}`);
    $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    render();
  }

  // ---------- Pantalla completa / pantalla activa ----------
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
  }
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });

  // ---------- Amagar la interfície quan no s'usa ----------
  let idleTimer = 0;
  function wake() {
    body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(goIdle, 3000);
  }
  function goIdle() {
    const busy = el.dlg.open ||
      document.querySelector('.ui:hover') ||
      (document.activeElement && document.activeElement.matches('input:not([type=checkbox]):not([type=range])'));
    if (busy) { idleTimer = setTimeout(goIdle, 1500); return; }
    body.classList.add('idle');
  }
  ['mousemove', 'mousedown', 'touchstart', 'keydown', 'wheel'].forEach((e) =>
    document.addEventListener(e, wake, { passive: true }));

  // ---------- Esdeveniments ----------
  $$('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#smaller').addEventListener('click', () => zoom(-0.05));
  $('#bigger').addEventListener('click', () => zoom(0.05));
  $('#fsBtn').addEventListener('click', toggleFullscreen);
  el.display.addEventListener('dblclick', toggleFullscreen);
  $('#soundBtn').addEventListener('click', () => {
    cfg.sound = !cfg.sound;
    save();
    body.classList.toggle('muted', !cfg.sound);
    if (cfg.sound) play('warn');
  });

  el.title.value = cfg.title;
  el.title.addEventListener('input', () => { cfg.title = el.title.value; save(); });
  el.title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') el.title.blur(); });

  const optSeconds = $('#optSeconds'), optDate = $('#optDate');
  optSeconds.checked = cfg.clockSeconds;
  optDate.checked = cfg.clockDate;
  optSeconds.addEventListener('change', () => { cfg.clockSeconds = optSeconds.checked; save(); render(); });
  optDate.addEventListener('change', () => { cfg.clockDate = optDate.checked; save(); render(); });

  [el.inH, el.inM, el.inS].forEach((i) => {
    i.addEventListener('input', readInputs);
    i.addEventListener('change', syncInputs);
    i.addEventListener('focus', () => i.select());
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { syncInputs(); timerStart(); } });
  });
  $$('.presets button').forEach((b) => b.addEventListener('click', () => setDuration(+b.dataset.min * 60000)));

  el.tStart.addEventListener('click', timerToggle);
  $('#tReset').addEventListener('click', timerReset);
  $('#tPlus').addEventListener('click', () => timerAdjust(60000));
  $('#tMinus').addEventListener('click', () => timerAdjust(-60000));
  el.sStart.addEventListener('click', swToggle);
  $('#sReset').addEventListener('click', swReset);
  el.banner.addEventListener('click', dismiss);

  // Diàleg d'avisos
  $$('[data-alert]').forEach((c) => {
    c.checked = !!cfg.alerts[c.dataset.alert];
    c.addEventListener('change', () => { cfg.alerts[c.dataset.alert] = c.checked; save(); render(); });
  });
  const customMin = $('#customMin'), volume = $('#volume');
  customMin.value = cfg.alerts.customMin;
  customMin.addEventListener('input', () => { cfg.alerts.customMin = Math.max(1, parseInt(customMin.value, 10) || 1); save(); });
  volume.value = cfg.alerts.volume;
  volume.addEventListener('input', () => { cfg.alerts.volume = +volume.value; save(); });
  volume.addEventListener('change', () => play('warn'));
  $('#tAlerts').addEventListener('click', () => el.dlg.showModal());
  $('#testWarn').addEventListener('click', () => { const s = cfg.sound; cfg.sound = true; play('warn'); cfg.sound = s; });
  $('#testEnd').addEventListener('click', () => { const s = cfg.sound; cfg.sound = true; play('end'); cfg.sound = s; });

  // Teclat
  document.addEventListener('keydown', (e) => {
    if (el.dlg.open || e.ctrlKey || e.altKey || e.metaKey) return;
    const typing = e.target.matches && e.target.matches('input:not([type=checkbox]):not([type=range])');
    if (e.key === 'Escape' && (alarmActive() || !el.banner.hidden)) { dismiss(); return; }
    if (typing) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (alarmActive() || !el.banner.hidden) { dismiss(); break; }
        if (cfg.mode === 'timer') timerToggle();
        else if (cfg.mode === 'stopwatch') swToggle();
        break;
      case 'r': case 'R':
        if (cfg.mode === 'timer') timerReset();
        else if (cfg.mode === 'stopwatch') swReset();
        break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 's': case 'S': $('#soundBtn').click(); break;
      case '+': case '=': zoom(0.05); break;
      case '-': case '_': zoom(-0.05); break;
      case '1': setMode('clock'); break;
      case '2': setMode('timer'); break;
      case '3': setMode('stopwatch'); break;
    }
  });

  // Desbloqueja l'àudio i manté la pantalla encesa al primer clic
  const firstGesture = () => { unlockAudio(); keepAwake(); };
  document.addEventListener('pointerdown', firstGesture, { once: true });
  document.addEventListener('keydown', firstGesture, { once: true });

  window.addEventListener('resize', fit);
  document.addEventListener('fullscreenchange', fit);

  // ---------- Inici ----------
  body.classList.toggle('muted', !cfg.sound);
  syncInputs();
  setMode(cfg.mode);
  fit();
  if (document.fonts) document.fonts.load('100px "clockicons"').then(fit, fit);
  wake();
  setInterval(tick, 100);
})();
