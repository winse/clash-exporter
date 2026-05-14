/**
 * Extended Clash metrics ({prefix}_*): /traffic speed + optional proxy latency probes.
 * Per-connection totals: `clash_connection_bytes_total` in server.mjs.
 */
import client from 'prom-client'

/**
 * @param {import('prom-client').Registry} register
 * @param {object} opts
 */
export function createClashExtendedMetrics(register, opts) {
  const { prefix, api, enableSpeed, enableProxyLatency, latencyIntervalMs } =
    opts

  const fq = (name) => `${prefix}_${name}`

  let gUpSpeed
  let gDownSpeed
  let gLat
  let gAvail

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

  let latencyTimer = null

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

  function start() {
    if (enableProxyLatency) {
      void runLatencyRound()
      latencyTimer = setInterval(() => {
        void runLatencyRound()
      }, latencyIntervalMs)
    }

    const stopTraffic = startTrafficLoop()

    return () => {
      if (latencyTimer) clearInterval(latencyTimer)
      stopTraffic()
    }
  }

  return { start }
}
