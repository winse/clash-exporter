# clash-exporter

> **Clash / Clash Meta** 的 Prometheus 导出器：把外接 API 上的连接与流量变成可抓取的标准指标。

---

## 它是做什么的

程序起一个轻量 HTTP 服务，对外提供 **`/metrics`**（基于 `prom-client`）。数据来自控制器的实时连接视图等能力。

- **未设置 `CLASH_HOST`**：通过 **Windows 命名管道** 访问控制器（默认 `\\.\pipe\verge-mihomo`，具体名称以 Clash Verge 等客户端为准）。
- **已设置 `CLASH_HOST`**：通过 **TCP**（`host:port`）访问外控；可配合 **`CLASH_TOKEN`**。

---

## 怎么用

### 本地运行

需要 **Node.js 18+**。在仓库根目录：

```bash
npm install
npm start
```

| 地址 | 说明 |
|------|------|
| `http://127.0.0.1:2112/metrics` | Prometheus 文本指标 |
| `/`、`/health` | 健康检查，返回 `ok` |

外控走 TCP 时，设置环境变量，例如：

```bash
export CLASH_HOST=127.0.0.1:9090
# export CLASH_TOKEN=…   # 若外控启用了密钥
```

### 接入 Prometheus

在 `scrape_configs` 里把 `targets` 指到导出器（默认端口 **2112**，可按 `PORT` 修改）。

### Docker 与监控栈

根目录提供 **`Dockerfile`**、**`docker-compose.yml`**（Exporter + Prometheus + Grafana）。先复制 **`.env.example`** 为 **`.env`**，按需改外控地址，再执行：

```bash
docker compose up -d
```

若 **Exporter 跑在 Windows 本机**、监控栈跑在容器里，请合并 **`docker-compose.windows.yml`**，并把 **`.env.windows.example`** 中的 **`PROMETHEUS_CONFIG_FILE`** 写进 **`.env`**，以便容器内 Prometheus 能抓到本机 Exporter。

### 更多配置

指标前缀、连接明细档位、`clash_traffic_by_*`、代理延迟等开关，见 **`server.mjs`** 顶部的环境变量说明与源码注释；此处不逐一罗列。

---

## 参与开发

1. **拉代码并装依赖**  
   `git clone` 后在仓库根目录执行 `npm install`。

2. **日常调试**  
   使用 `npm start` 或 `node server.mjs`。主要代码路径：
   - **`server.mjs`** — 核心 Gauge/Counter、`/connections` 主循环  
   - **`lib/api-client.mjs`** — HTTP、WebSocket、命名管道  
   - **`lib/clash-extended.mjs`** — 扩展指标与按维度统计  

3. **联调**  
   本机启用 Clash 外控后，配置管道或 `CLASH_HOST`，用浏览器或 `curl` 访问 `http://127.0.0.1:2112/metrics` 验证输出。

---

## 实现原理（简述）

| 步骤 | 说明 |
|------|------|
| **订阅快照** | 与控制器建立 **`/connections` WebSocket**，持续解析 JSON 快照；每条连接带有累计上下行字节等字段。 |
| **会话 Gauge** | 用快照中的 **`uploadTotal` / `downloadTotal`** 和**连接条数**更新 **`clash_*` Gauge**（含活跃连接数）。 |
| **流量 Counter** | 在内存中保留上一帧各连接的上下行字节，与当前帧作差，将正增量记入 **`clash_network_traffic_bytes_total`**（含 source、destination、policy、方向等标签）。 |
| **可选能力** | 另开 WS 读 **`/traffic`** 得速率；轮询 **`/proxies`** 解析出站与代理延迟；在 **`clash-extended.mjs`** 中维护 **`clash_traffic_by_*`** 等按维度的 Counter。 |
| **暴露指标** | 将 `prom-client` 的 Registry 挂到 HTTP，响应 **`GET /metrics`**。 |

---

许可证与仓库根目录一致。
