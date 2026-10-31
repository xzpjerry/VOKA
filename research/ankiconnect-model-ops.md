# AnkiConnect 笔记模型操作与同步影响（Issue #5）

调研日期：2026-10-31。只陈述事实；schema 决策留给后续 grilling 票。标记 **[待验证]** 的结论需要在真实环境（Issue #7）里确认。

## 0. 先看的结论

1. **改 CSS 或改模板文本（qfmt/afmt）不会设置 schema-modified 标志，不会强制全量同步。** 改动作为普通 notetype 变更在下次正常同步中按 mtime 合并。
2. **增/删/重排字段、增/删/重排卡片模板、改排序字段（sort field）会强制单向全量同步。** 字段**重命名**和**新建 notetype** 不会。
3. 因此“全局释义语言开关”可以只靠改模型 CSS（或改模板）实现，不改笔记、不动调度、不触发全量同步。前提是 **L1 与 L2 释义两个字段从第一版 notetype 起就存在**（事后加字段 = 一次全量同步）。
4. AnkiConnect 重复检测默认：**整个集合范围、仅同一 notetype、只比对第一个字段**（去 HTML、区分大小写）。`allowDuplicate` / `duplicateScope:"deck"` / `checkChildren` / `checkAllModels` 可调整。
5. **AnkiConnect 上游已重写**（见 1.1）。`addNotes` 在旧实现里是“逐条、失败返回 null”，在新 legacy 适配层里是“整批原子、任一失败整批报错”。两种实现都可能在用户机器上，必须都处理。

## 1. 来源与版本

| 来源 | 版本 / 日期 | 备注 |
| --- | --- | --- |
| AnkiConnect 旧实现（单文件 `plugin/__init__.py`，2007 行） | GitHub 镜像 `FooSoft/anki-connect` HEAD（`4064fa1`，2025-11-04）。镜像 README 声明“已永久迁移到 sr.ht” | 无 `canAddNotesWithErrorDetail` |
| AnkiConnect 新实现 | `git.sr.ht/~foosoft/anki-connect` `62fc13d1`（2026-10-20）。`README.md`：需要 Anki Desktop 26.08+；`API_LEGACY.md` 保留 v6 全部 122 个 action | 新增 JSON-RPC v1；legacy v6 为适配层（`plugin/legacy.py`、`plugin/services.py`） |
| Anki 核心（Rust） | `ankitects/anki` `136bd42b`（2026-10-29） | `rslib/src/...` |
| Anki 手册 | `ankitects/anki-manual` main；`docs.ankiweb.net` | |
| AnkiDroid 手册 | `docs.ankidroid.org` | |
| AnkiMobile 手册 | `docs.ankiweb.net/ankimobile/*.md` | |

### 1.1 版本分叉（影响 VOKA 的兼容策略）

- 旧版（Anki 2.1.45 ~ 25.x 上的 AnkiConnect 2.1.x）：`plugin/__init__.py` 第 18-21 行最低 Anki 2.1.45。
- 新版：最低 Anki 26.08。同一个 `http://127.0.0.1:8765/` 根端点继续接受 `version: 6` 请求。
- 两者对 v6 API 的**参数名一致，但少数行为不同**（`addNotes`、`canAddNotesWithErrorDetail` 是否存在、`duplicateScope` 非法值处理）。已知差异见各节。

## 2. createModel / 模型更新类 action

### 2.1 createModel

旧实现 `plugin/__init__.py` L1062-1102；新实现 `plugin/legacy.py` L1194-1206；文档 `API_LEGACY.md` L2269-2309。

