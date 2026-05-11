/**
 * Clash / Clash Meta Prometheus exporter — clash_* session metrics, optional extended series.
 *
 * CONNECTION_DETAIL_MODE: default | compact | full (aliases: off→default, nykma→full).
 * Legacy if unset: NYKMA_PROXY_ENABLE+NYKMA_PROXY_CONNECTION_DETAIL → full; CLASH_ENABLE_PER_CONN → compact.
 *
 * Env: PORT, CLASH_HOST, CLASH_TOKEN, CLASH_PIPE, COLLECT_DEST
 * Extended: METRIC_PREFIX, CLASH_ENABLE_SPEED, CLASH_ENABLE_NODE_AGG,
 *   CLASH_ENABLE_DEST_AGG, CLASH_ENABLE_PROXY_LATENCY, CLASH_LATENCY_INTERVAL_MS,
 *   CLASH_PROXIES_POLL_MS
 * clash_traffic_by_*: CLASH_ENABLE_TRAFFIC_BY_DIMS, CLASH_TRAFFIC_BY_SKIP_DIRECT,
 *   CLASH_TRAFFIC_BY_LABEL_IDLE_MS, CLASH_TRAFFIC_BY_LABEL_CLEANUP_MS
 * `full` / `{prefix}_connection_*` 的标签 `name`: NYKMA_PROXY_NAME (默认 default)
 */
import http from 'node:http'
import process from 'node:process'

import client from 'prom-client'

import { createApiClient } from './lib/api-client.mjs'
import { createClashExtendedMetrics } from './lib/clash-extended.mjs'

const PORT = Number(process.env.PORT) || 2112
const CLASH_HOST = process.env.CLASH_HOST || ''
const CLASH_TOKEN = process.env.CLASH_TOKEN || ''
const PIPE_PATH =
  process.env.CLASH_PIPE ?? '\\\\.\\pipe\\verge-mihomo'
const COLLECT_DEST = process.env.COLLECT_DEST !== 'false'

const METRIC_PREFIX = process.env.METRIC_PREFIX || 'clash'

const CLASH_ENABLE_SPEED = process.env.CLASH_ENABLE_SPEED !== 'false'
const CLASH_ENABLE_NODE = process.env.CLASH_ENABLE_NODE_AGG !== 'false'
const CLASH_ENABLE_DEST = process.env.CLASH_ENABLE_DEST_AGG !== 'false'
const CLASH_ENABLE_LATENCY =
  process.env.CLASH_ENABLE_PROXY_LATENCY === 'true' ||
  process.env.CLASH_ENABLE_PROXY_DELAY === 'true'
const CLASH_LATENCY_MS =
  Number(process.env.CLASH_LATENCY_INTERVAL_MS) || 60_000
const CLASH_PROXIES_MS =
  Number(process.env.CLASH_PROXIES_POLL_MS) || 1000

const ENABLE_TRAFFIC_BY_DIMS =
  process.env.CLASH_ENABLE_TRAFFIC_BY_DIMS !== 'false'
const TRAFFIC_BY_SKIP_DIRECT =
  process.env.CLASH_TRAFFIC_BY_SKIP_DIRECT !== 'false'
const TRAFFIC_BY_LABEL_IDLE_MS =
  Number(process.env.CLASH_TRAFFIC_BY_LABEL_IDLE_MS) || 3_600_000
const TRAFFIC_BY_LABEL_CLEANUP_MS =
  Number(process.env.CLASH_TRAFFIC_BY_LABEL_CLEANUP_MS) || 60_000

const NYKMA_PROXY_NAME =
  process.env.NYKMA_PROXY_NAME ||
  process.env.PROXY_EXPORTER_NAME ||
  'default'

function normalizeConnectionDetailMode(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  if (raw === 'default' || raw === 'compact' || raw === 'full') return raw
  if (raw === 'off') return 'default'
  return null
}

function resolveConnectionDetailMode() {
  const explicit = normalizeConnectionDetailMode(process.env.CONNECTION_DETAIL_MODE)
  if (explicit) return explicit

  const fullLegacy =
    process.env.NYKMA_PROXY_ENABLE === 'true' &&
    process.env.NYKMA_PROXY_CONNECTION_DETAIL === 'true'
  const compactLegacy = process.env.CLASH_ENABLE_PER_CONN === 'true'

  if (fullLegacy && compactLegacy) {
    console.error(
      '[clash-exporter] CONNECTION_DETAIL_MODE unset but NYKMA_* and CLASH_ENABLE_PER_CONN are both true; using full',
    )
  }
  if (fullLegacy) return 'full'
  if (compactLegacy) return 'compact'
  return 'default'
}

const CONNECTION_DETAIL_MODE = resolveConnectionDetailMode()

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
  enableAggNode: CLASH_ENABLE_NODE,
  enableAggDest: CLASH_ENABLE_DEST,
  connectionDetailMode: CONNECTION_DETAIL_MODE,
  fullDetailInstanceName: NYKMA_PROXY_NAME,
  enableProxyLatency: CLASH_ENABLE_LATENCY,
  latencyIntervalMs: CLASH_LATENCY_MS,
  proxiesPollMs: CLASH_PROXIES_MS,
  enableTrafficByDims: ENABLE_TRAFFIC_BY_DIMS,
  trafficBySkipDirect: TRAFFIC_BY_SKIP_DIRECT,
  trafficByLabelIdleMs: TRAFFIC_BY_LABEL_IDLE_MS,
  trafficByLabelCleanupMs: TRAFFIC_BY_LABEL_CLEANUP_MS,
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
    }
    if (dUl > 0) {
      clashNetworkTrafficBytesTotal
        .labels(source, dest, policy, 'upload')
        .inc(dUl)
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

function processSnapshot(msg) {
  processClashSnapshot(msg)
  extended.onConnectionsMessage(msg)
}

function startConnectionsLoop() {
  let ws
  let stopped = false
  let retryMs = 1_000

  const connect = () => {
    if (stopped) return
    ws = api.createWs('/connections')

    ws.on('message', (data, isBinary) => {
      retryMs = 1_000
      const text = isBinary ? data.toString('utf8') : data.toString()
      try {
        processSnapshot(JSON.parse(text))
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

async function bootstrapVersion() {
  try {
    const v = await api.jsonRequest('/version')
    clashInfo
      .labels(String(v.version ?? 'unknown'), String(v.premium ?? false))
      .set(1)
  } catch (e) {
    clashInfo.labels('unknown', 'false').set(1)
    console.error('[clash-exporter] version fetch failed:', e.message)
  }
}

const stopExtended = extended.start()
const stopWs = startConnectionsLoop()

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
      `[clash-exporter] :${PORT} /metrics | clash_* + ${METRIC_PREFIX}_* + clash_traffic_by_* | conn_detail=${CONNECTION_DETAIL_MODE} | pipe=${CLASH_HOST ? 'off' : PIPE_PATH} tcp=${CLASH_HOST || '—'}`,
    )
  })

await bootstrapVersion()

function shutdown() {
  stopWs()
  stopExtended()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
