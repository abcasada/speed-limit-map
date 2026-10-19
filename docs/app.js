import { URLShieldRenderer } from './vendor/maplibre-shield-generator.js';
import { QA_RULES } from './qa-rules.js';

// ---- configuration -------------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const config = await fetch('config.json').then((r) => r.json()).catch(() => ({}));
// `tiles` is one PMTiles file or a list of them (the national tileset is split into regional files to stay under
// GitHub's 100 MB file limit). ?tiles=a.pmtiles,b.pmtiles overrides the config.
const tileSpec = params.get('tiles')?.split(',') ?? config.tiles ?? 'data/us-highways.pmtiles';
const tilesUrls = [tileSpec].flat().map((t) => new URL(t.trim(), location.href).href);
// Optional companion tiles with just the signed routes, used to place shields evenly along each route and from low
// zooms. Without them shields come from the main road tiles (and only appear from zoom 6).
const routeSpec = params.get('routes')?.split(',') ?? config.routes ?? [];
const routesUrls = [routeSpec].flat().filter(Boolean).map((t) => new URL(t.trim(), location.href).href);

// Speed colours: white below 55 mph, then a continuous gradient from bright green at 55 through bright yellow at 70 to
// bright red at 85 (so a 62 mph limit is a yellowish green and an 80 is an orange-red), pink above 85. Roads without a
// usable maxspeed use the basemap's "no data" grey (see BASEMAPS).
const GRADIENT = [[55, '#00e03c'], [70, '#ffe600'], [85, '#ff1a1a']];
const BELOW_COLOR = '#ffffff';
const OVER_COLOR = '#ff66cc';

const speedNumber = ['to-number', ['get', 'speed']];
const speedColor = [
  'case',
  ['<', speedNumber, GRADIENT[0][0]], BELOW_COLOR,
  ['>', speedNumber, GRADIENT.at(-1)[0]], OVER_COLOR,
  ['interpolate', ['linear'], speedNumber, ...GRADIENT.flat()],
];

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

// ---- modes and layer visibility ------------------------------------------------------------------------------------

// "speed": roads coloured by posted limit. "fix": roads that may need fixing in OpenStreetMap (rules in qa-rules.js).
let mode = params.get('mode') === 'fix' ? 'fix' : 'speed';
// panel state survives basemap and mode switches
const toggles = { unknown: true, shields: true };
const qaEnabled = new Set(QA_RULES.map((rule) => rule.id));

/** Whether a kind of road layer should currently be shown. */
const kindVisible = (kind) => {
  const fix = mode === 'fix';
  return { casing: !fix, known: !fix, unknown: !fix && toggles.unknown, qaContext: fix, shields: toggles.shields }[kind];
};
const ruleVisible = (rule) => mode === 'fix' && qaEnabled.has(rule.id);
const visibility = (visible) => (visible ? 'visible' : 'none');

// ---- road layers ---------------------------------------------------------------------------------------------------

const roadAttribution = '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';
const roadSources = Object.fromEntries(
  tilesUrls.map((url, i) => [`roads${i}`, { type: 'vector', url: `pmtiles://${url}`, attribution: roadAttribution }]),
);
const routeSources = Object.fromEntries(
  routesUrls.map((url, i) => [`routes${i}`, { type: 'vector', url: `pmtiles://${url}`, attribution: roadAttribution }]),
);
const shieldSources = routesUrls.length ? routeSources : roadSources;
const shieldSourceLayer = routesUrls.length ? 'routes' : 'highways';

// Shields are drawn in tiers by route rank (4 Interstate, 3 US, 2 state, 1 county/other). Each tier starts at the zoom
// where its roads first appear on the map (see minZoom() in the tile profile), so a shield never floats over nothing.
// Collision detection then shows as many as fit without overlapping: layers further down the list win, so Interstates
// are placed first, then US routes, and so on, and the lesser routes only fill whatever room is left.
const SHIELD_TIERS = [
  { rk: 1, minzoom: 11 },
  { rk: 2, minzoom: 7 },
  { rk: 3, minzoom: 5 },
  { rk: 4, minzoom: 3 },
];

