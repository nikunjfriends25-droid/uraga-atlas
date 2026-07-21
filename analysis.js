/* Analytical sections of the regional report.
 *
 * Everything here is derived from data we already hold — no extra pipeline.
 * Where a figure is an estimate or rests on an assumption, the report says so
 * on the page itself: a regional checklist gets used for real decisions and
 * must not imply more certainty than the records support.
 */

let SPREAD = null;
async function spread(){
  if (SPREAD) return SPREAD;
  try { SPREAD = await fetch(RGN + 'spread.json', DATA_FETCH).then(r => r.json()); }
  catch { SPREAD = {}; }
  return SPREAD;
}

const esc = s => String(s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

/** Chao1, bias-corrected. The species known from exactly one or two records
 *  carry the information about how much of the fauna is still unseen. */
function chao1(counts){
  const S = counts.length;
  const f1 = counts.filter(n => n === 1).length;
  const f2 = counts.filter(n => n === 2).length;
  return {S, f1, f2, est: Math.round(S + (f1 * (f1 - 1)) / (2 * (f2 + 1)))};
}

/** A column chart as SVG rather than flexed divs.
 *
 *  The div version overflowed: `white-space:nowrap` on the labels stopped the
 *  flex items shrinking, so twelve 90px columns ran off a 491px sheet. SVG
 *  gives exact control and prints crisply at any DPI.
 *
 *  The scale stays LINEAR — a log or sqrt axis would make the 20th century
 *  look comparable to the 2020s, which is the opposite of true. Instead every
 *  non-zero value gets a minimum visible sliver and its own printed number, so
 *  small bars stay readable without distorting the shape.
 */
function barChart(pairs, opt){
  opt = opt || {};
  // The SVG is scaled to fit the sheet (560 units -> ~480px, and less again in
  // print), so type must be sized in user units generously or it lands at 7px.
  // Geometry is deliberately roomy: the previous version gave the plot 96 units
  // inside a 140-unit box, which left the max label colliding with the heading.
  const W = 560, n = pairs.length;
  if (!n) return '';
  const T = 26, B = 34, L = 10, R = 10;
  const plot = opt.plot || 108;
  const H = T + plot + B;
  const max = Math.max(1, ...pairs.map(p => p[1]));
  const bw = (W - L - R) / n;
  const base = T + plot;

  // draw a label only if it fits, else every k-th, so an axis degrades to
  // fewer labels instead of overlapping into mush
  // 8.8 units per character is measured, not guessed: at 7.2 the 13-label
  // decade axis still overlapped in 8 places
  const widest = Math.max(...pairs.map(p => String(p[0]).length)) * 8.8 + 6;
  const every = Math.max(1, Math.ceil(widest / bw));
  const showVals = bw >= 30;

  const body = pairs.map(([label, v], i) => {
    const w = Math.min(bw * 0.66, 46);
    const x = L + i * bw + (bw - w) / 2;
    // cap the tallest bar below the gridline so its value label has room
    const h = v ? Math.max(2, (plot - 14) * v / max) : 0;
    const y = base - h;
    const showLabel = i % every === 0 || i === n - 1;
    return `${v ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}"
        height="${h.toFixed(1)}" fill="${opt.colour || '#D97706'}" rx="1.5"/>` : ''}
      ${showVals && v ? `<text x="${(x + w / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}"
        text-anchor="middle" class="cval">${fmt(v)}</text>` : ''}
      ${showLabel ? `<text x="${(x + w / 2).toFixed(1)}" y="${(base + 20).toFixed(1)}"
        text-anchor="middle" class="clab${v ? '' : ' cdim'}">${label}</text>` : ''}`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${opt.alt || 'Column chart'}">
    <line x1="${L}" y1="${T}" x2="${W - R}" y2="${T}" class="cgrid"/>
    <text x="${L}" y="${T - 7}" class="cmax">${fmt(max)}</text>
    ${body}
    <line x1="${L}" y1="${base}" x2="${W - R}" y2="${base}" class="caxis"/>
  </svg>`;
}

/** Fill gaps so a time axis is continuous. A decade with no records must read
 *  as an explicit zero, not vanish and make the axis lie about elapsed time. */
function fillDecades(dec){
  const ys = Object.keys(dec).map(Number).sort((a, b) => a - b);
  if (!ys.length) return [];
  const out = [];
  for (let y = ys[0]; y <= ys[ys.length - 1]; y += 10){
    out.push([`${y}s`, dec[y] || 0]);
  }
  return out;
}

function sectionVenom(rows, byId){
  const ven = rows.map(r => [r, byId.get(r[0])]).filter(([, sp]) => sp && sp.ven)
                  .sort((a, b) => a[0][2].localeCompare(b[0][2]));
  if (!ven.length) return '';
  return `<section class="rsec">
    <h2>Venomous species of medical importance</h2>
    <p class="rlead">Recorded in this region. Venom information is curated from
      published sources and is never machine-generated. This is a field
      awareness aid and <b>not medical guidance</b> — suspected envenomation
      needs immediate hospital treatment and the appropriate antivenom.</p>
    <table class="rtable"><thead><tr><th>Species</th><th>Common name</th>
      <th>Venom</th><th>Records</th></tr></thead><tbody>
      ${ven.map(([r, sp]) => `<tr><td><i>${esc(r[2])}</i></td>
        <td>${esc(r[3]) || '—'}</td><td>${esc(sp.ven)}</td>
        <td class="rnumr">${fmt(r[1])}</td></tr>`).join('')}
    </tbody></table></section>`;
}

function sectionConcern(rows, byId){
  const rank = {CR: 0, EN: 1, VU: 2};
  const t = rows.filter(r => r[7] in rank)
    .sort((a, b) => rank[a[7]] - rank[b[7]] || a[2].localeCompare(b[2]));
  if (!t.length) return `<section class="rsec">
    <h2>Species of conservation concern</h2>
    <p class="rlead">No Vulnerable, Endangered or Critically Endangered species
      are recorded in this region.</p></section>`;
  return `<section class="rsec">
    <h2>Species of conservation concern</h2>
    <p class="rlead">${fmt(t.length)} of the ${fmt(rows.length)} species here are
      assessed as threatened. Record counts reflect survey effort, not abundance.</p>
    <table class="rtable"><thead><tr><th>Status</th><th>Species</th>
      <th>Common name</th><th>Assessed</th><th>Records</th></tr></thead><tbody>
      ${t.map(r => { const sp = byId.get(r[0]) || {};
        return `<tr><td><span class="rst rst-${r[7]}">${r[7]}</span></td>
          <td><i>${esc(r[2])}</i></td><td>${esc(r[3]) || '—'}</td>
          <td class="rnum">${sp.yr || '—'}</td>
          <td class="rnumr">${fmt(r[1])}</td></tr>`; }).join('')}
    </tbody></table></section>`;
}

function sectionEffort(rows, byId){
  const counts = rows.map(r => r[1]).sort((a, b) => a - b);
  const c = chao1(counts);
  const med = counts[Math.floor(counts.length / 2)];
  const thin = counts.filter(n => n < 5).length;
  const withRange = rows.filter(r => (byId.get(r[0]) || {}).rng).length;
  const stale = rows.filter(r => { const y = (byId.get(r[0]) || {}).yr; return y && y < 2010; }).length;
  const unseen = Math.max(0, c.est - c.S);
  const dec = region.dec || {};
  const years = Object.keys(dec).map(Number).sort((a, b) => a - b);
  const dated = Object.values(dec).reduce((a, b) => a + b, 0);

  return `<section class="rsec">
    <h2>Survey effort and data quality</h2>
    <dl class="rstats">
      <div><dt>Median records / species</dt><dd>${fmt(med)}</dd></div>
      <div><dt>Species under 5 records</dt><dd>${fmt(thin)}</dd></div>
      <div><dt>Estimated true richness</dt><dd>${fmt(c.est)}</dd></div>
      <div><dt>Have an IUCN range map</dt><dd>${fmt(withRange)}</dd></div>
    </dl>
    <p class="rlead"><b>How complete is this list?</b> ${fmt(c.f1)} species are known
      here from a single record and ${fmt(c.f2)} from exactly two. The Chao1
      estimator puts likely true richness near <b>${fmt(c.est)}</b> species —
      about <b>${fmt(unseen)}</b> more than the ${fmt(c.S)} actually recorded.
      This is a statistical estimate from the shape of the record counts, not a
      prediction of which species are missing, and it assumes reasonably even
      sampling, which is rarely true in practice. Read it as a measure of how
      much survey effort is still outstanding.</p>
    ${stale ? `<p class="rlead">${fmt(stale)} species carry a Red List assessment
      predating 2010, so their status may not reflect current conditions.</p>` : ''}
    ${years.length ? `<h3 class="rsub2">Records by decade</h3>
      ${barChart(fillDecades(dec), {alt: 'Occurrence records per decade'})}
      <p class="rnote2">${fmt(dated)} of ${fmt(region.nrec)} records carry a usable
        date. Linear scale — decades with no records are shown as gaps at zero.</p>`
      : ''}
  </section>`;
}

function sectionSeason(){
  const mon = region.mon || {};
  const total = Object.values(mon).reduce((a, b) => a + b, 0);
  if (!total) return '';
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const peak = M[+Object.entries(mon).sort((a, b) => b[1] - a[1])[0][0] - 1];
  return `<section class="rsec">
    <h2>When records were made</h2>
    ${barChart(M.map((m, i) => [m, mon[i + 1] || 0]),
        {alt: 'Occurrence records by month of year'})}
    <p class="rnote2">Recording peaks in <b>${peak}</b>. This reflects when people
      went looking as much as when animals were active — useful for planning
      fieldwork, not for inferring phenology.</p>
  </section>`;
}

async function sectionRestricted(rows){
  const sp = await spread();
  if (!Object.keys(sp).length) return '';
  const r = rows.map(x => [x, sp[x[0]] || 0]).filter(([, n]) => n && n <= 3)
    .sort((a, b) => a[1] - b[1] || a[0][2].localeCompare(b[0][2]));
  if (!r.length) return '';
  return `<section class="rsec">
    <h2>Restricted-range species</h2>
    <p class="rlead">Known from three or fewer districts across the whole atlas,
      so this region holds a disproportionate share of their recorded range.
      Based on where records exist, which is not the same as where the species
      occurs — under-surveyed species will appear more restricted than they are.</p>
    <table class="rtable"><thead><tr><th>Species</th><th>Common name</th>
      <th>Status</th><th>Districts</th></tr></thead><tbody>
      ${r.map(([x, n]) => `<tr><td><i>${esc(x[2])}</i></td><td>${esc(x[3]) || '—'}</td>
        <td><span class="rst rst-${x[7] || 'DD'}">${x[7] || 'DD'}</span></td>
        <td class="rnumr">${n}</td></tr>`).join('')}
    </tbody></table></section>`;
}

function sectionTaxa(rows){
  const fam = tally(rows, 4);
  const gen = new Set(rows.map(r => r[2].split(' ')[0]));
  return `<section class="rsec">
    <h2>Taxonomic profile</h2>
    <p class="rlead">${fmt(fam.length)} families and ${fmt(gen.size)} genera.</p>
    <ul class="rtags">${fam.map(([k, v]) => `<li>${esc(k)} <b>${v}</b></li>`).join('')}</ul>
  </section>`;
}

function sectionTrend(rows, byId){
  const c = new Map();
  rows.forEach(r => { const t = (byId.get(r[0]) || {}).tr || 'Unknown';
    c.set(t, (c.get(t) || 0) + 1); });
  const t = [...c.entries()].sort((a, b) => b[1] - a[1]);
  if (!t.some(([k]) => k !== 'Unknown')) return '';
  const dec = c.get('Decreasing') || 0;
  return `<section class="rsec">
    <h2>Population trend</h2>
    <p class="rlead">IUCN population trend for the species recorded here.
      ${dec ? `<b>${fmt(dec)}</b> are assessed as decreasing.` : ''}</p>
    <ul class="rtags">${t.map(([k, v]) => `<li>${esc(k)} <b>${v}</b></li>`).join('')}</ul>
  </section>`;
}

function sectionContext(){
  if (!region.parentCode || !rIndex) return '';
  const p = byCode(region.parentCode);
  if (!p) return '';
  const pct = Math.round(100 * region.sp.length / Math.max(1, p.ns));
  return `<p class="rnote"><b>In context.</b> ${esc(region.name)} holds
    ${fmt(region.sp.length)} of the ${fmt(p.ns)} species recorded in
    ${esc(p.n)} (${pct}%).</p>`;
}
