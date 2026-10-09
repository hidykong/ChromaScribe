import {
    currentDisplayObject,
    highlight,
    themeObject,
    themeSelectedObject,
    themesObject,
} from "../../chromascribe-main.js";
import { drawVisualization } from "./drawVisualization.js?v=20260901b";
import { drawVisualization2 } from "./drawVisualization2.js?v=20260901b";
import {
    appendThemeColorDot,
    commitThemeColorUpdates,
    commitThemeOrder,
    normalizeThemeColor,
    persistThemeSelection,
    selectTheme,
    syncThemeSelectionStyles,
} from "./selectTheme.js?v=20260929a";
import {
    buildPersistedThemePayload,
    dedupeThemeWordEntries,
    getContrastingTextColor,
    normalizeThemeNameKey,
    persistThemePayloadLocally,
} from "../themePersistence.js?v=20260901b";

const PANEL_OVERLAY_ID = "color-adjustment-panel-overlay";
const STATUS_IDLE = "idle";
const STATUS_SUCCESS = "success";
const STATUS_ERROR = "error";
const DEFAULT_GROUP_COLOR = "#579AE2";

let activeMode = "codes";
let activeDragData = null;
let selectedCodeKeys = new Set();
let groupState = {
    loaded: false,
    loadingPromise: null,
    groups: [],
    meta: {},
};

function getCurrentProjectId() {
    const serverProjectId = String(window.CURRENT_PROJECT_ID || "").trim();
    if (serverProjectId) return serverProjectId;
    try {
        return String(localStorage.getItem("currentProjectId") || "").trim();
    } catch (_) {
        return "";
    }
}

function withProjectPayload(payload) {
    const projectId = getCurrentProjectId();
    return projectId && payload && typeof payload === "object"
        ? { ...payload, projectId }
        : payload;
}

function scopedPath(url) {
    const rawUrl = String(url || "");
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("/demo/") || rawUrl === "/demo") return rawUrl;
    const isDemoPath = window.location.pathname === "/demo" || window.location.pathname.startsWith("/demo/");
    return isDemoPath ? `/demo${rawUrl}` : rawUrl;
}

function withProjectQuery(url) {
    const projectId = getCurrentProjectId();
    const scopedUrl = scopedPath(url);
    if (!projectId) return scopedUrl;
    const separator = scopedUrl.includes("?") ? "&" : "?";
    return `${scopedUrl}${separator}projectId=${encodeURIComponent(projectId)}`;
}

function getCurrentView() {
    return window.view === "question" ? "question" : "timeline";
}

function normalizeGroupPath(value) {
    const rawValue = String(value || "").trim();
    if (!rawValue) return "";
    return rawValue
        .split(">")
        .map(part => part.trim())
        .filter(Boolean)
        .join(" > ");
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
    return normalized;
}

function groupDepth(groupPath) {
    const normalized = normalizeGroupPath(groupPath);
    return normalized ? normalized.split(" > ").length - 1 : 0;
}

function groupLabel(groupPath) {
    const parts = normalizeGroupPath(groupPath).split(" > ");
    return parts[parts.length - 1] || "";
}

function groupParentPath(groupPath) {
    const parts = normalizeGroupPath(groupPath).split(" > ").filter(Boolean);
    if (parts.length <= 1) return "";
    return parts.slice(0, -1).join(" > ");
}

function normalizeGroupMeta(groups, meta = {}) {
    const normalizedMeta = {};
    normalizeGroupList(groups).forEach(groupPath => {
        const rawMeta = meta && typeof meta === "object" ? meta[groupPath] : {};
        normalizedMeta[groupPath] = {
            color: normalizeThemeColor(rawMeta && rawMeta.color, ""),
            comment: String(rawMeta && rawMeta.comment || ""),
        };
    });
    return normalizedMeta;
}

function buildCodeGroupsPayload() {
    const groups = normalizeGroupList(groupState.groups);
    return {
        groups,
        meta: normalizeGroupMeta(groups, groupState.meta),
    };
}

function getThemes() {
    return Array.isArray(themesObject.themes) ? themesObject.themes : [];
}

function getThemeName(theme) {
    return String(theme && theme.themeName || "").trim();
}

function getCodeLookupKey(value) {
    return normalizeThemeNameKey(value);
}

function getThemeKey(theme) {
    return getCodeLookupKey(getThemeName(theme));
}

function findThemeByName(themeName) {
    const targetKey = getCodeLookupKey(themeName);
    if (!targetKey) return null;
    return getThemes().find(theme => getThemeKey(theme) === targetKey) || null;
}

function getThemeColor(theme) {
    return normalizeThemeColor(theme && theme.color, DEFAULT_GROUP_COLOR);
}

function getQuoteCount(theme) {
    return Array.isArray(theme && theme.words) ? theme.words.length : 0;
}

function formatQuoteCount(count) {
    const value = Number.isFinite(Number(count)) ? Number(count) : 0;
    return `${value} quote${value === 1 ? "" : "s"}`;
}

function mergeUniqueArrayValues(...arrays) {
    const seen = new Set();
    const merged = [];
    arrays.forEach(arrayValue => {
        (Array.isArray(arrayValue) ? arrayValue : []).forEach(value => {
            const normalizedValue = String(value || "").trim();
            if (!normalizedValue || seen.has(normalizedValue)) return;
            seen.add(normalizedValue);
            merged.push(normalizedValue);
        });
    });
    return merged;
}

function clonePlainObject(value) {
    if (!value || typeof value !== "object") return {};
    try {
        return structuredClone(value);
    } catch (_) {
        return JSON.parse(JSON.stringify(value));
    }
}

function formatCodeDisplayName(themeName) {
    return String(themeName || "").replaceAll("_", " ").trim();
}

function themeHasGroup(theme, groupPath) {
    const target = normalizeGroupPath(groupPath);
    return normalizeGroupList(theme && theme.groups).includes(target);
}

function getAssignedThemesForGroup(groupPath) {
    return getThemes().filter(theme => themeHasGroup(theme, groupPath));
}

function resolveGroupColor(groupPath) {
    const normalizedPath = normalizeGroupPath(groupPath);
    const metaColor = normalizeThemeColor(groupState.meta[normalizedPath]?.color, "");
    if (metaColor) return metaColor;

    const assignedTheme = getAssignedThemesForGroup(normalizedPath)
        .find(theme => normalizeThemeColor(theme && theme.color, ""));
    return assignedTheme ? getThemeColor(assignedTheme) : DEFAULT_GROUP_COLOR;
}

function createElement(tagName, className = "", parent = null) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (parent) parent.appendChild(element);
    return element;
}

function setStatus(statusNode, message, state = STATUS_IDLE) {
    if (!statusNode) return;
    statusNode.textContent = message || "";
    statusNode.dataset.state = state;
}

function redrawCurrentVisualization() {
    if (getCurrentView() === "question") {
        drawVisualization2(currentDisplayObject.currentDisplay);
        return;
    }
    drawVisualization(currentDisplayObject.currentDisplay);
}

function closePanel() {
    document.getElementById(PANEL_OVERLAY_ID)?.remove();
}

