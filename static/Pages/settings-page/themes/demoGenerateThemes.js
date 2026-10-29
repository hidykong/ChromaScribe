import { generateThemes } from "./generateThemes.js?v=20260901a";
import { firstGenerateObject, themesObject, demoingObject } from "../../../chromascribe-main.js";
import {
    archiveCodeInPayload,
    getStoredThemePayload,
    isManualExcerptEffectivelySelected,
    isManualThemeWordEntry,
    migrateManualSelectionThemeName,
    normalizeManualSelectionOptOuts,
    persistThemePayload,
    persistThemePayloadLocally,
    subscribeToThemePayloadUpdates
} from "../../themePersistence.js?v=20260901b";
import {
    hideVisualizationLoadingOverlay,
    navigateToVisualizationWithOverlay,
    showVisualizationLoadingOverlay
} from "./visualizationLoadingOverlay.js?v=20260901a";

let masterCodeGroups = [];
let masterCodeGroupMeta = {};
const CODE_MANAGER_COLOR_EDITOR_ID = "code-manager-color-editor";
const GROUP_SELECTOR_POPOVER_ID = "code-group-selector-popover";
const GROUP_MANAGER_MODAL_ID = "edit-document-groups-modal";
const THEME_RENAME_DEBOUNCE_MS = 500;
const GROUP_SAVE_DEBOUNCE_MS = 450;
const CODE_MANAGER_REFRESH_MS = 12000;
const MATCHING_EXCERPT_SELECTION_STAGES = new Set(["matching_excerpts", "matching_excerpts_selected"]);
const MATCHING_EXCERPT_SELECTION_SOURCES = new Set(["matching_excerpts", "selected_excerpts", "theme_excerpt_selection"]);
const CODE_MANAGER_THEME_PAYLOAD_KEYS = [
    "selectionSource",
    "selectionStage",
    "appliedToVisualization",
    "appliedAt",
    "updatedAt",
    "visualizationPreviewState",
    "selectedByUser",
    "demoCodeManagerSeedVersion",
    "manualSelectionOptOuts",
    "archivedCodes",
    "projectRevision",
    "selectedThemesExists"
];
const themeRenameTimers = new WeakMap();
let activeCodeManagerColorEditor = null;
let activeCodeManagerThemes = null;
let codeManagerLiveSyncInitialized = false;
let codeManagerRefreshIntervalId = null;

function getInteractionEvent(event) {
    if (event && typeof event.stopPropagation === "function") return event;
    return (typeof d3 !== "undefined" && d3.event) ? d3.event : null;
}

function stopInteractionEvent(event) {
    const sourceEvent = getInteractionEvent(event);
    if (sourceEvent) sourceEvent.stopPropagation();
    return sourceEvent;
}

function getSelectionCompleteKey() {
    const projectId = getCurrentProjectId();
    const workspaceKey = (window.USER_WORKSPACE_KEY || localStorage.getItem("currentWorkspaceKey") || "").trim();
    const storageScope = projectId && workspaceKey ? `${workspaceKey}__${projectId}` : projectId;
    return storageScope ? `themeSelectionComplete_${storageScope}` : "themeSelectionComplete";
}

function getCurrentProjectId() {
    const rawValue = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
    return typeof rawValue === "string" ? rawValue.trim() : "";
}

function withProjectQuery(url) {
    const projectId = getCurrentProjectId();
    if (!projectId) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}projectId=${encodeURIComponent(projectId)}`;
}

function withProjectPayload(payload) {
    const projectId = getCurrentProjectId();
    if (!projectId || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return payload;
    }
    return { ...payload, projectId };
}

function hasThemePayload(payload) {
    return payload && Array.isArray(payload.themes) && payload.themes.length > 0;
}

function isSelectedMatchedExcerpt(wordEntry) {
    if (!wordEntry || typeof wordEntry !== "object") return false;

    if (wordEntry.selectedInMatching === true || wordEntry.matchingSelection === true) {
        return true;
    }

    const selectionStage = String(wordEntry.selectionStage || "").trim().toLowerCase();
    if (MATCHING_EXCERPT_SELECTION_STAGES.has(selectionStage)) {
        return true;
    }

    const selectionSource = String(wordEntry.selectionSource || wordEntry.selectedSource || "").trim().toLowerCase();
    return wordEntry.selectedByUser === true && MATCHING_EXCERPT_SELECTION_SOURCES.has(selectionSource);
}

function getSelectedMatchedExcerptCount(themeEntry, payload = activeCodeManagerThemes) {
    const words = Array.isArray(themeEntry?.words) ? themeEntry.words : [];
    return words.filter(word => (
        isManualThemeWordEntry(word)
            ? isManualExcerptEffectivelySelected(payload, themeEntry?.themeName, word)
            : isSelectedMatchedExcerpt(word)
    )).length;
}

function themePayloadSignature(payload) {
    return JSON.stringify(buildSelectedThemePayload(payload || { themes: [] }));
}

function copyCodeManagerPayloadMetadata(target, source) {
    if (!target || !source || typeof source !== "object") return target;
    Object.keys(target).forEach(key => {
        if (key !== "themes") delete target[key];
    });
    CODE_MANAGER_THEME_PAYLOAD_KEYS.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
            target[key] = structuredClone(source[key]);
        }
    });
    return target;
}

function getThemePayloadUpdatedTime(payload) {
    const rawValue = payload && payload.updatedAt;
    if (!rawValue) return 0;
    const parsed = Date.parse(rawValue);
    return Number.isFinite(parsed) ? parsed : 0;
}

function shouldPreferStoredThemePayload(storedPayload, serverPayload) {
    if (!hasThemePayload(storedPayload) || !serverPayload) return false;
    const storedUpdated = getThemePayloadUpdatedTime(storedPayload);
    const serverUpdated = getThemePayloadUpdatedTime(serverPayload);
    return storedUpdated > 0 && (!serverUpdated || storedUpdated > serverUpdated);
}

async function fetchSelectedThemesForCodeManager() {
    try {
        const selectedResponse = await fetch(withProjectQuery(`/api/load_selected_themes?displayOnly=1&includeUnselectedManual=1&t=${Date.now()}`), {
            cache: "no-store"
        });
        if (selectedResponse.ok) {
            const selectedPayload = await selectedResponse.json();
            if (selectedPayload?.selectedThemesExists === true) {
                return selectedPayload && Array.isArray(selectedPayload.themes) ? selectedPayload : { themes: [] };
            }
        }

        const generatedResponse = await fetch(withProjectQuery(`/api/load_selected_themes?displayOnly=1&includeUnselectedManual=1&includeGeneratedQuotes=1&includeGeneratedThemes=1&t=${Date.now()}`), {
            cache: "no-store"
        });
        if (!generatedResponse.ok) return null;
        const payload = await generatedResponse.json();
        return payload && Array.isArray(payload.themes) ? payload : null;
    } catch (error) {
        console.warn("Could not refresh Code Manager themes:", error);
        return null;
    }
}

function updateCodeManagerFromPayload(nextPayload) {
    if (!activeCodeManagerThemes || !nextPayload || !Array.isArray(nextPayload.themes)) return;

    const currentSignature = themePayloadSignature(activeCodeManagerThemes);
    const nextSignature = themePayloadSignature(nextPayload);
    if (currentSignature === nextSignature) return;

    copyCodeManagerPayloadMetadata(activeCodeManagerThemes, nextPayload);
    activeCodeManagerThemes.themes = structuredClone(nextPayload.themes);
    persistThemesToProjectStorage(activeCodeManagerThemes);
    displayThemes(activeCodeManagerThemes);
}

async function refreshCodeManagerThemesFromServer() {
    if (!activeCodeManagerThemes) return;

    const storedPayload = getStoredThemePayload();
    if (hasThemePayload(storedPayload)) {
        updateCodeManagerFromPayload(storedPayload);
    }

    const serverPayload = await fetchSelectedThemesForCodeManager();
    if (serverPayload && (serverPayload.selectedThemesExists === true || hasThemePayload(serverPayload))) {
        if (shouldPreferStoredThemePayload(storedPayload, serverPayload)) return;
        updateCodeManagerFromPayload(serverPayload);
    }
}

function initializeCodeManagerLiveSync() {
    if (codeManagerLiveSyncInitialized || typeof window === "undefined") return;
    codeManagerLiveSyncInitialized = true;

    subscribeToThemePayloadUpdates((payload) => {
        if (payload) {
            updateCodeManagerFromPayload(payload);
            return;
        }
        void refreshCodeManagerThemesFromServer();
    });

    window.addEventListener("pageshow", () => {
        void refreshCodeManagerThemesFromServer();
    });

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            void refreshCodeManagerThemesFromServer();
        }
    });

    codeManagerRefreshIntervalId = window.setInterval(() => {
        if (!document.hidden) {
            void refreshCodeManagerThemesFromServer();
        }
    }, CODE_MANAGER_REFRESH_MS);
}

function setSelectionComplete(value) {
    if ((window.APP_MODE || "user") === "demo") return;
    try {
        const key = getSelectionCompleteKey();
        if (value) {
            localStorage.setItem(key, "1");
        } else {
            localStorage.removeItem(key);
        }
    } catch (error) {
        console.warn("Failed to persist theme-selection step:", error);
    }
}

function normalizeThemeKey(value) {
    return String(value || "").trim().replace(/_/g, " ").toLowerCase();
}

function normalizeGroupPath(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const parts = raw.split(">").map(part => part.trim()).filter(Boolean);
    return parts.join(" > ");
}

function normalizeGroupList(groups) {
    if (!Array.isArray(groups)) return [];
    const seen = new Set();
    const normalized = [];
    groups.forEach(group => {
        const path = normalizeGroupPath(group);
        if (!path || seen.has(path)) return;
        seen.add(path);
        normalized.push(path);
    });
    return normalized.sort((a, b) => {
        const aDepth = a.split(" > ").length;
        const bDepth = b.split(" > ").length;
        if (aDepth !== bDepth) return aDepth - bDepth;
        return a.localeCompare(b);
    });
}

function normalizeCodeGroupMeta(groups, meta = {}) {
    const normalizedMeta = {};
    normalizeGroupList(groups).forEach(groupPath => {
        const rawMeta = meta && typeof meta === "object" ? meta[groupPath] : {};
        normalizedMeta[groupPath] = {
            comment: String(rawMeta && rawMeta.comment || ""),
            color: normalizeThemeHexColor(rawMeta && rawMeta.color || "#579AE2", "#579AE2")
        };
    });
    return normalizedMeta;
}

function buildCodeGroupsPayload(groups = masterCodeGroups, meta = masterCodeGroupMeta) {
    const normalizedGroups = normalizeGroupList(groups);
    return {
        groups: normalizedGroups,
        meta: normalizeCodeGroupMeta(normalizedGroups, meta)
    };
}

function groupDepth(path) {
    return normalizeGroupPath(path).split(" > ").length - 1;
}

function groupLabel(path) {
    const parts = normalizeGroupPath(path).split(" > ");
    return parts.length ? parts[parts.length - 1] : "";
}

function toIndentedLabel(path) {
    const depth = Math.max(0, groupDepth(path));
    return `${"  ".repeat(depth)}${groupLabel(path)}`;
}

function descendantsOf(path, list) {
    const base = normalizeGroupPath(path);
    if (!base) return [];
    const prefix = `${base} > `;
    return list.filter(candidate => candidate === base || candidate.startsWith(prefix));
}

function findThemeEntry(themes, themeName) {
    if (!themes || !Array.isArray(themes.themes)) return null;
    const target = normalizeThemeKey(themeName);
    return themes.themes.find(theme => normalizeThemeKey(theme && theme.themeName) === target) || null;
}

function persistThemesToProjectStorage(themes) {
    if (!themes || !Array.isArray(themes.themes)) return;
    const payload = persistThemePayloadLocally(themes);
    copyCodeManagerPayloadMetadata(themes, payload);
    themes.themes = structuredClone(payload.themes);
    themesObject.themes = structuredClone(payload.themes);
    themesObject.manualSelectionOptOuts = normalizeManualSelectionOptOuts(payload);
    themesObject.archivedCodes = structuredClone(payload.archivedCodes || []);
}

function clampRgbChannel(value) {
    const numericValue = Number.parseInt(value, 10);
    if (!Number.isFinite(numericValue)) return 0;
    return Math.max(0, Math.min(255, numericValue));
}

function normalizeThemeHexColor(value, fallback = "#579AE2") {
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
    return String(fallback || "#579AE2").toUpperCase();
}

function hexToThemeRgb(value) {
    const normalized = normalizeThemeHexColor(value);
    return {
        r: Number.parseInt(normalized.slice(1, 3), 16),
        g: Number.parseInt(normalized.slice(3, 5), 16),
        b: Number.parseInt(normalized.slice(5, 7), 16)
    };
}

function rgbToThemeHex(r, g, b) {
    const toHex = channel => clampRgbChannel(channel).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function buildSelectedThemePayload(themes) {
    const themeList = Array.isArray(themes && themes.themes) ? themes.themes : [];
    const payload = {
        themes: themeList.map(themeEntry => ({
            themeName: String(themeEntry?.themeName || "").trim(),
            color: normalizeThemeHexColor(themeEntry?.color || "#579AE2"),
            summary: String(themeEntry?.summary || ""),
            words: Array.isArray(themeEntry?.words) ? themeEntry.words : [],
            groups: Array.isArray(themeEntry?.groups) ? themeEntry.groups : [],
            highlight: Array.isArray(themeEntry?.highlight) ? themeEntry.highlight : [],
            comment: String(themeEntry?.comment || ""),
            ...(themeEntry?.codeSource ? { codeSource: themeEntry.codeSource } : {}),
            ...(themeEntry?.source ? { source: themeEntry.source } : {}),
            ...(themeEntry?.ai_generated === false ? { ai_generated: false } : {}),
            ...(themeEntry?.humanTagged === true ? { humanTagged: true } : {}),
            ...(themeEntry?.human_tagged === true ? { human_tagged: true } : {})
        })).filter(themeEntry => themeEntry.themeName),
        manualSelectionOptOuts: normalizeManualSelectionOptOuts(themes),
    };
    CODE_MANAGER_THEME_PAYLOAD_KEYS.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(themes || {}, key) && themes[key] !== undefined) {
            payload[key] = structuredClone(themes[key]);
        }
    });
    return payload;
}

async function persistThemeSelection(themes, options = {}) {
    const payload = await persistThemePayload(buildSelectedThemePayload(themes), {
        manualDeletionIntent: options.manualDeletionIntent,
        rollbackOnError: options.rollbackOnError === true,
        throwOnError: options.throwOnError === true,
    });
    copyCodeManagerPayloadMetadata(themes, payload);
    themes.themes = structuredClone(payload.themes);
    themesObject.themes = structuredClone(payload.themes);
    themesObject.manualSelectionOptOuts = normalizeManualSelectionOptOuts(payload);
    themesObject.archivedCodes = structuredClone(payload.archivedCodes || []);
    return payload;
}

function closeCodeManagerColorEditor() {
    activeCodeManagerColorEditor = null;
    d3.select(`#${CODE_MANAGER_COLOR_EDITOR_ID}`).remove();
    d3.select("body").on("click.code-manager-color-editor", null);
}

