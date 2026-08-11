/* Regional species reports.
 *
 * Pick a state, district or sub-district; the atlas scopes to it and can print
 * a species checklist as a PDF. Point-in-polygon already happened in
 * tools/build_regions.py, so selecting a region is just one JSON fetch.
 *
 * The PDF is produced by the browser's own print-to-PDF via a print
 * stylesheet — no PDF library, and it inherits the user's page size and
 * margins instead of guessing them.
 */

/* Labels are geoBoundaries ADM0–ADM3. Local terms differ (Bhutan's ADM1 is a
   dzongkhag, Sri Lanka's a province) — the hierarchy is right either way. */
const LEVELS = {0: 'Country', 1: 'State', 2: 'District', 3: 'Sub-district', aoi: 'Area of interest'};
const LEVEL_ORDER = [0, 1, 2, 3];
const RGN = 'data/regions/';
/* "6 countrys" — the naive +s was wrong for exactly the top level. */
const PLURAL = {0: 'countries', 1: 'states', 2: 'districts', 3: 'sub-districts'};
const plural = (lvl, n) => n === 1 ? LEVELS[lvl].toLowerCase() : PLURAL[lvl];
const THUMB_BATCH = 30;   // iNaturalist accepts comma-separated taxon ids

let rIndex = null;                  // lazily loaded region index
const rsel = [null, null, null, null];   // chosen code per level, 0=country
const rstate = {loading: false};

/* ── the region panel (floats right, independent of the filters) ─────── */
async function initRegionPanel(){
  const body = $('#rgnbody');
  if (rstate.loading) return;
  rstate.loading = true;
  body.innerHTML = '<div class="hollow">Loading regions…</div>';
  try {
    rIndex = await fetch('data/regions/index.json', DATA_FETCH).then(r => r.json());
  } catch (e){
    body.innerHTML = `<div class="hollow">Could not load regions — ${e.message}</div>`;
    return;
  } finally { rstate.loading = false; }
  paintRegionPanel();
}

const childrenOf = (lvl, parentCode) => rIndex
  .filter(r => r.l === lvl && (lvl === 0 || r.pc === parentCode))
  .sort((a, b) => a.n.localeCompare(b.n));

const byCode = c => rIndex.find(r => r.c === c);

/** Four dependent lists: country → state → district → sub-district. Each
 *  selection narrows the next, and a report can be exported at whichever
 *  level is currently the deepest chosen one. */
