# AnkiConnect v1 scheduling probe (#71)

Measured on 2026-11-01 against Anki 26.09.3 and the isolated v1 endpoint **http://127.0.0.1:8766/api/v1**. The probe created 12 synthetic notes in **VOKA Research::Scheduling**, using an ephemeral VOKA Research note type and its own preset. The preset's new-card limit was 2 and its learning/relearning step was 0.01 minutes.

The complete request and response log is generated at **.cache/anki-scheduling/raw.json**. The script used **api.describe** to read method schemas before each subsequent call. It did not call **collection.sync**.

The collection started with **scheduler: "sm2"** (FSRS off) and still reported **sm2** after the run. The described API has no collection scheduler setter, and **PresetSettings** has no FSRS enable flag, so the FSRS-on run was **not answered**. No collection-wide scheduler setting was changed.

## 1. Find today's due cards

**Methods and parameters.**

- **cards.search({query, limit: 100})** with **deck:"VOKA Research::Scheduling" note:"VOKA Research Vocabulary <run suffix>" is:due**, plus **is:new**, **is:learn**, **is:review**, and **is:suspended** variants.
- **scheduling.getDue({cardId})** for each test card.
- **decks.getCounts({deck:{name:"VOKA Research::Scheduling"}, includeChildren:false})** for the native new-card quota count.
- Test setup used **scheduling.setDueDate({cardIds:[id], days:"0"|"10"})**.

**Sample.** The note-type due query returned 7 IDs; the new-card snapshot was 12 cards total with **new: 2**. A New card's eligibility was:

~~~json
{"cardId":"<new-card>","dueNow":false,"available":true,"learnAhead":false}
~~~

After state setup, **is:due** returned 7 cards: 1 Learning, 1 Relearning, and 5 Review due today. **is:learn** returned 2 and **is:suspended** returned 1. The **is:new** search returned all 12 before setup answers; the native count exposed only 2 new cards for the day. **getDue.available** was true for the New cards even beyond that quota.

**days:"10"** created a Review card due ten scheduler days later (**due.kind:"day"**, **dueNow:false**). Overdue setup with **days:"-1"** was **not answered**: **scheduling.setDueDate** returned an item error with code **-32603**, message **Internal API error.**, and type **internalError**. The script then set that card due today with the verified **days:"0"** form.

**Conclusion.** **cards.search** can filter by deck, note type, and queue state, but returns IDs only. **scheduling.getDue** is a per-card eligibility check. New cards have no timed due obligation: **dueNow** is false while **available** can be true. **decks.getCounts** reflects the daily new-card cap; **cards.search is:new** and **scheduling.getDue.available** do not.

**Recommendation for P1.** Search **note:"VOKA Vocabulary · English" is:due**, then retain only cards whose **scheduling.getDue.dueNow** is true. Treat New separately; do not use **available** as the due predicate. The overdue-specific setup was not verified.

## 2. Read a card's scheduling state

**Methods and parameters.**

- **scheduling.get({cardId})**
- **cards.getMany({ids:[...]})**
- **scheduling.getDue({cardId})** to read current eligibility separately.

**Sample.**

~~~json
{
  "type":"learning",
  "queue":"learning",
  "due":{"kind":"timestamp","at":"2026-11-01T08:26:00.000Z"},
  "intervalDays":0,
  "learningIntervalSeconds":0,
  "remainingSteps":1,
  "repetitions":1,
  "lapses":0
}
~~~

**cards.getMany** returns card identity/deck fields and nests the same scheduling state. Across the prepared states, New used **due.kind:"position"**, Learning/Relearning used **"timestamp"**, and Review used **"day"**. **scheduling.getDue** returned **dueNow:true** for due Learning, Relearning, and Review cards; it returned false for a Review card ten days out and for a suspended card.

**Conclusion.** The state object includes **type**, **queue**, **due**, **intervalDays**, **learningIntervalSeconds**, **remainingSteps**, **repetitions**, **lapses**, **sm2EasePermille**, **fsrsMemory**, and **desiredRetention**. It has no **isDue** field. In this run, the separate eligibility result matched the distinction needed for due-now versus New, suspended, and future Review cards.

