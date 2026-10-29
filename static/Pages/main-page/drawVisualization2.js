import { 
    selectedParticipantObject, themesObject, themeObject, highlight,
	kObject, yObject, xObject, svgObject,
    currentDisplayObject, transcriptsObject } from "../../chromascribe-main.js";
import { mouseover, mouseleave, click } from "./mouseState.js?v=20260601b";
import { addSpeeches } from "./transcripts.js?v=20260901b";
import { drawNonVerbalCueLayer } from "./nonVerbalCues.js?v=20260601b";

export let allQuestionTags = [];

// Helper function to convert "MM:SS" string to total seconds
const getSeconds = (durationStr) => {
    if (!durationStr || !durationStr.includes(':')) return 0;
    const parts = durationStr.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
};

// Normalize toolbar theme state into a stable lowercase array for matching.
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

// Speech objects store selected excerpt assignments under the original theme names,
// so resolve the selected UI labels back to theme metadata before checking them.
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
    const speechTokens = new Set(matchTextTokens(speechText));
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
            if (hasAssignedSelectedExcerpt || themeHasSelectedExcerptForSpeech(themeMeta, speech)) {
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

    const gradientId = `question-theme-stripe-${gradientCache.size}`;
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

function isInterviewerSpeech(speech) {
    const speaker = String((speech && speech.speaker) || "").trim().toLowerCase();
    return speaker === "s1" || speaker.startsWith("interviewer") || speaker === "ai";
}

function qaTagSortKey(tag) {
    const match = String(tag || "").trim().match(/^[QA]?\s*0*(\d+)([a-z]?)$/i);
    if (!match) {
        return { number: Number.MAX_SAFE_INTEGER, suffixRank: 0, text: String(tag || "").toLowerCase() };
    }
    const suffix = (match[2] || "").toLowerCase();
    return {
        number: parseInt(match[1], 10),
        suffixRank: suffix ? suffix.charCodeAt(0) - 96 : 0,
        text: String(tag || "").toLowerCase()
    };
}

function sortTagsByNumber(a, b) {
    const left = qaTagSortKey(a);
    const right = qaTagSortKey(b);
    if (left.number !== right.number) return left.number - right.number;
    if (left.suffixRank !== right.suffixRank) return left.suffixRank - right.suffixRank;
    return left.text.localeCompare(right.text);
}

function hasGroupedSpeech(groupMap) {
    return Object.values(groupMap || {}).some(group => Array.isArray(group) && group.length > 0);
}

function appendGroupedSpeech(target, pId, tag, speech, speechIndex) {
    if (!target[pId]) target[pId] = {};
    if (!target[pId][tag]) target[pId][tag] = [];
    speech.participant = pId;
    speech._transcriptIndex = speechIndex;
    target[pId][tag].push(speech);
}

function addNeutralPreviewQuestionGroups(pId, transcript, questionGroups, answerGroups) {
    let currentQuestionNumber = 0;

    transcript.forEach((speech, speechIndex) => {
        if (!speech) return;

        if (isInterviewerSpeech(speech)) {
            currentQuestionNumber += 1;
            appendGroupedSpeech(
                questionGroups,
                pId,
                `Q${currentQuestionNumber}`,
                speech,
                speechIndex
            );
            return;
        }

        if (currentQuestionNumber === 0) {
            currentQuestionNumber = 1;
        }
        appendGroupedSpeech(
            answerGroups,
            pId,
            `A${currentQuestionNumber}`,
            speech,
            speechIndex
        );
    });
}

// Prefer the active y-scale ordering so this view stays in sync with the current
// participant layout, and fall back to the transcript map on first load.
function getVisibleParticipants() {
    if (yObject.y && typeof yObject.y.domain === "function") {
        const participants = yObject.y.domain();
        if (Array.isArray(participants) && participants.length > 0) {
            return participants;
        }
    }

    return Object.keys(transcriptsObject.transcripts || {}).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
    );
}

