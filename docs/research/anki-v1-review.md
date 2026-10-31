# AnkiConnect v1 写入复核（#19）

2026-10-31，Anki 26.09.3、新版 AnkiConnect，固定 `http://127.0.0.1:8766/api/v1`。全部 API 请求为 v1；未调用同步、未修改配置。脚本先创建独立笔记类型（首字段 Key）、两个牌组及另一笔记类型；结束删除测试笔记、牌组和未使用的测试笔记类型。

复现：启动 `~/VOKA-anki-test/launch.sh`，执行 `python3 tools/review_anki_v1.py --output docs/research/anki-v1-raw.json`。脚本会对隔离收藏作结构编辑正对照，使其 schema-modified；不调用同步。请勿把它用于真实收藏。测量在每次调用前后等待 0.3 秒，复制 collection.anki2 与存在的 -wal 到全新临时目录、删除目标 -shm，再读 `select scm from col`；它测量 scm 而未实际触发全量同步。

[完整请求、原始响应文本及解析结果](anki-v1-raw.json)通过 `calls[].label` 对应下表；`describe` 保留运行时完整 schema。以下 JSON 均为该次运行的原始响应，动态 ID 未替换。

| 检查（证据 label） | 结果 | matches spec / differs from spec |
|---|---|---|
| validate_new | valid=true | matches |
| validate_exact | valid=false，返回重复 note ID | matches |
| validate_case (`En:Achieve` vs `en:achieve`) | valid=true，区分大小写 | matches §6 / ADR-0001 |
| validate_html | valid=false，去 HTML | matches |
| validate_other_deck_default | valid=false，默认跨牌组 | matches |
| validate_deck_scope_other / same | 另一牌组 true，本牌组 false | 补充明确 scope 参数 |
| validate_other_type_default / across_types | 默认 true；acrossNoteTypes=true 为 false | 补充明确参数；跨类型返回还包含测试收藏原有匹配笔记，脚本不修改它们 |
| invalid_scope | -32602 invalidParams，未静默回退 | v1 与早期 v6 实测不同；原规格未承诺回退 |
| non_atomic / after_non_atomic | [new, duplicate, new] 返回成功、错误、成功；共存在 seed + 两条新笔记 | matches |
| reset_batch / atomic / after_atomic | 删除两条成功笔记恢复相同初态，再提交同一数组；顶层 1002 validationFailed，仅 seed 存在 | 补充 atomic=true 行为 |
| before_merge / update_note / after_merge | 只将 Word 从 original 改为 changed；Key=en:achieve、Keep=preserved 保留 | matches §6；未修改词条 Key |
| 写入方法返回方式 / navigate / operation_0 | 本次测试的笔记、标签、笔记类型写入直接返回完成值，无 operationId；navigate 返回句柄，operations.get 用 state=succeeded 表示完成 | differs：§6 原先笼统要求超时后 operations.get 回查；没有句柄无法这样回查 |

## col.scm

| 操作（证据 label） | before | after | matches spec / differs from spec |
|---|---|---|---|
| create_type | 1793435866789 | 1793435866789 | matches（未改变） |
| update_css | 1793435866789 | 1793435866789 | matches（未改变） |
| update_name | 1793435866789 | 1793435866789 | matches（未改变） |
| update_note | 1793435866789 | 1793435866789 | matches（未改变） |
| add_tag | 1793435866789 | 1793435866789 | matches（未改变） |
| add_field | 1793435866789 | 1793435872218 | matches（改变，结构编辑正对照） |

## 返回 JSON

### validate_new

```json
{"jsonrpc": "2.0", "id": 8, "result": {"items": [{"index": 0, "result": {"valid": true, "issues": [], "duplicateNoteIds": []}}]}}
```

### validate_exact

```json
{"jsonrpc": "2.0", "id": 9, "result": {"items": [{"index": 0, "result": {"valid": false, "issues": [{"type": "duplicate", "message": "A matching note exists."}], "duplicateNoteIds": ["1793435867893"]}}]}}
```

### validate_case

```json
{"jsonrpc": "2.0", "id": 10, "result": {"items": [{"index": 0, "result": {"valid": true, "issues": [], "duplicateNoteIds": []}}]}}
```

### validate_html

```json
{"jsonrpc": "2.0", "id": 11, "result": {"items": [{"index": 0, "result": {"valid": false, "issues": [{"type": "duplicate", "message": "A matching note exists."}], "duplicateNoteIds": ["1793435867893"]}}]}}
```

### validate_other_deck_default

