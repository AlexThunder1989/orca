import type {
  LayoutApplyOutcome,
  LayoutCommand
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  resolveHostId,
  type SessionHostPartitionOperations
} from '../loading-store/session-host-partitions'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { applyLayout, topologyCommitContext } from './terminal-topology-commit'

type LayoutCommandRuntime = Pick<
  StoreRuntimeState,
  'runDurableMutation' | 'state' | 'dirtyProfileStateDomains'
>

const layoutCommandPersistenceContext = Symbol('LayoutCommandPersistence')
type LayoutCommandPersistenceContext = {
  runtime: LayoutCommandRuntime
  sessions: SessionHostPartitionOperations
}

/** The Store's half of `layout.apply`; the commit module owns the write. */
export class LayoutCommandPersistence {
  readonly [layoutCommandPersistenceContext]: LayoutCommandPersistenceContext

  constructor(runtime: LayoutCommandRuntime, sessions: SessionHostPartitionOperations) {
    this[layoutCommandPersistenceContext] = { runtime, sessions }
  }

  /** Applies to each partition holding the command's tab, routed partition first (local if none). */
  applyLayoutCommand(
    command: LayoutCommand,
    hostIds: readonly string[] = []
  ): Promise<LayoutApplyOutcome> {
    const context = this[layoutCommandPersistenceContext]
    const resolved = hostIds.length > 0 ? hostIds.map(resolveHostId) : [resolveHostId()]
    return context.runtime.runDurableMutation(
      applyLayout(resolved, command, topologyCommitContext(context))
    )
  }
}
