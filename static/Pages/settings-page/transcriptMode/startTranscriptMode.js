import { loadTranscripts, transcriptsObject, themesObject } from "../../../chromascribe-main.js";
import { displayEditor } from "./displayEditor.js?v=20261006a";
import { findParticipantAudio } from "../../main-page/audioMatching.js?v=20260601b";
import {
    buildThemeExcerptEntry,
    getStoredThemePayload,
    subscribeToThemePayloadUpdates
} from "../../themePersistence.js?v=20260901b";
import { hydrateFileMapFromServer } from "../../fileMapSync.js?v=20260601b";

let selectedThemesData = [];
let selectedThemesPayload = null;
let selectedThemesFileExists = false;
let codeCountRefreshInitialized = false;
let codeCountRefreshIntervalId = null;
let fileMapRefreshInitialized = false;
let renderDocumentsInFlight = false;
let pendingRenderDocumentsOptions = null;
let suppressFileMapRefreshEvent = false;

function projectQueryParam(prefix = "&") {
    const rawValue = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
    const projectId = typeof rawValue === "string" ? rawValue.trim() : "";
    return projectId ? `${prefix}projectId=${encodeURIComponent(projectId)}` : "";
}

function themePayloadTimestamp(payload) {
    const rawTimestamp = String(payload?.updatedAt || payload?.appliedAt || "").trim();
    const parsedTimestamp = rawTimestamp ? Date.parse(rawTimestamp) : NaN;
    return Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0;
}

function themePayloadWordCount(payload) {
    const themes = Array.isArray(payload?.themes) ? payload.themes : [];
    return themes.reduce((total, theme) => {
        const words = Array.isArray(theme?.words) ? theme.words : [];
        return total + words.length;
    }, 0);
}

