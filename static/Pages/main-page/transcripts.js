import { xObject,themesObject,themeObject,highlight,kObject, selectedParticipantObject, playObject, firstClickObject, transcriptsObject } from "../../chromascribe-main.js";
import { calculateTime } from "../../calculateTime.js";
import { playBar, clearPlaybarAudio, hasAudioSource, setPlaybarAudioSource } from "./audioPlayBar.js";
import { normalizeParticipantCode, findParticipantAudio, buildServeAudioUrl } from "./audioMatching.js?v=20260601b";
import { buildThemeExcerptEntry, colorToRgba, getContrastingTextColor } from "../themePersistence.js?v=20260901b";
import { getSpeechTimelineStartSeconds } from "./timeNormalization.js";

export { normalizeParticipantCode, findParticipantAudio, buildServeAudioUrl } from "./audioMatching.js?v=20260601b";

export function resolveParticipantId(rawParticipant, transcriptMap = null) {
	const transcripts = transcriptMap || {};
	const direct = (rawParticipant || "").toString().trim();
	if (direct && transcripts[direct]) return direct;

	const normalizedTarget = normalizeParticipantCode(rawParticipant);
	if (!normalizedTarget) return direct || "";

	const keys = Object.keys(transcripts);
	for (let i = 0; i < keys.length; i++) {
		if (normalizeParticipantCode(keys[i]) === normalizedTarget) {
			return keys[i];
		}
	}

	return normalizedTarget;
}

function buildSpeechKey(speech) {
	if (!speech) return "";
	return [
		speech.participant || "",
		speech.timestamp || "",
		speech.speaker || "",
		speech.tag || "",
		Number.isInteger(speech._transcriptIndex) ? String(speech._transcriptIndex) : ""
	].join("|");
}

function resolveSpeechEdgeColor(speech) {
	const rawColor = ((speech && speech.color) || "").toString().trim();
	if (!rawColor) return "#BEBEBE";
	const lowered = rawColor.toLowerCase();
	if (
		lowered === "#ffffff" ||
		lowered === "#fff" ||
		lowered === "#eeeeee" ||
		lowered === "#eee" ||
		lowered === "white" ||
		lowered === "transparent" ||
		lowered === "none"
	) {
		return "#BEBEBE";
	}
	return rawColor;
}

function getQuestionAnswerBadgeMeta(speech) {
	const rawTag = String((speech && speech.tag) || "").trim().toUpperCase();
	if (!rawTag || rawTag === "NONE") return null;

	if (/^Q\d+[A-Z]?$/.test(rawTag)) {
		return {
			className: "question",
			label: rawTag,
			title: "Question excerpt"
		};
	}

	if (/^A\d+[A-Z]?$/.test(rawTag)) {
		return {
			className: "answer",
			label: rawTag,
			title: "Answer excerpt"
		};
	}

	return null;
}

function appendQuestionAnswerBadge(container, speech) {
    const badgeMeta = getQuestionAnswerBadgeMeta(speech);
    if (!badgeMeta || !container || typeof container.append !== "function") {
        return;
	}

	container.append("span")
		.attr("class", `speech-qa-badge ${badgeMeta.className}`)
		.attr("title", badgeMeta.title)
		.attr("aria-label", badgeMeta.title)
			.text(badgeMeta.label);
	}

function appendSpeechTimestamp(container, speech) {
	if (!container || typeof container.append !== "function") return;
	if (speech?.startSeconds === null) {
		container.append("span").attr("class", "speech-display-time").text("No timestamp");
		return;
	}
	const rawTimestamp = String((speech && (speech._rawTimestamp || speech.timestamp)) || "").trim();
	if (speech && speech._externalQuote) {
		container.append("span")
			.attr("class", "speech-display-time")
			.text(rawTimestamp || "Selected quote");
		return;
	}

	const displayTimestamp = calculateTime(getSpeechTimelineStartSeconds(speech));

	container.append("span")
		.attr("class", "speech-display-time")
		.text(displayTimestamp);

	if (rawTimestamp) {
		container.append("span")
			.attr("class", "speech-raw-time")
			.text(`(${rawTimestamp})`);
	}
}

function highlightSpeechInVisualization(targetSpeech) {
	if (!targetSpeech) return;
	const targetKey = buildSpeechKey(targetSpeech);
	if (!targetKey) return;
	const speechRects = d3.select("#graph").selectAll("#speech, .speech-rect");
	if (speechRects.empty()) return;

	speechRects.style("stroke", "none");
	speechRects
		.filter(d => buildSpeechKey(d) === targetKey)
		.style("stroke", "black");
}

function scrollTranscriptBlockIntoView(transcriptNode, blockNode, topPadding = 14) {
	if (!transcriptNode || !blockNode) return;
	const containerRect = transcriptNode.getBoundingClientRect();
	const blockRect = blockNode.getBoundingClientRect();
	const nextScrollTop = transcriptNode.scrollTop + (blockRect.top - containerRect.top) - topPadding;
	transcriptNode.scrollTop = Math.max(0, nextScrollTop);
}

