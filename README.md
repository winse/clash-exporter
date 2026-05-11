# Clash Prometheus Exporter

订阅 **Clash / Clash Meta** 控制器的 `/connections`（及可选 `/traffic`、`/proxies`），在 **`/metrics`** 输出 Prometheus 指标。支持 **Windows 命名管道**（不设 `CLASH_HOST` 时）或 **TCP**（`host:port`）。

**路径**：仓库内示例目录当前为 `examples/mihomo-exporter`；若你已把它重命名为 `examples/clash-exporter`，下文中的 `cd` 路径请相应替换。默认管道路径中的 `verge-mihomo` 来自 **Clash Verge** 实际管道名，与导出器命名无关。

---

## 使用

**依赖**：Node.js 18+  

```bash
cd examples/mihomo-exporter
npm install
npm start
```

默认监听 **`http://127.0.0.1:2112`**。

| 路径 | 说明 |
|------|------|
| `/metrics` | Prometheus 文本指标 |
| `/`、`/health` | 返回 `ok` |

**管道（如 Clash Verge）**：不设 `CLASH_HOST`，默认管道路径 `\\.\pipe\verge-mihomo`（由客户端决定），请求头使用 `Host: clash-verge`。

```powershell
$env:CLASH_PIPE = "\\.\pipe\verge-mihomo"
node server.mjs
```

**TCP 外控**：

```powershell
$env:CLASH_HOST = "127.0.0.1:9090"
$env:CLASH_TOKEN = "你的密钥"   # 可选
node server.mjs
```

Prometheus 抓取示例：

```yaml
scrape_configs:
  - job_name: clash_exporter
    scrape_interval: 5s
    static_configs:
      - targets: ["localhost:2112"]
```

---

## Docker

导出器镜像为 **Node 22 Alpine**，进程监听 **`2112`**，进程内健康检查 **`/health`**。

**工作目录**：始终在 `examples/mihomo-exporter` 下执行。

### 仅构建 / 单容器运行

```bash
cd examples/mihomo-exporter
docker build -t clash-exporter:latest .
docker run --rm -p 2112:2112 \
  --add-host=host.docker.internal:host-gateway \
  -e CLASH_HOST=host.docker.internal:9090 \
  -e CLASH_TOKEN=你的密钥 \
  clash-exporter:latest
```

### 一键栈：Exporter + Prometheus + Grafana（推荐 local）

`docker-compose.yml` 会起三个服务，同一 **bridge 网络 `monitoring`**：

| 服务 | 容器内地址 | 宿主机端口（默认） |
|------|------------|-------------------|
| clash-exporter | `clash-exporter:2112` | `${EXPORTER_PORT:-2112}` |
| Prometheus | `prometheus:9090` | `${PROMETHEUS_PORT:-9090}` |
| Grafana | `http://grafana:3000` | `${GRAFANA_PORT:-3000}` |

Prometheus 已配置抓取 **`clash-exporter:2112`**（走 Docker DNS，**不要**写 `localhost:2112`）。Grafana 已 **provisioning** 数据源 `Prometheus` → `http://prometheus:9090`，并挂载内置看板 **Clash exporter overview**（目录 **Dashboards → Clash**）。

```bash
cd examples/mihomo-exporter
copy .env.example .env   # Windows；Linux/macOS: cp .env.example .env
# 编辑 .env：至少确认 CLASH_HOST 指向宿主机上 Clash 外控
docker compose up -d
```

浏览器：**Grafana** `http://localhost:3000`（默认账号密码见 `.env.example`），**Prometheus** `http://localhost:9090`，Exporter 原始指标 `http://localhost:2112/metrics`。

停止：`docker compose down`（数据卷 `prometheus_data` / `grafana_data` 会保留；若需清空可加 `-v`）。

#### Local 网络注意（必读）

1. **Exporter → 宿主机 Clash**  
   - 默认 `CLASH_HOST=host.docker.internal:9090`。Compose 已为 Linux 加上 `extra_hosts: host.docker.internal:host-gateway`。  
   - **Docker Desktop（Windows/macOS）** 一般可直接用。  
   - **纯 Linux**：若仍解析失败，把 `CLASH_HOST` 改成宿主机 **局域网 IP**（如 `192.168.x.x:9090`），或确认 Docker 已支持 `host-gateway`。

2. **Clash 外控监听地址**  
   若外控只绑在 **`127.0.0.1:9090`**，部分环境下容器通过 `host.docker.internal` 访问会失败。请改为监听 **`0.0.0.0`**（或具体网卡 IP），再让 `CLASH_HOST` 指向可达地址。

3. **端口占用**  
   本机已有 Prometheus/Grafana 时，在 `.env` 里改 `PROMETHEUS_PORT` / `GRAFANA_PORT`，并同步修改 `GRAFANA_ROOT_URL`（浏览器访问 Grafana 的 URL），避免跳转错误。

