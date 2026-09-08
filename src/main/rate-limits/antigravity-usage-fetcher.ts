import { readdir, readFile } from 'node:fs/promises'
import { request } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'

const LOG_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'log')
const PORT_LINE = /listening on random port at (\d+) for HTTPS/g
const RPC_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const TIMEOUT_MS = 10_000
const WINDOW_MINUTES: Record<string, number> = { '5h': 300, weekly: 10080 }
const NOT_RUNNING_REASON =
  'Antigravity usage is not available. Orca reads it from the Antigravity language server, which is only reachable while Antigravity is running.'

type QuotaSummaryBucket = {
  bucketId?: string
  window?: string
  remainingFraction?: number
  resetTime?: string
}

type QuotaSummaryResponse = {
  response?: { groups?: { displayName?: string; buckets?: QuotaSummaryBucket[] }[] }
}

export function mapQuotaSummary(data: QuotaSummaryResponse): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  buckets: RateLimitBucket[]
} {
  const buckets: RateLimitBucket[] = []
  for (const group of data.response?.groups ?? []) {
    // Why: group names read "Gemini Models" / "Claude and GPT models"; the suffix is noise in a status bar.
    const pool = (group.displayName ?? '').replace(/\s*models$/i, '')
    for (const bucket of group.buckets ?? []) {
      const windowMinutes = WINDOW_MINUTES[bucket.window ?? '']
      if (!windowMinutes || typeof bucket.remainingFraction !== 'number') {
        continue
      }
      const resetsAt = bucket.resetTime ? new Date(bucket.resetTime).getTime() : Number.NaN
      buckets.push({
        name: `${pool} ${bucket.window === 'weekly' ? 'Weekly' : '5h'}`.trim(),
        usedPercent: Math.min(100, Math.max(0, Math.round((1 - bucket.remainingFraction) * 100))),
        windowMinutes,
        resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
        resetDescription: null
      })
    }
  }
  // Why: the pools are independent, so the headline window is the tightest one the user can hit.
  const tightest = (windowMinutes: number): RateLimitWindow | null => {
    const scoped = buckets.filter((bucket) => bucket.windowMinutes === windowMinutes)
    if (scoped.length === 0) {
      return null
    }
    const { name: _name, ...window } = scoped.reduce((worst, bucket) =>
      bucket.usedPercent > worst.usedPercent ? bucket : worst
    )
    return window
  }
  return { session: tightest(300), weekly: tightest(10080), buckets }
}

async function readLanguageServerPort(): Promise<number | null> {
  const entries = await readdir(LOG_DIR).catch(() => [] as string[])
  const newest = entries
    .filter((name) => name.endsWith('.log'))
    .sort()
    .pop()
  if (!newest) {
    return null
  }
  const text = await readFile(join(LOG_DIR, newest), 'utf8').catch(() => '')
  const ports = [...text.matchAll(PORT_LINE)]
  return ports.length > 0 ? Number(ports.at(-1)![1]) : null
}

export async function fetchAntigravityRateLimits(): Promise<ProviderRateLimits> {
  const port = await readLanguageServerPort()
  if (!port) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: NOT_RUNNING_REASON,
      status: 'unavailable'
    }
  }
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: RPC_PATH,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Why: the language server serves loopback-only HTTPS with a self-signed certificate.
          rejectUnauthorized: false,
          timeout: TIMEOUT_MS
        },
        (res) => {
          let chunks = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => (chunks += chunk))
          res.on('end', () =>
            res.statusCode === 200 ? resolve(chunks) : reject(new Error(`HTTP ${res.statusCode}`))
          )
        }
      )
      req.on('timeout', () => req.destroy(new Error('Timed out')))
      req.on('error', reject)
      req.end('{}')
    })
    const { session, weekly, buckets } = mapQuotaSummary(JSON.parse(body) as QuotaSummaryResponse)
    if (buckets.length === 0) {
      throw new Error('No quota buckets returned')
    }
    return {
      provider: 'antigravity',
      session,
      weekly,
      buckets,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } catch {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: NOT_RUNNING_REASON,
      status: 'unavailable'
    }
  }
}
