/* Per-species PDF export.
 *
 * Same print pipeline as the regional report (openReport → print stylesheet →
 * browser print-to-PDF), so one copy of the markup is both the on-screen sheet
 * and the PDF. Everything shown in the species record goes in: photographs, a
 * distribution map (occurrence points + IUCN range over a coastline), AI field
 * notes, traits, nomenclature, genetic resources and provenance.
 *
 * Reads what the open record already has in memory — `detail` (the per-species
 * JSON) and `live` (photos + occurrence points) — and fetches only the range
 * polygon and the coastline.
 */

/** Distribution map as standalone SVG (never a Leaflet snapshot — tiles are
 *  cross-origin). Frames the union of the range polygon and the points. */
function speciesMapSVG(sp, points, range, rings){
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const ext = (lon, lat) => { x0 = Math.min(x0, lon); x1 = Math.max(x1, lon);
                              y0 = Math.min(y0, lat); y1 = Math.max(y1, lat); };
  (points || []).forEach(p => ext(p.lon, p.lat));
  const geom = range && (range.geometry || range);
  const polys = geom ? (geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates]) : [];
  polys.forEach(poly => poly.forEach(ring => ring.forEach(pt => ext(pt[0], pt[1]))));
  if (x1 < x0) return '';   // no geography to draw

  const mx = (x1 - x0) * 0.12 + 0.1, my = (y1 - y0) * 0.12 + 0.1;
  x0 -= mx; x1 += mx; y0 -= my; y1 += my;
  const W = 560, H = 360, PAD = 14;
  const k = Math.cos((y0 + y1) / 2 * Math.PI / 180);
  const s = Math.min((W - PAD * 2) / ((x1 - x0) * k), (H - PAD * 2) / (y1 - y0));
  const ox = PAD + ((W - PAD * 2) - (x1 - x0) * k * s) / 2;
  const oy = PAD + ((H - PAD * 2) - (y1 - y0) * s) / 2;
  const X = lon => (ox + (lon - x0) * k * s).toFixed(1);
  const Y = lat => (oy + (y1 - lat) * s).toFixed(1);
  const path = r => 'M' + r.map(p => X(p[0]) + ',' + Y(p[1])).join(' L') + 'Z';
  const inView = r => r.some(p => p[0] > x0 - 6 && p[0] < x1 + 6 && p[1] > y0 - 6 && p[1] < y1 + 6);

  const land = (rings || []).filter(r => r.length > 2 && inView(r)).map(path).join(' ');
  const rangeSvg = polys.map(poly => poly.map(ring =>
    `<path d="${path(ring)}" fill="#38A169" fill-opacity=".16" stroke="#2F855A" stroke-width=".8"/>`
  ).join('')).join('');
  const ptsSvg = (points || []).map(p =>
    `<circle cx="${X(p.lon)}" cy="${Y(p.lat)}" r="1.8" fill="#DC2626" fill-opacity=".85"/>`).join('');
  const np = (points || []).length;

  return `<section class="rmap">
    <h2>Distribution</h2>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution of ${esc(sp.sci)}">
      <rect width="${W}" height="${H}" fill="#F3F1EC"/>
      <path d="${land}" fill="#FFFFFF" stroke="#C9C6BE" stroke-width=".8"/>
      ${rangeSvg}${ptsSvg}
      ${locatorInset(rings, [x0, y0, x1, y1], W, H)}
    </svg>
    <div class="rmapleg">
      ${geom ? '<span><i style="background:#38A169;opacity:.5"></i> IUCN range</span>' : ''}
      ${np ? '<span><i style="background:#DC2626;border-radius:50%"></i> Occurrence record</span>' : ''}
    </div>
    <p class="rmapnote">${geom ? 'IUCN range polygon (green)' : ''}${geom && np ? ', ' : ''}${
      np ? fmt(np) + ' georeferenced occurrence records (red, live from GBIF' +
           ((live && live.obis) ? ' + OBIS' : '') + ')' : ''}${
      !geom && !np ? 'No mapped range or georeferenced records for this species.' : ''}.
      Coastline: Natural Earth.</p>
  </section>`;
}

