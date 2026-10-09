import { demographicsTypes } from "../../../chromascribe-main.js";
import {
    getStoredFileMap,
    hydrateFileMapFromServer
} from "../../fileMapSync.js?v=20260601b";

// TODO: implement button selection to allow for multiple selected colors
var selectionColors = ["#E7A23B", "#E14947", "#8EC053", "#579AE2", "#8E41D1"];

export var demographicsOptions;

var buttons = [];
var newDemoField = "";
var newDemoType = "";

function isValidDemographicsObject(value) {
    return Boolean(value && Array.isArray(value.options) && Array.isArray(value.chosenFields));
}

function markUsageStep(stepName, details = {}) {
    const payload = { stepName, ...details };
    window.__pendingChromaUsageStep = payload;
    if (window.ChromaUsageLogger && typeof window.ChromaUsageLogger.setStep === "function") {
        window.ChromaUsageLogger.setStep(stepName, payload);
    }
}

/**
 * Creates the "Choose the attributes for demographics" page.
 */
export async function chooseDemographicsAttributes(demographicsObject) {
    markUsageStep("Choose demographics attributes", {
        stepKey: "demographics_choose_attributes",
        workflow: "qda_contextual_filtering",
    });
    const projectId = localStorage.getItem("currentProjectId");
    const demoKey = projectId ? `demographicsObject_${projectId}` : "demographicsObject";
    try {
        const stored = localStorage.getItem(demoKey);
        if (stored) {
            const storedObject = JSON.parse(stored);
            if (isValidDemographicsObject(storedObject)) demographicsObject = storedObject;
        }
    } catch (e) {
        console.warn("Failed to load demographics from storage:", e);
    }
    if (!isValidDemographicsObject(demographicsObject)) {
        demographicsObject = { options: [], chosenFields: [], transcripts: [] };
    }
    demographicsOptions = demographicsObject.options;
    
    var demographicsWindow = d3.select("#attributes-window");

    var frame = d3.select(".choose-button-frame-inner");

    var nextButton = d3.select("#next-button");
    nextButton.remove();

    // create demographics choices buttons
    drawButtons(frame, buttons, demographicsObject);

    // add bottom row with next button
    var bottomRow = demographicsWindow.append("div")
        .attr("class", "bottom-frame");
    // empty div for spacing (since there is no back button here)
    //bottomRow.append("div");
    // Add your new "Skip to Visualization" button
    bottomRow.append("div")
        .attr("class", "button positive next")
        .attr("id", "next-button")
        .text("Skip to Visualization")
        .on("click", async function() {
            const btn = d3.select(this);
            btn.text("Processing...") .property("disabled", true) // This makes the button unclickable
               .style("cursor", "not-allowed")
               .style("background-color", "#ccc") // A standard gray color
               .style("opacity", 0.7);

            // Fetch the FileMap from localStorage to send to the backend
            const projectId = localStorage.getItem("currentProjectId");
            await hydrateFileMapFromServer(projectId);
            const fileMap = getStoredFileMap(projectId);
            if (!fileMap) {
                alert("Error: FileMap not found. Cannot process transcripts.");
                btn.text("Skip to Visualization").style("cursor", "pointer");
                return;
            }

            try {
                const response = await fetch('/process_all_transcripts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...fileMap, projectId })
                });
                const result = await response.json();
                if (response.ok) {
                    window.location.href = '/visualization';
                } else {
                    alert("Error processing transcripts: " + result.error);
                    btn.text("Skip to Visualization").style("cursor", "pointer");
                }
            } catch (e) {
                alert("Network error during processing.");
                btn.text("Skip to Visualization").style("cursor", "pointer");
            }
        });
    
    bottomRow.append("div")
        .attr("class", "button positive next")
        .attr("id", "next-button")
        .text("Next")
        .on("click", function () {
            fetch('/demographics/edit-attributes', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(demographicsObject),
            })
            .then(response => {
                if (response.ok) {
                    // Redirect to editAttributes page
                    window.location.href = '/demographics/edit-attributes';
                } else {
                    console.error('Failed to send data', response.statusText);
                }
            })
            .catch(error => {
                console.error('Error:', error);
            });
        });
}

/**
 * Draws demographic options buttons.
 * 
 * @param   {Selection} frame the frame to add the buttons to
 * @param   {HTMLElement[]} buttons the array in which to store all buttons
 * @param   {Object} demographicsObject the demographics information
 */
function drawButtons(frame, buttons, demographicsObject) {
    // remove the add button
    var addButton = d3.select("#add-button");
    addButton.remove();

    //remove the old buttons
    buttons.forEach((element) => {
        element.remove();
    })

    demographicsOptions.forEach((field) => {
        console.log(field);
        let button = frame.append("div")
            .attr("class", "choose-button")
            .attr("id", field.field)
            .on("click", function () {
                selectButton(this, demographicsObject);
            });
            
        if (demographicsObject.chosenFields.indexOf(field.field) !== -1) {
            button.attr("active", "");
        }

        button.append("div")
            .attr("class", "choose-button-text")
            .text(camelCaseToTitleCase(field.field));
        buttons.push(button);
    });
    appendAddButton(frame, demographicsObject);
}

/**
 * Adds (or removes) the selected button's demographic field
 * from the demographics array object.
 * 
 * @param   {HTMLElement} b the button selected
 */
