// Mia Lee
// chromascribe-main.js
// 8/28/21


//Import statements
import {showSettings} from "./Pages/settings-page/menupanel.js?v=20260901a";
import {startThemeEditing} from "./Pages/settings-page/themes/startThemeEditing.js";
import { selectTheme } from "./Pages/main-page/selectTheme.js?v=20260929a";
import { processLoadedTranscripts } from './Pages/main-page/readJson.js?v=20260601b';
import { showMenu } from "./Pages/main-page/demographicFiltering.js?v=20260601b";
import { semanticZoom } from "./Pages/main-page/semanticZoom.js?v=20260601b";

// Box colors
export var highlight = 
	{"Neutral":"#eeedef",
	"#E7A23B":"#ffd6b5",
	"#8EC053":"#D7FFA9",
	"#579AE2":"#CBD2FF",
	"#E14947":"#FFA3A3",
	"#8E41D1":"#D8ABFF"};

// Prevent spacebar from scrolling
window.addEventListener('keydown', (e) => {  
	if ((e.key == " " || e.code == "Space") && e.target === document.body) 
	  e.preventDefault();  
});

// Default themes
export var themesObject = {themes:[]};
export var themeObject = {theme:[]};
export var multiSelectedWordsObject = {
    selectedWords: [], // array of { word, index, source }
  };
// Other Important variables
export var firstEditObject = {firstEdit:true};
export var demoingObject = {demoing:false};
export var firstGenerateObject = {firstGenerate:true};
export var possibleThemesObject = {possibleThemes:[]};
export var themeColors = [
  "#E7A23B",
  "#E14947",
  "#8EC053",
  "#579AE2",
  "#8E41D1",
  "#15AABF",
  "#F76707",
  "#2F9E44",
  "#D6336C",
  "#7048E8",
  "#0CA678",
  "#F59F00",
  "#1971C2",
  "#C2255C",
  "#5C940D",
  "#9C36B5",
];
export var selectedThemeBoxObject = {selectedThemeBox:""};
export var tempThemesObject = {tempThemes:[]};
export var currentBoxHeightObject = {currentBoxHeight:0};
export var currentBoxWidthObject = {currentBoxWidth:0};
export var wordCloudShapeObject = {wordCloudShape:""}
export var firstShowOnboradingObject = {firstShowOnborading:true};
export var wordSelectedAlreadyObject = {wordSelectedAlready:false};
export var mouseOverDeleteWordObject = {mouseOverDeleteWord:false};
export var showingStemmedWordsInstructionsObject = {showingStemmedWordsInstructions:false};
export var showingStemmedWordsObject = {showingStemmedWords:false};
export var mouseOverDeleteStemmedWordObject = {mouseOverDeleteStemmedWord:false};
export var currentDisplayObject = {currentDisplay:[]};
export var selectedParticipantObject = {selectedParticipant:""};
export var interviewLengthsObject = {interviewLengths:{}};
export var firstClickObject = {firstClick:true, object:""};
export var themeqObject = {theme:""};
export var themeSelectedObject = {themeSelected:false};
export var lastThemeClickedObject = {lastThemeClicked:""};
export var selectionMapObject = {selectionMap:{"allRace": true, "african_american": false, "asian": false, "white": false, "mixed": false,
	"allAge": true, "age-30-40": false, "age-41-50": false, "age-51-60": false,
	"allGender": true, "male": false, "female": false, "other": false, 
	"allHIV": true, "positive": false, "negative": false}};
export var menuOpenObject = {menuOpen:false};
export var tempObject = {temp:[]};
export var raceObject = {race:[]};
export var ageObject = {age:[]};
export var genderObject = {gender:[]};
export var demographicsObject = {"options":[
	{ "field": "age", "type": "Integer", "values": []},
	{ "field": "gender", "type": "Text", "values": []},
	{ "field": "educationLevel", "type": "Text", "values": []},
	{ "field": "ethnicity", "type": "Text", "values": []},
	{ "field": "maritalStatus", "type": "Text", "values": []},
	{ "field": "location", "type": "Text", "values": []},
	{ "field": "occupation", "type": "Text", "values": []}
	], 
	"chosenFields":[], 
	"transcripts": []};