function paintRegionPanel(){
  const body = $('#rgnbody');
  body.innerHTML = '';
  if (!rIndex) return;

  LEVEL_ORDER.forEach(lvl => {
    const parent = lvl === 0 ? null : rsel[lvl - 1];
    const opts = (lvl === 0 || parent) ? childrenOf(lvl, parent) : [];
    const row = document.createElement('div');
    row.className = 'rgnfield';

    const lab = document.createElement('label');
    lab.className = 'rgnlab';
    lab.htmlFor = 'rgnsel' + lvl;
    lab.textContent = LEVELS[lvl];
    row.appendChild(lab);

    const sel = document.createElement('select');
    sel.id = 'rgnsel' + lvl;
    sel.className = 'rgnq rgnco';
    if (!opts.length){
      sel.disabled = true;
      sel.innerHTML = `<option>${lvl === 0 ? '—' :
        `select a ${LEVELS[lvl - 1].toLowerCase()} first`}</option>`;
    } else {
      sel.innerHTML = `<option value="">All — ${fmt(opts.length)} ${plural(lvl, opts.length)}</option>` +
        opts.map(o => `<option value="${o.c}"${rsel[lvl] === o.c ? ' selected' : ''}>${o.n} · ${fmt(o.ns)} sp</option>`).join('');
      sel.onchange = () => choose(lvl, sel.value || null);
    }
    row.appendChild(sel);
    body.appendChild(row);
  });

  const chosen = deepest();
  const card = document.createElement('div');
  card.className = 'rgnsel';
  if (!chosen){
    card.innerHTML = `<div class="hollow">Choose a region to scope the atlas
      and export a species checklist. A report can be exported at any level.</div>`;
    body.appendChild(card);
    return;
  }
  const shown = INDEX.filter(matches).length;
  card.innerHTML = `
    <div class="rgnname">${region ? region.name : chosen.n}</div>
    <div class="rgnmeta">${LEVELS[chosen.l]}${chosen.p ? ' · ' + chosen.p : ''} · ${chosen.co}</div>
    <div class="rgnstat">
      <span><b>${fmt(chosen.ns)}</b> species</span>
      <span><b>${fmt(chosen.nr)}</b> records</span>
    </div>`;
  if (region && shown !== region.sp.length){
    const n = document.createElement('div');
    n.className = 'rgnnote';
    n.textContent = `${fmt(shown)} shown under the current filters — the report follows the filters.`;
    card.appendChild(n);
  }
  const row = document.createElement('div');
  row.className = 'rgnbtns';
  const pdf = document.createElement('button');
  pdf.className = 'rgnpdf';
  pdf.textContent = 'Species report';
  pdf.disabled = !region;
  pdf.onclick = () => makeReport(pdf);
  row.appendChild(pdf);
  const clear = document.createElement('button');
  clear.className = 'reset';
  clear.textContent = 'Clear';
  clear.onclick = () => choose(0, null);
  row.appendChild(clear);
  card.appendChild(row);
  body.appendChild(card);
}

/** The deepest level the user has actually picked — that is the unit a
 *  report covers. */
function deepest(){
  for (let l = 3; l >= 0; l--) if (rsel[l]) return byCode(rsel[l]);
  return null;
}

function choose(lvl, code){
  rsel[lvl] = code;
  for (let l = lvl + 1; l < 4; l++) rsel[l] = null;   // deeper picks are stale
  const d = deepest();
  if (d) selectRegion(d.c);
  else clearRegion();
}

/* ── selection ────────────────────────────────────────── */
async function selectRegion(code){
  setBusy(true, 'Loading region…');
  try {
    region = await fetch(`${RGN}${code}.json`, DATA_FETCH).then(r => r.json());
  } catch (e){
    alert('Could not load that region: ' + e.message);
    return;
  } finally { setBusy(false); }
  // keep the cascade in step when a region is selected some other way
  rsel[region.lvl] = code;
  let p = region.parentCode, l = region.lvl - 1;
  while (p && l >= 0){ rsel[l] = p; const r = byCode(p); p = r && r.pc; l--; }
  regionIds = new Set(region.sp.map(s => s[0]));
  closeReport();                 // a report for the previous region is stale
  picked = detail = live = null; full = false;
  $('#dock').classList.remove('full');
  state.shown = 60;
  render();
  zoomToRegion();
}

function clearRegion(){
  closeReport();
  region = regionIds = null;
  rsel.fill(null);
  state.shown = 60;
  render();
  map.fitBounds([[P.minLat, P.minLon], [P.maxLat, P.maxLon]],
    {...viewPadding(), animate:false});
}

/* ── map ──────────────────────────────────────────────── */
function drawRegion(){
  regionLayer.clearLayers();
  if (!region) return;
  // outline rings are [lon,lat]; Leaflet wants [lat,lon]
  L.polygon(region.outline.map(r => r.map(p => [p[1], p[0]])), {
    color: '#F59E0B', weight: 2.2, opacity: .95,
    fillColor: '#F59E0B', fillOpacity: .06, interactive: false,
  }).addTo(regionLayer);
}

function zoomToRegion(){
  const b = regionLayer.getBounds();
  if (b.isValid()) fitBounds(b, 13);
}

