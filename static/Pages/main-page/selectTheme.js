import { drawVisualization } from "./drawVisualization.js?v=20260901b";
import { selectedParticipantObject, themesObject, themeObject,currentDisplayObject,highlight,themeSelectedObject,
    lastThemeClickedObject } from "../../../static/chromascribe-main.js";
import { drawVisualization2 } from "./drawVisualization2.js?v=20260901b";
import {
    buildThemeWordIdentityKey,
    colorToRgba,
    getContrastingTextColor,
    getStoredThemePayload,
    isManualCodeEffectivelySelected,
    isManualExcerptEffectivelySelected,
    isManualThemeEntry,
    isManualThemeWordEntry,
    normalizeManualSelectionOptOuts,
    persistThemePayload
} from "../themePersistence.js?v=20260901b";

let hasInitializedPayloadSelectionForPage = false;

function getThemeKeyFromButton(buttonNode) {
    if (!buttonNode) return "";
    const rawTheme = buttonNode.dataset && buttonNode.dataset.theme ? buttonNode.dataset.theme : buttonNode.id;
    return (rawTheme || "").toString().trim().toLowerCase();
}

function getThemeColor(themeKey) {
    if (!themeKey || themeKey === "neutral") return null;
    const match = themesObject.themes.find(theme => (theme.themeName || "").toLowerCase() === themeKey);
    return match ? match.color : null;
}

export function normalizeThemeColor(rawColor, fallback = "#579AE2") {
    const color = String(rawColor || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(color)) {
        return `#${color.slice(1).split("").map(value => value + value).join("")}`.toUpperCase();
    }
    return fallback;
}

function normalizeThemeKeys(rawThemes) {
    if (Array.isArray(rawThemes)) {
        return [...new Set(rawThemes.map(theme => (theme || "").toString().trim().toLowerCase()).filter(Boolean))];
    }
    if (typeof rawThemes === "string" && rawThemes.trim()) {
        return [rawThemes.trim().toLowerCase()];
    }
    return [];
}

