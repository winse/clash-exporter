/**
 * Extended Clash metrics ({prefix}_*, clash_traffic_by_*).
 * CONNECTION_DETAIL_MODE compact | full: same metric names {prefix}_connection_{upload,download}_bytes,
 * unified label set; compact leaves most labels empty.
 * Session totals: clash_* only in server.mjs.
 */
import client from 'prom-client'
import { getDomain } from 'tldts'

const SKIP_PROXY_TYPES = new Set([
  'Selector',
  'URLTest',
  'Fallback',
  'LoadBalance',
  'Relay',
  'Direct',
  'Reject',
])

const CONNECTION_DETAIL_LABEL_NAMES = [
  'name',
  'connection_id',
  'network',
  'type',
  'source_ip',
  'destination_ip',
  'source_port',
  'destination_port',
  'source_geo_ip',
  'destination_geo_ip',
  'source_ip_asn',
  'destination_ip_asn',
  'inbound_ip',
  'inbound_port',
  'inbound_name',
  'inbound_user',
  'host',
  'dns_mode',
  'uid',
  'process',
  'process_path',
  'special_proxy',
  'special_rules',
  'remote_destination',
  'dscp',
  'sniff_host',
  'rule',
  'rule_payload',
  'chain',
  'provider_chain',
]

function fallbackLastChain(chains) {
  if (!chains?.length) return 'DIRECT'
  const last = chains[chains.length - 1]
  return last ? String(last) : 'DIRECT'
}

export function getActualOutboundNode(chains, proxiesResponse) {
  if (!chains?.length) return 'DIRECT'
  const pmap = proxiesResponse?.proxies
  if (!pmap) return fallbackLastChain(chains)

  for (let i = chains.length - 1; i >= 0; i--) {
    const name = String(chains[i])
    const proxy = pmap[name]
    if (!proxy) continue
    const t = proxy.type

    if (!SKIP_PROXY_TYPES.has(t)) return name

    if (t === 'Selector' && proxy.now) {
      const nowP = pmap[proxy.now]
      if (nowP?.type === 'Selector' && nowP.all?.length) {
        return String(nowP.all[0])
      }
      return String(proxy.now)
    }
  }
  return fallbackLastChain(chains)
}

function netIsIp(s) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true
  return /:/.test(s) && s.length > 2
}

export function extractAsn(dstIPASN) {
  if (!dstIPASN) return 'unknown'
  const parts = String(dstIPASN).trim().split(/\s+/, 2)
  if (parts.length === 2) {
    if (parts[0] !== '0') return parts[0]
    return 'unknown'
  }
  return parts[0] || 'unknown'
}

function normalizeIsIpString(s) {
  if (!s) return false
  return netIsIp(s)
}

export function extractTrafficByHostLabel(conn) {
  let target =
    conn.metadata?.sniffHost ||
    conn.metadata?.sniffhost ||
    conn.metadata?.host ||
    ''
  if (target.includes('://')) {
    try {
      target = new URL(target).hostname
    } catch {
      /* */
    }
  }
  if (normalizeIsIpString(target)) return 'unknown'
  const reg = getDomain(target, { detectIp: false, allowPrivateDomains: true })
  if (reg) return reg
  return target || 'unknown'
}

function firstChainHop(chains) {
  if (!chains?.length) return 'DIRECT'
  return String(chains[0])
}

function strMeta(v) {
  if (v == null || v === undefined) return ''
  if (Array.isArray(v)) return v.join(',')
  return String(v)
}

function buildProxyConnectionLabels(instanceName, c, chain, providerChain) {
  const m = c.metadata ?? {}
  return {
    name: strMeta(instanceName),
    connection_id: String(c.id ?? ''),
    network: strMeta(m.network),
    type: strMeta(m.type),
    source_ip: strMeta(m.sourceIP),
    destination_ip: strMeta(m.destinationIP),
    source_port: strMeta(m.sourcePort),
    destination_port: strMeta(m.destinationPort),
    source_geo_ip: strMeta(m.sourceGeoIP ?? m.sourceGeoIp),
    destination_geo_ip: strMeta(m.destinationGeoIP ?? m.destinationGeoIp),
    source_ip_asn: strMeta(m.sourceIPASN),
    destination_ip_asn: strMeta(m.destinationIPASN),
    inbound_ip: strMeta(m.inboundIP),
    inbound_port: strMeta(m.inboundPort),
    inbound_name: strMeta(m.inboundName),
    inbound_user: strMeta(m.inboundUser),
    host: strMeta(m.host),
    dns_mode: strMeta(m.dnsMode),
    uid: strMeta(m.uid ?? ''),
    process: strMeta(m.process),
    process_path: strMeta(m.processPath),
    special_proxy: strMeta(m.specialProxy),
    special_rules: strMeta(m.specialRules),
    remote_destination: strMeta(m.remoteDestination),
    dscp: strMeta(m.dscp ?? ''),
    sniff_host: strMeta(m.sniffHost),
    rule: strMeta(c.rule),
    rule_payload: strMeta(c.rulePayload),
    chain: strMeta(chain),
    provider_chain: strMeta(providerChain),
  }
}

