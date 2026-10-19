# US Speed Limit Map

A zoomable map of every US road down to residential streets, coloured by posted speed limit, drawn from OpenStreetMap.

- **Colour** = posted speed: white under 55 mph, then a continuous gradient from bright green at 55 through bright yellow
  at 70 to bright red at 85 (a 62 mph limit is a yellowish green, an 80 an orange-red), and pink above 85. Roads with no
  usable `maxspeed` tag are grey (toggle in the panel).
- **Width** = number of lanes (OSM `lanes` tag). Roads without the tag fall back to a typical lane count for their class.
- **Signs** = route shields: Interstate, US route and each state's own state-route shield (plus county routes, toll roads,
  business loops, ...), drawn by the [Americana shield renderer](https://github.com/osm-americana/openstreetmap-americana/tree/main/shieldlib).
- **Basemaps** (selector in the panel): Light (default), Streets and Dark, the full OpenStreetMap-based vector styles from
  [OpenFreeMap](https://openfreemap.org), fetched at runtime. If they cannot be reached the page shows a banner and falls
  back to a plain background. White (under 55 mph) roads get a dark outline so they stay visible on the light maps.
- Tap/click a road for its speed, lanes, route and type.
- **Fix-it mode** (switch at the top of the panel, or `?mode=fix`): instead of speeds, highlights roads an OpenStreetMap
  contributor might want to check. See below.

It is a static site (`docs/`) plus PMTiles files. No server code.

```
tiles/HighwaySpeedProfile.java   Planetiler profile: OSM -> vector tiles with speed, lanes, route shield, rank
tiles/build.sh                   download extract -> filter roads -> build data/us-highways.pmtiles
tiles/shard.sh                   split a tileset into <100 MB files for git / GitHub Pages
docs/qa-rules.js                 the fix-it mode rules (add new rules here)
docs/                            the web app (MapLibre GL JS + PMTiles) and the published tiles (docs/data/roads-*.pmtiles,
                                 docs/data/routes.pmtiles)
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

Route shields come from a second, small tileset (`docs/data/routes.pmtiles`, 43 MB): only roads that belong to a signed
route, merged into long lines per route so shields are spaced evenly along it and can appear from the default zoom.
They are drawn in tiers (Interstates from zoom 3, US routes from 5, state routes from 7, county and other routes from 11,
each matching the zoom where those roads first appear), and collision detection hides whatever does not fit.

## Fix-it mode

Highlights, on a faint copy of every road, the things worth investigating or fixing in OpenStreetMap. Tap a road to see
which rules flag it and to open that spot on openstreetmap.org or in the iD editor. Each rule can be switched on and off in
the legend. Current rules:

| rule | flags |
|---|---|
| No speed limit tagged | no `maxspeed` at all (the vast majority of small streets) |
| maxspeed tag present but unreadable | a value that is not a plain number: lists, `signals`, free text (zoom 10+) |
| Not a multiple of 5 mph | e.g. 24 or 62 mph, almost always a typo or a km/h value converted to mph |
| Implausible: over 85 mph | no US road is posted above 85 |
| Implausible: street at 60+ mph | residential / living street |
| Implausible: minor road at 70+ mph | unclassified road |
| Implausible: freeway at 10 mph or less | motorway (ramps share this class, see below) |

The thresholds come from looking at the data: residential roads at 55 mph are common on rural roads that are probably
just mis-classified (about 7,700 segments), whereas 60+ is only about 140.

**Adding a rule:** append an object to `QA_RULES` in `docs/qa-rules.js` (id, label, description, colour and a MapLibre
filter expression over the properties in the tiles; the file documents which properties exist). Rules run in the browser,
so no tile rebuild is needed. The legend, per-rule checkboxes, map layers and popup text all come from that list.
Ideas that need more data in the tiles first (ramps, adjacent-segment comparisons, conditional limits, ...) are listed in
`PLANNED_RULES` in the same file along with what each would need added to the tile profile.

Limits of the current rules: tiles store ramps under their parent class, so a freeway-speed check cannot tell a slow
ramp from a slow freeway (hence the low threshold), and the raw `maxspeed` text is only in the tiles from zoom 10.

## Rebuild the tiles

```sh
./tiles/build.sh --maxzoom=12      # needs Java 21+, curl; osmium-tool strongly recommended
./tiles/shard.sh data/us-highways.pmtiles docs/data
```

For a bigger local-only build with deeper data (zoom 14, about 1.7 GB, sharper geometry when zoomed far in), run
`./tiles/build.sh` and open `http://localhost:8080/?tiles=/data/us-highways.pmtiles&routes=/data/us-routes.pmtiles`. `--minor=false` leaves out
unclassified and residential streets (173 MB at zoom 12). Details and knobs are in the header of `tiles/build.sh`.

`?tiles=a.pmtiles,b.pmtiles&routes=r.pmtiles` points the app at any PMTiles files served with HTTP Range support (own server, S3,
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
