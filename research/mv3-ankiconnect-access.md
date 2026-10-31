# MV3 扩展访问本机 AnkiConnect 与站点权限（研究结论）

对应 issue #4。研究日期 2026-10-31。标注 **[待验证]** 的结论在 issue #7 用真实环境（Chrome stable + Anki Desktop + AnkiConnect）验证。

## 结论摘要

1. **Local/Private Network Access 基本不影响扩展 service worker 访问 `127.0.0.1:8765`**。LNA 针对"网页（public / local 站点）到本机 / 内网"的请求。Chrome 团队在 chromium-extensions 邮件列表回复："as long as an extension has the correct host permissions, then they will not be impacted by this"。第三方实测（非一手）称 `chrome-extension://` 文档与 worker 被归为 loopback 地址空间，因此不触发提示。**[待验证]**
2. **host_permissions**：从 service worker `fetch('http://127.0.0.1:8765')` 绕过 CORS 需要 host permission（`http://127.0.0.1/*`，端口默认通配）。但 AnkiConnect 对 `chrome-extension://` 来源本身回 `Access-Control-Allow-Origin: <该来源>`，所以默认配置下即使没有 host permission，CORS 也可能通过。声明与否是"防御性"选择，需实测并权衡安装警告。**[待验证]**
3. **AnkiConnect 默认配置下，用户零配置即可**：默认 `webCorsOriginList = ["http://localhost"]`，源码中只要列表含 `http://localhost`，任意 `chrome-extension://` 前缀的来源都被放行（不校验扩展 ID）。只有用户把 `http://localhost` 从列表删除、或改成自定义列表时，才需手动加入 `chrome-extension://<扩展ID>`。`requestPermission` 弹窗授权是备用路径。
4. **apiKey**：默认 `null`（不鉴权）。若用户设置了 apiKey，扩展必须在请求里带上（legacy API：JSON body 的 `key` 字段；新 v1 API：`Authorization: Bearer <key>`），除 `requestPermission` 外的动作都需要它。因"任意扩展都被放行"，推荐（可选）引导用户设置 apiKey，扩展提供输入框。
5. **运行时授权**：`optional_host_permissions` 配 `permissions.request()` 必须在用户手势内调用；声明 `"*://*/*"`（或包含 `<all_urls>`）才能在运行时请求任意站点；`activeTab` 无安装警告，仅在用户手势后对当前标签临时生效，导航或关闭标签即失效。持久站点支持靠 `scripting.registerContentScripts`（需 host permission）。
6. **Chrome Web Store**：访问 localhost 本身没有找到专门政策限制；审核焦点是 host 权限最小化与用户数据政策。声明 `<all_urls>` 等宽主机权限会触发更严格（更长）的审核；本项目"activeTab + 可选权限"的模型与官方"narrowest permissions"要求一致。

## 1. Private / Local Network Access 与扩展

### 1.1 现状（一手来源）

- Chrome 的 LNA 权限提示在 Chrome 142 上线，138 起可通过 flag 试用；针对 "any request from the public network to a local network or loopback destination"；权限请求仅限安全上下文；"Local network requests from Service Workers and Shared Workers require that the worker's origin has previously been granted the Local Network Access permission"（即网页的 SW 需要先由页面触发过授权）。来源：<https://developer.chrome.com/blog/local-network-access>。该页**完全没有提到扩展**。
- WICG 规范（Draft CG Report, 2026-08-07）：权限拆分为 `local-network` 与 `loopback-network`，`local-network-access` 保留为别名；规范对 Service Worker 的处理是 "If document is null, then return error"，并有未决议题 "Define local network access behavior for Service Workers"。来源：<https://wicg.github.io/local-network-access/>。规范同样未提及扩展。
- blink-dev Intent to Ship（Chrome 141 / origin trial 141 到 146）把 local network request 定义为 "any request from a public website to a local IP address or loopback, or from a local website (e.g. intranet) to loopback"，未提及扩展：<https://groups.google.com/a/chromium.org/g/blink-dev/c/cwu_RUmBpzY>。
- Chrome 团队成员（Patrick Kettner）在扩展开发者邮件列表的回复：扩展只要有正确的 host permissions 就不受影响；某个影响扩展的 bug 在 Chrome >= 144.0.7512.0 修复；另提到管理员策略 `LocalNetworkAccessRestrictionsTemporaryOptOut`。来源：<https://groups.google.com/a/chromium.org/g/chromium-extensions/c/pUDh8RiTjJk>。（本次读取的是页面摘要，原话以该链接为准。）

### 1.2 二手实验（仅作参考）

