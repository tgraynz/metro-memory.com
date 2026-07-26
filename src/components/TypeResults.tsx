'use client'

const TypeResults = ({
  foundProportion,
  hasMissed,
  onPlayAgain,
  onReview,
}: {
  foundProportion: number
  /** Whether there's anything to review (i.e. missed stations exist). When
   *  false — for a 100% round — the Review button is hidden. */
  hasMissed: boolean
  onPlayAgain: () => void
  onReview: () => void
}) => {
  return (
    <div className="w-full rounded-2xl bg-white px-4 py-3 shadow-lg">
      <div className="text-center text-sm font-bold text-gray-900">
        Round complete
      </div>
      <div className="mt-1 text-center text-3xl font-bold tabular-nums text-zinc-900">
        {(foundProportion * 100).toFixed(1)}%
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

export default TypeResults
