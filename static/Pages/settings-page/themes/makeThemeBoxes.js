import { makeWordClouds } from "./makeWordClouds.js?v=20260921a";
//import { editThemes } from "./editThemes.js";
import { themesObject, themeColors, multiSelectedWordsObject, selectedThemeBoxObject, tempThemesObject, currentBoxHeightObject, 
	currentBoxWidthObject, wordSelectedAlreadyObject, mouseOverDeleteWordObject, 
	showingStemmedWordsInstructionsObject, showingStemmedWordsObject, 
	mouseOverDeleteStemmedWordObject, graphWidthObject, currentDisplayObject, themeObject} from "../../../chromascribe-main.js";
import { addTail } from "../../../errorBoxTails.js";
import {
	archiveCodeInPayload,
	persistThemePayload,
	buildThemeWordIdentityKey,
	getNextAvailableThemeColor,
	isManualExcerptEffectivelySelected,
	isManualThemeWordEntry,
	migrateManualSelectionThemeName,
	normalizeManualSelectionOptOuts,
	normalizeThemeWordText,
	setManualCodeSelection
} from "../../themePersistence.js?v=20260901b";

var firstPopUpClick = true;
var creatingNewTheme = false;
var closePop = false;
const THEME_COLOR_POPUP_WIDTH = 280;

function getThemeColorPopupPosition(anchorNode) {
    const anchorRect = anchorNode && anchorNode.getBoundingClientRect
        ? anchorNode.getBoundingClientRect()
        : { top: 16, left: 16, right: 16 };
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const margin = 12;
    const estimatedHeight = 392;
    let left = anchorRect.right + margin;
    if (left + THEME_COLOR_POPUP_WIDTH > viewportWidth - margin) {
        left = anchorRect.left - THEME_COLOR_POPUP_WIDTH - margin;
    }
    left = Math.max(margin, Math.min(left, viewportWidth - THEME_COLOR_POPUP_WIDTH - margin));

    let top = anchorRect.top - 12;
    if (top + estimatedHeight > viewportHeight - margin) {
        top = viewportHeight - estimatedHeight - margin;
    }
    top = Math.max(margin, top);

    return { left, top };
}

function getCurrentProjectId() {
	const params = new URLSearchParams(window.location.search || "");
	const urlProjectId = params.get("projectId") || params.get("project_id");
	if (urlProjectId && urlProjectId.trim()) return urlProjectId.trim();
	const rawValue = localStorage.getItem("currentProjectId");
	if (typeof rawValue === "string" && rawValue.trim()) return rawValue.trim();
	const serverProjectId = window.CURRENT_PROJECT_ID;
	return typeof serverProjectId === "string" ? serverProjectId.trim() : "";
}

function withProjectPayload(payload) {
	const projectId = getCurrentProjectId();
	return projectId && payload && typeof payload === "object"
		? { ...payload, projectId }
		: payload;
}

function recordCodebookWorkflowEvent(eventType, details = {}, metrics = {}) {
	const logger = window.ChromaUsageLogger;
	if (!logger || typeof logger.recordFeatureEvent !== "function") {
		return;
	}
	logger.recordFeatureEvent("codebook_management", eventType, details, metrics);
}

function recordCodebookAnalysisAction(operation, details = {}) {
	const logger = window.ChromaUsageLogger;
	if (!logger || typeof logger.recordAction !== "function") {
		return;
	}
	logger.recordAction("codebook_management", "code", operation, details);
}

function makeSafeId(name) {
    return normalizeThemeCountKey(name).replace(/\s+/g, "_");
}

