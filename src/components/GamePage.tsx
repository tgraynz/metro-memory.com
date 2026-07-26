'use client'

import FoundList from '@/components/FoundList'
import FoundSummary from '@/components/FoundSummary'
import Input from '@/components/Input'
import IntroModal from '@/components/IntroModal'
import MenuComponent from '@/components/Menu'
import PinMode, { pinClickHandlerRef, pinResetRef } from '@/components/PinMode'
import SettingsModal from '@/components/SettingsModal'
import StripeModal from '@/components/StripeModal'
import useHideLabels from '@/hooks/useHideLabels'
import useNormalizeString from '@/hooks/useNormalizeString'
import useTranslation from '@/hooks/useTranslation'
import { useConfig } from '@/lib/configContext'
import { computePinScoreProportion, hasPinProgress } from '@/lib/pinScoring'
import {
  DataFeature,
  DataFeatureCollection,
  GameMode,
  PinProgress,
  RoutesFeatureCollection,
} from '@/lib/types'
import { useLocalStorageValue } from '@react-hookz/web'
import { coordEach } from '@turf/meta'
import { bbox } from '@turf/turf'
import Fuse from 'fuse.js'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import 'react-circular-progressbar/dist/styles.css'

export default function GamePage({
  fc,
  routes,
  callout,
}: {
  fc: DataFeatureCollection
  routes?: RoutesFeatureCollection
  callout?: React.ReactNode
}) {
  const { BEG_THRESHOLD, CITY_NAME, MAP_CONFIG, LINES, MAP_FROM_DATA } =
    useConfig()
  const { t } = useTranslation()

  const normalizeString = useNormalizeString()

  const [map, setMap] = useState<mapboxgl.Map | null>(null)
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { hideLabels, setHideLabels } = useHideLabels(map)
  const [showStripeModal, setShowStripeModal] = useState<boolean>(false)
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false)
  const [pinFlashId, setPinFlashId] = useState<number | null>(null)
  // Ids we've currently set `found` state on. Used to reliably clear them
  // when the effect re-runs (e.g. on mode switch); source-level removeFeatureState
  // can leave stale state on features it was called against.
  const foundAppliedRef = useRef<Set<number>>(new Set())

  const { value: modeValue, set: setModeValue } = useLocalStorageValue<GameMode>(
    `${CITY_NAME}-mode`,
    { defaultValue: 'type', initializeWithValue: false },
  )
  const mode: GameMode = modeValue ?? 'type'

  const allLineKeys = useMemo(() => Object.keys(LINES), [LINES])

  const { value: enabledLinesArr, set: setEnabledLinesArr } =
    useLocalStorageValue<string[] | null>(`${CITY_NAME}-enabled-lines`, {
      defaultValue: null,
      initializeWithValue: false,
    })
  const enabledLines = useMemo(
    () => new Set(enabledLinesArr ?? allLineKeys),
    [enabledLinesArr, allLineKeys],
  )
  const setEnabledLines = useCallback(
    (s: Set<string>) => setEnabledLinesArr([...s]),
    [setEnabledLinesArr],
  )

  // Pin-mode progress lives here so the right-hand score panel can read it.
  // Keyed on mode so soft vs hard pin variants persist independently.
  const pinStorageKey = `${CITY_NAME}-pin-progress-${mode}`
  const { value: pinProgress, set: setPinProgress } = useLocalStorageValue<
    PinProgress | null
  >(pinStorageKey, {
    defaultValue: null,
    initializeWithValue: false,
  })

  const { value: hasShownStripeModal, set: setHasShownStripeModal } =
    useLocalStorageValue<boolean>('has-shown-stripe-modal', {
      defaultValue: false,
      initializeWithValue: false,
    })

  const idMap = useMemo(() => {
    const map = new Map<number, DataFeature>()
    fc.features.forEach((feature) => {
      map.set(feature.id! as number, feature)
    })
    return map
  }, [fc.features])

  // Features currently in play (all types — points, routes, etc.) after
  // filtering by the enabled-line set. Used as the base for fuse, per-line
  // counts, and the score denominator so line selection applies uniformly to
  // both game modes.
  const enabledFeatures = useMemo(
    () =>
      fc.features.filter(
        (f) => f.properties.line && enabledLines.has(f.properties.line),
      ),
    [fc.features, enabledLines],
  )

  const stationsPerLine = useMemo(() => {
    const stationsPerLine: { [key: string]: number } = {}
    for (let feature of enabledFeatures) {
      const line = feature.properties.line
      if (!line) continue
      stationsPerLine[line] = (stationsPerLine[line] || 0) + 1
    }
    return stationsPerLine
  }, [enabledFeatures])

  const { value: localFound, set: setFound } = useLocalStorageValue<
    number[] | null
  >(`${CITY_NAME}-stations`, {
    defaultValue: null,
    initializeWithValue: false,
  })

  const { value: isNewPlayer, set: setIsNewPlayer } =
    useLocalStorageValue<boolean>(`${CITY_NAME}-stations-is-new-player`, {
      defaultValue: true,
      initializeWithValue: false,
    })

  const found: number[] = useMemo(() => {
    return (localFound || []).filter((f) => {
      const feat = idMap.get(f)
      if (!feat) return false
      const line = feat.properties.line
      return !!line && enabledLines.has(line)
    })
  }, [localFound, idMap, enabledLines])

  // Unconfirmed reset — clears typing state and reseeds an active pin game.
  // Callers that need a confirmation prompt should wrap this (see onReset).
  const resetAll = useCallback(() => {
    setFound([])
    setIsNewPlayer(true)
    setHasShownStripeModal(false)
    // Clear any pin-mode progress on disk for both variants.
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(`${CITY_NAME}-pin-progress-pin`)
      window.localStorage.removeItem(`${CITY_NAME}-pin-progress-pinHard`)
    }
    // If PinMode is currently mounted, ask it to reseed a fresh game.
    pinResetRef.current?.()
  }, [setFound, setIsNewPlayer, setHasShownStripeModal, CITY_NAME])

  const onReset = useCallback(() => {
    if (confirm(t('restartWarning'))) {
      resetAll()
    }
  }, [t, resetAll])

  const foundStationsPerLine = useMemo(() => {
    const foundStationsPerLine: { [key: string]: number } = {}
    for (let id of found || []) {
      const feature = idMap.get(id)
      if (!feature) {
        continue
      }
      const line = feature.properties.line
      if (!line) {
        continue
      }
      foundStationsPerLine[line] = (foundStationsPerLine[line] || 0) + 1
    }

    return foundStationsPerLine
  }, [found, idMap])

  const fuse = useMemo(
    () =>
      new Fuse(enabledFeatures, {
        includeScore: true,
        includeMatches: true,
        keys: [
          'properties.name',
          'properties.long_name',
          'properties.short_name',
          'properties.alternate_names',
        ],
        minMatchCharLength: 2,
        threshold: 0.15,
        distance: 10,
        getFn: (obj, path) => {
          const value = Fuse.config.getFn(obj, path)
          if (value === undefined) {
            return ''
          } else if (Array.isArray(value)) {
            return value.map((el) => normalizeString(el))
          } else {
            return normalizeString(value as string)
          }
        },
      }),
    [enabledFeatures, normalizeString],
  )

  const foundProportion = enabledFeatures.length
    ? found.length / enabledFeatures.length
    : 0

  // Map station name → all feature ids sharing that name (Baker Street exists
  // as one feature per line served — 5 features for 5 IDs but one "station").
  const nameToIds = useMemo(() => {
    const m = new Map<string, number[]>()
    for (const f of fc.features) {
      if (f.geometry.type !== 'Point') continue
      const name = f.properties.name
      if (!name) continue
      const id = Number(f.id)
      if (!Number.isFinite(id)) continue
      if (!m.has(name)) m.set(name, [])
      m.get(name)!.push(id)
    }
    return m
  }, [fc.features])

  // Points only, filtered by enabled lines, deduped by station name so we don't
  // ask about "Baker Street" once per line.
  const pinStationPool = useMemo(() => {
    const seen = new Set<string>()
    const out: DataFeature[] = []
    for (const f of fc.features) {
      if (f.geometry.type !== 'Point') continue
      const name = f.properties.name
      const line = f.properties.line
      if (!name || !line) continue
      if (!enabledLines.has(line)) continue
      if (seen.has(name)) continue
      seen.add(name)
      out.push(f)
    }
    return out
  }, [fc, enabledLines])

  // ---- Pin-mode-derived stats used by the right-hand score panel ----------

  // Only stations marked 'first' credit the per-line counts. When a station
  // like Baker Street (5 line features) is guessed first-try, we credit each
  // of its features so it matches typing mode where all 5 features are added
  // to `found`.
  const pinFirstPerLine = useMemo(() => {
    const out: Record<string, number> = {}
    if (mode === 'type' || !pinProgress) return out
    for (const [idStr, state] of Object.entries(pinProgress.stationStates)) {
      if (state !== 'first') continue
      const id = Number(idStr)
      const name = idMap.get(id)?.properties.name
      const relatedIds = (name && nameToIds.get(name)) || [id]
      for (const rid of relatedIds) {
        const line = idMap.get(rid)?.properties.line
        if (!line) continue
        out[line] = (out[line] || 0) + 1
      }
    }
    return out
  }, [mode, pinProgress, idMap, nameToIds])

  const pinScoreProportion = useMemo(
    () => (mode === 'type' ? 0 : computePinScoreProportion(pinProgress)),
    [mode, pinProgress],
  )

  // What the FoundSummary/ProgressBars actually use. stationsPerLine is
  // already filtered to enabled lines, so both modes share the same
  // denominator dictionary.
  const panelFoundPerLine =
    mode === 'type' ? foundStationsPerLine : pinFirstPerLine
  const panelStationsPerLine = stationsPerLine
  const panelProportion = mode === 'type' ? foundProportion : pinScoreProportion

  // Brief red flash on the station clicked when it's the wrong answer.
  const flashWrong = useCallback((id: number) => setPinFlashId(id), [])

  useEffect(() => {
    if (!map || pinFlashId == null) return
    map.setFeatureState({ source: 'features', id: pinFlashId }, { pinFlash: true })
    const t = setTimeout(() => {
      map.setFeatureState({ source: 'features', id: pinFlashId }, { pinFlash: false })
      setPinFlashId(null)
    }, 400)
    return () => clearTimeout(t)
  }, [pinFlashId, map])

  // Pulse pinFlash on the given feature ids 4 times (~200ms per phase) to
  // reveal the correct station when the player runs out of attempts. Also
  // zooms to fit the wrong-clicked and correct stations if the correct one is
  // currently off-screen. Any in-flight pulse from a previous wrong click is
  // cancelled first so flashes don't stack.
  const revealIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const revealIdsRef = useRef<number[]>([])

  const revealAnswer = useCallback(
    (correctIds: number[], clickedId: number) => {
      if (!map || correctIds.length === 0) return

      // Only reframe if the correct station is completely off screen. When it
      // is, zoom OUT to fit both stations with a 1/8th safe margin; never zoom
      // in — cap at current zoom so fitBounds can only pan / zoom out.
      const correctFeat = idMap.get(correctIds[0])
      const clickedFeat = idMap.get(clickedId)
      if (
        correctFeat?.geometry.type === 'Point' &&
        clickedFeat?.geometry.type === 'Point'
      ) {
        const correctCoord = correctFeat.geometry.coordinates as [number, number]
        const clickedCoord = clickedFeat.geometry.coordinates as [number, number]
        const container = map.getContainer()
        const w = container.clientWidth
        const h = container.clientHeight
        const correctPx = map.project(correctCoord)
        const correctInView =
          correctPx.x >= 0 &&
          correctPx.x <= w &&
          correctPx.y >= 0 &&
          correctPx.y <= h
        if (!correctInView) {
          const bounds = new mapboxgl.LngLatBounds()
          bounds.extend(correctCoord)
          bounds.extend(clickedCoord)
          map.fitBounds(bounds, {
            padding: {
              top: Math.floor(h / 8),
              bottom: Math.floor(h / 8),
              left: Math.floor(w / 8),
              right: Math.floor(w / 8),
            },
            maxZoom: map.getZoom(),
            duration: 400,
          })
        }
      }

      // Cancel any existing flash cycle first.
      if (revealIntervalRef.current != null) {
        clearInterval(revealIntervalRef.current)
        for (const id of revealIdsRef.current) {
          map.setFeatureState({ source: 'features', id }, { pinFlash: false })
        }
      }

      const PHASE_MS = 200
      const CYCLES = 4
      const TOTAL_PHASES = CYCLES * 2 // on + off per cycle
      let phase = 0
      revealIdsRef.current = correctIds
      revealIntervalRef.current = setInterval(() => {
        const on = phase % 2 === 0
        for (const id of correctIds) {
          map.setFeatureState({ source: 'features', id }, { pinFlash: on })
        }
        phase++
        if (phase >= TOTAL_PHASES) {
          if (revealIntervalRef.current != null) {
            clearInterval(revealIntervalRef.current)
            revealIntervalRef.current = null
          }
          for (const id of correctIds) {
            map.setFeatureState({ source: 'features', id }, { pinFlash: false })
          }
          revealIdsRef.current = []
        }
      }, PHASE_MS)
    },
    [map, idMap],
  )

  useEffect(() => {
    if (foundProportion > BEG_THRESHOLD && !hasShownStripeModal) {
      // once we reach a certain threshold, we show the stripe modal
      // and unlock the rest of the game.
      setShowStripeModal(true)
      setHasShownStripeModal(true)
    }
  }, [
    hasShownStripeModal,
    setHasShownStripeModal,
    foundProportion,
    found,
    setFound,
    idMap,
    BEG_THRESHOLD,
  ])

  useEffect(() => {
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

    const mapboxMap = new mapboxgl.Map(MAP_CONFIG)

    mapboxMap.on('load', () => {
      mapboxMap.addSource('features', {
        type: 'geojson',
        data: fc,
      })

      mapboxMap.addSource('hovered', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [],
        },
      })

      if (MAP_FROM_DATA && routes) {
        mapboxMap.addSource('lines', {
          type: 'geojson',
          data: routes,
        })

        mapboxMap.addLayer({
          id: 'lines',
          type: 'line',
          paint: {
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              8.763,
              1.5,
              15,
              3,
              22,
              3,
            ],
            'line-color': ['get', 'color'],
            'line-offset': [
              'interpolate',
              ['linear'],
              ['zoom'],
              9,
              ['coalesce', ['get', 'overlapOffsetPx'], 0],
              13,
              ['*', 2, ['coalesce', ['get', 'overlapOffsetPx'], 0]],
              18,
              ['*', 4, ['coalesce', ['get', 'overlapOffsetPx'], 0]],
            ],
          },
          source: 'lines',
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-sort-key': ['-', 100, ['get', 'order']],
          },
        })

        mapboxMap.addLayer({
          type: 'circle',
          source: 'features',
          id: 'stations',
          paint: {
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              9,
              1.5,
              16,
              10,
            ],
            'circle-color': '#ffffff',
            'circle-stroke-color': 'rgb(122, 122, 122)',
            'circle-stroke-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              8,
              0.5,
              22,
              2,
            ],
          },
        })

        const box = bbox(routes)

        mapboxMap.fitBounds(
          [
            [box[0], box[1]],
            [box[2], box[3]],
          ],
          { padding: 100, duration: 0 },
        )

        mapboxMap.setMaxBounds([
          [box[0] - 1, box[1] - 1],
          [box[2] + 1, box[3] + 1],
        ])
      }

      mapboxMap.addLayer({
        id: 'stations-hovered',
        type: 'circle',
        paint: {
          'circle-radius': 16,
          'circle-color': '#fde047',
          'circle-blur-transition': {
            duration: 100,
          },
          'circle-blur': 1,
        },
        source: 'hovered',
        filter: ['==', '$type', 'Point'],
      })

      mapboxMap.addLayer({
        type: 'circle',
        source: 'features',
        id: 'stations-circles',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            9,
            [
              'case',
              ['to-boolean', ['feature-state', 'pinFlash']],
              3,
              ['!=', ['feature-state', 'pinState'], null],
              2.5,
              ['to-boolean', ['feature-state', 'pinHover']],
              2.5,
              ['to-boolean', ['feature-state', 'found']],
              2,
              1,
            ],
            16,
            [
              'case',
              ['to-boolean', ['feature-state', 'pinFlash']],
              8,
              ['!=', ['feature-state', 'pinState'], null],
              7,
              ['to-boolean', ['feature-state', 'pinHover']],
              7,
              ['to-boolean', ['feature-state', 'found']],
              6,
              4,
            ],
          ],
          'circle-color': [
            'case',
            ['to-boolean', ['feature-state', 'pinFlash']],
            '#ef4444',
            ['==', ['feature-state', 'pinState'], 'first'],
            '#22c55e',
            ['==', ['feature-state', 'pinState'], 'second'],
            '#f97316',
            ['==', ['feature-state', 'pinState'], 'third'],
            '#f97316',
            ['==', ['feature-state', 'pinState'], 'missed'],
            '#ef4444',
            ['to-boolean', ['feature-state', 'found']],
            [
              'match',
              ['get', 'line'],
              ...Object.keys(LINES).flatMap((line) => [
                [line],
                LINES[line].color,
              ]),
              'rgba(255, 255, 255, 0.8)',
            ],
            'rgba(255, 255, 255, 0.8)',
          ],
          'circle-stroke-color': [
            'case',
            ['to-boolean', ['feature-state', 'pinFlash']],
            '#7f1d1d',
            ['==', ['feature-state', 'pinState'], 'first'],
            '#166534',
            ['==', ['feature-state', 'pinState'], 'second'],
            '#9a3412',
            ['==', ['feature-state', 'pinState'], 'third'],
            '#9a3412',
            ['==', ['feature-state', 'pinState'], 'missed'],
            '#7f1d1d',
            ['to-boolean', ['feature-state', 'pinHover']],
            '#4b5563',
            ['to-boolean', ['feature-state', 'found']],
            [
              'match',
              ['get', 'line'],
              ...Object.keys(LINES).flatMap((line) => [
                [line],
                LINES[line].backgroundColor,
              ]),
              'rgba(255, 255, 255, 0.8)',
            ],
            'rgba(255, 255, 255, 0.8)',
          ],
          'circle-stroke-width': [
            'case',
            ['to-boolean', ['feature-state', 'pinFlash']],
            2,
            ['!=', ['feature-state', 'pinState'], null],
            2,
            ['to-boolean', ['feature-state', 'pinHover']],
            2,
            ['to-boolean', ['feature-state', 'found']],
            1,
            0,
          ],
        },
        layout: {
          'circle-sort-key': ['-', 100, ['get', 'order']],
        },
      })

      mapboxMap.addLayer({
        minzoom: 11,
        layout: {
          'text-field': ['to-string', ['get', 'name']],
          'text-font': ['Cabin Regular', 'Arial Unicode MS Regular'],
          'text-anchor': 'bottom',
          'text-offset': [0, -0.5],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 12, 22, 14],
        },
        type: 'symbol',
        source: 'features',
        id: 'stations-labels',
        paint: {
          'text-color': [
            'case',
            [
              'any',
              ['to-boolean', ['feature-state', 'found']],
              ['to-boolean', ['feature-state', 'showLabel']],
            ],
            'rgb(29, 40, 53)',
            'rgba(0, 0, 0, 0)',
          ],
          'text-halo-color': [
            'case',
            [
              'any',
              ['to-boolean', ['feature-state', 'found']],
              ['to-boolean', ['feature-state', 'showLabel']],
            ],
            'rgba(255, 255, 255, 0.8)',
            'rgba(0, 0, 0, 0)',
          ],
          'text-halo-blur': 1,
          'text-halo-width': 1,
        },
      })

      mapboxMap.addLayer({
        id: 'hover-label-point',
        type: 'symbol',
        paint: {
          'text-halo-color': 'rgb(255, 255, 255)',
          'text-halo-width': 2,
          'text-halo-blur': 1,
          'text-color': 'rgb(29, 40, 53)',
        },
        layout: {
          'text-field': ['to-string', ['get', 'name']],
          'text-font': ['Cabin Bold', 'Arial Unicode MS Regular'],
          'text-anchor': 'bottom',
          'text-offset': [0, -0.6],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 14, 22, 16],
          'symbol-placement': 'point',
        },
        source: 'hovered',
        filter: ['==', '$type', 'Point'],
      })

      mapboxMap.once('data', () => {
        setMap((map) => (map === null ? mapboxMap : map))
      })

      mapboxMap.once('idle', () => {
        setMap((map) => (map === null ? mapboxMap : map))
        mapboxMap.on('mousemove', ['stations-circles'], (e) => {
          if (e.features && e.features.length > 0) {
            const feature = e.features.find((f) => f.state.found && f.id)
            if (feature && feature.id) {
              return setHoveredId(feature.id as number)
            }
          }

          setHoveredId(null)
        })

        mapboxMap.on('mouseleave', ['stations-circles'], () => {
          setHoveredId(null)
          mapboxMap.getCanvas().style.cursor = ''
        })

        // Hover feedback (pin mode only) — cursor pointer + stroke bump via feature-state.
        let hoverFeatureId: number | null = null
        const clearHover = () => {
          if (hoverFeatureId != null) {
            mapboxMap.setFeatureState(
              { source: 'features', id: hoverFeatureId },
              { pinHover: false },
            )
            hoverFeatureId = null
          }
        }
        mapboxMap.on('mousemove', (e) => {
          if (!pinClickHandlerRef.current) {
            clearHover()
            return
          }
          const nearby = mapboxMap.queryRenderedFeatures(
            [
              [e.point.x - 8, e.point.y - 8],
              [e.point.x + 8, e.point.y + 8],
            ],
            { layers: ['stations-circles'] },
          )
          const target = nearby.find((f) => f.id != null)
          if (target && target.id != null) {
            const id = target.id as number
            if (hoverFeatureId !== id) {
              clearHover()
              hoverFeatureId = id
              mapboxMap.setFeatureState(
                { source: 'features', id },
                { pinHover: true },
              )
            }
            mapboxMap.getCanvas().style.cursor = 'pointer'
          } else {
            clearHover()
            mapboxMap.getCanvas().style.cursor = ''
          }
        })

        // Click detection with an 8px bbox around the click point so users don't
        // need to hit the ~4px dot dead centre. Multiple stations can fall in the
        // bbox — pick the one closest to the click point in screen space.
        mapboxMap.on('click', (e) => {
          if (!pinClickHandlerRef.current) return
          const hits = mapboxMap.queryRenderedFeatures(
            [
              [e.point.x - 8, e.point.y - 8],
              [e.point.x + 8, e.point.y + 8],
            ],
            { layers: ['stations-circles'] },
          )
          if (hits.length === 0) return
          let best: { id: number; d2: number } | null = null
          for (const f of hits) {
            if (f.id == null) continue
            if (f.geometry.type !== 'Point') continue
            const p = mapboxMap.project(
              f.geometry.coordinates as [number, number],
            )
            const dx = p.x - e.point.x
            const dy = p.y - e.point.y
            const d2 = dx * dx + dy * dy
            if (!best || d2 < best.d2) {
              best = { id: Number(f.id), d2 }
            }
          }
          if (!best) return
          pinClickHandlerRef.current(best.id)
        })
      })
    })

    return () => {
      mapboxMap.remove()
    }
  }, [setMap, fc, LINES, MAP_CONFIG, MAP_FROM_DATA, routes])

  useEffect(() => {
    if (!map) {
      return
    } else {
      ;(map.getSource('hovered') as mapboxgl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: hoveredId ? [idMap.get(hoveredId)!] : [],
      })
    }
  }, [map, hoveredId, idMap])

  useEffect(() => {
    if (!map) return

    // Clear whatever we previously set — explicit `false` is more reliable
    // than removeFeatureState here, and it only touches the `found` key so
    // PinMode's pinState/showLabel/etc. are untouched.
    for (const id of foundAppliedRef.current) {
      map.setFeatureState({ source: 'features', id }, { found: false })
    }
    foundAppliedRef.current.clear()

    // Only reveal typing-found stations in type mode.
    if (mode === 'type' && found) {
      for (const id of found) {
        map.setFeatureState({ source: 'features', id }, { found: true })
        foundAppliedRef.current.add(id)
      }
    }
    // Insurance in case a source-level state change is missed by the renderer.
    map.triggerRepaint()
  }, [found, map, mode])

  // Line routes stay drawn but dimmed when disabled — useful for map
  // context. Station features on disabled lines are filtered out entirely:
  // multi-line stations have one feature per line, so the enabled siblings
  // at the same location keep the station visible. If we merely dimmed
  // them, the disabled-line feature (often the topmost per its layout
  // sort-key, which can't read feature-state) would cover the found dot
  // below.
  //
  // In pin hard mode, the disabled-line treatment is turned off entirely —
  // both lines and stations render at full visibility so the current pool
  // isn't visually inferable.
  useEffect(() => {
    if (!map) return
    const enabledArr = [...enabledLines]
    const opacityExpr: mapboxgl.Expression = [
      'case',
      ['match', ['get', 'line'], enabledArr, true, false],
      1,
      0.1,
    ]
    const enabledFilter: mapboxgl.Expression = [
      'match',
      ['get', 'line'],
      enabledArr,
      true,
      false,
    ]
    const hideDisabled = mode !== 'pinHard'
    if (map.getLayer('lines')) {
      map.setPaintProperty(
        'lines',
        'line-opacity',
        hideDisabled ? opacityExpr : 1,
      )
    }
    for (const id of ['stations', 'stations-circles', 'stations-labels']) {
      if (map.getLayer(id)) {
        map.setFilter(id, hideDisabled ? enabledFilter : null)
      }
    }
  }, [map, enabledLines, mode])

  const zoomToFeature = useCallback(
    (id: number) => {
      if (!map) return

      const feature = idMap.get(id)
      if (!feature) return

      if (feature.geometry.type === 'Point') {
        map.flyTo({
          center: feature.geometry.coordinates as [number, number],
          zoom: 14,
        })
      } else {
        const bounds = new mapboxgl.LngLatBounds()
        coordEach(feature, (coord) => {
          bounds.extend(coord as [number, number])
        })
        map.fitBounds(bounds, { padding: 100 })
      }
    },
    [map, idMap],
  )

  return (
    <div className="flex h-screen flex-row items-top justify-between">
      <div className="relative flex h-screen grow justify-center">
        <div className="absolute left-0 top-0 h-screen w-full" id="map" />
        <div className="absolute top-4 h-12 w-96 max-w-full px-1 lg:top-32">
          <FoundSummary
            className="mb-4 rounded-lg bg-white p-4 shadow-md lg:hidden"
            foundProportion={panelProportion}
            foundStationsPerLine={panelFoundPerLine}
            stationsPerLine={panelStationsPerLine}
            defaultMinimized
            minimizable
          />
          <div className="flex gap-2 lg:gap-4">
            {mode === 'type' ? (
              <Input
                fuse={fuse}
                found={found}
                setFound={setFound}
                setIsNewPlayer={setIsNewPlayer}
                inputRef={inputRef}
                map={map}
                idMap={idMap}
              />
            ) : (
              <PinMode
                // Force remount across pin-mode variants so PinMode's
                // initialisedRef and the mode-keyed localStorage hook both
                // reset cleanly — otherwise switching between soft and hard
                // with fresh progress leaves the component stuck on Loading.
                key={mode}
                mode={mode}
                stationPool={pinStationPool}
                idMap={idMap}
                nameToIds={nameToIds}
                map={map}
                progress={pinProgress}
                setProgress={setPinProgress}
                onFlashWrong={flashWrong}
                onRevealAnswer={revealAnswer}
              />
            )}
            <MenuComponent
              onReset={onReset}
              hideLabels={hideLabels}
              setHideLabels={setHideLabels}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>
        </div>
      </div>
      <div className="z-10 hidden h-full overflow-y-auto bg-zinc-50 p-6 shadow-lg lg:block lg:w-96 xl:w-[32rem]">
        <FoundSummary
          foundProportion={panelProportion}
          foundStationsPerLine={panelFoundPerLine}
          stationsPerLine={panelStationsPerLine}
          minimizable
          defaultMinimized
        />
        {callout}
        <hr className="my-4 w-full border-b border-zinc-100" />
        <FoundList
          found={found}
          idMap={idMap}
          setHoveredId={setHoveredId}
          hoveredId={hoveredId}
          hideLabels={hideLabels}
          zoomToFeature={zoomToFeature}
        />
      </div>
      <IntroModal
        inputRef={inputRef}
        open={isNewPlayer && mode === 'type'}
        setOpen={setIsNewPlayer}
      >
        {t('introInstruction')} ⏎
      </IntroModal>
      <StripeModal
        foundProportion={foundProportion}
        open={showStripeModal}
        setOpen={setShowStripeModal}
      />
      <SettingsModal
        open={settingsOpen}
        setOpen={setSettingsOpen}
        mode={mode}
        setMode={setModeValue}
        enabledLines={enabledLines}
        setEnabledLines={setEnabledLines}
        onCommitReset={() => {
          // Full state wipe. Imperatively clear any `found` visuals we've
          // applied first as insurance in case the effect-driven clear from
          // setFound([]) doesn't repaint in time.
          if (map) {
            for (const id of foundAppliedRef.current) {
              map.removeFeatureState({ source: 'features', id }, 'found')
            }
            foundAppliedRef.current.clear()
            map.triggerRepaint()
          }
          resetAll()
        }}
        onLinesChangedSilent={() => {
          // No active game so we don't need the confirm popup, but the pin
          // order (if PinMode is mounted) was baked from the old pool —
          // reseed so the prompt matches the new selection.
          pinResetRef.current?.()
        }}
        onCommitKeep={(newEnabledLines) => {
          // Type-mode line change: keep any previously-found station that
          // still has at least one feature on a currently-enabled line.
          // We collect names from ALL previously-found ids first (not just
          // the ones whose specific feature id survives the filter), so a
          // station whose only found feature was on a removed line still
          // gets a chance to be preserved via a sibling on a newly-enabled
          // line. Sibling features on the same station name are also
          // back-filled from the enabled set, keeping Input's already-found
          // detection in sync across multi-line stations.
          const foundNames = new Set<string>()
          for (const id of localFound || []) {
            const name = idMap.get(id)?.properties.name
            if (name) foundNames.add(name)
          }
          const kept = new Set<number>()
          for (const name of foundNames) {
            const siblingIds = nameToIds.get(name) || []
            for (const id of siblingIds) {
              const line = idMap.get(id)?.properties.line
              if (line && newEnabledLines.has(line)) kept.add(id)
            }
          }
          setFound([...kept])
        }}
        hasActiveGame={
          mode === 'type' ? found.length > 0 : hasPinProgress(pinProgress)
        }
      />
    </div>
  )
}
