import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import type { StructuredAgentTranscriptImport } from '../native-chat/structured-agent-cli-conversations'
import { resolveOpenCodeDatabasePath } from './opencode-data-directory'
import { environmentForStructuredOpenCodeAccountHome } from './opencode-structured-account-home'

export const OPENCODE_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport = {
  // The selected account, then the unmanaged environment this chat would launch with.
  accountHomeCandidates: ({ selectedAccountHome }) => [
    selectedAccountHome,
    { kind: 'opencode', locator: { kind: 'unmanaged' } }
  ],
  // The database the account's OpenCode opens, which is the only one its chat can load from.
  findTranscript: async ({ providerSessionId, accountHome, launchEnv }) => {
    if (isLegacyAgentSessionAccountHome(accountHome)) {
      return null
    }
    const env = environmentForStructuredOpenCodeAccountHome(accountHome, {
      managedAccounts: getManagedDataAccountService(),
      baseEnvironment: launchEnv
    })
    const dbPath = resolveOpenCodeDatabasePath(
      env,
      (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
    )
    if (!dbPath || !existsSync(dbPath)) {
      return null
    }
    const { readOpenCodeTranscriptSignalViaWorker } =
      await import('../ai-vault/session-scanner-opencode-sqlite-worker-spawn')
    const signal = await readOpenCodeTranscriptSignalViaWorker({
      dbPath,
      sessionId: providerSessionId
    })
    return signal ? dbPath : null
  }
}