function normalizeThemeCountKey(themeName) {
	return String(themeName || "")
		.replace(/[_-]+/g, " ")
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function formatThemeNameForDisplay(themeName) {
	return String(themeName || "").replace(/_/g, " ").trim();
}

function themeNamesMatchForCount(leftThemeName, rightThemeName) {
	const leftKey = normalizeThemeCountKey(leftThemeName);
	const rightKey = normalizeThemeCountKey(rightThemeName);
	if (!leftKey || !rightKey) return false;
	return leftKey === rightKey || leftKey.replace(/\s+/g, "") === rightKey.replace(/\s+/g, "");
}

function findThemeForCount(themeList, themeName) {
	return (Array.isArray(themeList) ? themeList : []).find(
		theme => themeNamesMatchForCount(theme && theme.themeName, themeName)
	);
}

function isExplicitMatchingExcerptSelection(wordEntry) {
	if (!wordEntry || typeof wordEntry !== "object") return false;
	const selectionSource = String(wordEntry.selectionSource || wordEntry.selectedSource || "").trim().toLowerCase();
	const selectionStage = String(wordEntry.selectionStage || "").trim().toLowerCase();
	return Boolean(
		wordEntry.selectedInMatching === true
		|| wordEntry.matchingSelection === true
		|| selectionStage === "matching_excerpts_selected"
		|| (wordEntry.selectedByUser === true && selectionSource === "matching_excerpts")
	);
}

function getSelectedExcerptCountKey(wordEntry) {
	const identityKey = buildThemeWordIdentityKey(wordEntry);
	if (identityKey) return identityKey;
	return normalizeThemeWordText(wordEntry && typeof wordEntry === "object" ? wordEntry.word : wordEntry).toLowerCase();
}

function countSelectedMatchingExcerptsForTheme(themeName, persistedTheme) {
	const seen = new Set();

	const addEntry = (entry) => {
		const key = getSelectedExcerptCountKey(entry);
		if (key) seen.add(key);
	};

	const addSelectedWordsFromTheme = (themeRecord) => {
		(Array.isArray(themeRecord && themeRecord.words) ? themeRecord.words : [])
			.filter(word => (
				isManualThemeWordEntry(word)
					? isManualExcerptEffectivelySelected(themesObject, themeName, word)
					: isExplicitMatchingExcerptSelection(word)
			))
			.forEach(addEntry);
	};

	if (Array.isArray(multiSelectedWordsObject && multiSelectedWordsObject.selectedWords)) {
		multiSelectedWordsObject.selectedWords.forEach((selection) => {
			if (!themeNamesMatchForCount(selection && selection.themeName, themeName)) return;
			addEntry(selection);
		});
	}

	addSelectedWordsFromTheme(persistedTheme);
	addSelectedWordsFromTheme(findThemeForCount(themesObject && themesObject.themes, themeName));
	addSelectedWordsFromTheme(findThemeForCount(tempThemesObject && tempThemesObject.tempThemes, themeName));

	return seen.size;
}

function clampColorChannel(value) {
    const numericValue = Number.parseInt(value, 10);
    if (!Number.isFinite(numericValue)) return 0;
    return Math.max(0, Math.min(255, numericValue));
}

function normalizeHexColor(value, fallback = "#579AE2") {
    const rawValue = String(value || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(rawValue)) {
        return rawValue.toUpperCase();
    }
    if (/^#[0-9a-f]{3}$/i.test(rawValue)) {
        const expanded = rawValue
            .slice(1)
            .split("")
            .map(channel => channel + channel)
            .join("");
        return `#${expanded}`.toUpperCase();
    }
    return fallback.toUpperCase();
}

function hexToRgb(value) {
    const normalized = normalizeHexColor(value);
    return {
        r: Number.parseInt(normalized.slice(1, 3), 16),
        g: Number.parseInt(normalized.slice(3, 5), 16),
        b: Number.parseInt(normalized.slice(5, 7), 16)
    };
}

function rgbToHex(r, g, b) {
    const toHex = channel => clampColorChannel(channel).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function getNextThemeColor() {
    const selectedThemes = Array.isArray(themesObject.themes) ? themesObject.themes : [];
    return getNextAvailableThemeColor(selectedThemes);
}

async function applyThemeColor(themeIndex, nextColor, boxHeight, boxWidth) {
    const theme = themesObject.themes[themeIndex];
    if (!theme) return;

    const color = normalizeHexColor(nextColor, theme.color || themeColors[themeIndex % themeColors.length] || "#579AE2");
    theme.color = color;
    if (tempThemesObject.tempThemes[themeIndex]) {
        tempThemesObject.tempThemes[themeIndex].color = color;
    }

    await persistCurrentThemes();
    makeThemeBoxes(boxHeight, boxWidth);
    makeWordClouds();
}

function normalizeThemeNameInput(value) {
    return String(value || "")
        .replace(/\s+/g, "_")
        .replace(/[^\w-]/g, "")
        .trim();
}

function normalizeThemeNameCollisionKey(value) {
    return normalizeThemeNameInput(value).toLowerCase();
}

function getThemeNameSet(excludeIndex = -1) {
    const names = new Set();
    (themesObject.themes || []).forEach((theme, index) => {
        if (index === excludeIndex) return;
        const themeName = normalizeThemeNameCollisionKey(theme && theme.themeName);
        if (themeName) names.add(themeName);
    });
    return names;
}

function getUniqueThemeName(baseName = "newtheme") {
    const normalizedBase = normalizeThemeNameInput(baseName) || "newtheme";
    const names = getThemeNameSet();
    if (!names.has(normalizeThemeNameCollisionKey(normalizedBase))) return normalizedBase;

    let suffix = 2;
    while (names.has(normalizeThemeNameCollisionKey(`${normalizedBase}_${suffix}`))) {
        suffix += 1;
    }
    return `${normalizedBase}_${suffix}`;
}

function syncGlobalThemeObject() {
    if (!themeObject || !Array.isArray(themesObject.themes)) return;
	themeObject.manualSelectionOptOuts = normalizeManualSelectionOptOuts(themesObject);
    themeObject.themes = themesObject.themes.map(theme => ({
        themeName: String(theme && theme.themeName || "").trim(),
        color: normalizeHexColor(theme && theme.color, "#579AE2"),
        summary: String(theme && theme.summary || ""),
        words: Array.isArray(theme && theme.words) ? structuredClone(theme.words) : [],
        highlight: Array.isArray(theme && theme.highlight) ? structuredClone(theme.highlight) : [],
        groups: Array.isArray(theme && theme.groups) ? structuredClone(theme.groups) : [],
        comment: String(theme && theme.comment || "")
    })).filter(theme => theme.themeName);
}

async function ensureThemeExistsInOutput(themeName, color = "") {
    const normalizedThemeName = normalizeThemeNameInput(themeName);
    if (!normalizedThemeName) return;

    try {
        const response = await fetch("/api/add_new_theme", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(withProjectPayload({ themeName: normalizedThemeName, color }))
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            console.warn("Could not create theme in ai_generated.json:", payload.error || response.statusText);
        }
    } catch (error) {
        console.warn("Could not create theme in ai_generated.json:", error);
    }
}

async function persistCurrentThemes({ ensureOutputTheme = "", ensureOutputThemeColor = "", manualDeletionIntent = null } = {}) {
    syncGlobalThemeObject();
    const persistedPayload = await persistThemePayload(
		{
			themes: themesObject.themes,
			archivedCodes: Array.isArray(themesObject.archivedCodes) ? themesObject.archivedCodes : [],
			manualSelectionOptOuts: normalizeManualSelectionOptOuts(themesObject),
			...(Number.isInteger(themesObject.projectRevision) ? { projectRevision: themesObject.projectRevision } : {})
		},
        manualDeletionIntent ? { manualDeletionIntent } : {}
    );
    themesObject.themes = persistedPayload.themes;
	themesObject.archivedCodes = structuredClone(persistedPayload.archivedCodes || []);
	if (Number.isInteger(persistedPayload.projectRevision)) {
		themesObject.projectRevision = persistedPayload.projectRevision;
	}
    syncGlobalThemeObject();
    if (ensureOutputTheme) {
        const persistedTheme = findThemeForCount(themesObject.themes, ensureOutputTheme);
        await ensureThemeExistsInOutput(
            ensureOutputTheme,
            ensureOutputThemeColor || persistedTheme?.color || ""
        );
    }
}

function removeDeletedThemeSelectionState(themeName) {
    if (!Array.isArray(multiSelectedWordsObject.selectedWords)) {
        multiSelectedWordsObject.selectedWords = [];
        return;
    }
    multiSelectedWordsObject.selectedWords = multiSelectedWordsObject.selectedWords.filter(
        selection => !themeNamesMatchForCount(selection && selection.themeName, themeName)
    );
}

function removeThemeByName(themeList, themeName) {
    if (!Array.isArray(themeList)) return [];
    return themeList.filter(theme => !themeNamesMatchForCount(theme && theme.themeName, themeName));
}

function renderThemeArchivedState(archivedThemeName, remainingThemeCount) {
    const wordCloud = d3.select("#word-cloud");
    if (wordCloud.empty()) return;

    wordCloud.selectAll("*").remove();
    const message = wordCloud.append("div")
        .style("height", "100%")
        .style("width", "100%")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("padding", "48px")
        .style("box-sizing", "border-box")
        .style("font-family", "Inter");

    const panel = message.append("div")
        .style("max-width", "420px")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("gap", "10px")
        .style("text-align", "center")
        .style("color", "#374151");

    panel.append("div")
        .style("font-size", "18px")
        .style("font-weight", "800")
        .style("color", "#111827")
        .text("Code archived");

    panel.append("div")
        .style("font-size", "14px")
        .style("line-height", "1.5")
        .text(
            remainingThemeCount > 0
                ? `Archived ${String(archivedThemeName || "the selected code").replace(/_/g, " ")}. Select another code to review excerpts.`
                : "No active codes remain. Restore one from Archive or add a code to continue."
        );
}

async function archiveThemeAtIndex(themeIndex, boxHeight, boxWidth) {
    const themeToArchive = themesObject.themes[themeIndex];
    const archivedThemeName = String(themeToArchive && themeToArchive.themeName || "").trim();
    if (!archivedThemeName) return;
	const confirmed = window.confirm(
		`Archive "${archivedThemeName}"?\n\nThe code and all of its quotation assignments will move to Archive, where you can restore them later.`
	);
	if (!confirmed) return;

    const archivedWasSelected = themeNamesMatchForCount(
        selectedThemeBoxObject.selectedThemeBox,
        archivedThemeName
    );

	const nextPayload = archiveCodeInPayload(themesObject, archivedThemeName);
	const persistedPayload = await persistThemePayload(nextPayload, {
		manualDeletionIntent: { themes: [archivedThemeName] },
		rollbackOnError: true,
		throwOnError: true
	});
	themesObject.themes = structuredClone(persistedPayload.themes);
	themesObject.archivedCodes = structuredClone(persistedPayload.archivedCodes || []);
	if (Number.isInteger(persistedPayload.projectRevision)) {
		themesObject.projectRevision = persistedPayload.projectRevision;
	}
	tempThemesObject.tempThemes = removeThemeByName(tempThemesObject.tempThemes, archivedThemeName);
	removeDeletedThemeSelectionState(archivedThemeName);

    if (archivedWasSelected) {
        selectedThemeBoxObject.selectedThemeBox = "";
    }

	recordCodebookWorkflowEvent("code_archived", {
		codeName: archivedThemeName,
		archivedWasSelected,
		remainingCodeCount: themesObject.themes.length
	}, { archives: 1 });
	recordCodebookAnalysisAction("archive", {
		codeName: archivedThemeName,
		archivedWasSelected,
		remainingCodeCount: themesObject.themes.length
	});
	makeThemeBoxes(boxHeight, boxWidth);

    if (archivedWasSelected) {
        renderThemeArchivedState(archivedThemeName, themesObject.themes.length);
        return;
    }

    if (findThemeForCount(themesObject.themes, selectedThemeBoxObject.selectedThemeBox)) {
        makeWordClouds();
    } else {
        selectedThemeBoxObject.selectedThemeBox = "";
        renderThemeArchivedState(archivedThemeName, themesObject.themes.length);
    }
}

function resetThemeNameText(inputNode, themeName) {
    inputNode.innerText = formatThemeNameForDisplay(themeName);
}

async function renameThemeEverywhere(inputNode, boxHeight, boxWidth) {
    const inputSelection = d3.select(inputNode);
    const themeIndex = Number(inputSelection.attr("data-theme-index"));
    const theme = themesObject.themes[themeIndex];
    if (!theme) return;

    if (inputNode.__themeRenameCommitting) return;
    inputNode.__themeRenameCommitting = true;

    const previousName = normalizeThemeNameInput(
        inputSelection.attr("data-theme-name") || theme.themeName
    );
    const nextName = normalizeThemeNameInput(inputNode.innerText);

    try {
        if (!nextName) {
            resetThemeNameText(inputNode, previousName);
            return;
        }

        if (nextName === previousName) {
            resetThemeNameText(inputNode, previousName);
            return;
        }

        if (getThemeNameSet(themeIndex).has(normalizeThemeNameCollisionKey(nextName))) {
            resetThemeNameText(inputNode, previousName);
            var errorMessage = d3.select(inputNode.parentNode.parentNode.parentNode).append("div")
                .attr("id", "name_error_message")
                .attr("class", "error")
                .text("You must choose a unique theme name");
            setTimeout(function(){ d3.select("#name_error_message").remove(); }, 5000);
            return;
        }

        theme.themeName = nextName;
        if (tempThemesObject.tempThemes[themeIndex]) {
            tempThemesObject.tempThemes[themeIndex].themeName = nextName;
        }
        selectedThemeBoxObject.selectedThemeBox = nextName;
        inputSelection.attr("data-theme-name", nextName);
        resetThemeNameText(inputNode, nextName);

        try {
            const response = await fetch("/api/rename_theme", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(withProjectPayload({ oldName: previousName, newName: nextName }))
            });
            if (!response.ok && response.status !== 404) {
                const payload = await response.json().catch(() => ({}));
                console.warn("Could not rename theme in ai_generated.json:", payload.error || response.statusText);
            }
        } catch (error) {
            console.warn("Could not rename theme in ai_generated.json:", error);
        }

		migrateManualSelectionThemeName(themesObject, previousName, nextName);

        await persistCurrentThemes({
            ensureOutputTheme: nextName,
            manualDeletionIntent: { themes: [previousName] }
        });
        makeThemeBoxes(boxHeight, boxWidth);
        makeWordClouds();
    } finally {
        inputNode.__themeRenameCommitting = false;
    }
}

function formatBoxSize(value, fallback = "260px") {
    if (typeof value === "number") return `${value}px`;
    const text = String(value || "").trim();
    return text || fallback;
}

function applyThemesForDemographics() {
    fetch('/visualization', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(withProjectPayload(themesObject)),
    })
    .then(response => {
        if (response.ok) {
            // Redirect to demographic page
            window.location.href = '/demographics/choose-attributes';
        } else {
            console.error('Failed to send data', response.statusText);
        }
    })
    .catch(error => {
        console.error('Error:', error);
    });
}

