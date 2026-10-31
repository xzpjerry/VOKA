# 离线英语释义、音标与词形还原数据（Issue #3）

调研日期：2026-10-31。只陈述事实与出处，不做选型（选型留给后续 grilling ticket）。本文不是法律意见。
体积数字中，标 **实测** 的是本次下载真实数据后统计的；标 **估算** 的是据样本外推。"裁剪到 ~20k 词头"= 取 ECDICT `frq`（当代语料词频排名）最靠前的 20,000 个纯字母词。

## 0. 结论速览

| 类别 | 候选 | 许可 | 对 MPL-2.0 扩展的影响 | 裁剪 20k 词体积 |
|---|---|---|---|---|
| (a) EN→ZH | ECDICT | 仓库 MIT，但数据来源不透明 | 许可文本无 share-alike；**来源/版权风险**需单独评估 | 词条+音标+中文释义 ≈ 2.2 MB JSON / 0.78 MB 压缩（实测） |
| (a) | CC-CEDICT | CC BY-SA 4.0 | 方向是 ZH→EN，不适用于本需求 | — |
| (b) EN→EN | Open English WordNet 2025 | CC BY 4.0（含 Princeton WordNet 3.1 许可声明） | 仅署名，无 share-alike | 每词 ≤4 条释义 ≈ 2.5 MB / 0.87 MB 压缩（实测） |
| (b) | Wiktionary via Kaikki | CC BY-SA 4.0 + GFDL | **有 share-alike**，数据文件须以 BY-SA 分发 | 每词 ≤5 gloss+IPA+词形 ≈ 10–20 MB / 4–8 MB 压缩（估算） |
| (b) | Princeton WordNet 3.1 | Princeton 宽松许可 | 须在所有副本保留版权声明 | 与 OEWN 同量级 |
| (c) IPA | CMUdict | BSD 式（CMU） | 仅保留声明；输出为 ARPAbet 需转 IPA，仅美音 | 20k 词 ≈ 0.4–0.5 MB（估算） |
| (c) | Wiktionary IPA | CC BY-SA 4.0 | 同上，share-alike | 并入 Kaikki 数据 |
| (c) | ECDICT `phonetic` | 同 ECDICT | 非严格 IPA（混用 DJ/KK 式 ASCII 近似）；抓取自网页 | 0.86 MB JSON / 0.21 MB 压缩（实测） |
| (c) | OEWN `pronunciation` | 同 OEWN（CC BY 4.0） | 仅部分词条有 | 含在 OEWN 内 |
| (d) 词形还原 | ECDICT `exchange` | 同 ECDICT | 无 share-alike | 20k 词 ≈ 1.07 MB / 0.24 MB（实测） |
| (d) | wink-lemmatizer + wink-lexicon | MIT（代码）；例外表源自 WordNet | 须保留 WordNet 声明 | 三张例外表合计 ≈ 286 KB 源码（实测） |
| (d) | Wiktionary `forms` | CC BY-SA 4.0 | share-alike | 并入 Kaikki 数据 |

## 1. 许可与 MPL-2.0 的关系（通用）

- **MPL-2.0 是文件级 copyleft**："The copyleft applies to any files containing MPLed code"；不含 MPL 代码的新文件可用其他许可，即便在同一个更大作品中。MPL 与 BSD/Apache 许可文件可同包分发。出处：<https://www.mozilla.org/en-US/MPL/2.0/FAQ/>。MPL FAQ 另说明 MPL "should generally only be used for software"，故数据文件应保留自己的许可而不是改标 MPL。
- **CC BY-SA 4.0 的兼容清单**：Creative Commons 官方列出的 BY-SA 兼容许可只有 BY-SA 4.0（及其后续/移植版）、Free Art License 1.3、GPLv3（且为单向）。**MPL 不在清单上**。出处：<https://creativecommons.org/share-your-work/licensing-considerations/compatible-licenses/>。因此不能把 BY-SA 数据"改授权"为 MPL，也不能让 MPL 覆盖 BY-SA 的改编数据。
- **Share-alike 触发条件**：BY-SA 4.0 §3(b) 要求分发 "Adapted Material"（"translated, altered, arranged, transformed, or otherwise modified" 的材料）时使用 BY-SA 或其兼容许可；§3(a) 要求保留署名、版权声明、许可链接、免责声明并指明是否修改。出处：<https://creativecommons.org/licenses/by-sa/4.0/legalcode.en>。CC FAQ 区分"集合（collection）"与"改编（adaptation）"：集合可自选许可，改编须 BY-SA。<https://creativecommons.org/faq/>
- **对本项目的含义（事实层面）**：把 Wiktionary 数据裁剪、重新编码为紧凑格式、与其他数据合并，都属于对数据的改编，**生成的数据文件**需以 CC BY-SA 4.0 提供（并给出署名与许可链接）。扩展的 MPL 代码文件本身是否因同包分发而受 SA 影响，法律文本未明确界定（CC 许可文本自身对"集合/改编"阈值没有给出判定标准），应视为未决法律问题。若采用 BY-SA 数据，数据文件需独立成文件、各自标明许可，代码不要内嵌数据。
- BY 4.0 / MIT / BSD 类许可（OEWN、ECDICT 仓库、CMUdict、wink 系列）只要求保留版权与许可声明，无 share-alike。
- Chrome Web Store 分发的 .crx 是 zip，用户可直接取出数据文件，不涉及技术保护措施（BY-SA 禁止对被许可材料施加限制接收者权利的有效技术措施）的问题；但商店页/扩展内"关于"页应放置署名。

