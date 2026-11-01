import { describe, expect, it, vi } from "vitest";
import {
  prepareAnswer,
  renderCard,
  submitReview,
  type ReviewCall,
} from "./review";

const input = {
  cardId: "123456789",
  rating: "good" as const,
  stateToken: "state-token",
  elapsedMs: 75000,
  latestReviewId: "review-before",
};

function callsOf(call: ReturnType<typeof vi.fn>) {
  return call.mock.calls.map(([method, params]) => [method, params]);
}

function expectAtMostOneAnswer(call: ReturnType<typeof vi.fn>) {
  const count = call.mock.calls.filter(
    ([method]) => method === "scheduling.answer",
  ).length;
  expect(count).toBeLessThanOrEqual(1);
}

describe("page review scheduling", () => {
  it("renders the question and answer without requesting CSS", async () => {
    const call = vi.fn(async (method: string) => {
      expect(method).toBe("cards.render");
      return { questionHtml: "front", answerHtml: "back", css: "ignored" };
    });

    await expect(renderCard(call as ReviewCall, input.cardId)).resolves.toEqual({
      questionHtml: "front",
      answerHtml: "back",
    });
    expect(callsOf(call)).toEqual([["cards.render", { id: input.cardId }]]);
  });

  it("saves the latest review id before preparing predicted answers", async () => {
    const call = vi.fn(async (method: string) =>
      method === "reviews.getLatestId"
        ? { id: "review-before" }
        : { stateToken: "fresh-token", answers: [{ rating: "easy" }] },
    );

    await expect(prepareAnswer(call as ReviewCall, input.cardId)).resolves.toEqual({
      latestReviewId: "review-before",
      predict: { stateToken: "fresh-token", answers: [{ rating: "easy" }] },
    });
    expect(callsOf(call)).toEqual([
      ["reviews.getLatestId", { cardIds: [input.cardId] }],
      ["scheduling.predict", { cardId: input.cardId }],
    ]);
  });

  it("submits once and reads the resulting schedule", async () => {
    const scheduling = { type: "review", intervalDays: 3 };
    const call = vi.fn(async (method: string) => {
      if (method === "scheduling.getDue") return { dueNow: true };
      if (method === "scheduling.answer") return { reviewId: "after" };
      if (method === "scheduling.get") return scheduling;
      throw new Error(`Unexpected method ${method}`);
    });

    await expect(submitReview(call as ReviewCall, input)).resolves.toEqual({
      outcome: "submitted",
      scheduling,
    });
    expect(callsOf(call)).toEqual([
      ["scheduling.getDue", { cardId: input.cardId }],
      [
        "scheduling.answer",
        {
          cardId: input.cardId,
          rating: input.rating,
          stateToken: input.stateToken,
          elapsedMs: 60000,
        },
      ],
      ["scheduling.get", { cardId: input.cardId }],
    ]);
    expectAtMostOneAnswer(call);
  });

  it("does not answer a card that is no longer due", async () => {
    const call = vi.fn(async () => ({ dueNow: false, available: true }));

    await expect(submitReview(call as ReviewCall, input)).resolves.toEqual({
      outcome: "notDue",
    });
    expect(callsOf(call)).toEqual([
      ["scheduling.getDue", { cardId: input.cardId }],
    ]);
    expectAtMostOneAnswer(call);
  });

  it("returns conflict for RPC code 1008 without retrying", async () => {
    const conflict = Object.assign(new Error("stale prediction"), { code: 1008 });
    const call = vi.fn(async (method: string) => {
      if (method === "scheduling.getDue") return { dueNow: true };
      throw conflict;
    });

    await expect(submitReview(call as ReviewCall, input)).resolves.toEqual({
      outcome: "conflict",
    });
    expect(callsOf(call)).toEqual([
      ["scheduling.getDue", { cardId: input.cardId }],
      [
        "scheduling.answer",
        {
          cardId: input.cardId,
          rating: input.rating,
          stateToken: input.stateToken,
          elapsedMs: 60000,
        },
      ],
    ]);
    expectAtMostOneAnswer(call);
  });

  it("confirms an uncertain answer from one matching review record", async () => {
    const scheduling = { type: "review", intervalDays: 4 };
    const timeout = new Error("request timed out");
    const call = vi.fn(async (method: string) => {
      if (method === "scheduling.getDue") return { dueNow: true };
      if (method === "scheduling.answer") throw timeout;
      if (method === "reviews.getLatestId") return { id: "review-after" };
      if (method === "reviews.list")
        return {
          items: [{ cardId: input.cardId, rating: input.rating }],
        };
      if (method === "scheduling.get") return scheduling;
      throw new Error(`Unexpected method ${method}`);
    });

    await expect(submitReview(call as ReviewCall, input)).resolves.toEqual({
      outcome: "confirmed",
      scheduling,
    });
    expect(callsOf(call)).toEqual([
      ["scheduling.getDue", { cardId: input.cardId }],
      [
        "scheduling.answer",
        {
          cardId: input.cardId,
          rating: input.rating,
          stateToken: input.stateToken,
          elapsedMs: 60000,
        },
      ],
      ["reviews.getLatestId", { cardIds: [input.cardId] }],
      [
        "reviews.list",
        { cardIds: [input.cardId], afterId: input.latestReviewId, limit: 20 },
      ],
      ["scheduling.get", { cardId: input.cardId }],
    ]);
    expectAtMostOneAnswer(call);
  });

  it("leaves the result unknown when readback fails", async () => {
    const timeout = new Error("request timed out");
    const readFailure = new Error("Anki disconnected");
    const call = vi.fn(async (method: string) => {
      if (method === "scheduling.getDue") return { dueNow: true };
      if (method === "scheduling.answer") throw timeout;
      if (method === "reviews.getLatestId") throw readFailure;
      throw new Error(`Unexpected method ${method}`);
    });

    await expect(submitReview(call as ReviewCall, input)).resolves.toEqual({
      outcome: "unknown",
    });
    expect(callsOf(call)).toEqual([
      ["scheduling.getDue", { cardId: input.cardId }],
      [
        "scheduling.answer",
        {
          cardId: input.cardId,
          rating: input.rating,
          stateToken: input.stateToken,
          elapsedMs: 60000,
        },
      ],
      ["reviews.getLatestId", { cardIds: [input.cardId] }],
    ]);
    expectAtMostOneAnswer(call);
  });

  it("rejects unsupported ratings before making a call", async () => {
    const call = vi.fn();

    await expect(
      submitReview(call as ReviewCall, { ...input, rating: "skip" as any }),
    ).rejects.toThrow("Invalid review rating");
    expect(call).not.toHaveBeenCalled();
  });
});
