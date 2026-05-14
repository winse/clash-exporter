# clash-exporter

面向 **Clash / Clash Meta** 的 Prometheus 导出器：**先** **`GET /version`** 成功（确认外控可用），**再** 监听 HTTP 提供 **`/metrics`**；之后 **`/connections`**（WebSocket）、**`/traffic`** 等。每次 **`/connections` 握手成功** 会再拉一次 **`/version`** 刷新 `clash_info`。

---

## 运行

需 **Node.js 18+**（本仓库 **`Dockerfile`** 镜像为 Node 22）。根目录执行 `npm install` 后 `npm start`（等同 `node server.mjs`）。

| 地址 | 说明 |
|------|------|
| `http://127.0.0.1:2112/metrics` | 指标文本（**仅在** 已与 Clash 通了 **`/version` 之后** 才监听端口） |
| `/`、`/health` | 返回 `ok`（**同上**，`/version` 未成功前端口未打开） |

- **未设置 `CLASH_HOST`**：走 **Windows 命名管道**（默认 `\\.\pipe\verge-mihomo`，以实际客户端为准）。控制器若配置了 **`secret`**，请同样设置 **`CLASH_TOKEN`**（与 TCP 一致：`Authorization: Bearer …`，WebSocket 会带 `token` 查询参数）。
- **设置了 `CLASH_HOST`**：TCP `host:port`，可选 **`CLASH_TOKEN`**（外控 `secret`）。
- **等待 `/version`**：在交互式终端（`stdin` 为 TTY）运行时，可随时 **按 Enter** 跳过当前退避间隔、**立刻再请求**一次 `/version`。非 TTY（如 Docker 无 `-it`）则只有定时退避。

**Docker / 监控栈**：`docker-compose.yml`；若 Exporter 在本机、Prom 在容器里，合并 **`docker-compose.windows.yml`**，并把 **`.env.windows.example`** 里的变量并到 **`.env`**。本仓库另有 **`start-docker-stack.bat`**、`destroy-docker-stack.bat`（Compose 带卷拆除）可辅助 Windows 环境。

---

## 常用环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `2112` | HTTP 端口 |
| `CLASH_HOST` / `CLASH_TOKEN` / `CLASH_PIPE` | 见上 | 控制器访问方式；**`CLASH_TOKEN`** 在 **管道与 TCP** 下均表示外控 **`secret`** |
| `COLLECT_DEST` | 启用 | 为 `false` 时 **`clash_network_traffic_bytes_total` 的 `destination` 恒为空** |
| `METRIC_PREFIX` | `clash` | 扩展指标名前缀（下称 `{prefix}`） |
| `CLASH_ENABLE_SPEED` | 开 | `false` 关闭 `{prefix}_traffic_*_speed_bytes`（`/traffic` WS） |
| `CLASH_ENABLE_PROXY_LATENCY` 或 `CLASH_ENABLE_PROXY_DELAY` | 关 | 为 `true` 时启用 `{prefix}_proxy_latency_ms`、`_proxy_available` |
| `CLASH_LATENCY_INTERVAL_MS` | `60000` | 代理延迟探测周期（毫秒），仅在上两项为 `true` 时生效 |

其余与部署相关的说明见 **`server.mjs` 文件头注释** 与 Compose 注释。

---

## 核心指标 `clash_*`（无前缀）

- **`clash_info`**：**在与外控 **`GET /version`** **首次成功后**写入；**`/connections`** 每次握手成功再拉一次。**未**连上 Clash 时进程会**阻塞并重试**，此时 **不** 监听 **`PORT`**，故无 **`/metrics`** / **`/health`**。不会出现仅作占位用的 **`unknown`** 标签（除非 API 真返回该 `version` 字符串）。
- **本节表中除 `clash_info` 外的指标**：来自 **`/connections` WebSocket** 快照流（与各连接的 `upload` / `download` 差分）。

| 指标 | 类型 | 标签 | 含义 |
|------|------|------|------|
| `clash_info` | Gauge | `version`, `premium` | 核心版本（非连接流） |
| `clash_download_bytes_total` | Gauge | — | **控制器整场会话**累计下载 |
| `clash_upload_bytes_total` | Gauge | — | **控制器整场会话**累计上传 |
| `clash_active_connections` | Gauge | — | 当前快照中的活跃连接数 |
| `clash_network_traffic_bytes_total` | Counter | `source`, `destination`, `policy`, `type` | 同上差分记入 Counter；多分一维 **`destination`**（可按 `COLLECT_DEST` 置空）；`policy`=链首跳，`type`=`upload`\|`download`。 |
| `clash_connection_bytes_total` | Gauge | `source`, `policy`, `type` | **同一套连接差分的累计**（**含 `DIRECT`**），不按 `destination` 拆维；从 **本 exporter 进程启动**起对各标签 **`inc`**（重启归零）；`type`=`upload`\|`download`。 |

会话 Gauge 为控制器总账本；**Counter / 本条** 仅覆盖快照里可走差分的连接，与总会话量可能不一致。

---

## 扩展指标

- **`{prefix}_traffic_{upload,download}_speed_bytes`**：`CLASH_ENABLE_SPEED` 时，`/traffic` WS。
- **`{prefix}_proxy_latency_ms` / `{prefix}_proxy_available`**：`CLASH_ENABLE_PROXY_LATENCY`（或 `_PROXY_DELAY`）为 `true`；按 **`CLASH_LATENCY_INTERVAL_MS`**（默认 60s）探测。

按连接的字节累计：**`server.mjs`**（**`clash_network_traffic_bytes_total`** / **`clash_connection_bytes_total`**）。**`lib/clash-extended.mjs`** 仅实现 **`{prefix}_traffic_*_speed_bytes`** 与 **`{prefix}_proxy_*`**。

---

## PromQL 提示

- **Gauge**（会话 **`clash_{upload,download}_bytes_total`**、**`clash_connection_bytes_total`**、活跃连接数）：看瞬时或序列，**勿对 Gauge 用 `rate()`**。
- **Counter**（`clash_network_traffic_bytes_total`）：**`increase(...[$__range])`**、**`rate(...[5m])`**。
- **连接累计总和（示例 Overview）**：`sum(clash_connection_bytes_total{...})`，与大盘 `source`/`policy`/`type` 变量一致即可。

示例大盘：**`deploy/grafana/dashboards/clash-dashboard.json`**。

---

## 开发

主要路径：`server.mjs`（核心）、`lib/api-client.mjs`、`lib/clash-extended.mjs`。

许可证与仓库根目录一致。
