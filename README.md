# US Speed Limit Map

A zoomable map of US roads coloured by posted speed limit, drawn from OpenStreetMap.

- **Colour** = posted speed: white under 55 mph, then one colour per 5 mph step (55, 60, 65, 70, 75, 80, 85+).
  Roads with no usable `maxspeed` tag are dim grey (toggle in the panel).
- **Width** = number of lanes (OSM `lanes` tag). Roads without the tag fall back to a typical lane count for their class.
- **Signs** = real route shields: Interstate, US route and each state's own state-route shield (plus county routes), drawn
  by the [Americana shield renderer](https://github.com/osm-americana/openstreetmap-americana/tree/main/shieldlib).
- Tap/click a road for its speed, lanes, route and type.

It is a static site (`docs/`) plus one tile file. No server code.

```
tiles/HighwaySpeedProfile.java   Planetiler profile: OSM -> vector tiles with speed, lanes, route shield, rank
tiles/build.sh                   download extract -> filter roads -> build data/us-highways.pmtiles
docs/                            the web app (MapLibre GL JS + PMTiles), GitHub Pages root
docs/data/demo.pmtiles           small sample (four areas) so the site works before you build the full tileset
server.mjs                       local dev server (supports HTTP Range requests, which PMTiles needs)
```

## Run it locally

```sh
node server.mjs            # http://localhost:8080/  (shows the demo tiles)
```

## Build the full-US tiles

```sh
./tiles/build.sh           # needs Java 21+, curl; osmium-tool recommended
node server.mjs            # then open http://localhost:8080/?tiles=/data/us-highways.pmtiles
```

Details and knobs are in the header of `tiles/build.sh`. `--minor=false` drops unclassified/residential streets for a much
smaller file.

`?tiles=<url>` points the app at any PMTiles file served with HTTP Range support (S3, Cloudflare R2, GitHub release
assets are not guaranteed to work - test first). To make a tileset the default, edit `docs/config.json`.

## Publish on GitHub Pages

Repository **Settings -> Pages -> Build and deployment -> Source: Deploy from a branch**, pick the branch and the
**/docs** folder. The site is then at `https://<user>.github.io/<repo>/`. Everything it needs is vendored under `docs/`
(MapLibre, PMTiles, shield renderer and artwork); the only third-party requests are the dark basemap tiles and fonts from
OpenFreeMap.

GitHub Pages limits: 1 GB per site, 100 MB per file in git. The demo tiles are well under that; a full-US tileset is not,
so host that elsewhere and point `config.json` (or `?tiles=`) at it.

## Data caveats

- **Speed limits come from the OSM `maxspeed` tag, which is far from complete in the US.** Freeways and major arterials
  are tagged much more often than local streets; large parts of the map will be grey "no data". Untagged roads are shown
  as such, never guessed.
- Bare numbers (`maxspeed=45`) are read as mph up to 85 and as km/h above that; values with a unit are converted. Values
  that are not numbers (`none`, `signals`, conditional limits) count as no data. On roads with different limits per
  direction the higher one is shown.
- Lane counts follow OSM semantics: on a one-way carriageway the tag is lanes for that carriageway, on a two-way road it
  is the total. Dual carriageways are two lines, so each is drawn at its own width.
- Where a road carries several routes, one shield is shown: Interstate over US over state over everything else.

## Licences and credit

Map data (c) OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Basemap tiles and fonts:
[OpenFreeMap](https://openfreemap.org) / (c) [OpenMapTiles](https://www.openmaptiles.org/). Shield renderer, shield
definitions and sprites: [OSM Americana](https://github.com/osm-americana/openstreetmap-americana) (CC0, vendored from
`@americana/maplibre-shield-generator` 0.1.1 and americanamap.org). MapLibre GL JS 5.24.0 (BSD-3), PMTiles 4.3.0 (BSD-3),
Planetiler (Apache-2.0).
