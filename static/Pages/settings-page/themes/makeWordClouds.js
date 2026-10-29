import {
    EXCERPT_SELF_RATING_HELP,
    compareExcerptSelfRatings,
    formatConfidenceThreshold,
    getExcerptRatingExplanation,
    getExcerptSelfRating,
    getExcerptSourceBadgeLabel,
    passesExcerptSelfRating
} from "./excerptConfidence.js";
/*
import { makeThemeBoxes } from "./makeThemeBoxes.js?v=20260620b";
import { selectedThemeBoxObject, tempThemesObject, wordCloudShapeObject } from "../../chromascribe-main.js";
import { dragWordFromCloud } from "./dragWords.js";

export function makeWordClouds() {
    var wordCloud = d3.select("#word-cloud");
	wordCloud.selectAll("*").remove();
	wordCloudShapeObject.wordCloudShape = wordCloud.append("div")
		.attr("id", "wordCloudShape")
		.style("margin-top", "15%")
		.style("margin-bottom", "15%")
		.style("width", "90%")
		.style("border-radius", "50%")
		.style("display", "flex")
		.style("flex-wrap", "wrap")
		.style("justify-content", "center")
		.style("align-items", "center")
		.style("font-size", "10px");
	for (var i=0; i<tempThemesObject.tempThemes.length; i++){
		if (tempThemesObject.tempThemes[i].themeName === selectedThemeBoxObject.selectedThemeBox){
			for (var j=0; j<tempThemesObject.tempThemes[i].words.length; j++){
				// if (tempThemesObject.tempThemes[i].words[j].word != selectedThemeBoxObject.selectedThemeBox){
				if (tempThemesObject.tempThemes[i].words[j] != selectedThemeBoxObject.selectedThemeBox){
					wordCloudShapeObject.wordCloudShape.append("div")
						.attr("id", j)
						.attr("class", "sections")
						.style("border-radius", "5px")
						.style("border", "2px solid #F4F4F4")
						.style("margin", "10px")
						.style("padding", "5px 10px 5px 10px")
						/* -> old stuff.
						.style("font-size", function() {
							var value = tempThemesObject.tempThemes[i].words[j].value;
							if (value >= 0 && value < 0.1)
								return "12px";
							if (value >= 0.1 && value < 0.2)
								return "13px";
							if (value >= 0.2 && value < 0.3)
								return "14px";
							if (value >= 0.3 && value < 0.4)
								return "15px";
							if (value >= 0.4 && value < 0.5)
								return "16px";
							if (value >= 0.5 && value < 0.6)
								return "20px";
							if (value >= 0.6 && value < 0.7)
								return "24px";
							if (value >= 0.7 && value < 0.8)
								return "32px";
							return "36px";
						})*/
						/*
						.style("font-size", "16px")
						.style("align-content", "center")
						.style("cursor", "pointer")
						.text(tempThemesObject.tempThemes[i].words[j])
						.call(dragWordFromCloud);
				}
			}
		}
	}

	var themeCloudCode = wordCloud.append("div")
		.attr("id", "themeCloudCode")
		.style("position", "absolute")
		.style("background", "#f4f4f4")
		.style("border-radius", "26px")
		.style("padding", "10px 15px 10px 15px")
		.style("bottom", "90px")
		.style("display", "flex")
		.style("flex-direction", "row")
		.style("align-items", "center");

	for (var i=0; i< tempThemesObject.tempThemes.length; i++){
		var circle = themeCloudCode.append("button")
			.attr("id", "circle_"+tempThemesObject.tempThemes[i].themeName)
			.style("margin", "5px")
			.style("background", "#4e4e4e")
			.style("width", "10px")
			.style("height", "12px")
			.style("border-radius", "50%");
		if (tempThemesObject.tempThemes[i].themeName === selectedThemeBoxObject.selectedThemeBox){
			circle.style("width", "15px")
				.style("height", "15px")
				.style("background", tempThemesObject.tempThemes[i].color)
		}
		circle.on("click", function() {
			selectedThemeBoxObject.selectedThemeBox = this.id.substring(7);
			makeThemeBoxes(108, 220);
			makeWordClouds();
		})
	}
}
*/
import { makeThemeBoxes } from "./makeThemeBoxes.js?v=20260921a";
import {
	selectedThemeBoxObject,
	themesObject,
	tempThemesObject,
	multiSelectedWordsObject,
	wordCloudShapeObject,
	themeObject
} from "../../../chromascribe-main.js";
import {
	buildThemeExcerptEntry,
	buildPersistedThemePayload,
	buildThemeWordIdentityKey,
	colorToRgba,
	dedupeThemeWordEntries,
	normalizeThemeExcerptIdentityText,
	normalizeThemeWordText,
	persistThemePayloadLocally,
	resolveThemeWordParticipantLabel,
	isManualExcerptEffectivelySelected,
	isManualThemeWordEntry,
	normalizeManualSelectionOptOuts,
	setManualCodeSelection,
	setManualExcerptSelection
} from "../../themePersistence.js?v=20260901b";
import {
	EXCERPT_CONFIDENCE_STEP_PERCENT,
	getExcerptConfidenceThreshold,
	MAX_EXCERPT_CONFIDENCE_THRESHOLD,
	MIN_EXCERPT_CONFIDENCE_THRESHOLD,
	setExcerptConfidenceThreshold
} from "./excerptConfidenceSettings.js?v=20260901c";
import { appendMatchingExcerptNotice } from "./matchingExcerptNotice.js?v=20260921a";

function getCurrentProjectId() {
	const params = new URLSearchParams(window.location.search || "");
	const urlProjectId = params.get("projectId") || params.get("project_id");
	if (urlProjectId && urlProjectId.trim()) return urlProjectId.trim();
	const rawValue = localStorage.getItem("currentProjectId");
	if (typeof rawValue === "string" && rawValue.trim()) return rawValue.trim();
	const serverProjectId = window.CURRENT_PROJECT_ID;
	return typeof serverProjectId === "string" ? serverProjectId.trim() : "";
}

function projectQueryParam() {
	const projectId = getCurrentProjectId();
	return projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
}

function withProjectPayload(payload) {
	const projectId = getCurrentProjectId();
	return projectId ? { ...payload, projectId } : payload;
}

function recordMatchingExcerptSelection(themeName, wordElement, selected) {
	const logger = window.ChromaUsageLogger;
	if (!logger || typeof logger.recordFeatureEvent !== "function") {
		return;
	}
	const text = String(wordElement && (wordElement.word || wordElement.text || "") || "").replace(/\s+/g, " ").trim();
	logger.recordFeatureEvent("manual_coding", "matching_excerpt_selection", {
		codeName: themeName || "",
		selected: Boolean(selected),
		participant: resolveThemeWordParticipantLabel(wordElement) || "",
		tag: wordElement && wordElement.tag ? String(wordElement.tag) : "",
		timestamp: wordElement && wordElement.timestamp ? String(wordElement.timestamp) : "",
		textLength: text.length,
		wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0
	}, {
		excerptSelections: selected ? 1 : 0,
		excerptDeselections: selected ? 0 : 1
	});
}

let aiGeneratedData = null;
fetch(`/api/load_ai_generated${projectQueryParam()}${projectQueryParam() ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" })
    .then(r => r.json())
    .then(data => {
		aiGeneratedData = data;
		if (selectedThemeBoxObject.selectedThemeBox && !d3.select("#word-cloud").empty()) {
			makeWordClouds();
		}
	})
    .catch(() => {});


function buildThemeSelectionKey(themeName, wordElement) {
	return `${String(themeName || "").trim().toLowerCase()}::${buildThemeWordIdentityKey(wordElement)}`;
}

function getVisibleExcerptText(wordElement) {
	if (typeof wordElement === "string") {
		return normalizeThemeWordText(wordElement);
	}
	if (!wordElement || typeof wordElement !== "object") return "";
	return normalizeThemeWordText(
		wordElement.word
		|| wordElement.text
		|| wordElement.excerpt
		|| wordElement.quote
		|| wordElement.cueText
		|| ""
	);
}

function buildVisibleExcerptTextKey(wordElement) {
	return buildLooseExcerptDuplicateKey(getVisibleExcerptText(wordElement));
}

function buildLooseExcerptDuplicateKey(rawValue) {
	return normalizeThemeExcerptIdentityText(rawValue)
		.replace(/[\u201c\u201d\u2018\u2019"'`]/g, "")
		.replace(/\u2026/g, " ")
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function getExcerptContextKey(wordElement) {
	const entry = buildThemeExcerptEntry(wordElement);
	if (!entry) return "";
	return [
		String(entry.participant || "").trim().toLowerCase(),
		String(entry.tag || "").trim().toLowerCase()
	].join("||");
}

function areVisibleExcerptTextsDuplicates(leftWordElement, rightWordElement) {
	const leftTextKey = buildVisibleExcerptTextKey(leftWordElement);
	const rightTextKey = buildVisibleExcerptTextKey(rightWordElement);
	if (!leftTextKey || !rightTextKey) return false;
	if (leftTextKey === rightTextKey) return true;

	const leftContextKey = getExcerptContextKey(leftWordElement);
	const rightContextKey = getExcerptContextKey(rightWordElement);
	if (!leftContextKey || leftContextKey === "||" || leftContextKey !== rightContextKey) return false;

	const shorterTextKey = leftTextKey.length <= rightTextKey.length ? leftTextKey : rightTextKey;
	const longerTextKey = leftTextKey.length > rightTextKey.length ? leftTextKey : rightTextKey;
	if (shorterTextKey.length < 32) return false;
	return longerTextKey.includes(shorterTextKey);
}