function speciesReportHTML(sp, d, got, range, rings, photos){
  const date = new Date().toLocaleDateString('en-IN', {year: 'numeric', month: 'long', day: 'numeric'});
  const lineage = (d && d.lineage || []).join(' · ');
  const iucn = (d && d.iucn) || sp.iucn || 'DD';
  const total = (got && got.total != null) ? got.total : sp.n;

  const heroCredits = photos.map(p => p.credit).filter(Boolean);

  // quick facts
  const trend = (sp.tr && sp.tr !== 'Unknown') ? sp.tr : (sp.tr || '—');
  const facts = [
    ['Occurrence records', fmt(total), 'GBIF, live'],
    ['IUCN status', IUNAME[iucn] || iucn, 'Red List'],
    ['Assessed', (d && d.yr) || sp.yr || '—', 'IUCN'],
    ['Population trend', trend, 'IUCN'],
    ['Region', (d && d.realm) || '—', 'IUCN realms'],
    ['Family', sp.fam || (d && d.fam) || '—', 'taxonomy'],
  ];

  // AI field notes, segmented like the app
  const aiSecs = (typeof SEGS !== 'undefined' ? SEGS : []).map(([name, keys]) => {
    const arts = keys.filter(f => d && d.ai && d.ai[f]).map(f =>
      `<article class="raicard"><h5>${AILAB[f] || f}</h5><p>${md(d.ai[f])}</p></article>`).join('');
    return arts ? `<h3 class="rsub2">${name}</h3>${arts}` : '';
  }).join('');

  const venom = d && d.venom;
  const g = sp.gen_;

  return `
  <header class="rhead">
    <div class="rbrand"><b>Uraga</b> Atlas</div>
    <h1>${esc(sp.sci)}</h1>
    <p class="rsub">${esc(sp.com || d && d.com || '')}</p>
    <p class="rsub">${esc(lineage)}</p>
    <p class="rsub"><span class="rst rst-${iucn}">${iucn}</span> ${IUNAME[iucn] || iucn} ·
      generated ${date}</p>
  </header>

  ${photos.length ? `<section class="rmap"><div class="spphotos">
      ${photos.slice(0, 6).map(p => `<img src="${p.url}" alt="">`).join('')}
    </div></section>` : ''}

  <dl class="rstats">
    ${facts.map(f => `<div><dt>${f[0]}</dt><dd style="font-size:12pt">${esc(String(f[1]))}</dd></div>`).join('')}
  </dl>

  ${speciesMapSVG(sp, got && got.points, range, rings)}

  ${(d && d.inatName && d.inatName !== sp.sci) ? `<section class="rsec">
    <h2>Nomenclature</h2>
    <p class="rlead"><i>${esc(sp.sci)}</i> — IUCN Red List. <i>${esc(d.inatName)}</i> — iNaturalist.
      Status and range on this page follow the IUCN name.</p></section>` : ''}

  ${venom ? `<section class="rsec">
    <h2>Venom</h2>
    <p class="rlead"><b>${esc(venom.l)}</b>${venom.s ? ' — ' + esc(venom.s) : ''}
      ${venom.c ? ` (recorded with <b>${esc(venom.c)}</b> confidence).` : '.'}
      Curated from published sources, never machine-generated. Field awareness
      only — <b>not medical guidance</b>.</p></section>` : ''}

  ${(d && d.hab && d.hab.length) ? `<section class="rsec">
    <h2>Habitat</h2>
    <ul class="rtags">${d.hab.map(h => `<li>${esc(h)}</li>`).join('')}</ul></section>` : ''}

  ${aiSecs ? `<section class="rsec">
    <h2>Field notes</h2>
    <p class="rnote">✦ Machine-generated and not reviewed by a specialist.</p>
    ${aiSecs}</section>` : ''}

  ${g ? `<section class="rsec">
    <h2>Genetic resources</h2>
    <dl class="rstats">
      <div><dt>GenBank sequences</dt><dd>${g.s > 0 ? fmt(g.s) : 'None'}</dd></div>
      <div><dt>DNA barcode (COI)</dt><dd>${g.c > 0 ? 'Yes · ' + fmt(g.c) : 'None'}</dd></div>
      <div><dt>Sequenced genome</dt><dd>${g.g > 0 ? fmt(g.g) : 'None'}</dd></div>
    </dl>
    <p class="rnote2">From NCBI GenBank (public domain). Full records:
      ${esc(sp.sci)} on <a href="${API.ncbiSeq(sp.sci)}">NCBI</a>.</p></section>` : ''}

  ${heroCredits.length ? `<section class="rsec rcred">
    <h2>Photograph credits</h2>
    <ul class="rcredlist">${photos.map(p =>
      `<li>${esc(p.credit)}${p.licence ? ` [${esc(p.licence)}]` : ''}</li>`).join('')}</ul>
  </section>` : ''}

  <footer class="rfoot">
    <p><b>Sources.</b> Conservation status, assessment, population trend, region
      and habitat: IUCN Red List. Occurrence records: GBIF${(live && live.obis) ? ' and OBIS' : ''}.
      Range polygon: IUCN. Photographs: iNaturalist contributors, each under its
      own licence. Genetic-resource counts: NCBI (public domain). Field notes are
      machine-generated and unverified.</p>
    <p><b>Occurrence caveat.</b> Record counts reflect collecting effort, not
      abundance; many carry obscured or rounded coordinates. Absence of records
      is not evidence of absence.</p>
  </footer>`;
}

async function makeSpeciesReport(sp, btn){
  const label = btn ? btn.textContent : '';
  if (btn){ btn.disabled = true; btn.textContent = 'Preparing…'; }

  // the record is open, so `detail` and `live` are already in memory
  const d = (typeof detail !== 'undefined') ? detail : null;
  const got = (typeof live !== 'undefined') ? live : null;

  let range = null;
  if (sp.rng){
    try { range = await fetch(`data/ranges/${sp.id}.geojson`, DATA_FETCH).then(r => r.json()); }
    catch (e){ /* no range: the map falls back to points only */ }
  }
  const rings = await coastline();
  const photos = ((got && got.photos) || []).filter(p => usableLicence(p.licence));

  openReport(speciesReportHTML(sp, d, got, range, rings, photos), sp.sci);
  setPageFurniture(sp.sci);           // running head shows the species
  await imagesSettled();
  if (btn){ btn.disabled = false; btn.textContent = label; }
}
