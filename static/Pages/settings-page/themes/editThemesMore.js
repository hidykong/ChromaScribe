import { pauseSelectedThemeProgress, resumeSelectedThemeProgress } from "./makeWordClouds.js?v=20260921a";
import { scopeAppPath } from "../../pageTransitionOverlay.js";
import { themeObject, themesObject, tempThemesObject, selectedThemeBoxObject, multiSelectedWordsObject } from "../../../chromascribe-main.js";
import {
  buildThemeExcerptEntry,
  buildThemeWordIdentityKey,
  colorToRgba,
  dedupeThemeWordEntries,
  getThemesStorageKey,
  isManualExcerptEffectivelySelected,
  isManualThemeWordEntry,
  normalizeManualSelectionOptOuts,
  normalizeThemeWordText,
  persistThemePayloadLocally,
  resolveThemeWordParticipantLabel
} from "../../themePersistence.js?v=20260901b";
import {
  hideVisualizationLoadingOverlay,
  navigateToVisualizationWithOverlay,
  showVisualizationLoadingOverlay
} from "./visualizationLoadingOverlay.js?v=20260901a";


// export function editThemesMore() {
// 	selectedThemeBoxObject.selectedThemeBox = themesObject.themes[0].themeName;
//     var mainEditWindow = d3.select("#main-edit-window");
// 	mainEditWindow.selectAll("*").remove();
// 	mainEditWindow.append("div")
//         .attr("id", "themeList")
// 		.style("width", "94%")
// 		.style("height", "85%")
// 		.style("margin-top", "30px")
// 		.style("overflow", "scroll")
// 		.style("align-items", "normal");

// 	console.log(themesObject)
// 	makeThemeBoxes(170, "100%");
// 	d3.json("../../static/stemDict.json", function(data){
// 		var foundArray = false;
// 		for (var i = 0; i<themesObject.themes.length; i++){
// 			for (var j = 0; j<themesObject.themes[i].words.length; j++){
// 				foundArray = false;
// 				for (var key in data){
// 					if (key === themesObject.themes[i].words[j].word){
// 						foundArray = true;
// 						themesObject.themes[i].words[j].stemmedWords = data[key];
// 					}
// 				}
// 				if (!foundArray)
// 					themesObject.themes[i].words[j].stemmedWords = [];
// 			}
// 		}
// 	});
// }