async function makeReport(btn){
  const rows = region.sp.filter(s => {
    const sp = INDEX.find(i => i.id === s[0]);
    return sp && matches(sp);
  });
  if (!rows.length){ alert('No species match the current filters in this region.'); return; }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = `Fetching photographs… 0/${rows.length}`;
  let thumbs = new Map();
  try {
    thumbs = await fetchThumbs(rows, n => {
      btn.textContent = `Finding usable photographs… ${n}/${rows.length}`;
    });
  } catch (e){
    // a report without photographs is still a useful report
    console.warn('thumbnails unavailable', e);
  }
  const rings = await coastline();
  await borders();
  await india();
  const restricted = await sectionRestricted(rows);   // needs spread.json
  openReport(reportHTML(rows, thumbs, rings, restricted));
  await imagesSettled((n, total) => {
    btn.textContent = `Loading photographs… ${n}/${total}`;
  });
  btn.disabled = false; btn.textContent = label;
}

/** Show the report as a floating sheet. The same markup is what prints, so
 *  what is on screen is the PDF — no separate preview to drift out of sync. */

/* Page furniture for the printed PDF.
 *
 * Chrome supports @page margin boxes and counter(page)/counter(pages), so the
 * running head and folio are real paged-media furniture rather than a
 * position:fixed approximation — which cannot count pages at all.
 *
 * The region name is baked into the rule because margin-box `content` takes
 * only strings and counters; it cannot read the document. Rebuilt per report.
 */
// JSON.stringify already emits a correctly escaped double-quoted string,
// which is exactly what a CSS `content` value needs.
const cssStr = s => JSON.stringify(String(s));

function setPageFurniture(label){
  let el = document.getElementById('pagefurniture');
  if (!el){
    el = document.createElement('style');
    el.id = 'pagefurniture';
    document.head.appendChild(el);
  }
  const where = label || (region
    ? `${region.name} · ${LEVELS[region.lvl]}${region.parent ? ', ' + region.parent : ''}`
    : 'Species record');
  const when = new Date().toLocaleDateString('en-IN',
    {year: 'numeric', month: 'short', day: 'numeric'});
  const type = 'font-family:"Sora",system-ui,sans-serif;font-size:7.5pt;color:#8a8580';

  el.textContent = `
    @page{
      size:A4;
      margin:16mm 14mm 15mm;
      @top-left{content:${cssStr('Uraga Atlas')};${type};letter-spacing:.08em;
        text-transform:uppercase}
      @top-right{content:${cssStr(where)};${type}}
      @bottom-left{content:${cssStr('Generated ' + when + ' · GBIF · IUCN Red List · iNaturalist')};${type}}
      @bottom-right{content:"Page " counter(page) " of " counter(pages);${type};
        font-variant-numeric:tabular-nums}
    }
    /* the cover already carries the title block, so it needs no running head */
    @page:first{
      @top-left{content:""}
      @top-right{content:""}
    }`;
}

function openReport(html, title){
  const r = $('#report');
  r.innerHTML = `<div class="rbar">
      <span class="rttl">${title || (region ? region.name + ' · species report' : 'Report')}</span>
      <button class="rsave">Save as PDF</button>
      <button class="rclose" aria-label="Close report">Close</button>
    </div>` + html;
  r.classList.add('on');
  r.removeAttribute('aria-hidden');
  r.scrollTop = 0;
  document.body.classList.add('reporting');
  document.documentElement.style.setProperty('--sheetw', r.offsetWidth + 'px');
  setPageFurniture();      // running head and folio for the printed pages
  r.querySelector('.rsave').onclick = () => window.print();
  r.querySelector('.rclose').onclick = closeReport;
}
function closeReport(){
  const r = $('#report');
  r.classList.remove('on');
  r.setAttribute('aria-hidden', 'true');
  r.innerHTML = '';
  document.body.classList.remove('reporting');
  document.documentElement.style.removeProperty('--sheetw');
}
window.addEventListener('resize', () => {
  const r = $('#report');
  if (r.classList.contains('on'))
    document.documentElement.style.setProperty('--sheetw', r.offsetWidth + 'px');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#report').classList.contains('on')) closeReport();
});

