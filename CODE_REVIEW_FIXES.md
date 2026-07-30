# 代码审查与修复记录

> 审查日期：2026-07-30
> 审查范围：Claude Export 全项目（manifest、background、content、export 模块、Supabase Edge Functions、测试）
> 验证方式：`npm run check` + `npm test`（41 passed / 3 skipped / 0 failed）

---

## 一、已修复问题

### 1. `export.js` 中 `buildDocxBlob` 兼容 API 重复定义

**严重程度**：中
**影响范围**：直接调用 `CHATVAULT_EXPORT.buildDocxBlob()` 时会丢失 `signal` 和 `onProgress`

**问题描述**

`src/modules/export.js` 在同一个 `globalThis.CHATVAULT_EXPORT` 对象字面量里定义了两次 `buildDocxBlob`：

```js
// L411：完整签名，含 options 参数
buildDocxBlob: function (messages, metadata, settings, options) {
  assertMods();
  return _mods.docx.buildDocxBlob(messages, metadata, settings, options);
},

// L486：重复定义，丢失 options 参数
buildDocxBlob: function (messages, metadata, settings) {
  return ensureModules().then(function () {
    return _mods.docx.buildDocxBlob(messages, metadata, settings);
  });
},
```

JS 对象字面量中后定义的属性会覆盖前定义的同名属性，因此 L411 是死代码，实际生效的 L486 丢失了 `options` 参数。

正常 Word 导出不受影响：`engine.js` 通过 `renderWordDocument()` 直接调用 builder，并已正确传递 `signal` 和 `onProgress`。受影响的是对外兼容 facade 的直接调用。

**根因**：sync-core.mjs 从主产品 ChatVault Exporter 全量同步 `export.js` 时，主产品的新增 API（L486 的懒加载版本）与本仓库已有的同步版本（L411）冲突，未做去重。

**修复方案**

只保留一个懒加载 facade，同时完整透传 `options`：

```js
buildDocxBlob: function (messages, metadata, settings, options) {
  return ensureModules().then(function () {
    return _mods.docx.buildDocxBlob(messages, metadata, settings, options);
  });
},
```

同步版使用 `assertMods()`，在浏览器尚未预加载模块时会抛错，因此没有保留。`scripts/sync-core.mjs` 增加同步后规范化步骤，防止下次同步重新引入重复定义。

**修改文件**
- src/modules/export.js
- scripts/sync-core.mjs
- tests/export-docx-facade.test.mjs

---

### 2. 共享 Edge Function 默认扩展 ID 白名单不完整

**严重程度**：高
**影响范围**：服务端未配置 `CHATVAULT_ALLOWED_EXTENSION_IDS` 环境变量时，扩展从 content script 调用 `product-verify-export-entitlement` 等 Edge Function 会被 CORS 拦截

**问题描述**

`supabase/functions/_shared/http.ts` 的 `isAllowedChromeExtensionOrigin` 在未配置 `CHATVAULT_ALLOWED_EXTENSION_IDS` 时只放行单个产品 ID。该 Supabase 项目的 `product-*` Edge Functions 同时服务 ChatVault、ChatGPT、Claude 和 Gemini，单产品默认值会让其他产品被 CORS 拒绝。

```ts
const allowed = configured.length
  ? configured
  : DEFAULT_ALLOWED_CHROME_EXTENSION_IDS;
```

Claude Export 的扩展 ID（`ljlmljccgbogejkhlnldgolahihniebj`）原先不在默认白名单，导致：
- 生产环境若忘记配置环境变量，扩展所有需要鉴权的 Edge Function 调用都会因 CORS 失败
- 用户表现为「登录后权益不刷新」「导出配额校验失败」

**修复方案**

生产部署仍应显式配置 `CHATVAULT_ALLOWED_EXTENSION_IDS`。代码中的应急默认值改为经过确认的官方扩展 ID 集合；一旦设置环境变量，显式配置会完整替换默认集合。测试同时覆盖所有默认 ID、非法 ID、路径拒绝和环境变量覆盖行为。

**修改文件**
- supabase/functions/_shared/http.ts
- tests/membership-product-sync.test.mjs

---

### 3. `background.js` 关键依赖加载失败缺少诊断信息

**严重程度**：低
**影响范围**：扩展包损坏或配置脚本语法错误时缺少明确日志，增加排查成本

**问题描述**

`src/background.js` 顶层的 `importScripts` 使用空 `catch` 吞掉所有错误：

```js
try {
  importScripts("product-config.js");
} catch (error) {}  // 静默吞错
try {
  importScripts("supabase-config.js");
} catch (error) {}  // 静默吞错
```

`product-config.js` 和 `supabase-config.js` 属于重要依赖，空 `catch` 会让扩展包缺文件或脚本语法错误难以定位。