export function editThemesMore() {
  const projectId = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
  const themesKey = getThemesStorageKey(projectId);
  const projectParam = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const withProjectPayload = (payload) => projectId ? { ...payload, projectId } : payload;
  // Check if user just came from card selection (words populated by makeWordClouds)
  const hasLiveSelections = themesObject.themes.some(t => t.words && t.words.length > 0);

  if (!hasLiveSelections) {
      try {
        const storedRaw = localStorage.getItem(themesKey);
        if (storedRaw) {
          const storedThemes = JSON.parse(storedRaw);
          if (storedThemes && Array.isArray(storedThemes.themes) && storedThemes.themes.length > 0) {
          // Only restore theme names and colors, NOT words
            storedThemes.themes.forEach(stored => {
              const live = themesObject.themes.find(
                t => t.themeName.trim().toLowerCase() === stored.themeName.trim().toLowerCase()
              );
              if (live) {
                live.color = stored.color;
                // words stay empty — they come from current multiSelectedWordsObject
                // Only restore words if live.words is empty (first visit, not a reselection)
                if (live.words.length === 0 && Array.isArray(stored.words)) {
                  live.words = structuredClone(stored.words);
                }
              }
            });
          }
        }
      }catch (e) {
        console.warn("Failed to load stored themes:", e);
      }
    } else {
      // Live selections exist from card clicks — only restore colors, keep live words
      try {
        const storedRaw = localStorage.getItem(themesKey);
        if (storedRaw) {
          const storedThemes = JSON.parse(storedRaw);
          if (storedThemes && Array.isArray(storedThemes.themes)) {
            storedThemes.themes.forEach(stored => {
              const live = themesObject.themes.find(
                t => t.themeName.trim().toLowerCase() === stored.themeName.trim().toLowerCase()
              );
              if (live) {
                live.color = stored.color; // color only, never touch words
              }
            });
          }
        }
      } catch (e) {
        console.warn("Failed to load stored themes:", e);
      }
  }
  sanitizeThemesForDisplay();
  persistThemeSnapshot(themesKey);

  // Clear main edit window
  const mainEditWindow = d3.select("#main-edit-window");
  mainEditWindow.selectAll("*").remove();
   mainEditWindow
    .style("overflow", "hidden");

  // Append theme list container
  const themeList = mainEditWindow.append("div")
    .attr("id", "themeList")
    .style("width", "90%")
    .style("height", "100%")
    .style("margin-top", "30px")
    .style("overflow", "auto")
    .style("padding-bottom", "80px")
    .style("align-items", "normal")
    .style("position", "relative");  // important for absolute buttons inside


  // Prepare normalized first theme id and set selectedThemeBox
  const firstThemeId = themesObject.themes.length > 0 
    ? themesObject.themes[0].themeName.toLowerCase().replace(/\s+/g, "_").replace(/[^\w\-]/g, "") 
    : "";
  selectedThemeBoxObject.selectedThemeBox = firstThemeId;

  //const boxHeight = "200px";  // example fixed height
  //const boxWidth = "100%";    // full width horizontal
  const boxWidth = "100%";

  themesObject.themes.forEach((themeObj, i) => {
    const themeNameId = themeObj.themeName.toLowerCase().replace(/\s+/g, "_").replace(/[^\w\-]/g, "");
    const themeColor = themeObj.color;

    // Theme box container
    const themeBox = themeList.append("div")
      .attr("class", "sections")
      .attr("id", "themeBox_" + themeNameId)
      .style("min-height", "120px")
      .style("height", "auto")
      .style("width", boxWidth)
      .style("display", "flex")
      .style("flex-direction", "row")
      .style("background-color", "#fafafa")
      .style("align-items", "stretch") // stretch children vertically
      .style("padding", "0")  // remove vertical padding to let color bar fill
      .style("margin-bottom", "20px")
      .style("box-shadow", "0 2px 5px rgba(0,0,0,0.1)")
      .style("cursor", "pointer")
      .on("click", function () {
        d3.selectAll(".themeColors").style("opacity", 0.3);
        d3.select(this).select(".themeColors").style("opacity", 1);
        selectedThemeBoxObject.selectedThemeBox = this.id.substring(9);
        d3.select("#wordCloudShape").selectAll("*").remove();
      });

    // Left color bar for theme
    themeBox.append("div")
      .attr("class", "themeColors")
      .style("width", "20px")     // thicker bar
      .style("align-self", "stretch")  // full height of themeBox (since align-items: stretch)
      .style("background-color", themeColor)
      .style("border-radius", "3px 0 0 3px")  // rounded left edges only
      .style("margin-right", "20px")
      .style("opacity", i === 0 ? 1 : 0.3);

    // Container for theme title and words
    const themeContent = themeBox.append("div")
      .style("flex", "1")
      .style("display", "flex")
      .style("flex-direction", "column")
      .style("text-align", "left")
      .style("padding-left", "0px")      // no padding left
      .style("margin-left", "0px");      // no margin left

    // Theme title inside themeContent
    themeContent.append("h3")
      .text(themeObj.themeName.trim())
      .style("margin", "20px 0 10px 0")
      .style("font-size", "20px")
      .style("color", "#333");

    // Word container: flex wrap for word cards horizontally
    const wordContainer = themeContent.append("div")
      .attr("class", "word-container")
      .style("display", "flex")
      .style("flex-wrap", "wrap")
      .style("gap", "15px")
      .style("justify-content", "flex-start")  // explicitly left align items in container
      .style("align-items", "flex-start")     // align items to the top of container row
      .style("padding", "0")                   // remove default padding if any
      .style("margin", "0");                   // remove default margin if any

    // Word cards with single-line truncation, left aligned text
    themeObj.words.forEach((wordText, wordIndex) => {
      const participantLabel = resolveThemeWordParticipantLabel(wordText);
      const wordCardBackground = colorToRgba(themeColor, 0.14);
      const wordCardBorder = colorToRgba(themeColor, 0.38);
      const wordCard = wordContainer.append("div")
        .attr("class", "word-card")
        .style("width", "280px")
        .style("min-height", participantLabel ? "76px" : "60px")
        .style("position", "relative")
        .style("border-radius", "5px")
        .style("box-sizing", "border-box")
        .style("display", "flex")
        .style("justify-content", "left")
        .style("align-items", "flex-start")
        .style("cursor", "pointer")
        .style("padding", participantLabel ? "10px 10px 28px 10px" : "10px")
        .style("font-size", "20px")
        .style("background-color", wordCardBackground)
        .style("border", `1px solid ${wordCardBorder}`)
        .style("border-left", `6px solid ${themeColor}`)
        .style("overflow", "hidden")
        .style("text-align", "center");

      // Quote text
      wordCard.append("div")
        .style("display", "-webkit-box")
        .style("-webkit-line-clamp", "1")
        .style("-webkit-box-orient", "vertical")
        .style("overflow", "hidden")
        .style("text-overflow", "ellipsis")
        .style("white-space", "nowrap")
        .style("flex", "1")
        .style("font-size", "14px")
        .text(wordText.word);

      if (participantLabel) {
        wordCard.append("div")
          .style("position", "absolute")
          .style("left", "10px")
          .style("bottom", "8px")
          .style("padding", "2px 8px")
          .style("border-radius", "999px")
          .style("background", "#eef2ff")
          .style("color", "#2643b6")
          .style("font-family", "Inter")
          .style("font-size", "11px")
          .style("font-weight", "700")
          .text(participantLabel);
      }

      // Delete button — shows on hover
    const deleteBtn = wordCard.append("button")
        .style("position", "absolute")
        .style("top", "4px")
        .style("right", "4px")
        .style("width", "14px")
        .style("height", "14px")
        .style("border-radius", "50%")
        .style("background", "#ffa3a3")
        .style("color", "#fff")
        .style("font-size", "8px")
        .style("display", "flex")   
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("cursor", "pointer")
        .style("border", "none")
        .style("line-height", "1")
        .text("x");

      deleteBtn.on("click", async function() {
        d3.event.stopPropagation();

     // 1. Remove from memory using excerpt identity so identical text from
     // different participants stays distinct.
    const currentIndex = themeObj.words.findIndex(w => buildThemeWordIdentityKey(w) === buildThemeWordIdentityKey(wordText));
    if (currentIndex !== -1) {
        themeObj.words.splice(currentIndex, 1);
    }
    // 2. Load existing deleted quotes
    let deletedQuotes = [];
    try {
        const res = await fetch(`/api/load_deleted_quotes${projectParam}`);
        if (res.ok) {
            const existing = await res.json();
            deletedQuotes = existing.deletedQuotes || [];
        }
    } catch(e) {}
    // 3. Add to deleted quotes archive
    const deletedQuoteRecord = buildDeletedQuoteRecord(themeObj.themeName, wordText);
    const deletedQuoteKey = buildThemeWordIdentityKey(deletedQuoteRecord);
    const hasArchivedRecord = deletedQuotes.some((entry) => {
        if (hasDeletedQuoteContext(entry)) {
            return buildThemeWordIdentityKey(entry) === deletedQuoteKey
                && String(entry.themeName || "").trim().toLowerCase() === themeObj.themeName.trim().toLowerCase();
        }
        return String(entry.themeName || "").trim().toLowerCase() === themeObj.themeName.trim().toLowerCase()
            && normalizeWordText(entry.word) === normalizeWordText(wordText.word);
    });
    if (!hasArchivedRecord) {
        deletedQuotes.push(deletedQuoteRecord);
    }

    // 4. Save to deletedQuotes.json
    try {
        await fetch('/api/save_deleted_quotes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withProjectPayload({ deletedQuotes }))
        });
    } catch(e) { console.warn("Could not save deleted quotes:", e); }
     // 5. Save updated SelectedThemes.json (without the deleted quote)
    try {
        await fetch('/api/save_selected_themes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withProjectPayload({
              ...buildSelectedThemesPayload(),
              manualDeletionIntent: { words: [deletedQuoteRecord] }
            }))
        });
    } catch(e) {}
    // 6. Clear stale localStorage snapshot so rerender uses live themesObject
    try {
        const projectId = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
        const themesKey = getThemesStorageKey(projectId);
        localStorage.setItem(themesKey, JSON.stringify(themesObject));
    } catch(e) {}

    // 7. Rerender
    editThemesMore();
    });
}); 

    // "+ Add Word" card left aligned text
    wordContainer.append("div")
      .attr("class", "add-word-card")
      .style("border-radius", "5px")
      .style("background", "#4e4e4e")
      .style("margin", "10px")
      .style("height", "35px")
      .style("padding", "10px")
      .style("width", "35px")
      .style("font-size", "20px")
      .style("color", "#ffffff")
      .style("flex-direction", "column")
      .style("justify-content", "center")
      .style("align-content", "center")
      .text("+")
      .on("click", function (event) {
        d3.event.stopPropagation(); // prevent triggering themeBox click
        const newWord = prompt("Enter a custom word or phrase:");
        if (newWord && newWord.trim()) {
          const newWordText = normalizeWordText(newWord);
          const hasDuplicate = Array.isArray(themeObj.words) && themeObj.words.some(
            (entry) => buildThemeWordIdentityKey(entry) === buildThemeWordIdentityKey({ word: newWordText })
          );
          if (hasDuplicate) return;
          themeObj.words.push(buildThemeExcerptEntry({
            word: newWordText,
            value: 1,
            stemmedWords: [],
            selectedByUser: true,
            selectedInMatching: true,
            matchingSelection: true,
            selectionSource: "matching_excerpts",
            selectionStage: "matching_excerpts_selected",
            codeSource: "manual",
            source: "manual",
            ai_generated: false,
            aiTagged: false,
            humanTagged: true
          }));
          themeObj.words = dedupeWords(themeObj.words);
          try {
            localStorage.setItem(themesKey, JSON.stringify(themesObject));
          } catch (e) {
            console.warn("Failed to save theme changes:", e);
          }
	          fetch('/api/save_selected_themes', {
	            method: 'POST',
	            headers: { 'Content-Type': 'application/json' },
	            body: JSON.stringify(withProjectPayload(buildSelectedThemesPayload()))
	        }).catch(e => console.warn("Could not save added word:", e));
          editThemesMore(); // rerender after adding word
        }
      });
  });

  // Add "Back" button
  var viewWordClouds = mainEditWindow.append("button")
    .style("position", "absolute")
    .style("border-radius", "10px")
    .style("background", "#ececf0")
    .style("bottom", "20px")
    .style("left", "20px")
    .style("padding", "12px 20px 12px 20px")
    .style("font-family", "Inter")
    .style("font-size", "16px")
    .style("font-weight", 700)
    .text("Back")
    .on("click", function () {
      fetch('/themes/edit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
	        body: JSON.stringify(withProjectPayload(themesObject)),
      })
        .then(response => {
          if (response.ok) {
            window.location.href = '/themes/edit';
          } else {
            console.error('Failed to send data', response.statusText);
          }
        })
        .catch(error => {
          console.error('Error:', error);
        });
    });

  // Add "Apply Themes" button
  var applyThemesButton = mainEditWindow.append("button")
    .style("position", "absolute")
    .style("right", "20px")
    .style("bottom", "20px")
    .style("text-align", "center")
    .style("width", "170px")
    .style("height", "48px")
    .style("border-radius", "10px")
    .style("background", "#000000")
    .style("color", "#ffffff")
    .style("padding", "6px 0px 6px 0px")
    .style("font-family", "Inter")
    .style("font-size", "16px")
    .style("font-weight", 700)
    .text("Apply Codes")
    .on("click", function () {
      void saveSelectedThemesAndContinue(this);
    });

  startThemeAutosave(themesKey);
}

