import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { describe, expect, it, vi } from 'vitest'
import { buildServePairingReadiness } from './serve-pairing-readiness'

vi.mock('./serve-pairing-output', () => ({
  renderServePairingQr: vi.fn(async () => 'terminal QR'),
  assertServeProjectRoot: vi.fn()
}))

function server() {
  const direct = {
    available: true as const,
    pairingUrl: 'orca://pair?direct',
    endpoint: 'ws://127.0.0.1:6768',
    deviceId: 'phone',
    webClientUrl: null,
    connectionMode: 'automatic' as const
  }
  return {
    getWebSocketEndpoint: () => 'ws://0.0.0.0:6768',
    createPairingOffer: vi.fn(() => direct),
    createMobilePairingOffer: vi.fn<OrcaRuntimeRpcServer['createMobilePairingOffer']>(async () => ({
      ...direct,
      pairingUrl: 'orca://pair?relay=invite'
    }))
  }
}

describe('serve mobile pairing output', () => {
  it('prints a Relay offer and QR for mobile enrollment', async () => {
    const rpc = server()
    const ready = await buildServePairingReadiness(
      { mobilePairing: true, pairingAddress: '192.168.10.50' },
      rpc
    )
    expect(rpc.createMobilePairingOffer).toHaveBeenCalledWith({
      address: '192.168.10.50',
      connectionMode: 'automatic',
      name: 'Mobile'
    })
    expect(rpc.createPairingOffer).not.toHaveBeenCalled()
    expect(ready.pairing).toMatchObject({
      available: true,
      url: 'orca://pair?relay=invite',
      qr: 'terminal QR',
      scope: 'mobile'
    })
  })

  it('reports Relay failure instead of silently printing a direct-only mobile link', async () => {
    const rpc = server()
    rpc.createMobilePairingOffer.mockResolvedValueOnce({
      available: false,
      reason: 'relay_mint_failed',
      guidance: 'Sign in on this host.'
    })
    const ready = await buildServePairingReadiness({ mobilePairing: true }, rpc)
    expect(ready.pairing).toMatchObject({ available: false, reason: 'relay_mint_failed' })
    expect(rpc.createPairingOffer).not.toHaveBeenCalled()
  })
})
