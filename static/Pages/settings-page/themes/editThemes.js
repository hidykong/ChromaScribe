import {
    EXCERPT_SELF_RATING_HELP,
    compareExcerptSelfRatings,
    formatConfidenceThreshold,
    getExcerptRatingExplanation,
    getExcerptSourceBadgeLabel,
    passesExcerptSelfRating
} from "./excerptConfidence.js";
import { makeWordClouds } from "./makeWordClouds.js?v=20260921a";
import {
	appendMatchingExcerptNotice,
	setMatchingExcerptLoadState
} from "./matchingExcerptNotice.js?v=20260921a";
import { makeThemeBoxes } from "./makeThemeBoxes.js?v=20260921a";
import { editThemesMore, saveSelectedThemesAndContinue } from "./editThemesMore.js?v=20261006a";
import {generateThemes} from "./generateThemes.js?v=20260901a";
import { showArchivePage } from "./archivePage.js?v=20260901a";
import {
	buildPersistedThemePayload,
	buildThemeExcerptEntry,
	buildThemeWordIdentityKey,
	dedupeThemeWordEntries,
	getThemesStorageKey,
	isManualThemeWordEntry,
	normalizeManualSelectionOptOuts,
	normalizeThemeWordText
} from "../../themePersistence.js?v=20260901b";
import {
	clampExcerptConfidenceThreshold,
	EXCERPT_CONFIDENCE_STEP_PERCENT,
	getExcerptConfidenceThreshold,
	MAX_EXCERPT_CONFIDENCE_THRESHOLD,
	MIN_EXCERPT_CONFIDENCE_THRESHOLD,
	setExcerptConfidenceThreshold
} from "./excerptConfidenceSettings.js?v=20260901c";
import { demoingObject, themesObject, selectedThemeBoxObject, tempThemesObject,
	firstShowOnboradingObject, multiSelectedWordsObject, themes } from "../../../chromascribe-main.js";

const THEMES_EDIT_ONBOARDING_ENDPOINT = "/api/themes_edit_onboarding";
function getCurrentProjectId() {
	const params = new URLSearchParams(window.location.search || "");
	const urlProjectId = params.get("projectId") || params.get("project_id");
	if (urlProjectId && urlProjectId.trim()) return urlProjectId.trim();
	const serverProjectId = window.CURRENT_PROJECT_ID;
	if (typeof serverProjectId === "string" && serverProjectId.trim()) return serverProjectId.trim();
	const rawValue = localStorage.getItem("currentProjectId");
	if (typeof rawValue === "string" && rawValue.trim()) return rawValue.trim();
	return "";
}

function projectQueryParam(prefix = "&") {
	const projectId = getCurrentProjectId();
	return projectId ? `${prefix}projectId=${encodeURIComponent(projectId)}` : "";
}

function getProjectStorageScope(projectId = getCurrentProjectId()) {
	const resolvedProjectId = String(projectId || "").trim();
	if (!resolvedProjectId) return "";
	const workspaceKey = (window.USER_WORKSPACE_KEY || localStorage.getItem("currentWorkspaceKey") || "").trim();
	return workspaceKey ? `${workspaceKey}__${resolvedProjectId}` : resolvedProjectId;
}

function getThemeSelectionCompleteKey(projectId = getCurrentProjectId()) {
	const storageScope = getProjectStorageScope(projectId);
	return storageScope ? `themeSelectionComplete_${storageScope}` : "themeSelectionComplete";
}

function getThemeSelectionPendingKey(projectId = getCurrentProjectId()) {
	const storageScope = getProjectStorageScope(projectId);
	return storageScope ? `themeSelectionPending_${storageScope}` : "themeSelectionPending";
}

function hasPendingGeneratedThemeCandidates(projectId = getCurrentProjectId()) {
	const storageScope = getProjectStorageScope(projectId);
	const key = storageScope ? `generatedPossibleThemes_${storageScope}` : "generatedPossibleThemes";
	try {
		const parsed = JSON.parse(localStorage.getItem(key) || "[]");
		return Array.isArray(parsed) && parsed.length > 0;
	} catch (error) {
		return false;
	}
}

function withProjectPayload(payload) {
	const projectId = getCurrentProjectId();
	return projectId ? { ...payload, projectId } : payload;
}

function markUsageStep(stepName, details = {}) {
	const payload = { stepName, ...details };
	window.__pendingChromaUsageStep = payload;
	if (window.ChromaUsageLogger && typeof window.ChromaUsageLogger.setStep === "function") {
		window.ChromaUsageLogger.setStep(stepName, payload);
	}
}

function ensureOnboardingOverlay() {
	d3.select("#popUpHolder").remove();
	d3.select("#onboarding").remove();
	d3.select("#settings-page").append("div")
		.attr("id", "onboarding")
		.style("position", "absolute")
		.style("z-index", 30)
		.style("width", "100%")
		.style("height", "100%")
		.style("background", "rgba(15, 23, 42, 0.42)");
}

async function getThemeEditOnboardingSeen() {
	try {
		const response = await fetch(`${THEMES_EDIT_ONBOARDING_ENDPOINT}?t=${Date.now()}`, { cache: "no-store" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const payload = await response.json();
		return payload?.seen === true;
	} catch (error) {
		console.warn("Failed to load onboarding preference:", error);
		return localStorage.getItem("chromascribe_theme_edit_onboarding_seen") === "true";
	}
}

async function setThemeEditOnboardingSeen() {
	localStorage.setItem("chromascribe_theme_edit_onboarding_seen", "true");
	try {
		await fetch(THEMES_EDIT_ONBOARDING_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ seen: true })
		});
	} catch (error) {
		console.warn("Failed to save onboarding preference:", error);
	}
}

async function showThemeEditOnboarding({ markSeen = false } = {}) {
	ensureOnboardingOverlay();
	onboardingPopUps();
	firstShowOnboradingObject.firstShowOnborading = false;
	if (markSeen) {
		await setThemeEditOnboardingSeen();
	}
}

async function maybeShowThemeEditOnboarding() {
	if (!firstShowOnboradingObject.firstShowOnborading) return;
	const hasSeenOnboarding = await getThemeEditOnboardingSeen();
	if (!hasSeenOnboarding) {
		await showThemeEditOnboarding({ markSeen: true });
	}
}

var item_dict, item_dict_keys;

function buildDemoExcerptCandidates(themeName, topicPayload) {
	const normalizedTheme = String(themeName || "this theme")
		.replaceAll("_", " ")
		.trim();
	const themeLabel = normalizedTheme || "this theme";
	const keywordEntries = topicPayload && typeof topicPayload === "object" && !Array.isArray(topicPayload)
		? Object.entries(topicPayload)
			.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
			.slice(0, 4)
			.map(([keyword]) => String(keyword || "").replaceAll("_", " ").trim())
			.filter(Boolean)
		: [];

	const keywordText = keywordEntries.length
		? keywordEntries.join(", ")
		: "practical experiences, repeated concerns, and concrete examples";

	return [
		`Demo excerpt: participants described ${themeLabel} through examples about ${keywordText}.`,
		`Demo excerpt: one speaker connected ${themeLabel} to day-to-day decisions and the way people interpret what they hear in interviews.`,
		`Demo excerpt: another participant framed ${themeLabel} as something that shapes confidence, expectations, and follow-up actions over time.`,
		`Demo excerpt: this sample quote is included for demo use only so the theme-edit page shows realistic-looking excerpts for ${themeLabel}.`
	];
}

function normalizeExcerptCandidate(rawQuote) {
	return buildThemeExcerptEntry(rawQuote);
}

function normalizeExcerptText(rawValue) {
	return normalizeThemeWordText(rawValue).toLowerCase();
}

function normalizeThemeSummary(rawTheme) {
	if (!rawTheme || typeof rawTheme !== "object") return "";
	return normalizeThemeWordText(rawTheme.summary || rawTheme.description || rawTheme.themeSummary || "");
}

