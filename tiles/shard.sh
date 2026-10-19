#!/usr/bin/env bash
# Splits one PMTiles file into west-to-east strips, each small enough to commit to git (GitHub rejects files over
# 100 MB) and serve from GitHub Pages. Strip edges were picked so the max-zoom-12 US tileset (~420 MB) lands at
# 50-85 MB per file; re-check the sizes if you build with different options.
#
#   ./tiles/shard.sh data/us-highways.pmtiles docs/data
#
# Needs the `pmtiles` CLI from https://github.com/protomaps/go-pmtiles/releases (tested with 1.30.0).
set -euo pipefail

IN=${1:?usage: shard.sh input.pmtiles [output-dir]}
OUT=${2:-docs/data}
mkdir -p "$OUT"

i=1
for strip in "-180 -110" "-110 -95" "-95 -89" "-89 -83" "-83 -77" "-77 -60"; do
  read -r west east <<<"$strip"
  pmtiles extract "$IN" "$OUT/roads-$i.pmtiles" --bbox="$west,15,$east,72"
  i=$((i + 1))
done

echo
ls -l "$OUT"/roads-*.pmtiles | awk '{ printf "%8.1f MB  %s\n", $5 / 1e6, $9 }'
if find "$OUT" -name 'roads-*.pmtiles' -size +95M | grep -q .; then
  echo "WARNING: a shard is close to or over GitHub's 100 MB file limit - move the strip edges in this script." >&2
fi
echo 'List the files under "tiles" in docs/config.json.'
