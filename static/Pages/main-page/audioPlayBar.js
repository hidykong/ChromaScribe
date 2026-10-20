import {
    xObject,
    transcriptsObject,
    selectedParticipantObject,
    playObject,
    svgObject,
    yObject
} from "../../chromascribe-main.js";
import { calculateTime } from "../../calculateTime.js";
import { barObject } from "./dragRedPlayBar.js";
import {
    getParticipantTimelineDurationSeconds,
    getSpeechTimelineEndSeconds,
    getSpeechTimelineStartSeconds,
    mapParticipantAudioSecondsToTimelineDisplaySeconds,
    mapParticipantTimelineDisplaySecondsToAudioSeconds,
    timeStringToSeconds as normalizedTimeStringToSeconds
} from "./timeNormalization.js";

var fullAudio = d3.select("#full-audiofile");
var fullSlider = d3.select("#full-slider");
var fullTimestamp = d3.select("#full-current-time");
var transcript = d3.select("#transcript");
const fullDuration = d3.select("#full-duration");
const playbar = d3.select("#playbar");
const backwardControl = d3.select("#backwardcontrol");
const forwardControl = d3.select("#forwardcontrol");

const playPauseButton = d3.select("#full-play-button");
const playPauseHolder = d3.select("#full-play-pause-holder");
const playPauseIcon = d3.select("#full-play-pause");

let lastHighlightedParticipant = "";
let lastHighlightedIndex = -1;

export const timeStringToSeconds = normalizedTimeStringToSeconds;

function clamp(value, minValue, maxValue) {
    if (!Number.isFinite(value)) return minValue;
    if (!Number.isFinite(maxValue)) return Math.max(minValue, value);
    return Math.min(maxValue, Math.max(minValue, value));
}

function getAudioNode() {
    return fullAudio.node();
}

export function hasAudioSource(audioNode = getAudioNode()) {
    const rawSrc = audioNode && typeof audioNode.getAttribute === "function"
        ? String(audioNode.getAttribute("src") || "").trim()
        : "";
    return rawSrc.length > 0;
}

export function setPlaybarDisabled(disabled, reason = "") {
    const isDisabled = !!disabled;

    if (!playbar.empty()) {
        playbar
            .classed("playbar-disabled", isDisabled)
            .attr("aria-disabled", isDisabled ? "true" : "false");
        if (isDisabled && reason) {
            playbar.attr("title", reason);
        } else {
            playbar.attr("title", null);
        }
    }

    playPauseButton
        .attr("aria-disabled", isDisabled ? "true" : "false")
        .style("cursor", isDisabled ? "not-allowed" : "pointer");
    backwardControl
        .attr("aria-disabled", isDisabled ? "true" : "false")
        .style("cursor", isDisabled ? "not-allowed" : "pointer");
    forwardControl
        .attr("aria-disabled", isDisabled ? "true" : "false")
        .style("cursor", isDisabled ? "not-allowed" : "pointer");
    fullSlider
        .property("disabled", isDisabled)
        .attr("aria-disabled", isDisabled ? "true" : "false");
}

export function clearPlaybarAudio(options = {}) {
    const {
        displaySeconds = null,
        maxDisplaySeconds = 0,
        durationText = "--:--",
        reason = "Audio not available for this selection."
    } = options;
    const audioNode = getAudioNode();

    fullAudio.on("loadedmetadata.playbar", null);
    if (audioNode) {
        audioNode.pause();
        audioNode.currentTime = 0;
        fullAudio.attr("src", null);
        try {
            audioNode.load();
        } catch (error) {
            console.warn("Could not reset audio node while clearing playbar audio:", error);
        }
    }

    resetPlayButtonToPaused();

    const safeDisplaySeconds = Number.isFinite(displaySeconds)
        ? Math.max(0, Math.floor(displaySeconds))
        : Math.max(0, Math.floor(Number(fullSlider.property("value")) || 0));
    const safeMaxDisplaySeconds = Number.isFinite(maxDisplaySeconds)
        ? Math.max(safeDisplaySeconds, Math.floor(maxDisplaySeconds))
        : safeDisplaySeconds;

    fullSlider.attr("max", safeMaxDisplaySeconds).property("value", safeDisplaySeconds);
    fullTimestamp.text(calculateTime(safeDisplaySeconds));
    fullDuration.text(durationText);
    setPlaybarDisabled(true, reason);
    updatePlayhead(safeDisplaySeconds);
}