function connectionDetailLabelKey(o) {
  return CONNECTION_DETAIL_LABEL_NAMES.map((k) => o[k]).join('\x1e')
}

function buildCompactConnectionLabels(
  instanceName,
  sourceHost,
  destination,
  outboundNode,
) {
  const dest = destination == null ? '' : String(destination)
  const dip = netIsIp(dest)
  const src = sourceHost === 'clash' ? '' : String(sourceHost)
  return {
    name: strMeta(instanceName),
    connection_id: '',
    network: '',
    type: '',
    source_ip: strMeta(src),
    destination_ip: dip ? strMeta(dest) : '',
    source_port: '',
    destination_port: '',
    source_geo_ip: '',
    destination_geo_ip: '',
    source_ip_asn: '',
    destination_ip_asn: '',
    inbound_ip: '',
    inbound_port: '',
    inbound_name: '',
    inbound_user: '',
    host: dip ? '' : strMeta(dest),
    dns_mode: '',
    uid: '',
    process: '',
    process_path: '',
    special_proxy: '',
    special_rules: '',
    remote_destination: '',
    dscp: '',
    sniff_host: '',
    rule: '',
    rule_payload: '',
    chain: strMeta(outboundNode),
    provider_chain: '',
  }
}

/**
 * @param {import('prom-client').Registry} register
 * @param {object} opts
 */