- 参数：`modelName, inOrderFields, cardTemplates, css=None, isCloze=False`。
- `cardTemplates[i]` 的键是 **`Name` / `Front` / `Back`**（首字母大写；`Name` 可省，默认 `Card 1`…）。
- 校验：`inOrderFields` 与 `cardTemplates` 不能为空；**同名模型已存在则抛错**（`Model name already exists`），不会覆盖，也不会自动加后缀。
- 不传 `css` 用 Anki 默认 CSS。
- 没有字段属性（字体、描述、sort field、`required`）参数；这些要靠 `modelFieldSetFont` / `modelFieldSetFontSize` / `modelFieldSetDescription` 另外设置。**没有 action 能设置排序字段 sortf**（旧代码无此 API；新 legacy 也没有）。排序字段默认第 0 个字段。**[待验证]**
- 模板写入时会被 Anki 校验（`rslib/src/notetype/mod.rs` `check_templates`，L520-528）：前面模板不能完全相同（除非含 `{{Card}}`）、模板引用的字段必须存在、前面模板必须至少含一个字段。校验失败整个调用失败。

### 2.2 updateModelTemplates / updateModelStyling

旧实现 L1214-1244；新实现 `legacy.py` L1221-1238；文档 L2359-2416。

- `updateModelTemplates({name, templates:{<卡片名>:{Front?, Back?}}})`：按模板**名字**更新；缺失的模板名或空串**被静默忽略**（旧代码 `if qfmt:` / 新文档“empty side values are ignored”）。不能增减模板。
- `updateModelStyling({name, css})`：**整段替换 CSS**。想保留用户自定义样式就要先 `modelStyling` 读出再改写，或用 `findAndReplaceInModels`（`css:true`，`front/back:false`，旧代码 L1248-1273，只在该 action 中做文本替换）。
- 旧实现均走 `models.update_dict`（`save_model`，L81-82）→ Anki 后端 `update_notetype_legacy`（`pylib/anki/models.py` L224-232）。**会跑 Anki 的模板校验**；字段/卡片序号没变时不会设置 schema 标志（见第 3 节）。

### 2.3 字段 / 模板结构类 action

`modelFieldAdd / Remove / Rename / Reposition`、`modelTemplateAdd / Remove / Rename / Reposition`：旧实现 L1277-1380，新实现 `legacy.py` L1239-1261。

- `modelFieldAdd` 若字段已存在则不重复添加（仅按 `index` 重排）。
- `modelTemplateAdd` 若同名模板已存在则**改为更新该模板**（旧代码 L1305-1310）。
- 删除字段会丢弃所有笔记里该字段的数据（Anki 重写笔记，`schemachange.rs` L101-119）。
- 这些 action 的同步影响见第 3 节。

### 2.4 notetype 内模板对字段的引用

`modelFieldsOnTemplates` 可以读出每个模板的前/后字段引用，用于校验 VOKA 自己的模板是否引用了预期字段（新实现为 `noteTypes.getTemplateUsage`，`legacy.py` L1219）。

## 3. 哪些操作触发全量同步（schema-modified）

### 3.1 机制

- `Collection::set_schema_modified()`：`rslib/src/collection/timestamps.rs` L35-39，注释 “Forces the next sync in one direction”。
- 同步时 `SyncMeta::compared_to_remote`（`rslib/src/sync/collection/meta.rs` L60-77）：先判断 `modified` 是否相同；不同再看 `remote.schema != local.schema`，不同则 `FullSyncRequired`，否则 `NormalSyncRequired`。
- 手册说明：“things like adding a new field, or removing a card template” 无法合并，需要选上传/下载（`ankitects/anki-manual` `src/syncing.md` L85-91）。
- 通过 API 修改时 GUI 不会弹确认框，标志静默设置；用户下次同步时才会遇到“全量同步”选择。

### 3.2 设置标志的代码位置（`ankitects/anki@136bd42b`）

