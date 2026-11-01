# Leveled POS gloss acceptance (#64)

Data version: en-2026.11.1. All 8495 leveled lemmas have both gloss languages; missing 0.

| Level | Lemmas | Missing bilingual gloss |
|---|---:|---:|
| A1 | 1050 | 0 |
| A2 | 1200 | 0 |
| B1 | 2085 | 0 |
| B2 | 2383 | 0 |
| C1 | 909 | 0 |
| C2 | 868 | 0 |

## Common-word before/after

| Word | Previous Chinese | Current Chinese | Previous English | Current English |
|---|---|---|---|---|
| a | n. 埃; 维生素甲 | det. 一个; 一位; 一名 | n. a metric unit of length equal to one ten billionth of a meter (or 0.0001 micron); used to specify wavelengths of electromagnetic radiation; any of several fat-soluble vitamins essential for normal vision; prevents night blindness or inflammation or dryness of the eyes | det. Used before a singular countable noun when it is not specific. |
| it | n. 信息技术 | pron. 它; 这件事 | n. the branch of engineering that deals with the use of computers and telecommunications to retrieve and store and transmit information | pron. A thing or animal already mentioned.; A situation or idea already mentioned. |
| he | n. 氦; 希伯来第五字母 | pron. 他 | n. a very light colorless element that is one of the six inert gasses; the most difficult gas to liquefy; occurs in economically extractable amounts in certain natural gases (as those found in Texas and Kansas); the 5th letter of the Hebrew alphabet | pron. A male person or animal already mentioned. |
| or | n. 手术室 | conj. 或者; 还是 | n. a room in a hospital equipped for the performance of surgical operations | conj. Used to show alternatives.; Used in questions to offer a choice. |
| as | n. 砷 · adv. 同样地 | conj. 随着; 因为; 如同 · prep. 作为; 以; 像 | n. a very poisonous metallic element that has three allotropic forms; arsenic and arsenic compounds are used as herbicides and insecticides and in various alloys; found in arsenopyrite and orpiment and realgar · adv. to the same degree (often followed by ‘as’) | conj. while something is happening; because; in the same way that · prep. in the role or form of; using a particular method; similar to |
| at | n. 砹; 阿特 | prep. 在; 于; 对着 | n. a highly unstable radioactive element (the heaviest of the halogen series); a decay product of uranium and thorium; 100 at equal 1 kip in Laos | prep. in a particular place; at a particular time or point; directed toward someone or something |
| can | n. 罐头; 一罐 · v. 装罐; 解雇 | n. 罐头; 一罐 · modal 能够; 可以; 可能 | n. airtight sealed metal container for food or drink or paint etc.; the quantity contained in a can · v. preserve in a can or tin; terminate the employment of; discharge from an office or position | modal be able to do something; be allowed to do something; be possible · n. airtight sealed metal container for food or drink or paint etc.; the quantity contained in a can |
| and |  | conj. 和; 并且; 而且 |  | conj. Used to join words, phrases, or ideas. |
| because |  | conj. 因为 |  | conj. for the reason that |
| could |  | modal 能; 可能; 可以 |  | modal past ability of can; used to say something is possible; used to make a polite request or suggestion |
| myself |  | pron. 我自己 |  | pron. Used as the object of an action done by the speaker.; Used to emphasize the speaker. |
| to |  | prep. 向; 到; 给 · inf. to 不定式标记 |  | prep. In the direction of a place or person.; At or reaching a place.; For or given to someone. · inf. to Placed before the base form of a verb to form an infinitive. |
| was |  | be 是; 在 |  | be past form of be used with I, he, she, it, or a singular noun; past form of be for a state or location |

## Generation and reuse

The original 74,441-entry pack and pilot prompt are unchanged. The source level POS union filters both languages; aliases fold to one Key and unleveled OEWN entries keep their existing behavior. The supplement stores filtered bilingual reuse plus 453 generated lemmas covering 520 missing POS pairs, generated through Codex gpt-6-luna effort max with a separate prompt and per-batch request hashes. See progress.json for actual validated/retry counts, reuse.json for every nonidentity source mapping, and spot-check.csv for 20 sampled lemmas per level (all POS rows shown; closed classes prioritized where present).

The coordinator-approved case rule suppresses POS found only on an ALL-UPPERCASE acronym (length >= 2) when it shares a Key with a lowercase source headword, retaining the raw POS and headwords in source metadata. Title-case collisions such as May/may remain merged. Every affected Key: en:it (IT=n, it=pron; n suppressed). See case-collisions.json.

Pinned Octanove errata: batter has blank POS but source note 'one who bats', mapped to n; remonstrate has POS 'vern', corrected to v. The lexical plural goods is generated separately: reusing good would incorrectly produce benefit/virtue rather than merchandise. Source packs retain independent licenses and model/prompt attribution is included in the About metadata.

## Validation

Offline coverage and exact source-POS matching passed for every leveled lemma; all supplement Chinese senses satisfy 1–10 Han characters and all bilingual groups contain 1–3 distinct senses. Semantic sampling is review evidence, not a claim of human approval of every generated meaning.

## Final checks and isolated Anki 8766

`npm run build && npm test` passed: 17 files, 137 tests. `npx tsx scripts/check-leveled-glosses.ts` passed: all 8,495 leveled lemmas covered in both languages with exact allowed POS; no missing glosses. No generation or model calls were made during finalization.

The existing gloss-upgrade Chrome harness passed against **127.0.0.1:8766 only**. The final `a` / `can` run reconstructed the production old fields from base commit a2d6dc1f1af0db7a2b1bda06b788125877bf70bb and seeded metadata version en-2026.10.1; fixture entries used the harness B1 deck. It verified preview is read-only, unedited updates default on, edited can defaults off and remains byte-for-byte unchanged when kept, then explicit replacement produces fields exactly matching the new pack and version en-2026.11.1. All collection card scheduling and unrelated fields remain unchanged; metadata pin/extra values and field hashes are preserved. Drawer, settings, import-preview notices, keep/reset and idempotent reruns passed in Chrome for Testing.

Final fixtures: `VOKA Gloss Upgrade Test 1793520129070`; note IDs 1793520129625, 1793520129626. See [result](upgrade-a-can/result.json) and the three screenshots beside it.

An earlier passing `and` / `was` run used synthetic old fields and old-version metadata, with the same keep/replace assertions and exact final-pack comparison; see [result](upgrade-and-was/result.json), fixture `VOKA Gloss Upgrade Test 1793508720430`. It is supporting UI evidence rather than a production-old-fields migration.

A later attempted production-old-fields fixture exposed a harness level mismatch (A1 input was filtered out by its B1 test deck). The fixture level was corrected and the final a/can run above passed; no product import logic changed. Large raw logs and caches remain outside git.

Not verified: full human semantic review of every generated gloss (the 20-lemma-per-level sample is provided for review); AnkiMobile/AnkiDroid; real network interruption/partial failure (unit tests cover failures); concurrent Anki edits during an in-flight write; fresh whole-level reimport and the full P0 acceptance suite for this change. Only local fixtures and the isolated test instance were used.
