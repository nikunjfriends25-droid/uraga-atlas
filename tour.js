/* Onboarding: a one-time welcome dialog and an optional coach-mark walkthrough.
 * No library — a dimmed overlay with a spotlight cut-out (box-shadow) and a
 * tooltip. Positioned synchronously, never via requestAnimationFrame (throttled
 * here). Re-openable any time from the "?" button. */
(function () {
  const KEY = 'uraga_tour_v1';
  const $ = s => document.querySelector(s);

  const STEPS = [
    { sel: '#panel', place: 'right', title: 'Filters & species',
      text: 'Filter the 1,096 species by taxonomic group or conservation status, search by name or family, and switch the list into a taxonomic tree.' },
    { sel: '.hud', place: 'left', title: 'The occurrence map',
      text: 'A heatmap of 98,451 georeferenced records. It re-grids finer as you zoom in. Selecting a species shows its own points and IUCN range.' },
    { sel: '#rgnhandle', place: 'left', title: 'Regions & reports', open: 'region',
      text: 'Narrow country → state → district → sub-district, then export a printable species report for that area — checklist, occurrence map, conservation, venom, genetics and more.' },
    { sel: '.rgnfoot', place: 'left', title: 'Map style & basemap', open: 'region',
      text: 'Switch between the heatmap and proportional bubbles, and choose a basemap — pale grey, colour, dark, satellite or terrain.' },
    { sel: '#dockhandle', place: 'top', title: 'Species record',
      text: 'Pick any species to open its record: photographs, a live occurrence map, IUCN range, AI field notes, traits and genetic resources — and Export PDF for a one-species report.' },
  ];

  let i = 0;

  // ---- overlay + tooltip (built once) ----
  const wrap = document.createElement('div');
  wrap.className = 'tour';
  wrap.hidden = true;
  wrap.innerHTML =
    '<div class="tour-hole"></div>' +
    '<div class="tour-tip">' +
      '<div class="tour-step"></div>' +
      '<h4 class="tour-title"></h4>' +
      '<p class="tour-text"></p>' +
      '<div class="tour-btns">' +
        '<button class="tour-skip">Skip</button>' +
        '<span class="tour-spacer"></span>' +
        '<button class="tour-back">Back</button>' +
        '<button class="tour-next"></button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
  const hole = wrap.querySelector('.tour-hole');
  const tip = wrap.querySelector('.tour-tip');

  function ensureVisible(step) {
    // some targets live in a collapsed panel — open it first
    if (step.open === 'region' && $('#rgnpanel') && $('#rgnpanel').classList.contains('closed'))
      $('#rgnhandle') && $('#rgnhandle').click();
  }

  function place() {
    const step = STEPS[i];
    ensureVisible(step);
    const el = $(step.sel);
    if (!el) { next(); return; }                 // target absent → skip on
    const r = el.getBoundingClientRect();
    const pad = 6;
    Object.assign(hole.style, {
      left: (r.left - pad) + 'px', top: (r.top - pad) + 'px',
      width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
    });
    wrap.querySelector('.tour-step').textContent = `${i + 1} / ${STEPS.length}`;
    wrap.querySelector('.tour-title').textContent = step.title;
    wrap.querySelector('.tour-text').textContent = step.text;
    wrap.querySelector('.tour-back').disabled = i === 0;
    wrap.querySelector('.tour-next').textContent = i === STEPS.length - 1 ? 'Done' : 'Next';

    // position the tooltip beside the target, clamped to the viewport
    tip.style.visibility = 'hidden'; tip.style.left = '0px'; tip.style.top = '0px';
    const tw = tip.offsetWidth, th = tip.offsetHeight, gap = 14;
    let x, y;
    if (step.place === 'right') { x = r.right + gap; y = r.top; }
    else if (step.place === 'left') { x = r.left - tw - gap; y = r.top; }
    else if (step.place === 'top') { x = r.left + r.width / 2 - tw / 2; y = r.top - th - gap; }
    else { x = r.left + r.width / 2 - tw / 2; y = r.bottom + gap; }
    x = Math.max(10, Math.min(x, innerWidth - tw - 10));
    y = Math.max(10, Math.min(y, innerHeight - th - 10));
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    tip.style.visibility = 'visible';
  }

  function open(n) { i = n || 0; wrap.hidden = false; place(); }
  function close() { wrap.hidden = true; localStorage.setItem(KEY, '1'); }
  function next() { if (i < STEPS.length - 1) { i++; place(); } else close(); }
  function back() { if (i > 0) { i--; place(); } }

  wrap.querySelector('.tour-next').onclick = next;
  wrap.querySelector('.tour-back').onclick = back;
  wrap.querySelector('.tour-skip').onclick = close;
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  addEventListener('keydown', e => {
    if (wrap.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') back();
  });
  addEventListener('resize', () => { if (!wrap.hidden) place(); });

  // ---- help button (always available) ----
  const help = document.createElement('button');
  help.className = 'tour-help';
  help.title = 'Take a tour';
  help.setAttribute('aria-label', 'Take a tour');
  help.textContent = '?';
  help.onclick = () => open(0);
  document.body.appendChild(help);

  // ---- welcome modal (first visit only) ----
  function welcome() {
    const m = document.createElement('div');
    m.className = 'tour welcome';
    m.innerHTML =
      '<div class="tour-card">' +
        '<div class="tour-brand"><b>Uraga</b> Atlas</div>' +
        '<h3>Reptiles &amp; amphibians of the Indian subcontinent</h3>' +
        '<p>An occurrence atlas of 1,096 species. Explore the heatmap, filter by ' +
        'group or conservation status, open any species for photos, range and field ' +
        'notes, and export a printable report for any region.</p>' +
        '<div class="tour-btns">' +
          '<button class="tour-skip">Explore on my own</button>' +
          '<span class="tour-spacer"></span>' +
          '<button class="tour-next">Take the tour</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    const done = () => { m.remove(); localStorage.setItem(KEY, '1'); };
    m.querySelector('.tour-next').onclick = () => { done(); open(0); };
    m.querySelector('.tour-skip').onclick = done;
    m.addEventListener('click', e => { if (e.target === m) done(); });
  }

  // wait until the data is in (panels exist), then greet a first-time visitor
  if (!localStorage.getItem(KEY)) {
    const t = setInterval(() => {
      if ($('#pbody') && $('#pbody').children.length && !$('#boot')) {
        clearInterval(t);
        setTimeout(welcome, 600);
      }
    }, 400);
  }
})();