function returnToThemeEditor() {
    fetch('/themes/edit', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(withProjectPayload(themesObject)),
    })
    .then(response => {
        if (response.ok) {
            window.location.href = '/themes/edit';
        } else {
            console.error('Failed to send data', response.statusText);
        }
    })
    .catch(error => {
        console.error('Error:', error);
    });
}

function selectThemeNavigationCircle() {
    selectedThemeBoxObject.selectedThemeBox = this.id.substring(7);
    console.log("hello");
    makeThemeBoxes(108, 220);
    makeWordClouds();
}

function renderThemeNavigation() {
    d3.select("#themeCloudCode").selectAll("*").remove();
    for (const theme of themesObject.themes) {
        const circle = d3.select("#themeCloudCode").append("button")
            .attr("id", "circle_"+theme.themeName)
            .style("margin", "5px")
            .style("background", "#4e4e4e")
            .style("width", "10px")
            .style("height", "12px")
            .style("border-radius", "50%");
        if (theme.themeName === selectedThemeBoxObject.selectedThemeBox){
            circle.style("width", "15px")
                .style("height", "15px")
                .style("background", theme.color);
        }
        circle.on("click", selectThemeNavigationCircle);
    }
}

function selectThemeBox() {
    d3.selectAll(".themeColors").style("opacity", 0.3);
    d3.select(this).select(".themeColors").style("opacity", 1);
    selectedThemeBoxObject.selectedThemeBox = this.getAttribute("data-theme-name") || this.id.substring(9);
    makeWordClouds();

    renderThemeNavigation();
}

function renderThemeColorPopupHeader(popUp, committedColor) {
    const popupHeader = popUp.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "space-between")
        .style("gap", "12px")
        .style("padding", "14px 14px 8px 14px")
        .style("font-family", "Inter");
    popupHeader.append("div")
        .style("font-size", "14px")
        .style("font-weight", "800")
        .style("color", "#111827")
        .text("Theme color");
    popupHeader.append("div")
        .style("width", "24px")
        .style("height", "24px")
        .style("border-radius", "999px")
        .style("border", "2px solid #e5e7eb")
        .style("background", committedColor);
}

function renderThemeArchiveButton(popUp, themeIndex, boxHeight, boxWidth, closeThemePopup) {
    popUp.append("button")
        .style("background", "none")
        .style("gap", 0)
        .style("width", "100%")
        .style("padding", "10px")
        .style("border-radius", 0)
        .style("text-align", "start")
        .text("Archive")
        .on("mouseover", function() {
            d3.select(this).style("background", "#d9d9d9");
        })
        .on("mouseout", function() {
            d3.select(this).style("background", "none");
        })
        .on("click", async function() {
            if (d3.event) {
                d3.event.stopPropagation();
            }
            closeThemePopup();
            try {
                await archiveThemeAtIndex(themeIndex, boxHeight, boxWidth);
            } catch (error) {
                console.error("Could not archive code:", error);
                window.alert(error.message || "Could not archive this code. Please try again.");
            }
        });
}

function renderThemeQuickColors(popUp, themeIndex, boxHeight, boxWidth, committedColor, closeThemePopup) {
    popUp.append("div")
        .style("padding", "10px 10px 0 10px")
        .style("font-family", "Inter")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .style("color", "#4b5563")
        .text("Quick colors");

    const chooseColor = popUp.append("div")
        .style("background", "none")
        .style("padding","8px 10px 10px 10px")
        .style("gap", "10px")
        .style("width", "100%")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "start")
        .style("flex-wrap", "wrap")
        .style("cursor", "default");

    for (const color of themeColors) {
        const colorButton = chooseColor.append("button")
            .attr("id", color.substring(1))
            .style("background", color)
            .style("border-radius", "50%")
            .style("width", "20px")
            .style("height", "20px")
            .style("opacity", function() {
                if (normalizeHexColor(color) === committedColor) {
                    d3.select(this).style("border", "2px solid #4e4e4e");
                }
                return 1;
            })
            .on("click", async function() {
                if (d3.event) {
                    d3.event.stopPropagation();
                }
                chooseColor.selectAll("*").style("border", "none");
                d3.select(this).style("border", "2px solid #4e4e4e");
                closeThemePopup();
                await applyThemeColor(themeIndex, "#" + this.id, boxHeight, boxWidth);
            });
    }
}

function createThemeRgbInput(rgbRow, labelText) {
    const field = rgbRow.append("label")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("gap", "4px")
        .style("font-family", "Inter")
        .style("font-size", "11px")
        .style("font-weight", "700")
        .style("color", "#4b5563");

    field.append("span").text(labelText);
    return field.append("input")
        .attr("type", "number")
        .attr("min", "0")
        .attr("max", "255")
        .style("width", "100%")
        .style("border", "1px solid #d1d5db")
        .style("border-radius", "6px")
        .style("padding", "6px 8px")
        .style("font-family", "Inter")
        .style("font-size", "12px")
        .on("click", function() {
            if (d3.event) {
                d3.event.stopPropagation();
            }
        });
}

function renderThemeCustomColorInputs(popUp) {
    popUp.append("div")
        .style("padding", "2px 10px 0 10px")
        .style("font-family", "Inter")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .style("color", "#4b5563")
        .text("Custom RGB");

    const customColorSection = popUp.append("div")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("gap", "10px")
        .style("padding", "8px 10px 12px 10px");

    const pickerRow = customColorSection.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "10px");

    const colorPreview = pickerRow.append("div")
        .style("width", "28px")
        .style("height", "28px")
        .style("border-radius", "6px")
        .style("border", "1px solid #d1d5db");

    const colorPicker = pickerRow.append("input")
        .attr("type", "color")
        .style("width", "56px")
        .style("height", "32px")
        .style("padding", "0")
        .style("border", "none")
        .style("background", "transparent")
        .style("cursor", "pointer")
        .on("click", function() {
            if (d3.event) {
                d3.event.stopPropagation();
            }
        });

    const rgbRow = customColorSection.append("div")
        .style("display", "grid")
        .style("grid-template-columns", "repeat(3, minmax(0, 1fr))")
        .style("gap", "8px");

    const redInput = createThemeRgbInput(rgbRow, "R");
    const greenInput = createThemeRgbInput(rgbRow, "G");
    const blueInput = createThemeRgbInput(rgbRow, "B");

    return { customColorSection, colorPicker, colorPreview, redInput, greenInput, blueInput };
}