/* Licences we may embed in a document that gets shared. Anything else — most
   importantly license_code null, meaning all rights reserved — is refused, and
   so is No-Derivatives, because the square crop is itself a derivative. */
const OBS_LICENCES = 'cc0,cc-by,cc-by-nc,cc-by-sa,cc-by-nc-sa';
const usableLicence = l => {
  l = (l || '').toLowerCase();
  return !!l && l.startsWith('cc') && !l.includes('nd');
};
const pick = p => ({url: p.square_url || p.url, credit: p.attribution || '',
                    licence: (p.license_code || '').toUpperCase()});

/** One usable photograph per species, in three tiers:
 *    1. the default photo, if its licence allows redistribution
 *    2. any other taxon photo that does           — free, same response
 *    3. a research-grade observation photo filtered by licence — one request
 *       per species, only for those still unresolved
 *  Tier 2 alone rescued 41 of 55 species on a test district, at no extra cost.
 */
async function fetchThumbs(rows, onProgress){
  const byId = new Map(INDEX.map(s => [s.id, s]));
  const ids = rows.map(r => byId.get(r[0])).filter(s => s && s.inat)
                  .map(s => [Number(s.inat), s.id]);
  const out = new Map();
  const unresolved = [];
  let done = 0;

  for (let i = 0; i < ids.length; i += THUMB_BATCH){
    const chunk = ids.slice(i, i + THUMB_BATCH);
    const url = `https://api.inaturalist.org/v1/taxa/${chunk.map(c => c[0]).join(',')}` +
                `?per_page=${THUMB_BATCH}`;
    try {
      const j = await fetch(url).then(r => r.json());
      const back = new Map(chunk);
      (j.results || []).forEach(t => {
        const sid = back.get(t.id);
        if (sid === undefined) return;
        const d = t.default_photo;
        if (d && d.square_url && usableLicence(d.license_code)){
          out.set(sid, pick(d));
          return;
        }
        const alt = (t.taxon_photos || []).map(x => x.photo)
          .find(p => p && (p.square_url || p.url) && usableLicence(p.license_code));
        if (alt) out.set(sid, pick(alt));
        else unresolved.push([t.id, sid]);
      });
    } catch (e){ /* skip this batch, keep the rest */ }
    done += chunk.length;
    onProgress(Math.min(done, rows.length));
  }

  // Tier 3: ask for observation photos that carry an acceptable licence.
  for (const [taxonId, sid] of unresolved){
    const u = `https://api.inaturalist.org/v1/observations?taxon_id=${taxonId}` +
              `&photo_license=${OBS_LICENCES}&photos=true&per_page=1&order_by=votes`;
    try {
      const j = await fetch(u).then(r => r.json());
      const p = ((j.results || [])[0] || {}).photos?.[0];
      if (p && usableLicence(p.license_code)) out.set(sid, pick(p));
    } catch (e){ /* leave it without a photograph */ }
  }
  return out;
}

/** Resolve once every <img> has loaded or failed — printing before they settle
 *  produces a PDF full of blank boxes. A few hundred thumbnails go through
 *  roughly six connections at a time, so this legitimately takes ~20s for a
 *  large district; the budget is generous and the caller shows progress. */
function imagesSettled(onProgress){
  const imgs = [...$('#report').querySelectorAll('img')];
  if (!imgs.length) return Promise.resolve();
  let done = 0;
  const tick = () => onProgress && onProgress(++done, imgs.length);
  return Promise.all(imgs.map(im => im.complete ? (tick(), null) : new Promise(res => {
    const fin = () => { tick(); res(); };
    im.addEventListener('load', fin, {once: true});
    im.addEventListener('error', () => { im.replaceWith(placeholder()); fin(); }, {once: true});
    setTimeout(res, 60000);
  })));
}
function placeholder(){
  const s = document.createElement('span');
  s.className = 'noimg';
  return s;
}


