# VOKA P0 可开工规格

> 状态：可开工 · 2026-10-31 · 由 wayfinder 地图「[VOKA P0 可开工规格](https://github.com/xzpjerry/VOKA/issues/1)」汇总而成。
>
> 这份规格以 PRD（`docs/VOKA-PRD.html`，只在维护者本地，不进仓库）为底本，合并了地图上所有 ticket 的决定和三份 ADR。**本文与 PRD 冲突时，以本文为准**；本文没写到的 P0 细节，回到 PRD 查。术语以 [`GLOSSARY.md`](../../GLOSSARY.md) 为准。
>
> 难以逆转的决定写在 ADR 里，实现前必读：
> - [ADR-0001 词条 Key 按 lemma 定义、永不改变，等级取各词性最低](../adr/0001-word-key-per-lemma-lowest-level.md)
> - [ADR-0002 只支持新版 AnkiConnect 的 v1 接口，连不上 Anki 时扩展完全不运行](../adr/0002-new-ankiconnect-v1-only-no-run-without-anki.md)
> - [ADR-0003 每门学习语言一个笔记类型，核心字段一次定齐，释义语言靠 CSS 切换](../adr/0003-note-type-per-language-fixed-core-fields.md)

---

## 1. P0 要交付什么

一个可以公开上架 Chrome Web Store 的桌面 Chrome MV3 扩展。它完成「选等级 → 安全导入 → 阅读标注 → 读取 Anki 状态 → 保存真实例句」这个闭环，学习语言只有英语。

用户能感知到的结果：

1. 首次安装后，向导检查 Anki 连接，让用户选母语、释义语言和目标等级（默认 B1），预览后确认，把该级词汇建成 Anki 词卡（`VOKA::English::B1`，2,088 张）。已有笔记、卡片和复习进度不受影响。
2. 阅读网页时，按目标等级和 Anki 状态高亮；悬停已高亮的词显示一行释义，单击或双击打开完整卡片，可以查释义、加入 Anki、保存真实例句（每个词条最多三条）。
3. 在 Anki（包括手机端）复习词卡时，正面看到自己读过的那句话，背面看到所选释义语言的释义；切换释义语言只改 CSS，不触发全量同步。

**两类学习者**：母语中文学英语（释义可选中文或英文）；母语英语扩充英语词汇（只用英文单语释义）。两类都用 CEFR 分级。界面语言中文和英文，国际化框架从 P0 搭好。

## 2. 不在 P0 范围内

- P1 上下文复习（与今日到期卡求交集、四档评分）、多语言阶段（de / es / ja）、P2（YouTube / EPUB / PDF）、P3（云翻译 / TTS / CLI / 同步）。底部抽屉里给「今日到期数」留了位置，但 P0 不实现复习。
- 多词短语（phrasal verb、习语）的识别与释义；等级词表里的 154 条多词短语不导入。
- 面向母语者的进阶词表（AWL、GRE 等）。
- 中文、英文以外的界面语言。
- Anki 26.08 以前的版本和旧版 AnkiConnect。
- 用释义考词条的反向卡。
- 自动采集例句；扫描件 OCR；无 Anki 的学习模式；手机 Chrome。

## 3. 相对 PRD 的改动

| 主题 | PRD 原文 | 本规格 | 依据 |
|---|---|---|---|
| Anki 版本 | 未限定，AnkiConnect API v6 | 只支持 Anki ≥ 26.08 + 新版 AnkiConnect，只用 **v1 JSON-RPC**（`POST /api/v1`） | ADR-0002 |
| 断连行为（FR-12、§16、T-01） | 离线词典继续可用，Anki 状态显示「无法确认」 | 连不上、版本太低或检测不出来时**扩展完全不运行**，只显示检查提示 | ADR-0002 |
| 词条等级 | 一个词可同时属于多个等级（等级成员标签） | 每个词条只有一个**词条等级**，取各词性最低；当前数据下几乎没有跨等级复用 | ADR-0001 |
| 词条 Key | `language:lemma` | 规范化为小写、NFC、直撇号；大小写词和拼写变体合并 | ADR-0001 |
| 等级标签 | `LevelTags` 字段或标签 | 只用标签 `voka::level::XX` | ADR-0003 |
| 笔记类型 | 一个 `VOKA Vocabulary` | 每门学习语言一个，`VOKA Vocabulary · English`；核心字段一次定齐 | ADR-0003 |
| 释义 | 一个 `Meaning` 字段 | `GlossNative`（母语释义）+ `GlossTarget`（单语释义），CSS 切换 | ADR-0003 |
| 人工状态 | auto / unknown / learning / known | 只有 `known` / `unknown`（空 = auto）；「学习中」交给 Anki 排程 | 「悬停弹窗与侧栏的交互形态」 |
| 界面形态 | Side Panel + 悬停弹窗 | 页面内**底部抽屉** + 一行提示 + 点击展开卡片（方案 B） | 同上 |
| 例句采集 | 用户触发或确认自动采集 | P0 只在用户主动操作时保存 | 「正文提取、隐私过滤与真实例句的分句规则」 |
| 例句来源 | URL / 视频时间戳 / 书名 | 默认只存「站点域名 · 页面标题 · 日期」，完整 URL 是默认关闭的开关 | ADR-0003 |
| 中文释义来源 | 离线词典（未指定） | VOKA 构建阶段用 LLM 自己生成，不内置 ECDICT | 「选定英语等级词表与词典组合」 |
| 复习交互 | — | P0 不做（P1） | 地图范围 |

## 4. 运行前提与「不运行」

- 桌面 Chrome / Chromium，Manifest V3。
- Anki ≥ 26.08，安装新版 AnkiConnect（插件代码 `2055492159`，AnkiWeb 会按 Anki 版本自动分发新版）。
- **每次开始工作前**，后台网关用 `api.describe` 确认对方是新版 AnkiConnect，并且支持本规格用到的全部方法。
- 任一条件不满足（连不上、版本太低、检测不出来、未授权、API Key 不对），**扩展完全不运行**：不高亮、不查词、不写 Anki；底部抽屉的摘要行显示「VOKA 未运行：请检查 Anki」，点开看到第 12 节的分项修复指引。
- **读到一半 Anki 断开**：撤掉页面上已显示的高亮和浮层，抽屉显示提示；不在后台一直重试，用户点「重试」、刷新页面或打开新页面时再检测，连上后自动恢复。

## 5. 架构与数据归属

```
Content Script（分词、Range 高亮、一行提示、完整卡片、底部抽屉；UI 放在 Shadow DOM 里）
        │ chrome.runtime 消息
Background Service Worker（唯一的 AnkiConnect v1 网关、离线数据加载、设置）
        │ fetch http://127.0.0.1:<port>/api/v1
AnkiConnect v1（新版） → Anki Desktop Collection（权威数据）
Options 页（首次安装向导 + 设置页）
```

| 数据 | 权威存储 | 说明 |
|---|---|---|
| 词条、两种释义、音标、真实例句与来源、人工状态、等级标签 | Anki 笔记字段 / 标签 | 写前先读当前内容再合并，写后回读 |
| 复习阶段、间隔、到期、复习历史 | Anki 卡片与 revlog | 只读，不自己实现间隔复习 |
| 学习语言、母语、释义语言、目标等级、站点范围与禁用名单、UI 偏好、端口与 API Key | `chrome.storage.local` | 不得存词汇状态、例句、评分 |
| 等级词表、离线词典、词形还原数据 | 扩展静态数据包 | 每个包带来源、许可、版本、词数 |
| 当前页 token 与 Anki 查询结果 | 内存 | 可丢弃、可重算 |

**所有 Anki 请求只能由 service worker 发出。** 实测：Chrome 156 下，service worker 请求 127.0.0.1 立即成功、没有本地网络访问提示；网页上下文的请求会被本地网络访问提示挂起，并被 AnkiConnect 用 403 拒绝。

## 6. AnkiConnect v1 网关

请求格式为 JSON-RPC 2.0：`{"jsonrpc":"2.0","id":…,"method":…,"params":{…}}`。设了 API Key 时用 `Authorization: Bearer <key>` 头传递。端口默认 8765，可在设置中修改。

| 用途 | v1 方法 | 要点 |
|---|---|---|
| 能力检测 | `api.describe` | 每次开始工作前调用 |
| 授权 | `access.requestPermission` | 只用于「来源未授权」的修复按钮 |
| 牌组 | `decks.list`、`decks.create` | `decks.create` 对已存在的同名牌组返回原牌组 |
| 笔记类型 | `noteTypes.list`、`noteTypes.get`、`noteTypes.create`、`noteTypes.update` | `create` 可设 `sortField`；`update` 只改 CSS、名称这类非结构设置；**不调用 `noteTypes.editStructure`** |
| 预检 | `notes.validateMany` | 等级导入和加入 Anki 前都要先预检 |
| 写入 | `notes.createMany` | 默认 `atomic: false`，逐条独立写入，每条有自己的结果 |
| 查找与读取 | `notes.search`、`notes.getMany`、`cards.search`、`cards.getMany` | 批量调用；不逐个 token 请求 |
| 更新字段 | `notes.update` | 只合并要改的字段；写后回读 |
| 标签 | `tags.add`、`tags.remove` | |
| 异步操作结果 | `operations.get` | 仅对返回 `operationId` 的方法凭句柄回查；本表的笔记、标签与笔记类型写入直接返回完成结果，不返回操作句柄。超时、断连时按 Key / ID 回读核对，**禁止盲目重发** |
| 同步（仅测试用） | `collection.sync` | 扩展本身不主动触发同步 |

**v1 复核已完成**（Anki 26.09.3，隔离实例，见[原始响应与复核报告](../research/anki-v1-review.md)）：首字段判重区分大小写、先去 HTML，默认按整个收藏查同一笔记类型；`duplicates.scope: "deck"` 必须指定 `deck`，`acrossNoteTypes: true` 可跨笔记类型判重，非法 scope 返回 `invalidParams`。`notes.validateMany` 返回 `items[{index,result:{valid,issues,duplicateNoteIds}}]`；`notes.createMany` 在 `atomic:false` 时返回逐条 `result` 或 `error`，成功项保留；`atomic:true` 遇重复返回顶层 `validationFailed`，整批不写入。新建笔记类型、更新 CSS / 名称、更新笔记字段、添加标签均不改变 `col.scm`；结构编辑添加字段会改变它。

**禁止调用**：任何会重置排程或改动结构的方法（如 `scheduling.reset`、`scheduling.setDueDate`、`cards.move`、`noteTypes.editStructure`），除非将来有专门的规格。

## 7. 数据

### 7.1 等级词表

- **CEFR-J Wordlist 1.6**（A1–B2，东京外国语大学 Tono 研究室）+ **Octanove Vocabulary Profile C1/C2 1.0**（CC BY-SA 4.0）。
- 做成**两个独立的数据文件**，各带署名与许可：CEFR-J 按其要求的格式引用；Octanove 按 CC BY-SA 4.0 署名并标明修改。不要合并成一个文件。
- 构建规则：按 ADR-0001 合并为 lemma；词条等级取各词性最低；带斜杠的变体取第一个拼写作为 Key，其余记为异体拼写；去掉多词短语。
- 按 v1.5 数据实算的各级词数：A1 1,049 / A2 1,202 / B1 2,088 / B2 2,384 / C1 909 / C2 869，合计 8,501。换成 1.6 后以重算结果为准。

### 7.2 离线词典

| 内容 | 来源 | 许可 |
|---|---|---|
| 单语释义（英→英） | Open English WordNet | CC BY 4.0（含 Princeton WordNet 声明） |
| 母语释义（英→中） | **VOKA 自己生成**：构建阶段用 LLM，依据 OEWN 义项与词性生成 | VOKA 自有，按 OEWN 的 CC BY 署名 |
| 音标 | CMUdict 转 IPA（**只提供美式**），OEWN 自带音标作补充 | BSD 式 / CC BY |
| 词形还原 | WordNet 不规则词形表 + 后缀规则（如 wink-lemmatizer） | MIT + 保留 Princeton 声明 |

- **收录范围**：OEWN 全部单个词的 lemma（约 8 万多个）；OEWN 里没有的词显示「词典没有」。
- **释义格式**：按词性分组；母语释义每个词性最多 3 个义项、每个不超过 10 个字；单语释义每个词性最多 2 条。例：`light　n. 光；灯　adj. 明亮的；轻的　v. 点燃`。
- **中文释义生成流程**：默认用最便宜的模型（haiku / Codex CLI luna），每次请求处理一批词。正式生成前先过**试点门槛**：按等级分层抽约 300 词，和中档模型（sonnet / sol）各生成一遍，人工抽查错误率；不达标的那一层改用中档模型。抽查时等级词表里的词抽得更多。
- **不内置** ECDICT（中文释义的版权链无法核实）和 Wiktionary/Kaikki（相同方式共享 + 体积大）。
- 每个数据包都带数据版本号（如 `en-2026.10`），供第 8 节的数据升级使用。分包和加载方式由实现决定；压缩后预估总量在 5MB 以内。
- 构建脚本放在仓库里（例如 `tools/data/`），可以重复执行；扩展里的「关于」页列出全部署名。

### 7.3 上架前门槛（已确认，2026-11-01）

1. **CEFR-J**：条款为 "CEFR-J vocabulary and grammar profile datasets can be used for research and commercial purposes with no charge, provided that you cite the dataset properly. The copyright belongs to Tono Laboratory at TUFS (Tokyo University of Foreign Studies)."，内置进产品免费可用，前提是正确引用；版权属 TUFS 投野研究室，数据不保证准确。`attributions.json` 与「关于」里的引用保持现有写法。
2. **Octanove C1/C2**：按 CC BY-SA 4.0 使用。改编后的 `octanove.json` 作为单独文件继续以 CC BY-SA 4.0 发布，不影响其他数据包的许可。

## 8. 词条 Key 与匹配（ADR-0001）

- 一个 lemma 一条笔记。Key = `en:` + 规范化 lemma：小写、Unicode NFC、弯撇号转直撇号，保留连字符和变音符号。**Key 永不改变。**
- 同形异义词合在一条笔记里，音标按词性分列（`n. /lɛd/ · v. /liːd/`）；只靠大小写区分的 4 组词（it/IT、march/March、may/May、miss/Miss）各合并成一条笔记。
- **阅读时的匹配**：词形 → 词形还原 → 候选 lemma。只有一个候选时直接匹配；有多个候选（saw → see / saw）时，默认匹配词条等级最低的那个，等级相同时优先词形本身就是 lemma 的那个。完整卡片里列出其他候选供改选，改选后保存例句、加入 Anki 都按用户选的 Key。异体拼写（colour）匹配到同一个 Key（`en:color`）。
- **手动加入的词**：有词条等级的，放进该等级的牌组（需要时才建，不导入整级）；没有等级的，放进未分级牌组 `VOKA::English::Unleveled`。

## 9. Anki 笔记类型与词卡（ADR-0003）

### 9.1 字段

笔记类型 `VOKA Vocabulary · English`，模板名「词卡」，浏览器排序字段 `Word`。**建好后永不增删字段。**

| # | 字段 | 内容 |
|---|---|---|
| 1 | `Key` | `en:achieve` |
| 2 | `Word` | 显示用的词形 |
| 3 | `Variants` | 异体拼写，逗号分隔 |
| 4 | `Reading` | 按词性分列的音标 |
| 5 | `GlossNative` | 母语释义；母语等于学习语言时留空 |
| 6 | `GlossTarget` | 单语释义 |
| 7–12 | `Context1` `Source1` `Context2` `Source2` `Context3` `Source3` | 真实例句（目标词加粗）与来源 |
| 13 | `ManualStatus` | 空 = auto；`known` / `unknown` |
| 14 | `Audio` | 预留，P0 不用 |
| 15 | `VokaMeta` | JSON：`schema`、`data`（数据版本）、生成字段的内容哈希、置顶例句的内容哈希 |

标签：所有 VOKA 笔记打 `voka`；词条等级用 `voka::level::B1`（不靠牌组判断等级，因为用户可能手动移动卡片）。

以后新增学习语言时，新建该语言的笔记类型：15 个核心字段不变，语言特有字段只能在**第一次创建时**追加在后面。

### 9.2 模板与 CSS

完整代码见「[VOKA 笔记类型字段与词卡模板定稿](https://github.com/xzpjerry/VOKA/issues/10)」的评论，下面是要点：

- **正面**：`Word`（大字）、`Reading`、`Context1`。
- **背面**：正面内容，然后是释义（按释义语言显示一种）、`Context2`、`Context3`、灰色小字的来源。
- 两种释义都写在背面；空字段用 `{{^Field}}` 输出缺失标记 `.miss-native` / `.miss-target`，**两个缺失标记放在两个释义元素之前**。
- 显示哪一种释义，只由 CSS 里 `/* voka:begin */ … /* voka:end */` 标记段内的两条规则决定：
  - 母语释义模式：`.gloss-native{display:block}` `.miss-native ~ .gloss-target{display:block}`
  - 单语释义模式：`.gloss-target{display:block}` `.miss-target ~ .gloss-native{display:block}`
- 切换释义语言 = 读出当前 CSS → **只替换标记段** → `noteTypes.update` 写回，以保住用户自己加的样式。不改笔记、不触发全量同步。
- 回退不依赖 `:has()`。已在 AnkiMobile 25.09 和 AnkiWeb 往返中验证；AnkiDroid 没测过。

### 9.3 释义数据升级

扩展更新带来新的释义数据后：

- **提示**：底部抽屉的摘要行显示「释义数据有更新 · 查看」（不打断阅读）；设置页有「检查释义数据更新」；下次导入的预览里也附带一个「已有 N 张词卡的释义有更新」区块。
- **判断「用户没改过」**：当前字段内容的哈希等于 `VokaMeta` 里记录的哈希。
- **预览**分两组：「你没改过的」默认全部更新；「你改过的」逐条对比「你的版本 / 新版本」，**默认保留你的版本**，可以单条或整组改用新版。
- 只改 `GlossNative`、`GlossTarget`、`Reading`；用户确认前不写入；写入后更新 `VokaMeta`。

## 10. 高亮规则

按优先级从上到下，第一条命中的规则决定样式：

| 优先级 | 情况 | 样式 |
|---|---|---|
| 1 | `ManualStatus = known` | 不高亮 |
| 1 | `ManualStatus = unknown` | 强高亮（红），不受等级限制 |
| 2 | Anki Learning / Relearning / Review 间隔 < 21 天 | 学习中（蓝） |
| 2 | Anki Review 间隔 ≥ 21 天 | 不高亮（阈值可在设置中调） |
| 3 | 词条等级 = 目标等级（含 Anki New 和尚未加入 Anki） | 目标词（黄） |
| 3 | 词条等级低于目标等级 | 不高亮；不自动标成 known |
| 3 | 词条等级高于目标等级 | 弱高亮（淡黄），**默认关闭** |
| 4 | 不在任何等级词表里 | 不高亮；可双击查词 |
| 独立 | 离线词典里查不到 | 卡片显示「词典没有」，与等级无关 |

- Suspended / buried 的卡不等于已掌握，按第 3 层的等级规则处理。
- 高亮用 TreeWalker + Range + CSS Custom Highlight API，不往页面里大量插入 span；动态页面用 MutationObserver 节流后增量处理。
- 颜色细节交给实现；原型里的配色可参考。

## 11. 阅读界面（方案 B）

原型：分支 `prototype/reading-ui` 上的 `prototypes/reading-ui.prototype.html`（`?variant=B`）。

- **悬停已高亮的词**：显示一行提示（词条 + 释义摘要）。设置项「悬停提示的范围」：只有高亮的词（默认）/ 所有识别出的词。
- **单击已高亮的词** 或 **双击任意词**：弹出完整卡片。单击没高亮的词不弹卡片，避免和链接、按钮冲突。
- **完整卡片**：
  - 词条、音标、词条等级、多个候选 lemma 时的改选、Anki 状态；
  - 释义（按释义语言显示，可展开另一种）；查不到时显示「词典没有」；
  - 「加入 Anki（含这句例句）」或「保存这句为例句（n/3）」；满三条时变成「替换一条…」（见第 12 节）；
  - 人工标记按钮，文字跟着情况变：已高亮的词显示「我认识，别再高亮」→ `known`；没高亮的词显示「我不认识，高亮它」→ `unknown`；标记过的词显示「撤销标记」。
- **底部抽屉**：默认收起，收起时显示一行摘要（「本页 N 个目标词 · M 张今日到期」，P0 的到期数可以先不显示或显示占位）。展开后有：连接状态、学习语言与目标等级、释义语言切换、进阶词弱高亮开关；四个筛选（目标词 / 学习中 / 词典没有 / 全部）和本页词汇列表。点列表里的词，滚动到它在文中的位置并弹出卡片。
- 所有页面内 UI 放在 Shadow DOM 里，关闭浮层时不拦截网页原有的交互。

## 12. 正文提取、隐私与真实例句

### 12.1 不处理的区域

输入框、多行文本框、可编辑区域、密码框；`code`、`pre`、`kbd`、`samp`；隐藏元素、`aria-hidden`、`script`、`style`；`nav`、`footer`、`[role=navigation]`；Chrome 自身页面。其余部分整页处理，**不做**自动识别正文。

### 12.2 默认禁用的网站

内置一个用户可编辑的小名单：常见邮箱（Gmail、Outlook、QQ 邮箱）、即时聊天（WhatsApp Web、Telegram Web、Discord、Slack）、密码管理器网页版。名单只在「记住启用过的网站」「所有网站」两种模式下生效；用户在名单里的网站上手动点图标仍可运行。

### 12.3 保存例句

- 只在用户点「加入 Anki（含这句例句）」或「保存这句为例句」时写入；P0 不做自动采集。
- **分句**：在包含这个词的段落块里用 `Intl.Segmenter`（按句子）切；列表项、标题、表格单元格没有句末标点时整块当一句；超过约 300 个字符时以目标词为中心截取并加「…」；少于 3 个词的句子不允许保存（提示「这句太短，换一句吧」）；加粗**用户实际遇到的词形**；去掉脚注标记（`[1]`、`¹`）。
- **去重**：统一成小写、合并空白、忽略首尾标点后比较；相同的不再保存，按钮显示「这句已保存过」。
- **来源**：默认「站点域名 · 页面标题 · 日期」；完整 URL 是默认关闭的开关。
- **满三条与置顶**：最多一条**置顶例句**，它就是 `Context1`；没有置顶时 `Context1` 是最新的那条。未满三条时，新例句成为最新的一条，其余后移。满三条时按钮变成「替换一条…」，列出已有三条让用户选，默认选中最旧且没置顶的那条；置顶的要先取消置顶才能替换；在同一列表里点 ★ 切换置顶。
- **用户在 Anki 里改过例句**：写入前先读出当前内容再合并，绝不用记住的旧内容覆盖；置顶按 `VokaMeta` 里的内容哈希识别，找不到对应的那句就视为没有置顶。

## 13. 引导、设置与等级导入

原型：分支 `prototype/onboarding` 上的 `prototypes/onboarding.prototype.html`（向导看 `?variant=A`，设置页看 `?variant=B`）。

### 13.1 首次安装向导（三步，上一步没完成不能进入下一步）

1. **连接 Anki**：按顺序逐项检查，上一项没通过，下一项显示「等上一步」。
   - **连不上**：扩展区分不出是 Anki 没开、没装 AnkiConnect 还是端口不对，所以合并成一条提示让用户逐项检查，并提供端口输入框。
   - **版本过低**：提示升级到 Anki ≥ 26.08，并在「工具 → 插件」里更新 AnkiConnect。
   - **来源未授权**：「请求访问权限」按钮（`access.requestPermission`），提示切到 Anki 窗口点「允许」；也说明可以手动在 webCorsOriginList 里加入扩展来源。默认配置的用户不会遇到这一步。
   - **设了 API Key**：输入框。
   - 只在用户点「重新检测」或刷新页面时再检测。
2. **学习设置**：学习语言（P0 只有 English）、母语、释义语言（母语等于学习语言时隐藏）、目标等级（每级显示词数，默认 B1）、站点范围三选一：
   - 点工具栏图标才在当前页运行（**默认**，用 `activeTab` + `scripting`，没有安装警告）；
   - 记住启用过的网站（`optional_host_permissions` 运行时授权 + `scripting.registerContentScripts`）；
   - 所有网站（运行时申请 `<all_urls>`，说明 Chrome 会显示的权限提示）。
   - `permissions.request` 必须在用户手势里调用。
3. **导入预览**：见 13.3。

### 13.2 设置页

单页布局，区块与向导相同：连接状态、学习设置、各等级导入、数据更新检查、站点禁用名单、关于（全部数据署名）。连接没通时，下面的区块置灰不可操作。

### 13.3 等级导入

- **预览**（只读，不写 Anki）：新建 / 已存在 / 冲突（同一 Key 有多条笔记）/ 跳过的数量；目标牌组和笔记类型是新建还是已存在；写明「不会修改、移动或重置任何已有卡片」和「新卡由 Anki 按你的每日新卡上限逐步引入」；数据来源与版本。
- **执行**：先建缺失的牌组与笔记类型，再按每批 200 条执行「`notes.validateMany` → 只提交可添加的 → `notes.createMany` → 回读确认」。可以取消，已写入的保留；中途断开后「继续导入」只补剩下的；同一级再导入一次显示「新建 0」。
- **冲突**：同一 Key 已有多条笔记时，列出具体 Key，跳过不处理，不静默合并或删除。
- **「先不导入」**：保留，旁边注明「不导入的话，无法使用上下文复习」；之后随时可以从设置页导入。不导入时目标词照样高亮，卡片里显示「未加入 Anki」。
- **切换目标等级**：只改高亮目标；新等级没导入时，在设置页提示可以导入；绝不删除、移动或重置旧卡。
- 绝不调用重置排程、移动牌组之类的方法来「补全」导入。

## 14. 权限

- `manifest.json`：`background.service_worker`；`permissions`：`storage`、`activeTab`、`scripting`；`host_permissions`：`http://127.0.0.1/*`（实测不声明也能连通，因为 AnkiConnect 会回 CORS 头，但声明后不依赖这一点；上架时确认安装提示的文案）；`optional_host_permissions`：`*://*/*`。
- 不再需要 `sidePanel` 权限（界面改成页面内抽屉）。
- 不发起任何翻译、语音、AI 云调用（P0 没有）。

## 15. 异常与边界

| 情况 | 应有行为 |
|---|---|
| Anki 没开 / AnkiConnect 没装 / 端口不对 | 扩展不运行；抽屉和设置页显示合并后的检查提示 |
| 版本过低 / 不是新版 AnkiConnect | 扩展不运行；提示升级 |
| 来源未授权、API Key 缺失或错误 | 扩展不运行；给出修复说明；不在后台反复重试，不绕过权限 |
| 读到一半 Anki 断开 | 撤掉高亮和浮层；用户重试或换页时再检测 |
| 再次导入同一级 | 新建 0，已有的原样保留 |
| 同一 Key 已有多条笔记 | 视为冲突，列出并跳过 |
| 写入超时、结果不确定 | 用 `operations.get` 或重新读取笔记确认结果，不盲目重发 |
| 用户在 Anki 里改过释义或例句 | 合并前先读当前内容；释义升级时默认保留用户版本 |
| 用户在 Anki 里把卡片移到别的牌组 | 等级按标签判断，不受影响 |
| 用户在 Anki 里改了模板 CSS | 释义切换只替换 `voka:begin/end` 标记段 |
| 切换目标等级 | 只改高亮目标，不改旧卡 |

## 16. 验收测试

全部写入型测试只在隔离测试实例上做（见第 17 节）；mock 测试不能代替真实 AnkiConnect 集成测试。

| ID | 测试 | 期望 |
|---|---|---|
| T-01（改） | 关闭 Anki 后刷新页面 | 扩展不运行、页面没有任何高亮、抽屉显示检查提示；重新打开 Anki 后点「重试」即恢复 |
| T-02（改） | 测试实例去掉 `http://localhost` 后连接，再用「请求访问权限」允许 | 允许前不写任何数据；允许后可以读写 |
| T-03（改） | 选 en / B1，看预览后确认 | 新建 `VOKA Vocabulary · English`、`VOKA::English::B1` 和 2,088 条笔记（以 1.6 数据重算为准），带 `voka` 与 `voka::level::B1` 标签 |
| T-04 | 连续两次导入同一级 | 第二次新建 0，卡片数量不变 |
| T-05 | 先在 Anki 复习若干词，再导入相邻等级 | 原有间隔、到期、复习记录和字段都不变 |
| T-06（改） | B1 学习者手动加入一个 A2 词，之后导入 A2 | 该词在 `VOKA::English::A2`；导入 A2 时它显示为「已存在」，只有一条笔记 |
| T-07 | B1 → B2 → B1 | 高亮按当前目标恢复；旧卡状态与例句不变 |
| T-08（改） | 把一个 A1 词标成「我不认识」，把一个 B1 词标成「我认识」 | 前者红色高亮，后者不高亮；撤销后恢复自动规则 |
| T-09 | React / Vue 页面动态加载新段落 | 新节点被标注，不明显改变正文和版式 |
| T-10（改） | 同一个词从 4 个页面各保存 1 条例句 | 第 4 次出现「替换一条…」并让用户选择；Anki 里最多 3 条；用户在 Anki 里改过的例句文字不被抹掉 |
| T-11 | 查一个等级词表有、离线词典没有的词（或反过来） | 等级与「词典没有」分别正确显示 |
| T-26（新） | 切换释义语言 | 只改 CSS 标记段；`col.scm` 不变（不触发全量同步）；词卡背面切换；用户自加的 CSS 保留 |
| T-27（新） | 某张卡缺母语释义（或缺单语释义） | 回退显示另一种；不依赖 `:has()` |
| T-28（新） | 阅读 "I saw…" 和 "colour" | saw 与 see 同为 A1，按平级规则默认匹配 `en:saw`，完整卡片可改选 `en:see`；colour 匹配 `en:color` |
| T-29（新） | 用新版本数据做释义升级，其中有用户改过的笔记 | 预览分两组；用户改过的默认保留；确认前 Anki 没有任何变化 |
| T-30（新） | 在输入框、可编辑区域、`code` 块、`nav` 里放目标词 | 不高亮、不能保存例句 |
| T-31（新） | 「记住启用过的网站」模式下打开 Gmail | 不自动运行；手动点图标可以运行 |
| T-32（新） | 保存超长句、过短句、带脚注的句子、重复句 | 截取并加「…」；拒绝过短；去掉脚注；提示已保存过 |
| T-33（新） | 用 v1 重跑判重与批量写入 | 结果与第 6 节一致，或在测试报告中写明差异 |

## 17. 测试环境

- **隔离测试实例**：`~/VOKA-anki-test`（独立数据目录），用 `~/VOKA-anki-test/launch.sh` 启动（设置 `ANKI_SINGLE_INSTANCE_KEY=voka-test`，可与日常 Anki 同时运行）。AnkiConnect 端口 **8766**，已登录一次性 AnkiWeb 账号，可用来测同步。**写入型请求只发 8766，绝不发日常 Anki 的 8765。**
- 实例里留有原型阶段的测试数据（`VOKA Vocabulary TEST/TEST2`、`VOKA Proto`、`VOKA Vocabulary · English` 等笔记类型和样例笔记），开始实现前可以清理。
- 判断「是否触发全量同步」：拷贝 `collection.anki2` 和 `-wal` 到临时目录（删掉旧的 `-shm`），比较 `col.scm`。
- 手机端：AnkiMobile 25.09 已验证模板与释义切换；AnkiDroid 没有测试设备。
- 浏览器自动化：可以用 puppeteer + Chrome for Testing 加载扩展（品牌版 Chrome 已不支持 `--load-extension`）。

## 18. 实施顺序

先打通真实闭环，再扩大功能。

**第一个可运行检查点**

1. `npm install`、`npm run build` 生成可加载的 MV3 `dist/`；Options 页能打开。
2. 后台网关用 `api.describe` 连上测试实例（8766），只读查询牌组与笔记类型；连不上时扩展不运行并显示提示。
3. 用一小段测试词表创建 `VOKA Vocabulary · English`，验证 Key 规范化和「再导入新建 0」。
4. 等级导入预览 → 确认 → 分批写入 → 回读，不影响已有卡片。
5. 在示例英文网页上正确高亮 B1 词，弹出卡片查离线释义，保存当前例句，在 Anki 里看到这句话，最多三条。

**之后的拆分**（对应 PRD Sprint A，已按本规格调整）

| 编号 | 内容 |
|---|---|
| A01 | 工程骨架：MV3 + TypeScript + Vite；Options 页；content script 与 Shadow DOM 容器；构建与本地运行说明 |
| A02 | v1 网关：`api.describe` 检测、授权、API Key、端口、错误分级、「不运行」状态机 |
| A03 | 数据构建流水线：等级词表（两个独立文件）、OEWN、CMUdict→IPA、词形还原数据、中文释义生成（含试点门槛）、署名与版本元信息 |
| A04 | 词条 Key 规范化与匹配：词形还原、候选 lemma 选择、异体拼写 |
| A05 | 笔记类型与模板：创建、CSS 标记段读写、释义语言切换 |
| A06 | 首次安装向导与设置页；等级导入预览与分批执行 |
| A07 | 正文提取、Range 高亮、高亮规则、动态页面；一行提示、完整卡片、底部抽屉 |
| A08 | 人工标记、加入 Anki、例句分句/去重/替换/置顶、写前读写后回读 |
| A09 | 站点范围与禁用名单；释义数据升级流程 |
| A10 | T-01～T-11、T-26～T-33 验收；v1 行为复核报告 |

## 19. 已知风险与待验证

- **数据许可**：已确认，见 7.3。
- **中文释义质量**：LLM 生成，靠试点门槛和抽查控制；释义升级流程是后续修正的通道。
- **v1 行为**：第 6 节列出的几项要在实现初期用测试实例重新确认。
- **AnkiDroid**：不做设备验证（维护者决定，模板只用标准 Anki 卡片特性并避开 `:has()`）；上架说明里注明「AnkiDroid 未测试」。
- **整级导入的高亮噪音**：导入后 B1 词都是 Anki 新卡，会一直高亮，直到复习间隔超过 21 天；「我认识，别再高亮」是主要出口。上线后关注用户反馈。
- **Chrome Web Store 审核**：访问 localhost 与可选的 `<all_urls>` 的实际审核反馈要等提交后才知道。

## 20. 参考

- 地图：[VOKA P0 可开工规格](https://github.com/xzpjerry/VOKA/issues/1)（每个决定的细节在对应 ticket 的结论评论里）
- 研究分支（只存资料，不合并）：`research/cefr-wordlists`、`research/offline-dictionary-data`、`research/mv3-ankiconnect-access`、`research/ankiconnect-model-ops`
- 原型分支（不合并）：`prototype/reading-ui`、`prototype/onboarding`
- 术语：[`GLOSSARY.md`](../../GLOSSARY.md)；ADR：[`docs/adr/`](../adr/)
