import { drawVisualization } from "./drawVisualization.js?v=20260901b";
import { drawVisualization2 } from "./drawVisualization2.js?v=20260901b";
import {graphAxes} from "./graphAxes.js";
import { menuOpenObject,selectionMapObject, tempObject, 
        currentDisplayObject, FileMap, raceObject, ageObject, HIVObject, 
        genderObject, kObject, demographicsObject, loadTranscripts,
        themesObject,themeObject, transcriptsObject} from "/static/chromascribe-main.js";
import { readJson } from "./readJson.js?v=20260601b";

let storedDemographicsData = {};
let participantBridge = {};
let fullDataset = [];
let storedThemes = {};

function getProjectDemographicsObject() {
    const projectId = String(localStorage.getItem("currentProjectId") || "").trim();
    const scopedKey = projectId ? `demographicsObject_${projectId}` : "demographicsObject";
    try {
        const scopedValue = localStorage.getItem(scopedKey);
        if (scopedValue) return JSON.parse(scopedValue);
        if (!projectId) {
            const legacyValue = localStorage.getItem("demographicsObject");
            return legacyValue ? JSON.parse(legacyValue) : null;
        }
    } catch (error) {
        console.warn("Could not parse demographics filter config:", error);
    }
    return null;
}

export async function showMenu(container) {

    if (menuOpenObject.menuOpen) {
        menuOpenObject.menuOpen = false;
        container.selectAll("*").remove(); 
        return;
    }

    // LOGIC to load data 
    try {
        if (window.APP_MODE === 'demo') {
            console.log("FILTERING: Demo mode detected. Loading demo demographic data.");
            const response = await fetch("/load_demographics_data/DEMOGRAPHICS.json");
            if (!response.ok) throw new Error('Demo demographic file not found.');
            storedDemographicsData = await response.json();
        } else {
            console.log("FILTERING: User mode detected. Finding latest user demographic data.");
            const nameResponse = await fetch('/api/get_latest_demographics_file');
            if (!nameResponse.ok) throw new Error('No demographic file found for this project.');
            const nameData = await nameResponse.json();
            const dataResponse = await fetch(`/load_demographics_data/${nameData.latest_filename}`);
            if (!dataResponse.ok) throw new Error('Project demographic data could not be loaded.');
            storedDemographicsData = await dataResponse.json();
        }
    } catch (e) {
        container.html("<p style='color:red;'>Could not load demographic data.</p>");
        return;
    }

    fullDataset = [...currentDisplayObject.currentDisplay];
    storedThemes = themesObject; 
    participantBridge = {};
    fullDataset.forEach(transcriptEntry => {
        const longId = transcriptEntry.participant;
        const shortId = getParticipantIdFromKey(longId);
        if (longId && shortId) {
            participantBridge[longId] = shortId;
        }
    });

    console.log("Participants for demo filtering",participantBridge);

    container.append("h2").text("Demographic Filters").style("padding-top", "10px").style("padding-bottom", "10px").style("font-weight", "bold").style("font-size", "20px");
    const storedDemographicsObject = getProjectDemographicsObject();
    
    if (storedDemographicsObject && storedDemographicsObject.chosenFields) {
        storedDemographicsObject.chosenFields.forEach(fieldName => {
            const fieldMeta = storedDemographicsObject.options.find(opt => opt.field === fieldName);
            if (fieldMeta) {
                createFilterSection(container, fieldMeta, fieldName);
            }
        });
    }
}

