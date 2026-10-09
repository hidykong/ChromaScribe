import {
    xObject,
    transcriptsObject,
    selectedParticipantObject
} from "../../chromascribe-main.js";
import { calculateTime } from "../../calculateTime.js";
import {
    getParticipantTimelineDurationSeconds,
    mapParticipantTimelineDisplaySecondsToAudioSeconds
} from "./timeNormalization.js";

function clamp(value, minValue, maxValue) {
    if (!Number.isFinite(value)) return minValue;
    return Math.min(maxValue, Math.max(minValue, value));
}

function hasAudioSource(audioNode) {
    const rawSrc = audioNode && typeof audioNode.getAttribute === "function"
        ? String(audioNode.getAttribute("src") || "").trim()
        : "";
    return rawSrc.length > 0;
}

function getActiveInterviewDurationSeconds() {
    const participantId = selectedParticipantObject.selectedParticipant;
    const interview = transcriptsObject.transcripts[participantId] || [];
    return getParticipantTimelineDurationSeconds(interview);
}

export var drag = d3.drag()
    .on("start", onStart)
    .on("drag", onDrag)
    .on("end", onEnd);

export function onStart() {
    d3.select(this).raise().classed("active", true);
}

export function onDrag() {
    if (!xObject.x) return;

    const maxSeconds = getActiveInterviewDurationSeconds();
    if (maxSeconds <= 0) return;

    const minX = xObject.x(0);
    const maxX = xObject.x(maxSeconds);
    const clampedX = clamp(d3.event.x, minX, maxX);
    d3.select(this).attr("x", clampedX);

    const timeInSeconds = Math.max(0, Math.round(xObject.x.invert(clampedX)));
    const audioNode = d3.select("#full-audiofile").node();
    if (hasAudioSource(audioNode)) {
        const audioDuration = Number(audioNode.duration);
        audioNode.currentTime = mapParticipantTimelineDisplaySecondsToAudioSeconds(
            timeInSeconds,
            selectedParticipantObject.selectedParticipant,
            transcriptsObject.transcripts,
            audioDuration
        );
    }

    d3.select("#full-slider").property("value", timeInSeconds);
    d3.select("#full-current-time").text(calculateTime(timeInSeconds));
}

export function onEnd() {
    d3.select(this).classed("active", false);
}

export var barObject = { bar: "" };
