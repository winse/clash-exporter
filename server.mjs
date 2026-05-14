/**
 * Clash / Clash Meta Prometheus exporter — clash_* session metrics + optional extended series.
 *
 * Startup: block until GET /version succeeds (controller ready). While waiting,
 * exponential backoff — press Enter when stdin is a TTY to retry immediately — then HTTP + WS.
 * clash_info: from /version; refreshed again on each /connections WS open.
 * clash_* on /connections stream.
 *
 * Env: PORT, CLASH_HOST, CLASH_TOKEN, CLASH_PIPE, COLLECT_DEST
 * Extended: METRIC_PREFIX, CLASH_ENABLE_SPEED, CLASH_ENABLE_PROXY_LATENCY/_DELAY,
 *   CLASH_LATENCY_INTERVAL_MS
 */
import http from 'node:http'
import process from 'node:process'
import readline from 'node:readline'

import client from 'prom-client'

import { createApiClient } from './lib/api-client.mjs'
import { createClashExtendedMetrics } from './lib/clash-extended.mjs'

function logErr(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args)
}

async function sleepBackoffOrWakeHint(totalMs, shouldWakeNow) {
  const tickMs = 200
  let left = totalMs
  while (left > 0) {
    if (shouldWakeNow()) return true
    const stepMs = Math.min(tickMs, left)
    await new Promise((r) => setTimeout(r, stepMs))
    left -= stepMs
  }
  return false
}

const PORT = Number(process.env.PORT) || 2112
const CLASH_HOST = process.env.CLASH_HOST || ''
const CLASH_TOKEN = process.env.CLASH_TOKEN || ''
const PIPE_PATH =
  process.env.CLASH_PIPE ?? '\\\\.\\pipe\\verge-mihomo'
const COLLECT_DEST = process.env.COLLECT_DEST !== 'false'

const METRIC_PREFIX = process.env.METRIC_PREFIX || 'clash'

const CLASH_ENABLE_SPEED = process.env.CLASH_ENABLE_SPEED !== 'false'
const CLASH_ENABLE_LATENCY =
  process.env.CLASH_ENABLE_PROXY_LATENCY === 'true' ||
  process.env.CLASH_ENABLE_PROXY_DELAY === 'true'
const CLASH_LATENCY_MS =
  Number(process.env.CLASH_LATENCY_INTERVAL_MS) || 60_000

const api = createApiClient({
  clashHost: CLASH_HOST,
  clashToken: CLASH_TOKEN,
  pipePath: PIPE_PATH,
})

const register = new client.Registry()

const clashInfo = new client.Gauge({
  name: 'clash_info',
  help: 'Clash core version (value is always 1; use labels).',
  labelNames: ['version', 'premium'],
  registers: [register],
})

const clashDownloadBytesTotal = new client.Gauge({
  name: 'clash_download_bytes_total',
  help: 'Total download bytes (controller session).',
  registers: [register],
})

const clashUploadBytesTotal = new client.Gauge({
  name: 'clash_upload_bytes_total',
  help: 'Total upload bytes (controller session).',
  registers: [register],
})

const clashActiveConnections = new client.Gauge({
  name: 'clash_active_connections',
  help: 'Number of active connections.',
  registers: [register],
})

const clashConnectionBytesTotal = new client.Gauge({
  name: 'clash_connection_bytes_total',
  help:
    'Cumulative upload and download bytes from /connections per-connection deltas, by source, policy (chain first hop), and type.',
  labelNames: ['source', 'policy', 'type'],
  registers: [register],
})

const clashNetworkTrafficBytesTotal = new client.Counter({
  name: 'clash_network_traffic_bytes_total',
  help:
    'Bytes by source, destination, egress policy (first chain hop), and direction (upload|download). Deltas from /connections stream.',
  labelNames: ['source', 'destination', 'policy', 'type'],
  registers: [register],
})

/** @type {Map<string, { upload: number, download: number }>} */
const connectionCache = new Map()

function policyFromChains(chains) {
  if (!chains?.length) return 'UNKNOWN'
  return String(chains[0])
}

function destinationLabel(metadata) {
  if (!COLLECT_DEST) return ''
  const h = metadata?.host
  if (h) return h
  const ip = metadata?.destinationIP || metadata?.remoteDestination
  return ip ? String(ip) : ''
}

const extended = createClashExtendedMetrics(register, {
  prefix: METRIC_PREFIX,
  api,
  enableSpeed: CLASH_ENABLE_SPEED,
  enableProxyLatency: CLASH_ENABLE_LATENCY,
  latencyIntervalMs: CLASH_LATENCY_MS,
})

