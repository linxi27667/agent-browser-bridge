# 金蝶云星空 (K3Cloud HTML5) 自动化经验笔记

## 1. 核心上下文门禁 (`guardExpression`) 与会话复用

- 推荐使用：`location.origin === 'http://10.1.3.38' && !document.getElementById('btnLogin')`
- **严禁误关业务标签页**：使用 `withDedicatedTab({ url: 'http://10.1.3.38/K3Cloud' }, fn)` 或 `withLeasedTarget({ urlIncludes: '10.1.3.38' }, fn)`。对于 `http(s)://` 业务地址，`withDedicatedTab` 默认复用同源未上锁页签且 `keepOpen = true`（任务结束或抛错均不关闭标签页）。切勿在脚本中对业务页签手动调用 `Target.closeTarget`。
- 登录态与验证码处理：若遇到滑块或短信验证码，必须调用 `cdp.waitForUserAuth` 或 `cdp.captureUniquePng` 交由用户确认，严禁将账套密码写入脚本或 Git 仓库。

## 2. 避免使用动态生成 ID，优先使用语义定位器与唯一可见收敛

- 金蝶 HTML5 界面每次打开页签会生成动态前缀 ID（如 `F83920_...`），且后台非活动页签仍保留在 DOM 中（处于隐藏状态）。
- `interaction.js` 与 `locator.js` 已对普通 CSS 选择器及语义定位器全部启用**唯一可见元素自动收敛**（当 DOM 存在多个同名节点但仅 1 个可见时自动命中可见节点）。
- 全页截图可直接调用 `await cdp.capturePagePng(page, destPngPath, guard)`（或 3 参数 `await cdp.captureUniquePng(page, destPngPath, guard)`）。
- `cdp.waitFor` 支持最高 `300000ms`（5 分钟）超时等待，冷启动登录可直接传 `{ timeoutMs: 90000 }`。

## 3. 顶部全局搜索（应用菜单）与列表内单号过滤规范

1. **区分“应用菜单搜索”与“单据编号过滤”**：
   - 顶部搜索框 `input.kd-appplat-searchinput` 默认作用范围为**应用菜单**，仅用于搜索并打开单据列表（如 `收款单列表`、`销售订单列表`、`生产订单列表`），**不能**直接输入业务单号（如 `26GC054`、`MO020234`）。
2. **正确点击搜索候选（避免点中行中央空白区）**：
   - `li.kd-fullsearch-item-container` 是整行宽容器，可点击标题位于左侧 `.kd-fullsearch-item-headertitle`。点击搜索结果时应定位 `.kd-fullsearch-item-headertitle`（而非 `li` 容器几何中心），并在打开后点击顶部对应页签头 `li.contentHeadEL` 确保切出全功能菜单抽屉。
3. **在单据列表内按单号检索并打开整单**：
   - 进入目标单据列表页签后，使用列表工具栏下方的快捷过滤输入框（如 `input[placeholder*="关键字"]`）或过滤弹窗输入单据编号（如 `26GC054`、`MO020234`、`SCRK00087170`、`FHTZD029708`、`XSCKD040422`），按 `Enter` 或点击右侧蓝色放大镜按钮查询。
   - 列表刷新出目标行后，点击单据编号蓝色超链接单元格即可打开对应单据详情页签。
