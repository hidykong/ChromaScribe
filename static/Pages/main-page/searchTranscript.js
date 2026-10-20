import { xObject, participants, currentDisplayObject, selectedParticipantObject, playObject, barYValueObject, yObject } from "../../chromascribe-main.js";
import { calculateTime } from "../../calculateTime.js";
import { playBar, clearPlaybarAudio, hasAudioSource, setPlaybarAudioSource } from "./audioPlayBar.js";
import { barObject } from "./dragRedPlayBar.js";
import { drawVisualization } from "./drawVisualization.js?v=20260901b";
import { drawVisualization2 } from "./drawVisualization2.js?v=20260901b";
import { findParticipantAudio, buildServeAudioUrl } from "./audioMatching.js?v=20260601b";
import { getSpeechTimelineStartSeconds } from "./timeNormalization.js";

function safeClearPlaybarAudio(opts) {
    if (typeof clearPlaybarAudio === "function") {
        clearPlaybarAudio(opts);
    }
}

function safeRedraw(view) {
    try {
        if (view === "timeline") {
            drawVisualization(currentDisplayObject.currentDisplay);
        } else {
            drawVisualization2(currentDisplayObject.currentDisplay);
        }
    } catch (e) {
        console.warn("safeRedraw error:", e);
    }
}

function appendSearchResultTimestamp(container, speech) {
    const displayTimestamp = calculateTime(getSpeechTimelineStartSeconds(speech));
    const rawTimestamp = String((speech && (speech._rawTimestamp || speech.timestamp)) || "").trim();
    const row = container.append("div")
        .attr("class", "speech-meta-row");

    row.append("span")
        .attr("class", "speech-display-time")
        .text(displayTimestamp);

    if (rawTimestamp) {
        row.append("span")
            .attr("class", "speech-raw-time")
            .text(`(${rawTimestamp})`);
    }
}

