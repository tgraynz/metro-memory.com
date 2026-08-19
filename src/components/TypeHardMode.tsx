'use client'

import { DataFeature, GameMode, PinProgress, PinStationState } from '@/lib/types'
import { computePinScoreProportion } from '@/lib/pinScoring'
import useNormalizeString from '@/hooks/useNormalizeString'
import mapboxgl from 'mapbox-gl'
import Fuse from 'fuse.js'
import {
  KeyboardEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import classNames from 'classnames'

const MAX_ATTEMPTS = 3

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export default function TypeHardMode({
  mode,
  stationPool,
  idMap,
  nameToIds,
  fuse,
  map,
  progress,
  setProgress,
  onRevealAnswer,
  onPlayAgain,
  onReview,
  hasMissed,
}: {
  mode: Extract<GameMode, 'typeHard' | 'typeHarder'>
  /** All Point features that can be prompted this round — one entry per
   *  unique station name, already narrowed by enabled lines / zones /
   *  review pool. */
  stationPool: DataFeature[]
  idMap: Map<number, DataFeature>
  /** All feature ids sharing a given station name (a station like Baker
   *  Street exists as one feature per line served). Used to spread the
   *  reveal flash across every line's dot for the same station. */
  nameToIds: Map<string, number[]>
  /** Shared Fuse instance built against active features, so the fuzzy
   *  match behaviour matches regular type mode exactly. */
  fuse: Fuse<DataFeature>
  map: mapboxgl.Map | null
  /** Progress state. `undefined` while the localStorage read is in-flight,
   *  `null` when nothing is stored. Owned by GamePage. Same shape as
   *  PinProgress — the two are structurally identical. */
  progress: PinProgress | null | undefined
  setProgress: (p: PinProgress) => void
  /** Fires the reveal-flash + fitBounds when wrong × 3 forces a reveal. */
  onRevealAnswer: (
    featureIds: number[],
    anchorCoord?: [number, number] | null,
  ) => void
  onPlayAgain: () => void
  onReview: () => void
  hasMissed: boolean
}) {
  const normalizeString = useNormalizeString()

  const poolIds = useMemo(
    () =>
      stationPool
        .map((f) => Number(f.id))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b),
    [stationPool],
  )

  const initialisedRef = useRef(false)

  // Ids we've applied pinState/showLabel to on the map. Cleared explicitly
  // on each pass because source-level removeFeatureState is unreliable.
  const appliedIdsRef = useRef<Set<number>>(new Set())

  // Pending typeHarder flash-cleanup timeouts. Cancelled on mode change /
  // unmount so a delayed clear from an aborted mode doesn't wipe the
  // current mode's visuals — and cancelled at round-complete transition
  // so they don't tear down the end-of-round outcome reveal.
  const harderFlashTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(
    new Set(),
  )

  useEffect(() => {
    return () => {
      for (const t of harderFlashTimeoutsRef.current) clearTimeout(t)
      harderFlashTimeoutsRef.current.clear()
    }
  }, [mode])

  const seedGame = useCallback(() => {
    const order = shuffle(poolIds)
    const next: PinProgress = {
      mode,
      order,
      currentIdx: 0,
      attemptsForCurrent: 0,
      stationStates: {},
    }
    setProgress(next)
  }, [poolIds, setProgress, mode])

  // Init: adopt saved progress if it matches the current pool AND was
  // seeded for this mode; otherwise seed fresh. Same guard PinMode uses.
  useEffect(() => {
    if (initialisedRef.current) return
    if (progress === undefined) return

    if (progress) {
      if (progress.mode !== mode) {
        seedGame()
        return
      }
      const sameOrder = [...progress.order].sort((a, b) => a - b)
      const matchesPool =
        sameOrder.length === poolIds.length &&
        sameOrder.every((v, i) => v === poolIds[i])
      if (matchesPool) {
        initialisedRef.current = true
        return
      }
    }

    initialisedRef.current = true
    seedGame()
  }, [progress, poolIds, seedGame, mode])

  const currentStationId = progress
    ? progress.order[progress.currentIdx] ?? null
    : null
  const currentStation =
    currentStationId != null ? idMap.get(currentStationId) : null
  const currentStationName =
    (currentStation?.properties.name as string | undefined) ?? null
  const isFinished = progress
    ? progress.currentIdx >= progress.order.length
    : false

  // Drive the `prompted` map source + optional pan when the current
  // station changes so the player can see where they're being asked
  // about. Only pans if the station is off-screen; if already visible we
  // leave the view alone to avoid disorienting movement.
  useEffect(() => {
    if (!map || currentStationId == null) return
    const feat = idMap.get(currentStationId)
    if (!feat || feat.geometry.type !== 'Point') return
    const source = map.getSource('prompted') as
      | mapboxgl.GeoJSONSource
      | undefined
    if (source) {
      source.setData({ type: 'FeatureCollection', features: [feat] })
    }
    const coord = feat.geometry.coordinates as [number, number]
    const container = map.getContainer()
    const w = container.clientWidth
    const h = container.clientHeight
    const px = map.project(coord)
    // Reserve some top padding so the station doesn't sit under the UI
    // strip along the top of the map.
    const safeTop = 160
    const inView =
      px.x >= 0 && px.x <= w && px.y >= safeTop && px.y <= h
    if (!inView) {
      map.easeTo({ center: coord, duration: 400 })
    }
    return () => {
      const s = map.getSource('prompted') as
        | mapboxgl.GeoJSONSource
        | undefined
      if (s) s.setData({ type: 'FeatureCollection', features: [] })
    }
  }, [map, currentStationId, idMap])

  // Reveal played stations as we go — same visual scheme as soft pin mode.
  // Each stationStates entry paints its features with the graded pinState
  // (green for first-try, orange for 2nd/3rd, red for missed) and reveals
  // the station's label. Cleared and re-applied every render so entries
  // dropped from stationStates (e.g. after a reseed) disappear cleanly.
  //
  // typeHarder: no persistent visual during play — played stations look
  // identical to unplayed. Correct-guess feedback is a brief flash
  // triggered inline in handleSubmit. At round-complete we reveal every
  // played station's outcome (mirroring pinHard's end-of-round reveal).
  useEffect(() => {
    if (!map || !progress) return

    for (const fid of appliedIdsRef.current) {
      map.removeFeatureState({ source: 'features', id: fid }, 'pinState')
      map.removeFeatureState({ source: 'features', id: fid }, 'showLabel')
    }
    appliedIdsRef.current.clear()

    const finished = progress.currentIdx >= progress.order.length

    if (mode === 'typeHarder' && !finished) return

    // Entering the typeHarder reveal: cancel any pending flash-cleanup
    // timeouts so they don't remove pinState from the last-typed stations
    // mid-reveal.
    if (mode === 'typeHarder' && finished) {
      for (const t of harderFlashTimeoutsRef.current) clearTimeout(t)
      harderFlashTimeoutsRef.current.clear()
    }

    for (const [idStr, state] of Object.entries(progress.stationStates)) {
      const id = Number(idStr)
      const name = idMap.get(id)?.properties.name
      const ids = (name && nameToIds.get(name)) || [id]
      for (const fid of ids) {
        map.setFeatureState(
          { source: 'features', id: fid },
          { pinState: state },
        )
        map.setFeatureState(
          { source: 'features', id: fid },
          { showLabel: true },
        )
        appliedIdsRef.current.add(fid)
      }
    }
  }, [map, progress, mode, idMap, nameToIds])

  // Clear pinState / showLabel when this component unmounts (mode switch)
  // so the coloured dots + labels don't linger over into pin/pinHard/type.
  useEffect(() => {
    return () => {
      if (!map) return
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const fid of appliedIdsRef.current) {
        map.removeFeatureState({ source: 'features', id: fid }, 'pinState')
        map.removeFeatureState({ source: 'features', id: fid }, 'showLabel')
      }
      appliedIdsRef.current.clear()
    }
  }, [map])

  const [input, setInput] = useState<string>('')
  const [wrongFlash, setWrongFlash] = useState<boolean>(false)
  const [correctFlash, setCorrectFlash] = useState<boolean>(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Refocus the input whenever the current prompt changes so the player
  // can keep typing without hunting for focus.
  useEffect(() => {
    inputRef.current?.focus()
  }, [currentStationId])

  const handleSubmit = useCallback(() => {
    if (!progress || isFinished || currentStationId == null) return
    if (!input.trim()) return

    const currentName = idMap.get(currentStationId)?.properties.name
    if (!currentName) return

    // Match the exact heuristic Input.tsx uses so fuzzy behaviour is
    // consistent with plain type mode.
    const sanitized = normalizeString(input)
    const results = fuse.search(sanitized)
    const matchedIds = new Set<number>()
    for (const result of results) {
      if (
        result.matches &&
        result.matches.length &&
        result.matches.some(
          (match) =>
            match.indices[0][0] === 0 &&
            match.value!.length -
              match.indices[match.indices.length - 1][1] <
              2 &&
            Math.abs(match.value!.length - sanitized.length) < 4,
        )
      ) {
        matchedIds.add(+result.item.id!)
      }
    }

    // Any feature sharing the current station's name counts as a hit —
    // handles multi-line stations where fuse may return a sibling's id.
    const currentNameIds = new Set(nameToIds.get(currentName) ?? [])
    const isCorrect = [...matchedIds].some((id) => currentNameIds.has(id))

    if (isCorrect) {
      const attempts = progress.attemptsForCurrent + 1
      let state: PinStationState
      if (attempts === 1) state = 'first'
      else if (attempts === 2) state = 'second'
      else if (attempts === 3) state = 'third'
      else state = 'missed'

      const next: PinProgress = {
        ...progress,
        currentIdx: progress.currentIdx + 1,
        attemptsForCurrent: 0,
        stationStates: {
          ...progress.stationStates,
          [currentStationId]: state,
        },
      }
      setProgress(next)
      setInput('')
      setCorrectFlash(true)
      setTimeout(() => setCorrectFlash(false), 250)

      // typeHarder: no persistent visual is applied by the effect above,
      // so briefly flash the graded pinState on the map so the player
      // still gets feedback about which station they just got. Timeout is
      // tracked so mode switch / round-complete transition can cancel it.
      if (mode === 'typeHarder' && map) {
        const ids = nameToIds.get(currentName) ?? [currentStationId]
        for (const fid of ids) {
          map.setFeatureState(
            { source: 'features', id: fid },
            { pinState: state },
          )
        }
        const t = setTimeout(() => {
          harderFlashTimeoutsRef.current.delete(t)
          for (const fid of ids) {
            map.removeFeatureState(
              { source: 'features', id: fid },
              'pinState',
            )
          }
        }, 600)
        harderFlashTimeoutsRef.current.add(t)
      }
    } else {
      const nextAttempts = progress.attemptsForCurrent + 1
      setInput('')
      setWrongFlash(true)
      setTimeout(() => setWrongFlash(false), 500)

      if (nextAttempts >= MAX_ATTEMPTS) {
        // Reveal + advance + mark missed. Anchor pan on the current view
        // centre so the reveal fitBounds always includes something even
        // when the correct dot is well off-screen.
        const ids = nameToIds.get(currentName) ?? [currentStationId]
        const centre = map?.getCenter()
        const anchor: [number, number] | null = centre
          ? [centre.lng, centre.lat]
          : null
        onRevealAnswer(ids, anchor)
        const next: PinProgress = {
          ...progress,
          currentIdx: progress.currentIdx + 1,
          attemptsForCurrent: 0,
          stationStates: {
            ...progress.stationStates,
            [currentStationId]: 'missed',
          },
        }
        setProgress(next)
      } else {
        const next: PinProgress = {
          ...progress,
          attemptsForCurrent: nextAttempts,
        }
        setProgress(next)
      }
    }
  }, [
    progress,
    isFinished,
    currentStationId,
    input,
    normalizeString,
    fuse,
    idMap,
    nameToIds,
    map,
    mode,
    onRevealAnswer,
    setProgress,
  ])

  const onKeyDown: KeyboardEventHandler<HTMLInputElement> = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit],
  )

  const handleSkip = useCallback(() => {
    if (!progress || isFinished || currentStationId == null) return
    // Skip = defer to end of queue. The skipped station keeps its
    // (empty) attempts state and slides to the back so the player will
    // come back to it. Does NOT mark missed — that only happens via
    // wrong × 3 or give-up.
    const skipped = progress.order[progress.currentIdx]
    const nextOrder = [
      ...progress.order.slice(0, progress.currentIdx),
      ...progress.order.slice(progress.currentIdx + 1),
      skipped,
    ]
    setInput('')
    setProgress({
      ...progress,
      order: nextOrder,
      attemptsForCurrent: 0,
    })
  }, [progress, isFinished, currentStationId, setProgress])

  const handleGiveUp = useCallback(() => {
    if (!progress || isFinished) return
    // Mark every remaining station (from currentIdx onward) as missed
    // and fast-forward to the round-complete view.
    const nextStates: Record<number, PinStationState> = {
      ...progress.stationStates,
    }
    for (let i = progress.currentIdx; i < progress.order.length; i++) {
      const id: number = progress.order[i]
      if (nextStates[id] === undefined) nextStates[id] = 'missed'
    }
    setProgress({
      ...progress,
      currentIdx: progress.order.length,
      attemptsForCurrent: 0,
      stationStates: nextStates,
    })
  }, [progress, isFinished, setProgress])

  // Register reset handler so GamePage's "Start Over" and Play again
  // paths can reseed us via the same ref pattern PinMode uses.
  useEffect(() => {
    typeHardResetRef.current = seedGame
    return () => {
      if (typeHardResetRef.current === seedGame) {
        typeHardResetRef.current = null
      }
    }
  }, [seedGame])

  if (!progress) {
    return (
      <div className="w-full rounded-full bg-white px-4 py-2 text-center text-sm text-gray-500 shadow-lg">
        Loading…
      </div>
    )
  }

  if (isFinished) {
    const finalScore = computePinScoreProportion(progress)
    return (
      <div className="w-full rounded-2xl bg-white px-4 py-3 shadow-lg">
        <div className="text-center text-sm font-bold text-gray-900">
          Round complete
        </div>
        <div className="mt-1 text-center text-3xl font-bold tabular-nums text-zinc-900">
          {(finalScore * 100).toFixed(1)}%
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={onPlayAgain}
            className="w-full rounded-full bg-zinc-700 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-600"
          >
            Play again
          </button>
          {hasMissed && (
            <button
              type="button"
              onClick={onReview}
              className="w-full rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-700 shadow-sm ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50"
            >
              Review missed
            </button>
          )}
        </div>
      </div>
    )
  }

  const attemptsUsed = progress.attemptsForCurrent
  const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attemptsUsed)

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="w-full rounded-full bg-white px-4 py-2 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium text-gray-500 tabular-nums">
            {progress.currentIdx + 1}/{progress.order.length}
          </div>
          <input
            ref={inputRef}
            className={classNames(
              {
                'animate animate-shake': wrongFlash,
                'shadow-md !shadow-yellow-500': correctFlash,
              },
              'grow rounded-full px-3 py-1 text-lg font-bold text-zinc-900 caret-current outline-none ring-zinc-800 transition-shadow duration-300 focus:ring-2',
            )}
            placeholder="Type the highlighted station"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
            type="text"
          />
          <div
            className="flex items-center gap-1"
            title={`${attemptsLeft} attempts left`}
          >
            {Array.from({ length: MAX_ATTEMPTS }).map((_, i) => (
              <span
                key={i}
                className={`inline-block h-2 w-2 rounded-full ${
                  i < attemptsUsed ? 'bg-red-400' : 'bg-gray-300'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleSkip}
          className="rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-600 shadow hover:text-gray-900"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={handleGiveUp}
          className="rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-600 shadow hover:text-gray-900"
        >
          Give up
        </button>
      </div>
      {/* Silence unused warning while keeping currentStationName addressable for
          future work (e.g. an accessible label). */}
      <span className="hidden">{currentStationName}</span>
    </div>
  )
}

/**
 * Module-level ref used by GamePage's Play-again / Start-over / mode-
 * switch flows to reseed an active typeHard game. Null when TypeHardMode
 * is not mounted.
 */
export const typeHardResetRef: { current: (() => void) | null } = {
  current: null,
}
