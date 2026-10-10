# 期货 20 日涨跌幅 rank20 看板

每日自动同步**国内六大期货交易所官方数据** → 复现「主力合约 20 日涨跌幅」口径 →
局域网 Web 看板展示涨幅榜 / 跌幅榜各 20 名，点行就地展开日K线、硬逻辑与数据溯源。

---

## 实现功能

**核心口径**（完整规则与实测论证见 `docs/06`、`docs/09`）

```
20 日涨跌幅 = (今日收盘价 − 基准日结算价) / 基准日结算价 × 100
基准日 = T−20 个交易日    主力 = T−1 日成交量最大者（且须在 T−20 有基准价）
```

| # | 功能 | 状态 |
| --- | --- | --- |
| D1 | 主力合约 **20 日涨跌幅 rank20**（涨幅榜 + 跌幅榜各 20 名） | ✅ 已交付，与已对账值 **34/34** 逐条命中 |
| D2 | 幅度数据：当日涨跌%、最新价、持仓量(变化)、成交量、成交额、基准价/基准日 | ✅ |
| D3 | rank20 品种**日 K 线**：官方日报优先 → 新浪补历史 → 实时滚动「形成中那根」，原生 Canvas 手绘 | ✅ |
| D4 | 硬逻辑面板：方向 / 做多做空逻辑 / 涨跌题材 / 龙头地位 / 确认日 / 失效条件 | ⚠️ 规则推导 v1；**LLM 归因未接入**，面板如实标注 |

**看板与交互**

- **涨 / 跌双榜为页面主体**：各 20 行**一屏看全、榜内零滚动条**（行高由视口高度反推，矮于 620px 才整页滚动）。
- 点任意行**就地向下展开**四个等高板块：日K图 / 硬逻辑 / 题材龙头 / 数据溯源；板块内部同样不滚动。
- 日K图支持滚轮缩放、拖动平移、点击固定读数；每根 K 线标注来源（`eod` 官方 / `sina` 补齐 / `live` 实时）。
- 顶栏：交易日、基准日、行情时间、延迟、连接/数据源/换价三个状态徽章、品种搜索；支持键盘操作。
- **运行状态模块**（默认折叠）：① 7 个数据源的真实地址 + 连通性 + 实测延迟，本地产物三件状态；
  ② 模型 API 输入框与服务端连通性测试（Key 只存服务端、页面只显示掩码）。
- 盘中**每 1.5s 刷新**（SSE 推送）；休市时按设计零请求并展示日报口径，顶部横幅明确标注。

**自动化与可信度**

- 每日 **09:00** 自动出表：`rank20/YYYY年MM月DD日HH时.md` / `.csv` / `latest.md` / `base.json`（幂等，当日已完成则跳过）。
- 六所**完整性校验**：最新交易日六所数据必须齐全，否则整轮退回上一完整交易日（防半截数据算出错榜）。
- 流量闸门：单轮 1 个请求、≤1 req/s、≤60 req/min、≤40,000 req/日，非交易时段零请求。
- **验收**：`npm test` 一键跑 13 套（含依赖传递闭包"零第三方依赖"证明、密钥安全、口径命中回归）。

---

## 快速开始

**要求**：Node.js ≥ 20.10（实测 v24.21.0）。运行时**不需要**任何 npm 包。

```bash
# 1) 取代码
git clone <your-repo-url> && cd <repo>

# 2) 配置凭据（只有大商所需要；其余五所是公开接口）
cp .env.example .env        # Windows: copy .env.example .env
#   编辑 .env 填 DCE_API_KEY / DCE_SECRET（大商所官网免费注册：数据 → API 服务）

# 3) 跑一次日报（首次约 2–3 分钟：32 个工作日 × 六所）
node standalone/daily-job.mjs

# 4) 启动：每日 09:00 调度器 + 实时服务 + 前端
node standalone/start.mjs
#   浏览器打开  http://127.0.0.1:8899/     局域网：http://<本机IP>:8899/
```

`package.json` 里的快捷脚本：

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动全栈（= `node standalone/start.mjs`） |
| `npm run daily` | 幂等跑一次日报 |
| `npm run serve` | 只起实时服务与前端 |
| `npm run build` | 重新构建 `rank20-daemon`（改了 `src/**.ts` 才需要，先 `npm install`） |
| `npm test` | 一键跑完全部验收（`--fast` 跳过需要真实数据的套件） |
| `npm run audit` | 发布前审计（密钥 / 绝对路径 / 运行时产物 / 体积） |
| `npm run status` | 前后端运行体检（默认探测 `127.0.0.1:8899`） |

