"""Assign every occurrence point to a state / district / sub-district, so the
dashboard can produce a species checklist for any administrative region.

Boundaries come from geoBoundaries (gbOpen, CC BY 4.0 — redistributable, unlike
GADM). Point-in-polygon runs here, once, not in the browser: the dashboard only
ever loads a precomputed species list.

  data/regions/index.json    every region — code, name, level, parent, counts
  data/regions/<code>.json   species list for that region + a simplified outline

Usage:
  python tools/build_regions.py --db "path/to/species.db" --out dashboard/data
"""
import argparse
import collections
import json
import os
import sqlite3
import urllib.request

import numpy as np
from shapely import STRtree, points as shp_points
from shapely.geometry import shape

# The subcontinent, as used everywhere else in this project.
# Pakistan is deliberately absent: its boundary set carries the disputed
# Kashmir units (Azad Kashmir, Gilgit-Baltistan and their districts), which
# geoBoundaries also places inside India's claimed ADM0 outline, so they were
# surfacing as Indian states and districts. Occurrence records from Pakistan
# are still counted in the corpus map — only the region selector drops it.
COUNTRIES = {'IND': 'India', 'LKA': 'Sri Lanka', 'NPL': 'Nepal',
             'BTN': 'Bhutan', 'BGD': 'Bangladesh'}
# geoBoundaries placeholders, not real administrative units. Their records are
# still counted by whichever real region contains them.
EXCLUDE_NAMES = {'data not available', 'disputed territory', 'not available',
                 'unknown', 'n/a', 'none'}
# country, state, district, sub-district. The picker cascades down this chain,
# and a report can be exported at any level of it.
LEVELS = ['ADM0', 'ADM1', 'ADM2', 'ADM3']
API = 'https://www.geoboundaries.org/api/current/gbOpen/{iso}/{lvl}/'
CACHE = 'tools/_geoboundaries'
# ~1 km. Outlines are drawn as a highlight, never measured against.
SIMPLIFY = 0.01
# Finest grid, matching build_dashboard.py's z3. Every coarser corpus level
# (1.1/2.2/4.4) is a power-of-two multiple of it, so the client can aggregate a
# region's own grid up to whatever level it is drawing with no error.
FINE = 0.55