function normalizeThemeNameKey(rawThemeName) {
	return String(rawThemeName || "")
		.replace(/[_-]+/g, " ")
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function themeNameKeysMatch(leftThemeName, rightThemeName) {
	const leftKey = normalizeThemeNameKey(leftThemeName);
	const rightKey = normalizeThemeNameKey(rightThemeName);
	if (!leftKey || !rightKey) return false;
	return leftKey === rightKey || leftKey.replace(/\s+/g, "") === rightKey.replace(/\s+/g, "");
}

function isHumanCodedThemeWord(wordEntry) {
	if (!wordEntry || typeof wordEntry !== "object") return false;
	const source = String(wordEntry.codeSource || wordEntry.source || wordEntry.tagSource || "").trim().toLowerCase();
	if (source === "manual" || source === "human") return true;
	if (source === "ai" || source === "llm" || source === "cloud") return false;
	if (Object.prototype.hasOwnProperty.call(wordEntry, "ai_generated")) {
		return wordEntry.ai_generated === false;
	}
	return false;
}

function themeHasGeneratedEvidence(theme) {
	if (!theme || typeof theme !== "object") return false;
	if (normalizeThemeSummary(theme)) return true;
	return (Array.isArray(theme.words) ? theme.words : []).some((word) => !isHumanCodedThemeWord(word));
}

function themeNameSet(themes) {
	return new Set(
		(Array.isArray(themes) ? themes : [])
			.map((theme) => normalizeThemeNameKey(theme && theme.themeName))
			.filter(Boolean)
	);
}

function storedSelectionOnlyContainsManualCodes(storedThemeSet, serverThemeSet) {
	if (!storedThemeSet || !Array.isArray(storedThemeSet.themes) || storedThemeSet.themes.length === 0) {
		return false;
	}
	const generatedServerThemeNames = themeNameSet((serverThemeSet || []).filter(themeHasGeneratedEvidence));
	if (generatedServerThemeNames.size === 0) return false;
	return !storedThemeSet.themes.some((theme) => generatedServerThemeNames.has(normalizeThemeNameKey(theme && theme.themeName)));
}

function storedSelectionExpandsIncomingThemes(storedThemeSet, serverThemeSet) {
	if (!storedThemeSet || !Array.isArray(storedThemeSet.themes) || storedThemeSet.themes.length === 0) {
		return false;
	}
	const incomingThemeNames = themeNameSet(serverThemeSet);
	if (incomingThemeNames.size === 0) return false;
	return storedThemeSet.themes.some((theme) => {
		const storedThemeName = normalizeThemeNameKey(theme && theme.themeName);
		return storedThemeName && !incomingThemeNames.has(storedThemeName);
	});
}

function themeListHasGeneratedEvidence(themeList) {
	return (Array.isArray(themeList) ? themeList : []).some(themeHasGeneratedEvidence);
}

function getThemePayloadByName(payloadByTheme, themeName) {
	if (!payloadByTheme || typeof payloadByTheme !== "object") return null;
	if (Object.prototype.hasOwnProperty.call(payloadByTheme, themeName)) {
		return payloadByTheme[themeName];
	}
	const normalizedThemeName = normalizeThemeNameKey(themeName);
	return Object.entries(payloadByTheme).find(
		([key]) => normalizeThemeNameKey(key) === normalizedThemeName
	)?.[1] || null;
}

function extractThemeQuoteCandidates(themePayload) {
	if (Array.isArray(themePayload)) return themePayload;
	if (!themePayload || typeof themePayload !== "object") return [];

	if (Array.isArray(themePayload.quotes)) return themePayload.quotes;
	if (Array.isArray(themePayload.excerpts)) return themePayload.excerpts;

	const summaryKeys = new Set(["summary", "description", "themeSummary", "theme_summary"]);
	return Object.entries(themePayload)
		.filter(([key]) => !summaryKeys.has(key))
		.map(([, value]) => value)
		.filter((value) => {
			if (value === null || typeof value === "undefined") return false;
			if (typeof value === "object") {
				return Boolean(value.text || value.word || value.quote || value.excerpt);
			}
			return typeof value === "string" && value.trim() !== "";
		});
}

function filterThemeSummaryWords(words, theme) {
	if (!Array.isArray(words)) return [];
	const themeSummary = normalizeThemeSummary(theme);
	if (!themeSummary) return words;

	return words.filter((word) => {
		const normalizedWord = buildThemeExcerptEntry(word);
		if (!normalizedWord) return true;
		return normalizeExcerptText(normalizedWord.word) !== normalizeExcerptText(themeSummary);
	});
}

function mergeThemeExcerptWords(theme, incomingWords) {
	if (!theme || typeof theme !== "object") return;
	const existingWords = Array.isArray(theme.words) ? theme.words : [];
	const nextWords = Array.isArray(incomingWords) ? incomingWords : [];
	theme.words = dedupeThemeWordEntries(
		filterThemeSummaryWords([...existingWords, ...nextWords], theme)
	);
}

function hasDeletedQuoteContext(entry) {
	if (!entry || typeof entry !== "object") return false;
	return Boolean(entry.participant || entry.tag || entry.timestamp || entry.cueText);
}

function matchesDeletedQuote(themeName, wordEntry, deletedQuote) {
	const normalizedThemeName = String(themeName || "").trim().toLowerCase();
	const deletedThemeName = String(deletedQuote && deletedQuote.themeName || "").trim().toLowerCase();
	if (!normalizedThemeName || normalizedThemeName !== deletedThemeName) {
		return false;
	}

	if (hasDeletedQuoteContext(deletedQuote)) {
		return buildThemeWordIdentityKey(wordEntry) === buildThemeWordIdentityKey(deletedQuote);
	}

	return normalizeExcerptText(deletedQuote && deletedQuote.word) === normalizeExcerptText(wordEntry && wordEntry.word);
}

function mergeSelectedWordsIntoTempThemes() {
	tempThemesObject.tempThemes.forEach((tempTheme) => {
		const selectedTheme = themesObject.themes.find(
			(theme) => themeNameKeysMatch(theme && theme.themeName, tempTheme && tempTheme.themeName)
		);
		if (!selectedTheme || !Array.isArray(selectedTheme.words) || selectedTheme.words.length === 0) {
			return;
		}

		const normalizedSelectedWords = selectedTheme.words
			.map((word) => normalizeExcerptCandidate(word))
			.filter(Boolean);

		tempTheme.words = dedupeThemeWordEntries([
			...(Array.isArray(tempTheme.words) ? tempTheme.words : []),
			...filterThemeSummaryWords(normalizedSelectedWords, tempTheme),
		]);
	});
}

function mergeStoredThemeMetadata(storedThemeSet, serverThemeSet) {
	if (!storedThemeSet || !Array.isArray(storedThemeSet.themes) || !Array.isArray(serverThemeSet)) {
		return storedThemeSet;
	}

	const mergedThemes = storedThemeSet.themes.map((storedTheme) => {
		const serverTheme = serverThemeSet.find(
			(theme) => themeNameKeysMatch(theme && theme.themeName, storedTheme && storedTheme.themeName)
		);
		if (!serverTheme || !Array.isArray(storedTheme.words)) {
			return storedTheme;
		}

		const normalizedServerWords = (serverTheme.words || [])
			.map((word) => buildThemeExcerptEntry(word))
			.filter(Boolean);
		const serverWordMap = new Map(
			normalizedServerWords
				.map((word) => {
					const identityKey = buildThemeWordIdentityKey(word);
					return identityKey ? [identityKey, word] : null;
				})
				.filter(Boolean)
		);
		const serverWordTextMap = new Map();
		normalizedServerWords.forEach((word) => {
			const normalizedText = normalizeExcerptText(word && word.word);
			if (!normalizedText) return;
			const bucket = serverWordTextMap.get(normalizedText) || [];
			bucket.push(word);
			serverWordTextMap.set(normalizedText, bucket);
		});

		return {
			...storedTheme,
			words: filterThemeSummaryWords(storedTheme.words.map((word) => {
				const normalizedWord = buildThemeExcerptEntry(word);
				if (!normalizedWord) return word;

				const identityKey = buildThemeWordIdentityKey(normalizedWord);
				let serverWord = identityKey ? serverWordMap.get(identityKey) : null;
				if (!serverWord) {
					const normalizedText = normalizeExcerptText(normalizedWord.word);
					const candidateWords = normalizedText ? (serverWordTextMap.get(normalizedText) || []) : [];
					if (candidateWords.length === 1) {
						serverWord = candidateWords[0];
					}
				}
					if (!serverWord) return word;
					const mergedWord = {
						...normalizedWord,
						speaker: normalizedWord.speaker || serverWord.speaker || "",
						participant: normalizedWord.participant || serverWord.participant || "",
						tag: normalizedWord.tag || serverWord.tag || "",
						timestamp: normalizedWord.timestamp || serverWord.timestamp || "",
						cueText: normalizedWord.cueText || serverWord.cueText || ""
					};
					if (typeof mergedWord.ai_generated === "undefined" && typeof serverWord.ai_generated !== "undefined") {
						mergedWord.ai_generated = serverWord.ai_generated;
					}
					if (!mergedWord.codeSource && serverWord.codeSource) {
						mergedWord.codeSource = serverWord.codeSource;
					}
					return mergedWord;
				}), serverTheme),
			summary: normalizeThemeSummary(serverTheme) || normalizeThemeSummary(storedTheme)
			};
		});

	return { ...storedThemeSet, themes: mergedThemes };
}

function renderBasicMatchingExcerptsFallback(error) {
	console.error("Failed to render advanced matching excerpts:", error);
	const wordCloud = d3.select("#word-cloud");
	wordCloud.selectAll("*").remove();
	const selectedThemeName = selectedThemeBoxObject.selectedThemeBox;
	const selectedTheme = (tempThemesObject.tempThemes || []).find(
		theme => themeNameKeysMatch(theme && theme.themeName, selectedThemeName)
	);
	const words = Array.isArray(selectedTheme && selectedTheme.words) ? selectedTheme.words : [];
	const themeSummary = normalizeThemeSummary(selectedTheme);
	const projectId = getCurrentProjectId();
	const limitKey = projectId ? `themeExcerptLimit_${projectId}` : "themeExcerptLimit";
	const isHumanWord = isManualThemeWordEntry;
	const confidenceThreshold = getExcerptConfidenceThreshold();
	const candidateWords = words
		.map((wordElement) => buildThemeExcerptEntry(wordElement))
		.filter(Boolean);
    const displayableWords = candidateWords
        .filter(wordElement => passesExcerptSelfRating(wordElement, confidenceThreshold))
        .sort(compareExcerptSelfRatings);
	const storedLimit = localStorage.getItem(limitKey) || "all";
	const resolvedLimit = storedLimit === "all"
		? displayableWords.length
		: Math.min(displayableWords.length, Math.max(0, parseInt(storedLimit, 10) || displayableWords.length));
	const visibleWords = displayableWords.slice(0, resolvedLimit);

	const header = wordCloud.append("div")
		.style("padding", "62px clamp(24px, 4vw, 56px) 0 clamp(24px, 4vw, 56px)")
		.style("font-family", "Inter")
		.style("box-sizing", "border-box");

	header.append("div")
		.style("font-size", "22px")
		.style("font-weight", "700")
		.style("color", "#111827")
		.text(String(selectedThemeName || "Matching excerpts").replace(/_/g, " "));

	if (themeSummary) {
		header.append("div")
			.style("margin-top", "6px")
			.style("font-size", "14px")
			.style("line-height", "1.6")
			.style("color", "#6b7280")
			.text(themeSummary);
	}

	const toolbar = wordCloud.append("div")
		.style("padding", "16px clamp(24px, 4vw, 56px) 12px clamp(24px, 4vw, 56px)")
		.style("display", "flex")
		.style("align-items", "center")
		.style("justify-content", "space-between")
		.style("gap", "16px")
		.style("flex-wrap", "wrap")
		.style("font-family", "Inter")
		.style("box-sizing", "border-box");

	const titleGroup = toolbar.append("div")
		.style("display", "flex")
		.style("flex-direction", "column")
		.style("gap", "4px");
	titleGroup.append("div")
		.style("font-size", "18px")
		.style("font-weight", "700")
		.style("color", "#111827")
		.text("Matching excerpts");
	titleGroup.append("div")
		.style("font-size", "12px")
		.style("font-weight", "600")
		.style("color", "#6b7280")
		.text(`${displayableWords.length} of ${words.length} excerpts available; rated AI suggestions are ordered by self-rating`);

    titleGroup.append("div")
        .style("max-width", "640px")
        .style("font-size", "12px")
        .style("color", "#6b7280")
        .text(EXCERPT_SELF_RATING_HELP);

	const controls = toolbar.append("div")
		.style("display", "flex")
		.style("align-items", "center")
		.style("justify-content", "flex-end")
		.style("gap", "16px")
		.style("flex-wrap", "wrap");

	const countControl = controls.append("label")
		.style("display", "inline-flex")
		.style("align-items", "center")
		.style("gap", "8px")
		.style("font-size", "13px")
		.style("font-weight", "700")
		.style("color", "#4b5563");
	countControl.append("span").text("Show");
	const countSelect = countControl.append("select")
		.attr("aria-label", "Number of excerpts to show")
		.style("height", "34px")
		.style("border", "1px solid #d1d5db")
		.style("border-radius", "8px")
		.style("padding", "0 28px 0 10px")
		.style("background", "#ffffff")
		.style("font-family", "Inter")
		.style("font-size", "13px")
		.style("font-weight", "700")
		.property("disabled", displayableWords.length === 0)
		.on("change", function() {
			localStorage.setItem(limitKey, this.value === String(displayableWords.length) ? "all" : this.value);
			renderBasicMatchingExcerptsFallback(error);
		});
	countSelect.append("option").attr("value", String(displayableWords.length)).text(displayableWords.length > 0 ? String(displayableWords.length) : "0");
	for (let i = 1; i < displayableWords.length; i += 1) {
		countSelect.append("option").attr("value", String(i)).text(String(i));
	}
	countSelect.property("value", String(resolvedLimit));
	countControl.append("span").text(`of ${displayableWords.length}`);

	const thresholdControl = controls.append("label")
		.style("display", "inline-flex")
		.style("align-items", "center")
		.style("gap", "8px")
		.style("font-size", "13px")
		.style("font-weight", "700")
		.style("color", "#4b5563");
	thresholdControl.append("span").text("Min AI self-rating");
	const thresholdLabel = thresholdControl.append("span")
		.style("min-width", "42px")
		.style("padding", "4px 8px")
		.style("border-radius", "999px")
		.style("background", "#eff6ff")
		.style("color", "#1d4ed8")
		.style("text-align", "center")
		.text(formatConfidenceThreshold(confidenceThreshold));
	thresholdControl.append("input")
		.attr("type", "range")
		.attr("min", String(Math.round(MIN_EXCERPT_CONFIDENCE_THRESHOLD * 100)))
		.attr("max", String(Math.round(MAX_EXCERPT_CONFIDENCE_THRESHOLD * 100)))
		.attr("step", String(EXCERPT_CONFIDENCE_STEP_PERCENT))
		.attr("aria-label", "Minimum AI self-rating")
		.style("width", "150px")
		.property("value", Math.round(confidenceThreshold * 100))
		.on("input", function() {
			const nextValue = clampExcerptConfidenceThreshold(Number(this.value) / 100);
			thresholdLabel.text(formatConfidenceThreshold(nextValue));
		})
		.on("change", function() {
			setExcerptConfidenceThreshold(Number(this.value) / 100);
			localStorage.setItem(limitKey, "all");
			renderBasicMatchingExcerptsFallback(error);
		});

	const grid = wordCloud.append("div")
		.style("display", "grid")
		.style("width", "100%")
		.style("grid-template-columns", "repeat(auto-fit, minmax(min(100%, 300px), 1fr))")
		.style("gap", "22px")
		.style("padding", "0 clamp(24px, 4vw, 56px) 350px clamp(24px, 4vw, 56px)")
		.style("box-sizing", "border-box")
		.style("align-content", "flex-start");

	appendMatchingExcerptNotice(grid, {
		theme: selectedTheme,
		candidateWords,
		visibleWords: displayableWords,
		transcriptUrl: `/transcriptmode${projectQueryParam("?")}`,
		isDemo: window.APP_MODE !== "user" || window.location.pathname.startsWith("/demo")
	});
	if (visibleWords.length === 0) {
		return;
	}

	visibleWords.forEach(normalizedWord => {
		const sourceLabel = getExcerptSourceBadgeLabel(normalizedWord);
		const card = grid.append("div")
			.style("min-height", "220px")
			.style("position", "relative")
			.style("border-radius", "5px")
			.style("border", "2px solid #e5e7eb")
			.style("border-left", `8px solid ${selectedTheme && selectedTheme.color ? selectedTheme.color : "#579AE2"}`)
			.style("background", "#e6f0ff")
			.style("padding", "54px 18px 46px 18px")
			.style("font-family", "Inter")
			.style("font-size", "16px")
			.style("line-height", "1.45")
			.style("text-align", "center")
			.style("box-sizing", "border-box")
			.style("word-break", "break-word");

		card.append("input")
			.attr("type", "checkbox")
			.style("position", "absolute")
			.style("top", "10px")
			.style("left", "10px")
			.style("width", "20px")
			.style("height", "20px")
			.property("checked", true);
		card.append("div")
			.style("position", "absolute")
			.style("top", "10px")
			.style("right", "12px")
			.style("padding", "4px 9px")
			.style("border-radius", "999px")
			.style("border", isHumanWord(normalizedWord) ? "1px solid #bfdbfe" : "1px solid #bbf7d0")
			.style("background", isHumanWord(normalizedWord) ? "#eff6ff" : "#ecfdf5")
			.style("color", isHumanWord(normalizedWord) ? "#1d4ed8" : "#166534")
			.style("font-size", "12px")
			.style("font-weight", "800")
			.attr("title", getExcerptRatingExplanation(normalizedWord))
			.text(sourceLabel);
		card.append("div")
			.style("overflow-y", "auto")
			.style("overflow-x", "hidden")
			.style("font-size", "16px")
			.style("line-height", "1.45")
			.style("text-align", "center")
			.style("padding", "52px 8px 46px 8px")
			.style("width", "100%")
			.style("height", "calc(100% - 44px)")
			.style("box-sizing", "border-box")
			.style("word-break", "break-word")
			.text(normalizedWord.word);
		const participantLabel = normalizedWord.participant || normalizedWord.tag || "";
		if (participantLabel) {
			card.append("div")
				.style("position", "absolute")
				.style("left", "12px")
				.style("bottom", "12px")
				.style("padding", "4px 10px")
				.style("border-radius", "999px")
				.style("background", "#eef2ff")
				.style("color", "#2643b6")
				.style("font-size", "13px")
				.style("font-weight", "700")
				.text(participantLabel);
		}
	});
}

function getSimilarExcerptStatusIcon(state) {
    switch (state) {
        case "loading":
            return "";
        case "success":
            return "OK";
        case "empty":
            return "0";
        case "error":
            return "!";
        default:
            return "i";
    }
}

function getSimilarExcerptPhaseLabel(phase) {
    switch (phase) {
        case "refreshing":
            return "Refreshing candidates";
        case "cancelling":
            return "Stopping";
        case "scanning":
            return "Scanning transcripts";
        default:
            return "Starting";
    }
}

function getEmptySimilarExcerptDetail(reason) {
    if (reason === "theme_not_found") {
        return "The code was not found in the generated-code file.";
    }
    if (reason === "no_current_uploaded_transcripts") {
        return "No current uploaded transcript files were available for this search.";
    }
    return "Try another code or lower the AI self-rating filter if candidates already exist.";
}

const SIMILAR_EXCERPT_TOAST_ID = "similar-excerpt-toast";
const SIMILAR_EXCERPT_TOAST_STYLE_ID = "similar-excerpt-toast-style";
let similarExcerptPollTimer = null;

function ensureSimilarExcerptToastStyles() {
	if (document.getElementById(SIMILAR_EXCERPT_TOAST_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = SIMILAR_EXCERPT_TOAST_STYLE_ID;
	style.textContent = `
@keyframes similar-excerpt-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.similar-excerpt-toast {
  align-items: flex-start;
  background: #ffffff;
  border: 1px solid #dbe3f0;
  border-left: 5px solid #3A61DD;
  border-radius: 10px;
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.18);
  box-sizing: border-box;
  color: #111827;
  display: flex;
  font-family: Inter, sans-serif;
  gap: 12px;
  max-width: min(430px, calc(100vw - 32px));
  padding: 14px 16px;
  position: fixed;
  right: 24px;
  top: 72px;
  width: min(430px, calc(100vw - 32px));
  z-index: 12000;
}
.similar-excerpt-toast[data-state="success"] { border-left-color: #16a34a; }
.similar-excerpt-toast[data-state="empty"] { border-left-color: #64748b; }
.similar-excerpt-toast[data-state="error"] { border-left-color: #dc2626; }
.similar-excerpt-toast-icon {
  align-items: center;
  border-radius: 999px;
  display: inline-flex;
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 900;
  height: 26px;
  justify-content: center;
  margin-top: 1px;
  width: 26px;
}
.similar-excerpt-toast[data-state="loading"] .similar-excerpt-toast-icon {
  animation: similar-excerpt-spin 0.9s linear infinite;
  border: 3px solid #dbeafe;
  border-top-color: #3A61DD;
}
.similar-excerpt-toast[data-state="info"] .similar-excerpt-toast-icon {
  background: #eef2ff;
  color: #3159c9;
}
.similar-excerpt-toast[data-state="success"] .similar-excerpt-toast-icon {
  background: #dcfce7;
  color: #166534;
}
.similar-excerpt-toast[data-state="empty"] .similar-excerpt-toast-icon {
  background: #f1f5f9;
  color: #475569;
}
.similar-excerpt-toast[data-state="error"] .similar-excerpt-toast-icon {
  background: #fee2e2;
  color: #991b1b;
}
.similar-excerpt-toast-title {
  color: #111827;
  font-size: 14px;
  font-weight: 900;
  line-height: 1.25;
}
.similar-excerpt-toast-message {
  color: #475569;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  margin-top: 4px;
}
.similar-excerpt-toast-detail {
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.35;
  margin-top: 8px;
}
.similar-excerpt-toast-close {
  background: transparent;
  border: none;
  color: #64748b;
  cursor: pointer;
  font-family: Inter, sans-serif;
  font-size: 16px;
  font-weight: 900;
  line-height: 1;
  padding: 2px;
}
.similar-excerpt-progress {
  background: #e5e7eb;
  border-radius: 999px;
  height: 8px;
  margin-top: 10px;
  overflow: hidden;
  width: 100%;
}
.similar-excerpt-progress-bar {
  background: #3A61DD;
  border-radius: inherit;
  height: 100%;
  transition: width 0.2s ease;
}
.similar-excerpt-toast-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.similar-excerpt-stop {
  background: #111827;
  border: 1px solid #111827;
  border-radius: 8px;
  color: #ffffff;
  cursor: pointer;
  font-family: Inter, sans-serif;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  padding: 8px 11px;
}
.similar-excerpt-stop:hover {
  background: #374151;
}
	`;
		document.head.appendChild(style);
	}

	function normalizeProgressPercent(value) {
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue)) return null;
		return Math.max(0, Math.min(100, Math.round(numericValue)));
	}

	function showSimilarExcerptToast({
		state = "info",
		title = "",
		message = "",
		detail = "",
		autoDismissMs = 0,
		progressPercent = null,
		showStop = false,
		onStop = null,
		onClose = null
	} = {}) {
		ensureSimilarExcerptToastStyles();
		d3.select(`#${SIMILAR_EXCERPT_TOAST_ID}`).remove();
		const normalizedProgress = normalizeProgressPercent(progressPercent);

		const toast = d3.select("body")
		.append("div")
		.attr("id", SIMILAR_EXCERPT_TOAST_ID)
		.attr("class", "similar-excerpt-toast")
		.attr("data-state", state)
		.attr("role", state === "error" ? "alert" : "status")
		.attr("aria-live", "polite");

	const iconText = getSimilarExcerptStatusIcon(state);
	toast.append("div")
		.attr("class", "similar-excerpt-toast-icon")
		.attr("aria-hidden", "true")
		.text(iconText);

	const body = toast.append("div")
		.style("flex", "1 1 auto")
		.style("min-width", "0");
	body.append("div")
		.attr("class", "similar-excerpt-toast-title")
		.text(title || "Find Similar Excerpts");
	body.append("div")
		.attr("class", "similar-excerpt-toast-message")
		.text(message || "");
		if (detail) {
			body.append("div")
				.attr("class", "similar-excerpt-toast-detail")
				.text(detail);
		}
		if (normalizedProgress !== null) {
			const progress = body.append("div")
				.attr("class", "similar-excerpt-progress")
				.attr("role", "progressbar")
				.attr("aria-valuemin", "0")
				.attr("aria-valuemax", "100")
				.attr("aria-valuenow", String(normalizedProgress));
			progress.append("div")
				.attr("class", "similar-excerpt-progress-bar")
				.style("width", `${normalizedProgress}%`);
		}
		if (showStop && typeof onStop === "function") {
			body.append("div")
				.attr("class", "similar-excerpt-toast-actions")
				.append("button")
				.attr("type", "button")
				.attr("class", "similar-excerpt-stop")
				.text("Stop search")
				.on("click", function() {
					onStop();
				});
		}

		toast.append("button")
		.attr("type", "button")
		.attr("class", "similar-excerpt-toast-close")
			.attr("aria-label", "Dismiss similar excerpt status")
			.text("x")
			.on("click", function() {
				if (typeof onClose === "function") {
					onClose();
					return;
				}
				d3.select(`#${SIMILAR_EXCERPT_TOAST_ID}`).remove();
			});

	if (autoDismissMs > 0) {
		setTimeout(() => {
			const current = d3.select(`#${SIMILAR_EXCERPT_TOAST_ID}`);
			if (!current.empty() && current.attr("data-state") === state) {
				current.remove();
			}
		}, autoDismissMs);
	}
}

function formatThemeLabel(themeName) {
	const text = String(themeName || "").replace(/_/g, " ").trim();
	return text || "selected code";
}

function formatSimilarExcerptFiles(files = []) {
	const uniqueFiles = [];
	const seen = new Set();
	(Array.isArray(files) ? files : []).forEach((file) => {
		const basename = String(file || "").split(/[\\/]/).pop().trim();
		if (!basename || seen.has(basename)) return;
		seen.add(basename);
		uniqueFiles.push(basename);
	});
	if (uniqueFiles.length <= 4) return uniqueFiles.join(", ");
	return `${uniqueFiles.slice(0, 4).join(", ")} +${uniqueFiles.length - 4} more`;
}

function buildSimilarExcerptSourceDetail(data = {}, prefix = "") {
	const detailParts = [];
	if (prefix) detailParts.push(prefix);
	const scannedFiles = formatSimilarExcerptFiles(data.sourceFiles);
	const codeFiles = formatSimilarExcerptFiles(data.codeSourceFiles);
	if (scannedFiles) {
		const count = Array.isArray(data.sourceFiles) ? data.sourceFiles.length : 0;
		detailParts.push(`Scanning current uploaded file${count === 1 ? "" : "s"}: ${scannedFiles}.`);
	}
	if (codeFiles) {
		detailParts.push(`This code was suggested from: ${codeFiles}.`);
	}
	return detailParts.join(" ");
}

function getThemeNamesForSimilarSearch(themeObject) {
	const candidates = [
		...(Array.isArray(themeObject && themeObject.themes) ? themeObject.themes : []),
		...(Array.isArray(themesObject && themesObject.themes) ? themesObject.themes : []),
		...(Array.isArray(tempThemesObject && tempThemesObject.tempThemes) ? tempThemesObject.tempThemes : []),
	];
	const seen = new Set();
	const names = [];
	candidates.forEach((theme) => {
		const name = String(theme && theme.themeName || "").trim();
		const key = normalizeThemeNameKey(name);
		if (!name || seen.has(key)) return;
		seen.add(key);
		names.push(name);
	});
	return names;
}

	function setSimilarExcerptButtonLoading(buttonNode, loading, progressPercent = null) {
		const button = d3.select(buttonNode);
		const normalizedProgress = normalizeProgressPercent(progressPercent);
		button
			.property("disabled", Boolean(loading))
			.style("opacity", loading ? "0.66" : "1")
			.style("cursor", loading ? "wait" : "pointer");
		button.select(".similar-excerpt-button-label")
			.text(loading ? (normalizedProgress !== null ? `Finding ${normalizedProgress}%` : "Finding...") : "Find Similar Excerpts");
	}

	async function refreshMatchingExcerptsFromServer(themeObject, topicsPayload = null) {
	const themesToSend = getThemeNamesForSimilarSearch(themeObject);
	let topics = topicsPayload;
	if (!topics) {
		const response = await fetch('/get_chosen_themes', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(withProjectPayload({ themes: themesToSend }))
		});
		if (!response.ok) {
			throw new Error(`Could not refresh excerpts (${response.status})`);
		}
		topics = await response.json();
	}

	setMatchingExcerptLoadState("ready");
	window.__matchingExcerptsByTheme = topics || {};
	for (let i = 0; i < tempThemesObject.tempThemes.length; i++) {
		const themeName = tempThemesObject.tempThemes[i].themeName;
		const item_dict = getThemePayloadByName(topics, themeName);
		if (!item_dict) continue;
		const themeSummary = normalizeThemeSummary(tempThemesObject.tempThemes[i]) || normalizeThemeSummary(item_dict);
		const incomingWords = extractThemeQuoteCandidates(item_dict)
			.map((quote) => normalizeExcerptCandidate(quote))
			.filter((quote) => quote && (!themeSummary || normalizeExcerptText(quote.word) !== normalizeExcerptText(themeSummary)));
		mergeThemeExcerptWords(tempThemesObject.tempThemes[i], incomingWords);
	}
	mergeSelectedWordsIntoTempThemes();

	try {
		const deletedRes = await fetch(`/api/load_deleted_quotes${projectQueryParam("?")}`);
		if (deletedRes.ok) {
			const deletedData = await deletedRes.json();
			const deletedQuotes = deletedData.deletedQuotes || [];
			for (let i = 0; i < tempThemesObject.tempThemes.length; i++) {
				tempThemesObject.tempThemes[i].words = tempThemesObject.tempThemes[i].words.filter(w =>
					!deletedQuotes.some(d => matchesDeletedQuote(tempThemesObject.tempThemes[i].themeName, w, d))
				);
				tempThemesObject.tempThemes[i].words = dedupeThemeWordEntries(tempThemesObject.tempThemes[i].words);
			}
		}
	} catch (error) {
		console.warn("Could not filter deleted quotes after similar search:", error);
	}

		makeWordClouds();
	}

	async function cancelSimilarExcerptSearch(taskId, buttonNode, { showStoppedToast = true } = {}) {
		if (similarExcerptPollTimer) {
			clearInterval(similarExcerptPollTimer);
			similarExcerptPollTimer = null;
		}
		setSimilarExcerptButtonLoading(buttonNode, false);
		if (!showStoppedToast) {
			d3.select(`#${SIMILAR_EXCERPT_TOAST_ID}`).remove();
		}
		try {
			const response = await fetch(`/task_status/${encodeURIComponent(taskId)}/cancel`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(withProjectPayload({ taskId }))
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok && data.status !== "not_found") {
				throw new Error(data.error || data.message || `HTTP ${response.status}`);
			}
			if (showStoppedToast) {
				showSimilarExcerptToast({
					state: "empty",
					title: "Similar excerpt search stopped",
					message: data.message || "The search was asked to stop and will exit at the next checkpoint.",
					progressPercent: normalizeProgressPercent(data.progressPercent) ?? null,
					autoDismissMs: 7000
				});
			}
		} catch (error) {
			if (!showStoppedToast) {
				console.warn("Could not stop similar excerpt search after closing status:", error);
				return;
			}
			showSimilarExcerptToast({
				state: "error",
				title: "Could not stop search",
				message: error.message || "The similar-excerpt search could not be stopped.",
				autoDismissMs: 9000
			});
		}
	}

	function pollSimilarExcerptTask(taskId, themeName, buttonNode, themeObject) {
		if (similarExcerptPollTimer) {
			clearInterval(similarExcerptPollTimer);
			similarExcerptPollTimer = null;
		}

		let pollCount = 0;
		const startedAt = Date.now();
		similarExcerptPollTimer = setInterval(async () => {
			pollCount += 1;
			try {
			const response = await fetch(`/task_status/${encodeURIComponent(taskId)}?t=${Date.now()}`, { cache: "no-store" });
			const data = await response.json().catch(() => ({}));
			if (!response.ok && data.status !== "not_found") {
				throw new Error(data.error || data.message || `HTTP ${response.status}`);
			}

				if (data.status === "processing" || data.status === "cancelling") {
					const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
					const progressPercent = normalizeProgressPercent(data.progressPercent);
					const phase = getSimilarExcerptPhaseLabel(data.phase);
					setSimilarExcerptButtonLoading(buttonNode, true, progressPercent);
					showSimilarExcerptToast({
						state: "loading",
						title: data.status === "cancelling" ? "Stopping similar excerpt search" : "Finding similar excerpts",
						message: data.message || `Qwen3 is scanning transcripts for ${formatThemeLabel(themeName)}.`,
						detail: buildSimilarExcerptSourceDetail(data, `${progressPercent ?? 0}% - ${phase} - ${elapsedSeconds}s elapsed`),
						progressPercent: progressPercent ?? 0,
						showStop: data.status !== "cancelling",
						onStop: () => cancelSimilarExcerptSearch(taskId, buttonNode),
						onClose: () => cancelSimilarExcerptSearch(taskId, buttonNode, { showStoppedToast: false })
					});
					return;
				}

				clearInterval(similarExcerptPollTimer);
				similarExcerptPollTimer = null;
				setSimilarExcerptButtonLoading(buttonNode, false);

				if (data.status === "done") {
				await refreshMatchingExcerptsFromServer(themeObject, data.topics || null);
				const addedCount = Number(data.addedQuoteCount || 0);
				const matchesFound = Number(data.matchesFound || 0);
				if (addedCount > 0) {
					showSimilarExcerptToast({
						state: "success",
						title: "Similar excerpt search finished",
						message: `Found ${addedCount} new excerpt${addedCount === 1 ? "" : "s"} for ${formatThemeLabel(themeName)}.`,
						detail: buildSimilarExcerptSourceDetail(data, "The matching excerpt list has been refreshed."),
						autoDismissMs: 7000
					});
				} else if (matchesFound > 0) {
					showSimilarExcerptToast({
						state: "empty",
						title: "No new excerpts added",
						message: "Qwen3 found similar text, but it was already listed for this code.",
						detail: buildSimilarExcerptSourceDetail(data, "The matching excerpt list has been refreshed."),
						autoDismissMs: 8000
					});
				} else {
					const emptyDetail = getEmptySimilarExcerptDetail(data.reason);
					showSimilarExcerptToast({
						state: "empty",
						title: "No similar excerpts found",
						message: `No additional excerpts were found for ${formatThemeLabel(themeName)}.`,
						detail: buildSimilarExcerptSourceDetail(data, emptyDetail),
						autoDismissMs: 9000
					});
				}
					return;
				}

				if (data.status === "cancelled") {
					showSimilarExcerptToast({
						state: "empty",
						title: "Similar excerpt search stopped",
						message: data.message || `The search for ${formatThemeLabel(themeName)} was stopped.`,
						progressPercent: normalizeProgressPercent(data.progressPercent) ?? null,
						autoDismissMs: 7000
					});
					return;
				}

			if (data.status === "not_found") {
				showSimilarExcerptToast({
					state: "error",
					title: "Search status unavailable",
					message: data.message || "The similar-excerpt search could not be found.",
					detail: "Start a new search if the excerpts did not refresh.",
					autoDismissMs: 9000
				});
				return;
			}

			showSimilarExcerptToast({
				state: "error",
				title: "Similar excerpt search failed",
				message: data.message || "The search ended unexpectedly.",
				detail: "No excerpts were changed.",
				autoDismissMs: 9000
			});
			} catch (error) {
				clearInterval(similarExcerptPollTimer);
				similarExcerptPollTimer = null;
				setSimilarExcerptButtonLoading(buttonNode, false);
				showSimilarExcerptToast({
				state: "error",
				title: "Similar excerpt search failed",
				message: error.message || "Could not check the search status.",
				detail: "No excerpts were changed.",
				autoDismissMs: 9000
			});
		}
	}, 2000);
}