function buildQuestionAndAnswerGroups(temp = []) {
    const questionGroups = {};
    const answerGroups = {};
    const seenParticipants = new Set();

    // Split each participant transcript into question/answer buckets keyed by tag so
    // the draw pass can position grouped segments without re-scanning transcripts.
    const addTranscript = (participantId, transcript) => {
        const pId = String(participantId || "").trim();
        if (!pId || seenParticipants.has(pId) || !Array.isArray(transcript)) return;

        seenParticipants.add(pId);
        questionGroups[pId] = {};
        answerGroups[pId] = {};

        transcript.forEach((speech, speechIndex) => {
            const tag = String((speech && speech.tag) || "").trim();
            if (!speech || !tag || tag === "None") return;

            // Always stamp participant/index for reliable click->transcript mapping.
            if (tag.startsWith("Q")) {
                appendGroupedSpeech(questionGroups, pId, tag, speech, speechIndex);
            } else if (tag.startsWith("A")) {
                appendGroupedSpeech(answerGroups, pId, tag, speech, speechIndex);
            }
        });

        if (!hasGroupedSpeech(questionGroups[pId]) && !hasGroupedSpeech(answerGroups[pId])) {
            addNeutralPreviewQuestionGroups(pId, transcript, questionGroups, answerGroups);
        }
    };

    Object.entries(transcriptsObject.transcripts || {}).forEach(([pId, transcript]) => {
        addTranscript(pId, transcript);
    });

    if (Array.isArray(temp)) {
        temp.forEach(entry => {
            addTranscript(entry && entry.participant, entry && entry.transcript);
        });
    }

    return { questionGroups, answerGroups };
}

