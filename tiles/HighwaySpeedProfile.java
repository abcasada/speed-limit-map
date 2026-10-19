import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.FeatureMerge;
import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.Profile;
import com.onthegomap.planetiler.VectorTile;
import com.onthegomap.planetiler.config.Arguments;
import com.onthegomap.planetiler.geo.GeometryException;
import com.onthegomap.planetiler.reader.SourceFeature;
import com.onthegomap.planetiler.reader.osm.OsmElement;
import com.onthegomap.planetiler.reader.osm.OsmReader;
import com.onthegomap.planetiler.reader.osm.OsmRelationInfo;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Planetiler profile that turns OpenStreetMap roads into a single "highways" vector tile layer carrying the
 * attributes the web map needs:
 *
 * <ul>
 * <li>{@code speed} - posted limit in mph (omitted when OSM has no usable maxspeed)</li>
 * <li>{@code lanes} - lane count from OSM (omitted when untagged)</li>
 * <li>{@code sh} - "network=ref" of the most important route relation (e.g. "US:I=70", "US:CO=470"); this is the
 * input format of the Americana shield renderer</li>
 * <li>{@code rk} - route rank: 4 Interstate, 3 US route, 2 state route, 1 other signed route, 0 unsigned</li>
 * <li>{@code hw}, {@code ref}, {@code name}, {@code maxspeed} - for the click popup, only at high zooms</li>
 * </ul>
 *
 * Run (Java 21): {@code java -Xmx8g -cp planetiler.jar tiles/HighwaySpeedProfile.java --osm_path=us.osm.pbf}
 */
public class HighwaySpeedProfile implements Profile {

  /** A route=road relation; only the pieces needed to pick a shield. */
  record RouteRelation(long id, String network, String ref) implements OsmRelationInfo {}

  private static final String LAYER = "highways";
  private static final Pattern SPEED = Pattern.compile("^(\\d+(?:\\.\\d+)?)\\s*([a-z/]*)$");
  private static final Pattern WAY_REF = Pattern.compile("^([A-Z]{1,2})[ -]?(\\d+[A-Z]?)$");
  private static final Set<String> STATES = Set.of(
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
    "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR",
    "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY");

  private final boolean includeMinor;

  HighwaySpeedProfile(boolean includeMinor) {
    this.includeMinor = includeMinor;
  }

  @Override
  public List<OsmRelationInfo> preprocessOsmRelation(OsmElement.Relation relation) {
    if ("route".equals(relation.getString("type")) && "road".equals(relation.getString("route"))) {
      String network = relation.getString("network");
      String ref = relation.getString("ref");
      if (network != null && ref != null) {
        return List.of(new RouteRelation(relation.id(), network, ref));
      }
    }
    return null;
  }

  @Override
  public void processFeature(SourceFeature sf, FeatureCollector features) {
    if (!sf.canBeLine() || !sf.hasTag("highway")) {
      return;
    }
    String highway = sf.getString("highway");
    boolean link = highway.endsWith("_link");
    String base = link ? highway.substring(0, highway.length() - "_link".length()) : highway;
    int hwRank = switch (base) {
      case "motorway" -> 6;
      case "trunk" -> 5;
      case "primary" -> 4;
      case "secondary" -> 3;
      case "tertiary" -> 2;
      case "unclassified" -> includeMinor ? 1 : -1;
      case "residential", "living_street" -> includeMinor ? 0 : -1;
      default -> -1;
    };
    if (hwRank < 0 || sf.hasTag("area", "yes") || sf.hasTag("access", "private", "no")) {
      return;
    }

    String network = null;
    String ref = null;
    int rank = 0;
    for (OsmReader.RelationMember<RouteRelation> m : sf.relationInfo(RouteRelation.class)) {
      int r = networkRank(m.relation().network());
      if (r > rank) {
        rank = r;
        network = m.relation().network();
        ref = m.relation().ref();
      }
    }
    if (network == null) {
      // fall back to the way's own ref tag when no route relation is mapped
      String wayRef = sf.getString("ref");
      if (wayRef != null) {
        for (String part : wayRef.split(";")) {
          Matcher m = WAY_REF.matcher(part.trim());
          if (!m.matches()) {
            continue;
          }
          String prefix = m.group(1);
          int r = prefix.equals("I") ? 4 : prefix.equals("US") ? 3 : STATES.contains(prefix) ? 2 : 0;
          if (r > rank) {
            rank = r;
            network = r == 4 ? "US:I" : r == 3 ? "US:US" : "US:" + prefix;
            ref = m.group(2);
          }
        }
      }
    }

    int minZoom = minZoom(base, link, rank);
    if (minZoom > 14) {
      return;
    }

    int speed = Math.max(parseMph(sf.getString("maxspeed")),
      Math.max(parseMph(sf.getString("maxspeed:forward")), parseMph(sf.getString("maxspeed:backward"))));
    int lanes = parseLanes(sf);

    var line = features.line(LAYER)
      .setMinZoom(minZoom)
      .setSortKey(rank * 8 + hwRank)
      .setAttr("rk", rank)
      .setAttr("hw", base)
      .setPixelTolerance(0.4);
    if (speed > 0) {
      line.setAttr("speed", speed);
    }
    if (lanes > 0) {
      line.setAttr("lanes", lanes);
    }
    if (network != null) {
      line.setAttrWithMinzoom("sh", network + "=" + ref, shieldMinZoom(rank));
    }
    addIfPresent(line, "ref", sf.getString("ref"), 10);
    addIfPresent(line, "name", sf.getString("name"), 12);
    addIfPresent(line, "maxspeed", sf.getString("maxspeed"), 10);
  }