4. **管道模式**  
   容器内 **不能用 Windows 命名管道** 连桌面客户端；Docker 场景一律 **TCP 外控** + `CLASH_HOST`。其余环境变量仍可通过 `.env` / `environment` 传入（与下文表格一致）。

配置文件位置：
- `deploy/prometheus/prometheus.yml` — 抓取与全局 `scrape_interval`
- `deploy/grafana/provisioning/` — 数据源与看板加载
- `deploy/grafana/dashboards/clash-dashboard.json` — 示例看板

---

## 环境变量

**连接**

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `2112` | 导出器监听端口 |
| `CLASH_HOST` | 空 | 非空则走 TCP；空则走管道 |
| `CLASH_TOKEN` | 空 | TCP 时 Bearer 与 WS token |
| `CLASH_PIPE` | `\\.\pipe\verge-mihomo` | 仅管道模式（路径以实际客户端为准） |

**`clash_network_traffic_bytes_total` 的标签**

| 变量 | 默认 | 说明 |
|------|------|------|
| `COLLECT_DEST` | 启用 | 设为 `false` 时 `destination` 标签恒为空字符串 |

**前缀**：`METRIC_PREFIX` 默认 `clash`。下文 **`{prefix}`** 表示该值；例如 `{prefix}_traffic_upload_speed_bytes` 默认即 `clash_traffic_upload_speed_bytes`。

| 变量 | 默认 | 说明 |
|------|------|------|
| `CLASH_ENABLE_SPEED` | 开 | `false` 关闭：`{prefix}_traffic_*_speed_bytes`（需 `/traffic` WS） |
| `CLASH_ENABLE_NODE_AGG` | 开 | `false` 关闭：按出站节点聚合的字节 Gauge |
| `CLASH_ENABLE_DEST_AGG` | 开 | `false` 关闭：按「目的地 + 出站节点」聚合 |
| `CLASH_ENABLE_PROXY_LATENCY` | 关 | 须为 `true` 启用（也可用 `CLASH_ENABLE_PROXY_DELAY`）：`{prefix}_proxy_latency_ms`、`_proxy_available` |
| `CLASH_LATENCY_INTERVAL_MS` | `60000` | 延迟探测周期；单次请求约 5s 超时 |
| `CLASH_PROXIES_POLL_MS` | `1000` | 刷新 `/proxies` 的间隔（用于解析真实出站、延迟列表） |

**每条连接的明细档位**（互斥：**`default`** | **`compact`** | **`full`**）

| 变量 | 说明 |
|------|------|
| `CONNECTION_DETAIL_MODE` | **推荐**：`default` 不按连接暴露明细；`compact` / `full` 使用**同一对指标** `{prefix}_connection_upload_bytes`、`_download_bytes`（默认即 `clash_*`），**同一套标签名**；`compact` 只在少数标签上填值、其余为空，`full` 尽量填全（高基数）。 |
| 别名 | `off` 等价 `default`；`nykma` 等价 `full`。非法值视为未设置，走下方 legacy。 |
| 未设置 `CONNECTION_DETAIL_MODE`（或无效）时 | `NYKMA_PROXY_ENABLE=true` 且 `NYKMA_PROXY_CONNECTION_DETAIL=true` → **`full`**；否则 `CLASH_ENABLE_PER_CONN=true` → **`compact`**；否则 **`default`**。 |
| | 若 NYKMA 与 `CLASH_ENABLE_PER_CONN` 两套 legacy 同时为 true，stderr 提示并采用 **`full`**。 |
| `NYKMA_PROXY_NAME` | **`full`** 模式下标签 `name`；默认 `default`。 |
| `PROXY_EXPORTER_NAME` | 同义，`NYKMA_PROXY_NAME` 优先。 |

**`clash_traffic_by_*`（按维度累计 Counter）**

| 变量 | 默认 | 说明 |
|------|------|------|
| `CLASH_ENABLE_TRAFFIC_BY_DIMS` | 开 | `false` 关闭整组 `clash_traffic_by_*` Counter |
| `CLASH_TRAFFIC_BY_SKIP_DIRECT` | 开 | `true` 时不统计代理链第一跳为 `DIRECT` 的连接 |
| `CLASH_TRAFFIC_BY_LABEL_IDLE_MS` | `3600000` | 某标签维度空闲超过此时长可从注册表移除 |
| `CLASH_TRAFFIC_BY_LABEL_CLEANUP_MS` | `60000` | 清理检查间隔 |

---

## 指标说明

**类型**：**Gauge** 一般为「当前快照」；**Counter** 单调递增，适合 `rate()` / `increase()`。  
**会话总字节与活跃连接数**：仅 **`clash_upload_bytes_total`、`clash_download_bytes_total`、`clash_active_connections`**（来自 `/connections` 快照）；其它系列不再重复这两项。