> 只想要日报文件、不想常驻服务：跑 `npm run daily` 即可，产物落在 `rank20/`。

---

## 配置方法

全部通过**环境变量或仓库根目录 `.env`**（模板 `.env.example`）。真实环境变量优先于 `.env`。
**凭据只从这里读取，源码与文档里不留任何真实值**（有回归测试守着这条红线）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DCE_API_KEY` / `DCE_SECRET` | 无（**必填**） | 大商所官方 API 凭据；缺失会让当日数据不完整并退回上一完整交易日，报错会指出获取方式 |
| `DCE_HOST` | `www.dce.com.cn` | 自建代理 / 镜像时覆盖 |
| `RT_HOST` / `RT_PORT` | `0.0.0.0` / `8899` | 监听地址与端口（前端即 `http://<本机IP>:<port>/`） |
| `RT_INTERVAL_MS` | `1500` | 盘中轮询节拍（实测数据源约 500ms 一拍） |
| `RT_BACKOFF_MS` / `RT_IDLE_ROUNDS` / `RT_TIMEOUT_MS` | `5000` / `10` / `5000` | 无变化退避、退避阈值、单请求超时 |
| `RT_MAX_RPS` / `RT_MAX_RPM` / `RT_MAX_RPD` | `1` / `60` / `40000` | 流量闸门（硬约束，超过自动延长节拍） |
| `RT_STORE_MS` / `RT_NAME` | `10000` / `盘中实时` | 落库节流、实时榜文件名 |
| `RT_BASE` / `RT_OUT` / `RT_VAR` | `<repo>/rank20/base.json` / `<repo>/rank20` / `<repo>/realtime-server/var` | 基准表、产物目录、服务目录 |
| `TSC_JS` / `ESBUILD` | 自动探测 | 仅构建时用；默认取本仓库 `node_modules` |

**模型 API**（接口地址 / 模型名 / API Key）**不放在环境变量里**：由前端「运行状态 → 模型 API」填写，
保存在服务端 `<repo>/realtime-server/var/model.json`（权限 0600）；页面只显示掩码 `sk-********1234`，
**绝不明文回传**，提交后输入框立即清空。连通性测试在服务端发起（先 `POST /chat/completions`，失败退 `GET /models`）。

---

## 架构与数据源

```
        ┌──────────────────── rank20-daemon/（纯产品库，零依赖）────────────────────┐
        │ exchanges.ts 六所官方日报抓取 ｜ rank20.ts 主力判定/基准日/20日涨跌幅/排序 │
        │ basetable.ts 基准表 base.json ｜ kline.ts 三层日K合成 ｜ env.ts 凭据读取   │
        └───────────────────────────────────────────────────────────────────────────┘
                 │ 写                                        ▲ 读（唯一契约：base.json）
                 ▼                                           │
  每日09:00 ┌────────────────────┐              ┌──────────────────────────────────────┐
  ─────────▶│ standalone/         │              │ realtime-server/（零依赖后端+前端）  │
            │ scheduler+daily-job │              │ poller 盘中1.5s轮询 → ranker 重算     │
            │ 产出 rank20/*.md|csv│              │ server REST + SSE(/events) + 静态页   │
            └────────────────────┘              │ web/ 原生 DOM + Canvas，无框架        │
                                                └──────────────────────────────────────┘
                                                              │ SSE
                                                              ▼  浏览器 http://<IP>:8899/
```

- **单向数据依赖**：采集端只写 `rank20/base.json`，实时端只读它，schema 严格校验（版本 / 字段不符即拒绝加载）。
- **一件事只让一个组件做**：实时轮询归 `realtime-server`，每日日报归 `standalone/scheduler`。
- **可选的 DSH 适配壳**：`rank20-daemon/src/index.ts` + `lib/` 只是把同一套逻辑挂到 DSH 宿主的薄壳，
  产品运行时不引用它，删掉照跑（`standalone/test/verify-independence.mjs` 用传递闭包证明）。