export function createClashExtendedMetrics(register, opts) {
  const {
    prefix,
    api,
    enableSpeed,
    enableAggNode,
    enableAggDest,
    connectionDetailMode,
    fullDetailInstanceName,
    enableProxyLatency,
    latencyIntervalMs,
    proxiesPollMs,
    enableTrafficByDims,
    trafficBySkipDirect,
    trafficByLabelIdleMs,
    trafficByLabelCleanupMs,
  } = opts

  const fq = (name) => `${prefix}_${name}`
  const detailCompact = connectionDetailMode === 'compact'
  const detailFull = connectionDetailMode === 'full'

  let gUpSpeed
  let gDownSpeed
  let gAggNodeUl
  let gAggNodeDl
  let gAggDestUl
  let gAggDestDl
  let gPerConnUl
  let gPerConnDl
  let gLat
  let gAvail

  let cxAsn
  let cxClient
  let cxHost
  let cxProxy

  if (enableSpeed) {
    gUpSpeed = new client.Gauge({
      name: fq('traffic_upload_speed_bytes'),
      help: 'Current upload speed in bytes per second.',
      registers: [register],
    })
    gDownSpeed = new client.Gauge({
      name: fq('traffic_download_speed_bytes'),
      help: 'Current download speed in bytes per second.',
      registers: [register],
    })
  }

  if (enableAggNode) {
    gAggNodeUl = new client.Gauge({
      name: fq('connection_upload_bytes_by_node'),
      help: 'Active connections upload bytes summed by outbound node.',
      labelNames: ['outbound_node'],
      registers: [register],
    })
    gAggNodeDl = new client.Gauge({
      name: fq('connection_download_bytes_by_node'),
      help: 'Active connections download bytes summed by outbound node.',
      labelNames: ['outbound_node'],
      registers: [register],
    })
  }

  if (enableAggDest) {
    gAggDestUl = new client.Gauge({
      name: fq('connection_upload_bytes_by_destination'),
      help: 'Active connections upload bytes by destination and node.',
      labelNames: ['destination', 'outbound_node'],
      registers: [register],
    })
    gAggDestDl = new client.Gauge({
      name: fq('connection_download_bytes_by_destination'),
      help: 'Active connections download bytes by destination and node.',
      labelNames: ['destination', 'outbound_node'],
      registers: [register],
    })
  }

  if (detailCompact || detailFull) {
    const perConnHelp =
      'Active connection upload/download bytes; same label names for compact (sparse) and full (all attributes set).'
    gPerConnUl = new client.Gauge({
      name: fq('connection_upload_bytes'),
      help: perConnHelp,
      labelNames: CONNECTION_DETAIL_LABEL_NAMES,
      registers: [register],
    })
    gPerConnDl = new client.Gauge({
      name: fq('connection_download_bytes'),
      help: perConnHelp,
      labelNames: CONNECTION_DETAIL_LABEL_NAMES,
      registers: [register],
    })
  }

  if (enableProxyLatency) {
    gLat = new client.Gauge({
      name: fq('proxy_latency_ms'),
      labelNames: ['proxy_name'],
      registers: [register],
    })
    gAvail = new client.Gauge({
      name: fq('proxy_available'),
      labelNames: ['proxy_name'],
      registers: [register],
    })
  }

  if (enableTrafficByDims) {
    cxAsn = new client.Counter({
      name: 'clash_traffic_by_asn',
      help: 'Cumulative bytes (up+down) by destination ASN.',
      labelNames: ['asn'],
      registers: [register],
    })
    cxClient = new client.Counter({
      name: 'clash_traffic_by_client',
      help: 'Cumulative bytes (up+down) by client source address.',
      labelNames: ['address'],
      registers: [register],
    })
    cxHost = new client.Counter({
      name: 'clash_traffic_by_host',
      help: 'Cumulative bytes (up+down) by registrar domain / host.',
      labelNames: ['host'],
      registers: [register],
    })
    cxProxy = new client.Counter({
      name: 'clash_traffic_by_proxy',
      help: 'Cumulative bytes (up+down) by first proxy chain hop.',
      labelNames: ['proxy'],
      registers: [register],
    })
  }

  let cachedProxies = null
  let proxiesTimer = null
  let latencyTimer = null
  let cleanupTimer = null

  const trafficByConnBytePrev = new Map()
  const asnSeen = new Map()
  const clientSeen = new Map()
  const hostSeen = new Map()
  const proxySeen = new Map()

  let prevNode = new Set()
  let prevDest = new Set()
  /** @type {Map<string, Record<string, string>>} */
  let perConnDetailState = new Map()

  function applyAggregations(msg) {
    const connections = msg.connections ?? []
    const nodeAgg = new Map()
    const destAgg = new Map()
    const connAgg = new Map()

    for (const c of connections) {
      const outbound = getActualOutboundNode(c.chains, cachedProxies)
      let destination = c.metadata?.host || ''
      if (!destination) {
        destination =
          c.metadata?.destinationIP ||
          c.metadata?.remoteDestination ||
          'unknown'
      }
      destination = String(destination)

      let sourceHost = c.metadata?.sourceIP
        ? String(c.metadata.sourceIP)
        : 'clash'

      const ul = Number(c.upload) || 0
      const dl = Number(c.download) || 0

      if (enableAggNode && gAggNodeUl && gAggNodeDl) {
        const t = nodeAgg.get(outbound) ?? { ul: 0, dl: 0 }
        t.ul += ul
        t.dl += dl
        nodeAgg.set(outbound, t)
      }

      if (enableAggDest && gAggDestUl && gAggDestDl) {
        const dk = `${destination}\0${outbound}`
        const t = destAgg.get(dk) ?? { dest: destination, node: outbound, ul: 0, dl: 0 }
        t.ul += ul
        t.dl += dl
        destAgg.set(dk, t)
      }

      if (detailCompact && gPerConnUl && gPerConnDl) {
        const ck = `${sourceHost}\0${destination}\0${outbound}`
        const t =
          connAgg.get(ck) ?? {
            source_host: sourceHost,
            destination,
            outbound_node: outbound,
            ul: 0,
            dl: 0,
          }
        t.ul += ul
        t.dl += dl
        connAgg.set(ck, t)
      }
    }

    if (enableAggNode && gAggNodeUl) {
      for (const k of prevNode) {
        if (!nodeAgg.has(k)) {
          try {
            gAggNodeUl.remove({ outbound_node: k })
            gAggNodeDl.remove({ outbound_node: k })
          } catch {
            /* */
          }
        }
      }
      for (const [node, t] of nodeAgg) {
        gAggNodeUl.labels(node).set(t.ul)
        gAggNodeDl.labels(node).set(t.dl)
      }
      prevNode = new Set(nodeAgg.keys())
    }

    if (enableAggDest && gAggDestUl) {
      for (const k of prevDest) {
        if (!destAgg.has(k)) {
          const [dest, node] = k.split('\0')
          try {
            gAggDestUl.remove({ destination: dest, outbound_node: node })
            gAggDestDl.remove({ destination: dest, outbound_node: node })
          } catch {
            /* */
          }
        }
      }
      for (const [, t] of destAgg) {
        gAggDestUl.labels(t.dest, t.node).set(t.ul)
        gAggDestDl.labels(t.dest, t.node).set(t.dl)
      }
      prevDest = new Set(destAgg.keys())
    }

    if (detailCompact && gPerConnUl && gPerConnDl) {
      const nextDetail = new Map()
      for (const [, t] of connAgg) {
        const o = buildCompactConnectionLabels(
          fullDetailInstanceName,
          t.source_host,
          t.destination,
          t.outbound_node,
        )
        const key = connectionDetailLabelKey(o)
        gPerConnUl.labels(o).set(t.ul)
        gPerConnDl.labels(o).set(t.dl)
        nextDetail.set(key, o)
      }
      for (const [key, o] of perConnDetailState.entries()) {
        if (!nextDetail.has(key)) {
          try {
            gPerConnUl.remove(o)
            gPerConnDl.remove(o)
          } catch {
            /* */
          }
        }
      }
      perConnDetailState = nextDetail
    }
  }

  function applyFullConnectionDetail(msg) {
    if (!detailFull || !gPerConnUl || !gPerConnDl) return

    const next = new Map()
    const connections = msg.connections ?? []

    for (const c of connections) {
      const chains = c.chains ?? []
      const pc = c.providerChains ?? c.provider_chains ?? []
      const n = Math.max(chains.length, pc.length, 1)

      for (let i = 0; i < n; i++) {
        const chain = chains[i] ?? ''
        const providerChain = pc[i] ?? ''
        const o = buildProxyConnectionLabels(
          fullDetailInstanceName,
          c,
          chain,
          providerChain,
        )
        const key = connectionDetailLabelKey(o)
        const ul = Number(c.upload) || 0
        const dl = Number(c.download) || 0

        gPerConnUl.labels(o).set(ul)
        gPerConnDl.labels(o).set(dl)
        next.set(key, o)
      }
    }

    for (const [key, o] of perConnDetailState.entries()) {
      if (!next.has(key)) {
        try {
          gPerConnUl.remove(o)
          gPerConnDl.remove(o)
        } catch {
          /* */
        }
      }
    }
    perConnDetailState = next
  }

  function applyTrafficByDimCounters(msg, now = Date.now()) {
    if (!enableTrafficByDims || !cxAsn) return
    const connections = msg.connections ?? []
    const active = new Set()

    for (const c of connections) {
      const id = c.id != null ? String(c.id) : ''
      if (!id) continue

      const proxyHop = firstChainHop(c.chains)
      if (trafficBySkipDirect && proxyHop === 'DIRECT') continue

      active.add(id)

      const ul = Number(c.upload) || 0
      const dl = Number(c.download) || 0
      const prev = trafficByConnBytePrev.get(id)
      let dUl = prev ? ul - prev.ul : ul
      let dDl = prev ? dl - prev.dl : dl
      if (dUl < 0) dUl = 0
      if (dDl < 0) dDl = 0

      trafficByConnBytePrev.set(id, { ul, dl })

      const sum = dUl + dDl
      if (sum <= 0) continue

      const asn = extractAsn(c.metadata?.destinationIPASN)
      const addr = c.metadata?.sourceIP
        ? String(c.metadata.sourceIP)
        : 'unknown'
      const host = extractTrafficByHostLabel(c)
      const px = proxyHop || 'UNKNOWN'

      cxAsn.labels(asn).inc(sum)
      cxClient.labels(addr).inc(sum)
      cxHost.labels(host).inc(sum)
      cxProxy.labels(px).inc(sum)

      asnSeen.set(asn, now)
      clientSeen.set(addr, now)
      hostSeen.set(host, now)
      proxySeen.set(px, now)
    }

    for (const id of trafficByConnBytePrev.keys()) {
      if (!active.has(id)) trafficByConnBytePrev.delete(id)
    }
  }

  function cleanupStaleTrafficByDimLabels(now) {
    if (!enableTrafficByDims) return

    for (const [label, ts] of [...asnSeen.entries()]) {
      if (now - ts > trafficByLabelIdleMs) {
        try {
          cxAsn?.remove({ asn: label })
        } catch {
          /* */
        }
        asnSeen.delete(label)
      }
    }
    for (const [label, ts] of [...clientSeen.entries()]) {
      if (now - ts > trafficByLabelIdleMs) {
        try {
          cxClient?.remove({ address: label })
        } catch {
          /* */
        }
        clientSeen.delete(label)
      }
    }
    for (const [label, ts] of [...hostSeen.entries()]) {
      if (now - ts > trafficByLabelIdleMs) {
        try {
          cxHost?.remove({ host: label })
        } catch {
          /* */
        }
        hostSeen.delete(label)
      }
    }
    for (const [label, ts] of [...proxySeen.entries()]) {
      if (now - ts > trafficByLabelIdleMs) {
        try {
          cxProxy?.remove({ proxy: label })
        } catch {
          /* */
        }
        proxySeen.delete(label)
      }
    }
  }

  async function refreshProxies() {
    try {
      cachedProxies = await api.jsonRequest('/proxies')
    } catch {
      /* keep stale */
    }
  }

  async function runLatencyRound() {
    if (!enableProxyLatency || !gLat || !gAvail) return
    let proxies
    try {
      proxies = await api.jsonRequest('/proxies')
    } catch {
      return
    }
    const pmap = proxies?.proxies
    if (!pmap) return

    const testUrl = encodeURIComponent('https://www.gstatic.com/generate_204')
    const timeoutMs = 5000

    const names = Object.keys(pmap).filter((name) => {
      const t = pmap[name]?.type
      if (!t) return false
      return ![
        'Selector',
        'URLTest',
        'Fallback',
        'LoadBalance',
        'Direct',
        'Reject',
      ].includes(t)
    })

    const concurrency = 6
    for (let i = 0; i < names.length; i += concurrency) {
      const batch = names.slice(i, i + concurrency)
      await Promise.all(
        batch.map(async (proxyName) => {
          const enc = encodeURIComponent(proxyName)
          const path = `/proxies/${enc}/delay?url=${testUrl}&timeout=${timeoutMs}`
          try {
            const d = await api.jsonRequest(path)
            const delay = Number(d?.delay) || 0
            gLat.labels(proxyName).set(delay)
            gAvail.labels(proxyName).set(delay > 0 ? 1 : 0)
          } catch {
            gLat.labels(proxyName).set(-1)
            gAvail.labels(proxyName).set(0)
          }
        }),
      )
    }
  }

  let trafficWs = null
  let trafficStopped = false
  let trafficRetry = 1000

  function startTrafficLoop() {
    if (!enableSpeed || !gUpSpeed || !gDownSpeed) return () => {}

    const connect = () => {
      if (trafficStopped) return
      trafficWs = api.createWs('/traffic')
      trafficWs.on('message', (data, isBinary) => {
        trafficRetry = 1000
        const text = isBinary ? data.toString('utf8') : data.toString()
        try {
          const j = JSON.parse(text)
          gUpSpeed.set(Number(j.up) || 0)
          gDownSpeed.set(Number(j.down) || 0)
        } catch {
          /* */
        }
      })
      trafficWs.on('error', () => {
        try {
          trafficWs?.close()
        } catch {
          /* */
        }
      })
      trafficWs.on('close', () => {
        if (trafficStopped) return
        setTimeout(connect, trafficRetry)
        trafficRetry = Math.min(trafficRetry * 2, 60_000)
      })
    }
    connect()
    return () => {
      trafficStopped = true
      try {
        trafficWs?.close()
      } catch {
        /* */
      }
    }
  }

  let stopped = false

  const needsProxiesPoll =
    enableAggNode ||
    enableAggDest ||
    detailCompact ||
    enableProxyLatency

  function start() {
    if (needsProxiesPoll) {
      void refreshProxies()
      proxiesTimer = setInterval(() => {
        void refreshProxies()
      }, proxiesPollMs)
    }

    if (enableProxyLatency) {
      void runLatencyRound()
      latencyTimer = setInterval(() => {
        void runLatencyRound()
      }, latencyIntervalMs)
    }

    if (enableTrafficByDims) {
      cleanupTimer = setInterval(() => {
        cleanupStaleTrafficByDimLabels(Date.now())
      }, trafficByLabelCleanupMs)
    }

    const stopTraffic = startTrafficLoop()

    return () => {
      stopped = true
      if (proxiesTimer) clearInterval(proxiesTimer)
      if (latencyTimer) clearInterval(latencyTimer)
      if (cleanupTimer) clearInterval(cleanupTimer)
      stopTraffic()
    }
  }

  function onConnectionsMessage(msg) {
    if (stopped) return
    if (
      enableAggNode ||
      enableAggDest ||
      detailCompact
    ) {
      applyAggregations(msg)
    }
    applyFullConnectionDetail(msg)
    if (enableTrafficByDims) applyTrafficByDimCounters(msg)
  }

  return { start, onConnectionsMessage }
}