function themePayloadParticipantWordCount(payload) {
    const themes = Array.isArray(payload?.themes) ? payload.themes : [];
    return themes.reduce((total, theme) => {
        const words = Array.isArray(theme?.words) ? theme.words : [];
        return total + words.filter((word) => resolveWordParticipantId(word)).length;
    }, 0);
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

function chooseFreshestThemePayload(remotePayload, storedPayload) {
    const hasRemotePayload = remotePayload && Array.isArray(remotePayload.themes);
    const hasStoredPayload = storedPayload && Array.isArray(storedPayload.themes);
    if (!hasStoredPayload) return hasRemotePayload ? remotePayload : null;
    if (!hasRemotePayload) return storedPayload;

    const remoteTimestamp = themePayloadTimestamp(remotePayload);
    const storedTimestamp = themePayloadTimestamp(storedPayload);
    const remoteWordCount = themePayloadWordCount(remotePayload);
    const storedWordCount = themePayloadWordCount(storedPayload);
    if (
        themePayloadParticipantWordCount(remotePayload) > themePayloadParticipantWordCount(storedPayload) &&
        remoteWordCount >= storedWordCount
    ) {
        return remotePayload;
    }

    if (storedTimestamp && (!remoteTimestamp || storedTimestamp > remoteTimestamp)) {
        return storedPayload;
    }
    if (remoteTimestamp && storedTimestamp && remoteTimestamp > storedTimestamp) {
        return remotePayload;
    }

    const storedIsMatchingSelection = themePayloadLooksLikeMatchingSelection(storedPayload);
    if (storedIsMatchingSelection && storedWordCount !== remoteWordCount) {
        return storedPayload;
    }

    return remotePayload;
}

async function fetchThemePayload(endpoint) {
    try {
        const separator = endpoint.includes("?") ? "&" : "?";
        const response = await fetch(`${endpoint}${separator}t=${Date.now()}${projectQueryParam()}`, { cache: "no-store" });
        if (!response.ok) return null;
        const payload = await response.json();
        return payload && Array.isArray(payload.themes) ? payload : null;
    } catch (error) {
        console.warn(`Failed to fetch theme payload from ${endpoint}:`, error);
        return null;
    }
}

async function syncSelectedThemesData(options = {}) {
    const preferRemote = options.preferRemote === true;
    const allowGeneratedFallback = options.allowGeneratedFallback !== false;
    const storedThemePayload = getStoredThemePayload();
    const storedThemes = Array.isArray(storedThemePayload?.themes) ? storedThemePayload.themes : [];

    if (!preferRemote && window.APP_MODE === "demo" && storedThemes.length > 0) {
        selectedThemesData = storedThemes;
        selectedThemesPayload = storedThemePayload;
        return selectedThemesData;
    }

    const selectedThemePayload = await fetchThemePayload("/api/load_selected_themes?includeGeneratedQuotes=1&includeGeneratedThemes=1");
    const resolvedSelectedThemePayload = chooseFreshestThemePayload(selectedThemePayload, storedThemePayload);
    selectedThemesFileExists = selectedThemePayload?.selectedThemesExists === true || resolvedSelectedThemePayload === storedThemePayload;
    if (
        resolvedSelectedThemePayload &&
        (selectedThemesFileExists || resolvedSelectedThemePayload.themes.length > 0 || window.APP_MODE !== "demo")
    ) {
        selectedThemesData = resolvedSelectedThemePayload.themes;
        selectedThemesPayload = resolvedSelectedThemePayload;
        return selectedThemesData;
    }

    if (storedThemes.length > 0) {
        selectedThemesData = storedThemes;
        selectedThemesPayload = storedThemePayload;
        return selectedThemesData;
    }

    if (!allowGeneratedFallback) {
        selectedThemesData = [];
        selectedThemesPayload = null;
        return selectedThemesData;
    }

    const fallbackThemePayload = await fetchThemePayload("/api/themes");
    selectedThemesData = Array.isArray(fallbackThemePayload?.themes) ? fallbackThemePayload.themes : [];
    selectedThemesPayload = fallbackThemePayload;
    return selectedThemesData;
}

function normalizeProgressMessage(message) {
    return String(message || "").trim().toLowerCase();
}

function isGenerationProgressRunning(progress) {
    const stage = Number(progress && progress.stage);
    const message = normalizeProgressMessage(progress && progress.message);
    return (
        [0, 1, 2, 3].includes(stage) &&
        !["idle", "not started", "complete", "demo data ready"].includes(message)
    );
}

async function hasRunningGenerationProgress() {
    if ((window.APP_MODE || "user") === "demo") return false;
    try {
        const response = await fetch(`/progress?t=${Date.now()}${projectQueryParam()}`, { cache: "no-store" });
        if (!response.ok) return false;
        return isGenerationProgressRunning(await response.json());
    } catch (error) {
        console.warn("Could not check generation progress for transcripts:", error);
        return false;
    }
}

async function loadThemesForCodeCounts() {
    if (await hasRunningGenerationProgress()) {
        const selectedThemes = await syncSelectedThemesData({
            preferRemote: true,
            allowGeneratedFallback: false
        });
        themesObject.themes = selectedThemes;
        return;
    }

    const resolvedThemes = await syncSelectedThemesData({
        preferRemote: true,
        allowGeneratedFallback: false
    });
    if (selectedThemesFileExists || (Array.isArray(resolvedThemes) && resolvedThemes.length > 0)) {
        themesObject.themes = resolvedThemes;
        return;
    }

    const serverThemePayload = await fetchThemePayload("/api/themes");
    if (Array.isArray(serverThemePayload?.themes) && serverThemePayload.themes.length > 0) {
        selectedThemesData = serverThemePayload.themes;
        selectedThemesPayload = serverThemePayload;
        themesObject.themes = serverThemePayload.themes;
        return;
    }

    themesObject.themes = [];
}

function resolveWordParticipantId(wordEntry) {
    const entry = buildThemeExcerptEntry(wordEntry);
    return String(entry?.participant || "").trim();
}

function countCodedCues(participantId) {
    if (!Array.isArray(selectedThemesData) || selectedThemesData.length === 0) return 0;
    const normalizedParticipantId = String(participantId || "").trim();
    if (!normalizedParticipantId) return 0;
    let count = 0;
    for (const theme of selectedThemesData) {
        const themeWords = Array.isArray(theme?.words) ? theme.words : [];
        for (const word of themeWords) {
            if (resolveWordParticipantId(word) === normalizedParticipantId) count++;
        }
    }
    return count;
}

function formatCodeCount(count) {
    const value = Number.isFinite(Number(count)) ? Number(count) : 0;
    return `${value} ${value === 1 ? "code" : "codes"}`;
}

function updateDocumentCodeBadges() {
    document.querySelectorAll('#documentsList .document[data-participant]').forEach((documentRow) => {
        const participantId = String(documentRow.dataset.participant || "").trim();
        const codesBadge = documentRow.querySelector('.codes');
        if (!participantId || !codesBadge) return;
        codesBadge.textContent = formatCodeCount(countCodedCues(participantId));
    });
}

async function refreshDocumentCodeBadges(options = {}) {
    await syncSelectedThemesData(options);
    updateDocumentCodeBadges();
}

function initializeCodeCountAutoRefresh() {
    if (codeCountRefreshInitialized || typeof window === "undefined") return;
    codeCountRefreshInitialized = true;

    subscribeToThemePayloadUpdates((payload) => {
        const nextThemes = Array.isArray(payload?.themes) ? payload.themes : null;
        if (nextThemes) {
            selectedThemesPayload = payload;
            selectedThemesData = nextThemes;
            updateDocumentCodeBadges();
            return;
        }
        void refreshDocumentCodeBadges();
    });

    window.addEventListener("pageshow", () => {
        void refreshDocumentCodeBadges({ preferRemote: true });
    });

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            void refreshDocumentCodeBadges({ preferRemote: true });
        }
    });

    if (codeCountRefreshIntervalId) {
        clearInterval(codeCountRefreshIntervalId);
    }
    codeCountRefreshIntervalId = window.setInterval(() => {
        if (!document.hidden) {
            void refreshDocumentCodeBadges({ preferRemote: true });
        }
    }, 12000);
}

