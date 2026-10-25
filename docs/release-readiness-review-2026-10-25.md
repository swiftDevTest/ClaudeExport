# Claude Export 发版检查记录

修复更新（2026-10-25）：本文列出的 6 项问题已在工作区完成修复，版本递增为 `1.3.1`；最终发布检查为 184 条测试、181 通过、3 跳过、0 失败。实现与验证见 [修复记录](release-fixes-2026-10-25.md)。以下保留修复前的审计证据和结论。

检查日期：2026-10-25（Asia/Shanghai）。检查基线为分支 `1.4.0`、HEAD `a53f5d2` 及当前工作区的全部未提交修改。

结论：**当前不建议发版。发现 4 项 P1 问题，建议作为发布阻塞处理；另有 2 项 P2 问题。** 自动发布门禁通过，但没有覆盖这些边界。以下功能问题均通过实际调用现有函数或提取原函数执行的方式复现；Claude API 响应、任务控制器和下载延迟使用模拟数据，未操作用户的真实对话或启动真实同步。

本次未修改生产代码、既有测试或线上配置；重新生成了忽略跟踪的 `dist/` 发布产物，并新增本检查记录。

## 发布阻塞项

### 1. [P1] 更新包版本与已上架版本相同

- 位置：`manifest.json:7`、`package.json:3`、`scripts/package-extension.mjs:27`。
- 实际读取 Chrome Web Store 页面，当前公开版本为 **1.3.0**；本地 manifest、package 和生成的 `dist/claude-export-1.3.0.zip` 同为 **1.3.0**。
- 影响：无法用当前版本号提交这一轮扩展更新。打包脚本只检查两个本地版本是否相等，无法检测版本是否高于已上架版本。
- 修复方向：确定新的产品版本后同步递增 manifest 和 package，重新运行发布门禁及打包。`chat-export-version: 1.6.0` 记录的是上游核心版本，不能代替 Chrome manifest 版本。
- 线上依据：[Chrome Web Store 产品页](https://chromewebstore.google.com/detail/claude-export/hgonhclokojiceeeeefkljaljjhmkoig)。

### 2. [P1] Claude 树形响应会把不同回答分支一起导出

- 位置：`src/modules/export/platform-fetchers.js:3631`；请求入口为 `:4846`。
- 触发条件：接口返回含多个分支的 `chat_messages`。当前代码还会在第一个请求失败时主动尝试 `?tree=true`。
- 原因：解析器直接遍历全部消息，未利用 `current_leaf_message_uuid` 和消息的 `parent_message_uuid` 恢复当前分支；归一化后也不再保留消息 UUID。
- 复现：让普通会话接口返回 503，树形接口返回以下逻辑结构：

  ```text
  u1: Question
  ├── a1: OBSOLETE ANSWER
  └── a2: SELECTED ANSWER  ← current_leaf_message_uuid
  ```

  实际解析结果为 `Question → OBSOLETE ANSWER → SELECTED ANSWER`，完整性检查返回 `needsFallback: false`。预期只包含当前选中分支。
- 影响：重新生成或编辑后存在分支的会话可能产生内容错误的文件；同一消息来源也被本地导出及同步使用。该问题是内容正确性问题，不能通过“成功下载”验收放行。
- 修复方向：先根据叶节点回溯父链，再做块解析；检测重复节点、缺失父节点和循环，并用重新生成、编辑问题、切换分支的响应建立回归用例。无法确认当前分支时应明确停止或提示，不能把整棵树线性导出。

### 3. [P1] 多组织账号没有活跃标记时，只尝试第一个组织

- 位置：`src/modules/export/platform-fetchers.js:3204`、`:4844`。
- 触发条件：账号有个人及团队等多个组织，`/api/organizations` 未返回 `active: true` 或 `is_active: true`，当前会话属于非首个组织。
- 原因：组织选择回退为第一个有 ID 的条目。两个会话请求都使用同一组织，即使返回 404，也不会切换到会话实际所属组织。
- 复现：组织列表返回 `[{uuid: "personal"}, {uuid: "team"}]`，会话仅存在于 team。实际依次请求 personal 的普通接口及树形接口，最终报 404；`teamAttempted: false`。模拟的 team 接口可正常返回完整会话。
- 影响：这类账号的全会话本地导出与同步失败。当前完整导出又明确禁用普通 DOM fallback，因此刷新页面不能解决选错组织的问题。
- 修复方向：优先使用当前会话或页面已知的组织身份；只有身份不足且收到组织相关的失败时，才进行有界的其他组织查找，并保留取消机制。验证缺少活跃标记和个人/团队切换场景。

### 4. [P1] 批量与同步入口能覆盖正在运行的单次导出控制器

- 位置：`src/content.js:4695`、`:4730`；Notion 单次入口也在 `:7196` 后直接创建并赋值控制器。
- 原因：`performExport` 已在入口检查 `abortController` 和批量状态，但 `startInPageBatchExport` 只检查批量标志；Notion 同步入口也缺少统一的任务占用判断。互斥没有覆盖所有入口。
- 复现：预置一个尚未结束的单次导出控制器，调用原始 `startInPageBatchExport`，将 `loadState` 挂起在第一次 await。函数已把全局控制器替换为新批量控制器。随后取消全局控制器，结果为：

  ```json
  {
    "controllerOverwritten": true,
    "singleCancelled": false,
    "batchCancelled": true
  }
  ```

- 影响：旧任务继续运行，取消按钮失去对旧任务的控制；多个任务共享批量标志、进度 UI、图片缓存和清理路径，会产生状态串扰。单次导出的若干后续判断仍实时读取全局批量标志。
- 修复方向：在本地导出、批量导出、Notion 和 Obsidian 的所有启动入口，用同一个同步任务锁占用任务；在预检的第一次 await 前完成占用，按任务身份释放。后台已接管的同步任务需有明确的占用和取消规则。

## 其他已确认问题

### 5. [P2] 合法的单角色 Claude 会话被误判为不完整

- 位置：`src/content.js:5203`；风险检测为 `src/modules/export/platform-fetchers.js:4983`。
- 复现：接口成功返回一个 `sender: "human"`、有正常文本的会话。解析结果有效，但实际调用内容脚本获取函数会抛出 `Conversation completeness check failed: missing_assistant_role`。
- 原因：只有 ChatGPT 对“单纯缺少一个角色”做非阻塞处理；Claude 直接把所有角色缺失信号视为失败。
- 影响：尚未获得回答、回复被中止等只有用户消息的会话无法全量导出。选择消息导出仍可作为临时操作路径。
- 修复方向：根据原始响应的消息和分支结构确认完整性，区分合法角色缺失与解析丢失消息；不要对所有平台都简单取消完整性校验。

### 6. [P2] 保存首个响应的 30 秒超时可能早于用户完成文件选择

- 位置：`src/modules/export/save.js:36`、`:200`；后台下载入口为 `src/background.js:1380`。
- 原因：前台发出保存请求后立即启动 30 秒超时，后台要等 `chrome.downloads.download` 的回调才回复。定义的 5 分钟下载完成等待，只在收到 downloadId 后才生效，不能覆盖首次响应前的用户等待。
- 已复现的边界：用原始 `sendSaveExportMessage`，将等待时间按比例缩为 20 ms，在 80 ms 后返回成功。前台先返回超时，迟到的成功响应被丢弃，但模拟下载仍已创建。
- 影响：在 Chrome 首次回调晚于 30 秒的情况下，文件仍可能保存，界面却显示失败；单次登录免费用户的服务端额度又在保存前消耗，重试可能额外消耗额度。
- 修复方向：把请求接收、等待用户选择、下载终态分开管理，通过请求 ID 跟踪和对账迟到结果，并在超时后维持正确的 Blob 生命周期。
- 验证边界：延迟回调行为已用模拟 Chrome bridge 复现；尚未在真实原生“另存为”对话框中人工等待验证，因此列为 P2。参考 [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)。

## 已通过的验证

| 范围 | 结果 |
| --- | --- |
| `npm run release:check` | 通过：语法检查、测试、打包均成功 |
| 自动化测试 | 165 条，162 通过，0 失败，3 条非 Claude DOM 测试按原配置跳过 |
| 全部源码语法 | 额外检查 `src/` 内 63 个 JS/MJS 文件，全部通过 |
| 模块引用 | 静态本地 import 路径无缺失；既有 manifest 模块暴露测试通过 |
| 安装包资源 | manifest 引用的入口及图标存在，9 个 locale 的 manifest 文案键齐全 |
| 安装包一致性 | 逐文件核对打包内容与当前源码一致；发布 manifest 已去除开发用 key |
| 差异格式 | `git diff --check` 通过 |
| npm 生产依赖审计 | `npm audit --omit=dev --json` 返回 0 漏洞；不代表已审计所有手动内置 vendor 文件 |
| Supabase 项目 | `acgehhqcgreatcjcefub` 为 `ACTIVE_HEALTHY` |
| 迁移 | 本仓库 9 个迁移版本均在线上历史中；共享项目另有 6 个较新迁移 |
| 关键函数 | checkout、订阅同步、导出权益、两类产品 analytics 及 Claude Notion OAuth 均已部署且 ACTIVE |
| 线上 CORS | 对 5 个关键产品函数各做 4 个 OPTIONS 请求，共 20 项符合预期 |

CORS 实测：正式扩展 origin 和 `https://claude.ai` 返回 204 并回显准确的允许来源；未知扩展 ID 及带路径的伪扩展 origin 返回 403，不返回允许来源头。

Supabase security advisor 未报告 ERROR；存在 1 类密码泄露保护 WARN 及 8 个启用 RLS 但无策略的 INFO。后者表示客户端默认拒绝访问，不能直接据此认定为越权漏洞。当前扩展代码只提供 Google 登录，密码保护提示不作为本次扩展发布阻塞；平台仍可参考 [密码保护说明](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) 和 [RLS 提示说明](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) 处理其他客户端的配置。

最近 24 小时日志聚合仅有少量 Edge Function 请求，未看到这些记录中出现 5xx；此样本不足以证明完整支付或登录流程可用。

## 尚未完成的真实环境验收

没有在真实登录的 Claude 多组织页面执行导出，也没有启动 Google OAuth、真实付款、恢复购买、Notion 写入或 Obsidian Vault 写入。PDF/长图的回归主要使用模拟 Canvas，尚未逐页视觉验收真实文件或在桌面 Word 中打开 DOCX。

在修复上述 P1 后，至少应完成：个人与团队会话、重新生成与分支切换、长 PDF/长图、保存取消及长时间文件选择、单次与批量入口并发、登录后 3 次免费额度，以及 Notion/Obsidian 的真实授权同步。涉及线上账户和同步的步骤需使用明确的测试目标。

本次 ZIP：`dist/claude-export-1.3.0.zip`（版本问题解决前不可作为本轮更新包提交）。SHA-256：`53d3a130ec17a7c5fd67a8116832f316f09b1f66d404fac1b642f382cae94e36`。
