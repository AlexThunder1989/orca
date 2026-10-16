// The read-only layout stream behind `layout.subscribe`: each workspace's published layout,
// re-projected from the Store's sessions after every write while anyone subscribes. A write that
// names its partition re-projects only that partition. Each pane's live terminal title is laid
// over the cached projection, so a title change costs no projection. Nothing reads it until a
// client opts in; with no subscriber it does no work.

import type { ExecutionHostId } from '../../shared/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayoutEvent } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeStore } from './runtime-store-contract'

type LayoutListener = (event: WorkspaceLayoutEvent) => void

type Published = { layout: PublishedWorkspaceLayout; json: string }

/** What a workspace was last sent as: its projection's JSON and its panes' live titles. */
type Shown = { json: string; liveTitles: string; layout: PublishedWorkspaceLayout }

type StreamStore = Pick<
  RuntimeStore,
  'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'onWorkspaceSessionWritten'
>

export class WorkspaceLayoutStream {
  private readonly listeners = new Set<LayoutListener>()
  /** Workspace key → its published layout, with its JSON for the by-value comparison. */
  private published = new Map<string, Published>()
  /** Workspace key → what listeners last received for it, live titles included. */
  private shown = new Map<string, Shown>()
  /** Partition → every workspace it holds, its own copy of a workspace it does not own included. */
  private projectedPartitions = new Map<ExecutionHostId, Map<string, Published>>()
  private stopWatching: (() => void) | null = null
  /** Partitions to re-project at the next flush; 'all' when a write did not name its partition. */
  private dirty: Set<ExecutionHostId> | 'all' | null = null
  private liveTitlesDirty = false
  private failureLogged = false

  constructor(
    private readonly deps: {
      store: () => StreamStore | null
      /** The partition that owns a workspace key; null when none does. */
      homeHostId: (key: string) => ExecutionHostId | null
      /** The title a terminal shows now; null when it has none. */
      liveTitle: (ptyId: string) => string | null
    }
  ) {}

  /** Every workspace's layout now, then each change until `unsubscribe`. */
  subscribe(listener: LayoutListener): {
    snapshot: { key: string; layout: PublishedWorkspaceLayout }[]
    unsubscribe: () => void
  } {
    if (this.listeners.size === 0) {
      this.stopWatching =
        this.deps.store()?.onWorkspaceSessionWritten?.((hostId) => this.markDirty(hostId)) ?? null
      this.published = new Map()
      this.shown = new Map()
      this.projectedPartitions = new Map()
      this.dirty = 'all'
    }
    // A change not yet published reaches existing listeners first, so the snapshot is current.
    this.flush()
    this.listeners.add(listener)
    const snapshot = [...this.shown].map(([key, { layout }]) => ({ key, layout }))
    return {
      snapshot,
      unsubscribe: () => {
        if (!this.listeners.delete(listener) || this.listeners.size > 0) {
          return
        }
        this.stopWatching?.()
        this.stopWatching = null
        // A flush already queued finds nothing to do.
        this.dirty = null
        this.liveTitlesDirty = false
        this.published.clear()
        this.shown.clear()
        this.projectedPartitions.clear()
      }
    }
  }

  /** Some terminal's title may have changed; republishes only the panes whose title did. */
  markLiveTitlesDirty(): void {
    if (this.listeners.size === 0) {
      return
    }
    this.schedule()
    this.liveTitlesDirty = true
  }

  private schedule(): void {
    if (this.dirty === null && !this.liveTitlesDirty) {
      // Coalesces a burst of writes and title changes in one task into one flush.
      queueMicrotask(() => this.flush())
    }
  }

  private markDirty(hostId: ExecutionHostId | null): void {
    this.schedule()
    if (hostId === null) {
      this.dirty = 'all'
    } else if (this.dirty === null) {
      this.dirty = new Set([hostId])
    } else if (this.dirty !== 'all') {
      this.dirty.add(hostId)
    }
  }

