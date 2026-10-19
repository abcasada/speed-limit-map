import { URLShieldRenderer } from './vendor/maplibre-shield-generator.js';

// ---- configuration -------------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const config = await fetch('config.json').then((r) => r.json()).catch(() => ({}));
// `tiles` is one PMTiles file or a list of them (the national tileset is split into regional files to stay under
// GitHub's 100 MB file limit). ?tiles=a.pmtiles,b.pmtiles overrides the config.
const tileSpec = params.get('tiles')?.split(',') ?? config.tiles ?? 'data/us-highways.pmtiles';
const tilesUrls = [tileSpec].flat().map((t) => new URL(t.trim(), location.href).href);

// One colour per 5 mph step from 55 to 85; anything below 55 is white. Roads without a usable maxspeed are dim grey.
const SPEED_COLORS = [
  [55, '#3d8bff'],
  [60, '#19d3da'],
  [65, '#3ddc6a'],
  [70, '#f2e03a'],
  [75, '#ff9f1a'],
  [80, '#ff4d4d'],
  [85, '#e040fb'],
];
const BELOW_COLOR = '#ffffff';
const UNKNOWN_COLOR = '#5f6b7a';

const speedColor = ['step', ['to-number', ['get', 'speed']], BELOW_COLOR, ...SPEED_COLORS.flat()];

// Width is proportional to the OSM `lanes` tag. Roads without the tag fall back to a typical lane count for their class.
const laneCount = [
  'min', 8,
  [
    'case',
    ['has', 'lanes'], ['to-number', ['get', 'lanes']],
    ['match', ['get', 'hw'], ['unclassified'], 1.5, ['residential', 'living_street'], 1, 2],
  ],
];
const PER_LANE_PX = [[3, 0.4], [6, 0.65], [10, 1.0], [14, 1.8], [18, 4.2], [20, 8]];
const laneWidth = (extra = 0) => [
  'interpolate', ['linear'], ['zoom'],
  ...PER_LANE_PX.flatMap(([z, px]) => [z, ['+', ['*', laneCount, px], extra]]),
];

// ---- map style -----------------------------------------------------------------------------------------------------

const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
const placeName = ['coalesce', ['get', 'name:en'], ['get', 'name']];
const labelPaint = { 'text-color': '#9aa7b5', 'text-halo-color': '#0b0f14', 'text-halo-width': 1.4 };

const roadAttribution = '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';
const roadSources = Object.fromEntries(
  tilesUrls.map((url, i) => [`roads${i}`, { type: 'vector', url: `pmtiles://${url}`, attribution: roadAttribution }]),
);

// Layers are created per tile file. Within each kind the order is: no-data roads first so roads with a known limit
// draw on top; higher route rank draws above lower.
const roadLayerBase = (source) => ({ source, 'source-layer': 'highways' });
const roadLine = { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'rk'] };
const roadLayers = { unknown: [], casing: [], known: [], shields: [] };
for (const source of Object.keys(roadSources)) {
  roadLayers.unknown.push({
    id: `roads-unknown-${source}`, type: 'line', ...roadLayerBase(source),
    filter: ['!', ['has', 'speed']],
    layout: { ...roadLine },
    paint: { 'line-color': UNKNOWN_COLOR, 'line-width': laneWidth() },
  });
  roadLayers.casing.push({
    id: `roads-casing-${source}`, type: 'line', ...roadLayerBase(source), minzoom: 8,
    filter: ['has', 'speed'],
    layout: { ...roadLine },
    paint: { 'line-color': '#05080b', 'line-opacity': 0.7, 'line-width': laneWidth(1.2) },
  });
  roadLayers.known.push({
    id: `roads-known-${source}`, type: 'line', ...roadLayerBase(source),
    filter: ['has', 'speed'],
    layout: { ...roadLine },
    paint: { 'line-color': speedColor, 'line-width': laneWidth() },
  });
  roadLayers.shields.push({
    id: `shields-${source}`, type: 'symbol', ...roadLayerBase(source), minzoom: 6,
    filter: ['has', 'sh'],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 420,
      'icon-image': ['image', ['concat', 'shield|', ['get', 'sh']]],
      'icon-rotation-alignment': 'viewport',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 10, 0.65, 14, 0.85, 18, 1],
      'symbol-sort-key': ['-', 5, ['get', 'rk']],
    },
  });
}
const layerIds = (kind) => roadLayers[kind].map((l) => l.id);