| 操作 | 是否设置标志 | 源码 |
| --- | --- | --- |
| 新建 notetype | **否** | `rslib/src/notetype/mod.rs` `add_notetype_inner` L742-752 里没有该调用 |
| 编辑模板文本（qfmt / afmt） | **否** | `update_cards_for_changed_templates` 仅当序号变化才设置（`schemachange.rs` L126-137） |
| 编辑 CSS | **否** | 无任何设置点；`merge_notetypes` 按 mtime 合并（`sync/collection/changes.rs` L245-272） |
| 字段重命名 | **否** | 序号不变（`schemachange.rs` L76：`ords_changed` 为假；改名只走 `update_templates_for_renamed_and_removed_fields`，`notetype/mod.rs` L501-511） |
| 字段增 / 删 / 重排 | **是** | `schemachange.rs` L101-102 |
| 排序字段（sort field）改变 | **是** | `schemachange.rs` L77-79 |
| 模板增 / 删 / 重排 | **是** | `schemachange.rs` L135-136 |
| 删除 notetype | **是** | `notetype/mod.rs` L800 |
| 更改笔记的 notetype（Change Note Type） | **是** | `notetype/notetypechange.rs` L222 |
| 删除 deck 配置预设 | **是** | `deckconfig/mod.rs` L215-221 |
| 添加笔记 / 改字段值 / 改标签 | **否** | 走普通 usn 增量同步 |

`pylib/anki/models.py` 的 docstring 里也有 `"Modifies schema."` 标记：`add_field`、`remove_field`、`reposition_field`、`set_sort_index`、`add_template`、`remove_template`、`reposition_template`（L301-366）；`rename_field` 没有此标记（L320-325）。

### 3.3 正常同步如何处理 notetype 变更

`merge_notetypes`（`sync/collection/changes.rs` L245-272）：对每个收到的 notetype，若本地已有且 `existing.mtime <= incoming.mtime`，则**字段数或模板数不同时返回 `ResyncRequired`**，否则覆盖本地（包括 CSS、模板文本）。mtime 更旧的传入版本被丢弃。也就是说：

- CSS / 模板文本变更在正常同步里**按“最后修改者胜出”传播到所有设备**；
- 两台设备并发改同一 notetype 的 CSS，后写入者覆盖前者，不会合并。

### 3.4 对 VOKA 的含义（事实）

- 第一版发布前必须定稿“字段集合 + 模板数量 + 排序字段”。上线后任一变动 = 所有用户一次单向全量同步（上传 / 下载二选一）。
- AnkiConnect 的 `createModel` 自身不会触发全量同步；首次导入的用户集合若为空，首次同步本来就是全量。
- 若用户在 AnkiWeb 上有多台设备，字段结构变化后其他设备也要选下载。

## 4. addNotes / canAddNotes / multi

### 4.1 重复检测范围

**默认行为（两种实现一致）：整个集合范围，仅同一 notetype，仅比较第一个字段。**

- 旧实现：`createNote`（L222-292）→ `isNoteDuplicateOrEmptyInScope`（L295-354）。`duplicateScope != 'deck'` 且 `checkAllModels` 为假时，直接 `note.dupeOrEmpty()`（L310-311），即 Anki 原生检查。
- Anki 原生检查 `note_fields_check`（`rslib/src/notes/mod.rs` L606-631）：先对第一个字段做 NFC 规整（取决于 `NormalizeNoteText` 配置）与 **去 HTML（保留媒体文件名）**，为空 → Empty；否则 `is_duplicate`（L633-642）：按 `field_checksum` 查同一 `notetype_id` 的笔记，再比较去 HTML 后的文本是否**完全相等**。
- 因此：
  - **区分大小写**（`Run` 与 `run` 是不同的笔记）；
  - 不做词形还原，`runs` 与 `run` 不重复；
  - 同一第一个字段内的 HTML 标签、`&nbsp;` 之类会被去掉再比较；
  - **跨 deck 重复**（只要是同一 notetype）；**跨 notetype 不算重复**。

选项（`note.options`）：

