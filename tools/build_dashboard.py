"""Generate the static data the Uraga Atlas dashboard loads.

The dashboard fetches photographs from iNaturalist and occurrence points from
GBIF live in the browser, so nothing image- or point-shaped is baked in here.
What we do ship is our own data:

  data/index.json          light list of every species — drives the panel,
                           the filters and the search
  data/species/<id>.json   the full record (AI field notes, traits,
                           nomenclature) fetched when a species is selected
  data/clusters.json       precomputed occurrence clusters for the corpus
                           overview, at three zoom levels
  data/basemap.json        Natural Earth coastline rings

Usage:
  python tools/build_dashboard.py --db "path/to/species.db" \
      --basemap "path/to/subcontinent.json" --out dashboard/data
"""
import argparse
import collections
import json
import os
import sqlite3

AI_FIELDS = ['description', 'identificationRemarks', 'habitat', 'behavior',
             'reproductionNotes', 'distributionRemarks', 'callDescription']
BBOX = (58, 100, 3, 39)  # lon min/max, lat min/max
# Marine taxa, where OBIS holds records GBIF under-covers. Only these species
# are queried against OBIS at runtime — a terrestrial species would just cost a
# round trip to be told zero.
MARINE_FAMILIES = {'Cheloniidae', 'Dermochelyidae'}
MARINE_GENERA = {'Hydrophis', 'Laticauda', 'Pelamis', 'Enhydrina', 'Thalassophina',
                 'Microcephalophis', 'Kerilia', 'Praescutata', 'Aipysurus',
                 'Emydocephalus', 'Astrotia', 'Lapemis'}


def clusters(db, cell):
    """Aggregate occurrence points into a grid, keyed by group|status so that
    group, class and status filters can all be applied exactly client-side."""
    meta = {r[0]: ((r[1] or 'Other'), (r[2] or 'DD')) for r in db.execute(
        'SELECT s.id, s.grp, i.iucnCategory FROM species s LEFT JOIN iucnData i ON i.speciesId=s.id')}
    counts = collections.defaultdict(collections.Counter)
    for sid, lon, lat in db.execute(
            'SELECT speciesId, decimalLongitude, decimalLatitude FROM occurrence'):
        m = meta.get(sid)
        if not m or lon is None or lat is None:
            continue
        if not (BBOX[0] <= lon <= BBOX[1] and BBOX[2] <= lat <= BBOX[3]):
            continue
        counts[(int(lon / cell), int(lat / cell))][m[0] + '|' + m[1]] += 1

    # Bubbles sit at the CELL CENTRE, not the mean of their points. A bubble
    # stands for a whole cell, so the centroid implied a precision the
    # aggregate does not have — and worse, two neighbouring cells whose points
    # both hug the shared border produced near-concentric bubbles that
    # overlapped ~90%. Cell centres are exactly one cell apart, so with a
    # radius under half the spacing adjacent bubbles can never collide.
    out = []
    for (kx, ky), c in counts.items():
        out.append({'x': round((kx + 0.5) * cell, 3),
                    'y': round((ky + 0.5) * cell, 3), 'b': dict(c)})
    return out


