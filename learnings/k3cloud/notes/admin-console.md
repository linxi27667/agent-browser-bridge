# 金蝶云星空管理中心与用户运维自动化笔记 (9232 / Edge-K3CloudAdmin)

> 2026-11-11 基于实机排障沉淀。普通业务查询走 `--scene k3`（端口 `9224`，`Edge-K3Cloud`）；`administrator` 管理中心/用户管理/重置密码走 `--scene k3-admin`（端口 `9232`，`Edge-K3CloudAdmin`）。

## 1. 场景与门禁选择

- 管理中心或部分系统设置页面不一定挂载普通业务桌面的 `.kd-fullsearch-searchicon`，门禁统一使用 `k3.K3_ADMIN_GUARD`（`cli/abb.cjs --scene k3-admin` 已默认启用）。
- 一步查看当前页签与交互引用：
  ```powershell
  node cli/abb.cjs --scene k3-admin tabs
  node cli/abb.cjs --scene k3-admin snap
  ```

## 2. 用户重置密码标准 5 步真实时序（9232 实机已验证）

> **关键认知（勿颠倒弹窗顺序、勿重复提交）**：
> 1. 新版金蝶云星空《查询用户》工具栏入口名称通常为 **`密码策略 ▼ → 重置密码`**（部分旧版为 `重置密码 ▼ → 重置密码`）。
> 2. 真实弹窗顺序是：**勾选用户行 → 点 `密码策略 → 重置密码` → 先弹出 `二次认证` → 通过后弹出 `重置用户密码 - 修改` → 填两遍新密码点 `确定` → 窗内顶部浮现黄色确认条 `密码即将修改，请确认！`（点 `是`）**。
> 3. **最大陷阱（窗口不自动关 ≠ 没成功）**：点击 `是` 后，金蝶通过 AJAX **立即完成密码重置**，黄色确认条瞬间消失（`[ModalBody]` 中不再有 `密码即将修改，请确认！`），**但外层 `重置用户密码 - 修改` `.k-window` 会故意保持打开**！此时直接点一次 `取消` 或右上角 `Close` 关窗即可，**切勿误以为没点上而反复点 `确定`**。
> 4. **密码策略红线（严禁越权绕过）**：若 `[ModalBody]` / `[Alert]` 出现 **`用户密码在30天内重复，请重新输入！`** 或复杂度报错，说明目标口令命中企业安全策略，**必须立即停止并向用户汇报更换新口令**，**严禁**擅自打开全局《密码策略》取消勾选重复周期，也**严禁**未经用户明确指令直接写库修改 `T_SEC_PASSWORDHISTORY`！

```powershell
# Step 1: 勾选目标用户复选框（切勿点蓝字姓名超链接以免锁单）
node cli/abb.cjs --scene k3-admin k3 select-row "测试用户"

# Step 2: 展开工具栏“密码策略”下拉并点击“重置密码”（自动悬停 + 等待 320ms 下拉动画稳定后点击叶子项）
node cli/abb.cjs --scene k3-admin k3 split-menu "密码策略" "重置密码"

# Step 3: 通过 administrator 二次认证（仅走进程内存环境变量，零明文落盘）
node cli/abb.cjs --scene k3-admin k3 admin-2fa --env K3_ADMIN_PWD

# Step 4: 根据上一步 UI Diff 返回的“重置用户密码 - 修改”弹窗内两个密码框 ref（如 e45/e46）填入新口令并点“确定”（如 e47）
node cli/abb.cjs --scene k3-admin fill e45 --env K3_TARGET_NEW_PWD
node cli/abb.cjs --scene k3-admin fill e46 --env K3_TARGET_NEW_PWD
node cli/abb.cjs --scene k3-admin click e47

# Step 5: 观察 UI Diff 出现 [ModalBody] "密码即将修改，请确认！..." 后点“是”，黄条消失即代表已成功，最后点“取消”关窗
node cli/abb.cjs --scene k3-admin k3 confirm "是"
node cli/abb.cjs --scene k3-admin k3 confirm "取消"
```

## 3. 五大高频踩坑与底层防护（已内置到 v0.7.2）

1. **工具栏拆分按钮（如“密码策略 ▼ / 重置密码 ▼”）点完秒收起或动画中途漏点**：
   - 根因：Kendo UI 工具栏拆分按钮依赖指针停留在触发器附近，且 `.k-animation-container` 有约 `250ms` 下滑展开动画。
   - 解法：`v0.7.2` 的 `clickByBox` 自动保留悬停，`k3 split-menu` 自动等待 `320ms` 动画落稳并精准命中无子级 `<ul>` 的叶子菜单项。
2. **用户列表选人不要点蓝字超链接**：
   - 点蓝字姓名/账号会打开用户修改页签并占用网控锁；工具栏操作一律用 `k3 select-row "<姓名或账号>"` 勾选行复选框。
3. **“二次认证 / 重置用户密码”模态框（`.k-window`）报 `Input must be unique` 或提示未输入密码**：
   - 根因：DOM 中残留隐藏 `.k-window` 副本导致多个 `input[type="password"]`；同时 Kendo MVVM 绑定需要真实鼠标点击激活 + `blur`/`focusout` 同步模型。
   - 解法：`v0.7.2` 的定位器与 `fillNative` 自动收敛到最顶层可见 `.k-window` 并自动补发物理点击与 `blur`；快照自动置顶输出 `[ActiveModal]` 与 `[ModalBody]` 提示正文，无需截图即可读到弹窗报错或黄条确认语。
4. **切忌手搓 `keyDown(text)` + `char(text)`**：
   - 同时发送带 `text` 的 `keyDown` 与 `char` 会使输入框收到双倍字符（8 位变 16 位）。如需逐键输入，统一用 `cdp.typeKeysSafe` 或 `node cli/abb.cjs type eN --env VAR`。
5. **提示框确认（“是 / 确定 / 取消”）**：
   ```powershell
   node cli/abb.cjs --scene k3-admin k3 confirm "是"
   node cli/abb.cjs --scene k3-admin k3 confirm "确定"
   ```
