"""Bundle India's protected areas (National Parks + Wildlife Sanctuaries) as a
compact JSON of WGS84 polygons for the portal's "Protected areas" picker.

Source: the WII/government National_Park shapefile (Lambert Conformal Conic),
staged in tools/_protected_areas/. Each PA's boundary is reprojected to lon/lat,
simplified, and stored as rings so the client can use it as a GBIF query polygon
(same pipeline as a drawn AOI).

    python tools/build_protected_areas.py --out dashboard/data
"""
import argparse, json, os
import shapefile
from shapely.geometry import shape
from shapely.ops import transform
from pyproj import CRS, Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '_protected_areas', 'National_Park')
SIMPLIFY = 0.004          # ~440 m; boundaries are a query/label aid, not survey-grade
MIN_PART = 3e-4           # drop polygon parts smaller than ~this (deg^2 of bbox) slivers

STATES = {
    'AN':'Andaman & Nicobar Islands','AP':'Andhra Pradesh','AR':'Arunachal Pradesh',
    'AS':'Assam','BR':'Bihar','CG':'Chhattisgarh','CH':'Chandigarh','DH':'Dadra & Nagar Haveli',
    'DL':'Delhi','GA':'Goa','GJ':'Gujarat','HP':'Himachal Pradesh','HR':'Haryana','JH':'Jharkhand',
    'JK':'Jammu & Kashmir','KA':'Karnataka','KL':'Kerala','LA':'Ladakh','LK':'Ladakh',
    'LD':'Lakshadweep','MH':'Maharashtra','ML':'Meghalaya','MN':'Manipur','MP':'Madhya Pradesh',
    'MZ':'Mizoram','NL':'Nagaland','OD':'Odisha','OR':'Odisha','PB':'Punjab','PY':'Puducherry',
    'RJ':'Rajasthan','SK':'Sikkim','TN':'Tamil Nadu','TR':'Tripura','TS':'Telangana',
    'UK':'Uttarakhand','UT':'Uttarakhand','UP':'Uttar Pradesh','WB':'West Bengal',
}
def norm_type(t):
    t = (t or '').strip().lower()
    if 'national' in t: return 'National Park'
    if 'sanctuar' in t: return 'Wildlife Sanctuary'
    return (t.title() or 'Protected Area')

def bbox_area(coords):
    xs=[p[0] for p in coords]; ys=[p[1] for p in coords]
    return (max(xs)-min(xs))*(max(ys)-min(ys))

def rings_of(geom):
    polys = geom.geoms if geom.geom_type == 'MultiPolygon' else [geom]
    out=[]
    for p in polys:
        if p.geom_type != 'Polygon': continue
        ring=[[round(x,4),round(y,4)] for x,y in p.exterior.coords]
        if len(ring) >= 4: out.append(ring)
    if not out: return out
    # keep the largest part always; drop tiny slivers beyond it
    out.sort(key=bbox_area, reverse=True)
    return [out[0]] + [r for r in out[1:] if bbox_area(r) >= MIN_PART]

def main(a):
    r = shapefile.Reader(SRC)
    flds=[f[0] for f in r.fields[1:]]
    idx={k:flds.index(k) for k in ['Name_of_Pr','Type','Sub_Type_','State','Major_Spec','Year_of_No','area']}
    src_crs = CRS.from_wkt(open(SRC+'.prj', encoding='utf-8').read())
    tf = Transformer.from_crs(src_crs, CRS.from_epsg(4326), always_xy=True)
    reproj = lambda x, y, z=None: tf.transform(x, y)

    pas=[]; skipped=0
    for sr in r.shapeRecords():
        rec=sr.record
        name=(rec[idx['Name_of_Pr']] or '').strip()
        if not name: skipped+=1; continue
        try:
            g = shape(sr.shape.__geo_interface__)
            g = transform(reproj, g).buffer(0).simplify(SIMPLIFY, preserve_topology=True)
        except Exception: skipped+=1; continue
        rings = rings_of(g)
        if not rings: skipped+=1; continue
        pas.append({
            'n': name,
            'ty': norm_type(rec[idx['Type']]),
            'st': STATES.get((rec[idx['State']] or '').strip(), (rec[idx['State']] or '').strip()),
            'sub': (rec[idx['Sub_Type_']] or '').strip(),
            'sp': (rec[idx['Major_Spec']] or '').strip(),
            'yr': str(rec[idx['Year_of_No']] or '').strip(),
            'ar': round(float(rec[idx['area']] or 0), 1),
            'r': rings,
        })
    pas.sort(key=lambda p: p['n'].lower())
    out=os.path.join(a.out,'protected_areas.json')
    json.dump({'pas':pas}, open(out,'w',encoding='utf-8'), separators=(',',':'), ensure_ascii=False)
    kb=os.path.getsize(out)//1024
    print(f'protected_areas.json: {len(pas)} PAs ({skipped} skipped), {kb} KB')
    print('  types:', sorted(set(p["ty"] for p in pas)))
    print('  states:', len(set(p["st"] for p in pas)))

if __name__ == '__main__':
    p=argparse.ArgumentParser(); p.add_argument('--out', default='dashboard/data'); main(p.parse_args())
