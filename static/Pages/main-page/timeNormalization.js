export function parseTimeStringToSeconds(rawTime) {
    if (typeof rawTime === "number" && Number.isFinite(rawTime)) {
        return Math.max(0, rawTime);
    }

    const text = String(rawTime || "").trim();
    if (!text) return null;

    const parts = text.split(":").map(part => parseInt(part, 10));
    if (parts.some(part => !Number.isFinite(part))) return null;

    if (parts.length === 3) {
        return Math.max(0, (parts[0] * 3600) + (parts[1] * 60) + parts[2]);
    }
    if (parts.length === 2) {
        return Math.max(0, (parts[0] * 60) + parts[1]);
    }
    return Math.max(0, parts[0] || 0);
}

export function timeStringToSeconds(rawTime) {
    const seconds = parseTimeStringToSeconds(rawTime);
    return Number.isFinite(seconds) ? seconds : 0;
}

export function formatTimelineSeconds(rawSeconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(rawSeconds) || 0));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function getTimelineTickValues(maxSeconds, width = 600) {
    const duration = Number(maxSeconds);
    if (!Number.isFinite(duration) || duration <= 0) return [0];

    const safeMaxSeconds = Math.ceil(duration);
    const tickCount = Math.max(2, Math.min(10, Math.floor(Number(width) / 90) || 6));
    const minimumStep = safeMaxSeconds / tickCount;
    const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = intervals.find(interval => interval >= minimumStep)
        || Math.ceil(minimumStep / 3600) * 3600;
    const ticks = [];
    for (let seconds = 0; seconds <= duration; seconds += step) {
        ticks.push(seconds);
    }
    return ticks;
}

export function getSpeechDurationSeconds(speech) {
    return timeStringToSeconds(speech && speech.duration);
}

export function getSpeechRawStartSeconds(speech) {
    return timeStringToSeconds(speech && speech.timestamp);
}

export function getSpeechTimelineOffsetSeconds(speech) {
    const offset = Number(speech && speech._timelineOffsetSeconds);
    return Number.isFinite(offset) ? Math.max(0, offset) : 0;
}

export function getSpeechTimelineStartSeconds(speech) {
    const normalized = Number(speech && speech._timelineStartSeconds);
    if (Number.isFinite(normalized)) {
        return Math.max(0, normalized);
    }
    return Math.max(0, getSpeechRawStartSeconds(speech) - getSpeechTimelineOffsetSeconds(speech));
}

export function getSpeechTimelineEndSeconds(speech) {
    return getSpeechTimelineStartSeconds(speech) + Math.max(1, getSpeechDurationSeconds(speech));
}

export function getTranscriptRawBoundsSeconds(transcript) {
    let startSeconds = null;
    let endSeconds = null;

    if (!Array.isArray(transcript)) {
        return { startSeconds: 0, endSeconds: 0, spanSeconds: 0 };
    }

    for (const speech of transcript) {
        const seconds = parseTimeStringToSeconds(speech && speech.timestamp);
        if (!Number.isFinite(seconds)) continue;
        if (startSeconds === null) {
            startSeconds = seconds;
        }
        endSeconds = seconds;
    }

    const resolvedStart = Number.isFinite(startSeconds) ? startSeconds : 0;
    const resolvedEnd = Number.isFinite(endSeconds) ? endSeconds : resolvedStart;
    return {
        startSeconds: resolvedStart,
        endSeconds: resolvedEnd,
        spanSeconds: Math.max(0, resolvedEnd - resolvedStart)
    };
}

export function getTranscriptTimelineOffsetSeconds(transcript) {
    if (!Array.isArray(transcript) || transcript.length === 0) return 0;

    for (const speech of transcript) {
        const explicitOffset = Number(speech && speech._timelineOffsetSeconds);
        if (Number.isFinite(explicitOffset)) return Math.max(0, explicitOffset);
    }

    return getTranscriptRawBoundsSeconds(transcript).startSeconds;
}

export function getParticipantTimelineOffsetSeconds(participantId, transcriptMap = {}) {
    return getTranscriptTimelineOffsetSeconds(transcriptMap && transcriptMap[participantId]);
}

export function getParticipantTimelineDurationSeconds(transcript) {
    if (!Array.isArray(transcript) || transcript.length === 0) return 0;
    return transcript.reduce((maxSeconds, speech) => (
        Math.max(maxSeconds, getSpeechTimelineEndSeconds(speech))
    ), 0);
}

function clamp(value, minValue, maxValue) {
    if (!Number.isFinite(value)) return minValue;
    if (!Number.isFinite(maxValue)) return Math.max(minValue, value);
    return Math.min(maxValue, Math.max(minValue, value));
}