function preferDuplicateExcerptEntry(existingEntry, candidateEntry, themeName) {
	const existingWord = existingEntry.wordElement || existingEntry;
	const candidateWord = candidateEntry.wordElement || candidateEntry;
	const existingTextKey = buildVisibleExcerptTextKey(existingWord);
	const candidateTextKey = buildVisibleExcerptTextKey(candidateWord);
	if (existingTextKey && candidateTextKey && existingTextKey !== candidateTextKey) {
		const existingSelected = isPersistedThemeWord(themeName, existingWord);
		const candidateSelected = isPersistedThemeWord(themeName, candidateWord);
		if (candidateSelected !== existingSelected) return candidateSelected ? candidateEntry : existingEntry;
		if (existingTextKey.length !== candidateTextKey.length) {
			return existingTextKey.length < candidateTextKey.length ? existingEntry : candidateEntry;
		}
	}
	return preferExcerptEntry(existingEntry, candidateEntry, themeName);
}

let selectedThemeProgressSaveTimer = null;
let selectedThemeProgressDirty = false;
let selectedThemeProgressSaveVersion = 0;
let selectedThemeProgressPaused = false;
const pendingSelectedThemeSaves = new Set();

function isExplicitMatchingSelection(wordEntry) {
	return Boolean(
		wordEntry
		&& typeof wordEntry === "object"
		&& (
			wordEntry.selectedInMatching === true
			|| wordEntry.matchingSelection === true
			|| wordEntry.selectionStage === "matching_excerpts_selected"
			|| (wordEntry.selectedByUser === true && wordEntry.selectionSource === "matching_excerpts")
		)
	);
}

function buildSelectedMatchingExcerptEntry(wordEntry) {
	const entry = buildAiTaggedThemeWord(wordEntry);
	return entry
		? buildThemeExcerptEntry(entry, {
			selectedByUser: true,
			selectedInMatching: true,
			matchingSelection: true,
			selectionSource: "matching_excerpts",
			selectionStage: "matching_excerpts_selected"
		})
		: null;
}

function getExplicitSelectedWordsForTheme(themeName) {
	const progressWords = Array.isArray(multiSelectedWordsObject && multiSelectedWordsObject.selectedWords)
		? multiSelectedWordsObject.selectedWords.filter(selection => themeNamesMatch(selection && selection.themeName, themeName))
		: [];
	const theme = findThemeByName(themesObject && themesObject.themes, themeName);
	const markedThemeWords = Array.isArray(theme && theme.words)
		? theme.words.filter(word => (
			isManualThemeWordEntry(word)
				? isManualExcerptEffectivelySelected(themesObject, themeName, word)
				: isExplicitMatchingSelection(word)
		))
		: [];
	const tempTheme = findThemeByName(tempThemesObject && tempThemesObject.tempThemes, themeName);
	const markedTempThemeWords = Array.isArray(tempTheme && tempTheme.words)
		? tempTheme.words.filter(word => (
			isManualThemeWordEntry(word)
				? isManualExcerptEffectivelySelected(themesObject, themeName, word)
				: isExplicitMatchingSelection(word)
		))
		: [];

	return dedupeThemeWordEntries(
		[...progressWords, ...markedThemeWords, ...markedTempThemeWords]
			.map(buildSelectedMatchingExcerptEntry)
			.filter(Boolean)
	);
}

function buildMatchingExcerptSelectionPayload() {
	const persistedPayload = buildPersistedThemePayload({
		...themesObject,
		themes: (Array.isArray(themesObject && themesObject.themes) ? themesObject.themes : [])
			.map(theme => ({ ...theme, words: [] }))
	});
	return {
		...persistedPayload,
		selectionSource: "matching_excerpts",
		selectionStage: "matching_excerpts",
		appliedToVisualization: false,
		visualizationPreviewState: "matching_excerpts_unapplied",
		manualSelectionOptOuts: normalizeManualSelectionOptOuts(themesObject),
		updatedAt: new Date().toISOString(),
		themes: persistedPayload.themes.map(theme => ({
			...theme,
			selectedByUser: true,
			selectionSource: "matching_excerpts",
			selectionStage: "matching_excerpts",
			words: getExplicitSelectedWordsForTheme(theme.themeName)
		}))
	};
}

async function saveSelectedThemeProgressToServer(options) {
	if (selectedThemeProgressPaused) {
		return {};
	}
	const payload = persistThemePayloadLocally(buildMatchingExcerptSelectionPayload());
	const projectId = getCurrentProjectId();
	const progress = window.ChromaProjectProgress;
	const revision = progress?.revisionAfterBrowserSaves?.(projectId, payload.projectRevision);
	if (Number.isInteger(revision)) {
		payload.projectRevision = revision;
	}
	const response = await fetch("/api/save_selected_themes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(withProjectPayload(payload)),
		keepalive: options.keepalive === true
	});
	const result = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(result.error || `HTTP ${response.status}`);
	}
	if (Number.isInteger(result.projectRevision)) {
		themesObject.projectRevision = result.projectRevision;
		persistThemePayloadLocally(buildMatchingExcerptSelectionPayload());
	}
	return result;
}

function startSelectedThemeProgressSave(options) {
	if (selectedThemeProgressSaveTimer) {
		clearTimeout(selectedThemeProgressSaveTimer);
		selectedThemeProgressSaveTimer = null;
	}
	const saveVersion = ++selectedThemeProgressSaveVersion;
	const saveChange = () => saveSelectedThemeProgressToServer(options);
	const progress = window.ChromaProjectProgress;
	const saveRequest = typeof progress?.runProjectChange === "function"
		? progress.runProjectChange(getCurrentProjectId(), saveChange)
		: saveChange();
	const pendingSave = saveRequest.then(() => {
		if (saveVersion === selectedThemeProgressSaveVersion) {
			selectedThemeProgressDirty = false;
		}
	}).catch(error => {
		console.warn("Could not auto-save selected excerpts:", error);
	}).finally(() => {
		pendingSelectedThemeSaves.delete(pendingSave);
	});
	pendingSelectedThemeSaves.add(pendingSave);
}

function autosaveSelectedThemeProgress(options = {}) {
	if (selectedThemeProgressPaused) {
		return;
	}
	if (!options.flushOnly) {
		selectedThemeProgressDirty = true;
	}
	if (!selectedThemeProgressDirty && !selectedThemeProgressSaveTimer) {
		return;
	}

	const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 150;
	persistThemePayloadLocally(buildMatchingExcerptSelectionPayload());

	if (selectedThemeProgressSaveTimer) {
		clearTimeout(selectedThemeProgressSaveTimer);
	}
	if (options.immediate) {
		startSelectedThemeProgressSave(options);
		return;
	}
	selectedThemeProgressSaveTimer = setTimeout(() => startSelectedThemeProgressSave(options), delayMs);
}

export async function pauseSelectedThemeProgress() {
	selectedThemeProgressPaused = true;
	selectedThemeProgressDirty = false;
	if (selectedThemeProgressSaveTimer) {
		clearTimeout(selectedThemeProgressSaveTimer);
		selectedThemeProgressSaveTimer = null;
	}
	await Promise.all([...pendingSelectedThemeSaves]);
}

export function resumeSelectedThemeProgress() {
	selectedThemeProgressPaused = false;
}

if (typeof window !== "undefined" && !window.__themeExcerptAutosaveFlushBound) {
	window.__themeExcerptAutosaveFlushBound = true;
	window.addEventListener("pageshow", resumeSelectedThemeProgress);
	window.addEventListener("pagehide", () => {
		autosaveSelectedThemeProgress({ immediate: true, keepalive: true, flushOnly: true });
	});
	window.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			autosaveSelectedThemeProgress({ immediate: true, keepalive: true, flushOnly: true });
		}
	});
}

function isMatchingSelectedWord(selection, themeName, wordElement, index) {
	const selectionKey = buildThemeSelectionKey(themeName, wordElement);
	if (selection && selection.key) {
		if (selection.key === selectionKey) return true;
	}

	const selectionExcerptKey = buildThemeWordIdentityKey(selection);
	const wordExcerptKey = buildThemeWordIdentityKey(wordElement);
	if (selectionExcerptKey && wordExcerptKey && selectionExcerptKey === wordExcerptKey) {
		return themeNamesMatch(selection.themeName, themeName);
	}

	return selection
		&& selection.word === wordElement.word
		&& selection.index === index
		&& themeNamesMatch(selection.themeName, themeName);
}

function buildAiTaggedThemeWord(wordElement) {
	const isHumanCoded = isHumanCodedExcerpt(wordElement);
	const isAiTagged = isAiTaggedExcerpt(wordElement);
	const source = String(wordElement && (wordElement.codeSource || wordElement.source || wordElement.tagSource) || "").trim();
	return buildThemeExcerptEntry(wordElement, {
		ai_generated: isAiTagged,
		aiTagged: isAiTagged,
		humanTagged: isHumanCoded,
		codeSource: isHumanCoded && isAiTagged ? "human_ai" : isHumanCoded ? (source || "manual") : "ai",
		selectedByUser: true,
		selectedInMatching: true,
		matchingSelection: true,
		selectionSource: "matching_excerpts",
		selectionStage: "matching_excerpts_selected"
	});
}

function isHumanCodedExcerpt(wordElement) {
	if (!wordElement || typeof wordElement !== "object") return false;
	const source = String(wordElement.codeSource || wordElement.source || wordElement.tagSource || "").trim().toLowerCase();
	if (source === "manual" || source === "human" || source === "human_ai" || source === "human+ai" || source === "both") return true;
	if (wordElement.humanTagged === true || wordElement.human_tagged === true) return true;
	return wordElement.ai_generated === false;
}

function isAiTaggedExcerpt(wordElement) {
	if (!wordElement || typeof wordElement !== "object") return true;
	const source = String(wordElement.codeSource || wordElement.source || wordElement.tagSource || "").trim().toLowerCase();
	if (source === "human_ai" || source === "human+ai" || source === "both") return true;
	if (source === "ai" || source === "llm" || source === "cloud") return true;
	if (wordElement.aiTagged === true || wordElement.ai_tagged === true) return true;
	if (wordElement.ai_generated === true) return true;
	return !isHumanCodedExcerpt(wordElement);
}