async function finalizeCodeManagerColorEditor({ persistIfDirty = false } = {}) {
    const editorState = activeCodeManagerColorEditor;
    if (!editorState) {
        closeCodeManagerColorEditor();
        return;
    }

    if (persistIfDirty && editorState.hasPendingChanges()) {
        await editorState.commit();
        return;
    }

    closeCodeManagerColorEditor();
}

async function openCodeManagerColorEditor(colorCell, themeEntry, themes, themeIndex) {
    const baseColor = normalizeThemeHexColor(themeEntry?.color || "#579AE2");
    const themeKey = String(themeEntry?.themeName || `${themeIndex}`);
    const colorSwatch = colorCell.select("button span");
    const existingEditor = d3.select(`#${CODE_MANAGER_COLOR_EDITOR_ID}`);
    if (!existingEditor.empty() && existingEditor.attr("data-theme-key") === themeKey) {
        await finalizeCodeManagerColorEditor({ persistIfDirty: true });
        return;
    }

    await finalizeCodeManagerColorEditor({ persistIfDirty: true });
    colorCell.style("position", "relative");

    const editor = colorCell.append("div")
        .attr("id", CODE_MANAGER_COLOR_EDITOR_ID)
        .attr("data-theme-key", themeKey)
        .style("position", "absolute")
        .style("top", "calc(100% - 4px)")
        .style("left", "50%")
        .style("transform", "translateX(-50%)")
        .style("z-index", "40")
        .style("min-width", "196px")
        .style("padding", "12px")
        .style("border-radius", "12px")
        .style("background", "#ffffff")
        .style("border", "1px solid #d9dfef")
        .style("box-shadow", "0 14px 30px rgba(15, 23, 42, 0.16)")
        .style("font-family", "Inter")
        .on("click", function(event) {
            stopInteractionEvent(event);
        });

    editor.append("div")
        .style("font-size", "11px")
        .style("font-weight", "700")
        .style("letter-spacing", "0.04em")
        .style("text-transform", "uppercase")
        .style("color", "#64748b")
        .text("Custom RGB");

    const previewRow = editor.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "10px")
        .style("margin-top", "10px");

    const previewDot = previewRow.append("div")
        .style("width", "22px")
        .style("height", "22px")
        .style("border-radius", "999px")
        .style("border", "1px solid rgba(15, 23, 42, 0.10)")
        .style("background-color", baseColor);

    const nativePicker = previewRow.append("input")
        .attr("type", "color")
        .property("value", baseColor.toLowerCase())
        .style("width", "52px")
        .style("height", "32px")
        .style("padding", "0")
        .style("border", "none")
        .style("background", "transparent")
        .style("cursor", "pointer")
        .on("click", function(event) {
            stopInteractionEvent(event);
        });

    const rgbGrid = editor.append("div")
        .style("display", "grid")
        .style("grid-template-columns", "repeat(3, minmax(0, 1fr))")
        .style("gap", "8px")
        .style("margin-top", "10px");

    const createRgbInput = (labelText) => {
        const field = rgbGrid.append("label")
            .style("display", "flex")
            .style("flex-direction", "column")
            .style("gap", "4px")
            .style("font-size", "11px")
            .style("font-weight", "700")
            .style("color", "#64748b");

        field.append("span").text(labelText);
        return field.append("input")
            .attr("type", "number")
            .attr("min", "0")
            .attr("max", "255")
            .style("width", "100%")
            .style("border", "1px solid #d1d5db")
            .style("border-radius", "8px")
            .style("padding", "6px 8px")
            .style("font-size", "12px")
            .style("color", "#111827")
            .on("click", function(event) {
                stopInteractionEvent(event);
            });
    };

    const redInput = createRgbInput("R");
    const greenInput = createRgbInput("G");
    const blueInput = createRgbInput("B");

    const actions = editor.append("div")
        .style("display", "flex")
        .style("justify-content", "space-between")
        .style("align-items", "center")
        .style("gap", "8px")
        .style("margin-top", "12px");

    const closeButton = actions.append("button")
        .style("border", "1px solid #d1d5db")
        .style("background", "#ffffff")
        .style("color", "#334155")
        .style("padding", "7px 10px")
        .style("border-radius", "8px")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .style("cursor", "pointer")
        .text("Close")
        .on("click", function(event) {
            stopInteractionEvent(event);
            closeCodeManagerColorEditor();
        });

    const saveButton = actions.append("button")
        .style("border", "none")
        .style("background", "#3A61DD")
        .style("color", "#ffffff")
        .style("padding", "7px 12px")
        .style("border-radius", "8px")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .style("cursor", "pointer")
        .text("Save");

    let committedColor = baseColor;
    let pendingColor = baseColor;

    const syncInputs = (nextColor) => {
        pendingColor = normalizeThemeHexColor(nextColor, committedColor);
        const { r, g, b } = hexToThemeRgb(pendingColor);
        previewDot.style("background-color", pendingColor);
        nativePicker.property("value", pendingColor.toLowerCase());
        redInput.property("value", r);
        greenInput.property("value", g);
        blueInput.property("value", b);
    };

    const persistPendingColor = async ({ closeEditor = false } = {}) => {
        themeEntry.color = pendingColor;
        committedColor = pendingColor;
        if (!colorSwatch.empty()) {
            colorSwatch.style("background-color", pendingColor);
        }
        await persistThemeSelection(themes);
        if (closeEditor) {
            closeCodeManagerColorEditor();
        }
    };

    const commitColor = async () => {
        await persistPendingColor({ closeEditor: true });
    };

    activeCodeManagerColorEditor = {
        themeKey,
        hasPendingChanges() {
            return pendingColor !== committedColor;
        },
        commit: commitColor
    };

    nativePicker
        .on("input", function(event) {
            stopInteractionEvent(event);
            syncInputs(this.value);
        })
        .on("change", async function(event) {
            stopInteractionEvent(event);
            syncInputs(this.value);
            await persistPendingColor();
        });

    [redInput, greenInput, blueInput].forEach(input => {
        input
            .on("input", function(event) {
                stopInteractionEvent(event);
                this.value = clampRgbChannel(this.value);
            })
            .on("change", function(event) {
                stopInteractionEvent(event);
                syncInputs(rgbToThemeHex(
                    redInput.property("value"),
                    greenInput.property("value"),
                    blueInput.property("value")
                ));
            })
            .on("keypress", function(event) {
                const sourceEvent = getInteractionEvent(event);
                if (sourceEvent && sourceEvent.keyCode === 13) {
                    sourceEvent.preventDefault();
                    void commitColor();
                }
            });
    });

    saveButton.on("click", function(event) {
        stopInteractionEvent(event);
        void commitColor();
    });

    syncInputs(baseColor);

    setTimeout(() => {
        d3.select("body").on("click.code-manager-color-editor", () => {
            void finalizeCodeManagerColorEditor({ persistIfDirty: true });
        });
    }, 0);
}

