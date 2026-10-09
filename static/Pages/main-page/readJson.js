// import { themesObject, highlight, currentDisplayObject, interviewLengthsObject,raceObject,ageObject,
//     HIVObject,genderObject,transcriptsObject } from "../chromascribe-main.js";
import { themesObject, highlight, currentDisplayObject, interviewLengthsObject, transcriptsObject } from "../../../static/chromascribe-main.js";
import {
    formatTimelineSeconds,
    getParticipantTimelineDurationSeconds,
    normalizeTranscriptTimeline
} from "./timeNormalization.js";
import { normalizeThemeParticipantId } from "../themePersistence.js";

export var allObject = {all:[]};
export var asianObject = {asian:[]};
export var african_americanObject = {african_american:[]};
export var whiteObject = {white:[]};
export var mixedObject = {mixed:[]};
export var age_30_40Object = {age_30_40:[]};
export var age_41_50Object = {age_41_50:[]};
export var age_51_60Object = {age_51_60:[]};
export var maleObject = {male:[]};
export var femaleObject = {female:[]};
export var otherObject = {other:[]};
export var positiveObject = {positive:[]};
export var negativeObject = {negative:[]};
export var countObject = {count:0};

const qnaIntermediateCache = {
    key: "",
    payload: null,
    promise: null,
};

function normalizeSearchText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizedTextTokens(value) {
    return normalizeSearchText(value)
        .split(/\s+/)
        .filter(token => token.length > 2);
}

function normalizedTextsHaveStrongOverlap(selectedText, speechText) {
    const selectedTokens = [...new Set(normalizedTextTokens(selectedText))];
    const speechTokens = new Set(normalizedTextTokens(speechText));
    if (selectedTokens.length < 4 || speechTokens.size < 4) return false;
    const overlap = selectedTokens.filter(token => speechTokens.has(token)).length;
    return overlap >= 4 && overlap / selectedTokens.length >= 0.55;
}

function normalizedExcerptTextMatchesSpeech(selectedText, speechText, hasContext = false) {
    if (!selectedText || !speechText) return false;
    if (speechText === selectedText || speechText.includes(selectedText) || selectedText.includes(speechText)) {
        return true;
    }
    return hasContext && normalizedTextsHaveStrongOverlap(selectedText, speechText);
}