function hasDeletedQuoteContext(entry) {
	return Boolean(entry && typeof entry === "object" && (entry.participant || entry.tag || entry.timestamp || entry.cueText));
}

function buildDeletedQuoteRecord(themeName, wordElement) {
	const entry = buildThemeExcerptEntry(wordElement);
	return {
		themeName,
		word: entry ? entry.word : String(wordElement && wordElement.word || "").trim(),
		participant: entry && entry.participant ? entry.participant : "",
		tag: entry && entry.tag ? entry.tag : "",
		timestamp: entry && entry.timestamp ? entry.timestamp : "",
		cueText: entry && entry.cueText ? entry.cueText : "",
		deletedAt: new Date().toISOString()
	};
}

function getExcerptLimitStorageKey() {
	const projectId = getCurrentProjectId();
	return projectId ? `themeExcerptLimit_${projectId}` : "themeExcerptLimit";
}

function getExcerptLimitDefaultStorageKey() {
	const projectId = getCurrentProjectId();
	return projectId ? `themeExcerptLimitDefaultV5_${projectId}` : "themeExcerptLimitDefaultV5";
}

function ensureExcerptLimitDefault() {
	const migrationKey = getExcerptLimitDefaultStorageKey();
	if (localStorage.getItem(migrationKey)) return;
	const limitKey = getExcerptLimitStorageKey();
	const currentValue = localStorage.getItem(limitKey);
	const numericValue = parseInt(currentValue || "", 10);
	if (
		!currentValue
		|| currentValue === "1"
		|| currentValue === "10"
		|| (currentValue !== "all" && (!Number.isFinite(numericValue) || numericValue <= 0))
	) {
		localStorage.setItem(limitKey, "all");
	}
	localStorage.setItem(migrationKey, "1");
}

function getExcerptLimit(totalAvailable = null) {
	const storedValue = localStorage.getItem(getExcerptLimitStorageKey()) || "all";
	const numericTotal = Number.isFinite(Number(totalAvailable)) ? Math.max(0, Number(totalAvailable)) : null;
	if (numericTotal === 0) return 0;
	if (storedValue === "all") return numericTotal ?? Infinity;
	const numericValue = parseInt(storedValue, 10);
	const fallbackValue = numericTotal === null ? Infinity : numericTotal;
	const resolvedValue = Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallbackValue;
	return numericTotal === null ? resolvedValue : Math.min(resolvedValue, numericTotal);
}

function setExcerptLimit(value) {
	localStorage.setItem(getExcerptLimitStorageKey(), String(value || "all"));
}

function getExcerptLimitOptions(totalAvailable) {
	const total = Math.max(0, Number(totalAvailable) || 0);
	if (total === 0) {
		return [{ value: "0", label: "0" }];
	}
	const allOption = { value: "all", label: "All" };
	if (total <= 10) {
		return [allOption, ...Array.from({ length: total }, (_, index) => {
			const value = String(index + 1);
			return { value, label: value };
		})];
	}

	const options = [5, 10, 15, 25, 50, 100]
		.filter(value => value < total);
	options.push(total);
	return [allOption, ...new Set(options)].map(value => {
		if (typeof value === "object") return value;
		const label = String(value);
		return { value: label, label };
	});
}

function findPersistedTheme(themeName) {
	if (!themesObject || !Array.isArray(themesObject.themes)) return null;
	const normalizedThemeName = String(themeName || "").trim().toLowerCase();
	return themesObject.themes.find(
		t => String(t.themeName || "").trim().toLowerCase() === normalizedThemeName
	);
}

function isPersistedThemeWord(themeName, wordElement) {
	const savedTheme = findPersistedTheme(themeName);
	const excerptKey = buildThemeWordIdentityKey(wordElement);
	return Boolean(
		savedTheme
		&& Array.isArray(savedTheme.words)
		&& excerptKey
		&& savedTheme.words.some(w => isExplicitMatchingSelection(w) && buildThemeWordIdentityKey(w) === excerptKey)
	);
}

function getExcerptContextCompleteness(wordElement) {
	if (!wordElement || typeof wordElement !== "object") return 0;
	return ["participant", "tag", "timestamp", "cueText"].reduce((score, field) => {
		return score + (wordElement[field] ? 1 : 0);
	}, 0);
}

function preferExcerptEntry(existingEntry, candidateEntry, themeName) {
	const existingWord = existingEntry.wordElement || existingEntry;
	const candidateWord = candidateEntry.wordElement || candidateEntry;
	const existingSelected = isPersistedThemeWord(themeName, existingWord);
	const candidateSelected = isPersistedThemeWord(themeName, candidateWord);
	if (candidateSelected !== existingSelected) return candidateSelected ? candidateEntry : existingEntry;

    const existingHuman = isHumanCodedExcerpt(existingWord);
    const candidateHuman = isHumanCodedExcerpt(candidateWord);
    if (candidateHuman !== existingHuman) return candidateHuman ? candidateEntry : existingEntry;

	const existingScore = getExcerptSelfRating(existingWord) ?? -1;
	const candidateScore = getExcerptSelfRating(candidateWord) ?? -1;
	if (candidateScore !== existingScore) return candidateScore > existingScore ? candidateEntry : existingEntry;

	const existingContext = getExcerptContextCompleteness(existingWord);
	const candidateContext = getExcerptContextCompleteness(candidateWord);
	return candidateContext > existingContext ? candidateEntry : existingEntry;
}

function cloneEntryWithWordElement(entry, wordElement) {
	if (!entry || typeof entry !== "object") return wordElement;
	if (Object.prototype.hasOwnProperty.call(entry, "wordElement")) {
		return { ...entry, wordElement };
	}
	return wordElement;
}

function mergeExcerptSourceMetadata(preferredEntry, existingEntry, candidateEntry) {
	const preferredWord = preferredEntry && preferredEntry.wordElement ? preferredEntry.wordElement : preferredEntry;
	const existingWord = existingEntry && existingEntry.wordElement ? existingEntry.wordElement : existingEntry;
	const candidateWord = candidateEntry && candidateEntry.wordElement ? candidateEntry.wordElement : candidateEntry;
	const hasHuman = isHumanCodedExcerpt(existingWord) || isHumanCodedExcerpt(candidateWord);
	const hasAi = isAiTaggedExcerpt(existingWord) || isAiTaggedExcerpt(candidateWord);
	if (!preferredWord || typeof preferredWord !== "object" || !(hasHuman && hasAi)) {
		return preferredEntry;
	}

	return cloneEntryWithWordElement(preferredEntry, {
		...preferredWord,
		ai_generated: true,
		aiTagged: true,
		humanTagged: true,
		codeSource: "human_ai",
		source: "human_ai"
	});
}

function dedupeExcerptEntriesByVisibleText(entries, themeName) {
	if (!Array.isArray(entries)) return [];
	const uniqueEntries = new Map();

	entries.forEach((entry) => {
		const wordElement = entry && entry.wordElement ? entry.wordElement : entry;
		const textKey = buildVisibleExcerptTextKey(wordElement);
		if (!textKey) return;

		let duplicateKey = uniqueEntries.has(textKey) ? textKey : "";
		if (!duplicateKey) {
			for (const [existingKey, existingEntry] of uniqueEntries.entries()) {
				const existingWord = existingEntry && existingEntry.wordElement ? existingEntry.wordElement : existingEntry;
				if (areVisibleExcerptTextsDuplicates(existingWord, wordElement)) {
					duplicateKey = existingKey;
					break;
				}
			}
		}

		const existingEntry = duplicateKey ? uniqueEntries.get(duplicateKey) : null;
		const preferredEntry = existingEntry ? preferDuplicateExcerptEntry(existingEntry, entry, themeName) : entry;
		const preferredWord = preferredEntry && preferredEntry.wordElement ? preferredEntry.wordElement : preferredEntry;
		const preferredKey = buildVisibleExcerptTextKey(preferredWord) || textKey;
		if (duplicateKey && duplicateKey !== preferredKey) {
			uniqueEntries.delete(duplicateKey);
		}
		uniqueEntries.set(
			preferredKey,
			existingEntry ? mergeExcerptSourceMetadata(preferredEntry, existingEntry, entry) : preferredEntry
		);
	});

	return Array.from(uniqueEntries.values());
}

function dedupeExcerptWordsByVisibleText(words, themeName) {
	return dedupeExcerptEntriesByVisibleText(
		(Array.isArray(words) ? words : []).map((wordElement, originalIndex) => ({ wordElement, originalIndex })),
		themeName
	).map(({ wordElement }) => wordElement);
}

function getThemePayloadFromGeneratedCache(themeName) {
	const payloadSources = [
		window.__matchingExcerptsByTheme,
		aiGeneratedData,
		window.__aiGeneratedThemesByTheme
	].filter(source => source && typeof source === "object");
	for (const payloadSource of payloadSources) {
		const matchedEntry = Object.entries(payloadSource).find(
			([generatedThemeName]) => themeNamesMatch(generatedThemeName, themeName)
		);
		if (matchedEntry) return matchedEntry[1];
	}
	return null;
}

