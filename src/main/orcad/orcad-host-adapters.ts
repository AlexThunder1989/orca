/** The Node host's stand-ins for Electron's app environment and secret store. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { ORCAD_CLI_PACKAGE_FILENAME } from '../../shared/orcad-artifacts'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { setSecretStore, type SecretStore } from '../../shared/secret-store'
import { resolveOrcadInstallRoot, resolveOrcadPath } from './orcad-app-paths'
import { getOrcadCliLauncherPath } from './orcad-cli-launcher'
import { describeOrcadSecretProtectionGap } from './orcad-secret-protection-gap'

let quitRegisteredHandlers = (): void => {}

export function runOrcadQuitHandlers(): void {
  quitRegisteredHandlers()
}

function createNodeAppEnvironment(): AppEnvironment {
  const quitHandlers: (() => void)[] = []
  // The main signal handler awaits runtime and browser teardown before process.exit.
  // Keep will-quit callbacks synchronous, but never let them pre-empt that async barrier.
  quitRegisteredHandlers = (): void => {
    const errors: unknown[] = []
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }
    // Why throw: a quit handler that failed may leave a writer running, which keeps the lock.
    if (errors.length > 0) {
      throw new AggregateError(errors, 'orcad_quit_handlers_failed')
    }
  }
  return {
    getPath: resolveOrcadPath,
    getAppPath: () => resolveOrcadInstallRoot(),
    getVersion: () => process.env.ORCA_VERSION ?? '0.0.0-orcad',
    // Why still true: consumers read this as "production build, not a dev checkout" —
    // it gates HTTPS-only skill downloads, the real CLI command name, and shell-PATH
    // hydration. Answering false to satisfy a path resolver would relax a security
    // posture. Layout questions must ask whether the app root is an asar archive
    // instead (see parcel-watcher-entry-path.ts).
    isPackaged: () => true,
    getCliLauncherPath: getOrcadCliLauncherPath,
    onWillQuit: (handler) => quitHandlers.push(handler),
    exit: (code = 0) => process.exit(code),
    // Why []: there are no Chromium processes on this host to measure.
    getAppMetrics: () => []
  }
}

/**
 * Why not silently plaintext: `isEncryptionAvailable() === false` already makes every
 * caller fall back to unsealed storage, which is a security posture, not a detail.
 * `describeProtectionGap()` gives the reason a client can surface.
 */
function createNodeSecretStore(): SecretStore {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    decryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    describeProtectionGap: () => describeOrcadSecretProtectionGap(process.platform)
  }
}

/**
 * The Orca release this server was built from, stamped into the bundle's own `out/package.json`.
 * Why: `status.get` and the updater report ORCA_APP_VERSION, which only the desktop's preflight
 * sets, so a server read `0.0.0-dev`. The bundle wins over an inherited value from another build.
 */
export function stampOrcadAppVersion(installRoot: () => string = resolveOrcadInstallRoot): void {
  let version: unknown
  try {
    const path = join(installRoot(), ...ORCAD_CLI_PACKAGE_FILENAME.split('/'))
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    version = parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : null
  } catch {
    return
  }
  if (typeof version === 'string' && version.length > 0) {
    process.env.ORCA_APP_VERSION = version
  }
}

export function installOrcadHostAdapters(): void {
  stampOrcadAppVersion()
  setAppEnvironment(createNodeAppEnvironment())
  setSecretStore(createNodeSecretStore())
}