function participantHasAudio(participantId) {
    const match = findParticipantAudio(participantId, { allowSingleFallback: false });
    const relativePath = match && match.audio && match.audio.relativePath;
    return typeof relativePath === "string" && relativePath.trim() !== "";
}

function appendAssetIcon(container, type, src, alt, title) {
    const iconWrapper = document.createElement("span");
    iconWrapper.className = `asset-icon ${type}`;
    iconWrapper.title = title;

    const icon = document.createElement("img");
    icon.src = src;
    icon.alt = alt;
    iconWrapper.appendChild(icon);
    container.appendChild(iconWrapper);
}

function buildDocumentRow(doc) {
    const documentDiv = document.createElement('div');
    documentDiv.classList.add('document');
    documentDiv.dataset.participant = doc.participant;

    const documentInfo = document.createElement('div');
    documentInfo.classList.add('document-info');

    const documentName = document.createElement('div');
    documentName.classList.add('document-name');

    const assetIcons = document.createElement("span");
    assetIcons.className = "asset-icons";
    appendAssetIcon(
        assetIcons,
        "transcript",
        "/static/images/transcript_icon_white.png",
        "Transcript available",
        "Transcript available"
    );
    if (participantHasAudio(doc.participant)) {
        appendAssetIcon(
            assetIcons,
            "audio",
            "/static/images/Audio_icon_white.png",
            "Audio available",
            "Audio available"
        );
    }
    documentName.appendChild(assetIcons);

    const nameText = document.createElement('span');
    nameText.textContent = doc.participant;
    documentName.appendChild(nameText);

    const documentCodes = document.createElement('div');
    documentCodes.classList.add('codes');
    documentCodes.textContent = formatCodeCount(doc.codes || countCodedCues(doc.participant));

    const documentTimestamp = document.createElement('div');
    documentTimestamp.classList.add('timestamp');
    documentTimestamp.textContent = doc.timestamp || getParticipantEndTimestamp(doc.participant);

    documentInfo.appendChild(documentName);
    documentInfo.appendChild(documentCodes);
    documentInfo.appendChild(documentTimestamp);

    documentDiv.appendChild(documentInfo);
    documentDiv.addEventListener('click', () => {
        window.location.href = `/transcriptmodedetail?participant=${encodeURIComponent(doc.participant)}`;
    });

    return documentDiv;
}

function getParticipantEndTimestamp(participant) {
    const transcriptEntries = transcriptsObject.transcripts[participant];
    return Array.isArray(transcriptEntries) && transcriptEntries.length > 0
        ? transcriptEntries[transcriptEntries.length - 1].timestamp
        : "00:00";
}

function isFileMapStorageKey(key) {
    return typeof key === "string" && (key.includes("FileMap_MatchedData") || key.startsWith("data.json"));
}