function extractGeneratedQuoteCandidates(themePayload) {
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

function getGeneratedExcerptWordsForTheme(themeName) {
	const themePayload = getThemePayloadFromGeneratedCache(themeName);
	return extractGeneratedQuoteCandidates(themePayload)
		.map((quote) => {
			const codeSource = quote && typeof quote === "object" && quote.ai_generated === false
				? (quote.codeSource || quote.source || "manual")
				: "ai";
			const sourceKey = String(codeSource || "").trim().toLowerCase();
			return buildThemeExcerptEntry(quote, {
				ai_generated: !(sourceKey === "manual" || sourceKey === "human"),
				codeSource
			});
		})
		.filter(Boolean);
}

function filterOutMatchingExcerptText(words, targetWordElement) {
	if (!Array.isArray(words)) return [];
	const targetIdentityKey = buildThemeWordIdentityKey(targetWordElement);
	const targetTextKey = buildVisibleExcerptTextKey(targetWordElement);
	return words.filter((wordElement) => {
		const identityKey = buildThemeWordIdentityKey(wordElement);
		const textKey = buildVisibleExcerptTextKey(wordElement);
		if (targetIdentityKey && identityKey === targetIdentityKey) return false;
		if (targetTextKey && textKey === targetTextKey) return false;
		return !areVisibleExcerptTextsDuplicates(wordElement, targetWordElement);
	});
}

function removeMatchingSelectedWords(themeName, targetWordElement, originalIndex) {
	if (!multiSelectedWordsObject || !Array.isArray(multiSelectedWordsObject.selectedWords)) return;
	const targetTextKey = buildVisibleExcerptTextKey(targetWordElement);
	const filteredWords = multiSelectedWordsObject.selectedWords.filter((selection) => {
		if (!themeNamesMatch(selection && selection.themeName, themeName)) return true;
		if (isMatchingSelectedWord(selection, themeName, targetWordElement, originalIndex)) return false;
		if (targetTextKey && buildVisibleExcerptTextKey(selection) === targetTextKey) return false;
		return !areVisibleExcerptTextsDuplicates(selection, targetWordElement);
	});
	multiSelectedWordsObject.selectedWords.splice(
		0,
		multiSelectedWordsObject.selectedWords.length,
		...filteredWords
	);
}

function normalizeThemeKey(themeName) {
	return String(themeName || "")
		.trim()
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[_-]+/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function themeNamesMatch(left, right) {
	const leftKey = normalizeThemeKey(left);
	const rightKey = normalizeThemeKey(right);
	if (!leftKey || !rightKey) return false;
	return leftKey === rightKey || leftKey.replace(/\s+/g, "") === rightKey.replace(/\s+/g, "");
}

function isLikelyCodeLabelText(value) {
	const text = String(value || "").trim();
	if (!text) return true;
	if (/^[cq]\d+[a-z]?$/i.test(text)) return true;
	if (/^code\s*\d*$/i.test(text)) return true;
	return false;
}

function hasExcerptContext(wordElement) {
	if (!wordElement || typeof wordElement !== "object") return false;
	return Boolean(
		wordElement.participant
		|| wordElement.tag
		|| wordElement.timestamp
		|| wordElement.cueText
		|| wordElement.speaker
	);
}

function isDisplayableExcerptCandidate(wordElement, themeName) {
	const entry = buildThemeExcerptEntry(wordElement);
	if (!entry) return false;
	if (themeNamesMatch(entry.word, selectedThemeBoxObject.selectedThemeBox)) return false;
	if (themeNamesMatch(entry.word, themeName)) return false;
	if (isLikelyCodeLabelText(entry.word) && !hasExcerptContext(entry)) return false;
	return true;
}

function getSelectedThemeName() {
	const selectedThemeName = String(selectedThemeBoxObject.selectedThemeBox || "").trim();
	if (selectedThemeName) return selectedThemeName;
	const firstThemeName = Array.isArray(tempThemesObject.tempThemes) && tempThemesObject.tempThemes[0]
		? String(tempThemesObject.tempThemes[0].themeName || "").trim()
		: "";
	if (firstThemeName) selectedThemeBoxObject.selectedThemeBox = firstThemeName;
	return firstThemeName;
}

function formatThemeNameForDisplay(themeName, fallback = "Selected theme") {
	const displayName = String(themeName || "").replace(/_/g, " ").trim();
	return displayName || fallback;
}

function getSelectedBadgeId(themeName) {
	return `selectedBadge_${normalizeThemeKey(themeName).replace(/\s+/g, "_")}`;
}

function findThemeByName(themeList, themeName) {
	return (Array.isArray(themeList) ? themeList : []).find(
		theme => themeNamesMatch(theme && theme.themeName, themeName)
	);
}

function getGeneratedThemeSummary(themeName) {
	const themePayload = getThemePayloadFromGeneratedCache(themeName);
	if (!themePayload || typeof themePayload !== "object" || Array.isArray(themePayload)) return "";
	return normalizeThemeWordText(themePayload.summary || themePayload.description || themePayload.themeSummary || "");
}

function getMergedThemeRecordForRender(themeName) {
	const resolvedThemeName = String(themeName || "").trim();
	const tempTheme = findThemeByName(tempThemesObject && tempThemesObject.tempThemes, resolvedThemeName);
	const savedTheme = findThemeByName(themesObject && themesObject.themes, resolvedThemeName);
	const generatedWords = getGeneratedExcerptWordsForTheme(resolvedThemeName);
	const mergedName = tempTheme?.themeName || savedTheme?.themeName || resolvedThemeName;
	if (!mergedName) return null;

	const mergedRecord = {
		...savedTheme,
		...tempTheme,
		themeName: mergedName,
		color: tempTheme?.color || savedTheme?.color || "#579AE2",
		summary: tempTheme?.summary || tempTheme?.description || tempTheme?.themeSummary
			|| savedTheme?.summary || savedTheme?.description || savedTheme?.themeSummary
			|| getGeneratedThemeSummary(mergedName),
		words: dedupeExcerptWordsByVisibleText(dedupeThemeWordEntries([
			...(Array.isArray(tempTheme?.words) ? tempTheme.words : []),
			...generatedWords,
			...(Array.isArray(savedTheme?.words) ? savedTheme.words : []),
			...(Array.isArray(multiSelectedWordsObject?.selectedWords)
				? multiSelectedWordsObject.selectedWords.filter(selection => themeNamesMatch(selection && selection.themeName, mergedName))
				: [])
		]), mergedName)
	};

	if (tempTheme) {
		return Object.assign(tempTheme, mergedRecord);
	}

	if (Array.isArray(tempThemesObject && tempThemesObject.tempThemes)) {
		tempThemesObject.tempThemes.push(mergedRecord);
	}
	return mergedRecord;
}

function countSelectedThemeWords(themeName) {
	const normalizedThemeName = normalizeThemeKey(themeName);
	const selectedEntries = [];

	(Array.isArray(multiSelectedWordsObject && multiSelectedWordsObject.selectedWords)
		? multiSelectedWordsObject.selectedWords
		: []
	).forEach((selection) => {
		if (normalizeThemeKey(selection && selection.themeName) !== normalizedThemeName) return;
		if (!isDisplayableExcerptCandidate(selection, themeName)) return;
		selectedEntries.push(selection);
	});

	const addMarkedThemeWords = (theme) => {
		(Array.isArray(theme && theme.words) ? theme.words : [])
			.filter(isExplicitMatchingSelection)
			.forEach((word) => {
				if (!isDisplayableExcerptCandidate(word, themeName)) return;
				selectedEntries.push(word);
			});
	};

	addMarkedThemeWords(findThemeByName(themesObject && themesObject.themes, themeName));
	addMarkedThemeWords(findThemeByName(tempThemesObject && tempThemesObject.tempThemes, themeName));

	return dedupeExcerptEntriesByVisibleText(selectedEntries, themeName).length;
}

function styleSelectedThemeBadge(badge, selectedCount) {
	badge
		.style("background", selectedCount > 0 ? "#1a1a1a" : "#e5e7eb")
		.style("color", selectedCount > 0 ? "#ffffff" : "#9ca3af")
		.text(selectedCount > 0 ? `${selectedCount} selected` : "0 selected");
}

function updateSelectedThemeBadge(themeName) {
	const selectedCount = countSelectedThemeWords(themeName);
	let updatedAnyBadge = false;

	d3.selectAll(".selected-theme-badge").each(function() {
		const badge = d3.select(this);
		const badgeThemeName = badge.attr("data-theme-name") || "";
		if (!themeNamesMatch(badgeThemeName, themeName)) return;
		styleSelectedThemeBadge(badge, selectedCount);
		updatedAnyBadge = true;
	});

	if (!updatedAnyBadge) {
		const badge = d3.select(`#${getSelectedBadgeId(themeName)}`);
		if (!badge.empty()) {
			styleSelectedThemeBadge(badge, selectedCount);
		}
	}
	return selectedCount;
}

function isExcerptSelectedForTheme(themeName, wordElement, originalIndex) {
	if (isManualThemeWordEntry(wordElement)) {
		return isManualExcerptEffectivelySelected(themesObject, themeName, wordElement);
	}
	const excerptKey = buildThemeWordIdentityKey(wordElement);
	const selectedFromProgress = Array.isArray(multiSelectedWordsObject && multiSelectedWordsObject.selectedWords)
		&& multiSelectedWordsObject.selectedWords.some(
			selection => isMatchingSelectedWord(selection, themeName, wordElement, originalIndex)
		);
	if (selectedFromProgress) return true;

	const savedTheme = findThemeByName(themesObject && themesObject.themes, themeName);
	const tempTheme = findThemeByName(tempThemesObject && tempThemesObject.tempThemes, themeName);
	return [savedTheme, tempTheme].some(theme => (
		theme
		&& Array.isArray(theme.words)
		&& excerptKey
		&& theme.words.some(word => isExplicitMatchingSelection(word) && buildThemeWordIdentityKey(word) === excerptKey)
	));
}

function applyExcerptSelection(themeName, wordElement, originalIndex, shouldSelect) {
	const excerptKey = buildThemeWordIdentityKey(wordElement);
	if (!excerptKey) return false;

	if (!Array.isArray(multiSelectedWordsObject.selectedWords)) {
		multiSelectedWordsObject.selectedWords = [];
	}

	const themeTargets = [
		findThemeByName(themesObject && themesObject.themes, themeName),
		findThemeByName(tempThemesObject && tempThemesObject.tempThemes, themeName)
	].filter(Boolean);
	if (themeTargets.length === 0) return false;
	const canonicalThemeName = themeTargets[0].themeName || themeName;
	const manualExcerpt = isManualThemeWordEntry(wordElement);
	if (manualExcerpt) {
		setManualExcerptSelection(themesObject, canonicalThemeName, wordElement, shouldSelect);
		if (shouldSelect) setManualCodeSelection(themesObject, canonicalThemeName, true);
	}

	if (shouldSelect) {
		const aiTaggedWord = buildSelectedMatchingExcerptEntry(wordElement) || wordElement;
		const selectionKey = buildThemeSelectionKey(themeName, wordElement);
		const alreadySelected = isExcerptSelectedForTheme(themeName, wordElement, originalIndex);
		let changed = !alreadySelected;

		if (!multiSelectedWordsObject.selectedWords.some(selection => isMatchingSelectedWord(selection, themeName, wordElement, originalIndex))) {
			multiSelectedWordsObject.selectedWords.push({
				...aiTaggedWord,
				key: selectionKey,
				excerptKey,
				index: originalIndex,
				source: "cloud",
				themeName: canonicalThemeName
			});
			changed = true;
		}

		themeTargets.forEach((themeTarget) => {
			if (!Array.isArray(themeTarget.words)) themeTarget.words = [];
			const existingWordIndex = themeTarget.words.findIndex(word => buildThemeWordIdentityKey(word) === excerptKey);
			if (existingWordIndex === -1) {
				themeTarget.words.push({
					...aiTaggedWord,
					themeName: themeTarget.themeName || canonicalThemeName
				});
				changed = true;
			} else if (
				themeTarget.words[existingWordIndex]?.selectedByUser !== true
				|| themeTarget.words[existingWordIndex]?.selectionSource !== "matching_excerpts"
			) {
				themeTarget.words[existingWordIndex] = {
					...themeTarget.words[existingWordIndex],
					selectedByUser: true,
					selectedInMatching: true,
					matchingSelection: true,
					selectionSource: "matching_excerpts",
					selectionStage: "matching_excerpts_selected",
					themeName: themeTarget.words[existingWordIndex]?.themeName || themeTarget.themeName || canonicalThemeName
				};
				changed = true;
			}
		});

		return changed;
	}

	const wasSelected = manualExcerpt || isExcerptSelectedForTheme(themeName, wordElement, originalIndex);
	removeMatchingSelectedWords(themeName, wordElement, originalIndex);
	if (manualExcerpt) return wasSelected;
	themeTargets.forEach((themeTarget) => {
		themeTarget.words = filterOutMatchingExcerptText(themeTarget.words, wordElement);
	});
	return wasSelected;
}

function getDisplayableExcerptEntries(themeRecord, confidenceThreshold) {
    return getCandidateExcerptEntries(themeRecord)
        .filter(({ wordElement }) => passesExcerptSelfRating(wordElement, confidenceThreshold))
        .sort((left, right) => compareExcerptSelfRatings(left.wordElement, right.wordElement));
}

function getCandidateExcerptEntries(themeRecord) {
	if (!themeRecord) return [];
	if (!Array.isArray(themeRecord.words)) themeRecord.words = [];
	const themeName = themeRecord.themeName;
	const selectedTheme = findThemeByName(themesObject && themesObject.themes, themeName);
	const selectedWords = Array.isArray(selectedTheme && selectedTheme.words)
		? selectedTheme.words.map(word => buildThemeExcerptEntry(word)).filter(Boolean)
		: [];
	const progressSelectedWords = Array.isArray(multiSelectedWordsObject && multiSelectedWordsObject.selectedWords)
		? multiSelectedWordsObject.selectedWords
			.filter(selection => themeNamesMatch(selection && selection.themeName, themeName))
			.map(selection => buildThemeExcerptEntry(selection))
			.filter(Boolean)
		: [];
	const generatedWords = getGeneratedExcerptWordsForTheme(themeName);

	themeRecord.words = dedupeThemeWordEntries([
		...(Array.isArray(themeRecord.words) ? themeRecord.words : []),
		...generatedWords,
		...selectedWords,
		...progressSelectedWords
	]);
	themeRecord.words = dedupeExcerptWordsByVisibleText(themeRecord.words, themeName);

	return themeRecord.words
		.map((wordElement, originalIndex) => ({ wordElement, originalIndex }))
		.filter(({ wordElement }) => isDisplayableExcerptCandidate(wordElement, themeName));
}

function applyBulkExcerptSelection(themeName, entries, shouldSelect) {
	const validEntries = Array.isArray(entries) ? entries : [];
	if (validEntries.length === 0) return;

	let changed = false;
	validEntries.forEach(({ wordElement, originalIndex }) => {
		if (applyExcerptSelection(themeName, wordElement, originalIndex, shouldSelect)) {
			changed = true;
		}
	});

	if (!changed) return;
	updateSelectedThemeBadge(themeName);
	autosaveSelectedThemeProgress({ immediate: true });
	makeWordClouds();
}

function appendThemeHeader(wordCloud, themeSummary) {
	const selectedThemeRecord = findThemeByName(tempThemesObject && tempThemesObject.tempThemes, getSelectedThemeName());
	const headerThemeName = selectedThemeRecord && selectedThemeRecord.themeName
		? selectedThemeRecord.themeName
		: getSelectedThemeName();
	const header = wordCloud.append("div")
		.attr("id", "excerptThemeHeader")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("gap", "6px")
        .style("width", "100%")
        .style("padding", "62px clamp(24px, 4vw, 56px) 0 clamp(24px, 4vw, 56px)")
        .style("box-sizing", "border-box")
        .style("font-family", "Inter");

	header.append("div")
		.style("font-size", "22px")
		.style("font-weight", "700")
		.style("color", "#111827")
		.text(formatThemeNameForDisplay(headerThemeName));
		if (themeSummary) {
			header.append("div")
				.style("font-size", "14px")
				.style("font-weight", "400")
				.style("color", "#6b7280")
				.style("line-height", "1.6")
				.text(themeSummary);
		}
	}
function appendExcerptToolbar(wordCloud, totalForSelectedTheme, displayableForSelectedTheme, confidenceThreshold, displayableEntries = []) {
	ensureExcerptLimitDefault();
	const toolbar = wordCloud.append("div")
		.attr("id", "excerptToolbar")
		.style("display", "flex")
		.style("align-items", "center")
		.style("justify-content", "space-between")
		.style("gap", "16px")
		.style("flex-wrap", "wrap")
		.style("width", "100%")
		.style("padding", "16px clamp(24px, 4vw, 56px) 12px clamp(24px, 4vw, 56px)")
		.style("box-sizing", "border-box")
		.style("font-family", "Inter");

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
		.text(() => {
			const humanCount = displayableEntries.filter(({ wordElement }) => isHumanCodedExcerpt(wordElement)).length;
			const humanNote = humanCount > 0 ? `, including ${humanCount} human-coded` : "";
			return `${displayableForSelectedTheme} of ${totalForSelectedTheme} excerpts available${humanNote}; rated AI suggestions are ordered by self-rating`;
		});

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

	const control = controls.append("label")
		.style("display", "inline-flex")
		.style("align-items", "center")
		.style("gap", "8px")
		.style("font-size", "13px")
		.style("font-weight", "700")
		.style("color", "#4b5563");

	control.append("span").text("Show");
	const select = control.append("select")
		.attr("aria-label", "Number of excerpts to show")
		.style("height", "34px")
		.style("border", "1px solid #d1d5db")
		.style("border-radius", "8px")
		.style("padding", "0 28px 0 10px")
		.style("background", "#ffffff")
		.style("font-family", "Inter")
		.style("font-size", "13px")
		.style("font-weight", "700")
		.on("change", function() {
			setExcerptLimit(this.value);
			makeWordClouds();
		});

	getExcerptLimitOptions(displayableForSelectedTheme).forEach(option => {
		select.append("option").attr("value", option.value).text(option.label);
	});

	const currentStoredLimit = localStorage.getItem(getExcerptLimitStorageKey()) || "all";
	const resolvedValue = getExcerptLimit(displayableForSelectedTheme);
	const shouldUseAllLimit = currentStoredLimit === "all";
	const selectedValue = displayableForSelectedTheme === 0
		? "0"
		: shouldUseAllLimit
			? String(displayableForSelectedTheme)
			: String(resolvedValue);
	select.property("value", selectedValue);
	select.property("disabled", displayableForSelectedTheme === 0);
	if (!shouldUseAllLimit && (localStorage.getItem(getExcerptLimitStorageKey()) || "") !== selectedValue) {
		setExcerptLimit(selectedValue);
	}
	control.append("span").text(`of ${displayableForSelectedTheme}`);

	const actionGroup = controls.append("div")
		.style("display", "inline-flex")
		.style("align-items", "center")
		.style("gap", "8px");

	const appendSelectionButton = (label, shouldSelect) => {
		return actionGroup.append("button")
			.attr("type", "button")
			.attr("aria-label", label)
			.style("height", "34px")
			.style("border", shouldSelect ? "1px solid #2563eb" : "1px solid #d1d5db")
			.style("border-radius", "8px")
			.style("background", shouldSelect ? "#2563eb" : "#ffffff")
			.style("color", shouldSelect ? "#ffffff" : "#374151")
			.style("padding", "0 12px")
			.style("font-family", "Inter")
			.style("font-size", "13px")
			.style("font-weight", "800")
			.style("cursor", displayableEntries.length === 0 ? "not-allowed" : "pointer")
			.style("opacity", displayableEntries.length === 0 ? 0.5 : 1)
			.property("disabled", displayableEntries.length === 0)
			.text(label)
			.on("click", function() {
				if (d3.event) {
					d3.event.preventDefault();
					d3.event.stopPropagation();
				}
				applyBulkExcerptSelection(selectedThemeBoxObject.selectedThemeBox, displayableEntries, shouldSelect);
			});
	};

	appendSelectionButton("Select all", true);
	appendSelectionButton("Deselect all", false);

	const thresholdControl = controls.append("label")
		.style("display", "inline-flex")
		.style("align-items", "center")
		.style("gap", "8px")
		.style("font-size", "13px")
		.style("font-weight", "700")
		.style("color", "#4b5563");

	thresholdControl.append("span").text("Min AI self-rating");
	const thresholdValueLabel = thresholdControl.append("span")
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
			thresholdValueLabel.text(formatConfidenceThreshold(Number(this.value) / 100));
		})
		.on("change", function() {
			setExcerptConfidenceThreshold(Number(this.value) / 100);
			setExcerptLimit("all");
			makeWordClouds();
		});
}