let visualizationSaveInFlight = false;

function showMatchingSaveError(message) {
  d3.select("#min_theme_error_message").remove();
  d3.select("#main-edit-window").append("div")
    .attr("id", "min_theme_error_message")
    .attr("role", "alert")
    .attr("class", "matching-save-error")
    .text(message);
}

export async function saveSelectedThemesAndContinue(button) {
  if (visualizationSaveInFlight) return;
  d3.select("#min_theme_error_message").remove();
  const selectedPayload = buildSelectedThemesPayload();
  const hasExcerpts = selectedPayload.themes.some(theme => theme.words.length > 0);
  if (!hasExcerpts) {
    showMatchingSaveError("Select at least one excerpt before continuing.");
    return;
  }

  const projectId = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
  const payload = { ...selectedPayload, projectId };
  visualizationSaveInFlight = true;
  button.disabled = true;
  showVisualizationLoadingOverlay();
  try {
    await pauseSelectedThemeProgress();
    const progress = window.ChromaProjectProgress;
    const saveChange = () => applySelectedThemesToVisualization(payload);
    const result = typeof progress?.runProjectChange === "function"
      ? await progress.runProjectChange(projectId, saveChange)
      : await saveChange();
    if (result.handoffError) {
      throw result.handoffError;
    }
    await navigateToVisualizationWithOverlay("Applying selected codes");
  } catch (error) {
    resumeSelectedThemeProgress();
    hideVisualizationLoadingOverlay();
    showMatchingSaveError(error.message || "Could not open Visualization. Please try again.");
    console.error("Failed to open visualization:", error);
  } finally {
    visualizationSaveInFlight = false;
    button.disabled = false;
  }
}

