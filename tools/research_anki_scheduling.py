#!/usr/bin/env python3
"""Probe AnkiConnect v1 scheduling on the isolated VOKA test instance only.

Run with: python3 tools/research_anki_scheduling.py
All request/response evidence is written to .cache/anki-scheduling/raw.json.
"""

import json
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


URL = "http://127.0.0.1:8766/api/v1"
OUTPUT = Path(".cache/anki-scheduling/raw.json")
DECK = "VOKA Research::Scheduling"
PRESET_PREFIX = "VOKA Research Scheduling"
NOTE_TYPE_PREFIX = "VOKA Research Vocabulary"
FIELDS = [
    "Key",
    "Word",
    "Variants",
    "Reading",
    "GlossNative",
    "GlossTarget",
    "Context1",
    "Source1",
    "Context2",
    "Source2",
    "Context3",
    "Source3",
    "ManualStatus",
    "Audio",
    "VokaMeta",
]


class ProbeError(RuntimeError):
    pass


def assert_safe_url(url):
    parsed = urlsplit(url)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.port != 8766
        or parsed.path != "/api/v1"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ProbeError(
            "Refusing to run: endpoint must be exactly "
            "http://127.0.0.1:8766/api/v1"
        )


def resolve_ref(schema, value):
    if not isinstance(value, dict) or "$ref" not in value:
        return value
    target = schema
    for part in value["$ref"].split("/")[1:]:
        target = target[part]
    return target


