import { 
    selectedParticipantObject, firstClickObject, themesObject, themeObject, highlight,
	kObject, xAxisObject, yAxisObject, yObject,
	xObject, svgObject, transcriptsObject} from "../../chromascribe-main.js";
import {drag,barObject} from "./dragRedPlayBar.js";
import { mouseover,mouseleave,click } from "./mouseState.js?v=20260601b";
import { addSpeeches } from "./transcripts.js?v=20260901b";
import { drawNonVerbalCueLayer } from "./nonVerbalCues.js?v=20260601b";
import {
    formatTimelineSeconds,
    getTimelineTickValues,
    getSpeechDurationSeconds,
    getSpeechTimelineStartSeconds
} from "./timeNormalization.js?v=20261006a";
//import { graphAudio } from "./graphAudio.js";
//import { semanticZoom } from "./semanticZoom.js";

var fullAudio = d3.select("#full-audiofile");

function normalizeSelectedThemeKeys() {
    const availableKeys = new Set(
        (Array.isArray(themesObject.themes) ? themesObject.themes : [])
            .map(theme => (theme && theme.themeName || "").toString().trim().toLowerCase())
            .filter(Boolean)
    );
    availableKeys.add("neutral");
    const filterAvailable = keys => keys.filter(themeKey => availableKeys.has(themeKey));
    const rawSelection = themeObject.theme;
    if (Array.isArray(rawSelection)) {
        return filterAvailable([...new Set(rawSelection
            .map(theme => (theme || "").toString().trim().toLowerCase())
            .filter(Boolean))]);
    }
    if (typeof rawSelection === "string" && rawSelection.trim()) {
        return filterAvailable([rawSelection.trim().toLowerCase()]);
    }
    return [];
}

function matchesAnySelectedTheme(speechDatum, selectedThemeKeys) {
    return getSelectedThemeFillColors(speechDatum, selectedThemeKeys).length > 0;
}

