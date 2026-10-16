// Whether this window owes main a session write: one is scheduled or not yet acknowledged. Fed by
// the session write subscriber in a layout-owner build only; layout frames wait while it is busy,
// so a frame never replaces a change main has not received yet.

let busy = false
let idleListener: (() => void) | null = null

export function reportWindowSessionWriteActivity(nextBusy: boolean): void {
  if (busy === nextBusy) {
    return
  }
  busy = nextBusy
  if (!busy) {
    idleListener?.()
  }
}

export function isWindowSessionWriteBusy(): boolean {
  return busy
}

/** The one listener: the window's layout frame sync. */
export function onWindowSessionWriteIdle(listener: () => void): () => void {
  idleListener = listener
  return () => {
    if (idleListener === listener) {
      idleListener = null
    }
  }
}
