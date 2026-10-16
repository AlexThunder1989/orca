/**
 * Writes a move's record through every phase up to its own, as the journal requires, starting
 * after the phase already on disk so a test can also advance an existing move.
 */
import {
  WSL_MOVE_CUTOVER_PHASES,
  type WslMoveCutover
} from '../../../../shared/wsl-move/wsl-move-cutover'
import {
  listWslMoveCutovers,
  writeWslMoveCutover
} from '../../moving-wsl-projects/wsl-move-cutover-journal'

export function seedWslMoveCutover(userDataPath: string, cutover: WslMoveCutover): void {
  const existing = listWslMoveCutovers(userDataPath).find(
    (entry) => entry.migrationId === cutover.migrationId
  )
  const from = existing ? WSL_MOVE_CUTOVER_PHASES.indexOf(existing.phase) + 1 : 0
  const to = WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase)
  for (const phase of WSL_MOVE_CUTOVER_PHASES.slice(from, to + 1)) {
    writeWslMoveCutover(userDataPath, { ...cutover, phase })
  }
}
