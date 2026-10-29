import { findTextHighlights, renderHighlightedText } from "../../safeText.js";
import {
    chooseTranscriptThemePayload,
    getActiveTranscriptCodes,
    transcriptThemePayloadIsOlder
} from "./transcriptCodeSelection.js";
import { loadTranscripts, themesObject, transcriptsObject, highlight, FileMap  } from "../../../chromascribe-main.js";
import { buildDemoFileMap } from "../../demoFileMap.js";
import { createTranscriptHistory } from "./transcriptHistory.js?v=20261006a";
import { scopeAppPath } from "../../pageTransitionOverlay.js";
import { findParticipantAudio, buildServeAudioUrl } from "../../main-page/audioMatching.js?v=20260601b";
import {
    buildPersistedThemePayload,
    buildThemeExcerptEntry,
    buildThemeWordIdentityKey,
    dedupeThemeWordEntries,
    getNextAvailableThemeColor,
    getStoredThemePayload,
    normalizeManualSelectionOptOuts,
    normalizeThemeParticipantId,
    persistThemePayload,
    persistThemePayloadLocally,
    selectManualCodeForNewExcerpt,
    setManualCodeSelection,
    subscribeToThemePayloadUpdates
} from "../../themePersistence.js?v=20260901b";
import {
    getStoredFileMap,
    hydrateFileMapFromServer
} from "../../fileMapSync.js?v=20260601b";

import {
    buildQnaConflictKey,
    getCueNoteKey,
    getCueOriginalSpeaker,
    getCueStartSeconds
} from "./transcriptIdentity.js?v=20260921a";

let currentJ; // To track which speech block is being edited
let currentParticipant; // To store the active participant
let notesData = {}; // Saved notes for the current project.
let notesLoaded = false;
let noteSaveInFlight = false;
let notesLoadVersion = 0;
const pendingTextSaves = new Set();

let allQTags = new Set();
let allATags = new Set();
let projectQuestionList = [];
let qnaIntermediatePayload = { questions: {}, answers: {}, possibleAnswers: {} };
let speakerRoleSaveInFlight = false;
let aiGeneratedCodeKeys = new Set();
let qnaConflictByCueKey = new Map();
let qnaReviewModeEnabled = true;
const QNA_CONFLICT_REVIEW_POPOVER_ID = "qnaConflictReviewPopover";
const NOTE_RAIL_SAFE_LEFT = 96;
const NOTE_RAIL_GAP = 14;
const NOTE_RAIL_MIN_WIDTH = 132;
const NOTE_RAIL_MAX_WIDTH = 190;
const MANUAL_CODE_SELECTION_SOURCE = "manual_codes";
const APPLIED_CODE_SELECTION_STAGE = "applied_codes";
let noteRailResizeHandlerBound = false;
let currentThemePayloadIsAppliedSelection = false;
let currentSelectedThemePayload = null;
let transcriptThemePayloadUnsubscribe = null;
let transcriptThemeRemoteRefreshBound = false;
let qnaSaveQueue = Promise.resolve();
const pendingQnaSaves = new Map();
const transcriptHistory = createTranscriptHistory(updateUndoButton);
let codeEditInFlight = false;

window.addEventListener("beforeunload", event => {
    if (pendingQnaSaves.size === 0 && pendingTextSaves.size === 0
        && !noteSaveInFlight && transcriptHistory.state().pending === 0) return;
    event.preventDefault();
    event.returnValue = "";
});

function updateUndoButton(state) {
    const button = document.getElementById("transcriptUndoButton");
    if (!button) return;
    button.disabled = !state.canUndo;
    button.title = state.label ? `Undo: ${state.label}` : "No tag or code changes to undo yet";
    button.textContent = state.undoing ? "Undoing…" : "↶ Undo";
    const status = document.getElementById("transcriptUndoStatus");
    if (status && state.pending > 0) status.textContent = "";
}

export async function undoTranscriptEdit() {
    const status = document.getElementById("transcriptUndoStatus");
    try {
        const undone = await transcriptHistory.undo();
        if (undone && status) status.textContent = "Change undone and saved.";
    } catch (error) {
        if (status) status.textContent = error.message || "Undo could not be saved. Please try again.";
    }
}

function transcriptRequestContext() {
    return {
        projectId: getCurrentProjectId(),
        mode: scopeAppPath("/api/undo_transcript_edit").startsWith("/demo/") ? "demo" : "user"
    };
}

function isTranscriptHistoryResult(endpoint, payload, result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    if (endpoint === "/api/undo_transcript_edit") {
        const hasCue = result.cue && typeof result.cue === "object" && !Array.isArray(result.cue);
        const hasThemes = result.themes && Array.isArray(result.themes.themes);
        return Boolean(hasCue || hasThemes);
    }
    if (payload.action === "capture") {
        return typeof result.checkpoint === "string" && result.checkpoint.length > 0;
    }
    if (payload.action === "record") {
        return result.undoToken === null || typeof result.undoToken === "string";
    }
    return false;
}

async function sendTranscriptHistoryRequest(endpoint, payload) {
    const response = await fetch(scopeAppPath(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => null);
    // Demo routing can redirect a successful JSON request. A sign-in page or
    // malformed response must still be reported as a failed save.
    if (!response.ok || !isTranscriptHistoryResult(endpoint, payload, result)) {
        throw new Error(result?.error || "The change could not be saved. Please try again.");
    }
    return result;
}

async function postTranscriptHistory(endpoint, payload) {
    const progress = window.ChromaProjectProgress;
    const saveChange = async () => {
        const result = await sendTranscriptHistoryRequest(endpoint, payload);
        if (endpoint === "/api/undo_transcript_edit" && result.themes) {
            persistThemePayloadLocally(result.themes);
        }
        return result;
    };
    if (endpoint === "/api/undo_transcript_edit" && typeof progress?.runProjectChange === "function") {
        return progress.runProjectChange(payload.projectId, saveChange);
    }
    return saveChange();
}

function rememberQnaUndo(result, context, cue, blockIndex, participant) {
    if (!result.undoToken) return;
    transcriptHistory.push({
        label: "Q&A tag change",
        async restore() {
            const restored = await postTranscriptHistory("/api/undo_transcript_edit", {
                ...context, undoToken: result.undoToken
            });
            syncQnaConflictResponse(cue, restored, blockIndex, participant);
        }
    });
}

async function runUndoableCodeChange(themeName, label, saveChange) {
    if (codeEditInFlight || transcriptHistory.state().undoing) {
        updateTagMenuStatus("Finishing the previous change…", "neutral");
        return;
    }
    codeEditInFlight = true;
    transcriptHistory.begin();
    updateTagMenuStatus("Saving code…", "neutral");
    const context = { ...transcriptRequestContext(), themeName };
    let checkpoint;
    try {
        const captured = await postTranscriptHistory("/api/transcript_code_history", {
            ...context, action: "capture"
        });
        checkpoint = captured.checkpoint;
        await saveChange();
    } catch (error) {
        updateTagMenuStatus(error.message || "Could not save code.", "warning");
    } finally {
        await finishCodeHistory(context, checkpoint, label);
        codeEditInFlight = false;
        transcriptHistory.end();
    }
}

async function finishCodeHistory(context, checkpoint, label) {
    if (!checkpoint) return;
    try {
        const result = await postTranscriptHistory("/api/transcript_code_history", {
            ...context, checkpoint, action: "record"
        });
        if (!result.undoToken) return;
        transcriptHistory.push({
            label,
            async restore() {
                const restored = await postTranscriptHistory("/api/undo_transcript_edit", {
                    ...context, undoToken: result.undoToken
                });
                refreshTranscriptCodingFromThemePayload(restored.themes);
            }
        });
    } catch (error) {
        updateTagMenuStatus("Undo is unavailable for this change. Reload to check the saved code.", "warning");
    }
}

function getCurrentProjectId() {
    const serverProjectId = typeof window !== "undefined" ? String(window.CURRENT_PROJECT_ID || "").trim() : "";
    if (serverProjectId) return serverProjectId;
    if (typeof localStorage === "undefined") return "";
    const rawValue = localStorage.getItem("currentProjectId");
    return typeof rawValue === "string" ? rawValue.trim() : "";
}

function projectQueryParam(prefix = "&") {
    const projectId = getCurrentProjectId();
    return projectId ? `${prefix}projectId=${encodeURIComponent(projectId)}` : "";
}

function withProjectPayload(payload) {
    const projectId = getCurrentProjectId();
    return projectId && payload && typeof payload === "object"
        ? { ...payload, projectId }
        : payload;
}

function getCurrentWorkspaceKey() {
    const serverWorkspaceKey = typeof window !== "undefined" ? String(window.USER_WORKSPACE_KEY || "").trim() : "";
    if (serverWorkspaceKey) return serverWorkspaceKey;
    if (typeof localStorage === "undefined") return "";
    const rawValue = localStorage.getItem("currentWorkspaceKey");
    return typeof rawValue === "string" ? rawValue.trim() : "";
}

function getProjectStorageScope(projectId = getCurrentProjectId()) {
    const resolvedProjectId = String(projectId || "").trim();
    if (!resolvedProjectId) return "";
    const workspaceKey = getCurrentWorkspaceKey();
    return workspaceKey ? `${workspaceKey}__${resolvedProjectId}` : resolvedProjectId;
}

function getSelectionCompleteKey(projectId = getCurrentProjectId()) {
    const storageScope = getProjectStorageScope(projectId);
    return storageScope ? `themeSelectionComplete_${storageScope}` : "themeSelectionComplete";
}

function getSelectionPendingKey(projectId = getCurrentProjectId()) {
    const storageScope = getProjectStorageScope(projectId);
    return storageScope ? `themeSelectionPending_${storageScope}` : "themeSelectionPending";
}

function markCodeManagerSelectionComplete() {
    if ((window.APP_MODE || "user") === "demo" || typeof localStorage === "undefined") return;
    try {
        const projectId = getCurrentProjectId();
        localStorage.setItem(getSelectionCompleteKey(projectId), "1");
        localStorage.removeItem(getSelectionPendingKey(projectId));
    } catch (error) {
        console.warn("Failed to mark Code Manager selection as complete:", error);
    }
}

function manualCodeSelectionMetadata() {
    return {
        selectedByUser: true,
        selectionSource: MANUAL_CODE_SELECTION_SOURCE,
        selectionStage: APPLIED_CODE_SELECTION_STAGE,
        codeSource: "manual",
        source: "manual",
        ai_generated: false,
        humanTagged: true,
    };
}

function markManualCodeThemeForSync(themeData) {
    if (!themeData || typeof themeData !== "object") return themeData;
    Object.assign(themeData, manualCodeSelectionMetadata());
    return themeData;
}

function markCodeSelectedForSync(themeData) {
    if (!themeData || typeof themeData !== "object") return themeData;
    themeData.selectedByUser = true;
    themeData.selectionSource = themeData.selectionSource || MANUAL_CODE_SELECTION_SOURCE;
    themeData.selectionStage = themeData.selectionStage || APPLIED_CODE_SELECTION_STAGE;
    if (!isAiGeneratedCode(themeData)) {
        markManualCodeThemeForSync(themeData);
    }
    return themeData;
}

function buildManualCodeSyncPayload(themes, extra = {}) {
    return {
        ...extra,
        themes,
        manualSelectionOptOuts: normalizeManualSelectionOptOuts(themesObject),
        selectionSource: MANUAL_CODE_SELECTION_SOURCE,
        selectionStage: APPLIED_CODE_SELECTION_STAGE,
        updatedAt: extra.updatedAt || new Date().toISOString(),
    };
}

function projectHasAnyMatchedAudio() {
    const participants = Array.isArray(FileMap?.participants) ? FileMap.participants : [];
    return participants.some((entry) => {
        const relativePath = entry && entry.audio && entry.audio.relativePath;
        return typeof relativePath === "string" && relativePath.trim() !== "";
    });
}

function themePayloadLooksLikeMatchingSelection(payload) {
    if (!payload || typeof payload !== "object") return false;
    const previewState = String(payload.visualizationPreviewState || "").trim().toLowerCase();
    const selectionStage = String(payload.selectionStage || "").trim().toLowerCase();
    const selectionSource = String(payload.selectionSource || "").trim().toLowerCase();
    return (
        previewState === "matching_excerpts_unapplied" ||
        selectionStage === "matching_excerpts" ||
        selectionStage === "matching_excerpts_selected" ||
        selectionSource === "matching_excerpts"
    );
}

function themePayloadIsAppliedSelection(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.appliedToVisualization === true) return true;
    if (themePayloadLooksLikeMatchingSelection(payload)) return false;

    const selectionStage = String(payload.selectionStage || "").trim().toLowerCase();
    if (["applied_codes", "apply_codes", "visualization_applied"].includes(selectionStage)) return true;

    const selectionSource = String(payload.selectionSource || "").trim().toLowerCase();
    if (["applied_codes", "apply_codes", "manual_codes", "visualization_applied"].includes(selectionSource)) return true;

    return !payload.visualizationPreviewState;
}

function setCurrentTranscriptThemePayload(payload) {
    if (!payload || !Array.isArray(payload.themes)) return null;
    const canonicalPayload = buildPersistedThemePayload(payload);
    currentSelectedThemePayload = canonicalPayload;
    currentThemePayloadIsAppliedSelection = themePayloadIsAppliedSelection(canonicalPayload);
    themesObject.themes = canonicalPayload.themes;
    themesObject.manualSelectionOptOuts = normalizeManualSelectionOptOuts(canonicalPayload);
    return canonicalPayload;
}

function refreshTranscriptCodingFromThemePayload(payload) {
    const canonicalPayload = setCurrentTranscriptThemePayload(payload);
    if (!canonicalPayload || !currentParticipant) return false;

    const interview = transcriptsObject.transcripts[currentParticipant] || [];
    interview.forEach((cue, index) => {
        refreshCueCodingUI(cue, themesObject, index);
    });
    refreshVisibleTagMenu();
    return true;
}

async function refreshTranscriptThemePayloadFromServer() {
    if (codeEditInFlight || transcriptHistory.state().undoing) return;
    const payloadBeforeRefresh = currentSelectedThemePayload;
    const [serverPayload, storedThemePayload] = await Promise.all([
        fetchSelectedThemePayload(),
        Promise.resolve(getStoredThemePayload())
    ]);
    const canonicalStoredThemePayload = storedThemePayload && Array.isArray(storedThemePayload.themes)
        ? buildPersistedThemePayload(storedThemePayload)
        : null;
    const preferredPayload = chooseTranscriptThemePayload(serverPayload, canonicalStoredThemePayload);
    if (codeEditInFlight || transcriptHistory.state().undoing) return;
    // Keep any edit or selection update that arrived while this request was loading.
    if (currentSelectedThemePayload !== payloadBeforeRefresh) return;
    if (preferredPayload && !transcriptThemePayloadIsOlder(currentSelectedThemePayload, preferredPayload)) {
        refreshTranscriptCodingFromThemePayload(preferredPayload);
    }
}

function initializeTranscriptThemePayloadSync() {
    if (!transcriptThemePayloadUnsubscribe) {
        transcriptThemePayloadUnsubscribe = subscribeToThemePayloadUpdates((payload) => {
            const canonicalPayload = payload && Array.isArray(payload.themes)
                ? buildPersistedThemePayload(payload)
                : null;
            if (!canonicalPayload) return;
            if (transcriptThemePayloadIsOlder(currentSelectedThemePayload, canonicalPayload)) return;
            refreshTranscriptCodingFromThemePayload(canonicalPayload);
        });
    }

    if (transcriptThemeRemoteRefreshBound || typeof window === "undefined") return;
    transcriptThemeRemoteRefreshBound = true;
    window.addEventListener("pageshow", () => {
        void refreshTranscriptThemePayloadFromServer();
    });
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            void refreshTranscriptThemePayloadFromServer();
        }
    });
}

function transcriptTextMetrics(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return {
        textLength: text.length,
        wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0
    };
}

function recordTranscriptWorkflowEvent(eventType, details = {}, metrics = {}) {
    const logger = window.ChromaUsageLogger;
    if (!logger || typeof logger.recordFeatureEvent !== "function") {
        return;
    }
    logger.recordFeatureEvent("manual_coding", eventType, {
        participant: currentParticipant || "",
        cueIndex: currentJ,
        ...details
    }, metrics);
}

function recordCodebookWorkflowEvent(eventType, details = {}, metrics = {}) {
    const logger = window.ChromaUsageLogger;
    if (!logger || typeof logger.recordFeatureEvent !== "function") {
        return;
    }
    logger.recordFeatureEvent("codebook_management", eventType, details, metrics);
}

function recordAnalysisWorkflowAction(actionType, entityType, operation, details = {}) {
    const logger = window.ChromaUsageLogger;
    if (!logger || typeof logger.recordAction !== "function") {
        return;
    }
    logger.recordAction(actionType, entityType, operation, details);
}