## 2. (a) EN→ZH 释义

### ECDICT（skywind3000/ECDICT）
- 许可：仓库 `LICENSE` 为 MIT，Copyright (c) 2025 Linwei。<https://github.com/skywind3000/ECDICT/blob/master/LICENSE>（GitHub API 同样识别为 MIT）。
- 来源（README 自述）：初始 EDictAZ.txt（约 2 万词）、CET4/CET6/GRE 词表、Linux `cdict-1.0-1.rpm` 开源词典数据、BNC 词频与词形统计、diaosi 词典英汉部分（2017-04-07 并入）、NodeBox 与 WordNet 工具。README 称中文释义是"多来源整理"，并含网页抓取（音标）。<https://github.com/skywind3000/ECDICT/blob/master/README.md>
- **来源风险（观察，非定论）**：MIT 声明由单一维护者作出，但数据行里有 `[网络]`、`[医]` 等标注的释义，以及 `collins`、`oxford`、`tag` 等字段，疑似源自第三方商业词典；README 未逐字段给出上游许可。`definition`（英文释义）样例（如 "n. the posterior part of a human (or animal) body from the neck to the end of the spine"）与 WordNet 释义风格一致，若确系 WordNet 衍生则适用 Princeton 许可声明（见 §3）。**上游权利链不可由 README 验证。**
- 规模（实测，v1.0.28 的 `ecdict.csv` 66,009,548 B）：770,611 行；有中文 `translation` 770,238；有英文 `definition` 160,884；有 `phonetic` 218,065；有 `exchange` 96,290；有 `frq>0` 42,231。
- 字段：word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, detail, audio。
- 发布包大小：`stardict.7z` 51.6 MB；release 1.0.28 的 sqlite 包 216.8 MB、mdx 包 97.8 MB 等。
- 裁剪到 20k（实测，按 frq 排序、仅纯字母词）：word+phonetic+translation JSON 2.22 MB，zlib 压缩 0.78 MB；加 exchange 2.90 MB / 0.96 MB；再加英文 definition 5.47 MB / 1.99 MB。该 20k 集合中 18,995 词有音标、19,759 词有英文释义。
- 释义风格：词性缩写 + 逗号分隔的中文义项，如 `back`："a. 后面的\nvt. 使后退, 支持 ..."，较稠密，面向考试词汇。

### CC-CEDICT
- 许可 CC BY-SA 4.0；但数据是 **汉→英**（词头为汉字），对"英→中释义"不适用，仅可能用于反向查找，本需求可忽略。（未单独抓取其页面，此条依据其公开定位；如需采用请另行核实。）

### 其他
- Wiktionary 英文词条内含少量"Translations"表（含中文），但覆盖稀疏且为 CC BY-SA；本次未量化。

## 3. (b) EN→EN 单语释义