  private static void addIfPresent(FeatureCollector.Feature line, String key, String value, int minZoom) {
    if (value != null) {
      line.setAttrWithMinzoom(key, value, minZoom);
    }
  }

  @Override
  public List<VectorTile.Feature> postProcessLayerFeatures(String layer, int zoom, List<VectorTile.Feature> items)
    throws GeometryException {
    // join consecutive segments with identical attributes into long lines: much smaller tiles at low zooms
    return FeatureMerge.mergeLineStrings(items, 0, 0.1, 4);
  }

  /** Road class + route rank decide at which zoom a road first appears. */
  private static int minZoom(String base, boolean link, int rank) {
    if (link) {
      return base.equals("motorway") || base.equals("trunk") ? 10 : 12;
    }
    return switch (base) {
      case "motorway" -> rank == 4 ? 3 : 5;
      case "trunk" -> rank >= 3 ? 5 : 6;
      case "primary" -> rank >= 3 ? 5 : rank == 2 ? 6 : 8;
      case "secondary" -> rank >= 3 ? 6 : rank == 2 ? 8 : 9;
      case "tertiary" -> rank >= 2 ? 9 : 10;
      case "unclassified" -> 11;
      case "residential" -> 12;
      default -> 13;
    };
  }

  private static int shieldMinZoom(int rank) {
    return switch (rank) {
      case 4 -> 6;
      case 3 -> 8;
      case 2 -> 9;
      default -> 11;
    };
  }

  /**
   * Interstate 4, US route 3, state route 2, anything else signed 1. Business loops, spurs, county routes and other
   * variants ("US:I:Business:Loop", "US:CO:Boulder", ...) still get their own shield but rank as minor roads, so a
   * downtown business loop is not promoted to Interstate importance.
   */
  static int networkRank(String network) {
    return switch (network) {
      case "US:I" -> 4;
      case "US:US" -> 3;
      default -> network.matches("US:[A-Z]{2}") ? 2 : network.startsWith("US:") ? 1 : 0;
    };
  }

  /**
   * Parses an OSM maxspeed value to whole mph; 0 when missing or not numeric ("none", "signals", ...). Values with a
   * unit are converted; bare numbers up to 85 are read as mph (the US convention in practice), larger bare numbers as
   * km/h.
   */
  static int parseMph(String value) {
    if (value == null) {
      return 0;
    }
    int best = 0;
    for (String part : value.toLowerCase(Locale.ROOT).split("[;|]")) {
      Matcher m = SPEED.matcher(part.trim());
      if (!m.matches()) {
        continue;
      }
      double n = Double.parseDouble(m.group(1));
      double mph;
      switch (m.group(2)) {
        case "mph" -> mph = n;
        case "km/h", "kmh", "kph" -> mph = n * 0.621371;
        case "" -> mph = n <= 85 ? n : n * 0.621371;
        default -> {
          continue;
        }
      }
      long rounded = Math.round(mph);
      if (rounded >= 5 && rounded <= 100) {
        best = Math.max(best, (int) rounded);
      }
    }
    return best;
  }

  /** Lane count: the {@code lanes} tag, else forward + backward lanes; 0 when unknown. */
  static int parseLanes(SourceFeature sf) {
    int lanes = parseInt(sf.getString("lanes"));
    if (lanes <= 0) {
      lanes = Math.max(0, parseInt(sf.getString("lanes:forward"))) + Math.max(0, parseInt(sf.getString("lanes:backward")));
    }
    return Math.min(lanes, 16);
  }

  private static int parseInt(String s) {
    if (s == null) {
      return 0;
    }
    try {
      return Integer.parseInt(s.trim());
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  @Override
  public String name() {
    return "US highway speed limits";
  }

  @Override
  public String description() {
    return "US roads with posted speed limit, lane count and route shield info, from OpenStreetMap";
  }

  @Override
  public String attribution() {
    return "<a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\">&copy; OpenStreetMap contributors</a>";
  }

  @Override
  public boolean isOverlay() {
    return true;
  }

  public static void main(String[] args) throws Exception {
    Arguments arguments = Arguments.fromArgs(args);
    Path osm = Path.of(arguments.getString("osm_path", "OSM extract (.osm.pbf)", "data/sources/us-roads.osm.pbf"));
    Path out = Path.of(arguments.getString("output", "output .pmtiles file", "data/us-highways.pmtiles"));
    boolean minor = arguments.getBoolean("minor", "include unclassified/residential streets (z11+)", true);
    Planetiler.create(arguments)
      .setProfile(new HighwaySpeedProfile(minor))
      .addOsmSource("osm", osm, "geofabrik:us")
      .overwriteOutput(out)
      .run();
  }
}