一份第三方 issue 在 Chrome for Testing 155 上测试：service worker、offscreen document、扩展页面对私网 IP / `.local` / loopback 的 fetch 都无提示通过；称 `chrome-extension://` 被归为 loopback 地址空间，"豁免来自扩展来源，而非 host permissions；host permissions 决定 CORS 是否通过"：<https://github.com/maxdubmors/rimlock/issues/35>。这不是官方来源，**[待验证]**。

### 1.3 对设计的含义

- **所有 AnkiConnect 请求必须由扩展 service worker（或扩展页面）发出**。content script 的网络请求以注入页面的来源发出，受页面 CORS / 同源策略约束（<https://developer.chrome.com/docs/extensions/develop/concepts/network-requests>），在 Chrome 142+ 还会让该网页站点面对 LNA 提示，且 `Origin` 为网页来源，会被 AnkiConnect 以 403 拒绝。content script 应通过 `runtime.sendMessage` 把请求交给 SW。
- 使用 `127.0.0.1` 而不是 `localhost`：AnkiConnect 默认绑定 `127.0.0.1`，`localhost` 可能解析到 `::1`。
- Chrome 以外的浏览器（Edge、Brave 等）以及 Chrome 版本低于 144 的行为未验证。

## 2. 需要的 manifest 声明

match pattern 的端口默认通配，`http://127.0.0.1/*` 即匹配 `http://127.0.0.1:8765`（<https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns>）。

```jsonc
{
  "manifest_version": 3,
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["http://127.0.0.1/*"],      // 是否必需见下 [待验证]
  "optional_host_permissions": ["*://*/*"]         // 运行时按站点申请；"所有站点"开关请求 <all_urls>
}
```

- 文档：要请求运行时才知道的主机，需在 `optional_host_permissions` 中声明 `"https://*/*"`，"This lets you specify any origin in Permissions.origins as long as it has a matching scheme"，所以要覆盖 http 站点应声明 `*://*/*` 或同时声明 http/https。"所有站点"开关请求 `<all_urls>` 时清单里的具体写法 **[待验证]**。来源：<https://developer.chrome.com/docs/extensions/reference/api/permissions>。
- `http://127.0.0.1/*` 放入 `host_permissions` 是否会在安装时产生警告、是否值得（因为 AnkiConnect 会返回允许 CORS 的响应头）需实测；备选是把它放进 `optional_host_permissions`，在用户首次"连接 Anki"时通过按钮手势申请。**[待验证]**
- `activeTab` 与 `host_permissions` 是 `scripting.executeScript` 的两种前置条件：<https://developer.chrome.com/docs/extensions/reference/api/scripting>。

## 3. AnkiConnect 对扩展来源的处理（读源码）

源码主库在 <https://git.sr.ht/~foosoft/anki-connect>（GitHub 镜像 `FooSoft/anki-connect` 已归档，README 写明 "permanently moved"，镜像最后推送 2025-11-04）。以下两个版本都读过。

### 3.1 旧版（GitHub 镜像 master，`plugin/web.py`）
<https://github.com/FooSoft/anki-connect/blob/master/plugin/web.py>

```python
allowed = False
corsOrigin = 'http://localhost'
allowAllCors = '*' in webCorsOriginList
if allowAllCors: corsOrigin = '*'; allowed = True
elif b'origin' in req.headers:
    originStr = req.headers[b'origin'].decode()
    if originStr in webCorsOriginList: corsOrigin = originStr; allowed = True
    elif 'http://localhost' in webCorsOriginList and (
        originStr == 'http://127.0.0.1' or originStr == 'https://127.0.0.1' or
        originStr.startswith('http://127.0.0.1:') or ... or
        originStr.startswith('chrome-extension://') or originStr.startswith('moz-extension://') or
        originStr.startswith('safari-web-extension://')):
        corsOrigin = originStr; allowed = True
else:
    allowed = True      # 无 Origin 头（如 curl）直接放行
```

- 不被放行时：非 `requestPermission` 动作返回 `403 Forbidden`；`requestPermission` 例外，会走到 Anki 里弹窗询问（"A website wants to access to Anki"），用户选 Yes 后把该 origin 追加到 `webCorsOriginList`，勾选 "Ignore further requests" 则加入 `ignoreOriginList`（`plugin/__init__.py`）。
- `OPTIONS` 预检不校验来源，总是返回 CORS 头；若请求带 `Access-Control-Request-Private-Network: true` 则加 `Access-Control-Allow-Private-Network: true`（提交 "Explicitly allow requests from public websites via new header (#302)", 2022-01）。这是应对 Chrome 旧版 PNA 预检，对扩展不是必需。
- apiKey：`if key != util.setting('apiKey') and name != 'requestPermission': raise Exception('valid api key must be provided')`。默认 `apiKey=null`，请求未带 `key` 时 `None == None` 通过。`requestPermission` 返回 `{"permission":"granted","requireApikey":bool,"version":6}`（不返回 key）。
- 默认配置 `plugin/config.json`：`webCorsOriginList: ["http://localhost"]`, `ignoreOriginList: []`, `apiKey: null`, 绑定 `127.0.0.1:8765`。