### Open English WordNet（OEWN）
- 许可：CC BY 4.0（Copyright (c) 2019-present, The Open English Wordnet Team）；发行包内 `WNDB_License.txt` 内嵌 Princeton WordNet 3.1 许可：允许为任何目的免费使用、复制、修改、分发，但须在**所有副本**（含修改版）保留版权声明与免责声明，且不得用 Princeton 名义做宣传。出处：<https://github.com/globalwordnet/english-wordnet/blob/main/LICENSE.md>、<https://github.com/globalwordnet/english-wordnet/blob/main/WNDB_License.txt>、<https://en-word.net/>。
- 版本：2025 Edition（2025-12-31 发布）；2025+ 含 161,875 词 / 120,564 synset；核心 2025 为 135,969 词 / 107,519 synset。实测 JSON 包解析：107,519 synsets、128,009 lemma 条目。
- 发布包（2025-edition release assets）：JSON zip 9.99 MB、XML.gz 11.4 MB、WNDB zip 9.6 MB；解压 JSON 约 69 MB（实测）。
- 质量：义项按词义（synset）组织，释义简短、定义式，偏书面语；有同义词集、上位词等关系，对学习者词典而言义项粒度偏细；没有例句的比例未统计。
- 音标：32,473 / 128,009 条目有 `pronunciation`（实测，约 25%）；来源许可未在 README 层面核实。
- 裁剪到 20k（实测）：20k 词中 19,214 词在 OEWN 内；每词最多 4 条（每词性前 2 个 sense）释义，JSON 2.51 MB，zlib 0.87 MB。13,401 词带 pronunciation。

### Princeton WordNet 3.0/3.1
- 许可：见上，宽松但须保留声明。官方许可页（wordnet.princeton.edu/license-and-commercial-use）抓取时返回 403，故以 OEWN 发行包内转载的 WordNet 3.1 许可原文为准。OEWN 是其 fork 并持续维护，Princeton 版本停留在 3.0/3.1，且无 CC 许可，实际更适合直接用 OEWN。

### Wiktionary via Kaikki（wiktextract）
- 许可：Wiktionary 原文为 CC BY-SA 4.0 与 GFDL 双许可（<https://en.wiktionary.org/wiki/Wiktionary:Copyrights>）。Kaikki 页面只要求学术引用 Ylonen (LREC 2022) 并欢迎链接 kaikki.org（<https://kaikki.org/dictionary/rawdata.html>），不改变底层 BY-SA。wiktextract 工具本身为独立项目（本次未核实其代码许可）。
- 数据量：英语词典抽取 1,396,111 个词条（含所有语言词形），原始 wiktextract JSONL 24.8 GB（压缩 2.9 GB），来自 2026-10-01 的 enwiktionary dump。旧的 postprocessed 英语文件 3.2 GB 已标记 DEPRECATED。<https://kaikki.org/dictionary/English/index.html>
- 样本（实测，kaikki 单词 JSONL）：`run` 238 KB、`the` 101 KB、`serendipity` 32 KB（原始）；仅保留 pos、前 2 个 IPA、前 5 条 gloss、前 8 个 form 后分别 0.99 KB / 1.08 KB / 0.44 KB（压缩 0.48 / 0.46 / 0.29 KB）。
- 估算：高频词平均 ≈ 0.5–1 KB/词，20k 词 ≈ 10–20 MB 原始 JSON、4–8 MB 压缩；若仅保留前 1–2 条 gloss 可压到约 4 MB。
- 质量：释义面向通用读者，含大量例句、用法标签；高频虚词（如 `the`）glosses 有重复与省略号残片，需清洗；`forms` 含 `no-table-tags`、`glossary` 等噪声标记（样例中 `run`）。含现代词汇（含俚语、新词）覆盖优于 WordNet。
- 许可影响：这是 **唯一在英→英候选中带 share-alike 的**，见 §1。

### 其他
- 其他英英词典（GCIDE 等）未在本次范围核实，不作结论。

## 4. (c) IPA 音标

| 来源 | 格式 | 覆盖 | 许可 | 备注 |
|---|---|---|---|---|
| Wiktionary（Kaikki `sounds[].ipa`） | 严格 IPA，常有多条（US/UK），如 `/ˌsɛɹ.ənˈdɪp.ɪ.ti/` | 高频词基本都有 | CC BY-SA 4.0 | 带 share-alike；需清洗 `[ðɪj]` 等括注 |
| CMUdict（cmusphinx/cmudict） | ARPAbet，需映射为 IPA | 约 13 万词，仅美音 | CMU BSD 式：源码/二进制再分发须保留版权声明与免责声明 | 出处 <https://github.com/cmusphinx/cmudict/blob/master/LICENSE>；映射表需自建（映射本身不受 CMUdict 许可约束，输出数据仍是其衍生物，保留声明即可）；20k 词估算 0.4–0.5 MB |
| ECDICT `phonetic` | 非严格 IPA | 全库 218,065 / 770,611；20k 高频集 18,995 | 同 ECDICT | 样例：`gud`、`'eni`、`twi:n`，为 KK/DJ 风格 ASCII 近似，非标准 IPA；来源为网页抓取，权利链不明 |
| OEWN `pronunciation` | IPA | 约 25% 词条 | 同 OEWN（CC BY 4.0） | 样例 `A` 为 `eɪ̯` |