async function applySelectedThemesToVisualization(payload) {
  const progress = window.ChromaProjectProgress;
  const revision = progress?.revisionAfterBrowserSaves?.(payload.projectId, themesObject.projectRevision)
    ?? themesObject.projectRevision;
  if (Number.isInteger(revision)) {
    payload.projectRevision = revision;
  }
  const saved = await postSelectedThemes("/api/save_selected_themes", payload);
  rememberSavedThemePayload(payload, saved);
  try {
    const applied = await postSelectedThemes("/visualization", payload);
    rememberSavedThemePayload(payload, applied);
    return { projectRevision: payload.projectRevision };
  } catch (handoffError) {
    // The selection is already saved. Let the coordinator record that revision
    // before showing the handoff error so autosave and a retry remain current.
    return { projectRevision: payload.projectRevision, handoffError };
  }
}

function rememberSavedThemePayload(payload, result) {
  if (Number.isInteger(result.projectRevision)) {
    payload.projectRevision = result.projectRevision;
  }
  Object.assign(themesObject, payload);
  persistThemePayloadLocally(payload);
}

async function postSelectedThemes(path, payload) {
  const response = await fetch(scopeAppPath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (response.ok && !response.redirected) return result;
  throw new Error(result.error || "Could not save your selection. Please try again.");
}

function buildSelectedThemesPayload() {
  const normalizeThemeNameKey = (themeName) => String(themeName || "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const themeNamesMatch = (left, right) => {
    const leftKey = normalizeThemeNameKey(left);
    const rightKey = normalizeThemeNameKey(right);
    if (!leftKey || !rightKey) return false;
    return leftKey === rightKey || leftKey.replace(/\s+/g, "") === rightKey.replace(/\s+/g, "");
  };

  const getWordSourceFlags = (word) => {
    const source = String(word && (word.codeSource || word.source || word.tagSource) || "").trim().toLowerCase();
    const hasHuman = source === "manual"
      || source === "human"
      || source === "human_ai"
      || source === "human+ai"
      || source === "both"
      || word?.humanTagged === true
      || word?.human_tagged === true
      || word?.ai_generated === false;
    const hasAi = source === "ai"
      || source === "llm"
      || source === "cloud"
      || source === "human_ai"
      || source === "human+ai"
      || source === "both"
      || word?.aiTagged === true
      || word?.ai_tagged === true
      || word?.ai_generated === true
      || !hasHuman;

    return { hasHuman, hasAi };
  };

  const mergeThemeSelectedWords = (theme) => {
    const themeWords = Array.isArray(theme && theme.words) ? theme.words : [];
    const markedThemeWords = themeWords.filter(word => (
      isManualThemeWordEntry(word)
        ? isManualExcerptEffectivelySelected(themesObject, theme && theme.themeName, word)
        : isExplicitMatchingSelection(word)
    ));
    const progressWords = Array.isArray(multiSelectedWordsObject && multiSelectedWordsObject.selectedWords)
      ? multiSelectedWordsObject.selectedWords.filter(
          selection => themeNamesMatch(selection && selection.themeName, theme && theme.themeName)
        )
      : [];
    return dedupeThemeWordEntries([...markedThemeWords, ...progressWords]);
  };

  const isExplicitMatchingSelection = (word) => {
    return Boolean(
      word
      && typeof word === "object"
      && (
        word.selectedInMatching === true
        || word.matchingSelection === true
        || word.selectionStage === "matching_excerpts_selected"
        || (word.selectedByUser === true && word.selectionSource === "matching_excerpts")
      )
    );
  };

  const isLikelyCodeLabelText = (value) => {
    const text = String(value || "").trim();
    if (!text) return true;
    if (/^[cq]\d+[a-z]?$/i.test(text)) return true;
    if (/^code\s*\d*$/i.test(text)) return true;
    return false;
  };

  const hasExcerptContext = (word) => {
    if (!word || typeof word !== "object") return false;
    return Boolean(word.participant || word.tag || word.timestamp || word.cueText || word.speaker);
  };

  const isMeaningfulSelectedExcerpt = (word, theme) => {
    const entry = buildThemeExcerptEntry(word);
    if (!entry) return false;
    if (themeNamesMatch(entry.word, theme && theme.themeName)) return false;
    if (isLikelyCodeLabelText(entry.word) && !hasExcerptContext(entry)) return false;
    return true;
  };

  const filterSummaryWords = (theme) => {
    const summary = normalizeThemeWordText(theme && theme.summary || "").toLowerCase();
    const words = Array.isArray(theme && theme.words) ? theme.words : [];
    if (!summary) return words;
    return words.filter((word) => {
      const entry = buildThemeExcerptEntry(word);
      return !entry || normalizeThemeWordText(entry.word).toLowerCase() !== summary;
    });
  };

  return {
    selectionSource: "matching_excerpts",
    selectionStage: "applied_codes",
    appliedToVisualization: true,
    appliedAt: new Date().toISOString(),
    manualSelectionOptOuts: normalizeManualSelectionOptOuts(themesObject),
    themes: themesObject.themes.map(t => {
      const selectedWords = filterSummaryWords({
        ...t,
        words: mergeThemeSelectedWords(t)
      })
        .filter((word) => isMeaningfulSelectedExcerpt(word, t))
        .map((word) => {
          const entry = buildThemeExcerptEntry(word);
          if (!entry) return null;
          const { hasHuman, hasAi } = getWordSourceFlags(entry);
          const codeSource = hasHuman && hasAi ? "human_ai" : hasHuman ? "manual" : "ai";
          return buildThemeExcerptEntry(entry, {
            selectedByUser: true,
            selectedInMatching: true,
            matchingSelection: true,
            selectionSource: "matching_excerpts",
            selectionStage: "matching_excerpts_selected",
            codeSource,
            source: codeSource,
            ai_generated: hasAi,
            aiTagged: hasAi,
            humanTagged: hasHuman
          });
        })
        .filter(Boolean);

      return {
        themeName: t.themeName,
        color: t.color,
        summary: String(t.summary || ""),
        selectedByUser: true,
        selectionSource: "matching_excerpts",
        words: dedupeThemeWordEntries(selectedWords),
        highlight: Array.isArray(t.highlight) ? t.highlight : [],
        groups: Array.isArray(t.groups) ? t.groups : [],
        comment: String(t.comment || ""),
        ...(t?.codeSource ? { codeSource: t.codeSource } : {}),
        ...(t?.source ? { source: t.source } : {}),
        ...(t?.ai_generated === false ? { ai_generated: false } : {}),
        ...(t?.humanTagged === true ? { humanTagged: true } : {}),
        ...(t?.human_tagged === true ? { human_tagged: true } : {})
      };
    })
  };
}

function startThemeAutosave(themesKey) {
  if (window.__themesAutosaveInterval) {
    clearInterval(window.__themesAutosaveInterval);
  }
  window.__themesAutosaveInterval = setInterval(() => {
    persistThemeSnapshot(themesKey);
  }, 2000);
}

function persistThemeSnapshot(themesKey) {
  try {
    sanitizeThemesForDisplay();
    localStorage.setItem(themesKey, JSON.stringify(themesObject));
  } catch (e) {
    console.warn("Failed to auto-save themes:", e);
  }
}

function normalizeWordText(wordEntry) {
  return normalizeThemeWordText(
    typeof wordEntry === "string"
      ? wordEntry
      : (wordEntry && typeof wordEntry === "object" ? wordEntry.word : "")
  );
}

function normalizeThemeNameKeyForDisplay(themeName) {
  return String(themeName || "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function displayThemeNamesMatch(left, right) {
  const leftKey = normalizeThemeNameKeyForDisplay(left);
  const rightKey = normalizeThemeNameKeyForDisplay(right);
  if (!leftKey || !rightKey) return false;
  return leftKey === rightKey || leftKey.replace(/\s+/g, "") === rightKey.replace(/\s+/g, "");
}

function isLikelyCodeLabelTextForDisplay(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (/^[cq]\d+[a-z]?$/i.test(text)) return true;
  if (/^code\s*\d*$/i.test(text)) return true;
  return false;
}

function hasExcerptContextForDisplay(word) {
  if (!word || typeof word !== "object") return false;
  return Boolean(word.participant || word.tag || word.timestamp || word.cueText || word.speaker);
}

function isMeaningfulThemeWordForDisplay(word, theme) {
  const entry = buildThemeExcerptEntry(word);
  if (!entry) return false;
  if (displayThemeNamesMatch(entry.word, theme && theme.themeName)) return false;
  if (isLikelyCodeLabelTextForDisplay(entry.word) && !hasExcerptContextForDisplay(entry)) return false;
  return true;
}

function isExplicitMatchingSelectionForDisplay(word) {
  return Boolean(
    word
    && typeof word === "object"
    && (
      word.selectedInMatching === true
      || word.matchingSelection === true
      || word.selectionStage === "matching_excerpts_selected"
      || (word.selectedByUser === true && word.selectionSource === "matching_excerpts")
    )
  );
}

function dedupeWords(words, theme) {
  return dedupeThemeWordEntries(words)
    .filter((word) => (
      (isManualThemeWordEntry(word)
        ? isManualExcerptEffectivelySelected(themesObject, theme && theme.themeName, word)
        : isExplicitMatchingSelectionForDisplay(word))
      && isMeaningfulThemeWordForDisplay(word, theme)
    ));
}

function hasDeletedQuoteContext(entry) {
  return Boolean(entry && typeof entry === "object" && (entry.participant || entry.tag || entry.timestamp || entry.cueText));
}

function buildDeletedQuoteRecord(themeName, wordEntry) {
  const entry = buildThemeExcerptEntry(wordEntry);
  return {
    themeName,
    word: entry ? entry.word : normalizeWordText(wordEntry),
    participant: entry && entry.participant ? entry.participant : "",
    tag: entry && entry.tag ? entry.tag : "",
    timestamp: entry && entry.timestamp ? entry.timestamp : "",
    cueText: entry && entry.cueText ? entry.cueText : "",
    deletedAt: new Date().toISOString()
  };
}

function sanitizeThemesForDisplay() {
  if (!themesObject || !Array.isArray(themesObject.themes)) return;
  themesObject.themes.forEach((theme) => {
    if (!theme || typeof theme !== "object") return;
    theme.words = dedupeWords(theme.words, theme);
  });
}
