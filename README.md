# Uraga Atlas — web GIS dashboard

An occurrence atlas of the **1,096 reptile and amphibian species** of the Indian
subcontinent. Companion to the Uraga Android field guide, built on the same
`species.db`.

Static site — no server, no build step at serve time, no API keys.

**Live: https://nikunjfriends25-droid.github.io/uraga-atlas/**

## What is served vs. fetched

Photographs and individual occurrence records are **not** stored here. They are
fetched from public APIs at the moment a species is selected, so this repository
stays small and the records stay current.

| | Source | When |
|---|---|---|
| Species index, filters, search | `data/index.json` | on load |
| Field notes, traits, nomenclature | `data/species/<id>.json` | on selection |
| Occurrence clusters (corpus overview) | `data/clusters.json` | on load |
| Basemap tiles | CARTO / Esri / OpenTopoMap | on pan and zoom |
| **Photographs** | **iNaturalist API** | **on selection** |
| **Occurrence points** | **GBIF API** | **on selection** |

Both APIs send `Access-Control-Allow-Origin: *`, need no key, and are called
directly from the browser:

```
https://api.inaturalist.org/v1/taxa/{inatTaxonId}
https://api.gbif.org/v1/occurrence/search?taxonKey={gbifTaxonKey}&hasCoordinate=true&hasGeospatialIssue=false&limit=300
```

Species carry both identifiers in the index, so no name-matching round trip is
needed at runtime. Responses are cached per species for the session.

If either call fails — offline, rate limited, or no identifier for that species
— the dashboard says so in the dock header and still renders everything that
came from our own data. It never shows an empty state pretending to be a result.

The corpus overview still uses precomputed clusters: 98,451 points is too many
to fetch live, and they are aggregated from our own snapshot. Cells are keyed
`group|status`, and because a taxonomic group implies its class, that one key
lets the group, class and status filters apply **exactly** rather than
approximately.

## Regional species reports

A **floating panel on the right** (separate from the filters) cascades
**country → state → district → sub-district**: each choice narrows the next
list. A report can be exported at **any** level of that chain, not only the
deepest — selecting India alone exports all of India. Choosing a region scopes
the whole atlas: the species list filters, the boundary is outlined, and the
map frames it.

Point-in-polygon is precomputed by `tools/build_regions.py`, so selecting a
region costs one JSON fetch — the browser never does geometry. Boundaries come
from **geoBoundaries** (gbOpen, CC BY 4.0), which unlike GADM may be
redistributed. 5,095 regions have at least one record: 6 countries, 87 states,
1,018 districts, 3,984 sub-districts.

Each region stores its **parent's code**, which is what the cascade keys on.
Parents are resolved geometrically, not by name: a representative point inside
the parent, falling back to largest-overlap and then nearest, because islands
(Lakshadweep), non-contiguous enclaves (Dadra and Nagar Haveli) and boundaries
that disagree between ADM levels otherwise end up parentless — and a parentless
region is unreachable in a cascade.

The report opens as a **floating sheet on the right**, over the map, with the
region still outlined beside it — scroll it, then **Save as PDF** or close it
(Escape works too). The map's zoom, readout and dock slide clear while it is
open; under 820px the sheet goes full width and reads as a document view.

There is deliberately **one copy of the markup**: the sheet you read *is* the
document that prints, so a preview can never drift out of sync with the PDF.
Screen and print share the styling — `@media print` only strips the panel
chrome and sets up pagination. The PDF itself comes from the browser's own
**print-to-PDF**, so no PDF library is involved and it inherits the reader's
page size and margins rather than guessing them. Thumbnails are pulled from iNaturalist in batches of
30 at print time; a few hundred images take ~20s to settle and the button
reports progress. Species with no photograph get a placeholder, never a gap.

Active group/status/search filters carry into the report, and the cover says so
explicitly when they do.

**Village level is deliberately not offered.** A large share of GBIF records
carry obscured or rounded coordinates — IUCN obscures threatened-species
localities and iNaturalist rounds them — so village-scale assignment would
manufacture false precision, and publishing it would defeat the obscuring. The
report footer carries this caveat.

## Regenerating the data

```bash
python tools/build_dashboard.py \
  --db       "path/to/species.db" \
  --basemap  "path/to/subcontinent.json" \
  --out      data

python tools/build_regions.py \
  --db       "path/to/species.db" \
  --out      data
```

## Running locally

Must be served over HTTP — `fetch` will not read `file://` URLs. Use the
bundled server rather than `python -m http.server`: it sends `no-store`, so an
edited app.js or styles.css is never masked by the browser cache.

```bash
python tools/serve.py 8099
# then open http://127.0.0.1:8099
```

## The map

Leaflet over raster tiles, switchable from the region panel: **CARTO Positron**
(default — near-monochrome so the red occurrence points stay loudest),
Voyager, Dark Matter, Esri World Imagery and OpenTopoMap. Leaflet is vendored
in `vendor/`, not loaded from a CDN.

Programmatic camera moves pass **`animate:false`**. Leaflet's zoom animation is
driven by `requestAnimationFrame`, which a throttled or backgrounded tab never
runs — the camera then starts moving and silently never arrives. User-driven
zoom keeps its animation.

## Attribution

Conservation status, assessments, population trends, biogeographic realms and
habitat classifications from the **IUCN Red List** (non-commercial use, with
attribution). Occurrence records from **GBIF**. Photographs from **iNaturalist**
contributors — each image carries its own credit and licence, shown with the
photograph. Coastline from **Natural Earth** (public domain). Field notes are
machine-generated and are labelled as unverified wherever they appear.
