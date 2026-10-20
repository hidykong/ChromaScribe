import { demographicsObject as globalDemographicsSettings } from "../../../chromascribe-main.js";
import {
    getStoredFileMap,
    hydrateFileMapFromServer
} from "../../fileMapSync.js?v=20260601b";

let currentDemographicsData = {}; // To hold {"P1": {field: value, ...}, "P2": ...}
let currentParticipantList = []; // Array of participant names, e.g., ["P1", "P2"]
let gridApi_demographics; 
let debounceTimer; // NEW: Timer for auto-save
let demographicsDataKey = "demographicsData";
let demographicsFilenameKey = "lastSavedDemographicsFilename";
let saveStatusEl = null;

function markUsageStep(stepName, details = {}) {
    const payload = { stepName, ...details };
    window.__pendingChromaUsageStep = payload;
    if (window.ChromaUsageLogger && typeof window.ChromaUsageLogger.setStep === "function") {
        window.ChromaUsageLogger.setStep(stepName, payload);
    }
}

function setAutoSaveStatus(text, tone = "neutral") {
    if (!saveStatusEl || saveStatusEl.empty()) return;

    const styles = {
        neutral: { color: "#475467", bg: "#F2F4F7", border: "#D0D5DD" },
        saving: { color: "#B54708", bg: "#FFFAEB", border: "#FEC84B" },
        success: { color: "#067647", bg: "#ECFDF3", border: "#A6F4C5" },
        error: { color: "#B42318", bg: "#FEF3F2", border: "#FDA29B" },
    };
    const picked = styles[tone] || styles.neutral;

    saveStatusEl
        .text(text)
        .style("color", picked.color)
        .style("background-color", picked.bg)
        .style("border", `1px solid ${picked.border}`);
}

function isValidDemographicsConfig(config) {
    return !!config && Array.isArray(config.options) && Array.isArray(config.chosenFields);
}

function updateTextFieldOptions(params, demographicsConfig, configStorageKey) {
    const fieldName = params.colDef?.field;
    if (!fieldName || fieldName === "Participant") {
        return;
    }
    const fieldConfig = (demographicsConfig.options || []).find(option => option.field === fieldName);
    if (!fieldConfig || fieldConfig.type !== "Text") {
        return;
    }
    const newValue = params.newValue;
    if (newValue === undefined || newValue === null || String(newValue).trim() === "") {
        return;
    }

    const trimmedValue = String(newValue).trim();
    if (!fieldConfig.values) {
        fieldConfig.values = [];
    }
    if (fieldConfig.values.includes(trimmedValue)) {
        return;
    }
    fieldConfig.values.push(trimmedValue);
    localStorage.setItem(configStorageKey, JSON.stringify(demographicsConfig));

    const columnDefinitions = gridApi_demographics.getColumnDefs();
    const editedColumn = columnDefinitions.find(column => column.field === fieldName);
    if (!editedColumn) {
        return;
    }
    editedColumn.cellEditor = OneClickSelectEditor;
    editedColumn.cellEditorParams = { values: ["", ...fieldConfig.values] };
    gridApi_demographics.setGridOption('columnDefs', columnDefinitions);
}

function handleDemographicsCellChange(params, demographicsConfig, configStorageKey) {
    console.log("Cell value changed, starting auto-save timer...");
    updateTextFieldOptions(params, demographicsConfig, configStorageKey);
    setAutoSaveStatus("Auto-saving changes...", "saving");
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        saveData(false);
    }, 1500);
}