def main(a):
    # which species have an extracted IUCN range polygon, so a report can say
    # how many of its species are mapped from range rather than from records
    global RANGE_IDS
    RANGE_IDS = set()
    if a.ranges and os.path.isdir(a.ranges):
        RANGE_IDS = {int(f.split('.')[0]) for f in os.listdir(a.ranges)
                     if f.endswith('.geojson') and f.split('.')[0].isdigit()}
    print(f'{len(RANGE_IDS)} species have a range polygon')

    db = sqlite3.connect(a.db)
    db.row_factory = sqlite3.Row
    os.makedirs(os.path.join(a.out, 'species'), exist_ok=True)

    rows = db.execute('''
        SELECT s.id, s.scientificName sci, s.commonName com, s.family fam, s.genus gen,
               s.grp grp, s.class cls, s.inatName inat, s.inatTaxonId inatKey,
               s.gbifTaxonKey gbifKey, s.taxOrder ordr, s.taxSuborder subordr,
               s.taxFamily txfam, s.taxSubfamily subfam,
               i.iucnCategory iucn, i.assessmentYear yr,
               (SELECT COUNT(*) FROM occurrence o WHERE o.speciesId=s.id) nOcc
        FROM species s LEFT JOIN iucnData i ON i.speciesId=s.id
        ORDER BY s.scientificName''').fetchall()

    index = []
    for r in rows:
        index.append({
            'id': r['id'], 'sci': r['sci'], 'com': r['com'] or '',
            'fam': r['fam'] or '', 'grp': r['grp'] or '',
            'iucn': r['iucn'] or 'DD', 'n': r['nOcc'],
            'inat': r['inatKey'], 'gbif': r['gbifKey'],
            # full lineage, so the panel can render a taxonomic tree without
            # fetching 1,096 per-species files. Positional: class, order,
            # suborder, family, subfamily, genus. Empty strings are real —
            # suborder (595/1096) and subfamily (701/1096) are genuinely
            # unknown for many species, and the tree collapses those ranks
            # rather than inventing an "Unknown" node.
            'lin': [r['cls'] or '', r['ordr'] or '', r['subordr'] or '',
                    r['txfam'] or r['fam'] or '', r['subfam'] or '',
                    r['gen'] or ''],
        })

        traits = collections.defaultdict(list)
        for t in db.execute(
                'SELECT category,label,snippet,confidence FROM traits WHERE speciesId=?', (r['id'],)):
            traits[t['category']].append(
                {'l': t['label'], 's': t['snippet'] or '', 'c': t['confidence']})

        # carried into the index so regional reports can profile venom risk,
        # population trend, habitat and assessment age without fetching 1,096
        # per-species files. Venom is curated, never AI-generated.
        index[-1]['ven'] = (traits.get('venom') or [{}])[0].get('l') or ''
        index[-1]['tr'] = (traits.get('trend') or [{'l': ''}])[0]['l']
        index[-1]['yr'] = r['yr']
        index[-1]['hab'] = [t['l'] for t in traits.get('habitat', [])]
        index[-1]['rng'] = 1 if r['id'] in RANGE_IDS else 0
        # queried against OBIS at runtime; terrestrial species are not, since
        # OBIS would only ever answer zero for them
        index[-1]['mar'] = 1 if ((r['fam'] or '') in MARINE_FAMILIES
                                 or (r['gen'] or '') in MARINE_GENERA) else 0
        ai = {x['fieldName']: x['generatedText'] for x in db.execute(
            'SELECT fieldName,generatedText FROM generationLog WHERE speciesId=? AND outputCharCount>0',
            (r['id'],))}

        json.dump({
            'id': r['id'], 'sci': r['sci'], 'com': r['com'] or '',
            'fam': r['fam'] or '', 'gen': r['gen'] or '', 'grp': r['grp'] or '',
            'cls': r['cls'] or '', 'inatName': r['inat'] or '',
            'inat': r['inatKey'], 'gbif': r['gbifKey'],
            'iucn': r['iucn'] or 'DD', 'yr': r['yr'], 'n': r['nOcc'],
            'lineage': [x for x in [r['cls'], r['ordr'], r['subordr'],
                                    r['txfam'] or r['fam'], r['subfam'], r['gen']] if x],
            'ai': {k: ai[k] for k in AI_FIELDS if ai.get(k)},
            'venom': (traits.get('venom') or [None])[0],
            'trend': (traits.get('trend') or [{'l': ''}])[0]['l'],
            'realm': ' · '.join(t['l'] for t in traits.get('realm', [])),
            'hab': [t['l'] for t in traits.get('habitat', [])],
        }, open(os.path.join(a.out, 'species', f"{r['id']}.json"), 'w', encoding='utf-8'),
            separators=(',', ':'), ensure_ascii=False)

    json.dump(index, open(os.path.join(a.out, 'index.json'), 'w', encoding='utf-8'),
              separators=(',', ':'), ensure_ascii=False)

    facets = {
        'grp': [{'k': r[0], 'n': r[1]} for r in db.execute(
            'SELECT grp,COUNT(*) FROM species WHERE grp IS NOT NULL GROUP BY grp ORDER BY 2 DESC')],
        'iucn': [{'k': k, 'label': l, 'n': db.execute(
            'SELECT COUNT(*) FROM iucnData WHERE iucnCategory=?', (k,)).fetchone()[0]}
            for k, l in [('LC', 'Least Concern'), ('NT', 'Near Threatened'),
                         ('VU', 'Vulnerable'), ('EN', 'Endangered'),
                         ('CR', 'Critically Endangered'), ('DD', 'Data Deficient')]],
    }
    stats = {
        'species': len(rows),
        'occ': db.execute('SELECT COUNT(*) FROM occurrence').fetchone()[0],
        'polygons': db.execute(
            "SELECT COUNT(*) FROM iucnData WHERE rangeSource='iucn_polygon'").fetchone()[0],
        'threatened': db.execute(
            "SELECT COUNT(*) FROM iucnData WHERE iucnCategory IN ('VU','EN','CR')").fetchone()[0],
    }
    # Four grid resolutions. The 4.4° level exists because at the default zoom
    # of 4 a 2.2° grid puts cell centres only ~25px apart, so bubbles collapse
    # into one blob. Cell sizes ship with the data so the client can size
    # bubbles from real spacing instead of a hardcoded guess.
    # powers of two apart, so a region's fine grid can be aggregated up to any
    # coarser level client-side with no error (see build_regions.py)
    cells = {'z0': 4.4, 'z1': 2.2, 'z2': 1.1, 'z3': 0.55}
    json.dump({'levels': {k: clusters(db, v) for k, v in cells.items()},
               'cells': cells,
               'facets': facets, 'stats': stats},
              open(os.path.join(a.out, 'clusters.json'), 'w', encoding='utf-8'),
              separators=(',', ':'))

    rings = json.load(open(a.basemap, encoding='utf-8'))['rings']
    json.dump({'rings': rings}, open(os.path.join(a.out, 'basemap.json'), 'w', encoding='utf-8'),
              separators=(',', ':'))

    def kb(p):
        return os.path.getsize(os.path.join(a.out, p)) // 1024
    print(f'index.json     {kb("index.json"):5} KB  ({len(index)} species)')
    print(f'clusters.json  {kb("clusters.json"):5} KB')
    print(f'basemap.json   {kb("basemap.json"):5} KB')
    print(f'species/*.json {len(rows)} files')
    print('with gbif key:', sum(1 for i in index if i['gbif']),
          '| with inat key:', sum(1 for i in index if i['inat']))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--db', required=True)
    p.add_argument('--basemap', required=True)
    p.add_argument('--ranges', default=r'C:/Herpetofauna app/rangemaps')
    p.add_argument('--out', default='dashboard/data')
    main(p.parse_args())
