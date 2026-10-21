#!/usr/bin/env python3
"""Compares an official posted-speed-limit dataset with OpenStreetMap and writes the stretches where they disagree.

    compare.py --official kdot.geojson --osm ks-roads.geojsonseq --out docs/data/kdot-diff.geojson

Method: walk along every official segment taking a sample every STEP metres; at each sample find the OSM roads that run
alongside it (within MATCH_M metres, heading within MAX_BEARING_DIFF degrees, same road class as the best match so a
frontage road does not count), and compare their speed with the official one. Consecutive disagreeing samples become a
"run" whose length in miles is stored, so the web app can show only runs longer than a chosen distance.

Run categories:
  differs  OSM has a different maxspeed on a matched road
  missing  matched OSM road(s) have no usable maxspeed
Samples with no OSM road alongside are not errors in the speed tag (the geometry just does not line up), so they are
skipped; a gap of up to BRIDGE_SAMPLES of them inside a run does not split it.

Official data: use --fields to map the dataset's column names; the defaults are for the Kansas DOT layer.
OSM data: `osmium export roads.osm.pbf -f geojsonseq --geometry-types=linestring --add-unique-id=type_id`.
Needs shapely >= 2 and pyproj. Inputs are treated as untrusted data (only parsed as JSON).
"""
import argparse
import collections
import json
import math
import re
import sys

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import substring, transform

STEP = 50.0              # metres between samples
MATCH_M = 35.0           # OSM road must be within this distance of the official line
MAX_BEARING_DIFF = 30.0  # degrees (mod 180) between the two lines at the closest point
BRIDGE_SAMPLES = 3       # samples without an OSM road that may sit inside a run
MIN_RUN_MILES = 0.1      # runs shorter than this are not written
MILE = 1609.344

CLASS_RANK = {'motorway': 6, 'trunk': 5, 'primary': 4, 'secondary': 3, 'tertiary': 2, 'unclassified': 1,
              'residential': 0, 'living_street': 0}
SPEED_RE = re.compile(r'^(\d+(?:\.\d+)?)\s*([a-z/]*)$')


def parse_mph(value):
    """Same rules as parseMph() in tiles/HighwaySpeedProfile.java so this tool agrees with the map."""
    if not value:
        return None
    best = None
    for part in re.split(r'[;|]', str(value).lower()):
        m = SPEED_RE.match(part.strip())
        if not m:
            continue
        n, unit = float(m.group(1)), m.group(2)
        if unit == 'mph':
            mph = n
        elif unit in ('km/h', 'kmh', 'kph'):
            mph = n * 0.621371
        elif unit == '':
            mph = n if n <= 85 else n * 0.621371
        else:
            continue
        mph = int(math.floor(mph + 0.5))
        if 5 <= mph <= 100:
            best = mph if best is None else max(best, mph)
    return best


def bearing(a, b):
    return math.degrees(math.atan2(b.x - a.x, b.y - a.y)) % 180.0


def angle_diff(a, b):
    d = abs(a - b) % 180.0
    return min(d, 180.0 - d)


def line_bearing(line, s, half=8.0):
    a = line.interpolate(max(s - half, 0.0))
    b = line.interpolate(min(s + half, line.length))
    return bearing(a, b) if a.distance(b) > 0.1 else None


def load_osm(path, to_m):
    ways = []
    with open(path, encoding='utf-8') as f:
        for raw in f:
            raw = raw.lstrip('\x1e').strip()
            if not raw:
                continue
            feat = json.loads(raw)
            props, geom = feat.get('properties', {}), feat.get('geometry')
            hw = props.get('highway')
            if not geom or geom['type'] != 'LineString' or hw not in CLASS_RANK:
                continue
            speeds = [parse_mph(props.get(k)) for k in ('maxspeed', 'maxspeed:forward', 'maxspeed:backward')]
            speeds = [s for s in speeds if s]
            ways.append({
                'id': str(feat.get('id', '')).lstrip('w'),
                'line': transform(to_m, LineString(geom['coordinates'])),
                'hw': hw, 'rank': CLASS_RANK[hw],
                'speed': max(speeds) if speeds else None,
                'name': props.get('name'), 'ref': props.get('ref'),
            })
    return ways


