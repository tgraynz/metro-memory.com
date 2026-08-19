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
  onPlayAgain,
  onReview,
  hasMissed,
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
   *  station's name. Fired on the 3rd+ wrong guess and on skip. `anchorCoord`
   *  is a secondary point that fitBounds should include alongside the
   *  correct station — the wrong click's coord for a wrong guess, the map's
   *  current centre for a skip. Callers may omit it to fall back to the
   *  current centre. */
  onRevealAnswer: (
    featureIds: number[],
    anchorCoord?: [number, number] | null,
  ) => void
  /** Round-complete Play Again — resets to a fresh full-pool round. Owned
   *  by GamePage because it needs to flip the review flag alongside. */
  onPlayAgain: () => void
  /** Round-complete Review — resets to a fresh round using the just-missed
   *  stations as the pool. */
  onReview: () => void
  /** Whether the just-completed round has any missed stations. Controls the
   *  Review button visibility on the round-complete panel. */
  hasMissed: boolean
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

  // Pending hard-mode clear timeouts. Cancelled on mode change / unmount so
  // a delayed clear from an aborted mode doesn't wipe the current mode's
  // visuals.
  const hardFlashTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(
    new Set(),
  )

  useEffect(() => {
    return () => {
      for (const t of hardFlashTimeoutsRef.current) clearTimeout(t)
      hardFlashTimeoutsRef.current.clear()
    }
  }, [mode])

  // Seed a new game from the current pool.
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

  // Initialise: adopt saved progress if it matches the current pool AND was
  // seeded for the current mode; otherwise seed fresh. The mode check guards
  // against a race after a mode switch: GamePage's mode-keyed
  // useLocalStorageValue lags the new key by one render, so we can briefly
  // receive the previous mode's progress as a prop even though `key={mode}`
  // has re-mounted us.
  useEffect(() => {
    if (initialisedRef.current) return
    // Wait for the async localStorage read to resolve.
    if (progress === undefined) return

    if (progress) {
      // Progress carries no mode tag on very old saved data — treat as
      // stale and re-seed.
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
        return // saved progress already valid — nothing to do
      }
    }

    initialisedRef.current = true
    seedGame()
  }, [progress, poolIds, seedGame, mode])

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

        // Hard mode: no persistent visual is applied by the effect below, so
        // briefly flash the graded colour so the player still gets feedback,
        // then clear it. Timeout is tracked so a mode change cancels it.
        if (mode === 'pinHard' && map) {
          const ids =
            (currentName && nameToIds.get(currentName)) || [currentStationId]
          for (const fid of ids) {
            map.setFeatureState(
              { source: 'features', id: fid },
              { pinState: state },
            )
          }
          const t = setTimeout(() => {
            hardFlashTimeoutsRef.current.delete(t)
            for (const fid of ids) {
              map.removeFeatureState(
                { source: 'features', id: fid },
                'pinState',
              )
            }
          }, 600)
          hardFlashTimeoutsRef.current.add(t)
        }
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
          const clickedFeat = idMap.get(clickedId)
          const clickedCoord =
            clickedFeat?.geometry.type === 'Point'
              ? (clickedFeat.geometry.coordinates as [number, number])
              : null
          onRevealAnswer(ids, clickedCoord)
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
      mode,
      map,
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

    const finished = progress.currentIdx >= progress.order.length

    // Hard mode: no persistent visual during play — played stations look
    // identical to unplayed. Correct-guess feedback is the brief flash
    // triggered inline in handleClickStation. But on round completion we
    // reveal every played station's outcome (and its label) so the player
    // can review before choosing Play again / Review missed.
    if (mode === 'pinHard' && !finished) return

    // Entering the pinHard reveal: cancel any pending flash-cleanup timeouts
    // so they don't remove pinState from the last-clicked stations
    // mid-reveal.
    if (mode === 'pinHard' && finished) {
      for (const t of hardFlashTimeoutsRef.current) clearTimeout(t)
      hardFlashTimeoutsRef.current.clear()
    }

    for (const [idStr, state] of Object.entries(progress.stationStates)) {
      const id = Number(idStr)
      const name = idMap.get(id)?.properties.name
      const ids = (name && nameToIds.get(name)) || [id]
      for (const fid of ids) {
        map.setFeatureState({ source: 'features', id: fid }, { pinState: state })
        // Reveal labels in soft pin always; in pinHard only during the
        // round-complete reveal so play stays label-free.
        if (mode === 'pin' || (mode === 'pinHard' && finished)) {
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

  const handleSkip = useCallback(() => {
    if (!progress || currentStationId == null) return
    // Skip = defer to the end of the queue. The skipped station keeps its
    // (empty) attempts state and slides to the back, so the player comes
    // back to it later. Does NOT mark missed and does NOT reveal — those
    // outcomes are reserved for the wrong × 3 path. This matches typeHard's
    // skip semantics so the two prompt-modes behave the same way.
    const skipped = progress.order[progress.currentIdx]
    const nextOrder = [
      ...progress.order.slice(0, progress.currentIdx),
      ...progress.order.slice(progress.currentIdx + 1),
      skipped,
    ]
    setProgress({
      ...progress,
      order: nextOrder,
      attemptsForCurrent: 0,
    })
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