function normalizeQaTag(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const match = text.match(/\b([QA])\s*0*(\d+)([a-z]?)\b/i);
    if (!match) return "";
    return `${match[1].toUpperCase()}${parseInt(match[2], 10)}${(match[3] || "").toLowerCase()}`;
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

function normalizeParticipantCodeFromText(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const match = text.match(/\b(?:participant|p)\s*0*(\d+)\b/i);
    if (match) return `P${parseInt(match[1], 10)}`;
    return "";
}

function normalizeTimestamp(value) {
    return String(value || "")
        .replace(/\s+/g, "")
        .trim();
}

function getExcerptParticipant(entry) {
    return normalizeThemeParticipantId(entry.participantId || entry.participant)
        || normalizeParticipantCodeFromText(entry.speaker);
}

function getExcerptSourceFile(entry) {
    return String(entry.sourceFile || entry.source_file || "").replace(/\\/g, "/").trim();
}

function createSelectedExcerptLookupKey(normalizedText, participant = "", tag = "") {
    return `${participant}||${tag}||${normalizedText}`;
}

function createSelectedExcerptCueLookupKey(participant = "", timestamp = "", tag = "") {
    return `cue::${participant}||${timestamp}||${tag}`;
}

function strictSelectedExcerptMatchesSpeech(entry, speech, normalizedSpeechText) {
    if (!entry || !speech || !normalizedSpeechText) return false;

    const speechParticipant = getExcerptParticipant(speech);
    if (entry.participant && (!speechParticipant || entry.participant !== speechParticipant)) {
        return false;
    }

    const speechSourceFile = getExcerptSourceFile(speech);
    if (entry.sourceFile && speechSourceFile && entry.sourceFile !== speechSourceFile) {
        return false;
    }
    if (entry.segmentId && speech.segmentId) {
        if (entry.segmentId !== speech.segmentId) return false;
        return normalizedExcerptTextMatchesSpeech(entry.cueText || entry.normalizedText, normalizedSpeechText, true);
    }

    const speechTags = getSpeechQaTags(speech);
    if (entry.tag && !speechTags.some(tag => qaTagsCompatible(entry.tag, tag))) {
        return false;
    }

    const speechTimestamp = normalizeTimestamp(speech.timestamp);
    if (entry.timestamp && (!speechTimestamp || entry.timestamp !== speechTimestamp)) {
        const hasTextFallback = Boolean(entry.cueText || entry.normalizedText);
        if (!hasTextFallback) return false;
    }

    const hasContext = Boolean(entry.participant || entry.tag || entry.timestamp);

    if (entry.cueText && normalizedExcerptTextMatchesSpeech(entry.cueText, normalizedSpeechText, hasContext)) {
        return true;
    }

    if (!entry.normalizedText) {
        return false;
    }

    if (normalizedExcerptTextMatchesSpeech(entry.normalizedText, normalizedSpeechText, hasContext)) {
        return true;
    }

    return false;
}

function buildSelectedExcerptLookup(activeThemes) {
    const lookup = new Map();
    const strictEntries = [];
    const themes = Array.isArray(activeThemes && activeThemes.themes)
        ? activeThemes.themes
        : [];

    const addThemeForLookupKey = (targetMap, key, theme, themeName) => {
        if (!key || !targetMap) return;
        const existing = targetMap.get(key) || [];
        if (!existing.some(entry => String((entry && entry.themeName) || "").trim() === themeName)) {
            existing.push(theme);
            targetMap.set(key, existing);
        }
    };

    themes.forEach((theme) => {
        const themeName = String((theme && theme.themeName) || "").trim();
        const words = Array.isArray(theme && theme.words) ? theme.words : [];
        if (!themeName || words.length === 0) return;

        words.forEach((wordEntry) => {
            const rawText = typeof wordEntry === "string"
                ? wordEntry
                : String((wordEntry && wordEntry.word) || "").trim();
            const normalizedText = normalizeSearchText(rawText);
            const normalizedCueText = normalizeSearchText(
                typeof wordEntry === "object" && wordEntry
                    ? wordEntry.cueText
                    : ""
            );
            if (!normalizedText && !normalizedCueText) return;

            const speaker = typeof wordEntry === "object" && wordEntry
                ? String(wordEntry.speaker || "").trim()
                : "";
            const participant = typeof wordEntry === "object" && wordEntry
                ? getExcerptParticipant(wordEntry)
                : "";
            const segmentId = String(wordEntry?.segmentId || "").trim();
            const sourceFile = typeof wordEntry === "object" && wordEntry
                ? getExcerptSourceFile(wordEntry)
                : "";
            const tag = normalizeQaTag(
                typeof wordEntry === "object" && wordEntry
                    ? (wordEntry.tag || speaker)
                    : ""
            );
            const timestamp = normalizeTimestamp(
                typeof wordEntry === "object" && wordEntry
                    ? wordEntry.timestamp
                    : ""
            );
            strictEntries.push({
                theme,
                themeName,
                participant,
                segmentId,
                sourceFile,
                tag,
                timestamp,
                normalizedText,
                cueText: normalizedCueText
            });

            // Imported identities must pass the strict checks below. Putting them
            // in the old text-only index would match repeated untimed answers.
            if (!participant || segmentId || sourceFile) return;

            const candidateKeys = [];
            const addTextLookupKeys = (text) => {
                if (!text) return;
                if (participant && tag) {
                    candidateKeys.push(createSelectedExcerptLookupKey(text, participant, tag));
                }
                if (participant) {
                    candidateKeys.push(createSelectedExcerptLookupKey(text, participant, ""));
                }
            };

            if (participant && timestamp && tag) {
                candidateKeys.push(createSelectedExcerptCueLookupKey(participant, timestamp, tag));
            }
            if (participant && timestamp) {
                candidateKeys.push(createSelectedExcerptCueLookupKey(participant, timestamp, ""));
            }
            addTextLookupKeys(normalizedText);
            addTextLookupKeys(normalizedCueText);

            candidateKeys.forEach((key) => {
                addThemeForLookupKey(lookup, key, theme, themeName);
            });
        });
    });

    lookup.strictEntries = strictEntries;
    return lookup;
}

function findSelectedThemeMatchesForSpeech(speech, selectedExcerptLookup) {
    const strictEntries = Array.isArray(selectedExcerptLookup && selectedExcerptLookup.strictEntries)
        ? selectedExcerptLookup.strictEntries
        : [];
    if (!speech || !selectedExcerptLookup || (selectedExcerptLookup.size === 0 && strictEntries.length === 0)) {
        return [];
    }

    const normalizedText = normalizeSearchText(speech.script);
    if (!normalizedText) return [];

    const participant = getExcerptParticipant(speech);
    const speechTags = getSpeechQaTags(speech);
    const timestamp = normalizeTimestamp(speech.timestamp);
    const candidateKeys = [];

    speechTags.forEach(tag => {
        if (participant && timestamp && tag) {
            candidateKeys.push(createSelectedExcerptCueLookupKey(participant, timestamp, tag));
        }
        if (participant && tag) {
            candidateKeys.push(createSelectedExcerptLookupKey(normalizedText, participant, tag));
        }
    });
    if (participant && timestamp) {
        candidateKeys.push(createSelectedExcerptCueLookupKey(participant, timestamp, ""));
    }
    if (participant) {
        candidateKeys.push(createSelectedExcerptLookupKey(normalizedText, participant, ""));
    }
    const strictMatches = [];
    const seenThemes = new Set();
    for (const key of candidateKeys) {
        const matches = selectedExcerptLookup.get(key);
        for (const theme of Array.isArray(matches) ? matches : []) {
            if (!theme.themeName || seenThemes.has(theme.themeName)) continue;
            seenThemes.add(theme.themeName);
            strictMatches.push(theme);
        }
    }

    strictEntries.forEach((entry) => {
        if (!strictSelectedExcerptMatchesSpeech(entry, speech, normalizedText)) return;
        if (!entry.themeName || seenThemes.has(entry.themeName)) return;
        seenThemes.add(entry.themeName);
        strictMatches.push(entry.theme);
    });

    return strictMatches;
}

function applyThemeScoresToSpeech(speech, activeThemes, options = {}) {
    const themes = Array.isArray(activeThemes && activeThemes.themes)
        ? activeThemes.themes
        : [];
    const selectedExcerptLookup = options && options.selectedExcerptLookup instanceof Map
        ? options.selectedExcerptLookup
        : null;

    if (!speech || typeof speech !== "object") {
        return;
    }

    themes.forEach(theme => {
        if (theme && theme.themeName) {
            speech[theme.themeName] = 0;
        }
    });
    speech._themeColors = [];

    const explicitMatches = findSelectedThemeMatchesForSpeech(speech, selectedExcerptLookup);
    if (!explicitMatches.length) {
        speech.color = highlight["Neutral"];
        return;
    }

    const normalizedScore = 1 / explicitMatches.length;
    explicitMatches.forEach((theme) => {
        if (theme && theme.themeName) {
            speech[theme.themeName] = normalizedScore;
        }
    });
    speech._themeColors = [...new Set(explicitMatches
        .map(theme => String((theme && theme.color) || "").trim())
        .filter(Boolean))];
    const primaryTheme = explicitMatches[0];
    speech.color = primaryTheme && primaryTheme.color ? primaryTheme.color : highlight["Neutral"];
}

function resolveCurrentProjectCacheKey() {
    const appMode = String(window.APP_MODE || "user").trim();
    const projectId = String(localStorage.getItem("currentProjectId") || "").trim();
    const processedUrl = String(window.PROCESSED_TRANSCRIPTS_URL || "").trim();
    return `${appMode}::${projectId}::${processedUrl}`;
}

function resolveIntermediateTagMapForFile(fileKey, section) {
    if (!section || typeof section !== "object") return {};
    if (section[fileKey] && typeof section[fileKey] === "object") {
        return section[fileKey];
    }

    const targetBaseName = String(fileKey || "").split(/[\\/]/).pop().toLowerCase();
    if (!targetBaseName) return {};

    for (const [candidateKey, value] of Object.entries(section)) {
        const candidateBaseName = String(candidateKey || "").split(/[\\/]/).pop().toLowerCase();
        if (candidateBaseName === targetBaseName && value && typeof value === "object") {
            return value;
        }
    }

    return {};
}

function applyIntermediateTagIndexMap(transcript, tagMap) {
    if (!Array.isArray(transcript) || !tagMap || typeof tagMap !== "object") {
        return;
    }

    Object.entries(tagMap).forEach(([tag, indexes]) => {
        const normalizedTag = normalizeQaTag(tag);
        if (!normalizedTag || !Array.isArray(indexes)) return;

        indexes.forEach((indexValue) => {
            const transcriptIndex = Number(indexValue);
            if (!Number.isInteger(transcriptIndex)) return;
            const speech = transcript[transcriptIndex];
            if (!speech || typeof speech !== "object") return;
            const currentTag = normalizeQaTag(speech.tag);
            if (!currentTag || currentTag === normalizedTag) {
                speech.tag = normalizedTag;
            }
        });
    });
}

function hydrateTranscriptTagsFromIntermediateData(data, intermediatePayload) {
    if (!data || typeof data !== "object" || !intermediatePayload || typeof intermediatePayload !== "object") {
        return;
    }

    Object.entries(data).forEach(([fileKey, entry]) => {
        if (!entry || !Array.isArray(entry.transcript)) return;
        applyIntermediateTagIndexMap(entry.transcript, resolveIntermediateTagMapForFile(fileKey, intermediatePayload.questions));
        applyIntermediateTagIndexMap(entry.transcript, resolveIntermediateTagMapForFile(fileKey, intermediatePayload.answers));
    });
}

async function fetchIntermediateQnaPayload() {
    const cacheKey = resolveCurrentProjectCacheKey();
    if (qnaIntermediateCache.payload && qnaIntermediateCache.key === cacheKey) {
        return qnaIntermediateCache.payload;
    }
    if (qnaIntermediateCache.promise && qnaIntermediateCache.key === cacheKey) {
        return qnaIntermediateCache.promise;
    }

    qnaIntermediateCache.key = cacheKey;
    qnaIntermediateCache.promise = fetch(`/api/project_qna_tag_payload?t=${Date.now()}`, { cache: "no-store" })
        .then((response) => {
            if (!response.ok) {
                throw new Error(`project_qna_tag_payload failed: ${response.status}`);
            }
            return response.json();
        })
        .catch((error) => {
            console.warn("Could not load project Q/A tag payload:", error);
            return { questions: {}, answers: {}, possibleAnswers: {} };
        })
        .then((payload) => {
            qnaIntermediateCache.payload = payload;
            qnaIntermediateCache.promise = null;
            return payload;
        });

    return qnaIntermediateCache.promise;
}

export async function processLoadedTranscripts(data, activeThemes) {
    if (!data || !activeThemes) {
        console.error("processLoadedTranscripts called with invalid data or themes.");
        return;
    }
	// This will hold the fully processed data for the visualization
    let processedParticipantData = []; 
    const qnaPayload = await fetchIntermediateQnaPayload();
    hydrateTranscriptTagsFromIntermediateData(data, qnaPayload);
    const selectedExcerptLookup = buildSelectedExcerptLookup(activeThemes);
    console.log("Processing transcripts with themes:", activeThemes);

		for (var fileKey in data){ // fileKey is like 'DataFiles_P3_Clean_Transcripts.txt'
        const entry = data[fileKey];
        if (!entry || !entry.transcript) continue;
		
        // Derive participant ID from the audiofile first, then fall back to the transcript filename.
        const participantId = entry.participantId || entry.participant || getParticipantIdFromAudiofileName(entry.audiofile, fileKey);
        if (!participantId) {
            console.warn(`Could not derive participant ID from audiofile: ${entry.audiofile} for key: ${fileKey}`);
            continue;
        }
		entry.participant = participantId; // Add participant ID to the entry

        normalizeTranscriptTimeline(entry.transcript, { fallbackLastDurationSeconds: 5 });

        entry.transcript.forEach(function(speech) {
            speech.participant = participantId;
            speech.sourceFile = speech.sourceFile || entry.sourceFile || fileKey;
            applyThemeScoresToSpeech(speech, activeThemes, {
                selectedExcerptLookup
            });

            speech.fullAudio = null;
        });
        interviewLengthsObject.interviewLengths[participantId] = formatTimelineSeconds(
            getParticipantTimelineDurationSeconds(entry.transcript)
        );
        
        // Populate the global transcriptsObject with the processed transcript
        transcriptsObject.transcripts[participantId] = entry.transcript;
        processedParticipantData.push(entry); // Push the entire processed entry
	}
    
    // Set the object that drawVisualization will use
	currentDisplayObject.currentDisplay = processedParticipantData;
	console.log("Processing complete. currentDisplayObject updated:", currentDisplayObject.currentDisplay);
}

function getParticipantIdFromAudiofileName(audioFilename, fallbackFilename = "") {
    const candidates = [audioFilename, fallbackFilename].filter(Boolean);
    for (const candidate of candidates) {
        const text = String(candidate || "").trim();
        const basename = text.split(/[\\/]/).pop() || text;
        let match = basename.match(/(^|[^A-Za-z0-9])P\s*0*(\d+)(?![A-Za-z0-9])/i);
        if (match && match[2]) return "P" + parseInt(match[2], 10);
        match = basename.match(/^P\s*0*(\d+)/i);
        if (match && match[1]) return "P" + parseInt(match[1], 10);
        match = basename.match(/(^|[^A-Za-z0-9])pt\s*0*(\d+)(?![A-Za-z0-9])/i);
        if (match && match[2]) return "P" + parseInt(match[2], 10);
        match = basename.match(/^0*(\d+)(?=[_\.\s-])/);
        if (match && match[1]) return "P" + parseInt(match[1], 10);
    }
    return null;
}


export function readJson(data,themesObject){
		allObject.all = [], asianObject.asian = [], african_americanObject.african_american = [], 
		whiteObject.white = [], mixedObject.mixed = [], age_30_40Object.age_30_40 = [], 
		age_41_50Object.age_41_50 = [], age_51_60Object.age_51_60 = [], maleObject.male = [], 
		femaleObject.female = [], otherObject.other = [], positiveObject.positive = [], negativeObject.negative = [];
    const selectedExcerptLookup = buildSelectedExcerptLookup(themesObject);

	console.log(data)
	console.log(themesObject)
	
	d3.select("#transcript").selectAll("*").remove();
	
	for (var key in data){

		// --- THIS IS THE KEY FIX ---
		// Instead of the fragile substring logic, we use your existing, working helper function.
		const participantId = data[key].participantId || data[key].participant || getParticipantIdFromAudiofileName(data[key].audiofile, key);
		
		if (!participantId) {
			console.warn(`Could not determine participant ID for key: ${key}. Skipping.`);
			continue; // Skip this entry if we can't get an ID
		}
		data[key].participant = participantId;
		// --- END OF FIX ---

		// // Determine the patient for the bar
		// countObject.count++;
		// if (data[key].audiofile.substring(9,11)*1>9)
		// 	data[key].participant = "P" + data[key].audiofile.substring(9,11);
		// else 
		// 	data[key].participant = "P" + data[key].audiofile.substring(10,11);

			transcriptsObject.transcripts[data[key].participant] = data[key]['transcript'];
			console.log(data)
			normalizeTranscriptTimeline(data[key]['transcript'], { fallbackLastDurationSeconds: 5 });
			data[key]['transcript'].forEach(function(speech) {
				speech.participant = data[key].participant;
				speech.sourceFile = speech.sourceFile || data[key].sourceFile || key;
				applyThemeScoresToSpeech(speech, themesObject, {
					selectedExcerptLookup
				});

				speech.fullAudio = null;
			});
        interviewLengthsObject.interviewLengths[data[key].participant] = formatTimelineSeconds(
            getParticipantTimelineDurationSeconds(data[key]['transcript'])
        );

		//filter arrays
		allObject.all.push(data[key]);
		if (data[key].ethnicity==='asian'){asianObject.asian.push(data[key]);}
		if (data[key].ethnicity==='african_american'){african_americanObject.african_american.push(data[key]);}
		if (data[key].ethnicity==='white'){whiteObject.white.push(data[key]);}
		if (data[key].ethnicity==='mixed'){mixedObject.mixed.push(data[key]);}
		if (data[key].age>=30 && data[key].age<=40){age_30_40Object.age_30_40.push(data[key]);}
		if (data[key].age>=41 && data[key].age<=50){age_41_50Object.age_41_50.push(data[key]);}
		if (data[key].age>=51 && data[key].age<=60){age_51_60Object.age_51_60.push(data[key]);}
		if (data[key].gender==='male'){maleObject.male.push(data[key]);}
		if (data[key].gender==='female'){femaleObject.female.push(data[key]);}
		if (data[key].gender==='other'){otherObject.other.push(data[key]);}
		if (data[key].HIV==='positive'){positiveObject.positive.push(data[key]);}
		if (data[key].HIV==='negative'){negativeObject.negative.push(data[key]);}
	}
	//raceObject.race=allObject.all, ageObject.age=allObject.all, genderObject.gender=allObject.all, HIVObject.HIV=allObject.all;
	
	currentDisplayObject.currentDisplay = Object.values(data);
	
}