async function loadMasterCodeGroups() {
    try {
        const response = await fetch(withProjectQuery("/api/get_code_groups?includeMeta=1"), {
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (Array.isArray(payload)) {
            masterCodeGroups = normalizeGroupList(payload);
            masterCodeGroupMeta = normalizeCodeGroupMeta(masterCodeGroups, {});
            return;
        }
        masterCodeGroups = normalizeGroupList(payload && payload.groups);
        masterCodeGroupMeta = normalizeCodeGroupMeta(masterCodeGroups, payload && payload.meta);
    } catch (error) {
        console.error("Failed to load code groups:", error);
        masterCodeGroups = [];
        masterCodeGroupMeta = {};
    }
}

async function saveThemeGroups(themeName, groups) {
    const response = await fetch("/api/save_theme_groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withProjectPayload({
            themeName,
            groups: normalizeGroupList(groups)
        }))
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
}

async function syncThemeGroupAssignments(themes) {
    const themeEntries = Array.isArray(themes && themes.themes)
        ? themes.themes.filter(themeEntry => String(themeEntry && themeEntry.themeName || "").trim())
        : [];
    const results = await Promise.allSettled(themeEntries.map(themeEntry =>
        saveThemeGroups(themeEntry.themeName, themeEntry.groups || [])
    ));
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length) {
        console.warn(`Saved document groups, but ${failed.length} theme group assignment sync request(s) failed.`, failed);
    }
}

async function getApiErrorMessage(response, fallback) {
    try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string" && payload.error.trim()) {
            return payload.error;
        }
        if (payload && typeof payload.message === "string" && payload.message.trim()) {
            return payload.message;
        }
    } catch (_) {
        // Ignore JSON parsing errors and use fallback.
    }
    return fallback;
}

async function saveRenamedTheme(oldName, newName) {
    const response = await fetch("/api/rename_theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withProjectPayload({ oldName, newName }))
    });
    if (!response.ok) {
        const errorMessage = await getApiErrorMessage(
            response,
            `Failed to rename theme (HTTP ${response.status})`
        );
        throw new Error(errorMessage);
    }
}

function hasThemeNameCollision(themes, nextName, currentThemeEntry) {
    if (!themes || !Array.isArray(themes.themes)) return false;
    const normalizedNext = normalizeThemeKey(nextName);
    return themes.themes.some(themeEntry => {
        if (!themeEntry || themeEntry === currentThemeEntry) return false;
        return normalizeThemeKey(themeEntry.themeName) === normalizedNext;
    });
}

function setNameInputValidState(inputSelection, isValid) {
    inputSelection
        .style("border", isValid ? "1px solid #ccc" : "1px solid #cf3f52")
        .style("background", isValid ? "#fff" : "#fff6f7");
}

async function commitThemeRename(themeEntry, nextNameRaw, themes, inputNode) {
    if (!themeEntry) return;

    const inputSelection = inputNode ? d3.select(inputNode) : null;
    const currentName = String(themeEntry.themeName || "").trim();
    const nextName = String(nextNameRaw || "").trim();

    if (!currentName) return;
    if (!nextName) {
        if (inputSelection) {
            inputSelection.property("value", currentName);
            setNameInputValidState(inputSelection, false);
        }
        return;
    }

    if (normalizeThemeKey(nextName) === normalizeThemeKey(currentName)) {
        if (inputSelection) {
            inputSelection.property("value", currentName);
            setNameInputValidState(inputSelection, true);
        }
        return;
    }

    if (hasThemeNameCollision(themes, nextName, themeEntry)) {
        if (inputSelection) {
            inputSelection.property("value", currentName);
            setNameInputValidState(inputSelection, false);
        }
        return;
    }

    if (inputSelection) {
        setNameInputValidState(inputSelection, true);
        inputSelection.property("disabled", true).style("opacity", "0.75");
    }

    try {
        await saveRenamedTheme(currentName, nextName);
        migrateManualSelectionThemeName(themes, currentName, nextName);
        themeEntry.themeName = nextName;
        await persistThemeSelection(themes, {
            manualDeletionIntent: { themes: [currentName] }
        });
        displayThemes(themes);
    } catch (error) {
        console.error("Failed to rename theme:", error);
        if (inputSelection) {
            inputSelection.property("value", currentName);
            setNameInputValidState(inputSelection, false);
        }
    } finally {
        if (inputSelection) {
            inputSelection.property("disabled", false).style("opacity", "1");
        }
    }
}

function scheduleThemeRename(themeEntry, nextNameRaw, themes, inputNode) {
    if (!themeEntry) return;
    const pendingTimer = themeRenameTimers.get(themeEntry);
    if (pendingTimer) clearTimeout(pendingTimer);
    const nextTimer = setTimeout(() => {
        themeRenameTimers.delete(themeEntry);
        void commitThemeRename(themeEntry, nextNameRaw, themes, inputNode);
    }, THEME_RENAME_DEBOUNCE_MS);
    themeRenameTimers.set(themeEntry, nextTimer);
}

function flushThemeRename(themeEntry, nextNameRaw, themes, inputNode) {
    if (!themeEntry) return;
    const pendingTimer = themeRenameTimers.get(themeEntry);
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        themeRenameTimers.delete(themeEntry);
    }
    void commitThemeRename(themeEntry, nextNameRaw, themes, inputNode);
}

async function addGroupToTheme(themeName, groupPath, themes) {
    const normalizedGroup = normalizeGroupPath(groupPath);
    if (!normalizedGroup) return;

    const themeEntry = findThemeEntry(themes, themeName);
    if (!themeEntry) return;

    const currentGroups = normalizeGroupList(themeEntry.groups || []);
    const nextGroups = normalizeGroupList([...currentGroups, normalizedGroup]);
    if (nextGroups.length === currentGroups.length) return;

    themeEntry.groups = nextGroups;
    await persistThemeSelection(themes);
    displayThemes(themes);

    try {
        await saveThemeGroups(themeEntry.themeName || themeName, nextGroups);
    } catch (error) {
        console.error("Error auto-saving added group:", error);
    }
}

async function removeGroupFromTheme(themeName, groupPath, themes) {
    const normalizedGroup = normalizeGroupPath(groupPath);
    if (!normalizedGroup) return;

    const themeEntry = findThemeEntry(themes, themeName);
    if (!themeEntry) return;

    const currentGroups = normalizeGroupList(themeEntry.groups || []);
    const nextGroups = normalizeGroupList(currentGroups.filter(group => group !== normalizedGroup));
    if (nextGroups.length === currentGroups.length) return;

    themeEntry.groups = nextGroups;
    await persistThemeSelection(themes);
    displayThemes(themes);

    try {
        await saveThemeGroups(themeEntry.themeName || themeName, nextGroups);
    } catch (error) {
        console.error("Error auto-saving removed group:", error);
    }
}

function closeGroupSelectorPopover({ rerenderThemes = null } = {}) {
    d3.select(`#${GROUP_SELECTOR_POPOVER_ID}`).remove();
    d3.select("body").on("mousedown.code-group-selector", null);
    if (rerenderThemes) {
        displayThemes(rerenderThemes);
    }
}

function openGroupSelector(anchorNode, themeEntry, themes) {
    if (!anchorNode || !themeEntry) return;
    closeGroupSelectorPopover();

    const anchorRect = anchorNode.getBoundingClientRect();
    const popoverWidth = 330;
    const popover = d3.select("body").append("div")
        .attr("id", GROUP_SELECTOR_POPOVER_ID)
        .style("position", "fixed")
        .style("z-index", "1200")
        .style("top", `${Math.min(anchorRect.bottom + 8, window.innerHeight - 420)}px`)
        .style("left", `${Math.min(anchorRect.left, window.innerWidth - popoverWidth - 16)}px`)
        .style("width", `${popoverWidth}px`)
        .style("max-height", "420px")
        .style("background", "#ffffff")
        .style("border", "1px solid #d8dce5")
        .style("border-radius", "12px")
        .style("box-shadow", "0 18px 40px rgba(15, 23, 42, 0.18)")
        .style("font-family", "Inter")
        .style("overflow", "hidden")
        .on("mousedown", function(event) {
            stopInteractionEvent(event);
        });

    const searchWrap = popover.append("div")
        .style("padding", "14px 14px 10px 14px")
        .style("border-bottom", "1px solid #eef0f4");

    const searchInput = searchWrap.append("input")
        .attr("type", "search")
        .attr("placeholder", "Search groups")
        .style("width", "100%")
        .style("height", "42px")
        .style("border", "1px solid #d1d5db")
        .style("border-radius", "10px")
        .style("padding", "0 12px")
        .style("font-size", "14px")
        .style("outline", "none");

    const list = popover.append("div")
        .style("max-height", "278px")
        .style("overflow-y", "auto")
        .style("padding", "8px 0");

    const footer = popover.append("div")
        .style("border-top", "1px solid #eef0f4")
        .style("padding", "10px 14px")
        .style("background", "#ffffff");

    const manageGroupsButton = footer.append("button")
        .attr("type", "button")
        .style("width", "100%")
        .style("border", "none")
        .style("background", "#ffffff")
        .style("color", "#111827")
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "10px")
        .style("font-size", "14px")
        .style("font-weight", "700")
        .style("padding", "8px 0")
        .style("cursor", "pointer")
        .on("click", function(event) {
            stopInteractionEvent(event);
            closeGroupSelectorPopover();
            showEditDocumentGroupsModal(themes);
        });
    manageGroupsButton.append("img")
        .attr("class", "interactive-icon")
        .attr("src", "/static/images/settings-icon.png")
        .attr("alt", "")
        .style("width", "16px")
        .style("height", "16px")
        .style("flex", "0 0 auto");
    manageGroupsButton.append("span").text("Manage Groups");

    let assignmentSaveQueue = Promise.resolve();

    async function persistAssignedGroups(nextGroups) {
        const normalizedGroups = normalizeGroupList(nextGroups);
        themeEntry.groups = normalizedGroups;
        await persistThemeSelection(themes);
        try {
            await saveThemeGroups(themeEntry.themeName, normalizedGroups);
        } catch (error) {
            console.error("Error saving group toggle:", error);
        }
    }

    function queueAssignedGroupsSave() {
        const groupsSnapshot = normalizeGroupList(themeEntry.groups || []);
        persistThemesToProjectStorage(themes);
        assignmentSaveQueue = assignmentSaveQueue
            .catch(() => {})
            .then(() => persistAssignedGroups(groupsSnapshot));
        return assignmentSaveQueue;
    }

    function toggleGroupAssignment(groupPath) {
        const currentGroups = normalizeGroupList(themeEntry.groups || []);
        const currentlyEnabled = currentGroups.includes(groupPath);
        themeEntry.groups = normalizeGroupList(currentlyEnabled
            ? currentGroups.filter(group => group !== groupPath)
            : [...currentGroups, groupPath]);
        renderList(searchInput.property("value"));
        void queueAssignedGroupsSave();
    }

    function renderList(filterText = "") {
        const assignedSet = new Set(normalizeGroupList(themeEntry.groups || []));
        const normalizedFilter = String(filterText || "").trim().toLowerCase();
        const visibleGroups = masterCodeGroups.filter(groupPath =>
            !normalizedFilter || groupPath.toLowerCase().includes(normalizedFilter)
        );

        list.html("");
        if (visibleGroups.length === 0) {
            list.append("div")
                .style("padding", "18px 14px")
                .style("font-size", "13px")
                .style("color", "#6b7280")
                .text("No groups found.");
            return;
        }

        visibleGroups.forEach(groupPath => {
            const enabled = assignedSet.has(groupPath);
            const row = list.append("button")
                .attr("type", "button")
                .attr("aria-pressed", enabled ? "true" : "false")
                .style("width", "100%")
                .style("border", "none")
                .style("background", "#ffffff")
                .style("display", "grid")
                .style("grid-template-columns", "minmax(0, 1fr) 46px")
                .style("align-items", "center")
                .style("gap", "12px")
                .style("padding", "9px 14px")
                .style("cursor", "pointer")
                .on("mouseover", function() { d3.select(this).style("background", "#f8fafc"); })
                .on("mouseout", function() { d3.select(this).style("background", "#ffffff"); })
                .on("click", function(event) {
                    stopInteractionEvent(event);
                    toggleGroupAssignment(groupPath);
                });

            const label = row.append("div")
                .style("display", "flex")
                .style("align-items", "center")
                .style("gap", "8px")
                .style("min-width", "0");

            label.append("span")
                .style("width", "12px")
                .style("height", "12px")
                .style("border-radius", "50%")
                .style("background", masterCodeGroupMeta[groupPath]?.color || "#579AE2")
                .style("flex", "0 0 auto");

            label.append("span")
                .attr("title", groupPath)
                .style("font-size", "14px")
                .style("font-weight", "600")
                .style("color", "#111827")
                .style("padding-left", `${groupDepth(groupPath) * 14}px`)
                .style("overflow", "hidden")
                .style("text-overflow", "ellipsis")
                .style("white-space", "nowrap")
                .text(groupLabel(groupPath) || groupPath);

            const switchTrack = row.append("span")
                .attr("role", "switch")
                .attr("aria-checked", enabled ? "true" : "false")
                .style("width", "40px")
                .style("height", "24px")
                .style("border-radius", "999px")
                .style("background", enabled ? "#3264e8" : "#d1d5db")
                .style("position", "relative")
                .style("display", "inline-block")
                .style("pointer-events", "none");

            switchTrack.append("span")
                .style("position", "absolute")
                .style("top", "3px")
                .style("left", enabled ? "19px" : "3px")
                .style("width", "18px")
                .style("height", "18px")
                .style("border-radius", "50%")
                .style("background", "#ffffff")
                .style("box-shadow", "0 1px 2px rgba(0,0,0,0.18)");
        });
    }

    searchInput.on("input", function() {
        renderList(this.value);
    });

    renderList();
    searchInput.node().focus();

    setTimeout(() => {
        d3.select("body").on("mousedown.code-group-selector", function(event) {
            const sourceEvent = getInteractionEvent(event);
            const popoverNode = document.getElementById(GROUP_SELECTOR_POPOVER_ID);
            if (popoverNode && sourceEvent && popoverNode.contains(sourceEvent.target)) return;
            closeGroupSelectorPopover({ rerenderThemes: themes });
        });
    }, 0);
}