// Function to create filter section dynamically based on chosen field
function createFilterSection(container, type, field) {
    const fieldType = type.type;
    const uniqueValues = getUniqueValues(field);
    
    const filterSection = container.append("div").style("margin-bottom", "16px");
    filterSection.append("h5")
        .text(field.charAt(0).toUpperCase() + field.slice(1))
        .style("font-weight", "700")
        .style("font-size", "17px")
        .style("color", "#111827");

    if (fieldType === "Integer" && uniqueValues.length > 0) {
        const numericValues = uniqueValues.map(Number).filter(v => !isNaN(v));
        const min = Math.min(...numericValues);
        const max = Math.max(...numericValues);
        selectionMapObject.selectionMap[`${field}-range`] = { min: min, max: max };

        // Create label
        filterSection.append("div")
            .attr("id", `${field}-range-label`)
            .text(`Range: ${min} – ${max}`)
            .style('font-size', "15px")
            .style("margin-bottom", "5px");
            
        // "Reset" button now uses the slider's API
        filterSection.append("button")
            .text("Reset")
            .attr("class", "filter-select-button")
            .style("font-size", "14px")
            .style("margin-top", "5px")
            .on("click", function () {
                sliderDiv.noUiSlider.set([min, max]);
            });
        
        // Create an empty div for the slider to be built on
        const sliderDiv = filterSection.append("div")
            .attr("id", `${field}-slider`)
            .node(); 

        // Initialize the noUiSlider on our new div
        noUiSlider.create(sliderDiv, {
            start: [min, max], 
            connect: true,     
            step: 1,           
            range: {
                'min': min,
                'max': max
            },
            format: { 
                to: value => Math.round(value),
                from: value => Number(value)
            }
        });  
    
        if (!document.getElementById('custom-nouislider-styles')) {
            const style = document.createElement('style');
            style.id = 'custom-nouislider-styles';
            style.innerHTML = `
                .noUi-target {
                    background: #d3d3d3; /* Light grey track */
                    border-radius: 5px;
                    border: none;
                    box-shadow: none;
                    height: 5px;
                }
                .noUi-connect {
                    background: #3A61DD; /* Your desired blue color */
                }
                .noUi-handle {
                    border: 1px solid #3A61DD;
                    border-radius: 50%;
                    background: #ffffff;
                    box-shadow: none;
                    height: 15px;
                    width: 15px;
                    top: -5px;
                    right: -7.5px;
                    cursor: pointer;
                }
                .noUi-handle::before, .noUi-handle::after {
                    display: none; /* Hide the default vertical bars on the handle */
                }
            `;
            document.head.appendChild(style);
        }

        // Listen for changes and update our application state
        sliderDiv.noUiSlider.on('update', function (values, handle) {
            const newMin = values[0];
            const newMax = values[1];
            
            // Update the label
            updateRangeLabel(field, newMin, newMax);
            
            // Update our global selection map
            selectionMapObject.selectionMap[`${field}-range`] = { min: newMin, max: newMax };
            applyFilterLogic();
        });
    } else {
        //Text field (default to checkboxes)
        const allNoneGroup = filterSection.append("div")
            .style("margin-bottom", "6px")
            .style("display", "flex")
            .style("flex-direction", "row")
            .style("gap", "8px");
        
        allNoneGroup.append("button").text("Select All")
            .attr("class", "filter-select-button")
            .style("display", "inline-block")
            .style("font-size", "14px")
            .on("click", () => toggleSelectAll(field, true));
        allNoneGroup.append("button").text("Select None")
            .attr("class", "filter-select-button")
            .style("display", "inline-block")
            .style("font-size", "14px")
            .on("click", () => toggleSelectAll(field, false));

        // Create a grid container for the checkboxes
        const checkboxContainer = filterSection.append("div")
            .attr("id", field) 
            .style("display", "grid")
            .style("grid-template-columns", "repeat(2, 1fr)") 
            .style("gap", "2px 10px"); // Row and column gap

        uniqueValues.forEach(value => {
            const buttonId = `${field}-${value}`;
            // Pass the new grid container to the filterButtons function
            filterButtons(checkboxContainer, buttonId, value, field);
        });
    }
}

function getUniqueValues(field) {
    return [...new Set(Object.values(storedDemographicsData).map(p => p[field]))];
}

// Helper to extract P-number from various key formats
function getParticipantIdFromKey(key) {
    const match = key.match(/P(\d+)/i);
    return match ? `P${parseInt(match[1], 10)}` : null;
}

function updateRangeLabel(field, min, max) {
    d3.select(`#${field}-range-label`).text(`Range: ${min} – ${max}`);
}