export async function demographicsManager(demographicsObjectFromFlask) {
    markUsageStep("Manage participant demographics", {
        stepKey: "demographics_manager",
        workflow: "qda_contextual_filtering",
    });
    console.log("Demographics Manager Page: Retrieved demographicsObjectFromFlask:", demographicsObjectFromFlask);
    // console.log("Demographics Manager Init. Chosen Fields:", demographicsObjectFromFlask.chosenFields);
    // console.log("DEMO MGR: demographicsObjectFromFlask at start of rowData prep:", JSON.parse(JSON.stringify(demographicsObjectFromFlask)));
    
    const gridDiv = document.querySelector("#demographics-grid");
    if (!gridDiv) { console.error("AG Grid container #demographics-grid not found!"); return; }

    // Ensure the immediate parent also participates in flex (some templates wrap the grid)
    const gridParent = gridDiv.parentElement;
    if (gridParent) {
    Object.assign(gridParent.style, {
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: "0",
    });
    }

    //const projectId = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
    //const workspaceKey = window.USER_WORKSPACE_KEY || localStorage.getItem("currentWorkspaceKey") || "";
    //const projectStorageScope = projectId && workspaceKey ? `${workspaceKey}__${projectId}` : projectId;
    //demographicsDataKey = projectStorageScope ? `demographicsData_${projectStorageScope}` : "demographicsData";
    //demographicsFilenameKey = projectStorageScope ? `lastSavedDemographicsFilename_${projectStorageScope}` : "lastSavedDemographicsFilename";
    //const demographicsConfigKey = projectStorageScope ? `demographicsObject_${projectStorageScope}` : "demographicsObject";
    const projectId = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
    demographicsDataKey = projectId ? `demographicsData_${projectId}` : "demographicsData";
    demographicsFilenameKey = projectId ? `lastSavedDemographicsFilename_${projectId}` : "lastSavedDemographicsFilename";
    const demographicsConfigKey = projectId ? `demographicsObject_${projectId}` : "demographicsObject";
    // Prefer latest autosaved demographics definitions from localStorage.
    try {
        const localConfigRaw = localStorage.getItem(demographicsConfigKey);
        if (localConfigRaw) {
            const localConfig = JSON.parse(localConfigRaw);
            if (isValidDemographicsConfig(localConfig)) {
                demographicsObjectFromFlask = localConfig;
                console.log("DEMO MGR: Loaded demographics definitions from localStorage draft.");
            }
        } else if (isValidDemographicsConfig(demographicsObjectFromFlask)) {
            localStorage.setItem(demographicsConfigKey, JSON.stringify(demographicsObjectFromFlask));
        }
    } catch (e) {
        console.warn("DEMO MGR: Failed to parse demographicsObject draft from localStorage:", e);
    }

    // Page root: full-height column
    const demographicsWindowEl = document.querySelector("#attributes-window");
    if (demographicsWindowEl) {
    Object.assign(demographicsWindowEl.style, {
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        minHeight: "100vh",
        alignItems: "stretch",
    });
    }

    // The grid: fill remaining space; give it an explicit height
    Object.assign(gridDiv.style, {
    flex: "1 1 auto",
    minHeight: "0",
    height: "100%",       // important for AG Grid with domLayout:'normal'
    overflowY: "auto",
    overflowX: "hidden",
    });

    
    // --- HARD RESET of the page section to avoid duplicates ---
    // 1) Remove any summary table that editAttributes.js might have left behind
    d3.select(".attr-wrapper").selectAll("table.table").remove();
    // 2) Remove *all* old bottom bars (not just the first one)
    d3.select("#attributes-window").selectAll(".bottom-frame").remove();
    // 3) If a grid already exists in this container, destroy it and clear the DOM
    if (gridApi_demographics && typeof gridApi_demographics.destroy === "function") {
        try { gridApi_demographics.destroy(); } catch (e) { console.warn("Could not destroy previous grid:", e); }
        gridApi_demographics = null;
    }
    gridDiv.innerHTML = ""; // ensure the container is empty before creating a new grid

    // 1. Determine the list of Participants for the current project
    // This should come from the state set by uploadFiles -> syncAudiosToTranscripts (FileMap)
    // Let's assume FileMap is stored in localStorage by syncAudiosToTranscripts
    currentParticipantList = [];
    
    if (window.APP_MODE === 'demo') {
        console.log("DEMO MGR: Demo mode detected. Using hardcoded participant list.");
        // In DEMO mode, we use a predefined, hardcoded list of participants.
        currentParticipantList = ['P3', 'P6', 'P7'].sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
    } else {
        console.log("DEMO MGR: User mode detected. Loading participants from localStorage.");
        const projectId = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
        await hydrateFileMapFromServer(projectId);
        const workspaceKey = window.USER_WORKSPACE_KEY || localStorage.getItem("currentWorkspaceKey") || "";
        const storageScope = projectId && workspaceKey ? `${workspaceKey}__${projectId}` : projectId;
        const demoKey = storageScope ? `FileMap_ForDemographics_${storageScope}` : 'FileMap_ForDemographics';
        const storedFileMapString = localStorage.getItem(demoKey);
        if (storedFileMapString) {
            try {
                const storedParticipantData = JSON.parse(storedFileMapString);
                if (storedParticipantData && Array.isArray(storedParticipantData)) {
                    currentParticipantList = storedParticipantData.map(p_data => p_data.participant) // Correctly maps to names
                                            .sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
                    console.log("DEMO MGR: Participants from FileMap_ForDemographics:", currentParticipantList);
                } else {
                    console.warn("DEMO MGR: Data from localStorage 'FileMap_ForDemographics' is not an array or is null.");
                }
            } catch (e) {
                console.error("DEMO MGR: Error parsing participant data from localStorage 'FileMap_ForDemographics':", e);
            }
        }
        if (currentParticipantList.length === 0) {
            const storedFileMap = getStoredFileMap(projectId);
            if (Array.isArray(storedFileMap?.participants)) {
                currentParticipantList = storedFileMap.participants
                    .map(participant => String(participant?.participant || "").trim())
                    .filter(Boolean)
                    .sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
            }
        }
    }
    
    if (currentParticipantList.length === 0) {
        console.warn("DEMO MGR: No participants found from previous steps (FileMap_ForDemographics). Demographics grid will be empty initially or rely on loaded CSV/manual additions.");
    }
    console.log("DEMO MGR: Participants for Grid:", currentParticipantList);

    // 2. Define AG Grid Columns based on demographicsObjectFromFlask.chosenFields
    const columnDefs = [{ field: "Participant", editable: false, pinned: 'left', lockPinned: true, cellClass: 'lock-pinned', width: 150 }];
    (demographicsObjectFromFlask.chosenFields || []).forEach(fieldName => {
        const fieldConfig = (demographicsObjectFromFlask.options || []).find(opt => opt.field === fieldName);
        
        let colDef = {
            field: fieldName,
            headerName: camelCaseToTitleCase(fieldName),
            editable: true,
            singleClickEdit: true, // Enable single-click editing for this column
            width: 180,
            cellEditor: 'agTextCellEditor', // Use simple text editor instead of large text editor
            cellEditorParams: {} // No popup for simple text editor
        };

        if (fieldConfig) {
            if (fieldConfig.type === "Text" && fieldConfig.values && fieldConfig.values.length > 0) {
                console.log(`  DEMO MGR: Col '${fieldName}' is Text with values. Setting one-click select editor.`);
                colDef.cellEditor = OneClickSelectEditor;
                colDef.cellEditorParams = { values: ["", ...fieldConfig.values] }; // "" for blank option
                colDef.singleClickEdit = true; // Enable single-click editing for dropdowns 
            
            } else if (fieldConfig.type === "Integer") {
                console.log(`  DEMO MGR: Col '${fieldName}' is Integer.`);
                colDef.singleClickEdit = true; // Enable single-click editing for integers
                colDef.cellEditor = 'agTextCellEditor'; // Use simple text editor instead of large text editor
                colDef.valueParser = params => { // Parse input to integer
                    if (params.newValue === "" || params.newValue === null || params.newValue === undefined) return null;
                    const val = Number(params.newValue);
                    // Revert to oldValue if not a valid integer (prevents invalid data entry)
                    return (isNaN(val) || !Number.isInteger(val)) ? params.oldValue : val; 
                };
                colDef.cellRenderer = params => { // How to display integer values (e.g., handle null)
                   return params.value === null || params.value === undefined ? '' : params.value;
                };           
            }
            // Add other type handlers here if needed (e.g., Date)
        } else {
            console.warn(`DEMO MGR: No fieldConfig for '${fieldName}'. Using default agLargeTextCellEditor.`);
        }
        columnDefs.push(colDef);
    });
    console.log("DEMO MGR: Final Column Defs:", JSON.parse(JSON.stringify(columnDefs)));

    // 3. Prepare Row Data for AG Grid
    // Initialize with participant names; values will be empty or from loaded CSV/JSON
    let rowDataForGrid = currentParticipantList.map(pName => {
        const row = { "Participant": pName };
        console.log("DEMO MGR: demographicsObjectFromFlask INSIDE map for " + pName + ":", JSON.parse(JSON.stringify(demographicsObjectFromFlask))); // LOG 2
        (demographicsObjectFromFlask.chosenFields || []).forEach(field => {
            row[field] = "";
        });
        return row;
    });

    let loadedDemographicsValues = {};

    try {
        if (window.APP_MODE === 'demo') {
            console.log("DEMO MGR: Demo mode detected. Loading hardcoded demo data.");
            const response = await fetch(`/load_demographics_data/DEMOGRAPHICS.json`);
            if (response.ok) {
                loadedDemographicsValues = await response.json();
            } else {
                console.warn("DEMO MGR: Could not load the demo demographics file.");
            }
        } else {
            console.log("DEMO MGR: User mode detected. Looking for saved user data.");
            const localDraft = localStorage.getItem(demographicsDataKey);
            if (localDraft) {
                try {
                    loadedDemographicsValues = JSON.parse(localDraft);
                    console.log("DEMO MGR: Loaded demographics values from localStorage.");
                } catch (e) {
                    console.warn("DEMO MGR: Failed to parse local draft demographics data:", e);
                }
            }
            if (Object.keys(loadedDemographicsValues).length === 0) {
                const lastSavedDemoFilename = localStorage.getItem(demographicsFilenameKey);
                if (lastSavedDemoFilename && currentParticipantList.length > 0) {
                    console.log("DEMO MGR: Attempting to load previously saved demographics from:", lastSavedDemoFilename);
                    const response = await fetch(`/load_demographics_data/${lastSavedDemoFilename}`);
                    if (response.ok) {
                        loadedDemographicsValues = await response.json();
                        console.log("DEMO MGR: Loaded demographics values:", loadedDemographicsValues);
                    } else {
                        console.warn(`DEMO MGR: Could not load demographics file ${lastSavedDemoFilename}. Status: ${response.status}`);
                    }
                }
            }
        }
    } catch (error) {
        console.error("DEMO MGR: Error fetching saved demographics:", error);
    }
    
    if (Object.keys(loadedDemographicsValues).length > 0) {
        rowDataForGrid.forEach(row => {
            const pData = loadedDemographicsValues[row.Participant];
            if (pData) {
                (demographicsObjectFromFlask.chosenFields || []).forEach(field => {
                if (pData.hasOwnProperty(field)) {
                    row[field] = pData[field];
                }
                });
            }
        });
        console.log("DEMO MGR: rowDataForGrid updated with loaded values:", JSON.parse(JSON.stringify(rowDataForGrid)));
    }


    // 5. Create AG Grid
    if (!gridDiv) {
        console.error("#demographics-grid element not found!");
        return;
    }

    if (gridApi_demographics) {
        console.log("DEMO MGR: Grid API exists. Setting row data.");
        gridApi_demographics.setGridOption('rowData', rowDataForGrid); 
    } else {
        console.log("DEMO MGR: Creating new AG Grid instance.");
        try {
                if (typeof agGrid !== 'undefined' && typeof agGrid.createGrid === 'function') {
                    const gridOptions = {
                    columnDefs,
                    rowData: rowDataForGrid,
                    defaultColDef: { resizable: true, filter: true, editable: true, singleClickEdit: true },
                    domLayout: "normal",
                    
                    onCellValueChanged: (params) => {
                        handleDemographicsCellChange(params, demographicsObjectFromFlask, demographicsConfigKey);
                    },
                    // Force single-click editing for all editable demographics cells.
                    onCellClicked: (params) => {
                        if (!params || params.rowIndex == null) return;
                        if (!params.colDef?.editable || params.colDef.field === "Participant") return;
                        const colId = params.column?.getColId?.();
                        if (!colId) return;

                        const alreadyEditing = (params.api.getEditingCells() || []).some(
                            cell => cell.rowIndex === params.rowIndex && cell.column?.getColId?.() === colId
                        );
                        if (alreadyEditing) return;
                        params.api.startEditingCell({ rowIndex: params.rowIndex, colKey: colId });
                    },
                    onGridReady: (params) => {
                        gridApi_demographics = params.api;
                        // Make sure AG Grid recalculates once it’s mounted & sized
                        requestAnimationFrame(() => {
                        //gridApi_demographics.doLayout();
                        //gridApi_demographics.sizeColumnsToFit();
                        if (typeof gridApi_demographics.sizeColumnsToFit === "function") {
                            gridApi_demographics.sizeColumnsToFit();
                        }
                        });
                    }
                    };
                    console.log("gridDiv rect at creation:", gridDiv.getBoundingClientRect());
                    console.log("gridParent rect:", gridParent?.getBoundingClientRect());
                    console.log("attributes-window rect:", demographicsWindowEl?.getBoundingClientRect());
                    agGrid.createGrid(gridDiv, gridOptions); // This call itself doesn't return the API directly.
                                        
                } else { console.log("ERROR agGrid not loaded !"); }
        } catch (error) { console.log(error) }
    }

    // 6. UI Elements (Buttons)
    const demographicsWindow = d3.select("#attributes-window");
    demographicsWindow.select(".bottom-frame").remove();

    const bottomRow = demographicsWindow.append("div")
    .attr("class", "bottom-frame")
    .style("display", "flex")
    .style("justify-content", "space-between")
    .style("align-items", "center")
    .style("gap", "10px")
    .style("padding", "12px 16px")
    .style("background", "#ffffff")
    .style("border-top", "1px solid #E5E7EB")
    .style("margin-top", "auto");   // <-- pushes this bar to the bottom of the viewport

    const leftButtons = bottomRow.append("div").style("display","flex").style("gap","10px");
    leftButtons.append("div")
        .attr("class", "button")
        .text("Back")
        .on("click", function () {
            // Navigate back to edit-attributes page, POSTing current demographicsObjectFromFlask definitions
            fetch('/demographics/edit-attributes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(demographicsObjectFromFlask), // Send the definition object
            }).then(response => {
                if (response.ok) window.location.href = '/demographics/edit-attributes';
                else console.error('Failed to navigate back', response.statusText);
            }).catch(error => console.error('Error:', error));
        });
    
    // --- CSV Upload Button and Hidden Input ---
    leftButtons.append("input")
        .attr("type", "file")
        .attr("id", "csvUploadInput_demographics")
        .attr("accept", ".csv")
        .style("display", "none")
        .on("change", function() { 
        handleDemographicsCsvUpload(d3.event || window.event, demographicsObjectFromFlask, demographicsConfigKey);
        });

    leftButtons.append("div")
        .attr("class", "button")
        .text("Upload CSV to Fill Table")
        .style("background-color","ECECF0")
        .on("click", () => document.getElementById("csvUploadInput_demographics").click());
    //CSV format help button
    leftButtons.append("div")
        .attr("class", "button")
        .attr("title", "CSV format help")
        .style("width", "32px")
        .style("height", "32px")
        .style("min-width", "32px")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("border-radius", "50%")
        .style("background-color", "#ECECF0")
        .style("font-weight", "700")
        .style("cursor", "pointer")
        .style("user-select", "none")
        .text("?")
        .on("click", () => showCsvHelpModal(demographicsObjectFromFlask));

    const rightButtons = bottomRow.append("div").style("display","flex").style("gap","10px");
    saveStatusEl = rightButtons.append("div")
        .attr("id", "demographics-autosave-status")
        .style("font-size", "14px")
        .style("font-weight", "700")
        .style("padding", "8px 12px")
        .style("border-radius", "10px");
    setAutoSaveStatus("Auto-saved. Changes save automatically.", "success");
    
    const addAttributeButton = d3.select("#add-attribute-button");
    if (!addAttributeButton.empty()) {
        addAttributeButton.on("click", function () {
            console.log("DEMO MGR: Add Attribute button clicked, navigating to choose-attributes.");
            fetch('/demographics/choose-attributes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(demographicsObjectFromFlask),
            }).then(response => {
                if (response.ok) {
                    window.location.href = '/demographics/choose-attributes';
                } else {
                    console.error('DEMO MGR: Failed to POST current demo object before navigating to choose-attributes:', response.statusText);
                    // Fallback: still navigate if POST fails but warn user.
                    // Or, you could just navigate directly if you don't need to save state from this page to that one:
                    // window.location.href = '/demographics/choose-attributes';
                }
            }).catch(error => {
                console.error('DEMO MGR: Error POSTing before navigating to choose-attributes:', error);
            });
        });
    } else {
        console.warn("DEMO MGR: #add-attribute-button not found.");
    }
} 
    