const style = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sprite: new URL('shields/sprite', location.href).href,
  sources: {
    base: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a>' },
    ...roadSources,
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0b0f14' } },
    { id: 'landcover', type: 'fill', source: 'base', 'source-layer': 'landcover', paint: { 'fill-color': '#0f1a15', 'fill-opacity': 0.8 } },
    { id: 'park', type: 'fill', source: 'base', 'source-layer': 'park', paint: { 'fill-color': '#0f1c16', 'fill-opacity': 0.8 } },
    { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': '#10283d' } },
    { id: 'waterway', type: 'line', source: 'base', 'source-layer': 'waterway', minzoom: 8, paint: { 'line-color': '#10283d', 'line-width': 1 } },
    {
      id: 'boundary-state', type: 'line', source: 'base', 'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 4], ['==', ['get', 'maritime'], 0]],
      paint: { 'line-color': '#4a5666', 'line-width': 0.8, 'line-dasharray': [3, 2] },
    },
    {
      id: 'boundary-country', type: 'line', source: 'base', 'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['==', ['get', 'maritime'], 0]],
      paint: { 'line-color': '#7b8797', 'line-width': 1.2 },
    },

    ...roadLayers.unknown,
    ...roadLayers.casing,
    ...roadLayers.known,

    {
      id: 'road-names', type: 'symbol', source: 'base', 'source-layer': 'transportation_name', minzoom: 14,
      layout: {
        'symbol-placement': 'line', 'text-field': placeName, 'text-font': FONT, 'text-size': 11,
        'text-letter-spacing': 0.02,
      },
      paint: { ...labelPaint, 'text-color': '#c4ccd6', 'text-halo-width': 1.8 },
    },
    ...roadLayers.shields,

    {
      id: 'place-state', type: 'symbol', source: 'base', 'source-layer': 'place', minzoom: 3, maxzoom: 7,
      filter: ['==', ['get', 'class'], 'state'],
      layout: { 'text-field': placeName, 'text-font': FONT, 'text-size': 11, 'text-transform': 'uppercase', 'text-letter-spacing': 0.12, 'text-max-width': 6 },
      paint: { ...labelPaint, 'text-color': '#6f7c8b' },
    },
    ...[
      ['place-city', ['city'], 4, 8, 17],
      ['place-town', ['town'], 8, 10, 15],
      ['place-village', ['village', 'suburb'], 11, 11, 14],
    ].map(([id, classes, minzoom, minSize, maxSize]) => ({
      id, type: 'symbol', source: 'base', 'source-layer': 'place', minzoom,
      filter: ['in', ['get', 'class'], ['literal', classes]],
      layout: {
        'text-field': placeName, 'text-font': id === 'place-city' ? FONT_BOLD : FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], minzoom, minSize, 14, maxSize],
        'text-max-width': 8, 'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: labelPaint,
    })),
  ],
};

// ---- map -----------------------------------------------------------------------------------------------------------

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const archives = tilesUrls.map((url) => {
  const archive = new pmtiles.PMTiles(url);
  protocol.add(archive);
  return archive;
});

const statusEl = document.getElementById('status');
const showStatus = (msg) => { statusEl.textContent = msg; statusEl.hidden = false; };

const headers = await Promise.all(archives.map((archive, i) => archive.getHeader().catch((e) => {
  showStatus(`Could not open the road tiles (${tilesUrls[i]}). ${e.message || e}`);
  return null;
})));
const bounds = headers.filter(Boolean).reduce((b, h) => ({
  minLon: Math.min(b.minLon, h.minLon), maxLon: Math.max(b.maxLon, h.maxLon),
  minLat: Math.min(b.minLat, h.minLat), maxLat: Math.max(b.maxLat, h.maxLat),
}), { minLon: 180, maxLon: -180, minLat: 90, maxLat: -90 });
const hasBounds = bounds.minLon <= bounds.maxLon;

