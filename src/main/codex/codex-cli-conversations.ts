import { join } from 'node:path'
import { configuredAdditionalCodexHomePaths } from '../ai-vault/cached-session-list'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  directoryTranscriptImport,
  resumeInvocationAfterMarker,
  type StructuredAgentCliConversations,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'

const CODEX_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  accountHomeCandidates: ({ settings, selectedAccountHomePath }) => [
    selectedAccountHomePath,
    ...(settings.codexManagedAccounts ?? []).map((account) => account.managedHomePath),
    ...configuredAdditionalCodexHomePaths(),
    getOrcaManagedCodexHomePath(),
    getSystemCodexHomePath()
  ],
  findTranscript: ({ providerSessionId, accountHomePath }) =>
    resolveSessionFilePath('codex', providerSessionId, {
      codexSessionsDirs: [join(accountHomePath, 'sessions')]
    })
})

const CODEX_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['codex'],
  rowSessionId: (link) => link.handle.nativeId,
  // `codex fork` carries no `resume` marker, and Codex has no target-less resume flag.
  parseResumeArgs: (args) => resumeInvocationAfterMarker(args, ['resume'])
}

export const CODEX_CLI_CONVERSATIONS: StructuredAgentCliConversations = {
  transcriptImport: CODEX_TRANSCRIPT_IMPORT,
  sessionHistory: CODEX_SESSION_HISTORY
}
