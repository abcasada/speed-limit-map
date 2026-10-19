import { URLShieldRenderer } from './vendor/maplibre-shield-generator.js';

// ---- configuration -------------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const config = await fetch('config.json').then((r) => r.json()).catch(() => ({}));
// `tiles` is one PMTiles file or a list of them (the national tileset is split into regional files to stay under
// GitHub's 100 MB file limit). ?tiles=a.pmtiles,b.pmtiles overrides the config.
const tileSpec = params.get('tiles')?.split(',') ?? config.tiles ?? 'data/us-highways.pmtiles';
const tilesUrls = [tileSpec].flat().map((t) => new URL(t.trim(), location.href).href);

// One colour per 5 mph step from 55 to 85; anything below 55 is white. Roads without a usable maxspeed are grey.
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

// ---- basemaps ------------------------------------------------------------------------------------------------------

// Full OpenStreetMap-based vector styles from OpenFreeMap. The road layers are drawn between the base map's own roads
// and its labels. Light themes need a dark outline so white (under 55 mph) roads stay visible.
const OFM = 'https://tiles.openfreemap.org';
const BASEMAPS = {
  light: {
    label: 'Light', url: `${OFM}/styles/positron`,
    unknown: '#9aa4af', unknownOpacity: 1,
    casing: '#2b323b', casingOpacity: 0.85, casingExtra: 1.6, casingMinZoom: 6,
  },
  streets: {
    label: 'Streets', url: `${OFM}/styles/liberty`,
    unknown: '#7d8791', unknownOpacity: 0.45,
    casing: '#2b323b', casingOpacity: 0.85, casingExtra: 1.6, casingMinZoom: 6,
  },
  dark: {
    label: 'Dark', url: `${OFM}/styles/dark`,
    unknown: '#5f6b7a', unknownOpacity: 1,
    casing: '#05080b', casingOpacity: 0.7, casingExtra: 1.2, casingMinZoom: 8,
  },
};

function storedTheme() {
  try { return localStorage.getItem('basemap'); } catch { return null; }
}
function rememberTheme(name) {
  try { localStorage.setItem('basemap', name); } catch { /* private mode etc. */ }
}
let themeName = [params.get('map'), storedTheme(), 'light'].find((t) => BASEMAPS[t]);

// ---- road layers ---------------------------------------------------------------------------------------------------

const roadAttribution = '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';
const roadSources = Object.fromEntries(
  tilesUrls.map((url, i) => [`roads${i}`, { type: 'vector', url: `pmtiles://${url}`, attribution: roadAttribution }]),
);

// Layers are created per tile file. Within each kind: no-data roads first so roads with a known limit draw on top;
// higher route rank draws above lower.
function buildRoadLayers(theme) {
  const base = (source) => ({ source, 'source-layer': 'highways' });
  const line = () => ({ 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'rk'] });
  const layers = { unknown: [], casing: [], known: [], shields: [] };
  for (const source of Object.keys(roadSources)) {
    layers.unknown.push({
      id: `roads-unknown-${source}`, type: 'line', ...base(source),
      filter: ['!', ['has', 'speed']],
      layout: line(),
      paint: { 'line-color': theme.unknown, 'line-opacity': theme.unknownOpacity, 'line-width': laneWidth() },
    });
    layers.casing.push({
      id: `roads-casing-${source}`, type: 'line', ...base(source), minzoom: theme.casingMinZoom,
      filter: ['has', 'speed'],
      layout: line(),
      paint: { 'line-color': theme.casing, 'line-opacity': theme.casingOpacity, 'line-width': laneWidth(theme.casingExtra) },
    });
    layers.known.push({
      id: `roads-known-${source}`, type: 'line', ...base(source),
      filter: ['has', 'speed'],
      layout: line(),
      paint: { 'line-color': speedColor, 'line-width': laneWidth() },
    });
    layers.shields.push({
      id: `shields-${source}`, type: 'symbol', ...base(source), minzoom: 6,
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
  return layers;
}
let roadLayers = buildRoadLayers(BASEMAPS[themeName]);
const layerIds = (kind) => roadLayers[kind].map((l) => l.id);

const baseStyleCache = {};
async function loadBaseStyle(name) {
  baseStyleCache[name] ??= fetch(BASEMAPS[name].url).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  });
  try {
    return await baseStyleCache[name];
  } catch (e) {
    delete baseStyleCache[name];
    throw e;
  }
}

// Last-resort background if the basemap style cannot be fetched at all.
const fallbackStyle = () => ({
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': themeName === 'dark' ? '#0b0f14' : '#e9ecef' } }],
});

function composeStyle(base, theme) {
  const style = structuredClone(base);
  style.sources = { ...style.sources, ...roadSources };
  // the base map's own route-number signs would duplicate ours
  for (const layer of style.layers) {
    if (layer.id.includes('shield')) layer.layout = { ...layer.layout, visibility: 'none' };
  }
  roadLayers = buildRoadLayers(theme);
  // above every base fill/line (so base roads and landuse never cover ours); the base map's labels stay on top
  const at = style.layers.findLastIndex((l) => l.type !== 'symbol') + 1;
  style.layers.splice(at, 0, ...roadLayers.unknown, ...roadLayers.casing, ...roadLayers.known);
  style.layers.push(...roadLayers.shields);
  return style;
}

