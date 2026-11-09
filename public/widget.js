/*
 * Proctor widget — drop into any website:
 *
 *   <script src="https://exams.example.com/widget.js"></script>
 *   // exam: your backend creates a session and gives you the `url`
 *   const exam = Proctor.open({ url, onSubmitted: (r) => ..., onFlag: (f) => ... });
 *   // builder: your backend creates a builder token and gives you the `url`
 *   Proctor.builder({ url, container: '#builder', onTestCreated: (t) => save(t.test_id) });
 *
 * Your site's origin must be listed in the tenant's allowed_origins.
 */
(function (global) {
  'use strict';

  function mount(opts, kind) {
    if (!opts || !opts.url) throw new Error('Proctor: `url` is required');
    var base = new URL(opts.url, location.href);
    var serviceOrigin = base.origin;
    base.searchParams.set('origin', location.origin);

    var iframe = document.createElement('iframe');
    iframe.src = base.toString();
    iframe.setAttribute('allow', 'camera; fullscreen');
    iframe.setAttribute('title', kind === 'exam' ? 'Proctored exam' : 'Test builder');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.style.cssText = 'border:0;width:100%;height:100%;display:block;background:#fff';

    var wrapper, container = null, prevOverflow = null, closed = false, canClose = kind !== 'exam';

    var api = {
      iframe: iframe,
      closeButton: null,
      close: function () {
        if (closed || !canClose) return false;
        closed = true;
        window.removeEventListener('message', onMessage);
        if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
        if (wrapper) { wrapper.remove(); document.documentElement.style.overflow = prevOverflow || ''; }
        else if (iframe.parentNode) iframe.remove();
        if (opts.onClose) opts.onClose();
        return true;
      },
    };

    if (opts.container) {
      container = typeof opts.container === 'string' ? document.querySelector(opts.container) : opts.container;
      if (!container) throw new Error('Proctor: container not found');
      container.appendChild(iframe);
    } else {
      wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#fff';
      wrapper.appendChild(iframe);
      var x = document.createElement('button');
      x.textContent = 'Close';
      x.setAttribute('aria-label', 'Close');
      x.style.cssText = 'position:absolute;top:8px;right:8px;z-index:1;padding:6px 12px;border:1px solid #999;border-radius:6px;background:#fff;cursor:pointer;display:none';
      x.onclick = function () { api.close(); };
      wrapper.appendChild(x);
      document.body.appendChild(wrapper);
      prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      api.closeButton = x;
    }

    function setCloseVisible(v) { canClose = v; if (api.closeButton) api.closeButton.style.display = v ? 'block' : 'none'; }
    if (canClose) setCloseVisible(true);

    function onMessage(e) {
      // Only accept messages from our own iframe, from the service origin.
      if (e.origin !== serviceOrigin || e.source !== iframe.contentWindow) return;
      var m = e.data;
      if (!m || m.source !== 'proctor-service') return;
      if (opts.onEvent) opts.onEvent(m);
      var cb = {
        ready: opts.onReady, started: opts.onStarted, submitted: opts.onSubmitted, flag: opts.onFlag,
        error: opts.onError, 'test.created': opts.onTestCreated,
      }[m.type];
      if (cb) cb(m);
      if (m.type === 'started') setCloseVisible(false); // no escaping a running exam
      if (m.type === 'submitted') setCloseVisible(true);
      if (m.type === 'ready' && m.status === 'submitted') setCloseVisible(true);
    }
    window.addEventListener('message', onMessage);
    return api;
  }

  global.Proctor = {
    open: function (opts) { return mount(opts, 'exam'); },
    builder: function (opts) { return mount(opts, 'builder'); },
  };
})(window);
