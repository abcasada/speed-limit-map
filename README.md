# US Speed Limit Map

A zoomable map of every US road down to residential streets, coloured by posted speed limit, drawn from OpenStreetMap.

- **Colour** = posted speed: white under 55 mph, then one colour per 5 mph step (55, 60, 65, 70, 75, 80, 85+).
  Roads with no usable `maxspeed` tag are dim grey (toggle in the panel).
- **Width** = number of lanes (OSM `lanes` tag). Roads without the tag fall back to a typical lane count for their class.
- **Signs** = route shields: Interstate, US route and each state's own state-route shield (plus county routes, toll roads,
  business loops, ...), drawn by the [Americana shield renderer](https://github.com/osm-americana/openstreetmap-americana/tree/main/shieldlib).
- **Basemaps** (selector in the panel): Light (default), Streets and Dark, the full OpenStreetMap-based vector styles from
  [OpenFreeMap](https://openfreemap.org), fetched at runtime. If they cannot be reached the page shows a banner and falls
  back to a plain background. White (under 55 mph) roads get a dark outline so they stay visible on the light maps.
- Tap/click a road for its speed, lanes, route and type.

It is a static site (`docs/`) plus PMTiles files. No server code.

```
tiles/HighwaySpeedProfile.java   Planetiler profile: OSM -> vector tiles with speed, lanes, route shield, rank
tiles/build.sh                   download extract -> filter roads -> build data/us-highways.pmtiles
tiles/shard.sh                   split a tileset into <100 MB files for git / GitHub Pages
docs/                            the web app (MapLibre GL JS + PMTiles) and the published tiles (docs/data/roads-*.pmtiles)
server.mjs                       local dev server (supports HTTP Range requests, which PMTiles needs)
```

## Run it locally

```sh
node server.mjs            # http://localhost:8080/
```

## Publish on GitHub Pages

Repository **Settings -> Pages -> Build and deployment -> Source: Deploy from a branch**, pick the branch and the
**/docs** folder. The site is then at `https://<user>.github.io/<repo>/`. Everything it needs is vendored under `docs/`
(MapLibre, PMTiles, shield renderer and artwork, road tiles); the only third-party requests are the basemap styles, tiles and
fonts from OpenFreeMap.

The committed tileset (`docs/data/roads-1..6.pmtiles`, 414 MB in total) covers all US roads up to **zoom 12 data, which the
map overzooms** for street-level views. It is split into six west-to-east files because GitHub rejects files over 100 MB;
Pages itself allows about 1 GB per site.

## Rebuild the tiles

```sh
./tiles/build.sh --maxzoom=12      # needs Java 21+, curl; osmium-tool strongly recommended
./tiles/shard.sh data/us-highways.pmtiles docs/data
```

For a bigger local-only build with deeper data (zoom 14, about 1.7 GB, sharper geometry when zoomed far in), run
`./tiles/build.sh` and open `http://localhost:8080/?tiles=/data/us-highways.pmtiles`. `--minor=false` leaves out
unclassified and residential streets (173 MB at zoom 12). Details and knobs are in the header of `tiles/build.sh`.

`?tiles=a.pmtiles,b.pmtiles` points the app at any PMTiles files served with HTTP Range support (own server, S3,
Cloudflare R2, ...). Edit `docs/config.json` to change the default.

Measured on a 4-core, 15 GB machine: the full US build takes about 5 minutes once the roads-only extract exists
(downloading the extract and filtering it with osmium add roughly 15 minutes).

## Data caveats

- **Speed limits come from the OSM `maxspeed` tag, which is far from complete in the US.** Share of ways carrying a
  maxspeed (or maxspeed:forward/backward) tag, counted in the US extract in October 2026:

  | road class | maxspeed tagged | lanes tagged |
  |---|---|---|
  | motorway | 94% | 99% |
  | trunk | 80% | 97% |
  | primary | 67% | 86% |
  | secondary | 52% | 72% |
  | tertiary | 32% | 49% |
  | unclassified | 12% | 18% |
  | residential | 10% | 9% |

  So freeways look solid and small streets are mostly grey "no data". Untagged roads are shown as such, never guessed.
  Filling the gaps would need another source (the federal HPMS dataset is a candidate; not used here).
- Bare numbers (`maxspeed=45`) are read as mph up to 85 and as km/h above that; values with a unit are converted. Values
  that are not numbers (`none`, `signals`, conditional limits) count as no data. On roads with different limits per
  direction the higher one is shown.
- Lane counts follow OSM semantics: on a one-way carriageway the tag is lanes for that carriageway, on a two-way road it
  is the total. Dual carriageways are two lines, so each is drawn at its own width.
- Where a road carries several routes, one shield is shown: Interstate over US over state over everything else.
- Roads that are not in OSM as `highway=motorway ... residential` (service roads, tracks, paths) are not included.

## Licences and credit

Map data (c) OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Basemap tiles and fonts:
[OpenFreeMap](https://openfreemap.org) / (c) [OpenMapTiles](https://www.openmaptiles.org/). Shield renderer, shield
definitions and sprites: [OSM Americana](https://github.com/osm-americana/openstreetmap-americana) (CC0, vendored from
`@americana/maplibre-shield-generator` 0.1.1 and americanamap.org). MapLibre GL JS 5.24.0 (BSD-3), PMTiles 4.3.0 (BSD-3),
Planetiler (Apache-2.0), go-pmtiles (BSD-3).
