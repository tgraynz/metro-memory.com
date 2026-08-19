import { FeatureCollection, MultiLineString, LineString, Point } from 'geojson'
import { MapboxOptions } from 'mapbox-gl'
import { Metadata } from 'next'

export type SortOptionType = 'order' | 'name' | 'line'

export type DataFeatureCollection = FeatureCollection<
  LineString | MultiLineString | Point,
  {
    name: string
    id?: number | null
    long_name?: string
    short_name?: string
    line?: string
    /** Fare zones this station belongs to. Boundary stations have multiple
     *  entries. Missing / undefined = the city has no zone data at all;
     *  such cities skip the zone selector entirely. Stations with no
     *  official zone in a zoned city should be stamped with a sentinel
     *  bucket zone (e.g. 0) so they can still be selected as a group. */
    zones?: number[]
  }
>

export type RoutesFeatureCollection = FeatureCollection<
  LineString | MultiLineString,
  {
    color: string
  }
>

export type DataFeature = DataFeatureCollection['features'][number]

export interface SortOption {
  name: string
  id: SortOptionType
  shortName: React.ReactNode
}

export interface Line {
  name: string
  color: string
  backgroundColor: string
  textColor: string
  order: number
}

export type GameMode = 'type' | 'typeHard' | 'typeHarder' | 'pin' | 'pinHard'

export type PinStationState = 'first' | 'second' | 'third' | 'missed'

export interface PinProgress {
  /** Mode this progress was seeded for. Used to detect stale progress after
   *  a mode switch, when the localStorage-backed value briefly lags the new
   *  key by one render. Optional for backward compatibility with older
   *  saved data — a missing tag triggers a re-seed. */
  mode?: GameMode
  order: number[]
  currentIdx: number
  attemptsForCurrent: number
  stationStates: Record<number, PinStationState>
}

export interface Config {
  MAP_FROM_DATA?: boolean
  GAUGE_COLORS?: 'inverted' | 'default'
  LOCALE: string
  CITY_NAME: string
  STRIPE_LINK: string
  MAP_CONFIG: MapboxOptions
  METADATA: Metadata
  LINES: { [key: string]: Line }
  BEG_THRESHOLD: number
}
