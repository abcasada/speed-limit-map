#!/usr/bin/env bash
# Builds data/us-highways.pmtiles (all US roads with speed limit, lanes and route-shield attributes) from OpenStreetMap.
#
#   ./tiles/build.sh                 download the Geofabrik US extract and build
#   OSM_PBF=/path/us.osm.pbf ./tiles/build.sh
#
# Needs: Java 21+, curl. Optional but recommended: osmium-tool (shrinks the input to roads only, so the build needs far
# less RAM/disk). Rough sizing, not measured on every machine: ~12 GB download, 30-90 min, 8+ GB RAM.
#
# Environment knobs:
#   OSM_PBF       use this local extract instead of downloading one
#   OSM_URL       where to download from (default: Geofabrik US extract)
#   CLIP_POLYGON  GeoJSON polygon to clip to (use when OSM_PBF covers more than the US, e.g. North America)
#   HEAP          Java heap (default 8g)
# Extra arguments are passed on to Planetiler, e.g. --minor=false to leave out unclassified/residential streets.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=${WORK:-build}
HEAP=${HEAP:-8g}
mkdir -p "$WORK" data

JAR="$WORK/planetiler.jar"
if [ ! -f "$JAR" ]; then
  curl -fL -o "$JAR" https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
fi

SRC=${OSM_PBF:-$WORK/us-latest.osm.pbf}
if [ ! -f "$SRC" ]; then
  curl -fL -o "$SRC" "${OSM_URL:-https://download.geofabrik.de/north-america/us-latest.osm.pbf}"
fi

ROADS="$SRC"
if command -v osmium >/dev/null; then
  ROADS="$WORK/roads.osm.pbf"
  # keep road ways and road route relations (used for Interstate / US / state shields); nodes come along automatically
  osmium tags-filter "$SRC" \
    w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,unclassified,residential,living_street \
    r/route=road \
    -o "$ROADS" --overwrite
  if [ -n "${CLIP_POLYGON:-}" ]; then
    osmium extract -p "$CLIP_POLYGON" --strategy=simple "$ROADS" -o "$WORK/roads-clipped.osm.pbf" --overwrite
    ROADS="$WORK/roads-clipped.osm.pbf"
  fi
else
  echo "osmium not found - building from the full extract (needs more RAM and disk)" >&2
fi

java -Xmx"$HEAP" -cp "$JAR" tiles/HighwaySpeedProfile.java \
  --osm_path="$ROADS" --output=data/us-highways.pmtiles --tmpdir="$WORK/tmp" --force "$@"

# Companion tileset used only to place route shields evenly along each route (see HighwaySpeedProfile.java).
java -Xmx"$HEAP" -cp "$JAR" tiles/HighwaySpeedProfile.java \
  --osm_path="$ROADS" --output=data/us-routes.pmtiles --tmpdir="$WORK/tmp" --force --routes_only=true "$@"

echo "Done: data/us-highways.pmtiles ($(du -h data/us-highways.pmtiles | cut -f1)), data/us-routes.pmtiles ($(du -h data/us-routes.pmtiles | cut -f1))"
echo "Try it: node server.mjs, then open http://localhost:8080/?tiles=/data/us-highways.pmtiles&routes=/data/us-routes.pmtiles"