function bindThemeColorInputs(controls, syncColorInputs, commitColorFromInputs, persistPendingColor) {
    const { customColorSection, colorPicker, colorPreview, redInput, greenInput, blueInput } = controls;
    const applyButton = customColorSection.append("button")
        .style("border-radius", "8px")
        .style("background", "#3A61DD")
        .style("color", "#ffffff")
        .style("padding", "8px 12px")
        .style("font-family", "Inter")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .style("align-self", "flex-start")
        .text("Apply Color")
        .on("click", async function() {
            if (d3.event) {
                d3.event.stopPropagation();
            }
            await commitColorFromInputs(colorPicker, redInput, greenInput, blueInput, colorPreview);
        });

    colorPicker
        .on("input", function() {
            if (d3.event) {
                d3.event.stopPropagation();
            }
            syncColorInputs(this.value, colorPicker, redInput, greenInput, blueInput, colorPreview);
        })
        .on("change", async function() {
            if (d3.event) {
                d3.event.stopPropagation();
            }
            syncColorInputs(this.value, colorPicker, redInput, greenInput, blueInput, colorPreview);
            await persistPendingColor();
        });

    [redInput, greenInput, blueInput].forEach(input => {
        input
            .on("input", function() {
                if (d3.event) {
                    d3.event.stopPropagation();
                }
                this.value = clampColorChannel(this.value);
            })
            .on("change", async function() {
                if (d3.event) {
                    d3.event.stopPropagation();
                }
                await commitColorFromInputs(colorPicker, redInput, greenInput, blueInput, colorPreview);
            })
            .on("keypress", async function() {
                if (d3.event && d3.event.keyCode === 13) {
                    d3.event.preventDefault();
                    await commitColorFromInputs(colorPicker, redInput, greenInput, blueInput, colorPreview);
                }
            });
    });
}

function openThemeColorPopup(iconNode, boxHeight, boxWidth) {
    d3.selectAll("#popUp").remove();
    d3.select("body").on("click.theme-color-popup", null);
    d3.event.preventDefault();
    d3.event.stopPropagation();
    const themeIndex = Number(iconNode.id.substring(10));
    const button = d3.select("#themePopUpButton_"+themeIndex);
    const popupPosition = getThemeColorPopupPosition(button.node());
    const popUp = d3.select("body").append("div")
        .attr("class", "sections")
        .attr("id", "popUp")
        .style("z-index", 10000)
        .style("border-radius", "12px")
        .style("position", "fixed")
        .style("left", `${popupPosition.left}px`)
        .style("top", `${popupPosition.top}px`)
        .style("width", `${THEME_COLOR_POPUP_WIDTH}px`)
        .style("max-height", "min(82vh, 420px)")
        .style("overflow-y", "auto")
        .style("display", "block")
        .style("box-shadow", "0 18px 45px rgba(15, 23, 42, 0.22)")
        .style("border", "1px solid #e5e7eb")
        .style("background", "#ffffff");

    const closeThemePopup = () => {
        d3.select("body").on("click.theme-color-popup", null);
        if (!popUp.empty()) {
            popUp.remove();
        }
        closePop = false;
    };

    popUp.on("click", function() {
        if (d3.event) {
            d3.event.stopPropagation();
        }
    });

    let committedColor = normalizeHexColor(
        themesObject.themes[themeIndex].color || themeColors[themeIndex % themeColors.length]
    );
    let pendingColor = committedColor;

    renderThemeColorPopupHeader(popUp, committedColor);

    renderThemeArchiveButton(popUp, themeIndex, boxHeight, boxWidth, closeThemePopup);

    const syncColorInputs = (hexColor, picker, redInput, greenInput, blueInput, preview) => {
        const normalizedColor = normalizeHexColor(hexColor, committedColor);
        pendingColor = normalizedColor;
        const { r, g, b } = hexToRgb(normalizedColor);
        picker.property("value", normalizedColor.toLowerCase());
        preview.style("background", normalizedColor);
        redInput.property("value", r);
        greenInput.property("value", g);
        blueInput.property("value", b);
    };

    const persistPendingColor = async ({ closeEditor = true } = {}) => {
        const nextColor = normalizeHexColor(pendingColor, committedColor);
        committedColor = nextColor;
        if (closeEditor) {
            closeThemePopup();
        }
        await applyThemeColor(themeIndex, nextColor, boxHeight, boxWidth);
    };

    const commitColorFromInputs = async (picker, redInput, greenInput, blueInput, preview) => {
        const nextColor = rgbToHex(
            redInput.property("value"),
            greenInput.property("value"),
            blueInput.property("value")
        );
        syncColorInputs(nextColor, picker, redInput, greenInput, blueInput, preview);
        await persistPendingColor();
    };

    renderThemeQuickColors(popUp, themeIndex, boxHeight, boxWidth, committedColor, closeThemePopup);
    const controls = renderThemeCustomColorInputs(popUp);
    const { colorPicker, colorPreview, redInput, greenInput, blueInput } = controls;

    bindThemeColorInputs(controls, syncColorInputs, commitColorFromInputs, persistPendingColor);

    syncColorInputs(
        themesObject.themes[themeIndex].color || themeColors[themeIndex % themeColors.length],
        colorPicker,
        redInput,
        greenInput,
        blueInput,
        colorPreview
    );

    d3.select("body").on("click.theme-color-popup", async function() {
        if (pendingColor !== committedColor) {
            await persistPendingColor();
            return;
        }
        closeThemePopup();
    });
}

function renderThemeName(topRow, themeIndex, boxHeight, boxWidth, layout) {
    const { isCompactMatchingView } = layout;
    const rawThemeName = themesObject.themes[themeIndex].themeName;
    const themeDisplayName = formatThemeNameForDisplay(rawThemeName);

    const themeName = topRow.append("div")
        .attr("contenteditable", "true")
        .attr("id", "themeName_"+rawThemeName.substring(0,1).toUpperCase()+rawThemeName.substring(1))
        .attr("data-theme-index", themeIndex)
        .attr("data-theme-name", rawThemeName)
        .attr("class", "themeName")
        .style("width", layout.titleWidth)
        .style("max-width", layout.titleWidth)
        .style("min-width", "0")
        .style("word-break", "break-word")
        .style("overflow-wrap", "break-word")
        .style("white-space", "normal")
        .style("font-family", "Inter")
        .style("font-weight", 700)
        .style("font-size", layout.titleFontSize)
        .style("line-height", isCompactMatchingView ? "1.25" : "normal")
        .style("margin-left", layout.titleMarginLeft)
        .style("margin-top", layout.titleMarginTop)
        .style("max-height", isCompactMatchingView ? "46px" : "none")
        .style("overflow", isCompactMatchingView ? "hidden" : "visible")
        .style("border", "none")
        .style("border-radius", "5px")
        .style("background", "none")
        .style("outline", "none")
        .style("cursor", "text")
        .style("line-height", isCompactMatchingView ? "1.25" : "1.4")
        .text(themeDisplayName)
        .on("focus", function() {
            d3.select(this).style("background", "#eeeeee");
            d3.select("#name_error_message").remove();
        })
        .on("blur", async function() {
            d3.select(this).style("background", "none");
            await renameThemeEverywhere(this, boxHeight, boxWidth);
        })
        .on("input", function() {
            d3.select("#name_error_message").remove();
        })
        .on("keypress", async function() {
            if (d3.event.keyCode === 13) {
                d3.event.preventDefault();
                d3.select(this).style("background", "none");
                await renameThemeEverywhere(this, boxHeight, boxWidth);
            }
        });
    tippy(themeName.node(), {
        content: themeDisplayName,
        placement: 'bottom',
        theme: 'blue',
        trigger: 'mouseenter focus',
    });
}

function renderThemeSummary(themeContent, themeIndex, layout) {
    const { isCompactMatchingView } = layout;
    const themeSummaryText = String(themesObject.themes[themeIndex].summary || "").trim();
    if (themeSummaryText) {
        const summaryBlock = themeContent.append("div")
            .attr("class", "themeSummary")
            .style("margin", layout.summaryMargin)
            .style("font-family", "Inter")
            .style("font-size", layout.summaryFontSize)
            .style("font-weight", "500")
            .style("line-height", "1.3")
            .style("color", "#4b5563")
            .style("display", "-webkit-box")
            .style("-webkit-line-clamp", isCompactMatchingView ? "2" : "3")
            .style("-webkit-box-orient", "vertical")
            .style("overflow", "hidden")
            .style("word-break", "break-word")
            .text(themeSummaryText);
        tippy(summaryBlock.node(), {
            content: themeSummaryText,
            placement: "bottom",
            theme: "blue",
            trigger: "mouseenter focus",
        });
    }
}

