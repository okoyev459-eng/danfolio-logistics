# Veritas campus map digitisation — Danfolio Logistics

## Goal

Build an editable campus vector dataset for Danfolio from verified roads, pedestrian paths, building footprints and landmarks. The finished app should render our campus-specific vectors in MapLibre and route Kekes only over verified motor-vehicle-accessible roads.

## Free tracing workflow

Use the OpenStreetMap iD editor in a browser. It is free and works without installing GIS software. **Important:** saving edits in iD contributes them to the public OpenStreetMap dataset under the ODbL licence. That means other people can also use the mapped roads/buildings, subject to the ODbL. If you want a private-only campus dataset, do not save edits to OSM; use a private QGIS digitising workflow instead.

1. Open the [Veritas University map editor](https://www.openstreetmap.org/edit?editor=id#map=18/9.28828/7.41411).
2. Sign in or create a free OpenStreetMap account.
3. Open **Background settings** (press `B`) and select **Esri World Imagery**. Do not use Google Earth/Google Maps imagery as the tracing source.
4. Check the imagery date/offset using [Esri World Imagery Wayback](https://livingatlas.arcgis.com/wayback/).
5. Trace only features you can clearly identify. Work in small sections and save frequently.
6. Add a changeset comment such as `Veritas University campus roads and buildings` and identify the imagery source as Esri where the editor permits.

Esri's published permission allows World Imagery to be used to trace features and validate edits in the creation of vector data. The imagery remains Esri's property; only the resulting vector data is used in Danfolio. OSM contributions are released under the OpenStreetMap ODbL, and the app must retain OpenStreetMap attribution. See the links at the end of this document.

## What to trace and how to tag it

### Roads — draw the centre-line, not both edges

Use the most accurate `highway` value that matches the real feature:

- `highway=service` — internal access roads and service lanes.
- `highway=residential` or `highway=unclassified` — public/internal streets where appropriate.
- `highway=track` — unpaved vehicle tracks, only when they are actually driveable.
- `highway=footway` or `highway=path` — pedestrian paths; these are **not Keke roads**.
- `highway=steps` — stairs; never Keke-routable.

Set access tags truthfully (`access`, `vehicle`, `motor_vehicle`, `oneway`, `surface`, and `width` where known). Do not mark a way `motor_vehicle=yes` just to make routing work. A road is only approved for Keke routing after it has been checked on the ground or confirmed by the campus.

### Buildings

Trace the building outline as a closed polygon and add `building=yes` plus `name=*` when the name is known. Do not guess a building name from its appearance.

### Junctions and gates

Road lines must physically connect at intersections. Use real access points for gates. Do not draw a junction where two paths merely cross at different levels.

## Campus sections to map

Map a little at a time, keeping each section connected to the existing road network:

1. Main Gate and the entrance road.
2. Academic Blocks A–D, NLT, MPH and nearby lecture halls.
3. Hostels K, M and N and their connecting roads.
4. Chapel, SANET, Software, Medicine, Law and postgraduate buildings.
5. Football pitch, auditorium/library and remaining junctions/paths.

Existing project location coordinates are already saved separately in `public/maps/veritas-campus-reference-anchors.geojson`. They are reference pins only and do not overwrite the Supabase `locations` table.

## Export the mapped campus data

After OSM edits have been saved, use Overpass Turbo to export roads and buildings in this bounding box:

- South: `9.282`
- West: `7.407`
- North: `9.299`
- East: `7.423`

Query:

```overpass
[out:json][timeout:60];
(
  way["highway"](9.282,7.407,9.299,7.423);
  way["building"](9.282,7.407,9.299,7.423);
);
out geom;
```

In [Overpass Turbo](https://overpass-turbo.eu/), run the query, choose **Export → raw data directly from Overpass API**, and save the JSON into the project as `overpass-veritas-campus.json` (do not put this temporary file in `public/`).

Then run from the project root:

```bash
node scripts/import-osm-campus.mjs ./overpass-veritas-campus.json
```

The script creates/updates:

- `public/maps/veritas-campus-roads.geojson`
- `public/maps/veritas-campus-footpaths.geojson`
- `public/maps/veritas-campus-buildings.geojson`

The import script preserves OSM access tags and marks motor-vehicle candidates for review; it does **not** certify that every road is safe or accessible to a Keke. Verify each candidate before it becomes routable.

## GeoJSON rules

- Coordinate order is always `[longitude, latitude]` (GeoJSON standard), not `[latitude, longitude]`.
- Coordinate reference system is WGS84 / EPSG:4326.
- Road geometry is `LineString`; building geometry is `Polygon`.
- Roads must join at shared junctions; near-miss lines create disconnected route graphs.
- Keep footpaths separate from motor-vehicle roads.
- Preserve names and original OSM tags for auditing.
- Never invent geometry to fill a blank area. Mark uncertain features for a field check.

## Sources and attribution

- [OpenStreetMap iD editor — Esri imagery guidance](https://www.esri.com/arcgis-blog/products/constituent-engagement/constituent-engagement/esri-world-imagery-in-openstreetmap)
- [OpenStreetMap Wiki — Esri imagery permissions](https://wiki.openstreetmap.org/wiki/Esri)
- [Esri World Imagery Wayback](https://livingatlas.arcgis.com/wayback/)
- [Veritas University location in OpenStreetMap-derived Mapcarta](https://mapcarta.com/W357391881)

When displaying OSM-derived map data in Danfolio, show `© OpenStreetMap contributors` and link to https://www.openstreetmap.org/copyright.

## How this becomes Danfolio's own map

The files in `public/maps/` are the campus-specific vector layer. `CampusMap.jsx` already loads these GeoJSON files and draws the local building outlines, road centre-lines, path dashes and labels over the general basemap. As the files are populated, the local geometry becomes visible automatically after a page refresh.

The current general basemap still comes from OpenFreeMap/OpenStreetMap tiles. Once the campus road/building data is complete and verified, we can switch the campus view to a clean local MapLibre style that uses the bundled GeoJSON as the map itself. That final style can render the campus layout without requesting a paid map API or external map tiles. Live GPS/Realtime still needs an internet connection; an offline basemap does not make live positions available while disconnected.

The first routing pass will continue to use the existing OSRM-compatible provider. After the road network is complete, we can add a campus-local router that uses only roads marked `keke_access: "yes"`; this avoids depending on a third-party road graph for campus-only trips.