function renderGroupPills(cell, themeEntry, themes) {
    cell.html("");
    themeEntry.groups = normalizeGroupList(themeEntry.groups || []);

    themeEntry.groups.forEach(groupPath => {
        const pill = cell.append("div")
            .style("display", "flex")
            .style("align-items", "center")
            .style("background", "#f1f4ff")
            .style("border", "1px solid #d5def8")
            .style("border-radius", "999px")
            .style("padding", "2px 8px")
            .style("font-size", "12px")
            .style("max-width", "100%");

        pill.append("span")
            .style("white-space", "nowrap")
            .style("overflow", "hidden")
            .style("text-overflow", "ellipsis")
            .attr("title", groupPath)
            .text(groupPath);

        pill.append("button")
            .style("margin-left", "6px")
            .style("border", "none")
            .style("background", "transparent")
            .style("cursor", "pointer")
            .style("font-size", "12px")
            .style("padding", "0")
            .text("x")
            .on("click", () => {
                void removeGroupFromTheme(themeEntry.themeName, groupPath, themes);
            });
    });

    cell.append("button")
        .attr("type", "button")
        .style("border", "1px solid #cfd6e4")
        .style("border-radius", "999px")
        .style("background", "#ffffff")
        .style("padding", "4px 10px")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .style("color", "#111827")
        .style("cursor", "pointer")
        .text(themeEntry.groups.length ? "+ Groups" : "+ Add Group")
        .on("click", function(event) {
            stopInteractionEvent(event);
            openGroupSelector(this, themeEntry, themes);
        });
}

async function archiveCodeFromManager(themeEntry, themes, buttonNode) {
    const themeName = String(themeEntry?.themeName || "").trim();
    if (!themeName) return;
    const confirmed = window.confirm(
        `Archive "${themeName}"?\n\nThe code and all of its quotation assignments will move to Archive, where you can restore them later.`
    );
    if (!confirmed) return;

    const button = d3.select(buttonNode);
    button
        .property("disabled", true)
        .style("opacity", "0.55")
        .style("cursor", "wait");

    try {
        const nextPayload = archiveCodeInPayload(themes, themeName);
        const persistedPayload = await persistThemeSelection(nextPayload, {
            manualDeletionIntent: { themes: [themeName] },
            rollbackOnError: true,
            throwOnError: true,
        });
        copyCodeManagerPayloadMetadata(themes, persistedPayload);
        themes.themes = structuredClone(persistedPayload.themes);
        activeCodeManagerThemes = themes;
        displayThemes(themes);
        d3.select("#code-manager-archive-button")
            .text(`Archive (${(persistedPayload.archivedCodes || []).length})`);
        showCodeManagerStatus(`Archived ${themeName}. Restore it from Archive.`);
    } catch (error) {
        console.error("Failed to archive code:", error);
        showCodeManagerStatus(error.message || `Could not archive ${themeName}.`, "error");
        button
            .property("disabled", false)
            .style("opacity", "1")
            .style("cursor", "pointer");
    }
}

function displayThemes(themes) {
    const participantsMatchingContainer = d3.select("#participantsMatching");
    participantsMatchingContainer.selectAll(".participant-row").remove();

    const participants = Array.isArray(themes && themes.themes) ? themes.themes : [];
    if (participants.length === 0) {
        const emptyRow = participantsMatchingContainer.append("div")
            .attr("class", "participant-row code-manager-empty-state")
            .style("display", "flex")
            .style("align-items", "center")
            .style("justify-content", "center")
            .style("min-height", "140px")
            .style("width", "100%")
            .style("padding", "24px")
            .style("box-sizing", "border-box")
            .style("border-top", "1px solid #ededed")
            .style("color", "#64748b")
            .style("font-family", "Inter")
            .style("font-size", "15px")
            .style("font-weight", "700")
            .style("text-align", "center");
        const generationRunning = d3.select("#main-edit-window").attr("data-generation-running") === "true";
        emptyRow.text(generationRunning
            ? "AI generation is still running. Your codes will appear here automatically when ready."
            : "No codes yet. You can add codes manually or start AI generation.");
        return;
    }

    participants.forEach((themeEntry, themeIndex) => {
        const row = participantsMatchingContainer.append("div")
            .attr("class", "participant-row")
            .style("display", "flex")
            .style("flex-direction", "row")
            .style("justify-content", "start")
            .style("width", "100%")
            .style("border-top", "1px solid #ededed");

        const nameCell = row.append("div")
            .style("width", "25%")
            .style("box-sizing", "border-box")
            .style("border-right", "2px solid #ededed")
            .style("padding", "10px")
            .style("display", "flex")
            .style("align-items", "center");

        nameCell.append("textarea")
            .attr("rows", "2")
            .attr("wrap", "soft")
            .property("value", String(themeEntry.themeName || "").trim())
            .style("width", "100%")
            .style("min-height", "44px")
            .style("resize", "vertical")
            .style("padding", "7px 9px")
            .style("font-size", "14px")
            .style("font-family", "Inter")
            .style("line-height", "1.25")
            .style("border", "1px solid #ccc")
            .style("border-radius", "8px")
            .style("overflow-wrap", "break-word")
            .style("white-space", "pre-wrap")
            .on("input", function() {
                setNameInputValidState(d3.select(this), true);
                scheduleThemeRename(
                    themeEntry,
                    d3.select(this).property("value"),
                    themes,
                    this
                );
            })
            .on("blur", function() {
                flushThemeRename(
                    themeEntry,
                    d3.select(this).property("value"),
                    themes,
                    this
                );
            })
            .on("keydown", function(event) {
                if (event.key === "Enter") {
                    event.preventDefault();
                    this.blur();
                }
            });

        const colorCell = row.append("div")
            .style("width", "8%")
            .style("border-right", "2px solid #ededed")
            .style("padding", "10px")
            .style("display", "flex")
            .style("align-items", "center")
            .style("justify-content", "center")
            .style("position", "relative");

        const displayColor = normalizeThemeHexColor(themeEntry?.color || "#579AE2");
        themeEntry.color = displayColor;

        colorCell.append("button")
            .attr("type", "button")
            .attr("title", "Customize RGB color")
            .style("width", "28px")
            .style("height", "28px")
            .style("padding", "0")
            .style("border", "1px solid rgba(15, 23, 42, 0.10)")
            .style("border-radius", "999px")
            .style("background", "#ffffff")
            .style("display", "inline-flex")
            .style("align-items", "center")
            .style("justify-content", "center")
            .style("cursor", "pointer")
            .style("box-shadow", "0 2px 6px rgba(15, 23, 42, 0.08)")
            .on("click", function(event) {
                stopInteractionEvent(event);
                openCodeManagerColorEditor(colorCell, themeEntry, themes, themeIndex);
            })
            .append("span")
            .style("width", "20px")
            .style("height", "20px")
            .style("border-radius", "50%")
            .style("background-color", displayColor)
            .style("display", "inline-block");

        const tagsCell = row.append("div")
            .style("width", "13%")
            .style("box-sizing", "border-box")
            .style("border-right", "2px solid #ededed")
            .style("padding", "10px")
            .style("display", "flex")
            .style("align-items", "center");
        tagsCell.append("img")
            .attr("class", "readonly-icon")
            .attr("src", "/static/images/tag.svg")
            .style("width", "20px")
            .style("height", "20px");
        tagsCell.append("span")
            .style("margin-left", "8px")
            .text(getSelectedMatchedExcerptCount(themeEntry));

        const groupsCell = row.append("div")
            .style("width", "22%")
            .style("border-right", "2px solid #ededed")
            .style("padding", "10px")
            .style("display", "flex")
            .style("flex-wrap", "wrap")
            .style("gap", "6px")
            .style("align-items", "center");
        renderGroupPills(groupsCell, themeEntry, themes);

        const commentCell = row.append("div")
            .style("width", "24%")
            .style("box-sizing", "border-box")
            .style("border-right", "2px solid #ededed")
            .style("padding", "10px")
            .style("display", "flex")
            .style("align-items", "center");
        commentCell.append("textarea")
            .attr("placeholder", "Add comment")
            .property("value", String(themeEntry.comment || ""))
            .style("width", "100%")
            .style("min-height", "46px")
            .style("resize", "vertical")
            .style("border", "1px solid #d1d5db")
            .style("border-radius", "8px")
            .style("padding", "8px 10px")
            .style("font-size", "13px")
            .style("font-family", "Inter")
            .style("line-height", "1.3")
            .on("input", function() {
                themeEntry.comment = this.value;
            })
            .on("blur", function() {
                themeEntry.comment = this.value;
                void persistThemeSelection(themes);
            });

        const actionCell = row.append("div")
            .style("width", "8%")
            .style("box-sizing", "border-box")
            .style("padding", "10px")
            .style("display", "flex")
            .style("align-items", "center")
            .style("justify-content", "center");

        actionCell.append("button")
            .attr("type", "button")
            .attr("aria-label", `Archive ${String(themeEntry.themeName || "code")}`)
            .attr("title", "Archive code")
            .style("width", "34px")
            .style("height", "34px")
            .style("border", "1px solid #fecaca")
            .style("border-radius", "8px")
            .style("background", "#fff7f7")
            .style("display", "inline-flex")
            .style("align-items", "center")
            .style("justify-content", "center")
            .style("cursor", "pointer")
            .on("click", function(event) {
                stopInteractionEvent(event);
                void archiveCodeFromManager(themeEntry, themes, this);
            })
            .append("img")
            .attr("src", "/static/images/trash.png")
            .attr("alt", "")
            .style("width", "17px")
            .style("height", "17px")
            .style("object-fit", "contain");
    });
}