function renderThemeMenu(topRow, themeIndex, boxHeight, boxWidth, layout) {
    const themePopUpButton = topRow.append("button")
        .attr("id", "themePopUpButton_"+themeIndex)
        .style("position", "absolute")
        .style("top", layout.menuTop)
        .style("right", layout.menuRight)
        .style("height", layout.menuHeight)
        .style("background", "none")
        .style("padding", 0)
        .style("cursor", "pointer");

    const threeDots = themePopUpButton.append("img")
        .attr("id", "threeDots_"+themeIndex)
        .attr("class", "interactive-icon")
        .attr("src", "/static/images/three-dots.png")
        .style("height", "100%");

    threeDots.on("click", function() {
        openThemeColorPopup(this, boxHeight, boxWidth);
    });
}

function renderThemeExcerptContainer(themeContent, theme, layout) {
    const { isCodeExcerptMatchingView, isCompactMatchingView } = layout;
    const wordArray = themeContent.append("div")
        .attr("id", theme.themeName+"_wordArray")
        .style("display", isCompactMatchingView ? "none" : "flex")
        .style("flex-direction", "row")
        .style("margin-top", isCodeExcerptMatchingView ? "6px" : "10px")
        .style("margin-left", isCodeExcerptMatchingView ? "8px" : "12px")
        .style("margin-right", isCodeExcerptMatchingView ? "8px" : "12px")
        .style("height", "auto")
        .style("min-height", isCodeExcerptMatchingView ? "38px" : "60px")
        .style("flex", "1")
        .style("flex-wrap", "wrap")
        .style("align-content", "flex-start")
        .style("overflow", "auto");
}

function renderThemeSelectedCount(themeContent, theme, layout) {
    const selectedCount = countSelectedMatchingExcerptsForTheme(theme.themeName, theme);
    const badgeRow = themeContent.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("padding", layout.badgeRowPadding)
        .style("gap", "6px");

    badgeRow.append("div")
        .attr("id", "selectedBadge_" + makeSafeId(theme.themeName))
        .attr("class", "selected-theme-badge")
        .attr("data-theme-name", theme.themeName)
        .attr("data-theme-key", normalizeThemeCountKey(theme.themeName))
        .style("background", selectedCount > 0 ? "#1a1a1a" : "#e5e7eb")
        .style("color", selectedCount > 0 ? "#ffffff" : "#9ca3af")
        .style("border-radius", "999px")
        .style("padding", layout.badgePadding)
        .style("font-size", layout.badgeFontSize)
        .style("font-weight", "700")
        .style("font-family", "Inter")
        .text(selectedCount > 0 ? `${selectedCount} selected` : "0 selected");
}

function toggleThemeWordCardSelection(cardNode, themeColor, wordElement, index) {
    const checkbox = d3.select(cardNode).select("input[type='checkbox']");
    const isChecked = checkbox.property("checked");
    checkbox.property("checked", !isChecked);

    if (!isChecked) {
        d3.select(cardNode)
            .style("padding-left", "30px")
            .style("margin-left", "0px")
            .style("border-left", `8px solid ${themeColor}`);

        if (!multiSelectedWordsObject.selectedWords.some(w => w.word === wordElement.word && w.index === Number(index))) {
            multiSelectedWordsObject.selectedWords.push({
                word: wordElement.word,
                index: Number(index),
                source: "cloud"
            });
        }
    } else {
        d3.select(cardNode)
            .style("border", "2px solid #F4F4F4")
            .style("padding-left", "10px")
            .style("margin-left", "10px");

        const removeIndex = multiSelectedWordsObject.selectedWords.findIndex(
            w => w.word === wordElement.word && w.index === Number(index)
        );
        if (removeIndex !== -1) {
            multiSelectedWordsObject.selectedWords.splice(removeIndex, 1);
        }
    }
    console.log(multiSelectedWordsObject.selectedWords);
}

function showThemeWordDeleteButton(cardNode, safeId, isCodeExcerptMatchingView) {
    d3.selectAll("#showStemmedWordsInstructions").remove();
    const word = cardNode;
    const parentId = word.parentNode.id;

    if (
        !wordSelectedAlreadyObject.wordSelectedAlready &&
        parentId === safeId &&
        !showingStemmedWordsObject.showingStemmedWords
    ) {
        d3.select(word).append("button")
            .attr("id", "deleteWord")
            .style("position", "absolute")
            .style("top", "-10px")
            .style("right", "-10px")
            .style("border-radius", "50%")
            .style("background", "#ffa3a3")
            .style("width", "25px")
            .style("height", "25px")
            .style("cursor", "pointer")
            .style("color", "#ffffff")
            .style("font-size", "15px")
            .text("x")
            .on("mouseover", () => {
                mouseOverDeleteWordObject.mouseOverDeleteWord = true;
            })
            .on("mouseout", () => {
                mouseOverDeleteWordObject.mouseOverDeleteWord = false;
            });

        wordSelectedAlreadyObject.wordSelectedAlready = true;

        if (
            !isCodeExcerptMatchingView &&
            !showingStemmedWordsInstructionsObject.showingStemmedWordsInstructions &&
            !showingStemmedWordsObject.showingStemmedWords
        ) {
            showStemmedWordsInstructions(word);
        }
    }
}

function renderThemeWordCard(theme, index, wordElement, safeId, isCodeExcerptMatchingView) {
    const isSelected = multiSelectedWordsObject.selectedWords.some(
        w => w.word === wordElement.word && w.index === Number(index) && w.source === "cloud"
    );

    const themeColor = theme.color || "#007bff";

    // Create card
    const card = d3.select("#wordCloudShape").append("div")
        .attr("id", index)
        .attr("class", "sections word")
        .style("width", "280px")
        .style("height", "260px")
        .style("border-radius", "5px")
        .style("margin", "10px")
        .style("padding", isSelected ? "10px 10px 10px 30px" : "10px")
        .style("box-sizing", "border-box")
        .style("position", "relative")
        .style("display", "flex")
        .style("justify-content", "center")
        .style("align-items", "center")
        .style("cursor", "pointer")
        .style("background-color", "#fff")
        .style("border-left", isSelected ? `8px solid ${themeColor}` : "2px solid #F4F4F4")
        .style("border-top", "2px solid #F4F4F4")
        .style("border-right", "2px solid #F4F4F4")
        .style("border-bottom", "2px solid #F4F4F4");

    // Add checkbox (purely visual)
    card.append("input")
        .attr("type", "checkbox")
        .style("position", "absolute")
        .style("top", "10px")
        .style("left", "10px")
        .style("width", "20px")
        .style("height", "20px")
        .property("checked", isSelected);

    // Add text
    card.append("div")
        .style("display", "-webkit-box")
        .style("-webkit-line-clamp", "5")
        .style("-webkit-box-orient", "vertical")
        .style("overflow", "hidden")
        .style("text-overflow", "ellipsis")
        .style("font-size", "20px")
        .style("line-height", "1.3")
        .style("text-align", "center")
        .style("width", "100%")
        .text(wordElement.word);

    // Card click toggles checkbox + styling
    card.on("click", function () {
        toggleThemeWordCardSelection(this, themeColor, wordElement, index);
    });

    // Delete button and hover
    card.on("mouseover", function () {
        showThemeWordDeleteButton(this, safeId, isCodeExcerptMatchingView);
    })
        .on("mouseleave", function () {
            d3.select(this).select("button").remove();
            d3.selectAll("#showStemmedWordsInstructions").remove();
            showingStemmedWordsInstructionsObject.showingStemmedWordsInstructions = false;
            wordSelectedAlreadyObject.wordSelectedAlready = false;
        });
}

function renderThemeWordCards(isCodeExcerptMatchingView) {
    for (const theme of themesObject.themes) {
        const safeId = theme.themeName.replace(/\s+/g, "_") + "_wordArray";

        const wordArray = d3.select("#themeList")
            .append("div")
            .attr("id", safeId)
            .attr("class", "word-array")
            .style("display", "flex")
            .style("flex-wrap", "wrap");

        for (const [index, wordElement] of Object.entries(theme.words)) {
            if (typeof wordElement !== 'object') {
                continue;
            }

            renderThemeWordCard(theme, index, wordElement, safeId, isCodeExcerptMatchingView);
        }
    }
}

