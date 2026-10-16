import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from './ssh-relay-exec-command'
import type { OrcadMachineHomeProbe } from './orcad-machine-home'
import type { OrcadHostTransport } from './orcad-host-transport'
import type { RemoteHostPlatform } from './ssh-remote-platform'

// Each "machine" is a real local shell whose `uname -n` answers that machine's hostname.
const shell = vi.hoisted((): { env: NodeJS.ProcessEnv | undefined } => ({
  env: undefined
}))
vi.mock('./ssh-relay-exec-command', async (importOriginal) => {
  const { runProcess } = await import('@orca/process-host')
  return {
    ...(await importOriginal<typeof ExecCommandModule>()),
    execCommand: async (conn: { env?: NodeJS.ProcessEnv }, command: string) => {
      const result = await runProcess({
        program: '/bin/sh',
        args: ['-c', command],
        env: conn.env ?? shell.env
      })
      if (result.code !== 0) {
        const { sshCommandExitError } = await import('./ssh-relay-exec-command')
        throw sshCommandExitError(command, result.code ?? 1, result.stdout)
      }
      return result.stdout
    }
  }
})

const { resolveOrcadMachineHome } = await import('./orcad-remote-context')
const {
  decideOrcadMachineHome,
  orcadMachineIdentity,
  ORCAD_MACHINE_CLAIM_FILENAME,
  ORCAD_MACHINE_HOMES_DIRNAME
} = await import('./orcad-machine-home')
const { computeRemoteInstallDir } = await import('./remote-versioned-install')
const { ORCAD_INSTALL_MODEL } = await import('./remote-install-model')
const { orcadLivenessProbeCommand, ORCAD_PID_FILENAME } = await import('./orcad-remote-launch')
const { execOrcadRemote } = await import('./orcad-remote-runtime-control')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')
type Probe = OrcadMachineHomeProbe
type Host = RemoteHostPlatform

const linux = getRemoteHostPlatform('linux-x64')
const darwin = getRemoteHostPlatform('darwin-arm64')
const POSIX = process.platform !== 'win32'

let scratch: string
let home: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orcad-machine-home-'))
  home = join(scratch, 'shared-home')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The fake machine's hardware UUID, as `sysctl -n kern.hostuuid` answers it. */
function uuidOf(name: string): string {
  const hex = Buffer.from(name.padEnd(16, '-')).toString('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** A (macOS-flavored) machine sharing `home`, as on an NFS-mounted cluster home. */
function machine(name: string, hostname = name) {
  const bin = join(scratch, `bin-${name}-${hostname}`)
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho ${hostname}\n`)
  writeFileSync(join(bin, 'sysctl'), `#!/bin/sh\necho ${uuidOf(name)}\n`)
  chmodSync(join(bin, 'uname'), 0o755)
  chmodSync(join(bin, 'sysctl'), 0o755)
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked execCommand reads only env.
  const conn = {
    env
  } as unknown as OrcadHostTransport
  return { conn, host: darwin, env }
}

function loginHomeResult() {
  return { loginHome: home, orcadHome: home, userDataDir: join(home, '.orca') }
}

function claimPath(): string {
  return join(home, '.orca-remote', ORCAD_MACHINE_CLAIM_FILENAME)
}

function legacyOwner(name: string): void {
  const dir = join(home, '.orca', '.profile-state-access', 'participants', 'token')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'token.owner'),
    JSON.stringify({
      token: 'token',
      pid: 4242,
      host: name,
      platform: 'darwin',
      machineIdentity: uuidOf(name)
    })
  )
}