// Custom one-click select editor for demographic dropdown columns.
function OneClickSelectEditor() {}

OneClickSelectEditor.prototype.init = function(params) {
    this.params = params;
    this.eSelect = document.createElement("select");
    this.eSelect.style.width = "100%";
    this.eSelect.style.height = "100%";
    this.eSelect.style.border = "none";
    this.eSelect.style.background = "transparent";

    const values = Array.isArray(params.values) ? params.values : [];
    values.forEach(value => {
        const option = document.createElement("option");
        const normalized = value == null ? "" : String(value);
        option.value = normalized;
        option.textContent = normalized;
        this.eSelect.appendChild(option);
    });

    const currentValue = params.value == null ? "" : String(params.value);
    this.eSelect.value = values.map(v => (v == null ? "" : String(v))).includes(currentValue) ? currentValue : "";

    this.eSelect.addEventListener("change", () => params.stopEditing());
    this.eSelect.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === "Tab") {
            params.stopEditing();
        }
    });
};

OneClickSelectEditor.prototype.getGui = function() {
    return this.eSelect;
};

OneClickSelectEditor.prototype.afterGuiAttached = function() {
    this.eSelect.focus();
    // Trigger native dropdown expansion immediately after first click.
    this.eSelect.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    this.eSelect.click();
};

