(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // Two modes share this page:
  //   /admin          -> sign in with the tenant API key (full access)
  //   /builder/<tok>  -> short-lived builder token, scoped to one owner (embeddable in a host site)
  const BUILDER = location.pathname.startsWith('/builder/');
  const parentOrigin = new URLSearchParams(location.search).get('origin');
  let KEY = null;
  let ME = null;
  if (BUILDER) KEY = decodeURIComponent(location.pathname.split('/')[2] || '');
  else { try { KEY = sessionStorage.getItem('proctor_key'); } catch { /* storage unavailable */ } }

  // Build DOM safely (all user-supplied text goes through textContent).
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
    return n;
  }
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
  const badge = (text, cls) => h('span', { class: 'badge ' + (cls || text) }, text);
  const msg = (text, kind) => h('div', { class: 'msg ' + (kind || '') }, text);

  async function request(path, opts = {}) {
    const r = await fetch('/api/v1' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return r;
  }
  async function api(path, opts) {
    const r = await request(path, opts);
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    if (!r.ok) {
      if (r.status === 401 && !BUILDER) logout();
      throw new Error(r.status === 401 && BUILDER ? 'This builder link has expired. Reload the page that opened it.' : data.error || 'HTTP ' + r.status);
    }
    return data;
  }

  function notifyParent(type, data) {
    if (window.parent === window || !parentOrigin || !ME || !(ME.allowed_origins || []).includes(parentOrigin)) return;
    window.parent.postMessage({ source: 'proctor-service', type, ...data }, parentOrigin);
  }

  // --------------------------------------------------------------- login
  async function login(key) {
    KEY = key;
    try {
      ME = await api('/me');
      if (!BUILDER) { try { sessionStorage.setItem('proctor_key', key); } catch { /* ignore */ } }
      $('tenant-name').textContent = BUILDER ? 'Tests & results' : ME.name;
      $('login').classList.add('hidden');
      $('app').classList.remove('hidden');
      if (BUILDER) {
        $('btn-logout').classList.add('hidden');
        for (const b of $('tabs').querySelectorAll('[data-full]')) b.classList.add('hidden');
        selectTab('tests');
      } else loadAttempts();
      notifyParent('ready', { scope: ME.scope });
      return true;
    } catch (e) {
      KEY = null;
      $('login-error').textContent = e.message;
      $('login-error').classList.remove('hidden');
      $('login').classList.remove('hidden');
      return false;
    }
  }
  function logout() {
    KEY = null;
    try { sessionStorage.removeItem('proctor_key'); } catch { /* ignore */ }
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  }
  $('btn-login').onclick = () => login($('key').value.trim());
  $('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') login($('key').value.trim()); });
  $('btn-logout').onclick = logout;

  // ---------------------------------------------------------------- tabs
  const loaders = { attempts: loadAttempts, tests: loadTests, invites: loadInvites, settings: loadSettings, audit: loadAudit };
  function selectTab(tab) {
    for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.tab === tab);
    for (const t of Object.keys(loaders)) $('tab-' + t).classList.toggle('hidden', t !== tab);
    $('detail').replaceChildren();
    loaders[tab]();
  }
  $('tabs').addEventListener('click', (e) => { if (e.target.dataset && e.target.dataset.tab) selectTab(e.target.dataset.tab); });

  // ------------------------------------------------------------ attempts
  async function loadAttempts() {
    const box = $('tab-attempts');
    box.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const { attempts } = await api('/attempts?limit=200');
      const filter = h('select', { id: 'filter-risk' },
        h('option', { value: '' }, 'All risk levels'), h('option', { value: 'high' }, 'High risk'),
        h('option', { value: 'medium' }, 'Medium risk'), h('option', { value: 'low' }, 'Low risk'));
      const tbody = h('tbody');
      const render = () => {
        tbody.replaceChildren();
        for (const a of attempts.filter((x) => !filter.value || x.risk_level === filter.value)) {
          tbody.append(h('tr', { class: 'clickable', onclick: () => showDetail(a.id) },
            h('td', {}, a.candidate_name || a.candidate_ref || '(anonymous)', h('div', { class: 'muted' }, a.candidate_email || '')),
            h('td', {}, a.test_title || a.test_id),
            h('td', {}, badge(a.status)),
            h('td', {}, a.status === 'submitted' ? `${a.score}/${a.max_score}${a.pending_manual ? ' *' : ''}` : '—'),
            h('td', {}, badge(`${a.risk_level} (${a.risk_score})`, a.risk_level)),
            h('td', {}, a.review_decision ? badge(a.review_decision) : '—'),
            h('td', {}, fmt(a.started_at))));
        }
        if (!tbody.children.length) tbody.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No attempts yet.')));
      };
      filter.onchange = render;
      render();
      box.replaceChildren(
        h('div', { class: 'row spread', style: 'margin:12px 0' }, filter, h('button', { class: 'btn small', onclick: loadAttempts }, 'Refresh')),
        h('div', { class: 'card', style: 'padding:0;overflow:auto' },
          h('table', {}, h('thead', {}, h('tr', {}, ...['Candidate', 'Test', 'Status', 'Score', 'Risk', 'Review', 'Started'].map((t) => h('th', {}, t)))), tbody)),
        h('p', { class: 'muted' }, '* = some answers still need manual grading'));
    } catch (e) { box.replaceChildren(msg(e.message, 'err')); }
  }

  // Snapshots need the Authorization header, so fetch them as blobs (keeps keys out of URLs/logs).
  async function loadSnapshots(attemptId, snaps, grid) {
    let i = 0;
    const worker = async () => {
      while (i < snaps.length) {
        const s = snaps[i++];
        const fig = grid.children[snaps.indexOf(s)];
        try {
          const r = await request(`/attempts/${encodeURIComponent(attemptId)}/snapshots/${encodeURIComponent(s.file)}`);
          if (!r.ok) throw new Error();
          fig.querySelector('img').src = URL.createObjectURL(await r.blob());
        } catch { fig.querySelector('img').alt = 'unavailable'; }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  async function showDetail(id) {
    const box = $('detail');
    box.replaceChildren(h('p', { class: 'muted' }, 'Loading attempt…'));
    box.scrollIntoView({ behavior: 'smooth' });
    const reload = () => { showDetail(id); if (!$('tab-attempts').classList.contains('hidden')) loadAttempts(); };
    try {
      const a = await api('/attempts/' + encodeURIComponent(id));
      const counts = Object.entries(a.risk.counts).filter(([t]) => t !== 'started')
        .map(([t, n]) => `${t.replace(/_/g, ' ')}: ${n}`).join(' · ');
      const decide = async (decision) => {
        await api(`/attempts/${encodeURIComponent(id)}/review`, { body: { decision, note: $('review-note').value } });
        reload();
      };

      const questions = a.questions.map((q, i) => {
        const g = q.grading;
        let resp;
        if (q.type === 'mcq') resp = q.response === undefined ? '(no answer)' : `${q.options[q.response]}  ${q.response === q.answer ? '✓' : '✗ (correct: ' + q.options[q.answer] + ')'}`;
        else resp = q.response === undefined || q.response === '' ? '(no answer)' : q.response;
        const needsGrade = g && !g.auto;
        const input = needsGrade ? h('input', { type: 'number', min: '0', max: String(g.max), step: '0.5', value: g.points ?? '', style: 'width:90px' }) : null;
        return h('div', { style: 'margin:14px 0' },
          h('strong', {}, `${i + 1}. `), h('span', { class: 'prompt' }, q.prompt),
          h('pre', { class: q.type === 'code' ? 'mono' : '' }, String(resp)),
          g && h('div', { class: 'row' },
            needsGrade ? [input, h('span', { class: 'muted' }, `/ ${g.max}`),
              h('button', { class: 'btn small', onclick: async () => {
                await api(`/attempts/${encodeURIComponent(id)}/grade`, { body: { question_id: q.id, points: Number(input.value) } });
                reload();
              } }, 'Save grade')] : h('span', { class: 'muted' }, `${g.points}/${g.max} points (auto)`)));
      });

      const events = a.events.map((e) => h('div', {}, h('span', { class: 'muted' }, new Date(e.ts).toLocaleTimeString() + '  '),
        h('strong', {}, e.type.replace(/_/g, ' ')), e.detail ? '  ' + e.detail : ''));
      const grid = h('div', { class: 'grid' }, a.snapshots.map((s) => h('figure', {},
        h('img', { alt: 'loading…' }), new Date(s.ts).toLocaleTimeString() + (s.faces !== null ? ` · faces: ${s.faces}` : ''))));

      const tools = h('div', { class: 'row', style: 'margin:8px 0' },
        a.status === 'in_progress' && h('button', { class: 'btn small', onclick: async () => {
          const m = Number(prompt('Add how many minutes? (1-120)', '10'));
          if (m) { try { await api(`/attempts/${encodeURIComponent(id)}/extend`, { body: { minutes: m } }); reload(); } catch (e) { alert(e.message); } }
        } }, 'Extend time'),
        h('button', { class: 'btn small', onclick: async () => {
          try { await api(`/attempts/${encodeURIComponent(id)}/webhook/resend`, { body: {} }); alert('Webhook queued.'); } catch (e) { alert(e.message); }
        } }, 'Resend webhook'),
        h('button', { class: 'btn small danger', onclick: async () => {
          if (!confirm('Permanently erase this attempt, its answers, events and snapshots? This cannot be undone.')) return;
          await api(`/attempts/${encodeURIComponent(id)}`, { method: 'DELETE' });
          box.replaceChildren(msg('Attempt erased.', 'ok'));
          if (!$('tab-attempts').classList.contains('hidden')) loadAttempts();
        } }, 'Erase data'));

      box.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'row spread' }, h('h2', {}, a.candidate_name || a.candidate_ref || id),
          h('button', { class: 'btn small', onclick: () => box.replaceChildren() }, 'Close')),
        h('p', { class: 'muted' }, `${a.candidate_email || ''} · ${a.test_title} · started ${fmt(a.started_at)} · submitted ${fmt(a.submitted_at)}`),
        h('p', {}, badge(a.status), ' ', badge(`risk ${a.risk_level} (${a.risk_score})`, a.risk_level), ' ',
          a.status === 'submitted' ? `Score ${a.score}/${a.max_score}${a.pending_manual ? ' (manual grading pending)' : ''}` : '', ' ',
          a.webhook_status ? h('span', { class: 'muted' }, 'webhook: ' + a.webhook_status) : ''),
        h('p', { class: 'muted' }, counts || 'No proctoring flags recorded.'),
        tools,
        h('h2', {}, 'Review decision'),
        h('textarea', { id: 'review-note', style: 'min-height:60px', placeholder: 'Reviewer note (optional)' }, a.review_note || ''),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'btn', onclick: () => decide('approved') }, 'Approve'),
          h('button', { class: 'btn danger', onclick: () => decide('rejected') }, 'Reject'),
          h('button', { class: 'btn danger', onclick: () => decide('invalidated') }, 'Invalidate'),
          h('button', { class: 'btn', onclick: () => decide(null) }, 'Clear'),
          a.review_decision && badge(a.review_decision)),
        h('h2', { style: 'margin-top:20px' }, `Snapshots (${a.snapshots.length})`),
        a.snapshots.length ? grid : h('p', { class: 'muted' }, 'None captured.'),
        h('h2', { style: 'margin-top:20px' }, `Event timeline (${events.length})`),
        h('div', { class: 'timeline' }, events),
        h('h2', { style: 'margin-top:20px' }, 'Answers'), questions));
      if (a.snapshots.length) loadSnapshots(id, a.snapshots, grid);
    } catch (e) { box.replaceChildren(msg(e.message, 'err')); }
  }

  // ---------------------------------------------------------------- tests
  const newQ = (type) => ({ type, prompt: '', points: 1, options: ['', '', '', ''], answer: 0, accepted: '' });

  function testEditor(initial, onCreated) {
    const st = initial || {
      title: '', instructions: '', duration_min: 30, pick: '',
      settings: { snapshot_interval_sec: 20, require_camera: true, require_fullscreen: true, block_clipboard: true, shuffle_questions: true, show_result: false },
      questions: [newQ('mcq')],
    };
    const out = h('div');
    const qBox = h('div');

    const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
    const bind = (input, obj, key, num) => { input.addEventListener('input', () => { obj[key] = num ? input.value : input.value; }); return input; };
    const check = (label, key) => {
      const c = h('input', { type: 'checkbox', checked: !!st.settings[key] });
      c.addEventListener('change', () => { st.settings[key] = c.checked; });
      return h('label', {}, c, ' ' + label);
    };

    function renderQuestions() {
      qBox.replaceChildren(...st.questions.map((q, qi) => {
        const typeSel = h('select', {}, ['mcq', 'short', 'text', 'code'].map((t) => h('option', { value: t, selected: t === q.type }, { mcq: 'Multiple choice', short: 'Short answer (auto-graded)', text: 'Essay (manual grading)', code: 'Code (manual grading)' }[t])));
        typeSel.addEventListener('change', () => { q.type = typeSel.value; renderQuestions(); });
        const prompt = bind(h('textarea', { style: 'min-height:70px' }, q.prompt), q, 'prompt');
        const points = bind(h('input', { type: 'number', min: '0', step: '0.5', value: String(q.points), style: 'width:100px' }), q, 'points');
        let body = null;
        if (q.type === 'mcq') {
          body = h('div', {}, q.options.map((o, oi) => h('div', { class: 'row', style: 'margin:4px 0' },
            h('input', { type: 'radio', name: 'correct' + qi, checked: q.answer === oi, style: 'width:auto', title: 'Correct answer', onchange: () => { q.answer = oi; } }),
            bind(h('input', { type: 'text', value: o, placeholder: 'Option ' + (oi + 1) }), q.options, oi),
            h('button', { class: 'btn small', disabled: q.options.length <= 2, onclick: () => { q.options.splice(oi, 1); if (q.answer >= q.options.length) q.answer = 0; renderQuestions(); } }, '✕'))),
            h('button', { class: 'btn small', disabled: q.options.length >= 10, onclick: () => { q.options.push(''); renderQuestions(); } }, 'Add option'));
        } else if (q.type === 'short') {
          body = field('Accepted answers (one per line, case-insensitive)', bind(h('textarea', { style: 'min-height:70px' }, q.accepted), q, 'accepted'));
        }
        return h('div', { class: 'qedit' },
          h('div', { class: 'row spread' }, h('strong', {}, 'Question ' + (qi + 1)),
            h('button', { class: 'btn small danger', disabled: st.questions.length <= 1, onclick: () => { st.questions.splice(qi, 1); renderQuestions(); } }, 'Remove')),
          h('div', { class: 'field-row' }, field('Type', typeSel), field('Points', points)),
          field('Question', prompt), body);
      }));
    }
    renderQuestions();

    const title = bind(h('input', { type: 'text', value: st.title, maxlength: '300' }), st, 'title');
    const dur = bind(h('input', { type: 'number', min: '1', max: '600', value: String(st.duration_min) }), st, 'duration_min');
    const pick = bind(h('input', { type: 'number', min: '1', value: st.pick === null ? '' : String(st.pick), placeholder: 'all' }), st, 'pick');
    const interval = h('input', { type: 'number', min: '5', max: '120', value: String(st.settings.snapshot_interval_sec) });
    interval.addEventListener('input', () => { st.settings.snapshot_interval_sec = Number(interval.value); });
    const instr = bind(h('textarea', { style: 'min-height:70px' }, st.instructions || ''), st, 'instructions');

    function payload() {
      return {
        title: st.title, instructions: st.instructions, duration_min: Number(st.duration_min),
        pick: st.pick === '' || st.pick === null ? null : Number(st.pick), settings: st.settings,
        questions: st.questions.map((q, i) => {
          const o = { id: 'q' + (i + 1), type: q.type, prompt: q.prompt, points: Number(q.points) };
          if (q.type === 'mcq') { o.options = q.options; o.answer = q.answer; }
          if (q.type === 'short') o.accepted = String(q.accepted).split('\n').map((s) => s.trim()).filter(Boolean);
          return o;
        }),
      };
    }

    const root = h('div', { class: 'card' },
      h('h2', {}, initial ? 'New test (copied — tests cannot be edited once created)' : 'Create test'),
      h('div', { class: 'field-row' }, field('Title', title), field('Duration (minutes)', dur), field('Random questions per candidate (optional)', pick)),
      field('Instructions shown to candidates', instr),
      h('div', { class: 'checks', style: 'margin:8px 0' }, check('Require camera', 'require_camera'), check('Require fullscreen', 'require_fullscreen'),
        check('Block copy/paste', 'block_clipboard'), check('Shuffle questions', 'shuffle_questions'), check('Show score to candidate', 'show_result')),
      field('Snapshot every (seconds)', interval),
      h('h2', { style: 'margin-top:16px' }, 'Questions'), qBox,
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { st.questions.push(newQ('mcq')); renderQuestions(); } }, '+ Add question'),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const r = await api('/tests', { body: payload() });
            out.replaceChildren(msg(`Created ${r.test_id} (${r.question_count} questions)`, 'ok'));
            notifyParent('test.created', { test_id: r.test_id, owner_ref: r.owner_ref });
            onCreated(r);
          } catch (e) { out.replaceChildren(msg(e.message, 'err')); }
        } }, 'Create test')),
      out);
    return root;
  }

  async function loadTests() {
    const box = $('tab-tests');
    box.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const { tests } = await api('/tests');
      const editorBox = h('div');
      const openEditor = (initial) => { editorBox.replaceChildren(testEditor(initial, () => setTimeout(loadTests, 600))); };
      const rows = tests.length ? tests.map((t) => h('tr', {},
        h('td', {}, t.title), h('td', { class: 'mono' }, t.id),
        h('td', {}, t.duration_min + ' min'), h('td', {}, String(t.question_count) + (t.pick ? ` (random ${t.pick})` : '')),
        h('td', {}, t.owner_ref || '—'),
        h('td', { class: 'row' },
          h('button', { class: 'btn small', onclick: async () => {
            const full = await api('/tests/' + encodeURIComponent(t.id));
            openEditor({
              title: full.title + ' (copy)', instructions: full.instructions || '', duration_min: full.duration_min, pick: full.pick,
              settings: { ...full.settings },
              questions: full.questions.map((q) => ({ type: q.type, prompt: q.prompt, points: q.points, options: q.options ? [...q.options] : ['', '', '', ''], answer: q.answer || 0, accepted: (q.accepted || []).join('\n') })),
            });
            editorBox.scrollIntoView({ behavior: 'smooth' });
          } }, 'Duplicate'),
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!confirm(`Archive "${t.title}"? It can no longer be used for new invites (existing results are kept).`)) return;
            await api('/tests/' + encodeURIComponent(t.id), { method: 'DELETE' });
            loadTests();
          } }, 'Archive'))))
        : [h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No tests yet.'))];
      box.replaceChildren(
        h('div', { class: 'card', style: 'padding:0;overflow:auto' }, h('table', {},
          h('thead', {}, h('tr', {}, ...['Title', 'ID', 'Duration', 'Questions', 'Owner', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows))),
        h('button', { class: 'btn primary', onclick: () => openEditor(null) }, '+ New test'), editorBox);
      if (!tests.length) openEditor(null);
    } catch (e) { box.replaceChildren(msg(e.message, 'err')); }
  }

  // -------------------------------------------------------------- invites
  async function loadInvites() {
    const box = $('tab-invites');
    box.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const { tests } = await api('/tests');
      const sel = h('select', {}, tests.map((t) => h('option', { value: t.id }, `${t.title} (${t.id})`)));
      const f = (label, id, type = 'text', ph = '') => h('label', { class: 'field' }, h('span', {}, label), h('input', { type, id, placeholder: ph }));
      const out = h('div');
      const tableBox = h('div');
      const loadTable = async () => {
        const { sessions } = await api('/sessions');
        tableBox.replaceChildren(h('div', { class: 'card', style: 'padding:0;overflow:auto' }, h('table', {},
          h('thead', {}, h('tr', {}, ...['Candidate', 'Test', 'Status', 'Created', 'Expires', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, sessions.map((s) => h('tr', s.attempt_id ? { class: 'clickable', onclick: () => showDetail(s.attempt_id) } : {},
            h('td', {}, s.candidate_name || s.candidate_ref || s.id, h('div', { class: 'muted' }, s.candidate_email || '')),
            h('td', {}, s.test_id), h('td', {}, badge(s.status)), h('td', {}, fmt(s.created_at)), h('td', {}, fmt(s.expires_at)),
            h('td', {}, s.status === 'not_started' && h('button', { class: 'btn small danger', onclick: async (e) => {
              e.stopPropagation();
              await api(`/sessions/${encodeURIComponent(s.id)}/revoke`, { body: {} });
              loadTable();
            } }, 'Revoke'))))))));
      };
      const form = h('div', { class: 'card' }, h('h2', {}, 'Create invite link'),
        h('label', { class: 'field' }, h('span', {}, 'Test'), sel),
        f('Candidate name', 'inv-name'), f('Candidate email', 'inv-email', 'email'),
        f('Your reference (user/application id)', 'inv-ref'), f('Return URL (optional)', 'inv-return', 'text', 'https://…'),
        f('Link valid for (days)', 'inv-days', 'number', '7'),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const r = await api('/sessions', { body: {
              test_id: sel.value, candidate_name: $('inv-name').value || undefined, candidate_email: $('inv-email').value || undefined,
              candidate_ref: $('inv-ref').value || undefined, return_url: $('inv-return').value || undefined,
              ttl_minutes: (Number($('inv-days').value) || 7) * 1440 } });
            out.replaceChildren(msg('Invite link (copy it now; send it to the candidate):', 'ok'),
              h('input', { type: 'text', readonly: true, value: r.url, onclick: (e) => e.target.select() }));
            loadTable();
          } catch (e) { out.replaceChildren(msg(e.message, 'err')); }
        } }, 'Create link'), out);
      box.replaceChildren(tests.length ? form : msg('Create a test first (Tests tab).'), h('h2', { style: 'margin-top:20px' }, 'Recent invites'), tableBox);
      loadTable();
    } catch (e) { box.replaceChildren(msg(e.message, 'err')); }
  }

  // ------------------------------------------------------------- settings
  async function loadSettings() {
    const box = $('tab-settings');
    try {
      const me = await api('/me');
      const hook = h('input', { type: 'text', value: me.webhook_url || '', placeholder: 'https://yoursite.com/hooks/proctor' });
      const origins = h('textarea', { style: 'min-height:90px', placeholder: 'https://yoursite.com' }, (me.allowed_origins || []).join('\n'));
      const out = h('div');
      const rotateOut = h('div');
      const bOut = h('div');
      const owner = h('input', { type: 'text', placeholder: 'owner id, e.g. employer-42' });
      const rotate = (what) => h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm(`Rotate ${what}? ${what === 'api_key' ? 'The current key stops working immediately and you will be signed out.' : 'Update your site with the new value right away.'}`)) return;
        try {
          const r = await api('/me/rotate', { body: { what } });
          rotateOut.replaceChildren(msg(`New ${what} (shown once): ${r[what]}`, 'ok'));
          if (what === 'api_key') { KEY = r.api_key; try { sessionStorage.setItem('proctor_key', KEY); } catch { /* ignore */ } }
        } catch (e) { rotateOut.replaceChildren(msg(e.message, 'err')); }
      } }, 'Rotate ' + what.replace('_', ' '));
      box.replaceChildren(
        h('div', { class: 'card' }, h('h2', {}, 'Webhook & embedding'),
          h('label', { class: 'field' }, h('span', {}, 'Webhook URL (results are POSTed here, signed)'), hook),
          h('label', { class: 'field' }, h('span', {}, 'Allowed origins: sites that may embed the exam widget/builder (one per line)'), origins),
          h('button', { class: 'btn primary', onclick: async () => {
            try {
              await api('/me', { method: 'PATCH', body: { webhook_url: hook.value.trim() || null, allowed_origins: origins.value.split('\n').map((s) => s.trim()).filter(Boolean) } });
              out.replaceChildren(msg('Saved.', 'ok'));
            } catch (e) { out.replaceChildren(msg(e.message, 'err')); }
          } }, 'Save'), out),
        h('div', { class: 'card' }, h('h2', {}, 'Secrets'),
          h('p', { class: 'muted' }, 'Rotate if a secret may have leaked. New values are shown once.'),
          h('div', { class: 'row' }, rotate('api_key'), rotate('launch_secret'), rotate('webhook_secret')), rotateOut),
        h('div', { class: 'card' }, h('h2', {}, 'Try the embedded builder'),
          h('p', { class: 'muted' }, 'Your backend normally creates these. This makes a 30-minute builder link for one owner so you can test it.'),
          h('label', { class: 'field' }, h('span', {}, 'Owner'), owner),
          h('button', { class: 'btn', onclick: async () => {
            try {
              const r = await api('/builder-tokens', { body: { owner_ref: owner.value.trim() } });
              bOut.replaceChildren(msg('Builder link (valid 30 minutes):', 'ok'), h('input', { type: 'text', readonly: true, value: r.url, onclick: (e) => e.target.select() }));
            } catch (e) { bOut.replaceChildren(msg(e.message, 'err')); }
          } }, 'Create builder link'), bOut));
    } catch (e) { box.replaceChildren(msg(e.message, 'err')); }
  }

  async function loadAudit() {
    const box = $('tab-audit');
    try {
      const { entries } = await api('/audit');
      box.replaceChildren(h('div', { class: 'card', style: 'padding:0;overflow:auto' }, h('table', {},
        h('thead', {}, h('tr', {}, ...['Time', 'Actor', 'Action', 'Target', 'Detail'].map((t) => h('th', {}, t)))),
        h('tbody', {}, entries.length ? entries.map((e) => h('tr', {}, h('td', {}, fmt(e.ts)), h('td', {}, e.actor), h('td', {}, e.action), h('td', { class: 'mono' }, e.target || ''), h('td', {}, e.detail || '')))
          : [h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'Nothing yet.'))]))));
    } catch (e) { box.replaceChildren(msg(e.message, 'err')); }
  }

  // ---------------------------------------------------------------- start
  if (BUILDER) login(KEY);
  else if (KEY) login(KEY).then((ok) => { if (!ok) $('login').classList.remove('hidden'); });
  else $('login').classList.remove('hidden');
})();
