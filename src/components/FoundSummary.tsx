'use client'

import { usePrevious } from '@react-hookz/web'
import classNames from 'classnames'
import { useEffect, useState } from 'react'
import ProgressBars from './ProgressBars'
import { MaximizeIcon } from './MaximizeIcon'
import { MinimizeIcon } from './MinimizeIcon'

const FoundSummary = ({
  className,
  foundStationsPerLine,
  stationsPerLine,
  fullStationsPerLine,
  foundProportion,
  minimizable = false,
  defaultMinimized = false,
}: {
  className?: string
  foundStationsPerLine: Record<string, number>
  stationsPerLine: Record<string, number>
  /** Full un-narrowed per-line counts (i.e. before any review-pool
   *  filtering). When provided, per-line confetti only fires if hitting
   *  100% of the current pool also equals the full line — so a review round
   *  covering a proper subset of a line doesn't confetti, but a review that
   *  happens to cover the whole line does. If omitted, falls back to
   *  treating `stationsPerLine` as the full total. */
  fullStationsPerLine?: Record<string, number>
  foundProportion: number
  minimizable?: boolean
  defaultMinimized?: boolean
}) => {
  const previousFound = usePrevious(foundStationsPerLine)
  const [minimized, setMinimized] = useState<boolean>(defaultMinimized)

  useEffect(() => {
    // Confetti when a line hits 100%. `previousFound[line]` may be
    // `undefined` if the line wasn't tracked last render (e.g. it was just
    // re-enabled in settings and back-filled with sibling stations), so we
    // coerce to 0 to catch that increase.
    //
    // The `Object.keys(previousFound).length > 0` guard suppresses the
    // spurious firing on page refresh: on first mount `foundStationsPerLine`
    // is `{}` (pre-LS-hydration), then jumps to fully-populated counts —
    // without this check every already-complete line would confetti on load.
    // Any real user-driven change happens with a populated previousFound.
    //
    // The `fullStationsPerLine` gate suppresses confetti in review rounds
    // that cover only a proper subset of a line — the review pool has
    // fewer stations than the real line, so hitting 100% of the pool isn't
    // actually completing the line. If the review pool happens to include
    // every station on the line, the two totals match and confetti fires.
    const hasPriorTracking =
      previousFound && Object.keys(previousFound).length > 0
    const newFoundLines = Object.keys(foundStationsPerLine).filter(
      (line) =>
        hasPriorTracking &&
        foundStationsPerLine[line] > (previousFound![line] ?? 0) &&
        foundStationsPerLine[line] === stationsPerLine[line] &&
        (!fullStationsPerLine ||
          stationsPerLine[line] === fullStationsPerLine[line]),
    )

    if (newFoundLines.length > 0) {
      const makeConfetti = async () => {
        const confetti = (await import('tsparticles-confetti')).confetti
        confetti({
          spread: 120,
          ticks: 200,
          particleCount: 150,
          origin: { y: 0.2 },
          decay: 0.85,
          gravity: 2,
          startVelocity: 50,
          shapes: ['image'],
          scalar: 2,
          shapeOptions: {
            image: newFoundLines.map((line) => ({
              src: `/images/${line}.svg`,
              width: 64,
              height: 64,
            })),
          },
        })
      }

      makeConfetti()
    }
  }, [
    previousFound,
    foundStationsPerLine,
    stationsPerLine,
    fullStationsPerLine,
  ])

  return (
    <div
      className={classNames(className, '@container', {
        relative: minimizable,
      })}
    >
      <div className="mb-2">
        <p className="mb-2">
          <span className="text-lg font-bold @md:text-2xl">
            {((foundProportion || 0) * 100).toFixed(1)}
          </span>
          <span className="text-lg @md:text-xl">%</span>
        </p>
        <ProgressBars
          minimized={minimized}
          foundStationsPerLine={foundStationsPerLine}
          stationsPerLine={stationsPerLine}
        />
      </div>
      {minimizable && (
        <div className="absolute bottom-0 right-0">
          <button
            onClick={() => setMinimized(!minimized)}
            className="mx-2 my-1 flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-500 shadow"
          >
            {minimized ? (
              <MaximizeIcon className="h-4 w-4" />
            ) : (
              <MinimizeIcon className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
    </div>
  )
}

export default FoundSummary
