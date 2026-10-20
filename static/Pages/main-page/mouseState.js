import { selectedParticipantObject, firstClickObject, yObject, xObject, barYValueObject,
    transcriptsObject, currentDisplayObject, playObject, FileMap, themesObject, themeObject } from "../../chromascribe-main.js";
import { barObject } from "./dragRedPlayBar.js";
import { addQuestionSpeeches, addSpeeches, resolveParticipantId, findParticipantAudio, buildServeAudioUrl } from "./transcripts.js?v=20260901b";

import { playBar, clearPlaybarAudio, setPlaybarAudioSource } from "./audioPlayBar.js";
import { readAudio } from "./readAudio.js";
import { drawVisualization } from "./drawVisualization.js?v=20260901b";
import { drawVisualization2 } from "./drawVisualization2.js?v=20260901b";
import { getSpeechTimelineStartSeconds } from "./timeNormalization.js";

export var mouseover = function(d) {
	if (d.color != "#ffffff" && selectedParticipantObject.selectedParticipant===""){
		d3.select(this)
			.style("stroke", "black")
			.style("stroke-opacity", 1)
			.raise();
	}
	if (barObject.bar && !barObject.bar.empty()) barObject.bar.raise();
}

export var mouseleave = function() {
	if (selectedParticipantObject.selectedParticipant===""){
		d3.select(this)
	  		.style("stroke", "none");
	}
}

function normalizeSpeechText(value) {
	return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function findMatchingSpeechIndex(transcript, speechCandidate, preferredIndex = null) {
	if (!Array.isArray(transcript) || transcript.length === 0) return -1;

	if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < transcript.length) {
		return preferredIndex;
	}

	const directRefIndex = transcript.indexOf(speechCandidate);
	if (directRefIndex >= 0) return directRefIndex;

	const selectedTimestamp = normalizeSpeechText(speechCandidate && speechCandidate.timestamp);
	const selectedScript = normalizeSpeechText(speechCandidate && speechCandidate.script);
	const selectedSpeaker = normalizeSpeechText(speechCandidate && speechCandidate.speaker);
	const selectedTag = normalizeSpeechText(speechCandidate && speechCandidate.tag);

	for (let i = 0; i < transcript.length; i++) {
		const cue = transcript[i] || {};
		const cueTimestamp = normalizeSpeechText(cue.timestamp);
		const cueScript = normalizeSpeechText(cue.script);
		const cueSpeaker = normalizeSpeechText(cue.speaker);
		const cueTag = normalizeSpeechText(cue.tag);

		const timestampMatch = selectedTimestamp && cueTimestamp === selectedTimestamp;
		const scriptMatch = selectedScript && cueScript === selectedScript;
		const speakerMatch = selectedSpeaker && cueSpeaker === selectedSpeaker;
		const tagMatch = selectedTag && cueTag === selectedTag;

		if (timestampMatch && scriptMatch) return i;
		if (timestampMatch && tagMatch) return i;
		if (timestampMatch && speakerMatch) return i;
		if (scriptMatch && tagMatch) return i;
	}

	if (selectedTimestamp) {
		for (let i = 0; i < transcript.length; i++) {
			if (normalizeSpeechText(transcript[i] && transcript[i].timestamp) === selectedTimestamp) {
				return i;
			}
		}
	}

	return -1;
}

function resolveSpeechContext(speechCandidate, speechIndex) {
	const transcriptMap = transcriptsObject.transcripts || {};
	const normalizedIndex = Number.isInteger(speechIndex)
		? speechIndex
		: (Number.isInteger(speechCandidate && speechCandidate._transcriptIndex) ? speechCandidate._transcriptIndex : null);

	const preferredParticipant = resolveParticipantId(
		(speechCandidate && (speechCandidate.participant || speechCandidate.speaker)) || "",
		transcriptMap
	);

	if (preferredParticipant && Array.isArray(transcriptMap[preferredParticipant])) {
		const preferredTranscript = transcriptMap[preferredParticipant];
		const preferredMatchIndex = findMatchingSpeechIndex(preferredTranscript, speechCandidate, normalizedIndex);
		if (preferredMatchIndex >= 0) {
			return {
				participant: preferredParticipant,
				index: preferredMatchIndex,
				speech: preferredTranscript[preferredMatchIndex]
			};
		}
	}

	const participantIds = Object.keys(transcriptMap);
	for (let i = 0; i < participantIds.length; i++) {
		const participantId = participantIds[i];
		const transcript = transcriptMap[participantId];
		if (!Array.isArray(transcript) || transcript.length === 0) continue;
		const matchedIndex = findMatchingSpeechIndex(transcript, speechCandidate, null);
		if (matchedIndex >= 0) {
			return {
				participant: participantId,
				index: matchedIndex,
				speech: transcript[matchedIndex]
			};
		}
	}

	return null;
}

function getSelectedThemeKeys() {
	const rawSelection = themeObject.theme;
	if (Array.isArray(rawSelection)) {
		return [...new Set(rawSelection.map((value) => String(value || "").trim()).filter(Boolean))];
	}
	if (typeof rawSelection === "string" && rawSelection.trim()) {
		return [rawSelection.trim()];
	}
	return [];
}

