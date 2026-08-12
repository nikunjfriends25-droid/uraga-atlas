/* Area of interest — draw a polygon on the map or upload a GeoJSON/KML, then
 * scope the atlas (and export a report) to whatever species GBIF has
 * georeferenced inside that boundary.
 *
 * How the species list is found: GBIF's occurrence search takes a polygon as
 * WKT and can facet by speciesKey. We restrict to the four herp classes
 * (Amphibia, Squamata, Testudines, Crocodylia) and intersect the returned
 * speciesKeys with our own `gbif` keys — which ARE GBIF speciesKeys, so the
 * match is exact. Anything GBIF returns that isn't in our checklist is a newer
 * split or an out-of-region taxon, and is correctly left out.
 *
 * The result is dropped into the same `region` object the country→district
 * reports use (with `aoi:true` and no precomputed heat grid), so the existing
 * report pipeline renders it unchanged apart from the map section.
 */
(function () {
  const HERP_CLASSES = [131, 11592253, 11418114, 11493978];   // Amphibia, Squamata, Testudines, Crocodylia
  const GBIF = 'https://api.gbif.org/v1/occurrence/search';

  let drawing = false;
  let pts = [];                 // in-progress vertices, Leaflet [lat,lng]
  const tmp = L.layerGroup();   // vertices + rubber-band line while drawing

  // ---- geometry helpers -------------------------------------------------
  const ringCCW = r => {        // shoelace; positive area ⇒ counter-clockwise
    let a = 0;
    for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    return a > 0;
  };
  const thin = (r, max = 480) => {   // GBIF rejects very dense polygons
    if (r.length <= max) return r;
    const step = Math.ceil(r.length / max);
    const out = r.filter((_, i) => i % step === 0);
    out.push(r[r.length - 1]);
    return out;
  };
  const bboxArea = r => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    r.forEach(p => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
    return (x1 - x0) * (y1 - y0);
  };
  // one polygon element: CCW, closed, thinned → "((lon lat,…))"
  function ringWKT(ring, maxPts) {
    let r = thin(ring.slice(), maxPts);
    const f = r[0], l = r[r.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) r = r.concat([f]);
    if (!ringCCW(r)) r = r.slice().reverse();
    return '((' + r.map(p => p[0].toFixed(5) + ' ' + p[1].toFixed(5)).join(',') + '))';
  }
  // Build a single WKT for all rings. GBIF accepts one MULTIPOLYGON, so a
  // many-part shapefile is one request. Vertex-budgeted (largest parts first).
  function aoiWKT(rings) {
    const budget = 2500;
    const sized = rings.map(r => ({ r, a: bboxArea(r) })).sort((a, b) => b.a - a.a);
    let used = 0; const parts = [];
    for (const { r } of sized) {
      const mp = Math.min(200, r.length);
      if (used + mp > budget && parts.length) break;
      used += mp; parts.push(ringWKT(r, mp));
    }
    return parts.length > 1 ? `MULTIPOLYGON(${parts.join(',')})` : `POLYGON${parts[0]}`;
  }
  function bboxWKT(rings) {                 // fallback if the full geometry is rejected
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    rings.forEach(r => r.forEach(p => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }));
    return `POLYGON((${x0} ${y0},${x1} ${y0},${x1} ${y1},${x0} ${y1},${x0} ${y0}))`;
  }

  // ---- GBIF ------------------------------------------------------------
  function facetURL(wkt) {
    const q = new URLSearchParams();
    q.set('geometry', wkt); q.set('facet', 'speciesKey');
    q.set('facetLimit', '1000'); q.set('limit', '0'); q.set('hasCoordinate', 'true');
    HERP_CLASSES.forEach(c => q.append('classKey', c));
    return `${GBIF}?${q}`;
  }
  async function speciesInAOI(rings) {
    let r;
    try {
      r = await fetch(facetURL(aoiWKT(rings))).then(x => { if (!x.ok) throw new Error('GBIF ' + x.status); return x.json(); });
    } catch (e) {                          // polygon too large/complex → bounding box
      r = await fetch(facetURL(bboxWKT(rings))).then(x => x.json());
    }
    const counts = new Map();
    ((r.facets && r.facets[0] && r.facets[0].counts) || []).forEach(c => counts.set(+c.name, c.count));
    return counts;
  }

  // ---- shapefile (.shp) polygon reader + reprojection ------------------
  function parseSHP(u8) {                   // returns rings in the file's own CRS
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const rings = []; let off = 100;        // skip 100-byte header
    while (off + 8 <= dv.byteLength) {
      const contentLen = dv.getInt32(off + 4, false);   // 16-bit words, big-endian
      let p = off + 8;
      const t = dv.getInt32(p, true); p += 4;
      if (t === 5 || t === 15 || t === 25) {            // Polygon / PolygonZ / PolygonM
        p += 32;                                        // bbox (4 doubles)
        const nP = dv.getInt32(p, true); p += 4;
        const nPt = dv.getInt32(p, true); p += 4;
        const parts = []; for (let i = 0; i < nP; i++) { parts.push(dv.getInt32(p, true)); p += 4; }
        const pts = []; for (let i = 0; i < nPt; i++) { pts.push([dv.getFloat64(p, true), dv.getFloat64(p + 8, true)]); p += 16; }
        for (let i = 0; i < nP; i++) rings.push(pts.slice(parts[i], i + 1 < nP ? parts[i + 1] : nPt));
      }
      off += 8 + contentLen * 2;
    }
    return rings;
  }
  function reproject(rings, prj) {          // .prj WKT → lon/lat (only if projected)
    if (!prj || !/PROJCS/.test(prj) || typeof proj4 === 'undefined') return rings;
    return rings.map(r => r.map(xy => { const ll = proj4(prj, proj4.WGS84, xy); return [ll[0], ll[1]]; }));
  }

  // rows shaped exactly like region.sp: [id, n, sci, com, fam, grp, cls, iucn]
  function aoiRows(counts) {
    const byKey = new Map(INDEX.map(s => [s.gbif, s]));
    const rows = [];
    counts.forEach((n, key) => {
      const s = byKey.get(key);
      if (s) rows.push([s.id, n, s.sci, s.com, s.fam, s.grp, (s.lin && s.lin[0]) || '', s.iucn]);
    });
    rows.sort((a, b) => b[1] - a[1]);
    return rows;
  }

  // ---- apply an AOI ----------------------------------------------------
  async function applyAOI(rings, name) {
    rings = rings.filter(r => r && r.length >= 3);
    if (!rings.length) { alert('That file has no usable polygon.'); return; }
    status('Querying GBIF for species in the area…');
    exportBtn.disabled = true;
    let counts;
    try {
      counts = await speciesInAOI(rings);
    } catch (e) {
      status('GBIF request failed: ' + e.message, true); return;
    }
    const rows = aoiRows(counts);
    if (!rows.length) { status('No reptile or amphibian records found in that area.', true); return; }

    region = {
      aoi: true, name: name, lvl: 'aoi', parent: '', country: 'User-defined boundary',
      outline: rings.map(r => (r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) ? r : r.concat([r[0]])),
      sp: rows,
      nrec: [...counts.values()].reduce((a, b) => a + b, 0),
      cells: null, cell: 0,
    };
    regionIds = new Set(rows.map(r => r[0]));
    rsel.fill(null);                 // the region dropdowns no longer describe the scope
    render();
    drawRegion();                    // amber outline via the shared region layer
    zoomToRegion();
    if (typeof paintRegionPanel === 'function') paintRegionPanel();
    status(`${fmt(rows.length)} species · ${fmt(region.nrec)} records in “${name}”.`);
    exportBtn.disabled = false;
    clearBtn.hidden = false;
  }

  // ---- drawing on the map ---------------------------------------------
  function redraw() {
    tmp.clearLayers();
    if (pts.length) L.polyline(pts, { color: '#F59E0B', weight: 2, dashArray: '5,4' }).addTo(tmp);
    pts.forEach(p => L.circleMarker(p, { radius: 4, color: '#B45309', fillColor: '#F59E0B', fillOpacity: 1, weight: 1.5 }).addTo(tmp));
  }
  function onClick(e) { pts.push([e.latlng.lat, e.latlng.lng]); redraw(); finishBtn.disabled = pts.length < 3; }
  function startDraw() {
    if (drawing) return;
    drawing = true; pts = [];
    // hide the corpus heat grid so the new outline is unobstructed (stays hidden
    // across zoom/pan via the __aoiDrawing guard in app.js drawMap)
    window.__aoiDrawing = true;
    if (typeof pointLayer !== 'undefined') pointLayer.clearLayers();
    if (typeof clusterLayer !== 'undefined') clusterLayer.clearLayers();
    tmp.addTo(map);
    map.doubleClickZoom.disable();
    map.getContainer().style.cursor = 'crosshair';
    map.on('click', onClick);
    map.on('dblclick', finishDraw);
    drawBtn.hidden = true; finishBtn.hidden = false; cancelBtn.hidden = false; finishBtn.disabled = true;
    status('Click to add points; double-click or “Finish” to close the shape.');
  }
  function endDraw() {
    drawing = false;
    window.__aoiDrawing = false;
    map.off('click', onClick); map.off('dblclick', finishDraw);
    map.doubleClickZoom.enable();
    map.getContainer().style.cursor = '';
    tmp.clearLayers(); map.removeLayer(tmp);
    drawBtn.hidden = false; finishBtn.hidden = true; cancelBtn.hidden = true;
  }
  function finishDraw() {
    if (pts.length < 3) return;
    const ring = pts.map(p => [p[1], p[0]]);   // [lat,lng] → [lon,lat]
    endDraw();
    applyAOI([ring], 'Drawn area');
  }
  function cancelDraw() { endDraw(); if (typeof drawMap === 'function') drawMap(); status(''); }

  // ---- file upload -----------------------------------------------------
  function ringsFromGeoJSON(obj) {
    const out = [];
    const add = g => {
      if (!g) return;
      if (g.type === 'Polygon') out.push(g.coordinates[0]);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => out.push(p[0]));
      else if (g.type === 'GeometryCollection') g.geometries.forEach(add);
    };
    if (obj.type === 'FeatureCollection') obj.features.forEach(f => add(f.geometry));
    else if (obj.type === 'Feature') add(obj.geometry);
    else add(obj);
    return out.map(r => r.map(p => [+p[0], +p[1]]));
  }
  function ringsFromKML(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    return [...doc.getElementsByTagName('Polygon')].map(poly => {
      const outer = poly.getElementsByTagName('outerBoundaryIs')[0] || poly;
      const c = outer.getElementsByTagName('coordinates')[0];
      if (!c) return null;
      return c.textContent.trim().split(/\s+/).map(t => {
        const [lon, lat] = t.split(',').map(Number);
        return [lon, lat];
      });
    }).filter(Boolean);
  }
  function fromZip(buf, base) {             // KMZ or zipped shapefile
    if (typeof fflate === 'undefined') { status('Unzip library not loaded.', true); return; }
    let files;
    try { files = fflate.unzipSync(new Uint8Array(buf)); }
    catch (err) { status('Could not open the archive: ' + err.message, true); return; }
    const names = Object.keys(files);
    const dec = u8 => new TextDecoder().decode(u8);
    const kml = names.find(n => /\.kml$/i.test(n));
    const shp = names.find(n => /\.shp$/i.test(n));
    let rings;
    if (kml) rings = ringsFromKML(dec(files[kml]));
    else if (shp) {
      const prjName = names.find(n => /\.prj$/i.test(n));
      rings = reproject(parseSHP(files[shp]), prjName ? dec(files[prjName]) : '');
    } else { status('The archive has no .kml or .shp inside.', true); return; }
    if (!rings || !rings.length) { status('No polygon found in the archive.', true); return; }
    applyAOI(rings, base);
  }
  function onFile(e) {
    const f = e.target.files[0];
    e.target.value = '';                  // allow re-selecting the same file
    if (!f) return;
    const base = f.name.replace(/\.[^.]+$/, '');
    const lower = f.name.toLowerCase();
    const reader = new FileReader();
    if (lower.endsWith('.kmz') || lower.endsWith('.zip')) {
      reader.onload = () => fromZip(reader.result, base);
      reader.readAsArrayBuffer(f);
      return;
    }
    reader.onload = () => {
      try {
        const rings = lower.endsWith('.kml')
          ? ringsFromKML(reader.result)
          : ringsFromGeoJSON(JSON.parse(reader.result));
        if (!rings.length) { status('No polygon found in that file.', true); return; }
        applyAOI(rings, base);
      } catch (err) { status('Could not read that file: ' + err.message, true); }
    };
    reader.readAsText(f);
  }

  function clearAOI() {
    if (drawing) endDraw();
    if (typeof clearRegion === 'function') clearRegion();
    if (typeof paintRegionPanel === 'function') paintRegionPanel();
    exportBtn.disabled = true; clearBtn.hidden = true;
    status('');
  }

  // ---- UI --------------------------------------------------------------
  const box = document.getElementById('aoibox');
  let statusEl, drawBtn, finishBtn, cancelBtn, uploadInput, exportBtn, clearBtn;
  function status(msg, warn) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('warn', !!warn);
    statusEl.hidden = !msg;
  }
  function build() {
    if (!box) return;
    box.innerHTML = `
      <div class="aoihead">Area of interest</div>
      <p class="aoihint">Draw a boundary or upload a GeoJSON, KML, KMZ or zipped
        shapefile to list every reptile and amphibian GBIF has recorded inside it —
        then export its report.</p>
      <div class="aoibtns">
        <button class="aoibtn" id="aoiDraw">✎ Draw polygon</button>
        <button class="aoibtn" id="aoiUpload">↥ Upload file</button>
        <button class="aoibtn primary" id="aoiFinish" hidden>Finish</button>
        <button class="aoibtn" id="aoiCancel" hidden>Cancel</button>
        <input type="file" id="aoiFile" accept=".geojson,.json,.kml,.kmz,.zip" hidden>
      </div>
      <div class="aoistatus" id="aoiStatus" hidden></div>
      <div class="aoibtns">
        <button class="rgnpdf" id="aoiExport" disabled>Export AOI report</button>
        <button class="reset" id="aoiClear" hidden>Clear</button>
      </div>`;
    statusEl = box.querySelector('#aoiStatus');
    drawBtn = box.querySelector('#aoiDraw');
    finishBtn = box.querySelector('#aoiFinish');
    cancelBtn = box.querySelector('#aoiCancel');
    uploadInput = box.querySelector('#aoiFile');
    exportBtn = box.querySelector('#aoiExport');
    clearBtn = box.querySelector('#aoiClear');
    drawBtn.onclick = startDraw;
    finishBtn.onclick = finishDraw;
    cancelBtn.onclick = cancelDraw;
    box.querySelector('#aoiUpload').onclick = () => uploadInput.click();
    uploadInput.onchange = onFile;
    exportBtn.onclick = () => makeReport(exportBtn);
    clearBtn.onclick = clearAOI;
    addEventListener('keydown', e => { if (e.key === 'Escape' && drawing) cancelDraw(); });
  }
  build();
})();