export function setPlaybarAudioSource(audioSrc) {
    const audioNode = getAudioNode();
    if (!audioNode || !audioSrc) {
        return false;
    }

    fullAudio.on("loadedmetadata.playbar", null);
    fullAudio.attr("src", audioSrc);
    fullDuration.text("--:--");
    fullAudio.on("loadedmetadata.playbar", function() {
        const duration = Number(audioNode.duration);
        if (Number.isFinite(duration) && duration > 0) {
            const safeDuration = Math.floor(duration);
            fullSlider.attr("max", safeDuration);
            fullDuration.text(calculateTime(safeDuration));
        }
        fullAudio.on("loadedmetadata.playbar", null);
    });
    try {
        audioNode.load();
    } catch (error) {
        console.warn("Could not load audio source:", error);
    }
    setPlaybarDisabled(false);
    return true;
}

function getActiveInterview() {
    const participantId = selectedParticipantObject.selectedParticipant;
    if (!participantId) return [];
    return transcriptsObject.transcripts[participantId] || [];
}

function getSpeechEndInSeconds(speech) {
    return getSpeechTimelineEndSeconds(speech);
}

function mapAudioSecondsToTimelineDisplaySeconds(audioSeconds, participantId, audioDuration) {
    return mapParticipantAudioSecondsToTimelineDisplaySeconds(
        audioSeconds,
        participantId,
        transcriptsObject.transcripts,
        audioDuration
    );
}

function mapTimelineDisplaySecondsToAudioSeconds(displaySeconds, participantId, audioDuration) {
    return mapParticipantTimelineDisplaySecondsToAudioSeconds(
        displaySeconds,
        participantId,
        transcriptsObject.transcripts,
        audioDuration
    );
}

function findTranscriptIndexForTime(interview, second) {
    if (!Array.isArray(interview) || interview.length === 0) return -1;
    let matchedIndex = -1;
    for (let i = 0; i < interview.length; i++) {
        const current = interview[i];
        const start = getSpeechTimelineStartSeconds(current);
        const next = interview[i + 1];
        const nextStart = next ? getSpeechTimelineStartSeconds(next) : Number.POSITIVE_INFINITY;
        const end = Math.max(start + 1, Math.min(nextStart, getSpeechEndInSeconds(current)));
        if (second >= start && second < end) {
            matchedIndex = i;
        }
    }
    if (matchedIndex >= 0) return matchedIndex;
    if (second >= getSpeechTimelineStartSeconds(interview[interview.length - 1])) {
        return interview.length - 1;
    }
    return -1;
}

function isSecondWithinSpeechRange(interview, index, second) {
    if (!Array.isArray(interview)) return false;
    if (!Number.isInteger(index) || index < 0 || index >= interview.length) return false;
    const current = interview[index];
    const start = getSpeechTimelineStartSeconds(current);
    const next = interview[index + 1];
    const nextStart = next ? getSpeechTimelineStartSeconds(next) : Number.POSITIVE_INFINITY;
    const end = Math.max(start + 1, Math.min(nextStart, getSpeechEndInSeconds(current)));
    return second >= start && second < end;
}

function keepSpeechVisible(speechNode) {
    const transcriptNode = transcript.node();
    if (!transcriptNode || !speechNode) return;

    const viewportTop = transcriptNode.scrollTop;
    const viewportBottom = viewportTop + transcriptNode.clientHeight;
    const speechTop = speechNode.offsetTop;
    const speechBottom = speechTop + speechNode.offsetHeight;
    const padding = 24;

    if (speechTop < viewportTop || speechBottom > viewportBottom - padding) {
        const centeredTop = speechTop - (transcriptNode.clientHeight * 0.35);
        transcriptNode.scrollTop = Math.max(0, centeredTop);
    }
}