async function loadCodeGroups() {
    if (groupState.loaded) return groupState;
    if (groupState.loadingPromise) return groupState.loadingPromise;

    groupState.loadingPromise = fetch(withProjectQuery("/api/get_code_groups?includeMeta=1"), { cache: "no-store" })
        .then(async response => {
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload?.error || payload?.details || `HTTP ${response.status}`);
            }

            const groups = Array.isArray(payload) ? payload : payload.groups;
            const meta = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.meta : {};
            groupState = {
                loaded: true,
                loadingPromise: null,
                groups: normalizeGroupList(groups),
                meta: normalizeGroupMeta(groups, meta),
            };
            return groupState;
        })
        .catch(error => {
            groupState.loadingPromise = null;
            throw error;
        });

    return groupState.loadingPromise;
}

async function saveCodeGroups() {
    const response = await fetch(scopedPath("/api/save_code_groups"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withProjectPayload(buildCodeGroupsPayload())),
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error || payload?.details || `HTTP ${response.status}`);
    }
}

async function persistSelectedThemesStrict(source, options = {}) {
    const payload = buildPersistedThemePayload(source);
    const requestPayload = options.manualDeletionIntent
        ? { ...payload, manualDeletionIntent: options.manualDeletionIntent }
        : payload;
    const response = await fetch(scopedPath("/api/save_selected_themes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withProjectPayload(requestPayload)),
    });
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result?.error || result?.details || `HTTP ${response.status}`);
    }
    return persistThemePayloadLocally(payload);
}

