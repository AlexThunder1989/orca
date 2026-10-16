// What a start checks on this host before it spawns the agent. A runtime Orca manages is installed
// only when the person asks, so a start that finds no copy refuses rather than downloading one.

import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

/** The launch a start spawns; `closedBeforeSpawn` throws once the start was abandoned. */
export async function prepareAcpStructuredLaunch(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'spec' | 'resolveLaunch'>,
  acquire: Pick<StructuredAgentSessionAcquireInput, 'identity' | 'spawnToken'>,
  closedBeforeSpawn: () => void
): Promise<AcpStructuredLaunch> {
  const { spec } = deps
  const launch = await deps
    .resolveLaunch({ identity: acquire.identity, spawnToken: acquire.spawnToken })
    .catch((error: unknown) => {
      throw new AgentSessionPreSpawnError(error)
    })
  closedBeforeSpawn()
  // A missed lookup returns the bare name; a selected Command setting resolves or refuses.
  if (spec.managedRuntime && launch.command === spec.command) {
    throw new AgentSessionPreSpawnError(
      new Error(`${spec.managedRuntime.label} is not installed on this host`),
      { reason: 'runtimeNotInstalled' }
    )
  }
  return launch
}