def now_utc():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def main():
    assert_safe_url(URL)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    stamp = str(time.time_ns())
    note_type = NOTE_TYPE_PREFIX + " " + stamp
    preset = PRESET_PREFIX + " " + stamp
    calls = []
    log = {
        "endpoint": URL,
        "startedAt": now_utc(),
        "run": {
            "requested": ["FSRS OFF", "FSRS ON"],
            "runs": [],
        },
        "calls": calls,
        "cleanup": {"status": "pending"},
    }
    methods = {}
    schema = {}
    current_run = "setup"
    resources = {
        "deck": False,
        "noteType": False,
        "preset": False,
    }
    original_scheduler = None
    suite_error = None
    cleanup_errors = []
    cleanup_ok = False

    def save():
        OUTPUT.write_text(
            json.dumps(log, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def check_params(method, params):
        meta = methods.get(method)
        if meta is None:
            raise ProbeError("api.describe does not list method: " + method)
        params_schema = resolve_ref(schema, meta["params"])
        properties = params_schema.get("properties", {})
        missing = [name for name in params_schema.get("required", []) if name not in params]
        extra = [name for name in params if name not in properties]
        if missing or extra:
            raise ProbeError(
                "Parameters do not match api.describe for "
                + method
                + ": missing="
                + repr(missing)
                + " extra="
                + repr(extra)
            )

    def rpc(label, method, params, allow_error=False, skip_schema=False):
        if not skip_schema:
            check_params(method, params)
        request_body = {
            "jsonrpc": "2.0",
            "id": len(calls) + 1,
            "method": method,
            "params": params,
        }
        entry = {
            "run": current_run,
            "label": label,
            "request": request_body,
        }
        request = Request(
            URL,
            json.dumps(request_body).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=30) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            entry["httpStatus"] = error.code
        except (URLError, TimeoutError, OSError) as error:
            entry["transportError"] = str(error)
            calls.append(entry)
            save()
            if allow_error:
                return {"error": {"transportError": str(error)}}
            raise ProbeError("Transport error for " + method + ": " + str(error))

        entry["rawResponse"] = raw
        try:
            body = json.loads(raw)
        except json.JSONDecodeError as error:
            entry["parseError"] = str(error)
            calls.append(entry)
            save()
            if allow_error:
                return {"error": {"parseError": str(error)}}
            raise ProbeError("Non-JSON response for " + method + ": " + str(error))

        entry["response"] = body
        calls.append(entry)
        save()
        if "error" in body and not allow_error:
            raise ProbeError(method + " returned JSON-RPC error: " + json.dumps(body["error"]))
        return body

    def result(body):
        if "error" in body:
            return None
        return body.get("result")

    def require_result(body, label):
        value = result(body)
        if value is None:
            raise ProbeError(label + " did not return a result")
        return value

    def operation_result(label, method, params):
        body = rpc(label, method, params)
        handle = require_result(body, label)
        operation_id = handle.get("operationId")
        if not operation_id:
            raise ProbeError(label + " returned no operationId")
        for index in range(100):
            status = rpc(
                label + ".poll." + str(index),
                "operations.get",
                {"operationId": operation_id},
            )
            operation = require_result(status, label + " poll")
            if operation.get("state") == "succeeded":
                return operation.get("result")
            if operation.get("state") in ("failed", "cancelled"):
                raise ProbeError(
                    label + " operation ended in "
                    + str(operation.get("state"))
                    + ": "
                    + json.dumps(operation.get("error"))
                )
            time.sleep(0.1)
        raise ProbeError(label + " operation did not finish within 10 seconds")

    def schedule_state(card_id, label):
        return require_result(
            rpc(label, "scheduling.get", {"cardId": str(card_id)}), label
        )

    def eligibility(card_id, label):
        return require_result(
            rpc(label, "scheduling.getDue", {"cardId": str(card_id)}), label
        )

    def predict(card_id, label, allow_error=False):
        return rpc(
            label,
            "scheduling.predict",
            {"cardId": str(card_id)},
            allow_error=allow_error,
        )

    def answer(card_id, rating, label, state_token=None, allow_error=False):
        if state_token is None:
            prediction_body = predict(card_id, label + ".predict", allow_error=allow_error)
            prediction = result(prediction_body)
            if prediction is None:
                return prediction_body
            state_token = prediction["stateToken"]
        return rpc(
            label,
            "scheduling.answer",
            {
                "cardId": str(card_id),
                "rating": rating,
                "stateToken": state_token,
                "elapsedMs": 250,
            },
            allow_error=allow_error,
        )

    def wait_until_due_now(card_id, label):
        last = None
        for index in range(40):
            last = eligibility(card_id, label + "." + str(index))
            if last.get("dueNow"):
                return last
            time.sleep(0.25)
        return last

    def graduate_new_to_review(card_id, label):
        prediction = require_result(
            predict(card_id, label + ".predict"), label + " prediction"
        )
        ratings = [item.get("rating") for item in prediction.get("answers", [])]
        if "easy" not in ratings:
            raise ProbeError(label + " prediction did not offer Easy: " + repr(ratings))
        body = rpc(
            label + ".answer",
            "scheduling.answer",
            {
                "cardId": str(card_id),
                "rating": "easy",
                "stateToken": prediction["stateToken"],
                "elapsedMs": 250,
            },
        )
        state = require_result(body, label + " answer").get("scheduling", {})
        if state.get("type") != "review":
            raise ProbeError(label + " did not graduate to Review: " + repr(state))

    def search_cards(label, query):
        body = rpc(label, "cards.search", {"query": query, "limit": 100})
        return require_result(body, label)

    # First call is the documented discovery endpoint; it supplies every later schema.
    description = rpc("describe", "api.describe", {}, skip_schema=True)
    description_result = require_result(description, "api.describe")
    schema = description_result["schema"]
    methods = schema.get("x-methods", {})

    required_methods = [
        "collection.get",
        "decks.list",
        "decks.create",
        "decks.delete",
        "decks.getCounts",
        "deckPresets.list",
        "deckPresets.create",
        "deckPresets.get",
        "deckPresets.update",
        "deckPresets.assign",
        "deckPresets.delete",
        "noteTypes.list",
        "noteTypes.create",
        "noteTypes.deleteUnused",
        "notes.createMany",
        "notes.search",
        "notes.delete",
        "cards.search",
        "cards.getMany",
        "cards.render",
        "cards.setSuspended",
        "scheduling.getDue",
        "scheduling.get",
        "scheduling.answer",
        "scheduling.answerMany",
        "scheduling.predict",
        "scheduling.setDueDate",
        "reviews.list",
        "reviews.getLatestId",
        "operations.get",
    ]
    missing_methods = [name for name in required_methods if name not in methods]
    if missing_methods:
        raise ProbeError("Required methods absent from api.describe: " + repr(missing_methods))

    try:
        current_run = "setup"
        collection = require_result(rpc("collection.before", "collection.get", {}), "collection.get")
        original_scheduler = collection["scheduler"]
        mode = "FSRS ON" if original_scheduler == "fsrs" else "FSRS OFF"
        log["run"]["runs"].append(
            {
                "mode": mode,
                "scheduler": original_scheduler,
                "startedAt": now_utc(),
            }
        )
        setter_candidates = [
            name
            for name in (
                "collection.setScheduler",
                "collection.update",
                "collection.setConfig",
                "scheduler.set",
            )
            if name in methods
        ]
        preset_fields = set(
            resolve_ref(schema, {"$ref": "#/$defs/PresetSettings"})
            .get("properties", {})
        )
        log["run"]["fsrsControl"] = {
            "originalScheduler": original_scheduler,
            "setterMethodsDescribed": setter_candidates,
            "presetHasFsrsEnableFlag": "fsrs" in preset_fields,
            "fsrsOnRun": (
                "not answered: api.describe exposes collection.get as read-only and "
                "does not describe a scheduler setter; PresetSettings has no fsrs enable flag"
            ),
        }

        decks = require_result(rpc("decks.before", "decks.list", {}), "decks.list")
        if any(deck.get("name") == DECK for deck in decks):
            raise ProbeError(
                "Refusing to reuse pre-existing reserved deck "
                + DECK
                + "; inspect it before re-running."
            )

        created_deck = require_result(
            rpc("deck.create", "decks.create", {"name": DECK}), "decks.create"
        )
        resources["deck"] = created_deck.get("name") == DECK
        if not resources["deck"]:
            raise ProbeError("decks.create did not create the requested research deck")

        existing_presets = require_result(
            rpc("presets.before", "deckPresets.list", {}), "deckPresets.list"
        )
        if not any(item.get("name") == "Default" for item in existing_presets):
            raise ProbeError("No Default deck preset is available to clone")
        created_preset = require_result(
            rpc(
                "preset.create",
                "deckPresets.create",
                {"name": preset, "cloneFrom": {"name": "Default"}},
            ),
            "deckPresets.create",
        )
        resources["preset"] = created_preset.get("name") == preset
        if not resources["preset"]:
            raise ProbeError("deckPresets.create did not create the research preset")
        preset_ref = {"id": created_preset["id"]}

        preset_settings = {
            "newPerDay": 2,
            "learnStepsMinutes": [0.01],
            "relearnStepsMinutes": [0.01],
        }
        operation_result(
            "preset.update",
            "deckPresets.update",
            {"preset": preset_ref, "settings": preset_settings},
        )
        operation_result(
            "preset.assign",
            "deckPresets.assign",
            {
                "decks": [{"name": DECK}],
                "preset": preset_ref,
                "rescheduleFsrs": False,
            },
        )
        require_result(
            rpc("preset.after", "deckPresets.get", {"preset": preset_ref}),
            "deckPresets.get",
        )

        fields = [{"name": name} for name in FIELDS]
        note_type_result = require_result(
            rpc(
                "noteType.create",
                "noteTypes.create",
                {
                    "name": note_type,
                    "kind": "normal",
                    "fields": fields,
                    "templates": [
                        {
                            "name": "Vocabulary",
                            "questionHtml": (
                                '<div class="word">{{Word}}</div>'
                                '<div class="context">{{Context1}}</div>'
                            ),
                            "answerHtml": (
                                "{{FrontSide}}<hr id=answer>"
                                '<div class="gloss-native">{{GlossNative}}</div>'
                                '<div class="gloss-target">{{GlossTarget}}</div>'
                            ),
                        }
                    ],
                    "css": ".card { font-family: Arial; font-size: 20px; }",
                    "sortField": "Word",
                },
            ),
            "noteTypes.create",
        )
        resources["noteType"] = note_type_result.get("name") == note_type
        if not resources["noteType"]:
            raise ProbeError("noteTypes.create did not create the research note type")

        labels = [
            "learning_new",
            "relearning_seed",
            "rating_again_today",
            "rating_hard_today",
            "rating_good_today",
            "rating_easy_today",
            "review_not_due_10_days",
            "suspended_new",
            "concurrency_review_today",
            "new_limit_1",
            "new_limit_2",
            "new_limit_3",
        ]
        note_inputs = []
        for index, label in enumerate(labels, start=1):
            values = {name: "" for name in FIELDS}
            values.update(
                {
                    "Key": "en:research-scheduling-" + stamp + "-" + str(index),
                    "Word": "research-" + str(index).zfill(2),
                    "GlossNative": "synthetic native gloss " + str(index),
                    "GlossTarget": "synthetic target gloss " + str(index),
                    "Context1": "Synthetic research context " + str(index) + ".",
                    "Source1": "VOKA research probe",
                }
            )
            note_inputs.append(
                {
                    "noteType": {"name": note_type},
                    "deck": {"name": DECK},
                    "fields": values,
                    "tags": ["voka-research-scheduling"],
                }
            )
        created_notes = require_result(
            rpc(
                "notes.createMany",
                "notes.createMany",
                {"notes": note_inputs, "atomic": True},
            ),
            "notes.createMany",
        )
        items = created_notes.get("items", [])
        if len(items) != len(labels) or any("error" in item for item in items):
            raise ProbeError("notes.createMany did not create all 12 research notes")
        card_ids = {
            label: str(item["result"]["cardIds"][0])
            for label, item in zip(labels, items)
        }

        current_run = "experiment." + mode.lower().replace(" ", "_")
        run_record = log["run"]["runs"][0]
        run_record["cardRoles"] = card_ids

        # Capture the untouched New-card view before setup answers consume the
        # daily quota. getDue.available is deliberately distinct from counts:
        # the schema states it ignores daily deck limits.
        initial_new_search = search_cards(
            "q1.cards.search.new.beforeScheduling",
            'deck:"' + DECK + '" is:new',
        )
        initial_due = {}
        for label, card_id in card_ids.items():
            initial_due[label] = eligibility(
                card_id, "q1.scheduling.getDue.new.beforeScheduling." + label
            )
        run_record["dailyNewLimitBeforeScheduling"] = {
            "deckCounts": result(
                rpc(
                    "q1.decks.getCounts.beforeScheduling",
                    "decks.getCounts",
                    {"deck": {"name": DECK}, "includeChildren": False},
                )
            ),
            "cardsSearchIsNew": initial_new_search,
            "getDue": initial_due,
        }

        # Build true scheduler states using only the research deck and preset.
        learning_prediction = require_result(
            predict(card_ids["learning_new"], "setup.learning.predict"),
            "learning new prediction",
        )
        answer(
            card_ids["learning_new"],
            "again",
            "setup.learning.answer",
            learning_prediction["stateToken"],
        )
        wait_until_due_now(card_ids["learning_new"], "setup.learning.due")

        graduate_new_to_review(card_ids["relearning_seed"], "setup.relearning.graduate")
        relearning_prediction = require_result(
            predict(card_ids["relearning_seed"], "setup.relearning.predict"),
            "relearning review prediction",
        )
        answer(
            card_ids["relearning_seed"],
            "again",
            "setup.relearning.answer",
            relearning_prediction["stateToken"],
        )
        wait_until_due_now(card_ids["relearning_seed"], "setup.relearning.due")

        review_cards = {
            "again": card_ids["rating_again_today"],
            "hard": card_ids["rating_hard_today"],
            "good": card_ids["rating_good_today"],
            "easy": card_ids["rating_easy_today"],
            "notDue": card_ids["review_not_due_10_days"],
            "concurrency": card_ids["concurrency_review_today"],
        }
        for label, card_id in review_cards.items():
            graduate_new_to_review(card_id, "setup.review." + label + ".graduate")
        overdue_attempt = rpc(
            "setup.review.overdue.setDueDate",
            "scheduling.setDueDate",
            {"cardIds": [review_cards["again"]], "days": "-1"},
            allow_error=True,
        )
        run_record["reviewOverdueSetupAttempt"] = overdue_attempt
        for rating, days in (("again", "0"), ("hard", "0"), ("good", "0"), ("easy", "0")):
            card_id = review_cards[rating]
            rpc(
                "setup.review." + rating + ".setDueDate",
                "scheduling.setDueDate",
                {"cardIds": [card_id], "days": days},
            )
        rpc(
            "setup.review.notDue.setDueDate",
            "scheduling.setDueDate",
            {"cardIds": [review_cards["notDue"]], "days": "10"},
        )
        rpc(
            "setup.review.concurrency.setDueDate",
            "scheduling.setDueDate",
            {"cardIds": [review_cards["concurrency"]], "days": "0"},
        )

        suspended_id = card_ids["suspended_new"]
        rpc(
            "setup.suspended",
            "cards.setSuspended",
            {"ids": [suspended_id], "suspended": True},
        )

        # Question 1: native search and per-card eligibility, before rating cards.
        search_queries = {
            "researchDeck": 'deck:"' + DECK + '"',
            "researchNoteType": 'deck:"' + DECK + '" note:"' + note_type + '"',
            "vokaNoteTypeDue": (
                'deck:"' + DECK + '" note:"' + note_type + '" is:due'
            ),
            "isDue": 'deck:"' + DECK + '" is:due',
            "isNew": 'deck:"' + DECK + '" is:new',
            "isLearning": 'deck:"' + DECK + '" is:learn',
            "isReview": 'deck:"' + DECK + '" is:review',
            "isSuspended": 'deck:"' + DECK + '" is:suspended',
        }
        run_record["searches"] = {}
        for name, query in search_queries.items():
            body = rpc(
                "q1.cards.search." + name,
                "cards.search",
                {"query": query, "limit": 100},
                allow_error=True,
            )
            run_record["searches"][name] = result(body) if "error" not in body else body
        run_record["deckCounts"] = result(
            rpc(
                "q1.decks.getCounts",
                "decks.getCounts",
                {"deck": {"name": DECK}, "includeChildren": False},
            )
        )
        due_roles = {
            "learning": card_ids["learning_new"],
            "relearning": card_ids["relearning_seed"],
            "reviewTodayAgain": review_cards["again"],
            "reviewTodayHard": review_cards["hard"],
            "reviewTodayGood": review_cards["good"],
            "reviewTodayEasy": review_cards["easy"],
            "reviewNotDue": review_cards["notDue"],
            "suspended": suspended_id,
            "concurrencyReviewToday": review_cards["concurrency"],
            "newLimit1": card_ids["new_limit_1"],
            "newLimit2": card_ids["new_limit_2"],
            "newLimit3": card_ids["new_limit_3"],
        }
        run_record["dueEligibility"] = {}
        for role, card_id in due_roles.items():
            run_record["dueEligibility"][role] = eligibility(
                card_id, "q1.scheduling.getDue." + role
            )

        # Question 2: state fields from both cards.getMany and scheduling.get.
        cards_body = rpc(
            "q2.cards.getMany",
            "cards.getMany",
            {"ids": [str(value) for value in card_ids.values()]},
        )
        run_record["cardsGetMany"] = result(cards_body)
        state_roles = {
            "learning": card_ids["learning_new"],
            "relearning": card_ids["relearning_seed"],
            "reviewToday": review_cards["hard"],
            "reviewOverdue": review_cards["again"],
            "reviewNotDue": review_cards["notDue"],
            "suspended": suspended_id,
            "new": card_ids["new_limit_1"],
        }
        run_record["schedulingGet"] = {
            role: schedule_state(card_id, "q2.scheduling.get." + role)
            for role, card_id in state_roles.items()
        }

        # Question 4: scheduler button/interval predictions, including Learning.
        run_record["predictions"] = {
            "learning": result(
                predict(card_ids["learning_new"], "q4.predict.learning")
            )
        }
        for rating, card_id in (
            ("again", review_cards["again"]),
            ("hard", review_cards["hard"]),
            ("good", review_cards["good"]),
            ("easy", review_cards["easy"]),
        ):
            run_record["predictions"][rating] = result(
                predict(card_id, "q4.predict." + rating)
            )

        # Question 6: render a synthetic VOKA-style card.
        run_record["render"] = result(
            rpc(
                "q6.cards.render",
                "cards.render",
                {"id": review_cards["hard"]},
            )
        )

        # Question 5: record the latest review ID before/after a real answer.
        before_review = require_result(
            rpc(
                "q5.reviews.getLatestId.before",
                "reviews.getLatestId",
                {"cardIds": [review_cards["again"]]},
            ),
            "reviews.getLatestId before",
        )
        run_record["reviewsBeforeAgain"] = before_review

        # Question 3: individual ratings and answerMany use fresh prediction tokens.
        again_prediction = require_result(
            predict(review_cards["again"], "q3.answer.again.predict"),
            "Again prediction",
        )
        run_record["answerAgain"] = rpc(
            "q3.answer.again",
            "scheduling.answer",
            {
                "cardId": review_cards["again"],
                "rating": "again",
                "stateToken": again_prediction["stateToken"],
                "elapsedMs": 250,
            },
        )

        after_review = require_result(
            rpc(
                "q5.reviews.getLatestId.after",
                "reviews.getLatestId",
                {"cardIds": [review_cards["again"]]},
            ),
            "reviews.getLatestId after",
        )
        run_record["reviewsAfterAgain"] = after_review
        previous_id = before_review.get("id")
        reviews_params = {"cardIds": [review_cards["again"]], "limit": 20}
        if previous_id is not None:
            reviews_params["afterId"] = previous_id
        run_record["reviewsListAfterAgain"] = result(
            rpc("q5.reviews.list", "reviews.list", reviews_params)
        )

        hard_prediction = require_result(
            predict(review_cards["hard"], "q3.answer.hard.predict"),
            "Hard prediction",
        )
        run_record["answerHard"] = rpc(
            "q3.answer.hard",
            "scheduling.answer",
            {
                "cardId": review_cards["hard"],
                "rating": "hard",
                "stateToken": hard_prediction["stateToken"],
                "elapsedMs": 250,
            },
        )

        good_prediction = require_result(
            predict(review_cards["good"], "q3.answerMany.good.predict"),
            "Good prediction",
        )
        easy_prediction = require_result(
            predict(review_cards["easy"], "q3.answerMany.easy.predict"),
            "Easy prediction",
        )
        run_record["answerMany"] = rpc(
            "q3.answerMany.good_easy",
            "scheduling.answerMany",
            {
                "answers": [
                    {
                        "cardId": review_cards["good"],
                        "rating": "good",
                        "stateToken": good_prediction["stateToken"],
                        "elapsedMs": 250,
                    },
                    {
                        "cardId": review_cards["easy"],
                        "rating": "easy",
                        "stateToken": easy_prediction["stateToken"],
                        "elapsedMs": 250,
                    },
                ]
            },
            allow_error=True,
        )

        # Test early Review, New, and suspended behavior with real state tokens.
        not_due_prediction = predict(
            review_cards["notDue"], "q3.notDue.predict", allow_error=True
        )
        if result(not_due_prediction) is not None:
            run_record["answerNotDue"] = answer(
                review_cards["notDue"],
                "good",
                "q3.notDue.answer",
                result(not_due_prediction)["stateToken"],
                allow_error=True,
            )
        else:
            run_record["answerNotDue"] = not_due_prediction

        new_id = card_ids["new_limit_1"]
        new_prediction = predict(new_id, "q3.new.predict", allow_error=True)
        if result(new_prediction) is not None:
            run_record["answerNew"] = answer(
                new_id,
                "good",
                "q3.new.answer",
                result(new_prediction)["stateToken"],
                allow_error=True,
            )
        else:
            run_record["answerNew"] = new_prediction

        suspended_prediction = predict(
            suspended_id, "q3.suspended.predict", allow_error=True
        )
        if result(suspended_prediction) is not None:
            run_record["answerSuspended"] = answer(
                suspended_id,
                "good",
                "q3.suspended.answer",
                result(suspended_prediction)["stateToken"],
                allow_error=True,
            )
        else:
            run_record["answerSuspended"] = suspended_prediction

        # Question 7: an answered card invalidates the stale page's state token.
        concurrency_prediction = require_result(
            predict(review_cards["concurrency"], "q7.predict.stale_page"),
            "concurrency prediction",
        )
        run_record["concurrencyFirstAnswer"] = rpc(
            "q7.answer.once",
            "scheduling.answer",
            {
                "cardId": review_cards["concurrency"],
                "rating": "good",
                "stateToken": concurrency_prediction["stateToken"],
                "elapsedMs": 250,
            },
        )
        run_record["concurrencyStaleRetry"] = rpc(
            "q7.answer.stale_retry",
            "scheduling.answer",
            {
                "cardId": review_cards["concurrency"],
                "rating": "good",
                "stateToken": concurrency_prediction["stateToken"],
                "elapsedMs": 250,
            },
            allow_error=True,
        )

        run_record["finishedAt"] = now_utc()
    except Exception as error:
        suite_error = error
        log["failure"] = str(error)
    finally:
        current_run = "cleanup"

        def cleanup_call(label, method, params):
            try:
                return rpc(label, method, params, allow_error=True)
            except Exception as error:
                cleanup_errors.append(label + ": " + str(error))
                return {"error": {"message": str(error)}}

        if resources["noteType"]:
            try:
                found = cleanup_call(
                    "cleanup.notes.search.before",
                    "notes.search",
                    {"query": '"note:' + note_type + '"', "limit": 1000},
                )
                found_result = result(found)
                note_ids = found_result.get("ids", []) if found_result else []
                if note_ids:
                    cleanup_call(
                        "cleanup.notes.delete",
                        "notes.delete",
                        {"ids": note_ids},
                    )
            except Exception as error:
                cleanup_errors.append("notes cleanup: " + str(error))

        if resources["deck"]:
            cleanup_call(
                "cleanup.deck.delete",
                "decks.delete",
                {"decks": [{"name": DECK}], "deleteCards": True},
            )

        if resources["preset"]:
            try:
                operation_result(
                    "cleanup.preset.delete",
                    "deckPresets.delete",
                    {"preset": {"name": preset}},
                )
            except Exception as error:
                cleanup_errors.append("preset cleanup: " + str(error))

        if resources["noteType"]:
            cleanup_call(
                "cleanup.noteType.deleteUnused",
                "noteTypes.deleteUnused",
                {"noteTypes": [{"name": note_type}]},
            )

        # A final search across notes, cards, decks, presets and note types is
        # the only condition for printing CLEANUP OK.
        try:
            note_search = cleanup_call(
                "cleanup.final.notes.search",
                "notes.search",
                {"query": '"note:' + note_type + '"', "limit": 1000},
            )
            card_search = cleanup_call(
                "cleanup.final.cards.search",
                "cards.search",
                {"query": 'deck:"' + DECK + '"', "limit": 1000},
            )
            final_decks = cleanup_call("cleanup.final.decks.list", "decks.list", {})
            final_presets = cleanup_call(
                "cleanup.final.presets.list", "deckPresets.list", {}
            )
            final_types = cleanup_call(
                "cleanup.final.noteTypes.list", "noteTypes.list", {}
            )
            after_collection = cleanup_call(
                "cleanup.collection.after", "collection.get", {}
            )
            note_result = result(note_search)
            card_result = result(card_search)
            deck_result = result(final_decks)
            preset_result = result(final_presets)
            type_result = result(final_types)
            collection_result = result(after_collection)
            cleanup_ok = (
                note_result is not None
                and card_result is not None
                and deck_result is not None
                and preset_result is not None
                and type_result is not None
                and collection_result is not None
                and not note_result.get("ids")
                and not card_result.get("ids")
                and not any(item.get("name") == DECK for item in deck_result)
                and not any(item.get("name") == preset for item in preset_result)
                and not any(item.get("name") == note_type for item in type_result)
                and collection_result.get("scheduler") == original_scheduler
                and not cleanup_errors
            )
            log["cleanup"] = {
                "status": "ok" if cleanup_ok else "failed",
                "notesRemaining": note_result.get("ids") if note_result else None,
                "cardsRemaining": card_result.get("ids") if card_result else None,
                "deckRemaining": (
                    [item for item in deck_result if item.get("name") == DECK]
                    if deck_result
                    else None
                ),
                "presetRemaining": (
                    [item for item in preset_result if item.get("name") == preset]
                    if preset_result
                    else None
                ),
                "noteTypeRemaining": (
                    [item for item in type_result if item.get("name") == note_type]
                    if type_result
                    else None
                ),
                "schedulerBefore": original_scheduler,
                "schedulerAfter": (
                    collection_result.get("scheduler") if collection_result else None
                ),
                "errors": cleanup_errors,
            }
        except Exception as error:
            cleanup_errors.append("final cleanup verification: " + str(error))
            log["cleanup"] = {"status": "failed", "errors": cleanup_errors}
        finally:
            log["finishedAt"] = now_utc()
            save()

    if cleanup_ok:
        print("CLEANUP OK")
    else:
        print("CLEANUP FAILED: see " + str(OUTPUT), file=sys.stderr)
    if suite_error is not None:
        print("PROBE FAILED: " + str(suite_error), file=sys.stderr)
        return 1
    if not cleanup_ok:
        return 2
    print("Raw request/response evidence:", OUTPUT)
    print(
        "Measured scheduler:",
        original_scheduler,
        "(FSRS ON pass is not available through the described v1 methods.)",
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProbeError as error:
        print("PROBE FAILED: " + str(error), file=sys.stderr)
        raise SystemExit(1)
