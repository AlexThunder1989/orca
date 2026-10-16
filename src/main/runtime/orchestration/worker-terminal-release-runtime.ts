import type { OrcaRuntimeService } from '../orca-runtime'

export type WorkerTerminalReleaseRuntime = Pick<
  OrcaRuntimeService,
  | 'retireStructuredAgentSessionTabFromSnapshot'
  | 'forgetStructuredSessionMail'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
  | 'getOrchestrationFleetAgentStatusSnapshot'
  | 'getOrchestrationDb'
  | 'showTerminal'
  | 'resolveTerminalHandleByProcessIncarnation'
  | 'getTerminalPaneKey'
  | 'getTerminalProcessIncarnation'
  | 'getTerminalLivenessVerdict'
  | 'getOrchestrationDispatchAuthority'
  | 'ensureStructuredAgentSessionHost'
  | 'inspectTerminalProcessIncarnationLiveness'
  | 'closeTerminal'
  | 'getExactWorkerProviderSession'
  | 'readTerminal'
  | 'notifyMessageArrived'
>
