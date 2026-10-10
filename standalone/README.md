# standalone —— 脱离 DSH 的独立运行入口

目标：**只装 Node 20+，不装 DSH**，就能跑通「抓数据 → 算 rank20 → 出日报 → 实时刷新 → 局域网看板」全链路。

## 一、为什么可以脱离

| 组件 | 依赖 |
| --- | --- |
| `standalone/`（本目录） | 仅 `node:*` |
| `realtime-server/`（后端 + 前端） | 仅 `node:*`（HTTP / SSE / 静态资源都在标准库里） |
| `rank20-daemon/dist/` 的算法模块<br>`exchanges.js` `rank20.js` `net.js` `realtime.js` `basetable.js` `naming.js` `types.js` | 仅相对路径 + `node:*` |

**唯一带三方依赖的是 `rank20-daemon/dist/index.js`** —— 那是 **DSH 插件外壳**（import `schemastery`），独立入口**不加载它**。

依赖方向是单向的，且是"数据契约"而非代码耦合：

```
standalone/daily-job.mjs ──写──▶ rank20/base.json ──读──▶ realtime-server ──▶ 浏览器
      （每日一次）                  （唯一契约）              （盘中每 1.5s）
```

`base.json` 的 schema 由 `rank20-daemon/dist/basetable.js` 定义（`schemaVersion: 1`），
消费端 `realtime-server/src/base.mjs` 做严格校验：字段缺失/版本不符即**拒绝加载**并报错。

## 二、快速开始

```powershell
cd <repo>/standalone          # 换成你的实际仓库路径

# 一键启动：日报调度 + 实时服务 + 前端
node start.mjs
# 浏览器打开  http://127.0.0.1:8899/
```

启动后终端会打印本机与局域网地址。

## 三、命令

| 命令 | 作用 |
| --- | --- |
| `node start.mjs` | 一键启动（调度器 + 实时服务 + 前端），默认端口 8899 |
| `node start.mjs --port 9000` | 换端口 |
| `node start.mjs --serve-only` | 只起实时服务与前端（不跑日报调度） |
| `node start.mjs --daily-only` | 只跑日报调度（不起前端） |
| `node start.mjs --no-catchup` | 启动时若当日未跑也不补跑，只等 09:00 |
| `node daily-job.mjs` | 幂等跑一次日报（当日已完成则跳过） |
| `node daily-job.mjs --force` | 强制重跑 |
| `node daily-job.mjs --out <dir>` | 指定输出目录（默认 `<workspace>/rank20`） |
| `node scheduler.mjs` | 只跑常驻调度器（每日 09:00） |
| `node scheduler.mjs --once` | 只做一次幂等检查+按需补跑后退出（给系统计划任务用） |
| `node test/verify-standalone.mjs` | 独立运行验收（真跑日报时 29 项；`--skip-daily` 复用已有数据 25 项） |
| `node test/verify-independence.mjs` | 独立性验收：产品入口依赖闭包**零第三方包**（20 项） |

## 四、产物

| 文件 | 频率 | 说明 |
| --- | --- | --- |
| `rank20/YYYY年MM月DD日HH时.md` / `.csv` | 每日一次 | 日报快照（涨幅榜 20 + 跌幅榜 20） |
| `rank20/latest.md` | 每日一次 | 日报固定入口 |
| `rank20/base.json` | 每日一次 | **实时服务的唯一输入**（基准表） |
| `rank20/base-<交易日>.json` | 每日一次 | 按交易日留档 |
| `rank20/盘中实时.md` / `.csv` | 盘中每 1.5s | 实时榜（休市时为日报口径） |
| `standalone/var/*.log`、`*.state.json` | 运行时 | 本目录自己的日志与状态 |

## 五、与 DSH 插件版共存

`rank20-daemon`（DSH 插件）与本目录的 `daily-job.mjs` **产出同一套文件、同一份 base.json 契约**，
并且都用**同一个幂等判据**：`rank20/base.json` 的 `generatedAt` 是否属于本地今天。

因此两边同时存在也不会重复抓取 —— 先跑完的那个当天生效，另一个直接跳过：

```
⏭ 今日已完成，跳过抓取 —— 当日 base.json 已存在（generatedAt=2026-09-20T06:21:14.198Z，交易日 20260918）
```

要完全脱离 DSH，只需**不启动 DSH**，用 `node start.mjs` 替代即可；插件仍留在 profile 里不影响。

## 六、用系统计划任务代替常驻调度器（可选）

不想常驻进程时，让 Windows 计划任务每天 09:00 跑一次即可（幂等，重复触发无害）：

```
程序：   node
参数：   "<repo>\standalone\scheduler.mjs" --once
起始于： <repo>\standalone
```

（`<repo>` 换成你的实际仓库路径；`--once` 是幂等的，重复触发无害。）

实时服务仍用 `node start.mjs --serve-only` 常驻。

## 七、验收

`node test/verify-standalone.mjs` 覆盖：

- **A** 独立运行时闭包零三方依赖、零 `cordis`/`@deepseek-ai`/`dsh-*` 引用（静态扫描）
- **B** 每日任务真跑一次 → `base.json`（schemaVersion / 品种数 = 基准表行数 / 铁律字段）+ md/csv 台账
- **C** 幂等：当日已完成则跳过，不重复抓取
- **D** 实时服务独立加载 `base.json` → HTTP / SSE / 快照完整（休市时断言为"全量日报口径"）
- **E** 前端页面区块：双榜 / 日K线面板 / 硬逻辑面板 / 溯源 Tab / 状态徽章 / 合规页脚

## 八、边界与已知限制

1. **首次运行需要约 2–3 分钟**（32 个工作日 × 六所日报）。之后每天一次，且当日已完成会跳过。
2. **需要 `.env` 里的 DCE 凭据**（大商所官方 API）。缺失会导致当日数据不完整并退回上一完整交易日；
   错误信息会明确告诉你去哪申请（见根目录 `.env.example`）。
3. **`rank20-daemon/dist` 已随仓库提供**，无需构建即可运行；只有改了 `src/**.ts` 才需要
   `npm install && npm run build`（工具链是本仓库的 devDependencies，不依赖任何外部检出）。
4. **休市时段**（周末/节假日/收盘后）轮询器按设计不发请求，前端展示的是基准表播种的**日报口径**榜单，
   页面顶部会明确标注"数值非实时"。
5. **月均价合约**（DCE `ppF` / `lF` / `vF` 等）公开实时源没有行情，始终沿用日报值并打 `○日报` 标记。
6. 单机自用定位：绑 `0.0.0.0` 供局域网访问，**不带鉴权**，不要暴露到公网。
