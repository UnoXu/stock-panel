# 部署到云端（电脑关机也能用）

目标：手机在外用流量、**电脑完全关机**，照样能打开这个页面、看到同一份持仓。

## 为什么需要这一步

这个应用有两部分：**页面/计算** 和 **你的数据**。

- 数据现在存在这台电脑的 `state.json` 里 → 电脑一关就没了
- 页面现在由这台电脑提供 → 电脑一关就打不开

云端方案就是把**两者都搬到不依赖这台电脑的地方**：

```
手机浏览器 ─┐
            ├──▶ 云端服务（免费档即可，无状态）──▶ 免费键值存储（你的持仓 JSON）
电脑浏览器 ─┘        ↑ 换代码只换这里，数据不在容器里        ↑ 这里才是数据的家
```

**关键点：数据不在容器里。** 免费容器档没有持久磁盘（重启会清空），所以我把数据存到你自己的**免费键值存储**里，容器变成无状态的——重启、休眠、重建都不丢数据。

## 要花多少钱

**免费。** 需要两个免费账号：

| 用途 | 服务 | 免费额度（请以注册页为准） |
|---|---|---|
| 存你的持仓 JSON | Upstash Redis（免费档） | 每月几十万次命令，这个应用每天只用几十次 |
| 跑服务 | Render（免费档） | 免费实例，闲置会自动休眠，下次访问自动唤醒 |

> ⚠️ **我无法核实当前的免费条款。** 我这边抓不到 `render.com` / `koyeb.com` 的正文（被本地代理挡了），搜到的信息也互相矛盾。请你**在注册页确认**，并建议先设一个消费上限（Render: Billing → Spend Limit，比如 $0 或 $5）。

---

## 第 1 步：建免费键值存储（约 3 分钟）

1. 打开 https://upstash.com/ → 注册（可用 Google 账号）
2. 控制台 → **Create Database**
   - Name: `stock-state`
   - Type: **Redis**
   - Region: 选离你最近的（如 `ap-southeast-1` 新加坡）
3. 建好后进入数据库详情页，找到 **REST API** 区域，复制两个值：
   - **UPSTASH_REDIS_REST_URL** → 形如 `https://xxx-yyy-12345.upstash.io`
   - **UPSTASH_REDIS_REST_TOKEN** → 一长串字母数字

先把这两个值记在记事本里，第 3 步要用。

> 不用 Upstash 也行：任何**兼容 Upstash Redis REST 协议**的服务都可以（例如 Vercel KV）。只要给出 `KV_REST_URL` 和 `KV_REST_TOKEN` 两个环境变量即可。

## 第 2 步：部署到 Render

**方式 A：用 Blueprint（推荐，省事）**

1. 打开 https://render.com/ → 注册
2. 把 `stock/` 这个目录上传到一个 Git 仓库（**必须能访问 GitHub** —— 你这台机器的代理挡了 `github.com`，所以这一步可能需要在手机上或换个网络做；如果不行就用方式 B）
3. Render 控制台 → **New → Blueprint** → 选中仓库 → 它会读 `render.yaml`
4. 它会提示你填三个环境变量（见第 3 步）

**方式 B：手动创建（不需要 Git）**

1. Render 控制台 → **New → Web Service**
2. 选 **Deploy an existing image**，或者用 **Public Git repository**（同样需要能连 GitHub）
3. 若两者都不通，用**任何支持 Docker 的 VPS** 代替，直接：
   ```bash
   docker build -t stock .
   docker run -d --restart unless-stopped -p 8080:8080 \
     -e KV_REST_URL="你的URL" \
     -e KV_REST_TOKEN="你的TOKEN" \
     -e STOCK_TOKEN="你自己定的口令" \
     -e DATA_DIR=/tmp/stock-data \
     stock
   ```
   这样你拿到的是 `http://你的VPS的IP:8080`（建议再套一层 HTTPS，见文末）。

## 第 3 步：填三个环境变量

在 Render 的 Environment 页面填：

| 变量 | 值 | 说明 |
|---|---|---|
| `KV_REST_URL` | 第 1 步复制的那串 URL | 数据存哪 |
| `KV_REST_TOKEN` | 第 1 步复制的那串 token | 存储的钥匙 |
| `STOCK_TOKEN` | **你自己定一个 12 位以上口令** | 公网上必须有，否则谁拿到网址都能看你的持仓 |