export var demographicsTypes = ["Integer", "Text"];
export var typePatterns = [
    { "type": "Text", "pattern": /.*/ },
    { "type": "Integer", "pattern": /\d+/ },
];

export var HIVObject = {HIV:[]};
export var kObject = {k:1};
export var lastKObject = {lastK:1};
export var graphWidthObject = {graphWidth:0};
//export var timesObject = {times:[]};
export var xTimeObject = {xTime:"null"};
export var xAxisObject = {xAxis:"null"};
export var xObject = {x:null};
export var yObject = {y:null};
export var yAxisObject = {yAxis:""};
export var participants = [];
export var barYValueObject = {barYValue:0};
export var transcriptsObject = {transcripts:{}};
export var transcriptCacheObject = { lastUrl: "", lastThemeSignature: "", rawData: null };
export var selectedGraphObject = {selectedGraph:[]};
export var playObject = {play:true};
export var svgObject = {svg:""};
export var userImportedFilesObject = {userImportedFiles:[]};
//export var files = {filesUploaded: false};
export var filesUploaded = false
//localStorage.setItem('filesUploaded', true)
export var themes = {themesApplied: false};


export let FileMap = { participants: [] };

function getActiveProjectId() {
	try {
		const rawValue = localStorage.getItem("currentProjectId");
		return typeof rawValue === "string" ? rawValue.trim() : "";
	} catch (_) {
		return "";
	}
}

function projectMatchesActiveProject(projectId) {
	const activeProjectId = getActiveProjectId();
	const incomingProjectId = String(projectId || "").trim();
	return !incomingProjectId || !activeProjectId || incomingProjectId === activeProjectId;
}

function parseFileMapPayload(rawValue) {
	if (!rawValue) return null;
	try {
		const parsed = JSON.parse(rawValue);
		const participantsPayload = Array.isArray(parsed?.participants)
			? parsed.participants
			: (Array.isArray(parsed) ? parsed : null);
		return participantsPayload
			? {
				participants: participantsPayload,
				projectId: parsed?.projectId
			}
			: null;
	} catch (error) {
		console.warn("Failed to parse FileMap sync payload:", error);
		return null;
	}
}

function isFileMapStorageKey(key) {
	return typeof key === "string" && (key.includes("FileMap_MatchedData") || key.startsWith("data.json"));
}

export function clearTranscriptCache() {
	transcriptCacheObject.lastUrl = "";
	transcriptCacheObject.lastThemeSignature = "";
	transcriptCacheObject.rawData = null;
	currentDisplayObject.currentDisplay = [];
	transcriptsObject.transcripts = {};
	interviewLengthsObject.interviewLengths = {};
	participants.length = 0;
}

export function applySyncedFileMap(fileMap, options = {}) {
	if (!projectMatchesActiveProject(options.projectId)) return false;
	if (!fileMap || !Array.isArray(fileMap.participants)) return false;
	FileMap.participants = fileMap.participants;
	clearTranscriptCache();
	return true;
}

if (typeof window !== "undefined") {
	window.addEventListener("filemap:updated", function(event) {
		applySyncedFileMap(event?.detail?.fileMap, {
			projectId: event?.detail?.projectId
		});
	});

	window.addEventListener("storage", function(event) {
		if (!event || !isFileMapStorageKey(event.key)) return;
		const fileMap = parseFileMapPayload(event.newValue);
		if (fileMap) {
			applySyncedFileMap(fileMap, { projectId: fileMap.projectId });
		} else {
			clearTranscriptCache();
		}
	});
}
// Export an object holding the file lists
export const fileLists = {
    filesList1: [],  // First list for the first upload div
    filesList2: []   // Second list for the second upload div
};


// Theme Selection buttons
d3.selectAll(".theme-labels").on("click", selectTheme);

// Edit Themes button
var editThemesButton = d3.select("#edit-themes-button");
editThemesButton.on("click", function(){
	//showSettings();
	startThemeEditing();
});

