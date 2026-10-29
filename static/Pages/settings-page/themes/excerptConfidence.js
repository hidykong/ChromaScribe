import { isManualThemeWordEntry } from "../../themePersistence.js?v=20260901b";
import { clampExcerptConfidenceThreshold } from "./excerptConfidenceSettings.js?v=20260901c";

export const EXCERPT_SELF_RATING_HELP = "Filters rated AI suggestions only. Unrated and human-coded excerpts stay visible. AI self-ratings are not measured accuracy.";

export function getExcerptSelfRating(excerpt) {
    if (excerpt?.confidenceSource !== "model_self_reported") return null;
    const rating = excerpt.confidence;
    if (typeof rating !== "number" || !Number.isFinite(rating)) return null;
    return rating >= 0 && rating <= 1 ? rating : null;
}

export function passesExcerptSelfRating(excerpt, minimum) {
    if (isManualThemeWordEntry(excerpt)) return true;
    const rating = getExcerptSelfRating(excerpt);
    return rating === null || rating >= minimum;
}

export function compareExcerptSelfRatings(left, right) {
    const leftHuman = isManualThemeWordEntry(left);
    const rightHuman = isManualThemeWordEntry(right);
    if (leftHuman !== rightHuman) return leftHuman ? -1 : 1;
    // Unrated excerpts follow rated suggestions, including a genuine zero rating.
    return (getExcerptSelfRating(right) ?? -1) - (getExcerptSelfRating(left) ?? -1);
}

function hasAiSource(excerpt) {
    const source = String(excerpt?.codeSource || excerpt?.source || excerpt?.tagSource || "").trim().toLowerCase();
    return ["ai", "llm", "cloud", "human_ai", "human+ai", "both"].includes(source)
        || excerpt?.aiTagged === true || excerpt?.ai_tagged === true || excerpt?.ai_generated === true;
}

export function getExcerptSourceBadgeLabel(excerpt) {
    const humanCoded = isManualThemeWordEntry(excerpt);
    if (humanCoded && !hasAiSource(excerpt)) return "Human-coded";
    const rating = getExcerptSelfRating(excerpt);
    const aiLabel = rating === null
        ? "AI suggested · Not rated"
        : `AI self-rating · ${Math.round(rating * 100)}/100`;
    return humanCoded ? `Human + ${aiLabel}` : aiLabel;
}

export function getExcerptRatingExplanation(excerpt) {
    const sourceDescriptions = {
        exact_answer_tag_match: "Source link: matched an answer tag.",
        quote_text_match: "Source link: matched transcript text.",
        model_quote_only: "Source link: model-provided quote without a verified transcript match."
    };
    const sourceDescription = sourceDescriptions[excerpt?.sourceMatch];
    const ratingDescription = getExcerptSelfRating(excerpt) === null
        ? "No AI self-rating is available."
        : "The AI model rated this suggestion. This is not measured accuracy.";
    return sourceDescription ? `${ratingDescription} ${sourceDescription}` : ratingDescription;
}

export function formatConfidenceThreshold(value) {
    return `${Math.round(clampExcerptConfidenceThreshold(value) * 100)}/100`;
}