> `STOCK_TOKEN` 千万别用 `-RoMQNDE0pak` 这种已出现在聊天记录里的口令，重新定一个。

## 第 4 步：等部署完成并自检

部署完（约 2~5 分钟），打开：

```
https://你的服务地址/api/health
```

**应该看到这样的返回**（关键是前两行）：

```json
{
  "ok": true,
  "storage": "kv",                                    ← 必须是 kv
  "storageTarget": "kv:xxx.upstash.io",               ← 应该是你的存储主机名
  "degraded": false,                                  ← 必须是 false
  "auth": "on"                                        ← 必须是 on
}
```

- 如果 `storage` 是 `file` → 说明 `KV_REST_URL` / `KV_REST_TOKEN` 没生效，回第 3 步检查
- 如果 `degraded` 是 `true` → 云存储连不上，看返回里的 `degradedReason`
- 如果 `auth` 是 `off` → **危险**，公网上没口令，立刻检查 `STOCK_TOKEN`

再验证口令生效（不带口令应该被拦）：

```powershell
curl.exe -i https://你的服务地址/api/health
```

## 第 5 步：手机上用

1. Safari 打开 `https://你的服务地址`
2. 第一次会让你输口令 → 填 `STOCK_TOKEN` 的值 → 之后手机记住
3. 分享按钮 → **添加到主屏幕**
4. **现在可以关电脑了** —— 服务在云上 24 小时跑着

## 第 6 步：把电脑上这份数据搬上去

云端是独立的空数据。两种做法：

**做法一：用界面导出/导入（最简单）**

1. 电脑上打开本地页面 → 「流水」页 → 点「备份 / 迁移」→「导出」，得到 `stock-backup-xxxx.json`
2. 手机上打开云端页面 → 「流水」页 → 「备份 / 迁移」→「导入」→ 选那个文件 → 确认

**做法二：命令行推（适合批量）**

```powershell
cd C:\Users\lenovo\Documents\deepseek-harness\default-workspace\stock
$h = (Invoke-RestMethod 'http://127.0.0.1:8787/api/export').state
$body = @{ state = $h } | ConvertTo-Json -Depth 8 -Compress
curl.exe -X POST "https://你的服务地址/api/import?token=你的STOCK_TOKEN" `
  -H "Content-Type: application/json" -d $body
```

> 搬完以后，电脑和云端就是**两份独立数据**，不会自动同步。日常只用云端那份即可；本地那份留着当备份。

## 怎么知道数据存在哪

页面顶栏行情时间右边有个胶囊：

| 胶囊 | 含义 |
|---|---|
| **云同步** | 数据在云端，电脑关机也能用，多设备共用同一份 |
| **本机文件** | 数据在这台电脑上（局域网/Tailscale 模式） |
| **云存储异常 · 只读** | 云端读不到了，正在用上次同步的本地副本；**此时改动不会保存**（会被拒绝，不会丢数据） |

## 出问题怎么办

| 现象 | 原因 / 怎么查 |
|---|---|
| 首次打开等 30~60 秒 | 免费档闲置会休眠，首次访问要唤醒。正常 |
| `storage` 说 `file` | 两个 KV 变量没生效，回第 3 步 |
| `degraded: true` | 云存储连不上：检查 Upstash 是否被删/超额、token 是否被轮换 |
| 谁都能打开、不用口令 | `STOCK_TOKEN` 没设成功；改完要重新部署 |
| 页面胶囊写「云存储异常 · 只读」 | 存储暂时不可用。**不要**在这里改数据（会被拒），等恢复 |
| 想省钱/停掉 | Render 免费档本来就会自动休眠，不用管；彻底不要了就删掉服务（**先导出备份**） |
| 数据怎么备份 | 页面「导出」按钮，或 `GET /api/export` |

## 换其他平台

代码是标准 Node 应用，也是标准 Docker 镜像，所以换平台成本很低。**唯一不能省的三件事**：

1. `KV_REST_URL` + `KV_REST_TOKEN` 指向你的键值存储
2. `STOCK_TOKEN` 设成你自己的口令
3. 走 HTTPS

除此之外，`Dockerfile` 可以直接扔给任何支持 Docker 的地方（VPS / Koyeb / Zeabur / Railway）。

**自建 VPS 想加 HTTPS**：用 Caddy 最省事，一个 `Caddyfile` 两行：

```
你的域名.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 会自动申请并续期证书。