async function startSimilarExcerptSearch(themeObject, buttonNode) {
	const selectedTheme = String(selectedThemeBoxObject.selectedThemeBox || "").trim();
	if (!selectedTheme) {
		showSimilarExcerptToast({
			state: "empty",
			title: "Select a code first",
			message: "Choose a code on the left, then find similar excerpts for that code.",
			autoDismissMs: 7000
		});
		return;
	}

	const themesToSend = getThemeNamesForSimilarSearch(themeObject);
	if (themesToSend.length === 0) {
		showSimilarExcerptToast({
			state: "error",
			title: "No codes available",
			message: "There are no codes to search against.",
			autoDismissMs: 7000
		});
		return;
	}

		setSimilarExcerptButtonLoading(buttonNode, true);
		showSimilarExcerptToast({
			state: "loading",
			title: "Starting similar excerpt search",
			message: `Preparing Qwen3 to scan transcripts for ${formatThemeLabel(selectedTheme)}.`,
			detail: "0% - Starting",
			progressPercent: 0
		});

	try {
		const response = await fetch("/get_similar_sentences", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(withProjectPayload({
				theme: selectedTheme,
				chosen_themes: themesToSend
			}))
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok && data.status !== "already_running_for_theme") {
			throw new Error(data.error || data.message || `HTTP ${response.status}`);
		}

		if (data.status === "already_running_for_theme") {
				showSimilarExcerptToast({
					state: "loading",
					title: "Search already in progress",
					message: data.message || `A search is already running for ${formatThemeLabel(selectedTheme)}.`,
					detail: buildSimilarExcerptSourceDetail(data, data.task_id ? "Reconnected to the active search." : "Wait for the current search to finish, then refresh if needed."),
					progressPercent: data.task_id ? 0 : null,
					showStop: Boolean(data.task_id),
					onStop: data.task_id ? () => cancelSimilarExcerptSearch(data.task_id, buttonNode) : null,
					onClose: data.task_id ? () => cancelSimilarExcerptSearch(data.task_id, buttonNode, { showStoppedToast: false }) : null,
					autoDismissMs: data.task_id ? 0 : 9000
				});
			if (data.task_id) {
				pollSimilarExcerptTask(data.task_id, selectedTheme, buttonNode, themeObject);
			} else {
				setSimilarExcerptButtonLoading(buttonNode, false);
			}
			return;
		}

			if (data.status === "started" && data.task_id) {
				showSimilarExcerptToast({
					state: "loading",
					title: "Similar excerpt search started",
					message: `Qwen3 is scanning transcripts for ${formatThemeLabel(selectedTheme)}.`,
					detail: buildSimilarExcerptSourceDetail(data, "0% - Scanning transcripts"),
					progressPercent: 0,
					showStop: true,
					onStop: () => cancelSimilarExcerptSearch(data.task_id, buttonNode),
					onClose: () => cancelSimilarExcerptSearch(data.task_id, buttonNode, { showStoppedToast: false })
				});
				pollSimilarExcerptTask(data.task_id, selectedTheme, buttonNode, themeObject);
				return;
		}

		throw new Error(data.error || data.message || "The server did not start the search.");
	} catch (error) {
		setSimilarExcerptButtonLoading(buttonNode, false);
		showSimilarExcerptToast({
			state: "error",
			title: "Could not start search",
			message: error.message || "The similar-excerpt search could not be started.",
			detail: "No excerpts were changed.",
			autoDismissMs: 9000
		});
	}
}

