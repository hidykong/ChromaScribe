import { isManualThemeWordEntry } from "../../themePersistence.js?v=20260901b";

let matchingExcerptLoadState = "ready";
let loadedMatchingExcerptThemes = new Set();

export function setMatchingExcerptLoadState(state, loadedThemeNames = []) {
	matchingExcerptLoadState = state;
	loadedMatchingExcerptThemes = new Set(loadedThemeNames);
}

function getMatchingExcerptLoadState(theme) {
	if (loadedMatchingExcerptThemes.has(theme?.themeName)) {
		return "ready";
	}
	return matchingExcerptLoadState;
}

function hasAiSource(entry) {
	const source = String(entry?.codeSource || entry?.source || entry?.tagSource || "").trim().toLowerCase();
	if (["ai", "llm", "cloud", "human_ai", "human+ai", "both"].includes(source)) {
		return true;
	}
	if (entry?.aiTagged === true || entry?.ai_tagged === true || entry?.ai_generated === true) {
		return true;
	}
	return !isManualThemeWordEntry(entry);
}

export function getMatchingExcerptNotice({
	theme = {},
	candidateWords = [],
	visibleWords = [],
	isDemo = false,
	demoEmptyMessage = "No excerpts are currently linked to this code.",
	loadState = getMatchingExcerptLoadState(theme)
}) {
	if (isDemo) {
		return visibleWords.length === 0
			? { kind: "empty", message: demoEmptyMessage }
			: null;
	}
	if (visibleWords.some(hasAiSource)) {
		return null;
	}
	if (loadState === "loading") {
		return { kind: "loading", message: "Loading AI-suggested excerpts…" };
	}
	if (loadState === "error") {
		return {
			kind: "error",
			message: "AI-suggested excerpts could not be loaded. Refresh the page to try again."
		};
	}
	if (candidateWords.some(hasAiSource)) {
		return {
			kind: "filtered",
			message: "No rated AI suggestions meet your current minimum self-rating. Lower it to review more suggestions."
		};
	}
	// Check the code itself: an AI code can also contain manually added excerpts.
	if (isManualThemeWordEntry(theme) && !hasAiSource(theme)) {
		return candidateWords.length === 0
			? {
				kind: "manual-empty",
				message: "No excerpts are linked yet. Apply this code to an excerpt in Transcript mode."
			}
			: null;
	}
	return {
		kind: "ai-empty",
		message: "No AI-suggested excerpts are currently linked to this code.",
		helpTitle: "Why can a code have no AI-suggested excerpts?",
		helpText: "AI can suggest a possible code without returning a matching transcript excerpt. You can use the code as a starting point for review: use Find Similar Excerpts, apply it manually in Transcript mode, or archive it if it isn’t useful."
	};
}

export function appendMatchingExcerptNotice(container, options) {
	const notice = getMatchingExcerptNotice(options);
	if (!notice) {
		return;
	}

	const panel = container.append("div")
		.attr("class", "sections matching-excerpt-notice")
		.attr("data-state", notice.kind)
		.style("grid-column", "1 / -1")
		.style("width", "100%")
		.style("box-sizing", "border-box")
		.style("padding", "20px")
		.style("border", "1px solid #e5e7eb")
		.style("border-radius", "8px")
		.style("background", "#f9fafb")
		.style("font-family", "Inter, sans-serif")
		.style("font-size", "14px")
		.style("line-height", "1.6")
		.style("color", "#4b5563");

	if (!notice.helpText) {
		panel.text(notice.message);
		return;
	}

	// Native disclosure supports touch, Enter, and Space without custom key handlers.
	const details = panel.append("details");
	const summary = details.append("summary")
		.attr("title", notice.helpTitle)
		.attr("aria-label", `${notice.message} ${notice.helpTitle}`)
		.style("cursor", "pointer")
		.style("font-weight", "600");
	summary.append("span").text(notice.message);
	summary.append("span")
		.attr("aria-hidden", "true")
		.style("display", "inline-flex")
		.style("align-items", "center")
		.style("justify-content", "center")
		.style("width", "24px")
		.style("height", "24px")
		.style("margin-left", "8px")
		.style("border", "1px solid #9ca3af")
		.style("border-radius", "50%")
		.text("?");
	details.append("div")
		.style("margin-top", "12px")
		.style("font-weight", "600")
		.text(notice.helpTitle);
	details.append("p")
		.style("margin", "6px 0 0")
		.style("max-width", "70ch")
		.text(notice.helpText);
	details.append("a")
		.attr("href", options.transcriptUrl || "/transcriptmode")
		.style("display", "inline-block")
		.style("margin-top", "8px")
		.style("color", "#2449b8")
		.style("text-decoration", "underline")
		.text("Open Transcript mode");
}