async function fetchSelectedThemePayload() {
    try {
        const response = await fetch(`/api/load_selected_themes?includeGeneratedQuotes=1&includeGeneratedThemes=1&t=${Date.now()}${projectQueryParam()}`, { cache: "no-store" });
        if (!response.ok) return null;
        const payload = await response.json();
        return payload && Array.isArray(payload.themes)
            ? buildPersistedThemePayload(payload)
            : null;
    } catch (error) {
        console.warn("Failed to fetch selected themes for transcript mode:", error);
        return null;
    }
}

function normalizeCodeNameKey(value) {
    return String(value || "")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function readThemeName(themeData) {
    return String(
        (themeData && (themeData.themeName || themeData.theme || themeData.name || themeData.title)) || ""
    ).trim();
}

async function fetchAiGeneratedCodeKeys() {
    try {
        const response = await fetch(`/api/load_ai_generated?t=${Date.now()}${projectQueryParam()}`, { cache: "no-store" });
        if (!response.ok) return new Set();
        const payload = await response.json();
        const keys = new Set();

        const addName = (name) => {
            const normalized = normalizeCodeNameKey(name);
            if (normalized && normalized !== "error" && normalized !== "details") {
                keys.add(normalized);
            }
        };
        const isManualThemePayload = (value) => {
            if (!value || typeof value !== "object") return false;
            const source = String(value.codeSource || value.source || value.tagSource || "").trim().toLowerCase();
            if (source === "manual" || source === "human" || source === "human_ai" || source === "human+ai" || source === "both") return true;
            if (source === "ai" || source === "llm" || source === "cloud") return false;
            if (value.humanTagged === true || value.human_tagged === true) return true;
            return value.ai_generated === false;
        };

        if (Array.isArray(payload)) {
            payload.forEach(entry => {
                if (typeof entry === "string") {
                    addName(entry);
                    return;
                }
                if (isManualThemePayload(entry)) return;
                addName(readThemeName(entry));
            });
        } else if (payload && typeof payload === "object") {
            Object.entries(payload).forEach(([key, value]) => {
                if (isManualThemePayload(value)) return;
                addName(key);
                if (value && typeof value === "object") {
                    addName(readThemeName(value));
                }
            });
        }

        return keys;
    } catch (error) {
        console.warn("Failed to fetch AI-generated code list:", error);
        return new Set();
    }
}

function normalizeQATag(rawTag) {
    const value = String(rawTag || "").trim();
    if (!value || value.toLowerCase() === "none" || value.toLowerCase() === "null") {
        return "";
    }
    const match = value.match(/^([QA])\s*0*(\d+)([a-z]?)$/i);
    if (!match) {
        return "";
    }
    return `${match[1].toUpperCase()}${parseInt(match[2], 10)}${(match[3] || "").toLowerCase()}`;
}

function getQATagBase(rawTag) {
    const tag = normalizeQATag(rawTag);
    const match = tag.match(/^([QA]\d+)/i);
    return match ? match[1].toUpperCase() : "";
}

function qaTagsCompatible(leftTag, rightTag) {
    const left = normalizeQATag(leftTag);
    const right = normalizeQATag(rightTag);
    if (!left || !right) return false;
    if (left === right) return true;
    const leftBase = getQATagBase(left);
    const rightBase = getQATagBase(right);
    return Boolean(leftBase && rightBase && leftBase === rightBase);
}

function getCueQATags(cueOrTag) {
    const rawTags = [];
    if (cueOrTag && typeof cueOrTag === "object" && !Array.isArray(cueOrTag)) {
        rawTags.push(cueOrTag.tag);
        rawTags.push(cueOrTag.manualTag);
        rawTags.push(cueOrTag.aiSuggestedTag);
        rawTags.push(cueOrTag.originalTag);
        rawTags.push(cueOrTag.originalAiTag);
        if (Array.isArray(cueOrTag.additionalTags)) {
            rawTags.push(...cueOrTag.additionalTags);
        }
        if (Array.isArray(cueOrTag.aiSuggestedTags)) {
            rawTags.push(...cueOrTag.aiSuggestedTags);
        }
    } else if (Array.isArray(cueOrTag)) {
        rawTags.push(...cueOrTag);
    } else {
        rawTags.push(cueOrTag);
    }

    const seen = new Set();
    const tags = [];
    rawTags.forEach(rawTag => {
        const tag = normalizeQATag(rawTag);
        if (!tag || seen.has(tag)) return;
        seen.add(tag);
        tags.push(tag);
    });
    return tags;
}

function getDisplayedQATags(cueOrTag) {
    if (!cueOrTag || typeof cueOrTag !== "object" || Array.isArray(cueOrTag)) {
        return getCueQATags(cueOrTag);
    }

    // Keep historical AI labels for excerpt matching, but display only the
    // active choice. "Keep both" explicitly stores its second label here.
    const primaryTag = cueOrTag.manualTag ?? cueOrTag.tag;
    const additionalTags = Array.isArray(cueOrTag.additionalTags) ? cueOrTag.additionalTags : [];
    return getCueQATags([primaryTag, ...additionalTags]);
}

function normalizeConflictTimestamp(rawTimestamp) {
    return String(rawTimestamp || "").replace(/\s+/g, "").trim();
}

async function fetchQnaTagConflicts() {
    try {
        const participantParam = currentParticipant ? `&participant=${encodeURIComponent(currentParticipant)}` : "";
        const endpoint = scopeAppPath("/api/tag_conflicts");
        const mode = endpoint.startsWith("/demo/") ? "demo" : "user";
        const url = `${endpoint}?mode=${mode}&t=${Date.now()}${participantParam}${projectQueryParam()}`;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return { conflicts: [], summary: { openCount: 0 } };
        const payload = await response.json();
        return payload && Array.isArray(payload.conflicts)
            ? payload
            : { conflicts: [], summary: { openCount: 0 } };
    } catch (error) {
        console.warn("Failed to fetch Q&A tag conflicts:", error);
        return { conflicts: [], summary: { openCount: 0 } };
    }
}

function indexQnaTagConflicts(conflicts) {
    qnaConflictByCueKey = new Map();
    (conflicts || []).forEach(conflict => {
        const key = buildQnaConflictKey(conflict.participant, conflict.timestamp, conflict.segmentId);
        if (key.trim() !== "||") qnaConflictByCueKey.set(key, conflict);
    });
}

function mergeQnaTagConflictsIntoTranscripts(conflictPayload) {
    const conflicts = Array.isArray(conflictPayload && conflictPayload.conflicts)
        ? conflictPayload.conflicts
        : [];
    indexQnaTagConflicts(conflicts);

    Object.entries(transcriptsObject.transcripts || {}).forEach(([participant, transcriptArray]) => {
        if (!Array.isArray(transcriptArray)) return;
        transcriptArray.forEach(cue => {
            if (!cue || typeof cue !== "object") return;
            const conflict = qnaConflictByCueKey.get(buildQnaConflictKey(participant, cue.timestamp, cue.segmentId));
            if (conflict) {
                cue.tagConflict = true;
                cue.tagConflictType = conflict.type || "qa_tag_mismatch";
                cue.manualTag = conflict.manualTag || "None";
                cue.aiSuggestedTag = conflict.aiSuggestedTag || "";
                cue.additionalTags = Array.isArray(conflict.additionalTags) ? conflict.additionalTags : cue.additionalTags;
                cue.tagSource = "manual";
                cue.tag = normalizeQATag(conflict.manualTag) || "None";
            } else if (cue.tagConflict) {
                delete cue.tagConflict;
                delete cue.tagConflictType;
            }
        });
    });
}

function getCueQnaConflict(cue, participant = currentParticipant) {
    if (!cue || typeof cue !== "object") return null;
    const indexedConflict = qnaConflictByCueKey.get(buildQnaConflictKey(participant, cue.timestamp, cue.segmentId));
    if (indexedConflict) return indexedConflict;
    if (!cue.tagConflict) return null;
    const aiSuggestedTag = normalizeQATag(cue.aiSuggestedTag);
    if (!aiSuggestedTag) return null;
    return {
        manualTag: normalizeQATag(cue.manualTag || cue.tag) || "None",
        aiSuggestedTag,
        tagFamily: aiSuggestedTag.startsWith("Q") ? "question" : "answer",
    };
}

function hideQnaConflictReviewPopover() {
    d3.select(`#${QNA_CONFLICT_REVIEW_POPOVER_ID}`).remove();
    d3.select("body").on("mousedown.qna-conflict-review", null);
}

function getQnaConflictReviewActions(conflict) {
    const aiSuggestedTag = normalizeQATag(conflict && conflict.aiSuggestedTag);
    const tagFamily = String(
        conflict && (conflict.tagFamily || (aiSuggestedTag.startsWith("Q") ? "question" : "answer"))
    ).toLowerCase();
    const actions = [
        { action: "keep_manual", icon: "H", label: "Use human" }
    ];
    if (aiSuggestedTag) {
        actions.push({ action: "use_ai", icon: "AI", label: "Use AI" });
    }
    if (tagFamily === "answer") {
        actions.push({ action: "keep_both", icon: "+", label: "Keep both" });
    } else {
        actions.push({ action: "dismiss", icon: "x", label: "Dismiss", subtle: true });
    }
    return actions;
}

function findQnaConflictBlockIndex(conflict) {
    const interview = transcriptsObject.transcripts[currentParticipant] || [];
    if (conflict && conflict.segmentId) {
        return interview.findIndex(cue => cue && cue.segmentId === conflict.segmentId);
    }
    const normalizedTimestamp = normalizeConflictTimestamp(conflict && conflict.timestamp);
    const transcriptIndex = Number(conflict && conflict.transcriptIndex);
    if (
        Number.isInteger(transcriptIndex)
        && transcriptIndex >= 0
        && transcriptIndex < interview.length
        && normalizeConflictTimestamp(interview[transcriptIndex] && interview[transcriptIndex].timestamp) === normalizedTimestamp
    ) {
        return transcriptIndex;
    }
    return interview.findIndex(cue => normalizeConflictTimestamp(cue && cue.timestamp) === normalizedTimestamp);
}

function getCurrentParticipantQnaConflicts() {
    const participantKey = String(currentParticipant || "").trim().toUpperCase();
    return Array.from(qnaConflictByCueKey.values())
        .filter(conflict => String(conflict && conflict.participant || "").trim().toUpperCase() === participantKey)
        .map(conflict => {
            const blockIndex = findQnaConflictBlockIndex(conflict);
            const cue = blockIndex >= 0 ? (transcriptsObject.transcripts[currentParticipant] || [])[blockIndex] : null;
            return { conflict, blockIndex, cue };
        })
        .filter(item => item.blockIndex >= 0 && item.cue);
}

function scrollToQnaConflict(blockIndex) {
    const speechBlock = document.getElementById(`speechBlock_${blockIndex}`);
    if (!speechBlock) return;
    speechBlock.scrollIntoView({ behavior: "smooth", block: "center" });
    d3.selectAll(".speechBlock").classed("qna-review-focus", false);
    d3.select(speechBlock).classed("qna-review-focus", true);
    setTimeout(() => {
        d3.select(speechBlock).classed("qna-review-focus", false);
    }, 1600);
}

function applyQnaReviewModeClasses() {
    const conflictIndexes = new Set(
        getCurrentParticipantQnaConflicts().map(item => String(item.blockIndex))
    );
    d3.selectAll(".speechBlock").each(function() {
        const match = String(this.id || "").match(/^speechBlock_(.+)$/);
        const blockIndex = match ? match[1] : "";
        const hasConflict = conflictIndexes.has(blockIndex);
        d3.select(this)
            .classed("has-qna-conflict", hasConflict)
            .classed("qna-review-highlight", qnaReviewModeEnabled && hasConflict);
    });
}

function renderQnaReviewRail() {
    d3.select("#qnaReviewRail").remove();
    const editor = d3.select("#editor");
    if (editor.empty()) return;

    const conflictItems = getCurrentParticipantQnaConflicts();
    if (!qnaReviewModeEnabled || conflictItems.length === 0) return;

    const rail = editor.insert("aside", "#editorContent")
        .attr("id", "qnaReviewRail")
        .attr("class", "qna-review-rail")
        .attr("aria-label", "Q&A tag review");

    const header = rail.append("div").attr("class", "qna-review-rail-header");
    header.append("div")
        .attr("class", "qna-review-rail-title")
        .text("Review");
    header.append("div")
        .attr("class", "qna-review-rail-count")
        .text(`${conflictItems.length} open`);

    rail.append("div")
        .attr("class", "qna-review-rail-help")
        .text("Choose whether to keep your tag, use the AI tag, or leave the conflict unresolved.");

    const list = rail.append("div").attr("class", "qna-review-list");
    conflictItems.forEach(({ conflict, blockIndex, cue }) => {
        const manualTag = normalizeQATag(conflict.manualTag) || "None";
        const aiSuggestedTag = normalizeQATag(conflict.aiSuggestedTag) || "None";
        const tagFamily = String(conflict.tagFamily || (aiSuggestedTag.startsWith("Q") ? "question" : "answer")).toLowerCase();
        const excerpt = String(conflict.cueText || cue.script || "").replace(/\s+/g, " ").trim();
        const card = list.append("div")
            .attr("class", "qna-review-card")
            .attr("role", "button")
            .attr("tabindex", "0")
            .on("click", function() {
                scrollToQnaConflict(blockIndex);
            })
            .on("keydown", function() {
                const event = d3.event || window.event;
                if (event && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    scrollToQnaConflict(blockIndex);
                }
            });

        const cardHeader = card.append("div").attr("class", "qna-review-card-header");
        cardHeader.append("span")
            .attr("class", "qna-review-card-type")
            .text(tagFamily === "question" ? "Question" : "Answer");
        cardHeader.append("span")
            .attr("class", "qna-review-card-time")
            .text(conflict.timestamp || cue.timestamp || "");

        card.append("div")
            .attr("class", "qna-review-card-tags")
            .text(`Human ${manualTag} | AI ${aiSuggestedTag}`);
        card.append("div")
            .attr("class", "qna-review-card-excerpt")
            .text(excerpt || "Transcript segment");

        const actions = card.append("div").attr("class", "qna-review-card-actions");
        getQnaConflictReviewActions(conflict).slice(0, 3).forEach(actionDef => {
            actions.append("button")
                .attr("type", "button")
                .attr("class", `qna-review-card-action${actionDef.subtle ? " subtle" : ""}`)
                .text(actionDef.label)
                .on("click", function() {
                    d3.event.preventDefault();
                    d3.event.stopPropagation();
                    currentJ = blockIndex;
                    resolveQnaConflict(actionDef.action, conflict, blockIndex);
                });
        });
    });
}

function renderQnaReviewExperience() {
    qnaReviewModeEnabled = true;
    d3.select("#qnaReviewToggle").remove();
    refreshAllSpeechBlockQATags();
    applyQnaReviewModeClasses();
    renderQnaReviewRail();
}

function positionQnaConflictReviewPopover(popover, pageX, pageY) {
    const node = popover.node();
    if (!node) return;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const rect = node.getBoundingClientRect();
    const left = Math.max(scrollX + 12, Math.min(pageX, scrollX + viewportWidth - rect.width - 12));
    const top = Math.max(scrollY + 12, Math.min(pageY, scrollY + viewportHeight - rect.height - 12));
    popover.style("left", `${left}px`).style("top", `${top}px`);
}

function showQnaConflictReviewPopover(pageX, pageY, cue, blockIndex) {
    const conflict = getCueQnaConflict(cue);
    if (!conflict) return;
    const manualTag = normalizeQATag(conflict.manualTag) || "None";
    const aiSuggestedTag = normalizeQATag(conflict.aiSuggestedTag) || "None";
    const tagFamily = String(conflict.tagFamily || (aiSuggestedTag.startsWith("Q") ? "question" : "answer")).toLowerCase();

    hideQnaConflictReviewPopover();
    const popover = d3.select("body").append("div")
        .attr("id", QNA_CONFLICT_REVIEW_POPOVER_ID)
        .attr("class", "qna-conflict-review-popover")
        .attr("role", "dialog")
        .attr("aria-label", "Review AI Q&A tag conflict")
        .style("position", "absolute")
        .style("left", `${pageX}px`)
        .style("top", `${pageY}px`);

    const header = popover.append("div")
        .attr("class", "qna-conflict-review-header");
    header.append("div")
        .attr("class", "qna-conflict-review-title")
        .text(tagFamily === "question" ? "Question conflict" : "Answer conflict");
    header.append("button")
        .attr("type", "button")
        .attr("class", "qna-conflict-review-close")
        .attr("aria-label", "Close conflict review")
        .text("x")
        .on("click", function() {
            d3.event.preventDefault();
            d3.event.stopPropagation();
            hideQnaConflictReviewPopover();
        });

    popover.append("div")
        .attr("class", "qna-conflict-review-copy")
        .text(`Manual: ${manualTag} | AI: ${aiSuggestedTag}`);

    const actions = popover.append("div")
        .attr("class", "qna-conflict-review-actions");
    getQnaConflictReviewActions(conflict).forEach(actionDef => {
        const button = actions.append("button")
            .attr("type", "button")
            .attr("class", `qna-conflict-review-action${actionDef.subtle ? " subtle" : ""}`)
            .attr("title", actionDef.label)
            .attr("aria-label", actionDef.label)
            .on("click", function() {
                d3.event.preventDefault();
                d3.event.stopPropagation();
                currentJ = blockIndex;
                hideQnaConflictReviewPopover();
                resolveQnaConflict(actionDef.action, conflict, blockIndex);
            });
        button.append("span").attr("class", "qna-conflict-review-icon").text(actionDef.icon);
        button.append("span").attr("class", "qna-conflict-review-label").text(actionDef.label);
    });

    positionQnaConflictReviewPopover(popover, pageX, pageY);
    setTimeout(() => {
        d3.select("body").on("mousedown.qna-conflict-review", function() {
            const event = d3.event;
            if (event && popover.node() && popover.node().contains(event.target)) return;
            hideQnaConflictReviewPopover();
        });
    }, 0);
}

function parseQuestionListItem(questionText, index) {
    const rawText = String(questionText || "").trim();
    const fallbackLabel = String(index + 1);
    const match = rawText.match(/^(?:Q\s*)?0*(\d+)([a-z]?)\s*[\.\):\-]\s*(.*)$/i);
    if (!match) {
        return { label: fallbackLabel, text: rawText };
    }
    return {
        label: `${parseInt(match[1], 10)}${(match[2] || "").toLowerCase()}`,
        text: String(match[3] || "").trim()
    };
}