export function searchSpeeches(fullInterviews, word, view) {
       if (!fullInterviews || !word || word.trim() === "") {
        console.warn("searchSpeeches: missing fullInterviews or word");
        return;
    }

    var transcript = d3.select("#transcript");
    if (transcript.empty()) {
        console.error("searchSpeeches: #transcript element not found in DOM");
        return;
    }

    var transcriptHeader = d3.select("#transcript-header");
    var transcriptHeaderTitle = d3.select("#transcript-header .transcript-header-title");

    transcript.selectAll("*").remove();

    console.log("before for loop");
    var interview = fullInterviews;
    var keys = Object.keys(interview);
    console.log("Interview keys:", keys.length, keys);
    console.log("Participants array:", participants);

    var count = 0;

    safeClearPlaybarAudio({
        displaySeconds: 0,
        maxDisplaySeconds: 0,
        reason: "Select a result with audio to enable playback."
    });

    selectedParticipantObject.selectedParticipant = "";
    safeRedraw(view);
	    transcriptHeaderTitle.text(`Results for "${word}"`);
    if (window.ChromaTranscriptViews && typeof window.ChromaTranscriptViews.hideThemeQuoteButton === "function") {
        window.ChromaTranscriptViews.hideThemeQuoteButton();
    }

    // Remove any stale clear button before adding a fresh one
    d3.select("#clear-search-btn").remove();

    transcriptHeader.append("button")
        .attr("id", "clear-search-btn")
        .text("✕ Clear")
        .style("margin-left", "8px")
        .style("cursor", "pointer")
        .style("font-size", "12px")
        .style("padding", "3px 8px")
        .style("border", "1px solid #aaa")
        .style("border-radius", "4px")
        .style("background", "#f5f5f5")
        .style("vertical-align", "middle")
        .on("click", function () {
            d3.select("#clear-search-btn").remove();
            transcriptHeaderTitle.text("Transcript");
            if (window.ChromaTranscriptViews && typeof window.ChromaTranscriptViews.hideThemeQuoteButton === "function") {
                window.ChromaTranscriptViews.hideThemeQuoteButton();
            }
            transcript.selectAll("*").remove();
            selectedParticipantObject.selectedParticipant = "";
            // Clear the search input box too
            d3.select("#searchInput").property("value", "");
            safeClearPlaybarAudio({
                displaySeconds: 0,
                maxDisplaySeconds: 0,
                reason: "Select a speech segment to enable playback."
            });
            safeRedraw(view);
        });

    transcript.selectAll("*").remove();
    var countDiv = transcript.append("div")
        .attr("id", "scriptCount")
        .style("margin-top", "5px")
        .style("margin-left", "20px")
        .style("width", "280px")
        .style("float", "right")
        .attr("class", "script")
        .text("0 results found.");

    var validParticipants = participants && participants.length > 0
        ? participants.filter(p => interview[p] !== undefined)
        : keys;

    if (validParticipants.length === 0) {
        console.warn("searchSpeeches: No matching participants found.");
        console.warn("participants array:", participants);
        console.warn("interview keys:", keys);
        countDiv.text("0 results found. (participant key mismatch — check console)");
        return;
    }

    for (var i = 0; i < validParticipants.length; i++) {
        var participantKey = validParticipants[i];
        var speeches = interview[participantKey];

        if (!speeches || !Array.isArray(speeches)) {
            console.warn(`searchSpeeches: no speech array for participant "${participantKey}"`);
            continue;
        }

        let foundInJLoop = false;

        for (var j = 0; j < speeches.length; j++) {
            var speechObj = speeches[j];

            if (!speechObj || typeof speechObj.script !== "string") continue;

            var indexes = findIndexesOfWord(speechObj.script, word);
            if (indexes.length === 0) continue;
            if (!foundInJLoop) {
                (function (label) {
                    transcript.append("div")
                        .attr("class", "header")
                        .style("margin-top", "30px")
                        .style("margin-left", "20px")
                        .style("font-size", "14px")
                        .style("font-weight", "600")
                        .text(`Interview of ${label}`);
                })(participantKey);
                foundInJLoop = true;
            }

            var speechBlock = transcript.append("div")
                .attr("class", `speech speech_${i}`)
                .attr("id", `_${i}_${j}`)
                .style("opacity", 1);

            var info = speechBlock.append("div")
                .style("margin-top", "5px")
                .attr("class", "info");
            appendSearchResultTimestamp(info, speechObj);

            var speaker;
            if (speechObj.participant === "P15") {
                speaker = speechObj.speaker === "S2" ? "Interviewer" : "Participant";
            } else {
                speaker = speechObj.speaker === "S1" ? "Interviewer" : "Participant";
            }
            info.append("div").text(speaker);

            const textLength = speechObj.script.length;
            const contextLength = 20;
            const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            const highlightedWord = `<span class="highlight">${word}</span>`;
            let context = "";
            let datacontext = speechObj.script.replace(regex, highlightedWord);

            function trimToNearestWord(script, start, end) {
                while (start > 0 && script[start - 1] !== ' ' && script[start - 1] !== '\n') start--;
                while (end < script.length && script[end] !== ' ' && script[end] !== '\n') end++;
                return { start, end };
            }

            for (let h = 0; h < indexes.length; h++) {
                count++;
                let startIndex = Math.max(indexes[h] - contextLength, 0);
                let endIndex = Math.min(indexes[h] + word.length + contextLength, textLength);
                const trimmed = trimToNearestWord(speechObj.script, startIndex, endIndex);
                let snippet = speechObj.script.substring(trimmed.start, trimmed.end);
                snippet = snippet.replace(regex, highlightedWord);
                context += snippet + "...";
            }

            var scriptDiv = speechBlock.append("div")
                .attr("id", "script")
                .style("margin-top", "5px")
                .style("margin-left", "20px")
                .style("width", "280px")
                .style("float", "right")
                .attr("class", "script")
                .html(context)
                .attr("full-content", datacontext)
                .attr("short-content", context)
                .attr("state", "closed");

            scriptDiv.on("click", function () {
                d3.event.stopPropagation();
                var blockState = d3.select(this).attr("state");
                var originalContext = d3.select(this).attr("full-content");
                var shortContext = d3.select(this).attr("short-content");
                var newText = blockState === "closed" ? originalContext : shortContext;
                var blockNewState = blockState === "closed" ? "open" : "closed";
                d3.select(this).attr("state", blockNewState).html(newText);
            });
            speechBlock.on("click", function () {
                var id = d3.select(this).node().id;
                var matches = id.match(/_(\d+)_(\d+)/);
                if (!matches) {
                    console.error("Could not parse speech block id:", id);
                    return;
                }
                var pIdx = parseInt(matches[1], 10);
                var sIdx = parseInt(matches[2], 10);

                var block = interview[validParticipants[pIdx]][sIdx];
                if (!block) {
                    console.error("Block not found for pIdx/sIdx:", pIdx, sIdx);
                    return;
                }

                const blockTimeSeconds = getSpeechTimelineStartSeconds(block);
                d3.select("#full-slider").property("value", blockTimeSeconds);
                d3.select("#full-current-time").text(calculateTime(blockTimeSeconds));
                d3.select("#bar").attr("x", xObject.x(blockTimeSeconds)).raise();
                
                selectedParticipantObject.selectedParticipant = block.participant;
                barYValueObject.barYValue = yObject.y(block.participant) - 10;

                document.body.onkeyup = function (e) {
                    const audioNode = d3.select("#full-audiofile").node();
                    if (
                        selectedParticipantObject.selectedParticipant !== "" &&
                        hasAudioSource(audioNode) &&
                        (e.key === " " || e.code === "Space")
                    ) {
                        if (playObject.play) {
                            d3.select("#full-audiofile").node().play();
                            playObject.play = false;
                            d3.select("#full-play-pause-holder").attr("class", "pause");
                            d3.select("#full-play-pause").attr("src", "../static/images/pause-button.png");
                        } else {
                            d3.select("#full-audiofile").node().pause();
                            playObject.play = true;
                            d3.select("#full-play-pause-holder").attr("class", "play");
                            d3.select("#full-play-pause").attr("src", "../static/images/play-button.png");
                        }
                    }
                };
                safeRedraw(view);

                if (barObject.bar && !barObject.bar.empty()) {
                    barObject.bar.raise();
                }

                const participantMatch = findParticipantAudio(block.participant);
                if (participantMatch && participantMatch.audio && participantMatch.audio.relativePath) {
                    const audioSrc = buildServeAudioUrl(participantMatch.audio);
                    const sourceSet = setPlaybarAudioSource(audioSrc);
                    if (sourceSet) {
                        block.audioFileObject = participantMatch.audio;
                        playBar({ ...block, participant: block.participant });
                    } else {
                        safeClearPlaybarAudio({
                            displaySeconds: blockTimeSeconds,
                            maxDisplaySeconds: blockTimeSeconds,
                            reason: "Audio not available for this participant."
                        });
                    }
                } else {
                    safeClearPlaybarAudio({
                        displaySeconds: blockTimeSeconds,
                        maxDisplaySeconds: blockTimeSeconds,
                        reason: "Audio not provided for this participant."
                    });
                }

                d3.select(this).style("opacity", 1);
            });
        }
    }

    d3.selectAll("#scriptCount").text(`${count} result${count !== 1 ? "s" : ""} found.`);
    transcriptHeaderTitle.text(`Results for "${word}"`);
    safeRedraw(view);
}

function findIndexesOfWord(text, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    let match;
    const indexes = [];
    while ((match = regex.exec(text)) !== null) {
        indexes.push(match.index);
    }
    return indexes;
}