OneClickSelectEditor.prototype.getValue = function() {
    return this.eSelect.value;
};


function parseDemographicsCsvValue(csvValue, expectedType) {
    if (expectedType !== "Integer") {
        const textValue = csvValue === null || csvValue === undefined ? "" : String(csvValue);
        return { value: textValue, hasTypeMismatch: false };
    }
    if (String(csvValue).trim() === "") {
        return { value: "", hasTypeMismatch: false };
    }
    const integerValue = Number(csvValue);
    if (!Number.isInteger(integerValue)) {
        return { value: "", hasTypeMismatch: true };
    }
    return { value: integerValue, hasTypeMismatch: false };
}

function handleDemographicsCsvUpload(event, demographicsConfigFromManager, demographicsConfigKey) {
    const file = event.target.files[0];
    if (!file) return;
    if (!gridApi_demographics) {
        alert("Grid not initialized. Cannot process CSV.");
        event.target.value = null; return;
    }

    const existingRows = [];
    gridApi_demographics.forEachNode(node => existingRows.push(node.data));
    const chosenFieldsBeforeUpload = demographicsConfigFromManager.chosenFields || [];
    const hasExistingData = existingRows.some(row =>
        chosenFieldsBeforeUpload.some(field => {
            const val = row[field];
            return val !== undefined && val !== null && String(val).trim() !== "";
        })
    );

    if (hasExistingData) {
        const proceed = confirm(
            "This table already has data in it. Uploading this CSV will overwrite existing values, and columns not present in the CSV will be deselected from the table.\n\nDo you want to continue?"
        );
        if (!proceed) {
            event.target.value = null;
            return;
        }
    }

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const csvText = e.target.result;
            const rawParsedCsvData = d3.csvParse(csvText);
            const parsedCsvData = rawParsedCsvData.map(row => {
                const cleanRow = {};
                Object.keys(row).forEach(key => {
                    const cleanKey = key.trim();
                    const val = row[key];
                    cleanRow[cleanKey] = typeof val === 'string' ? val.trim() : val;
                });
                return cleanRow;
            });
            parsedCsvData.columns = (rawParsedCsvData.columns || []).map(c => c.trim());

            const buildLowerKeyMap = (row) => {
                const map = {};
                Object.keys(row).forEach(k => { map[k.toLowerCase()] = row[k]; });
                return map;
            };
            const parsedCsvDataLower = parsedCsvData.map(buildLowerKeyMap);

            console.log("DEMO MGR CSV: Parsed CSV Data:", JSON.parse(JSON.stringify(parsedCsvData)));

            if (!parsedCsvData || parsedCsvData.length === 0) {
                alert("CSV is empty or could not be parsed correctly."); return;
            }

            const csvHeaders = parsedCsvData.columns || [];
            const oldOptions = demographicsConfigFromManager.options || [];
            const newChosenFields = [];
            const csvDerivedOptions = [];

            csvHeaders.forEach(csvHeader => {
                let potentialFieldName = toCamelCase(csvHeader.trim());
                if (potentialFieldName.toLowerCase() === "participant") return;

                if (!newChosenFields.some(f => f.toLowerCase() === potentialFieldName.toLowerCase())) {
                    newChosenFields.push(potentialFieldName);
                    const existingOption = oldOptions.find(opt => opt.field.toLowerCase() === potentialFieldName.toLowerCase());
                    csvDerivedOptions.push(existingOption ? { ...existingOption, field: potentialFieldName } : { field: potentialFieldName, type: "Text", values: [] });
                }
            });
            csvDerivedOptions.forEach(option => {
                if (option.type !== "Text") return; 

                const headerVariations = [
                    option.field,
                    camelCaseToTitleCase(option.field),
                    option.field.replace(/([A-Z])/g, '_$1'),
                    option.field.replace(/([A-Z])/g, ' $1')
                ].map(h => h.toLowerCase());

                const uniqueFromCsv = new Set(option.values || []); 

                parsedCsvDataLower.forEach(csvRowLower => {
                    for (const header of headerVariations) {
                        if (Object.prototype.hasOwnProperty.call(csvRowLower, header)) {
                            const val = String(csvRowLower[header] ?? "").trim();
                            if (val !== "") uniqueFromCsv.add(val);
                            break;
                        }
                    }
                });

                option.values = Array.from(uniqueFromCsv);
            });
            const mergedOptionsMap = new Map(oldOptions.map(opt => [opt.field.toLowerCase(), opt]));
            csvDerivedOptions.forEach(opt => mergedOptionsMap.set(opt.field.toLowerCase(), opt));
            const newOptions = Array.from(mergedOptionsMap.values());

            const removedFields = chosenFieldsBeforeUpload.filter(
                oldField => !newChosenFields.some(f => f.toLowerCase() === oldField.toLowerCase())
            );
            if (removedFields.length > 0) {
                console.log("DEMO MGR CSV: Deselecting columns not present in CSV (still available as options):", removedFields);
            }

            demographicsConfigFromManager.chosenFields = newChosenFields; 
            demographicsConfigFromManager.options = newOptions;            
            localStorage.setItem(demographicsConfigKey, JSON.stringify(demographicsConfigFromManager));

            console.log("DEMO MGR CSV: Rebuilding columns and grid from CSV headers.");

            const newColumnDefs = [{ field: "Participant", editable: false, pinned: 'left', lockPinned: true, cellClass: 'lock-pinned', width: 150 }];
            newChosenFields.forEach(fieldName => {
                const fieldConfig = newOptions.find(opt => opt.field === fieldName);
                let editorParams = {}; let cellEditor = 'agTextCellEditor';
                if (fieldConfig && fieldConfig.type === "Text" && fieldConfig.values && fieldConfig.values.length > 0) {
                    editorParams.values = ["", ...(fieldConfig.values || [])];
                    cellEditor = OneClickSelectEditor;
                }
                newColumnDefs.push({
                    field: fieldName, headerName: camelCaseToTitleCase(fieldName), editable: true,
                    cellEditor: cellEditor, cellEditorParams: editorParams, width: 180,
                    valueParser: fieldConfig && fieldConfig.type === 'Integer' ? params => {
                        if (params.newValue === "" || params.newValue === null || params.newValue === undefined) return null;
                        const val = Number(params.newValue);
                        return isNaN(val) || !Number.isInteger(val) ? params.oldValue : val;
                    } : undefined,
                    cellRenderer: fieldConfig && fieldConfig.type === 'Integer' ? params => {
                       return params.value === null || params.value === undefined ? '' : params.value;
                    } : undefined
                });
            });

            gridApi_demographics.setGridOption('columnDefs', newColumnDefs);
            console.log("DEMO MGR CSV: Column definitions updated using setGridOption.");

            let updatedRowCount = 0;
            let dataTypeMismatchErrors = [];
            const currentGridData = [];
            gridApi_demographics.forEachNode(node => currentGridData.push(node.data));

            const newRowData = currentGridData.map(gridRow => {
                const participantNameInGrid_original = gridRow.Participant;
                if (!participantNameInGrid_original) return { Participant: gridRow.Participant };
                const participantNameInGrid_normalized = participantNameInGrid_original.toLowerCase().trim();
                const updatedRow = { Participant: participantNameInGrid_original };
                let rowWasActuallyUpdatedThisIteration = false;

                const csvRowLowerForParticipant = parsedCsvDataLower.find(csvRowLower => {
                    const csvParticipantValue = csvRowLower["participant"] || csvRowLower["participant id"];
                    return csvParticipantValue && (String(csvParticipantValue).toLowerCase().trim() === participantNameInGrid_normalized);
                });

                newChosenFields.forEach(gridFieldKey_camelCase => {
                    const fieldDefinition = newOptions.find(opt => opt.field === gridFieldKey_camelCase);
                    const expectedType = fieldDefinition ? fieldDefinition.type : "Text";

                    const headerVariations = [
                        gridFieldKey_camelCase,
                        camelCaseToTitleCase(gridFieldKey_camelCase),
                        gridFieldKey_camelCase.replace(/([A-Z])/g, '_$1'),
                        gridFieldKey_camelCase.replace(/([A-Z])/g, ' $1')
                    ].map(h => h.toLowerCase());

                    let csvValueOriginal = undefined;
                    if (csvRowLowerForParticipant) {
                        for (const header of headerVariations) {
                            if (Object.prototype.hasOwnProperty.call(csvRowLowerForParticipant, header)) {
                                csvValueOriginal = csvRowLowerForParticipant[header]; break;
                            }
                        }
                    }

                    if (csvValueOriginal === undefined) {
                        updatedRow[gridFieldKey_camelCase] = "";
                        return;
                    }
                    const convertedCell = parseDemographicsCsvValue(csvValueOriginal, expectedType);
                    if (convertedCell.hasTypeMismatch) {
                        dataTypeMismatchErrors.push(
                            `P: '${participantNameInGrid_original}', Attr: '${gridFieldKey_camelCase}': Expected Integer, CSV has '${csvValueOriginal}'. Left blank.`
                        );
                    }
                    updatedRow[gridFieldKey_camelCase] = convertedCell.value;
                    rowWasActuallyUpdatedThisIteration = true;
                });

                if (rowWasActuallyUpdatedThisIteration) updatedRowCount++;
                return updatedRow;
            });

            gridApi_demographics.setGridOption('rowData', newRowData);
            setAutoSaveStatus("Auto-saving changes...", "saving");
            await saveData(false);

            let finalAlertMessage = `Table rebuilt from CSV. ${updatedRowCount} participant rows updated. `;
            if (removedFields.length > 0) {
                finalAlertMessage += `\n\nColumns deselected (not present in CSV, still available under "Choose your demographics"): ${removedFields.map(camelCaseToTitleCase).join(', ')}.`;
            }
            if (dataTypeMismatchErrors.length > 0) {
                finalAlertMessage += `\n\nDATA TYPE WARNINGS (left blank):\n${dataTypeMismatchErrors.join('\n')}`;
            }
            alert(finalAlertMessage + "\n\nPlease review the table and click 'Save Demographics Data' if changes are correct.");

        } catch (err) {
            alert("Error processing CSV file. Make sure it's a valid CSV format.");
            console.error("CSV processing error:", err);
        }
    };
    reader.readAsText(file);
    event.target.value = null;
}

