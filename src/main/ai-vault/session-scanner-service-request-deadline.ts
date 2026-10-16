import type { AiVaultServicePendingCall } from './session-scanner-service-client-state'
import type { AiVaultServiceRequest } from './session-scanner-service-protocol'
import type { AiVaultScanWork } from '../../shared/ai-vault-scan-progress'

/** No-progress window: a scan whose work keeps advancing re-arms it, however long it runs. */
export const AI_VAULT_SERVICE_SCAN_TIMEOUT_MS = 130_000
export const AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS = 15_000

/** The named call exhausted its deadline; a shared child fault may reject other calls too. */
export class AiVaultServiceDeadlineError extends Error {
  constructor(
    message: string,
    readonly operation: AiVaultServiceRequest['operation'],
    readonly requestId: number
  ) {
    super(message)
  }
}

/** Follows one scan request: when the child received it, and each report of its work. */
export type AiVaultServiceScanListener = {
  sent: (requestId: number) => void
  work: (work: AiVaultScanWork) => void
}

function armAiVaultServiceRequestDeadline(
  call: AiVaultServicePendingCall,
  onTimeout: (error: Error) => void
): void {
  const timeoutMs =
    call.request.operation === 'scan'
      ? AI_VAULT_SERVICE_SCAN_TIMEOUT_MS
      : AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS
  if (call.timer) {
    clearTimeout(call.timer)
  }
  // Same text for both meanings: remote clients humanize it, so a new wording
  // would reach older ones as "stopped unexpectedly".
  call.timer = setTimeout(() => {
    onTimeout(
      new AiVaultServiceDeadlineError(
        `AI Vault service timed out after ${timeoutMs}ms.`,
        call.request.operation,
        call.request.id
      )
    )
  }, timeoutMs)
  call.timer.unref?.()
}

/** Starts the request deadline only once the child is ready to receive it. */
export function sendAiVaultServiceCall(
  // Only the send this needs, so the module stays off the direct child_process import list.
  child: { send(request: AiVaultServiceRequest): unknown },
  call: AiVaultServicePendingCall,
  isActive: () => boolean,
  onTimeout: (error: Error) => void
): void {
  if (call.cancelled || !isActive()) {
    return
  }
  armAiVaultServiceRequestDeadline(call, onTimeout)
  call.sent = true
  call.scanListener?.sent(call.request.id)
  child.send(call.request)
}

/**
 * Restarts a running scan's no-progress window when its counter advanced.
 * A cancelled call keeps its two-second acknowledgement bound, and interactive
 * calls keep their fixed one, so only a live scan's own work can extend it.
 */
export function noteAiVaultServiceScanProgress(
  call: AiVaultServicePendingCall,
  progress: { units: number; work?: AiVaultScanWork },
  onTimeout: (error: Error) => void
): void {
  if (call.cancelled || !call.sent || call.request.operation !== 'scan') {
    return
  }
  if (progress.work) {
    call.scanListener?.work(progress.work)
  }
  if (progress.units <= call.progressUnits) {
    return
  }
  call.progressUnits = progress.units
  armAiVaultServiceRequestDeadline(call, onTimeout)
}