async function loadFullSelectedThemes() {
    const response = await fetch(withProjectQuery(`/api/load_selected_themes?t=${Date.now()}`), { cache: "no-store" });
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result?.error || result?.details || `HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => ({}));
    return Array.isArray(payload && payload.themes) ? payload.themes : [];
}

async function resolveFullThemePair(sourceName, targetName) {
    const sourceFallback = findThemeByName(sourceName);
    const targetFallback = findThemeByName(targetName);
    try {
        const fullThemes = await loadFullSelectedThemes();
        const findFullTheme = (themeName) => {
            const key = getCodeLookupKey(themeName);
            return fullThemes.find(theme => getThemeKey(theme) === key) || null;
        };
        return {
            sourceTheme: findFullTheme(sourceName) || sourceFallback,
            targetTheme: findFullTheme(targetName) || targetFallback,
            usedFallback: false,
        };
    } catch (error) {
        console.warn("Could not load full selected themes for merge; using current visualization payload.", error);
        return {
            sourceTheme: sourceFallback,
            targetTheme: targetFallback,
            usedFallback: true,
        };
    }
}

function moveArrayItem(items, sourceKey, targetKey, keyResolver) {
    const sourceIndex = items.findIndex(item => keyResolver(item) === sourceKey);
    const targetIndex = items.findIndex(item => keyResolver(item) === targetKey);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;

    const [sourceItem] = items.splice(sourceIndex, 1);
    const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    items.splice(adjustedTargetIndex, 0, sourceItem);
    return true;
}

function descendantsOf(groupPath) {
    const basePath = normalizeGroupPath(groupPath);
    if (!basePath) return [];
    const prefix = `${basePath} > `;
    return groupState.groups.map(normalizeGroupPath).filter(candidate => {
        const normalizedCandidate = normalizeGroupPath(candidate);
        return normalizedCandidate === basePath || normalizedCandidate.startsWith(prefix);
    });
}

function shouldConnectGroupRows(groupPath, nextGroupPath) {
    const currentPath = normalizeGroupPath(groupPath);
    const nextPath = normalizeGroupPath(nextGroupPath);
    if (!currentPath || !nextPath) return false;
    if (nextPath.startsWith(`${currentPath} > `)) return true;
    const currentParent = groupParentPath(currentPath);
    return currentParent && groupParentPath(nextPath) === currentParent;
}

function remapThemeGroupAssignments(renameMap) {
    getThemes().forEach(theme => {
        const groups = normalizeGroupList(theme && theme.groups);
        theme.groups = normalizeGroupList(groups.map(groupPath => renameMap.get(groupPath) || groupPath));
    });
}

function applyGroupPathRenameMap(renameMap) {
    const nextMeta = {};
    Object.entries(groupState.meta || {}).forEach(([groupPath, meta]) => {
        const normalizedPath = normalizeGroupPath(groupPath);
        const nextPath = renameMap.get(normalizedPath) || normalizedPath;
        if (nextPath) {
            nextMeta[nextPath] = meta;
        }
    });
    groupState.meta = nextMeta;
    remapThemeGroupAssignments(renameMap);
}

function createDragHandle(container, label, dragData) {
    const handle = createElement("button", "color-adjustment-drag-handle", container);
    handle.type = "button";
    handle.draggable = true;
    handle.setAttribute("aria-label", label);
    handle.title = label;
    handle.textContent = "::";
    handle.addEventListener("dragstart", event => {
        activeDragData = dragData;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/json", JSON.stringify(dragData));
        event.dataTransfer.setData("text/plain", dragData.key || "");
        container.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => {
        activeDragData = null;
        container.classList.remove("dragging");
        document.querySelectorAll(".color-adjustment-row.drag-over").forEach(row => {
            row.classList.remove("drag-over");
        });
    });
    return handle;
}

function readDragData(event) {
    if (activeDragData) return activeDragData;
    const rawValue = event.dataTransfer.getData("application/json");
    if (!rawValue) return null;
    try {
        return JSON.parse(rawValue);
    } catch (_) {
        return null;
    }
}

function makeRowDropTarget(row, acceptedType, targetKey, onDrop) {
    row.addEventListener("dragover", event => {
        const dragData = readDragData(event);
        if (!dragData || dragData.type !== acceptedType || dragData.key === targetKey) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => {
        row.classList.remove("drag-over");
    });
    row.addEventListener("drop", event => {
        const dragData = readDragData(event);
        row.classList.remove("drag-over");
        if (!dragData || dragData.type !== acceptedType || dragData.key === targetKey) return;
        event.preventDefault();
        onDrop(dragData.key, targetKey);
    });
}

function reorderThemesByGroupOrder() {
    const orderedThemes = [];
    const seen = new Set();

    groupState.groups.forEach(groupPath => {
        getAssignedThemesForGroup(groupPath).forEach(theme => {
            const themeName = getThemeName(theme);
            const themeKey = themeName.toLowerCase();
            if (!themeKey || seen.has(themeKey)) return;
            seen.add(themeKey);
            orderedThemes.push(theme);
        });
    });

    getThemes().forEach(theme => {
        const themeName = getThemeName(theme);
        const themeKey = themeName.toLowerCase();
        if (!themeKey || seen.has(themeKey)) return;
        seen.add(themeKey);
        orderedThemes.push(theme);
    });

    themesObject.themes = orderedThemes;
}

async function moveSingleCode(sourceThemeName, targetThemeName, statusNode, renderAfterMove) {
    const themes = getThemes();
    const moved = moveArrayItem(
        themes,
        String(sourceThemeName || "").trim().toLowerCase(),
        String(targetThemeName || "").trim().toLowerCase(),
        theme => getThemeName(theme).toLowerCase()
    );
    if (!moved) return;

    setStatus(statusNode, "Saving code order...");
    try {
        await commitThemeOrder(getCurrentView(), { throwOnError: true });
        setStatus(statusNode, "Code moved.", STATUS_SUCCESS);
        renderAfterMove();
    } catch (error) {
        setStatus(statusNode, error.message || "Could not save code order.", STATUS_ERROR);
    }
}

function recalculateSpeechThemeColors(speech) {
    if (!speech || typeof speech !== "object") return;
    const colors = [];
    const seen = new Set();

    getThemes().forEach(theme => {
        const themeName = getThemeName(theme);
        if (!themeName) return;
        const score = Number(speech[themeName]);
        if (!Number.isFinite(score) || score <= 0) return;

        const color = getThemeColor(theme);
        const colorKey = color.toLowerCase();
        if (seen.has(colorKey)) return;
        seen.add(colorKey);
        colors.push(color);
    });

    speech._themeColors = colors;
    speech.color = colors[0] || highlight["Neutral"] || "#eeedef";
}

function updateCurrentTranscriptAssignmentsAfterMerge(sourceName, targetName, finalName) {
    const oldNames = [sourceName, targetName]
        .map(name => String(name || "").trim())
        .filter(Boolean);

    Object.values(currentDisplayObject.currentDisplay || {}).forEach(participantData => {
        const transcript = participantData && Array.isArray(participantData.transcript)
            ? participantData.transcript
            : [];
        transcript.forEach(speech => {
            if (!speech || typeof speech !== "object") return;

            const scores = oldNames
                .map(name => Number(speech[name]))
                .filter(score => Number.isFinite(score) && score > 0);
            const existingFinalScore = Number(speech[finalName]);
            if (Number.isFinite(existingFinalScore) && existingFinalScore > 0) {
                scores.push(existingFinalScore);
            }

            oldNames.forEach(name => {
                if (name !== finalName) {
                    delete speech[name];
                }
            });

            if (scores.length > 0) {
                speech[finalName] = Math.max(...scores);
            }
            recalculateSpeechThemeColors(speech);
        });
    });
}

function snapshotCurrentTranscriptRecords() {
    const snapshots = [];
    Object.values(currentDisplayObject.currentDisplay || {}).forEach(participantData => {
        const transcript = participantData && Array.isArray(participantData.transcript)
            ? participantData.transcript
            : [];
        transcript.forEach(speech => {
            if (!speech || typeof speech !== "object") return;
            snapshots.push({ speech, snapshot: clonePlainObject(speech) });
        });
    });
    return snapshots;
}

function restoreCurrentTranscriptRecords(snapshots) {
    (Array.isArray(snapshots) ? snapshots : []).forEach(({ speech, snapshot }) => {
        if (!speech || typeof speech !== "object") return;
        Object.keys(speech).forEach(key => {
            delete speech[key];
        });
        Object.assign(speech, clonePlainObject(snapshot));
    });
}

function buildMergedThemeRecord(sourceTheme, targetTheme, finalName, preferredTheme) {
    const primaryTheme = preferredTheme || sourceTheme;
    const secondaryTheme = primaryTheme === sourceTheme ? targetTheme : sourceTheme;
    const mergedTheme = clonePlainObject(primaryTheme);

    mergedTheme.themeName = finalName;
    mergedTheme.color = getThemeColor(primaryTheme);
    mergedTheme.words = dedupeThemeWordEntries([
        ...(Array.isArray(sourceTheme && sourceTheme.words) ? sourceTheme.words : []),
        ...(Array.isArray(targetTheme && targetTheme.words) ? targetTheme.words : []),
    ]);
    mergedTheme.groups = normalizeGroupList([
        ...(Array.isArray(sourceTheme && sourceTheme.groups) ? sourceTheme.groups : []),
        ...(Array.isArray(targetTheme && targetTheme.groups) ? targetTheme.groups : []),
    ]);
    mergedTheme.highlight = mergeUniqueArrayValues(sourceTheme && sourceTheme.highlight, targetTheme && targetTheme.highlight);

    if (!String(mergedTheme.summary || "").trim() && String(secondaryTheme && secondaryTheme.summary || "").trim()) {
        mergedTheme.summary = String(secondaryTheme.summary || "").trim();
    }
    if (!String(mergedTheme.comment || "").trim() && String(secondaryTheme && secondaryTheme.comment || "").trim()) {
        mergedTheme.comment = String(secondaryTheme.comment || "");
    }

    return mergedTheme;
}

function getMergedQuoteCount(sourceTheme, targetTheme) {
    return dedupeThemeWordEntries([
        ...(Array.isArray(sourceTheme && sourceTheme.words) ? sourceTheme.words : []),
        ...(Array.isArray(targetTheme && targetTheme.words) ? targetTheme.words : []),
    ]).length;
}

function formatThemeButtonLabel(rawThemeName, maxChars = 32) {
    const normalized = formatCodeDisplayName(rawThemeName);
    if (normalized.length <= maxChars) return normalized;
    const words = normalized.split(/\s+/);
    const keptWords = [];
    let currentLength = 0;
    for (const word of words) {
        const nextLength = currentLength + word.length + (keptWords.length ? 1 : 0);
        if (nextLength > maxChars - 1) break;
        keptWords.push(word);
        currentLength = nextLength;
    }
    return `${keptWords.join(" ") || normalized.slice(0, maxChars - 1)}...`;
}

function getLegendNodeThemeName(node) {
    if (!node || node.id === "neutral") return "";
    return String((node.dataset && node.dataset.theme) || node.textContent || "").trim();
}

function syncMergedThemeLegend(mergedTheme, oldThemeNames) {
    if (typeof d3 === "undefined") return;
    const legend = d3.select("#theme-legend");
    if (legend.empty()) return;

    const finalName = getThemeName(mergedTheme);
    const finalKey = getCodeLookupKey(finalName);
    if (!finalKey) return;

    const oldKeys = new Set((oldThemeNames || []).map(getCodeLookupKey).filter(Boolean));
    const nodes = legend.selectAll(".theme-labels").nodes().filter(node => node && node.id !== "neutral");
    let replacementNode = nodes.find(node => getCodeLookupKey(getLegendNodeThemeName(node)) === finalKey);
    if (!replacementNode) {
        replacementNode = nodes.find(node => oldKeys.has(getCodeLookupKey(getLegendNodeThemeName(node))));
    }
    if (!replacementNode) {
        replacementNode = legend.append("button").node();
    }

    nodes.forEach(node => {
        if (node === replacementNode) return;
        if (oldKeys.has(getCodeLookupKey(getLegendNodeThemeName(node)))) {
            node.remove();
        }
    });

    const safeId = `theme-btn-${finalName.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
    const themeColor = getThemeColor(mergedTheme);
    const button = d3.select(replacementNode);
    button.selectAll(".theme-color-control").remove();
    button
        .attr("id", safeId)
        .attr("class", "theme-labels")
        .attr("data-theme", finalName)
        .attr("title", finalName)
        .style("border", `2px solid ${themeColor}`)
        .style("color", themeColor)
        .style("cursor", "pointer")
        .on("click", function() {
            selectTheme(this, getCurrentView());
        })
        .text(formatThemeButtonLabel(finalName, 32));
    appendThemeColorDot(button, mergedTheme, getCurrentView());
}

function updateThemeSelectionAfterMerge(sourceName, targetName, finalName) {
    const mergedSourceKeys = new Set([sourceName, targetName].map(getCodeLookupKey).filter(Boolean));
    const currentSelection = Array.isArray(themeObject.theme)
        ? themeObject.theme
        : (themeObject.theme ? [themeObject.theme] : []);
    const finalSelectionKey = String(finalName || "").trim().toLowerCase();
    let shouldSelectMergedTheme = false;
    const nextSelection = [];
    const seen = new Set();

    currentSelection.forEach(themeKey => {
        const rawKey = String(themeKey || "").trim();
        if (!rawKey) return;
        if (mergedSourceKeys.has(getCodeLookupKey(rawKey))) {
            shouldSelectMergedTheme = true;
            return;
        }
        const normalizedRawKey = rawKey.toLowerCase();
        if (seen.has(normalizedRawKey)) return;
        seen.add(normalizedRawKey);
        nextSelection.push(normalizedRawKey);
    });

    if (shouldSelectMergedTheme && finalSelectionKey && !seen.has(finalSelectionKey)) {
        nextSelection.push(finalSelectionKey);
    }

    themeObject.theme = nextSelection;
    themeSelectedObject.themeSelected = nextSelection.length > 0;
    persistThemeSelection(nextSelection);
}

async function mergeTwoCodes(sourceThemeName, targetThemeName, finalThemeName, nameChoice, statusNode, renderAfterMerge, dialogErrorNode = null) {
    const currentSourceTheme = findThemeByName(sourceThemeName);
    const currentTargetTheme = findThemeByName(targetThemeName);
    const finalName = String(finalThemeName || "").replace(/\s+/g, " ").trim();
    if (!currentSourceTheme || !currentTargetTheme || !finalName) return false;

    const sourceName = getThemeName(currentSourceTheme);
    const targetName = getThemeName(currentTargetTheme);
    const finalKey = getCodeLookupKey(finalName);
    const duplicateTheme = getThemes().find(theme => {
        const themeKey = getCodeLookupKey(getThemeName(theme));
        if (!themeKey || themeKey !== finalKey) return false;
        return theme !== currentSourceTheme && theme !== currentTargetTheme;
    });
    if (duplicateTheme) {
        setStatus(statusNode, `A code named ${finalName} already exists.`, STATUS_ERROR);
        return false;
    }

    const themes = getThemes();
    const sourceIndex = themes.indexOf(currentSourceTheme);
    const targetIndex = themes.indexOf(currentTargetTheme);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;

    const { sourceTheme, targetTheme } = await resolveFullThemePair(sourceName, targetName);
    if (!sourceTheme || !targetTheme) {
        setStatus(statusNode, "Could not load both source codes for merge.", STATUS_ERROR);
        return false;
    }

    const preferredTheme = nameChoice === "target" ? targetTheme : sourceTheme;
    const mergedTheme = buildMergedThemeRecord(sourceTheme, targetTheme, finalName, preferredTheme);
    const insertIndex = Math.min(sourceIndex, targetIndex);
    const removedIndexes = new Set([sourceIndex, targetIndex]);
    const nextThemes = [];
    themes.forEach((theme, index) => {
        if (index === insertIndex) {
            nextThemes.push(mergedTheme);
        }
        if (!removedIndexes.has(index)) {
            nextThemes.push(theme);
        }
    });

    const previousThemes = themes.slice();
    const previousSelection = Array.isArray(themeObject.theme) ? themeObject.theme.slice() : themeObject.theme;
    const previousTranscriptRecords = snapshotCurrentTranscriptRecords();
    themesObject.themes = nextThemes;
    updateThemeSelectionAfterMerge(sourceName, targetName, finalName);
    updateCurrentTranscriptAssignmentsAfterMerge(sourceName, targetName, finalName);

    const absorbedThemeNames = [sourceName, targetName].filter(name => getCodeLookupKey(name) !== finalKey);
    setStatus(statusNode, "Saving merged code...");
    try {
        await persistSelectedThemesStrict(
            { themes: themesObject.themes },
            { manualDeletionIntent: { themeNames: absorbedThemeNames } }
        );
        syncMergedThemeLegend(mergedTheme, [sourceName, targetName]);
        syncThemeSelectionStyles();
        redrawCurrentVisualization();
        setStatus(
            statusNode,
            `Merged ${formatCodeDisplayName(sourceName)} and ${formatCodeDisplayName(targetName)} as ${formatCodeDisplayName(finalName)}.`,
            STATUS_SUCCESS
        );
        renderAfterMerge();
        return true;
    } catch (error) {
        themesObject.themes = previousThemes;
        restoreCurrentTranscriptRecords(previousTranscriptRecords);
        themeObject.theme = previousSelection;
        themeSelectedObject.themeSelected = Array.isArray(previousSelection)
            ? previousSelection.length > 0
            : Boolean(previousSelection);
        syncThemeSelectionStyles();
        const errorMessage = error.message || "Could not save merged code.";
        setStatus(statusNode, errorMessage, STATUS_ERROR);
        if (dialogErrorNode) {
            dialogErrorNode.textContent = errorMessage;
        }
        renderAfterMerge();
        return false;
    }
}

async function nestCodeGroup(sourceGroupPath, targetGroupPath, statusNode, renderAfterMove) {
    const sourcePath = normalizeGroupPath(sourceGroupPath);
    const targetPath = normalizeGroupPath(targetGroupPath);
    if (!sourcePath || !targetPath || sourcePath === targetPath) return;
    if (targetPath.startsWith(`${sourcePath} > `)) {
        setStatus(statusNode, "Cannot move a group inside its own child group.", STATUS_ERROR);
        return;
    }

    const sourceSubtree = descendantsOf(sourcePath);
    if (sourceSubtree.length === 0) return;

    const sourceLabel = groupLabel(sourcePath);
    const nextSourcePath = normalizeGroupPath(`${targetPath} > ${sourceLabel}`);
    const renameMap = new Map();
    sourceSubtree.forEach(path => {
        const suffix = path === sourcePath ? "" : path.slice(sourcePath.length);
        renameMap.set(path, normalizeGroupPath(`${nextSourcePath}${suffix}`));
    });

    const movedSubtree = sourceSubtree.map(path => renameMap.get(path));
    const existingOutsideSubtree = new Set(
        groupState.groups
            .map(normalizeGroupPath)
            .filter(path => path && !sourceSubtree.includes(path))
    );
    const collidingPath = movedSubtree.find(path => existingOutsideSubtree.has(path));
    if (collidingPath) {
        setStatus(statusNode, `A group already exists at ${collidingPath}.`, STATUS_ERROR);
        return;
    }

    const previousGroups = groupState.groups.slice();
    const previousMeta = structuredClone(groupState.meta || {});
    const previousThemes = getThemes().slice();
    const previousThemeGroups = new Map(previousThemes.map(theme => [
        theme,
        normalizeGroupList(theme && theme.groups),
    ]));

    const sourceSet = new Set(sourceSubtree);
    const remainingGroups = groupState.groups
        .map(normalizeGroupPath)
        .filter(path => path && !sourceSet.has(path));
    let insertIndex = remainingGroups.findIndex(path => path === targetPath);
    if (insertIndex >= 0) {
        const targetPrefix = `${targetPath} > `;
        remainingGroups.forEach((path, index) => {
            if (path === targetPath || path.startsWith(targetPrefix)) {
                insertIndex = Math.max(insertIndex, index);
            }
        });
    }

    if (insertIndex < 0) {
        remainingGroups.push(...movedSubtree);
    } else {
        remainingGroups.splice(insertIndex + 1, 0, ...movedSubtree);
    }
    groupState.groups = normalizeGroupList(remainingGroups);
    applyGroupPathRenameMap(renameMap);
    reorderThemesByGroupOrder();

    const movedCodeNames = new Set();
    movedSubtree.forEach(groupPath => {
        getAssignedThemesForGroup(groupPath).forEach(theme => {
            const themeName = getThemeName(theme);
            if (themeName) {
                movedCodeNames.add(themeName.toLowerCase());
            }
        });
    });

    setStatus(statusNode, "Saving nested code group...");
    try {
        await saveCodeGroups();
        await commitThemeOrder(getCurrentView(), { throwOnError: true });
        setStatus(
            statusNode,
            `Nested ${sourceLabel} under ${groupLabel(targetPath)} with ${movedCodeNames.size} related code${movedCodeNames.size === 1 ? "" : "s"}.`,
            STATUS_SUCCESS
        );
        renderAfterMove();
    } catch (error) {
        groupState.groups = previousGroups;
        groupState.meta = previousMeta;
        themesObject.themes = previousThemes;
        previousThemes.forEach(theme => {
            if (previousThemeGroups.has(theme)) {
                theme.groups = previousThemeGroups.get(theme);
            }
        });
        try {
            await saveCodeGroups();
        } catch (rollbackError) {
            console.warn("Failed to roll back nested code group metadata:", rollbackError);
        }
        setStatus(statusNode, error.message || "Could not save nested code group.", STATUS_ERROR);
        renderAfterMove();
    }
}

function renderGroupPills(container, groups) {
    const normalizedGroups = normalizeGroupList(groups);
    if (normalizedGroups.length === 0) {
        const empty = createElement("span", "color-adjustment-muted", container);
        empty.textContent = "Ungrouped";
        return;
    }

    normalizedGroups.forEach(groupPath => {
        const pill = createElement("span", "color-adjustment-pill", container);
        pill.textContent = groupPath;
        pill.title = groupPath;
    });
}

function renderColorInput(container, options) {
    const normalizedColor = normalizeThemeColor(options.color, DEFAULT_GROUP_COLOR);
    const wrapper = createElement("div", "color-adjustment-color-field", container);
    const swatch = createElement("span", "color-adjustment-swatch", wrapper);
    swatch.style.backgroundColor = normalizedColor;
    const input = createElement("input", "color-adjustment-color-input", wrapper);
    input.type = "color";
    input.value = normalizedColor.toLowerCase();
    input.dataset.committedColor = normalizedColor;
    input.setAttribute("aria-label", options.label || "Change color");

    input.addEventListener("input", () => {
        const nextColor = normalizeThemeColor(input.value, input.dataset.committedColor);
        swatch.style.backgroundColor = nextColor;
    });
    input.addEventListener("change", async () => {
        const previousColor = input.dataset.committedColor || normalizedColor;
        const nextColor = normalizeThemeColor(input.value, previousColor);
        input.disabled = true;
        try {
            await options.onCommit(nextColor, previousColor);
            input.dataset.committedColor = nextColor;
            input.value = nextColor.toLowerCase();
            swatch.style.backgroundColor = nextColor;
        } catch (error) {
            input.value = normalizeThemeColor(previousColor, normalizedColor).toLowerCase();
            swatch.style.backgroundColor = previousColor;
        } finally {
            input.disabled = false;
        }
    });

    return input;
}

async function commitSingleCodeColor(theme, nextColor, previousColor, statusNode) {
    const themeName = getThemeName(theme);
    if (!themeName) return;
    setStatus(statusNode, "Saving code color...");
    const updates = await commitThemeColorUpdates([{
        themeName,
        color: nextColor,
        previousColor,
    }], getCurrentView(), { throwOnError: true });

    setStatus(
        statusNode,
        updates.length ? "Code color saved." : "No color change.",
        STATUS_SUCCESS
    );
}

function pruneSelectedCodeKeys() {
    const availableKeys = new Set(getThemes().map(getThemeKey).filter(Boolean));
    selectedCodeKeys = new Set([...selectedCodeKeys].filter(key => availableKeys.has(key)));
}

function getSelectedCodeThemes() {
    pruneSelectedCodeKeys();
    return getThemes().filter(theme => selectedCodeKeys.has(getThemeKey(theme)));
}

async function applyColorToSelectedCodes(nextColor, statusNode, renderAfterSave) {
    const selectedThemes = getSelectedCodeThemes();
    if (selectedThemes.length === 0) return;

    const updates = selectedThemes.map(theme => ({
        themeName: getThemeName(theme),
        color: nextColor,
        previousColor: getThemeColor(theme),
    }));

    setStatus(statusNode, `Applying color to ${selectedThemes.length} code${selectedThemes.length === 1 ? "" : "s"}...`);
    try {
        const changed = await commitThemeColorUpdates(updates, getCurrentView(), { throwOnError: true });
        setStatus(
            statusNode,
            changed.length
                ? `Applied color to ${changed.length} selected code${changed.length === 1 ? "" : "s"}.`
                : "Selected codes already use this color.",
            STATUS_SUCCESS
        );
        renderAfterSave();
    } catch (error) {
        setStatus(statusNode, error.message || "Could not apply selected code color.", STATUS_ERROR);
        renderAfterSave();
    }
}

async function assignSelectedCodesToGroup(groupPath, statusNode, renderAfterSave) {
    const normalizedGroupPath = normalizeGroupPath(groupPath);
    const selectedThemes = getSelectedCodeThemes();
    if (!normalizedGroupPath || selectedThemes.length === 0) return;

    const previousGroups = new Map(selectedThemes.map(theme => [
        theme,
        normalizeGroupList(theme && theme.groups),
    ]));

    selectedThemes.forEach(theme => {
        theme.groups = normalizeGroupList([
            ...(Array.isArray(theme && theme.groups) ? theme.groups : []),
            normalizedGroupPath,
        ]);
    });

    setStatus(statusNode, `Assigning ${selectedThemes.length} code${selectedThemes.length === 1 ? "" : "s"} to ${normalizedGroupPath}...`);
    try {
        await persistSelectedThemesStrict({ themes: themesObject.themes });
        setStatus(
            statusNode,
            `Assigned ${selectedThemes.length} selected code${selectedThemes.length === 1 ? "" : "s"} to ${normalizedGroupPath}.`,
            STATUS_SUCCESS
        );
        renderAfterSave();
    } catch (error) {
        previousGroups.forEach((groups, theme) => {
            theme.groups = groups;
        });
        setStatus(statusNode, error.message || "Could not assign selected codes to group.", STATUS_ERROR);
        renderAfterSave();
    }
}

function populateGroupSelect(selectNode, assignButton) {
    if (!selectNode) return;
    selectNode.innerHTML = "";
    const groups = normalizeGroupList(groupState.groups);
    if (groups.length === 0) {
        const option = createElement("option", "", selectNode);
        option.value = "";
        option.textContent = "No groups available";
        selectNode.disabled = true;
        if (assignButton) assignButton.disabled = true;
        return;
    }

    const placeholder = createElement("option", "", selectNode);
    placeholder.value = "";
    placeholder.textContent = "Choose a group...";
    placeholder.selected = true;

    groups.forEach(groupPath => {
        const option = createElement("option", "", selectNode);
        option.value = groupPath;
        option.textContent = groupPath;
    });
    selectNode.disabled = false;
    if (assignButton) assignButton.disabled = true;
}

function renderSelectedCodeActions(container, statusNode, renderAfterSave) {
    const selectedThemes = getSelectedCodeThemes();
    if (selectedThemes.length === 0) return;

    const actionBar = createElement("div", "color-adjustment-selection-bar", container);
    actionBar.setAttribute("role", "region");
    actionBar.setAttribute("aria-label", "Selected code actions");

    const summary = createElement("div", "color-adjustment-selection-summary", actionBar);
    summary.textContent = `${selectedThemes.length} selected`;
    summary.setAttribute("aria-live", "polite");

    const colorLabel = createElement("label", "color-adjustment-inline-label", actionBar);
    colorLabel.textContent = "Color";
    const colorInput = createElement("input", "color-adjustment-batch-color-input", colorLabel);
    colorInput.type = "color";
    colorInput.value = getThemeColor(selectedThemes[0] || getThemes()[0] || {}).toLowerCase();

    const colorButton = createElement("button", "color-adjustment-secondary-button", actionBar);
    colorButton.type = "button";
    colorButton.textContent = "Apply color";
    colorButton.addEventListener("click", async () => {
        if (colorButton.disabled) return;
        actionBar.setAttribute("aria-busy", "true");
        actionBar.querySelectorAll("input, select, button").forEach(control => {
            control.disabled = true;
        });
        await applyColorToSelectedCodes(colorInput.value, statusNode, renderAfterSave);
    });

    const groupLabel = createElement("label", "color-adjustment-inline-label color-adjustment-group-select-label", actionBar);
    groupLabel.textContent = "Group";
    const groupSelect = createElement("select", "color-adjustment-select color-adjustment-group-select", groupLabel);
    const loadingOption = createElement("option", "", groupSelect);
    loadingOption.value = "";
    loadingOption.textContent = "Loading groups...";
    groupSelect.disabled = true;

    const assignButton = createElement("button", "color-adjustment-secondary-button", actionBar);
    assignButton.type = "button";
    assignButton.textContent = "Assign to group";
    assignButton.disabled = true;
    assignButton.addEventListener("click", async () => {
        if (assignButton.disabled || !groupSelect.value) return;
        actionBar.setAttribute("aria-busy", "true");
        actionBar.querySelectorAll("input, select, button").forEach(control => {
            control.disabled = true;
        });
        await assignSelectedCodesToGroup(groupSelect.value, statusNode, renderAfterSave);
    });
    groupSelect.addEventListener("change", () => {
        assignButton.disabled = !groupSelect.value;
    });

    const clearButton = createElement("button", "color-adjustment-link-button", actionBar);
    clearButton.type = "button";
    clearButton.textContent = "Clear";
    clearButton.addEventListener("click", () => {
        selectedCodeKeys.clear();
        renderAfterSave();
    });

    loadCodeGroups()
        .then(() => populateGroupSelect(groupSelect, assignButton))
        .catch(error => {
            groupSelect.innerHTML = "";
            const option = createElement("option", "", groupSelect);
            option.value = "";
            option.textContent = "Could not load groups";
            groupSelect.disabled = true;
            assignButton.disabled = true;
            console.warn("Failed to load groups for code assignment:", error);
        });
}

function closeMergeDialog(dialogOverlay) {
    dialogOverlay?.remove();
}

function openMergeDialog(sourceThemeName, statusNode, renderAfterMerge) {
    const sourceTheme = findThemeByName(sourceThemeName);
    const sourceName = getThemeName(sourceTheme);
    const candidates = getThemes().filter(theme => getCodeLookupKey(getThemeName(theme)) !== getCodeLookupKey(sourceName));
    if (!sourceTheme || candidates.length === 0) {
        setStatus(statusNode, "At least two codes are required to merge.", STATUS_ERROR);
        return;
    }

    const dialogOverlay = createElement("div", "color-adjustment-merge-overlay", document.body);
    dialogOverlay.addEventListener("mousedown", () => closeMergeDialog(dialogOverlay));

    const dialog = createElement("div", "color-adjustment-merge-modal", dialogOverlay);
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "color-adjustment-merge-title");
    dialog.addEventListener("mousedown", event => event.stopPropagation());

    const title = createElement("h3", "color-adjustment-merge-title", dialog);
    title.id = "color-adjustment-merge-title";
    title.textContent = "Merge Codes";

    const sourceSummary = createElement("div", "color-adjustment-merge-source", dialog);
    sourceSummary.textContent = `Code 1: ${formatCodeDisplayName(sourceName)}`;

    const targetLabel = createElement("label", "color-adjustment-field-label", dialog);
    targetLabel.textContent = "Code 2";
    const targetSelect = createElement("select", "color-adjustment-select", targetLabel);
    candidates.forEach(theme => {
        const option = createElement("option", "", targetSelect);
        option.value = getThemeName(theme);
        option.textContent = formatCodeDisplayName(getThemeName(theme));
    });

    const choiceGroup = createElement("div", "color-adjustment-name-choice-group", dialog);
    const choiceTitle = createElement("div", "color-adjustment-field-label", choiceGroup);
    choiceTitle.textContent = "Merged code name";

    const choices = [
        { value: "source", label: `Keep code 1 name: ${formatCodeDisplayName(sourceName)}` },
        { value: "target", label: "" },
        { value: "custom", label: "Use a new name" },
    ];

    const radioInputs = new Map();
    choices.forEach((choice, index) => {
        const label = createElement("label", "color-adjustment-radio-card", choiceGroup);
        const input = createElement("input", "", label);
        input.type = "radio";
        input.name = "color-adjustment-merge-name-choice";
        input.value = choice.value;
        input.checked = index === 0;
        radioInputs.set(choice.value, input);
        const text = createElement("span", "", label);
        text.textContent = choice.label || "Keep code 2 name";
        if (choice.value === "target") {
            text.dataset.targetChoiceLabel = "true";
        }
    });

    const customNameInput = createElement("input", "color-adjustment-text-input", dialog);
    customNameInput.type = "text";
    customNameInput.placeholder = "New merged code name";
    customNameInput.disabled = true;

    const previewNode = createElement("div", "color-adjustment-merge-preview", dialog);
    previewNode.setAttribute("aria-live", "polite");
    const previewSummary = createElement("div", "color-adjustment-merge-preview-summary", previewNode);
    const previewNote = createElement("div", "color-adjustment-merge-preview-note", previewNode);
    previewNote.textContent = "Duplicate quotations shared by both codes are counted once.";

    const errorNode = createElement("div", "color-adjustment-dialog-error", dialog);
    errorNode.setAttribute("aria-live", "polite");

    const actions = createElement("div", "color-adjustment-dialog-actions", dialog);
    const cancelButton = createElement("button", "color-adjustment-secondary-button", actions);
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => closeMergeDialog(dialogOverlay));

    const mergeButton = createElement("button", "color-adjustment-primary-button", actions);
    mergeButton.type = "button";
    mergeButton.textContent = "Merge";

    const getSelectedChoice = () => {
        const checked = [...radioInputs.values()].find(input => input.checked);
        return checked ? checked.value : "source";
    };

    const updateTargetChoiceLabel = () => {
        const targetTheme = findThemeByName(targetSelect.value);
        const targetName = getThemeName(targetTheme);
        const targetChoiceText = choiceGroup.querySelector("[data-target-choice-label='true']");
        if (targetChoiceText) {
            targetChoiceText.textContent = `Keep code 2 name: ${formatCodeDisplayName(targetName)}`;
        }
    };

    let previewRequestId = 0;
    const updateMergePreview = async () => {
        const requestId = previewRequestId + 1;
        previewRequestId = requestId;
        const targetName = String(targetSelect.value || "").trim();
        const fallbackTarget = findThemeByName(targetName);
        if (!targetName || !fallbackTarget) {
            previewSummary.textContent = "Choose a second code to see the merged quote count.";
            previewNote.hidden = true;
            return;
        }

        previewSummary.textContent = "Calculating merged quote count...";
        previewNote.hidden = true;
        const {
            sourceTheme: fullSourceTheme,
            targetTheme: fullTargetTheme,
            usedFallback,
        } = await resolveFullThemePair(sourceName, targetName);
        if (requestId !== previewRequestId) return;

        const sourceCount = getQuoteCount(fullSourceTheme || sourceTheme);
        const targetCount = getQuoteCount(fullTargetTheme || fallbackTarget);
        const mergedCount = getMergedQuoteCount(fullSourceTheme || sourceTheme, fullTargetTheme || fallbackTarget);
        previewSummary.textContent = `${formatCodeDisplayName(sourceName)}: ${formatQuoteCount(sourceCount)} + ${formatCodeDisplayName(targetName)}: ${formatQuoteCount(targetCount)} = ${mergedCount} unique merged quote${mergedCount === 1 ? "" : "s"}.`;
        previewNote.hidden = false;
        previewNote.textContent = usedFallback
            ? "Preview uses the quotations currently loaded in this visualization; duplicates are counted once."
            : "Duplicate quotations shared by both codes are counted once.";
    };

    const updateCustomInputState = () => {
        const useCustomName = getSelectedChoice() === "custom";
        customNameInput.disabled = !useCustomName;
        if (useCustomName) {
            customNameInput.focus();
        }
    };

    radioInputs.forEach(input => {
        input.addEventListener("change", updateCustomInputState);
    });
    targetSelect.addEventListener("change", () => {
        updateTargetChoiceLabel();
        errorNode.textContent = "";
        void updateMergePreview();
    });
    customNameInput.addEventListener("input", () => {
        errorNode.textContent = "";
    });
    updateTargetChoiceLabel();
    void updateMergePreview();

    mergeButton.addEventListener("click", async () => {
        const targetName = String(targetSelect.value || "").trim();
        const nameChoice = getSelectedChoice();
        const finalName = nameChoice === "source"
            ? sourceName
            : nameChoice === "target"
                ? targetName
                : String(customNameInput.value || "").replace(/\s+/g, " ").trim();

        if (!targetName) {
            errorNode.textContent = "Choose a second code to merge.";
            return;
        }
        if (!finalName) {
            errorNode.textContent = "Enter a name for the merged code.";
            customNameInput.focus();
            return;
        }

        const finalKey = getCodeLookupKey(finalName);
        const duplicateTheme = getThemes().find(theme => {
            const themeKey = getCodeLookupKey(getThemeName(theme));
            if (!themeKey || themeKey !== finalKey) return false;
            return theme !== sourceTheme && getCodeLookupKey(getThemeName(theme)) !== getCodeLookupKey(targetName);
        });
        if (duplicateTheme) {
            errorNode.textContent = `A code named ${finalName} already exists.`;
            return;
        }

        mergeButton.disabled = true;
        mergeButton.textContent = "Merging...";
        cancelButton.disabled = true;
        targetSelect.disabled = true;
        customNameInput.disabled = true;
        radioInputs.forEach(input => {
            input.disabled = true;
        });
        errorNode.textContent = "";
        const merged = await mergeTwoCodes(
            sourceName,
            targetName,
            finalName,
            nameChoice,
            statusNode,
            renderAfterMerge,
            errorNode
        );
        if (merged) {
            closeMergeDialog(dialogOverlay);
            return;
        }
        mergeButton.disabled = false;
        mergeButton.textContent = "Merge";
        cancelButton.disabled = false;
        targetSelect.disabled = false;
        radioInputs.forEach(input => {
            input.disabled = false;
        });
        updateCustomInputState();
    });
}

