import { PinProgress, PinStationState } from './types'

export const PIN_STATE_POINTS: Record<PinStationState, number> = {
  first: 3,
  second: 2,
  third: 1,
  missed: 0,
}

/**
 * Score as a proportion (0-1) of the maximum achievable on the stations played
 * so far. Each played station contributes its point value; the denominator is
 * 3 × played (i.e. everything on first-guess = 1.0).
 */
export function computePinScoreProportion(
  progress: PinProgress | null | undefined,
): number {
  if (!progress) return 0
  let sum = 0
  let played = 0
  for (const s of Object.values(progress.stationStates)) {
    sum += PIN_STATE_POINTS[s]
    played++
  }
  return played === 0 ? 0 : sum / (3 * played)
}

/**
 * True if the player has meaningfully started the current game and not yet
 * finished it. A fresh game (no resolutions, no wrong clicks on the first
 * prompt) does not count, and a completed round does not either.
 */
export function isPinGameInProgress(
  progress: PinProgress | null | undefined,
): boolean {
  if (!progress) return false
  if (progress.currentIdx >= progress.order.length) return false
  return progress.currentIdx > 0 || progress.attemptsForCurrent > 0
}

/**
 * True if the player has any recorded progress at all — either a game in
 * progress, or a completed round whose score would be wiped by a reset.
 * Used to decide when settings changes should prompt for confirmation.
 */
export function hasPinProgress(
  progress: PinProgress | null | undefined,
): boolean {
  if (!progress) return false
  if (progress.attemptsForCurrent > 0) return true
  return Object.keys(progress.stationStates).length > 0
}
