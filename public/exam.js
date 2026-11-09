(() => {
  'use strict';
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const $ = (id) => document.getElementById(id);

  // When embedded by the widget, tell the host page what is happening. The target origin
  // must be on the tenant's allowed_origins list, so nothing leaks to arbitrary parents.
  const parentOrigin = new URLSearchParams(location.search).get('origin');
  let notifyOrigin = null;
  function notify(type, data) {
    if (window.parent === window || !notifyOrigin) return;
    try { window.parent.postMessage({ source: 'proctor-service', type, ...data }, notifyOrigin); } catch { /* ignore */ }
  }
  const FLAG_EVENTS = new Set(['tab_hidden', 'window_blur', 'fullscreen_exit', 'copy_attempt', 'paste_attempt', 'camera_lost', 'no_face', 'multiple_faces']);

  // ------------------------------------------------------------- helpers
  const screens = ['loading', 'error', 'intro', 'exam', 'done'];
  const show = (name) => screens.forEach((s) => $('screen-' + s).classList.toggle('hidden', s !== name));

  async function api(path, body) {
    const opts = { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(`/api/exam/${encodeURIComponent(token)}${path}`, opts);
    let data = {};
    try { data = await r.json(); } catch { /* non-JSON */ }
    if (!r.ok) {
      const e = new Error(data.error || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  }

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) n.append(kid);
    return n;
  }

  function showError(msg) {
    $('error-msg').textContent = msg;
    show('error');
  }

  // --------------------------------------------------------------- state
  let info = null, settings = null;
  let questions = [], answers = {}, current = 0;
  let endAt = 0; // performance.now() timestamp when time runs out
  let active = false, submitting = false;
  let stream = null, camOk = false;
  const pending = {}; // unsaved answers
  let saveTimer = null, eventQueue = [], snapTimer = null, overlayLock = null;
  let faceDetector = null;
  try { if ('FaceDetector' in window) faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 3 }); } catch { /* unsupported */ }

  // ------------------------------------------------------------- overlay
  function showOverlay({ title, msg, btn, onClick, btn2, onClick2 }) {
    $('overlay-title').textContent = title;
    $('overlay-msg').textContent = msg;
    const b = $('overlay-btn');
    b.textContent = btn;
    b.onclick = onClick;
    const b2 = $('overlay-btn2');
    b2.classList.toggle('hidden', !btn2);
    if (btn2) { b2.textContent = btn2; b2.onclick = onClick2; }
    $('overlay').classList.remove('hidden');
  }
  const hideOverlay = () => { $('overlay').classList.add('hidden'); overlayLock = null; };

  // ---------------------------------------------------------- init/intro
  async function init() {
    try {
      info = await api('/info');
    } catch (e) {
      return showError(e.status === 404 ? 'This exam link is not valid.' : e.message);
    }
    settings = info.settings;
    if (parentOrigin && Array.isArray(info.allowed_origins) && info.allowed_origins.includes(parentOrigin)) notifyOrigin = parentOrigin;
    notify('ready', { status: info.status });
    if (info.status === 'submitted') return showDone(info);
    renderIntro();
  }

  function renderIntro() {
    $('intro-title').textContent = info.title;
    $('intro-meta').textContent =
      `${info.candidate_name ? info.candidate_name + ' · ' : ''}${info.duration_min} minutes · ${info.question_count} questions`;
    $('intro-instructions').textContent = info.instructions || '';
    const rules = $('intro-rules');
    rules.replaceChildren();
    const add = (t) => rules.append(el('li', {}, t));
    add('The timer runs on our server. Closing this page does not pause it.');
    if (settings.require_fullscreen) add('The exam runs in fullscreen. Leaving fullscreen or switching tabs/windows is recorded.');
    if (settings.require_camera) add('Your camera must stay on. Periodic snapshots are captured. Be alone, in good light, face visible.');
    if (settings.block_clipboard) add('Copy, paste and right-click are disabled.');
    add('Answers are saved automatically. If you get disconnected, reopen this link to resume.');
    $('cam-block').classList.toggle('hidden', !settings.require_camera);
    $('btn-start').textContent = info.status === 'in_progress' ? 'Resume exam' : 'Start exam';
    $('btn-camera').onclick = enableCamera;
    $('consent').onchange = updateStart;
    $('btn-start').onclick = onStart;
    updateStart();
    show('intro');
  }

  function updateStart() {
    $('btn-start').disabled = !($('consent').checked && (!settings.require_camera || camOk));
  }

  async function enableCamera() {
    $('cam-status').textContent = 'Requesting camera…';
    try {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
      const cam = $('cam');
      cam.srcObject = stream;
      cam.classList.remove('hidden');
      stream.getVideoTracks()[0].addEventListener('ended', onCameraLost);
      camOk = true;
      $('cam-status').textContent = 'Camera ready ✓ (check your face is visible in the preview)';
      if (active) queueEvent('camera_ok');
    } catch (e) {
      camOk = false;
      $('cam-status').textContent = 'Camera unavailable: allow camera access in your browser settings, then try again.';
      queueEvent('camera_denied', e.name || '');
    }
    updateStart();
  }

  async function enterFullscreen() {
    const de = document.documentElement;
    if (!de.requestFullscreen) throw new Error('This browser does not support fullscreen. Please use desktop Chrome, Edge or Firefox.');
    await de.requestFullscreen();
  }

  async function onStart() {
    const btn = $('btn-start');
    const err = $('intro-error');
    err.classList.add('hidden');
    btn.disabled = true;
    try {
      if (settings.require_fullscreen) await enterFullscreen();
      const data = await api('/start', { consent: true });
      begin(data);
    } catch (e) {
      err.textContent = e.status === 409 ? 'This exam has already been submitted.' : (e.message || 'Could not start the exam.');
      err.classList.remove('hidden');
      updateStart();
    }
  }

  // ---------------------------------------------------------------- exam
  function begin(data) {
    questions = data.questions;
    answers = data.answers || {};
    endAt = performance.now() + data.remaining_ms;
    current = 0;
    active = true;
    notify('started', { resumed: !!data.resumed });
    $('exam-title').textContent = info.title;
    renderNav();
    showQuestion(0);
    show('exam');
    setInterval(tick, 250);
    setInterval(heartbeat, 15000);
    setInterval(flushEvents, 4000);
    setInterval(retrySaves, 5000);
    setTimeout(takeSnapshot, 1500);
    scheduleSnapshot();
    bindProctoring();
    $('btn-prev').onclick = () => showQuestion(current - 1);
    $('btn-next').onclick = () => showQuestion(current + 1);
    $('btn-submit').onclick = confirmSubmit;
  }

  function renderNav() {
    const nav = $('nav');
    nav.replaceChildren();
    questions.forEach((q, i) => {
      const cls = [answers[q.id] !== undefined && answers[q.id] !== '' ? 'answered' : '', i === current ? 'current' : ''].join(' ').trim();
      nav.append(el('button', { class: cls, title: 'Question ' + (i + 1), onclick: () => showQuestion(i) }, String(i + 1)));
    });
  }

  function showQuestion(i) {
    if (i < 0 || i >= questions.length) return;
    current = i;
    const q = questions[i];
    const card = $('question-card');
    card.replaceChildren(
      el('p', { class: 'muted' }, `Question ${i + 1} of ${questions.length} · ${q.points} point${q.points === 1 ? '' : 's'}`),
      el('p', { class: 'prompt' }, q.prompt),
    );
    if (q.type === 'mcq') {
      for (const o of q.options) {
        const input = el('input', { type: 'radio', name: 'opt', value: String(o.i) });
        if (answers[q.id] === o.i) input.checked = true;
        input.addEventListener('change', () => setAnswer(q.id, o.i));
        card.append(el('label', { class: 'opt' }, input, el('span', {}, o.text)));
      }
    } else if (q.type === 'short') {
      const input = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
      input.value = answers[q.id] || '';
      input.addEventListener('input', () => setAnswer(q.id, input.value, true));
      card.append(input);
    } else {
      const ta = el('textarea', { class: q.type === 'code' ? 'code' : '', spellcheck: q.type === 'code' ? 'false' : 'true' });
      ta.value = answers[q.id] || '';
      ta.addEventListener('input', () => setAnswer(q.id, ta.value, true));
      if (q.type === 'code') ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const s = ta.selectionStart;
          ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
          ta.selectionStart = ta.selectionEnd = s + 2;
          setAnswer(q.id, ta.value, true);
        }
      });
      card.append(ta);
    }
    $('btn-prev').disabled = i === 0;
    $('btn-next').disabled = i === questions.length - 1;
    renderNav();
  }

  // ------------------------------------------------------------ autosave
  function setSaveState(t) { $('savestate').textContent = t; }

  function setAnswer(qid, value, debounce) {
    answers[qid] = value;
    pending[qid] = value;
    setSaveState('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushAnswers, debounce ? 700 : 0);
    renderNavSoft();
  }
  let navTimer = null;
  function renderNavSoft() { clearTimeout(navTimer); navTimer = setTimeout(renderNav, 200); }

  let flushing = false;
  async function flushAnswers() {
    if (flushing) return;
    flushing = true;
    try {
      for (const qid of Object.keys(pending)) {
        const value = pending[qid];
        try {
          await api('/answer', { question_id: qid, value });
          if (pending[qid] === value) delete pending[qid];
        } catch (e) {
          if (e.status === 409) { timeUp(); return; }
          setSaveState('Offline — will retry');
          return;
        }
      }
      if (!Object.keys(pending).length) setSaveState('All answers saved');
    } finally { flushing = false; }
  }
  const retrySaves = () => { if (Object.keys(pending).length) flushAnswers(); };

  // --------------------------------------------------------------- timer
  function tick() {
    if (!active) return;
    const ms = Math.max(0, endAt - performance.now());
    const s = Math.ceil(ms / 1000);
    const t = $('timer');
    t.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    t.classList.toggle('low', s <= 60);
    if (ms <= 0 && !submitting) doSubmit(true);
  }

  async function heartbeat() {
    if (!active) return;
    try {
      const r = await api('/heartbeat', {});
      if (r.status !== 'in_progress') return timeUp();
      endAt = performance.now() + r.remaining_ms; // re-sync with the server clock
    } catch (e) { if (e.status === 409) timeUp(); }
  }

  // ------------------------------------------------------------ proctoring
  function queueEvent(type, detail = '') {
    eventQueue.push({ type, detail, ts: Date.now() });
    if (eventQueue.length > 500) eventQueue.shift();
    if (active && FLAG_EVENTS.has(type)) notify('flag', { event: type });
  }

  async function flushEvents() {
    if (!active || !eventQueue.length) return;
    const batch = eventQueue.splice(0, 50);
    try { await api('/events', { events: batch }); }
    catch (e) { if (e.status !== 409) eventQueue.unshift(...batch); }
  }

  function bindProctoring() {
    document.addEventListener('visibilitychange', () => {
      if (!active) return;
      queueEvent(document.hidden ? 'tab_hidden' : 'tab_visible');
      if (document.hidden) flushEvents();
    });
    window.addEventListener('blur', () => { if (active && !document.hidden) queueEvent('window_blur'); });
    window.addEventListener('focus', () => { if (active) queueEvent('window_focus'); });

    document.addEventListener('fullscreenchange', () => {
      if (!active || !settings.require_fullscreen) return;
      if (!document.fullscreenElement) {
        queueEvent('fullscreen_exit');
        flushEvents();
        if (!overlayLock) {
          overlayLock = 'fs';
          showOverlay({
            title: 'Fullscreen required',
            msg: 'You left fullscreen. This has been recorded. The timer is still running.',
            btn: 'Return to fullscreen',
            onClick: async () => { try { await enterFullscreen(); hideOverlay(); queueEvent('fullscreen_enter'); } catch { /* retry */ } },
          });
        }
      } else if (overlayLock === 'fs') hideOverlay();
    });

    const block = (type) => (e) => {
      if (!active || !settings.block_clipboard) return;
      e.preventDefault();
      queueEvent(type);
    };
    document.addEventListener('copy', block('copy_attempt'));
    document.addEventListener('cut', block('cut_attempt'));
    document.addEventListener('paste', block('paste_attempt'));
    document.addEventListener('contextmenu', block('contextmenu_attempt'));
    window.addEventListener('beforeprint', () => { if (active) queueEvent('print_attempt'); });

    document.addEventListener('keydown', (e) => {
      if (!active) return;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const combo = e.key === 'F12' || (ctrl && e.shiftKey && ['i', 'j', 'c'].includes(k)) ||
        (ctrl && ['u', 'p', 's'].includes(k)) || (e.altKey && e.key === 'Tab');
      if (combo) {
        e.preventDefault();
        queueEvent('key_shortcut', (ctrl ? 'ctrl+' : '') + (e.shiftKey ? 'shift+' : '') + (e.altKey ? 'alt+' : '') + e.key);
      }
    });

    window.addEventListener('beforeunload', (e) => { if (active && !submitting) { e.preventDefault(); e.returnValue = ''; } });
  }

  function onCameraLost() {
    if (!active) { camOk = false; updateStart(); return; }
    camOk = false;
    queueEvent('camera_lost');
    flushEvents();
    if (!settings.require_camera) return;
    overlayLock = 'cam';
    showOverlay({
      title: 'Camera disconnected',
      msg: 'Your camera stopped. Re-enable it to continue. This has been recorded.',
      btn: 'Re-enable camera',
      onClick: async () => { await enableCamera(); if (camOk) hideOverlay(); },
    });
  }

  async function takeSnapshot() {
    if (!active || !stream) return;
    const cam = $('cam');
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live' || !cam.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = Math.round((320 * cam.videoHeight) / cam.videoWidth);
    canvas.getContext('2d').drawImage(cam, 0, 0, canvas.width, canvas.height);
    let faces = null;
    if (faceDetector) {
      try { faces = (await faceDetector.detect(cam)).length; } catch { faces = null; }
    }
    if (faces === 0) queueEvent('no_face');
    else if (faces > 1) queueEvent('multiple_faces', String(faces));
    try { await api('/snapshot', { image: canvas.toDataURL('image/jpeg', 0.6), faces }); } catch { /* next one will try again */ }
  }

  function scheduleSnapshot() {
    const delay = settings.snapshot_interval_sec * 1000 * (0.8 + Math.random() * 0.4); // jitter so timing can't be gamed
    snapTimer = setTimeout(async () => { await takeSnapshot(); if (active) scheduleSnapshot(); }, delay);
  }

  // -------------------------------------------------------------- submit
  function confirmSubmit() {
    const unanswered = questions.filter((q) => answers[q.id] === undefined || answers[q.id] === '').length;
    showOverlay({
      title: 'Submit exam?',
      msg: unanswered ? `You have ${unanswered} unanswered question${unanswered === 1 ? '' : 's'}. You cannot change answers after submitting.` : 'You cannot change answers after submitting.',
      btn: 'Submit now', onClick: () => { hideOverlay(); doSubmit(false); },
      btn2: 'Keep working', onClick2: hideOverlay,
    });
  }

  async function doSubmit(auto) {
    if (submitting) return;
    submitting = true;
    hideOverlay();
    setSaveState(auto ? 'Time is up — submitting…' : 'Submitting…');
    clearTimeout(saveTimer);
    for (let i = 0; i < 3 && Object.keys(pending).length; i++) { flushing = false; await flushAnswers(); }
    await flushEvents();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await api('/submit', {});
        return finish(res);
      } catch (e) {
        if (attempt === 4) {
          submitting = false;
          return showOverlay({ title: 'Could not submit', msg: 'Check your connection and try again. Your saved answers are safe.', btn: 'Retry', onClick: () => { hideOverlay(); doSubmit(auto); } });
        }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }

  function timeUp() {
    if (!active || submitting) return;
    submitting = true;
    api('/info').then(showDone).catch(() => showDone({ status: 'submitted' }));
    cleanup();
  }

  function finish(res) { cleanup(); showDone(res); }

  function cleanup() {
    active = false;
    clearTimeout(snapTimer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    $('cam').classList.add('hidden');
    hideOverlay();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function showDone(res) {
    cleanup();
    notify('submitted', { result: res.result || null });
    $('done-msg').textContent = 'Your answers have been recorded. You can close this window.';
    const r = res.result;
    const out = $('done-result');
    if (r) {
      out.textContent = `Score: ${r.score} / ${r.max_score}${r.percent !== null ? ` (${r.percent}%)` : ''}` +
        (r.pending_manual ? ' — some answers still need manual grading.' : '');
      out.classList.remove('hidden');
    }
    if (res.return_url) {
      const a = $('done-link');
      a.href = res.return_url;
      a.classList.remove('hidden');
    }
    show('done');
  }

  init();
})();