async function addThemeFromButton(buttonNode, boxHeight, boxWidth) {
    const button = d3.select(buttonNode);
    button.property("disabled", true).style("opacity", 0.35);
    const colorCode = getNextThemeColor();
    const newThemeName = getUniqueThemeName("newtheme");
    themesObject.themes.push({
        themeName: newThemeName,
        color: colorCode,
        words: [],
        highlight: [],
        groups: [],
        codeSource: "manual",
        source: "manual",
        ai_generated: false,
        humanTagged: true,
        selectedByUser: true,
        selectionSource: "manual_codes"
    });
    tempThemesObject.tempThemes.push({
        themeName: newThemeName,
        color: colorCode,
        words: [],
        highlight: [],
        groups: [],
        codeSource: "manual",
        source: "manual",
        ai_generated: false,
        humanTagged: true,
        selectedByUser: true,
        selectionSource: "manual_codes"
    });
    selectedThemeBoxObject.selectedThemeBox = newThemeName;
    setManualCodeSelection(themesObject, newThemeName, true);
    await persistCurrentThemes({ ensureOutputTheme: newThemeName, ensureOutputThemeColor: colorCode });
    makeThemeBoxes(boxHeight, boxWidth);
    makeWordClouds();
}

function renderAddThemeButton(themeList, boxHeight, boxWidth, layout) {
    const { isCodeExcerptMatchingView } = layout;
    const addThemeButton = themeList.append("button")
        .style("width", formatBoxSize(boxWidth))
        .style("margin-bottom", function() {
            if (!isCodeExcerptMatchingView) {
                return "180px";
            }
            return "0px";
        })
        .style("height", layout.addButtonHeight)
        .style("border-radius", "10px")
        .style("background", "#ffffff")
        .style("border-color", "charcoal")
        .style("color", "charcoal")
        .style("border-width", "2px")
        .style("font-size", layout.addButtonFontSize)
        .style("opacity", 1)
        .text("Add a Code  +")
        .on("click", async function() {
            await addThemeFromButton(this, boxHeight, boxWidth);
        });
}

function renderThemeEditorActions(themeList) {
    const viewWordClouds = themeList.append("button")
        .style("position", "absolute")
        .style("border-radius", "10px")
        .style("background", "#ececf0")
        .style("bottom", "28px")
        .style("margin-left", "36px")
        .style("left", "16%")
        .style("padding", "12px 20px 12px 20px")
        .style("font-family", "Inter")
        .style("font-size", "16px")
        .style("font-weight", 700)
        .text("Back")
        .on("click", returnToThemeEditor);

    const applyThemesButton = themeList.append("button")
        .style("position", "absolute")
        .style("right", "20px")
        .style("bottom", "40px")
        .style("text-align", "center")
        .style("width", "170px")
        .style("height", "48px")
        .style("border-radius", "10px")
        .style("background", "#000000")
        .style("bottom", "20px")
        .style("right", "20px")
        .style("color", "#ffffff")
        .style("padding", "6px 0px 6px 0px")
        .style("font-family", "Inter")
        .style("font-size", "16px")
        .style("font-weight", 700)
        .style("font-family", "Inter")
        .style("font-weight", 700)
        .style("font-size", "16px")
        .text("Apply Codes")
        .on("click", applyThemesForDemographics);
}

function renderThemeBox(themeList, themeIndex, boxHeight, boxWidth, layout) {
    const { isCodeExcerptMatchingView } = layout;
    const themeBox = themeList.append("div")
        .attr("class", "sections")
        .attr("id", "themeBox_"+themesObject.themes[themeIndex].themeName.toLowerCase())
        .attr("data-theme-name", themesObject.themes[themeIndex].themeName)
        .style("min-height", boxHeight + "px")
        .style("height", "auto")
        .style("width", formatBoxSize(boxWidth))
        .style("flex", "0 0 auto")
        .style("box-sizing", "border-box")
        .style("display", "flex")
        .style("flex-direction", "row")
        .style("align-items", "stretch")
        .style("position", "relative")
        .on("click", selectThemeBox);

    if (!isCodeExcerptMatchingView) {
        themeBox.style("margin", "20px").style("margin-left", 0);
    }

    const themeColor = themeBox.append("div")
        .attr("class", "themeColors")
        .attr("id", "themeColors_"+themesObject.themes[themeIndex].themeName)
        .style("width", layout.colorWidth)
        .style("min-height", "100%")
        .style("align-self", "stretch")
        .style("border-radius", "10px 0 0 10px")
        .style("flex-shrink", "0")
        .style("opacity", function() {
            if (isCodeExcerptMatchingView) {
                return 1;
            }
            if (themesObject.themes[themeIndex].themeName === selectedThemeBoxObject.selectedThemeBox) {
                return 1;
            }
            return 0.3;
        })
        .style("background", themesObject.themes[themeIndex].color);

    const themeContent = themeBox.append("div")
        .style("flex", "1")
        .style("min-width", "0")
        .style("height", "auto");

    const topRow = themeContent.append("div")
        .style("width", "100%")
        .style("display", "flex")
        .style("flex-direction", "row")
        .style("flex-wrap", "wrap");

    renderThemeName(topRow, themeIndex, boxHeight, boxWidth, layout);
    renderThemeSummary(themeContent, themeIndex, layout);
    renderThemeMenu(topRow, themeIndex, boxHeight, boxWidth, layout);
    renderThemeExcerptContainer(themeContent, themesObject.themes[themeIndex], layout);
    renderThemeSelectedCount(themeContent, themesObject.themes[themeIndex], layout);

    renderThemeWordCards(isCodeExcerptMatchingView);
}

function getThemeBoxLayout(boxHeight, boxWidth) {
    const isCodeExcerptMatchingView = formatBoxSize(boxWidth) !== "100%";
    const isCompactMatchingView = isCodeExcerptMatchingView && Number(boxHeight) <= 120;
    const layout = {
        isCodeExcerptMatchingView,
        isCompactMatchingView,
        colorWidth: "10px",
        titleWidth: "calc(100% - 60px)",
        titleFontSize: "16px",
        titleMarginLeft: "22px",
        titleMarginTop: "22px",
        summaryMargin: "8px 22px 0 22px",
        summaryFontSize: "13px",
        menuTop: "12px",
        menuRight: "10px",
        menuHeight: "30px",
        badgeRowPadding: "8px 12px 12px 22px",
        badgePadding: "2px 10px",
        badgeFontSize: "12px",
        addButtonHeight: "50px",
        addButtonFontSize: "20px",
    };

    if (isCodeExcerptMatchingView) {
        Object.assign(layout, {
            colorWidth: "8px",
            titleWidth: "calc(100% - 42px)",
            titleFontSize: "13px",
            titleMarginLeft: "12px",
            titleMarginTop: "14px",
            summaryMargin: "6px 12px 0 12px",
            summaryFontSize: "11px",
            menuTop: "8px",
            menuRight: "6px",
            menuHeight: "24px",
            badgeRowPadding: "6px 8px 10px 12px",
            badgePadding: "2px 8px",
            badgeFontSize: "11px",
            addButtonHeight: "42px",
            addButtonFontSize: "14px",
        });
    }

    if (isCompactMatchingView) {
        Object.assign(layout, {
            colorWidth: "8px",
            titleWidth: "calc(100% - 34px)",
            titleFontSize: "12px",
            titleMarginLeft: "10px",
            titleMarginTop: "10px",
            summaryMargin: "5px 10px 0 10px",
            summaryFontSize: "10px",
            menuTop: "6px",
            menuRight: "4px",
            menuHeight: "20px",
            badgeRowPadding: "6px 8px 7px 10px",
            badgePadding: "2px 7px",
            badgeFontSize: "10px",
            addButtonHeight: "34px",
            addButtonFontSize: "12px",
        });
    }

    return layout;
}

