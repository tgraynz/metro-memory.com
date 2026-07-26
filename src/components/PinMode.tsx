'use client'

import { DataFeature, GameMode, PinProgress, PinStationState } from '@/lib/types'
import { computePinScoreProportion } from '@/lib/pinScoring'
import mapboxgl from 'mapbox-gl'
import { useCallback, useEffect, useMemo, useRef } from 'react'

const MAX_ATTEMPTS = 3

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export default function PinMode({
  mode,
  stationPool,
  idMap,
  nameToIds,
  map,
  progress,
  setProgress,
  onFlashWrong,
  onRevealAnswer,
}: {
  mode: Extract<GameMode, 'pin' | 'pinHard'>
  stationPool: DataFeature[]
  idMap: Map<number, DataFeature>
  /** All feature ids sharing a given station name (a station like Baker
   *  Street exists as one feature per line served). */
  nameToIds: Map<string, number[]>
  map: mapboxgl.Map | null
  /** Current pin progress. `undefined` while the localStorage read is
   *  in-flight, `null` when nothing is stored. Owned by GamePage. */
  progress: PinProgress | null | undefined
  /** Persist and update progress. */
  setProgress: (p: PinProgress) => void
  /** Trigger a transient red flash on the wrong station clicked. */
  onFlashWrong: (id: number) => void
  /** Trigger a 4-cycle reveal flash on all features sharing the correct
   *  station's name — fired on the 3rd and every subsequent wrong guess.
   *  `clickedId` is the wrong feature so the map can zoom to fit both. */
  onRevealAnswer: (featureIds: number[], clickedId: number) => void
}) {
  // Snapshot of the ids the pool contained when the current game was seeded.
  // Used to detect when the enabled-line set changes and we need a new game.
  const poolIds = useMemo(
    () =>
      stationPool
        .map((f) => Number(f.id))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b),
    [stationPool],
  )

  const initialisedRef = useRef(false)

  // Ids we've applied pinState/showLabel to. Cleared explicitly on each pass
  // because removeFeatureState({source}, key) is unreliable — it can leave
  // stale state on features it was called against.
  const appliedIdsRef = useRef<Set<number>>(new Set())

  // Seed a new game from the current pool.
  const seedGame = useCallback(() => {
    const order = shuffle(poolIds)
    const next: PinProgress = {
      order,
      currentIdx: 0,
      attemptsForCurrent: 0,
      stationStates: {},
    }
    setProgress(next)
  }, [poolIds, setProgress])

  // Initialise: adopt saved progress if it matches the current pool, otherwise seed fresh.
  useEffect(() => {
    if (initialisedRef.current) return
    // Wait for the async localStorage read to resolve.
    if (progress === undefined) return

    initialisedRef.current = true

    if (progress) {
      const sameOrder = [...progress.order].sort((a, b) => a - b)
      const matchesPool =
        sameOrder.length === poolIds.length &&
        sameOrder.every((v, i) => v === poolIds[i])
      if (matchesPool) return // saved progress already valid — nothing to do
    }
    seedGame()
  }, [progress, poolIds, seedGame])

  const currentStationId = progress
    ? progress.order[progress.currentIdx] ?? null
    : null
  const currentStation = currentStationId != null ? idMap.get(currentStationId) : null
  const isFinished = progress
    ? progress.currentIdx >= progress.order.length
    : false

  const handleClickStation = useCallback(
    (clickedId: number) => {
      if (!progress || isFinished || currentStationId == null) return

      const clickedName = idMap.get(clickedId)?.properties.name
      const currentName = idMap.get(currentStationId)?.properties.name

      if (clickedName && currentName && clickedName === currentName) {
        // Correct guess — grade based on attempt count used.
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
      } else {
        // Wrong guess — flash the clicked station and bump the attempt counter.
        onFlashWrong(clickedId)
        const nextAttempts = progress.attemptsForCurrent + 1
        const next: PinProgress = {
          ...progress,
          attemptsForCurrent: nextAttempts,
        }
        setProgress(next)

        // On the 3rd and every subsequent wrong guess, reveal the correct
        // station by flashing every feature that shares its name.
        if (nextAttempts >= MAX_ATTEMPTS) {
          const ids =
            (currentName && nameToIds.get(currentName)) || [currentStationId]
          onRevealAnswer(ids, clickedId)
        }
      }
    },
    [
      progress,
      isFinished,
      currentStationId,
      idMap,
      nameToIds,
      onFlashWrong,
      onRevealAnswer,
      setProgress,
    ],
  )

  // Expose click handler for the map effect in GamePage via window ref pattern.
  // We do this by publishing to a ref-object that GamePage owns; see below.
  // (Passed via context param below instead.)

  // Apply pin state to map features so ring visuals update.
  // A single "station" may correspond to several features (one per line served),
  // so we spread the state to every feature sharing the resolved station's name.
  useEffect(() => {
    if (!map || !progress) return

    // Clear each id we previously applied to (targeted, per-feature — reliable).
    for (const fid of appliedIdsRef.current) {
      map.removeFeatureState({ source: 'features', id: fid }, 'pinState')
      map.removeFeatureState({ source: 'features', id: fid }, 'showLabel')
    }
    appliedIdsRef.current.clear()

    for (const [idStr, state] of Object.entries(progress.stationStates)) {
      const id = Number(idStr)
      const name = idMap.get(id)?.properties.name
      const ids = (name && nameToIds.get(name)) || [id]
      for (const fid of ids) {
        map.setFeatureState({ source: 'features', id: fid }, { pinState: state })
        // Only reveal labels in soft pin mode; hard mode deliberately withholds them.
        if (mode === 'pin') {
          map.setFeatureState({ source: 'features', id: fid }, { showLabel: true })
        }
        appliedIdsRef.current.add(fid)
      }
    }
  }, [map, progress, mode, idMap, nameToIds])

  // Clear pin-mode feature-state when this component unmounts (mode switch).
  useEffect(() => {
    return () => {
      if (!map) return
      // Intentionally read the LATEST applied ids at cleanup time — not a stale
      // snapshot from when the effect ran.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const fid of appliedIdsRef.current) {
        map.removeFeatureState({ source: 'features', id: fid }, 'pinState')
        map.removeFeatureState({ source: 'features', id: fid }, 'showLabel')
      }
      appliedIdsRef.current.clear()
    }
  }, [map])

  const handleReplay = useCallback(() => {
    seedGame()
  }, [seedGame])

  const handleSkip = useCallback(() => {
    if (!progress || currentStationId == null) return
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
  }, [progress, currentStationId, setProgress])

  // Register the click handler so GamePage can call it from its map layer.
  useEffect(() => {
    pinClickHandlerRef.current = handleClickStation
    return () => {
      if (pinClickHandlerRef.current === handleClickStation) {
        pinClickHandlerRef.current = null
      }
    }
  }, [handleClickStation])

  // Register reset handler so GamePage's "Start Over" menu item can reseed us.
  useEffect(() => {
    pinResetRef.current = seedGame
    return () => {
      if (pinResetRef.current === seedGame) {
        pinResetRef.current = null
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
        <button
          type="button"
          onClick={handleReplay}
          className="mt-3 w-full rounded-full bg-zinc-700 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-600"
        >
          Play again
        </button>
      </div>
    )
  }

  const stationName =
    (currentStation?.properties.name as string | undefined) ?? '—'
  const attemptsUsed = progress.attemptsForCurrent
  const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attemptsUsed)

  return (
    <div className="w-full rounded-full bg-white px-4 py-2 shadow-lg">
      <div className="flex items-center gap-3">
        <div className="text-xs font-medium text-gray-500 tabular-nums">
          {progress.currentIdx + 1}/{progress.order.length}
        </div>
        <div className="flex-1 truncate text-center text-lg font-bold text-zinc-900">
          {stationName}
        </div>
        <div className="flex items-center gap-1" title={`${attemptsLeft} attempts left`}>
          {Array.from({ length: MAX_ATTEMPTS }).map((_, i) => (
            <span
              key={i}
              className={`inline-block h-2 w-2 rounded-full ${
                i < attemptsUsed ? 'bg-red-400' : 'bg-gray-300'
              }`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={handleSkip}
          className="text-xs font-medium text-gray-500 hover:text-gray-800"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

/**
 * Module-level ref so GamePage's map click handler can invoke the current
 * PinMode instance without a prop-drilled callback chain. PinMode populates
 * this on mount and clears it on unmount; GamePage reads it inside the map
 * click listener.
 */
export const pinClickHandlerRef: { current: ((id: number) => void) | null } = {
  current: null,
}

/**
 * Module-level ref used by GamePage's "Start Over" menu item to reset an
 * active pin-mode game. Null when PinMode is not mounted.
 */
export const pinResetRef: { current: (() => void) | null } = {
  current: null,
}
