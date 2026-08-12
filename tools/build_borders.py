"""Reference borders for the report maps.

The report maps are standalone SVG (raster tiles can't be printed), so a bare
coastline looks empty. This bakes country + state (ADM1) boundary linework from
the geoBoundaries cache into data/borders.json, drawn as thin grey lines so a
reader can see which country and state the occurrences fall in.

  python tools/build_borders.py --out dashboard/data
"""
import argparse
import json
import os

from shapely.geometry import shape

CACHE = 'tools/_geoboundaries'
ISOS = ['IND', 'PAK', 'NPL', 'BTN', 'BGD', 'LKA']   # all six, for geographic context
BBOX = (58, 3, 100, 39)      # atlas extent (lon min, lat min, lon max, lat max)
SIMPLIFY = 0.03              # ~3 km; borders are reference lines, not measured


def rings_of(geom):
    """Exterior rings of a (Multi)Polygon, rounded."""
    polys = geom.geoms if geom.geom_type == 'MultiPolygon' else [geom]
    out = []
    for p in polys:
        if p.geom_type != 'Polygon':
            continue
        out.append([[round(x, 3), round(y, 3)] for x, y in p.exterior.coords])
    return out


def main(a):
    from shapely.geometry import box
    clip = box(*BBOX)
    lines = []
    for iso in ISOS:
        path = os.path.join(CACHE, f'{iso}_ADM1.geojson')
        if not os.path.exists(path):
            print(f'  {iso} ADM1: missing, skipped')
            continue
        feats = json.load(open(path, encoding='utf-8'))['features']
        for f in feats:
            g = shape(f['geometry'])
            g = g.intersection(clip).simplify(SIMPLIFY, preserve_topology=True)
            if g.is_empty:
                continue
            lines.extend(rings_of(g))
        print(f'  {iso} ADM1: {len(feats)} units')

    json.dump({'lines': lines}, open(os.path.join(a.out, 'borders.json'), 'w', encoding='utf-8'),
              separators=(',', ':'))
    kb = os.path.getsize(os.path.join(a.out, 'borders.json')) // 1024
    print(f'borders.json: {len(lines)} rings, {kb} KB')

    # Place labels: India ADM1 (states) at a representative interior point, plus
    # the five neighbour countries as coarse labels. Drawn on the report maps.
    from shapely.ops import unary_union
    labels = []
    ind = os.path.join(CACHE, 'IND_ADM1.geojson')
    if os.path.exists(ind):
        for f in json.load(open(ind, encoding='utf-8'))['features']:
            g = shape(f['geometry']).intersection(clip)
            if g.is_empty:
                continue
            name = (f.get('properties') or {}).get('shapeName') or ''
            if not name:
                continue
            rp = g.representative_point()
            labels.append({'n': name, 'x': round(rp.x, 3), 'y': round(rp.y, 3), 't': 'state'})
    for iso, nm in [('PAK', 'Pakistan'), ('NPL', 'Nepal'), ('BTN', 'Bhutan'),
                    ('BGD', 'Bangladesh'), ('LKA', 'Sri Lanka')]:
        p = os.path.join(CACHE, f'{iso}_ADM1.geojson')
        if not os.path.exists(p):
            continue
        u = unary_union([shape(f['geometry']) for f in json.load(open(p, encoding='utf-8'))['features']]).intersection(clip)
        if u.is_empty:
            continue
        rp = u.representative_point()
        labels.append({'n': nm, 'x': round(rp.x, 3), 'y': round(rp.y, 3), 't': 'country'})
    json.dump({'labels': labels}, open(os.path.join(a.out, 'labels.json'), 'w', encoding='utf-8'),
              separators=(',', ':'))
    print(f'labels.json: {len(labels)} labels')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--out', default='dashboard/data')
    main(p.parse_args())
