/**
 * Which directory a POSIX host's orcad state hangs off when several machines share one `$HOME`
 * (an NFS home across a cluster) (#29059).
 *
 * Everything orcad keeps on a host — install slots, the PID and readiness files, activation
 * record, locks, runtime store and data root — names one machine's processes, and a PID is only
 * evidence on the machine that issued it. So the first machine to claim a home keeps the login
 * home's `~/.orca-remote` and `~/.orca` unchanged (no migration for single-machine installs); any
 * other machine gets a complete tree of its own under `~/.orca-remote/hosts/<key>/`. Even the
 * immutable install stays per machine: the runtime store's GC judges "in use" from processes it
 * can see, so a store shared across machines could be collected under another machine's server.
 */
import { createHash, randomUUID } from 'node:crypto'
import { shellEscape } from './ssh-connection-utils'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  joinRemotePath,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from './ssh-remote-platform'

/** Under `~/.orca-remote`: names the one machine that owns the login home's orcad state. */
export const ORCAD_MACHINE_CLAIM_FILENAME = 'orcad-machine.json'
/** Under `~/.orca-remote`: one orcad home per other machine sharing this `$HOME`. */
export const ORCAD_MACHINE_HOMES_DIRNAME = 'hosts'
export const ORCAD_MACHINE_CLAIM_SCHEMA_VERSION = 1

const SECTION = '__ORCA_MACHINE_HOME_SECTION__'
const CLAIM_ABSENT = 'ABSENT'
const CLAIM_PRESENT = 'PRESENT'
const RECORD_MAX_BYTES = 4096
const ACCESS_ROOT = '.orca/.profile-state-access'

export type OrcadMachineIdentity = {
  /** Short, path-safe hash; the raw identity never lands on disk. */
  key: string
  /** What the data root's profile-state owners record, to recognise another machine's. */
  machineIdentity: string
  hostname: string | null
}

export type OrcadMachineClaimRead =
  | { state: 'absent' }
  | { state: 'present'; machineKey: string }
  | { state: 'unreadable'; reason: string }

export type OrcadMachineHomeProbe = {
  loginHome: string
  identity: OrcadMachineIdentity | null
  claim: OrcadMachineClaimRead
  /** Profile-state owners (live orcads, or crashed ones) in the login home's data root. */
  dataRootOwners: readonly {
    host: string | null
    machineIdentity: string | null
  }[]
  /** Keys that already have a machine home under `~/.orca-remote/hosts/`. */
  machineHomeKeys: readonly string[]
}

export type OrcadMachineHomeDecision =
  | { kind: 'login-home' }
  | { kind: 'claim'; machineKey: string }
  | { kind: 'machine-home'; machineKey: string }

/**
 * Reads the login home, this machine's identity, the claim, and who holds the shared data root,
 * in one exec. Identity sources match `profile-state-access-identity.ts`, so the two agree.
 */
export function orcadMachineHomeProbeCommand(host: RemoteHostPlatform): string {
  const claim = `"$HOME"/${shellEscape(`${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_CLAIM_FILENAME}`)}`
  const access = `"$HOME"/${shellEscape(ACCESS_ROOT)}`
  const homes = `"$HOME"/${shellEscape(`${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_HOMES_DIRNAME}`)}`
  return [
    `printf '%s\\n' "$HOME"; echo ${SECTION};`,
    host.os === 'darwin'
      ? 'sysctl -n kern.hostuuid 2>/dev/null;'
      : 'cat /etc/machine-id 2>/dev/null;',
    `echo; echo ${SECTION}; uname -n 2>/dev/null; echo; echo ${SECTION};`,
    // An empty claim is one a full disk cut short; the claim command replaces it.
    `if { [ ! -e ${claim} ] && [ ! -L ${claim} ]; } || { [ -f ${claim} ] && [ ! -s ${claim} ]; };`,
    `then echo ${CLAIM_ABSENT};`,
    `elif [ -f ${claim} ]; then echo ${CLAIM_PRESENT}; head -c ${RECORD_MAX_BYTES} ${claim}; echo;`,
    `else echo UNREADABLE; fi; echo ${SECTION};`,
    `for f in ${access}/participants/*/*.owner ${access}/maintenance/*.owner; do`,
    `[ -f "$f" ] && { head -c ${RECORD_MAX_BYTES} "$f"; echo; }; done; echo ${SECTION};`,
    `ls -1 ${homes} 2>/dev/null; true`
  ].join(' ')
}

