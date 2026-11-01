# VOKA P0 整体验收（#36）

2026-11-01，依据 spec §16 的 **T-01–T-11、T-26–T-33（19 项）**，重新构建并运行当前 main（`4e63cb4`）。产品 `src/`、`public/` 无修改；本 PR 只有验收编排、旧 harness 的适配及本次证据。

环境：macOS / Node 26.9.0 / Anki **26.09.3**、AnkiConnect v1、**Chrome for Testing 156.0.8078.47 + Puppeteer**，数据版本 `en-2026.10.1`。全部 Anki 读写限定 `~/VOKA-anki-test` 的 **127.0.0.1:8766**；Chrome NetLog 全程记录并断言没有任何 8765 请求。各 harness 自建的 closed port / diagnostic mock 不属于 Anki 写入目标。

rebase `origin/main` 后再次执行 [`npm run build && npm test`](p0-evidence/build-and-test.log)：通过，**17 个文件 / 136 个测试**。完整批次及选定 harness 修订后重跑的逐测试 machine-readable 结果见 [results.json](p0-evidence/results.json)；每个子目录的 `run.log`、`network.json`，以及原始 `rpc.json.gz` 和压缩 Chrome NetLog 都是本次重跑生成，未用旧票报告代替执行。为避免仓库膨胀，32 个原始 `rpc.json.gz` / `chrome-netlog-*.json.gz`（约 30 MB）不进仓库，打包在 GitHub Release 附件 [p0-acceptance-raw-evidence.tar](https://github.com/xzpjerry/VOKA/releases/download/p0-acceptance-2026-11-01/p0-acceptance-raw-evidence.tar)（SHA-256 `833d6f3e34b45ab69cdf748fa4ec648963880694c665e5d9326a43967771b8de`，解包后路径与本目录一致）；`network.json` 与 [network audit](p0-evidence/network-audit.json) 是从这些 NetLog 提取的 8765 审计结果，留在仓库里。最终结果：**19 PASS / 0 FAIL / 0 PARTIAL / 0 NOT RUN**，18 个步骤完成；14 份 Chrome NetLog 的 8765 事件为 0。PASS 仅指表内环境和操作；其他环境及未覆盖路径见文末。

## 逐项结果

| ID | 结果 | 本次检查（自动脚本 / manual-equivalent） | 证据 | 真实限制 |
|---|---|---|---|---|
| T-01 | PASS | `lifecycle` 用独立 fresh Chrome profile，按完整 argv 定位并实际停止隔离 Anki；刷新 fixture 后无高亮且有检查提示；重新启动 8766，点产品 Retry 后恢复。`highlight` 另重跑 closed-port 断连清除。 | [lifecycle/results.json](p0-evidence/lifecycle/results.json)、[stopped screenshot](p0-evidence/lifecycle/anki-stopped.png)、[highlight log](p0-evidence/highlight/run.log) | 页面 fixture；不是物理工具栏点击；自动同步处理见下文。 |
| T-02 | PASS | 真正移除测试 add-on 的 `http://localhost` 来源配置并重启；真实扩展收到 403，不能导入；点 Options「请求访问权限」，用 Orca accessibility 接受实际 Anki Yes 对话框，重新检测后从同一 Chrome service worker 验证、创建、读回一条 throwaway 笔记；配置在 finally 原样恢复。允许前 SQLite 快照相同。 | [permission/results.json](p0-evidence/permission/results.json)、[native dialog](p0-evidence/permission/native-dialog.png)、[403 UI](p0-evidence/permission/forbidden.png)、[network](p0-evidence/permission/network.json) | 测的是 Anki 原生授权；Chrome 的可选站点 Allow/Deny 仍未测。 |
| T-03 | PASS | `level` 重跑完整 UI 导入；`final` 暂存旧测试 type/deck 名称后，在真正默认名称 `VOKA Vocabulary · English` / `VOKA::English::B1` 上预览、确认和读回；**2,085 笔记 / 2,085 卡片**，全部 Key 唯一且带两个要求标签。 | [default preview](p0-evidence/final/default-preview.png)、[final](p0-evidence/final/results.json)、[whole-level results](p0-evidence/level/level-import-evidence/results.json) | 1.6 重算为 **2,085**，相对规格暂估 2,088 少 3；符合「以 1.6 数据重算为准」。旧测试名称最终恢复，新 fixtures 另名保留。 |
| T-04 | PASS | 同级第二次预览 new=0；确认禁用；再次执行 created=0，所有卡片/复习记录快照不变。 | [final](p0-evidence/final/results.json)、[level](p0-evidence/level/level-import-evidence/results.json)、[import log](p0-evidence/import/run.log) | 当前本机收藏；不是多设备同步后的再导入。 |
| T-05 | PASS | `supplemental` 新建独立 B1 state，通过真实 `application.navigate` / `reviewer.showAnswer` / `reviewer.answer(good)` 回答三张卡，再导入相邻 B2 **2,383** 词；逐行比较此前所有卡片排程、完整 revlog，并比较被复习笔记全部字段，均不变。 | [review/import results](p0-evidence/supplemental/results.json)、[v1 request/response（Release 附件内 supplemental/rpc.json.gz）](https://github.com/xzpjerry/VOKA/releases/download/p0-acceptance-2026-11-01/p0-acceptance-raw-evidence.tar) | 本地真实 reviewer 记录；未做 AnkiWeb sync，也未验证跨设备历史。 |
| T-06 | PASS | `final` 在 B1 设置下通过产品 card-context save 手动加入一个真实 A2 词；A2 预览 existing=1 / new=1,199；实际导入其余 A2 后按 Key 回查仍只有同一条，字段保持，牌组为 `VOKA::English::A2`。 | [final T-06](p0-evidence/final/results.json)、[level T-06](p0-evidence/level/level-import-evidence/results.json) | 加入使用真实产品后台流程；不模拟物理 Anki 编辑操作。 |
| T-07 | PASS | Chrome 页面 B1→B2→B1，分别观察 `benefit` / `abolish` 的目标高亮；预先保存例句，切换后笔记字段、卡片与 revlog 快照保持相同。`level` 同时检查 Options 选择和导入提示。 | [final T-07](p0-evidence/final/results.json)、[level](p0-evidence/level/level-import-evidence/results.json) | 真实数据的本地 fixture；不是任意网站布局或跨浏览器重启。 |
| T-08 | PASS | 重跑真实卡片控件：A1 banana 标 unknown 后红色、B1 benefit 标 known 后不高亮；Undo 恢复规则，reload 后人工标记保持；已有笔记只改 ManualStatus。 | [manual results](p0-evidence/manual/manual-status-evidence/result.json)、[screenshots/log](p0-evidence/manual/) | 既有部分笔记是早期小 fixture；新增未收录词使用当前真实数据。 |
| T-09 | PASS | 本地 React 18.3.1 渲染 2,000 段、8,000 Range；append/replace/remove 后 8,002→8,000→7,998，未变段落保留 Range 身份，无 detached/empty ranges，正文 HTML 与几何值不变。记录初始化与 rAF 滚动数据。 | [measurements](p0-evidence/dynamic/dynamic-performance.json)、[run log](p0-evidence/dynamic/run.log) | 未跑 Vue 或真实第三方应用；性能数据只代表这次 fixture，不能推出所有设备无卡顿。 |
| T-10 | PASS | 四个不同本地页面实际保存例句；第 4 次出现替换选择，Anki 最多三条；通过真实 notes.update 模拟用户在 Anki 改句，随后保存/选择其他替换仍保留编辑。 | [contexts result](p0-evidence/contexts/context-evidence/result.json)、[replacement UI](p0-evidence/contexts/context-evidence/replacement.png) | 外部编辑在操作间隙执行；没有证明与 read→patch 同时编辑时原子合并。 |
| T-11 | PASS | 当前数据 API 检查有等级但无词典的 `'m`；相反方向用词典有、未分级的 aardvark 实际打开完整卡片，显示未分级和释义，不显示「词典没有」；既有 contexts 缺词 UI 也重新运行。 | [final T-11](p0-evidence/final/results.json)、[data log](p0-evidence/data/run.log)、[contexts](p0-evidence/contexts/context-evidence/result.json) | `'m` 为 API 层检查；完整卡片的反方向分支已在浏览器检查。未检查全部词典语义。 |
| T-26 | PASS | Options 实际切换 native/target；对比完整 CSS 必须恰好等于 marker replacement，附加 user CSS 保留；实际 cards.render 背面 computed display 随模式切换。按 §17 复制 DB + WAL 到全新临时目录，显式删除目标 -shm，再读 `col.scm`，前后均为 **1793504349850**。 | [final modes/scm](p0-evidence/final/results.json)、[target back](p0-evidence/final/target-back.png)、[native back](p0-evidence/final/native-back.png)、[gloss rerun](p0-evidence/gloss/gloss-switch-raw.json) | 本地 schema 值与 Chrome 渲染；未发起真实 sync，也不代表移动端已兼容。 |
| T-27 | PASS | 真实 Anki 卡分别清空母语/单语释义；渲染并断言另一种 computed display=block，模板/CSS 不包含 `:has(`。 | [final fallbacks](p0-evidence/final/results.json)、[gloss fallbacks](p0-evidence/gloss/gloss-switch-raw.json) | Chrome for Testing；AnkiMobile / AnkiDroid 留待设备验证。 |
| T-28 | PASS | 重跑完整卡片候选测试：saw/see 均 A1，默认 **en:saw**，可切 **en:see** 再切回；colour→en:color；人工标记/例句写到当前选择，see 保持原样；重开保留、reload 重置。 | [candidate results](p0-evidence/candidates/lemma-candidates-evidence/result.json) | 按当前规格/ADR 平级规则，不作上下文自动消歧；多标签/跨站选择状态未测。 |
| T-29 | PASS | 真实两个旧版本 fixture，其中一条人工改释义；预览两组、edited 默认保留，确认前全收藏快照相同；选择确认后只改允许的生成字段/metadata，其他笔记与所有卡片相同；kept 记忆与 reset 也重新跑。 | [upgrade results](p0-evidence/upgrade/gloss-upgrade-evidence/result.json)、[edited group](p0-evidence/upgrade/gloss-upgrade-evidence/edited-default-keep.png) | live 断连/拒绝写入/202-note 故障分支仍只有确定性测试；外部编辑竞争不能原子排除。 |
| T-30 | PASS | `highlight` 重跑 exclusions；`final` 在 input、textarea、contenteditable、code、nav 内放目标词并双击，断言无相关 Range，完整卡片保持关闭，无法经该路径保存例句。 | [final T-30](p0-evidence/final/results.json)、[highlight](p0-evidence/highlight/run.log) | 本地标准 DOM；不扩展到任意 shadow/iframe 或浏览器内页。 |
| T-31 | PASS | 记住站点模式、真实内置 Gmail deny host `mail.google.com`；HTTPS 请求被 CDP 用本地 fixture HTML 响应，自动不创建 UI，手动走实际 content.js injection 后完成 Anki 检测并出现 benefit 目标高亮。另重跑 scope 和 cold-start harness。 | [Gmail-host fixture](p0-evidence/final/results.json)、[screenshot](p0-evidence/final/gmail-local-manual.png)、[scope](p0-evidence/scope/site-scope-evidence/results.json)、[cold start](p0-evidence/cold/site-scope-cold-start-evidence/results.json) | **没有使用真实 Gmail**。Chrome 站点授权用 developerPrivate 预授权后可信点击请求；手动注入等价路径不是物理图标点击。 |
| T-32 | PASS | 实际保存超长句得到居中窗口、`…` 和表面词加粗；两词句拒绝；清理 `[1]` / `¹`；同句不同 URL 提示重复。 | [context result](p0-evidence/contexts/context-evidence/result.json)、[short](p0-evidence/contexts/context-evidence/short.png)、[duplicate](p0-evidence/contexts/context-evidence/duplicate.png) | 本地英文样句；未穷举任意语言/网页脚注格式。 |
| T-33 | PASS | 当前 8766 v1 重新创建独立 type/decks：首字段区分大小写、去 HTML、默认跨 deck 同 type、deck scope、默认跨 type 不判重 / acrossNoteTypes 开启判重、非法 scope invalidParams；non-atomic 成功/重复/成功逐条保留，atomic 全批失败且零写入；notes.update 合并保留其他字段。 | [v1 results](p0-evidence/supplemental/results.json)、[raw requests/responses（Release 附件内 supplemental/rpc.json.gz）](https://github.com/xzpjerry/VOKA/releases/download/p0-acceptance-2026-11-01/p0-acceptance-raw-evidence.tar) | §6 判重/批量行为与本次预期一致；等级导入的 200-note 逻辑批次按 v1 上限拆成 100-note wire requests。没有重跑禁止的结构编辑正对照或主动同步；不能据此声称未调用的 API 均正确。 |

## 隔离、同步与测试状态

- fresh Chrome profile 和临时 extension copy 只在启动前 seed `port:8766`；源码与原始 `dist/` 不变。脚本同时记录 Node 请求及每个 Chrome 进程的 NetLog，解析 URL 并复核原始事件参数，断言 8765 请求数为零，见 [network audit](p0-evidence/network-audit.json)。例外诊断端口均是本地 mock / closed-port；没有对它们做 Anki 写入。
- `final` 先按 ID 暂存既有测试 type/deck 名称，给真正默认名称留出干净状态；结束把新 fixtures 改为 `VOKA P0 Final <timestamp>` / `VOKA::P0 Final <timestamp>` 并按原 ID 恢复旧名称。测试自己的 fresh targets、笔记 ID 和保留状态见各 results / artifacts JSON。早期 harness 调整产生的 **21,330 条专属 preliminary fixture** 已按精确 type ID 回读核验后清理，见 [cleanup manifest](p0-evidence/preliminary-fixture-cleanup.json)；未删除既有原型或其他用户笔记。
- 未调用 `collection.sync`、`scheduling.*`、`cards.move`、`noteTypes.editStructure`；删除仅用于上述隔离实例 preliminary fixtures 的外部测试清理，不进入产品代码。T-05 调用真实 reviewer 的回答接口是明确授权的复习测试。
- 首次关闭隔离 Anki 时，原有 `autoSync=true` 自动弹出 AnkiWeb schema-conflict 询问；**取消，未选择 Upload/Download**。实例退出后仅把隔离 `User 1` 的 autoSync 改为 false 并保持关闭，后续 lifecycle checks 在停止前断言它为 false。未读取一次性账号凭据、未主动登入/同步；这不是一次成功的同步验证。[environment record](p0-evidence/environment.json)。
- T-26 的 SCM 数值只在自身操作前后比较；外部清理测试 note types 可能改变全局 SCM，不把不同 fixture 生命周期的数值混为同一次 CSS 切换测量。快照包含 WAL，目标 SHM 显式移除。

## 复现和验收脚本范围

```sh
npm ci
npx puppeteer browsers install chrome
# 先在隔离 User 1 中关闭 autoSync，再启动 ~/VOKA-anki-test/launch.sh；端口必须 8766。
npm run build && npm test
VOKA_NATIVE_PERMISSION=1 npm run check:p0
```

`check:p0` 顺序运行已有 check-* harness 和补齐的真实检查，写 `p0-evidence/results.json`（逐步骤、逐测试、退出码、耗时、证据）。`-- --only=final,lifecycle,permission` 可复跑选定步骤；同一 productCommit 的既有本次结果会保留，并在 reruns / replacedSteps 中记录替换；没有执行记录的项为 NOT RUN。不设 `VOKA_NATIVE_PERMISSION=1` 时 T-02 的真实 native step 记 PARTIAL，且不修改授权配置；完整 native 路径需要本机 Orca accessibility。所有 fixture 都是测试状态，脚本会进行大量导入、复习和隔离 Anki 重启，不能拿去连接日常收藏。

旧 harness 的修订仅修复验收器：等待 drawer 异步更新/upgrade summary 完成，使用当前 `#importTarget` UI、等待稳定且 enabled 的点击目标，扩大 SQLite stdout buffer，显式清理复制目标 SHM，以及把旧硬编码 Playwright renderer 统一到 Puppeteer 的 Chrome for Testing。站点权限准备会切换 tab，等待 rAF 驱动的 DOM 断言前明确 bringToFront；Gmail fixture 与停止/重启检查使用独立 profile，避免共享浏览器准备状态。初期失败属于这些过时假设、fixture/授权准备或验收器问题；最终结果以本次完整重跑为准。没有在本 PR 修产品 bug。本次未发现可复现产品 FAIL，因此未另开缺陷 issue；suite.log 与 results.json 的 replacedSteps 保留验收器失败/复跑记录，不把这些尝试隐藏为一次全过。

## 需要人工确认

以下项目合并自各票报告的 Not verified / Limits / Remaining limits；自动化补过的旧缺口（整级写入、候选切换、完整卡片、真实 reviewer 本地记录、实际停止 Anki、Anki 原生授权）不再当作未做。范围仍仅限本机 Anki 26.09.3、Chrome for Testing 156.0.8078.47、当前数据包；不据此声明所有平台兼容。

- **Chrome 原生界面**：首次安装及可选站点权限 Allow/Deny 对话框、真实图标点击触发首次记住授权、尤其是物理工具栏点击唤醒完全停止的 service worker（#56）。cold-start 自动化捕获实际 listener 并延迟临时构建的缓存，用 developerPrivate 预授权；不能替代这些手势。还需核对真实安装提示、拒绝权限及恢复路径。[site scope](site-scope-acceptance.md)、[cold start](site-scope-cold-start.md)、[onboarding](onboarding-acceptance.md)。本次 T-02 的 **Anki** 原生 Yes 对话框已有真实验证，与 **Chrome** 原生权限弹窗不同。
- **持久化与安装**：关闭并重新启动整个浏览器后，站点注册、学习设置、人工标记和释义语言是否保留；Chrome Web Store 安装/审核；多窗口、多标签、跨站导航；设备切换或扩展重装后的 kept-upgrade 迁移/重新提示。页面 reload 与本地 storage 读回已测，不能等同于浏览器重启。[manual status](manual-status-acceptance.md)、[lemma candidates](lemma-candidates-acceptance.md)、[kept upgrades](upgrade-keep-memory-acceptance.md)。
- **移动端和真实同步**：AnkiMobile / AnkiDroid 的完整卡片、缺释义回退和 CSS 切换，以及 AnkiWeb 的显示/同步；本地复习记录跨真实 sync 的保持。没有使用测试账号凭据或执行人工 sync / Upload / Download；`col.scm` 不变只证明本地 schema-modified 值未变，不能替代端到端同步验证。[gloss switch](gloss-switch-acceptance.md)、[note import](note-import-acceptance.md)。
- **真实站点与框架**：真实 Gmail、Outlook、邮件/聊天/密码库页面；真实第三方 React 和 Vue 应用（本次动态检查用本地 React 18.3.1）；iframe / Shadow DOM 文字、任意页面布局；仅改 stylesheet 而没有可观察 DOM mutation 的情况；滚动同时发生框架更新。T-31 的 mail.google.com 内容来自本地 fixture 的 CDP 响应，不是真实 Gmail。[site scope](site-scope-acceptance.md)、[dynamic pages](dynamic-pages-acceptance.md)、[contexts](context-acceptance.md)。
- **性能与交互环境**：低性能设备、极大单段落、长期运行/极大个人收藏、真实滚轮/触控板滚动。2,000 段本地 fixture 的 measurements 不是全设备性能保证；programmatic rAF scrolling 不等于物理滚动。[dynamic pages](dynamic-pages-acceptance.md)。
- **Anki 排程边界**：真实 Learning/Relearning 状态与 21 天 Review 边界、每日新卡上限的实际引入行为、其他 Anki / AnkiConnect 版本。本次 reviewer 实际回答三张新卡并验证记录保持，未模拟数周学习。[highlight](highlight-acceptance.md)、[level import](level-import-acceptance.md)。
- **真实冲突与取消**：人为损坏的重复 Key 收藏在产品导入预览中的冲突展示/跳过（v1 判重实测不等于整条 UI 冲突路径）；在正在执行的 createMany 请求内部点击取消。已验证的是批次边界取消/续传；产品不承诺回滚已提交批次。[level import](level-import-acceptance.md)、[manual status](manual-status-acceptance.md)。
- **例句分支与外部并发编辑**：未分级词条的实际加入、完整 URL opt-in 后实际写入的来源、固定例句的替换拒绝等未覆盖的 live 分支；用户在 Anki 外部编辑与 extension read→patch 同时发生的竞争。已有单元覆盖不能替代真实设备检查，v1 无 conditional-write 原语。[contexts](context-acceptance.md)。
- **升级故障**：真实网络断连/拒绝写入、真实 202-note upgrade、worker 重启或 token 过期时的预览恢复、正在 patch 时发生外部编辑。确定性失败/不确定响应测试仍只是单元测试；kept 决定的重装/跨设备行为也未验证。[gloss upgrade](gloss-upgrade-acceptance.md)、[kept upgrades](upgrade-keep-memory-acceptance.md)。
- **真实鉴权与数据质量**：真实 API-key 保护的 Anki 实例（onboarding 使用 mock）；词典释义/音标和 heteronym 发音的全面人工质量检查、CMU 无词性标注与 OEWN US fallback 的限制。数据构建/格式校验不证明语义正确。[onboarding](onboarding-acceptance.md)、[data pipeline](data-pipeline-acceptance.md)。
- **中文释义人工审查**：必须完成 [210 行抽样](gloss-full/spot-check.csv)（每级 30 行 + 未分级 30 行）及其 OEWN grounding 对照；本次未把格式全过当成语义全过。[full gloss acceptance](gloss-full/acceptance.md)。
- **发布门槛**：CEFR-J 嵌入式再分发条款澄清、Octanove 来源确认以及实际商店审核反馈，属于 spec §7.3 / §19 的发布工作，本验收不代表已取得许可。[data pipeline](data-pipeline-acceptance.md)。