// ---- shield sprites ------------------------------------------------------------------------------------------------

// The shield renderer draws on top of blank sprites (shield outlines) that live in a sprite sheet. Base styles bring
// their own sprite, so ours are added to the map by hand after every style load.
const spriteSuffix = devicePixelRatio >= 1.5 ? '@2x' : '';
const spriteImages = await (async () => {
  try {
    const [meta, image] = await Promise.all([
      fetch(`shields/sprite${spriteSuffix}.json`).then((r) => r.json()),
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = `shields/sprite${spriteSuffix}.png`;
      }),
    ]);
    return Promise.all(Object.entries(meta).map(async ([name, d]) => ({
      name,
      bitmap: await createImageBitmap(image, d.x, d.y, d.width, d.height),
      pixelRatio: d.pixelRatio,
    })));
  } catch (e) {
    console.warn('shield sprites failed to load', e);
    return [];
  }
})();

function addSpriteImages(map) {
  for (const { name, bitmap, pixelRatio } of spriteImages) {
    if (!map.hasImage(name)) map.addImage(name, bitmap, { pixelRatio });
  }
}

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

async function styleFor(name) {
  try {
    return composeStyle(await loadBaseStyle(name), BASEMAPS[name]);
  } catch (e) {
    showStatus(`Could not load the "${BASEMAPS[name].label}" basemap (${e.message || e}); showing a plain background.`);
    const style = fallbackStyle();
    style.sources = { ...roadSources };
    roadLayers = buildRoadLayers(BASEMAPS[name]);
    style.layers.push(...roadLayers.unknown, ...roadLayers.casing, ...roadLayers.known, ...roadLayers.shields);
    return style;
  }
}

const view = config.view || {};
const map = new maplibregl.Map({
  container: 'map',
  style: await styleFor(themeName),
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

// panel toggles survive basemap switches
const toggles = { unknown: true, shields: true };
const applyToggles = () => {
  for (const kind of Object.keys(toggles)) {
    for (const id of layerIds(kind)) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', toggles[kind] ? 'visible' : 'none');
    }
  }
};
map.on('style.load', () => {
  addSpriteImages(map);
  applyToggles();
});

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

let baseWarned = false;
map.on('error', (e) => {
  const url = e?.source?.url || e?.error?.url || '';
  if (String(url).includes('.pmtiles') || e?.sourceId?.startsWith('roads')) {
    showStatus('Problem loading road tiles: ' + (e.error?.message || 'unknown error'));
  } else if (e?.sourceId && !baseWarned && !String(e.error?.message).includes('aborted')) {
    baseWarned = true;
    showStatus(`Basemap tiles failed to load (${e.error?.message || 'unknown error'}). Is tiles.openfreemap.org blocked on this network?`);
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

const hitLayers = () => [...layerIds('known'), ...layerIds('unknown')].filter((id) => map.getLayer(id));

map.on('click', (e) => {
  const pad = 8;
  const hits = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], {
    layers: hitLayers(),
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
  const hit = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: hitLayers() });
  map.getCanvas().style.cursor = hit.length ? 'pointer' : '';
});

// ---- panel ---------------------------------------------------------------------------------------------------------

const legend = document.getElementById('legend');
function renderLegend() {
  const rows = [
    [BELOW_COLOR, 'under 55'],
    ...SPEED_COLORS.map(([mph, color], i) => [color, i === SPEED_COLORS.length - 1 ? `${mph}+` : `${mph}`]),
    [BASEMAPS[themeName].unknown, 'no data'],
  ];
  legend.replaceChildren(...rows.map(([color, label]) => {
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = color;
    swatch.style.outline = '1px solid rgba(0, 0, 0, 0.55)';
    li.append(swatch, document.createTextNode(label));
    return li;
  }));
}
renderLegend();

const panel = document.getElementById('panel');
if (matchMedia('(max-width: 600px)').matches) panel.open = false;

document.getElementById('toggle-unknown').addEventListener('change', (e) => { toggles.unknown = e.target.checked; applyToggles(); });
document.getElementById('toggle-shields').addEventListener('change', (e) => { toggles.shields = e.target.checked; applyToggles(); });

const basemapPicker = document.getElementById('basemap');
for (const [name, theme] of Object.entries(BASEMAPS)) basemapPicker.append(new Option(theme.label, name));
basemapPicker.value = themeName;
basemapPicker.addEventListener('change', async () => {
  themeName = basemapPicker.value;
  rememberTheme(themeName);
  statusEl.hidden = true;
  baseWarned = false;
  renderLegend();
  map.setStyle(await styleFor(themeName), { diff: false });
});

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