  private flush(): void {
    const dirty = this.dirty
    if (dirty === null && !this.liveTitlesDirty) {
      return
    }
    this.dirty = null
    this.liveTitlesDirty = false
    // A failed projection is logged once; it never reaches the write that notified it.
    try {
      this.reconcile(dirty)
    } catch (error) {
      // The cache may be part-updated; the next write re-projects every partition.
      this.projectedPartitions.clear()
      this.logFailure('projection', error)
    }
  }

  private logFailure(what: string, error: unknown): void {
    if (!this.failureLogged) {
      this.failureLogged = true
      console.warn(`[workspace-layout] layout stream ${what} failed:`, error)
    }
  }

  private projectPartition(hostId: ExecutionHostId): Map<string, Published> {
    const projected = new Map<string, Published>()
    const session = this.deps.store()?.getWorkspaceSession?.(hostId)
    if (!session) {
      return projected
    }
    const { layout } = loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
    for (const [key, workspace] of Object.entries(layout.workspaces)) {
      const published = publishWorkspaceLayout(workspace, hostId)
      projected.set(key, { layout: published, json: stableJson(published) })
    }
    return projected
  }

  private project(dirty: Set<ExecutionHostId> | 'all'): Map<string, Published> {
    const hostIds = this.deps.store()?.getWorkspaceSessionHostIds?.() ?? []
    const partitions = new Map<ExecutionHostId, Map<string, Published>>()
    for (const hostId of hostIds) {
      const cached =
        dirty === 'all' || dirty.has(hostId) ? undefined : this.projectedPartitions.get(hostId)
      partitions.set(hostId, cached ?? this.projectPartition(hostId))
    }
    this.projectedPartitions = partitions
    const projected = new Map<string, Published>()
    for (const [hostId, workspaces] of partitions) {
      for (const [key, workspace] of workspaces) {
        // Only the owning partition's copy is published; a stray copy elsewhere is not shown.
        if (this.deps.homeHostId(key) === hostId) {
          projected.set(key, workspace)
        }
      }
    }
    return projected
  }

  /** Every pane's live title, in tab and pane order; null for a pane with none. */
  private liveTitlesOf(layout: PublishedWorkspaceLayout): (string | null)[] {
    return layout.tabs.flatMap((tab) =>
      (tab.terminal?.panes ?? []).map((pane) =>
        pane.ptyId ? this.deps.liveTitle(pane.ptyId) : null
      )
    )
  }

  private reconcile(dirty: Set<ExecutionHostId> | 'all' | null): void {
    const next = dirty === null ? this.published : this.project(dirty)
    const events: WorkspaceLayoutEvent[] = []
    for (const key of this.shown.keys()) {
      if (!next.has(key)) {
        events.push({ type: 'removed', key })
      }
    }
    const shown = new Map<string, Shown>()
    for (const [key, { layout, json }] of next) {
      const titles = this.liveTitlesOf(layout)
      const liveTitles = JSON.stringify(titles)
      const previous = this.shown.get(key)
      if (previous?.json === json && previous.liveTitles === liveTitles) {
        shown.set(key, previous)
        continue
      }
      const withTitles = withLiveTitles(layout, titles)
      shown.set(key, { json, liveTitles, layout: withTitles })
      events.push({ type: 'workspace', key, layout: withTitles })
    }
    this.published = next
    this.shown = shown
    for (const event of events) {
      for (const listener of this.listeners) {
        // One failing listener must not cost the others an event the stream has now published.
        try {
          listener(event)
        } catch (error) {
          this.logFailure('listener', error)
        }
      }
    }
  }
}

function withLiveTitles(
  layout: PublishedWorkspaceLayout,
  titles: (string | null)[]
): PublishedWorkspaceLayout {
  if (titles.every((title) => title === null)) {
    return layout
  }
  let index = 0
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.terminal
        ? {
            ...tab,
            terminal: {
              ...tab.terminal,
              panes: tab.terminal.panes.map((pane) => {
                const liveTitle = titles[index++]
                return liveTitle === null ? pane : { ...pane, liveTitle }
              })
            }
          }
        : tab
    )
  }
}
