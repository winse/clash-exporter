import http from 'node:http'
import net from 'node:net'

import WebSocket from 'ws'

/**
 * @param {string} hostPort e.g. 127.0.0.1:9090
 */
export function parseHostPort(hostPort) {
  const i = hostPort.lastIndexOf(':')
  if (i <= 0) {
    return { hostname: hostPort, port: 9090 }
  }
  return {
    hostname: hostPort.slice(0, i),
    port: Number(hostPort.slice(i + 1)) || 9090,
  }
}

/**
 * @param {{ clashHost: string, clashToken: string, pipePath: string }} cfg
 */
export function createApiClient(cfg) {
  const { clashHost, clashToken, pipePath } = cfg

  const authHeaders = clashToken
    ? { Authorization: `Bearer ${clashToken}` }
    : {}

  /**
   * @param {string} path e.g. /version
   * @returns {Promise<any>}
   */
  function jsonRequest(path) {
    return new Promise((resolve, reject) => {
      const done = (err, data) => (err ? reject(err) : resolve(data))

      if (clashHost) {
        const { hostname, port } = parseHostPort(clashHost)
        const req = http.request(
          {
            hostname,
            port,
            path,
            method: 'GET',
            timeout: 15_000,
            headers: {
              Host: `${hostname}:${port}`,
              'Accept-Encoding': 'identity',
              ...authHeaders,
            },
          },
          (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8')
              const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300
              if (!ok) {
                done(
                  new Error(
                    `HTTP ${res.statusCode ?? '?'} ${path}: ${raw.slice(0, 200)}`,
                  ),
                )
                return
              }
              try {
                done(null, JSON.parse(raw || '{}'))
              } catch (e) {
                done(e)
              }
            })
          },
        )
        req.on('error', done)
        req.on('timeout', () => {
          req.destroy()
          done(new Error('request timeout'))
        })
        req.end()
        return
      }

      const req = http.request(
        {
          host: 'clash-verge',
          path,
          method: 'GET',
          timeout: 15_000,
          headers: {
            Connection: 'close',
            Host: 'clash-verge',
            'Accept-Encoding': 'identity',
            ...authHeaders,
          },
          createConnection() {
            return net.connect({ path: pipePath })
          },
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300
            if (!ok) {
              done(
                new Error(
                  `HTTP ${res.statusCode ?? '?'} ${path}: ${raw.slice(0, 200)}`,
                ),
              )
              return
            }
            try {
              done(null, JSON.parse(raw || '{}'))
            } catch (e) {
              done(e)
            }
          })
        },
      )
      req.on('error', done)
      req.on('timeout', () => {
        req.destroy()
        done(new Error('request timeout'))
      })
      req.end()
    })
  }

  /**
   * @param {string} path e.g. /connections
   */
  function createWs(path) {
    const sep = path.includes('?') ? '&' : '?'
    const qs = clashToken
      ? `${sep}token=${encodeURIComponent(clashToken)}`
      : ''

    if (clashHost) {
      return new WebSocket(`ws://${clashHost}${path}${qs}`, {
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
      })
    }
    return new WebSocket(`ws://localhost${path}${qs}`, {
      headers: {
        Host: 'clash-verge',
        ...authHeaders,
      },
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
      createConnection() {
        return net.connect({ path: pipePath })
      },
    })
  }

  return { jsonRequest, createWs }
}