function filterButtons(container, id, value, field) {
        var checkbox, filterButton, filterText;

        // Create the checkbox container
        checkbox = container.append("div")
            .style("display", "flex")
            .style("align-items", "center")
            .style("padding", "2px 0");
    
        // Create an input checkbox element
        filterButton = checkbox.append("input")
            .attr("type", "checkbox")
            .attr("id", id)
            .attr("class", "demographic-filter")
            .attr("data-field", field) 
            .attr("data-value", value)
            .style("width", "16px")
            .style("height", "16px")
            .style("margin-right", "6px");
        

        // 1. Set the initial state in the selectionMap to FALSE.
        selectionMapObject.selectionMap[id] = false;
    
        // 2. Set the checkbox's initial visual state to FALSE (unchecked).
        filterButton.property("checked", false);


        // Append the label for the checkbox
        filterText = checkbox.append("div")
            .text(value)
            .style("font-size", "15px");

        // Listen for checkbox change event
        filterButton.on("change", function() {
            console.log("Checkbox changed:", this.checked);
            toggleFilterSelection(id, value, field)
            
        });
}


// Function to toggle selecting/unselecting all checkboxes in a section
function toggleSelectAll(field, isSelectAll) {

    const uniqueValues = getUniqueValues(field);
    uniqueValues.forEach(value => {
        const buttonId = `${field}-${value}`;
        selectionMapObject.selectionMap[buttonId] = isSelectAll;

        d3.select(`[data-field="${CSS.escape(field)}"][data-value="${CSS.escape(String(value))}"]`)
        .property("checked", isSelectAll);
    });

    // Apply filtering logic after updating the selection
    applyFilterLogic();
}

// Function to toggle the filter state when a button is clicked
function toggleFilterSelection(buttonId, value, field) {
    const isSelected = !selectionMapObject.selectionMap[buttonId];
    selectionMapObject.selectionMap[buttonId] = isSelected;

    // Update button style
    d3.select(`[data-field="${CSS.escape(field)}"][data-value="${CSS.escape(String(value))}"]`)
        .property("checked", isSelected).property("unchecked", !isSelected);

    // Apply filtering logic after updating the selection
    applyFilterLogic();
}



// Function to apply the filtering logic
function applyFilterLogic() {
    console.log("Applying demographic filters...");
   
    const filteredData = fullDataset.filter(transcriptEntry => {
        const longId = transcriptEntry.participant;
        const shortId = participantBridge[longId];
        if (!shortId || !storedDemographicsData[shortId]) return false;

        const participantDemos = storedDemographicsData[shortId];
        let isValid = true;
        const storedDemographicsObject = getProjectDemographicsObject();
        if (!storedDemographicsObject || !storedDemographicsObject.chosenFields) return true;

        for (const fieldName of storedDemographicsObject.chosenFields) {
            const fieldMeta = storedDemographicsObject.options.find(opt => opt.field === fieldName);
            const value = participantDemos[fieldName];
            if (!fieldMeta) continue;

            if (fieldMeta.type === "Integer") {
                const range = selectionMapObject.selectionMap[`${fieldName}-range`];
                if (range && (value < range.min || value > range.max)) {
                    isValid = false;
                    break;
                }
            } else {
                // Get all possible values for this category
                const allValuesForField = getUniqueValues(fieldName);
                // Get all selected values for this category
                const selectedValues = allValuesForField.filter(val => {
                    const filterId = `${fieldName}-${val}`;
                    return selectionMapObject.selectionMap[filterId];
                });
                if (selectedValues.length > 0 && selectedValues.length < allValuesForField.length) {
                    const participantValue = participantDemos[fieldName];
                    if (!selectedValues.includes(participantValue)) {
                        isValid = false;
                        break;
                    }
                }
            }
        }
        return isValid;
    });
    console.log("Filtered data contains", filteredData.length, "participants.");

    currentDisplayObject.currentDisplay = filteredData;
    redrawVisualization();
}

function getActiveVizView() {
    // Timeline is the default page; only use Question View when it is explicitly active.
    const raw = String(window.view || "").trim().toLowerCase();
    return raw.includes("question") ? "question" : "timeline";
}

function redrawVisualization() {
    const participantIds = currentDisplayObject.currentDisplay.map(p => p.participant);
    const activeView = getActiveVizView();
    graphAxes(participantIds, window.view || "timeline");

    if (activeView === "question") {
        drawVisualization2(currentDisplayObject.currentDisplay);
    } else {
        drawVisualization(currentDisplayObject.currentDisplay);
    }
}