export function makeThemeBoxes(boxHeight, boxWidth, themeObject) {
    const scrollTopBefore = d3.select("#themeList").node().scrollTop;
    currentBoxHeightObject.currentBoxHeight = boxHeight;
    currentBoxWidthObject.currentBoxWidth = boxWidth;
    const themeList = d3.select("#themeList");
    themeList.selectAll("*").remove();
    const layout = getThemeBoxLayout(boxHeight, boxWidth);
    const { isCodeExcerptMatchingView } = layout;

    for (let themeIndex = 0; themeIndex < themesObject.themes.length; themeIndex++) {
        renderThemeBox(themeList, themeIndex, boxHeight, boxWidth, layout);
    }
    if (isCodeExcerptMatchingView) {
        renderAddThemeButton(themeList, boxHeight, boxWidth, layout);
    }

    if (!isCodeExcerptMatchingView) {
        renderThemeEditorActions(themeList);
    }
    d3.select("#themeList").node().scrollTop = scrollTopBefore;
}

function addWord(button, boxHeight, boxWidth, currentTheme) {
	console.log(currentTheme)
	console.log(selectedThemeBoxObject.selectedThemeBox)
	const scrollTopBefore = d3.select("#themeList").node().scrollTop;

	//d3.event.preventDefault()
	var newWordContainer = d3.select("#" + currentTheme + "_wordArray").append("input")
    .attr("id", "wordInput")
    .attr("class", "sections")
    .style("margin", "10px")
    .style("height", "35px")
    .style("padding", "5px 10px 5px 10px")
    .style("border", "none")
    .style("width", "50px")
    .style("text-align", "center")
    .style("font-size", "20px")
    .on("input", function () {
        var index = button.id.substring(8) * 1;
        d3.select("#" + button.id).on("click", function () {
            console.log(themesObject.themes[index].themeName)
        })
        creatingNewTheme = true;
        var newWord = (this.value.replace(/ /g, "_"));
        d3.select(this).property("value", newWord);
        var fake = d3.select("#" + selectedThemeBoxObject.selectedThemeBox + "_wordArray").append("text")
            .attr("id", "fake")
            .style("position", "absolute")
            .style("display", "block")
            .style("opacity", 0)
            .style("padding", "5px 10px 5px 10px")
            .style("font-size", "20px")
            .html(newWord);
        d3.select(this).style("width", function () {
            if (fake.node().offsetWidth > 50)
                return fake.node().offsetWidth + 4;
            return "50px";
        });
        d3.select("#fake").remove();
    })
    .on("keydown", function (event) {
        var key = d3.event.key || d3.event.which || d3.event.keyCode;  // Fallback for older browsers
        if (key === "Enter" || key === 13) {  // `13` is the key code for the Enter key
            creatingNewTheme = true;
            d3.event.preventDefault(); // Prevent any default behavior of the Enter key
            newWordContainer.remove(); // Remove the input box
            
            // Save the word
            for (var j = 0; j < themesObject.themes.length; j++) {
                if (themesObject.themes[j].themeName === currentTheme && newWordContainer.node().value !== "") {
                    themesObject.themes[j].words.push({
                        word: newWordContainer.node().value,
                        value: 1,
                        stemmedWords: []
                    });
                }
            }
            
            makeThemeBoxes(boxHeight, boxWidth);
        }
    })
    .on("blur", function () {
        // This will be triggered when the input box loses focus (clicking outside)
        creatingNewTheme = true;
        // Save the word if the input box is not empty
        if (newWordContainer.node().value !== "") {
            for (var j = 0; j < themesObject.themes.length; j++) {
                if (themesObject.themes[j].themeName === currentTheme) {
                    themesObject.themes[j].words.push({
                        word: newWordContainer.node().value,
                        value: 1,
                        stemmedWords: []
                    });
                }
            }
        }
        
        // Remove the input box after the word is saved
        newWordContainer.remove();
        
        makeThemeBoxes(boxHeight, boxWidth);
    });

		
	/*d3.select("#settings-page").on("click", function() {
		d3.event.preventDefault()
		var wordBox = d3.select("#wordInput");
		if (d3.event.x < wordBox.node().offsetLeft ||
		d3.event.x > wordBox.node().offsetLeft + wordBox.node().offsetWidth ||
		d3.event.y < wordBox.node().offsetTop ||
		d3.event.y > wordBox.node().offsetTop + wordBox.node().offsetHeight){
			wordBox.remove();
			for (var j=0; j<themesObject.themes.length; j++){
				if (themesObject.themes[j].themeName === currentTheme && newWordContainer.node().value != ""){
					themesObject.themes[j].words.push({
						word: newWordContainer.node().value,
						value: 1,
						stemmedWords: []
					});
				}
			}
			makeThemeBoxes(boxHeight, boxWidth);
		}
	});*/
	var index = button.id.substring(8)*1;
	d3.select("#"+button.id).remove();
	d3.select("#"+themesObject.themes[index].themeName+"_wordArray").append("button")
		.attr("id", "addWord_"+index)
		.attr("class", "sections")
		.style("border-radius", "5px")
		.style("background", "#4e4e4e")
		.style("margin", "10px")
		.style("height", "35px")
		.style("padding", "10px")
		.style("width", "35px")
		.style("font-size", "20px")
		.style("color", "#ffffff")
		.style("flex-direction", "column")
		.style("justify-content", "center")
		.style("align-content", "center")
		.text("+")
		.on("click", function() {
			d3.select("#"+themesObject.themes[index].themeName+"_wordArray").select("input").remove();
			addWord(this, boxHeight, boxWidth, themesObject.themes[index].themeName);
			selectedThemeBoxObject.selectedThemeBox = themesObject.themes[this.id.substring(8)].themeName;
		});
	//var selection = window.getSelection();  
	//var range = document.createRange();  
	//selection.removeAllRanges();  
	//range.selectNodeContents(newWordContainer.node());  
	//range.collapse(false);  
	//selection.addRange(range);  
	//newWordContainer.node().focus();
	d3.select("#themeList").node().scrollTop = scrollTopBefore;
newWordContainer.node().focus();

}

export function showStemmedWordsInstructions(word){
	d3.selectAll("#showStemmedWordsInstructions").remove();
	showingStemmedWordsInstructionsObject.showingStemmedWordsInstructions = true;
	var clickInstructions = d3.select(word).append("div")
		.attr("id", "showStemmedWordsInstructions")
		.style("position", "absolute")
		.style("margin-top", 15 - d3.select("#themeList").node().parentNode.scrollTop)
		.style("margin-left", -word.offsetWidth/2)
		.style("border-radius", "5px")
		.style("background", "#4e4e4e")
		.style("color", "#ffffff")
		.style("padding", "5px 10px 5px 10px")
		.style("font-size", "14px")
		.text("Double Click To Edit Stems")
}

