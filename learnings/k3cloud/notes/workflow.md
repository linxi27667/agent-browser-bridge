# 金蝶云星空 (K3Cloud HTML5) 自动化经验笔记

> 2026-11-09 在 `http://10.1.3.38/K3Cloud`（`101 广州高昌`）实机验证。可复用代码在 `tools/k3-actions.cjs`，CLI 入口 `tools/open-bill.cjs`。

## 1. 上下文门禁与会话

- 门禁：`k3.K3_GUARD`（已登录、非登录页、顶部全局搜索存在）。登录页门禁：`!!document.getElementById('btnLogin')`。
- 打开方式：`withDedicatedTab({ url: 'http://10.1.3.38/K3Cloud' }, fn)`。业务地址默认复用同源标签页，**结束或抛错都不关闭标签页**。
- 登录：凭据只从 Obsidian `密码簿.md` 读取，不写进脚本或 Git。`#user` 获得焦点时会自动取消选中，`fillNative` 已先清空再输入。
- 组织：单据属于哪个组织就切到哪个组织再查。`26GC054`（西班牙 FRAIN）及其链路单据都在 **`101 广州高昌`**，在 `102 广州赫力` 下查不到。

## 2. 多 Agent 必须串行（“打架”的根因）

- 同一金蝶账号、同一浏览器端口，同一时间只能有一个任务在操作。两个 Agent 同时点同一页签会互相抢焦点、关掉对方打开的页签。
- 库已强制：
  - 标签页被其他存活进程租用时，`attachTarget` 和直连页面调试地址都会抛 `CDP_TARGET_LEASED`；
  - `withDedicatedTab` 发现同站点标签页都被占用时，默认**排队等待**（`leaseWaitMs` 默认 60 秒），不会另开第二个金蝶标签页并行操作。需要立即失败用 `onLeased: 'fail'`，确实要并行用 `onLeased: 'newTab'`（金蝶不建议）。
- 锁只对使用本库的程序有效。任务开始前确认 Cursor / Codex 等其他会话没有在跑金蝶脚本。

## 3. 打开单据列表（顶部全局搜索）

- `input.kd-appplat-searchinput` 只搜**应用菜单**，不能搜单号。它只监听 keydown/keyup，输入后要点一下 `.kd-fullSearchList-header-searchresult-container`（“搜索 …”）候选才按新关键词刷新。
- 点候选的**标题** `.kd-fullsearch-item-headertitle`，不要点整行中心。
- 下拉菜单正好盖在列表工具栏“票据查询 / 业务查询 / 凭证”上方，点完后鼠标留在原地会触发下方按钮的悬停下拉。点击一律带 `{ parkPointer: true }`。
- 封装：`k3.openListBySearch(page, { query: '生产入库单列表', exclude: '简单' })`。会先关掉旧页签，等页签激活、快捷过滤栏就绪、加载遮罩消失。

## 4. 按单据编号过滤

- 首个快捷过滤字段不一定是“单据编号”（`生产入库单列表` 默认是“物料编码”），先 `k3.ensureQuickFilterField(page, '单据编号')`。
- 只点一次蓝色放大镜 `a.kd-filterquicker-btnSearch-container`。**不要“回车 + 点按钮”**：会连发两次查询，第二次重绘会把刚出现的单号链接销毁，导致点空。
- 每次查询后等 `.k-loading-image / .k-loading-mask` 消失再读网格或截图，否则截到转圈空表。
- 默认方案可能带日期条件，查不到就点“重置”再查。封装：`k3.filterByBillNo(page, billNo)`。

## 5. 打开单据：注意“修改”模式

- 点蓝字单号会按当前用户权限打开，常见标题是 `xxx - 修改`。已审核单据改不了，但**创建/暂存状态的单据以修改模式打开会占用网控锁**，同事再打开会提示“…冲突，请稍候再使用”（11-09 实际撞到胡湘果正在改 `XSCKD040422`）。
- `k3.openBill` 返回 `{ mode, billStatus, conflict, editable }`。`editable === true` 时读完必须 `k3.closeActiveBillTab(page)`；`open-bill` 工具默认自动关闭。
- 本库从不点保存/提交/审核；关页签遇到“是否保存”一律选“否”。

## 6. 序列号查询

- 入口因单据而异：销售出库单在顶部工具栏直接有“序列号”；生产入库单在“业务操作”下拉里。`k3.openSerialView(page)` 两种都会尝试，并等“查询进度 / 正在取数”结束。
- 生产订单（如 `MO020234`）没有可用的序列号入口（隐藏页签、菜单里也没有），序列号在入库/出库环节才产生，用生产入库单和销售出库单取证。
- 11-09 实测：`SCRK00087170` 2 条（`BF-MSL-003/004`）；`XSCKD040422` 17 条。

## 7. 截图

- `cdp.capturePagePng(page, outPath, guard)` 会自动隐藏桥接自己的 HUD 提示，截完恢复（需要保留时设 `page.captureIncludeHud = true`）。
- 内部页签用 `li.contentHeadEL span.mainTabCloseButton` 关闭，`k3.closeInnerTabs(page)` 会先关弹窗再从最后一个关起。