export function drawVisualization2(temp) {
	console.log("Drawing Question View. The toolbar should be visible.");

	if (!svgObject.svg || svgObject.svg.empty()) {
        console.error("drawVisualization2 Error: svgObject.svg not initialized.");
        return;
    }
    // Clear the canvas prepared by graphAxes
	svgObject.svg.selectAll("*").remove();
    const gradientCache = new Map();

    // --- 1. DATA GROUPING ---
    // Use the loaded transcript map as the source of truth. The `temp` display
    // array can be stale or filtered to the first participant during view changes.
    const { questionGroups, answerGroups } = buildQuestionAndAnswerGroups(temp);
    const selectedThemeKeys = normalizeSelectedThemeKeys();
    const participants = getVisibleParticipants();
    
    // --- 2. THE FIX: Determine all possible tags ONCE ---
    // If we are drawing for the first time (i.e., not filtering), find and store all tags.
    // We can detect the first run by checking if `temp` (the data passed in) has the same
    // number of participants as the full dataset.
    //On subsequent draws (like after filtering), we re-use the cached list.
    if (allQuestionTags.length === 0) {
        const discoveredTags = new Set();
        Object.values(questionGroups).forEach(participantQuestions => {
            Object.keys(participantQuestions || {}).forEach(qTag => discoveredTags.add(qTag));
        });
        Object.values(answerGroups).forEach(participantAnswers => {
            Object.keys(participantAnswers || {}).forEach(aTag => {
                if (aTag.startsWith("A")) {
                    discoveredTags.add("Q" + aTag.substring(1));
                }
            });
        });
        allQuestionTags = Array.from(discoveredTags).sort(sortTagsByNumber);
        console.log("Found and stored all possible question tags:", allQuestionTags);
    }
    // --- END OF FIX ---

    // const allQuestionTags  = Array.from(new Set(Object.values(questionGroups).flatMap(p => Object.keys(p))))
    //                     .sort((a, b) => parseInt(a.substring(1)) - parseInt(b.substring(1)));

    console.log("what is tag", allQuestionTags );


    // --- 3. X-AXIS AND LAYOUT  ---
    let questionBaseX = {};
    let questionSpacing = 80;
    let currentX = 10;
    
    // Reserve one horizontal slot per question tag using the widest participant
    // block so every row shares the same question/answer alignment.
    allQuestionTags.forEach(qTag => {
        const aTag = 'A' + qTag.substring(1); // Map "Q1" to "A1"
        let maxGroupWidth  = 0;
        
         participants.forEach(pId => {
            let questionWidth = 0;
            if (questionGroups[pId] && questionGroups[pId][qTag]) {
                questionWidth = questionGroups[pId][qTag].reduce((sum, s) => sum + (xObject.x(getSeconds(s.duration)) * kObject.k), 0);
            }
            let answerWidth = 0;
            if (answerGroups[pId] && answerGroups[pId][aTag]) {
                answerWidth = answerGroups[pId][aTag].reduce((sum, s) => sum + (xObject.x(getSeconds(s.duration)) * kObject.k), 0);
            }
            const groupWidth = Math.max(questionWidth, answerWidth);
            if (groupWidth > maxGroupWidth) maxGroupWidth = groupWidth;
        });
        questionBaseX[qTag] = { start: currentX, width: maxGroupWidth };
        currentX += maxGroupWidth + questionSpacing;
    });

    // --- 4. DRAW THE X-AXIS NOW (Moved this block down) ---
    // Now that questionBaseX is populated, this will work without error.
    const questionScale = d3.scalePoint().domain(allQuestionTags).range([0, Math.max(currentX - questionSpacing, 0)]);
    svgObject.svg.append("g")
        .attr("class", "x axis")
        .style("font-size", "16px")
        .call(d3.axisTop(questionScale))
        .selectAll(".tick").attr("transform", d => `translate(${questionBaseX[d].start}, 0)`);
    
    // Set SVG width for scrolling
    const graphSvg = d3.select("#graph");
    graphSvg.attr("width", currentX + 120);

    const showParticipantTranscript = (participantId) => {
        const transcript = transcriptsObject.transcripts[participantId];
        if (!transcript || transcript.length === 0) return;
        selectedParticipantObject.selectedParticipant = participantId;
        addSpeeches({ participant: participantId }, transcript);
    };

    // Add a row-sized transparent hit target so transcript switching does not
    // require the user to click directly on a colored segment.
    const rowHitGroup = svgObject.svg.append("g")
        .attr("class", "row-hit-targets");
    rowHitGroup.selectAll("rect")
        .data(participants)
        .enter()
        .append("rect")
        .attr("x", 0)
        .attr("y", d => yObject.y(d))
        .attr("width", currentX)
        .attr("height", yObject.y.bandwidth())
        .style("fill", "transparent")
        .style("cursor", "pointer")
        .on("click", function(participantId) { showParticipantTranscript(participantId); });

    // --- 5. RECTANGLE DRAWING (Specific to this view) ---

    participants.forEach(pId => { // Loop through the correct participant IDs
        const yPos = yObject.y(pId);
        if (yPos === undefined) {
            console.warn(`Skipping ${pId}: not in yObject.y domain =`, yObject.y.domain());
            return;
        }
        if (!questionGroups[pId] && !answerGroups[pId]) {
            // Skip this participant if they have no question data
            console.log(`   - Skipping ${pId} (no question data in questionGroups).`);
            return; 
        }

        allQuestionTags.forEach(qNum => {
            const aNum = 'A' + qNum.substring(1); // Map Q -> A
            const questionSpeeches = (questionGroups[pId] && questionGroups[pId][qNum]) ? questionGroups[pId][qNum] : [];
            const answerSpeeches = (answerGroups[pId] && answerGroups[pId][aNum]) ? answerGroups[pId][aNum] : [];

            if (questionSpeeches.length > 0 || answerSpeeches.length > 0) {
                let questionX = questionBaseX[qNum].start;
                let answerX = questionBaseX[qNum].start;
                const questionTotalWidth = questionSpeeches.reduce((sum, s) => sum + (xObject.x(getSeconds(s.duration)) * kObject.k), 0);
                const answerTotalWidth = answerSpeeches.reduce((sum, s) => sum + (xObject.x(getSeconds(s.duration)) * kObject.k), 0);
                let totalWidth = Math.max(questionTotalWidth, answerTotalWidth, 4);
                
                // Outline the full Q/A block so related segments read as one unit.
                svgObject.svg.append("rect") // Bounding box
                    .attr("x", questionBaseX[qNum].start).attr("y", yObject.y(pId) - 2)
                    .attr("width", totalWidth).attr("height", 60)
                    .attr("class", "question-bounds")
                    .style("stroke", "black").style("stroke-width", 1).style("fill", "none");

                questionSpeeches.forEach(speech => {
                    const rectWidth = xObject.x(getSeconds(speech.duration)) * kObject.k;
                    svgObject.svg.append("rect")
                        .datum(speech)
                        .attr("class", "speech-rect")
                        .attr("data-participant", pId)
                        .attr("data-transcript-index", Number.isInteger(speech._transcriptIndex) ? speech._transcriptIndex : "")
                        .attr("x", questionX)
                        .attr("y", yObject.y(pId) - 1)
                        .attr("width", rectWidth)
                        .attr("height", 16)
                        .style("fill", resolveSpeechFill(speech, gradientCache, selectedThemeKeys))
                        .on("mouseover", mouseover)
                        .on("mouseleave", mouseleave)
                        .on("click", function(d) {
                            if (!d || d.color === "#ffffff") return;
                            // Pass an explicit transcript index so right-panel focus is stable.
                            const speechIndex = Number.isInteger(d._transcriptIndex) ? d._transcriptIndex : null;
                            click.call(this, d, speechIndex);
                        });
                    questionX += rectWidth;
                });

                // Answers sit in the lower, taller lane so multi-sentence responses are
                // visually separated from the interviewer question above.
                answerSpeeches.forEach(speech => {
                    const rectWidth = xObject.x(getSeconds(speech.duration)) * kObject.k;
                    svgObject.svg.append("rect")
                        .datum(speech)
                        .attr("class", "speech-rect")
                        .attr("data-participant", pId)
                        .attr("data-transcript-index", Number.isInteger(speech._transcriptIndex) ? speech._transcriptIndex : "")
                        .attr("x", answerX)
                        .attr("y", yObject.y(pId) + 16 + 1)
                        .attr("width", rectWidth)
                        .attr("height", 40)
                        .style("fill", resolveSpeechFill(speech, gradientCache, selectedThemeKeys))
                        .on("mouseover", mouseover)
                        .on("mouseleave", mouseleave)
                        .on("click", function(d) {
                            if (!d || d.color === "#ffffff") return;
                            const speechIndex = Number.isInteger(d._transcriptIndex) ? d._transcriptIndex : null;
                            click.call(this, d, speechIndex);
                        });
                    answerX += rectWidth;
                });
            }
        });
    });

    // --- THEME FILTERING (Match timeline view logic) ---
    svgObject.svg.selectAll(".speech-rect").style("opacity", function(d) {
        if (selectedThemeKeys.length === 0) return 1;
        if (selectedThemeKeys.includes("neutral")) {
            return d && d.color === highlight["Neutral"] ? 1 : 0.2;
        }
        return matchesAnySelectedTheme(d, selectedThemeKeys) ? 1 : 0.2;
    });

    // --- 6. Y-AXIS DRAWING  ---
    const height = yObject.y.range()[1];
    const icons = ["/static/images/interviewer.svg", "/static/images/user_green.png"];
	
    // Keep labels/icons in a dedicated group so the participant axis remains readable
    // while the question view scrolls horizontally.
	var fixedGroup = svgObject.svg.append("g")
        .attr("class", "fixedYAxisIcons")
        .style("z-index", 999).attr("transform", "translate(0,0)");
		
	fixedGroup.append("rect")
        .attr("class", "axis-background")
        .attr("x", -70).attr("y", 0).attr("width", 70).attr("height", height).attr("fill", "white");
	
	fixedGroup.append("g")
		.attr("class", "axis")
		.style("font-size", "12px")
		.call(d3.axisLeft(yObject.y));

    fixedGroup.selectAll(".tick text")
			.attr("dy", "1.7em").attr("dx", "-2em");

	fixedGroup.selectAll(".icon1")
		.data(participants).enter().append("image")
		.attr("xlink:href", icons[0])
		.attr("x", -30).attr("y", d => yObject.y(d) + yObject.y.bandwidth() / 2 - 35)
		.attr("width", 20).attr("height", 20);

	fixedGroup.selectAll(".icon2")
		.data(participants).enter().append("image")
		.attr("xlink:href", icons[1])
		.attr("x", -30).attr("y", d => yObject.y(d) + yObject.y.bandwidth() / 2 + 5)
		.attr("width", 20).attr("height", 20);

    fixedGroup.selectAll(".tick text")
        .style("cursor", "pointer")
        .on("click", function(participantId) { showParticipantTranscript(participantId); });

    fixedGroup.selectAll(".icon1, .icon2")
        .style("cursor", "pointer")
        .on("click", function(participantId) { showParticipantTranscript(participantId); });
	
	fixedGroup.raise();
    drawNonVerbalCueLayer(participants);
    console.log("--- drawVisualization2 END ---");
}