// function to add speech segments to Uploaded_files
export function addSpeeches(d, fullInterview){
    var transcript = d3.select("#transcript");
		var themeCount = 0, themeTotal = 0, topOfSpeech = 0, topOfPreviousSpeech = 0, topOfScroll = 10, interview = [];
		interview = Array.isArray(fullInterview) ? fullInterview : [];
		var transcriptHeaderTitle = d3.select("#transcript-header .transcript-header-title");
		transcript.selectAll("*").remove();
		const headerParticipant = resolveParticipantId(
			(d && d.participant) || selectedParticipantObject.selectedParticipant,
			transcriptsObject.transcripts
		) || (d && d.participant) || selectedParticipantObject.selectedParticipant;
		transcriptHeaderTitle.text(`Transcript for ${headerParticipant}`);
		syncHeaderThemeQuoteButton(d, headerParticipant);

    const normalizeText = (value) => (value || "").toString().replace(/\s+/g, " ").trim().toLowerCase();
    const selectedTimestamp = d && d.timestamp ? normalizeText(d.timestamp) : "";
	const selectedScript = d && d.script ? normalizeText(d.script) : "";
	const selectedSpeaker = d && d.speaker ? normalizeText(d.speaker) : "";
    const selectedIndex = Number.isInteger(d && d._transcriptIndex)
        ? d._transcriptIndex
        : (d && d._transcriptIndex !== undefined && d._transcriptIndex !== null
            ? parseInt(d._transcriptIndex, 10)
            : -1);

	let targetIndex = -1;
    if (selectedIndex >= 0 && selectedIndex < interview.length) {
        targetIndex = selectedIndex;
    }
	if (d && Array.isArray(interview)) {
		const directIndex = interview.indexOf(d);
		if (targetIndex === -1 && directIndex !== -1) targetIndex = directIndex;
	}
	if (targetIndex === -1 && (selectedTimestamp || selectedScript)) {
        for (let i = 0; i < interview.length; i++) {
            const cue = interview[i] || {};
            const cueTimestamp = normalizeText(cue.timestamp);
            const cueScript = normalizeText(cue.script);
            const cueSpeaker = normalizeText(cue.speaker);
            if (selectedTimestamp && cueTimestamp === selectedTimestamp) {
                if (!selectedScript || cueScript === selectedScript) {
                    targetIndex = i;
                    break;
                }
            }
            if (targetIndex === -1 && selectedScript && cueScript === selectedScript) {
                targetIndex = i;
            }
            if (targetIndex === -1 && selectedSpeaker && cueSpeaker === selectedSpeaker && selectedTimestamp && cueTimestamp === selectedTimestamp) {
                targetIndex = i;
            }
        }
    }

	for (var i=0; i<interview.length; i++){
        if (!interview[i]) continue;
		if (typeof interview[i].script !== "string" && typeof interview[i].text === "string") {
			interview[i].script = interview[i].text;
		}
        interview[i]._transcriptIndex = i;
		themeCount = 0, themeTotal = 0;
		var speechBlock = transcript.append("div")
			.attr("class", "speech")
			.attr("id", "_"+i)
            .attr("data-index", i)
            .attr("data-timestamp", interview[i].timestamp || "")
            .attr("data-speaker", interview[i].speaker || "")
            .attr("data-script", interview[i].script || "")
			.attr("data-theme", getPrimaryThemeForSpeech(interview[i])?.themeName || "");

		const edgeColor = resolveSpeechEdgeColor(interview[i]);
		speechBlock
			.style("border-left", `6px solid ${edgeColor}`)
			.attr("title", getTranscriptBlockExplanation(interview[i]));

		if (i === targetIndex){
			topOfSpeech = speechBlock.node().offsetTop;
			if (topOfSpeech-topOfPreviousSpeech >= transcript.node().offsetHeight)
				topOfScroll = topOfSpeech - transcript.node().offsetHeight/2 + 100;
			else
				topOfScroll = topOfPreviousSpeech - 10;
			speechBlock.classed("active", true).style("opacity", 1);
		}

		var info = speechBlock.append("div")
			.style("margin-top", "10px")
			.attr("class", "info");

			const timestampRow = info.append("div")
				.attr("class", "speech-meta-row");
			appendSpeechTimestamp(timestampRow, interview[i]);
			appendQuestionAnswerBadge(timestampRow, interview[i]);

		info.append("div")
			.text(getDisplaySpeaker(interview[i]));
		
		var script = speechBlock.append("div")
			.attr("id", "script")
			.style("margin-top", "10px")
			.style("margin-left", "20px")
			.style("width", "280px")
			.style("float", "right")
			.attr("class", "script");
		try {
			tagWords(interview[i], script);
		} catch (error) {
			console.error("Failed to render transcript script highlight:", error);
			script.text((interview[i] && interview[i].script) ? interview[i].script : "(No transcript text)");
		}
		

		var themeBar = speechBlock.append("div")
			.style("display", "flex")
			.style("margin-top", "20px")
			.style("width", "98%")
			.style("margin-right", "20px")
			.style("margin-left", "20px")
			.style("flex-wrap", "no-wrap");

		if (interview[i].color != "#ffffff"){
			themeBar.style("margin-bottom", "20px");
			for (var j=0; j<themesObject.themes.length; j++){
				if (interview[i][themesObject.themes[j].themeName] > 0)
					themeTotal++;
			}
			for (var j=0; j<themesObject.themes.length; j++){
				if (interview[i][themesObject.themes[j].themeName] > 0){
					var smallBar = themeBar.append("div");
					themeCount++;
					addThemeBar(themesObject.themes[j], interview[i][themesObject.themes[j].themeName], smallBar, themeCount, themeTotal)
				}
			}
		}
		
		speechBlock.on("click", function() {
			const id = d3.select(this).node().id.substring(1) * 1;
			const block = interview[id];
			if (!block) return;

			d3.selectAll(".speech").style("opacity", 0.5).classed("active", false);
			d3.select(this).style("opacity", 1).classed("active", true);

			const resolvedParticipant = resolveParticipantId(
				block.participant || d.participant || selectedParticipantObject.selectedParticipant,
				transcriptsObject.transcripts
			);
			if (resolvedParticipant) {
				selectedParticipantObject.selectedParticipant = resolvedParticipant;
				block.participant = resolvedParticipant;
			}
			firstClickObject.firstClick = false;
			firstClickObject.object = buildSpeechKey(block);

			const timeInSeconds = getSpeechTimelineStartSeconds(block);
			d3.select("#full-slider").property("value", timeInSeconds);
			d3.select("#full-current-time").text(calculateTime(timeInSeconds));

			const participantMatch = findParticipantAudio(selectedParticipantObject.selectedParticipant);
			if (participantMatch && participantMatch.audio && participantMatch.audio.relativePath) {
				const audioSrc = buildServeAudioUrl(participantMatch.audio);
				if (setPlaybarAudioSource(audioSrc)) {
					block.audioFileObject = participantMatch.audio;
					playBar(block);
				}
			} else {
				clearPlaybarAudio({
					displaySeconds: timeInSeconds,
					maxDisplaySeconds: timeInSeconds,
					reason: "Audio not provided for this participant."
				});
			}

			const bar = d3.select("#bar");
			if (!bar.empty()) {
				bar
					.attr("x", xObject.x(timeInSeconds))
					.style("opacity", 1)
					.raise();
			}
			highlightSpeechInVisualization(block);
			
			document.body.onkeyup = function(e) {
				const audioNode = d3.select("#full-audiofile").node();
				if (
					selectedParticipantObject.selectedParticipant!="" &&
					hasAudioSource(audioNode) &&
					(e.key == " " || e.code == "Space")
				) {
					if (playObject.play){
						d3.select("#full-audiofile").node().play();
						playObject.play=false;
						d3.select("#full-play-pause-holder")
						.attr("class", "pause");
						d3.select("#full-play-pause")
						.attr("src","../static/images/pause-button.png");
					}
					else {
						d3.select("#full-audiofile").node().pause();
						playObject.play=true;
						d3.select("#full-play-pause-holder")
						.attr("class","play");
						d3.select("#full-play-pause")
						.attr("src","../static/images/play-button.png");
					}
  				}
			}
		});
		topOfPreviousSpeech = speechBlock.node().offsetTop;
		}
		transcript.node().scrollTop = topOfScroll;

	if (targetIndex >= 0) {
		const transcriptNode = transcript.node();
		const selectedNode = d3.select("#_" + targetIndex).node();
		if (transcriptNode && selectedNode) {
			scrollTranscriptBlockIntoView(transcriptNode, selectedNode);
		}
	}
}