function showEditDocumentGroupsModal(themes) {
    closeGroupSelectorPopover();
    d3.select(`#${GROUP_MANAGER_MODAL_ID}`).remove();

    const groupRows = normalizeGroupList(masterCodeGroups).map(groupPath => ({
        originalPath: groupPath,
        path: groupPath,
        comment: String(masterCodeGroupMeta[groupPath]?.comment || ""),
        color: normalizeThemeHexColor(masterCodeGroupMeta[groupPath]?.color || "#579AE2", "#579AE2")
    }));
    const groupGridTemplate = "minmax(220px, 1fr) minmax(180px, 0.8fr) minmax(170px, 0.6fr) minmax(220px, 1fr) 44px";
    const newGroupGridTemplate = "minmax(220px, 1fr) minmax(180px, 0.8fr) minmax(170px, 0.6fr) minmax(220px, 1fr)";
    let groupSaveTimer = null;
    let groupSaveInFlight = false;
    let groupSavePending = false;
    let groupSaveClosePending = false;
    let autosaveStatus = null;

    function parentPathOf(path) {
        const parts = normalizeGroupPath(path).split(" > ").filter(Boolean);
        parts.pop();
        return parts.join(" > ");
    }

    function defaultColorForParent(parentPath) {
        const normalizedParent = normalizeGroupPath(parentPath);
        if (!normalizedParent) return "#579AE2";
        const parentRow = groupRows.find(row => normalizeGroupPath(row.path) === normalizedParent);
        return normalizeThemeHexColor(parentRow?.color || masterCodeGroupMeta[normalizedParent]?.color || "#579AE2", "#579AE2");
    }

    function setGroupRowPath(rowData, nextPath) {
        const previousPath = normalizeGroupPath(rowData.path);
        const normalizedNextPath = normalizeGroupPath(nextPath);
        if (!normalizedNextPath) {
            rowData.path = "";
            return;
        }
        if (previousPath && previousPath !== normalizedNextPath) {
            const previousPrefix = `${previousPath} > `;
            groupRows.forEach(candidate => {
                const candidatePath = normalizeGroupPath(candidate.path);
                if (candidate !== rowData && candidatePath.startsWith(previousPrefix)) {
                    candidate.path = normalizeGroupPath(`${normalizedNextPath} > ${candidatePath.slice(previousPrefix.length)}`);
                }
            });
        }
        rowData.path = normalizedNextPath;
    }

    function selectableParentPaths(rowPath = "") {
        const normalizedRowPath = normalizeGroupPath(rowPath);
        const blocked = new Set(descendantsOf(normalizedRowPath, groupRows.map(row => normalizeGroupPath(row.path))));
        return normalizeGroupList(groupRows
            .map(row => normalizeGroupPath(row.path))
            .filter(path => path && !blocked.has(path)));
    }

    function setAutosaveStatus(message, state = "idle") {
        if (!autosaveStatus) return;
        const color = state === "error"
            ? "#b91c1c"
            : state === "saved"
                ? "#166534"
                : "#64748b";
        autosaveStatus
            .style("color", color)
            .text(message);
    }

    function collectCleanedGroupRows() {
        const cleanedRows = [];
        const seen = new Set();
        groupRows.forEach(row => {
            const path = normalizeGroupPath(row.path);
            if (!path || seen.has(path)) return;
            seen.add(path);
            cleanedRows.push({
                ...row,
                path,
                color: normalizeThemeHexColor(row.color || "#579AE2", "#579AE2"),
                comment: String(row.comment || "")
            });
        });
        return cleanedRows;
    }

    function applyGroupRowsToLocalState(cleanedRows) {
        const renameMap = new Map();
        cleanedRows.forEach(row => {
            const original = normalizeGroupPath(row.originalPath);
            if (original && original !== row.path) {
                renameMap.set(original, row.path);
            }
        });

        const nextGroups = normalizeGroupList(cleanedRows.map(row => row.path));
        const nextMeta = {};
        cleanedRows.forEach(row => {
            nextMeta[row.path] = {
                color: row.color,
                comment: row.comment
            };
        });

        if (themes && Array.isArray(themes.themes)) {
            themes.themes.forEach(themeEntry => {
                const currentGroups = normalizeGroupList(themeEntry.groups || []);
                themeEntry.groups = normalizeGroupList(currentGroups
                    .map(group => renameMap.get(group) || group)
                    .filter(group => nextGroups.includes(group)));
            });
        }

        masterCodeGroups = nextGroups;
        masterCodeGroupMeta = normalizeCodeGroupMeta(nextGroups, nextMeta);
        groupRows.forEach(row => {
            const normalizedPath = normalizeGroupPath(row.path);
            if (normalizedPath) row.originalPath = normalizedPath;
        });
        return { nextGroups, nextMeta };
    }

    async function persistDocumentGroups({ closeAfterSave = false } = {}) {
        if (closeAfterSave) groupSaveClosePending = true;
        if (groupSaveInFlight) {
            groupSavePending = true;
            return false;
        }

        groupSaveInFlight = true;
        setAutosaveStatus("Saving...", "saving");
        try {
            const cleanedRows = collectCleanedGroupRows();
            const { nextGroups, nextMeta } = applyGroupRowsToLocalState(cleanedRows);

            if (themes && Array.isArray(themes.themes)) {
                await persistThemeSelection(themes);
            }

            const response = await fetch("/api/save_code_groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(withProjectPayload(buildCodeGroupsPayload(nextGroups, nextMeta)))
            });
            if (!response.ok) {
                throw new Error(await getApiErrorMessage(response, `HTTP ${response.status}`));
            }

            await syncThemeGroupAssignments(themes);

            setAutosaveStatus("Saved", "saved");
            if (closeAfterSave || groupSaveClosePending) {
                groupSaveClosePending = false;
                d3.select(`#${GROUP_MANAGER_MODAL_ID}`).remove();
                displayThemes(themes);
            }
            return true;
        } catch (error) {
            console.error("Failed to save document groups:", error);
            setAutosaveStatus("Could not save", "error");
            groupSaveClosePending = false;
            return false;
        } finally {
            groupSaveInFlight = false;
            if (groupSavePending) {
                const shouldClose = groupSaveClosePending;
                groupSavePending = false;
                void persistDocumentGroups({ closeAfterSave: shouldClose });
            }
        }
    }

    function scheduleDocumentGroupAutosave() {
        setAutosaveStatus("Unsaved changes", "idle");
        if (groupSaveTimer) clearTimeout(groupSaveTimer);
        groupSaveTimer = setTimeout(() => {
            groupSaveTimer = null;
            void persistDocumentGroups();
        }, GROUP_SAVE_DEBOUNCE_MS);
    }

    function applyGroupColorToChildCodes(parentPath, color) {
        const normalizedParent = normalizeGroupPath(parentPath);
        if (!normalizedParent) return;
        const normalizedColor = normalizeThemeHexColor(color || "#579AE2", "#579AE2");
        const affectedGroups = new Set(descendantsOf(
            normalizedParent,
            groupRows.map(row => normalizeGroupPath(row.path)).filter(Boolean)
        ));
        if (affectedGroups.size === 0) affectedGroups.add(normalizedParent);

        groupRows.forEach(row => {
            if (affectedGroups.has(normalizeGroupPath(row.path))) {
                row.color = normalizedColor;
            }
        });

        if (themes && Array.isArray(themes.themes)) {
            themes.themes.forEach(themeEntry => {
                const entryGroups = normalizeGroupList(themeEntry.groups || []);
                if (entryGroups.some(group => affectedGroups.has(group))) {
                    themeEntry.color = normalizedColor;
                }
            });
        }

        renderRows();
        scheduleDocumentGroupAutosave();
    }

    const overlay = d3.select("body").append("div")
        .attr("id", GROUP_MANAGER_MODAL_ID)
        .style("position", "fixed")
        .style("inset", "0")
        .style("z-index", "1300")
        .style("background", "rgba(0,0,0,0.44)")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("font-family", "Inter");

    const modal = overlay.append("div")
        .style("width", "min(1040px, calc(100vw - 56px))")
        .style("max-height", "calc(100vh - 56px)")
        .style("background", "#ffffff")
        .style("border-radius", "12px")
        .style("box-shadow", "0 24px 80px rgba(0,0,0,0.25)")
        .style("padding", "28px 32px")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("gap", "18px")
        .on("mousedown", function(event) {
            stopInteractionEvent(event);
        });

    const header = modal.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "space-between")
        .style("gap", "16px");

    header.append("div")
        .style("font-size", "24px")
        .style("font-weight", "800")
        .style("color", "#111827")
        .text("Edit Document Groups");

    header.append("button")
        .attr("type", "button")
        .style("border", "none")
        .style("background", "transparent")
        .style("font-size", "30px")
        .style("line-height", "1")
        .style("color", "#4b5563")
        .style("cursor", "pointer")
        .text("x")
        .on("click", () => {
            if (groupSaveTimer) {
                clearTimeout(groupSaveTimer);
                groupSaveTimer = null;
            }
            void persistDocumentGroups({ closeAfterSave: true });
        });

    const columnHeader = modal.append("div")
        .style("display", "grid")
        .style("grid-template-columns", groupGridTemplate)
        .style("gap", "10px")
        .style("font-size", "12px")
        .style("font-weight", "800")
        .style("color", "#64748b")
        .style("text-transform", "uppercase");
    columnHeader.append("div").text("Group");
    columnHeader.append("div").text("Parent");
    columnHeader.append("div").text("Color / apply");
    columnHeader.append("div").text("Comment");
    columnHeader.append("div");

    const rowsContainer = modal.append("div")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("gap", "10px")
        .style("overflow-y", "auto")
        .style("max-height", "48vh");

    const addRow = modal.append("div")
        .style("display", "grid")
        .style("grid-template-columns", newGroupGridTemplate)
        .style("gap", "10px")
        .style("align-items", "center");

    const newGroupInput = addRow.append("input")
        .attr("type", "text")
        .attr("placeholder", "Create group or subgroup")
        .attr("aria-label", "New group name")
        .style("height", "44px")
        .style("border", "1px solid #d1d5db")
        .style("border-radius", "10px")
        .style("padding", "0 12px")
        .style("font-size", "15px");
    const newGroupParentSelect = addRow.append("select")
        .style("height", "44px")
        .style("border", "1px solid #d1d5db")
        .style("border-radius", "10px")
        .style("padding", "0 10px")
        .style("font-size", "14px")
        .style("background", "#ffffff")
        .on("change", function() {
            const parentColor = defaultColorForParent(this.value);
            newGroupColorInput.property("value", parentColor.toLowerCase());
        });
    const newGroupColorInput = addRow.append("input")
        .attr("type", "color")
        .property("value", "#579ae2")
        .style("width", "44px")
        .style("height", "36px")
        .style("border", "none")
        .style("background", "transparent")
        .style("cursor", "pointer");
    const newGroupCommentInput = addRow.append("input")
        .attr("type", "text")
        .attr("placeholder", "Comment")
        .style("height", "44px")
        .style("border", "1px solid #d1d5db")
        .style("border-radius", "10px")
        .style("padding", "0 12px")
        .style("font-size", "15px");

    let committingNewGroupDraft = false;

    function commitNewGroupDraft() {
        if (committingNewGroupDraft) return false;

        const rawName = normalizeGroupPath(newGroupInput.property("value"));
        if (!rawName) return false;

        const parentPath = normalizeGroupPath(newGroupParentSelect.property("value"));
        const nextPath = normalizeGroupPath(parentPath ? `${parentPath} > ${rawName}` : rawName);
        if (!nextPath) return false;
        if (groupRows.some(row => normalizeGroupPath(row.path) === nextPath)) {
            setAutosaveStatus("Group already exists", "error");
            return false;
        }

        committingNewGroupDraft = true;
        try {
            groupRows.push({
                originalPath: "",
                path: nextPath,
                comment: String(newGroupCommentInput.property("value") || ""),
                color: normalizeThemeHexColor(
                    newGroupColorInput.property("value") || defaultColorForParent(parentPath),
                    defaultColorForParent(parentPath)
                )
            });
            newGroupInput.property("value", "");
            newGroupCommentInput.property("value", "");
            newGroupParentSelect.property("value", "");
            newGroupColorInput.property("value", "#579ae2");
            renderRows({ scrollToPath: nextPath });
            scheduleDocumentGroupAutosave();
            return true;
        } finally {
            committingNewGroupDraft = false;
        }
    }

    newGroupInput
        .on("keydown", function(event) {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commitNewGroupDraft();
        })
        .on("blur", function() {
            commitNewGroupDraft();
        });

    function refreshNewGroupParentOptions() {
        const currentValue = normalizeGroupPath(newGroupParentSelect.property("value"));
        const parentOptions = selectableParentPaths();
        newGroupParentSelect.html("");
        newGroupParentSelect.append("option").attr("value", "").text("No parent");
        parentOptions.forEach(path => {
            newGroupParentSelect.append("option")
                .attr("value", path)
                .text(toIndentedLabel(path));
        });
        if (parentOptions.includes(currentValue)) {
            newGroupParentSelect.property("value", currentValue);
        } else {
            newGroupParentSelect.property("value", "");
        }
    }

    const footer = modal.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "space-between")
        .style("gap", "10px");

    autosaveStatus = footer.append("div")
        .style("font-size", "13px")
        .style("font-weight", "700")
        .style("color", "#64748b")
        .text("Autosaved");

    const doneButton = footer.append("button")
        .attr("type", "button")
        .style("border", "none")
        .style("background", "#3264e8")
        .style("color", "#ffffff")
        .style("padding", "11px 20px")
        .style("border-radius", "10px")
        .style("font-size", "15px")
        .style("font-weight", "800")
        .style("cursor", "pointer")
        .text("Done")
        .on("click", async function() {
            if (doneButton.property("disabled")) return;
            if (groupSaveTimer) {
                clearTimeout(groupSaveTimer);
                groupSaveTimer = null;
            }
            doneButton
                .property("disabled", true)
                .style("opacity", "0.72")
                .style("cursor", "wait")
                .text("Saving...");

            const saved = await persistDocumentGroups({ closeAfterSave: true });
            if (!saved && !d3.select(`#${GROUP_MANAGER_MODAL_ID}`).empty()) {
                doneButton
                    .property("disabled", false)
                    .style("opacity", "1")
                    .style("cursor", "pointer")
                    .text("Done");
            }
        });

    function keepRenderedGroupRowVisible(containerNode, rowNode) {
        if (!containerNode || !rowNode) return;
        const rowTop = rowNode.offsetTop - containerNode.offsetTop;
        const rowBottom = rowTop + rowNode.offsetHeight;
        const visibleTop = containerNode.scrollTop;
        const visibleBottom = visibleTop + containerNode.clientHeight;
        const margin = 12;

        if (rowTop - margin < visibleTop) {
            containerNode.scrollTop = Math.max(0, rowTop - margin);
        } else if (rowBottom + margin > visibleBottom) {
            containerNode.scrollTop = Math.max(0, rowBottom + margin - containerNode.clientHeight);
        }
    }

    function renderRows(options = {}) {
        const scrollToPath = normalizeGroupPath(options.scrollToPath);
        const shouldPreserveScroll = options.preserveScroll !== false && !scrollToPath;
        const containerNode = rowsContainer.node();
        const previousScrollTop = containerNode ? containerNode.scrollTop : 0;
        const renderedRowsByPath = new Map();

        rowsContainer.html("");
        refreshNewGroupParentOptions();
        if (groupRows.length === 0) {
            rowsContainer.append("div")
                .style("padding", "20px")
                .style("border", "1px dashed #cbd5e1")
                .style("border-radius", "10px")
                .style("color", "#64748b")
                .style("font-size", "14px")
                .text("No groups yet.");
            return;
        }

        groupRows.forEach((rowData, index) => {
            const normalizedPath = normalizeGroupPath(rowData.path);
            const currentParentPath = parentPathOf(normalizedPath);
            const currentLabel = groupLabel(normalizedPath);
            const row = rowsContainer.append("div")
                .style("display", "grid")
                .style("grid-template-columns", groupGridTemplate)
                .style("gap", "10px")
                .style("align-items", "center");
            if (normalizedPath) {
                renderedRowsByPath.set(normalizedPath, row.node());
            }

            row.append("input")
                .attr("type", "text")
                .property("value", currentLabel)
                .style("height", "44px")
                .style("border", "1px solid #d1d5db")
                .style("border-radius", "10px")
                .style("padding", "0 12px")
                .style("font-size", "15px")
                .on("input", function() {
                    const leafName = String(this.value || "").trim();
                    setGroupRowPath(rowData, currentParentPath ? `${currentParentPath} > ${leafName}` : leafName);
                    scheduleDocumentGroupAutosave();
                });

            const parentSelect = row.append("select")
                .style("height", "44px")
                .style("border", "1px solid #d1d5db")
                .style("border-radius", "10px")
                .style("padding", "0 10px")
                .style("font-size", "14px")
                .style("background", "#ffffff");
            parentSelect.append("option").attr("value", "").text("No parent");
            let parentOptions = selectableParentPaths(normalizedPath);
            if (currentParentPath && !parentOptions.includes(currentParentPath)) {
                parentOptions = normalizeGroupList([...parentOptions, currentParentPath]);
            }
            parentOptions.forEach(path => {
                parentSelect.append("option")
                    .attr("value", path)
                    .text(toIndentedLabel(path));
            });
            parentSelect
                .property("value", currentParentPath)
                .on("change", function() {
                    const leafName = groupLabel(rowData.path);
                    const nextParent = normalizeGroupPath(this.value);
                    setGroupRowPath(rowData, nextParent ? `${nextParent} > ${leafName}` : leafName);
                    renderRows();
                    scheduleDocumentGroupAutosave();
                });

            const colorControls = row.append("div")
                .style("display", "flex")
                .style("align-items", "center")
                .style("gap", "8px");

            colorControls.append("input")
                .attr("type", "color")
                .property("value", normalizeThemeHexColor(rowData.color || "#579AE2", "#579AE2").toLowerCase())
                .style("width", "44px")
                .style("height", "36px")
                .style("border", "none")
                .style("background", "transparent")
                .style("cursor", "pointer")
                .on("input", function() {
                    rowData.color = this.value;
                    scheduleDocumentGroupAutosave();
                });

            colorControls.append("button")
                .attr("type", "button")
                .attr("title", "Apply this group color to child groups and all codes assigned under this group")
                .style("border", "1px solid #c7d2fe")
                .style("background", "#eef2ff")
                .style("color", "#1f3f9a")
                .style("height", "34px")
                .style("border-radius", "8px")
                .style("padding", "0 10px")
                .style("font-size", "12px")
                .style("font-weight", "800")
                .style("cursor", "pointer")
                .style("white-space", "nowrap")
                .text("Apply")
                .on("click", function(event) {
                    stopInteractionEvent(event);
                    applyGroupColorToChildCodes(rowData.path, rowData.color);
                });

            row.append("input")
                .attr("type", "text")
                .property("value", rowData.comment)
                .attr("placeholder", "Comment")
                .style("height", "44px")
                .style("border", "1px solid #d1d5db")
                .style("border-radius", "10px")
                .style("padding", "0 12px")
                .style("font-size", "15px")
                .on("input", function() {
                    rowData.comment = this.value;
                    scheduleDocumentGroupAutosave();
                });

            row.append("button")
                .attr("type", "button")
                .style("border", "none")
                .style("background", "#ffffff")
                .style("height", "40px")
                .style("border-radius", "10px")
                .style("font-size", "22px")
                .style("color", "#4b5563")
                .style("cursor", "pointer")
                .text("x")
                .on("click", function() {
                    groupRows.splice(index, 1);
                    renderRows();
                    scheduleDocumentGroupAutosave();
                });
        });

        const updatedContainerNode = rowsContainer.node();
        if (updatedContainerNode && scrollToPath && renderedRowsByPath.has(scrollToPath)) {
            keepRenderedGroupRowVisible(updatedContainerNode, renderedRowsByPath.get(scrollToPath));
        } else if (updatedContainerNode && shouldPreserveScroll) {
            updatedContainerNode.scrollTop = Math.min(
                previousScrollTop,
                Math.max(0, updatedContainerNode.scrollHeight - updatedContainerNode.clientHeight)
            );
        }
    }

    renderRows();
}

