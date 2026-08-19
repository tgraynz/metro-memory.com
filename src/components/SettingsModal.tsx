'use client'

import { useConfig } from '@/lib/configContext'
import { GameMode } from '@/lib/types'
import { Dialog, Transition } from '@headlessui/react'
import { Fragment, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

const MODE_OPTIONS: { value: GameMode; label: string; description: string }[] = [
  {
    value: 'type',
    label: 'Type',
    description: 'The original game — type station names to reveal them.',
  },
  {
    value: 'typeHard',
    label: 'Type (hard)',
    description:
      'Type the highlighted station name.',
  },
  {
    value: 'typeHarder',
    label: 'Type (harder)',
    description:
      'Same as Type (hard), but played stations leave no trace.',
  },
  {
    value: 'pin',
    label: 'Pin',
    description: 'Click on the stations.',
  },
  {
    value: 'pinHard',
    label: 'Pin (hard)',
    description:
      'Played stations leave no trace.',
  },
]

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

// Top-level game-mode taxonomy: Type family (type / typeHard / typeHarder)
// vs Pin family (pin / pinHard). Derived from the mode string prefix so
// adding a new variant only requires appending to MODE_OPTIONS.
type ModeFamily = 'type' | 'pin'
function getFamily(m: GameMode): ModeFamily {
  return m.startsWith('pin') ? 'pin' : 'type'
}
// Base variant of each family — what draftMode falls back to when the
// player switches family via the segmented control.
const FAMILY_BASE: Record<ModeFamily, GameMode> = {
  type: 'type',
  pin: 'pin',
}

type ConfirmKind = 'mode' | 'pool-pin' | 'pool-type'

// Line and zone selection are grouped under a single "pool" concept in the
// confirmation copy — from the player's perspective both narrow the same
// set of stations.
const CONFIRM_MESSAGES: Record<ConfirmKind, string> = {
  mode: 'You are changing game mode - you are going to lose all of your progress. Are you sure?',
  'pool-pin':
    'You are changing your line or zone selection - you are going to lose all of your progress. Are you sure?',
  'pool-type':
    'You are changing your line or zone selection - you may lose some of your progress. Are you sure?',
}

// Type-mode pool changes preserve valid found stations rather than doing a
// full wipe; every other kind fully resets both modes.
const CONFIRM_ACTION: Record<ConfirmKind, 'reset' | 'keep'> = {
  mode: 'reset',
  'pool-pin': 'reset',
  'pool-type': 'keep',
}

export default function SettingsModal({
  open,
  setOpen,
  mode,
  setMode,
  enabledLines,
  setEnabledLines,
  enabledZones,
  setEnabledZones,
  allZones,
  onCommitReset,
  onCommitKeep,
  onPoolChangedSilent,
  hasActiveGame,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  mode: GameMode
  setMode: (mode: GameMode) => void
  enabledLines: Set<string>
  setEnabledLines: (lines: Set<string>) => void
  /** All zones present in the city's data, sorted ascending. Empty for
   *  cities without zone metadata — the modal then skips the Zones section
   *  entirely. */
  allZones: number[]
  enabledZones: Set<number>
  setEnabledZones: (zones: Set<number>) => void
  /** Fired after mode changes (or pin-mode pool changes) have been flushed.
   *  Caller should imperatively clear map visuals and reseed/reset both
   *  modes. */
  onCommitReset: () => void
  /** Fired after a type-mode pool change (line and/or zone) has been
   *  flushed. Caller should purge `found` so it only contains ids that
   *  survive both `newEnabledLines` and `newEnabledZones`. */
  onCommitKeep: (
    newEnabledLines: Set<string>,
    newEnabledZones: Set<number>,
  ) => void
  /** Fired after a pool change (line and/or zone) is silently applied (no
   *  active game to warn about). Caller should reseed any pin game so its
   *  order matches the new pool — otherwise the current prompt could point
   *  at a filtered-out station. */
  onPoolChangedSilent: () => void
  /** When true, Done prompts for confirmation before applying mode or pool
   *  changes (used when an in-progress game would be disturbed). When false,
   *  changes apply silently. */
  hasActiveGame: boolean
}) {
  const { LINES } = useConfig()

  // Local drafts so cancelling the restart prompt can genuinely revert without
  // fighting parent state. Mode changes are also drafted so radio clicks don't
  // take effect until the user presses Done.
  const [draftLines, setDraftLines] = useState<Set<string>>(
    () => new Set(enabledLines),
  )
  const [draftZones, setDraftZones] = useState<Set<number>>(
    () => new Set(enabledZones),
  )
  const [draftMode, setDraftMode] = useState<GameMode>(mode)

  // Collapse state for the Lines / Zones filter sections. Default closed
  // to keep the modal compact — the header shows a count summary so the
  // player can see the current selection without expanding.
  const [linesOpen, setLinesOpen] = useState<boolean>(false)
  const [zonesOpen, setZonesOpen] = useState<boolean>(false)

  // Resync drafts to the current committed values each time the modal opens.
  useEffect(() => {
    if (open) {
      setDraftLines(new Set(enabledLines))
      setDraftZones(new Set(enabledZones))
      setDraftMode(mode)
      setLinesOpen(false)
      setZonesOpen(false)
    }
    // We deliberately only resync on open transitions; changes to props while
    // the modal is closed shouldn't wipe an unrelated in-flight draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Family selection derives from draftMode. Clicking a family segment
  // resets draftMode to that family's base variant — losing sub-variant
  // memory across family switches, which keeps state minimal and avoids
  // surprising "your last typeHarder is still selected" moments.
  const draftFamily = getFamily(draftMode)
  const switchFamily = (family: ModeFamily) => {
    if (draftFamily === family) return
    setDraftMode(FAMILY_BASE[family])
  }
  const familyOptions = MODE_OPTIONS.filter(
    (o) => getFamily(o.value) === draftFamily,
  )

  const toggleLine = (key: string) => {
    setDraftLines((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleZone = (zone: number) => {
    setDraftZones((prev) => {
      const next = new Set(prev)
      if (next.has(zone)) next.delete(zone)
      else next.add(zone)
      return next
    })
  }

  const allLineKeys = Object.keys(LINES).sort(
    (a, b) => (LINES[a].order ?? 0) - (LINES[b].order ?? 0),
  )
  const allLinesEnabled = allLineKeys.every((k) => draftLines.has(k))
  const allZonesEnabled = allZones.every((z) => draftZones.has(z))
  const hasZones = allZones.length > 0

  const applyChanges = (
    poolChanged: boolean,
    linesChanged: boolean,
    zonesChanged: boolean,
    modeChanged: boolean,
    action: 'reset' | 'keep' | null,
  ) => {
    if (modeChanged) flushSync(() => setMode(draftMode))
    if (linesChanged) flushSync(() => setEnabledLines(draftLines))
    if (zonesChanged) flushSync(() => setEnabledZones(draftZones))
    // Fire callback AFTER all state has been flushed so PinMode's derived
    // poolIds (and any other pool-dep memos) reflect the new selection.
    if (action === 'reset') onCommitReset()
    else if (action === 'keep') onCommitKeep(draftLines, draftZones)
    else if (poolChanged) onPoolChangedSilent()
  }

  const handleDone = () => {
    const linesChanged = !setsEqual(draftLines, enabledLines)
    const zonesChanged = !setsEqual(draftZones, enabledZones)
    const modeChanged = draftMode !== mode
    const poolChanged = linesChanged || zonesChanged

    if (!poolChanged && !modeChanged) {
      setOpen(false)
      return
    }

    if (!hasActiveGame) {
      // Nothing at stake — commit silently.
      applyChanges(poolChanged, linesChanged, zonesChanged, modeChanged, null)
      setOpen(false)
      return
    }

    // Determine which confirmation copy to show. Mode change trumps
    // simultaneous pool changes.
    let kind: ConfirmKind
    if (modeChanged) kind = 'mode'
    else if (mode !== 'type') kind = 'pool-pin'
    else kind = 'pool-type'

    if (confirm(CONFIRM_MESSAGES[kind])) {
      applyChanges(
        poolChanged,
        linesChanged,
        zonesChanged,
        modeChanged,
        CONFIRM_ACTION[kind],
      )
      setOpen(false)
    } else {
      setDraftLines(new Set(enabledLines))
      setDraftZones(new Set(enabledZones))
      setDraftMode(mode)
    }
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
                  <div
                    role="tablist"
                    aria-label="Game mode family"
                    className="mt-2 flex gap-1 rounded-md border border-gray-200 p-1"
                  >
                    {(['type', 'pin'] as const).map((family) => {
                      const active = draftFamily === family
                      return (
                        <button
                          key={family}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => switchFamily(family)}
                          className={`flex-1 rounded px-3 py-1.5 text-sm font-semibold transition-colors ${
                            active
                              ? 'bg-zinc-700 text-white'
                              : 'text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          {family === 'type' ? 'Type' : 'Pin'}
                        </button>
                      )
                    })}
                  </div>
                  <div className="mt-2 flex flex-col gap-2">
                    {familyOptions.map((opt) => (
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

                <div className="mt-6 rounded-md border border-gray-200">
                  <button
                    type="button"
                    aria-expanded={linesOpen}
                    onClick={() => setLinesOpen((v) => !v)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gray-50"
                  >
                    <span className="text-xs font-bold uppercase tracking-wider text-gray-500">
                      Lines
                    </span>
                    <span className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="tabular-nums">
                        {draftLines.size}/{allLineKeys.length}
                      </span>
                      <span aria-hidden className="text-sm text-gray-500">
                        {linesOpen ? '−' : '+'}
                      </span>
                    </span>
                  </button>
                  {linesOpen && (
                    <div className="border-t border-gray-200 p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-gray-500">
                          Which lines to include in the game.
                        </p>
                        <button
                          type="button"
                          className="text-xs font-medium text-zinc-600 hover:text-zinc-800"
                          onClick={() =>
                            setDraftLines(
                              allLinesEnabled
                                ? new Set()
                                : new Set(allLineKeys),
                            )
                          }
                        >
                          {allLinesEnabled ? 'Deselect all' : 'Select all'}
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {allLineKeys.map((key) => {
                          const line = LINES[key]
                          const on = draftLines.has(key)
                          return (
                            <button
                              key={key}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggleLine(key)}
                              // 1px border on both states so the box is
                              // pixel-identical regardless of selection —
                              // on the selected variant the border matches
                              // the background colour so it reads as
                              // borderless.
                              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                                on ? '' : 'bg-white text-gray-700 hover:bg-gray-50'
                              }`}
                              style={
                                on
                                  ? {
                                      backgroundColor: line.color,
                                      color: line.textColor,
                                      border: `1px solid ${line.color}`,
                                    }
                                  : { border: `1px solid ${line.color}` }
                              }
                            >
                              {line.name}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {hasZones && (
                  <div className="mt-3 rounded-md border border-gray-200">
                    <button
                      type="button"
                      aria-expanded={zonesOpen}
                      onClick={() => setZonesOpen((v) => !v)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gray-50"
                    >
                      <span className="text-xs font-bold uppercase tracking-wider text-gray-500">
                        Zones
                      </span>
                      <span className="flex items-center gap-2 text-xs text-gray-400">
                        <span className="tabular-nums">
                          {draftZones.size}/{allZones.length}
                        </span>
                        <span aria-hidden className="text-sm text-gray-500">
                          {zonesOpen ? '−' : '+'}
                        </span>
                      </span>
                    </button>
                    {zonesOpen && (
                      <div className="border-t border-gray-200 p-3">
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-gray-500">
                            Which zones to include in the game.
                          </p>
                          <button
                            type="button"
                            className="text-xs font-medium text-zinc-600 hover:text-zinc-800"
                            onClick={() =>
                              setDraftZones(
                                allZonesEnabled
                                  ? new Set()
                                  : new Set(allZones),
                              )
                            }
                          >
                            {allZonesEnabled ? 'Deselect all' : 'Select all'}
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {allZones.map((zone) => {
                            const on = draftZones.has(zone)
                            return (
                              <button
                                key={zone}
                                type="button"
                                aria-pressed={on}
                                onClick={() => toggleZone(zone)}
                                // Border present on both states (matching
                                // bg colour on the selected variant) so
                                // the pill size stays fixed on toggle.
                                className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                                  on
                                    ? 'border-zinc-700 bg-zinc-700 text-white'
                                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                                }`}
                              >
                                {zone === 0 ? 'Unzoned' : `Zone ${zone}`}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-6">
                  <button
                    type="button"
                    className="inline-flex w-full justify-center rounded-md bg-zinc-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:hover:bg-zinc-300"
                    onClick={handleDone}
                    disabled={
                      draftLines.size === 0 ||
                      (hasZones && draftZones.size === 0)
                    }
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