export async function editThemes(themeObject) {
	setMatchingExcerptLoadState("loading");
	const projectId = getCurrentProjectId();
	const selectionPending =
		localStorage.getItem(getThemeSelectionPendingKey(projectId)) === "1" ||
		hasPendingGeneratedThemeCandidates(projectId);
	if (selectionPending) {
		localStorage.removeItem(getThemeSelectionCompleteKey(projectId));
		window.location.href = "/themes";
		return;
	}

	markUsageStep("Review and edit AI-generated codes", {
		stepKey: "ai_code_theme_editing",
		workflow: "ai_assisted_qda",
	});
	// Stop autosave when returning to selection page — prevents stale words persisting
    if (window.__themesAutosaveInterval) {
        clearInterval(window.__themesAutosaveInterval);
        window.__themesAutosaveInterval = null;
	}
	const themesKey = getThemesStorageKey(projectId);
	const normalizeThemeForStorage = (theme) => {
		const themeName = String(theme && theme.themeName ? theme.themeName : "").trim();
		const color = String(theme && theme.color ? theme.color : "").trim() || "#579AE2";
		return {
			themeName,
			color,
			summary: normalizeThemeSummary(theme),
			words: filterThemeSummaryWords(Array.isArray(theme && theme.words) ? structuredClone(theme.words) : [], theme),
			highlight: Array.isArray(theme && theme.highlight) ? structuredClone(theme.highlight) : [],
			groups: Array.isArray(theme && theme.groups) ? structuredClone(theme.groups) : [],
			comment: String(theme && theme.comment || ""),
			...(theme?.codeSource ? { codeSource: theme.codeSource } : {}),
			...(theme?.source ? { source: theme.source } : {}),
			...(theme?.ai_generated === false ? { ai_generated: false } : {}),
			...(theme?.humanTagged === true ? { humanTagged: true } : {}),
			...(theme?.human_tagged === true ? { human_tagged: true } : {})
		};
	};
	const serverThemes = buildPersistedThemePayload({
		themes: (themeObject && Array.isArray(themeObject.themes))
			? themeObject.themes
				.filter(theme => theme && typeof theme === "object" && String(theme.themeName || "").trim() !== "")
				.map(normalizeThemeForStorage)
			: []
	}).themes;
	const serverThemesWithoutSelections = serverThemes.map(theme => ({
		...theme,
		words: []
	}));

	let storedThemes = null;
	let selectedThemesExists = false;
	let selectedThemesLoaded = false;
	try {
		const storedRaw = localStorage.getItem(themesKey);
		if (storedRaw) {
			storedThemes = buildPersistedThemePayload(JSON.parse(storedRaw));
		}
	} catch (e) {
		console.warn("Failed to load stored themes:", e);
	}

	try {
		const savedResponse = await fetch(`/api/load_selected_themes?displayOnly=1&includeUnselectedManual=1&includeGeneratedQuotes=1&t=${Date.now()}${projectQueryParam()}`, { cache: "no-store" });
		if (savedResponse.ok) {
			const savedThemes = await savedResponse.json();
			selectedThemesLoaded = true;
			selectedThemesExists = savedThemes?.selectedThemesExists === true;
			if (savedThemes && Array.isArray(savedThemes.themes) && (selectedThemesExists || savedThemes.themes.length > 0)) {
				storedThemes = buildPersistedThemePayload(savedThemes);
				localStorage.setItem(themesKey, JSON.stringify(storedThemes));
			}
		}
	} catch (e) {
		console.warn("Failed to load saved selected themes:", e);
	}
	if (selectedThemesLoaded && !selectedThemesExists) {
		storedThemes = null;
	}

	const hasStoredThemes = storedThemes && Array.isArray(storedThemes.themes) && storedThemes.themes.length > 0;
	const hasServerThemes = serverThemes.length > 0;
	const storedSelectionIsManualOnly = hasServerThemes && storedSelectionOnlyContainsManualCodes(storedThemes, serverThemes);
	const storedSelectionAddsUnchosenThemes = hasServerThemes && hasStoredThemes && storedSelectionExpandsIncomingThemes(storedThemes, serverThemes);
	const incomingLooksLikeStaleManualOnlyState = hasServerThemes
		&& hasStoredThemes
		&& serverThemes.length <= 1
		&& storedThemes.themes.length > serverThemes.length
		&& themeListHasGeneratedEvidence(storedThemes.themes)
		&& !themeListHasGeneratedEvidence(serverThemes);
	const shouldUseStoredThemes = hasStoredThemes
		&& !storedSelectionIsManualOnly
		&& (!storedSelectionAddsUnchosenThemes || incomingLooksLikeStaleManualOnlyState)
		&& (selectedThemesExists || hasStoredThemes);
	if (storedSelectionIsManualOnly) {
		console.warn("Ignoring manual-only selected themes while generated AI themes are available for matching excerpts.");
	}
	if (storedSelectionAddsUnchosenThemes) {
		if (incomingLooksLikeStaleManualOnlyState) {
			console.warn("Restoring selected AI codes and excerpts over stale manual-only matching state.");
		} else {
			console.warn("Keeping the current code-selection subset for matching excerpts.");
		}
	}

	if (shouldUseStoredThemes && hasStoredThemes && hasServerThemes) {
		storedThemes = buildPersistedThemePayload(mergeStoredThemeMetadata(storedThemes, serverThemes));
		try {
			localStorage.setItem(themesKey, JSON.stringify(storedThemes));
		} catch (e) {
			console.warn("Failed to persist merged theme metadata:", e);
		}
	}

	if (shouldUseStoredThemes) {
		themeObject = {
			...themeObject,
			themes: storedThemes.themes.map(theme => ({
				...theme,
				themeName: theme.themeName,
				color: theme.color,
				summary: normalizeThemeSummary(theme),
				words: filterThemeSummaryWords(Array.isArray(theme.words) ? structuredClone(theme.words) : [], theme),
				highlight: Array.isArray(theme.highlight) ? structuredClone(theme.highlight) : [],
				groups: Array.isArray(theme.groups) ? structuredClone(theme.groups) : [],
				comment: String(theme.comment || "")
			}))
		};
	} else if (hasServerThemes) {
		let syncedThemeList = serverThemesWithoutSelections;
		if (storedSelectionIsManualOnly && hasStoredThemes) {
			const syncedThemeNames = themeNameSet(syncedThemeList);
			syncedThemeList = syncedThemeList.map((serverTheme) => {
				const storedTheme = storedThemes.themes.find(
					(theme) => normalizeThemeNameKey(theme && theme.themeName) === normalizeThemeNameKey(serverTheme && serverTheme.themeName)
				);
				if (!storedTheme || themeHasGeneratedEvidence(serverTheme)) {
					return serverTheme;
				}
				return {
					...serverTheme,
					words: Array.isArray(storedTheme.words) ? structuredClone(storedTheme.words) : [],
					highlight: Array.isArray(storedTheme.highlight) ? structuredClone(storedTheme.highlight) : [],
					groups: Array.isArray(storedTheme.groups) ? structuredClone(storedTheme.groups) : [],
					comment: String(storedTheme.comment || "")
				};
			});
			storedThemes.themes.forEach((storedTheme) => {
				const storedThemeName = normalizeThemeNameKey(storedTheme && storedTheme.themeName);
				if (!storedThemeName || syncedThemeNames.has(storedThemeName)) return;
				syncedThemeList.push({
					...storedTheme,
					themeName: storedTheme.themeName,
					color: storedTheme.color || "#579AE2",
					summary: normalizeThemeSummary(storedTheme),
					words: Array.isArray(storedTheme.words) ? structuredClone(storedTheme.words) : [],
					highlight: Array.isArray(storedTheme.highlight) ? structuredClone(storedTheme.highlight) : [],
					groups: Array.isArray(storedTheme.groups) ? structuredClone(storedTheme.groups) : [],
					comment: String(storedTheme.comment || "")
				});
			});
		}
		const syncedThemes = buildPersistedThemePayload({
			themes: syncedThemeList,
			manualSelectionOptOuts: normalizeManualSelectionOptOuts(storedThemes)
		});
		syncedThemeList = syncedThemes.themes;
		storedThemes = syncedThemes;
		try {
			localStorage.setItem(themesKey, JSON.stringify(syncedThemes));
		} catch (e) {
			console.warn("Failed to sync server theme selection to local storage:", e);
		}
		themeObject = {
			...themeObject,
			themes: syncedThemeList.map(theme => ({
				...theme,
				themeName: theme.themeName,
				color: theme.color,
				summary: normalizeThemeSummary(theme),
				words: filterThemeSummaryWords(Array.isArray(theme.words) ? structuredClone(theme.words) : [], theme),
				highlight: Array.isArray(theme.highlight) ? structuredClone(theme.highlight) : [],
				groups: Array.isArray(theme.groups) ? structuredClone(theme.groups) : [],
				comment: String(theme.comment || "")
			}))
		};
		}

	if (themeObject && Array.isArray(themeObject.themes)) {
		themeObject = {
			...themeObject,
			manualSelectionOptOuts: normalizeManualSelectionOptOuts(storedThemes || themeObject),
			themes: buildPersistedThemePayload({ themes: themeObject.themes }).themes
		};
	}

	const incomingThemes = (themeObject && Array.isArray(themeObject.themes)) ? themeObject.themes : [];
	if (incomingThemes.length === 0) {
		const mainEditWindow = d3.select("#main-edit-window");
		mainEditWindow.selectAll("*").remove();
		mainEditWindow
			.style("display", "flex")
			.style("flex-direction", "column")
			.style("align-items", "center")
			.style("justify-content", "center")
			.style("gap", "16px");

		mainEditWindow.append("div")
			.style("font-family", "Inter")
			.style("font-size", "20px")
			.style("font-weight", "700")
			.style("color", "#2b2b2b")
			.text("No themes available to edit");

		mainEditWindow.append("div")
			.style("font-family", "Inter")
			.style("font-size", "14px")
			.style("color", "#4b5563")
			.text("Generate themes first, then return to this page.");

		mainEditWindow.append("button")
			.style("border-radius", "10px")
			.style("background", "#000000")
			.style("color", "#ffffff")
			.style("padding", "10px 16px")
			.style("font-family", "Inter")
			.style("font-size", "14px")
			.style("font-weight", "700")
			.text("Back to Themes")
			.on("click", function() {
				window.location.href = window.APP_MODE === "demo" ? "/demo/themes" : "/themes";
			});
		return;
	}

	//d3.select("#settings-page").on("click", function() {});
	d3.select("#theme_error_message").remove();
    var mainEditWindow = d3.select("#main-edit-window");
	mainEditWindow.selectAll("*").remove();
	mainEditWindow.style("flex-direction", "row")
		.style("align-items", "normal")
		.style("justify-content", "start")
		.style("position", "relative")
		.style("gap", "0")
		.style("min-width", "0");
	
	// Populating Themes
	selectedThemeBoxObject.selectedThemeBox = themeObject.themes[0].themeName;
	tempThemesObject.tempThemes = [];
	multiSelectedWordsObject.selectedWords = [];
	themesObject.themes = [];
	themesObject.manualSelectionOptOuts = normalizeManualSelectionOptOuts(themeObject);
	themesObject.archivedCodes = structuredClone(
		(storedThemes && Array.isArray(storedThemes.archivedCodes))
			? storedThemes.archivedCodes
			: (Array.isArray(themeObject.archivedCodes) ? themeObject.archivedCodes : [])
	);
	if (Number.isInteger((storedThemes || themeObject).projectRevision)) {
		themesObject.projectRevision = (storedThemes || themeObject).projectRevision;
	}
	tempThemesObject.manualSelectionOptOuts = normalizeManualSelectionOptOuts(themeObject);
	for (var i=0; i < themeObject.themes.length; i++){
		tempThemesObject.tempThemes.push({
			...themeObject.themes[i],
			themeName: themeObject.themes[i].themeName,
			color: themeObject.themes[i].color,
			summary: normalizeThemeSummary(themeObject.themes[i]),
			words: filterThemeSummaryWords(Array.isArray(themeObject.themes[i].words) ? structuredClone(themeObject.themes[i].words) : [], themeObject.themes[i]),
			highlight: Array.isArray(themeObject.themes[i].highlight) ? structuredClone(themeObject.themes[i].highlight) : [],
			groups: Array.isArray(themeObject.themes[i].groups) ? structuredClone(themeObject.themes[i].groups) : [],
			comment: String(themeObject.themes[i].comment || "")
		});
		if (storedThemes && Array.isArray(storedThemes.themes)) {
			const storedTheme = storedThemes.themes.find(
				theme => themeNameKeysMatch(theme && theme.themeName, themeObject.themes[i].themeName)
			) || storedThemes.themes[i];
			themesObject.themes.push({
				...storedTheme,
				themeName: storedTheme.themeName,
				color: storedTheme.color,
				summary: normalizeThemeSummary(themeObject.themes[i]) || normalizeThemeSummary(storedTheme),
				words: filterThemeSummaryWords(Array.isArray(storedTheme.words) ? structuredClone(storedTheme.words) : [], themeObject.themes[i]),
				highlight: storedTheme.highlight ? structuredClone(storedTheme.highlight) : [],
				groups: Array.isArray(storedTheme.groups) ? structuredClone(storedTheme.groups) : [],
				comment: String(storedTheme.comment || "")
			});
		} else {
			themesObject.themes.push({
				...themeObject.themes[i],
				themeName: themeObject.themes[i].themeName,
				color: themeObject.themes[i].color,
				summary: normalizeThemeSummary(themeObject.themes[i]),
				words: filterThemeSummaryWords(Array.isArray(themeObject.themes[i].words) ? structuredClone(themeObject.themes[i].words) : [], themeObject.themes[i]),
				highlight: Array.isArray(themeObject.themes[i].highlight) ? structuredClone(themeObject.themes[i].highlight) : [],
				groups: Array.isArray(themeObject.themes[i].groups) ? structuredClone(themeObject.themes[i].groups) : [],
				comment: String(themeObject.themes[i].comment || "")
			});
		}
	}
	var themes_to_send = [];
	themeObject.themes.forEach(element => {
		themes_to_send.push(element.themeName);
	});
	//demoingObject.demoing=true
	var data;
	let excerptsLoaded = false;
	//Need to fetch actual themes from server
	//Check if already selectedThemes.json exists and loads.
	try {
			const savedRes = await fetch(`/api/load_selected_themes?displayOnly=1&includeUnselectedManual=1&includeGeneratedQuotes=1&t=${Date.now()}${projectQueryParam()}`, { cache: "no-store" });
		if (savedRes.ok) {
				const savedData = await savedRes.json();
				if (savedData && Array.isArray(savedData.themes)) {
					buildPersistedThemePayload(savedData).themes.forEach(saved => {
						const live = themesObject.themes.find(
						t => themeNameKeysMatch(t && t.themeName, saved && saved.themeName)
					);
					if (live && Array.isArray(saved.words) && saved.words.length > 0) {
						live.words = structuredClone(saved.words);
					}
				});
			}
		}
	} catch(e) {
		console.warn("Could not restore saved words:", e);
	}
	try {
		data = await fetch("/get_chosen_themes", {
			method: "POST",
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
				body: JSON.stringify(withProjectPayload({ themes: themes_to_send }))
		})
		.then(function(response){
			if (!response.ok) {
				throw new Error(`get_chosen_themes failed: ${response.status}`);
			}
			return response.json();
		}).then(function(data) {
			excerptsLoaded = true;
			return data;
		});
	} catch (error) {
		console.error("Failed to load chosen themes:", error);
		data = {};
	}
	window.__matchingExcerptsByTheme = data || {};
	let generatedFallbackData = null;
	try {
		const generatedRes = await fetch(`/api/load_ai_generated?t=${Date.now()}${projectQueryParam()}`, { cache: "no-store" });
		if (generatedRes.ok) {
			generatedFallbackData = await generatedRes.json();
			window.__aiGeneratedThemesByTheme = generatedFallbackData || {};
		}
	} catch (error) {
		console.warn("Failed to load generated excerpt fallback:", error);
	}
	// An empty fallback response cannot explain away a failed primary request.
	const fallbackThemeNames = themes_to_send.filter(themeName => {
		const payload = getThemePayloadByName(generatedFallbackData, themeName);
		return payload !== null && typeof payload === "object";
	});
	setMatchingExcerptLoadState(excerptsLoaded ? "ready" : "error", fallbackThemeNames);
	//Parse the JSON result
	for (var i = 0; i< themes_to_send.length;i++){
		let item_dict = getThemePayloadByName(data, themes_to_send[i])
			|| getThemePayloadByName(generatedFallbackData, themes_to_send[i]);
		if (!item_dict && demoingObject.demoing) {
			try {
				const fallbackTopics = await d3.json(`/demo/api/load_ai_generated?t=${Date.now()}${projectQueryParam()}`);
				item_dict = getThemePayloadByName(fallbackTopics, themes_to_send[i]);
			} catch (fallbackError) {
				console.warn("Could not load demo excerpt fallback:", fallbackError);
			}
		}
		if (!item_dict) {
			console.warn("No quote payload found for theme:", themes_to_send[i]);
			continue;
		}
		const quoteCandidates = extractThemeQuoteCandidates(item_dict);
		const themeSummary = normalizeThemeSummary(tempThemesObject.tempThemes[i]) || normalizeThemeSummary(item_dict);
		if (themeSummary && !normalizeThemeSummary(tempThemesObject.tempThemes[i])) {
			tempThemesObject.tempThemes[i].summary = themeSummary;
		}
		let nextWords = [];
		for(var j = 0; j< quoteCandidates.length; j++){
			const normalizedQuote = normalizeExcerptCandidate(quoteCandidates[j]);
			if (!normalizedQuote) continue;
			if (themeSummary && normalizeExcerptText(normalizedQuote.word) === normalizeExcerptText(themeSummary)) continue;
			nextWords.push(normalizedQuote);
			// tempThemesObject.tempThemes[i].words[j] = item_dict[item_dict_keys[j]]
		}
		mergeThemeExcerptWords(tempThemesObject.tempThemes[i], nextWords);
	}
	mergeSelectedWordsIntoTempThemes();
	//Filter deleted quotes before rerendering
	try {
			const deletedRes = await fetch(`/api/load_deleted_quotes${projectQueryParam("?")}`);
		if (deletedRes.ok) {
			const deletedData = await deletedRes.json();
			const deletedQuotes = deletedData.deletedQuotes || [];
			for (let i = 0; i < tempThemesObject.tempThemes.length; i++) {
				tempThemesObject.tempThemes[i].words = tempThemesObject.tempThemes[i].words.filter(w =>
					!deletedQuotes.some(d => matchesDeletedQuote(tempThemesObject.tempThemes[i].themeName, w, d))
				);
				tempThemesObject.tempThemes[i].words = dedupeThemeWordEntries(tempThemesObject.tempThemes[i].words);
			}
		}
	} catch(e) {
		console.warn("Could not filter deleted quotes:", e);
	}


	mainEditWindow.append("div")
		.attr("id", "themeList")
		.style("height", "100%")
		.style("width", "clamp(270px, 19vw, 320px)")
		.style("flex", "0 0 clamp(270px, 19vw, 320px)")
		.style("padding", "56px 12px 88px 34px")
		.style("gap", "4px")
		.style("display", "flex")
		.style("flex-direction", "column")
		.style("flex-wrap", "nowrap")
		.style("align-content", "flex-start")
		.style("justify-content", "flex-start")
		.style("box-sizing", "border-box")
		.style("overflow", "auto");

    // Word Cloud
	mainEditWindow.append("div")
        .attr("id", "word-cloud")
		.style("height", "100%")
		.style("flex", "1 1 0")
		.style("min-width", "0")
		.style("position", "relative")
		.style("padding-bottom", "70px")
    	.style("box-sizing", "border-box")
		.style("border-radius", "0px 10px 10px 0px")
		.style("display", "flex")
		.style("flex-direction", "column")
		.style("align-items", "stretch")
		.style("overflow","auto");

	try {
		makeThemeBoxes(108, 220, themeObject);
	} catch (error) {
		console.error("Failed to render matching code cards:", error);
	}

	try {
		makeWordClouds();
		setTimeout(() => window.__ensureMatchingExcerptsVisible?.("initial-editThemes-render"), 0);
	} catch (error) {
		renderBasicMatchingExcerptsFallback(error);
	}
	startThemeAutosave(themesKey);

// Keep track of the currently selected theme
var selectedThemeName = null;
// Example: set selectedThemeName when a theme box is clicked
// Make sure your theme boxes have class "theme-box" and data-theme attribute
// d3.selectAll(".theme-box")
//   .on("click", function(event, d) {
//       selectedThemeName = d.themeName;
//   });

		const topActions = mainEditWindow.append("div")
			.attr("id", "themeTopActions")
			.style("position", "absolute")
			.style("top", "clamp(8px, 1.2vw, 16px)")
			.style("right", "clamp(12px, 1.6vw, 24px)")
			.style("z-index", "5")
			.style("display", "flex")
			.style("align-items", "center")
			.style("justify-content", "flex-end")
			.style("gap", "8px")
			.style("max-width", "calc(100% - 24px)")
			.style("flex-wrap", "wrap");

		const findSimilarButton = topActions.append("button")
			.attr("type", "button")
			.attr("aria-label", "Find similar excerpts for the selected code")
			.attr("title", "Ask Qwen3 to scan transcripts for more excerpts similar to the selected code")
			.style("height", "clamp(32px, 3vw, 40px)")
			.style("border-radius", "10px")
			.style("background", "#3A61DD")
			.style("border", "1px solid #3156d4")
			.style("color", "#ffffff")
			.style("padding", "0 clamp(10px, 1.2vw, 14px)")
			.style("font-family", "Inter")
			.style("font-size", "clamp(12px, 1vw, 14px)")
			.style("font-weight", 800)
			.style("display", "inline-flex")
			.style("align-items", "center")
			.style("justify-content", "center")
			.style("gap", "7px")
			.style("white-space", "nowrap")
			.style("cursor", "pointer")
			.on("mouseover", function() {
				if (!this.disabled) d3.select(this).style("background", "#2449b8");
			})
			.on("mouseout", function() {
				if (!this.disabled) d3.select(this).style("background", "#3A61DD");
			})
			.on("click", function() {
				if (d3.event) {
					d3.event.preventDefault();
					d3.event.stopPropagation();
				}
				void startSimilarExcerptSearch(themeObject, this);
			});
		findSimilarButton.append("img")
			.attr("src", "/static/images/search.svg")
			.attr("alt", "")
			.style("width", "16px")
			.style("height", "16px")
			.style("filter", "brightness(0) invert(1)");
		findSimilarButton.append("span")
			.attr("class", "similar-excerpt-button-label")
			.text("Find Similar Excerpts");

		// ADD archive button:
		var archiveButton = topActions.append("button")
			.style("border-radius", "10px")
			.style("background", "#f3f4f6")
			.style("border", "1px solid #d1d5db")
			.style("color", "#374151")
			.style("height", "clamp(32px, 3vw, 40px)")
			.style("padding", "0 clamp(10px, 1.2vw, 14px)")
			.style("font-family", "Inter")
			.style("font-size", "clamp(12px, 1vw, 14px)")
			.style("font-weight", 700)
			.style("cursor", "pointer")
			.on("click", async function() {
			// Navigate to archive page via JS — pass themeObject state first
			try {
				const res = await fetch('/themes/edit', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(withProjectPayload(themesObject)),
				});

				if (!res.ok) throw new Error("Failed to save themes");

				showArchivePage(themesObject);
			} catch (err) {
				console.error(err);
			}
		});

	// Update button text with count
	async function updateArchiveButtonCount() {
		try {
			const res = await fetch(`/api/load_deleted_quotes${projectQueryParam("?")}`);
			if (res.ok) {
				const data = await res.json();
				const archivedQuoteCount = (data.deletedQuotes || []).length;
				const archivedCodeCount = Array.isArray(themesObject.archivedCodes)
					? themesObject.archivedCodes.length
					: 0;
				const count = archivedQuoteCount + archivedCodeCount;
				archiveButton.text(count > 0 ? `Archive (${count})` : "Archive");
			}
		} catch(e) {
			archiveButton.text("Archive");
		}
		}
		updateArchiveButtonCount();


		var helpButton = topActions.append("button")
			.attr("aria-label", "Show code matching instructions")
			.attr("title", "Show code matching instructions")
			.style("height", "clamp(32px, 3vw, 40px)")
			.style("border-radius", "999px")
			.style("background", "#ffffff")
			.style("border", "1px solid #d1d5db")
			.style("box-shadow", "0 2px 6px rgba(17, 24, 39, 0.08)")
			.style("color", "#374151")
			.style("padding", "0 clamp(9px, 1vw, 12px)")
			.style("display", "inline-flex")
			.style("align-items", "center")
			.style("gap", "6px")
			.style("font-family", "Inter")
			.style("font-size", "clamp(11px, 0.95vw, 13px)")
			.style("font-weight", 800)
			.style("letter-spacing", "0")
			.style("cursor", "pointer")
			.on("mouseover", function() {
				d3.select(this).style("background", "#eef2ff").style("border-color", "#c7d2fe");
			})
			.on("mouseout", function() {
				d3.select(this).style("background", "#ffffff").style("border-color", "#d1d5db");
			})
			.on("click", function() {
				void showThemeEditOnboarding();
			});
		helpButton.append("span")
			.style("width", "18px")
			.style("height", "18px")
			.style("border-radius", "50%")
			.style("display", "inline-flex")
			.style("align-items", "center")
			.style("justify-content", "center")
			.style("background", "#4f46e5")
			.style("color", "#ffffff")
			.style("font-size", "12px")
			.style("font-weight", 900)
			.text("?");
		helpButton.append("span").text("Help");

	var nextButton = mainEditWindow.append("button")
		.style("position", "absolute")
		.style("border-radius", "10px")
		.style("background", "#000000")
		.style("bottom", "20px")
		.style("right", "20px")
		.style("color", "#ffffff")
		.style("padding", "12px 20px 12px 20px")
		.style("font-family", "Inter")
		.style("font-size", "16px")
		.style("font-weight", 700)
		.text("Next")
		.on("click", function() {
			void saveSelectedThemesAndContinue(this);
		});


    mainEditWindow.append("button")
        .attr("class", "matching-review-button")
        .text("Review codes")
        .on("click", function () {
            mainEditWindow.style("justify-content", "center");
            editThemesMore();
        });

	var backButton = mainEditWindow.append("button")
		.style("position", "absolute")
		.style("border-radius", "10px")
		.style("background", "#ececf0")
		.style("bottom", "20px")
		.style("left", "20px")
		.style("padding", "12px 20px 12px 20px")
		.style("font-family", "Inter")
		.style("font-size", "16px")
		.style("font-weight", 700)
		.text("Back")
		.on("click", function() {
			window.location.href = "/themes";
		});
	
	void maybeShowThemeEditOnboarding();
}
function startThemeAutosave(themesKey) {
	if (window.__themesAutosaveInterval) {
		clearInterval(window.__themesAutosaveInterval);
	}
	window.__themesAutosaveInterval = setInterval(() => {
		try {
			localStorage.setItem(themesKey, JSON.stringify(themesObject));
		} catch (e) {
			console.warn("Failed to auto-save themes:", e);
		}
	}, 2000);
}