// Demographic Filters

d3.select("#settings-icon").on("click", showSettings);



// Play bar
d3.select("#full-duration").text("--:--");

// Settings Page is displayed first
//showSettings();


export async function loadTranscripts(force = false) {
		// --- THIS IS THE KEY FIX ---
    // 1. Determine which JSON file to load based on the global mode.
    let jsonPath;
    let candidateJsonPaths = [];
    const preferredPath = (window.PROCESSED_TRANSCRIPTS_URL || "").trim();
    if (window.APP_MODE === 'demo') {
        console.log("LOADER: Demo mode detected. Loading demo transcripts.");
        if (preferredPath) {
            candidateJsonPaths.push(preferredPath);
        }
        candidateJsonPaths.push("/demo/api/processed_transcripts");
        jsonPath = candidateJsonPaths[0];
    } else {
        console.log("LOADER: User mode detected. Loading user transcripts.");
        if (preferredPath) {
            candidateJsonPaths.push(preferredPath);
        }
        if (!candidateJsonPaths.length) {
            console.warn("LOADER: No processed transcripts URL found for user project.");
            return null;
        }
        jsonPath = candidateJsonPaths[0];
    }
    // --- END OF FIX ---

        const exactSelectedOnly = window.VISUALIZATION_SELECTED_EXCERPTS_ONLY === true;
	    const themeSignature = JSON.stringify({
            themes: themesObject.themes || [],
            exactSelectedOnly
        });
    if (!force &&
        transcriptCacheObject.rawData &&
        transcriptCacheObject.lastUrl === jsonPath &&
        transcriptCacheObject.lastThemeSignature === themeSignature &&
        currentDisplayObject.currentDisplay.length > 0) {
        console.log("LOADER: Using cached transcripts.");
        return transcriptCacheObject.rawData;
    }

    // Reset state so transcript mode only reflects the currently loaded project
    transcriptsObject.transcripts = {};
    interviewLengthsObject.interviewLengths = {};
    participants.length = 0;
    
    try {
        let data = null;
        let lastStatus = null;
        let resolvedPath = jsonPath;
        const testedPaths = candidateJsonPaths.length ? candidateJsonPaths : [jsonPath];

        const matchedParticipantsCount = Array.isArray(FileMap.participants) ? FileMap.participants.length : 0;
        for (const path of testedPaths) {
            const separator = path.includes("?") ? "&" : "?";
            const response = await fetch(path + separator + "t=" + new Date().getTime());
            if (!response.ok) {
                lastStatus = response.status;
                continue;
            }
            const candidateData = await response.json();
            const isEmptyObject =
                candidateData &&
                typeof candidateData === "object" &&
                !Array.isArray(candidateData) &&
                Object.keys(candidateData).length === 0;
            // If we already know participants were matched, an empty transcript file
            // likely means this path is stale. Try fallback paths before giving up.
            if (isEmptyObject && matchedParticipantsCount > 0 && testedPaths.length > 1) {
                continue;
            }
            data = candidateData;
            resolvedPath = path;
            break;
        }

        if (!data) {
            throw new Error(`HTTP error! Status: ${lastStatus ?? "unknown"} while fetching all_transcripts_processed.json`);
        }

        console.log("Fetched all_transcripts_processed.json:", data);

        // Now, call the processing function. We need the active themes object.
        // themesObject might be empty at this point, or it might be loaded from user's last session.
        // The visualization should ideally be drawn/re-drawn after themes are selected.
        // For now, let's process with whatever themes are currently in themesObject.
        console.log(themesObject)
        await processLoadedTranscripts(data, themesObject); 
        const participantIds = Object.keys(transcriptsObject.transcripts || {}).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true })
        );
        participants.push(...participantIds);
        transcriptCacheObject.lastUrl = resolvedPath;
        transcriptCacheObject.lastThemeSignature = themeSignature;
        transcriptCacheObject.rawData = data;
        return data;
    } catch (error) {
        console.error("Failed to load or process all_transcripts_processed.json:", error);
        return null;
    }
}
        
        