function getDominantThemeName(speech) {
	if (!speech || !Array.isArray(themesObject.themes)) return "";
	let topThemeName = "";
	let topThemeValue = 0;

	themesObject.themes.forEach((theme) => {
		const themeName = String(theme?.themeName || "").trim();
		if (!themeName) return;
		const score = Number(speech[themeName]);
		if (!Number.isFinite(score) || score <= topThemeValue) return;
		topThemeValue = score;
		topThemeName = themeName;
	});

	return topThemeName;
}

function recordVisualizationBlockFocus(speech) {
	if (
		!window.ChromaUsageLogger
		|| typeof window.ChromaUsageLogger.startVisualizationBlockFocus !== "function"
	) {
		return;
	}

	window.ChromaUsageLogger.startVisualizationBlockFocus({
		participant: speech?.participant,
		transcriptIndex: speech?._transcriptIndex,
		tag: speech?.tag,
		timestamp: speech?.timestamp,
		speaker: speech?.speaker,
		color: speech?.color,
		dominantTheme: getDominantThemeName(speech),
		viewMode: String(window.view || "timeline").toLowerCase(),
		selectedThemes: getSelectedThemeKeys(),
	});
}


// Click function
export var click = function(d, speechIndex){
	if (!d) return;

	const speechContext = resolveSpeechContext(d, speechIndex);
	const selectedSpeech = speechContext
		? Object.assign({}, speechContext.speech || {}, {
			participant: speechContext.participant,
			_transcriptIndex: speechContext.index
		})
		: Object.assign(
			{},
			d,
			Number.isInteger(speechIndex)
				? { _transcriptIndex: speechIndex }
				: (Number.isInteger(d._transcriptIndex) ? { _transcriptIndex: d._transcriptIndex } : {})
		);
	const selectedIndex = Number.isInteger(selectedSpeech._transcriptIndex) ? selectedSpeech._transcriptIndex : null;

	d3.selectAll("#speech, .speech-rect, .selected-excerpt-overlay").style("stroke", "none");
	d3.select(this).style("stroke", "black");

	const speechKey = [
		selectedSpeech.participant || "",
		selectedSpeech.timestamp || "",
		selectedSpeech.speaker || "",
		selectedSpeech.tag || "",
		selectedIndex !== null ? String(selectedIndex) : ""
	].join("|");

	firstClickObject.firstClick = false;
	firstClickObject.object = speechKey;

	const resolvedParticipant = resolveParticipantId(
		selectedSpeech.participant || selectedSpeech.speaker,
		transcriptsObject.transcripts
	);
	if (resolvedParticipant) {
		selectedSpeech.participant = resolvedParticipant;
	}

	const participantTranscript = transcriptsObject.transcripts[selectedSpeech.participant] || [];
	if (participantTranscript.length === 0) {
		console.warn(`Transcript for ${selectedSpeech.participant || "unknown participant"} is unavailable.`);
		return;
	}

	const resolvedSpeechIndex = findMatchingSpeechIndex(participantTranscript, selectedSpeech, selectedIndex);
	if (resolvedSpeechIndex >= 0) {
		const canonicalSpeech = participantTranscript[resolvedSpeechIndex];
		selectedSpeech.timestamp = canonicalSpeech.timestamp;
		selectedSpeech.script = (typeof canonicalSpeech.script === "string")
			? canonicalSpeech.script
			: (typeof canonicalSpeech.text === "string" ? canonicalSpeech.text : "");
		selectedSpeech.speaker = canonicalSpeech.speaker;
		selectedSpeech.tag = canonicalSpeech.tag;
		selectedSpeech._transcriptIndex = resolvedSpeechIndex;
	}

	recordVisualizationBlockFocus(selectedSpeech);

	const participantRowY = yObject.y(selectedSpeech.participant);
	barYValueObject.barYValue = Number.isFinite(participantRowY) ? participantRowY - 10 : -10;
	selectedParticipantObject.selectedParticipant = selectedSpeech.participant;

	const participantMatch = findParticipantAudio(selectedSpeech.participant);
	const audioSrc = buildServeAudioUrl(participantMatch?.audio);
	const hasAudioMatch = !!audioSrc;
	if (hasAudioMatch) {
		if (setPlaybarAudioSource(audioSrc)) {
			selectedSpeech.audioFileObject = participantMatch.audio;
		}
	} else {
		const displaySeconds = getSpeechTimelineStartSeconds(selectedSpeech);
		clearPlaybarAudio({
			displaySeconds,
			maxDisplaySeconds: displaySeconds,
			reason: "Audio not provided for this participant."
		});
	}

	addSpeeches(selectedSpeech, participantTranscript);
	if (hasAudioMatch) {
		playBar(selectedSpeech);
	}

	if (barObject.bar && !barObject.bar.empty()) {
		const currentSeconds = getSpeechTimelineStartSeconds(selectedSpeech);
		barObject.bar
			.attr("x", xObject.x(currentSeconds))
			.attr("y", yObject.y(selectedSpeech.participant) || -9999)
			.style("opacity", 1)
			.raise();
	}
}