function normalizeThemeFillColor(rawColor) {
    const color = String(rawColor || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    if (/^#[0-9a-f]{3}$/i.test(color)) {
        return `#${color.slice(1).split("").map(value => value + value).join("")}`;
    }
    return "";
}

function normalizeMatchText(value) {
    return String(value || "")
        .replace(/[“”]/g, "\"")
        .replace(/[‘’]/g, "'")
        .replace(/[^a-z0-9]+/gi, " ")
        .replace(/\s+/g, " ")
        .replace(/^["']+|["']+$/g, "")
        .trim()
        .toLowerCase();
}

function matchTextTokens(value) {
    return normalizeMatchText(value)
        .split(/\s+/)
        .filter(token => token.length > 2);
}

function matchTextsHaveStrongOverlap(selectedText, speechText) {
    const selectedTokens = [...new Set(matchTextTokens(selectedText))];
    const orderedSpeechTokens = matchTextTokens(speechText);
    const speechTokens = new Set(orderedSpeechTokens);
    if (selectedTokens.length < 4 || speechTokens.size < 4) return false;
    const overlap = selectedTokens.filter(token => speechTokens.has(token)).length;
    const selectedCoverage = overlap / selectedTokens.length;
    const speechCoverage = overlap / speechTokens.size;
    const shorterCoverage = overlap / Math.min(selectedTokens.length, speechTokens.size);
    return overlap >= 4 && (
        selectedCoverage >= 0.5 ||
        speechCoverage >= 0.75 ||
        shorterCoverage >= 0.55
    );
}

function selectedTextMatchesSpeechText(selectedText, speechText, hasContext = false) {
    if (!selectedText || !speechText) return false;
    if (speechText === selectedText || speechText.includes(selectedText) || selectedText.includes(speechText)) {
        return true;
    }
    return hasContext && matchTextsHaveStrongOverlap(selectedText, speechText);
}

function normalizeParticipantCode(value) {
    const text = String(value || "").trim();
    const match = text.match(/\b(?:participant|p)\s*0*(\d+)\b/i);
    return match ? `P${parseInt(match[1], 10)}` : "";
}

function normalizeQaTag(value) {
    const match = String(value || "").trim().match(/\b([QA])\s*0*(\d+)([a-z]?)\b/i);
    return match ? `${match[1].toUpperCase()}${parseInt(match[2], 10)}${(match[3] || "").toLowerCase()}` : "";
}

function getQaTagBase(value) {
    const tag = normalizeQaTag(value);
    const match = tag.match(/^([QA]\d+)/i);
    return match ? match[1].toUpperCase() : "";
}

function qaTagsCompatible(leftTag, rightTag) {
    const left = normalizeQaTag(leftTag);
    const right = normalizeQaTag(rightTag);
    if (!left || !right) return false;
    if (left === right) return true;
    const leftBase = getQaTagBase(left);
    const rightBase = getQaTagBase(right);
    return Boolean(leftBase && rightBase && leftBase === rightBase);
}

function getSpeechQaTags(speech) {
    const rawTags = [];
    if (speech && typeof speech === "object") {
        rawTags.push(speech.tag);
        rawTags.push(speech.manualTag);
        rawTags.push(speech.aiSuggestedTag);
        rawTags.push(speech.originalTag);
        rawTags.push(speech.originalAiTag);
        if (Array.isArray(speech.additionalTags)) rawTags.push(...speech.additionalTags);
        if (Array.isArray(speech.aiSuggestedTags)) rawTags.push(...speech.aiSuggestedTags);
    }
    const seen = new Set();
    return rawTags
        .map(normalizeQaTag)
        .filter(tag => {
            if (!tag || seen.has(tag)) return false;
            seen.add(tag);
            return true;
        });
}

function normalizeTimestamp(value) {
    return String(value || "").replace(/\s+/g, "").trim();
}

function selectedThemeWordMatchesSpeech(wordEntry, speech) {
    if (!wordEntry || !speech) return false;

    const entry = typeof wordEntry === "object" ? wordEntry : { word: wordEntry };
    const speechText = normalizeMatchText(speech.script);
    if (!speechText) return false;

    const entryParticipant = normalizeParticipantCode(entry.participant || entry.speaker);
    const speechParticipant = normalizeParticipantCode(speech.participant || speech.speaker);
    if (entryParticipant && (!speechParticipant || entryParticipant !== speechParticipant)) {
        return false;
    }

    const entryTag = normalizeQaTag(entry.tag || entry.speaker);
    const speechTags = getSpeechQaTags(speech);
    if (entryTag && !speechTags.some(tag => qaTagsCompatible(entryTag, tag))) {
        return false;
    }

    const entryTimestamp = normalizeTimestamp(entry.timestamp);
    const speechTimestamp = normalizeTimestamp(speech.timestamp);
    if (entryTimestamp && (!speechTimestamp || entryTimestamp !== speechTimestamp)) {
        const hasTextFallback = Boolean(entry.cueText || entry.word || entry.text || entry.quote || entry.excerpt);
        if (!hasTextFallback) return false;
    }

    const cueText = normalizeMatchText(entry.cueText);
    const hasContext = Boolean(entryParticipant || entryTag || entryTimestamp || cueText);
    if (cueText && selectedTextMatchesSpeechText(cueText, speechText, hasContext)) {
        return true;
    }

    const selectedText = normalizeMatchText(entry.word || entry.text || entry.quote || entry.excerpt);
    if (selectedTextMatchesSpeechText(selectedText, speechText, hasContext)) {
        return true;
    }

    return Boolean(entryTimestamp && speechTimestamp && entryTimestamp === speechTimestamp && !selectedText && !cueText);
}

function themeHasSelectedExcerptForSpeech(theme, speech) {
    const words = Array.isArray(theme && theme.words) ? theme.words : [];
    return words.some(wordEntry => selectedThemeWordMatchesSpeech(wordEntry, speech));
}

function selectedTextSpeechMatchScore(selectedText, speechText, hasContext = false) {
    if (!selectedText || !speechText) return 0;
    if (speechText === selectedText) return 4;
    if (speechText.includes(selectedText) || selectedText.includes(speechText)) return 3;
    if (!hasContext) return 0;

    const selectedTokens = [...new Set(matchTextTokens(selectedText))];
    const orderedSpeechTokens = matchTextTokens(speechText);
    const speechTokens = new Set(orderedSpeechTokens);
    if (selectedTokens.length < 4 || speechTokens.size < 4) return 0;

    const overlap = selectedTokens.filter(token => speechTokens.has(token)).length;
    if (overlap < 4) return 0;

    const selectedCoverage = overlap / selectedTokens.length;
    const speechCoverage = overlap / speechTokens.size;
    const shorterCoverage = overlap / Math.min(selectedTokens.length, speechTokens.size);
    if (selectedCoverage < 0.5 && speechCoverage < 0.75 && shorterCoverage < 0.55) {
        return 0;
    }
    const leadPhrase = selectedTokens.slice(0, Math.min(6, selectedTokens.length)).join(" ");
    const startsNearQuoteBeginning = leadPhrase && orderedSpeechTokens.join(" ").includes(leadPhrase);
    return 1 + selectedCoverage + speechCoverage + shorterCoverage + (startsNearQuoteBeginning ? 0.75 : 0);
}

function selectedExcerptSpeechMatchScore(wordEntry, speech, fallbackParticipant = "") {
    if (!wordEntry || !speech) return 0;

    const entry = typeof wordEntry === "object" ? wordEntry : { word: wordEntry };
    const speechText = normalizeMatchText(speech.script || speech.text || speech.word);
    if (!speechText) return 0;

    const entryParticipant = normalizeParticipantCode(entry.participant || entry.speaker);
    const speechParticipant = normalizeParticipantCode(speech.participant || fallbackParticipant || speech.speaker);
    if (entryParticipant && (!speechParticipant || entryParticipant !== speechParticipant)) {
        return 0;
    }

    const entryTag = normalizeQaTag(entry.tag || entry.speaker);
    const speechTags = getSpeechQaTags(speech);
    if (entryTag && !speechTags.some(tag => qaTagsCompatible(entryTag, tag))) {
        return 0;
    }

    const entryTimestamp = normalizeTimestamp(entry.timestamp);
    const speechTimestamp = normalizeTimestamp(speech.timestamp);
    const cueText = normalizeMatchText(entry.cueText);
    const selectedText = normalizeMatchText(entry.word || entry.text || entry.quote || entry.excerpt);
    const hasTextFallback = Boolean(cueText || selectedText);
    let contextScore = 0;

    if (entryParticipant) contextScore += 0.5;
    if (entryTag) contextScore += 0.5;
    if (entryTimestamp) {
        if (speechTimestamp && entryTimestamp === speechTimestamp) {
            contextScore += 2;
        } else if (!hasTextFallback) {
            return 0;
        }
    }

    const hasContext = Boolean(entryParticipant || entryTag || entryTimestamp || cueText);
    const textScore = Math.max(
        selectedTextSpeechMatchScore(cueText, speechText, hasContext),
        selectedTextSpeechMatchScore(selectedText, speechText, hasContext)
    );

    if (textScore > 0) return textScore + contextScore;
    return entryTimestamp && speechTimestamp && entryTimestamp === speechTimestamp ? 1 + contextScore : 0;
}

function selectedExcerptHasText(wordEntry) {
    if (!wordEntry) return false;
    if (typeof wordEntry === "string") return Boolean(normalizeMatchText(wordEntry));
    return Boolean(normalizeMatchText(wordEntry.word || wordEntry.text || wordEntry.quote || wordEntry.excerpt || wordEntry.cueText));
}

function getThemeForSelectedKey(selectedKey) {
    return (Array.isArray(themesObject.themes) ? themesObject.themes : []).find(
        theme => (theme.themeName || "").toLowerCase() === selectedKey
    );
}

function collectParticipantTranscripts(temp) {
    const participantTranscripts = new Map();
    if (Array.isArray(temp)) {
        temp.forEach(participantData => {
            const participantId = String(participantData && participantData.participant || "").trim();
            if (participantId && Array.isArray(participantData && participantData.transcript)) {
                participantTranscripts.set(participantId, participantData.transcript);
            }
        });
    }
    Object.entries(transcriptsObject.transcripts || {}).forEach(([participantId, transcript]) => {
        if (participantId && Array.isArray(transcript) && !participantTranscripts.has(participantId)) {
            participantTranscripts.set(participantId, transcript);
        }
    });
    return participantTranscripts;
}

function findBestSelectedExcerptSpeech(wordEntry, participantTranscripts) {
    const entry = typeof wordEntry === "object" ? wordEntry : { word: wordEntry };
    const entryParticipant = normalizeParticipantCode(entry.participant || entry.speaker);
    const candidates = entryParticipant && participantTranscripts.has(entryParticipant)
        ? [[entryParticipant, participantTranscripts.get(entryParticipant)]]
        : Array.from(participantTranscripts.entries());

    let bestMatch = null;
    candidates.forEach(([participantId, transcript]) => {
        if (!Array.isArray(transcript)) return;
        transcript.forEach((speech, speechIndex) => {
            if (!speech || typeof speech !== "object") return;
            const score = selectedExcerptSpeechMatchScore(wordEntry, speech, participantId);
            if (score <= 0) return;
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { participantId, speech, speechIndex, score };
            }
        });
    });
    return bestMatch;
}

function collectSelectedExcerptOverlays(selectedThemeKeys, temp) {
    if (!Array.isArray(selectedThemeKeys) || selectedThemeKeys.length === 0 || selectedThemeKeys.includes("neutral")) {
        return [];
    }

    const participantTranscripts = collectParticipantTranscripts(temp);
    const overlays = [];
    const seen = new Set();
    selectedThemeKeys.forEach(selectedKey => {
        const theme = getThemeForSelectedKey(selectedKey);
        const words = Array.isArray(theme && theme.words) ? theme.words : [];
        if (!theme || words.length === 0) return;

        words.forEach((wordEntry, wordIndex) => {
            if (!selectedExcerptHasText(wordEntry)) return;
            const match = findBestSelectedExcerptSpeech(wordEntry, participantTranscripts);
            if (!match) return;
            const key = `${theme.themeName}||${wordIndex}||${match.participantId}||${match.speechIndex}`;
            if (seen.has(key)) return;
            seen.add(key);
            overlays.push({
                theme,
                wordEntry,
                wordIndex,
                participantId: match.participantId,
                speech: match.speech,
                speechIndex: match.speechIndex,
                score: match.score
            });
        });
    });
    return overlays;
}

function drawSelectedExcerptOverlays(selectedThemeKeys, temp) {
    const overlays = collectSelectedExcerptOverlays(selectedThemeKeys, temp);
    if (overlays.length === 0) return;

    const overlayGroup = svgObject.svg.append("g")
        .attr("class", "selected-excerpt-overlays");

    overlayGroup.selectAll("rect")
        .data(overlays)
        .enter()
        .append("rect")
        .attr("class", "selected-excerpt-overlay")
        .attr("data-theme", d => d.theme.themeName || "")
        .attr("data-participant", d => d.participantId || "")
        .attr("data-transcript-index", d => d.speechIndex)
        .attr("x", d => xObject.x(getSpeechTimelineStartSeconds(d.speech)))
        .attr("y", d => {
            const yBase = yObject.y(d.participantId);
            if (d.speech.speaker === "S1" || d.speech.speaker === "Interviewer") return yBase - 1;
            return yBase + 16 + 1;
        })
        .attr("width", d => Math.max(5, xObject.x(getSpeechDurationSeconds(d.speech)) - xObject.x(0)))
        .attr("height", d => (d.speech.speaker === "S1" || d.speech.speaker === "Interviewer") ? 16 : 40)
        .attr("fill", d => normalizeThemeFillColor(d.theme.color) || highlight["Neutral"] || "#eeedef")
        .style("opacity", 0.96)
        .style("stroke", "none")
        .style("cursor", "pointer")
        .each(function(d) {
            d.speech.participant = d.participantId;
            d.speech._transcriptIndex = d.speechIndex;
        })
        .on("mouseover", function(d) {
            mouseover.call(this, d.speech);
        })
        .on("mouseleave", mouseleave)
        .on("click", function(d) {
            click.call(this, d.speech, d.speechIndex);
        });
}

function getSpeechThemeFillColors(speech) {
    const sourceColors = Array.isArray(speech && speech._themeColors) && speech._themeColors.length > 0
        ? speech._themeColors
        : [(speech && speech.color) || ""];
    const colors = [];
    const seen = new Set();
    sourceColors.forEach(rawColor => {
        const color = normalizeThemeFillColor(rawColor);
        if (!color || seen.has(color.toLowerCase())) return;
        seen.add(color.toLowerCase());
        colors.push(color);
    });
    return colors;
}

function getSelectedThemeFillColors(speech, selectedThemeKeys) {
    if (!speech || !Array.isArray(selectedThemeKeys) || selectedThemeKeys.length === 0 || selectedThemeKeys.includes("neutral")) {
        return [];
    }

    const colors = [];
    const seen = new Set();
    const selectedExcerptOnly = window.VISUALIZATION_SELECTED_EXCERPTS_ONLY === true;
    selectedThemeKeys.forEach(selectedKey => {
        const themeMeta = themesObject.themes.find(
            theme => (theme.themeName || "").toLowerCase() === selectedKey
        );
        if (!themeMeta) return;

        const color = normalizeThemeFillColor(themeMeta.color);
        if (!color || seen.has(color.toLowerCase())) return;

        const confidence = Number(speech[themeMeta.themeName]);
        const hasAssignedSelectedExcerpt = Number.isFinite(confidence) && confidence > 0;
        if (selectedExcerptOnly) {
            if (hasAssignedSelectedExcerpt) {
                seen.add(color.toLowerCase());
                colors.push(color);
            }
            return;
        }

        const hasSelectedExcerptMatch = themeHasSelectedExcerptForSpeech(themeMeta, speech);
        if (hasAssignedSelectedExcerpt || hasSelectedExcerptMatch) {
            seen.add(color.toLowerCase());
            colors.push(color);
        }
    });
    return colors;
}

function resolveSpeechFill(speech, gradientCache, selectedThemeKeys) {
    const colors = selectedThemeKeys.length > 0
        ? getSelectedThemeFillColors(speech, selectedThemeKeys)
        : getSpeechThemeFillColors(speech);
    if (colors.length <= 1) {
        return colors[0] || highlight["Neutral"] || "#eeedef";
    }

    const key = colors.map(color => color.toLowerCase()).join("|");
    if (gradientCache.has(key)) {
        return `url(#${gradientCache.get(key)})`;
    }

    const gradientId = `theme-stripe-${gradientCache.size}`;
    gradientCache.set(key, gradientId);
    const defs = svgObject.svg.select("defs.theme-fill-defs").empty()
        ? svgObject.svg.append("defs").attr("class", "theme-fill-defs")
        : svgObject.svg.select("defs.theme-fill-defs");
    const gradient = defs.append("linearGradient")
        .attr("id", gradientId)
        .attr("x1", "0%")
        .attr("x2", "100%")
        .attr("y1", "0%")
        .attr("y2", "0%");
    const step = 100 / colors.length;
    colors.forEach((color, index) => {
        const start = `${index * step}%`;
        const end = `${(index + 1) * step}%`;
        gradient.append("stop").attr("offset", start).attr("stop-color", color);
        gradient.append("stop").attr("offset", end).attr("stop-color", color);
    });
    return `url(#${gradientId})`;
}

export function drawVisualization(temp) {

    
    // Clear the SVG for a fresh draw
	if (!svgObject.svg || svgObject.svg.empty()) {
        console.error("drawVisualization Error: svgObject.svg was not initialized by graphAxes.");
        return;
    }

	// Clear only the elements that this function draws
	svgObject.svg.selectAll("#speech, .x-axis, .fixedYAxisIcons, #bar, .row-hit-targets, .selected-excerpt-overlays, .non-verbal-cues-layer, .theme-fill-defs").remove();
    const gradientCache = new Map();
    const selectedThemeKeys = normalizeSelectedThemeKeys();
    
    
	
	// --- CORRECTED PARTICIPANT LIST CREATION ---
    // 1. Get a unique list of participant IDs directly from the data.
    // 2. Sort them numerically.
	const participants = yObject.y.domain(); // Get the participant list directly from the y-scale's domain
    const height = yObject.y.range()[1]; // Get height from the y-scale's range

	// Draw the X-axis (or re-draw it if needed, graphAxes already drew it once)
	const [, axisMaxSeconds = 0] = xObject.x.domain();
	const [axisStart, axisEnd] = xObject.x.range();
	const timelineTicks = getTimelineTickValues(axisMaxSeconds, Math.abs(axisEnd - axisStart));
	xAxisObject.xAxis = svgObject.svg.append("g")
		.attr("class", "x-axis")
		.call(d3.axisTop(xObject.x)
		.tickValues(timelineTicks)
		.tickFormat(formatTimelineSeconds)
		);

	const currentTimeInSeconds = Math.floor(Number(d3.select("#full-slider").property("value")) || 0);
	barObject.bar = svgObject.svg.append("rect")
		.attr("id", "bar")
		.style("rx", "2px")
		.attr("x", xObject.x(currentTimeInSeconds))
		.attr("y", yObject.y(selectedParticipantObject.selectedParticipant) || -9999) // Safely get y-pos
		.call(drag);

	
	// Visibility check for the bar
	if (firstClickObject.firstClick || !participants.includes(selectedParticipantObject.selectedParticipant)) {
		barObject.bar.style("opacity", 0);
    } else {
		barObject.bar.style("opacity", 1);
    }

    const showParticipantTranscript = (participantId) => {
        const transcript = transcriptsObject.transcripts[participantId];
        if (!transcript || transcript.length === 0) return;
        selectedParticipantObject.selectedParticipant = participantId;
        addSpeeches({ participant: participantId }, transcript);
    };

    // Clickable row background to switch transcripts without hitting a segment
    const rowHitGroup = svgObject.svg.append("g")
        .attr("class", "row-hit-targets");
    rowHitGroup.selectAll("rect")
        .data(participants)
        .enter()
        .append("rect")
        .attr("x", 0)
        .attr("y", d => yObject.y(d))
        .attr("width", xObject.x.range()[1])
        .attr("height", yObject.y.bandwidth())
        .style("fill", "transparent")
        .style("cursor", "pointer")
        .on("click", function(participantId) { showParticipantTranscript(participantId); });

	// --- DRAWING SPEECH RECTS ---
	temp.forEach(participantData => {
        const yValue = yObject.y(participantData.participant);
        if (yValue === undefined || yValue === null) return;
        participantData.transcript.forEach((speech, speechIdx) => {
            speech.participant = participantData.participant;
            speech._transcriptIndex = speechIdx;
        });

        svgObject.svg.selectAll(`.speech-rects-${participantData.participant}`)
            .data(participantData.transcript)
            .enter()
            .append("rect")
            .attr("id", "speech")
            .attr("class", `speech-rects-${participantData.participant}`)
            //.style("z-index", -100)
            .attr("x", function(speech) { 
                return xObject.x(getSpeechTimelineStartSeconds(speech));
            })
            .attr("y", function(speech) {
                const y_base = yObject.y(participantData.participant);
                if (speech.speaker === "S1" || speech.speaker === "Interviewer") return y_base - 1;
                return y_base + 16 + 1;
            })
             .attr("width", function(speech) {
                const durationInSeconds = getSpeechDurationSeconds(speech);
                return xObject.x(durationInSeconds) - xObject.x(0);
            })
            .attr("height", function(speech){
                if (speech.speaker === "S1" || speech.speaker === "Interviewer") return 16;
                return 40;
            })
            .attr("fill", function(speech) { return resolveSpeechFill(speech, gradientCache, selectedThemeKeys); })
            .on("mouseover", mouseover)
            .on("mouseleave", mouseleave)
            .on("click", function(speech, speechIndex) {
                click.call(this, speech, speechIndex);
            });
	});


	// --- THEME FILTERING ---
    svgObject.svg.selectAll("#speech").style("opacity", function(d) {
        if (selectedThemeKeys.length === 0) return 1;
        if (selectedThemeKeys.includes("neutral")) {
            return d && d.color === highlight["Neutral"] ? 1 : 0.2;
        }
        return matchesAnySelectedTheme(d, selectedThemeKeys) ? 1 : 0.2;
    });

    try {
        drawSelectedExcerptOverlays(selectedThemeKeys, temp);
    } catch (error) {
        console.warn("Selected excerpt overlays failed to render:", error);
    }

	// --- Y-AXIS SETUP (Now guaranteed to have correct domain) ---
    const icons = ["/static/images/interviewer.svg", "/static/images/user_green.png", "/static/images/audio_mic.png"];
	
	yObject.y.domain(participants)
	//yObject.y = d3.scaleBand().domain(participants)
		.range([0, height])
		.padding(.25);

	var fixedGroup = svgObject.svg.append("g")
        .attr("class", "fixedYAxisIcons")
        .style("z-index", 999).attr("transform", "translate(0,0)");
		
	fixedGroup.append("rect")
        .attr("class", "axis-background")
        .attr("x", -70).attr("y", 0).attr("width", 70).attr("height", height).attr("fill", "white");
	
	fixedGroup.append("g")
		.attr("class", "axis")
		.style("font-size", "12px").attr("fill", "white") // 'fill' here might be incorrect, styles usually on text
		.call(d3.axisLeft(yObject.y));

    fixedGroup.selectAll(".tick text")
			.attr("class", "axis")
			.attr("dy", "1.7em").attr("dx", "-2em");

	fixedGroup.selectAll(".icon1")
		.data(participants).enter().append("image")
		.attr("class", "axis")
		.attr("xlink:href", icons[0])
		.attr("x", -30).attr("y", d => yObject.y(d) + yObject.y.bandwidth() / 2 - 35)
		.attr("width", 20).attr("height", 20);

	fixedGroup.selectAll(".icon2")
		.data(participants).enter().append("image")
		.attr("class", "axis")
		.attr("xlink:href", icons[1])
		.attr("x", -30).attr("y", d => yObject.y(d) + yObject.y.bandwidth() / 2 + 5)
		.attr("width", 20).attr("height", 20);

    drawNonVerbalCueLayer(participants);
	
	fixedGroup.raise();
	barObject.bar.raise();

    if (selectedParticipantObject.selectedParticipant && !participants.includes(selectedParticipantObject.selectedParticipant)) {
        selectedParticipantObject.selectedParticipant = "";
    }

	// Initialize transcript panel only when nothing is selected.
	// On redraws (zoom/theme), keep the current transcript stable.
	const transcriptSelection = d3.select("#transcript");
	if (!selectedParticipantObject.selectedParticipant) {
		transcriptSelection.selectAll("*").remove();
		transcriptSelection.append("div")
			.attr("id", "scriptStmt")
			.style("text-align", "center")
			.style("margin-top", "40%")
			.text("Click on a participant row to see the transcript");

		// Auto-populate the transcript panel with the first participant on initial load.
		if (participants.length > 0) {
			showParticipantTranscript(participants[0]);
		}
	} else {
		const transcriptNode = transcriptSelection.node();
		if (transcriptNode && transcriptNode.childElementCount === 0) {
			showParticipantTranscript(selectedParticipantObject.selectedParticipant);
		}
	}

    // Make Y-axis labels/icons clickable to show transcripts
    fixedGroup.selectAll(".tick text")
        .style("cursor", "pointer")
        .on("click", function(participantId) { showParticipantTranscript(participantId); });

    fixedGroup.selectAll(".icon1, .icon2")
        .style("cursor", "pointer")
        .on("click", function(participantId) { showParticipantTranscript(participantId); });
}