### 1. `clash_*`

| 指标 | 类型 | 标签 | 含义 |
|------|------|------|------|
| `clash_info` | Gauge | `version`, `premium` | 值为 `1`，信息在标签 |
| `clash_download_bytes_total` | Gauge | — | 当前会话累计下载字节 |
| `clash_upload_bytes_total` | Gauge | — | 当前会话累计上传字节 |
| `clash_active_connections` | Gauge | — | 活跃连接数 |
| `clash_network_traffic_bytes_total` | Counter | `source`, `destination`, `policy`, `type` | `type`=`upload`/`download`；各连接 upload/download 相对上一帧的增量；`policy` 为链上第一跳 |

`destination`：优先连接 metadata 的 `host`，否则 `destinationIP` / `remoteDestination`（受 `COLLECT_DEST` 影响）。

### 2. 扩展指标（`METRIC_PREFIX`，默认 `clash` → `clash_traffic_*` 等）

| 指标 | 默认名 | 条件 | 类型 | 标签 |
|------|--------|------|------|------|
| 上传/下载速率 | `…traffic_upload_speed_bytes` / `…download_speed_bytes` | `CLASH_ENABLE_SPEED` 未关 | Gauge | — |
| 按节点累计 | `…connection_{upload,download}_bytes_by_node` | 节点聚合未关 | Gauge | `outbound_node` |
| 按目的地+节点 | `…connection_{upload,download}_bytes_by_destination` | 目的地聚合未关 | Gauge | `destination`, `outbound_node` |
| 按连接明细 | `…connection_{upload,download}_bytes` | `CONNECTION_DETAIL_MODE=compact`（标签稀疏）或 `full`（标签尽量填满） | Gauge | 名称相同；标签键集合相同，见下表 |
| 延迟 / 可用 | `…proxy_latency_ms` / `…proxy_available` | `CLASH_ENABLE_PROXY_LATENCY=true` | Gauge | `proxy_name` |

速率来自 `/traffic` 的 `up`、`down` 字段（一般为当前速率，字节/秒；具体以 Clash 核心版本为准）。节点/目的地/按连接明细等 Gauge 表示**当前仍活跃连接**在各分组上的上传、下载字节合计。

**`{prefix}_connection_{upload,download}_bytes` 标签键（顺序固定）**  
`compact`：主要使用 `name`、`source_ip`、`host` 或 `destination_ip`、`chain`（出站）、`connection_id` 等常为空；`full`：按连接与链上每一跳填充/metadata 尽力填写。

`name`, `connection_id`, `network`, `type`, `source_ip`, `destination_ip`, `source_port`, `destination_port`, `source_geo_ip`, `destination_geo_ip`, `source_ip_asn`, `destination_ip_asn`, `inbound_ip`, `inbound_port`, `inbound_name`, `inbound_user`, `host`, `dns_mode`, `uid`, `process`, `process_path`, `special_proxy`, `special_rules`, `remote_destination`, `dscp`, `sniff_host`, `rule`, `rule_payload`, `chain`, `provider_chain`。

其中实例名 `name` 来自 `NYKMA_PROXY_NAME`（`full` 与 `compact` 均会写入）。

### 3. `clash_traffic_by_*`

| 指标 | 类型 | 标签 | 含义 |
|------|------|------|------|
| `clash_traffic_by_asn` | Counter | `asn` | 每连接上下行增量之和，按目的 ASN |
| `clash_traffic_by_client` | Counter | `address` | 按源 IP |
| `clash_traffic_by_host` | Counter | `host` | 按规范化域名 |
| `clash_traffic_by_proxy` | Counter | `proxy` | 按链第一跳名称 |

---

## PromQL 提示

- Gauge：`clash_download_bytes_total` 直接作图即可；`rate()` 不适用。
- Counter：`rate(clash_network_traffic_bytes_total{type="download"}[5m])`、`rate(clash_traffic_by_host[5m])` 等。
- 扩展 Gauge（默认前缀）：`clash_traffic_download_speed_bytes`、`clash_proxy_latency_ms` 等。
- 抓取间隔只影响采样密度，不重置 Counter。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 无 `clash_*` 或不变 | 检查 pipe / `CLASH_HOST`、Token、控制器是否对外提供 WS |
| 速率为 0 | 核对 `/traffic`；不需要可关 `CLASH_ENABLE_SPEED` |
| 时间序列极多 | 保持 **`default`** 或只用 **`compact`**；慎用 **`full`** |
| 延迟探测太频繁 | 增大 `CLASH_LATENCY_INTERVAL_MS` 或关闭 latency |

许可证与仓库根目录一致。