describe.runIf(POSIX)('resolveOrcadMachineHome on a home several machines share', () => {
  it('gives the first machine the login home and every other machine its own', async () => {
    const a = machine('node-a')
    const b = machine('node-b')

    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
    const bHome = await resolveOrcadMachineHome(b, true)
    expect(bHome.loginHome).toBe(home)
    expect(bHome.orcadHome).toMatch(
      new RegExp(`^${home}/\\.orca-remote/${ORCAD_MACHINE_HOMES_DIRNAME}/[a-f0-9]{16}$`)
    )
    expect(statSync(bHome.orcadHome).mode & 0o777).toBe(0o700)
    // A sibling of `~/.orca`, so the runtime socket inside it stays within the path limit.
    expect(bHome.userDataDir).toMatch(new RegExp(`^${home}/\\.orca-[a-f0-9]{8}$`))

    // Stable on every later connect, in either order.
    expect(await resolveOrcadMachineHome(b, true)).toEqual(bHome)
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
    expect(
      computeRemoteInstallDir(ORCAD_INSTALL_MODEL, bHome.orcadHome, '0.1.0+abc').startsWith(
        `${bHome.orcadHome}/.orca-remote/`
      )
    ).toBe(true)
  })

  it('never judges another machine’s PID: the second machine probes only its own slot', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    await resolveOrcadMachineHome(a, true)
    // node-a's live orcad: a PID that means nothing on node-b.
    const aSlot = computeRemoteInstallDir(ORCAD_INSTALL_MODEL, home, '0.1.0+abc')
    mkdirSync(aSlot, { recursive: true })
    writeFileSync(join(aSlot, ORCAD_PID_FILENAME), '999999\n')

    const { orcadHome } = await resolveOrcadMachineHome(b, true)
    const bSlot = computeRemoteInstallDir(ORCAD_INSTALL_MODEL, orcadHome, '0.1.0+abc')
    expect(bSlot).not.toBe(aSlot)
    const answer = await execOrcadRemote(b, orcadLivenessProbeCommand(darwin, bSlot))
    expect(answer.trim()).toBe('NEVER_LAUNCHED')
    expect(readFileSync(join(aSlot, ORCAD_PID_FILENAME), 'utf8')).toBe('999999\n')
  })

  it('upgrades an existing single-machine install in place', async () => {
    const a = machine('node-a')
    mkdirSync(join(home, '.orca-remote', 'orcad-0.1.0+abc'), {
      recursive: true
    })
    writeFileSync(join(home, '.orca-remote', 'orcad-active.json'), '{"schemaVersion":1}')
    mkdirSync(join(home, '.orca', 'profiles'), { recursive: true })
    legacyOwner('node-a')

    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
    expect(existsSync(claimPath())).toBe(true)
    expect(readFileSync(join(home, '.orca-remote', 'orcad-active.json'), 'utf8')).toBe(
      '{"schemaVersion":1}'
    )
    expect(existsSync(join(home, '.orca-remote', ORCAD_MACHINE_HOMES_DIRNAME))).toBe(false)
  })

  it('leaves an unclaimed install to the machine whose orcad holds its data root', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    legacyOwner('node-a')

    const bHome = await resolveOrcadMachineHome(b, true)
    expect(bHome.orcadHome).not.toBe(home)
    expect(existsSync(claimPath())).toBe(false)

    // node-a's orcad exits; node-b must stay on its own home, not move onto node-a's install.
    rmSync(join(home, '.orca'), { recursive: true })
    expect(await resolveOrcadMachineHome(b, true)).toEqual(bHome)
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('lets exactly one of two machines claiming at once win', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    const homes = await Promise.all([
      resolveOrcadMachineHome(a, true),
      resolveOrcadMachineHome(b, true)
    ])
    expect(homes.filter((resolved) => resolved.orcadHome === home)).toHaveLength(1)
    // No partial claim is left behind.
    expect(readdirNames(join(home, '.orca-remote'))).toEqual(
      [ORCAD_MACHINE_CLAIM_FILENAME, ORCAD_MACHINE_HOMES_DIRNAME].sort()
    )
  })

  it('keeps a renamed machine on its own install', async () => {
    expect(await resolveOrcadMachineHome(machine('node-a'), true)).toEqual(loginHomeResult())
    expect(await resolveOrcadMachineHome(machine('node-a', 'renamed'), true)).toEqual(
      loginHomeResult()
    )
  })

  it('replaces an empty claim a full disk left behind', async () => {
    mkdirSync(join(home, '.orca-remote'))
    writeFileSync(claimPath(), '')
    expect(await resolveOrcadMachineHome(machine('node-a'), true)).toEqual(loginHomeResult())
    expect(readFileSync(claimPath(), 'utf8')).toContain('machineKey')
  })

  it('refuses to guess when the claim cannot be read', async () => {
    mkdirSync(join(home, '.orca-remote'))
    writeFileSync(claimPath(), 'not json')
    await expect(resolveOrcadMachineHome(machine('node-a'), true)).rejects.toThrow(
      /cannot tell which machine owns/
    )
  })

  it('keeps WSL on the login home without probing or claiming', async () => {
    expect(await resolveOrcadMachineHome(machine('node-a'), false)).toEqual(loginHomeResult())
    expect(existsSync(join(home, '.orca-remote'))).toBe(false)
  })
})

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort()
}