function processClashSnapshot(msg) {
  const uploadTotal = msg.uploadTotal ?? 0
  const downloadTotal = msg.downloadTotal ?? 0
  const connections = msg.connections ?? []

  clashUploadBytesTotal.set(uploadTotal)
  clashDownloadBytesTotal.set(downloadTotal)
  clashActiveConnections.set(connections.length)

  const activeIds = new Set()
  for (const c of connections) {
    activeIds.add(c.id)
    const prev = connectionCache.get(c.id) ?? { upload: 0, download: 0 }
    const dest = destinationLabel(c.metadata)
    const policy = policyFromChains(c.chains)
    const source = c.metadata?.sourceIP != null ? String(c.metadata.sourceIP) : ''

    const dDl = (c.download ?? 0) - prev.download
    const dUl = (c.upload ?? 0) - prev.upload
    if (dDl > 0) {
      clashNetworkTrafficBytesTotal
        .labels(source, dest, policy, 'download')
        .inc(dDl)
      clashConnectionBytesTotal.labels(source, policy, 'download').inc(dDl)
    }
    if (dUl > 0) {
      clashNetworkTrafficBytesTotal
        .labels(source, dest, policy, 'upload')
        .inc(dUl)
      clashConnectionBytesTotal.labels(source, policy, 'upload').inc(dUl)
    }

    connectionCache.set(c.id, {
      upload: c.upload ?? 0,
      download: c.download ?? 0,
    })
  }

  for (const id of connectionCache.keys()) {
    if (!activeIds.has(id)) connectionCache.delete(id)
  }
}

/** Currently exported `clash_info` labels; used so we can replace without leaving stale series. */
let clashInfoActive = /** @type {[string, string] | null} */ (null)

function applyClashInfo(versionRaw, premiumRaw) {
  const ver = String(versionRaw ?? 'unknown')
  const prem = String(premiumRaw ?? false)
  if (clashInfoActive && clashInfoActive[0] === ver && clashInfoActive[1] === prem) {
    return
  }
  if (clashInfoActive) {
    try {
      clashInfo.remove(...clashInfoActive)
    } catch {
      /* Child may already be absent. */
    }
  }
  clashInfo.labels(ver, prem).set(1)
  clashInfoActive = [ver, prem]
}

async function refreshClashInfoFromApi() {
  try {
    const v = await api.jsonRequest('/version')
    applyClashInfo(v.version ?? 'unknown', v.premium ?? false)
    return true
  } catch {
    return false
  }
}

async function waitForClashVersionBeforeListen() {
  let delayMs = 1_000
  const maxDelayMs = 60_000

  let wakeBackoffNow = false
  /** @type {import('node:readline').Interface | null} */
  let rlWake = null

  if (process.stdin.isTTY) {
    rlWake = readline.createInterface({
      input: process.stdin,
      terminal: process.stdin.isTTY,
    })
    rlWake.on('line', () => {
      wakeBackoffNow = true
    })
    console.error(
      '[clash-exporter] 等待外控 /version 期间可随时按 Enter 跳过间隔、立即再试一次',
    )
  }

  try {
    for (;;) {
      try {
        const v = await api.jsonRequest('/version')
        applyClashInfo(v.version ?? 'unknown', v.premium ?? false)
        console.error(`[clash-exporter] controller ready; starting HTTP :${PORT}`)
        return
      } catch (e) {
        logErr('[clash-exporter] waiting for controller /version:', String(e?.message ?? e))
        const woke = await sleepBackoffOrWakeHint(delayMs, () => wakeBackoffNow)
        if (woke) {
          wakeBackoffNow = false
          logErr('[clash-exporter] 收到 Enter → 立即重试 /version')
          delayMs = 1_000
        } else {
          delayMs = Math.min(delayMs * 2, maxDelayMs)
        }
      }
    }
  } finally {
    rlWake?.close()
  }
}

function startConnectionsLoop() {
  let ws
  let stopped = false
  let retryMs = 1_000

  const connect = () => {
    if (stopped) return
    ws = api.createWs('/connections')

    ws.on('open', () => {
      void refreshClashInfoFromApi()
    })

    ws.on('message', (data, isBinary) => {
      retryMs = 1_000
      const text = isBinary ? data.toString('utf8') : data.toString()
      try {
        processClashSnapshot(JSON.parse(text))
      } catch {
        /* ignore malformed frame */
      }
    })

    ws.on('error', () => {
      try {
        ws.close()
      } catch {
        /* */
      }
    })

    ws.on('close', () => {
      if (stopped) return
      setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 60_000)
    })
  }

  connect()

  return () => {
    stopped = true
    try {
      ws?.close()
    } catch {
      /* */
    }
  }
}

let stopExtended = () => {}
let stopWs = () => {}

function shutdown() {
  stopWs()
  stopExtended()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await waitForClashVersionBeforeListen()

stopExtended = extended.start()
stopWs = startConnectionsLoop()

http
  .createServer(async (req, res) => {
    if (req.url === '/metrics' || req.url?.startsWith('/metrics?')) {
      res.setHeader('Content-Type', register.contentType)
      res.end(await register.metrics())
      return
    }
    if (req.url === '/health' || req.url === '/') {
      res.setHeader('Content-Type', 'text/plain')
      res.end('ok')
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  .listen(PORT, () => {
    console.error(
      `[clash-exporter] listening :${PORT} /metrics | clash_* + ${METRIC_PREFIX}_* | pipe=${CLASH_HOST ? 'off' : PIPE_PATH} tcp=${CLASH_HOST || '—'}`,
    )
  })