| 数据源 | 用途 | 接口（`{YYYYMMDD}` 为交易日） | 认证 |
| --- | --- | --- | --- |
| 上期所 SHFE | 日报：结算价 / OHLC / 持仓 / 成交额 | `GET /data/tradedata/future/dailydata/kx{YYYYMMDD}.dat` | 公开 |
| 能源中心 INE | 同上 | `GET www.ine.cn/data/tradedata/future/dailydata/kx{YYYYMMDD}.dat` | 公开 |
| 郑商所 CZCE | 同上 | `GET /cn/DFSStaticFiles/Future/{YYYY}/{YYYYMMDD}/FutureDataDaily.txt` | 公开 |
| 大商所 DCE | 同上（含月均价 `F` 合约） | `POST /dceapi/forward/publicweb/dailystat/dayQuotes` | **需 API 凭据** |
| 广期所 GFEX | 同上 | `POST /u/interfacesWebTiDayQuotes/loadList`（需 Origin/Referer） | 公开 |
| 中金所 CFFEX | 同上（股指 / 国债） | `GET /sj/hqsj/rtj/{YYYYMM}/{DD}/{YYYYMMDD}_1.csv` | 公开 |
| 新浪财经 | 盘中实时价、历史日K补齐 | `GET hq.sinajs.cn/list=<合约>`（需 Referer） | 公开 |

官方日报是**权威值**（结算价、成交额）；实时源只用于「正在形成的那一根」与当日最新价。

### 仓库结构

```
.
├── README.md / LICENSE(MIT) / requirements.txt / package.json / .env.example / .gitignore / .gitattributes
├── docs/                      ← 规格与实测报告 00–12（口径权威规格、实时规格、独立性、发布说明）
├── tools/
│   ├── audit-publish.mjs      ← 发布前审计（密钥 / 绝对路径 / 运行时产物 / 体积）
│   ├── run-tests.mjs          ← 一键跑完全部验收套件
│   └── probes/                ← 一次性核查脚本（源字段位、实时节拍、口径对比…）
├── rank20-daemon/             ← 采集 + 口径 + 日K合成（TypeScript）
│   ├── src/                   ← 源码（exchanges / rank20 / basetable / kline / env / 可选插件壳）
│   ├── dist/                  ← 构建产物，**已入库**：零依赖，standalone 与 realtime-server 直接 import
│   ├── lib/                   ← 【不入库】可选的 DSH 适配壳，`npm run build` 生成
│   ├── test/ test-run.mjs     ← 回归（凭据安全 / 生命周期 / 口径命中）
│   ├── run-now.mjs build.mjs cordis.patch.yml
├── realtime-server/           ← 实时后端 + 局域网前端（零依赖）
│   ├── src/                   ← poller / ranker / server / store / kline / logic / sources…
│   ├── web/                   ← index.html + app.js + style.css（原生 Canvas，无框架）
│   └── test/                  ← 验收与体检脚本（verify* / status / audit-frontend）
├── standalone/                ← 脱离任何宿主的一键入口
│   ├── start.mjs scheduler.mjs daily-job.mjs
│   └── test/                  ← 独立运行验收 + 独立性验收
└── rank20/                    ← 【运行时生成，不入库】日报 md/csv、base.json、kline/、盘中实时.*
```

---

## 许可与免责

本项目采用 **MIT License**（见 [`LICENSE`](LICENSE)）：`Copyright (c) 2026 fyc`。

- **MIT 只覆盖本仓库的代码与文档**。行情数据版权归各交易所所有；本项目只做**本地自用**的抓取与展示，
  **不再分发原始数据**。交易所接口文档（`docs/*.docx`）与从发布 sourcemap 还原的第三方注入器源码
  （`super-injector-src/`）**都不在本仓库内**，也不在 MIT 授权范围内。
- 本项目为**局域网内部自用**工具：不上公网、不对外提供接口、不转售数据。**不带鉴权**，请勿暴露到公网。
- **不抓取文华页面、不逆向 wh6/wh7 客户端、不使用其私有协议**；「与文华一致」仅指**口径复现**，
  与文华财经无任何关联。
- 使用者需自行遵守各交易所接口的使用条款与频率限制（本项目已内置保守闸门）。
- 软件按 MIT 条款「按原样提供」，**不构成任何投资建议**。
