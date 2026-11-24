# Campus map data model

Danfolio keeps the map geometry separate from the Supabase `locations` table.

| File | Geometry | Purpose |
|---|---|---|
| `veritas-campus-reference-anchors.geojson` | Points | Existing user-supplied campus coordinates for reference only |
| `veritas-campus-roads.geojson` | LineStrings | Road centre-lines and their access tags |
| `veritas-campus-footpaths.geojson` | LineStrings | Pedestrian-only routes |
| `veritas-campus-buildings.geojson` | Polygons | Building footprints and names |

The current empty road/path/building files are intentional. They are not filled with guessed geometry. The Overpass import script populates them after real mapping edits have been saved.

A future local routing graph should be generated only from roads whose `motor_vehicle`/`vehicle` access has been checked. Footpaths and steps must never be used for Keke routing. Keep the Supabase location IDs and fare relationships unchanged.