def boundaries(iso, lvl):
    """Fetch one country/level as GeoJSON, caching the raw download."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f'{iso}_{lvl}.geojson')
    if not os.path.exists(path):
        meta = json.load(urllib.request.urlopen(API.format(iso=iso, lvl=lvl), timeout=60))
        if isinstance(meta, list):
            meta = meta[0]
        with urllib.request.urlopen(meta['gjDownloadURL'], timeout=300) as r:
            data = r.read()
        with open(path, 'wb') as f:
            f.write(data)
    with open(path, encoding='utf-8') as f:
        return json.load(f)['features']


def load_all():
    """Every region, as (code, name, level, iso, geometry)."""
    out = []
    for iso in COUNTRIES:
        for n, lvl in enumerate(LEVELS):
            try:
                feats = boundaries(iso, lvl)
            except Exception as e:  # Bhutan has no ADM3; not an error worth stopping for
                print(f'  {iso} {lvl}: unavailable ({type(e).__name__})')
                continue
            for i, f in enumerate(feats):
                p = f['properties']
                name = p.get('shapeName') or f'{iso} {lvl} {i}'
                if name.strip().lower() in EXCLUDE_NAMES:
                    continue
                if n == 0:
                    name = COUNTRIES[iso]      # geoBoundaries ADM0 names vary
                out.append((f'{iso}{n}-{i}', name, n, iso, shape(f['geometry'])))
            print(f'  {iso} {lvl}: {len(feats)} regions')
    return out


def main(a):
    db = sqlite3.connect(a.db)
    outdir = os.path.join(a.out, 'regions')
    os.makedirs(outdir, exist_ok=True)

    rows = db.execute('''SELECT o.speciesId, o.decimalLongitude, o.decimalLatitude,
                                o.eventDate
                         FROM occurrence o
                         WHERE o.decimalLongitude IS NOT NULL
                           AND o.decimalLatitude IS NOT NULL''').fetchall()
    sid = np.array([r[0] for r in rows])
    pts = shp_points(np.array([[r[1], r[2]] for r in rows]))
    # grid index and filter key per point, so each region can carry its OWN
    # occurrence grid — a selected region must filter the map exactly, and the
    # corpus grid cannot be clipped to a boundary after the fact
    lons = [r[1] for r in rows]
    lats = [r[2] for r in rows]
    spmeta = {r[0]: ((r[1] or 'Other'), (r[2] or 'DD')) for r in db.execute(
        'SELECT s.id, s.grp, i.iucnCategory FROM species s '
        'LEFT JOIN iucnData i ON i.speciesId=s.id')}
    bkey = [(lambda m: m[0] + '|' + m[1])(spmeta[s]) if s in spmeta else None
            for s in sid]
    # decade and month per record, for the survey-effort and seasonality
    # sections of the report. 96,210 of 98,451 records carry a date.
    def ym(dt):
        if not dt or len(str(dt)) < 4:
            return None, None
        t = str(dt)
        try:
            y = int(t[:4])
            m = int(t[5:7]) if len(t) >= 7 and t[5:7].isdigit() else 0
        except ValueError:
            return None, None
        return (y if 1750 <= y <= 2100 else None), (m if 1 <= m <= 12 else 0)
    yrs, mons = zip(*[ym(r[3]) for r in rows]) if rows else ((), ())
    print(f'{len(rows)} occurrence points')

    print('loading boundaries')
    regions = load_all()
    tree = STRtree([r[4] for r in regions])

    print('assigning points')
    # query returns [input_index, tree_index] pairs for every hit
    hit = tree.query(pts, predicate='intersects')
    per = collections.defaultdict(collections.Counter)
    rpts = collections.defaultdict(list)   # region -> its in-polygon point indices
    for pi, ri in zip(hit[0], hit[1]):
        per[ri][int(sid[pi])] += 1
        rpts[ri].append(pi)
    print(f'  {sum(len(v) for v in per.values())} species-region pairs')

    def region_grid(geom, pis):
        """Grid a region's in-polygon points at a cell size ADAPTED to the
        region's extent — fine for a small district, coarse for a country — so
        the map has real detail everywhere and boundary cells stay small
        (which, with client-side clipping to the polygon, kills the old spill).
        A cap keeps any single region file bounded."""
        minx, miny, maxx, maxy = geom.bounds
        extent = max(maxx - minx, maxy - miny, 1e-6)
        base = min(0.55, max(0.08, extent / 40))

        def grid_at(cell):
            g = collections.defaultdict(collections.Counter)
            for pi in pis:
                k = bkey[pi]
                if k:
                    g[(int(lons[pi] / cell), int(lats[pi] / cell))][k] += 1
            return g

        g = grid_at(base)
        while len(g) > 500 and base < 0.55:
            base = min(0.55, base * 2)
            g = grid_at(base)
        dc, mc = collections.Counter(), collections.Counter()
        for pi in pis:
            if yrs[pi]:
                dc[yrs[pi] // 10 * 10] += 1
            if mons[pi]:
                mc[mons[pi]] += 1
        return round(base, 4), g, dc, mc

    # Names for the checklist come from the same place the app gets them.
    meta = {r[0]: r for r in db.execute('''
        SELECT s.id, s.scientificName, s.commonName, s.family, s.grp, s.class,
               i.iucnCategory
        FROM species s LEFT JOIN iucnData i ON i.speciesId=s.id''')}

    # A region is its own parent's child by geometry, not by name: find the
    # smallest containing region one level up. Cheaper and more reliable than
    # trusting geoBoundaries' parent name fields, which are inconsistent.
    by_level = collections.defaultdict(list)
    for i, r in enumerate(regions):
        by_level[r[2]].append(i)
    parent_tree = {lvl: STRtree([regions[i][4] for i in by_level[lvl]])
                   for lvl in (0, 1, 2) if by_level[lvl]}

    index = []
    for i, (code, name, lvl, iso, geom) in enumerate(regions):
        counts = per.get(i)
        if not counts:
            continue  # no records: nothing to report on, don't offer it
        parent = parent_code = ''
        if lvl > 0 and (lvl - 1) in parent_tree:
            p = find_parent(geom, lvl, regions, by_level, parent_tree)
            if p:
                parent, parent_code = p[1], p[0]

        species = sorted(
            ([s, n] + list(meta[s][1:]) for s, n in counts.items() if s in meta),
            key=lambda x: x[2])  # scientific name
        gcell, ggrid, gdec, gmon = region_grid(geom, rpts.get(i, []))
        json.dump({
            'code': code, 'name': name, 'lvl': lvl,
            'country': COUNTRIES[iso], 'parent': parent, 'parentCode': parent_code,
            'nrec': sum(counts.values()),
            # this region's own occurrence grid at FINE degrees, keyed
            # group|status exactly like the corpus levels, so group and status
            # filters stay exact after the map is scoped to the region
            'cell': gcell,
            # collecting effort through time and across the year
            'dec': dict(sorted(gdec.items())),
            'mon': dict(sorted(gmon.items())),
            'cells': [{'k': [k[0], k[1]], 'b': dict(b)}
                      for k, b in sorted(ggrid.items())],
            # [speciesId, records, scientific, common, family, group, class, iucn]
            'sp': species,
            'outline': mapping_rings(geom.simplify(SIMPLIFY, preserve_topology=True)),
        }, open(os.path.join(outdir, f'{code}.json'), 'w', encoding='utf-8'),
            separators=(',', ':'), ensure_ascii=False)

        index.append({'c': code, 'n': name, 'l': lvl, 'p': parent,
                      'pc': parent_code,        # the cascade keys on this
                      'co': COUNTRIES[iso], 'ns': len(species),
                      'nr': sum(counts.values())})

    # How many districts each species is known from, nationally. A species
    # found in one or two districts is restricted-range, which is the strongest
    # conservation signal we can derive without extra data.
    spread = collections.Counter()
    for i, (code, name, lvl, iso, geom) in enumerate(regions):
        if lvl != 2:
            continue
        for s in (per.get(i) or {}):
            spread[s] += 1
    json.dump(spread, open(os.path.join(outdir, 'spread.json'), 'w', encoding='utf-8'),
              separators=(',', ':'))
    print(f'  spread.json: {len(spread)} species with a district count')

    index.sort(key=lambda r: (r['co'], r['l'], r['n']))
    json.dump(index, open(os.path.join(outdir, 'index.json'), 'w', encoding='utf-8'),
              separators=(',', ':'), ensure_ascii=False)

    kb = os.path.getsize(os.path.join(outdir, 'index.json')) // 1024
    print(f'\nindex.json {kb} KB — {len(index)} regions with records')
    for lvl, label in [(0, 'country'), (1, 'state'), (2, 'district'), (3, 'sub-district')]:
        n = [r for r in index if r['l'] == lvl]
        orphan = sum(1 for r in n if lvl and not r['pc'])
        print(f'  {label:13} {len(n):5}  median '
              f'{sorted(r["ns"] for r in n)[len(n)//2] if n else 0} species'
              + (f'  ({orphan} with no parent)' if orphan else ''))


def find_parent(geom, lvl, regions, by_level, parent_tree):
    """The containing region one level up.

    A representative point inside the parent handles the ordinary case, but
    islands (Lakshadweep), non-contiguous enclaves (Dadra and Nagar Haveli)
    and boundaries that disagree slightly between ADM levels all fail it — and
    a region with no parent is unreachable in a cascading picker, so fall back
    to largest overlap, then to nearest.
    """
    up, tree = lvl - 1, parent_tree[lvl - 1]
    at = lambda i: regions[by_level[up][i]]

    hit = tree.query(geom.representative_point(), predicate='within')
    if len(hit):
        return at(hit[0])

    best, best_area = None, 0.0
    for ci in tree.query(geom, predicate='intersects'):
        try:
            a = geom.intersection(at(ci)[4]).area
        except Exception:
            continue
        if a > best_area:
            best, best_area = at(ci), a
    if best:
        return best

    near = tree.nearest(geom)          # a true island, off every parent polygon
    return at(near) if near is not None else None


def mapping_rings(geom):
    """Exterior rings only, rounded — enough to draw a highlight."""
    polys = geom.geoms if geom.geom_type == 'MultiPolygon' else [geom]
    return [[[round(x, 3), round(y, 3)] for x, y in p.exterior.coords]
            for p in polys if p.geom_type == 'Polygon']


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--db', required=True)
    p.add_argument('--out', default='dashboard/data')
    main(p.parse_args())
