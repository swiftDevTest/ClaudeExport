# Chrome Web Store 上架清单 — ChatVault Exporter

> 最后更新日期：2026-06-25

该文档是 ChatVault Exporter 上架 Chrome Web Store（CWS）的元数据与配置指南，开发者可直接复制相应内容填入 Chrome 开发者控制台（Chrome Developer Dashboard）。

---

## 1. 商店上架信息 (Store Listing)

### 扩展名称 (Extension Name)
<!-- 必须与 manifest.json 中的 name 保持一致。最多 75 个字符。 -->
AI Chat Exporter - Local ChatGPT Claude Gemini to PDF, Docs, MD and More

### 简短描述 (Short Description)
<!-- 最多 132 个字符。显示在搜索结果中。 -->
本地将 ChatGPT、Claude、Gemini 对话导出为 PDF、Docs、MD 等，保留清晰排版与浏览器内处理。

### 详细描述 (Detailed Description)
<!-- 最多 16,000 个字符。 -->
ChatVault Exporter 是一款隐私优先、完全运行在浏览器本地的 AI 聊天导出工具。支持将 ChatGPT、Claude 和 Gemini 对话转换为适合编辑、分享、归档和交付的 PDF、Docs、MD 等本地文件。

主要功能亮点：
1. 【隐私安全，本地转换】所有文件的生成和转换过程 100% 在您的浏览器本地完成，聊天正文绝不上传到任何第三方服务器，确保商业敏感信息和个人隐私不外泄。
2. 【出版级排版】生成的文件采用专业报告排版，保留标题层级、代码高亮、表格、引用、数学公式和插图，并提供多种专业主题供选择（学术、商业、复古等）。
3. 【AI-only 报告模式】支持过滤用户提问，仅合并导出 AI 的连续回答，并自动生成目录，将聊天记录秒变专业教程、技术方案或总结报告。
4. 【导出凭证与归档】为学术、审计和工作留档用户提供包含导出时间、来源 URL、平台名称、文件 SHA-256 校验和在内的“导出凭证”。
5. 【开发者代码导出】自动为对话中的代码块生成索引，并支持将多段代码另存为对应的语言文件打包导出。

使用说明：
- 安装扩展后，打开任一 ChatGPT、Claude 或 Gemini 聊天页面。
- 页面右下角将出现轻量的“Export”按钮。
- 点击按钮选择 PDF、Docs、MD 等输出类型和导出主题，一键点击即可在本地完成下载。

客服与支持：
如有任何问题或建议，欢迎发送邮件至 chatvaultaisupport@gmail.com。

### 类别 (Category)
<!-- 推荐选择 Productivity 或 Developer Tools -->
Productivity (效率)

### 单一用途声明 (Single Purpose)
<!-- 简短的一句话，说明核心功能 -->
在用户浏览器本地将 ChatGPT、Claude 和 Gemini 网页端的聊天对话导出为 PDF、Docs、MD 等本地文件。

### 主要语言 (Primary Language)
English (United States) / Chinese (Simplified)
<!-- 注：本扩展支持多语言，但需设定一个主要语言。 -->

---

## 2. 图像与媒体资产 (Graphics & Assets)

| 资产类型 | 尺寸要求 | 当前状态 | 文件路径 |
| :--- | :--- | :---: | :--- |
| 商店图标 (Store Icon) | 128×128 PNG | ✅ 已准备 | `images/store-icon-128.png` |
| 屏幕截图 1 | 1280×800 或 640×400 | ✅ 已准备 | `1.0.0/商店功能图/01-plugin-popup.png` |
| 屏幕截图 2 | 1280×800 或 640×400 | ✅ 已准备 | `1.0.0/商店功能图/02-batch-export.png` |
| 屏幕截图 3 | 1280×800 或 640×400 | ✅ 已准备 | `1.0.0/商店功能图/03-export-theme-settings.png` |
| 屏幕截图 4 | 1280×800 或 640×400 | ✅ 已准备 | `1.0.0/商店功能图/04-select-messages-export.png` |
| 屏幕截图 5 | 1280×800 或 640×400 | ✅ 已准备 | `1.0.0/商店功能图/05-local-private-report.png` |
| 小宣传瓷砖 (Small Promo Tile) | 440×280 | ✅ 已准备 | `1.0.0/商店功能图/promo-small-440x280.png` |
| 大宣传瓷砖 (Marquee Promo Tile)| 1400×560 | ✅ 已准备 | `1.0.0/商店功能图/promo-marquee-1400x560.png` |

---

## 3. 权限声明与合理性释义 (Permissions Justification)

<!-- 针对 manifest.json 中声明的每一项权限，向审核团队给出合理性解释。不当或模糊的释义会导致驳回。 -->