**Recommendation for P1.** Use **scheduling.get** or **cards.getMany** for display state, then use **scheduling.getDue.dueNow** for the submit gate. Do not infer gradability from **type**, **queue**, or **available** alone.

## 3. Submit ratings

**Methods and parameters.**

- **scheduling.predict({cardId})** first, then **scheduling.answer({cardId, rating, stateToken, elapsedMs})**.
- Ratings are strings, not numbers: ease 1 = **again**, 2 = **hard**, 3 = **good**, 4 = **easy**.
- **scheduling.answerMany({answers:[{cardId, rating, stateToken, elapsedMs}, ...]})**.

**Sample.**

~~~json
{
  "request":{"cardId":"<review-card>","rating":"hard","stateToken":"<fresh-token>","elapsedMs":250},
  "response":{"cardId":"<review-card>","reviewId":"<review-id>","scheduling":{"type":"review","queue":"review","intervalDays":7,"sm2EasePermille":2350}}
}
~~~

**answerMany** returned an **items** array in input order with one result per card. In the measured SM-2 run, Again moved Review to Relearning; Hard remained Review and lowered ease to 2350; Good remained Review at ease 2500; Easy remained Review and raised ease to 2650. The returned intervals depended on each card's starting state.

A Review card due ten days later was accepted early when given a fresh prediction token. A New card was also accepted and graduated to Review, even after the research deck's available-new count had reached zero. A suspended card's **scheduling.predict** returned a token, but **scheduling.answer** rejected it with code **1009**, type **invalidState**, message **This card cannot be answered outside the reviewer.** A second answer using the token from the first accepted answer failed with code **1008**, type **conflict**, message **Prediction/conversion token is stale.**

**Conclusion.** The API does not enforce the P1 due-only policy for New or not-due Review cards; those answers succeeded. Suspended cards are rejected. The prediction token is required and a consumed token cannot be reused.

**Recommendation for P1.** Only submit after a fresh due-now check and prediction. Send the rating string with that token, lock the card while the request is in flight, and never retry a stale token. Exclude New and not-due cards in the client even though the API accepts them.

## 4. Predict intervals

**Methods and parameters.**

- **scheduling.predict({cardId})**
- Read **source**, **stateToken**, and each **answers[]** item's **rating**, **label**, and nullable **interval**.

**Sample.** The Learning card returned four answer options under SM-2:

~~~json
{
  "source":"scheduler",
  "answers":[
    {"rating":"again","label":"(end)","interval":{"value":0,"unit":"seconds"}},
    {"rating":"hard","label":"(end)","interval":{"value":0,"unit":"seconds"}},
    {"rating":"good","label":"1d","interval":{"value":1,"unit":"days"}},
    {"rating":"easy","label":"5d","interval":{"value":5,"unit":"days"}}
  ]
}
~~~

All prepared Review cards also returned four predictions. The actual intervals differed by card state. No **interval:null** prediction occurred; the schema permits null.

**Conclusion.** Predictions are scheduler-produced, card-specific, and include a state token for the subsequent answer. SM-2 was the only measured scheduler. FSRS-on behavior was not answered because **api.describe** exposes **collection.get** as read-only and has no scheduler setter; the research preset schema also has no enable flag.

**Recommendation for P1.** Render the rating options returned by **scheduling.predict** and show its label/interval when non-null. Do not calculate intervals locally or assume a fixed button count across scheduler states. FSRS-on button count and predictions remain unverified.

## 5. Read back a submitted review

**Methods and parameters.**

- **reviews.getLatestId({cardIds:[cardId]})** before and after an answer.
- **reviews.list({cardIds:[cardId], afterId:previousId, limit:20})**.

**Sample.** For the Again answer, the per-card latest ID advanced from **1793521558226** to **1793521560425**. The list call with the prior ID returned one record:

~~~json
{
  "items":[{
    "id":"1793521560425",
    "cardId":"<review-card>",
    "rating":"again",
    "interval":{"value":0,"unit":"days"},
    "previousInterval":{"value":4,"unit":"days"},
    "elapsedMs":250,
    "kind":"review"
  }],
  "nextCursor":null
}
~~~

**Conclusion.** Both methods can read back a just-written review for a selected card. **afterId** is exclusive, and **reviews.list** includes the rating, card ID, timestamp, interval, and review kind.

**Recommendation for P1.** Before submit, retain the card's latest review ID. If the response is uncertain, query **reviews.getLatestId** and **reviews.list** for that card after the saved ID, then read **scheduling.get**; do not resend the rating while the first result is uncertain.

## 6. Render front and back

**Methods and parameters.**

- **cards.render({id:cardId})**

**Sample.** The copy-like research note type rendered the question as the word and context; the answer added both gloss fields:

~~~json
{
  "questionHtml":"...<div class=\"word\">research-04</div><div class=\"context\">Synthetic research context 4.</div>",
  "answerHtml":"...<div class=\"word\">research-04</div><div class=\"context\">Synthetic research context 4.</div><hr id=answer><div class=\"gloss-native\">synthetic native gloss 4</div><div class=\"gloss-target\">synthetic target gloss 4</div>"
}
~~~

**Conclusion.** **cards.render** returns **questionHtml**, **answerHtml**, and **css**. The research template's front did not contain either answer field. This measured the VOKA-shaped research copy, not an existing production note type.

**Recommendation for P1.** Render the selected card and show only **questionHtml** before reveal; keep **answerHtml** hidden until the user requests it. Confirm the installed production template separately before relying on it.

## 7. Anki UI/API concurrency

**Methods and parameters.**

- **scheduling.predict({cardId})**
- Submit once with **scheduling.answer({cardId, rating, stateToken, elapsedMs})**, then submit again with the same token to represent the stale page.

**Sample.**

~~~json
{"request":{"cardId":"<review-card>","rating":"good","stateToken":"<used-token>","elapsedMs":250},
 "response":{"error":{"code":1008,"message":"Prediction/conversion token is stale.","data":{"type":"conflict"}}}}
~~~

The first answer succeeded and returned a **reviewId**; the stale retry was rejected. This used the requested API simulation and did not click the Anki reviewer.

**Conclusion.** A stale page cannot submit a second rating with the token it loaded before another review was accepted.

**Recommendation for P1.** On a conflict, discard the stale prediction, refresh scheduling state, and ask the user to review the refreshed card state. Do not retry the old rating automatically.

## P1 design recommendations

- **Today's due VOKA cards:** query **cards.search** with **note:"VOKA Vocabulary · English" is:due**; use the note type filter so a user moving a card between decks does not hide it. Check each candidate with **scheduling.getDue**.
- **Gradable right now:** require **dueNow:true**. **available:true** is insufficient because New cards can be available without a timed due obligation, and the method ignores the daily new-card cap.
- **Before submit:** read current state and eligibility, call **scheduling.predict** immediately before enabling the rating buttons, then submit with its **stateToken**. Lock that card until the request resolves.
- **Uncertain submit:** compare a saved **reviews.getLatestId** value with a fresh value, then use **reviews.list** filtered to the card with **afterId** set to the saved ID. Read **scheduling.get** as a second check. Keep the result uncertain if no matching review can be found; do not retry.
- **Buttons and intervals:** display the ratings and intervals in **scheduling.predict.answers**; hide an interval when it is null. The SM-2 Learning probe returned four options, but FSRS and other profiles were not measured.
- **New cards:** show as preview/extra practice only. The 2/day preset exposed **new:2** while search found 12 New cards, and direct API answering bypassed the limit.
- **Suspended cards:** exclude them; **getDue** returned **dueNow:false** and **available:false**, and **scheduling.answer** rejected the suspended card.
- **Not-due cards:** allow preview only. The API accepted an early Review answer, so the due-only rule must be enforced before submission by VOKA.

The script removed the research notes, deck, note type, and preset. Its final searches found no leftovers and confirmed the collection scheduler remained **sm2**; it printed **CLEANUP OK**.
