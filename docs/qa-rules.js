// Fix-it mode rules: things an OpenStreetMap contributor might want to go and check.
//
// Every rule is a plain object and the whole list is the QA_RULES array at the bottom; the map builds one layer per
// rule and the legend, the per-rule checkboxes and the "flagged because" lines in the popup all come from the same list.
//
//   id           unique, used in layer ids
//   label        short text for the legend and the popup
//   description  one sentence explaining what is wrong / worth checking (shown as a tooltip in the legend)
//   color        line colour in fix-it mode
//   filter       MapLibre filter expression evaluated against the properties of each road feature in the tiles
//   minzoom      optional; the first zoom at which the rule can be evaluated (some properties are only in the tiles
//                at higher zooms)
//   extraWidth   optional; extra line width in px so rare findings stand out from common ones (default 0.8)
//
// To add a rule, append an object to QA_RULES (see the examples in "Rules" below). Rules run in the browser, so a new
// rule needs no tile rebuild as long as the properties it needs are already in the tiles:
//
//   speed     posted limit in whole mph, parsed from maxspeed; absent when there is no usable value
//   maxspeed  the raw maxspeed tag text (zoom 10 and up)
//   lanes     the lanes tag (absent when untagged)
//   hw        highway class: motorway, trunk, primary, secondary, tertiary, unclassified, residential, living_street.
//             Ramps ("_link" roads) are folded into their parent class, so a ramp looks like a motorway here
//   rk        signed-route rank: 4 Interstate, 3 US route, 2 state route, 1 county/other route, 0 unsigned
//   ref       the ref tag (zoom 10 and up)
//   name      the name tag (zoom 12 and up)
//
// Checks that need more than that (ramps, one-way, surface, conditional limits, speed differences between neighbouring
// segments, ...) need the property added to tiles/HighwaySpeedProfile.java and the tiles rebuilt; note that next to the
// rule so it is clear why it is missing. See PLANNED_RULES at the bottom.

// ---- thresholds ----------------------------------------------------------------------------------------------------
// Chosen from the data: residential roads posted 55+ mph are common on rural roads that are probably just
// mis-classified (about 7,700 segments), whereas 60+ is only a couple of hundred and almost certainly a mistake.

/** Highest limit that exists on any US road (some Texas toll roads); anything above is a typo or a km/h value. */
const MAX_PLAUSIBLE_MPH = 85;
/** Residential and living streets at or above this are implausible. */
const RESIDENTIAL_IMPLAUSIBLE_MPH = 60;
/** Unclassified (typically rural county) roads at or above this are implausible. */
const UNCLASSIFIED_IMPLAUSIBLE_MPH = 70;
/** Freeways at or below this are implausible (ramps, folded into "motorway" here, are rarely tagged this low). */
const FREEWAY_IMPLAUSIBLE_MPH = 10;

// ---- helpers for writing filters -----------------------------------------------------------------------------------

const speed = ['to-number', ['get', 'speed']];
const hasSpeed = ['has', 'speed'];
const hasRawMaxspeed = ['has', 'maxspeed'];
/** True when the road class is one of the given highway values. */
const hwIn = (...classes) => ['in', ['get', 'hw'], ['literal', classes]];

// ---- Rules ---------------------------------------------------------------------------------------------------------

export const QA_RULES = [
  {
    id: 'no-speed',
    label: 'No speed limit tagged',
    description: 'The way has no maxspeed tag (or none that can be read). Most small streets are in this state.',
    color: '#ff9500',
    // maxspeed text is only in the tiles from zoom 10, so below that this also catches unreadable values
    filter: ['all', ['!', hasSpeed], ['!', hasRawMaxspeed]],
  },
  {
    id: 'unreadable',
    extraWidth: 2.4,
    label: 'maxspeed tag present but unreadable',
    description: 'There is a maxspeed value, but it is not a plain number (for example a list, "signals" or free text).',
    color: '#1e6bff',
    minzoom: 10,
    filter: ['all', ['!', hasSpeed], hasRawMaxspeed],
  },
  {
    id: 'not-multiple-of-5',
    extraWidth: 2.4,
    label: 'Not a multiple of 5 mph',
    description: 'US limits are almost always multiples of 5; others are usually typos or km/h values converted to mph.',
    color: '#9b30ff',
    filter: ['all', hasSpeed, ['!=', ['%', speed, 5], 0]],
  },
  {
    id: 'implausible-too-fast',
    extraWidth: 2.4,
    label: `Implausible: over ${MAX_PLAUSIBLE_MPH} mph`,
    description: `No US road is posted above ${MAX_PLAUSIBLE_MPH} mph, so this is probably a typo or a km/h value.`,
    color: '#e0001a',
    filter: ['all', hasSpeed, ['>', speed, MAX_PLAUSIBLE_MPH]],
  },
  {
    id: 'implausible-residential',
    extraWidth: 2.4,
    label: `Implausible: street at ${RESIDENTIAL_IMPLAUSIBLE_MPH}+ mph`,
    description: `A residential or living street posted ${RESIDENTIAL_IMPLAUSIBLE_MPH} mph or more: wrong limit or wrong road class.`,
    color: '#e0001a',
    filter: ['all', hasSpeed, hwIn('residential', 'living_street'), ['>=', speed, RESIDENTIAL_IMPLAUSIBLE_MPH]],
  },
  {
    id: 'implausible-unclassified',
    extraWidth: 2.4,
    label: `Implausible: minor road at ${UNCLASSIFIED_IMPLAUSIBLE_MPH}+ mph`,
    description: `An unclassified road posted ${UNCLASSIFIED_IMPLAUSIBLE_MPH} mph or more: wrong limit or wrong road class.`,
    color: '#e0001a',
    filter: ['all', hasSpeed, hwIn('unclassified'), ['>=', speed, UNCLASSIFIED_IMPLAUSIBLE_MPH]],
  },
  {
    id: 'implausible-freeway-slow',
    extraWidth: 2.4,
    label: `Implausible: freeway at ${FREEWAY_IMPLAUSIBLE_MPH} mph or less`,
    description: `A motorway posted ${FREEWAY_IMPLAUSIBLE_MPH} mph or less: toll plaza, ramp tagged as a motorway, or a typo.`,
    color: '#e0001a',
    filter: ['all', hasSpeed, hwIn('motorway'), ['<=', speed, FREEWAY_IMPLAUSIBLE_MPH]],
  },
];

// ---- Ideas that need more data in the tiles ------------------------------------------------------------------------
// Documentation only; nothing reads this. Each entry says what the rule would flag and which tile property is missing,
// so whoever picks one up knows to add it to tiles/HighwaySpeedProfile.java first.

export const PLANNED_RULES = [
  { idea: 'Ramps (motorway_link etc.) with a limit above the connecting road', needs: 'link flag on each way' },
  { idea: 'Neighbouring segments of the same route whose limits differ by 20+ mph', needs: 'way ids / adjacency, or a QA pass at build time' },
  { idea: 'maxspeed:conditional (school zones, time of day) with no base maxspeed', needs: 'conditional tag copied into the tiles' },
  { idea: 'Direction-specific limits that disagree (maxspeed:forward vs :backward)', needs: 'both values kept instead of only the higher one' },
  { idea: 'Interstate or US route with no maxspeed while its neighbours have one', needs: 'adjacency, as above' },
  { idea: 'Speed limit units written in km/h in the US', needs: 'the raw unit text (partly covered by "not a multiple of 5")' },
  { idea: 'Lane count that looks wrong for the class (a 1-lane Interstate, a 10-lane residential street)', needs: 'nothing; add a rule on lanes and hw' },
];