/* ── the map printed in the report ────────────────────────
 * Drawn as standalone SVG rather than snapshotting the live Leaflet view:
 * raster tiles are cross-origin and would either taint a canvas or print as
 * blank boxes, and an SVG stays crisp at print resolution.
 *
 * It carries a coastline for geographic context — a distribution map floating
 * on blank paper is unreadable — plus the region outline and the same heat
 * cells and colour ramp the screen map uses, so the two agree.
 */
let _rings = null, _borders = null, _india = null;
async function coastline(){
  if (_rings) return _rings;
  try {
    _rings = (await fetch('data/basemap.json', DATA_FETCH).then(r => r.json())).rings;
  } catch { _rings = []; }
  return _rings;
}
async function borders(){
  if (_borders) return _borders;
  try {
    _borders = (await fetch('data/borders.json', DATA_FETCH).then(r => r.json())).lines;
  } catch { _borders = []; }
  return _borders;
}
// India's official boundary (full claimed extent), drawn as an emphasised line
// over the reference ADM1 borders so the report maps show the same outline as
// the interactive map.
async function india(){
  if (_india) return _india;
  try {
    _india = (await fetch('data/india.json', DATA_FETCH).then(r => r.json())).lines;
  } catch { _india = []; }
  return _india;
}


/** Per-photograph credits. Every image in the report is an iNaturalist
 *  contributor's work under its own licence, and the report is a document
 *  people share — so the credits travel with it rather than living only in the
 *  web page it was generated from. */
function sectionCredits(rows, thumbs){
  const used = rows.map(r => [r, thumbs.get(r[0])]).filter(([, t]) => t && t.credit);
  if (!used.length) return '';
  return `<section class="rsec rcred">
    <h2>Photograph credits</h2>
    <p class="rlead">${fmt(used.length)} photographs, one per species, from
      iNaturalist. Only Creative Commons and public-domain images are used: where
      a species' main photograph is all-rights-reserved or No-Derivatives, an
      openly licensed alternative was searched for, and the species is left
      without a thumbnail only when none exists. Each photograph remains the
      property of its photographer under the licence shown; reuse is governed by
      that licence, not by this report.</p>
    <ul class="rcredlist">
      ${used.map(([r, t]) => `<li><i>${esc(r[2])}</i> — ${esc(t.credit)}${
          t.licence ? ` [${esc(t.licence)}]` : ''}</li>`).join('')}
    </ul>
  </section>`;
}

/** A small locator inset: the whole subcontinent drawn in a corner of the map,
 *  with a red square marking the bounding box of the area being reported. Same
 *  equirectangular projection maths as the maps it sits in. Placed bottom-left
 *  inside a WxH map SVG. `bbox` is [lon0,lat0,lon1,lat1] of the reported area. */