| 选项 | 作用 | 来源 |
| --- | --- | --- |
| `allowDuplicate: true` | 允许重复，直接加入 | 旧实现 L246-257、L286-287 |
| `duplicateScope: "deck"` | 重复仅在指定 deck 内检查（默认是该笔记的目标 deck） | L258-259、L319-333 |
| `duplicateScopeOptions.deckName` | 改为在另一个 deck 内检查；该 deck 不存在则视为非重复 | L262-263、L323-328 |
| `duplicateScopeOptions.checkChildren` | deck 范围含子 deck | L264-267、L331-333 |
| `duplicateScopeOptions.checkAllModels` | 不再限定同一 notetype | L268-271、L341-343 |

注意：

- 旧实现的 deck 范围检查要求“该笔记**有卡片**在这些 deck 里”（L350-353），只看 `cards.did`，不看 `odid`；新实现看 `card.odid or card.did`（`services.py` L282），即把**过滤牌组（filtered deck）里的卡**算回原 deck。**[待验证]** 旧版在卡被移入过滤牌组时的差异。
- 旧实现中 `duplicateScope` 为 `"deck"` 以外的任意值都**静默回退**到集合范围；新文档称“other values fail”（`API_LEGACY.md` L208-209），但 `legacy.py` L297 的代码是 `'deck' if ... == 'deck' else 'collection'`，看起来也是回退。文档与代码不一致。**[待验证]**
- 新实现的重复检查还用 `normalized_field`（NFC + 去 HTML 媒体，`services.py` L68-70），与 Anki 原生一致。
- 空第一字段：返回错误 `cannot create note because it is empty`；重复：`cannot create note because it is a duplicate`（`API_LEGACY.md` L222-224；旧实现 L283-288）。

### 4.2 addNote / addNotes

- 旧实现 `addNotes`（L1911-1919）：对每条笔记 `try addNote` / `except: None`。**逐条独立，失败项返回 `null`，不告知原因**；成功项是 note id。每条笔记各自 `collection.addNote` 并 `autosave`。
- 新实现 `addNotes`（`API_LEGACY.md` L2816-2829；`legacy.py` L825-849）：**一个原生原子批次**。任何一条预检失败 → 整个批次不写入，抛出顶层 legacy 错误，其内容为“按输入顺序的错误字符串列表（stringified list）”；包含**同批次内部**的重复检测（`services.py` L317-345 `prepare_notes`）。成功时按顺序返回 id 列表。
- 因此客户端不能假设 `null` 项意味着单条失败（新实现里整批失败时没有结果数组）。VOKA 需要：先 `canAddNotes…` 预检，或对批次失败回退到逐条 `addNote`。**[待验证]** 两种实现下具体的错误响应体。
- 第一字段重复的“一词一卡”语义：重复检测的是第一个字段，因此 **第一个字段应只放纯词条（headword）**；IPA、例句应放在别的字段，否则同一个词不同语境不会被判重复。（这是对上述规则的推论，不是 AnkiConnect 的要求。）
- 找回已存在笔记的 id：legacy `canAddNotes…` 不返回已存在笔记的 id（新 v1 `notes.validateMany` 返回 `duplicateNoteIds`，`services.py` L289）；legacy 路径下要用 `findNotes`（如 `note:<模型名> "<首字段名>:<词>"`）再 `updateNoteFields`。

### 4.3 canAddNotes / canAddNotesWithErrorDetail

- 旧实现：`canAddNotes`（L1923-1928）只返回布尔数组，**内部吞掉所有异常**（L796-800 `except: return False`），无法区分“重复 / 空 / 模型不存在 / 牌组不存在”。
- GitHub 镜像快照（`4064fa1`）里**没有** `canAddNotesWithErrorDetail`。新实现有：返回 `[{canAdd, error}]`，重复时 `error` 为 `"cannot create note because it is a duplicate"`（`API_LEGACY.md` L2899-2911；`legacy.py` L819-824）。**[待验证]** 用户机器上的 AnkiConnect 版本是否都带该 action（可用 `apiReflect` / `version` 探测）。
- 预检不下载媒体、不改集合（新文档 L2871）。

### 4.4 multi 的错误语义

