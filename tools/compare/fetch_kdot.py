#!/usr/bin/env python3
"""Downloads the Kansas DOT "Speed Limits" layer (all current segments) as GeoJSON in WGS84.

    fetch_kdot.py kdot.geojson

Source: https://hub.kansasgis.org/datasets/KSDOT::speed-limits-1 (ArcGIS FeatureServer, 1000 records per page).
The layer has no open-data licence, only a no-warranty notice, so the raw download is not kept in this repository.
"""
import json
import sys
import urllib.parse
import urllib.request

URL = 'https://kanplan.ksdot.gov/arcgis_web_adaptor/rest/services/Transportation/Speed_Limits/FeatureServer/0/query'
PAGE = 1000


def page(offset):
    query = urllib.parse.urlencode({
        'where': 'LRSToDate IS NULL',  # current records only
        'outFields': '*', 'outSR': 4326, 'orderByFields': 'OBJECTID',
        'resultOffset': offset, 'resultRecordCount': PAGE, 'f': 'geojson',
    })
    with urllib.request.urlopen(f'{URL}?{query}', timeout=120) as response:
        return json.load(response)['features']


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'kdot.geojson'
    features, offset = [], 0
    while True:
        chunk = page(offset)
        features += chunk
        print(f'{len(features)} features', file=sys.stderr)
        if len(chunk) < PAGE:
            break
        offset += PAGE
    json.dump({'type': 'FeatureCollection', 'features': features}, open(out, 'w'))


if __name__ == '__main__':
    main()