function locatorInset(rings, bbox, W, H){
  const IW = 96, IH = 108, PAD = 6, M = 8;               // inset size + page margin
  // subcontinent extent (matches the atlas P), a touch of padding
  const e0 = 60, e1 = 98, f0 = 5, f1 = 38;
  const k = Math.cos((f0 + f1) / 2 * Math.PI / 180);
  const s = Math.min((IW - PAD * 2) / ((e1 - e0) * k), (IH - PAD * 2) / (f1 - f0));
  const ox = PAD + ((IW - PAD * 2) - (e1 - e0) * k * s) / 2;
  const oy = PAD + ((IH - PAD * 2) - (f1 - f0) * s) / 2;
  const X = lon => (ox + (lon - e0) * k * s).toFixed(1);
  const Y = lat => (oy + (f1 - lat) * s).toFixed(1);
  const path = ring => 'M' + ring.map(p => X(p[0]) + ',' + Y(p[1])).join(' L') + 'Z';
  const inBox = r => r.some(p => p[0] > e0 - 4 && p[0] < e1 + 4 && p[1] > f0 - 4 && p[1] < f1 + 4);
  const land = (rings || []).filter(r => r.length > 2 && inBox(r)).map(path).join(' ');
  // the reported area's bbox as a red rectangle
  const bx = X(bbox[0]), by = Y(bbox[3]), bw = (X(bbox[2]) - X(bbox[0])).toFixed(1),
        bh = (Y(bbox[1]) - Y(bbox[3])).toFixed(1);
  const tx = W - IW - M, ty = H - IH - M;                // bottom-right corner
  return `<g transform="translate(${tx},${ty})">
    <rect width="${IW}" height="${IH}" fill="#FFFFFF" stroke="#C9C6BE" stroke-width=".8" rx="3"/>
    <path d="${land}" fill="#EDEAE3" stroke="#C9C6BE" stroke-width=".5"/>
    <rect x="${bx}" y="${by}" width="${Math.max(2.5, bw)}" height="${Math.max(2.5, bh)}"
      fill="#DC2626" fill-opacity=".22" stroke="#DC2626" stroke-width="1"/>
    <text x="${IW/2}" y="${IH-3}" text-anchor="middle" font-size="6" fill="#888"
      font-family="Sora,sans-serif">Indian subcontinent</text>
  </g>`;
}