### 3.2 新版（sr.ht master，`plugin/web.py`，README 要求 Anki Desktop 26.08+）
<https://git.sr.ht/~foosoft/anki-connect/blob/master/plugin/web.py>、<https://git.sr.ht/~foosoft/anki-connect/blob/master/README.md>、<https://git.sr.ht/~foosoft/anki-connect/blob/master/API_LEGACY.md>、<https://git.sr.ht/~foosoft/anki-connect/blob/master/API_V1.md>

- 来源判定逻辑等价：`allowed = not origin or origin in origins`；列表含 `http://localhost` 时 `chrome-extension://` / `moz-extension://` / `safari-web-extension://` 前缀与 `127.0.0.1` 来源均放行；列表含 `*` 时全部放行。
- 保留 legacy 接口（根路径 `/`，`version: 6`，`key` 在 body 中），新增 JSON-RPC 接口 `/api/v1`（`Authorization: Bearer <key>`，来源被拒返回 403，key 错误返回 401）。文档明示："Origin permission is checked separately using `webCorsOriginList` and `ignoreOriginList`"。
- `OPTIONS` 回复 `Access-Control-Allow-Headers: Content-Type, Authorization, *`、`Access-Control-Allow-Methods: POST, OPTIONS`，并支持 `Access-Control-Allow-Private-Network`。旧版的 `Access-Control-Allow-Headers: *` 不覆盖 `Authorization`（Fetch 规范中通配符不含该头），因此 legacy 用 body 中的 `key` 是稳妥选择。
- 因此：**PRD 若基于 API v6 legacy 接口，新旧两版 AnkiConnect 均兼容**；是否同时支持 v1 属于范围决策。

### 3.3 用户需要做什么

| 场景 | 用户需做 |
|---|---|
| 默认配置（未改 webCorsOriginList） | 安装 AnkiConnect（add-on code `2055492159`），保持 Anki 运行，无需额外配置 |
| 用户已自定义 `webCorsOriginList` 且不含 `http://localhost` | 加入 `"chrome-extension://<VOKA 扩展ID>"`；或在扩展内触发 `requestPermission`，在 Anki 弹窗点 Yes |
| 用户设置了 apiKey | 在 VOKA 设置中填入 key |
| Windows | 防火墙提示时放行 Anki（新版 README） |
| macOS | 新版 README 称自动抑制 App Nap；旧版需按其文档处理（未查证旧版文档） |

安全含义：由于是前缀匹配、不校验扩展 ID，机器上任何已安装扩展都可在默认配置下访问 AnkiConnect（包括删除 deck 之类动作）。这是 AnkiConnect 的设计，VOKA 隐私说明里应提示，并建议设置 apiKey。

## 4. 运行时权限行为

- **optional_host_permissions + `permissions.request`**：请求必须在用户手势内（"Permissions must be requested from inside a user gesture, like a button's click handler"）；只能请求清单中声明或被 `optional_host_permissions` 通配符覆盖的主机；返回 `Promise<boolean>`；不可作为 optional 的权限有 debugger、declarativeNetRequest、devtools、geolocation、mdns、proxy、tts、ttsEngine、wallpaper。来源：<https://developer.chrome.com/docs/extensions/reference/api/permissions>、<https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>。
- **安装警告**：官方文档建议用运行时申请避免安装期警告；`activeTab` 不产生警告；新增带警告的权限会让扩展在更新后被禁用直到用户确认：<https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>。具体警告文案（尤其是 `http://127.0.0.1/*`）官方页面未逐条列出，**[待验证]**（装测试包观察）。
- **activeTab**：由用户手势触发（点击 action、上下文菜单项、`commands` 快捷键、omnibox 建议被接受）；授权后可对该标签调用 `scripting.executeScript/insertCSS`（需 `scripting` 权限），并读取 URL / title / favicon；用户导航离开或关闭标签后失效；不适用于 `chrome://` 等受限页面：<https://developer.chrome.com/docs/extensions/develop/concepts/activeTab>。侧边栏打开方式是否同样视为手势，文档未说明，**[待验证]**。
- **`scripting.registerContentScripts`**：`matches` 必填；`persistAcrossSessions` 默认 true；需有对应 host permission（`host_permissions` 或已授予的可选权限）。文档明确 "Unregistering content scripts will not remove scripts or styles that have already been injected"；"注册只影响之后加载的页面，已打开页面需 `executeScript` 补注入"属 Chrome 已知行为，但本次未找到一手原文，**[待验证]**。授权被撤销后脚本是否自动失效、是否需在 `permissions.onRemoved` 手动 `unregisterContentScripts` 同样 **[待验证]**。来源：<https://developer.chrome.com/docs/extensions/reference/api/scripting>。
- 官方文档自 Chrome 148 起在扩展 API 页面标注 `browser.*` 命名空间；`chrome.*` 是否继续可用本次未查证。**[待验证]**

