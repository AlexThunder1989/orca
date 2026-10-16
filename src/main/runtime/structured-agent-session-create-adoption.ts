import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import { agentSessionExecutionLocationsEqual } from '../../shared/agent-session-record'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { listStructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import {
  findCommittedStructuredAgentSessionAdoptionReplay,
  findConflictingStructuredAdoption,
  resolveStructuredAgentSessionAdoption,
  structuredAdoptionConflictError
} from '../native-chat/structured-agent-session-history-adoption'
import { structuredAgentRuntimeMetadata } from './structured-agent-runtime-metadata'
import type {
  StructuredAgentTranscriptImport,
  StructuredAgentTranscriptImportSettings
} from '../native-chat/structured-agent-cli-conversations'

export function resolveCommittedStructuredAgentSessionAdoptionIntent(input: {
  host: StructuredAgentSessionHost | null
  envelope: { sessionId: string; clientOperationId: string }
  agent: StructuredAgentId
  callerKey?: string
  resumeFrom?: { providerSessionId: string }
  location: AgentSessionExecutionLocation
  options?: Readonly<Record<string, string>>
}): AgentSessionAttachParams | null {
  const history = structuredAgentRuntimeMetadata(input.agent)?.sessionHistory
  const replay =
    input.resumeFrom && input.callerKey && input.host && history
      ? findCommittedStructuredAgentSessionAdoptionReplay({
          agent: input.agent,
          providerSessionId: input.resumeFrom.providerSessionId,
          rowSessionId: history.rowSessionId,
          selfSessionId: input.envelope.sessionId,
          callerKey: input.callerKey,
          operationId: input.envelope.clientOperationId,
          record: input.host.deps.store.getRecord(input.envelope.sessionId),
          operations: input.host.deps.store.listOperationRows()
        })
      : null
  if (!replay || !agentSessionExecutionLocationsEqual(replay.record.location, input.location)) {
    return null
  }
  return {
    envelope: {
      sessionId: input.envelope.sessionId,
      clientOperationId: input.envelope.clientOperationId,
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: input.location,
    provider: input.agent,
    agent: input.agent,
    accountHome: replay.record.accountHome,
    ...(input.options ? { options: input.options } : {}),
    adopt: { providerHandle: replay.providerHandle },
    runtimeKind: 'native'
  }
}

export async function resolveStructuredAgentSessionAdoptionForCreate(input: {
  host: StructuredAgentSessionHost | null
  settings: StructuredAgentTranscriptImportSettings
  agent: StructuredAgentId
  /** The agent's registered importer; only an agent with one adopts. */
  transcriptImport: StructuredAgentTranscriptImport
  providerSessionId: string
  selfSessionId: string
  selectedAccountHome: AgentSessionAccountHome
  launchEnv: NodeJS.ProcessEnv
  workspaceCwd: string
}) {
  const conflict = input.host
    ? findConflictingStructuredAdoption({
        agent: input.agent,
        providerSessionId: input.providerSessionId,
        selfSessionId: input.selfSessionId,
        ownership: listStructuredProviderSessionOwnership(input.host.deps.store.listRecords())
      })
    : null
  if (conflict) {
    throw structuredAdoptionConflictError(conflict)
  }
  return resolveStructuredAgentSessionAdoption({
    providerSessionId: input.providerSessionId,
    candidateAccountHomes: input.transcriptImport.accountHomeCandidates(input),
    resolveTranscript: input.transcriptImport.findTranscript,
    launchEnv: input.launchEnv,
    workspaceCwd: input.workspaceCwd
  })
}
