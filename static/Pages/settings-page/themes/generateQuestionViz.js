import {
    currentDisplayObject,
    graphWidthObject,
    themesObject,
    transcriptsObject,
    FileMap,
    loadTranscripts
} from "../../../chromascribe-main.js";
import { drawVisualization2, allQuestionTags } from "../../main-page/drawVisualization2.js?v=20260901b";
import { graphAxes } from "../../main-page/graphAxes.js";
import { searchSpeeches } from "../../main-page/searchTranscript.js?v=20260601b";
import { normalizeParticipantCode, projectHasUploadedAudio, findParticipantAudio, buildServeAudioUrl } from "../../main-page/audioMatching.js?v=20260601b";
import { appendThemeColorDot, initializeThemeSelectionForPayload, selectTheme, syncThemeSelectionStyles } from "../../main-page/selectTheme.js?v=20260929a";
import { semanticZoom } from "../../main-page/semanticZoom.js?v=20260601b";
import { showFilterSettings } from '../menupanel.js?v=20260901a';
import { buildDemoFileMap } from "../../demoFileMap.js";
import { clearPlaybarAudio, setPlaybarAudioSource } from "../../main-page/audioPlayBar.js";
import {
    getStoredFileMap,
    hydrateFileMapFromServer
} from "../../fileMapSync.js?v=20260601b";
import {
    initializeNonVerbalCueControls,
    setNonVerbalCueControlForView,
    ensureNonVerbalCueData,
    clearNonVerbalCueLayer,
    drawNonVerbalCueLayer,
} from "../../main-page/nonVerbalCues.js?v=20260601b";

const FALLBACK_THEME_COLORS = ["#E7A23B", "#E14947", "#8EC053", "#579AE2", "#8E41D1"];

async function loadCanonicalFileMap(projectId) {
    const fileMap = await hydrateFileMapFromServer(projectId);
    return fileMap || getStoredFileMap(projectId);
}

function resolveLoadedParticipantId(rawParticipant, transcriptMap = transcriptsObject.transcripts) {
    const direct = String(rawParticipant || "").trim();
    if (direct && Array.isArray(transcriptMap[direct])) return direct;

    const normalized = normalizeParticipantCode(direct);
    if (!normalized) return direct;

    const matchedKey = Object.keys(transcriptMap || {}).find(
        key => normalizeParticipantCode(key) === normalized
    );
    return matchedKey || normalized;
}