function probe(host: Host, overrides: Partial<Probe> = {}): Probe {
  return {
    loginHome: '/home/u',
    identity: orcadMachineIdentity(host, 'a'.repeat(32), 'node-a'),
    claim: { state: 'absent' },
    dataRootOwners: [],
    machineHomeKeys: [],
    ...overrides
  }
}

describe('decideOrcadMachineHome', () => {
  it('keys Linux by machine-id alone, so a rename keeps the key', () => {
    const a = orcadMachineIdentity(linux, 'a'.repeat(32), 'node-a')
    expect(a?.key).toMatch(/^[a-f0-9]{16}$/)
    expect(orcadMachineIdentity(linux, 'a'.repeat(32), 'renamed')?.key).toBe(a?.key)
    expect(orcadMachineIdentity(linux, 'b'.repeat(32), 'node-a')?.key).not.toBe(a?.key)
    // No machine-id (many containers): the login home, as before.
    expect(orcadMachineIdentity(linux, '', 'node-a')).toBeNull()
    expect(orcadMachineIdentity(linux, '0'.repeat(32), 'node-a')).toBeNull()
  })

  it('keys macOS by hardware UUID alone, since its hostname follows the network', () => {
    const uuid = '12345678-1234-1234-1234-123456789ABC'
    expect(orcadMachineIdentity(darwin, uuid, 'cafe-wifi')?.key).toBe(
      orcadMachineIdentity(darwin, uuid, 'home-wifi')?.key
    )
    const renamed = probe(darwin, {
      identity: orcadMachineIdentity(darwin, uuid, 'cafe-wifi'),
      dataRootOwners: [{ host: 'home-wifi', machineIdentity: uuid }]
    })
    expect(decideOrcadMachineHome(renamed, darwin).kind).toBe('claim')
  })

  it('judges a data-root owner by machine-id, and by hostname only when it recorded none', () => {
    const other = probe(linux, {
      dataRootOwners: [{ host: 'node-a', machineIdentity: 'b'.repeat(32) }]
    })
    expect(decideOrcadMachineHome(other, linux).kind).toBe('machine-home')
    const renamed = probe(linux, {
      dataRootOwners: [{ host: 'old-name', machineIdentity: 'a'.repeat(32) }]
    })
    expect(decideOrcadMachineHome(renamed, linux).kind).toBe('claim')
    const unrecorded = probe(linux, {
      dataRootOwners: [{ host: 'node-b', machineIdentity: null }]
    })
    expect(decideOrcadMachineHome(unrecorded, linux).kind).toBe('machine-home')
  })

  it('keeps the login home when the machine cannot be identified', () => {
    expect(decideOrcadMachineHome(probe(linux, { identity: null }), linux)).toEqual({
      kind: 'login-home'
    })
  })
})