function highlightTranscriptByTime(second, shouldScroll) {
    const participantId = selectedParticipantObject.selectedParticipant;
    if (!participantId) return;

    const interview = getActiveInterview();
    let activeIndex = findTranscriptIndexForTime(interview, second);
    const audioNode = getAudioNode();
    const isAudioPaused = !audioNode || audioNode.paused || audioNode.ended;
    if (
        participantId === lastHighlightedParticipant &&
        Number.isInteger(lastHighlightedIndex) &&
        (
            // Keep the clicked transcript block selected while paused so metadata/time mapping
            // updates do not jump the UI to a neighboring cue.
            (!shouldScroll && isAudioPaused) ||
            isSecondWithinSpeechRange(interview, lastHighlightedIndex, second)
        )
    ) {
        // Preserve the explicitly clicked transcript block while currentTime is still in its range.
        activeIndex = lastHighlightedIndex;
    }
    if (activeIndex < 0) return;

    if (participantId !== lastHighlightedParticipant || activeIndex !== lastHighlightedIndex) {
        d3.selectAll(".speech").style("opacity", 0.5).classed("active", false);
        const activeBlock = d3.select(`#_${activeIndex}`);
        if (!activeBlock.empty()) {
            activeBlock.style("opacity", 1).classed("active", true);
            if (shouldScroll) {
                keepSpeechVisible(activeBlock.node());
            }
        }
        lastHighlightedParticipant = participantId;
        lastHighlightedIndex = activeIndex;
    } else if (shouldScroll) {
        const existingNode = d3.select(`#_${activeIndex}`).node();
        keepSpeechVisible(existingNode);
    }
}

function highlightVisualizationByTime(second) {
    if (!svgObject.svg || svgObject.svg.empty()) return;
    const participantId = selectedParticipantObject.selectedParticipant;
    if (!participantId) return;

    const allSpeechRects = svgObject.svg.selectAll("#speech, .speech-rect");
    if (allSpeechRects.empty()) return;

    let selectedNode = null;
    allSpeechRects.each(function(speech) {
        if (!speech || speech.participant !== participantId || selectedNode) return;
        const start = getSpeechTimelineStartSeconds(speech);
        const end = getSpeechEndInSeconds(speech);
        if (second >= start && second < end) {
            selectedNode = this;
        }
    });

    allSpeechRects.style("stroke", "none");
    if (selectedNode) {
        d3.select(selectedNode).style("stroke", "black");
    }
}

function updatePlayhead(displaySecond) {
    if (!xObject.x || !yObject.y) return;
    if (!barObject.bar || barObject.bar.empty()) return;
    barObject.bar
        .attr("x", xObject.x(displaySecond))
        .attr("y", yObject.y(selectedParticipantObject.selectedParticipant) || -9999)
        .style("opacity", selectedParticipantObject.selectedParticipant ? 1 : 0)
        .raise();
}

function updateDisplayUi(displaySecond, shouldScrollTranscript = false) {
    const wholeDisplaySeconds = Math.max(0, Math.floor(displaySecond));
    fullSlider.property("value", wholeDisplaySeconds);
    fullTimestamp.text(calculateTime(wholeDisplaySeconds));
    updatePlayhead(wholeDisplaySeconds);
    highlightTranscriptByTime(wholeDisplaySeconds, shouldScrollTranscript);
    highlightVisualizationByTime(wholeDisplaySeconds);
}

function updateAudioUI(audioSecond, shouldScrollTranscript = false) {
    const participantId = selectedParticipantObject.selectedParticipant;
    const audioNode = getAudioNode();
    const audioDuration = Number(audioNode?.duration);
    const displaySecond = mapAudioSecondsToTimelineDisplaySeconds(
        Math.max(0, audioSecond),
        participantId,
        audioDuration
    );
    updateDisplayUi(displaySecond, shouldScrollTranscript);
}

export function seekAudioBy(deltaSeconds) {
    const audioNode = getAudioNode();
    if (!hasAudioSource(audioNode)) return;

    const duration = Number(audioNode.duration);
    const maxSeek = Number.isFinite(duration) ? duration : Number.POSITIVE_INFINITY;
    const nextTime = clamp(audioNode.currentTime + deltaSeconds, 0, maxSeek);
    audioNode.currentTime = nextTime;
    updateAudioUI(nextTime, true);
}

function resetPlayButtonToPaused() {
    playObject.play = true;
    playPauseHolder.attr("class", "play");
    playPauseIcon.attr("src", "../static/images/play-button.png");
}