function resolveCueSpeakerLabel(cue, participantCode) {
    const rawSpeaker = getCueOriginalSpeaker(cue);
    if (cue.speakerRole === "interviewer" || cue.speakerRole === "participant") {
        const roleLabel = canonicalSpeakerRoleLabel(cue.speakerRole);
        return rawSpeaker && normalizeSpeakerName(rawSpeaker) !== normalizeSpeakerName(roleLabel)
            ? `${rawSpeaker} (${roleLabel})`
            : roleLabel;
    }
    if (Object.prototype.hasOwnProperty.call(cue, "speakerLabel") && !rawSpeaker) {
        return "Unknown speaker";
    }
    const participantNumber = String(participantCode || "").replace(/^P/i, "");
    if (/^(s1|interviewer|moderator)$/i.test(rawSpeaker)) {
        return "Interviewer";
    }

    const participantMatch = rawSpeaker.match(/\b(?:participant|p)\s*0*(\d+)\b/i);
    if (participantMatch) {
        return `Participant ${parseInt(participantMatch[1], 10)}`;
    }

    if (/^s2$/i.test(rawSpeaker) && participantNumber) {
        return `Participant ${participantNumber}`;
    }

    return rawSpeaker || (participantNumber ? `Participant ${participantNumber}` : "Participant");
}