## 5. Chrome Web Store 政策与审核

- 权限政策："Request access to the narrowest permissions necessary to implement your Product's features or services. If more than one permission could be used … you must request those with the least access to data or functionality."，且禁止为未来功能"future proof"：<https://developer.chrome.com/docs/webstore/program-policies/permissions>。
- 审核时间：官方指出 `*://*/*`、`https://*/*`、`<all_urls>` 等宽主机权限使扩展可访问用户的全部网页活动，审核会更仔细；"dangerous permission requests" 和 "broad host permissions or sensitive execution permissions" 会触发更深入审查：<https://developer.chrome.com/docs/webstore/review-process>。该页未明确说使用 optional 权限能缩短审核。提交时需准备每个权限的理由。
- 用户数据政策：所有处理用户信息的产品必须发布隐私政策；浏览活动 / 网站内容属于用户数据，收集须是 "reasonably required" 于已披露的单一用途；Limited Use 要求仅用于单一用途，禁止转让给数据经纪人 / 个性化广告等：<https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>、<https://developer.chrome.com/docs/webstore/program-policies/limited-use>。FAQ 明确"安全处理"要求不适用于"扩展与同一台电脑上的原生程序之间的传输"，所以发往本机 AnkiConnect 的 HTTP 明文通信不违规。
- MV3 要求：禁止远程托管代码（不得加载包外 `<script>`、不得对远程字符串 `eval`）；可获取非逻辑性的远程资源（如配置、图片）：<https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>。
- 没有找到专门针对"扩展访问 localhost / 127.0.0.1"的政策条款。审核实际表现只能在提交后得知 **[待验证]**；建议在商店说明与隐私政策中明确写出"仅在用户操作时与本机 Anki（AnkiConnect）通信，不向第三方服务器发送阅读内容"（以实际行为为准）。

## 6. 对 PRD 的建议（供后续 ticket 采用）

1. 所有 AnkiConnect 调用封装在 service worker，content script 只发消息。
2. 先实测"不声明任何 127.0.0.1 host_permissions"能否工作；若能，可降低安装警告面。
3. 提供"连接检测"：调用 `version`（legacy v6）；403 则提示添加 `chrome-extension://<id>` 或触发 `requestPermission`；带 apiKey 时区分错误信息。
4. 站点授权 UI：按钮手势触发 `permissions.request({origins:[...]})`，授权后 `registerContentScripts`；"所有站点"开关请求 `<all_urls>`，并在 `permissions.onRemoved` 时清理注册。
5. 隐私说明要包含"任意本机扩展可访问 AnkiConnect"的风险提示，鼓励设置 apiKey。

## 7. 待真实环境验证清单（issue #7）

1. Chrome stable（>=144）下 SW fetch `http://127.0.0.1:8765` 是否出现 LNA 提示；有无 host permission 的差异。
2. 默认 AnkiConnect 配置下 `chrome-extension://<id>` 的 `version` 调用返回；`webCorsOriginList` 去掉 `http://localhost` 后的 403 与 `requestPermission` 弹窗流程。
3. 带 apiKey 时 legacy `key` 字段行为；旧版（AnkiWeb 发布版）与 26.08+ 新版各验证一次。
4. 声明 `http://127.0.0.1/*` 的安装警告文案；`optional_host_permissions` 中 `*://*/*` 与 `<all_urls>` 的请求行为与提示文案。
5. `permissions.request` 从 popup / options / side panel 调用的手势有效性，以及 SW 内调用的失败表现。
6. `registerContentScripts` 对已打开页面的影响、撤销授权后的状态、浏览器重启后的持久化。
7. 实际 CWS 审核反馈（提交后）。