function showGroupsPopup(themes) {
    showEditDocumentGroupsModal(themes);
    return;
    let currentGroups = normalizeGroupList(masterCodeGroups);
    let saveTimer = null;
    let saveInFlight = false;
    let pendingSave = false;
    let closeAfterSave = false;

    const mainEditWindow = d3.select("#main-edit-window");
    mainEditWindow.selectAll("*").remove();
    mainEditWindow
        .style("flex-direction", "column")
        .style("align-items", "center")
        .style("justify-content", "flex-start");

    const page = mainEditWindow.append("div")
        .attr("id", "created-groups-page")
        .style("width", "84%")
        .style("margin-top", "10%")
        .style("font-family", "Inter")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("gap", "18px");

    const pageHeader = page.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "space-between")
        .style("gap", "16px");

    const titleBlock = pageHeader.append("div")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("gap", "4px");

    titleBlock.append("div")
        .style("font-size", "14px")
        .style("font-weight", "700")
        .style("color", "#5f6f99")
        .text("Code Manager");

    titleBlock.append("h2")
        .style("margin", "0")
        .style("font-size", "34px")
        .style("font-weight", "800")
        .style("color", "#3A61DD")
        .text("Created Groups");

    pageHeader.append("button")
        .text("Back to Codes")
        .style("border", "1px solid #c9d6ff")
        .style("background", "#eef2ff")
        .style("color", "#1f3f9a")
        .style("padding", "10px 16px")
        .style("border-radius", "10px")
        .style("font-size", "14px")
        .style("font-weight", "800")
        .style("cursor", "pointer")
        .on("click", () => {
            if (saveTimer) {
                clearTimeout(saveTimer);
                saveTimer = null;
            }
            void flushSave(true);
        });

    const popup = page.append("div")
        .style("background", "#fff")
        .style("padding", "22px")
        .style("border-radius", "12px")
        .style("width", "100%")
        .style("box-shadow", "0px 4px 4px rgba(0, 48, 83, 0.18)")
        .style("display", "flex")
        .style("flex-direction", "column");

    const listContainer = popup.append("div")
        .style("border", "1px solid #ddd")
        .style("border-radius", "8px")
        .style("padding", "10px")
        .style("overflow-y", "auto")
        .style("max-height", "48vh");

    const addSection = popup.append("div")
        .style("display", "grid")
        .style("grid-template-columns", "minmax(180px, 1fr) minmax(180px, 1fr) auto")
        .style("gap", "8px")
        .style("align-items", "center")
        .style("margin-top", "12px");

    const newNameInput = addSection.append("input")
        .attr("type", "text")
        .attr("placeholder", "New group name")
        .style("padding", "8px")
        .style("border", "1px solid #ccc")
        .style("border-radius", "8px");

    const parentSelect = addSection.append("select")
        .style("padding", "8px")
        .style("border", "1px solid #ccc")
        .style("border-radius", "8px");

    const addButton = addSection.append("button")
        .text("Add Group")
        .style("border", "none")
        .style("background", "#eef2ff")
        .style("padding", "8px 12px")
        .style("border-radius", "8px")
        .style("font-weight", "800")
        .style("cursor", "pointer");

    const footer = popup.append("div")
        .style("display", "flex")
        .style("justify-content", "flex-end")
        .style("margin-top", "14px");

    const saveButton = footer.append("button")
        .text("Save & Back")
        .style("border", "none")
        .style("background", "#3A61DD")
        .style("color", "#fff")
        .style("padding", "10px 18px")
        .style("border-radius", "8px")
        .style("cursor", "pointer");

    function returnToCodeManager() {
        void startDemoThemeEditing(themes);
    }

    function hasGroupChanges(cleanedGroups) {
        if (cleanedGroups.length !== masterCodeGroups.length) return true;
        return cleanedGroups.some((groupPath, idx) => groupPath !== masterCodeGroups[idx]);
    }

    async function applySavedGroups(cleanedGroups) {
        masterCodeGroups = cleanedGroups;
        if (themes && Array.isArray(themes.themes)) {
            themes.themes.forEach(theme => {
                theme.groups = normalizeGroupList(theme.groups || []).filter(
                    group => masterCodeGroups.includes(group)
                );
            });
        }
        await persistThemeSelection(themes);
        displayThemes(themes);
    }

    async function flushSave(shouldClose = false) {
        if (shouldClose) closeAfterSave = true;

        const cleaned = normalizeGroupList(currentGroups);
        currentGroups = cleaned;

        if (!hasGroupChanges(cleaned)) {
            if (closeAfterSave) returnToCodeManager();
            return;
        }

        if (saveInFlight) {
            pendingSave = true;
            return;
        }

        saveInFlight = true;
        try {
            const response = await fetch("/api/save_code_groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(withProjectPayload({ groups: cleaned }))
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            await applySavedGroups(cleaned);
        } catch (error) {
            console.error("Failed to auto-save group hierarchy:", error);
            closeAfterSave = false;
        } finally {
            saveInFlight = false;
            if (pendingSave) {
                pendingSave = false;
                await flushSave(false);
                return;
            }
            if (closeAfterSave) returnToCodeManager();
        }
    }

    function queueAutoSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void flushSave(false);
        }, GROUP_SAVE_DEBOUNCE_MS);
    }

    function renderParentOptions() {
        parentSelect.html("");
        parentSelect.append("option").attr("value", "").text("(Top-level)");
        currentGroups.forEach(groupPath => {
            parentSelect.append("option")
                .attr("value", groupPath)
                .text(toIndentedLabel(groupPath));
        });
    }

    function renderList() {
        listContainer.html("");
        if (currentGroups.length === 0) {
            listContainer.append("div")
                .style("font-size", "13px")
                .style("color", "#666")
                .text("No groups yet. Create a top-level group, then add child groups.");
            renderParentOptions();
            return;
        }

        currentGroups.forEach((groupPath, index) => {
            const row = listContainer.append("div")
                .style("display", "flex")
                .style("align-items", "center")
                .style("gap", "8px")
                .style("margin-bottom", "8px");

            row.append("span")
                .style("min-width", "110px")
                .style("font-size", "12px")
                .style("color", "#666")
                .text(`L${groupDepth(groupPath) + 1}`);

            row.append("input")
                .attr("type", "text")
                .property("value", groupPath)
                .style("flex-grow", "1")
                .style("padding", "6px 8px")
                .style("border", "1px solid #ccc")
                .style("border-radius", "8px")
                .on("input", function() {
                    currentGroups[index] = normalizeGroupPath(this.value);
                })
                .on("blur", function() {
                    currentGroups[index] = normalizeGroupPath(this.value);
                    currentGroups = normalizeGroupList(currentGroups);
                    renderList();
                    queueAutoSave();
                })
                .on("keydown", function(event) {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        this.blur();
                    }
                });

            row.append("button")
                .text("Delete")
                .style("border", "1px solid #ddd")
                .style("background", "#fff")
                .style("padding", "6px 8px")
                .style("border-radius", "8px")
                .style("cursor", "pointer")
                .on("click", () => {
                    const subtree = new Set(descendantsOf(groupPath, currentGroups));
                    currentGroups = currentGroups.filter(path => !subtree.has(path));
                    currentGroups = normalizeGroupList(currentGroups);
                    renderList();
                    queueAutoSave();
                });
        });

        renderParentOptions();
    }

    addButton.on("click", () => {
        const groupName = String(newNameInput.property("value") || "").trim();
        if (!groupName) return;
        const parentPath = normalizeGroupPath(parentSelect.property("value"));
        const newPath = normalizeGroupPath(parentPath ? `${parentPath} > ${groupName}` : groupName);
        if (!newPath) return;
        if (currentGroups.includes(newPath)) {
            newNameInput.property("value", "");
            return;
        }
        currentGroups = normalizeGroupList([...currentGroups, newPath]);
        newNameInput.property("value", "");
        renderList();
        queueAutoSave();
    });

    saveButton.on("click", () => {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        void flushSave(true);
    });

    renderList();
}