function renderCodesMode(body, statusNode) {
    body.innerHTML = "";
    const themes = getThemes();
    pruneSelectedCodeKeys();
    if (themes.length === 0) {
        const empty = createElement("div", "color-adjustment-empty", body);
        empty.textContent = "No codes are available for this visualization.";
        return;
    }

    renderSelectedCodeActions(body, statusNode, () => renderCodesMode(body, statusNode));

    const list = createElement("div", "color-adjustment-list", body);
    themes.forEach(theme => {
        const themeName = getThemeName(theme);
        if (!themeName) return;

        const row = createElement("div", "color-adjustment-row color-adjustment-code-row", list);
        row.dataset.theme = themeName;
        row.classList.toggle("is-selected", selectedCodeKeys.has(getThemeKey(theme)));

        const selectionLabel = createElement("label", "color-adjustment-code-select", row);
        const selectionInput = createElement("input", "", selectionLabel);
        selectionInput.type = "checkbox";
        selectionInput.checked = selectedCodeKeys.has(getThemeKey(theme));
        selectionInput.setAttribute("aria-label", `Select ${themeName}`);
        selectionInput.addEventListener("change", () => {
            const key = getThemeKey(theme);
            if (selectionInput.checked) {
                selectedCodeKeys.add(key);
            } else {
                selectedCodeKeys.delete(key);
            }
            renderCodesMode(body, statusNode);
        });

        createDragHandle(row, `Move ${themeName}`, {
            type: "code",
            key: themeName.toLowerCase(),
        });
        makeRowDropTarget(row, "code", themeName.toLowerCase(), (sourceKey, targetKey) => {
            void moveSingleCode(sourceKey, targetKey, statusNode, () => renderCodesMode(body, statusNode));
        });

        renderColorInput(row, {
            color: getThemeColor(theme),
            label: `Change color for ${themeName}`,
            onCommit: async (nextColor, previousColor) => {
                try {
                    await commitSingleCodeColor(theme, nextColor, previousColor, statusNode);
                } catch (error) {
                    setStatus(statusNode, error.message || "Could not save code color.", STATUS_ERROR);
                    throw error;
                }
            },
        });

        const main = createElement("div", "color-adjustment-row-main", row);
        const title = createElement("div", "color-adjustment-row-title", main);
        title.textContent = themeName.replaceAll("_", " ");

        const groups = createElement("div", "color-adjustment-pill-row", main);
        renderGroupPills(groups, theme.groups);

        const meta = createElement("div", "color-adjustment-row-meta", row);
        const quoteCount = getQuoteCount(theme);
        meta.textContent = `${quoteCount} quote${quoteCount === 1 ? "" : "s"}`;

        const mergeButton = createElement("button", "color-adjustment-merge-button", row);
        mergeButton.type = "button";
        mergeButton.textContent = "Merge";
        mergeButton.disabled = themes.length < 2;
        mergeButton.addEventListener("click", () => {
            openMergeDialog(themeName, statusNode, () => renderCodesMode(body, statusNode));
        });
    });
}

