/* EAA Chapter 1699 — progressive enhancement only.
   Every page works with JavaScript disabled; this file adds polish.
   No inline handlers anywhere, which is what lets the CSP forbid them. */
(function () {
  'use strict';

  /* --------------------------------------------------------- mobile nav */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('primary-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  /* ----------------------------------------------------------- carousel */
  document.querySelectorAll('[data-carousel]').forEach(function (root) {
    var track = root.querySelector('.carousel-track');
    var slides = root.querySelectorAll('.carousel-slide');
    var prev = root.querySelector('.carousel-prev');
    var next = root.querySelector('.carousel-next');
    var dots = root.querySelectorAll('.carousel-dots button');
    var counter = root.querySelector('.carousel-count .current');
    if (!track || slides.length < 2) return;

    var index = 0;

    function show(i) {
      index = Math.max(0, Math.min(i, slides.length - 1));
      track.style.transform = 'translateX(' + index * -100 + '%)';
      if (prev) prev.hidden = index === 0;
      if (next) next.hidden = index === slides.length - 1;
      dots.forEach(function (dot, d) {
        dot.setAttribute('aria-current', String(d === index));
      });
      slides.forEach(function (slide, s) {
        slide.setAttribute('aria-hidden', String(s !== index));
      });
      if (counter) counter.textContent = String(index + 1);
    }

    if (prev) prev.addEventListener('click', function () { show(index - 1); });
    if (next) next.addEventListener('click', function () { show(index + 1); });
    dots.forEach(function (dot, d) {
      dot.addEventListener('click', function () { show(d); });
    });

    root.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { show(index - 1); }
      if (e.key === 'ArrowRight') { show(index + 1); }
    });

    // Touch swipe.
    var startX = null;
    root.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; }, { passive: true });
    root.addEventListener('touchend', function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 45) show(index + (dx < 0 ? 1 : -1));
      startX = null;
    });

    show(0);
  });

  /* ------------------------------------------------- password strength UI
     Purely a hint for the member. The authoritative check runs on the
     server, which never trusts anything this function decides. */
  var pw = document.querySelector('[data-strength-for]');
  if (pw) {
    var bar = document.querySelector(pw.getAttribute('data-strength-for'));
    var label = document.querySelector('[data-strength-label]');
    pw.addEventListener('input', function () {
      var v = pw.value;
      var score = 0;
      if (v.length >= 12) score += 35;
      if (v.length >= 16) score += 20;
      if (v.length >= 20) score += 15;
      if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score += 10;
      if (/\d/.test(v)) score += 8;
      if (/[^\w\s]/.test(v)) score += 8;
      if (new Set(v).size > 8) score += 10;
      score = Math.min(score, 100);

      if (bar) {
        bar.style.width = score + '%';
        bar.style.background = score < 40 ? '#b3261e' : score < 70 ? '#d98315' : '#1f7a4d';
      }
      if (label) {
        label.textContent = !v.length ? ''
          : score < 40 ? 'Too easy to guess'
          : score < 70 ? 'Getting there'
          : 'Strong — nice one';
      }
    });
  }

  /* ------------------------------------------------------ rich text editor
     Progressive enhancement. The server renders a plain <textarea> holding
     markdown; if Trix loaded, swap in the editor, seed it from the rendered
     HTML, and flip the format flag so the server converts the submission back
     to markdown. If Trix is missing or JS is off, the textarea is what gets
     submitted and nothing here runs. */
  document.querySelectorAll('[data-rich-editor]').forEach(function (field) {
    if (typeof window.Trix === 'undefined') return;

    var textarea = field.querySelector('[data-rich-source]');
    var initial = field.querySelector('[data-rich-initial]');
    var format = field.querySelector('[data-rich-format]');
    var hint = field.querySelector('[data-rich-hint]');
    if (!textarea || !format) return;

    // Trix needs an <input> to write into; the textarea keeps the field name
    // so whichever one is visible is the one that submits.
    var name = textarea.getAttribute('name');
    var hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.id = name + '-trix-input';
    hidden.value = initial ? initial.innerHTML.trim() : '';

    var editor = document.createElement('trix-editor');
    editor.setAttribute('input', hidden.id);
    editor.setAttribute('class', 'trix-content');
    if (textarea.getAttribute('placeholder')) {
      editor.setAttribute('placeholder', textarea.getAttribute('placeholder'));
    }
    // Point the label at the editor so clicking it still focuses the field.
    var label = field.querySelector('label');
    if (label) label.removeAttribute('for');

    textarea.hidden = true;
    textarea.removeAttribute('required'); // a hidden required field blocks submit
    textarea.setAttribute('aria-hidden', 'true');
    textarea.tabIndex = -1;

    field.insertBefore(hidden, textarea);
    field.insertBefore(editor, textarea);
    field.classList.add('is-rich');
    if (hint) hint.hidden = false;

    // On submit, hand the editor's HTML over as the field's value and tell the
    // server what it is getting.
    var form = field.closest('form');
    if (form) {
      form.addEventListener('submit', function () {
        textarea.value = hidden.value;
        format.value = 'html';
      });
    }
  });

  /* --------------------------------------------- hero scroll cue */
  // A floating button that stays on screen and steps down the page one section
  // at a time. At the last section it turns around and goes back to the top.
  var cue = document.querySelector('[data-scroll-cue]');
  if (cue) {
    var sections = Array.prototype.slice.call(document.querySelectorAll('main > .hero, main > section'));
    var header = document.querySelector('.site-header');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var nextSection = function () {
      var headerH = header ? header.offsetHeight : 0;
      // At the very bottom there is nowhere further to go, even if a short
      // last section never reaches the top of the screen.
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) return null;
      for (var i = 0; i < sections.length; i++) {
        // "Next" is the first section whose top is still below the header.
        if (sections[i].getBoundingClientRect().top > headerH + 8) return sections[i];
      }
      return null;
    };
    var cueTimer = null;
    var refreshCue = function () {
      cueTimer = null;
      var up = !nextSection();
      cue.classList.toggle('is-up', up);
      cue.setAttribute('aria-label', up ? 'Back to the top' : 'Scroll down to see more');
    };
    var queueRefresh = function () { if (!cueTimer) cueTimer = window.requestAnimationFrame(refreshCue); };
    window.addEventListener('scroll', queueRefresh, { passive: true });
    window.addEventListener('resize', queueRefresh);
    cue.addEventListener('click', function (e) {
      e.preventDefault();
      var target = nextSection();
      var top = target
        ? window.scrollY + target.getBoundingClientRect().top - (header ? header.offsetHeight : 0)
        : 0;
      window.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
    });
    refreshCue();
  }

  /* ------------------------------------------ phone number formatting */
  // Formats US numbers as you type: (518) 396-6775. A leading "+" means an
  // international number, which is left exactly as typed.
  document.querySelectorAll('input[type="tel"]').forEach(function (input) {
    function format() {
      var v = input.value;
      if (v.trim().charAt(0) === '+') return;
      var d = v.replace(/\D/g, '');
      if (d.length > 10 && d.charAt(0) === '1') d = d.slice(1);
      if (d.length > 10) return; // not a plain US number: leave it alone
      var out = d;
      if (d.length > 6) out = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
      else if (d.length > 3) out = '(' + d.slice(0, 3) + ') ' + d.slice(3);
      else if (d.length > 0) out = d.length === 3 && v.length >= 3 ? '(' + d + ') ' : d;
      if (out !== v) input.value = out;
    }
    input.addEventListener('input', function (e) {
      // Let backspace delete cleanly instead of re-adding the punctuation.
      if (e.inputType && e.inputType.indexOf('delete') === 0) return;
      format();
    });
    input.addEventListener('blur', format);
  });

  /* ------------------------------------------------ time on page */
  // Reports how long this page was actually in front of the reader and how far
  // down they got, so the chapter can tell "read it" from "bounced". Counts only
  // time the tab is visible, sends a tiny summary (never the page's content, never
  // an identity) when the page is hidden or left, and does nothing at all if the
  // browser says "do not track". Bots do not run this, which keeps them out too.
  (function () {
    var meta = document.querySelector('meta[name="eaa-stats"]');
    if (!meta || !navigator.sendBeacon) return;
    if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;
    var base = meta.getAttribute('data-base') || '';
    var path = location.pathname;
    if (base && path.indexOf(base) === 0) path = path.slice(base.length) || '/';
    if (/^\/(members\/(admin|account)|login|logout|forgot|reset|invite)(\/|$)/.test(path)) return;

    var id = Math.random().toString(36).slice(2, 10);
    var visibleMs = 0;
    var shownAt = document.visibilityState === 'visible' ? Date.now() : null;
    var deepest = 0;
    function depth() {
      var d = document.documentElement;
      var room = d.scrollHeight - window.innerHeight;
      var pct = room <= 0 ? 100 : Math.round((window.scrollY / room) * 100);
      if (pct > deepest) deepest = Math.min(100, pct);
    }
    depth();
    window.addEventListener('scroll', depth, { passive: true });

    function report() {
      if (shownAt) { visibleMs += Date.now() - shownAt; shownAt = null; }
      var secs = Math.round(visibleMs / 1000);
      if (secs < 1) return;
      depth();
      navigator.sendBeacon(meta.getAttribute('content'), JSON.stringify({ i: id, p: path, t: secs, s: deepest }));
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') report();
      else shownAt = Date.now();
    });
    window.addEventListener('pagehide', report);
  })();

  /* ------------------------------------------- stats chart tooltips */
  // Hover (or tap) a column to read its number. The same figures are in the
  // "Show as a table" list under each chart, for keyboards and screen readers.
  var statTip = null;
  function showTip(target, x, y) {
    if (!statTip) {
      statTip = document.createElement('div');
      statTip.className = 'stat-tip';
      statTip.setAttribute('role', 'status');
      document.body.appendChild(statTip);
    }
    statTip.textContent = target.getAttribute('data-tip');
    statTip.hidden = false;
    var w = statTip.offsetWidth;
    statTip.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - w - 8)) + 'px';
    statTip.style.top = Math.max(8, y - 38) + 'px';
  }
  document.addEventListener('mouseover', function (e) {
    var g = e.target.closest && e.target.closest('.stat-chart [data-tip]');
    if (g) showTip(g, e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', function (e) {
    var g = e.target.closest && e.target.closest('.stat-chart [data-tip]');
    if (g && statTip && !statTip.hidden) showTip(g, e.clientX, e.clientY);
  });
  document.addEventListener('mouseout', function (e) {
    if (statTip && e.target.closest && e.target.closest('.stat-chart [data-tip]')) statTip.hidden = true;
  });
  document.addEventListener('click', function (e) {
    var g = e.target.closest && e.target.closest('.stat-chart [data-tip]');
    if (g) showTip(g, e.clientX, e.clientY);
    else if (statTip) statTip.hidden = true;
  });

  /* ------------------------------------------------------- tag picker */
  // Turns the plain comma-separated tags box into chips with type-ahead. It
  // suggests tags already in use (substring match, so "bui" finds both
  // "builders" and "homebuild") and still lets the writer make a new one. The
  // original input stays in the form, hidden, holding a comma-separated value,
  // so the server sees exactly what it always did.
  document.querySelectorAll('[data-tag-picker]').forEach(function (picker, pickerIndex) {
    var store = picker.querySelector('[data-tag-store]');
    if (!store) return;
    var known = [];
    try { known = JSON.parse(picker.getAttribute('data-known') || '[]'); } catch (e) { known = []; }
    var knownCount = {};
    known.forEach(function (k) { knownCount[k.tag] = k.n; });
    var max = parseInt(picker.getAttribute('data-max'), 10) || 8;

    function normalize(t) {
      return String(t || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 40);
    }

    var tags = [];
    store.value.split(',').forEach(function (t) {
      t = normalize(t);
      if (t && tags.indexOf(t) < 0 && tags.length < max) tags.push(t);
    });

    // Build the interface.
    var listId = 'tag-list-' + pickerIndex;
    var box = document.createElement('div');
    box.className = 'tag-box';
    var entry = document.createElement('input');
    entry.type = 'text';
    entry.className = 'tag-entry';
    entry.id = 'tags-input';
    entry.setAttribute('autocomplete', 'off');
    entry.setAttribute('autocapitalize', 'off');
    entry.setAttribute('spellcheck', 'false');
    entry.setAttribute('role', 'combobox');
    entry.setAttribute('aria-autocomplete', 'list');
    entry.setAttribute('aria-expanded', 'false');
    entry.setAttribute('aria-controls', listId);
    entry.setAttribute('maxlength', '40');
    var list = document.createElement('ul');
    list.className = 'tag-list';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    var status = document.createElement('div');
    status.className = 'sr-only';
    status.setAttribute('aria-live', 'polite');
    box.appendChild(entry);
    picker.appendChild(box);
    picker.appendChild(list);
    picker.appendChild(status);
    store.type = 'hidden';

    var rows = []; // what the dropdown is showing: { tag, isNew }
    var active = 0;

    function say(msg) { status.textContent = msg; }

    function sync() {
      store.value = tags.join(', ');
      box.querySelectorAll('.tag-chip').forEach(function (c) { c.remove(); });
      tags.forEach(function (t) {
        var chip = document.createElement('span');
        var isNew = !(t in knownCount);
        chip.className = 'tag-chip' + (isNew ? ' is-new' : '');
        chip.appendChild(document.createTextNode(t));
        if (isNew) {
          var badge = document.createElement('span');
          badge.className = 'tag-new';
          badge.textContent = 'new';
          chip.appendChild(badge);
        }
        var x = document.createElement('button');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove tag ' + t);
        x.textContent = '×';
        x.addEventListener('click', function () { removeTag(t); entry.focus(); });
        chip.appendChild(x);
        box.insertBefore(chip, entry);
      });
      var full = tags.length >= max;
      entry.disabled = full;
      entry.placeholder = full ? 'Tag limit reached' : (tags.length ? '' : 'meeting-notes, young-eagles, safety');
    }

    function addTag(raw) {
      var t = normalize(raw);
      if (!t) return false;
      if (tags.indexOf(t) >= 0) { say(t + ' is already added'); return false; }
      if (tags.length >= max) { say('You can add up to ' + max + ' tags'); return false; }
      tags.push(t);
      sync();
      say(t in knownCount ? 'Added existing tag ' + t : 'Added new tag ' + t);
      return true;
    }

    function removeTag(t) {
      tags = tags.filter(function (x) { return x !== t; });
      sync();
      say('Removed tag ' + t);
    }

    function matchesFor(q) {
      if (!q) return [];
      return known
        .filter(function (k) { return tags.indexOf(k.tag) < 0 && k.tag.indexOf(q) >= 0; })
        .sort(function (a, b) {
          var ap = a.tag.indexOf(q) === 0 ? 0 : 1;
          var bp = b.tag.indexOf(q) === 0 ? 0 : 1;
          return ap - bp || b.n - a.n || (a.tag < b.tag ? -1 : 1);
        })
        .slice(0, 6);
    }

    function closeList() {
      list.hidden = true;
      entry.setAttribute('aria-expanded', 'false');
      entry.removeAttribute('aria-activedescendant');
      rows = [];
    }

    function renderList() {
      var q = normalize(entry.value);
      list.textContent = '';
      rows = [];
      if (!q || entry.disabled) { closeList(); return; }
      matchesFor(q).forEach(function (k) { rows.push({ tag: k.tag, isNew: false, n: k.n }); });
      if (!(q in knownCount) && tags.indexOf(q) < 0) rows.push({ tag: q, isNew: true });
      if (!rows.length) { closeList(); return; }
      if (active >= rows.length) active = 0;
      rows.forEach(function (r, i) {
        var li = document.createElement('li');
        li.id = listId + '-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.className = 'tag-option' + (i === active ? ' is-active' : '') + (r.isNew ? ' is-create' : '');
        // The name is one element so the row's flex gap never splits the word.
        var name = document.createElement('span');
        name.className = 'tag-name';
        li.appendChild(name);
        if (r.isNew) {
          name.appendChild(document.createTextNode('Create new tag “' + r.tag + '”'));
        } else {
          var at = r.tag.indexOf(q);
          name.appendChild(document.createTextNode(r.tag.slice(0, at)));
          var b = document.createElement('strong');
          b.textContent = r.tag.slice(at, at + q.length);
          name.appendChild(b);
          name.appendChild(document.createTextNode(r.tag.slice(at + q.length)));
          var used = document.createElement('span');
          used.className = 'tag-used';
          used.textContent = r.n === 1 ? 'used once' : 'used ' + r.n + ' times';
          li.appendChild(used);
        }
        // mousedown, not click, so the field keeps focus.
        li.addEventListener('mousedown', function (e) {
          e.preventDefault();
          choose(i);
        });
        list.appendChild(li);
      });
      list.hidden = false;
      entry.setAttribute('aria-expanded', 'true');
      entry.setAttribute('aria-activedescendant', listId + '-' + active);
    }

    function choose(i) {
      var r = rows[i];
      if (!r) return false;
      var ok = addTag(r.tag);
      entry.value = '';
      active = 0;
      closeList();
      return ok;
    }

    entry.addEventListener('input', function () {
      // Pasted or typed separators finish the tags before them.
      if (/[\s,]/.test(entry.value)) {
        var parts = entry.value.split(/[\s,]+/);
        var rest = parts.pop();
        parts.forEach(addTag);
        entry.value = rest;
      }
      active = 0;
      renderList();
    });

    entry.addEventListener('keydown', function (e) {
      var hasText = normalize(entry.value) !== '';
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!rows.length) { renderList(); if (!rows.length) return; }
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        renderList();
      } else if (e.key === 'Enter') {
        if (rows.length) { e.preventDefault(); choose(active); }
        else if (hasText) { e.preventDefault(); addTag(entry.value); entry.value = ''; }
        // Empty field: let Enter submit the form as usual.
      } else if (e.key === 'Tab' && !e.shiftKey && hasText) {
        e.preventDefault();
        if (rows.length) choose(active);
        else { addTag(entry.value); entry.value = ''; closeList(); }
      } else if (e.key === ' ' || e.key === ',') {
        e.preventDefault();
        if (hasText) { addTag(entry.value); entry.value = ''; active = 0; closeList(); }
      } else if (e.key === 'Backspace' && !entry.value && tags.length) {
        removeTag(tags[tags.length - 1]);
      } else if (e.key === 'Escape') {
        closeList();
      }
    });

    entry.addEventListener('blur', function () { closeList(); });
    box.addEventListener('click', function (e) { if (e.target === box) entry.focus(); });

    // Anything typed but not yet added still counts when the form is sent.
    var form = store.closest('form');
    if (form) {
      form.addEventListener('submit', function () {
        if (normalize(entry.value)) { addTag(entry.value); entry.value = ''; }
      });
    }

    sync();
  });

  /* ------------------------------------------ inline suggestions */
  // For ordinary text boxes that tend to repeat ("Hangar 6", "DeWalt"). Shows
  // values already in use as you type, but never forces a choice: nothing is
  // pre-selected, so Enter and Tab behave as normal unless you have deliberately
  // moved onto a suggestion with the arrow keys or the mouse. Keep typing and
  // your own text stands.
  document.querySelectorAll('input[data-suggest]').forEach(function (input, index) {
    var values = [];
    try { values = JSON.parse(input.getAttribute('data-suggest') || '[]'); } catch (e) { values = []; }
    if (!values.length) return;

    var wrap = document.createElement('div');
    wrap.className = 'suggest-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var listId = 'suggest-list-' + index;
    var list = document.createElement('ul');
    list.className = 'tag-list suggest-list';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.appendChild(list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', listId);

    var shown = [];
    var active = -1; // -1: nothing chosen, so keys behave normally

    function close() {
      list.hidden = true;
      active = -1;
      shown = [];
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function render() {
      var q = input.value.trim().toLowerCase();
      list.textContent = '';
      if (!q) { close(); return; }
      shown = values
        .filter(function (v) { var l = v.toLowerCase(); return l.indexOf(q) >= 0 && l !== q; })
        .sort(function (a, b) {
          var ap = a.toLowerCase().indexOf(q) === 0 ? 0 : 1;
          var bp = b.toLowerCase().indexOf(q) === 0 ? 0 : 1;
          return ap - bp;
        })
        .slice(0, 6);
      if (!shown.length) { close(); return; }
      var head = document.createElement('li');
      head.className = 'suggest-head';
      head.setAttribute('role', 'presentation');
      head.textContent = 'Already used — or keep typing your own';
      list.appendChild(head);
      shown.forEach(function (v, i) {
        var li = document.createElement('li');
        li.id = listId + '-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.className = 'tag-option' + (i === active ? ' is-active' : '');
        var at = v.toLowerCase().indexOf(q);
        var name = document.createElement('span');
        name.className = 'tag-name';
        name.appendChild(document.createTextNode(v.slice(0, at)));
        var b = document.createElement('strong');
        b.textContent = v.slice(at, at + q.length);
        name.appendChild(b);
        name.appendChild(document.createTextNode(v.slice(at + q.length)));
        li.appendChild(name);
        li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(i); });
        list.appendChild(li);
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', listId + '-' + active);
      else input.removeAttribute('aria-activedescendant');
    }

    function pick(i) {
      if (shown[i] === undefined) return;
      input.value = shown[i];
      close();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    input.addEventListener('input', function () { active = -1; render(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!shown.length) { render(); if (!shown.length) return; }
        e.preventDefault();
        var step = e.key === 'ArrowDown' ? 1 : -1;
        // From "nothing chosen" the first press lands on the first/last suggestion.
        active = active < 0 ? (step > 0 ? 0 : shown.length - 1) : active + step;
        if (active < 0 || active >= shown.length) active = -1; // wrap back to "just my text"
        render();
      } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0 && !list.hidden) {
        e.preventDefault();
        pick(active);
      } else if (e.key === 'Escape') {
        close();
      }
    });
    input.addEventListener('blur', close);
  });

  /* --------------------------- cards / compact panel toggle (events) */
  // Two server-rendered versions of the same list; this shows one and remembers
  // the choice. Without JavaScript the cards show and the toggle stays hidden.
  var panelToggle = document.querySelector('[data-panel-toggle]');
  if (panelToggle) {
    var panels = document.querySelectorAll('[data-panel]');
    var panelKey = panelToggle.getAttribute('data-key');
    var showPanel = function (view) {
      panels.forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== view; });
      panelToggle.querySelectorAll('[data-view]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view));
      });
    };
    var savedPanel = null;
    try { savedPanel = window.localStorage.getItem(panelKey); } catch (e) { /* storage blocked: still works */ }
    showPanel(savedPanel === 'compact' ? 'compact' : 'cards');
    panelToggle.hidden = false;
    panelToggle.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-view]');
      if (!btn) return;
      var view = btn.getAttribute('data-view');
      showPanel(view);
      try { window.localStorage.setItem(panelKey, view); } catch (err) { /* see above */ }
    });
  }

  /* ------------------------------------- cards / compact layout toggle */
  var viewToggle = document.querySelector('[data-view-toggle]');
  var viewTarget = document.querySelector('[data-view-target]');
  if (viewToggle && viewTarget) {
    var KEY = 'eaa1699.locker.view';
    var setView = function (view) {
      viewTarget.classList.toggle('is-compact', view === 'compact');
      viewToggle.querySelectorAll('[data-view]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view));
      });
    };
    var saved = null;
    try { saved = window.localStorage.getItem(KEY); } catch (e) { /* storage blocked: still works, just not remembered */ }
    setView(saved === 'compact' ? 'compact' : 'cards');
    viewToggle.hidden = false;
    viewToggle.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-view]');
      if (!btn) return;
      var view = btn.getAttribute('data-view');
      setView(view);
      try { window.localStorage.setItem(KEY, view); } catch (err) { /* see above */ }
    });
  }

  /* ------------------------------------------- confirm destructive actions */
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  /* ----------------------------------------------- spam trap timestamp */
  document.querySelectorAll('input[name="rendered_at"]').forEach(function (input) {
    input.value = String(Date.now());
  });

  /* ------------------------------------------- image upload previews */
  document.querySelectorAll('input[type="file"][data-preview]').forEach(function (input) {
    var target = document.querySelector(input.getAttribute('data-preview'));
    if (!target) return;
    input.addEventListener('change', function () {
      target.innerHTML = '';
      Array.prototype.slice.call(input.files || []).forEach(function (file) {
        if (!/^image\//.test(file.type)) return;
        var img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.alt = '';
        img.addEventListener('load', function () { URL.revokeObjectURL(img.src); });
        var wrap = document.createElement('div');
        wrap.className = 'preview-thumb';
        wrap.appendChild(img);
        target.appendChild(wrap);
      });
    });
  });

  /* --------------------------------------------------------- toasts */
  // Short messages that float over the page and fade by themselves, so saving
  // something never shoves the page around. Success and info fade quickly; an
  // error stays longer so it is not missed, and any toast can be closed.
  var toastHost = null;
  function showToast(message, type) {
    type = type || 'success';
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'toasts';
      toastHost.setAttribute('role', 'status');
      toastHost.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastHost);
    }
    var toast = document.createElement('div');
    toast.className = 'toast flash flash-' + type;
    var icon = document.createElement('span');
    icon.className = 'flash-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
    var text = document.createElement('p');
    text.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    toast.appendChild(icon);
    toast.appendChild(text);
    toast.appendChild(close);
    toastHost.appendChild(toast);

    var timer = null;
    function leave() {
      window.clearTimeout(timer);
      toast.classList.add('is-leaving');
      window.setTimeout(function () { toast.remove(); }, 400);
    }
    close.addEventListener('click', leave);
    timer = window.setTimeout(leave, type === 'error' ? 9000 : 4000);
    return toast;
  }

  // Messages the server put at the top of the page become toasts too.
  document.querySelectorAll('main .flash').forEach(function (flash) {
    var p = flash.querySelector('p');
    var type = (flash.className.match(/flash-(success|error|info)/) || [])[1] || 'info';
    if (p) showToast(p.textContent, type);
    var holder = flash.parentNode;
    (holder && holder.classList.contains('wrap') ? holder : flash).remove();
  });

  /* ------------------------------------------ keep your place on reload */
  // A form that has to reload the page (a role change, suspend) remembers how
  // far down you were and puts you back there, instead of jumping to the top.
  var SCROLL_KEY = 'eaa.scroll';
  function rememberScroll() {
    try { window.sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ p: location.pathname, y: window.scrollY })); } catch (e) { /* ignore */ }
  }
  try {
    var kept = JSON.parse(window.sessionStorage.getItem(SCROLL_KEY) || 'null');
    window.sessionStorage.removeItem(SCROLL_KEY);
    if (kept && kept.p === location.pathname && kept.y > 0) window.scrollTo(0, kept.y);
  } catch (e) { /* ignore */ }
  document.addEventListener('submit', function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-keep-scroll')) rememberScroll();
  });

  /* ----------------------------------------------- auto-submit controls */
  // A checkbox in a form marked data-ajax saves in the background and reports
  // with a toast; the page does not move. Anything else submits the form, and
  // keeps your scroll position if the form asks for that.
  function saveInBackground(form, control) {
    var wasChecked = control.checked;
    // Read the form BEFORE disabling the control: a disabled field is left out of the data.
    var body = new URLSearchParams(new FormData(form)).toString();
    control.disabled = true;
    window.fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'fetch',
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body
    })
      .then(function (res) {
        return res.json().then(
          function (data) { return { ok: res.ok && data.ok, message: data.message }; },
          function () { return { ok: false, message: 'That did not save. Please reload the page and try again.' }; }
        );
      })
      .then(function (result) {
        if (!result.ok) control.checked = !wasChecked;
        showToast(result.message || (result.ok ? 'Saved.' : 'That did not save.'), result.ok ? 'success' : 'error');
      })
      .catch(function () {
        control.checked = !wasChecked;
        showToast('Could not save. Check your connection and try again.', 'error');
      })
      .then(function () { control.disabled = false; });
  }

  document.querySelectorAll('form[data-autosubmit] select, form[data-autosubmit] input[type="checkbox"]').forEach(function (control) {
    control.addEventListener('change', function () {
      var form = control.form;
      if (form.hasAttribute('data-ajax') && window.fetch && control.type === 'checkbox') {
        saveInBackground(form, control);
        return;
      }
      if (form.hasAttribute('data-keep-scroll')) rememberScroll();
      form.submit();
    });
  });
})();