function normalizeThemeText(value) {
    return String(value || "")
        .replace(/[“”]/g, "\"")
        .replace(/[‘’]/g, "'")
        .replace(/[^a-z0-9]+/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function getThemeNameKey(theme) {
    return String((theme && theme.themeName) || "").trim().toLowerCase();
}

function getThemeWordText(wordEntry) {
    if (typeof wordEntry === "string") return wordEntry.trim();
    if (!wordEntry || typeof wordEntry !== "object") return "";
    return String(
        wordEntry.word ||
        wordEntry.text ||
        wordEntry.quote ||
        wordEntry.excerpt ||
        wordEntry.selectedText ||
        wordEntry.selection ||
        ""
    ).trim();
}

function isAppliedExcerptWord(wordEntry, theme, themePayload) {
    const text = getThemeWordText(wordEntry);
    if (!text) return false;

    const normalizedText = normalizeThemeText(text);
    if (!normalizedText) return false;
    if (normalizedText === normalizeThemeText(theme && theme.themeName)) return false;
    if (normalizedText === normalizeThemeText(theme && theme.summary)) return false;

    if (wordEntry && typeof wordEntry === "object" && wordEntry.selectedByUser === false && wordEntry.matchingSelection !== true) {
        return false;
    }

    if (isManualThemeWordEntry(wordEntry)) {
        return isManualExcerptEffectivelySelected(themePayload, theme && theme.themeName, wordEntry);
    }

    return true;
}

function getThemeKeysWithAppliedExcerpts(themePayload) {
    const themes = Array.isArray(themePayload && themePayload.themes) ? themePayload.themes : [];
    return [...new Set(themes
        .filter(theme => (
            (!isManualThemeEntry(theme) || isManualCodeEffectivelySelected(themePayload, theme))
            && Array.isArray(theme && theme.words)
            && theme.words.some(word => isAppliedExcerptWord(word, theme, themePayload))
        ))
        .map(getThemeNameKey)
        .filter(Boolean))];
}

function payloadRepresentsAppliedExcerptSelection(themePayload) {
    if (!themePayload || typeof themePayload !== "object") return false;
    if (themePayload.appliedToVisualization === true) return true;
    const selectionStage = String(themePayload.selectionStage || "").trim().toLowerCase();
    if (["matching_excerpts", "matching_excerpts_selected", "applied_codes", "apply_codes"].includes(selectionStage)) return true;
    const selectionSource = String(themePayload.selectionSource || "").trim().toLowerCase();
    return ["matching_excerpts", "selected_excerpts", "theme_excerpt_selection", "apply_codes", "applied_codes"].includes(selectionSource);
}

function normalizeSelectedThemes() {
    return normalizeThemeKeys(themeObject.theme);
}

function getThemeSelectionStorageKey() {
    const projectId = String(localStorage.getItem("currentProjectId") || "").trim();
    return projectId ? `visualizationThemeSelection_${projectId}` : "visualizationThemeSelection";
}

function getThemePayloadSignatureStorageKey() {
    return `${getThemeSelectionStorageKey()}_payloadSignature`;
}

function getAvailableThemeKeys() {
    const keys = new Set(["neutral"]);
    (themesObject.themes || []).forEach(theme => {
        const key = String((theme && theme.themeName) || "").trim().toLowerCase();
        if (key) keys.add(key);
    });
    return keys;
}

function filterAvailableThemeSelection(selectedThemes) {
    const availableKeys = getAvailableThemeKeys();
    return normalizeThemeKeys(selectedThemes).filter(themeKey => availableKeys.has(themeKey));
}

export function persistThemeSelection(selectedThemes = themeObject.theme) {
    try {
        const normalizedSelection = filterAvailableThemeSelection(selectedThemes);
        localStorage.setItem(getThemeSelectionStorageKey(), JSON.stringify(normalizedSelection));
    } catch (error) {
        console.warn("Failed to persist visualization theme selection:", error);
    }
}

export function restoreThemeSelection() {
    let restoredSelection = [];
    try {
        const rawValue = localStorage.getItem(getThemeSelectionStorageKey());
        if (rawValue) {
            restoredSelection = filterAvailableThemeSelection(JSON.parse(rawValue));
        }
    } catch (error) {
        console.warn("Failed to restore visualization theme selection:", error);
    }

    themeObject.theme = restoredSelection;
    themeSelectedObject.themeSelected = restoredSelection.length > 0;
    return restoredSelection;
}

function payloadShouldDefaultToSelectedThemes(themePayload) {
    if (!themePayload || typeof themePayload !== "object") return false;
    if (themePayload.appliedToVisualization === true) return true;
    const previewState = String(themePayload.visualizationPreviewState || "").trim().toLowerCase();
    if (previewState === "theme_selection_unapplied") return true;
    const selectionStage = String(themePayload.selectionStage || "").trim().toLowerCase();
    if (["theme_selection", "matching_excerpts", "applied_codes", "apply_codes"].includes(selectionStage)) {
        return true;
    }
    const selectionSource = String(themePayload.selectionSource || "").trim().toLowerCase();
    return ["theme_selection", "matching_excerpts", "apply_codes", "applied_codes"].includes(selectionSource);
}

function buildThemePayloadSelectionSignature(themePayload) {
    const themes = Array.isArray(themesObject.themes) ? themesObject.themes : [];
    const themeSignature = themes
        .map(theme => {
            const themeName = String((theme && theme.themeName) || "").trim().toLowerCase();
            if (!themeName) return null;
            const words = Array.isArray(theme.words) ? theme.words : [];
            return {
                themeName,
                color: String(theme.color || "").trim().toLowerCase(),
                words: words
                    .map(word => buildThemeWordIdentityKey(word) || String((word && word.word) || word || "").trim())
                    .filter(Boolean)
                    .sort(),
            };
        })
        .filter(Boolean);

    return JSON.stringify({
        appliedToVisualization: themePayload && themePayload.appliedToVisualization === true,
        selectionStage: String(themePayload && themePayload.selectionStage || "").trim().toLowerCase(),
        selectionSource: String(themePayload && themePayload.selectionSource || "").trim().toLowerCase(),
        visualizationPreviewState: String(themePayload && themePayload.visualizationPreviewState || "").trim().toLowerCase(),
        appliedExcerptThemeKeys: getThemeKeysWithAppliedExcerpts({
            themes,
            manualSelectionOptOuts: normalizeManualSelectionOptOuts(themePayload),
        }).sort(),
        themes: themeSignature,
    });
}

export function initializeThemeSelectionForPayload(themePayload) {
    const themeKeys = (Array.isArray(themesObject.themes) ? themesObject.themes : [])
        .map(theme => String((theme && theme.themeName) || "").trim().toLowerCase())
        .filter(Boolean);

    if (themeKeys.length === 0) {
        themeObject.theme = [];
        themeSelectedObject.themeSelected = false;
        hasInitializedPayloadSelectionForPage = true;
        syncThemeSelectionStyles();
        return [];
    }

    themesObject.manualSelectionOptOuts = normalizeManualSelectionOptOuts(themePayload);

    const payloadSignature = buildThemePayloadSelectionSignature(themePayload);
    const signatureStorageKey = getThemePayloadSignatureStorageKey();
    let previousSignature = "";
    try {
        previousSignature = localStorage.getItem(signatureStorageKey) || "";
    } catch (error) {
        console.warn("Failed to read visualization theme payload signature:", error);
    }

    const shouldDefaultToAll =
        payloadShouldDefaultToSelectedThemes(themePayload) &&
        (!hasInitializedPayloadSelectionForPage || payloadSignature !== previousSignature);

    if (shouldDefaultToAll) {
        themeObject.theme = payloadRepresentsAppliedExcerptSelection(themePayload)
            ? getThemeKeysWithAppliedExcerpts({
                ...themePayload,
                themes: themesObject.themes,
                manualSelectionOptOuts: normalizeManualSelectionOptOuts(themePayload),
            })
            : [...new Set(themeKeys)].filter(themeKey => {
                const theme = themesObject.themes.find(entry => getThemeNameKey(entry) === themeKey);
                return !isManualThemeEntry(theme) || isManualCodeEffectivelySelected(themePayload, theme);
            });
        themeSelectedObject.themeSelected = themeObject.theme.length > 0;
        persistThemeSelection(themeObject.theme);
        hasInitializedPayloadSelectionForPage = true;
        try {
            localStorage.setItem(signatureStorageKey, payloadSignature);
        } catch (error) {
            console.warn("Failed to persist visualization theme payload signature:", error);
        }
        syncThemeSelectionStyles();
        return themeObject.theme;
    }

    const restoredSelection = restoreThemeSelection().filter(themeKey => {
        const theme = themesObject.themes.find(entry => getThemeNameKey(entry) === themeKey);
        return !isManualThemeEntry(theme) || isManualCodeEffectivelySelected(themePayload, theme);
    });
    themeObject.theme = restoredSelection;
    themeSelectedObject.themeSelected = restoredSelection.length > 0;
    persistThemeSelection(restoredSelection);
    hasInitializedPayloadSelectionForPage = true;
    try {
        if (!previousSignature) {
            localStorage.setItem(signatureStorageKey, payloadSignature);
        }
    } catch (error) {
        console.warn("Failed to initialize visualization theme payload signature:", error);
    }
    syncThemeSelectionStyles();
    return restoredSelection;
}

function refreshThemeButtonStyles(selectedThemes) {
    d3.selectAll(".theme-labels").each(function() {
        const button = d3.select(this);
        const themeKey = getThemeKeyFromButton(this);
        const isSelected = selectedThemes.includes(themeKey);
        const color = getThemeColor(themeKey);
        const borderColor = themeKey === "neutral" ? highlight["Neutral"] : (color || "#d1d5db");
        button.style("border-color", borderColor);
        button.select(".theme-color-dot")
            .style("background", color || "#d1d5db")
            .style("border-color", color || "#d1d5db");
        if (color) {
            button.select(".theme-color-control input")
                .property("value", normalizeThemeColor(color).toLowerCase())
                .attr("data-committed-color", normalizeThemeColor(color));
        }
        if (isSelected) {
            if (themeKey === "neutral") {
                button.style("background", highlight["Neutral"]).style("color", "#000000");
            } else if (color) {
                button.style("background", color).style("color", getContrastingTextColor(color));
            }
            button.select(".theme-color-dot").style("border-color", "rgba(255,255,255,0.86)");
            return;
        }
        button.style("background", "#ffffff");
        if (themeKey === "neutral") {
            button.style("color", "#000000");
        } else if (color) {
            button.style("color", color);
        }
    });
}

export function syncThemeSelectionStyles() {
    const selectedThemes = filterAvailableThemeSelection(normalizeSelectedThemes());
    themeObject.theme = selectedThemes;
    themeSelectedObject.themeSelected = selectedThemes.length > 0;
    refreshThemeButtonStyles(selectedThemes);
}

export function selectTheme(t,view) {
    selectedParticipantObject.selectedParticipant = "";
    const clickedTheme = getThemeKeyFromButton(t);
    if (!clickedTheme) return;

    let selectedThemes = normalizeSelectedThemes();
    const clickedIndex = selectedThemes.indexOf(clickedTheme);

    if (clickedTheme === "neutral") {
        if (selectedThemes.length === 1 && selectedThemes[0] === "neutral") {
            selectedThemes = [];
        } else {
            selectedThemes = ["neutral"];
        }
    } else {
        selectedThemes = selectedThemes.filter(theme => theme !== "neutral");
        if (clickedIndex > -1) {
            selectedThemes.splice(clickedIndex, 1);
        } else {
            selectedThemes.push(clickedTheme);
        }
    }

    themeObject.theme = selectedThemes;
    themeSelectedObject.themeSelected = selectedThemes.length > 0;

    // Legend clicks only change which codes are highlighted in this view.
    // Saving manual opt-outs here would remove the code from the next server
    // response, leaving no legend button to turn it back on.
    lastThemeClickedObject.lastThemeClicked = t;
    persistThemeSelection(selectedThemes);
    syncThemeSelectionStyles();

    if (view == "timeline") {
        drawVisualization(currentDisplayObject.currentDisplay);
    } else {
        drawVisualization2(currentDisplayObject.currentDisplay);
    }

    const clickedThemeIsActive = clickedTheme !== "neutral" && selectedThemes.includes(clickedTheme);
    if (
        clickedThemeIsActive &&
        window.ChromaTranscriptViews &&
        typeof window.ChromaTranscriptViews.showThemeQuotes === "function"
    ) {
        window.ChromaTranscriptViews.showThemeQuotes(clickedTheme, {
            returnParticipant: selectedParticipantObject.selectedParticipant || ""
        });
    } else if (
        selectedThemes.length === 0 &&
        window.ChromaTranscriptViews &&
        typeof window.ChromaTranscriptViews.hideThemeQuoteButton === "function"
    ) {
        window.ChromaTranscriptViews.hideThemeQuoteButton();
    }
}

function updateSpeechThemeColors(themeName, nextColor, previousColorOverride = "") {
    const previousColor = String(previousColorOverride || getThemeColor(themeName) || "").trim().toLowerCase();
    const nextColorKey = nextColor.toLowerCase();
    Object.values(currentDisplayObject.currentDisplay || {}).forEach(participantData => {
        const transcript = participantData && Array.isArray(participantData.transcript)
            ? participantData.transcript
            : [];
        transcript.forEach(speech => {
            if (!speech || typeof speech !== "object") return;
            if (String(speech.color || "").trim().toLowerCase() === previousColor) {
                speech.color = nextColor;
            }
            if (Array.isArray(speech._themeColors)) {
                speech._themeColors = speech._themeColors.map(color =>
                    String(color || "").trim().toLowerCase() === previousColor ? nextColor : color
                );
                if (!speech._themeColors.some(color => String(color || "").trim().toLowerCase() === nextColorKey)) {
                    const confidence = Number(speech[themeName]);
                    if (Number.isFinite(confidence) && confidence > 0) {
                        speech._themeColors.push(nextColor);
                    }
                }
            }
        });
    });
}

function redrawVisualizationForView(view) {
    if (view === "question") {
        drawVisualization2(currentDisplayObject.currentDisplay);
    } else {
        drawVisualization(currentDisplayObject.currentDisplay);
    }
}

function normalizeRenderedThemeKey(value) {
    return String(value || "")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function getRenderedTheme(node) {
    const renderedKey = normalizeRenderedThemeKey(node && node.dataset && node.dataset.theme);
    if (!renderedKey) return null;
    return (Array.isArray(themesObject.themes) ? themesObject.themes : []).find(
        theme => normalizeRenderedThemeKey(theme && theme.themeName) === renderedKey
    ) || null;
}

function buildCompleteThemeColorPayload() {
    const storedPayload = getStoredThemePayload();
    const storedThemes = Array.isArray(storedPayload && storedPayload.themes)
        ? storedPayload.themes
        : [];
    const storedByKey = new Map(storedThemes.map(theme => [getThemeNameKey(theme), theme]));
    const themes = (Array.isArray(themesObject.themes) ? themesObject.themes : []).map(theme => ({
        ...(storedByKey.get(getThemeNameKey(theme)) || {}),
        ...theme,
    }));
    return {
        ...(storedPayload && typeof storedPayload === "object" ? storedPayload : {}),
        themes,
    };
}

export function syncRenderedThemeColorSurfaces() {
    d3.selectAll(".speech[data-theme], .speechBlock[data-theme]").each(function() {
        const theme = getRenderedTheme(this);
        if (theme && theme.color) {
            d3.select(this).style("border-left", `6px solid ${theme.color}`);
        }
    });

    d3.selectAll(".theme-quote-block[data-theme]").each(function() {
        const theme = getRenderedTheme(this);
        if (theme && theme.color) {
            d3.select(this).style("border-left", `6px solid ${theme.color}`);
        }
    });

    d3.selectAll(".code-highlight[data-theme]").each(function() {
        const theme = getRenderedTheme(this);
        if (theme && theme.color) {
            d3.select(this).style("background-color", colorToRgba(theme.color, 0.35));
        }
    });

    d3.selectAll(".theme-color-segment[data-theme]").each(function() {
        const theme = getRenderedTheme(this);
        if (!theme || !theme.color) return;
        const segment = d3.select(this).style("background", theme.color);
        segment.select("div").style("color", getContrastingTextColor(theme.color));
    });

    d3.selectAll("#theme-quotes-btn[data-theme]").each(function() {
        const theme = getRenderedTheme(this);
        if (!theme || !theme.color) return;
        const button = d3.select(this).style("border-color", theme.color);
        button.select(".theme-quotes-swatch").style("background-color", theme.color);
    });

    d3.selectAll(".color-adjustment-code-row[data-theme]").each(function() {
        const theme = getRenderedTheme(this);
        if (!theme || !theme.color) return;
        const row = d3.select(this);
        row.select(".color-adjustment-swatch").style("background-color", theme.color);
        row.select(".color-adjustment-color-input")
            .property("value", normalizeThemeColor(theme.color).toLowerCase())
            .attr("data-committed-color", normalizeThemeColor(theme.color));
    });
}

function syncThemeLegendOrder() {
    const legend = d3.select("#theme-legend");
    if (legend.empty()) return;
    const legendNode = legend.node();
    const neutralNode = legend.select("#neutral").node();
    if (neutralNode) legendNode.appendChild(neutralNode);

    (Array.isArray(themesObject.themes) ? themesObject.themes : []).forEach(theme => {
        const themeName = String((theme && theme.themeName) || "").trim().toLowerCase();
        if (!themeName) return;
        const buttonNode = legend.selectAll(".theme-labels").nodes().find(node =>
            String((node.dataset && node.dataset.theme) || "").trim().toLowerCase() === themeName
        );
        if (buttonNode) legendNode.appendChild(buttonNode);
    });
}

export async function commitThemeColorUpdates(updates = [], view, options = {}) {
    const normalizedUpdates = [];
    const seen = new Set();

    (Array.isArray(updates) ? updates : []).forEach(update => {
        const normalizedThemeName = String(update && update.themeName || "").trim();
        if (!normalizedThemeName) return;
        const theme = themesObject.themes.find(
            candidate => String((candidate && candidate.themeName) || "").trim().toLowerCase() === normalizedThemeName.toLowerCase()
        );
        if (!theme) return;

        const updateKey = String(theme.themeName || "").trim().toLowerCase();
        if (!updateKey || seen.has(updateKey)) return;
        seen.add(updateKey);

        const normalizedColor = normalizeThemeColor(update.color || update.nextColor, theme.color || "#579AE2");
        const previousColor = normalizeThemeColor(update.previousColor || theme.color || "", "");
        if (normalizedColor.toLowerCase() === String(theme.color || "").trim().toLowerCase()) return;

        normalizedUpdates.push({
            theme,
            color: normalizedColor,
            previousColor,
        });
    });

    if (normalizedUpdates.length === 0) {
        syncThemeSelectionStyles();
        return [];
    }

    const speechColorSnapshots = [];
    Object.values(currentDisplayObject.currentDisplay || {}).forEach(participantData => {
        const transcript = participantData && Array.isArray(participantData.transcript)
            ? participantData.transcript
            : [];
        transcript.forEach(speech => {
            if (!speech || typeof speech !== "object") return;
            speechColorSnapshots.push({
                speech,
                hasColor: Object.prototype.hasOwnProperty.call(speech, "color"),
                color: speech.color,
                hasThemeColors: Object.prototype.hasOwnProperty.call(speech, "_themeColors"),
                themeColors: Array.isArray(speech._themeColors) ? speech._themeColors.slice() : speech._themeColors,
            });
        });
    });

    normalizedUpdates.forEach(({ theme, color, previousColor }) => {
        updateSpeechThemeColors(theme.themeName, color, previousColor);
        theme.color = color;
    });

    try {
        await persistThemePayload(
            buildCompleteThemeColorPayload(),
            {
                broadcastAfterRemote: true,
                rollbackOnError: true,
                throwOnError: options.throwOnError === true,
            }
        );
    } catch (error) {
        console.warn("Failed to persist visualization theme color:", error);
        normalizedUpdates.forEach(({ theme, previousColor }) => {
            theme.color = previousColor;
        });
        speechColorSnapshots.forEach(({ speech, hasColor, color, hasThemeColors, themeColors }) => {
            if (hasColor) speech.color = color;
            else delete speech.color;
            if (hasThemeColors) {
                speech._themeColors = Array.isArray(themeColors) ? themeColors.slice() : themeColors;
            } else {
                delete speech._themeColors;
            }
        });
        await persistThemePayload(buildCompleteThemeColorPayload(), { syncRemote: false });
        syncThemeLegendOrder();
        syncThemeSelectionStyles();
        syncRenderedThemeColorSurfaces();
        redrawVisualizationForView(view);
        if (options.throwOnError === true) {
            throw error;
        }
        return [];
    }

    syncThemeLegendOrder();
    syncThemeSelectionStyles();
    syncRenderedThemeColorSurfaces();
    redrawVisualizationForView(view);
    return normalizedUpdates.map(({ theme, color, previousColor }) => ({
        themeName: theme.themeName,
        color,
        previousColor,
    }));
}

export async function commitThemeColor(themeName, nextColor, view, previousColor = "") {
    const normalizedThemeName = String(themeName || "").trim();
    if (!normalizedThemeName) return;

    return commitThemeColorUpdates([{
        themeName: normalizedThemeName,
        color: nextColor,
        previousColor,
    }], view);
}

export async function commitThemeOrder(view, options = {}) {
    try {
        await persistThemePayload({ themes: themesObject.themes });
    } catch (error) {
        console.warn("Failed to persist visualization theme order:", error);
        if (options.throwOnError === true) {
            throw error;
        }
    }

    syncThemeLegendOrder();
    syncThemeSelectionStyles();
    redrawVisualizationForView(view);
}

export function appendThemeColorDot(button, theme, view) {
    const themeName = String((theme && theme.themeName) || "").trim();
    if (!themeName || !button || button.empty()) return;

    const color = normalizeThemeColor(theme.color);
    button.style("position", "relative");
    const control = button.append("span")
        .attr("class", "theme-color-control")
        .style("position", "absolute")
        .style("right", "8px")
        .style("bottom", "8px")
        .style("width", "14px")
        .style("height", "14px")
        .style("border-radius", "999px")
        .style("display", "inline-flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("cursor", "pointer")
        .on("click", function() {
            d3.event.stopPropagation();
            const input = this.querySelector("input");
            if (input) input.click();
        });

    control.append("span")
        .attr("class", "theme-color-dot")
        .style("width", "10px")
        .style("height", "10px")
        .style("border-radius", "999px")
        .style("background", color)
        .style("border", `2px solid ${color}`)
        .style("box-shadow", "0 1px 3px rgba(0,0,0,0.28)")
        .style("pointer-events", "none");

    control.append("input")
        .attr("type", "color")
        .attr("aria-label", `Change color for ${themeName}`)
        .attr("data-committed-color", color)
        .property("value", color.toLowerCase())
        .style("position", "absolute")
        .style("inset", "0")
        .style("width", "100%")
        .style("height", "100%")
        .style("opacity", "0")
        .style("cursor", "pointer")
        .on("click", function() {
            d3.event.stopPropagation();
        })
        .on("input", function() {
            d3.event.stopPropagation();
            const nextColor = normalizeThemeColor(this.value, color);
            theme.color = nextColor;
            button.select(".theme-color-dot").style("background", nextColor).style("border-color", nextColor);
            syncThemeSelectionStyles();
        })
        .on("change", function() {
            d3.event.stopPropagation();
            const previousColor = this.dataset.committedColor || color;
            this.dataset.committedColor = normalizeThemeColor(this.value, color);
            void commitThemeColor(themeName, this.value, view, previousColor);
        });
}
