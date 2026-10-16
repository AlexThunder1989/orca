import { parseExecutionHostId } from '../../../shared/execution-host'
import { assertOpenCodeCopyUsesLocalStore } from '../../../shared/opencode-launch-command'
import { findOptionOccurrence } from '../../../shared/command-option-occurrence'
import {
  getTuiAgentLaunchCommand,
  TUI_AGENT_CONFIG,
  isTuiAgent
} from '../../../shared/tui-agent-config'
import {
  tokenizeStartupCommand,
  resolveStartupShell,
  quoteStartupArg
} from '../../../shared/tui-agent-startup-shell'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import { normalizeAiVaultResumeFilePath } from '../../../shared/ai-vault-resume-path'
import { isResumableTuiAgent } from '../../../shared/agent-session-resume'
import {
  buildAiVaultResumeShellCommand,
  realHomeCodexResumeEnvDeletion
} from '../../../shared/ai-vault-resume-command'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import {
  getAiVaultAgentProviderSession,
  buildAiVaultResumeStartupForWorktree,
  resolveAiVaultResumeHost,
  type AiVaultResumeStartup,
  type AiVaultResumeWorktreeArgs
} from '@/lib/ai-vault-resume-command'

/**
 * A terminal session that starts from a copy of a conversation a native chat owns.
 *
 * Null when the agent cannot fork: a plain resume in its place would make the terminal a second
 * writer on the chat's conversation. No `providerSession` either: the copy gets its own id, and a
 * cold restore of this tab must never re-enter the chat's conversation.
 */
export function buildAiVaultForkStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup | null {
  const { session, state } = args
  const { platform, codexHome, liveShell } = resolveAiVaultResumeHost(args)
  const providerSession = getAiVaultAgentProviderSession({
    ...session,
    filePath: normalizeAiVaultResumeFilePath(session.filePath, platform)
  })
  if (!providerSession || !isResumableTuiAgent(session.agent)) {
    return null
  }
  const plan = buildAgentResumeStartupPlan({
    agent: session.agent,
    providerSession,
    cmdOverrides: {
      ...state.settings?.agentCmdOverrides,
      ...(args.commandOverride?.trim() ? { [session.agent]: args.commandOverride } : {})
    },
    platform,
    shell: liveShell,
    agentArgs: resolveTuiAgentLaunchArgs(session.agent, state.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(session.agent, state.settings?.agentDefaultEnv),
    resumeInLaunchCwd: true,
    fork: true
  })
  if (!plan) {
    return null
  }
  return {
    command: buildAiVaultResumeShellCommand({
      resumeCommand: plan.launchCommand,
      cwd: null,
      platform,
      codexHome,
      shell: liveShell
    }),
    ...(plan.env ? { env: plan.env } : {}),
    ...realHomeCodexResumeEnvDeletion(session),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    launchConfig: plan.launchConfig
  }
}

/** Keeps the history row's launch mode while the copied conversation opens with its actual CLI. */
export function buildAiVaultCopiedSessionStartupForWorktree(
  args: AiVaultResumeWorktreeArgs,
  sourceAgent: AiVaultAgent
): AiVaultResumeStartup {
  const { platform, liveShell } = resolveAiVaultResumeHost(args)
  const shell = resolveStartupShell(platform, liveShell)
  const configuredArgs = isTuiAgent(args.session.agent)
    ? resolveTuiAgentLaunchArgs(args.session.agent, args.state.settings?.agentDefaultArgs)
    : ''
  const configured = tokenizeStartupCommand(configuredArgs, shell)
  if (!configured.ok) {
    throw new Error('This session cannot be opened in the CLI.')
  }
  const commandOverride =
    args.commandOverride?.trim() ||
    args.state.settings?.agentCmdOverrides?.[args.session.agent]?.trim()
  const mode =
    sourceAgent !== args.session.agent &&
    isTuiAgent(sourceAgent) &&
    !commandOverride &&
    !findOptionOccurrence(configured.tokens, ['--standalone'], true)
      ? tokenizeStartupCommand(
          getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[sourceAgent], platform),
          shell
        )
      : null
  if (mode && !mode.ok) {
    throw new Error('This session cannot be opened in the CLI.')
  }
  const agentArgs = [
    mode?.ok
      ? mode.tokens
          .slice(1)
          .map((token) => quoteStartupArg(token, shell))
          .join(' ')
      : '',
    configuredArgs
  ]
    .filter(Boolean)
    .join(' ')
  return {
    ...buildAiVaultResumeStartupForWorktree({ ...args, agentArgs }),
    agent: args.session.agent
  }
}

/** Runtime hosts validate their own launch settings when making the copy. */
export function assertAiVaultCopiedSessionLaunchAllowed(args: AiVaultResumeWorktreeArgs): void {
  if (args.session.agent !== 'opencode' && args.session.agent !== 'opencode2') {
    return
  }
  if (parseExecutionHostId(args.session.executionHostId)?.kind === 'runtime') {
    return
  }
  const { platform, liveShell } = resolveAiVaultResumeHost(args)
  const command =
    args.commandOverride?.trim() ||
    args.state.settings?.agentCmdOverrides?.opencode ||
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG.opencode, platform)
  const parsed = tokenizeStartupCommand(
    `${command} ${resolveTuiAgentLaunchArgs('opencode', args.state.settings?.agentDefaultArgs)}`,
    resolveStartupShell(platform, liveShell)
  )
  if (!parsed.ok) {
    throw new Error('This session cannot be opened in the CLI.')
  }
  assertOpenCodeCopyUsesLocalStore(parsed.tokens.slice(1))
}