function getThemeName(theme) {
	return String((theme && theme.themeName) || "").trim();
}

function getThemeScore(speech, theme) {
	const themeName = getThemeName(theme);
	if (!speech || !themeName) return 0;
	const score = Number(speech[themeName]);
	return Number.isFinite(score) ? score : 0;
}

function colorsMatch(a, b) {
	const normalize = value => String(value || "").trim().toLowerCase();
	return normalize(a) !== "" && normalize(a) === normalize(b);
}

function isSelectedExcerptOnlyMode() {
	return window.VISUALIZATION_SELECTED_EXCERPTS_ONLY === true;
}

function getThemesForSpeech(speech) {
	const themes = Array.isArray(themesObject.themes) ? themesObject.themes : [];
	const assignedThemes = themes.filter(theme => getThemeScore(speech, theme) > 0);
	if (assignedThemes.length > 0) return assignedThemes;
	if (isSelectedExcerptOnlyMode()) return [];

	const speechColor = String((speech && speech.color) || "").trim();
	if (!speechColor || colorsMatch(speechColor, highlight["Neutral"])) return [];
	return themes.filter(theme => colorsMatch(theme && theme.color, speechColor));
}

function normalizeThemeLookupKey(value) {
	return String(value || "")
		.replace(/_/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function formatThemeDisplayName(themeName) {
	const normalized = String(themeName || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
	return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Theme";
}

function findThemeByName(themeNameOrKey) {
	const target = normalizeThemeLookupKey(themeNameOrKey);
	if (!target || !Array.isArray(themesObject.themes)) return null;
	return themesObject.themes.find(theme => normalizeThemeLookupKey(theme && theme.themeName) === target) || null;
}

function getPrimaryThemeForSpeech(speech) {
	const assignedThemes = getThemesForSpeech(speech);
	if (assignedThemes.length === 0) return null;
	return assignedThemes
		.slice()
		.sort((leftTheme, rightTheme) => getThemeScore(speech, rightTheme) - getThemeScore(speech, leftTheme))[0] || null;
}

function getSelectedThemeFromToolbar() {
	const selected = Array.isArray(themeObject.theme)
		? themeObject.theme
		: (themeObject.theme ? [themeObject.theme] : []);
	const selectedThemeKey = selected
		.map(value => String(value || "").trim())
		.find(value => value && value.toLowerCase() !== "neutral");
	return selectedThemeKey ? findThemeByName(selectedThemeKey) : null;
}

function speechMatchesTheme(speech, theme) {
	if (!speech || !theme) return false;
	const score = getThemeScore(speech, theme);
	if (score > 0) return true;
	if (isSelectedExcerptOnlyMode()) return false;
	return colorsMatch(speech.color, theme.color);
}

function normalizeQuoteIdentityText(value) {
	return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeQuoteMatchText(value) {
	return String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function quoteMatchTextTokens(value) {
	return normalizeQuoteMatchText(value)
		.split(/\s+/)
		.filter(token => token.length > 2);
}

function quoteTextsHaveStrongOverlap(selectedText, quoteText) {
	const selectedTokens = [...new Set(quoteMatchTextTokens(selectedText))];
	const quoteTokens = new Set(quoteMatchTextTokens(quoteText));
	if (selectedTokens.length < 4 || quoteTokens.size < 4) return false;
	const overlap = selectedTokens.filter(token => quoteTokens.has(token)).length;
	const selectedCoverage = overlap / selectedTokens.length;
	const quoteCoverage = overlap / quoteTokens.size;
	const shorterCoverage = overlap / Math.min(selectedTokens.length, quoteTokens.size);
	return overlap >= 4 && (
		selectedCoverage >= 0.5 ||
		quoteCoverage >= 0.75 ||
		shorterCoverage >= 0.55
	);
}

function quoteTextMatchesSelectedText(selectedText, quoteText, hasContext = false) {
	if (!selectedText || !quoteText) return false;
	if (quoteText === selectedText || quoteText.includes(selectedText) || selectedText.includes(quoteText)) {
		return true;
	}
	return hasContext && quoteTextsHaveStrongOverlap(selectedText, quoteText);
}

function normalizeQuoteQaTag(value) {
	const text = String(value || "").trim();
	if (!text) return "";
	const match = text.match(/\b([QA])\s*0*(\d+)([a-z]?)\b/i);
	if (!match) return "";
	return `${match[1].toUpperCase()}${parseInt(match[2], 10)}${(match[3] || "").toLowerCase()}`;
}

function getQuoteQaTagBase(value) {
	const tag = normalizeQuoteQaTag(value);
	const match = tag.match(/^([QA]\d+)/i);
	return match ? match[1].toUpperCase() : "";
}

function quoteQaTagsCompatible(leftTag, rightTag) {
	const left = normalizeQuoteQaTag(leftTag);
	const right = normalizeQuoteQaTag(rightTag);
	if (!left || !right) return false;
	if (left === right) return true;
	const leftBase = getQuoteQaTagBase(left);
	const rightBase = getQuoteQaTagBase(right);
	return Boolean(leftBase && rightBase && leftBase === rightBase);
}

function getQuoteQaTags(speech) {
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
		.map(normalizeQuoteQaTag)
		.filter(tag => {
			if (!tag || seen.has(tag)) return false;
			seen.add(tag);
			return true;
		});
}

function normalizeQuoteTimestamp(value) {
	return String(value || "")
		.replace(/\s+/g, "")
		.trim();
}

function buildQuoteIdentity(speech) {
	return [
		normalizeQuoteIdentityText(speech && speech.participant),
		normalizeQuoteIdentityText(speech && speech.timestamp),
		normalizeQuoteIdentityText(speech && speech.tag),
		normalizeQuoteIdentityText((speech && (speech.script || speech.text || speech.word)) || "")
	].join("||");
}

function getQuoteParticipantLabel(rawParticipant) {
	const rawLabel = String(rawParticipant || "").trim();
	const normalizedLabel = normalizeParticipantCode(rawLabel);
	if (/^P\d+$/i.test(normalizedLabel)) {
		return normalizedLabel.toUpperCase();
	}
	return rawLabel || "Selected quotes";
}

function compareParticipantLabels(leftLabel, rightLabel) {
	const left = getQuoteParticipantLabel(leftLabel);
	const right = getQuoteParticipantLabel(rightLabel);
	const leftMatch = left.match(/^P(\d+)$/i);
	const rightMatch = right.match(/^P(\d+)$/i);
	if (leftMatch && rightMatch) {
		return parseInt(leftMatch[1], 10) - parseInt(rightMatch[1], 10);
	}
	if (leftMatch) return -1;
	if (rightMatch) return 1;
	return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function compareThemeQuotes(leftQuote, rightQuote) {
	const participantDiff = compareParticipantLabels(leftQuote && leftQuote.participant, rightQuote && rightQuote.participant);
	if (participantDiff !== 0) return participantDiff;

	const leftIndex = Number.isInteger(leftQuote && leftQuote._transcriptIndex) ? leftQuote._transcriptIndex : Number.MAX_SAFE_INTEGER;
	const rightIndex = Number.isInteger(rightQuote && rightQuote._transcriptIndex) ? rightQuote._transcriptIndex : Number.MAX_SAFE_INTEGER;
	if (leftIndex !== rightIndex) return leftIndex - rightIndex;

	const leftWordIndex = Number.isInteger(leftQuote && leftQuote._themeWordIndex) ? leftQuote._themeWordIndex : Number.MAX_SAFE_INTEGER;
	const rightWordIndex = Number.isInteger(rightQuote && rightQuote._themeWordIndex) ? rightQuote._themeWordIndex : Number.MAX_SAFE_INTEGER;
	if (leftWordIndex !== rightWordIndex) return leftWordIndex - rightWordIndex;

	const leftTime = getSpeechTimelineStartSeconds(leftQuote);
	const rightTime = getSpeechTimelineStartSeconds(rightQuote);
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
		return leftTime - rightTime;
	}

	return normalizeQuoteIdentityText(leftQuote && (leftQuote.script || leftQuote.text || leftQuote.word))
		.localeCompare(normalizeQuoteIdentityText(rightQuote && (rightQuote.script || rightQuote.text || rightQuote.word)));
}

function quoteMatchesThemeWord(quote, rawWordEntry) {
	const entry = buildThemeExcerptEntry(rawWordEntry);
	if (!quote || !entry) return false;

	const quoteText = normalizeQuoteMatchText(quote.script || quote.text || quote.word);
	const wordText = normalizeQuoteMatchText(entry.word);
	const cueText = normalizeQuoteMatchText(entry.cueText);
	if (!quoteText || (!wordText && !cueText)) return false;

	const quoteParticipant = normalizeParticipantCode(quote.participant || quote.speaker);
	if (entry.participant && (!quoteParticipant || entry.participant !== quoteParticipant)) {
		return false;
	}

	const quoteTags = getQuoteQaTags(quote);
	if (entry.tag && quoteTags.length > 0 && !quoteTags.some(tag => quoteQaTagsCompatible(entry.tag, tag))) {
		return false;
	}

	const quoteTimestamp = normalizeQuoteTimestamp(quote.timestamp || quote._rawTimestamp);
	if (entry.timestamp && quoteTimestamp && entry.timestamp !== quoteTimestamp) {
		return false;
	}

	const hasContext = Boolean(entry.participant || entry.tag || entry.timestamp || cueText);
	return quoteTextMatchesSelectedText(wordText, quoteText, hasContext)
		|| quoteTextMatchesSelectedText(cueText, quoteText, hasContext);
}

function buildQuoteFromThemeWord(rawWordEntry, theme, wordIndex) {
	const entry = buildThemeExcerptEntry(rawWordEntry);
	if (!entry) return null;
	const themeName = getThemeName(theme);
	const script = String(entry.cueText || entry.word || "").trim();
	if (!script) return null;
	const participant = entry.participant || normalizeParticipantCode(entry.speaker) || "Selected quotes";
	const quote = Object.assign({}, entry, {
		participant,
		speaker: entry.speaker || getQuoteParticipantLabel(participant),
		script,
		text: script,
		color: (theme && theme.color) || highlight["Neutral"],
		_externalQuote: true,
		_themeWordIndex: wordIndex,
		_themeColors: theme && theme.color ? [theme.color] : []
	});
	if (themeName) quote[themeName] = 1;
	return quote;
}

function collectThemeQuotes(theme) {
	const quotes = [];
	const matchedTranscriptQuotes = [];
	Object.entries(transcriptsObject.transcripts || {}).forEach(([participantId, interview]) => {
		if (!Array.isArray(interview)) return;
		interview.forEach((speech, speechIndex) => {
			if (!speechMatchesTheme(speech, theme)) return;
			const quote = Object.assign({}, speech, {
				participant: participantId,
				_transcriptIndex: speechIndex
			});
			matchedTranscriptQuotes.push(quote);
		});
	});

	const selectedWords = Array.isArray(theme && theme.words) ? theme.words : [];
	if (selectedWords.length > 0) {
		selectedWords.forEach((wordEntry, wordIndex) => {
			const selectedQuote = buildQuoteFromThemeWord(wordEntry, theme, wordIndex);
			if (!selectedQuote) return;
			const linkedQuote = matchedTranscriptQuotes.find(quote => quoteMatchesThemeWord(quote, wordEntry));
			if (linkedQuote) {
				selectedQuote._externalQuote = false;
				selectedQuote._linkedQuote = linkedQuote;
				selectedQuote._transcriptIndex = linkedQuote._transcriptIndex;
				if (!selectedQuote.timestamp && linkedQuote.timestamp) selectedQuote.timestamp = linkedQuote.timestamp;
				if (!selectedQuote._rawTimestamp && linkedQuote._rawTimestamp) selectedQuote._rawTimestamp = linkedQuote._rawTimestamp;
			}
			quotes.push(selectedQuote);
		});
		return quotes.sort(compareThemeQuotes);
	}

	const seen = new Set();
	matchedTranscriptQuotes.forEach((quote) => {
		const key = buildQuoteIdentity(quote);
		if (seen.has(key)) return;
		seen.add(key);
		quotes.push(quote);
	});

	return quotes.sort(compareThemeQuotes);
}

function getThemeQuoteParticipantOptions(quotes) {
	const seen = new Set();
	return quotes.reduce((options, quote) => {
		const label = getQuoteParticipantLabel(quote && quote.participant);
		if (!label || seen.has(label)) return options;
		seen.add(label);
		options.push(label);
		return options;
	}, []);
}

function getDisplaySpeaker(speech) {
	const rawSpeaker = String((speech && speech.speaker) || "").trim();
	if (/^interviewer/i.test(rawSpeaker) || /^s1$/i.test(rawSpeaker)) {
		return "Interviewer";
	}
	if (/^s2$/i.test(rawSpeaker)) {
		return "Participant";
	}
	if (/^p\d+/i.test(rawSpeaker)) {
		return `Participant ${rawSpeaker.slice(1)}`;
	}
	return rawSpeaker || "Participant";
}

function getThemeQuoteButton() {
	const button = d3.select("#theme-quotes-btn");
	return button.empty() ? null : button;
}

function renderThemeButtonContent(button, theme, labelText) {
	button.html("");
	button.append("span")
		.attr("class", "theme-quotes-swatch")
		.style("background-color", theme && theme.color ? theme.color : "#CBD5E1");
	button.append("span").text(labelText);
}

function setThemeQuoteButton(theme, returnParticipant = "") {
	const button = getThemeQuoteButton();
	if (!button || !theme) {
		hideThemeQuoteButton();
		return;
	}
	const label = formatThemeDisplayName(theme.themeName);
	button
		.property("hidden", false)
		.classed("active", false)
		.attr("data-theme", theme.themeName || "")
		.attr("title", `Show all quotes for ${label}`)
		.style("border-color", theme.color || "#cfd7ea")
		.on("click", function() {
			showThemeQuotes(theme.themeName, { returnParticipant });
		});
	renderThemeButtonContent(button, theme, "Go to Quotations");
}

function setThemeQuoteBackButton(theme, returnParticipant = "") {
	const button = getThemeQuoteButton();
	if (!button || !theme || !returnParticipant) {
		hideThemeQuoteButton();
		return;
	}
	button
		.property("hidden", false)
		.classed("active", true)
		.attr("data-theme", theme.themeName || "")
		.attr("title", `Back to transcript for ${returnParticipant}`)
		.style("border-color", theme.color || "#cfd7ea")
		.on("click", function() {
			const transcript = transcriptsObject.transcripts[returnParticipant];
			if (!Array.isArray(transcript) || transcript.length === 0) {
				hideThemeQuoteButton();
				return;
			}
			addSpeeches({ participant: returnParticipant }, transcript);
		});
	renderThemeButtonContent(button, theme, "Back");
}

export function hideThemeQuoteButton() {
	const button = getThemeQuoteButton();
	if (!button) return;
	button
		.property("hidden", true)
		.classed("active", false)
		.attr("data-theme", null)
		.attr("title", "")
		.style("border-color", null)
		.on("click", null)
		.html("Go to Quotations");
}

function syncHeaderThemeQuoteButton(sourceSpeech, fallbackParticipant = "") {
	const theme = getPrimaryThemeForSpeech(sourceSpeech) || getSelectedThemeFromToolbar();
	if (!theme) {
		hideThemeQuoteButton();
		return;
	}
	setThemeQuoteButton(theme, fallbackParticipant);
}

function escapeRegExp(value) {
	return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCodeVariant(value) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'“”]+|["'“”]+$/g, "")
		.trim();
}

function isBoundaryCharacter(value) {
	return /^[A-Za-z0-9_]$/.test(value);
}

function buildCodeVariantRegex(variant) {
	const normalized = normalizeCodeVariant(variant);
	if (!normalized) return null;

	const parts = normalized.split(/\s+/).map(escapeRegExp);
	let pattern = parts.join("\\s+");
	const isPhraseSelection = /\s/.test(normalized);
	if (!isPhraseSelection && isBoundaryCharacter(normalized[0])) {
		pattern = `\\b${pattern}`;
	}
	if (!isPhraseSelection && isBoundaryCharacter(normalized[normalized.length - 1])) {
		pattern = `${pattern}\\b`;
	}
	return new RegExp(pattern, "gi");
}

function getWordVariants(wordDef) {
	const baseWord = typeof wordDef === "string"
		? wordDef
		: String((wordDef && wordDef.word) || "");
	const stemmedWords = Array.isArray(wordDef && wordDef.stemmedWords)
		? wordDef.stemmedWords
		: [];

	const seen = new Set();
	return [baseWord, ...stemmedWords]
		.map(normalizeCodeVariant)
		.filter(Boolean)
		.filter(variant => {
			const key = variant.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

function getExcerptSourceKey(entry) {
	return String((entry && (entry.codeSource || entry.source || entry.tagSource)) || "").trim().toLowerCase();
}

function sourceLooksHuman(source) {
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

function isUserSelectedOrMatchedExcerpt(wordDef, theme) {
	if (!wordDef || typeof wordDef !== "object") {
		return sourceLooksHuman(getExcerptSourceKey(theme));
	}

	const source = getExcerptSourceKey(wordDef);
	const selectionSource = String(wordDef.selectionSource || wordDef.selection_source || "").trim().toLowerCase();
	return (
		wordDef.selectedByUser === true ||
		wordDef.userSelected === true ||
		wordDef.matchedByUser === true ||
		wordDef.humanTagged === true ||
		wordDef.human_tagged === true ||
		wordDef.ai_generated === false ||
		sourceLooksHuman(source) ||
		sourceLooksUserSelected(source) ||
		sourceLooksUserSelected(selectionSource)
	);
}

function collectCodeHighlightRanges(rawText, speech) {
	const ranges = [];
	if (!rawText) return ranges;

	getThemesForSpeech(speech).forEach(theme => {
		const themeName = getThemeName(theme);
		const themeScore = getThemeScore(speech, theme);
		const themeColor = colorToRgba((theme && theme.color) || highlight["Neutral"], 0.35);

		((theme && theme.words) || []).filter(wordDef =>
			isUserSelectedOrMatchedExcerpt(wordDef, theme)
		).forEach(wordDef => {
			getWordVariants(wordDef).forEach(variant => {
				const regex = buildCodeVariantRegex(variant);
				if (!regex) return;

				let match = regex.exec(rawText);
				while (match) {
					if (match[0]) {
						ranges.push({
							start: match.index,
							end: match.index + match[0].length,
							color: themeColor,
							themeName,
							score: themeScore
						});
					}
					if (regex.lastIndex === match.index) regex.lastIndex++;
					match = regex.exec(rawText);
				}
			});
		});
	});

	return ranges;
}

function selectNonOverlappingRanges(ranges) {
	return ranges
		.filter(range => Number.isInteger(range.start) && Number.isInteger(range.end) && range.end > range.start)
		.sort((a, b) => {
			if (a.start !== b.start) return a.start - b.start;
			const lengthDiff = (b.end - b.start) - (a.end - a.start);
			if (lengthDiff !== 0) return lengthDiff;
			return (b.score || 0) - (a.score || 0);
		})
		.reduce((selected, range) => {
			const previous = selected[selected.length - 1];
			if (previous && range.start < previous.end) return selected;
			selected.push(range);
			return selected;
		}, []);
}

function renderCodeHighlightedText(rawText, speech, container) {
	container.html("");
	const ranges = selectNonOverlappingRanges(collectCodeHighlightRanges(rawText, speech));
	if (ranges.length === 0) {
		container.text(rawText);
		return;
	}

	let cursor = 0;
	ranges.forEach(range => {
		if (range.start > cursor) {
			container.append("span").text(rawText.slice(cursor, range.start));
		}

		const highlightedText = rawText.slice(range.start, range.end);
		const codeSpan = container.append("span")
			.attr("class", "code-highlight")
			.attr("data-theme", range.themeName || "")
			.attr("title", `${range.themeName || "Theme"}: highlighted text was selected, matched, or manually coded by a user.`)
			.style("background-color", range.color)
			.style("border-radius", "5px");
		codeSpan.append("strong").text(highlightedText);
		cursor = range.end;
	});

	if (cursor < rawText.length) {
		container.append("span").text(rawText.slice(cursor));
	}
}

function getTranscriptBlockExplanation(speech) {
	if (speech && speech._externalQuote) {
		return "Selected Code Manager quotation. It is not linked to a visible transcript row in this view.";
	}
	const rawText = (typeof speech?.script === "string")
		? speech.script
		: (typeof speech?.text === "string" ? speech.text : "");
	const hasHighlights = selectNonOverlappingRanges(collectCodeHighlightRanges(rawText, speech)).length > 0;
	const hasThemeBlock = getThemesForSpeech(speech).length > 0;

	if (hasHighlights) {
		return "Highlighted words or sentences are excerpts a user selected, matched, or manually coded.";
	}
	if (hasThemeBlock) {
		return "Plain black text in a color-coded block is an AI-generated theme suggestion that has not been manually verified yet.";
	}
	return "Transcript text without a color-coded block is not currently tagged with a selected theme.";
}

function focusThemeQuoteSpeech(speech, blockNode) {
	if (!speech) return;
	d3.selectAll(".theme-quote-block").classed("active", false);
	if (blockNode) d3.select(blockNode).classed("active", true);
	const focusSpeech = speech._linkedQuote || speech;
	if (speech._externalQuote && !speech._linkedQuote) return;

	const participantId = resolveParticipantId(focusSpeech.participant, transcriptsObject.transcripts);
	const selectedSpeech = Object.assign({}, focusSpeech, { participant: participantId || focusSpeech.participant });
	selectedParticipantObject.selectedParticipant = selectedSpeech.participant || "";
	firstClickObject.firstClick = false;
	firstClickObject.object = buildSpeechKey(selectedSpeech);

	const timeInSeconds = getSpeechTimelineStartSeconds(selectedSpeech);
	d3.select("#full-slider").property("value", timeInSeconds);
	d3.select("#full-current-time").text(calculateTime(timeInSeconds));

	const participantMatch = findParticipantAudio(selectedSpeech.participant);
	if (participantMatch && participantMatch.audio && participantMatch.audio.relativePath) {
		const audioSrc = buildServeAudioUrl(participantMatch.audio);
		if (setPlaybarAudioSource(audioSrc)) {
			selectedSpeech.audioFileObject = participantMatch.audio;
			playBar(selectedSpeech);
		}
	} else {
		clearPlaybarAudio({
			displaySeconds: timeInSeconds,
			maxDisplaySeconds: timeInSeconds,
			reason: "Audio not provided for this participant."
		});
	}

	const bar = d3.select("#bar");
	if (!bar.empty()) {
		bar
			.attr("x", xObject.x(timeInSeconds))
			.style("opacity", 1)
			.raise();
	}
	highlightSpeechInVisualization(selectedSpeech);
}

function appendThemeQuoteBlock(container, speech, theme) {
	const isExternalQuote = Boolean(speech && speech._externalQuote && !speech._linkedQuote);
	const speechBlock = container.append("div")
		.attr("class", "speech theme-quote-block")
		.attr("data-theme", (theme && theme.themeName) || "")
		.classed("external", isExternalQuote)
		.attr("title", getTranscriptBlockExplanation(speech))
		.style("opacity", 1)
		.style("border-left", `6px solid ${theme.color || resolveSpeechEdgeColor(speech)}`)
		.on("click", function() {
			focusThemeQuoteSpeech(speech, this);
		});

	const info = speechBlock.append("div")
		.style("margin-top", "10px")
		.attr("class", "info");
	const timestampRow = info.append("div").attr("class", "speech-meta-row");
	appendSpeechTimestamp(timestampRow, speech);
	appendQuestionAnswerBadge(timestampRow, speech);
	info.append("div").text(getDisplaySpeaker(speech));

	const rawText = (typeof speech.script === "string")
		? speech.script
		: (typeof speech.text === "string" ? speech.text : "");
	const script = speechBlock.append("div")
		.attr("id", "script")
		.style("margin-top", "10px")
		.style("margin-left", "20px")
		.style("width", "280px")
		.style("float", "right")
		.attr("class", "script");
	renderCodeHighlightedText(rawText || "(No transcript text)", speech, script);
}

function renderThemeQuoteGroups(container, quotes, theme) {
	container.selectAll("*").remove();
	if (quotes.length === 0) {
		container.append("div")
			.attr("class", "theme-quotes-summary")
			.text("No matching quotes found for this participant.");
		return;
	}

	let currentParticipant = "";
	quotes.forEach(quote => {
		const participantLabel = getQuoteParticipantLabel(quote && quote.participant);
			if (participantLabel !== currentParticipant) {
				currentParticipant = participantLabel;
				const hasTranscriptBackedQuote = quotes.some(candidate => (
					getQuoteParticipantLabel(candidate && candidate.participant) === currentParticipant
					&& !(candidate && candidate._externalQuote && !candidate._linkedQuote)
				));
				container.append("div")
					.attr("class", "theme-quote-participant")
					.text(`${hasTranscriptBackedQuote ? "Transcript for" : "Selected quotes for"} ${currentParticipant}`);
			}
		appendThemeQuoteBlock(container, quote, theme);
	});
}

export function showThemeQuotes(themeNameOrKey, options = {}) {
	const theme = findThemeByName(themeNameOrKey);
	if (!theme) return;

	const transcript = d3.select("#transcript");
	const transcriptHeaderTitle = d3.select("#transcript-header .transcript-header-title");
	if (transcript.empty() || transcriptHeaderTitle.empty()) return;

	const returnParticipant = String(options.returnParticipant || selectedParticipantObject.selectedParticipant || "").trim();
	const themeLabel = formatThemeDisplayName(theme.themeName);
	const quotes = collectThemeQuotes(theme);
	const participantOptions = getThemeQuoteParticipantOptions(quotes);
	transcript.selectAll("*").remove();
	d3.select("#clear-search-btn").remove();
	transcriptHeaderTitle.text(`Quotes for ${themeLabel}`);
	setThemeQuoteBackButton(theme, returnParticipant);

	const summary = transcript.append("div")
		.attr("class", "theme-quotes-summary")
		.text(`${quotes.length} quote${quotes.length === 1 ? "" : "s"} tagged with ${themeLabel}`);

	if (quotes.length === 0) {
		transcript.append("div")
			.attr("class", "theme-quotes-summary")
			.text("No matching quotes found for this theme.");
		return;
	}

	const controls = transcript.append("div")
		.attr("class", "theme-quotes-controls");
	controls.append("label")
		.attr("for", "theme-quotes-participant-select")
		.text("Participant");
	const participantSelect = controls.append("select")
		.attr("id", "theme-quotes-participant-select")
		.attr("class", "theme-quotes-participant-select")
		.attr("aria-label", "Filter quotes by participant");
	participantSelect.append("option")
		.attr("value", "__all__")
		.text("All participants");
	participantOptions.forEach(participantLabel => {
		participantSelect.append("option")
			.attr("value", participantLabel)
			.text(participantLabel);
	});

	const quoteList = transcript.append("div")
		.attr("class", "theme-quotes-list");

	function renderSelectedParticipantQuotes() {
		const selectedParticipant = String(participantSelect.property("value") || "__all__");
		const visibleQuotes = selectedParticipant === "__all__"
			? quotes
			: quotes.filter(quote => getQuoteParticipantLabel(quote && quote.participant) === selectedParticipant);
		const summaryPrefix = selectedParticipant === "__all__"
			? `${quotes.length} quote${quotes.length === 1 ? "" : "s"} tagged with ${themeLabel}, grouped by participant`
			: `${visibleQuotes.length} of ${quotes.length} quote${quotes.length === 1 ? "" : "s"} tagged with ${themeLabel} for ${selectedParticipant}`;
		summary.text(summaryPrefix);
		renderThemeQuoteGroups(quoteList, visibleQuotes, theme);
	}

	participantSelect.on("change", function() {
		renderSelectedParticipantQuotes();
		const transcriptNode = transcript.node();
		if (transcriptNode) transcriptNode.scrollTop = 0;
	});
	renderSelectedParticipantQuotes();
}

if (typeof window !== "undefined") {
	window.ChromaTranscriptViews = Object.assign({}, window.ChromaTranscriptViews || {}, {
		showThemeQuotes,
		hideThemeQuoteButton
	});
}

// function to color tagged words in the transcript
function tagWords(d, tempTooltip){
	const rawText = (d && typeof d.script === "string")
		? d.script
		: ((d && typeof d.text === "string") ? d.text : "");
	if (!rawText) {
		tempTooltip.text("(No transcript text)");
		return;
	}
	if (d && d.color === "#eee") {
		tempTooltip.text(rawText);
		return;
	}

	renderCodeHighlightedText(rawText, d, tempTooltip);
}

// function to add a theme to sentiment bar
function addThemeBar(theme, themeValue, themeBar, count, total){
	if (count===1)
		themeBar.style("border-radius", "5px 0 0 5px")
	if (count===total)
		themeBar.style("border-radius", "0 5px 5px 0")
	if (total===1)
		themeBar.style("border-radius", "5px")
	const themeLabel = formatThemeDisplayName(theme && theme.themeName);
	themeBar
	.attr("class", "theme-color-segment")
	.attr("data-theme", (theme && theme.themeName) || "")
	.attr("title", `Show all quotes for ${themeLabel}`)
	.on("click", function() {
		if (d3.event) d3.event.stopPropagation();
		showThemeQuotes(theme.themeName, { returnParticipant: selectedParticipantObject.selectedParticipant });
	})
	.style("background", theme.color)
	.style("width", (themeValue*100).toString()+"%")
	.append("div")
	.style("margin-left", "5px")
	.style("margin-top", "3px")
	.style("color", getContrastingTextColor(theme.color))
	.text((themeValue*100).toFixed(0).toString()+"%");
}


export function addQuestionSpeeches(d, answerGroups, options = {}){
    
    var transcript = d3.select("#transcript");
    transcript.selectAll("*").remove();
    var transcriptHeaderTitle = d3.select("#transcript-header .transcript-header-title");
    var themeCount = 0, themeTotal = 0, topOfSpeech = 0, topOfPreviousSpeech = 0, topOfScroll = 10, interview = [];
   
    // Create a container for the tabs
    var tabContainer = transcript.append("div")
    .attr("class", "tabContainer");

    console.log("In addQuestionSpeeches function",d.participant)
    const clickedQuestionTag = d.tag; // This is the 'Q' tag, e.g., "Q2"
    const correspondingAnswerTag = 'A' + d.tag.substring(1); // Derive the 'A' tag, e.g., "A2"
    
    const themeName = options.themeName || null;
    const themeLabel = themeName
        ? themeName.substring(0,1).toUpperCase() + themeName.substring(1).replaceAll("_", " ")
        : null;

    transcriptHeaderTitle.text(themeLabel ? `Question View for ${d.tag} — Theme: ${themeLabel}` : `Question View for ${d.tag}`);
	if (themeName) {
		const questionTheme = findThemeByName(themeName);
		if (questionTheme) {
			setThemeQuoteButton(questionTheme, d && d.participant ? d.participant : "");
		}
	} else {
		syncHeaderThemeQuoteButton(d, d && d.participant ? d.participant : "");
	}

	var scrollToElement = null; // To track the element to scroll to
			
    let hasAnyQuotes = false;
	for(var pId in answerGroups){
			// And we look for the corresponding ANSWER tag.
		if(answerGroups[pId] && answerGroups[pId][correspondingAnswerTag]){
            // --- The rest of your function is now CORRECT ---
			const speechesForThisAnswer = answerGroups[pId][correspondingAnswerTag];
            const filteredSpeeches = themeName
                ? speechesForThisAnswer.filter(s => {
                    const score = s && typeof s[themeName] === "number" ? s[themeName] : 0;
                    return isSelectedExcerptOnlyMode() ? score > 0 : score >= 0.2;
                })
                : speechesForThisAnswer;

            if (filteredSpeeches.length === 0) {
                continue;
            }
            hasAnyQuotes = true;

            // Create a single speech block container
            var participantTab = tabContainer.append("div")
            .attr("class", "participantTab")
            .style("border", "1px solid #ccc")
            .style("margin", "5px 0")
            .style("border-radius", "5px")
            .style("cursor", "pointer")
            .style("margin", "10px")
            .style("padding", "10px")
            .text(`Participant ${pId} `)
            .on("click", function () {
                var isVisible = d3.select(this.nextSibling).style("display") === "block";
                d3.selectAll(".speechBlockContainer").style("display", "none"); // Collapse others
                d3.select(this.nextSibling).style("display", isVisible ? "none" : "block"); // Toggle current
                d3.selectAll(".speechBlockContainer").style("background-color","#ffffff");
                d3.select(this).style("background-color",isVisible ? "#ffffff":"#e0e0e0");
            });
            
            // Append a span element for the dropdown icon
            participantTab.append("span")
            .attr("class", "dropdownIcon")
            .style("font-family", "Arial, sans-serif") // Use a suitable font for the icon
            .style("font-size", "12px")
            .style("pointer-events", "none") // Ensure the icon doesn't interfere with click
            .style("padding-left","270px")
            .html("&#9660;");

            // Create a container for speech blocks, initially hidden
            var speechBlockContainer = tabContainer.append("div")
            .attr("class", "speechBlockContainer")
            .style("display", "none")  // Initially collapsed
            .style("margin", "10px");

            if (pId === d.participant) {
                speechBlockContainer.style("display", "block");
                participantTab.style("background-color", "#e0e0e0");
                scrollToElement = participantTab.node(); // Track the element to scroll to
            }

			 filteredSpeeches.forEach(speechData => {
                var speechBlock = speechBlockContainer.append("div")
                    .attr("class", "speechBlock")
					.attr("data-theme", getPrimaryThemeForSpeech(speechData)?.themeName || "")
                    .style("padding", "10px").style("margin-bottom","5px")
                    .style("border", "1px solid #eee").style("border-radius", "10px")
                    .style("border-left", `6px solid ${resolveSpeechEdgeColor(speechData)}`)
                    .style("background-color", "#fff").style("box-shadow", "0 2px 4px rgba(0,0,0,0.05)");

                var speechSection = speechBlock.append("div")
                    .attr("class", "speechSection")
                    .style("padding", "5px");

                var infoContainer = speechSection.append("div").style("display", "flex");
                var info = infoContainer.append("div").style("width", "120px");
                
	                const timestampRow = info.append("div")
	                    .attr("class", "speech-meta-row");
	                appendSpeechTimestamp(timestampRow, speechData);
	                appendQuestionAnswerBadge(timestampRow, speechData);
                const speaker = (speechData.speaker === "S1" || speechData.speaker === "Interviewer") ? "Interviewer" : `Participant ${pId.slice(1)}`;
                info.append("div").style("font-weight", "bold").text(speaker);

                var script = infoContainer.append("div").style("flex", "1");
                tagWords2(speechData, script);

                var themeBar = speechSection.append("div")
                    .style("display", "flex").style("margin-top", "10px");

                if (speechData.color !== "#ffffff") {
                    let themeCount = 0, themeTotal = 0;
                    themesObject.themes.forEach(theme => { if (speechData[theme.themeName] > 0) themeTotal++; });
                    themesObject.themes.forEach(theme => {
                        if (speechData[theme.themeName] > 0) {
                            let smallBar = themeBar.append("div");
                            themeCount++;
                            addThemeBar2(theme, speechData[theme.themeName], smallBar, themeCount, themeTotal);
                        }
                    });
                }
                
                // --- THIS IS THE CORRECTED CLICK HANDLER ---
                speechSection.on("click", function() {
                    d3.selectAll(".speechSection").style("opacity", 0.7);
                    d3.select(this).style("opacity", 1);
                    
                    // The 'speechData' from the outer scope is the correct data object.
                    // We don't need to loop or find 'block' again.
                    const block = speechData; 

                    const timeInSeconds = getSpeechTimelineStartSeconds(block);
                    selectedParticipantObject.selectedParticipant = pId;
                    d3.select("#full-slider").property("value", timeInSeconds);
                    d3.select("#full-current-time").text(calculateTime(timeInSeconds));
                    const participantMatch = findParticipantAudio(pId);
                    if (participantMatch && participantMatch.audio && participantMatch.audio.relativePath) {
                        const audioSrc = buildServeAudioUrl(participantMatch.audio);
                        if (setPlaybarAudioSource(audioSrc)) {
                            playBar({ ...block, participant: pId });
                        }
                    } else {
                        clearPlaybarAudio({
                            displaySeconds: timeInSeconds,
                            maxDisplaySeconds: timeInSeconds,
                            reason: "Audio not provided for this participant."
                        });
                    }
                    
                    // Note: The red playhead '#bar' does not exist in Question View,
                    // so we don't try to move it.
                });
                // --- END OF FIX ---
            });
        }
    }
    
	if (scrollToElement) {
		var transcriptNode = transcript.node();
		scrollTranscriptBlockIntoView(transcriptNode, scrollToElement);
	}
    if (!hasAnyQuotes) {
        transcript.append("div")
            .style("text-align", "center")
            .style("margin-top", "30%")
            .style("color", "#666")
            .text(themeLabel ? `No quotes found for theme "${themeLabel}".` : "No quotes found for this question.");
    }
}


// function to color tagged words in the transcript
// function tagWords2(d, tempTooltip){
// 	var text=d.script;
// 	var tagWords = [];
// 	if (d.color==="#eee")
// 		tempTooltip.html(d.script);
// 	else {
// 		for (var i=0; i<d.script.length; i++){
// 			for (var j=0; j<themesObject.themes.length; j++){
// 				for (var k=0; k<themesObject.themes[j].words.length; k++){
// 					// go through stemmed words
// 					var stemmedFound = false;
// 					for (var l=0; l<themesObject.themes[j].words[k].stemmedWords.length; l++){
// 						if (d.script.substring(i,i+themesObject.themes[j].words[k].stemmedWords[l].length).toLowerCase()===themesObject.themes[j].words[k].stemmedWords[l].toLowerCase()){
// 							tagWords.push({
// 								word: d.script.substring(i,i+themesObject.themes[j].words[k].stemmedWords[l].length),
// 								highlight: highlight[themesObject.themes[j].color.toUpperCase()]
// 							});
// 							stemmedFound = true;
// 						}
// 					}
// 					if (!stemmedFound && (d.script.substring(i,i+themesObject.themes[j].words[k].word.length).toLowerCase()===themesObject.themes[j].words[k].word.toLowerCase())){
// 						tagWords.push({
// 							word: d.script.substring(i,i+themesObject.themes[j].words[k].word.length),
// 							highlight: highlight[themesObject.themes[j].color.toUpperCase()]
// 						})
// 					}
// 				}
// 			}
// 		}
// 		for (var i=0; i<tagWords.length; i++)
// 			text = text.replaceAll(tagWords[i].word, "<span style='background-color: "+tagWords[i].highlight+"; border-radius: 5px;'><strong>"+tagWords[i].word+"</strong></span>");
// 		tempTooltip.html(text);
// 	}
// }

function tagWords2(d, tempTooltip){
    let text = (d && typeof d.script === "string")
        ? d.script
        : ((d && typeof d.text === "string") ? d.text : "");
    if (!text) {
        tempTooltip.text("(No transcript text)");
        return;
    }
    if (d.color === "#eee") {
        tempTooltip.text(text);
        return;
    }

    renderCodeHighlightedText(text, d, tempTooltip);
}


// function to add a theme to sentiment bar
function addThemeBar2(theme, themeValue, themeBar, count, total){
	if (count===1)
		themeBar.style("border-radius", "5px 0 0 5px")
	if (count===total)
		themeBar.style("border-radius", "0 5px 5px 0")
	if (total===1)
		themeBar.style("border-radius", "5px")
	themeBar
	.attr("class", "theme-color-segment")
	.attr("data-theme", (theme && theme.themeName) || "")
	.style("background", theme.color)
	.style("width", (themeValue*100).toString()+"%")
	.append("div")
	.style("margin-left", "5px")
	.style("margin-top", "3px")
	.style("color", getContrastingTextColor(theme.color))
	.text((themeValue*100).toFixed(0).toString()+"%");
	
}
