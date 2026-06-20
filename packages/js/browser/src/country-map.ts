import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import worldAtlas from "world-atlas/countries-110m.json" with { type: "json" };
import {
  OPENRECEIVE_COUNTRY_MAP_HEIGHT,
  OPENRECEIVE_COUNTRY_MAP_WIDTH
} from "./index.ts";

export interface OpenReceiveCountryMapLandPath {
  readonly id: string;
  readonly d: string;
}

const topojsonFeature = feature as unknown as (
  topology: unknown,
  object: unknown
) => { readonly features: readonly Record<string, unknown>[] };
const worldFeatures = topojsonFeature(
  worldAtlas,
  (worldAtlas as { objects: { countries: unknown } }).objects.countries
).features;
const projection = geoNaturalEarth1()
  .scale(132)
  .translate([
    OPENRECEIVE_COUNTRY_MAP_WIDTH / 2,
    OPENRECEIVE_COUNTRY_MAP_HEIGHT / 2
  ]);
const pathForCountry = geoPath(projection) as unknown as (object: unknown) => string | null;

export const openReceiveCountryMapLandPaths: readonly OpenReceiveCountryMapLandPath[] =
  worldFeatures.flatMap((country, index) => {
    const d = pathForCountry(country);
    return d === null ? [] : [{ id: String(index), d }];
  });