- 旧实现：`multi` = `list(map(self.handler, actions))`（L492-494）。`handler` 内部 try/except，**每个子请求各自返回 `{result, error}`**，一个失败不影响后续（L96-137）。
- 新文档（`API_LEGACY.md` L1958-1968）：“No atomicity. Unknown child actions and bad arguments return errors in their own result slots; subsequent requests still run.”；**等待每个子操作完成**（如 `sync` 在 `multi` 里等同步完成，单独调用只表示“已接受”，L1866）。
- 因此：`multi` 的顶层调用几乎总是成功（`error: null`），要逐项检查。子项里若有 `addNotes` 整批失败，只体现在该子项的 `error`。
- 子项的 `version` 单独生效（新文档 L1964：“preserve each nested version envelope”）。
- `multi` 不是事务。需要“先建 notetype 再加笔记”这类依赖时，顺序是有保证的（按序执行），但失败不回滚。

## 5. 卡片渲染环境（AnkiDroid / AnkiMobile / 桌面）

### 5.1 平台 CSS 类与暗色

桌面手册 `src/templates/styling.md`：

- L281-327：Anki 在渲染容器上设置平台类：`.win` `.mac` `.linux` `.mobile`（Android + iOS）`.iphone` `.ipad` `.android`；浏览器类 `.gecko` `.opera` `.ie`（AnkiWeb）。
- L387-408：夜间模式类 `.nightMode`，用法 `.card.nightMode { ... }` / `.nightMode .myclass { ... }`。AnkiMobile 手册 `ankimobile/night-mode.md` 同样支持。
- 这些类只区分**平台和明暗**，**不携带用户设置**，不能作为“释义语言”开关的状态来源。

### 5.2 条件渲染

`src/templates/generation.md` L59-135：`{{#Field}}…{{/Field}}`（非空显示）、`{{^Field}}…{{/Field}}`（为空显示）。在**正面模板**使用时影响“是否生成该卡”，所以**释义字段不应放在正面做条件**（会引起卡片生成/空卡片问题）；放在背面模板是安全的。

- 特殊字段 `{{Tags}}`、`{{Type}}`、`{{Deck}}`、`{{Card}}`、`{{FrontSide}}`（`src/templates/fields.md` L138-160）。
- 条件只能判断“字段是否为空”，**不能判断字段内容或某个特定标签**。`{{#Tags}}` 只测“有没有任何标签”。
- 要用标签驱动，必须把 `{{Tags}}` 输出成 HTML class（如 `<div class="{{Tags}}">`），再靠 CSS 选择器匹配。这在桌面和移动端都是渲染时纯文本替换，但标签会变成 class 名，含空格/特殊字符要受 class 语法约束。**[待验证]** 带冒号/层级的标签（`a::b`）。

### 5.3 JavaScript

- 桌面手册 `styling.md` L430-456：支持，但“无支持、无保证”；客户端可能长驻页面动态更新，需避免 `document.write`；`window.alert` 可能不可用。
- AnkiMobile（`ankimobile/more.md`）：同样适用上述警告；点击检测要求自定义可点击元素加 `tappable` 类（2.0.39+）。
- AnkiDroid（`docs.ankidroid.org`，“User actions”节）：JS 属于高级功能，“Official user support is not provided and AnkiDroid updates may break functionality”；提供 `userJs1…userJs9` 钩子。
- 因此 JS 路线增加三端不一致风险。本场景不需要 JS。

### 5.4 TTS 标签

- `{{tts en_US:Field}}` 在 Anki 2.1.20+ / AnkiMobile 2.0.56+ / AnkiDroid 2.17+ 可用（`src/templates/fields.md` L55-96）。若释义用 CSS 隐藏，TTS 是否还会朗读被隐藏的字段取决于 TTS 对字段内容的取法，而不是 CSS。**[待验证]**（只有在 VOKA 打算让 Anki 朗读释义时才相关。）

### 5.5 CSS 变更的传播

