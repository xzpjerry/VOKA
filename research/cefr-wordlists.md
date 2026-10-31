# 英语 CEFR 等级词表的再分发许可与覆盖

对应 issue #2。目标场景：VOKA（Chrome MV3 扩展，代码 MPL-2.0）公开上架 Chrome Web Store，内置词表数据随扩展包再分发。研究日期 2026-10-31。只陈述事实，不做选型决定。

## 结论摘要

- **能拼出合法的 A1–C2**：CEFR-J Wordlist v1.5/1.6（A1–B2）+ Octanove Vocabulary Profile C1/C2 v1.0，二者都发布在 [openlanguageprofiles/olp-en-cefrj](https://github.com/openlanguageprofiles/olp-en-cefrj)，明文允许商用/再分发，只需署名；Octanove 部分为 CC BY-SA 4.0（ShareAlike）。
- 合计约 **8,650 个唯一 headword（9,935 行 lemma+POS）**，粒度为 lemma+词性，不含义项。覆盖面远小于 Oxford 5000 / EVP，C1/C2 部分偏薄（C1 1,111 行、C2 1,025 行）。
- **Oxford 3000/5000、Cambridge EVP 不可内置再分发**：均为受版权保护的专有数据，未见允许再分发的许可，Oxford 条款明确禁止系统性复制与对外分发；GitHub/HF 上不少“开源 CEFR 词表”实为从二者衍生，MIT 等标签不能洗白上游版权。
- **Wiktionary/Kaikki 没有可用的 CEFR 分级**（词条上基本无 CEFR 标签）。许可（CC BY-SA + GFDL）可再分发，但不提供等级，只能作为释义/词性来源。
- 主要风险：(1) CEFR-J 官网条款有“涉及监修/编辑时需另行协商并可能收费”的模糊措辞；(2) Octanove ShareAlike 对“合并后数据文件”的传染范围；(3) 数据停更（最后提交 2020-03）；(4) 覆盖/粒度缺口（无义项级、无短语分级）；(5) Octanove 构建方法未公开，无法排除其派生自专有来源。

## 候选逐项

### 1. CEFR-J Wordlist（A1–B2）

- **来源/版权**：东京外国语大学 Tono Laboratory 版权。官网 [cefr-j.org/download.html](https://www.cefr-j.org/download.html) 当前为 v1.6（2020-03-24 更新）；GitHub 镜像 [olp-en-cefrj](https://github.com/openlanguageprofiles/olp-en-cefrj) 为 v1.5（2020-01 取自官网）。
- **许可**：镜像 README 原文：“can be used for research and commercial purposes with no charge, provided that you cite the dataset properly”。官网条款：允许商用、允许修改后再分发，但须规范引用（格式 “The CEFR-J Wordlist Version 1.6. Compiled by Yukio Tono, Tokyo University of Foreign Studies. Retrieved from [URL] on [date].”）；另有一句“涉及监修或编辑时需另行咨询，可能收取必要费用”（含义未界定，是否涵盖“把词表嵌入产品”需向权利人确认）。
- **等级**：A1、A2、B1、B2（无 C1/C2）。官网统计 A1 1,166 / A2 1,411 / B1 2,445 / B2 2,779，共 7,801 条（v1.6）。本研究实测 GitHub v1.5 CSV：7,799 行（A1 1,164 / A2 1,411 / B1 2,446 / B2 2,778），6,863 个唯一 headword。
- **粒度**：lemma + 词性（CSV 列 `headword,pos,CEFR,CoreInventory 1,CoreInventory 2,Threshold`）；词性为文字（noun/verb/…）。部分 headword 含斜杠变体（如 `a.m./A.M./am/AM`），需清洗。
- **维护**：基本停更（镜像最后推送 2020-03-25；官网最新 v1.6 为 2020-03）。官网声明含不完整部分、可能有误。
- 仓库无 LICENSE 文件：许可仅以 README 文字形式存在，不是标准 SPDX 许可。

### 2. Octanove Vocabulary Profile C1/C2 v1.0

- **来源**：Octanove Labs 制作，作为 CEFR-J 的 C1/C2 扩展，托管于同一仓库。
- **许可**：README 原文：CC BY-SA 4.0（[legalcode](https://creativecommons.org/licenses/by-sa/4.0/)）。允许商用与再分发，要求署名、标明修改、衍生作品以同样许可发布。
- **等级**：仅 C1、C2。实测 2,136 行（C1 1,111 / C2 1,025），1,955 个唯一 headword；45 行带 notes。与 CEFR-J headword 有 165 个同形重叠（词性/等级可能不同，合并时需消歧）。
- **粒度**：lemma + 词性（`headword,pos,CEFR,notes`）。
- **维护**：停更（2020-03）。
- **制作方法未在一手来源中找到公开说明**（[octanove.com](https://www.octanove.com/) 与仓库 README 均未描述）。无法核实其是否派生自 EVP 等专有来源；仓库以 CC BY-SA 自行授权。
- **ShareAlike 影响（事实陈述）**：Octanove 数据及其“改编”须 CC BY-SA。若与 CEFR-J 合并成单一文件，合并文件是否整体落入 SA 没有明确裁定；保持两个独立数据文件、各带署名与许可声明可避免该问题。扩展代码（MPL-2.0）与数据文件是不同作品，是常见做法，但属法律判断，本研究不作定论。

### 3. Cambridge English Vocabulary Profile（EVP）

- **版权方**：Cambridge University Press & Assessment（English Profile 项目）。
- **条款**：官方 `englishprofile.org/wordlists/terms-of-use`（本次直连抓取返回 404，未能读到全文；该 URL 被 [HF miesepeter/CEFR_vocab_tokens](https://huggingface.co/datasets/miesepeter/CEFR_vocab_tokens) 引用为授权依据）。二手检索结果显示条款禁止他人在未获书面许可时将商业材料标榜为 “English Profile informed”。EVP 提供免费在线浏览，但**未见任何允许打包再分发的许可**。结论：按默认版权处理，不可内置，需向 CUP 申请书面许可。
- **等级/粒度**：A1–C2；义项级（词条 + 词性 + 义项 + 等级 + 例句）。
- **维护**：在线版持续维护，数据封闭。

### 4. Oxford 3000 / 5000

- **版权方**：Oxford University Press。[官方说明页](https://www.oxfordlearnersdictionaries.com/about/wordlists/oxford3000-5000)：Oxford 3000 对齐 A1–B2；Oxford 5000 追加 2,000 词，对齐 B2–C1（**无 C2**）；基于 Oxford English Corpus 频率与 OUP 教材语料；站内提供浏览/下载。
- **条款**：[OLD Terms & Conditions](https://www.oxfordlearnersdictionaries.com/terms-and-conditions) §3.1：不得系统性复制产品内容为印刷/电子副本（除非产品专项条款允许）、不得在互联网上向非授权用户展示或分发产品任何部分；§9.4.2 消费者只能家庭与私人使用，不得用于商业、业务或转售。词表页本身未给出独立开源许可。结论：不可内置再分发，需 OUP 书面许可。
- **粒度**：词 + 词性 + 级别，约 5,000 条。
- **衍生品污染示例**：[datpmt/cefr-words](https://github.com/datpmt/cefr-words)（MIT 标签，数据源自 Oxford 3000/5000 与 Oxford Phrase List，A1–C1）——MIT 标签不改变上游版权。

### 5. Wiktionary / Kaikki 衍生

- **许可**：Wiktionary 内容 CC BY-SA + GFDL；[wiktextract](https://github.com/tatuylonen/wiktextract) / [kaikki.org](https://kaikki.org) 抽取数据沿用同一许可。可商用、可再分发，需署名与相同方式共享。
- **CEFR 等级**：英文 Wiktionary 中几乎没有逐词 CEFR 标签。用 MediaWiki 搜索 API 查询 `insource:"CEFR" incategory:English_lemmas` 仅 6 条命中，且是 A1、C2 等与等级概念本身相关的词条，而非词条的等级标注。结论：不能作为 CEFR 分级来源，仅可补充释义、词性、IPA。

### 6. 其他开源 CEFR 数据集及其上游来源

| 数据集 | 声称许可 | 实际上游 | 可用性 |
|---|---|---|---|
| [Maximax67/CEFRpy](https://github.com/Maximax67/CEFRpy) | MIT（代码） | 基于 CEFR-J 与 Google Books Ngram、NLTK/WordNet 等；称覆盖 A1–C2（C1/C2 等级来源 README 未说明） | 数据来源混合，需逐项核实后才能引用 |
| [datpmt/cefr-words](https://github.com/datpmt/cefr-words) | MIT | Oxford 3000/5000 + Oxford Phrase List | 不干净 |
| [miesepeter/CEFR_vocab_tokens](https://huggingface.co/datasets/miesepeter/CEFR_vocab_tokens)（HF） | “Other”，指向 englishprofile.org 条款 | English Profile 词表 | 不干净 |
| [CEFR-Annotated WordNet](https://arxiv.org/html/2510.18466)（数据在 [Zenodo](https://doi.org/10.5281/zenodo.17395388)） | 论文称资源公开，具体许可未核实 | 用 GPT-4o 把 EVP Online（美式子集）义项等级对齐到 WordNet；约 10,995 标注 / 10,644 义项 / 5,645 lemma | 标签是 EVP 的派生，来源不干净 |
| [EFLLex（CEFRLex）](https://cental.uclouvain.be/cefrlex/efllex/download/) | CC BY-NC-SA 4.0 | 15,280 lemma，A1–C1 | NC 禁止商业用途；无 C2 |
| UniversalCEFR（[arXiv](https://arxiv.org/html/2506.01419v2)） | CC BY-NC-SA 4.0 | 文本级语料，非词表 | 不适用 |
| KELLY（[HF codesue/kelly](https://huggingface.co/datasets/codesue/kelly)） | CC BY 4.0 | 该镜像为瑞典语；原项目覆盖九种语言，英语版现行许可本次未核实 | 未确认 |

## 覆盖与缺口

| 等级 | 合法来源 | 规模（行，lemma+POS） |
|---|---|---|
| A1 | CEFR-J | 1,164–1,166 |
| A2 | CEFR-J | 1,411 |
| B1 | CEFR-J | 2,445–2,446 |
| B2 | CEFR-J | 2,778–2,779 |
| C1 | Octanove | 1,111 |
| C2 | Octanove | 1,025 |

- 合法拼合可达 A1–C2 全覆盖，约 9,935 行 / 约 8,650 唯一 headword（含 165 个两表重叠 headword 的消歧问题）。
- 缺口：无义项级分级（多义词只有一个等级，与 EVP 的义项分级差异大）；无短语动词/习语的系统分级；词表停留在 2020 年；C1/C2 制作方法未公开；两表 headword 规范（大小写、斜杠变体、复合词）需自行清洗；词形还原需运行时 lemmatizer 配合。
- 若需要更大或义项级覆盖，路径是向 CUP（EVP）或 OUP（Oxford 3000/5000）申请书面许可，或自建（如频率语料 + 自有标注），本研究未评估成本。

## 若采用 CEFR-J + Octanove 的署名与合规清单

1. 随扩展发布 CEFR-J 引用文本（含 URL 与取用日期）及版权方 Tono Laboratory, TUFS 声明。
2. 随扩展发布 Octanove 的 CC BY-SA 4.0 署名、许可链接，并标明是否做过修改（清洗/格式转换视为修改）。
3. 向 cefr-j.org 联系方确认“监修/编辑需另行协商并可能收费”是否适用于嵌入产品（待确认）。
4. 向 Octanove Labs 确认其 C1/C2 构建来源（待确认）。

## 未能核实的项

- EVP terms-of-use 全文（englishprofile.org 对本次抓取返回 404）。
- Oxford 3000/5000 “下载”的产品专项条款（词表页对机器抓取返回 403，仅读取了站点通用条款）。
- Zenodo CEFR-Annotated WordNet 的具体许可。
- KELLY 英语版现行许可。