function renderGroupRows(body, statusNode) {
    body.innerHTML = "";
    if (groupState.groups.length === 0) {
        const empty = createElement("div", "color-adjustment-empty", body);
        empty.textContent = "No code groups yet. Manage groups in Code Manager.";
        return;
    }

    const list = createElement("div", "color-adjustment-list", body);
    groupState.groups.forEach((groupPath, index) => {
        const normalizedPath = normalizeGroupPath(groupPath);
        const nextPath = normalizeGroupPath(groupState.groups[index + 1]);
        const assignedThemes = getAssignedThemesForGroup(normalizedPath);
        const assignedCount = assignedThemes.length;
        const color = resolveGroupColor(normalizedPath);

        const row = createElement("div", "color-adjustment-row color-adjustment-group-row", list);
        row.style.setProperty("--group-depth", String(groupDepth(normalizedPath)));
        row.classList.toggle("is-child-group", groupDepth(normalizedPath) > 0);
        row.classList.toggle("connects-next-group", shouldConnectGroupRows(normalizedPath, nextPath));
        createDragHandle(row, `Move ${normalizedPath} and its related codes`, {
            type: "group",
            key: normalizedPath,
        });
        makeRowDropTarget(row, "group", normalizedPath, (sourceKey, targetKey) => {
            void nestCodeGroup(sourceKey, targetKey, statusNode, () => renderGroupRows(body, statusNode));
        });

        renderColorInput(row, {
            color,
            label: `Change color for ${normalizedPath}`,
            onCommit: async (nextColor, previousColor) => {
                setStatus(statusNode, "Saving group color...");
                try {
                    groupState.meta[normalizedPath] = {
                        ...(groupState.meta[normalizedPath] || {}),
                        color: nextColor,
                    };
                    await saveCodeGroups();
                    setStatus(statusNode, "Group color saved.", STATUS_SUCCESS);
                } catch (error) {
                    groupState.meta[normalizedPath] = {
                        ...(groupState.meta[normalizedPath] || {}),
                        color: previousColor,
                    };
                    setStatus(statusNode, error.message || "Could not save group color.", STATUS_ERROR);
                    throw error;
                }
            },
        });

        const main = createElement("div", "color-adjustment-row-main", row);
        main.classList.toggle("is-child-group-main", groupDepth(normalizedPath) > 0);
        main.style.paddingLeft = `${groupDepth(normalizedPath) * 16}px`;
        const title = createElement("div", "color-adjustment-row-title", main);
        title.textContent = groupLabel(normalizedPath);
        title.title = normalizedPath;

        const path = createElement("div", "color-adjustment-row-subtitle", main);
        path.textContent = normalizedPath;

        const codePills = createElement("div", "color-adjustment-pill-row", main);
        if (assignedThemes.length === 0) {
            const empty = createElement("span", "color-adjustment-muted", codePills);
            empty.textContent = "No assigned codes";
        } else {
            assignedThemes.forEach(theme => {
                const pill = createElement("span", "color-adjustment-pill", codePills);
                pill.textContent = getThemeName(theme).replaceAll("_", " ");
                pill.title = getThemeName(theme);
            });
        }

        const meta = createElement("div", "color-adjustment-row-meta", row);
        meta.textContent = `${assignedCount} code${assignedCount === 1 ? "" : "s"}`;

        const applyButton = createElement("button", "color-adjustment-apply-button", row);
        applyButton.type = "button";
        applyButton.textContent = "Apply";
        applyButton.disabled = assignedCount === 0;
        applyButton.style.backgroundColor = color;
        applyButton.style.color = getContrastingTextColor(color);
        applyButton.addEventListener("click", async () => {
            if (applyButton.disabled) return;

            const groupColor = resolveGroupColor(normalizedPath);
            const updates = assignedThemes.map(theme => ({
                themeName: getThemeName(theme),
                color: groupColor,
                previousColor: getThemeColor(theme),
            }));

            applyButton.disabled = true;
            setStatus(statusNode, "Applying group color...");
            try {
                groupState.meta[normalizedPath] = {
                    ...(groupState.meta[normalizedPath] || {}),
                    color: groupColor,
                };
                await saveCodeGroups();
                const changed = await commitThemeColorUpdates(updates, getCurrentView(), { throwOnError: true });
                syncThemeSelectionStyles();
                setStatus(
                    statusNode,
                    changed.length
                        ? `Applied color to ${changed.length} code${changed.length === 1 ? "" : "s"}.`
                        : "Assigned codes already use this color.",
                    STATUS_SUCCESS
                );
                renderGroupRows(body, statusNode);
            } catch (error) {
                setStatus(statusNode, error.message || "Could not apply group color.", STATUS_ERROR);
            } finally {
                applyButton.disabled = assignedCount === 0;
            }
        });
    });
}

