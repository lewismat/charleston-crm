/* toast.js — shared feedback + undo.
   Replaces alert()/confirm() with something that does not punish a misclick.  */
(function () {
  var host;
  function ensure() {
    if (host) return host;
    host = document.createElement('div');
    host.id = 'tbmToasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    var css = document.createElement('style');
    css.textContent =
      '#tbmToasts{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:9999;' +
        'display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none;width:min(560px,92vw)}' +
      '.tbmT{pointer-events:auto;display:flex;align-items:center;gap:12px;width:100%;' +
        'background:#3B4832;color:#F7F2E4;border-radius:12px;padding:13px 16px;' +
        'font-family:Karla,system-ui,sans-serif;font-size:.92rem;line-height:1.45;' +
        'box-shadow:0 12px 32px rgba(59,72,50,.3);animation:tbmIn .18s ease-out}' +
      '.tbmT.bad{background:#8C3F1E}' +
      '.tbmT .msg{flex:1;min-width:0}' +
      '.tbmT button{flex:none;background:transparent;border:1px solid rgba(247,242,228,.5);' +
        'color:inherit;font:inherit;font-size:.84rem;font-weight:600;border-radius:8px;' +
        'padding:6px 13px;cursor:pointer}' +
      '.tbmT button:hover{background:rgba(247,242,228,.14)}' +
      '.tbmT .x{border:none;font-size:1.2rem;line-height:1;padding:2px 6px;opacity:.7}' +
      '@keyframes tbmIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
      '@media(prefers-reduced-motion:reduce){.tbmT{animation:none}}';
    document.head.appendChild(css);
    return host;
  }

  function close(el) {
    if (!el || !el.parentNode) return;
    el.style.transition = 'opacity .15s'; el.style.opacity = '0';
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 160);
  }

  // toast('Saved')  ·  toast('Could not save', 'bad')
  window.toast = function (message, kind) {
    var el = document.createElement('div');
    el.className = 'tbmT' + (kind === 'bad' ? ' bad' : '');
    el.innerHTML = '<span class="msg"></span><button class="x" aria-label="Dismiss">&times;</button>';
    el.querySelector('.msg').textContent = message;
    el.querySelector('.x').onclick = function () { close(el); };
    ensure().appendChild(el);
    setTimeout(function () { close(el); }, kind === 'bad' ? 7000 : 4200);
    return el;
  };

  /* undoable('Cancelled Jane's seat', doIt)
     Shows an Undo button and waits ~6s. If Undo is pressed, doIt never runs.  */
  window.undoable = function (message, run, opts) {
    opts = opts || {};
    var ms = opts.ms || 6000, cancelled = false;
    var el = document.createElement('div');
    el.className = 'tbmT';
    el.innerHTML = '<span class="msg"></span><button class="undo">Undo</button>' +
                   '<button class="x" aria-label="Dismiss">&times;</button>';
    el.querySelector('.msg').textContent = message;
    el.querySelector('.undo').onclick = function () {
      cancelled = true; close(el);
      if (opts.onUndo) opts.onUndo();
      window.toast(opts.undoMessage || 'Undone — nothing was changed.');
    };
    el.querySelector('.x').onclick = function () { close(el); };
    ensure().appendChild(el);
    setTimeout(function () {
      close(el);
      if (!cancelled) Promise.resolve(run()).catch(function (e) {
        window.toast((e && e.message) || 'That did not work.', 'bad');
      });
    }, ms);
  };
})();