function normalizeSpeakerName(rawSpeaker) {
    return String(rawSpeaker || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function canonicalSpeakerRoleLabel(role) {
    return normalizeSpeakerName(role) === "interviewer" ? "Interviewer" : "Participant";
}

function getSpeakerOccurrenceCount(rawSpeaker) {
    const sourceSpeaker = normalizeSpeakerName(rawSpeaker);
    if (!sourceSpeaker) return 0;
    const interview = transcriptsObject.transcripts[currentParticipant] || [];
    return interview.filter(cue => normalizeSpeakerName(getCueOriginalSpeaker(cue)) === sourceSpeaker).length;
}

function refreshSpeakerRoleButtons() {
    const interview = transcriptsObject.transcripts[currentParticipant] || [];
    document.querySelectorAll(".speaker-role-button[data-block-index]").forEach(button => {
        const blockIndex = parseInt(button.dataset.blockIndex, 10);
        const cue = interview[blockIndex];
        if (!cue) return;

        const rawSpeaker = getCueOriginalSpeaker(cue);
        button.dataset.speakerRaw = rawSpeaker;
        button.textContent = resolveCueSpeakerLabel(cue, currentParticipant);
        button.title = rawSpeaker
            ? `Tag all "${rawSpeaker}" speaker labels`
            : "Tag speaker labels";
    });
}

function ensureSpeakerRoleMenu() {
    if (document.getElementById("speakerRoleMenu")) return;

    d3.select("body").append("div")
        .attr("id", "speakerRoleMenu")
        .style("display", "none")
        .style("position", "absolute")
        .style("z-index", "1100");

    d3.select("body").on("mousedown.speakerRoleMenu", function() {
        const target = d3.event && d3.event.target;
        if (
            target &&
            !target.closest("#speakerRoleMenu") &&
            !target.closest(".speaker-role-button")
        ) {
            hideSpeakerRoleMenu();
        }
    });
}

function hideSpeakerRoleMenu() {
    d3.select("#speakerRoleMenu").style("display", "none").html("");
}

function showSpeakerRoleMenu(x, y, rawSpeaker) {
    const speakerName = String(rawSpeaker || "").trim();
    if (!speakerName) return;

    ensureSpeakerRoleMenu();
    const occurrenceCount = getSpeakerOccurrenceCount(speakerName);
    const menu = d3.select("#speakerRoleMenu");
    menu.html("");

    menu.append("div")
        .attr("class", "speaker-role-title")
        .text(speakerName);
    menu.append("div")
        .attr("class", "speaker-role-count")
        .text(`${occurrenceCount} ${occurrenceCount === 1 ? "line" : "lines"}`);

    const actions = menu.append("div").attr("class", "speaker-role-actions");
    actions.append("button")
        .attr("type", "button")
        .text("Interviewer")
        .on("click", () => applySpeakerRole(speakerName, "interviewer"));
    actions.append("button")
        .attr("type", "button")
        .text("Participant")
        .on("click", () => applySpeakerRole(speakerName, "participant"));

    menu.append("div").attr("class", "speaker-role-status");
    menu.style("display", "block")
        .style("left", `${x}px`)
        .style("top", `${y}px`);
}

function normalizeExcerptMatchText(value) {
    return String(value || "")
        .replace(/[“”]/g, "\"")
        .replace(/[‘’]/g, "'")
        .replace(/[^a-z0-9]+/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

const INFORMATIVE_EXCERPT_STOP_WORDS = new Set([
    "the", "and", "that", "this", "with", "from", "have", "has", "had",
    "for", "you", "your", "are", "was", "were", "but", "not", "can",
    "could", "would", "should", "about", "like", "just", "really"
]);

function informativeExcerptTokens(value) {
    return normalizeExcerptMatchText(value)
        .split(/[^a-z0-9]+/i)
        .filter(token => token.length > 2 && !INFORMATIVE_EXCERPT_STOP_WORDS.has(token));
}

function normalizeExcerptTimestamp(value) {
    return String(value || "")
        .replace(/\s+/g, "")
        .trim();
}

function selectedExcerptMatchesCue(wordDef, cue) {
    const entry = buildThemeExcerptEntry(wordDef);
    if (!entry || !cue) return false;
    const strictCueMatch = isManualCodeEntry(entry);

    const entryParticipant = normalizeExcerptMatchText(entry.participant);
    const cueParticipant = normalizeExcerptMatchText(currentParticipant);
    if (entryParticipant && cueParticipant && entryParticipant !== cueParticipant) {
        return false;
    }
    if (entry.segmentId && cue.segmentId) {
        return entry.segmentId === cue.segmentId;
    }

    const entryTag = normalizeQATag(entry.tag);
    const cueTags = getCueQATags(cue);
    const tagMatchesCue = entryTag && cueTags.some(cueTag => qaTagsCompatible(entryTag, cueTag));
    if (entryTag && cueTags.length > 0 && !tagMatchesCue) {
        return false;
    }

    const entryTimestamp = normalizeExcerptTimestamp(entry.timestamp);
    const cueTimestamp = normalizeExcerptTimestamp(cue.timestamp);
    if (entryTimestamp && cueTimestamp) {
        return entryTimestamp === cueTimestamp;
    }

    const cueText = normalizeExcerptMatchText(cue.script);
    const entryCueText = normalizeExcerptMatchText(entry.cueText);
    if (entryCueText && cueText && entryCueText === cueText) {
        return true;
    }

    const excerptText = normalizeExcerptMatchText(entry.word);
    if (excerptText && cueText && cueText.includes(excerptText)) {
        return true;
    }
    if (excerptText && cueText && excerptText.includes(cueText)) {
        return true;
    }
    if (strictCueMatch) {
        return false;
    }

    const excerptTokens = informativeExcerptTokens(`${excerptText} ${entryCueText}`);
    if (excerptTokens.length === 0) return false;
    const cueTokenSet = new Set(informativeExcerptTokens(cueText));
    const overlap = excerptTokens.filter(token => cueTokenSet.has(token)).length;
    if (tagMatchesCue && overlap >= Math.min(2, excerptTokens.length)) {
        return true;
    }
    if (excerptTokens.length <= 3) return overlap >= Math.min(2, excerptTokens.length);
    return overlap >= 3 && overlap / excerptTokens.length >= 0.55;
}

function selectedThemeWordsForCue(themeData, cue) {
    const words = Array.isArray(themeData && themeData.words) ? themeData.words : [];
    return words.filter(wordDef => selectedExcerptMatchesCue(wordDef, cue));
}

function sourceLooksHumanSelected(source) {
    return [
        "manual",
        "human",
        "human_ai",
        "human+ai",
        "both",
        "human_manual_code",
        "manual_code",
        "user",
        "user_manual"
    ].includes(String(source || "").trim().toLowerCase());
}

function sourceLooksUserSelected(source) {
    return [
        "matching_excerpts",
        "matched_excerpts",
        "selected_excerpts",
        "selected",
        "user_selected",
        "apply_codes",
        "applied_codes",
        "ai_generate_more_codes",
        "ai_more_codes_generated"
    ].includes(String(source || "").trim().toLowerCase());
}

function isUserSelectedOrMatchedExcerpt(wordDef, themeData) {
    if (!wordDef || typeof wordDef !== "object") {
        const themeSource = String(themeData && (themeData.codeSource || themeData.source || themeData.tagSource) || "").trim();
        return sourceLooksHumanSelected(themeSource);
    }

    const source = String(wordDef.codeSource || wordDef.source || wordDef.tagSource || "").trim();
    const selectionSource = String(wordDef.selectionSource || wordDef.selection_source || "").trim();
    return (
        currentThemePayloadIsAppliedSelection ||
        wordDef.selectedByUser === true ||
        wordDef.userSelected === true ||
        wordDef.matchedByUser === true ||
        wordDef.humanTagged === true ||
        wordDef.human_tagged === true ||
        wordDef.ai_generated === false ||
        sourceLooksHumanSelected(source) ||
        sourceLooksUserSelected(source) ||
        sourceLooksUserSelected(selectionSource)
    );
}

function getCodeLabel(themeData) {
    return readThemeName(themeData).replace(/_/g, " ");
}

function getActiveSelectionText() {
    const selectedText = String(window.selectedTextForNote?.text || "").trim();
    if (selectedText) return selectedText;
    return String(window.selectedRange?.toString?.() || "").trim();
}

function getContainedScriptSelection(scriptBlock) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

    const range = selection.getRangeAt(0);
    if (!scriptBlock.contains(range.startContainer) || !scriptBlock.contains(range.endContainer)) {
        return null;
    }

    const rawSelectedText = range.toString();
    const selectedText = rawSelectedText.trim();
    if (!selectedText) return null;

    const preSelectionRange = document.createRange();
    preSelectionRange.selectNodeContents(scriptBlock);
    preSelectionRange.setEnd(range.startContainer, range.startOffset);
    const startIndex = preSelectionRange.toString().length;
    const endIndex = startIndex + rawSelectedText.length;

    return {
        range,
        selectedText,
        startIndex,
        endIndex
    };
}

function getCodeEntriesForCue(code, cue) {
    if (!code || !Array.isArray(code.words)) return [];
    return code.words
        .map(wordEntry => buildThemeExcerptEntry(wordEntry))
        .filter(wordEntry => wordEntry && selectedExcerptMatchesCue(wordEntry, cue));
}

function codeHasCurrentSelection(code, cue) {
    const selectedText = getActiveSelectionText();
    if (!selectedText || !code || !Array.isArray(code.words)) return false;

    const selectionEntry = buildManualTagWordEntry(selectedText, cue);
    const selectionKey = buildThemeWordIdentityKey(selectionEntry);
    if (!selectionKey) return false;

    return code.words.some(wordEntry => buildThemeWordIdentityKey(wordEntry) === selectionKey);
}

function updateTagMenuCodeSummary(cue) {
    const summary = d3.select("#tagMenuCodeSummary");
    if (summary.empty()) return;

    const codeCount = getActiveTranscriptCodes(themesObject)
        .filter(themeData => getCodeEntriesForCue(themeData, cue).length > 0).length;

    summary.text(`${codeCount} code${codeCount === 1 ? "" : "s"} on this segment`);
}

function updateTagMenuStatus(message, tone = "neutral") {
    const status = d3.select("#tagMenuCodeStatus");
    if (status.empty()) return;
    status
        .attr("data-tone", tone)
        .text(message || "");
}

function refreshVisibleTagMenu() {
    const tagMenu = d3.select("#tagMenu");
    if (tagMenu.empty() || tagMenu.style("display") === "none") return;

    const interview = transcriptsObject.transcripts[currentParticipant] || [];
    populateTagMenu(d3.select("#tagMenuOptions"), themesObject, interview);
    updateTagMenuCodeSummary(interview[currentJ]);
}

function getCueNoteSelections(cue, participant = currentParticipant) {
    if (!cue) return [];
    const noteKey = getCueNoteKey(cue, participant, notesData);
    const noteEntry = cue.notes || notesData[noteKey] || {};
    return Array.isArray(noteEntry.selections)
        ? noteEntry.selections.filter(selection => selection && typeof selection === "object")
        : [];
}

function openNoteEditor(selectionData, cue, j, theme, participant, pageX, pageY) {
    if (!selectionData) return;
    currentJ = j;
    window.selectedTextForNote = { ...selectionData };
    showTagMenu(pageX, pageY, transcriptsObject.transcripts[participant], theme);
    activateTagMenuTab("notes");
}

function layoutNoteColumn(container, blockIndex) {
    const node = container && container.node ? container.node() : null;
    const speechBlock = document.getElementById(`speechBlock_${blockIndex}`);
    if (!node || !speechBlock || !container.classed("has-notes")) return;

    const blockRect = speechBlock.getBoundingClientRect();
    const availableLeft = blockRect.left - NOTE_RAIL_SAFE_LEFT - NOTE_RAIL_GAP;
    const canUseLeftRail = availableLeft >= NOTE_RAIL_MIN_WIDTH;

    if (canUseLeftRail) {
        const width = Math.min(NOTE_RAIL_MAX_WIDTH, Math.floor(availableLeft));
        container
            .classed("is-inline", false)
            .style("position", "absolute")
            .style("left", `-${width + NOTE_RAIL_GAP}px`)
            .style("top", "42px")
            .style("width", `${width}px`)
            .style("max-width", `${width}px`)
            .style("margin", "0")
            .style("z-index", "5");
        return;
    }

    const inlineWidth = (window.innerWidth || document.documentElement.clientWidth || 0) <= 760
        ? "100%"
        : `${Math.min(170, Math.max(NOTE_RAIL_MIN_WIDTH, Math.floor(blockRect.width * 0.28)))}px`;
    container
        .classed("is-inline", true)
        .style("position", "static")
        .style("left", null)
        .style("top", null)
        .style("width", inlineWidth)
        .style("max-width", inlineWidth)
        .style("margin", "0 14px 10px 0")
        .style("z-index", null);
}

function layoutAllNoteColumns() {
    d3.selectAll(".transcript-note-column.has-notes").each(function() {
        const match = String(this.id || "").match(/^noteCommentColumn_(.+)$/);
        if (!match) return;
        layoutNoteColumn(d3.select(this), match[1]);
    });
}

function bindNoteRailResizeHandler() {
    if (noteRailResizeHandlerBound) return;
    noteRailResizeHandlerBound = true;
    window.addEventListener("resize", debounce(layoutAllNoteColumns, 120));
}

function appendNoteCommentCards(container, cue, j, theme, participant) {
    container.html("");
    const selections = getCueNoteSelections(cue, participant);
    container.classed("has-notes", selections.length > 0);
    if (!selections.length) return;

    selections.forEach((selectionData, index) => {
        const card = container.append("button")
            .attr("type", "button")
            .attr("class", "note-comment-card")
            .attr("aria-label", `Open note ${index + 1}`)
            .on("click", function() {
                d3.event.preventDefault();
                d3.event.stopPropagation();
                openNoteEditor(selectionData, cue, j, theme, participant, d3.event.pageX, d3.event.pageY);
            });

        card.append("div")
            .attr("class", "note-comment-quote")
            .text(selectionData.text || "Selected transcript text");
        card.append("div")
            .attr("class", "note-comment-text")
            .text(selectionData.note || "Add a comment...");
    });
    window.requestAnimationFrame(() => layoutNoteColumn(container, j));
}

function bindNoteHighlightHandlers(scriptSelection, cue, j, theme, participant) {
    scriptSelection.selectAll(".note-highlight")
        .on("click", function() {
            d3.event.stopPropagation();

            const startIndex = parseInt(d3.select(this).attr("data-start-index"));
            currentJ = j;

            const noteEntry = notesData[getCueNoteKey(cue, participant, notesData)];
            if (noteEntry && noteEntry.selections) {
                const selectionData = noteEntry.selections.find(sel => sel.start === startIndex);
                if (selectionData) {
                    openNoteEditor(selectionData, cue, j, theme, participant, d3.event.pageX, d3.event.pageY);
                }
            }
        });
}

function appendAppliedCodeChips(container, cue, theme, blockIndex) {
    container.html("");
    const activeThemes = getActiveTranscriptCodes(theme)
        .filter(themeData => getCodeEntriesForCue(themeData, cue).length > 0);

    if (activeThemes.length === 0) return;

    container.append("span")
        .attr("class", "applied-code-label")
        .text("Code tags");

    activeThemes.forEach(themeData => {
        const sourceInfo = getCueThemeSourceInfo(themeData, cue);
        const chip = container.append("span")
            .attr("class", "applied-code-chip")
            .attr("title", sourceInfo.title)
            .style("--code-color", themeData.color || "#579AE2");

        chip.append("span")
            .attr("class", "applied-code-dot")
            .style("background-color", themeData.color || "#579AE2");

        chip.append("span")
            .attr("class", "applied-code-name")
            .text(getCodeLabel(themeData));

        appendThemeSourceBadge(chip, sourceInfo);

        chip.append("button")
            .attr("type", "button")
            .attr("class", "remove-code-chip")
            .attr("aria-label", `Remove ${getCodeLabel(themeData)} code`)
            .text("×")
            .on("click", function() {
                d3.event.preventDefault();
                d3.event.stopPropagation();
                removeCodeFromCue(themeData, cue, theme, blockIndex);
            });
    });
}

function refreshCueCodingUI(cue, theme, blockIndex = currentJ) {
    const index = String(blockIndex);
    const script = d3.select(`#script_${index}`);
    if (!script.empty()) {
        script.html(highlightWordsInScript(cue, theme));
        bindNoteHighlightHandlers(script, cue, index, theme, currentParticipant);
    }

    const chipContainer = d3.select(`#appliedCodeChips_${index}`);
    if (!chipContainer.empty()) {
        appendAppliedCodeChips(chipContainer, cue, theme, index);
    }

    const barContainer = d3.select(`#themeBarContainer_${index}`);
    if (!barContainer.empty()) {
        addVerticalThemeBars(barContainer, cue, theme);
    }

    const noteColumn = d3.select(`#noteCommentColumn_${index}`);
    if (!noteColumn.empty()) {
        appendNoteCommentCards(noteColumn, cue, index, theme, currentParticipant);
    }
}

function isManualCodeEntry(wordDef) {
    if (!wordDef || typeof wordDef !== "object") return false;
    const source = String(wordDef.codeSource || wordDef.source || wordDef.tagSource || "").trim().toLowerCase();
    if (source === "manual" || source === "human" || source === "human_ai" || source === "human+ai" || source === "both") return true;
    if (source === "ai" || source === "llm" || source === "cloud") return false;
    if (wordDef.humanTagged === true || wordDef.human_tagged === true) return true;
    return wordDef.ai_generated === false;
}

function isAiGeneratedCodeEntry(entry) {
    if (!entry) return false;
    if (typeof entry !== "object") return Boolean(String(entry).trim());
    const source = String(entry.codeSource || entry.source || entry.tagSource || "").trim().toLowerCase();
    if (source === "human_ai" || source === "human+ai" || source === "both") return true;
    if (entry.aiTagged === true || entry.ai_tagged === true) return true;
    return !isManualCodeEntry(entry);
}

function themeHasAiGeneratedEntries(themeData) {
    if (!themeData || typeof themeData !== "object") return false;
    const source = String(themeData.codeSource || themeData.source || themeData.tagSource || "").trim().toLowerCase();
    if (source === "human_ai" || source === "human+ai" || source === "both") return true;
    if (source === "manual" || source === "human") return false;
    if (source === "ai" || source === "llm" || source === "cloud") return true;
    if (themeData.aiTagged === true || themeData.ai_tagged === true) return true;
    if (themeData.ai_generated === true) return true;
    if (themeData.ai_generated === false) return false;

    const entries = [
        ...(Array.isArray(themeData.words) ? themeData.words : []),
        ...(Array.isArray(themeData.quotes) ? themeData.quotes : [])
    ];
    return entries.some(isAiGeneratedCodeEntry);
}

function isAiGeneratedCode(themeData) {
    const themeName = readThemeName(themeData);
    return themeHasAiGeneratedEntries(themeData) || aiGeneratedCodeKeys.has(normalizeCodeNameKey(themeName));
}

function getCueThemeSourceInfo(themeData, cue) {
    const matchedEntries = selectedThemeWordsForCue(themeData, cue);
    let hasHuman = matchedEntries.some(isManualCodeEntry);
    let hasAi = matchedEntries.some(isAiGeneratedCodeEntry);

    if (matchedEntries.length === 0) {
        hasHuman = !themeHasAiGeneratedEntries(themeData);
        hasAi = isAiGeneratedCode(themeData);
    }

    if (hasHuman && hasAi) {
        return {
            label: "Human + AI",
            className: "is-human-ai",
            title: `${getCodeLabel(themeData)} has both human-coded and AI-tagged excerpts on this segment.`
        };
    }

    if (hasHuman) {
        return {
            label: "Human code",
            className: "is-human",
            title: `${getCodeLabel(themeData)} was manually applied by a user on this segment.`
        };
    }

    if (hasAi) {
        return {
            label: "AI code",
            className: "is-ai",
            title: `${getCodeLabel(themeData)} was suggested by AI on this segment.`
        };
    }

    return {
        label: "Code",
        className: "is-neutral",
        title: `${getCodeLabel(themeData)} is applied on this segment.`
    };
}

function appendThemeSourceBadge(parent, sourceInfo) {
    const badge = parent.append("span")
        .attr("class", `theme-source-badge ${sourceInfo.className}`)
        .attr("role", "img")
        .attr("tabindex", "0")
        .attr("title", sourceInfo.title)
        .attr("aria-label", sourceInfo.title);
    const humanPath = "M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8";
    const aiPath = "m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3M20 2v4m-2-2h4";
    if (sourceInfo.className === "is-human" || sourceInfo.className === "is-human-ai") {
        appendCodeSourceIcon(badge, humanPath);
    }
    if (sourceInfo.className === "is-ai" || sourceInfo.className === "is-human-ai") {
        appendCodeSourceIcon(badge, aiPath);
    }
    if (sourceInfo.className === "is-neutral") badge.text(sourceInfo.label);
    return badge;
}

function appendCodeSourceIcon(badge, path) {
    badge.append("svg")
        .attr("viewBox", "0 0 24 24")
        .attr("width", 16)
        .attr("height", 16)
        .attr("aria-hidden", "true")
        .attr("fill", "none")
        .attr("stroke", "currentColor")
        .attr("stroke-width", 1.8)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .append("path").attr("d", path);
}

function cueHasAiTaggedCode(cue, themePayload) {
    const themes = Array.isArray(themePayload && themePayload.themes) ? themePayload.themes : [];
    return themes.some(themeData =>
        selectedThemeWordsForCue(themeData, cue).some(isAiGeneratedCodeEntry)
    );
}

function appendAiTaggedBadge(parent) {
    return parent.append("span")
        .attr("class", "ai-tagged-badge")
        .style("display", "inline-flex")
        .style("align-items", "center")
        .style("margin-left", "8px")
        .style("padding", "2px 8px")
        .style("border-radius", "999px")
        .style("background", "#eef2ff")
        .style("color", "#2643b6")
        .style("font-size", "0.72em")
        .style("font-weight", "700")
        .style("line-height", "1.4")
        .style("white-space", "nowrap")
        .text("[AI-tagged]");
}

async function applySpeakerRole(rawSpeaker, targetRole) {
    if (speakerRoleSaveInFlight) return;

    const participant = currentParticipant;
    const context = transcriptRequestContext();
    const sourceSpeaker = String(rawSpeaker || "").trim();
    const sourceKey = normalizeSpeakerName(sourceSpeaker);
    if (!sourceKey) return;

    const targetLabel = canonicalSpeakerRoleLabel(targetRole);
    const menu = d3.select("#speakerRoleMenu");
    const status = menu.select(".speaker-role-status");
    speakerRoleSaveInFlight = true;
    menu.selectAll("button").property("disabled", true);
    status.text("Saving...");

    try {
        const response = await fetch(scopeAppPath("/api/tag_speaker_role"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...context, participant,
                speakerName: sourceSpeaker,
                targetRole
            })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || "Could not save speaker role.");
        }

        const savedSpeakerLabel = result.speaker || targetLabel;
        const interview = transcriptsObject.transcripts[participant] || [];
        interview.forEach(cue => {
            if (normalizeSpeakerName(getCueOriginalSpeaker(cue)) === sourceKey) {
                cue.speakerLabel = getCueOriginalSpeaker(cue);
                cue.speakerRole = targetRole;
                cue.speaker = savedSpeakerLabel;
            }
        });
        if (participant === currentParticipant) {
            refreshSpeakerRoleButtons();
            hideSpeakerRoleMenu();
        }
    } catch (error) {
        console.error("Failed to tag speaker role:", error);
        status.text(error.message || "Could not save.");
    } finally {
        speakerRoleSaveInFlight = false;
        menu.selectAll("button").property("disabled", false);
    }
}

function canRemoveAiQATag(cue) {
    if (!cue || typeof cue !== "object" || !normalizeQATag(cue.tag)) return false;
    const source = String(cue.tagSource || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(cue, "manualTag")) return false;
    // Older AI and demo tags may have no source field. Manual choices have
    // their own source or manualTag, including an intentional empty tag.
    return source === "ai" || source === "";
}

async function removeAiQATag(cue, blockIndex, participant) {
    if (participant !== currentParticipant || pendingQnaSaves.has(cue)) return false;
    if (!canRemoveAiQATag(cue)) return false;
    currentJ = blockIndex;
    return applyQATag("None");
}

function appendQATagBadge(container, rawTag, blockIndex = currentJ, participant = currentParticipant) {
    getDisplayedQATags(rawTag).forEach(tag => {
        const tagType = tag.charAt(0);
        const tagNumber = tag.slice(1);
        const tagLabel = tagType === "Q" ? "Question" : "Answer";
        const tagClass = tagType === "Q" ? "qa-tag-question" : "qa-tag-answer";

        container.append("span")
            .attr("class", `tag-badge qa-tag-badge ${tagClass}`)
            .attr("title", `${tagLabel} ${tagNumber}`)
            .attr("aria-label", `${tagLabel} ${tagNumber}`)
            .text(tag);
    });
    if (!canRemoveAiQATag(rawTag)) return;
    container.append("button")
        .attr("type", "button")
        .attr("class", "tag-badge qa-remove-ai-tag")
        .attr("title", "Remove this sentence's AI Q&A tag. You can undo this change.")
        .attr("aria-label", `Remove AI tag ${normalizeQATag(rawTag.tag)} from this sentence`)
        .style("background", "#fff")
        .style("border-color", "#d1d5db")
        .style("color", "#4b5563")
        .style("cursor", "pointer")
        .text("Remove AI tag")
        .on("click", function() {
            d3.event.preventDefault();
            d3.event.stopPropagation();
            void removeAiQATag(rawTag, blockIndex, participant);
        });
}

function appendQATagConflictBadge(container, cue, blockIndex = currentJ) {
    const conflict = getCueQnaConflict(cue);
    if (!conflict || !qnaReviewModeEnabled) return;

    const manualTag = normalizeQATag(conflict.manualTag) || "None";
    const aiSuggestedTag = normalizeQATag(conflict.aiSuggestedTag);
    const title = aiSuggestedTag
        ? `Human tag ${manualTag} conflicts with AI suggestion ${aiSuggestedTag}. Manual tag is kept.`
        : "Human Q&A tag conflicts with the AI suggestion. Manual tag is kept.";

    container.append("button")
        .attr("type", "button")
        .attr("class", "qa-conflict-badge")
        .attr("title", title)
        .attr("aria-label", title)
        .text("AI conflict")
        .on("click", function() {
            d3.event.preventDefault();
            d3.event.stopPropagation();
            currentJ = blockIndex;
            showQnaConflictReviewPopover(d3.event.pageX + 8, d3.event.pageY + 8, cue, blockIndex);
        });
}

function refreshSpeechBlockQATag(blockIndex, cueOrTag) {
    const info = d3.select(`#speechBlock_${blockIndex}`).select(".info");
    info.selectAll(".tag-badge, .qa-conflict-badge").remove();
    const cue = cueOrTag && typeof cueOrTag === "object"
        ? cueOrTag
        : (transcriptsObject.transcripts[currentParticipant] || [])[blockIndex];
    appendQATagBadge(info, cue && typeof cue === "object" ? cue : cueOrTag, blockIndex);
    if (cue && typeof cue === "object") {
        appendQATagConflictBadge(info, cue, blockIndex);
    }
}

function refreshAllSpeechBlockQATags() {
    const interview = transcriptsObject.transcripts[currentParticipant] || [];
    interview.forEach((cue, index) => {
        if (!d3.select(`#speechBlock_${index}`).empty()) {
            refreshSpeechBlockQATag(index, cue);
        }
    });
}

function debounce(fn, delay) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

export async function displayEditor(theme, participant) {
    currentParticipant = participant; // Store participant for use in other functions
    qnaReviewModeEnabled = true;
    ensureSpeakerRoleMenu();
    // console.log(`Displaying theme: ${theme}`);
    // console.log(`Displaying themesObject: ${themesObject}`);
    
    if (window.PROCESSED_TRANSCRIPTS_URL) {
    window.__transcriptUrl = window.PROCESSED_TRANSCRIPTS_URL;
    }

    // Prefer the server selection from /themes/edit so transcript mode never falls back to stale AI-generated themes.
    const [serverSelectedThemePayload, generatedCodeKeys] = await Promise.all([
        fetchSelectedThemePayload(),
        fetchAiGeneratedCodeKeys()
    ]);
    aiGeneratedCodeKeys = generatedCodeKeys;
    currentThemePayloadIsAppliedSelection = false;
    const storedThemePayload = getStoredThemePayload();
    const canonicalStoredThemePayload = storedThemePayload && Array.isArray(storedThemePayload.themes)
        ? buildPersistedThemePayload(storedThemePayload)
        : null;
    const selectedThemePayload = chooseTranscriptThemePayload(serverSelectedThemePayload, canonicalStoredThemePayload);
    const hasSavedThemeSelection = serverSelectedThemePayload?.selectedThemesExists === true || selectedThemePayload === canonicalStoredThemePayload;
    const shouldRespectEmptyUserSelection = selectedThemePayload && window.APP_MODE !== "demo";

    if (selectedThemePayload && (hasSavedThemeSelection || selectedThemePayload.themes.length > 0 || shouldRespectEmptyUserSelection)) {
        setCurrentTranscriptThemePayload(selectedThemePayload);
        persistThemePayload(selectedThemePayload, { syncRemote: false });
    } else if (canonicalStoredThemePayload && canonicalStoredThemePayload.themes.length > 0) {
        console.log("THEMES: Found persisted themes. Using them.");
        setCurrentTranscriptThemePayload(canonicalStoredThemePayload);
    } else {
        console.log("THEMES: No persisted themes found. Initializing from server data.");
        if (theme && Array.isArray(theme.themes)) {
            const canonicalThemePayload = buildPersistedThemePayload(theme);
            setCurrentTranscriptThemePayload(canonicalThemePayload);
            persistThemePayload(canonicalThemePayload, { syncRemote: false });
        }
    }
    initializeTranscriptThemePayloadSync();
    
    // 1. Load the FileMap from localStorage first. This is crucial.
    if (window.APP_MODE === 'demo') {
        console.log("EDITOR: Demo mode detected. Programmatically creating FileMap.");
        try {
            FileMap.participants = await buildDemoFileMap({ includeOriginalFilename: true });
        } catch (error) {
            console.warn("Falling back to hardcoded demo FileMap due to error:", error);
            FileMap.participants = [
                { participant: 'P3', audio: { relativePath: 'P3_trimmed.m4a' }, transcript: { relativePath: 'P3_Clean_Transcripts_trimmed.txt', originalFilename: 'P3_Clean_Transcripts_trimmed.txt' }},           
                { participant: 'P6', audio: { relativePath: 'P6_trimmed.m4a' }, transcript: { relativePath: 'P6_Clean_Transcripts_trimmed.txt', originalFilename: 'P6_Clean_Transcripts_trimmed.txt' }},
                { participant: 'P7', audio: { relativePath: 'P7_trimmed.m4a' }, transcript: { relativePath: 'P7_Clean_Transcripts_trimmed.txt', originalFilename: 'P7_Clean_Transcripts_trimmed.txt' }}
            ];
        }
    }
    else {
        console.log("EDITOR: User mode detected. Loading FileMap from localStorage.");   
        const projectId = getCurrentProjectId();
        let savedFileMap = await hydrateFileMapFromServer(projectId);
        if (!savedFileMap) savedFileMap = getStoredFileMap(projectId);
        if (savedFileMap) {
            FileMap.participants = savedFileMap.participants || [];
        } else {
            // Already processed transcripts can still be reviewed when an
            // upload has no saved recording/participant assignment.
            FileMap.participants = [];
        }
    }
    
    // 2. --- Pre-load all necessary data in parallel ---
    const [, , , , qnaConflictPayload] = await Promise.all([
        loadTranscripts(),
        loadNotes(),
        loadQuestionList(),
        loadQnaIntermediatePayload(),
        fetchQnaTagConflicts()
    ]);
    mergeQnaTagConflictsIntoTranscripts(qnaConflictPayload);
            
    const interview = transcriptsObject.transcripts[participant];
    // if (!theme || !theme.themes.length || !interview) {
    if (!interview) {
        showInfoPopup("Data Error: Could not find the necessary transcript data for this participant.");
        return;
    }

    allQTags = new Set();
    allATags = new Set();
    Object.values(transcriptsObject.transcripts)
        .filter(transcriptArray => Array.isArray(transcriptArray)) // <-- ADD THIS LINE
        .forEach(transcriptArray => {
            transcriptArray.forEach(cue => {
                const normalizedTag = normalizeQATag(cue.tag);
                if (normalizedTag) {
                    cue.tag = normalizedTag;
                    if (normalizedTag.startsWith('Q')) allQTags.add(normalizedTag);
                    else if (normalizedTag.startsWith('A')) allATags.add(normalizedTag);
                }
            });
        });

    // 4. Find the matched audio file for THIS participant in the FileMap.
    const participantMatch = findParticipantAudio(participant);
    if (!participantMatch || !participantMatch.audio || !participantMatch.audio.relativePath) {
        const audioElement = d3.select("#full-audiofile").node();
        if (audioElement) audioElement.pause();
        d3.select("#full-audiofile").attr("src", null);
        if (projectHasAnyMatchedAudio() && !isAudioNoticeDismissed(participant)) {
            showInfoPopup(
                `Audio file for ${participant} not found. Please ensure it was matched correctly.`,
                {
                    className: "audio-missing-popup",
                    onClose: () => markAudioNoticeDismissed(participant)
                }
            );
        }
    } else {
        // Switching to a participant that has audio: close any leftover audio popup.
        d3.select("#infoPopup.audio-missing-popup").remove();

        // 5. Construct the server URL and set the audio player's source.
        const audioSrc = buildServeAudioUrl(participantMatch.audio);
        if (audioSrc) {
            d3.select("#full-audiofile").attr("src", audioSrc);
        } else {
            showInfoPopup(`Audio file for ${participant} has an invalid path.`);
        }
    }

    // 6.Show settings tab and main page
    d3.select("#settings-page").style("display", "flex");
    d3.select("#main-page").style("display", "flex");
    const editor = d3.select("#editorContent");
    editor.html("");

    // Create white card container
    const whiteCard = editor.append("div")
        .attr("class", "transcript-editor-card")
        .style("background-color", "#ffffff")
        .style("border-radius", "12px")
        .style("box-shadow", "0 8px 24px rgba(15, 23, 42, 0.08)")
        .style("padding", "24px 28px")
        .style("margin", "0 auto")
        .style("width", "100%")
        .style("max-width", "1180px")
        .style("min-height", "calc(100% - 48px)");

    setupAudioControls(interview);

    interview.forEach((cue, j) => {
        const noteKey = getCueNoteKey(cue, participant, notesData);
        if (notesData[noteKey]) cue.notes = notesData[noteKey];
        renderSpeechBlock(whiteCard, cue, j, themesObject, participant);
    });
    bindNoteRailResizeHandler();
    layoutAllNoteColumns();
    renderQnaReviewExperience();
    
    setupTaggingMenu(interview, themesObject);
}


function bindTranscriptTextAutosave(scriptSide, script, cue, participant) {
    if (window.APP_MODE === 'demo') return;

    const context = transcriptRequestContext();
    const fileKey = getCurrentTranscriptFileKey();
    const relativePath = getCurrentTranscriptRelativePath();
    let editVersion = 0;
    let saveQueue = Promise.resolve();
    const saveStatus = scriptSide.append("div")
        .attr("class", "transcript-save-status")
        .attr("role", "status");

    async function saveSnapshot(snapshot) {
        saveStatus.text("Saving text…");
        try {
            const response = await fetch(scopeAppPath('/api/save_transcript_edit'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: snapshot.requestBody,
                keepalive: true,
                signal: AbortSignal.timeout(15000)
            });
            if (!response.ok) throw new Error("The transcript edit could not be saved.");
            if (snapshot.version !== editVersion) return;

            // A response for an older edit must not replace the latest text.
            cue.script = snapshot.plainText;
            pendingTextSaves.delete(cue);
            saveStatus.text("Saved");
        } catch (error) {
            saveStatus.text("Text not saved. Keep this page open and edit the text to retry.");
        }
    }

    function queueTextSave() {
        const plainText = script.node().innerText || script.node().textContent || "";
        const snapshot = {
            version: editVersion,
            plainText,
            requestBody: JSON.stringify({
                ...context,
                participant,
                timestamp: cue.timestamp,
                segmentId: cue.segmentId,
                fileKey,
                relativePath,
                newText: plainText
            })
        };
        // Save edits in order, even if an earlier request failed.
        saveQueue = saveQueue.catch(() => {}).then(() => saveSnapshot(snapshot));
    }

    const saveText = debounce(queueTextSave, 1000);
    script.on("input", () => {
        editVersion += 1;
        pendingTextSaves.add(cue);
        cue.script = script.node().innerText || script.node().textContent || "";
        saveStatus.text("Text not saved yet…");
        saveText();
    });
}


function renderSpeechBlock(editor, cue, j, theme, participant) {
    // Merge saved notes into the cue before rendering
    const noteKey = getCueNoteKey(cue, participant, notesData);
    if (notesData[noteKey]) {
        cue.notes = notesData[noteKey]; // Now an object: {note, selectedText}
    } else {
        delete cue.notes;
    }

    const speechBlock = editor.append("div")
        .attr("id", `speechBlock_${j}`)
        .attr("class", "speechBlock")
        .classed("has-qna-conflict", Boolean(getCueQnaConflict(cue)))
        .classed("qna-review-highlight", qnaReviewModeEnabled && Boolean(getCueQnaConflict(cue)))
        .style("width", "100%")
        .style("padding", "15px 20px")
        .style("margin-bottom", "12px")
        .style("background-color", "transparent")
        .style("border", "none")
        .style("box-shadow", "none")
        .style("position", "relative")
        .style("border-radius", "8px");
    
    const mainContainer = speechBlock.append("div")
        .style("display", "flex").style("align-items", "flex-start");

    const noteColumn = mainContainer.append("div")
        .attr("id", `noteCommentColumn_${j}`)
        .attr("class", "transcript-note-column");
    appendNoteCommentCards(noteColumn, cue, j, theme, participant);

    // --- CONTINUOUS BACKGROUND STYLING ---
    const scriptSide = mainContainer.append("div")
        .style("flex", "1")
        .style("min-width", "0")
        .style("border", "none")
        .style("border-radius", "0")
        .style("padding", "0")
        .style("background-color", "transparent");

    const info = scriptSide.append("div")
        .attr("class", "info transcript-cue-header")
        .style("display", "flex").style("align-items", "center").style("margin-bottom", "10px");
        
    const speaker = resolveCueSpeakerLabel(cue, participant);
    const rawSpeaker = getCueOriginalSpeaker(cue);
    info.append("button")
        .attr("type", "button")
        .attr("class", "speaker-label speaker-role-button")
        .attr("data-block-index", j)
        .attr("data-speaker-raw", rawSpeaker)
        .attr("title", rawSpeaker ? `Tag all "${rawSpeaker}" speaker labels` : "Tag speaker labels")
        .text(speaker)
        .on("click", function() {
            d3.event.stopPropagation();
            const selectedSpeaker = d3.select(this).attr("data-speaker-raw") || rawSpeaker || speaker;
            showSpeakerRoleMenu(d3.event.pageX, d3.event.pageY, selectedSpeaker);
        });
    appendQATagBadge(info, cue, j, participant);
    appendQATagConflictBadge(info, cue, j);
    info.append("span")
        .attr("class", "cue-timestamp")
        .style("font-size", "0.9em")
        .style("color", "#666")
        .text(cue.timestamp || "No timestamp");
    if (cueHasAiTaggedCode(cue, theme)) {
        appendAiTaggedBadge(info);
    }

    const script = scriptSide.append("div")
        .attr("id", `script_${j}`).attr("class", "script-block")
        .style("line-height", "1.6")
        .style("padding", "8px 0")
        .style("margin-bottom", "0")
        .style("word-wrap", "break-word")
        .style("word-break", "break-word")
        .style("white-space", "pre-wrap")
        .style("overflow-wrap", "break-word")
        .style("hyphens", "auto")
        .style("font-family", "'Inter', sans-serif")
        .style("font-size", "14px")
        .style("color", "#333")
        .style("background-color", "transparent")
        .style("border-radius", "0")
        .style("box-shadow", "none")
        .style("border", "none")
        .attr("contenteditable", "true")
        .html(highlightWordsInScript(cue, theme));
    bindTranscriptTextAutosave(scriptSide, script, cue, participant);
    bindNoteHighlightHandlers(script, cue, j, theme, participant);

    const codeChips = scriptSide.append("div")
        .attr("id", `appliedCodeChips_${j}`)
        .attr("class", "applied-code-chips");
    appendAppliedCodeChips(codeChips, cue, theme, j);

    const themeBarContainer = mainContainer.append("div")
        .attr("id", `themeBarContainer_${j}`)
        .style("display", "flex").style("flex-direction", "column").style("width", "200px");
    
    addVerticalThemeBars(themeBarContainer, cue, theme);

    speechBlock.on("click", function() {
        d3.selectAll(".speechBlock").classed("selected", false);
        d3.select(this).classed("selected", true);
        const fullAudio = d3.select("#full-audiofile").node();
        const timeInSeconds = getCueStartSeconds(cue);
        if (fullAudio && fullAudio.getAttribute("src") && timeInSeconds !== null) {
            fullAudio.currentTime = timeInSeconds;
        }
    });
}


function addVerticalThemeBars(container, cue, currentThemes) {
    container.html("");
    if (currentThemes && Array.isArray(currentThemes.themes))  {
        const activeThemesForCue = getActiveTranscriptCodes(currentThemes).filter(t => selectedThemeWordsForCue(t, cue).length > 0);
        
        activeThemesForCue.forEach(themeData => {
            const sourceInfo = getCueThemeSourceInfo(themeData, cue);
            const barWrapper = container.append("div").style("margin-bottom", "5px");
            const label = barWrapper.append("div")
                .style("display", "flex")
                .style("align-items", "center")
                .style("gap", "6px")
                .style("min-width", "0")
                .style("font-size", "0.8em")
                .style("color", "#555");
            label.append("span")
                .style("overflow", "hidden")
                .style("text-overflow", "ellipsis")
                .style("white-space", "nowrap")
                .text(themeData.themeName);
            appendThemeSourceBadge(label, sourceInfo);
            const bar = barWrapper.append("div").style("height", "8px").style("background-color", "#e0e0e0").style("border-radius", "4px").style("width", "100%");
            bar.append("div").style("height", "100%").style("width", "100%").style("background-color", themeData.color).style("border-radius", "4px");
        });
    }
}

function highlightWordsInScript(cue, theme) {
    const text = String(cue.script || "");
    const highlights = [];
    for (const code of getActiveTranscriptCodes(theme)) {
        const excerpts = selectedThemeWordsForCue(code, cue)
            .filter(excerpt => isUserSelectedOrMatchedExcerpt(excerpt, code));
        for (const excerpt of excerpts) {
            highlights.push(...findTextHighlights(text, excerpt.word, {
                className: "tagged-word",
                title: "Highlighted text was selected, matched, or manually coded by a user.",
                backgroundColor: hexToRGBA(code.color, 0.3)
            }));
        }
    }
    for (const note of cue.notes?.selections || []) {
        highlights.push({
            start: note.start, end: note.end,
            className: "note-highlight", title: `Note: ${note.note || ""}`
        });
    }
    // Offsets refer to the original text; imported text never becomes markup.
    return renderHighlightedText(text, highlights);
}

function activateTagMenuTab(tabName) {
    const activeTab = ["code", "qa", "notes"].includes(tabName) ? tabName : "code";
    d3.selectAll("#tagMenu .header-tab").classed("active", false);
    d3.select(`#tag-menu-tab-${activeTab}`).classed("active", true);
    d3.select("#code-panel").style("display", activeTab === "code" ? "block" : "none");
    d3.select("#qa-panel").style("display", activeTab === "qa" ? "block" : "none");
    d3.select("#notes-panel").style("display", activeTab === "notes" ? "block" : "none");
    const tagMenu = d3.select("#tagMenu");
    tagMenu
        .classed("is-note-comment-card", activeTab === "notes")
        .style("width", activeTab === "notes" ? "min(320px, calc(100vw - 112px))" : "min(1020px, calc(100vw - 72px))")
        .style("padding", activeTab === "notes" ? "12px" : "14px");
    if (!tagMenu.empty() && tagMenu.style("display") !== "none" && tagMenu.style("visibility") !== "hidden") {
        if (activeTab === "notes") {
            positionNoteMenuBesideTranscript();
        } else {
            const event = d3.event || {};
            positionTagMenuInViewport(
                parseFloat(tagMenu.style("left")) || event.pageX || window.scrollX + 24,
                parseFloat(tagMenu.style("top")) || event.pageY || window.scrollY + 24
            );
        }
    }
}

function setupTaggingMenu(interview, theme) {
    if (document.getElementById("tagMenu")) document.getElementById("tagMenu").remove();

    const tagMenu = d3.select("body").append("div")
        .attr("id", "tagMenu").style("display", "none").style("position", "absolute")
        .style("padding", "14px").style("background-color", "#ffffff")
        .style("border", "1px solid #d8dee9").style("border-radius", "10px")
        .style("box-shadow", "0px 12px 28px rgba(15, 23, 42, 0.18)").style("z-index", "1000")
        .style("width", "min(1020px, calc(100vw - 72px))")
        .style("max-height", "calc(100vh - 72px)")
        .style("overflow", "hidden");

    // --- Create the Structure from Image ---
    // 1. Code / Q&A / Notes Header
    const header = tagMenu.append("div").attr("class", "tag-menu-header");
    const codeTab = header.append("div").attr("id", "tag-menu-tab-code").attr("class", "header-tab active").text("Code");
    const qaTab = header.append("div").attr("id", "tag-menu-tab-qa").attr("class", "header-tab").text("Q&A");
    const notesTab = header.append("div").attr("id", "tag-menu-tab-notes").attr("class", "header-tab").text("Notes");
    
    // 2. Panel for Code/Themes
    const codePanel = tagMenu.append("div").attr("id", "code-panel").style("display", "block");
    const searchInput = codePanel.append("input").attr("type", "text")
                        .attr("placeholder", "Find or create new code")
                        .attr("class", "tag-menu-search")
                        .style("width", "100%").style("padding", "8px").style("margin-bottom", "10px")
                        .style("border", "1px solid #d8dee9").style("border-radius", "7px");
    codePanel.append("div").attr("id", "tagMenuCodeSummary").attr("class", "tag-menu-code-summary");
    codePanel.append("div").attr("id", "tagMenuOptions");
    codePanel.append("div").attr("id", "tagMenuCodeStatus").attr("class", "tag-menu-code-status");
    codePanel.append("button")
        .attr("type", "button")
        .attr("id", "tagMenuAddCodeButton")
        .attr("class", "qa-add-button")
        .text("+ Add New Code")
        .on("click", function() {
            d3.event.preventDefault();
            showInlineNewCodeForm(searchInput.property("value"));
        });
    const newCodeForm = codePanel.append("div")
        .attr("id", "tagMenuNewCodeForm")
        .attr("class", "new-code-inline-form")
        .style("display", "none");
    const newCodeInputRow = newCodeForm.append("div").attr("class", "new-code-inline-row");
    newCodeInputRow.append("input")
        .attr("id", "tagMenuNewCodeColor")
        .attr("type", "color")
        .attr("value", "#579AE2")
        .attr("aria-label", "New code color")
        .attr("class", "new-code-color-input");
    newCodeInputRow.append("input")
        .attr("id", "tagMenuNewCodeInput")
        .attr("type", "text")
        .attr("placeholder", "New code name")
        .attr("class", "new-code-name-input")
        .on("keydown", function() {
            const event = d3.event || window.event;
            if (event && event.key === "Enter") {
                event.preventDefault();
                createNewCodeFromPopover();
            }
            if (event && event.key === "Escape") {
                event.preventDefault();
                hideInlineNewCodeForm();
            }
        });
    const newCodeActions = newCodeForm.append("div").attr("class", "new-code-inline-actions");
    newCodeActions.append("button")
        .attr("type", "button")
        .attr("class", "new-code-cancel-button")
        .text("Cancel")
        .on("click", hideInlineNewCodeForm);
    newCodeActions.append("button")
        .attr("type", "button")
        .attr("class", "new-code-save-button")
        .text("Save code")
        .on("click", createNewCodeFromPopover);

    // 3. Panel for Q&A
    const qaPanel = tagMenu.append("div").attr("id", "qa-panel").style("display", "none");
    const radioContainer = qaPanel.append("div").attr("class", "qa-radio-group");
    radioContainer.append("label").html('<input type="radio" name="qa-type" value="Q" checked> Question');
    radioContainer.append("label").html('<input type="radio" name="qa-type" value="A"> Answer');
    
    // ONE container for BOTH Q and A lists. We will just change its content.
    qaPanel.append("div").attr("id", "qa-list-container");

    // 4. Panel for notes
    const notesPanel = tagMenu.append("div").attr("id", "notes-panel").style("display", "none");
    const noteArea = notesPanel.append("div").attr("class", "tag-menu-note-area");
    noteArea.append("div").attr("id", "tagMenuNoteSelection").attr("class", "note-selection-preview");
    noteArea.append("textarea").attr("id", "tagMenuNoteTextarea").attr("placeholder", "Add a comment...");
    noteArea.append("div").attr("id", "tagMenuNoteButtons");
    noteArea.append("div").attr("id", "tagMenuNoteStatus").attr("role", "status");

    // Add click logic to switch between panels
    codeTab.on("click", () => activateTagMenuTab("code"));
    qaTab.on("click", () => activateTagMenuTab("qa"));
    notesTab.on("click", () => activateTagMenuTab("notes"));

    // Radio Button Logic - now it will call a function to redraw the list
    tagMenu.selectAll('input[name="qa-type"]').on("change", function() {
        populateQAPanel(); // Redraw the list when the radio changes
    });
    
    searchInput.on("input", function() {
        const filterText = this.value.toLowerCase();
        codePanel.selectAll(".tag-option").style("display", function() {
            return d3.select(this).text().toLowerCase().includes(filterText) ? "flex" : "none";
        });
    });

    searchInput.on("keydown", function(event) {
        event = event || d3.event || window.event;
        if (event.key === "Enter" && this.value.trim() !== "") {
            event.preventDefault();
            showInlineNewCodeForm(this.value.trim());
            createNewCodeFromPopover();
        }
    });

    document.querySelectorAll(".script-block").forEach(scriptBlock => {
        scriptBlock.addEventListener("mouseup", function(event) {
            const selectionData = getContainedScriptSelection(this);
            if (selectionData) {
                window.selectedRange = selectionData.range; // For applyTag
                
                window.selectedTextForNote = {
                    text: selectionData.selectedText,
                    start: selectionData.startIndex,
                    end: selectionData.endIndex,
                    note:""
                };
                currentJ = this.id.split('_')[1];
                showTagMenu(event.pageX, event.pageY, interview, themesObject);
            }
        });
    });
     
    d3.select("body").on("mousedown.tagmenu", function() { 
        if (d3.event && !d3.event.target.closest("#tagMenu")) {
            hideTagMenu();
        }
    });
}

function populateTagMenu(container, currentThemes, interview) {
    container.html("");
    const currentCue = interview && currentJ !== undefined ? interview[currentJ] : null;
    updateTagMenuCodeSummary(currentCue);
    updateTagMenuStatus("");

    getActiveTranscriptCodes(themesObject).forEach(code => {
        const appliedToSelection = currentCue ? codeHasCurrentSelection(code, currentCue) : false;
        const cueEntryCount = currentCue ? getCodeEntriesForCue(code, currentCue).length : 0;

        const option = container.append("div")
            .attr("class", "tag-option")
            .classed("is-applied", appliedToSelection)
            .classed("is-on-segment", cueEntryCount > 0)
            .on("click", async () => {
                if (!getActiveSelectionText() || !currentCue) {
                    updateTagMenuStatus("Select transcript text first.", "warning");
                    return;
                }
                await applyTag(code, currentCue, themesObject, { keepMenuOpen: true });
            });

        option.append("div")
            .attr("class", "tag-option-color")
            .style("background-color", code.color || "#579AE2");

        const label = option.append("span")
            .attr("class", "tag-option-label");

        label.append("span")
            .attr("class", "tag-option-name")
            .text(getCodeLabel(code));
        if (isAiGeneratedCode(code)) {
            appendAiTaggedBadge(label);
        }

        const meta = option.append("span")
            .attr("class", "tag-option-meta");
        if (appliedToSelection) {
            meta.text("Added");
        } else if (cueEntryCount > 0) {
            meta.text(`${cueEntryCount} on segment`);
        } else {
            meta.text("Apply");
        }

        if (cueEntryCount > 0) {
            option.append("button")
                .attr("type", "button")
                .attr("class", "tag-option-remove")
                .attr("aria-label", `Remove ${getCodeLabel(code)} from segment`)
                .text("Remove")
                .on("click", async function() {
                    d3.event.preventDefault();
                    d3.event.stopPropagation();
                    await removeCodeFromCue(code, currentCue, themesObject, currentJ);
                });
        }
    });
}

function buildCueSpeakerLabel(cue, participantCode) {
    let speakerLabel = `Participant ${String(participantCode || "").replace(/^P/i, "")}`;
    if (cue && cue.tag && String(cue.tag).startsWith("A")) {
        speakerLabel += ` ${cue.tag}`;
    }
    return speakerLabel.trim();
}

function buildManualTagWordEntry(selectedText, cue) {
    return buildThemeExcerptEntry({
        word: selectedText,
        value: 1,
        stemmedWords: [],
        speaker: buildCueSpeakerLabel(cue, currentParticipant),
        participant: cue.participantId || currentParticipant,
        participantId: cue.participantId || currentParticipant,
        segmentId: cue.segmentId,
        sourceFile: cue.sourceFile || getCurrentTranscriptRelativePath() || getCurrentTranscriptFileKey(),
        tag: cue && cue.tag ? cue.tag : "",
        timestamp: cue && cue.timestamp ? cue.timestamp : "",
        cueText: cue && cue.script ? cue.script : "",
        ...manualCodeSelectionMetadata()
    });
}

async function syncDeleteThemeTag(code, wordEntry, cue) {
    const payload = {
        themeName: code.themeName,
        speaker: wordEntry.speaker || buildCueSpeakerLabel(cue, currentParticipant),
        text: wordEntry.word,
        participant: wordEntry.participant || currentParticipant,
        participantId: wordEntry.participantId || cue.participantId || currentParticipant,
        tag: wordEntry.tag || "",
        timestamp: wordEntry.timestamp || "",
        segmentId: wordEntry.segmentId || cue.segmentId,
        sourceFile: wordEntry.sourceFile || cue.sourceFile || getCurrentTranscriptRelativePath() || getCurrentTranscriptFileKey(),
        cueText: wordEntry.cueText || "",
    };

    const response = await fetch("/api/delete_theme_tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withProjectPayload(payload))
    });
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Server error");
    }
}

