export const reviewRatings = ["again", "hard", "good", "easy"] as const;
export type ReviewRating = (typeof reviewRatings)[number];
export type ReviewCall = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<any>;

export type ReviewSubmission = {
  cardId: string;
  rating: ReviewRating;
  stateToken: string;
  elapsedMs: number;
  latestReviewId: unknown;
};

export async function renderCard(call: ReviewCall, cardId: string) {
  const rendered = await call("cards.render", { id: cardId });
  return {
    questionHtml: rendered.questionHtml,
    answerHtml: rendered.answerHtml,
  };
}

export async function prepareAnswer(call: ReviewCall, cardId: string) {
  const latest = await call("reviews.getLatestId", {
    cardIds: [cardId],
  });
  const prediction = await call("scheduling.predict", { cardId });
  return {
    latestReviewId: latest.id,
    predict: {
      stateToken: prediction.stateToken,
      answers: prediction.answers,
    },
  };
}

function errorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function unknownOutcome() {
  return { outcome: "unknown" as const };
}

export async function submitReview(
  call: ReviewCall,
  answer: ReviewSubmission,
): Promise<
  | { outcome: "submitted"; scheduling: unknown }
  | { outcome: "notDue" }
  | { outcome: "conflict" }
  | { outcome: "confirmed"; scheduling: unknown }
  | { outcome: "unknown" }
> {
  if (!(reviewRatings as readonly string[]).includes(answer.rating))
    throw new TypeError("Invalid review rating");

  const due = await call("scheduling.getDue", { cardId: answer.cardId });
  if (due?.dueNow !== true) return { outcome: "notDue" };

  try {
    await call("scheduling.answer", {
      cardId: answer.cardId,
      rating: answer.rating,
      stateToken: answer.stateToken,
      elapsedMs: Math.min(answer.elapsedMs, 60000),
    });
  } catch (error) {
    if (errorCode(error) === 1008) return { outcome: "conflict" };

    try {
      const latest = await call("reviews.getLatestId", {
        cardIds: [answer.cardId],
      });
      if (String(latest.id) === String(answer.latestReviewId))
        return unknownOutcome();

      const result = await call("reviews.list", {
        cardIds: [answer.cardId],
        afterId: answer.latestReviewId,
        limit: 20,
      });
      const found = Array.isArray(result?.items)
        ? result.items.some(
            (item: any) =>
              String(item?.cardId) === answer.cardId &&
              item?.rating === answer.rating,
          )
        : false;
      if (!found) return unknownOutcome();

      const scheduling = await call("scheduling.get", {
        cardId: answer.cardId,
      });
      return { outcome: "confirmed", scheduling };
    } catch {
      return unknownOutcome();
    }
  }

  try {
    const scheduling = await call("scheduling.get", { cardId: answer.cardId });
    return { outcome: "submitted", scheduling };
  } catch {
    return unknownOutcome();
  }
}