function showCodeManagerError(message) {
    d3.select("#code-manager-error").remove();
    d3.select("#main-edit-window").append("div")
        .attr("id", "code-manager-error")
        .style("position", "absolute")
        .style("right", "20px")
        .style("bottom", "74px")
        .style("background", "#fff2f2")
        .style("border", "1px solid #f0b3b3")
        .style("color", "#7d1b1b")
        .style("border-radius", "8px")
        .style("padding", "8px 12px")
        .style("font-size", "13px")
        .text(message || "Failed to continue to visualization.");
}

function showCodeManagerStatus(message, state = "info") {
    d3.select("#code-manager-status").remove();
    const colors = state === "error"
        ? { background: "#fff2f2", border: "#f0b3b3", color: "#7d1b1b" }
        : { background: "#f0f6ff", border: "#bfdbfe", color: "#1e3a8a" };
    d3.select("#main-edit-window").append("div")
        .attr("id", "code-manager-status")
        .style("position", "absolute")
        .style("right", "20px")
        .style("bottom", "74px")
        .style("background", colors.background)
        .style("border", `1px solid ${colors.border}`)
        .style("color", colors.color)
        .style("border-radius", "8px")
        .style("padding", "8px 12px")
        .style("font-size", "13px")
        .style("font-weight", "700")
        .text(message);
}