async function removeCodeFromCue(code, cue, currentThemes = themesObject, blockIndex = currentJ) {
    if (!code || !cue) return;
    return runUndoableCodeChange(code.themeName, `Remove ${getCodeLabel(code)}`, () =>
        saveCodeRemoval(code, cue, currentThemes, blockIndex)
    );
}

async function saveCodeRemoval(code, cue, currentThemes, blockIndex) {
    if (!code || !cue || !Array.isArray(code.words)) return;

    const removedEntries = [];
    code.words = code.words.filter(wordEntry => {
        const entry = buildThemeExcerptEntry(wordEntry);
        if (!entry) return true;
        if (selectedExcerptMatchesCue(entry, cue)) {
            removedEntries.push(entry);
            return false;
        }
        return true;
    });

    if (removedEntries.length === 0) {
        updateTagMenuStatus("No matching code to remove.", "warning");
        return;
    }

    const themesToPersist = currentThemes && Array.isArray(currentThemes.themes)
        ? currentThemes.themes
        : themesObject.themes;
    await persistThemePayload(
        buildManualCodeSyncPayload(themesToPersist),
        {
            throwOnError: true,
            rollbackOnError: true,
            manualDeletionIntent: {
                words: removedEntries.map(entry => ({
                    ...entry,
                    themeName: code.themeName
                }))
            }
        }
    );
    markCodeManagerSelectionComplete();

    try {
        await Promise.all(removedEntries.map(entry => syncDeleteThemeTag(code, entry, cue)));
    } catch (error) {
        console.warn("Failed to remove code from generated theme cache:", error);
    }

    refreshCueCodingUI(cue, currentThemes, blockIndex);
    refreshVisibleTagMenu();
    updateTagMenuStatus(`Removed ${getCodeLabel(code)}.`, "success");
    recordTranscriptWorkflowEvent("manual_code_removed", {
        codeName: code.themeName || "",
        timestamp: cue.timestamp || "",
        tag: cue.tag || "",
        removedCount: removedEntries.length
    }, { codeRemovals: removedEntries.length });
    recordAnalysisWorkflowAction("manual_coding", "code", "remove", {
        codeName: code.themeName || "",
        participant: currentParticipant || "",
        cueIndex: blockIndex,
        timestamp: cue.timestamp || "",
        tag: cue.tag || "",
        removedCount: removedEntries.length
    });
}

