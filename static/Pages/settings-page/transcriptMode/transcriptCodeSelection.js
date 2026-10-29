import {
    buildManualCodeSelectionKey,
    normalizeManualSelectionOptOuts
} from "../../themePersistence.js?v=20260901b";

function selectionTimestamp(payload) {
    const timestamp = Date.parse(payload?.updatedAt || payload?.appliedAt || "");
    return Number.isFinite(timestamp) ? timestamp : 0;
}

export function chooseTranscriptThemePayload(serverPayload, cachedPayload) {
    if (!Array.isArray(serverPayload?.themes)) return cachedPayload || null;
    if (!Array.isArray(cachedPayload?.themes)) return serverPayload;

    const serverRevision = serverPayload.projectRevision;
    const cachedRevision = cachedPayload.projectRevision;
    if (Number.isInteger(serverRevision) && Number.isInteger(cachedRevision)) {
        if (cachedRevision > serverRevision) return cachedPayload;
    }

    // A saved selection, including an empty one, defines which codes are active.
    if (serverPayload.selectedThemesExists === true) return serverPayload;
    if (selectionTimestamp(cachedPayload) > selectionTimestamp(serverPayload)) return cachedPayload;
    return serverPayload;
}

export function transcriptThemePayloadIsOlder(currentPayload, incomingPayload) {
    const currentRevision = currentPayload?.projectRevision;
    const incomingRevision = incomingPayload?.projectRevision;
    if (Number.isInteger(currentRevision) && Number.isInteger(incomingRevision)) {
        return incomingRevision < currentRevision;
    }
    if (incomingPayload?.selectedThemesExists === true) return false;
    const currentTimestamp = selectionTimestamp(currentPayload);
    const incomingTimestamp = selectionTimestamp(incomingPayload);
    return Boolean(currentTimestamp && incomingTimestamp && incomingTimestamp < currentTimestamp);
}

export function getActiveTranscriptCodes(payload) {
    const codes = Array.isArray(payload?.themes) ? payload.themes : [];
    const excludedNames = new Set(normalizeManualSelectionOptOuts(payload).codes);
    // Filter the display only; keep manual coding in the complete saved payload.
    return codes.filter(code => !excludedNames.has(buildManualCodeSelectionKey(code.themeName)));
}