async function renderGroupsMode(body, statusNode) {
    body.innerHTML = "";
    const loading = createElement("div", "color-adjustment-empty", body);
    loading.textContent = "Loading code groups...";

    try {
        await loadCodeGroups();
        renderGroupRows(body, statusNode);
    } catch (error) {
        body.innerHTML = "";
        const errorNode = createElement("div", "color-adjustment-empty color-adjustment-empty-error", body);
        errorNode.textContent = error.message || "Could not load code groups.";
        setStatus(statusNode, errorNode.textContent, STATUS_ERROR);
    }
}

function renderMode(body, statusNode) {
    if (activeMode === "groups") {
        void renderGroupsMode(body, statusNode);
        return;
    }
    renderCodesMode(body, statusNode);
}

function renderPanel(overlay) {
    overlay.innerHTML = "";

    const modal = createElement("div", "color-adjustment-modal", overlay);
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "color-adjustment-title");
    modal.addEventListener("mousedown", event => event.stopPropagation());

    const header = createElement("div", "color-adjustment-header", modal);
    const titleBlock = createElement("div", "", header);
    const title = createElement("h2", "color-adjustment-title", titleBlock);
    title.id = "color-adjustment-title";
    title.textContent = "Color Adjustment";
    const summary = createElement("div", "color-adjustment-summary", titleBlock);
    summary.textContent = `${getThemes().length} code${getThemes().length === 1 ? "" : "s"}`;

    const closeButton = createElement("button", "color-adjustment-close-button", header);
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close color adjustment panel");
    closeButton.textContent = "x";
    closeButton.addEventListener("click", closePanel);

    const controls = createElement("div", "color-adjustment-controls", modal);
    const codesButton = createElement("button", "color-adjustment-mode-button", controls);
    codesButton.type = "button";
    codesButton.textContent = "Codes";
    const groupsButton = createElement("button", "color-adjustment-mode-button", controls);
    groupsButton.type = "button";
    groupsButton.textContent = "Code Groups";

    const statusNode = createElement("div", "color-adjustment-status", controls);
    statusNode.dataset.state = STATUS_IDLE;

    const body = createElement("div", "color-adjustment-body", modal);

    const syncModeButtons = () => {
        codesButton.classList.toggle("active", activeMode === "codes");
        groupsButton.classList.toggle("active", activeMode === "groups");
    };

    codesButton.addEventListener("click", () => {
        activeMode = "codes";
        syncModeButtons();
        setStatus(statusNode, "");
        renderMode(body, statusNode);
    });
    groupsButton.addEventListener("click", () => {
        activeMode = "groups";
        syncModeButtons();
        setStatus(statusNode, "");
        renderMode(body, statusNode);
    });

    syncModeButtons();
    renderMode(body, statusNode);
}

function openPanel() {
    let overlay = document.getElementById(PANEL_OVERLAY_ID);
    if (overlay) {
        overlay.remove();
    }

    overlay = createElement("div", "color-adjustment-overlay", document.body);
    overlay.id = PANEL_OVERLAY_ID;
    overlay.addEventListener("mousedown", closePanel);
    renderPanel(overlay);
}

export function initializeColorAdjustmentPanel() {
    const button = document.getElementById("color-adjustment-button");
    if (!button || button.dataset.colorAdjustmentInitialized === "true") return;
    button.dataset.colorAdjustmentInitialized = "true";
    button.addEventListener("click", openPanel);
}