function appendSelectedThemeExcerptNotice(container, theme, candidateEntries, visibleEntries, demoEmptyMessage) {
	appendMatchingExcerptNotice(container, {
		theme,
		candidateWords: candidateEntries.map(entry => entry.wordElement),
		visibleWords: visibleEntries.map(entry => entry.wordElement),
		demoEmptyMessage,
		transcriptUrl: `/transcriptmode${projectQueryParam()}`,
		isDemo: window.APP_MODE !== "user" || window.location.pathname.startsWith("/demo")
	});
}

function renderFallbackMatchingExcerpts(wordCloud, error, previousHtml) {
	try {
		console.error("Rendering fallback matching excerpts:", error);
		wordCloud.selectAll("*").remove();
		const selectedThemeName = getSelectedThemeName();
		const selectedThemeRecord = getMergedThemeRecordForRender(selectedThemeName) || {
			themeName: selectedThemeName || "Selected code",
			color: "#579AE2",
			summary: "",
			words: []
		};
		const confidenceThreshold = getExcerptConfidenceThreshold();
		const candidateEntries = (Array.isArray(selectedThemeRecord.words) ? selectedThemeRecord.words : [])
			.map((wordElement, originalIndex) => ({ wordElement, originalIndex }))
			.filter(({ wordElement }) => Boolean(buildThemeExcerptEntry(wordElement)));
		const displayableEntries = candidateEntries
			.filter(({ wordElement }) => passesExcerptSelfRating(wordElement, confidenceThreshold))
			.sort((left, right) => compareExcerptSelfRatings(left.wordElement, right.wordElement));
		const visibleEntries = displayableEntries.slice(0, getExcerptLimit(displayableEntries.length));

		appendThemeHeader(wordCloud, selectedThemeRecord.summary || "");
		appendExcerptToolbar(wordCloud, candidateEntries.length, displayableEntries.length, confidenceThreshold, displayableEntries);

		wordCloudShapeObject.wordCloudShape = wordCloud.append("div")
			.attr("id", "wordCloudShape")
			.style("display", "grid")
			.style("width", "100%")
			.style("grid-template-columns", "repeat(auto-fit, minmax(min(100%, 300px), 1fr))")
			.style("gap", "22px")
			.style("padding", "0 clamp(24px, 4vw, 56px) 350px clamp(24px, 4vw, 56px)")
			.style("box-sizing", "border-box")
			.style("align-content", "flex-start")
			.style("justify-content", "stretch")
			.style("justify-items", "stretch")
			.style("overflow-y", "auto")
			.style("height", "calc(100% - 112px)");

		appendSelectedThemeExcerptNotice(
			wordCloudShapeObject.wordCloudShape,
			selectedThemeRecord,
			candidateEntries,
			displayableEntries
		);
		if (visibleEntries.length === 0) {
			return;
		}

		visibleEntries.forEach(({ wordElement, originalIndex }) => {
			const normalizedWord = buildThemeExcerptEntry(wordElement);
			if (!normalizedWord) return;
			const isAlreadySelected = isExcerptSelectedForTheme(selectedThemeRecord.themeName, normalizedWord, originalIndex);
			const hasHuman = isHumanCodedExcerpt(normalizedWord);
			const hasAi = isAiTaggedExcerpt(normalizedWord);
			const sourceBadgeStyle = hasHuman && hasAi
				? { border: "1px solid #c4b5fd", background: "#f5f3ff", color: "#6d28d9" }
				: hasHuman
					? { border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1d4ed8" }
					: { border: "1px solid #bbf7d0", background: "#ecfdf5", color: "#166534" };

			const card = wordCloudShapeObject.wordCloudShape.append("div")
				.attr("class", "sections word")
				.style("position", "relative")
				.style("width", "100%")
				.style("height", "clamp(220px, 24vh, 280px)")
				.style("overflow", "hidden")
				.style("border-radius", "5px")
				.style("box-sizing", "border-box")
				.style("display", "flex")
				.style("justify-content", "center")
				.style("align-items", "center")
				.style("cursor", "pointer")
				.style("padding", "10px")
				.style("background-color", isAlreadySelected ? "#e6f0ff" : "#ffffff")
				.style("border", "2px solid #e5e7eb")
				.style("border-left", isAlreadySelected ? `8px solid ${selectedThemeRecord.color || "#579AE2"}` : "2px solid #e5e7eb");

			card.append("input")
				.attr("type", "checkbox")
				.style("position", "absolute")
				.style("top", "10px")
				.style("left", "10px")
				.style("width", "20px")
				.style("height", "20px")
				.style("pointer-events", "none")
				.property("checked", isAlreadySelected);

			card.append("div")
				.style("position", "absolute")
				.style("top", "10px")
				.style("right", "12px")
				.style("padding", "4px 9px")
				.style("border-radius", "999px")
				.style("border", sourceBadgeStyle.border)
				.style("background", sourceBadgeStyle.background)
				.style("color", sourceBadgeStyle.color)
				.style("font-family", "Inter")
				.style("font-size", "12px")
				.style("font-weight", "800")
				.attr("title", getExcerptRatingExplanation(normalizedWord))
				.text(getExcerptSourceBadgeLabel(normalizedWord));

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

			const participantLabel = resolveThemeWordParticipantLabel(normalizedWord);
			if (participantLabel) {
				card.append("div")
					.style("position", "absolute")
					.style("left", "12px")
					.style("bottom", "12px")
					.style("padding", "4px 10px")
					.style("border-radius", "999px")
					.style("background", "#eef2ff")
					.style("color", "#2643b6")
					.style("font-family", "Inter")
					.style("font-size", "13px")
					.style("font-weight", "700")
					.text(participantLabel);
			}

			card.on("click", function() {
				const shouldSelect = !d3.select(this).select("input[type='checkbox']").property("checked");
				applyExcerptSelection(selectedThemeRecord.themeName, normalizedWord, originalIndex, shouldSelect);
				autosaveSelectedThemeProgress({ immediate: true });
				updateSelectedThemeBadge(selectedThemeRecord.themeName);
				makeWordClouds();
			});
		});
	} catch (fallbackError) {
		console.error("Fallback matching excerpt render failed:", fallbackError);
		renderLastChanceMatchingExcerpts(wordCloud, fallbackError);
	}
}

function renderLastChanceMatchingExcerpts(wordCloud, reason) {
	try {
		const selectedThemeName = getSelectedThemeName();
		const selectedThemeRecord = getMergedThemeRecordForRender(selectedThemeName) || {
			themeName: selectedThemeName || "Selected code",
			color: "#579AE2",
			summary: "",
			words: []
		};
		const confidenceThreshold = getExcerptConfidenceThreshold();
		const candidateEntries = dedupeExcerptWordsByVisibleText(
			Array.isArray(selectedThemeRecord.words) ? selectedThemeRecord.words : [],
			selectedThemeRecord.themeName
		)
			.map((wordElement, originalIndex) => ({ wordElement: buildThemeExcerptEntry(wordElement), originalIndex }))
			.filter(({ wordElement }) => Boolean(wordElement));
		const entries = candidateEntries
            .filter(({ wordElement }) => passesExcerptSelfRating(wordElement, confidenceThreshold))
            .sort((left, right) => compareExcerptSelfRatings(left.wordElement, right.wordElement));
		const visibleEntries = entries.slice(0, getExcerptLimit(entries.length));

		wordCloud.selectAll("*").remove();
		wordCloud
			.style("display", "flex")
			.style("flex-direction", "column")
			.style("align-items", "stretch")
			.style("min-height", "100%");

		const header = wordCloud.append("div")
			.attr("id", "excerptThemeHeader")
			.style("padding", "62px clamp(24px, 4vw, 56px) 0 clamp(24px, 4vw, 56px)")
			.style("font-family", "Inter")
			.style("box-sizing", "border-box");
		header.append("div")
			.style("font-size", "22px")
			.style("font-weight", "700")
			.style("color", "#111827")
			.text(formatThemeNameForDisplay(selectedThemeRecord.themeName, "Selected code"));
		if (selectedThemeRecord.summary) {
			header.append("div")
				.style("margin-top", "6px")
				.style("font-size", "14px")
				.style("line-height", "1.6")
				.style("color", "#6b7280")
				.text(selectedThemeRecord.summary);
		}

		const toolbar = wordCloud.append("div")
			.attr("id", "excerptToolbar")
			.style("padding", "16px clamp(24px, 4vw, 56px) 12px clamp(24px, 4vw, 56px)")
			.style("display", "flex")
			.style("align-items", "center")
			.style("justify-content", "space-between")
			.style("gap", "16px")
			.style("flex-wrap", "wrap")
			.style("font-family", "Inter")
			.style("box-sizing", "border-box");
		const titleGroup = toolbar.append("div");
		titleGroup.append("div")
			.style("font-size", "18px")
			.style("font-weight", "700")
			.style("color", "#111827")
			.text("Matching excerpts");
		titleGroup.append("div")
			.style("margin-top", "4px")
			.style("font-size", "12px")
			.style("font-weight", "600")
			.style("color", "#6b7280")
			.text(`${entries.length} excerpts available; rated AI suggestions are ordered by self-rating`);
    titleGroup.append("div")
        .style("max-width", "640px")
        .style("font-size", "12px")
        .style("color", "#6b7280")
        .text(EXCERPT_SELF_RATING_HELP);



		wordCloudShapeObject.wordCloudShape = wordCloud.append("div")
			.attr("id", "wordCloudShape")
			.style("display", "grid")
			.style("width", "100%")
			.style("grid-template-columns", "repeat(auto-fit, minmax(min(100%, 300px), 1fr))")
			.style("gap", "22px")
			.style("padding", "0 clamp(24px, 4vw, 56px) 350px clamp(24px, 4vw, 56px)")
			.style("box-sizing", "border-box")
			.style("align-content", "flex-start")
			.style("justify-content", "stretch")
			.style("justify-items", "stretch")
			.style("overflow-y", "auto");

		appendSelectedThemeExcerptNotice(
			wordCloudShapeObject.wordCloudShape,
			selectedThemeRecord,
			candidateEntries,
			entries
		);
		if (visibleEntries.length === 0) {
			return;
		}

		visibleEntries.forEach(({ wordElement, originalIndex }) => {
			const isAlreadySelected = isExcerptSelectedForTheme(selectedThemeRecord.themeName, wordElement, originalIndex);
			const hasHuman = isHumanCodedExcerpt(wordElement);
			const hasAi = isAiTaggedExcerpt(wordElement);
			const badgeStyle = hasHuman && hasAi
				? { border: "1px solid #c4b5fd", background: "#f5f3ff", color: "#6d28d9" }
				: hasHuman
					? { border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1d4ed8" }
					: { border: "1px solid #bbf7d0", background: "#ecfdf5", color: "#166534" };

			const card = wordCloudShapeObject.wordCloudShape.append("div")
				.attr("class", "sections word")
				.style("position", "relative")
				.style("width", "100%")
				.style("height", "clamp(220px, 24vh, 280px)")
				.style("overflow", "hidden")
				.style("border-radius", "5px")
				.style("box-sizing", "border-box")
				.style("display", "flex")
				.style("justify-content", "center")
				.style("align-items", "center")
				.style("cursor", "pointer")
				.style("padding", "10px")
				.style("background-color", isAlreadySelected ? "#e6f0ff" : "#ffffff")
				.style("border", "2px solid #e5e7eb")
				.style("border-left", isAlreadySelected ? `8px solid ${selectedThemeRecord.color || "#579AE2"}` : "2px solid #e5e7eb")
				.on("click", function() {
					const shouldSelect = !d3.select(this).select("input[type='checkbox']").property("checked");
					applyExcerptSelection(selectedThemeRecord.themeName, wordElement, originalIndex, shouldSelect);
					autosaveSelectedThemeProgress({ immediate: true });
					updateSelectedThemeBadge(selectedThemeRecord.themeName);
					makeWordClouds();
				});

			card.append("input")
				.attr("type", "checkbox")
				.style("position", "absolute")
				.style("top", "10px")
				.style("left", "10px")
				.style("width", "20px")
				.style("height", "20px")
				.style("pointer-events", "none")
				.property("checked", isAlreadySelected);
			card.append("div")
				.style("position", "absolute")
				.style("top", "10px")
				.style("right", "12px")
				.style("padding", "4px 9px")
				.style("border-radius", "999px")
				.style("border", badgeStyle.border)
				.style("background", badgeStyle.background)
				.style("color", badgeStyle.color)
				.style("font-family", "Inter")
				.style("font-size", "12px")
				.style("font-weight", "800")
				.attr("title", getExcerptRatingExplanation(wordElement))
				.text(getExcerptSourceBadgeLabel(wordElement));
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
				.text(wordElement.word);
			const participantLabel = resolveThemeWordParticipantLabel(wordElement);
			if (participantLabel) {
				card.append("div")
					.style("position", "absolute")
					.style("left", "12px")
					.style("bottom", "12px")
					.style("padding", "4px 10px")
					.style("border-radius", "999px")
					.style("background", "#eef2ff")
					.style("color", "#2643b6")
					.style("font-family", "Inter")
					.style("font-size", "13px")
					.style("font-weight", "700")
					.text(participantLabel);
			}
		});
	} catch (lastChanceError) {
		console.error("Last chance matching excerpt render failed:", reason, lastChanceError);
		wordCloud.html('<div style="padding:64px;font-family:Inter;font-weight:700;color:#4b5563;">Matching excerpts could not be rendered. Refresh the page to retry.</div>');
	}
}

function hasVisibleMatchingExcerptContent(wordCloudNode) {
	if (!wordCloudNode) return false;
	if (wordCloudNode.querySelector("#excerptThemeHeader, #excerptToolbar, .sections.word")) return true;
	return String(wordCloudNode.textContent || "").trim().length > 0;
}

function ensureMatchingExcerptsVisible(reason = "post-render") {
	const wordCloud = d3.select("#word-cloud");
	const wordCloudNode = wordCloud.node();
	if (!wordCloudNode) return;
	if (hasVisibleMatchingExcerptContent(wordCloudNode)) return;
	renderLastChanceMatchingExcerpts(wordCloud, new Error(reason));
}

if (typeof window !== "undefined") {
	window.__ensureMatchingExcerptsVisible = ensureMatchingExcerptsVisible;
}

export function makeWordClouds() {
	const wordCloud = d3.select("#word-cloud");
	const previousHtml = wordCloud.html();
	try {
		renderWordClouds(wordCloud);
	} catch (error) {
		renderFallbackMatchingExcerpts(wordCloud, error, previousHtml);
	}
	setTimeout(() => ensureMatchingExcerptsVisible("makeWordClouds-empty-pane"), 0);
}

function renderWordClouds(wordCloud) {
	wordCloud.selectAll("*").remove();
	const wordCloudNode = wordCloud.node();
	if (wordCloudNode) {
		wordCloudNode.scrollTop = 0;
		wordCloudNode.scrollLeft = 0;
	}
	if (!Array.isArray(multiSelectedWordsObject.selectedWords)) {
		multiSelectedWordsObject.selectedWords = [];
	}
	const selectedThemeName = getSelectedThemeName();

	let totalForSelectedTheme = 0;
	let displayableForSelectedTheme = 0;
	let displayableEntriesForSelectedTheme = [];
	const confidenceThreshold = getExcerptConfidenceThreshold();
	const selectedThemeRecord = getMergedThemeRecordForRender(selectedThemeName);
	const candidateEntriesForSelectedTheme = selectedThemeRecord
		? getCandidateExcerptEntries(selectedThemeRecord)
		: [];
	totalForSelectedTheme = candidateEntriesForSelectedTheme.length;
	displayableEntriesForSelectedTheme = selectedThemeRecord
		? getDisplayableExcerptEntries(selectedThemeRecord, confidenceThreshold)
		: [];
	displayableForSelectedTheme = displayableEntriesForSelectedTheme.length;
	let themeSummary = "";
	if (selectedThemeRecord) {
		themeSummary = selectedThemeRecord.summary || selectedThemeRecord.description || selectedThemeRecord.themeSummary || "";
	}
	if (aiGeneratedData) {
		const matchedKey = Object.keys(aiGeneratedData).find(
			k => themeNamesMatch(k, selectedThemeName)
		);
		if (matchedKey) themeSummary = aiGeneratedData[matchedKey].summary || themeSummary;
	}

	appendThemeHeader(wordCloud, themeSummary);
	appendExcerptToolbar(
		wordCloud,
		totalForSelectedTheme,
		displayableForSelectedTheme,
		confidenceThreshold,
		displayableEntriesForSelectedTheme
	);

	wordCloudShapeObject.wordCloudShape = wordCloud.append("div")
		.attr("id", "wordCloudShape")
		.style("display", "grid")
		.style("width", "100%")
		.style("grid-template-columns", "repeat(auto-fit, minmax(min(100%, 300px), 1fr))")
		.style("gap", "22px")
		.style("padding", "0 clamp(24px, 4vw, 56px) 350px clamp(24px, 4vw, 56px)")
		.style("align-content", "flex-start")
		.style("justify-content", "stretch")
		.style("justify-items", "stretch")
			.style("overflow-y", "auto")
			.style("height", "calc(100% - 112px)")
			.style("box-sizing", "border-box");
		const wordCloudShapeNode = wordCloudShapeObject.wordCloudShape.node();
		if (wordCloudShapeNode) {
			wordCloudShapeNode.scrollTop = 0;
			wordCloudShapeNode.scrollLeft = 0;
		}

	// Keep the existing demo copy; the new explanation is for regular projects.
	const demoEmptyMessage = totalForSelectedTheme > 0 && confidenceThreshold > 0
		? "No rated AI suggestions meet this minimum self-rating. Lower the filter to review more suggestions, or apply this code manually in Transcript mode."
		: "No generated excerpts are currently linked to this code. This can happen for manually created codes, codes with no accepted AI quote matches, or excerpts that were archived. You can apply the code manually in Transcript mode or refresh generated quotes.";
	appendSelectedThemeExcerptNotice(
		wordCloudShapeObject.wordCloudShape,
		selectedThemeRecord,
		candidateEntriesForSelectedTheme,
		displayableEntriesForSelectedTheme,
		demoEmptyMessage
	);
	const excerptLimit = getExcerptLimit(displayableForSelectedTheme);


	if (selectedThemeRecord) {
		const theme = themesObject.themes.find(
			t => themeNamesMatch(t.themeName, selectedThemeName)
		);

		const selectedThemeObj = selectedThemeRecord;
		const capturedThemeName = selectedThemeRecord.themeName;
		selectedThemeObj.words = dedupeExcerptWordsByVisibleText(selectedThemeObj.words, capturedThemeName);
		const themeColor = theme ? theme.color : selectedThemeRecord.color || "#007bff";
		const selectedCardBackground = colorToRgba(themeColor, 0.16);
		const selectedCardBorder = colorToRgba(themeColor, 0.42);
		let displayedForTheme = 0;

				const sortedWordEntries = displayableEntriesForSelectedTheme;

				for (const { wordElement, originalIndex } of sortedWordEntries) {
						if (displayedForTheme >= excerptLimit) {
							continue;
						}
						displayedForTheme += 1;
						const isHumanCoded = isHumanCodedExcerpt(wordElement);
						const isAiTagged = isAiTaggedExcerpt(wordElement);
						const sourceBadgeLabel = getExcerptSourceBadgeLabel(wordElement);
						const sourceBadgeStyle = isHumanCoded && isAiTagged
							? { border: "1px solid #c4b5fd", background: "#f5f3ff", color: "#6d28d9" }
							: isHumanCoded
								? { border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1d4ed8" }
								: { border: "1px solid #bbf7d0", background: "#ecfdf5", color: "#166534" };
						const excerptKey = buildThemeWordIdentityKey(wordElement);
						const isAlreadySelected = isExcerptSelectedForTheme(capturedThemeName, wordElement, originalIndex);

						// Sync into multiSelectedWordsObject so editThemesMore stays consistent
						if (isAlreadySelected && !multiSelectedWordsObject.selectedWords.some(
							w => isMatchingSelectedWord(w, capturedThemeName, wordElement, originalIndex)
						)) {
							const aiTaggedWord = buildAiTaggedThemeWord(wordElement) || wordElement;
							multiSelectedWordsObject.selectedWords.push({
								...aiTaggedWord,
									key: buildThemeSelectionKey(capturedThemeName, wordElement),
									excerptKey,
									index: originalIndex,
									source: "cloud",
								themeName: capturedThemeName
							});
					}

						const card = wordCloudShapeObject.wordCloudShape.append("div")
							.attr("id", originalIndex)
							.attr("class", "sections word")
						.style("position", "relative")
						.style("width", "100%")
						.style("height", "clamp(220px, 24vh, 280px)")
						.style("overflow", "hidden")
						.style("border-radius", "5px")
						.style("box-sizing", "border-box")
						.style("display", "flex")
						.style("justify-content", "center")
						.style("align-items", "center")
						.style("cursor", "pointer")
						.style("padding", "10px")
						.style("margin", "0")
						.style("background-color", isAlreadySelected ? selectedCardBackground : "#ffffff")
						.style("border", isAlreadySelected ? `2px solid ${selectedCardBorder}` : "2px solid #e5e7eb")
						.style("border-left", isAlreadySelected ? `8px solid ${themeColor}` : "2px solid #e5e7eb")

						card.append("input")
							.attr("type", "checkbox")
						.style("position", "absolute")
						.style("top", "10px")
						.style("left", "10px")
						.style("width", "20px")
							.style("height", "20px")
							.style("pointer-events", "none")
							.property("checked", isAlreadySelected);

						card.append("div")
							.attr("title", getExcerptRatingExplanation(wordElement))
							.style("position", "absolute")
							.style("top", "10px")
							.style("right", "36px")
							.style("display", "inline-flex")
							.style("align-items", "center")
							.style("gap", "6px")
							.style("padding", "4px 9px")
							.style("border-radius", "999px")
							.style("border", sourceBadgeStyle.border)
							.style("background", sourceBadgeStyle.background)
							.style("color", sourceBadgeStyle.color)
							.style("font-family", "Inter")
							.style("font-size", "12px")
							.style("font-weight", "800")
							.style("line-height", "1")
							.style("white-space", "nowrap")
							.text(sourceBadgeLabel);

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
						.text(wordElement.word);

					const participantLabel = resolveThemeWordParticipantLabel(wordElement);
					if (participantLabel) {
						card.append("div")
							.style("position", "absolute")
							.style("left", "12px")
							.style("bottom", "12px")
							.style("padding", "4px 10px")
							.style("border-radius", "999px")
							.style("background", "#eef2ff")
							.style("color", "#2643b6")
							.style("font-family", "Inter")
							.style("font-size", "13px")
							.style("font-weight", "700")
							.style("letter-spacing", "0.02em")
							.text(participantLabel);
					}
					
					const deleteBtn = card.append("button")
						.style("position", "absolute")
						.style("top", "4px")
						.style("right", "4px")
						.style("width", "20px")
						.style("height", "20px")
						.style("border-radius", "50%")
						.style("background", "#ffa3a3")
						.style("color", "#fff")
						.style("font-size", "12px")
						.style("display", "flex")
						.style("align-items", "center")
						.style("justify-content", "center")
						.style("cursor", "pointer")
						.style("border", "none")
						.style("line-height", "1")
						.style("z-index", "10")
						.text("×")
						.on("click", async function() {
							d3.event.stopPropagation();

								const deletedThemeName = capturedThemeName;
								const themeIndex = tempThemesObject.tempThemes.findIndex(
									theme => themeNamesMatch(theme && theme.themeName, deletedThemeName)
								);

								// 1. Remove from tempThemesObject
								if (themeIndex !== -1) {
									tempThemesObject.tempThemes[themeIndex].words = filterOutMatchingExcerptText(
										tempThemesObject.tempThemes[themeIndex].words,
										wordElement
									);
								}

							// 2. Remove from multiSelectedWordsObject if selected
							removeMatchingSelectedWords(deletedThemeName, wordElement, originalIndex);

							// 3. Remove from themesObject too
							const themeTarget = findThemeByName(themesObject && themesObject.themes, deletedThemeName);
							if (themeTarget) {
								themeTarget.words = filterOutMatchingExcerptText(themeTarget.words, wordElement);
							}
							autosaveSelectedThemeProgress({ immediate: true });

							// 4. Save to deletedQuotes.json
							let deletedQuotes = [];
							try {
									const res = await fetch(`/api/load_deleted_quotes${projectQueryParam()}`);
								if (res.ok) {
									const existing = await res.json();
									deletedQuotes = existing.deletedQuotes || [];
								}
							} catch(e) {}

							// Only add if not already in archive
							const deletedQuoteRecord = buildDeletedQuoteRecord(deletedThemeName, wordElement);
							const deletedQuoteKey = buildThemeWordIdentityKey(deletedQuoteRecord);
							const alreadyDeleted = deletedQuotes.some((quote) => {
								if (hasDeletedQuoteContext(quote)) {
									return String(quote.themeName || "").trim().toLowerCase() === deletedThemeName.trim().toLowerCase()
										&& buildThemeWordIdentityKey(quote) === deletedQuoteKey;
								}
								return String(quote.themeName || "").trim().toLowerCase() === deletedThemeName.trim().toLowerCase()
									&& String(quote.word || "").trim().toLowerCase() === String(wordElement.word || "").trim().toLowerCase();
							});
							if (!alreadyDeleted) {
								deletedQuotes.push(deletedQuoteRecord);
							}

							try {
									await fetch('/api/save_deleted_quotes', {
										method: 'POST',
										headers: { 'Content-Type': 'application/json' },
										body: JSON.stringify(withProjectPayload({ deletedQuotes }))
									});
							} catch(e) {}

							// 5. Update archive button count — call safely without crashing if not defined
							try {
								const archiveBtn = d3.select("#main-edit-window").select("button").filter(function() {
									return d3.select(this).text().startsWith("Archive");
								});
								if (!archiveBtn.empty()) {
									archiveBtn.text(`Archive (${deletedQuotes.length})`);
								}
							} catch(e) {}

							// 6. Rerender
							makeWordClouds();
						});

					card.on("click", function () {
						const cb = d3.select(this).select("input[type='checkbox']");
							const isChecked = cb.property("checked");
							const shouldSelect = !isChecked;
							cb.property("checked", shouldSelect);
							applyExcerptSelection(capturedThemeName, wordElement, originalIndex, shouldSelect);
							recordMatchingExcerptSelection(capturedThemeName, wordElement, shouldSelect);
							if (shouldSelect) {
								d3.select(this)
									.style("background-color", selectedCardBackground)
									.style("margin-left", "0px")
									.style("border-left", `8px solid ${themeColor}`)
									.style("border-top", `2px solid ${selectedCardBorder}`)
									.style("border-right", `2px solid ${selectedCardBorder}`)
									.style("border-bottom", `2px solid ${selectedCardBorder}`);
						} else {
							d3.select(this)
								.style("border", "2px solid #e5e7eb")
								.style("border-left", "2px solid #e5e7eb")
								.style("background-color", "#fff")
								.style("margin-left", "0px");
						}
						autosaveSelectedThemeProgress({ immediate: true });
						updateSelectedThemeBadge(capturedThemeName);
					});
				}
			}


	const themeCloudCode = wordCloud.append("div")
		.attr("id", "themeCloudCode")
		.style("position", "absolute")
		.style("background", "#f4f4f4")
		.style("border-radius", "26px")
		.style("padding", "10px 15px 10px 15px")
		.style("bottom", "90px")
		.style("display", "flex")
		.style("flex-direction", "row")
		.style("align-items", "center")
		.style("display", "none");

	for (let i = 0; i < tempThemesObject.tempThemes.length; i++) {
		const themeName = tempThemesObject.tempThemes[i].themeName;
		const circle = themeCloudCode.append("button")
			.attr("id", "circle_" + themeName)
			.style("margin", "5px")
			.style("background", "#4e4e4e")
			.style("width", "10px")
			.style("height", "12px")
			.style("border-radius", "50%");

		if (themeNamesMatch(themeName, selectedThemeBoxObject.selectedThemeBox)) {
			circle.style("width", "15px")
				.style("height", "15px")
				.style("background", tempThemesObject.tempThemes[i].color);
		}

		circle.on("click", function () {
			selectedThemeBoxObject.selectedThemeBox = themeName;
			makeThemeBoxes(108, 220);
			makeWordClouds();
		});
	}
}