function selectButton(b, demographicsObject) {
    // get the button as a d3 selection
    var button = d3.select("#" + b.id);
    if (button.attr("active") === null) {
        button.attr("active", "");
        let field = button.attr("id");
        if (demographicsObject.chosenFields.indexOf(field) == -1){
            demographicsObject.chosenFields.push(field);
        }
    } else {
        button.attr("active", null);
        let index = demographicsObject.chosenFields.indexOf(button.attr("id"));
        demographicsObject.chosenFields.splice(index, 1);
    }
    const projectId = localStorage.getItem("currentProjectId");
    const demoKey = projectId ? `demographicsObject_${projectId}` : "demographicsObject";
    localStorage.setItem(demoKey, JSON.stringify(demographicsObject));
}

/**
 * Adds the addButton (the `+` button) to the `selection` div.
 * 
 * @param   {Selection} selection the div to add the button to
 */
function appendAddButton(selection, demographicsObject) {
    console.log("hi");
    selection.append("div")
        .attr("class", "add-button")
        .attr("shape", "square")
        .attr("id", "add-button")
        .on("click", function () {
            addField(demographicsObject);
        })
        .append("div")
        .attr("class", "add-symbol")
        .text("+");

}

/**
 * Opens up a modal to add a new demographic field.
 * 
 * If the user successfully enters in a new field and assigns it a type,
 * it will create a new demographic button and set it to active.
 */
function addField(demographicsObject) {
    var button = d3.select(".add-button");

    if (button.attr("disabled") === null) {
        button.attr("disabled", "");
        // open up modal
        var wrapper = d3.select(".attr-wrapper");
        createModal(wrapper, demographicsObject);
    }
}

/**
 * Creates a modal window on the page.
 * 
 * @param   {Selection} selection the div to add the modal to
 * @param   {object} demographicsObject the demographics object
 */
function createModal(selection, demographicsObject) {
    var modal = selection.append("div").attr("class", "modal-window");
    var topRow = modal.append("div").attr("class", "modal-row");
    var textInput = topRow.append("input")
        .attr("type", "text")
        .attr("name", "field name input")
        .attr("placeholder", "Enter the field name")
        .attr("minlength", "1")
        .attr("required", "");
    var typeInput = topRow.append("select")
        .attr("name", "type-select")
        .attr("id", "type-dropdown");

    typeInput.append("option").attr("value", "null").text("Choose the type");
    demographicsTypes.forEach((element) => {
        typeInput.append("option").attr("value", element).text(element);
    });

    var bottomRow = modal.append("div").attr("class", "modal-row");

    bottomRow.append("div")
        .attr("class", "button")
        .attr("id", "cancel-button")
        .on("click", function () {
            close(modal);
        })
        .append("div")
        .text("Cancel");

    bottomRow.append("div")
        .attr("class", "button positive")
        .attr("id", "okay-button")
        .on("click", function () {
            validateAndClose(modal, textInput, typeInput, demographicsObject);
        })
        .append("div")
        .text("Add field");
}

/**
 * Validates the chosen fields and closes the modal if successful
 * 
 * @param   {Selection} modal the modal window
 * @param   {HTMLElement} textInput the input field for the field name
 * @param   {HTMLElement} typeInput the input field for the field type
 * @param   {object} demographicsObject the demographics object
 */
function validateAndClose(modal, textInput, typeInput, demographicsObject) {
    newDemoField = toCamelCase(textInput.property("value"));
    newDemoType = typeInput.property("value");
    // TODO: Check for duplicate field names
    if (newDemoField.match(/.*/)
        && !newDemoType.includes("Choose the type")
        && newDemoType !== "null") {
        //demographicsOptions.push({ "field": newDemoField, "type": newDemoType, "values":[] });
        demographicsObject.options.push({ "field": newDemoField, "type": newDemoType, "values": [] });
        demographicsObject.chosenFields.push(newDemoField);
        console.log(demographicsObject);
        const projectId = localStorage.getItem("currentProjectId");
        const demoKey = projectId ? `demographicsObject_${projectId}` : "demographicsObject";
        localStorage.setItem(demoKey, JSON.stringify(demographicsObject));
        var frame = d3.select("#choose-button-frame-inner");
        
        close(modal);
        //drawButtons(frame, buttons, demographicsObject);
        chooseDemographicsAttributes(demographicsObject)
    }
    else {
        console.log("Invalid");
    }
}

/**
 * Removes the `selection`.
 * 
 * @param {Selection} selection the d3 selection to remove
 */
function close(selection) {
    var button = d3.select(".add-button");
    button.attr("disabled", null);

    selection.remove();
}

/**
 * Splits a camelCase string and recombines with spaces in Title Case.
 * 
 * Ex: "thisIsAString" --> "This Is A String"
 * 
 * @see {@link https://stackoverflow.com/questions/4149276/how-to-convert-camelcase-to-camel-case?noredirect=1&lq=1|Vincent Robert's StackOverflow answer} for the source. 
 * 
 * @param   {string} text the camelCase string to split
 * @returns {string} the recombined split string in Title Case
 */
function camelCaseToTitleCase(text) {
    return text.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase())
}

/**
 * Converts a string to camelCase.
 * 
 * Ex: "this Is a String" --> "thisIsAString"
 * 
 * @see {@link https://stackoverflow.com/questions/2970525/converting-a-string-with-spaces-into-camel-case|Christian C. Salvadó's StackOverflow answer} for the source.
 * 
 * @param   {string} text the raw text to convert
 * @returns {string} the camelCase conversion of `text` 
 */
function toCamelCase(text) {
    text = text.toLowerCase();
    return text.replace(/(?:^\w|[A-Z]|\b\w)/g, function (word, index) {
        return index === 0 ? word.toLowerCase() : word.toUpperCase();
    }).replace(/\s+/g, '');
}