def sample_part(line, kdot_speed, tree, ways):
    """Yields one record per STEP-metre interval along `line`."""
    n = max(1, math.ceil(line.length / STEP))
    width = line.length / n
    centres = [(i + 0.5) * width for i in range(n)]
    points = shapely.points(np.array([[line.interpolate(s).x, line.interpolate(s).y] for s in centres]))
    q_in, q_tree = tree.query(points, predicate='dwithin', distance=MATCH_M)
    by_sample = collections.defaultdict(list)
    for i, j in zip(q_in, q_tree):
        by_sample[i].append(j)
    out = []
    for i, s in enumerate(centres):
        want = line_bearing(line, s)
        accepted = []
        for j in by_sample.get(i, ()):
            w = ways[j]
            d = w['line'].distance(points[i])
            t = w['line'].project(points[i])
            theirs = line_bearing(w['line'], t)
            if want is None or theirs is None or angle_diff(want, theirs) <= MAX_BEARING_DIFF:
                accepted.append((d, w))
        if accepted:
            top = max(w['rank'] for _, w in accepted)
            kept = [w for _, w in accepted if w['rank'] == top]
        else:
            kept = []
        if not kept:
            status = 'none'
        elif any(w['speed'] and w['speed'] != kdot_speed for w in kept):
            status = 'differs'
        elif any(w['speed'] is None for w in kept):
            status = 'missing'
        else:
            status = 'ok'
        out.append({'s0': s - width / 2, 's1': s + width / 2, 'w': width, 'status': status, 'kept': kept})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--official', required=True)
    ap.add_argument('--osm', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--source', default='KDOT', help='short name stored in each output feature')
    ap.add_argument('--route-field', default='RouteID')
    ap.add_argument('--from-field', default='FromMeasure')
    ap.add_argument('--to-field', default='ToMeasure')
    ap.add_argument('--speed-field', default='SpeedLimit')
    args = ap.parse_args()

    to_m = Transformer.from_crs(4326, 5070, always_xy=True).transform
    to_ll = Transformer.from_crs(5070, 4326, always_xy=True).transform

    official = json.load(open(args.official, encoding='utf-8'))['features']
    ways = load_osm(args.osm, to_m)
    print(f'{len(official)} official segments, {len(ways)} OSM ways', file=sys.stderr)
    tree = shapely.STRtree([w['line'] for w in ways])

    # chain segments of the same route that touch end-to-start into streams, so a run can cross segment boundaries
    by_route = collections.defaultdict(list)
    for f in official:
        p = f['properties']
        if f.get('geometry') and p.get(args.speed_field):
            by_route[p[args.route_field]].append(f)
    streams = []
    for route, feats in by_route.items():
        feats.sort(key=lambda f: f['properties'][args.from_field])
        current, last_to = [], None
        for f in feats:
            p = f['properties']
            if current and abs(p[args.from_field] - last_to) > 0.02:
                streams.append(current)
                current = []
            current.append(f)
            last_to = p[args.to_field]
        if current:
            streams.append(current)

    runs_out = []
    stats = collections.Counter()
    for stream in streams:
        samples = []
        for f in stream:
            g = f['geometry']
            parts = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
            for coords in parts:
                if len(coords) < 2:
                    continue
                line = transform(to_m, LineString(coords))
                if line.length < 1:
                    continue
                for smp in sample_part(line, f['properties'][args.speed_field], tree, ways):
                    smp.update(line=line, props=f['properties'])
                    samples.append(smp)
        stats['samples'] += len(samples)
        stats['miles_checked'] += sum(s['w'] for s in samples) / MILE

        run, pending = None, []

        def close(run):
            if run and run['m'] / MILE >= MIN_RUN_MILES:
                runs_out.append(run)

        for smp in samples:
            status, kdot = smp['status'], smp['props'][args.speed_field]
            key = (status, kdot) if status in ('differs', 'missing') else None
            if status == 'none':
                pending.append(smp)
                if len(pending) > BRIDGE_SAMPLES:
                    close(run)
                    run, pending = None, []
                continue
            if key and run and run['key'] == key:
                for p in pending:  # bridge the gap
                    run['parts'].append(p)
                    run['m'] += p['w']
                pending = []
            else:
                close(run)
                run, pending = None, []
                if key:
                    run = {'key': key, 'parts': [], 'm': 0.0, 'ways': collections.Counter(), 'speeds': set(),
                           'names': collections.Counter(), 'refs': collections.Counter(), 'hw': collections.Counter()}
            if run:
                run['parts'].append(smp)
                run['m'] += smp['w']
                for w in smp['kept']:
                    if status == 'differs' and not (w['speed'] and w['speed'] != kdot):
                        continue
                    if status == 'missing' and w['speed'] is not None:
                        continue
                    run['ways'][w['id']] += 1
                    if w['speed']:
                        run['speeds'].add(w['speed'])
                    if w['name']:
                        run['names'][w['name']] += 1
                    if w['ref']:
                        run['refs'][w['ref']] += 1
                    run['hw'][w['hw']] += 1
        close(run)

    features = []
    for run in runs_out:
        kind, kdot = run['key']
        pieces = []
        for smp in run['parts']:  # merge consecutive intervals of one official line back into a single piece
            if pieces and pieces[-1][0] is smp['line'] and abs(pieces[-1][2] - smp['s0']) < 1e-6:
                pieces[-1][2] = smp['s1']
            else:
                pieces.append([smp['line'], smp['s0'], smp['s1']])
        lines = [substring(line, a, b) for line, a, b in pieces if b - a > 0.5]
        if not lines:
            continue
        geom = lines[0] if len(lines) == 1 else MultiLineString(lines)
        geom = transform(to_ll, geom)
        first = run['parts'][0]['props']
        features.append({
            'type': 'Feature',
            'geometry': json.loads(shapely.to_geojson(shapely.set_precision(geom, 1e-6))),
            'properties': {
                'src': args.source,
                'kind': kind,
                'miles': round(run['m'] / MILE, 2),
                'official': kdot,
                'osm': ','.join(str(s) for s in sorted(run['speeds'])),
                'ways': ','.join(w for w, _ in run['ways'].most_common(6)),
                'route': first[args.route_field],
                'name': run['names'].most_common(1)[0][0] if run['names'] else '',
                'ref': run['refs'].most_common(1)[0][0] if run['refs'] else '',
                'hw': run['hw'].most_common(1)[0][0] if run['hw'] else '',
            },
        })
    features.sort(key=lambda f: -f['properties']['miles'])
    json.dump({'type': 'FeatureCollection', 'features': features}, open(args.out, 'w'), separators=(',', ':'))

    print(f"checked {stats['miles_checked']:.0f} miles in {len(streams)} route streams", file=sys.stderr)
    for kind in ('differs', 'missing'):
        ms = [f['properties']['miles'] for f in features if f['properties']['kind'] == kind]
        print(f'{kind}: {len(ms)} runs >= {MIN_RUN_MILES} mi; >=0.5: {sum(m >= 0.5 for m in ms)}; '
              f'>=1: {sum(m >= 1 for m in ms)}; >=3: {sum(m >= 3 for m in ms)}; total {sum(ms):.0f} mi', file=sys.stderr)


if __name__ == '__main__':
    main()