function toCamelCase(text) {
    if (!text) return '';
    // Replace non-alphanumeric characters (except spaces that will be removed) with a space
    let sanitizedText = text.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    if (!sanitizedText) return ''; 

    return sanitizedText
        .toLowerCase()
        .replace(/(?:^\w|[A-Z]|\b\w)/g, function(word, index) {
            return index === 0 ? word.toLowerCase() : word.toUpperCase();
        })
        .replace(/\s+/g, '');
}

function camelCaseToTitleCase(text) {
    if (!text) return "";
    return text.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
}
//Help button function to show modal with instructions for CSV upload
function showCsvHelpModal(demographicsConfigFromManager) {
    d3.select("#csv-help-modal-overlay").remove();

    const fields = (demographicsConfigFromManager.chosenFields || []);
    const fieldListHtml = fields.length
        ? fields.map(f => {
            const opt = (demographicsConfigFromManager.options || []).find(o => o.field === f);
            const label = camelCaseToTitleCase(f);
            const type = opt ? opt.type : "Text";
            return `<li><strong>${label}</strong> (${type})</li>`;
        }).join("")
        : "<li>No demographic attributes have been configured for this project yet.</li>";

    const overlay = d3.select("body").append("div")
        .attr("id", "csv-help-modal-overlay")
        .style("position", "fixed")
        .style("top", 0).style("left", 0).style("right", 0).style("bottom", 0)
        .style("background", "rgba(0,0,0,0.4)")
        .style("z-index", 9999)
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .on("click", function(event) {
            if (event.target === this) overlay.remove();
        });

    const modal = overlay.append("div")
        .style("background", "#fff")
        .style("border-radius", "12px")
        .style("padding", "24px")
        .style("max-width", "480px")
        .style("width", "90%")
        .style("max-height", "80vh")
        .style("overflow-y", "auto")
        .style("box-shadow", "0 10px 30px rgba(0,0,0,0.2)");

    modal.append("h3")
        .style("margin-top", 0)
        .text("CSV Upload Instructions");

    modal.append("p")
        .style("font-size", "14px")
        .style("color", "#475467")
        .html(`
            To upload demographic data, your CSV must contain a
            <strong>Participant</strong> column with participant IDs that exactly match
            those in this project (for example: <code>P1</code>, <code>P2</code>).

            Each additional column will be treated as a demographic attribute.
        `);

    modal.append("p")
        .style("font-size", "14px")
        .style("font-weight", "700")
        .text("Current attributes in this project:");

    modal.append("ul")
        .style("font-size", "14px")
        .style("color", "#475467")
        .html(fieldListHtml);

    const btnRow = modal.append("div")
        .style("display", "flex")
        .style("gap", "10px")
        .style("margin-top", "20px")
        .style("justify-content", "flex-end");

    btnRow.append("div")
        .attr("class", "button")
        .style("background-color", "#ECECF0")
        .text("Download CSV Template")
        .on("click", () => downloadSampleCsv(demographicsConfigFromManager));

    btnRow.append("div")
        .attr("class", "button")
        .text("Close")
        .on("click", () => overlay.remove());
}