async function startAiGenerationInBackground() {
    showCodeManagerStatus("AI generation is running in the background.");
    try {
        const response = await fetch("/create_themes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(withProjectPayload({}))
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        window.dispatchEvent(new CustomEvent("themes:generation-started"));
    } catch (error) {
        console.error("Failed to start AI generation:", error);
        showCodeManagerStatus("Could not start AI generation.", "error");
    }
}

function codeManagerThemeNames(themes) {
    return (Array.isArray(themes && themes.themes) ? themes.themes : [])
        .map(theme => String(theme?.themeName || "").trim())
        .filter(Boolean);
}


function appendEditCodesAvailabilityHelp(container, button) {
    const tooltipId = `edit-codes-help-${Date.now().toString(36)}`;

    button.attr("aria-describedby", tooltipId);
    button.append("span")
        .attr("class", "code-manager-edit-help-trigger")
        .attr("aria-hidden", "true")
        .on("click", function(event) {
            const sourceEvent = stopInteractionEvent(event);
            if (sourceEvent && typeof sourceEvent.preventDefault === "function") {
                sourceEvent.preventDefault();
            }
        })
        .text("?");

    container.append("span")
        .attr("id", tooltipId)
        .attr("class", "code-manager-edit-help-tooltip")
        .attr("role", "tooltip")
        .text("The Edit Codes page will be available after the AI-tagging process is done. If you want to edit manual codes before AI tagging is done, please do that in Transcript Mode.");
}


async function generateMoreCodesWithQwen(themes, buttonNode) {
    const button = d3.select(buttonNode);
    const originalLabel = button.text();
    button
        .property("disabled", true)
        .style("opacity", "0.62")
        .style("cursor", "wait")
        .text("Generating...");
    showCodeManagerStatus("Qwen3 is generating more code suggestions.");

    try {
        const response = await fetch("/api/generate_more_codes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(withProjectPayload({
                count: 5,
                existingCodes: codeManagerThemeNames(themes)
            }))
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const details = payload?.details || payload?.error || `HTTP ${response.status}`;
            throw new Error(details);
        }

        if (payload?.themeObject && Array.isArray(payload.themeObject.themes)) {
            persistThemesToProjectStorage(payload.themeObject);
            updateCodeManagerFromPayload(payload.themeObject);
        } else {
            await refreshCodeManagerThemesFromServer();
        }

        const addedCount = Array.isArray(payload?.addedCodes) ? payload.addedCodes.length : 0;
        showCodeManagerStatus(
            addedCount > 0
                ? `Added ${addedCount} AI-suggested code${addedCount === 1 ? "" : "s"}.`
                : "Qwen3 did not find distinct new codes this time.",
            "info"
        );
        window.dispatchEvent(new CustomEvent("themes:code-suggestions-updated", {
            detail: {
                ...(payload || {}),
                payload: payload?.themeObject || null,
                projectId: getCurrentProjectId()
            }
        }));
    } catch (error) {
        console.error("Failed to generate more AI codes:", error);
        showCodeManagerStatus(error.message || "Could not generate more AI codes.", "error");
    } finally {
        button
            .property("disabled", false)
            .style("opacity", "1")
            .style("cursor", "pointer")
            .text(originalLabel || "AI Generate More Codes");
    }
}

async function goToVisualization(themes) {
    showVisualizationLoadingOverlay();
    try {
        persistThemesToProjectStorage(themes);
        const response = await fetch("/visualization", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(withProjectPayload(themes || { themes: [] }))
        });
        if (!response.ok) {
            let details = response.statusText || "Failed to continue.";
            try {
                const payload = await response.json();
                if (payload && payload.error) details = payload.error;
            } catch (_) {
                // keep fallback message
            }
            hideVisualizationLoadingOverlay();
            showCodeManagerError(details);
            return;
        }
        setSelectionComplete(true);
        await navigateToVisualizationWithOverlay("Applying selected codes");
    } catch (error) {
        console.error("Failed to navigate to visualization:", error);
        hideVisualizationLoadingOverlay();
        showCodeManagerError("Unable to reach the server.");
    }
}

export async function startDemoThemeEditing(themes) {
    const mainEditWindow = d3.select("#main-edit-window");
    const isDemoMode = window.APP_MODE === "demo";
    const normalizedThemes = themes && Array.isArray(themes.themes) ? themes : { themes: [] };
    themes = normalizedThemes;
    activeCodeManagerThemes = themes;
    initializeCodeManagerLiveSync();

    await loadMasterCodeGroups();
    mainEditWindow.selectAll("*").remove();
    demoingObject.demoing = false;
    persistThemesToProjectStorage(themes);

    const title = mainEditWindow.append("div")
        .style("position", "absolute")
        .style("top", "10%")
        .style("text-align", "left")
        .style("width", "84%")
        .style("font-family", "Inter")
        .style("font-size", "34px")
        .style("font-weight", "700")
        .style("color", "#3A61DD")
        .style("margin-left", "5%")
        .text("Code Manager");

    const mainContentContainer = title.append("div")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("align-items", "center")
        .style("margin-top", "38px")
        .style("width", "100%")
        .style("font-family", "Nunito")
        .style("font-size", "20px")
        .style("font-weight", "800")
        .style("color", "#000")
        .style("text-align", "left");

    const mainContent = mainContentContainer.append("div")
        .style("width", "100%")
        .style("display", "flex")
        .style("flex-direction", "row")
        .style("align-items", "normal")
        .style("justify-content", "start");

    const actionButtons = mainEditWindow.append("div")
        .style("position", "absolute")
        .style("top", "10%")
        .style("right", "20px")
        .style("display", "flex")
        .style("gap", "10px")
        .style("flex-wrap", "wrap")
        .style("justify-content", "flex-end");

    const editCodesControl = actionButtons.append("div")
        .attr("class", "code-manager-edit-help-wrapper")
        .style("display", "inline-flex")
        .style("align-items", "center")
        .style("position", "relative");

    const editCodesButton = editCodesControl.append("button")
        .attr("class", "code-manager-edit-button")
        .style("border-radius", "10px")
        .style("background", "#3A61DD")
        .style("color", "#ffffff")
        .style("border", "none")
        .style("padding", "12px 18px 12px 20px")
        .style("font-family", "Inter")
        .style("font-size", "16px")
        .style("font-weight", "700")
        .style("display", "inline-flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("gap", "10px")
        .style("white-space", "nowrap")
        .style("cursor", "pointer")
        .on("click", function () {
            fetch("/themes/edit", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(withProjectPayload(themes))
            })
            .then(response => {
                if (response.status === 204) {
                    window.location.href = "/themes/edit";
                    console.log("Themes updated successfully");
                }
            })
            .catch(error => console.error("Error:", error));
        });
    editCodesButton.append("span").text("Edit Codes");

    appendEditCodesAvailabilityHelp(editCodesControl, editCodesButton);

    const archivedCodeCount = Array.isArray(themes.archivedCodes) ? themes.archivedCodes.length : 0;
    actionButtons.append("button")
        .attr("id", "code-manager-archive-button")
        .attr("type", "button")
        .style("border-radius", "10px")
        .style("background", "#f8fafc")
        .style("color", "#374151")
        .style("border", "1px solid #d1d5db")
        .style("padding", "12px 18px")
        .style("font-family", "Inter")
        .style("font-size", "16px")
        .style("font-weight", "700")
        .style("white-space", "nowrap")
        .style("cursor", "pointer")
        .text(archivedCodeCount > 0 ? `Archive (${archivedCodeCount})` : "Archive")
        .on("click", async function() {
            try {
                const { showArchivePage } = await import("./archivePage.js?v=20260901a");
                await showArchivePage(themes);
            } catch (error) {
                console.error("Could not open Archive:", error);
                showCodeManagerStatus("Could not open Archive.", "error");
            }
        });

    actionButtons.append("button")
        .style("border-radius", "10px")
        .style("background", "#eef2ff")
        .style("color", "#1f3f9a")
        .style("border", "1px solid #c9d6ff")
        .style("padding", "12px 18px")
        .style("font-family", "Inter")
        .style("font-size", "16px")
        .style("font-weight", "700")
        .style("white-space", "nowrap")
        .style("cursor", "pointer")
        .text("AI Generate More Codes")
        .on("click", function () {
            void generateMoreCodesWithQwen(themes, this);
        });

    actionButtons.append("button")
        .style("border-radius", "10px")
        .style("background", "#000000")
        .style("color", "#ffffff")
        .style("border", "none")
        .style("padding", "12px 20px")
        .style("font-family", "Inter")
        .style("font-size", "16px")
        .style("font-weight", "700")
        .text("Go to Visualization")
        .on("click", () => {
            void goToVisualization(themes);
        });

    const filesColumn = mainContent.append("div").style("width", "92%");
    const filesMatched = filesColumn.append("div")
        .attr("id", "participantsMatching")
        .style("margin-top", "10px")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("align-items", "center")
        .style("overflow", "auto")
        .style("border-radius", "10px")
        .style("opacity", "1")
        .style("border", "2px solid #C4C4C4");

    const labels = filesMatched.append("div")
        .style("display", "flex")
        .style("flex-direction", "row")
        .style("justify-content", "start")
        .style("color", "#3A61DD")
        .style("width", "100%")
        .style("font-size", "17px")
        .style("font-weight", "800")
        .style("line-height", "1.15");

    labels.append("div")
        .style("width", "25%")
        .style("box-sizing", "border-box")
        .style("border-right", "2px solid #ededed")
        .style("padding", "10px")
        .style("overflow-wrap", "anywhere")
        .text("Name");
    labels.append("div")
        .style("width", "8%")
        .style("box-sizing", "border-box")
        .style("border-right", "2px solid #ededed")
        .style("padding", "10px")
        .style("overflow-wrap", "anywhere")
        .text("Color");
    labels.append("div")
        .style("width", "13%")
        .style("box-sizing", "border-box")
        .style("border-right", "2px solid #ededed")
        .style("padding", "10px")
        .style("overflow-wrap", "anywhere")
        .style("white-space", "nowrap")
        .text("Quotations");

    const groupsHeader = labels.append("div")
        .style("width", "22%")
        .style("box-sizing", "border-box")
        .style("border-right", "2px solid #ededed")
        .style("padding", "10px")
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "8px")
        .style("flex-wrap", "wrap")
        .style("overflow-wrap", "anywhere");
    groupsHeader.append("span").text("Groups");
    const manageGroupsHeaderButton = groupsHeader.append("button")
        .attr("type", "button")
        .attr("aria-label", "Manage Groups")
        .attr("title", "Manage Groups")
        .style("display", "inline-flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("border", "none")
        .style("background", "transparent")
        .style("color", "#3A61DD")
        .style("font", "inherit")
        .style("font-weight", "700")
        .style("font-size", "16px")
        .style("line-height", "1.1")
        .style("width", "24px")
        .style("height", "24px")
        .style("min-width", "24px")
        .style("padding", "0")
        .style("cursor", "pointer")
        .on("click", function(event) {
            stopInteractionEvent(event);
            showEditDocumentGroupsModal(themes);
        });
    manageGroupsHeaderButton.append("img")
        .attr("class", "interactive-icon")
        .attr("src", "/static/images/settings-icon.png")
        .attr("alt", "")
        .style("width", "16px")
        .style("height", "16px");

    labels.append("div")
        .style("width", "24%")
        .style("box-sizing", "border-box")
        .style("border-right", "2px solid #ededed")
        .style("padding", "10px")
        .style("overflow-wrap", "anywhere")
        .text("Comment");

    labels.append("div")
        .style("width", "8%")
        .style("box-sizing", "border-box")
        .style("padding", "10px 6px")
        .style("overflow-wrap", "anywhere")
        .style("text-align", "center")
        .text("Actions");

    filesMatched.append("div")
        .style("width", "100%")
        .style("height", "2px")
        .style("background-color", "#C4C4C4");

    displayThemes(themes);
    void refreshCodeManagerThemesFromServer();
    mainEditWindow.style("flex-direction", "column")
        .style("align-items", "center")
        .style("justify-content", "flex-start");
}