export function getAudioDisplayTimeMapping(transcript, audioDuration) {
    if (!Array.isArray(transcript) || transcript.length === 0) {
        return { offsetSeconds: 0, scale: 1 };
    }

    const transcriptBounds = getTranscriptRawBoundsSeconds(transcript);
    const transcriptStart = transcriptBounds.startSeconds;
    const transcriptSpan = transcriptBounds.spanSeconds;

    const hasAudioDuration = Number.isFinite(audioDuration) && audioDuration > 0;
    if (!hasAudioDuration || transcriptSpan <= 0) {
        return { offsetSeconds: 0, scale: 1 };
    }

    const severeSpanMismatch = transcriptSpan > (audioDuration * 1.2);
    const startBeyondAudio = transcriptStart > (audioDuration + 30);
    const shouldMap = severeSpanMismatch || startBeyondAudio;
    if (!shouldMap) {
        return { offsetSeconds: 0, scale: 1 };
    }

    const offsetSeconds = transcriptStart >= 60 ? transcriptStart : 0;
    const scale = severeSpanMismatch ? (transcriptSpan / audioDuration) : 1;
    return { offsetSeconds, scale };
}

export function normalizeTranscriptTimeline(transcript, options = {}) {
    if (!Array.isArray(transcript) || transcript.length === 0) {
        return { offsetSeconds: 0, durationSeconds: 0 };
    }

    const fallbackLastDurationSeconds = Number.isFinite(Number(options.fallbackLastDurationSeconds))
        ? Math.max(0, Number(options.fallbackLastDurationSeconds))
        : 5;
    const rawStartSeconds = transcript.map(speech => parseTimeStringToSeconds(speech && speech.timestamp));
    const firstValidRawStart = rawStartSeconds.find(seconds => Number.isFinite(seconds));
    const offsetSeconds = Number.isFinite(firstValidRawStart) ? Math.max(0, firstValidRawStart) : 0;
    const timelineStarts = [];

    for (let index = 0; index < transcript.length; index += 1) {
        const rawSeconds = rawStartSeconds[index];
        const fallbackStart = index > 0 ? timelineStarts[index - 1] : 0;
        timelineStarts[index] = Number.isFinite(rawSeconds)
            ? Math.max(0, rawSeconds - offsetSeconds)
            : fallbackStart;
    }

    for (let index = 0; index < transcript.length; index += 1) {
        const speech = transcript[index];
        if (!speech) continue;

        const startSeconds = timelineStarts[index] || 0;
        const nextStartSeconds = index < transcript.length - 1
            ? timelineStarts[index + 1]
            : startSeconds + fallbackLastDurationSeconds;
        const durationSeconds = Math.max(0, nextStartSeconds - startSeconds);

        speech._rawTimestamp = String(speech.timestamp || "").trim();
        speech._timelineOffsetSeconds = offsetSeconds;
        speech._timelineStartSeconds = startSeconds;
        speech._timelineDurationSeconds = durationSeconds;
        speech.duration = formatTimelineSeconds(durationSeconds);
    }

    return {
        offsetSeconds,
        durationSeconds: getParticipantTimelineDurationSeconds(transcript)
    };
}

export function mapAudioSecondsToTimelineDisplaySecondsForTranscript(audioSeconds, transcript, audioDuration) {
    const mapping = getAudioDisplayTimeMapping(transcript, audioDuration);
    const rawDisplaySeconds = (Math.max(0, audioSeconds) * mapping.scale) + mapping.offsetSeconds;
    const timelineOffsetSeconds = getTranscriptTimelineOffsetSeconds(transcript);
    return Math.max(0, rawDisplaySeconds - timelineOffsetSeconds);
}

export function mapTimelineDisplaySecondsToAudioSecondsForTranscript(displaySeconds, transcript, audioDuration) {
    const mapping = getAudioDisplayTimeMapping(transcript, audioDuration);
    const timelineOffsetSeconds = getTranscriptTimelineOffsetSeconds(transcript);
    const rawDisplaySeconds = Math.max(0, displaySeconds) + timelineOffsetSeconds;
    const rawAudioSeconds = (rawDisplaySeconds - mapping.offsetSeconds) / Math.max(0.01, mapping.scale);

    if (Number.isFinite(audioDuration) && audioDuration > 0) {
        return clamp(rawAudioSeconds, 0, audioDuration);
    }
    return Math.max(0, rawAudioSeconds);
}

export function mapParticipantAudioSecondsToTimelineDisplaySeconds(audioSeconds, participantId, transcriptMap = {}, audioDuration) {
    return mapAudioSecondsToTimelineDisplaySecondsForTranscript(
        audioSeconds,
        transcriptMap && transcriptMap[participantId],
        audioDuration
    );
}

export function mapParticipantTimelineDisplaySecondsToAudioSeconds(displaySeconds, participantId, transcriptMap = {}, audioDuration) {
    return mapTimelineDisplaySecondsToAudioSecondsForTranscript(
        displaySeconds,
        transcriptMap && transcriptMap[participantId],
        audioDuration
    );
}
