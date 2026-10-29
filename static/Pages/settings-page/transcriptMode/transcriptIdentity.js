// Imported transcripts can have no timestamps. Use their stable segment IDs
// for edits and notes; retain timestamp identities for older projects.
export function buildQnaConflictKey(participant, timestamp, segmentId = "") {
    const participantKey = String(participant || "").trim().toUpperCase();
    const normalizedSegmentId = String(segmentId || "").trim();
    const cueKey = normalizedSegmentId
        ? `segment:${normalizedSegmentId}`
        : String(timestamp || "").replace(/\s+/g, "").trim();
    return `${participantKey}||${cueKey}`;
}

export function getCueNoteKey(cue, participant, notes = {}) {
    const legacyKey = `${participant}_${cue.timestamp || ""}`;
    const segmentId = String(cue.segmentId || "").trim();
    if (!segmentId) {
        return legacyKey;
    }

    const segmentKey = `${participant}_segment:${segmentId}`;
    if (Object.prototype.hasOwnProperty.call(notes, segmentKey)) {
        return segmentKey;
    }
    if (cue.timestamp && Object.prototype.hasOwnProperty.call(notes, legacyKey)) {
        return legacyKey;
    }
    return segmentKey;
}

export function getCueStartSeconds(cue) {
    if (typeof cue.startSeconds === "number" && Number.isFinite(cue.startSeconds)) {
        return cue.startSeconds >= 0 ? cue.startSeconds : null;
    }
    const timestamp = String(cue.timestamp || "").trim();
    if (!/^\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d+)?$/.test(timestamp)) {
        return null;
    }
    const parts = timestamp.replace(",", ".").split(":").map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0);
}

export function getCueOriginalSpeaker(cue) {
    return String(cue.speakerLabel ?? cue.speaker ?? "").trim();
}