- 模型 CSS 和模板文本存放在 notetype 中，随正常同步到达 AnkiDroid / AnkiMobile，并按 4.3 / 3.3 的规则合并；移动端渲染时直接使用同步下来的 CSS。
- AnkiDroid、AnkiMobile 的手册没有声明它们对模板/CSS 有“缓存而不刷新”的特殊行为。**[待验证]** 同步后移动端是否立即使用新 CSS（可能需要退出重进复习界面）。

## 6. 评估：只改 CSS / 模板能否切换释义语言

前提（用户已决定）：每条笔记同时存 L1（中文）释义字段与 L2（英文单语）释义字段；全局“释义语言”设置只改变背面显示哪一个，不改写笔记，不影响调度。下列是事实性对比，不是决策。

### 6.1 方案 A：CSS 切换（两个字段都渲染，CSS 隐藏其一）

模板背面同时输出两块，带 class：

```html
<div class="gloss gloss-l1">{{GlossL1}}</div>
<div class="gloss gloss-l2">{{GlossL2}}</div>
```

VOKA 把一段由它管理的 CSS 写进模型样式，例如隐藏 `.gloss-l2` 或 `.gloss-l1`。切换设置 = 一次 `modelStyling` 读 + `updateModelStyling`（或 `findAndReplaceInModels` 替换标记 token）。

- **同步影响：无 schema 标志，不触发全量同步**（3.2 表中“编辑 CSS”）。传播方式见 3.3。
- 不改笔记（笔记 mod / usn 不变），不改卡片，**不影响调度**。
- 全局：对该 notetype 的所有卡、所有设备一次生效。
- 要点 / 风险：
  - `updateModelStyling` 会整段替换 CSS，必须读后写，且最好用成对的标记注释包住 VOKA 管理的段落，避免覆盖用户自定义样式。
  - 两个释义都进入 DOM；Anki 浏览器的“答案”列、搜索、导出都会含两种释义（搜索 `GlossL2:xxx` 不受 CSS 影响）。
  - 若所选语言的字段为空，CSS 单靠 `display:none` 无法回退到另一语言。可用 `:empty` 隐藏空块；“空则回退”需要 `:has()` 之类，旧 WebView 支持情况 **[待验证]**。
  - 并发：多设备同时改 CSS，后写入者胜（3.3）。
  - 与 `.mobile` / `.nightMode` 等平台类无冲突；开关状态只存在于 CSS 文本中。

### 6.2 方案 B：改模板文本（把背面里的 `{{GlossL1}}` 换成 `{{GlossL2}}`，或反之）

- `updateModelTemplates` 只改 `Back`（afmt）。同步影响：与 CSS 相同，**不设置 schema 标志**（`schemachange.rs` L126-137 仅看序号）。
- 不改笔记与调度。仅改背面不会影响卡片生成（生成由正面决定）。
- 模板文本比 CSS 更容易与用户手改冲突；`updateModelTemplates` 需提供完整的 `Back` 字符串，做字符串替换要先 `modelTemplates` 读取。
- 校验：模板引用的字段必须存在（`ensure_valid_parsed_templates`），否则整次更新被拒。

### 6.3 方案 C：条件字段（`{{#GlossL2}}…{{/GlossL2}}`）

- 条件只依赖“字段是否为空”，不能表达用户偏好；要靠清空/填充字段来切换，等于改写所有笔记。不满足“不改写笔记”。仅可作为“所选语言为空时的回退”辅助（背面模板里使用）。

### 6.4 方案 D：标签驱动

- 给每条笔记打语言标签并 `<div class="{{Tags}}">` + CSS。切换仍要改 CSS（和方案 A 一样），还额外要给全部笔记加标签（改写笔记，`updateNoteTags` 会修改笔记 mod / usn，产生大量同步增量）。相对方案 A 无增益。

### 6.5 方案 E：字段驱动（单个 `Gloss` 字段存当前语言）