async function applyTag(code, cue, currentThemes, options = {}) {
    if (!code || !cue || transcriptHistory.state().undoing) return;
    const selectedText = getActiveSelectionText();
    const capturedOptions = {
        ...options,
        selectedText,
        nextWordEntry: buildManualTagWordEntry(selectedText, cue),
        blockIndex: currentJ
    };
    return runUndoableCodeChange(code.themeName, `Apply ${getCodeLabel(code)}`, () =>
        saveAppliedTag(code, cue, currentThemes, capturedOptions)
    );
}

async function saveAppliedTag(code, currentInterviewCue, currentThemes, options) {
    const selectedText = options.selectedText;
    if (!selectedText || !currentInterviewCue) {
        updateTagMenuStatus("Select transcript text first.", "warning");
        if (!options.keepMenuOpen) hideTagMenu();
        return;
    }

    const nextWordEntry = options.nextWordEntry;
    if (!nextWordEntry) {
        if (!options.keepMenuOpen) hideTagMenu();
        return;
    }

    if (!Array.isArray(code.words)) {
        code.words = [];
    }
    markCodeSelectedForSync(code);
    selectManualCodeForNewExcerpt(themesObject, code.themeName, nextWordEntry);

    const nextEntryKey = buildThemeWordIdentityKey(nextWordEntry);
    const hasExistingEntry = code.words.some(wordEntry =>
        buildThemeWordIdentityKey(wordEntry) === nextEntryKey
    );
    if (!hasExistingEntry) {
        code.words.push(nextWordEntry);
        code.words = dedupeThemeWordEntries(code.words);
    }

    if (!currentInterviewCue[code.themeName]) currentInterviewCue[code.themeName] = 0;
    currentInterviewCue[code.themeName] = selectedThemeWordsForCue(code, currentInterviewCue).length;

    refreshCueCodingUI(currentInterviewCue, currentThemes, options.blockIndex);

    window.getSelection().removeAllRanges();
    const themesToPersist = currentThemes && Array.isArray(currentThemes.themes)
        ? currentThemes.themes
        : themesObject.themes;
    await persistThemePayload(buildManualCodeSyncPayload(themesToPersist), { throwOnError: true, rollbackOnError: true });
    markCodeManagerSelectionComplete();

    if (hasExistingEntry) {
        updateTagMenuStatus(`${getCodeLabel(code)} already applied.`, "neutral");
        const metrics = transcriptTextMetrics(selectedText);
        recordTranscriptWorkflowEvent("manual_code_duplicate_apply", {
            codeName: code.themeName || "",
            timestamp: currentInterviewCue.timestamp || "",
            tag: currentInterviewCue.tag || "",
            selectedTextLength: metrics.textLength,
            selectedWordCount: metrics.wordCount
        }, { duplicateApplications: 1 });
        refreshVisibleTagMenu();
        return;
    }

    const payload = {
        themeName: code.themeName,
        speaker: nextWordEntry.speaker || buildCueSpeakerLabel(currentInterviewCue, currentParticipant),
        text: nextWordEntry.word,
        participant: nextWordEntry.participant || currentParticipant,
        participantId: nextWordEntry.participantId || currentInterviewCue.participantId || currentParticipant,
        tag: nextWordEntry.tag || "",
        timestamp: nextWordEntry.timestamp || "",
        segmentId: nextWordEntry.segmentId || currentInterviewCue.segmentId,
        sourceFile: nextWordEntry.sourceFile || currentInterviewCue.sourceFile || getCurrentTranscriptRelativePath() || getCurrentTranscriptFileKey(),
        cueText: nextWordEntry.cueText || "",
        ai_generated: false,
        codeSource: "manual"
    };

    try {
        const response = await fetch('/api/save_theme_tag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withProjectPayload(payload))
        });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.error || "Server error");
        }
        console.log("Code tag saved to ai_generated.json successfully.");
        const metrics = transcriptTextMetrics(selectedText);
        recordTranscriptWorkflowEvent("manual_code_applied", {
            codeName: code.themeName || "",
            timestamp: nextWordEntry.timestamp || "",
            tag: nextWordEntry.tag || "",
            speaker: nextWordEntry.speaker || "",
            selectedTextLength: metrics.textLength,
            selectedWordCount: metrics.wordCount
        }, { codeApplications: 1 });
        recordAnalysisWorkflowAction("manual_coding", "code", "apply", {
            codeName: code.themeName || "",
            participant: nextWordEntry.participant || currentParticipant || "",
            cueIndex: currentJ,
            timestamp: nextWordEntry.timestamp || "",
            tag: nextWordEntry.tag || "",
            speaker: nextWordEntry.speaker || "",
            selectedTextLength: metrics.textLength,
            selectedWordCount: metrics.wordCount
        });
    } catch (error) {
        console.error("Failed to save code tag to server:", error);
        alert("Error: Could not save code tag to server.");
    }

    refreshVisibleTagMenu();
    updateTagMenuStatus(`Added ${getCodeLabel(code)}.`, "success");
    if (!options.keepMenuOpen) hideTagMenu();
}


function hideTagMenu() {
    d3.select("#tagMenu").style("display", "none");
}

function showInfoPopup(message, { onClose, className = "" } = {}) {
    d3.select("#infoPopup").remove();               // never stack popups
    const popup = d3.select("body").append("div")
        .attr("id", "infoPopup")
        .attr("class", className)
        .attr("role", "dialog")
        .style("position", "fixed").style("top", "50%").style("left", "50%")
        .style("transform", "translate(-50%, -50%)").style("padding", "20px")
        .style("background", "white").style("border", "1px solid #ccc")
        .style("box-shadow", "0 4px 8px rgba(0,0,0,0.2)").style("z-index", "2000");
    popup.append("p").text(message);
    popup.append("button")
        .attr("type", "button")
        .text("Close")
        .on("click", () => {
            popup.remove();
            if (typeof onClose === "function") onClose();
        });
}

function audioNoticeDismissedKey(participant) {
    const scope = getProjectStorageScope() || "default";
    const participantKey = normalizeThemeParticipantId(participant) || String(participant || "");
    return `audioMissingNoticeDismissed_${scope}__${participantKey}`;
}

function isAudioNoticeDismissed(participant) {
    try {
        return localStorage.getItem(audioNoticeDismissedKey(participant)) === "1";
    } catch {
        return false;
    }
}

function markAudioNoticeDismissed(participant) {
    try {
        localStorage.setItem(audioNoticeDismissedKey(participant), "1");
    } catch {
    }
}