```json
{"jsonrpc": "2.0", "id": 12, "result": {"items": [{"index": 0, "result": {"valid": false, "issues": [{"type": "duplicate", "message": "A matching note exists."}], "duplicateNoteIds": ["1793435867893"]}}]}}
```

### validate_deck_scope_other

```json
{"jsonrpc": "2.0", "id": 13, "result": {"items": [{"index": 0, "result": {"valid": true, "issues": [], "duplicateNoteIds": []}}]}}
```

### validate_deck_scope_same

```json
{"jsonrpc": "2.0", "id": 14, "result": {"items": [{"index": 0, "result": {"valid": false, "issues": [{"type": "duplicate", "message": "A matching note exists."}], "duplicateNoteIds": ["1793435867893"]}}]}}
```

### validate_other_type_default

```json
{"jsonrpc": "2.0", "id": 15, "result": {"items": [{"index": 0, "result": {"valid": true, "issues": [], "duplicateNoteIds": []}}]}}
```

### validate_across_types

```json
{"jsonrpc": "2.0", "id": 16, "result": {"items": [{"index": 0, "result": {"valid": false, "issues": [{"type": "duplicate", "message": "A matching note exists."}], "duplicateNoteIds": ["1793428929377", "1793428954505", "1793432258253", "1793435867893"]}}]}}
```

### invalid_scope

```json
{"jsonrpc": "2.0", "id": 17, "error": {"code": -32602, "message": "{'notes': [{'noteType': {'name': 'VOKA v1 review 1793435866978504000'}, 'deck': {'name': 'VOKA v1 review 1793435866978504000 A'}, 'fields': {'Key': 'en:achieve', 'Word': 'original', 'Keep': 'preserved'}, 'duplicates': {'scope': 'invalid'}}]} is not valid under any of the given schemas", "data": {"type": "invalidParams", "details": {"path": "/"}}}}
```

### non_atomic

```json
{"jsonrpc": "2.0", "id": 18, "result": {"items": [{"index": 0, "result": {"noteId": "1793435868491", "cardIds": ["1793435868491"]}}, {"index": 1, "error": {"code": 1002, "message": "Note cannot be created.", "data": {"type": "validationFailed", "details": {"valid": false, "issues": [{"type": "duplicate", "message": "A matching note exists."}], "duplicateNoteIds": ["1793435867893"]}}}}, {"index": 2, "result": {"noteId": "1793435868492", "cardIds": ["1793435868492"]}}]}}
```

### after_non_atomic

```json
{"jsonrpc": "2.0", "id": 20, "result": {"items": [{"index": 0, "result": {"id": "1793435867893", "noteType": {"id": "1793435867342", "name": "VOKA v1 review 1793435866978504000"}, "fields": {"Key": "en:achieve", "Word": "original", "Keep": "preserved"}, "tags": [], "cardIds": ["1793435867893"], "modifiedAt": "2026-10-31T08:37:47.000Z"}}, {"index": 1, "result": {"id": "1793435868491", "noteType": {"id": "1793435867342", "name": "VOKA v1 review 1793435866978504000"}, "fields": {"Key": "en:batch-one", "Word": "original", "Keep": "preserved"}, "tags": [], "cardIds": ["1793435868491"], "modifiedAt": "2026-10-31T08:37:48.000Z"}}, {"index": 2, "result": {"id": "1793435868492", "noteType": {"id": "1793435867342", "name": "VOKA v1 review 1793435866978504000"}, "fields": {"Key": "en:batch-two", "Word": "original", "Keep": "preserved"}, "tags": [], "cardIds": ["1793435868492"], "modifiedAt": "2026-10-31T08:37:48.000Z"}}]}}
```

### reset_batch

```json
{"jsonrpc": "2.0", "id": 22, "result": {"items": [{"index": 0, "result": {"changed": true}}, {"index": 1, "result": {"changed": true}}]}}
```

### atomic

```json
{"jsonrpc": "2.0", "id": 23, "error": {"code": 1002, "message": "Atomic batch validation failed.", "data": {"type": "validationFailed", "details": {"items": [{"index": 1, "error": {"code": 1002, "message": "Invalid note.", "data": {"type": "validationFailed", "details": {"valid": false, "issues": [{"type": "duplicate", "message": "A matching note exists."}], "duplicateNoteIds": ["1793435867893"]}}}}]}}}}
```

### after_atomic