function onboardingPopUps() {
	const helpSteps = [
		{
			title: "Codes are idea groups",
			body: "Codes are categories that collect coded excerpts, helping you spot important and recurring ideas in the transcript."
		},
		{
			title: "Each code can hold related excerpts",
			body: "A code can include several related excerpts, so you can quickly understand what that code is about."
		},
		{
			title: "Use the excerpt list on the right",
			body: "The right-side list shows transcript excerpts that may fit the selected code. These suggestions can help you build or refine that code."
		},
		{
			title: "Add excerpts to a code",
			body: "Select an excerpt card to keep it in the currently selected code. You can also remove excerpts that do not belong."
		},
		{
			title: "Remove excerpts when needed",
			body: "Hover over an excerpt inside a code and click the red X to remove it from that code."
		}
	];

	const closeHelp = () => {
		d3.select("#popUpHolder").remove();
		d3.select("#onboarding").remove();
	};

	var popUpHolder = d3.select("#settings-page")
		.append("div")
		.attr("id", "popUpHolder")
		.style("position", "absolute")
		.style("top", "50%")
		.style("left", "50%")
		.style("transform", "translate(-50%, -50%)")
		.style("background", "#ffffff")
		.style("z-index", 31)
		.style("width", "min(980px, calc(100vw - 72px))")
		.style("max-height", "min(760px, calc(100vh - 72px))")
		.style("display", "flex")
		.style("flex-direction", "column")
		.style("border", "1px solid #e5e7eb")
		.style("border-radius", "18px")
		.style("box-shadow", "0 24px 70px rgba(15, 23, 42, 0.24)")
		.style("font-family", "Inter")
		.style("color", "#111827")
		.style("overflow", "hidden");

	const header = popUpHolder.append("div")
		.style("display", "flex")
		.style("align-items", "flex-start")
		.style("justify-content", "space-between")
		.style("gap", "18px")
		.style("padding", "26px 30px 20px 30px")
		.style("border-bottom", "1px solid #e5e7eb");

	const headerText = header.append("div")
		.style("display", "flex")
		.style("flex-direction", "column")
		.style("gap", "8px");

	headerText.append("div")
		.style("display", "inline-flex")
		.style("align-items", "center")
		.style("gap", "8px")
		.style("width", "fit-content")
		.style("padding", "5px 10px")
		.style("border-radius", "999px")
		.style("background", "#eef2ff")
		.style("color", "#3b5bdb")
		.style("font-size", "12px")
		.style("font-weight", "800")
		.text("Code help");

	headerText.append("div")
		.style("font-size", "26px")
		.style("font-weight", "800")
		.style("line-height", "1.2")
		.text("Build and adjust your codes");

	headerText.append("div")
		.style("max-width", "760px")
		.style("font-size", "15px")
		.style("line-height", "1.55")
		.style("font-weight", "500")
		.style("color", "#4b5563")
		.text("Use codes to organize repeated ideas, then add or remove suggested excerpts as you review the transcript.");

	header.append("button")
		.attr("aria-label", "Close help")
		.style("width", "38px")
		.style("height", "38px")
		.style("border", "1px solid #d1d5db")
		.style("border-radius", "999px")
		.style("background", "#ffffff")
		.style("color", "#374151")
		.style("font-size", "22px")
		.style("line-height", "1")
		.style("font-weight", "700")
		.style("cursor", "pointer")
		.text("×")
		.on("click", closeHelp);

	const content = popUpHolder.append("div")
		.style("display", "grid")
		.style("grid-template-columns", "repeat(auto-fit, minmax(min(100%, 320px), 1fr))")
		.style("gap", "24px")
		.style("padding", "24px 30px 28px 30px")
		.style("overflow", "auto");

	const stepsColumn = content.append("div")
		.style("display", "flex")
		.style("flex-direction", "column")
		.style("gap", "12px");

	helpSteps.forEach((step, index) => {
		const stepCard = stepsColumn.append("div")
			.style("display", "grid")
			.style("grid-template-columns", "34px 1fr")
			.style("gap", "12px")
			.style("padding", "14px")
			.style("border", "1px solid #e5e7eb")
			.style("border-radius", "12px")
			.style("background", index === 0 ? "#f8fbff" : "#ffffff")
			.style("box-shadow", "0 8px 20px rgba(15, 23, 42, 0.05)");

		stepCard.append("div")
			.style("width", "30px")
			.style("height", "30px")
			.style("display", "flex")
			.style("align-items", "center")
			.style("justify-content", "center")
			.style("border-radius", "999px")
			.style("background", "#eef2ff")
			.style("color", "#3b5bdb")
			.style("font-size", "13px")
			.style("font-weight", "800")
			.text(index + 1);

		const stepCopy = stepCard.append("div")
			.style("display", "flex")
			.style("flex-direction", "column")
			.style("gap", "5px");

		stepCopy.append("div")
			.style("font-size", "15px")
			.style("font-weight", "800")
			.style("line-height", "1.25")
			.text(step.title);

		stepCopy.append("div")
			.style("font-size", "13px")
			.style("font-weight", "500")
			.style("line-height", "1.45")
			.style("color", "#4b5563")
			.text(step.body);
	});

	const preview = content.append("div")
		.style("border", "1px solid #dbe4f0")
		.style("border-radius", "16px")
		.style("background", "linear-gradient(180deg, #f8fbff 0%, #ffffff 100%)")
		.style("padding", "18px")
		.style("display", "flex")
		.style("flex-direction", "column")
		.style("gap", "16px")
		.style("min-height", "360px");

	preview.append("div")
		.style("font-size", "15px")
		.style("font-weight", "800")
		.text("Current code workspace");

	preview.append("div")
		.style("margin-top", "-8px")
		.style("font-size", "12px")
		.style("font-weight", "600")
		.style("line-height", "1.45")
		.style("color", "#6b7280")
		.text("Choose a code, then review the transcript excerpts that explain it.");

	const mockWorkspace = preview.append("div")
		.style("display", "grid")
		.style("grid-template-columns", "1fr 1fr")
		.style("gap", "14px")
		.style("align-items", "stretch");

	const themeMock = mockWorkspace.append("div")
		.style("display", "flex")
		.style("flex-direction", "column")
		.style("gap", "10px");

	[
		{
			name: "Tool evaluation",
			detail: "Participants describe when the tool helps and where its summaries still need review."
		},
		{
			name: "Data privacy",
			detail: "Participants discuss how uploaded interview content should be protected."
		},
		{
			name: "Explainability",
			detail: "Participants want to understand why a suggested code fits an excerpt."
		}
	].forEach((theme, index) => {
		const card = themeMock.append("div")
			.style("min-height", "76px")
			.style("border", "1px solid #e5e7eb")
			.style("border-left", `7px solid ${["#E7A23B", "#8E41D1", "#579AE2"][index]}`)
			.style("border-radius", "10px")
			.style("background", "#ffffff")
			.style("box-shadow", "0 6px 14px rgba(15, 23, 42, 0.06)")
			.style("padding", "11px 12px")
			.style("box-sizing", "border-box");

		card.append("div")
			.style("font-size", "13px")
			.style("font-weight", "800")
			.text(theme.name);

		card.append("div")
			.style("margin-top", "6px")
			.style("font-size", "11px")
			.style("font-weight", "600")
			.style("line-height", "1.35")
			.style("color", "#6b7280")
			.text(theme.detail);

		card.append("div")
			.style("display", "inline-flex")
			.style("margin-top", "10px")
			.style("padding", "4px 8px")
			.style("border-radius", "999px")
			.style("background", index === 0 ? "#111827" : "#e5e7eb")
			.style("color", index === 0 ? "#ffffff" : "#6b7280")
			.style("font-size", "11px")
			.style("font-weight", "800")
			.text(index === 0 ? "2 selected" : "0 selected");
	});

	const excerptMock = mockWorkspace.append("div")
		.style("display", "flex")
		.style("flex-direction", "column")
		.style("gap", "10px")
		.style("padding", "12px")
		.style("border", "1px dashed #c7d2fe")
		.style("border-radius", "12px")
		.style("background", "#ffffff");

	excerptMock.append("div")
		.style("font-size", "12px")
		.style("font-weight", "800")
		.style("color", "#4b5563")
		.text("Suggested excerpts");

	[
		"Participants describe the AI tool as useful for summarizing long interviews, but they still want to check the results themselves.",
		"One participant worries that private stories could be shared with outside systems if data is uploaded without care.",
		"Several comments connect explainability with trust, especially when researchers need to understand why a code was suggested."
	].forEach((excerpt, index) => {
		const card = excerptMock.append("div")
			.style("display", "flex")
			.style("align-items", "flex-start")
			.style("justify-content", "space-between")
			.style("gap", "8px")
			.style("padding", "10px 12px")
			.style("border-radius", "10px")
			.style("background", index % 2 === 0 ? "#eef2ff" : "#f3f4f6")
			.style("color", "#111827")
			.style("font-size", "12px")
			.style("font-weight", "650")
			.style("line-height", "1.4");

		card.append("span")
			.style("flex", "1")
			.text(excerpt);
		card.append("span")
			.style("color", "#ef4444")
			.style("font-weight", "900")
			.style("line-height", "1")
			.text("×");
	});

	preview.append("div")
		.style("padding", "12px 14px")
		.style("border-radius", "12px")
		.style("background", "#f9fafb")
		.style("color", "#4b5563")
		.style("font-size", "13px")
		.style("font-weight", "600")
		.style("line-height", "1.45")
		.text("Tip: keep only excerpts that help explain the code. You can always change these choices later.");

	const footer = popUpHolder.append("div")
		.style("display", "flex")
		.style("justify-content", "flex-end")
		.style("padding", "0 30px 26px 30px");

	footer.append("button")
		.style("min-width", "112px")
		.style("height", "42px")
		.style("border", "none")
		.style("border-radius", "10px")
		.style("background", "#111827")
		.style("color", "#ffffff")
		.style("font-size", "14px")
		.style("font-weight", "800")
		.style("cursor", "pointer")
		.text("Got it")
		.on("click", closeHelp);
}