function reportMapSVG(rings, rows){
  if (region && region.aoi) return aoiMapSVG(rings);   // aoi.js — outline, no heat grid
  if (!region || !region.cells || !region.cells.length) return '';
  const W = 560, H = 380, PAD = 14;

  // bounds from the region outline, padded a little
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  region.outline.forEach(r => r.forEach(p => {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }));
  const spanDeg = Math.max(x1 - x0, y1 - y0);   // region extent, before padding
  const mx = (x1 - x0) * 0.12 + 0.05, my = (y1 - y0) * 0.12 + 0.05;
  x0 -= mx; x1 += mx; y0 -= my; y1 += my;
  // equirectangular, longitude compressed by cos(lat) so shapes stay sane
  const k = Math.cos((y0 + y1) / 2 * Math.PI / 180);
  const sx = (W - PAD * 2) / ((x1 - x0) * k), sy = (H - PAD * 2) / (y1 - y0);
  const s = Math.min(sx, sy);
  const ox = PAD + ((W - PAD * 2) - (x1 - x0) * k * s) / 2;
  const oy = PAD + ((H - PAD * 2) - (y1 - y0) * s) / 2;
  const X = lon => (ox + (lon - x0) * k * s).toFixed(1);
  const Y = lat => (oy + (y1 - lat) * s).toFixed(1);

  // only the filtered species contribute, so the map matches the checklist
  const keep = new Set(rows.map(r => r[5] + '|' + (r[7] || 'DD')));
  // The stored grid is fine (adaptive per region); aggregate it to a display
  // cell that puts ~26 cells across the region, so a small district shows real
  // detail and a country stays legible.
  const factor = Math.max(1, Math.round((spanDeg / 26) / region.cell));
  const cellSize = region.cell * factor;
  const agg = new Map();
  region.cells.forEach(c => {
    let n = 0;
    for (const key in c.b) if (keep.has(key)) n += c.b[key];
    if (!n) return;
    const kx = Math.floor(c.k[0] / factor), ky = Math.floor(c.k[1] / factor);
    const id = kx + ',' + ky;
    const e = agg.get(id);
    if (e) e.n += n; else agg.set(id, {kx, ky, n});
  });
  const cells = [...agg.values()];
  if (!cells.length) return '';
  const breaks = heatBreaks(cells.map(c => c.n));

  const path = r => 'M' + r.map(p => X(p[0]) + ',' + Y(p[1])).join(' L') + 'Z';
  const inView = r => r.some(p => p[0] > x0 - 6 && p[0] < x1 + 6 &&
                                  p[1] > y0 - 6 && p[1] < y1 + 6);

  const land = (rings || []).filter(r => r.length > 2 && inView(r))
    .map(r => path(r)).join(' ');
  const borderSvg = (_borders || []).filter(r => r.length > 1 && inView(r))
    .map(r => `<path d="${path(r)}" fill="none" stroke="#C9C6BE" stroke-width=".5"/>`).join('');
  const indiaSvg = (_india || []).filter(r => r.length > 1 && inView(r))
    .map(r => `<path d="${path(r)}" fill="none" stroke="#6b5836" stroke-width="1"/>`).join('');

  const cellSvg = cells.map(c => {
    const lon = c.kx * cellSize, lat = c.ky * cellSize;
    const x = X(lon), y = Y(lat + cellSize);
    const w = (cellSize * k * s).toFixed(1), h = (cellSize * s).toFixed(1);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}"
      fill="${heatColour(c.n, breaks)}" fill-opacity=".85"/>`;
  }).join('');

  const outline = region.outline.map(r => path(r)).join(' ');
  let lo = 1;
  const legend = breaks.map((hi, i) => {
    const row = `<span><i style="background:${HEAT[HEAT.length - breaks.length + i]}"></i>` +
      `${lo === hi ? fmt(hi) : fmt(lo) + '–' + fmt(hi)}</span>`;
    lo = hi + 1;
    return row;
  }).join('');

  return `<section class="rmap">
    <h2>Occurrence density</h2>
    <svg viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Occurrence density of reptiles and amphibians in ${region.name}">
      <defs><clipPath id="rgnclip"><path d="${outline}"/></clipPath></defs>
      <rect width="${W}" height="${H}" fill="#F3F1EC"/>
      <path d="${land}" fill="#FFFFFF" stroke="#B9B5AC" stroke-width=".7"/>
      ${borderSvg}${indiaSvg}
      <g clip-path="url(#rgnclip)">${cellSvg}</g>
      <path d="${outline}" fill="none" stroke="#111" stroke-width="1.3"
            stroke-linejoin="round"/>
      ${locatorInset(rings, [x0, y0, x1, y1], W, H)}
    </svg>
    <div class="rmapleg"><span class="rmapttl">Records per ${cellSize.toFixed(2)}° cell</span>${legend}</div>
    <p class="rmapnote">Grid cells shaded by number of georeferenced occurrence
      records falling inside the ${LEVELS[region.lvl].toLowerCase()} boundary and
      <b>clipped to it</b> — a cell straddling the border is drawn only where it
      lies within the region. Cell size adapts to the region's extent. Coastline:
      Natural Earth. Cells follow the filters applied to this report.</p>
  </section>`;
}

function tally(rows, i){
  const c = new Map();
  rows.forEach(r => c.set(r[i], (c.get(r[i]) || 0) + 1));
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

function reportHTML(rows, thumbs, rings, restricted){
  const filtered = rows.length !== region.sp.length;
  const filterNote = [
    state.grp.size ? `groups: ${[...state.grp].join(', ')}` : '',
    state.iucn.size ? `status: ${[...state.iucn].map(k => IUNAME[k]).join(', ')}` : '',
    state.q ? `search: “${state.q}”` : '',
  ].filter(Boolean).join(' · ');

  const date = new Date().toLocaleDateString('en-IN',
    {year: 'numeric', month: 'long', day: 'numeric'});
  const byId = new Map(INDEX.map(s => [s.id, s]));

  const body = rows.map((r, i) => {
    const [id, n, sci, com, fam, grp, cls, iucn] = r;
    const t = thumbs.get(id);
    // species name and thumbnail link into Uraga (?sp=id) — clickable in the PDF
    return `<tr>
      <td class="rnum">${i + 1}</td>
      <td class="rimg">${t ? spLink(id, `<img src="${t.url}" alt="">`) : '<span class="noimg"></span>'}</td>
      <td>${spLink(id, `<i>${esc(sci)}</i>`)}<br><span class="rcom">${esc(com) || '—'}</span></td>
      <td>${esc(fam)}</td>
      <td><span class="rst rst-${iucn || 'DD'}">${iucn || 'DD'}</span> ${esc(IUNAME[iucn] || 'Data Deficient')}</td>
      <td class="rnumr">${fmt(n)}</td>
    </tr>`;
  }).join('');

  return `
  <header class="rhead">
    <div class="rbrand"><b>Uraga</b> Atlas</div>
    <h1>${esc(region.name)}</h1>
    <p class="rsub">${LEVELS[region.lvl]}${region.parent ? ' · ' + esc(region.parent) : ''} · ${esc(region.country)}</p>
    <p class="rsub">Reptile &amp; amphibian species checklist · generated ${date}</p>
  </header>

  <dl class="rstats">
    <div><dt>Species</dt><dd>${fmt(rows.length)}</dd></div>
    <div><dt>Occurrence records</dt><dd>${fmt(region.nrec)}</dd></div>
    <div><dt>Threatened (VU/EN/CR)</dt><dd>${fmt(rows.filter(r => ['VU','EN','CR'].includes(r[7])).length)}</dd></div>
    <div><dt>Families</dt><dd>${fmt(new Set(rows.map(r => r[4])).size)}</dd></div>
  </dl>

  ${filtered ? `<p class="rnote"><b>Filtered view.</b> This report covers ${fmt(rows.length)}
     of the ${fmt(region.sp.length)} species recorded in ${esc(region.name)} — ${esc(filterNote)}.</p>` : ''}

  <section class="rbreak">
    <h2>By group</h2>
    <ul class="rtags">${tally(rows, 5).map(([k, v]) =>
      `<li>${esc(k)} <b>${v}</b></li>`).join('')}</ul>
    <h2>By conservation status</h2>
    <ul class="rtags">${tally(rows, 7).map(([k, v]) =>
      `<li><span class="rst rst-${k || 'DD'}">${k || 'DD'}</span> ${esc(IUNAME[k] || 'Data Deficient')} <b>${v}</b></li>`).join('')}</ul>
  </section>

  ${sectionContext()}
  ${reportMapSVG(rings, rows)}
  ${sectionEffort(rows, byId)}
  ${sectionConcern(rows, byId)}
  ${sectionVenom(rows, byId)}
  ${restricted}
  ${sectionTrend(rows, byId)}
  ${sectionMolecular(rows, byId)}
  ${sectionSeason()}
  ${sectionTaxa(rows)}

  <h2 class="rlisth">Checklist</h2>
  <table class="rtable">
    <thead><tr><th>#</th><th></th><th>Species</th><th>Family</th><th>IUCN status</th><th>Records</th></tr></thead>
    <tbody>${body}</tbody>
  </table>

  ${sectionCredits(rows, thumbs)}

  <footer class="rfoot">
    <p><b>How to read this list.</b> A species appears here when at least one
    georeferenced occurrence record falls inside the boundary. Record counts
    reflect collecting and reporting effort, not abundance — a low count may
    mean a rare species or simply an under-surveyed area. Absence from this
    list is not evidence of absence in the field.</p>
    <p><b>Coordinate precision.</b> Many records carry deliberately obscured or
    rounded coordinates, particularly for threatened species. Assignments near
    a boundary should be treated as approximate, and this list should not be
    used to infer precise localities.</p>
    <p><b>Sources.</b> Occurrence records: GBIF. Conservation status: IUCN Red
    List. Photographs: iNaturalist contributors, each under its own licence.
    Administrative boundaries: geoBoundaries (CC BY 4.0). Generated by Uraga
    Atlas.</p>
  </footer>`;
}