export function parseOrcadMachineHomeProbe(
  output: string,
  host: RemoteHostPlatform
): OrcadMachineHomeProbe {
  const sections = output.split(new RegExp(`^${SECTION}$`, 'mu'))
  if (sections.length !== 6) {
    throw new Error('orcad machine-home probe returned no verifiable answer')
  }
  const [homeRaw, machineRaw, hostnameRaw, claimRaw, ownersRaw, homesRaw] = sections
  const loginHome = normalizeRemoteHome(homeRaw, host)
  if (!validateRemoteHome(loginHome, host)) {
    throw new Error(`Remote home is not a valid path: ${loginHome.slice(0, 100)}`)
  }
  return {
    loginHome,
    identity: orcadMachineIdentity(host, machineRaw.trim(), hostnameRaw.trim()),
    claim: parseClaimSection(claimRaw.trim()),
    dataRootOwners: ownersRaw
      .split('\n')
      .map((line) => parseOwnerLine(line.trim()))
      .filter((owner) => owner !== null),
    machineHomeKeys: homesRaw
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => /^[a-f0-9]{16}$/u.test(name))
  }
}

/**
 * The same machine identity the profile-state owners record: `/etc/machine-id` on Linux, the
 * hardware UUID on macOS. Neither changes when the host is renamed or a container is recreated
 * over a persistent home. A host without one keeps the login home, as before (#29059).
 */
export function orcadMachineIdentity(
  host: RemoteHostPlatform,
  machineRaw: string,
  hostnameRaw: string
): OrcadMachineIdentity | null {
  const machineIdentity =
    host.os === 'darwin'
      ? /^[0-9A-Fa-f-]{36}$/u.test(machineRaw)
        ? machineRaw.toLowerCase()
        : null
      : /^[a-f0-9]{32}$/u.test(machineRaw) && !/^0+$/u.test(machineRaw)
        ? machineRaw
        : null
  if (!machineIdentity) {
    return null
  }
  const key = createHash('sha256')
    .update(`${host.os}:${machineIdentity}`)
    .digest('hex')
    .slice(0, 16)
  const hostname = /^[\x21-\x7e]{1,255}$/u.test(hostnameRaw) ? hostnameRaw : null
  return { key, machineIdentity, hostname }
}

function parseClaimSection(raw: string): OrcadMachineClaimRead {
  if (raw === CLAIM_ABSENT) {
    return { state: 'absent' }
  }
  if (!raw.startsWith(CLAIM_PRESENT)) {
    return { state: 'unreadable', reason: 'the claim is not a regular file' }
  }
  return parseOrcadMachineClaim(raw.slice(CLAIM_PRESENT.length).trim())
}

export function parseOrcadMachineClaim(raw: string): OrcadMachineClaimRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'unreadable', reason: 'the claim is not JSON' }
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'schemaVersion' in parsed &&
    parsed.schemaVersion === ORCAD_MACHINE_CLAIM_SCHEMA_VERSION &&
    'machineKey' in parsed &&
    typeof parsed.machineKey === 'string' &&
    /^[a-f0-9]{16}$/u.test(parsed.machineKey)
  ) {
    return { state: 'present', machineKey: parsed.machineKey }
  }
  return { state: 'unreadable', reason: 'the claim has an unknown shape' }
}

function parseOwnerLine(line: string): OrcadMachineHomeProbe['dataRootOwners'][number] | null {
  if (!line.startsWith('{')) {
    return null
  }
  try {
    const owner: unknown = JSON.parse(line)
    if (typeof owner !== 'object' || owner === null) {
      return null
    }
    return {
      host: 'host' in owner && typeof owner.host === 'string' ? owner.host : null,
      machineIdentity:
        'machineIdentity' in owner && typeof owner.machineIdentity === 'string'
          ? owner.machineIdentity
          : null
    }
  } catch {
    // A torn or foreign file is not evidence of another machine.
    return null
  }
}