- 切换 = 重写所有笔记的 `Gloss` 字段（`updateNoteFields`）。笔记 usn / mtime 变化，产生与笔记数成比例的同步量；调度不变，但违背“不重写笔记”的要求。

### 6.6 方案 F：JS 读取偏好

- 需要把偏好传给卡片（只能通过模板或 CSS 内容），JS 本身没有独立的偏好来源；三端 JS 行为不一致（5.3）。没有额外收益。

### 6.7 小结（事实）

- 在“不重写笔记 + 不触发全量同步 + 全局切换”这三个约束下，可行的路径是 A 与 B（修改 notetype 的 CSS 或背面模板）。二者的同步代价相同（普通增量同步，无标志）。
- 无论选哪个，**L1 与 L2 两个字段必须在第一版 notetype 中就存在**，之后新增字段会触发全量同步（3.2）。
- 多设备并发写 notetype 采用后者胜出，VOKA 的“设置”写入应当是幂等的整段替换。

## 7. 需要在真实环境验证的清单（对应 Issue #7）

1. `updateModelStyling` / `updateModelTemplates` 在目标 Anki 版本（旧版 2.1.x/25.x 与新版 26.08+）上不触发全量同步：同步前后比较集合 `scm`，并实测 AnkiWeb 往返与移动端拉取。
2. 移动端（AnkiDroid、AnkiMobile）收到新 CSS 后复习界面是否立即生效，是否需要重新进入。
3. `createModel` 对字段属性（排序字段、字体、描述）的实际默认值；是否能设置 sort field。
4. 旧版与新版 AnkiConnect 对 `addNotes` 部分失败的响应体；`multi` 中的错误位置。
5. `canAddNotesWithErrorDetail` 在用户机器上是否可用（探测方式：`apiReflect` / `version`）。
6. `duplicateScope` 为非法值时的处理（文档说失败，代码看起来回退）；卡片在过滤牌组中时 deck 范围的重复检测差异。
7. 第一字段含 HTML / NFC 差异 / 前后空白时的重复判断。
8. “所选语言字段为空时回退到另一语言”的 CSS（`:empty`、`:has`）在 AnkiDroid System WebView 与 AnkiMobile 的支持情况。
9. `{{Tags}}` 作为 class 时带 `::` 的层级标签的表现（仅在考虑标签驱动方案时需要）。
10. `{{tts}}` 与被 CSS 隐藏字段的关系（仅当 VOKA 要让 Anki 朗读释义时）。

## 8. 引用索引

- AnkiConnect（旧，GitHub 镜像快照）：`plugin/__init__.py` — `createNote` L222、`isNoteDuplicateOrEmptyInScope` L295、`multi` L493、`addNote` L735、`canAddNote` L796、`createModel` L1062、`updateModelTemplates` L1214、`updateModelStyling` L1236、`modelField*` L1331-1380、`addNotes` L1911、`canAddNotes` L1923。<https://github.com/FooSoft/anki-connect/blob/4064fa142785975255457abd6a496015f5b71f38/plugin/__init__.py>
- AnkiConnect（新）：<https://git.sr.ht/~foosoft/anki-connect/tree/62fc13d1/item/API_LEGACY.md>、`plugin/legacy.py`、`plugin/services.py`。
- Anki 核心：<https://github.com/ankitects/anki/blob/136bd42b/rslib/src/notetype/schemachange.rs>、`rslib/src/notetype/mod.rs`、`rslib/src/collection/timestamps.rs`、`rslib/src/sync/collection/meta.rs`、`rslib/src/sync/collection/changes.rs`、`rslib/src/notes/mod.rs`、`pylib/anki/models.py`。
- Anki 手册：<https://docs.ankiweb.net/templates/styling.html>、`templates/generation.html`、`templates/fields.html`、`syncing.html`。
- AnkiMobile：<https://docs.ankiweb.net/ankimobile/more.md>、`night-mode.md`、`syncing.md`。
- AnkiDroid：<https://docs.ankidroid.org/>（Study screen / User actions / Custom Card Layout）。