// Layers are created per tile file. Within each kind: no-data roads first so roads with a known limit draw on top;
// higher route rank draws above lower.
function buildRoadLayers(theme) {
  const base = (source) => ({ source, 'source-layer': 'highways' });
  const line = (kind) => ({
    'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'rk'],
    ...(kind && { visibility: visibility(kindVisible(kind)) }),
  });
  const layers = { unknown: [], casing: [], known: [], qaContext: [], qa: [], shields: [] };
  for (const source of Object.keys(roadSources)) {
    layers.unknown.push({
      id: `roads-unknown-${source}`, type: 'line', ...base(source),
      filter: ['!', ['has', 'speed']],
      layout: line('unknown'),
      paint: { 'line-color': theme.unknown, 'line-opacity': theme.unknownOpacity, 'line-width': laneWidth() },
    });
    layers.casing.push({
      id: `roads-casing-${source}`, type: 'line', ...base(source), minzoom: theme.casingMinZoom,
      filter: ['has', 'speed'],
      layout: line('casing'),
      paint: { 'line-color': theme.casing, 'line-opacity': theme.casingOpacity, 'line-width': laneWidth(theme.casingExtra) },
    });
    layers.known.push({
      id: `roads-known-${source}`, type: 'line', ...base(source),
      filter: ['has', 'speed'],
      layout: line('known'),
      paint: { 'line-color': speedColor, 'line-width': laneWidth() },
    });
  }
  // Fix-it mode: every road as faint context, then one layer per rule from qa-rules.js (hidden until that mode is on)
  for (const source of Object.keys(roadSources)) {
    layers.qaContext.push({
      id: `qa-context-${source}`, type: 'line', ...base(source),
      layout: line('qaContext'),
      paint: { 'line-color': theme.unknown, 'line-opacity': 0.5, 'line-width': laneWidth() },
    });
    for (const rule of QA_RULES) {
      layers.qa.push({
        id: `qa-${rule.id}-${source}`, type: 'line', ...base(source), minzoom: rule.minzoom ?? 0,
        filter: rule.filter,
        layout: { ...line(), visibility: visibility(ruleVisible(rule)) },
        paint: { 'line-color': rule.color, 'line-width': laneWidth(rule.extraWidth ?? 0.8) },
      });
    }
  }
  for (const source of Object.keys(shieldSources)) {
    for (const { rk, minzoom } of SHIELD_TIERS) {
      layers.shields.push({
        id: `shields-${rk}-${source}`, type: 'symbol', source, 'source-layer': shieldSourceLayer, minzoom,
        filter: ['all', ['has', 'sh'], ['==', ['get', 'rk'], rk]],
        layout: {
          visibility: visibility(kindVisible('shields')),
          'symbol-placement': 'line',
          'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 2, 200, 6, 280, 12, 380],
          'icon-image': ['image', ['concat', 'shield|', ['get', 'sh']]],
          'icon-rotation-alignment': 'viewport',
          'icon-padding': 6,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.4, 6, 0.5, 10, 0.65, 14, 0.85, 18, 1],
        },
      });
    }
  }
  return layers;
}
let roadLayers = buildRoadLayers(BASEMAPS[themeName]);
const layerIds = (kind) => roadLayers[kind].map((l) => l.id);
const ruleLayerIds = (rule) => Object.keys(roadSources).map((source) => `qa-${rule.id}-${source}`);

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
  style.sources = { ...style.sources, ...roadSources, ...routeSources };
  // the base map's own route-number signs would duplicate ours
  for (const layer of style.layers) {
    if (layer.id.includes('shield')) layer.layout = { ...layer.layout, visibility: 'none' };
  }
  roadLayers = buildRoadLayers(theme);
  // above every base fill/line (so base roads and landuse never cover ours); the base map's labels stay on top
  const at = style.layers.findLastIndex((l) => l.type !== 'symbol') + 1;
  style.layers.splice(at, 0, ...roadLayers.unknown, ...roadLayers.casing, ...roadLayers.known, ...roadLayers.qaContext, ...roadLayers.qa);
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
    style.sources = { ...roadSources, ...routeSources };
    roadLayers = buildRoadLayers(BASEMAPS[name]);
    style.layers.push(...roadLayers.unknown, ...roadLayers.casing, ...roadLayers.known, ...roadLayers.qaContext, ...roadLayers.qa, ...roadLayers.shields);
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