function downloadSampleCsv(demographicsConfigFromManager) {
    const fields = (demographicsConfigFromManager.chosenFields && demographicsConfigFromManager.chosenFields.length)
        ? demographicsConfigFromManager.chosenFields
        : ["age", "gender", "maritalStatus", "location", "educationLevel"];

    const headers = ["Participant", ...fields.map(f => camelCaseToTitleCase(f))];

    const sampleRows = [
        ["P1", ...fields.map(f => sampleValueForField(f, demographicsConfigFromManager))],
        ["P2", ...fields.map(f => sampleValueForField(f, demographicsConfigFromManager))]
    ];

    const csvLines = [headers.join(","), ...sampleRows.map(r => r.join(","))];
    const csvContent = csvLines.join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "demographics_sample.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function sampleValueForField(fieldName, demographicsConfigFromManager) {
    const opt = (demographicsConfigFromManager.options || []).find(o => o.field === fieldName);
    if (opt && opt.type === "Integer") return "30";
    if (opt && opt.values && opt.values.length > 0) return opt.values[0];
    const lower = fieldName.toLowerCase();
    if (lower.includes("age")) return "30";
    if (lower.includes("gender")) return "Female";
    if (lower.includes("marital")) return "Single";
    if (lower.includes("location")) return "SF";
    if (lower.includes("education")) return "Bachelor's";
    return "Sample";
}
// --- NEW: A REUSABLE SAVE FUNCTION ---
// We've extracted the logic from your "Save Draft" button.
// `isManualSave` controls whether the success alert is shown.
async function saveData(isManualSave = false) {
    if (!gridApi_demographics) {
        console.warn("Grid not ready, cannot save.");
        return;
    }

    console.log(isManualSave ? "Manual save triggered..." : "Auto-save triggered...");
    if (!isManualSave) {
        setAutoSaveStatus("Auto-saving changes...", "saving");
    }

    // Extract data from the grid
    const dataToSave = {};
    gridApi_demographics.forEachNode(rowNode => {
        const participantName = rowNode.data.Participant;
        dataToSave[participantName] = { ...rowNode.data };
        delete dataToSave[participantName].Participant; // Remove redundant key
    });
    localStorage.setItem(demographicsDataKey, JSON.stringify(dataToSave));
    
    try {
        const response = await fetch('/save_demographics_data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dataToSave)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unknown server error');
        
        // Only show the alert on a manual save (like clicking "Next")
        if (isManualSave) {
            alert(`Demographics data saved successfully! (${result.message})`);
        } else {
            setAutoSaveStatus("All changes auto-saved.", "success");
        }
        console.log("Save successful:", result);
        
        // Update localStorage with the new filename
        if (result.message && result.message.includes("saved as ")) {
            const savedFilename = result.message.split("saved as ")[1].trim();
            if (savedFilename) {
                localStorage.setItem(demographicsFilenameKey, savedFilename);
            }
        }
        return true; // Indicate success
    } catch (error) {
        if (isManualSave) {
            alert("Error saving demographics data. Check console.");
        } else {
            setAutoSaveStatus("Auto-save failed. Edit again to retry.", "error");
        }
        console.error("Error saving demographics:", error);
        return false; // Indicate failure
    }
}