- 开源社区另有 `ipa-dict` 等项目，本次未核实其许可，不作结论。

## 5. (d) 屈折形 → lemma

### ECDICT `exchange` 字段
- 格式 `类型:变体/类型:变体`，类型码：p 过去式、d 过去分词、i 现在分词、3 第三人称单数、r 比较级、t 最高级、s 复数、0 lemma、1 lemma 的变形类型。样例（实测）：`back` → `d:backed/s:backs/p:backed/i:backing/3:backs`；`good` → `t:best/r:better`。
- 覆盖：96,290 行有 exchange。20k 高频词的 `word + exchange` JSON 1.07 MB，压缩 0.24 MB（实测）。需自行反转成 form→lemma 表。
- 另有仓库内 `lemma.en.txt`（2,318,694 B），自述 "En Lemma Database v1.0.3"，由作者参考 BNC 1 亿词、NodeBox Linguistics、Yasumasa Someya 词形表编制，"provided as is and is free to use for any research"（该措辞偏研究用途，与仓库 MIT 并存；商业/公开分发的权利链需自行判断）。

### wink-lemmatizer
- 许可：MIT，Copyright 2017-20 GRAYPE Systems Private Limited。<https://github.com/winkjs/wink-lemmatizer>
- 实现："an adaptation of WordNet's Morphy"：名词有少量后缀规则，形容词/动词用后缀去除；例外表来自 `wink-lexicon` 的 `wn-noun-exceptions.js`（119,299 B）、`wn-verb-exceptions.js`（100,082 B）、`wn-adjective-exceptions.js`（66,672 B），共约 286 KB 源码；`wn-words.js` 1.89 MB 与 `wn-senses.js` 等用于验证候选词是否存在。wink-lexicon 同为 MIT。<https://github.com/winkjs/wink-lexicon>
- 许可注意：例外表是 WordNet `*.exc` 文件的衍生，WordNet 许可要求保留 Princeton 版权声明；wink 仓库的 MIT 声明本身没有转载该声明（样例文件头只有 GRAYPE MIT 声明）。
- 限制：按词性分别调用（名/动/形），不带词性上下文时需自行遍历。

### Wiktionary `forms`
- Kaikki 条目的 `forms` 数组（如 `run`: runs/running/ran）可直接反推 form→lemma，覆盖含不规则与现代词汇，但许可为 BY-SA（见 §1）。

### WordNet morphy 例外表
- 直接使用 WordNet / OEWN `*.exc`（不规则形态例外）加 morphy 后缀规则，许可同 §3 OEWN；具体 `.exc` 文件体积本次未统计，wink-lexicon 的三张表（约 286 KB）可作量级参考。

## 6. 汇总：体积预算参考（20k 词头，gzip/zlib 压缩前后）

| 数据块 | 原始 | 压缩 |
|---|---|---|
| ECDICT 词条+音标+中文释义（实测） | 2.2 MB | 0.78 MB |
| ECDICT exchange 词形（实测） | 1.07 MB | 0.24 MB |
| ECDICT 英文 definition（实测，仅 20k 词） | 2.97 MB | 0.97 MB |
| OEWN 前 4 条释义（实测） | 2.5 MB | 0.87 MB |
| ECDICT phonetic 单项（实测） | 0.86 MB | 0.21 MB |
| Kaikki 裁剪版（估算） | 10–20 MB | 4–8 MB |
| CMUdict→IPA（估算） | 0.4–0.5 MB | 0.15 MB 量级 |
| wink-lexicon 例外表（实测，源码） | 0.29 MB | — |

## 7. 未决/未核实

1. ECDICT 各字段（尤其中文 translation、collins/oxford/tag）的上游版权状态无法由 README 核实。
2. BY-SA 数据与 MPL 代码同包分发时，SA 是否外溢到代码，没有权威判例或 CC 对软件的明确答复；本文只给出文本事实。
3. Princeton 官网许可页 403，WordNet 许可以 OEWN 转载文本为准；CC-CEDICT、`ipa-dict`、wiktextract 代码许可未逐一核实。
4. 体积中标"估算"的 Kaikki 与 CMUdict 数值未全量跑通。