```json
{"jsonrpc": "2.0", "id": 25, "result": {"items": [{"index": 0, "result": {"id": "1793435867893", "noteType": {"id": "1793435867342", "name": "VOKA v1 review 1793435866978504000"}, "fields": {"Key": "en:achieve", "Word": "original", "Keep": "preserved"}, "tags": [], "cardIds": ["1793435867893"], "modifiedAt": "2026-10-31T08:37:47.000Z"}}]}}
```

### before_merge

```json
{"jsonrpc": "2.0", "id": 28, "result": {"items": [{"index": 0, "result": {"id": "1793435867893", "noteType": {"id": "1793435867342", "name": "VOKA v1 review 1793435866978504000 renamed"}, "fields": {"Key": "en:achieve", "Word": "original", "Keep": "preserved"}, "tags": [], "cardIds": ["1793435867893"], "modifiedAt": "2026-10-31T08:37:47.000Z"}}]}}
```

### update_note

```json
{"jsonrpc": "2.0", "id": 29, "result": {"id": "1793435867893", "noteType": {"id": "1793435867342", "name": "VOKA v1 review 1793435866978504000 renamed"}, "fields": {"Key": "en:achieve", "Word": "changed", "Keep": "preserved"}, "tags": [], "cardIds": ["1793435867893"], "modifiedAt": "2026-10-31T08:37:50.000Z"}}
```

### after_merge

```json
{"jsonrpc": "2.0", "id": 30, "result": {"items": [{"index": 0, "result": {"id": "1793435867893", "noteType": {"id": "1793435867342", "name": "VOKA v1 review 1793435866978504000 renamed"}, "fields": {"Key": "en:achieve", "Word": "changed", "Keep": "preserved"}, "tags": [], "cardIds": ["1793435867893"], "modifiedAt": "2026-10-31T08:37:50.000Z"}}]}}
```

### navigate

```json
{"jsonrpc": "2.0", "id": 33, "result": {"operationId": "6215388d378e4cd5bca93e666b3e4d61", "method": "application.navigate", "session": "84122fd060704b9d80c39320c9b9cdc6"}}
```

### operation_0

```json
{"jsonrpc": "2.0", "id": 34, "result": {"operationId": "6215388d378e4cd5bca93e666b3e4d61", "method": "application.navigate", "session": "84122fd060704b9d80c39320c9b9cdc6", "createdAt": "2026-10-31T08:37:52.592Z", "updatedAt": "2026-10-31T08:37:52.592Z", "state": "succeeded", "cancellable": false, "progress": null, "result": {"changed": true}}}
```

## 操作句柄范围

运行时 `describe.result.schema["x-methods"]` 中 `completion="operation"` 的方法如下（只实测 application.navigate；其余为运行时契约声明，未执行）：

`profiles.switch`, `collection.sync`, `collection.checkIntegrity`, `collection.undo`, `deckPresets.update`, `deckPresets.assign`, `deckPresets.delete`, `media.store`, `packages.import`, `packages.export`, `browser.open`, `browser.select`, `editors.openNote`, `editors.openAdd`, `editors.updateDraft`, `reviewer.answer`, `application.navigate`, `application.importFile`, `advanced.reviews.import`, `api.execute`.

`operations.get` 的完成值包含 operationId、method、session、createdAt、updatedAt、state、cancellable、progress、result。本次所有测试写入的 completion 为 completed；断连时需按 Key / ID 回读，不能凭空构造 operationId。

## 清理证据

- `cleanup_search`: `{"jsonrpc": "2.0", "id": 35, "result": {"ids": ["1793435867893"], "nextCursor": null}}`
- `cleanup_notes`: `{"jsonrpc": "2.0", "id": 36, "result": {"items": [{"index": 0, "result": {"changed": true}}]}}`
- `cleanup_search`: `{"jsonrpc": "2.0", "id": 37, "result": {"ids": [], "nextCursor": null}}`
- `cleanup_notes`: `{"jsonrpc": "2.0", "id": 38, "result": {"items": []}}`
- `cleanup_decks`: `{"jsonrpc": "2.0", "id": 39, "result": {"items": [{"index": 0, "result": {"changed": true}}, {"index": 1, "result": {"changed": true}}]}}`
- `cleanup_types`: `{"jsonrpc": "2.0", "id": 40, "result": {"items": [{"index": 0, "result": {"changed": true}}, {"index": 1, "result": {"changed": true}}]}}`

结论：§8 Key 与 §9.1 固定字段设计、ADR-0001 / ADR-0003 均得到本次检查支持，无 ADR 冲突；仅修正 §6 操作句柄回查条件并记录已确认行为。