background、content、popup、Supabase Auth 和 entitlement 模块的 fallback namespace 均为 `claude_export.`，因此不存在原报告所述的 storage key 不一致。缺少完整配置仍可能让产品元数据或登录能力降级，但不是命名空间错位。

**修复方案**

将关键脚本的空 `catch` 改为 `console.error`，保留一致的安全 fallback；Notion/Obsidian 可选依赖继续使用 `console.warn`：

```js
try {
  importScripts("product-config.js");
} catch (error) {
  console.error("[Background] Failed to import product-config.js:", error);
}
```

**修改文件**
- src/background.js

---

## 二、经评估不修复的问题

| 问题 | 不修复原因 |
|---|---|
| `export.js` 中 ChatGPT/Gemini 平台分支是死代码 | manifest 和同步后生成的 registry 已仅暴露 Claude extractor，分支当前不可达且不增加跨平台资源暴露；如要清理，应在主产品或同步转换层统一处理 |
| `supabase.ts` 与 `product-supabase.ts` 代码高度重复 | 两者分别操作 `profiles`（老表）和 `product_profiles`（新表），是有意的两套 schema，非重复代码 |
| `product-analytics-identify` 的 `verify_jwt=true` 与 `product-analytics-track` 的 `verify_jwt=false` 不一致 | `identify` 必须登录（强校验 JWT），`track` 允许匿名 guest 上报（try/catch 容错），不一致是有意设计 |
| Analytics 模块整体被注销但仍保留完整代码骨架 | 影响范围仅为 bundle 体积，可能有「保留骨架以便未来重启」的意图，不擅自删除 |

---

## 三、验证结果

```bash
npm run check   # 语法检查通过
npm test        # 41 passed / 3 skipped / 0 failed
```

跳过的 3 个测试为 ChatGPT/Gemini 平台的 DOM 导出用例，本就因平台隔离而 skip，与本次修复无关。

---

## 四、生产部署与验证

2026-07-30 已完成：

- 更新 Supabase Secret `CHATVAULT_ALLOWED_EXTENSION_IDS`，保留 ChatVault、ChatGPT、Claude、Gemini 四个已确认扩展 ID；
- 部署 `product-create-checkout-session`、`product-sync-subscription-status`、`product-verify-export-entitlement`、`product-analytics-identify`、`product-analytics-track`；
- 确认五个函数均为 `ACTIVE`，JWT 配置与 `supabase/config.toml` 一致；
- 线上 CORS 验证：四个官方扩展 Origin 与 `https://claude.ai` 返回 204 并回显 Origin；
- 非法扩展 ID及带路径的扩展 Origin 返回 403，且不返回 `Access-Control-Allow-Origin`；
- 扩展语法检查、41 项测试及生产包构建通过，无需数据库迁移。

最终发布门禁：

```text
npm run release:check
41 passed / 3 skipped / 0 failed
dist/claude-export-1.3.0.zip
SHA-256: 83c769c98aada09cf0bbf04fecedda7d02eb99d01b51f73a2d9f53766d8d4e99
```

Chrome 工具栏中可以看到 Claude Exporter，但自动化控制 Claude 页面和 Chrome
内部扩展管理页时超时，因此没有把未完成的真实下载操作记为通过。发布到 Chrome
Web Store 后仍需按下方人工验收用例执行一次浏览器端最终验收。

---

## 五、发布后人工验收用例

1. **扩展注入**
   - 打开一个已有消息的 `https://claude.ai/...` 对话，再打开扩展。
   - 预期：扩展识别为 Claude 页面，导出按钮可用，消息数与当前对话一致。
2. **Word 导出和进度**
   - 选择 Word 导出一个含代码块、表格和图片的长对话。
   - 预期：进度持续更新；文件仅下载一次；DOCX 可打开，代码、表格、图片和正文顺序正确。
3. **Word 取消**
   - 在长对话生成阶段点击取消。
   - 预期：任务停止、不下载残缺文件、不显示通用失败提示，随后可以重新导出。
4. **选中消息再次导出**
   - 只选两条消息导出 PDF，再从结果页快速再次导出 Markdown。
   - 预期：两次都只包含相同的两条消息，不会扩大成完整对话。
5. **登录和权益刷新**
   - 登录后关闭并重新打开扩展，再刷新 Claude 页面。
   - 预期：登录状态保留；邮箱、套餐和剩余额度正确；不会无故退出。
6. **免费额度**
   - 使用免费账户成功导出一次并重新打开扩展。
   - 预期：剩余额度只减少一次；达到限制后给出明确升级/登录提示。
7. **Notion / Obsidian**
   - 分别连接一次并同步一个短对话；然后主动断开。
   - 预期：同步进度和成功结果准确；断开只清理对应连接，不影响产品登录状态。
8. **错误恢复**
   - 在离线状态尝试权益刷新或导出，再恢复网络重试。
   - 预期：已有登录不会因临时网络错误被清除；恢复网络后可成功刷新和导出。