/* AOI report map: the outline over coastline + borders, no heat grid (GBIF
 * facets give species counts, not geographic bins). Defined here so report.js
 * carries only the one-line branch that calls it. */
function aoiMapSVG(rings) {
  const W = 560, H = 380, PAD = 14;
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  region.outline.forEach(r => r.forEach(p => {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }));
  const mx = (x1 - x0) * 0.14 + 0.06, my = (y1 - y0) * 0.14 + 0.06;
  x0 -= mx; x1 += mx; y0 -= my; y1 += my;
  const k = Math.cos((y0 + y1) / 2 * Math.PI / 180);
  const s = Math.min((W - PAD * 2) / ((x1 - x0) * k), (H - PAD * 2) / (y1 - y0));
  const ox = PAD + ((W - PAD * 2) - (x1 - x0) * k * s) / 2;
  const oy = PAD + ((H - PAD * 2) - (y1 - y0) * s) / 2;
  const X = lon => (ox + (lon - x0) * k * s).toFixed(1);
  const Y = lat => (oy + (y1 - lat) * s).toFixed(1);
  const path = r => 'M' + r.map(p => X(p[0]) + ',' + Y(p[1])).join(' L') + 'Z';
  const inView = r => r.some(p => p[0] > x0 - 6 && p[0] < x1 + 6 && p[1] > y0 - 6 && p[1] < y1 + 6);

  const land = (rings || []).filter(r => r.length > 2 && inView(r)).map(path).join(' ');
  const borderSvg = (typeof _borders !== 'undefined' && _borders ? _borders : [])
    .filter(r => r.length > 1 && inView(r))
    .map(r => `<path d="${path(r)}" fill="none" stroke="#C9C6BE" stroke-width=".5"/>`).join('');
  const indiaSvg = (typeof _india !== 'undefined' && _india ? _india : [])
    .filter(r => r.length > 1 && inView(r))
    .map(r => `<path d="${path(r)}" fill="none" stroke="#6b5836" stroke-width="1"/>`).join('');
  const outline = region.outline.map(path).join(' ');

  return `<section class="rmap">
    <h2>Area of interest</h2>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="The reported area of interest">
      <rect width="${W}" height="${H}" fill="#F3F1EC"/>
      <path d="${land}" fill="#FFFFFF" stroke="#B9B5AC" stroke-width=".7"/>
      ${borderSvg}${indiaSvg}
      <path d="${outline}" fill="#F59E0B" fill-opacity=".1" stroke="#B45309" stroke-width="1.5"
            stroke-linejoin="round"/>
      ${locatorInset(rings, [x0, y0, x1, y1], W, H)}
    </svg>
    <p class="rmapnote">The checklist covers every reptile and amphibian with at least
      one georeferenced GBIF record inside this boundary. Occurrence density is not
      gridded for a custom area. Coastline: Natural Earth; India boundary official.</p>
  </section>`;
}