function scheduleDocumentRefresh(options = {}) {
    pendingRenderDocumentsOptions = {
        ...(pendingRenderDocumentsOptions || {}),
        ...options
    };
    if (renderDocumentsInFlight) return;
    const nextOptions = pendingRenderDocumentsOptions;
    pendingRenderDocumentsOptions = null;
    void renderDocuments(nextOptions);
}

function initializeFileMapAutoRefresh() {
    if (fileMapRefreshInitialized || typeof window === "undefined") return;
    fileMapRefreshInitialized = true;

    window.addEventListener("filemap:updated", () => {
        if (suppressFileMapRefreshEvent) return;
        scheduleDocumentRefresh({ hydrateFileMap: false, preferRemoteThemes: true });
    });

    window.addEventListener("storage", (event) => {
        if (!event || !isFileMapStorageKey(event.key)) return;
        scheduleDocumentRefresh({ hydrateFileMap: false, preferRemoteThemes: true });
    });

    window.addEventListener("themes:generation-started", () => {
        scheduleDocumentRefresh({ hydrateFileMap: true, preferRemoteThemes: true });
    });
}

export async function renderDocuments(options = {}) {
    if (renderDocumentsInFlight) {
        pendingRenderDocumentsOptions = {
            ...(pendingRenderDocumentsOptions || {}),
            ...options
        };
        return;
    }
    renderDocumentsInFlight = true;
    initializeFileMapAutoRefresh();
    const documentListContainer = document.getElementById('documentsList');
    if (!documentListContainer) {
        renderDocumentsInFlight = false;
        return;
    }
    try {
        documentListContainer.innerHTML = '<div>Loading and processing transcripts...</div>';

        await loadThemesForCodeCounts();
        if (options.hydrateFileMap !== false) {
            suppressFileMapRefreshEvent = true;
            try {
                await hydrateFileMapFromServer(window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId"));
            } finally {
                suppressFileMapRefreshEvent = false;
            }
        }
        await loadTranscripts(true);

        // Use the now-populated global object
        const transcripts = transcriptsObject.transcripts;
        console.log("Rendering document list from globally loaded transcripts:", transcripts);
        documentListContainer.innerHTML = ''; // Clear "Loading..."

        if (Object.keys(transcripts).length === 0) {
            documentListContainer.innerHTML = '<p>No transcripts found. Please go to File Manager to upload files.</p>';
            return;
        }

     // Create an array to sort by participant ID
    const participantList = Object.keys(transcripts).map(participantId => {
    const transcriptArray = transcripts[participantId];
    
    // --- THIS IS THE FIX ---
    // Check if transcriptArray is actually an array and has content
    if (Array.isArray(transcriptArray) && transcriptArray.length > 0) {
        return {
            participant: participantId,
            codes: countCodedCues(participantId), //pass participant ID
            timestamp: transcriptArray[transcriptArray.length - 1].timestamp
        };
    } else {
        // If it's not a valid array, return a default object
        return {
            participant: participantId,
            codes: 0,
            timestamp: "00:00"
        };
    }
    }).sort((a,b) => a.participant.localeCompare(b.participant, undefined, {numeric: true}));

    participantList.forEach(doc => {
        documentListContainer.appendChild(buildDocumentRow(doc));
    });

    initializeCodeCountAutoRefresh();
    } finally {
        renderDocumentsInFlight = false;
        if (pendingRenderDocumentsOptions) {
            const nextOptions = pendingRenderDocumentsOptions;
            pendingRenderDocumentsOptions = null;
            void renderDocuments(nextOptions);
        }
    }
}

// Function to filter documents based on search input
export function filterDocuments() {
    const searchInput = document.getElementById('searchInput').value.toLowerCase();
    const allParticipants = Object.keys(transcriptsObject.transcripts).map(p => ({ participant: p }));

    const filteredParticipants = allParticipants.filter(doc =>
        doc.participant.toLowerCase().includes(searchInput)
    );
    
    renderFilteredDocuments(filteredParticipants);
}

function renderFilteredDocuments(filteredParticipantList) {
    const documentListContainer = document.getElementById('documentsList');
    documentListContainer.innerHTML = '';

    filteredParticipantList.forEach(doc => {
        documentListContainer.appendChild(buildDocumentRow({
            participant: doc.participant,
            codes: countCodedCues(doc.participant),
            timestamp: getParticipantEndTimestamp(doc.participant)
        }));
    });
}