export function playBar(speech) {
    const audioNode = getAudioNode();
    if (!audioNode) return;

    const participantId = (speech && speech.participant) || selectedParticipantObject.selectedParticipant;
    const initialDisplaySeconds = getSpeechTimelineStartSeconds(speech);
    const hasPinnedSpeechIndex = Number.isInteger(speech && speech._transcriptIndex);
    if (!hasAudioSource(audioNode)) {
        const interviewDuration = getParticipantTimelineDurationSeconds(getActiveInterview());
        clearPlaybarAudio({
            displaySeconds: initialDisplaySeconds,
            maxDisplaySeconds: Math.max(initialDisplaySeconds, interviewDuration),
            reason: "Audio not available for this selection."
        });
        updateDisplayUi(initialDisplaySeconds, !hasPinnedSpeechIndex);
        return;
    }

    // An untimed excerpt cannot identify a position within an optional recording.
    if (speech?.startSeconds === null) return;

    audioNode.pause();
    setPlaybarDisabled(false);
    resetPlayButtonToPaused();

    if (hasPinnedSpeechIndex && participantId) {
        lastHighlightedParticipant = participantId;
        lastHighlightedIndex = speech._transcriptIndex;
    }
    const seekWhenReady = () => {
        const duration = Number(audioNode.duration);
        const initialAudioSeconds = mapTimelineDisplaySecondsToAudioSeconds(initialDisplaySeconds, participantId, duration);
        if (Number.isFinite(duration) && duration > 0) {
            const mappedMaxDisplaySeconds = Math.floor(
                mapAudioSecondsToTimelineDisplaySeconds(duration, participantId, duration)
            );
            const interviewDuration = Math.floor(
                getParticipantTimelineDurationSeconds(transcriptsObject.transcripts?.[participantId] || [])
            );
            const maxDisplaySeconds = Math.max(mappedMaxDisplaySeconds, interviewDuration);
            fullSlider.attr("max", maxDisplaySeconds);
            d3.select("#full-duration").text(calculateTime(maxDisplaySeconds));
            audioNode.currentTime = clamp(initialAudioSeconds, 0, duration);
        } else {
            audioNode.currentTime = initialAudioSeconds;
        }
        updateAudioUI(audioNode.currentTime, !hasPinnedSpeechIndex);
    };

    fullAudio.on("loadedmetadata.playbar", null);
    if (audioNode.readyState >= 1 && Number.isFinite(audioNode.duration) && audioNode.duration > 0) {
        seekWhenReady();
    } else {
        fullAudio.on("loadedmetadata.playbar", function() {
            seekWhenReady();
            fullAudio.on("loadedmetadata.playbar", null);
        });
    }

    // Immediate UI update for stable feedback while metadata loads.
    updateDisplayUi(initialDisplaySeconds, !hasPinnedSpeechIndex);
}

playPauseButton.on("click", function() {
    const audioNode = getAudioNode();
    if (!hasAudioSource(audioNode)) return;

    updateAudioUI(audioNode.currentTime, false);
    if (playObject.play) {
        audioNode.play();
        playObject.play = false;
        playPauseHolder.attr("class", "pause");
        playPauseIcon.attr("src", "../static/images/pause-button.png");
    } else {
        audioNode.pause();
        resetPlayButtonToPaused();
    }
});

fullSlider.on("input", function() {
    const requestedDisplayTime = Number(this.value);
    const safeDisplayTime = Number.isFinite(requestedDisplayTime) ? Math.max(0, requestedDisplayTime) : 0;
    const audioNode = getAudioNode();
    if (hasAudioSource(audioNode)) {
        const duration = Number(audioNode.duration);
        const participantId = selectedParticipantObject.selectedParticipant;
        const mappedAudioTime = mapTimelineDisplaySecondsToAudioSeconds(safeDisplayTime, participantId, duration);
        audioNode.currentTime = mappedAudioTime;
        updateAudioUI(mappedAudioTime, true);
        return;
    }
    updateDisplayUi(safeDisplayTime, true);
});

fullAudio.on("timeupdate", () => {
    const audioNode = getAudioNode();
    if (!hasAudioSource(audioNode)) return;

    const currentTime = Number(audioNode.currentTime);
    if (!Number.isFinite(currentTime)) return;

    updateAudioUI(currentTime, false);

    if (audioNode.ended) {
        audioNode.pause();
        audioNode.currentTime = 0;
        resetPlayButtonToPaused();
        updateAudioUI(0, true);
    }
});

setPlaybarDisabled(!hasAudioSource(), "Select a transcript segment with audio to enable playback.");