const setVisible = (ids, visible) => {
  for (const id of ids) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility(visible));
  }
};
function applyVisibility() {
  for (const kind of ['casing', 'known', 'unknown', 'qaContext', 'shields']) setVisible(layerIds(kind), kindVisible(kind));
  for (const rule of QA_RULES) setVisible(ruleLayerIds(rule), ruleVisible(rule));
}
map.on('style.load', () => {
  addSpriteImages(map);
  applyVisibility();
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

// all road layers that can be tapped; layers that are hidden in the current mode simply return nothing
const hitLayers = () => [...layerIds('qa'), ...layerIds('qaContext'), ...layerIds('known'), ...layerIds('unknown')]
  .filter((id) => map.getLayer(id));

const sameProps = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** Rules that flag this feature. Rules only look at a feature's properties, so any rendered feature with identical
 *  properties in a rule's layer means the rule flags it. */
function flaggedRules(box, props) {
  return QA_RULES.filter((rule) => qaEnabled.has(rule.id)
    && map.queryRenderedFeatures(box, { layers: ruleLayerIds(rule).filter((id) => map.getLayer(id)) })
      .some((f) => sameProps(f.properties, props)));
}

function element(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

map.on('click', (e) => {
  const pad = 8;
  const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const hits = map.queryRenderedFeatures(box, { layers: hitLayers() });
  if (!hits.length) return;
  const props = hits[0].properties;

  const content = document.createElement('div');
  content.append(element('h3', props.name || props.ref || ROAD_CLASS[props.hw] || 'Road'));
  const list = document.createElement('dl');
  for (const [k, v] of describe(props)) list.append(element('dt', k), element('dd', v));
  content.append(list);

  if (mode === 'fix') {
    const flags = flaggedRules(box, props);
    content.append(element('h4', flags.length ? 'Flagged because' : 'Not flagged by any enabled rule'));
    if (flags.length) {
      const ul = document.createElement('ul');
      for (const rule of flags) {
        const li = element('li', rule.label);
        li.title = rule.description;
        li.style.setProperty('--dot', rule.color);
        ul.append(li);
      }
      content.append(ul);
    }
    const where = `19/${e.lngLat.lat.toFixed(6)}/${e.lngLat.lng.toFixed(6)}`;
    const links = element('p', '', 'links');
    for (const [label, url] of [['View on OpenStreetMap', `https://www.openstreetmap.org/#map=${where}`],
      ['Edit in iD', `https://www.openstreetmap.org/edit#map=${where}`]]) {
      const a = element('a', label);
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      links.append(a);
    }
    content.append(links);
  }
  new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setDOMContent(content).addTo(map);
});
map.on('mousemove', (e) => {
  const hit = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: hitLayers() });
  map.getCanvas().style.cursor = hit.length ? 'pointer' : '';
});

// ---- panel ---------------------------------------------------------------------------------------------------------

const legend = document.getElementById('legend');
const note = document.getElementById('note');
const speedOptions = document.getElementById('speed-options');
const modeButtons = [...document.querySelectorAll('[data-mode]')];

const NOTES = {
  speed: 'Line width = number of lanes tagged in OpenStreetMap. Signs show the route (Interstate, US, state).',
  fix: 'Roads that may need fixing in OpenStreetMap. Faint grey = nothing flagged. Tap a road to see why it is flagged '
    + 'and open it in OSM. Rules are in docs/qa-rules.js.',
};

function swatch(color) {
  const el = document.createElement('span');
  el.className = 'swatch';
  el.style.background = color;
  return el;
}

function renderLegend() {
  note.textContent = NOTES[mode];
  speedOptions.hidden = mode === 'fix';
  if (mode === 'fix') {
    const ul = document.createElement('ul');
    ul.className = 'rules';
    for (const rule of QA_RULES) {
      const label = document.createElement('label');
      label.title = rule.description;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = qaEnabled.has(rule.id);
      box.addEventListener('change', () => {
        if (box.checked) qaEnabled.add(rule.id); else qaEnabled.delete(rule.id);
        applyVisibility();
      });
      label.append(box, swatch(rule.color), document.createTextNode(rule.label));
      const li = document.createElement('li');
      li.append(label);
      ul.append(li);
    }
    legend.replaceChildren(ul);
    return;
  }
  const [lo, mid, hi] = GRADIENT;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.background = `linear-gradient(to right, ${GRADIENT.map(([mph, color]) => `${color} ${((mph - lo[0]) / (hi[0] - lo[0])) * 100}%`).join(', ')})`;
  const ticks = document.createElement('div');
  ticks.className = 'ticks';
  ticks.append(element('span', `${lo[0]} mph`), element('span', `${mid[0]}`), element('span', `${hi[0]} mph`));
  const gradient = document.createElement('div');
  gradient.className = 'gradient';
  gradient.append(bar, ticks);
  const chips = document.createElement('ul');
  chips.className = 'chips';
  for (const [color, text] of [[BELOW_COLOR, `under ${lo[0]}`], [OVER_COLOR, `over ${hi[0]}`], [BASEMAPS[themeName].unknown, 'no data']]) {
    const li = document.createElement('li');
    li.append(swatch(color), document.createTextNode(text));
    chips.append(li);
  }
  legend.replaceChildren(gradient, chips);
}

function setMode(next) {
  mode = next;
  for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  const url = new URL(location.href);
  if (mode === 'fix') url.searchParams.set('mode', 'fix'); else url.searchParams.delete('mode');
  history.replaceState(null, '', url);
  document.querySelectorAll('.maplibregl-popup').forEach((el) => el.remove());
  renderLegend();
  applyVisibility();
}
for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
setMode(mode);

const panel = document.getElementById('panel');
if (matchMedia('(max-width: 600px)').matches) panel.open = false;

document.getElementById('toggle-unknown').addEventListener('change', (e) => { toggles.unknown = e.target.checked; applyVisibility(); });
document.getElementById('toggle-shields').addEventListener('change', (e) => { toggles.shields = e.target.checked; applyVisibility(); });

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