const view = config.view || {};
const map = new maplibregl.Map({
  container: 'map',
  style,
  center: view.center || (hasBounds ? [(bounds.minLon + bounds.maxLon) / 2, (bounds.minLat + bounds.maxLat) / 2] : [-98.5, 39.5]),
  zoom: view.zoom ?? 4,
  minZoom: 2,
  maxZoom: 20,
  hash: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
map.touchZoomRotate.disableRotation();
map.dragRotate.disable();

const shieldParser = {
  // image ids look like `shield|US:I=70|`: network, ref, optional name
  parse: (id) => {
    const [, networkRef, name] = id.split('|');
    const eq = networkRef.indexOf('=');
    return { network: networkRef.slice(0, eq), ref: networkRef.slice(eq + 1), name };
  },
  format: (network, ref, name) => `shield|${network}=${ref}|${name ?? ''}`,
};
new URLShieldRenderer(new URL('shields/shields.json', location.href).href, shieldParser)
  .filterImageID((id) => id.startsWith('shield|'))
  .renderOnMaplibreGL(map);

map.on('error', (e) => {
  const url = e?.source?.url || e?.error?.url || '';
  if (String(url).includes('.pmtiles') || e?.sourceId?.startsWith('roads')) {
    showStatus('Problem loading road tiles: ' + (e.error?.message || 'unknown error'));
  }
  console.warn(e.error || e);
});

// ---- popup ---------------------------------------------------------------------------------------------------------

const ROAD_CLASS = {
  motorway: 'Freeway', trunk: 'Trunk road', primary: 'Primary road', secondary: 'Secondary road',
  tertiary: 'Tertiary road', unclassified: 'Minor road', residential: 'Residential street', living_street: 'Living street',
};

function describe(props) {
  const rows = [];
  rows.push(['Speed limit', props.speed ? `${props.speed} mph` : 'not tagged in OSM']);
  if (props.maxspeed && String(props.maxspeed) !== `${props.speed} mph`) rows.push(['OSM maxspeed', props.maxspeed]);
  rows.push(['Lanes', props.lanes ? String(props.lanes) : 'not tagged']);
  if (props.ref) rows.push(['Route', props.ref]);
  rows.push(['Type', ROAD_CLASS[props.hw] || props.hw]);
  return rows;
}

map.on('click', (e) => {
  const pad = 8;
  const hits = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], {
    layers: [...layerIds('known'), ...layerIds('unknown')],
  });
  if (!hits.length) return;
  const props = hits[0].properties;

  const box = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = props.name || props.ref || ROAD_CLASS[props.hw] || 'Road';
  const list = document.createElement('dl');
  for (const [k, v] of describe(props)) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    list.append(dt, dd);
  }
  box.append(title, list);
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setDOMContent(box).addTo(map);
});
map.on('mousemove', (e) => {
  const hit = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: [...layerIds('known'), ...layerIds('unknown')] });
  map.getCanvas().style.cursor = hit.length ? 'pointer' : '';
});

// ---- panel ---------------------------------------------------------------------------------------------------------

const legend = document.getElementById('legend');
const legendRows = [
  [BELOW_COLOR, 'under 55'],
  ...SPEED_COLORS.map(([mph, color], i) => [color, i === SPEED_COLORS.length - 1 ? `${mph}+` : `${mph}`]),
  [UNKNOWN_COLOR, 'no data'],
];
for (const [color, label] of legendRows) {
  const li = document.createElement('li');
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = color;
  li.append(swatch, document.createTextNode(label));
  legend.append(li);
}

const panel = document.getElementById('panel');
if (matchMedia('(max-width: 600px)').matches) panel.open = false;

const setVisible = (ids, visible) => {
  for (const id of ids) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
};
document.getElementById('toggle-unknown').addEventListener('change', (e) => setVisible(layerIds('unknown'), e.target.checked));
document.getElementById('toggle-shields').addEventListener('change', (e) => setVisible(layerIds('shields'), e.target.checked));

const picker = document.getElementById('bookmarks');
if (config.bookmarks?.length) {
  picker.append(new Option('Jump to…', ''));
  config.bookmarks.forEach((b, i) => picker.append(new Option(b.name, String(i))));
  picker.hidden = false;
  picker.addEventListener('change', () => {
    const b = config.bookmarks[Number(picker.value)];
    if (b) map.flyTo({ center: b.center, zoom: b.zoom });
    picker.value = '';
  });
}
