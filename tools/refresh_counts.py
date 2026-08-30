"""Refresh per-species GBIF occurrence counts → data/counts.json.

The species list ships a record count baked in at build time (from the
pipeline). It drifts as GBIF grows and, for wide-ranging marine species, never
matched the live count the app shows (Chelonia mydas: 573 stored vs ~2,087
live). This re-queries GBIF for every species with the SAME bbox + filters the
app uses at runtime (API.gbif in app.js), so the left-panel count tracks the
live panel.

Run weekly by .github/workflows/refresh-counts.yml in the deploy repo; also
safe to run locally. Writes data/counts.json = {"generated": ISO, "n": {id: count}}.
The app overlays it onto index.json; if the file is absent it falls back to the
baked-in count, so this is purely additive.

    python tools/refresh_counts.py
"""
import datetime
import json
import os
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# deploy repo: tools/ and data/ sit at the root. dev tree: data/ is under dashboard/.
DATA = os.path.join(HERE, '..', 'data')
if not os.path.isdir(DATA):
    DATA = os.path.join(HERE, '..', 'dashboard', 'data')

# MUST mirror API.gbif in app.js — same box, same filters, so the refreshed
# count equals what the app fetches live.
P = dict(minLon=60, maxLon=98, minLat=4, maxLat=38)
URL = ('https://api.gbif.org/v1/occurrence/search?taxonKey={key}'
       '&hasCoordinate=true&hasGeospatialIssue=false'
       '&decimalLatitude={la0},{la1}&decimalLongitude={lo0},{lo1}&limit=0')


def count(key):
    url = URL.format(key=key, la0=P['minLat'] - 1, la1=P['maxLat'] + 1,
                     lo0=P['minLon'] - 2, lo1=P['maxLon'] + 2)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r).get('count')
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                return None                      # 4xx (not rate-limit): give up
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(1.5 * (attempt + 1))          # 429/5xx/network: back off
    return None


def main():
    index = json.load(open(os.path.join(DATA, 'index.json'), encoding='utf-8'))
    out, miss = {}, 0
    for i, s in enumerate(index):
        key = s.get('gbif')
        if not key:
            continue
        c = count(key)
        if c is None:
            miss += 1
            continue
        out[str(s['id'])] = c
        time.sleep(0.08)                         # be polite to GBIF
        if i % 100 == 0:
            print(f'{i}/{len(index)}  {len(out)} counts, {miss} misses', flush=True)
    payload = {'generated': datetime.date.today().isoformat(), 'n': out}
    json.dump(payload, open(os.path.join(DATA, 'counts.json'), 'w', encoding='utf-8'),
              separators=(',', ':'))
    print(f'wrote counts.json: {len(out)} species, {miss} misses')


if __name__ == '__main__':
    main()