function getRenderableParticipantIds() {
    const transcriptMap = transcriptsObject.transcripts || {};
    const seen = new Set();
    const ids = [];

    const addParticipant = (rawParticipant) => {
        const participantId = resolveLoadedParticipantId(rawParticipant, transcriptMap);
        if (!participantId || seen.has(participantId)) return;
        const transcript = transcriptMap[participantId];
        if (!Array.isArray(transcript) || transcript.length === 0) return;
        seen.add(participantId);
        ids.push(participantId);
    };

    Object.keys(transcriptMap).forEach(addParticipant);
    currentDisplayObject.currentDisplay
        .map(entry => entry && entry.participant)
        .forEach(addParticipant);
    (FileMap.participants || [])
        .map(entry => entry && entry.participant)
        .forEach(addParticipant);

    return ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function getInitialAudioMatch(participantIds = []) {
    for (const participantId of participantIds) {
        const match = findParticipantAudio(participantId, { allowSingleFallback: false });
        if (match?.audio?.relativePath) return match;
    }
    return findParticipantAudio("", { allowSingleFallback: true });
}

function preloadInitialAudioSource(participantIds = []) {
    const match = getInitialAudioMatch(participantIds);
    const audioSrc = buildServeAudioUrl(match?.audio);
    if (!audioSrc) return false;
    return setPlaybarAudioSource(audioSrc);
}

function getLegendSelection() {
    let legend = d3.select("#theme-legend");
    if (legend.empty()) {
        legend = d3.select("#legend");
    }
    return legend;
}

function getColorInputValue(rawColor, index) {
    const fallback = FALLBACK_THEME_COLORS[index % FALLBACK_THEME_COLORS.length];
    const color = String(rawColor || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) {
        return color;
    }
    if (/^#[0-9a-f]{3}$/i.test(color)) {
        const expanded = color.slice(1).split("").map((value) => value + value).join("");
        return `#${expanded}`;
    }
    return fallback;
}

function formatThemeButtonLabel(rawThemeName, maxChars = 32) {
    const normalized = (rawThemeName || "").replaceAll("_", " ").trim();
    if (normalized.length <= maxChars) return normalized;
    const words = normalized.split(/\s+/);
    const keptWords = [];
    let currentLength = 0;
    for (const word of words) {
        const nextLength = currentLength + (keptWords.length ? 1 : 0) + word.length;
        if (nextLength > maxChars) break;
        keptWords.push(word);
        currentLength = nextLength;
    }
    const visible = keptWords.length > 0
        ? keptWords.join(" ")
        : normalized.slice(0, Math.max(1, maxChars - 3)).trim();
    return `${visible}...`;
}

export async function displayQuestions(themeObject, view) {
    // THIS IS THE ORCHESTRATOR - IT SETS THE STAGE
    // Ensure global themes match the active theme data (needed for color processing + legend)
    themesObject.themes = (themeObject && Array.isArray(themeObject.themes)) ? themeObject.themes : [];
    initializeThemeSelectionForPayload(themeObject || { themes: [] });
    initializeNonVerbalCueControls(() => {
        const activeView = (window.view || view || "question");
        if (activeView === "timeline" || activeView === "question") {
            drawNonVerbalCueLayer();
        } else {
            clearNonVerbalCueLayer();
        }
    });
    setNonVerbalCueControlForView("question");

    const showUploadPrompt = () => {
        if (!d3.select("#popup-overlay").empty()) return;
        d3.select("#settings-page").style("display", "none");
        d3.select("#main-page").style("display", "flex");
        var overlay = d3.select("#main-page").append("div")
            .attr("id", "popup-overlay")
            .style("position", "absolute")
            .style("top", 0)
            .style("left", 0)
            .style("width", "100%")
            .style("height", "100%")
            .style("background", "rgba(240, 240, 240, 0.85)")
            .style("z-index", 100)
            .style("display", "flex")
            .style("align-items", "center")
            .style("justify-content", "center");
        
        var popUpHolder = overlay.append("div").attr("id", "popUpHolder")
            .style("position", "relative")
            .style("background", "#ffffff")
            .style("z-index", 101)
            .style("height", "250px")
            .style("width", "600px")
            .style("display", "flex")
            .style("flex-direction", "column")
            .style("align-items", "center")
            .style("justify-content", "center")
            .style("border-radius", "15px")
            .style("font-family", "Inter")
            .style("font-weight", 700)
            .style("font-size", "28px")
            .style("text-align", "center")
            .style("box-shadow", "0 4px 15px rgba(0, 0, 0, 0.2)");

        popUpHolder.append("div")
            .style("width", "500px")
            .text("Please select transcripts/audio to view the visualizations.");

        popUpHolder.append("button")
            .style("background", "#3A61DD")
            .style("color", "white")
            .style("border", "none")
            .style("padding", "12px 24px")
            .style("border-radius", "8px")
            .style("font-family", "Nunito")
            .style("font-size", "20px")
            .style("cursor", "pointer")
            .style("margin-top", "30px")
            .text("Upload Files")
            .on("click", () => { window.location.href = "/fileManager" });
    };

    let fileMapIsEmpty = true;
    if (window.APP_MODE === 'demo') {
        console.log("QUESTIONS: Running in DEMO mode.");
        try {
            FileMap.participants = await buildDemoFileMap();
            fileMapIsEmpty = FileMap.participants.length === 0;
        } catch (error) {
            console.warn("Falling back to hardcoded demo FileMap due to error:", error);
            FileMap.participants = [
                { participant: 'P3', audio: { relativePath: 'P3_trimmed.m4a' }, transcript: { relativePath: 'P3_Clean_Transcripts_trimmed.txt' }},
                { participant: 'P6', audio: { relativePath: 'P6_trimmed.m4a' }, transcript: { relativePath: 'P6_Clean_Transcripts_trimmed.txt' }},
                { participant: 'P7', audio: { relativePath: 'P7_trimmed.m4a' }, transcript: { relativePath: 'P7_Clean_Transcripts_trimmed.txt' }}
            ];
            fileMapIsEmpty = FileMap.participants.length === 0;
        }
    } else {
        console.log("QUESTIONS: Running in USER mode.");
        // 1. Load the FileMap. This is the SINGLE SOURCE OF TRUTH for who is in the project.
        const projectId = localStorage.getItem("currentProjectId");
        const savedFileMap = await loadCanonicalFileMap(projectId);
        if (savedFileMap) {
            FileMap.participants = savedFileMap.participants || [];
        }
        fileMapIsEmpty = FileMap.participants.length === 0;
    }

    const canRenderFromProcessedData =
        window.APP_MODE !== 'demo' &&
        typeof window.PROCESSED_TRANSCRIPTS_URL === "string" &&
        window.PROCESSED_TRANSCRIPTS_URL.trim() !== "";

    if (fileMapIsEmpty && !canRenderFromProcessedData) {
        console.log("No FileMap found. Showing prompt to upload files.");
        showUploadPrompt();
        return;
    }
    if (fileMapIsEmpty && canRenderFromProcessedData) {
        console.warn("FileMap missing, but processed transcripts exist. Continuing question visualization render.");
    }
    
    if (allQuestionTags) allQuestionTags.length = 0;    
    
    const graphHolder = d3.select("#graph-holder");
    if (graphHolder.empty()) {
        console.error("#graph-holder element not found. Cannot render question view.");
        return;
    }

    // Ensure the SVG exists and clear any previous render
    let graphSvg = graphHolder.select("#graph");
    if (graphSvg.empty()) {
        graphSvg = graphHolder.append("svg").attr("id", "graph");
    }
    graphSvg.html("<text x='50%' y='50%' text-anchor='middle'>Loading and Processing Question Data...</text>");

    const data = await loadTranscripts();
    if (!data || !currentDisplayObject.currentDisplay || currentDisplayObject.currentDisplay.length === 0) {
        graphSvg.html("<text x='50%' y='50%' text-anchor='middle' fill='red'>Error: No data to display.</text>");
        return;
    }
    console.log("1b. Successfully loaded all_transcripts_processed  NOW all_transcripts_processed.json");
    graphSvg.html("");

    console.log("2. After loadTranscripts, currentDisplayObject has", currentDisplayObject.currentDisplay.length, "entries.");
    console.log("   First entry's participant is:", currentDisplayObject.currentDisplay[0]?.participant);

    const participantIds = getRenderableParticipantIds();
    console.log("Derived participantIds for Question View from loaded transcripts:", participantIds);

    graphWidthObject.graphWidth = d3.select("#graph-holder").node().offsetWidth - 99;
    graphAxes(participantIds, 'question');
    const projectHasAudio = projectHasUploadedAudio();
    const initialAudioReady = projectHasAudio && preloadInitialAudioSource(participantIds);
    if (!initialAudioReady) {
        clearPlaybarAudio({
            displaySeconds: 0,
            maxDisplaySeconds: 0,
            reason: projectHasAudio
                ? "Select a transcript segment with audio to enable playback."
                : "This project does not have an audio file."
        });
    }

    void ensureNonVerbalCueData();
    drawVisualization2(currentDisplayObject.currentDisplay); // This DRAWS on the canvas

    // Attach listeners AFTER drawing is complete
    setupEventListeners(view);
    console.log("--- 5. Question View END ---");
}

function setupEventListeners(view) {
    console.log("--- 5. ENTERED SETUPEVENTLISTENER ---");
    var legend = getLegendSelection();
    if (legend.empty()) {
        console.warn("Theme legend container not found for question view.");
        return;
    }
    legend.selectAll("*").remove(); 
    legend.append("button").attr("id", "neutral").attr("class", "theme-labels")
        .style("margin-left", "20px")
        .style("border", "2px solid #eeedef")
        .style("color", "#000000")
        .style("cursor", "pointer")
        .on("click", function() { selectTheme(this, view); }).text("Neutral");
    
    themesObject.themes.forEach((theme, index) => {
        const rawThemeName = String(theme.themeName || "").trim();
        if (!rawThemeName) return;
        const themeId = "theme-btn-" + rawThemeName.toLowerCase().replace(/[^a-z0-9_-]/g, "-") + "-" + index;
        const themeDisplayName = rawThemeName.substring(0,1).toUpperCase() + rawThemeName.substring(1);
        const themeColor = getColorInputValue(theme.color, index);

        const button = legend.append("button")
            .attr("id", themeId).attr("data-theme", rawThemeName).attr("class", "theme-labels")
            .style("border", "2px solid " + themeColor).style("color", themeColor)
            .style("cursor", "pointer")
            .on("click", function() { selectTheme(this, view); })
            .text(formatThemeButtonLabel(themeDisplayName, 32));
        appendThemeColorDot(button, theme, view);

        tippy('#' + themeId, { content: rawThemeName.substring(0,1).toUpperCase() + rawThemeName.substring(1).replaceAll("_", " "), placement: 'bottom', theme: 'blue', trigger: 'mouseenter focus' });
    });

    syncThemeSelectionStyles();

    const zoomSlider = d3.select("#zoom-slider");
    if (!zoomSlider.empty()) { zoomSlider.on("input", function() { semanticZoom(this.value, view); }); }
    
    
    //search
    const searchBtn = document.getElementById('search-btn');
    if (searchBtn) {
        const newSearchBtn = searchBtn.cloneNode(true);
        searchBtn.parentNode.replaceChild(newSearchBtn, searchBtn);
        newSearchBtn.addEventListener('click', () => searchSpeeches(transcriptsObject.transcripts, document.getElementById('searchInput').value, view)); 
    }

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        const newSearchInput = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearchInput, searchInput);
        newSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                searchSpeeches(transcriptsObject.transcripts, newSearchInput.value, view);
            }
        });
    }


    // Demographic Filtering
    const filterBtn = d3.select("#menu-button"); // The filter icon in the tool ribbon
    if (!filterBtn.empty()) {
        // Remove any old click listeners and attach the new one that opens the filter panel.
        filterBtn.on("click", null).on("click", showFilterSettings);
    } else {
        console.warn("Could not find #menu-button to attach filter handler.");
    }
}
