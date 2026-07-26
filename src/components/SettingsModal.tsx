'use client'

import { Fragment, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { Dialog, Transition } from '@headlessui/react'
import { useConfig } from '@/lib/configContext'
import useTranslation from '@/hooks/useTranslation'
import { GameMode } from '@/lib/types'

const MODE_OPTIONS: { value: GameMode; label: string; description: string }[] = [
  {
    value: 'type',
    label: 'Type mode',
    description: 'The original game — type station names to reveal them.',
  },
  {
    value: 'pin',
    label: 'Pin mode',
    description: 'You are shown a station name and click on the map to find it.',
  },
]

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

export default function SettingsModal({
  open,
  setOpen,
  mode,
  setMode,
  enabledLines,
  setEnabledLines,
  onLinesChangedReset,
  onModeChangeReset,
  hasActiveGame,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  mode: GameMode
  setMode: (mode: GameMode) => void
  enabledLines: Set<string>
  setEnabledLines: (lines: Set<string>) => void
  /** Apply the new line pool to any active pin game. */
  onLinesChangedReset: () => void
  /** Fired synchronously when the user commits a mode change so the caller
   *  can wipe both modes' game state and any map visuals belonging to the
   *  previous mode. Runs before setMode's flushSync so bookkeeping tied to
   *  the outgoing mode is still intact. */
  onModeChangeReset: () => void
  /** When true, Done prompts for confirmation before applying mode or line
   *  changes (used when an in-progress game would be disturbed). When false,
   *  changes apply silently. */
  hasActiveGame: boolean
}) {
  const { LINES } = useConfig()
  const { t } = useTranslation()

  // Local drafts so cancelling the restart prompt can genuinely revert without
  // fighting parent state. Mode changes are also drafted so radio clicks don't
  // take effect until the user presses Done.
  const [draftLines, setDraftLines] = useState<Set<string>>(
    () => new Set(enabledLines),
  )
  const [draftMode, setDraftMode] = useState<GameMode>(mode)

  // Resync drafts to the current committed values each time the modal opens.
  useEffect(() => {
    if (open) {
      setDraftLines(new Set(enabledLines))
      setDraftMode(mode)
    }
    // We deliberately only resync on open transitions; changes to props while
    // the modal is closed shouldn't wipe an unrelated in-flight draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggleLine = (key: string) => {
    setDraftLines((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allLineKeys = Object.keys(LINES).sort(
    (a, b) => (LINES[a].order ?? 0) - (LINES[b].order ?? 0),
  )
  const allEnabled = allLineKeys.every((k) => draftLines.has(k))

  const applyChanges = (linesChanged: boolean, modeChanged: boolean) => {
    if (modeChanged) {
      // Fire imperative reset BEFORE the state change so bookkeeping tied
      // to the outgoing mode is still intact (and so the effect-based mode
      // sync doesn't drain it out from under us).
      onModeChangeReset()
      flushSync(() => setMode(draftMode))
    }
    if (linesChanged) {
      // Commit synchronously so PinMode's derived poolIds is up-to-date by
      // the time we ask it to reseed.
      flushSync(() => setEnabledLines(draftLines))
      onLinesChangedReset()
    }
  }

  const handleDone = () => {
    const linesChanged = !setsEqual(draftLines, enabledLines)
    const modeChanged = draftMode !== mode
    if (linesChanged || modeChanged) {
      if (hasActiveGame) {
        if (confirm(t('restartWarning'))) {
          applyChanges(linesChanged, modeChanged)
        } else {
          // User declined — revert both drafts and keep the modal open so they
          // can adjust their selection.
          setDraftLines(new Set(enabledLines))
          setDraftMode(mode)
          return
        }
      } else {
        // No active game to disturb — apply immediately, no prompt.
        applyChanges(linesChanged, modeChanged)
      }
    }
    setOpen(false)
  }

  return (
    <Transition.Root show={open} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={setOpen}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" />
        </Transition.Child>

        <div className="fixed inset-0 z-10 w-screen overflow-y-auto">
          <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-md sm:p-6">
                <Dialog.Title
                  as="h3"
                  className="text-base font-bold leading-6 text-gray-900"
                >
                  Settings
                </Dialog.Title>

                <div className="mt-4">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                    Game mode
                  </h4>
                  <div className="mt-2 flex flex-col gap-2">
                    {MODE_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className="flex cursor-pointer items-start gap-3 rounded-md border border-gray-200 p-3 hover:border-gray-400"
                      >
                        <input
                          type="radio"
                          name="game-mode"
                          value={opt.value}
                          checked={draftMode === opt.value}
                          onChange={() => setDraftMode(opt.value)}
                          className="mt-1 accent-zinc-600"
                        />
                        <div>
                          <div className="text-sm font-semibold text-gray-900">
                            {opt.label}
                          </div>
                          <div className="text-xs text-gray-500">
                            {opt.description}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="mt-6">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                      Lines
                    </h4>
                    <button
                      type="button"
                      className="text-xs font-medium text-zinc-600 hover:text-zinc-800"
                      onClick={() =>
                        setDraftLines(
                          allEnabled ? new Set() : new Set(allLineKeys),
                        )
                      }
                    >
                      {allEnabled ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Currently used by pin mode to filter which stations you are asked about.
                  </p>
                  <div className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
                    {allLineKeys.map((key) => {
                      const line = LINES[key]
                      const on = draftLines.has(key)
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-gray-50"
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleLine(key)}
                            className="accent-zinc-600"
                          />
                          <span
                            className="inline-block h-3 w-3 rounded-full"
                            style={{ backgroundColor: line.color }}
                          />
                          <span className="text-sm text-gray-800">
                            {line.name}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>

                <div className="mt-6">
                  <button
                    type="button"
                    className="inline-flex w-full justify-center rounded-md bg-zinc-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-zinc-500"
                    onClick={handleDone}
                  >
                    Done
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  )
}