| 权限 / 域名 | 类型 | 合理性释义 (Justification) |
| :--- | :--- | :--- |
| `storage` | permissions | 用于在本地存储用户的导出选项（如隐藏水印、显示时间等参数）、每日免费额度计数和临时会话状态（如 Supabase 登录 session 缓存）。 |
| `downloads` | permissions | 用于在浏览器本地生成导出文件后，调用 Chrome 下载管理器将其保存到用户的本地磁盘。 |
| `contextMenus` | permissions | 用于在 ChatGPT、Claude 和 Gemini 网页右键菜单中添加快捷导出入口（如右键“导出到 PDF”），提升用户在聊天页面时的操作便捷性。 |
| `identity` | permissions | 用于发起 Google 登录流程（LaunchWebAuthFlow），从而让已购买主产品 Pro 订阅的用户激活并恢复其 Pro 会员权益。 |
| `https://acgehhqcgreatcjcefub.supabase.co/*` | host_permissions | 用于与后端 Supabase 数据库和 Edge Functions 进行安全通信，以验证登录状态、同步 Pro 会员订阅和查询服务器验证的每日免费导出次数。 |
| `https://chatgpt.com/*`<br>`https://chat.openai.com/*` | host_permissions | 允许内容脚本在 ChatGPT 聊天页面运行，用于捕获聊天 DOM 树进行本地转换；允许背景脚本检测活动标签页以确定导出是否可用。 |
| `https://claude.ai/*` | host_permissions | 允许内容脚本在 Claude 聊天页面运行，用于捕获聊天 DOM 树进行本地转换。 |
| `https://gemini.google.com/*` | host_permissions | 允许内容脚本在 Gemini 聊天页面运行，用于捕获聊天 DOM 树进行本地转换。 |
| `https://*.oaiusercontent.com/*`<br>`https://*.googleusercontent.com/*`<br>`https://images.anthropic.com/*`<br>`https://media.anthropic.com/*`<br>`https://lh0.google.com/*` 至 `https://lh9.google.com/*` | host_permissions | 允许背景脚本从原 AI 平台或其受信任的 CDN 安全抓取聊天对话中嵌入的图片字节，以使本地生成的文件包含完整插图，避免因跨域导致图裂或缺失。 |

---

## 4. 隐私与数据使用声明 (Privacy & Data Use)

### 数据收集声明 (Data Collection)
**该扩展是否收集或传输用户数据？**
- **是 (Yes)**（注：虽然不上传聊天正文，但因包含 Supabase 登录及 Paddle 订阅功能，需收集必要的身份和交易凭证以提供付费功能）。

#### 数据类型声明细则：
1. **个人身份信息 (Personally identifiable info)**: 
   - *是否收集*: 是
   - *是否传输*: 是
   - *用途*: 仅用于用户账号登录和 Pro 订阅激活（通过 Supabase 账户注册邮箱）。
   - *是否共享给第三方*: 否。
2. **身份验证信息 (Authentication info)**: 
   - *是否收集*: 是
   - *是否传输*: 是
   - *用途*: 临时传输并缓存 Supabase 返回的安全 Access Token / Refresh Token，仅用于保持登录状态和验证 Pro 权益。扩展也可能在用户浏览器本地使用当前 AI 平台会话 cookie 或 access token 拉取用户选择导出的历史/图片，但不会把这些平台凭证上传或保存到我们的服务器。
   - *是否共享给第三方*: 否。
3. **财务/付款信息 (Financial info)**: 
   - *是否收集*: 是
   - *是否传输*: 是
   - *用途*: 当用户通过 Paddle 进行 Pro 订阅购买时，由 Paddle 支付服务处理交易并返回订单 ID。扩展本身不收集或存储卡号等敏感财务信息。
   - *是否共享给第三方*: 否。
4. **网站内容 (Website content)**:
   - *是否收集*: 否
   - *是否传输*: 否
   - *说明*: 扩展虽然在本地读取当前网页的 DOM（聊天对话），并可能用当前平台会话在浏览器本地请求用户选择导出的历史和图片进行格式排版和保存，但聊天正文和导出文件内容不传输（不上传）到我们的远程服务器。
5. **用户活动/网络历史 (User activity / Web history)**:
   - *是否收集*: 否
   - *是否传输*: 否
   - *说明*: 扩展仅限在 ChatGPT、Claude 和 Gemini 这三个受支持的域名下运作。不追踪也不记录用户的浏览历史或搜索行为。

### 数据安全与合规保证 (Data Use Certification)
- [x] 我们保证不将收集的数据出售给第三方。
- [x] 我们保证不将收集的数据用于扩展核心功能以外的任何不相关目的（例如广告、画像等）。
- [x] 我们保证不将收集的数据用于评估信用度、贷款发放等非授权业务。

### 隐私政策链接 (Privacy Policy URL)
上架必填，已部署在官方网站：
`https://tabpilotpro.com/aichatexport/private.html`

---

## 5. 发布与分发设置 (Distribution)

- **可见性 (Visibility)**: 公开 (Public)
- **地区分布 (Regions)**: 所有地区 (All regions)
- **定价模式 (Pricing)**: 免费下载 + 订阅增值 (Free with in-app subscription)
- **支持联系方式**: chatvaultaisupport@gmail.com
- **主页链接 (Homepage URL)**: `https://tabpilotpro.com/aichatexport/index.html`

---

## 6. 版本发布记录 (Version History)

| 版本号 | 提交日期 | 变更说明 | 审核状态 |
| :--- | :--- | :--- | :--- |
| `1.0.0` | 2026-06-25 | 1.0.0 稳定发版。支持 ChatGPT、Claude、Gemini 本地导出 PDF、Docs、MD 等；增加导出凭证 (Receipt) 及代码索引等功能；优化了大图分段导出。 | 待提交 (Draft) |