function hexToRGBA(hex, alpha) {
    if(!hex) return 'rgba(200,200,200,0.1)';
    hex = hex.replace(/^#/, '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function setupAudioControls(interview) {
    let fullAudio = d3.select("#full-audiofile").node();
    if (!fullAudio) return;
    let fullSlider = d3.select("#full-slider");
    let currentTimeDisplay = d3.select("#full-current-time");
    let durationDisplay = d3.select("#full-duration");
    const playPauseHolder = d3.select("#full-play-pause-holder");
    const playPauseIcon = d3.select("#full-play-pause");

    function setPlayButtonState(isPlaying) {
        playPauseHolder.attr("class", isPlaying ? "pause" : "play");
        playPauseIcon.attr(
            "src",
            isPlaying
                ? "../static/images/pause-button.png"
                : "../static/images/play-button.png"
        );
    }

    setPlayButtonState(false);
    fullSlider.property("disabled", !fullAudio.getAttribute("src"));
    
    fullAudio.onloadedmetadata = function() {
        fullSlider.attr("max", fullAudio.duration);
        durationDisplay.text(new Date(fullAudio.duration * 1000).toISOString().substr(14, 5));
    };

    fullAudio.ontimeupdate = function() {
        fullSlider.property("value", fullAudio.currentTime);
        currentTimeDisplay.text(new Date(fullAudio.currentTime * 1000).toISOString().substr(14, 5));
    };

    fullSlider.on("input", function() {
        fullAudio.currentTime = this.value;
    });

    d3.select("#full-play-button").on("click", function() {
        if (!fullAudio.getAttribute("src")) return;
        if (fullAudio.paused) {
            fullAudio.play().catch(error => console.warn("The recording could not be played:", error));
        } else {
            fullAudio.pause();
        }
    });

    fullAudio.onplay = function() {
        setPlayButtonState(true);
    };

    fullAudio.onpause = function() {
        setPlayButtonState(false);
    };

    fullAudio.onended = function() {
        setPlayButtonState(false);
    };

    d3.select("#forwardcontrol").on("click", () => { fullAudio.currentTime += 10; });
    d3.select("#backwardcontrol").on("click", () => { fullAudio.currentTime -= 10; });
}

// --- HELPER to load the master question list ---
async function loadQuestionList() {
    try {
        const response = await fetch('/api/get_question_list');
        if (!response.ok) throw new Error("Failed to fetch question list");
        const data = await response.json();
        projectQuestionList = data.questions || [];
        console.log("Successfully loaded question list:", projectQuestionList.length);
    } catch (error) {
        console.error("Could not load question list:", error);
        projectQuestionList = [];
    }
}

async function loadQnaIntermediatePayload() {
    try {
        const response = await fetch(`/api/project_qna_tag_payload?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Failed to fetch Q&A intermediate payload");
        const data = await response.json();
        qnaIntermediatePayload = data && typeof data === "object"
            ? {
                questions: data.questions || {},
                answers: data.answers || {},
                possibleAnswers: data.possibleAnswers || {}
            }
            : { questions: {}, answers: {}, possibleAnswers: {} };
    } catch (error) {
        console.warn("Could not load Q&A answer text payload:", error);
        qnaIntermediatePayload = { questions: {}, answers: {}, possibleAnswers: {} };
    }
}

function positionTagMenuInViewport(x, y) {
    const tagMenu = d3.select("#tagMenu");
    const node = tagMenu.node();
    if (!node) return;

    const margin = 18;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const rect = node.getBoundingClientRect();
    const maxLeft = scrollX + Math.max(margin, viewportWidth - rect.width - margin);
    const maxTop = scrollY + Math.max(margin, viewportHeight - rect.height - margin);
    const left = Math.max(scrollX + margin, Math.min(Number(x) || scrollX + margin, maxLeft));
    const top = Math.max(scrollY + margin, Math.min(Number(y) || scrollY + margin, maxTop));

    tagMenu
        .style("left", `${left}px`)
        .style("top", `${top}px`)
        .style("visibility", "visible");
}

function positionNoteMenuBesideTranscript() {
    const tagMenu = d3.select("#tagMenu");
    const node = tagMenu.node();
    const speechBlock = document.getElementById(`speechBlock_${currentJ}`);
    if (!node || !speechBlock) {
        positionTagMenuInViewport(
            parseFloat(tagMenu.style("left")) || window.scrollX + 24,
            parseFloat(tagMenu.style("top")) || window.scrollY + 24
        );
        return;
    }

    const margin = 16;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const blockRect = speechBlock.getBoundingClientRect();
    const noteColumn = document.getElementById(`noteCommentColumn_${currentJ}`);
    if (noteColumn) {
        layoutNoteColumn(d3.select(noteColumn), currentJ);
    }
    const anchorRect = noteColumn ? noteColumn.getBoundingClientRect() : blockRect;
    const menuRect = node.getBoundingClientRect();
    const preferredLeft = scrollX + anchorRect.left;
    const fallbackLeft = scrollX + blockRect.left;
    const safeLeft = scrollX + NOTE_RAIL_SAFE_LEFT;
    const maxLeft = scrollX + viewportWidth - menuRect.width - margin;
    const minimumLeft = Math.min(safeLeft, maxLeft);
    const left = Math.max(minimumLeft, Math.min(preferredLeft <= maxLeft ? preferredLeft : fallbackLeft, maxLeft));
    const top = Math.max(
        scrollY + margin,
        Math.min(scrollY + anchorRect.top, scrollY + viewportHeight - menuRect.height - margin)
    );

    tagMenu
        .style("left", `${left}px`)
        .style("top", `${top}px`)
        .style("visibility", "visible");
}

// --- HELPER to show and populate the menu ---
function showTagMenu(x, y, interview, theme) {
    const tagMenu = d3.select("#tagMenu");
    const cue = interview[currentJ];

    const openingExistingNote = Boolean(
        window.selectedTextForNote
        && getCueNoteSelections(cue).some(selection => selection.start === window.selectedTextForNote.start)
    );
    activateTagMenuTab(openingExistingNote ? "notes" : "code");

    // Populate the theme options
    populateTagMenu(d3.select("#tagMenuOptions"), theme, interview);

    // Populate the note textarea with the existing note for this cue
    d3.select("#tagMenuNoteSelection")
        .text(window.selectedTextForNote && window.selectedTextForNote.text
            ? window.selectedTextForNote.text
            : "Selected transcript text");
    d3.select("#tagMenuNoteStatus").text("");
    const noteTextarea = d3.select("#tagMenuNoteTextarea");
    noteTextarea.property("value", window.selectedTextForNote && window.selectedTextForNote.note ? window.selectedTextForNote.note : "");

    // Get a reference to the button container
    const buttonContainer = d3.select("#tagMenuNoteButtons");
    buttonContainer.html(""); // Clear any old buttons

    // Add the new "Delete" button
    buttonContainer.append("button").text(openingExistingNote ? "Delete" : "Cancel")
        .attr("class", "delete-note-button")
        .on("click", () => {
            if (openingExistingNote) {
                deleteNote(cue, window.selectedTextForNote);
            } else {
                hideTagMenu();
            }
        });
    
    // Add the "Save Note" button
    buttonContainer.append("button").text("Save Note")
        .attr("class", "save-note-button")
        .on("click", () => {
            const newNoteText = noteTextarea.property("value");
            saveNote(cue, newNoteText, window.selectedTextForNote);
        });

    populateQAPanel();

    tagMenu
        .style("display", "block")
        .style("visibility", "hidden")
        .style("left", "0px")
        .style("top", "0px");
    if (openingExistingNote) {
        positionNoteMenuBesideTranscript();
    } else {
        positionTagMenuInViewport(x, y);
    }
    
    if (openingExistingNote) {
        noteTextarea.node().focus();
    }
}

function basenameFromPath(value) {
    return String(value || "").split(/[\\/]/).pop();
}

function getCurrentPossibleAnswersEntry() {
    const possibleAnswers = qnaIntermediatePayload && qnaIntermediatePayload.possibleAnswers;
    if (!possibleAnswers || typeof possibleAnswers !== "object") return null;

    const currentFileKey = getCurrentTranscriptFileKey();
    if (currentFileKey && possibleAnswers[currentFileKey]) return possibleAnswers[currentFileKey];

    const entries = Object.entries(possibleAnswers);
    const currentPath = currentFileKey.replace(/\\/g, "/");
    const exactPathMatches = entries.filter(([key, value]) => {
        const sourceFile = String(value?.sourceFile || value?.source_file || key).replace(/\\/g, "/");
        return currentPath && sourceFile === currentPath;
    });
    if (exactPathMatches.length === 1) return exactPathMatches[0][1];

    const participantId = normalizeThemeParticipantId(currentParticipant);
    const participantMatches = entries.filter(([, value]) => {
        const valueParticipant = normalizeThemeParticipantId(value?.participantId || value?.participant);
        return participantId && valueParticipant === participantId;
    });
    if (participantMatches.length === 1) return participantMatches[0][1];

    // Older analyses used basenames. Only use that fallback when it identifies
    // one file, so two folders named interview.txt cannot exchange answers.
    const currentBasename = basenameFromPath(currentFileKey).toLowerCase();
    const basenameMatches = entries.filter(([key, value]) => {
        const valueParticipant = normalizeThemeParticipantId(value?.participantId || value?.participant);
        const sameParticipant = !valueParticipant || valueParticipant === participantId;
        return sameParticipant && currentBasename && basenameFromPath(key).toLowerCase() === currentBasename;
    });
    if (basenameMatches.length === 1) return basenameMatches[0][1];

    const legacyParticipantId = /^P\d+$/i.test(participantId) ? getParticipantIdFromKey(participantId) : null;
    const legacyMatches = entries.filter(([key, value]) => {
        const keyParticipant = getParticipantIdFromKey(key);
        const valueParticipant = getParticipantIdFromKey(value && value.participant);
        return legacyParticipantId && (keyParticipant === legacyParticipantId || valueParticipant === legacyParticipantId);
    });
    return legacyMatches.length === 1 ? legacyMatches[0][1] : null;
}

function questionTagFromAnswerTag(answerTag) {
    const normalizedTag = normalizeQATag(answerTag);
    return normalizedTag && normalizedTag.startsWith("A") ? `Q${normalizedTag.slice(1)}` : "";
}

function getPossibleAnswerTextForTag(answerTag) {
    const qTag = questionTagFromAnswerTag(answerTag);
    if (!qTag) return "";
    const entry = getCurrentPossibleAnswersEntry();
    const questionEntry = entry && entry.questions && entry.questions[qTag];
    const possibleAnswers = questionEntry && questionEntry.possibleAnswers;
    if (!possibleAnswers || typeof possibleAnswers !== "object") return "";

    return Object.entries(possibleAnswers)
        .sort(([leftKey], [rightKey]) => {
            const leftNumber = Number(leftKey);
            const rightNumber = Number(rightKey);
            if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
            return String(leftKey).localeCompare(String(rightKey));
        })
        .map(([, value]) => String(value || "").trim())
        .filter(Boolean)
        .join(" ");
}

function getTranscriptAnswerTextForTag(answerTag) {
    const normalizedTag = normalizeQATag(answerTag);
    if (!normalizedTag) return "";
    const transcript = transcriptsObject.transcripts[currentParticipant] || [];
    return transcript
        .filter(cue => getDisplayedQATags(cue).includes(normalizedTag))
        .map(cue => String(cue && cue.script || "").trim())
        .filter(Boolean)
        .join(" ");
}

function getQuestionTextForAnswerTag(answerTag, fallbackQuestionText = "") {
    const qTag = questionTagFromAnswerTag(answerTag);
    const entry = getCurrentPossibleAnswersEntry();
    const questionEntry = entry && entry.questions && entry.questions[qTag];
    return String((questionEntry && questionEntry.question) || fallbackQuestionText || "").trim();
}

function getAnswerDisplayText(answerTag, fallbackQuestionText = "") {
    const possibleAnswerText = getPossibleAnswerTextForTag(answerTag);
    if (possibleAnswerText) return possibleAnswerText;
    const transcriptAnswerText = getTranscriptAnswerTextForTag(answerTag);
    if (transcriptAnswerText) return transcriptAnswerText;
    const questionText = getQuestionTextForAnswerTag(answerTag, fallbackQuestionText);
    return questionText ? `Answer to: ${questionText}` : "No answer excerpt available yet.";
}


function populateQAPanel() {
    const selectedType = d3.select('input[name="qa-type"]:checked').property("value"); // "Q" or "A"
    const listContainer = d3.select("#qa-list-container");
    listContainer.html(""); // Clear the container
    const currentCue = (transcriptsObject.transcripts[currentParticipant] || [])[currentJ];
    const conflict = getCueQnaConflict(currentCue);
    if (conflict && qnaReviewModeEnabled) {
        const manualTag = normalizeQATag(conflict.manualTag) || "None";
        const aiSuggestedTag = normalizeQATag(conflict.aiSuggestedTag);
        const conflictPanel = listContainer.append("div")
            .attr("class", "qa-conflict-panel");
        conflictPanel.append("div")
            .attr("class", "qa-conflict-panel-title")
            .text("AI conflict");
        conflictPanel.append("div")
            .attr("class", "qa-conflict-panel-text")
            .text(`Manual: ${manualTag} | AI: ${aiSuggestedTag || "None"}`);
        const actions = conflictPanel.append("div")
            .attr("class", "qa-conflict-actions");
        getQnaConflictReviewActions(conflict).slice(0, 3).forEach(actionDef => {
            actions.append("button")
                .attr("type", "button")
                .attr("class", `qa-conflict-action${actionDef.subtle ? " subtle" : ""}`)
                .text(actionDef.label)
                .on("click", function() {
                    d3.event.preventDefault();
                    d3.event.stopPropagation();
                    resolveQnaConflict(actionDef.action, conflict);
                });
        });
    }

    // Determine which list to show based on the radio button
    if (selectedType === 'Q') {
        listContainer.append("div").attr("class", "qa-list-header").text("Question");
        const qItems = listContainer.append("div").attr("class", "qa-list-items");
        
        projectQuestionList.forEach((questionText, index) => {
            const parsedQuestion = parseQuestionListItem(questionText, index);
            const qTag = `Q${parsedQuestion.label}`;
            const cleanText = parsedQuestion.text || String(questionText || "").trim();

            const listItem = qItems.append("div")
                .attr("class", "qa-list-item question-list-item")
                .attr("title", cleanText)
                .on("click", () => applyQATag(qTag));

            listItem.append("span").attr("class", "qa-tag").text(qTag);
            listItem.append("span").attr("class", "qa-text").text(cleanText);
        });
    } else { // selectedType === 'A'
        const answerHeader = listContainer.append("div").attr("class", "qa-list-header qa-list-header-row");
        answerHeader.append("span").text("Answer");
        answerHeader.append("span")
            .attr("class", "qa-help-trigger")
            .attr("tabindex", "0")
            .attr("title", "Answer rows show the full answer text when generated answer matches are available.")
            .attr("aria-label", "Answer rows show the full answer text when generated answer matches are available.")
            .text("(?)");
        const aItems = listContainer.append("div").attr("class", "qa-list-items");

        projectQuestionList.forEach((questionText, index) => {
            const parsedQuestion = parseQuestionListItem(questionText, index);
            const aTag = `A${parsedQuestion.label}`;
            const cleanText = parsedQuestion.text || String(questionText || "").trim();
            const answerText = getAnswerDisplayText(aTag, cleanText);
            const resolvedQuestionText = getQuestionTextForAnswerTag(aTag, cleanText);
            
            const listItem = aItems.append("div")
                .attr("class", "qa-list-item answer-list-item")
                .attr("title", answerText)
                .attr("aria-label", `${aTag}. ${answerText}`)
                .on("click", () => applyQATag(aTag));

            listItem.append("span")
                .attr("class", "qa-tag")
                .text(`${aTag}:`);

            const answerBody = listItem.append("span")
                .attr("class", "qa-answer-copy");
            answerBody.append("span")
                .attr("class", "qa-answer-text")
                .text(answerText);
            if (resolvedQuestionText && !answerText.includes(resolvedQuestionText)) {
                answerBody.append("span")
                    .attr("class", "qa-answer-question")
                    .text(`Question: ${resolvedQuestionText}`);
            }
        });
    }
    
    // Add the "+ Add New Question" button at the end
    listContainer.append("div")
        .attr("class", "qa-add-button")
        .text("+ Add New Question")
        .on("click", addNewQuestion);
}

// --- Function to handle adding a new question ---
async function addNewQuestion() {
    const selectedText = window.selectedTextForNote.text;
    if (!selectedText) {
        alert("Please highlight the text you want to add as a question first.");
        return;
    }

    // 1. Ask the user for the question label.
    const questionNumber = prompt("Please enter the new question label (e.g., 7 or 7a):");
    const labelMatch = String(questionNumber || "").trim().match(/^0*(\d+)([a-z]?)$/i);
    if (!labelMatch) {
        alert("Invalid label. Please enter a whole number or a follow-up label like 7a.");
        return; // Stop if the user cancels or enters invalid text
    }
    const questionLabel = `${parseInt(labelMatch[1], 10)}${(labelMatch[2] || "").toLowerCase()}`;

    // Create the correctly formatted string that the backend expects.
    const formattedQuestionText = `${questionLabel}. ${selectedText}`;
    const newQTag = `Q${questionLabel}`;


    try {
        const response = await fetch('/api/add_new_question', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question_text: formattedQuestionText })
        });
        
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.error || "Server error");
        }
        
        const result = await response.json();
        // The server sends back the complete, updated list of questions.
        // We update our global list with this new data.
        projectQuestionList = result.questions;

        // Now, we can re-populate the Q&A panel with the new list,
        // and apply the newly created tag.
        await applyQATag(newQTag);
       
        // Refresh the lists in the currently open menu to show the new question
        showTagMenu(
            parseFloat(d3.select("#tagMenu").style("left")), 
            parseFloat(d3.select("#tagMenu").style("top")), 
            transcriptsObject.transcripts[currentParticipant], 
            themesObject
        );

    } catch (error) {
        console.error("Failed to add new question:", error);
        alert("Could not add new question: " + error.message);
    }
}


function getCurrentTranscriptFileKey() {
    const sourcePath = getCurrentTranscriptRelativePath();
    if (sourcePath) return sourcePath;
    const participantEntry = (FileMap.participants || []).find(
        entry => normalizeThemeParticipantId(entry.participantId || entry.participant) === normalizeThemeParticipantId(currentParticipant)
    );
    return participantEntry?.transcript?.originalFilename || "";
}

function getCurrentTranscriptRelativePath() {
    const interview = transcriptsObject.transcripts[currentParticipant] || [];
    const currentCue = interview[currentJ];
    if (currentCue?.sourceFile) return currentCue.sourceFile;
    const participantEntry = (FileMap.participants || []).find(
        entry => normalizeThemeParticipantId(entry.participantId || entry.participant) === normalizeThemeParticipantId(currentParticipant)
    );
    const firstSourceCue = interview.find(cue => cue?.sourceFile);
    return participantEntry?.transcript?.relativePath || firstSourceCue?.sourceFile || "";
}

function syncQnaConflictResponse(cue, result, blockIndex, participant) {
    if (result.cue && typeof result.cue === "object") {
        // These optional fields may have been removed by the server. Clear them
        // before copying the saved cue so an old conflict badge cannot survive.
        for (const field of [
            "tag", "manualTag", "tagSource", "tagUpdatedAt",
            "aiSuggestedTag", "aiSuggestedTags", "originalTag", "originalAiTag",
            "additionalTags", "tagConflict", "tagConflictType",
            "tagConflictResolution", "tagConflictResolvedAt",
            "tagConflictResolvedManualTag", "tagConflictResolvedAiTag"
        ]) {
            delete cue[field];
        }
        Object.assign(cue, result.cue);
    }
    if (result.tagConflicts) {
        mergeQnaTagConflictsIntoTranscripts(result.tagConflicts);
    }
    if (currentParticipant !== participant) return;
    refreshSpeechBlockQATag(blockIndex, cue);
    renderQnaReviewExperience();
    if (!d3.select("#qa-list-container").empty()) {
        populateQAPanel();
    }
}

function showQnaSaveStatus(participant, blockIndex, message) {
    if (currentParticipant !== participant) return;
    const info = d3.select(`#speechBlock_${blockIndex} .info`);
    let status = info.select(".qa-save-status");
    if (status.empty()) {
        status = info.append("span")
            .attr("class", "qa-save-status")
            .attr("role", "status");
    }
    status.text(message);
}

async function saveQnaChange(cue, endpoint, payload, blockIndex) {
    // Capture the destination before waiting: the user can select another cue
    // or open another project while a request is in flight.
    if (transcriptHistory.state().undoing) return false;
    const participant = payload.participant;
    const url = scopeAppPath(endpoint);
    const mode = url.startsWith("/demo/") ? "demo" : "user";
    const context = withProjectPayload({ mode });
    const requestBody = JSON.stringify({ ...payload, ...context });
    transcriptHistory.begin();
    const saveToken = {};
    pendingQnaSaves.set(cue, saveToken);
    showQnaSaveStatus(participant, blockIndex, "Saving Q&A tag…");

    // Preserve click order, including edits to different cues in the same file.
    const saveRequest = qnaSaveQueue.catch(() => {}).then(async () => {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
            keepalive: true
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.cue) {
            throw new Error(result.error || "The server did not confirm the saved tag.");
        }
        return result;
    });
    qnaSaveQueue = saveRequest;

    try {
        const result = await saveRequest;
        syncQnaConflictResponse(cue, result, blockIndex, participant);
        rememberQnaUndo(result, context, cue, blockIndex, participant);
        if (pendingQnaSaves.get(cue) === saveToken) {
            pendingQnaSaves.delete(cue);
            showQnaSaveStatus(participant, blockIndex, "Saved");
        }
        return true;
    } catch (error) {
        console.error("Failed to save Q&A tag:", error);
        if (pendingQnaSaves.get(cue) === saveToken) {
            pendingQnaSaves.delete(cue);
            showQnaSaveStatus(participant, blockIndex, "Not saved. Please try again.");
            alert("Could not save the Q&A tag. Please select the tag again to retry.");
        }
        return false;
    } finally {
        transcriptHistory.end();
    }
}

async function resolveQnaConflict(action, conflict, blockIndex = currentJ) {
    const targetIndex = Number.isFinite(Number(blockIndex)) ? Number(blockIndex) : currentJ;
    const cue = transcriptsObject.transcripts[currentParticipant]?.[targetIndex];
    if (!cue || !conflict) return;
    currentJ = targetIndex;

    return saveQnaChange(cue, "/api/resolve_qna_tag_conflict", {
        action,
        fileKey: conflict.fileKey || getCurrentTranscriptFileKey(),
        participant: currentParticipant,
        timestamp: conflict.timestamp || cue.timestamp,
        segmentId: conflict.segmentId || cue.segmentId,
        manualTag: conflict.manualTag || cue.manualTag || cue.tag,
        aiSuggestedTag: conflict.aiSuggestedTag || cue.aiSuggestedTag
    }, targetIndex);
}

async function applyQATag(tag) {
    const blockIndex = currentJ;
    const cue = transcriptsObject.transcripts[currentParticipant]?.[blockIndex];
    if (!cue) return false;

    const fileKey = getCurrentTranscriptFileKey();
    if (!fileKey) {
        alert("Could not find the transcript file. Please reload before tagging.");
        return false;
    }

    hideTagMenu();
    return saveQnaChange(cue, "/api/save_qna_tags", {
        key: fileKey,
        fileKey,
        relativePath: getCurrentTranscriptRelativePath(),
        participant: currentParticipant,
        segmentId: cue.segmentId,
        timestamp: cue.timestamp,
        newTag: normalizeQATag(tag) || "None"
    }, blockIndex);
}

// --- Make sure you have this helper function in your file ---
function getParticipantIdFromKey(key) {
    const match = String(key || "").match(/P(\d+)/i);
    return match ? `P${parseInt(match[1], 10)}` : null;
}

// ---HELPER to load notes from the backend ---
async function loadNotes() {
    // Participant switches must not reload an older snapshot during a note save.
    if (noteSaveInFlight) return;
    const loadVersion = ++notesLoadVersion;
    notesLoaded = false;
    try {
        const context = transcriptRequestContext();
        const query = new URLSearchParams(context);
        const response = await fetch(`${scopeAppPath('/api/load_notes')}?${query}`);
        if (!response.ok) throw new Error("Failed to fetch notes");
        const loadedNotes = await response.json();
        if (loadVersion !== notesLoadVersion || noteSaveInFlight) return;
        notesData = loadedNotes;
        notesLoaded = true;
    } catch (error) {
        if (loadVersion !== notesLoadVersion || noteSaveInFlight) return;
        console.warn("Saved notes could not be loaded. Note changes are disabled until reload.");
        notesData = {};
    }
}

async function persistNoteChange(cue, noteKey, nextNotes) {
    const status = d3.select("#tagMenuNoteStatus");
    if (!notesLoaded) {
        status.text("Saved notes could not be loaded. Reload this page before changing them.");
        return false;
    }
    if (noteSaveInFlight) return false;
    const participant = currentParticipant;
    const blockIndex = currentJ;
    const context = transcriptRequestContext();
    noteSaveInFlight = true;
    notesLoadVersion += 1;
    const buttons = d3.selectAll("#tagMenuNoteButtons button");
    buttons.property("disabled", true);
    status.text("Saving note…");
    try {
        const response = await fetch(scopeAppPath('/api/save_notes'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...context, notes: nextNotes }),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error("The note could not be saved.");
        notesData = nextNotes;
        if (nextNotes[noteKey]) cue.notes = nextNotes[noteKey];
        else delete cue.notes;
        if (participant === currentParticipant) refreshCueCodingUI(cue, themesObject, blockIndex);
        if (participant === currentParticipant && blockIndex === currentJ) hideTagMenu();
        return true;
    } catch (error) {
        // Leave the original note and the typed draft available for retry.
        status.text("Note not saved. Your draft is still here; try again.");
        return false;
    } finally {
        noteSaveInFlight = false;
        buttons.property("disabled", false);
    }
}

async function saveNote(cue, newText, newSelection) {
    if (!newSelection) return false;
    const noteKey = getCueNoteKey(cue, currentParticipant, notesData);
    const nextNotes = structuredClone(notesData);
    const noteEntry = nextNotes[noteKey] || { selections: [] };
    const existingIndex = noteEntry.selections.findIndex(selection => selection.start === newSelection.start);
    const selection = { ...newSelection, note: newText || "" };
    if (existingIndex >= 0) noteEntry.selections[existingIndex] = selection;
    else noteEntry.selections.push(selection);
    nextNotes[noteKey] = noteEntry;
    return persistNoteChange(cue, noteKey, nextNotes);
}

async function deleteNote(cue, selectionToDelete) {
    const noteKey = getCueNoteKey(cue, currentParticipant, notesData);
    if (!selectionToDelete || !notesData[noteKey]) return false;
    const nextNotes = structuredClone(notesData);
    nextNotes[noteKey].selections = nextNotes[noteKey].selections.filter(
        selection => selection.start !== selectionToDelete.start
    );
    if (nextNotes[noteKey].selections.length === 0) delete nextNotes[noteKey];
    return persistNoteChange(cue, noteKey, nextNotes);
}

// --- Function to handle adding a new theme/code ---
function showInlineNewCodeForm(initialName = "") {
    const addButton = d3.select("#tagMenuAddCodeButton");
    const form = d3.select("#tagMenuNewCodeForm");
    const input = d3.select("#tagMenuNewCodeInput");
    const colorInput = d3.select("#tagMenuNewCodeColor");
    if (form.empty()) return;

    addButton.style("display", "none");
    form.style("display", "flex");
    input.property("value", String(initialName || "").trim());
    colorInput.property("value", getNextAvailableThemeColor(themesObject.themes));
    updateTagMenuStatus("");
    recordCodebookWorkflowEvent("code_create_started", {
        initialNameLength: String(initialName || "").trim().length,
        existingCodeCount: Array.isArray(themesObject.themes) ? themesObject.themes.length : 0
    }, { createStarts: 1 });
    setTimeout(() => {
        const inputNode = input.node();
        if (inputNode) inputNode.focus();
    }, 0);
}

function hideInlineNewCodeForm() {
    d3.select("#tagMenuNewCodeForm").style("display", "none");
    d3.select("#tagMenuAddCodeButton").style("display", "block");
    d3.select("#tagMenuNewCodeInput").property("value", "");
}

function normalizeNewCodeName(rawName) {
    return String(rawName || "")
        .replace(/\s+/g, " ")
        .trim();
}

function toInternalThemeName(displayName) {
    return normalizeNewCodeName(displayName)
        .replace(/\s+/g, "_")
        .toLowerCase();
}

function findExistingCodeByInternalName(internalThemeName) {
    const targetKey = normalizeCodeNameKey(internalThemeName);
    return themesObject.themes.find(themeData => normalizeCodeNameKey(themeData.themeName) === targetKey) || null;
}

async function createNewCodeFromPopover() {
    const input = d3.select("#tagMenuNewCodeInput");
    const colorInput = d3.select("#tagMenuNewCodeColor");
    const saveButton = d3.select("#tagMenuNewCodeForm .new-code-save-button");
    const displayName = normalizeNewCodeName(input.property("value"));
    if (!displayName) {
        updateTagMenuStatus("Enter a code name.", "warning");
        return;
    }

    const internalThemeName = toInternalThemeName(displayName);
    const existingCode = findExistingCodeByInternalName(internalThemeName);
    if (existingCode) {
        const cue = transcriptsObject.transcripts[currentParticipant] && transcriptsObject.transcripts[currentParticipant][currentJ];
        const hasSelection = Boolean(getActiveSelectionText());
        hideInlineNewCodeForm();
        if (cue && hasSelection) {
            await applyTag(existingCode, cue, themesObject, { keepMenuOpen: true });
        } else {
            updateTagMenuStatus(`${getCodeLabel(existingCode)} already exists.`, "neutral");
        }
        populateTagMenu(d3.select("#tagMenuOptions"), themesObject, transcriptsObject.transcripts[currentParticipant]);
        return;
    }

    const newCode = {
        themeName: internalThemeName,
        color: getNextAvailableThemeColor(themesObject.themes, colorInput.property("value")),
        words: [],
    };
    const cue = transcriptsObject.transcripts[currentParticipant]?.[currentJ];
    const selectedText = getActiveSelectionText();
    const options = {
        keepMenuOpen: true,
        selectedText,
        nextWordEntry: cue ? buildManualTagWordEntry(selectedText, cue) : null,
        blockIndex: currentJ
    };
    return runUndoableCodeChange(internalThemeName, `Create ${displayName}`, () =>
        saveNewCode(newCode, saveButton, cue, options)
    );
}

async function saveNewCode(newCode, saveButton, cue, options) {
    const internalThemeName = newCode.themeName;
    markManualCodeThemeForSync(newCode);
    setManualCodeSelection(themesObject, internalThemeName, true);
    saveButton.property("disabled", true).text("Saving...");
    themesObject.themes.push(newCode);

    try {
        const persistedPayload = await persistThemePayload(buildManualCodeSyncPayload(themesObject.themes), { throwOnError: true, rollbackOnError: true });
        themesObject.themes = persistedPayload.themes;
        const persistedNewCode = findExistingCodeByInternalName(internalThemeName) || newCode;
        markManualCodeThemeForSync(persistedNewCode);

        const response = await fetch('/api/add_new_theme', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withProjectPayload(persistedNewCode))
        });
        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.error || "Server error");
        }

        const hasSelection = Boolean(options.selectedText);
        if (cue && hasSelection) {
            await saveAppliedTag(persistedNewCode, cue, themesObject, options);
            updateTagMenuStatus(`Created and applied ${getCodeLabel(persistedNewCode)}.`, "success");
        } else {
            updateTagMenuStatus(`Created ${getCodeLabel(persistedNewCode)}.`, "success");
        }
        recordCodebookWorkflowEvent("code_created", {
            codeName: persistedNewCode.themeName || internalThemeName,
            color: persistedNewCode.color || newCode.color || "",
            autoAppliedToSelection: Boolean(cue && hasSelection),
            existingCodeCount: Array.isArray(themesObject.themes) ? themesObject.themes.length : 0
        }, { creates: 1 });
        recordAnalysisWorkflowAction("codebook_management", "code", "create", {
            codeName: persistedNewCode.themeName || internalThemeName,
            color: persistedNewCode.color || newCode.color || "",
            autoAppliedToSelection: Boolean(cue && hasSelection),
            participant: currentParticipant || "",
            cueIndex: currentJ
        });

        markCodeManagerSelectionComplete();
        hideInlineNewCodeForm();
        d3.select(".tag-menu-search").property("value", "");
        populateTagMenu(d3.select("#tagMenuOptions"), themesObject, transcriptsObject.transcripts[currentParticipant]);
    } catch (error) {
        themesObject.themes = themesObject.themes.filter(themeData =>
            normalizeCodeNameKey(themeData && themeData.themeName) !== normalizeCodeNameKey(newCode.themeName)
        );
        await persistThemePayload(buildManualCodeSyncPayload(themesObject.themes)).catch(() => {});
        console.error("Failed to add new theme:", error);
        updateTagMenuStatus(error.message || "Could not save code.", "warning");
    } finally {
        saveButton.property("disabled", false).text("Save code");
    }
}

function addNewCode() {
    showInlineNewCodeForm(d3.select(".tag-menu-search").property("value"));
}