// Function to show stemmed words
export function showStemmedWords(wordElement, wordArray, stemIndex){
	d3.selectAll("#stemmedListBox").remove();
	mouseOverDeleteStemmedWordObject.mouseOverDeleteStemmedWord = false;
	var thisName = wordArray.split("_")[0];
	var themeNameIndex = 0;
	var firstClickShowStemmed = true;
	for (var i=0; i<themesObject.themes.length; i++){
		if (themesObject.themes[i].themeName === thisName){
			themeNameIndex = i;
			i = themesObject.themes.length;
		}
	}
	showingStemmedWordsObject.showingStemmedWords = true;
	showingStemmedWordsInstructionsObject.showingStemmedWordsInstructions = false;
	var stem = themesObject.themes[themeNameIndex].words[stemIndex].word;
	d3.selectAll("#showStemmedWordsInstructions").remove();
	var stemmedListBox = d3.select(wordElement).append("div")
		.attr("id", "stemmedListBox")
		.attr("class", "sections")
		.style("position", "absolute")
		.style("background", "#f4f4f4")
		.style("flex-direction", "column")
		.style("margin-top", -wordElement.offsetHeight - d3.select("#themeList").node().parentNode.scrollTop)
		.style("margin-left", wordElement.offsetWidth)
		.style("padding", "30px")
		.style("z-index", 9)
		.style("box-shadow", "0px 4px 20px rgba(0, 0, 0, 0.25)");
	d3.select(wordElement).select("button").remove();
	var heading = stemmedListBox.append("div")
		.style("color", "#000000")
		.style("font-size", "20px")
		.style("font-weight", "800")
		.text("Stemmed Words/Synonyms from "+stem[0].toUpperCase()+stem.substring(1));
	var stemmedWords = themesObject.themes[themeNameIndex].words[stemIndex].stemmedWords;
	// for (var i=0; i<stemmedWords.length; i++){
	// 	var stemmedWord = stemmedListBox.append("div")
	// 		.attr("id", i)
	// 		.style("background", "#ffffff")
	// 		.style("border-radius", "10px")
	// 		.style("color", "#4e4e4e")
	// 		.style("padding", "10px")
	// 		.style("margin-top", "10px")
	// 		.style("margin-bottom", "10px")
	// 		.style("width", "fit-content")
	// 		.text(stemmedWords[i][0].toUpperCase()+stemmedWords[i].substring(1))
	// 		.on("mouseover", function(){
	// 			d3.select(this).append("button")
	// 				.attr("id", "deleteStemmedWord")
	// 				.style("position", "absolute")
	// 				.style("margin-top", -20)
	// 				.style("margin-left", -4)
	// 				.style("background", "#e14947")
	// 				.style("border-radius", "50%")
	// 				.style("height", "25px")
	// 				.style("width", "25px")
	// 				.style("font-size", "15px")
	// 				.style("color", "#ffffff")
	// 				.text("x")
	// 				.on("mouseover", function(){mouseOverDeleteStemmedWordObject.mouseOverDeleteStemmedWord = true;})
	// 				.on("mouseout", function(){mouseOverDeleteStemmedWordObject.mouseOverDeleteStemmedWord = false;})
	// 		})
	// 		.on("mouseleave", function(){d3.selectAll("#deleteStemmedWord").remove();})
	// 		.call(dragWord);
	// }

	for (var i = 0; i < stemmedWords.length; i++) {
		const wordText = stemmedWords[i];
		const capitalizedWord = wordText.charAt(0).toUpperCase() + wordText.slice(1);
	
		const isAlreadySelected = multiSelectedWordsObject.selectedWords.some(
			w => w.word === capitalizedWord && w.index === i && w.source === "stemmed"
		);
	
		const selectedThemeName = selectedThemeBoxObject.selectedThemeBox.trim().toLowerCase();
		const theme = themesObject.themes.find(t =>
			t.themeName.trim().toLowerCase() === selectedThemeName
		);
		const themeColor = theme ? theme.color : "#007bff";
	
		const stemmedWord = stemmedListBox.append("div")
			.attr("id", `stemmedWord_${i}`)
			.attr("class", "word")
			.style("border-radius", "10px")
			.style("color", "#4e4e4e")
			.style("padding", "10px 10px 10px 30px")
			.style("margin-top", "10px")
			.style("margin-bottom", "10px")
			.style("width", "fit-content")
			.style("cursor", "pointer")
			.style("position", "relative")
			.style("background-color", isAlreadySelected ? "#e6f0ff" : "#ffffff")
			.style("border-left", isAlreadySelected ? `8px solid ${themeColor}` : "2px solid #F4F4F4")
			.style("border-top", "2px solid #F4F4F4")
			.style("border-right", "2px solid #F4F4F4")
			.style("border-bottom", "2px solid #F4F4F4");
	
		// Append checkbox
		const checkbox = stemmedWord.append("input")
			.attr("type", "checkbox")
			.style("position", "absolute")
			.style("top", "10px")
			.style("left", "6px")
			.style("width", "16px")
			.style("height", "16px")
			.property("checked", isAlreadySelected);
	
		// Append word text
		stemmedWord.append("span")
			.text(capitalizedWord);
	
		// Toggle checkbox and styling on click
		stemmedWord.on("click", function () {
			const cb = d3.select(this).select("input[type='checkbox']");
			const isChecked = cb.property("checked");
			cb.property("checked", !isChecked); // Toggle checkbox state
	
			if (!isChecked) {
				d3.select(this)
					.style("background-color", "#e6f0ff")
					.style("border-left", `8px solid ${themeColor}`)
					.style("border-top", "2px solid #F4F4F4")
					.style("border-right", "2px solid #F4F4F4")
					.style("border-bottom", "2px solid #F4F4F4");
	
				multiSelectedWordsObject.selectedWords.push({
					word: capitalizedWord,
					index: i,
					source: "stemmed"
				});
			} else {
				d3.select(this)
					.style("background-color", "#ffffff")
					.style("border", "2px solid #F4F4F4");
	
				const removeIndex = multiSelectedWordsObject.selectedWords.findIndex(
					w => w.word === capitalizedWord && w.index === i && w.source === "stemmed"
				);
				if (removeIndex !== -1) {
					multiSelectedWordsObject.selectedWords.splice(removeIndex, 1);
				}
			}
		});
	
		// Show delete button on hover
		stemmedWord.on("mouseover", function () {
			d3.select(this).append("button")
				.attr("id", "deleteStemmedWord")
				.style("position", "absolute")
				.style("top", "-10px")
				.style("right", "-10px")
				.style("background", "#e14947")
				.style("border-radius", "50%")
				.style("height", "25px")
				.style("width", "25px")
				.style("font-size", "15px")
				.style("color", "#ffffff")
				.text("x")
				.on("mouseover", function () {
					mouseOverDeleteStemmedWordObject.mouseOverDeleteStemmedWord = true;
				})
				.on("mouseout", function () {
					mouseOverDeleteStemmedWordObject.mouseOverDeleteStemmedWord = false;
				});
		});
	
		// Remove delete button on mouse leave
		stemmedWord.on("mouseleave", function () {
			d3.select(this).select("#deleteStemmedWord").remove();
		});
	}
	
	
	
		
	var addVariantButton = stemmedListBox.append("div")
		.style("background", "#ffffff")
		.style("border-radius", "10px")
		.style("border", "2px solid #4e4e4e")
		.style("color", "#4e4e4e")
		.style("padding", "10px")
		.style("margin-top", "10px")
		.style("margin-bottom", "10px")
		.style("width", "fit-content")
		.text("+ Add variant")
		.on("click", function(){
			d3.select(this).remove();
			var newStemmedWordContainer = stemmedListBox.append("input")
				.style("background", "#ffffff")
				.style("border-radius", "10px")
				.style("color", "#4e4e4e")
				.style("padding", "10px")
				.style("margin-top", "10px")
				.style("margin-bottom", "10px")
				.style("width", "fit-content")
				.style("width", "50px")
				.on("input", function() {
					var newWord = (this.value.replace(/ /g,"_"));
					d3.select(this).property("value", newWord);
					var fake = stemmedListBox.append("text")
						.attr("id", "fake")
						.style("position", "absolute")
						.style("display", "block")
						.style("opacity", 0)
						.style("padding", "5px 10px 5px 10px")
						.style("font-size", "20px")
						.html(newWord)
					d3.select(this).style("width", function() {
					if (fake.node().offsetWidth > 50)
						return fake.node().offsetWidth+4;
					return "50px";
					});
					d3.select("#fake").remove();
				})
			d3.select("#stemmedListBox").on("click", function() {
				if ((showingStemmedWordsInstructionsObject.showingStemmedWords && d3.event.x < newStemmedWordContainer.node().offsetLeft ||
				d3.event.x > newStemmedWordContainer.node().offsetLeft + newStemmedWordContainer.node().offsetWidth ||
				d3.event.y < newStemmedWordContainer.node().offsetTop ||
				d3.event.y > newStemmedWordContainer.node().offsetTop + newStemmedWordContainer.node().offsetHeight) && 
				newStemmedWordContainer.node().value != ""){
					themesObject.themes[themeNameIndex].words[stemIndex].stemmedWords.push(newStemmedWordContainer.node().value);
					showStemmedWords(wordElement, wordArray, stemIndex);
					d3.select("#stemmedListBox").on("click", function() {});
				}
			});
		});
	
	d3.select("#settings-page").on("click", function() {
		if (!firstClickShowStemmed){
			var stemBox = d3.select("#stemmedListBox");
			if (showingStemmedWordsObject.showingStemmedWords && d3.event.x < stemBox.node().offsetLeft ||
			d3.event.x > stemBox.node().offsetLeft + stemBox.node().offsetWidth ||
			d3.event.y < stemBox.node().offsetTop ||
			d3.event.y > stemBox.node().offsetTop + stemBox.node().offsetHeight){
				stemBox.remove();
				showingStemmedWordsObject.showingStemmedWords = false;
				d3.select("#settings-page").on("click", function() {});
			}
		}
		firstClickShowStemmed = false;
	});
	stemmedListBox.style("bottom", function(){
		// Switch to bottom instead of top margin if box is longer than window page
		if (stemmedListBox.node().offsetHeight > (d3.select("#settings-page").node().offsetHeight-
		stemmedListBox.node().offsetTop))
			return 20;
	});
}