/** True when a data-root owner names a machine other than this one. */
function isForeignOwner(
  owner: OrcadMachineHomeProbe['dataRootOwners'][number],
  identity: OrcadMachineIdentity,
  host: RemoteHostPlatform
): boolean {
  if (owner.machineIdentity) {
    return owner.machineIdentity.toLowerCase() !== identity.machineIdentity
  }
  // An owner too old to record its machine is judged by hostname, except on drifting macOS names.
  return (
    host.os !== 'darwin' &&
    Boolean(owner.host && identity.hostname && owner.host !== identity.hostname)
  )
}

/**
 * An unclaimed home is claimed unless a live (or crashed) orcad from another machine holds its
 * data root: that one is the install's owner, and claiming it here would judge its PIDs on the
 * wrong machine. A machine that already has its own home keeps it, so a later claim cannot move
 * it off a server still running there. An unreadable claim throws: guessing can strand a server.
 */
export function decideOrcadMachineHome(
  probe: OrcadMachineHomeProbe,
  host: RemoteHostPlatform
): OrcadMachineHomeDecision {
  const { identity, claim } = probe
  if (!identity) {
    return { kind: 'login-home' }
  }
  if (claim.state === 'unreadable') {
    throw new Error(
      `orcad cannot tell which machine owns ${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_CLAIM_FILENAME}: ${claim.reason}`
    )
  }
  if (claim.state === 'present') {
    return claim.machineKey === identity.key
      ? { kind: 'login-home' }
      : { kind: 'machine-home', machineKey: identity.key }
  }
  return probe.machineHomeKeys.includes(identity.key) ||
    probe.dataRootOwners.some((owner) => isForeignOwner(owner, identity, host))
    ? { kind: 'machine-home', machineKey: identity.key }
    : { kind: 'claim', machineKey: identity.key }
}

export function orcadMachineHomeDir(
  host: RemoteHostPlatform,
  loginHome: string,
  machineKey: string
): string {
  return joinRemotePath(host, loginHome, RELAY_REMOTE_DIR, ORCAD_MACHINE_HOMES_DIRNAME, machineKey)
}

/**
 * A sibling of `~/.orca`, not inside the machine home: orcad binds its runtime socket in the data
 * root, and a deeper path would cross the Unix socket length limit on long cluster home paths.
 */
export function orcadMachineDataRoot(
  host: RemoteHostPlatform,
  loginHome: string,
  machineKey: string
): string {
  return joinRemotePath(host, loginHome, `.orca-${machineKey.slice(0, 8)}`)
}

/**
 * Publishes the claim exclusively and prints whichever claim won. Why a hard link: `ln` is atomic
 * and exclusive on NFS too, and a reader never sees a half-written claim. A filesystem without
 * hard links, or an empty claim a full disk left, falls back to an atomic (not exclusive) rename.
 */
export function orcadMachineClaimCommand(
  host: RemoteHostPlatform,
  loginHome: string,
  machineKey: string
): string {
  const base = shellEscape(joinRemotePath(host, loginHome, RELAY_REMOTE_DIR))
  const claim = shellEscape(
    joinRemotePath(host, loginHome, RELAY_REMOTE_DIR, ORCAD_MACHINE_CLAIM_FILENAME)
  )
  const partial = shellEscape(
    joinRemotePath(
      host,
      loginHome,
      RELAY_REMOTE_DIR,
      `${ORCAD_MACHINE_CLAIM_FILENAME}.partial.${randomUUID()}`
    )
  )
  const body = shellEscape(
    JSON.stringify({
      schemaVersion: ORCAD_MACHINE_CLAIM_SCHEMA_VERSION,
      machineKey
    })
  )
  return [
    `umask 077; mkdir -p ${base} || exit 65;`,
    `printf %s ${body} > ${partial} || exit 65;`,
    `ln ${partial} ${claim} 2>/dev/null || [ -s ${claim} ] || mv -f ${partial} ${claim};`,
    `rm -f ${partial}; cat ${claim}`
  ].join(' ')
}
