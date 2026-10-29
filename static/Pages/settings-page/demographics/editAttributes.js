import { demographicsObject } from "../../../chromascribe-main.js";
import { demographicsTypes } from "../../../chromascribe-main.js";

var tempDemoObj;
var Storedtranscript;

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

async function persistDemographicsObject(demoObj, endpoint = "/demographics/edit-attributes") {
    const projectId = localStorage.getItem("currentProjectId");
    const demoKey = projectId ? `demographicsObject_${projectId}` : "demographicsObject";
    localStorage.setItem(demoKey, JSON.stringify(demoObj));

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(demoObj),
        });
        if (!response.ok) {
            console.error(`Failed to persist demographics object to ${endpoint}`, response.statusText);
            return false;
        }
        return true;
    } catch (error) {
        console.error(`Error persisting demographics object to ${endpoint}:`, error);
        return false;
    }
}

export async function editAttributes(demographicsObject,transcript) {
    markUsageStep("Edit demographics attributes", {
        stepKey: "demographics_edit_attributes",
        workflow: "qda_contextual_filtering",
    });
    Storedtranscript = transcript
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
    persistDemographicsObject(demographicsObject);
    
    tempDemoObj = structuredClone(demographicsObject);
    var demographicsWindow = d3.select("#attributes-window");
        
    var attrWrapper = d3.select(".attr-wrapper");

    demographicsWindow.selectAll(".bottom-frame").remove();   
    attrWrapper.selectAll("table.table").remove();            
    var table = attrWrapper.append("table")
    .attr("class", "table bdr");
    buildTable(table, demographicsWindow, demographicsObject);
    d3.select("#attr-columns-help").on("click", () => showAttributeColumnsHelpModal(demographicsWindow));

    var bottomRow = demographicsWindow.append("div")
        .attr("class", "bottom-frame");

    bottomRow.append("div")
        .attr("class", "button")
        .attr("id", "back-button")
        .text("Back")
        .on("click", async function () {
            const ok = await persistDemographicsObject(demographicsObject, "/demographics/choose-attributes");
            if (ok) {
                window.location.href = "/demographics/choose-attributes";
            }
        });
    bottomRow.append("div")
        .attr("class", "button positive next")
        .attr("id", "next-button")
        .text("Next")
        .on("click", async function () {
            const ok = await persistDemographicsObject(demographicsObject, "/demographics/demographics-manager");
            if (ok) {
                window.location.href = "/demographics/demographics-manager";
            } else {
            }
        });
}


function buildTable(table, demographicsWindow, demographicsObject) {
    table.selectAll("tbody").remove();

    var body = table.append("tbody");
    demographicsObject.chosenFields.forEach(chosenField => {
        var field = demographicsObject.options.find(f => f.field === chosenField);
        var row = body.append("tr")
            .style("border-bottom", "1px solid #eee");

        row.append("td")
            .style("border", "none")
            .style("padding", "16px")
            .text(camelCaseToTitleCase(field.field));

        addDropdown(
            row.append("td")
                .style("border", "none")
                .style("text-align", "center")
                .style("vertical-align", "middle"),
            field, demographicsObject
        );

        var valuesCellTd = row.append("td")
            .style("border", "none")
            .style("text-align", "center")
            .style("vertical-align", "middle");

        renderValuesCellContent(valuesCellTd, field, demographicsWindow, demographicsObject);
    });
}
function showAttributeColumnsHelpModal(demographicsWindow) {
    d3.select("#attr-columns-help-modal-overlay").remove();

    const overlay = d3.select("body").append("div")
        .attr("id", "attr-columns-help-modal-overlay")
        .style("position", "fixed")
        .style("top", 0).style("left", 0).style("right", 0).style("bottom", 0)
        .style("background", "rgba(0,0,0,0.4)")
        .style("z-index", 9999)
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .on("click", function (event) {
            if (event.target === this) overlay.remove();
        });

    const modal = overlay.append("div")
        .style("background", "#fff")
        .style("border-radius", "12px")
        .style("padding", "24px")
        .style("max-width", "440px")
        .style("width", "90%")
        .style("box-shadow", "0 10px 30px rgba(0,0,0,0.2)");

    modal.append("h3").style("margin-top", 0).text("Table Columns Explanation");

    modal.append("p")
    .style("font-size", "14px")
    .style("color", "#475467")
    .html(`
        1st: <span style="color:#000; font-weight:800;">Attribute</span> = the name of the demographic field (e.g. Ethnicity, Marital Status).<br><br>
        2nd: <span style="color:#000; font-weight:800;">Attribute Type</span> = <em>Text</em> for names or categories, <em>Integer</em> for whole numbers only (e.g. Age).<br><br>
        3rd: <span style="color:#000; font-weight:800;">Attribute Values</span> = the number of predefined values set for this attribute. Click to add or edit them (only available for Text type).
    `);

    modal.append("div")
    .style("display", "flex")
    .style("justify-content", "center")
    .append("div")
    .attr("class", "button")
    .style("width", "fit-content")
    .style("padding", "8px 24px")
    .text("Close")
    .on("click", () => overlay.remove());
}

function addDropdown(div, field, demographicsObject) {
    var dropdown = div.append("select").attr("name", field.field + " type dropdown")
        .attr("id", field.field)
        .on("change", function () {
            changeFieldType(this, field, demographicsObject,div.node().parentNode);
        });

    (demographicsTypes || ["Text", "Integer"]).forEach(type => {
        dropdown.append("option").attr("value", type).text(type);
    })
    console.log("Setting dropdown for " + field.field + " to type: " + field.type);
    dropdown.property("value", field.type);
}

function changeFieldType(select, field, demographicsObject, tableRowElement) {
    var newType = select.value;
    const targetField = (demographicsObject.options || []).find(f => f.field === field.field);

    if (targetField && targetField.type !== newType) {
        if (targetField.values && targetField.values.length > 0) {
             if (confirm(`Changing type for "${targetField.field}" from ${targetField.type} to ${newType} will clear its current ${targetField.values.length} predefined value(s). Continue?`)) {
                targetField.type = newType;
                targetField.values = []; 
            } else {
                select.value = targetField.type; 
                return;
            }
        } else {
             targetField.type = newType; 
        }
        console.log("Field " + targetField.field + " type changed to: " + newType);
        const valuesCellTd = d3.select(tableRowElement).select("td:nth-child(3)");
        if (!valuesCellTd.empty()) {
             renderValuesCellContent(valuesCellTd, targetField, d3.select("#attributes-window"), demographicsObject);
        }
        persistDemographicsObject(demographicsObject);
    }
}


function renderValuesCellContent(valuesCellTd, field, demographicsWindow, demographicsObject) {
    valuesCellTd.html(""); 
    valuesCellTd.style("cursor", "default").attr("title", null).on("click", null);

    const contentWrapper = valuesCellTd.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "center");

    if (field.type === "Text") {
        const values = field.values || [];
        const valueCountText = `${values.length} value${values.length !== 1 ? 's' : ''}`;

        contentWrapper.append("span").text(valueCountText);

        valuesCellTd.style("cursor", "pointer")
                   .attr("title", "Click to edit values")
                   .on("click", function() {
                      tempDemoObj = structuredClone(demographicsObject);
                      const fieldInTempForModal = (tempDemoObj.options || []).find(f => f.field === field.field);
                      if (fieldInTempForModal) {
                        createAttributeValuesModal(fieldInTempForModal, demographicsWindow, demographicsObject);
                      } else {
                        console.error("Could not find field in tempDemoObj for modal:", field.field);
                      }
                   });
        contentWrapper.append("span")
            .html(" ✏️")
            .style("margin-left", "8px")
            .style("font-size", "1.1em")
            .attr("title", "Edit values");
    } else {
        contentWrapper.append("span")
            .style("color", "#98A2B3")
            .style("font-style", "italic")
            .text("N/A (free entry)");
        valuesCellTd.style("cursor", "default").attr("title", `Predefined values not applicable for type: ${field.type}`).on("click", null);
    }
}

function createAttributeValuesModal(fieldInTempObj, demographicsWindow, mainDemographicsObject) {

    demographicsWindow.select("#attribute-values-editor-modal").remove();

    var modalContainer = demographicsWindow.append("div") 
        .attr("class", "modal fade show") 
        .attr("id", "attribute-values-editor-modal")
        .style("display", "block") 
        .style("background-color", "rgba(0,0,0,0.5)");

    var modalDialog = modalContainer.append("div")
        .attr("class", "modal-dialog modal-dialog-centered modal-dialog-scrollable");
    var modalContent = modalDialog.append("div").attr("class", "modal-content");

    var header = modalContent.append("div").attr("class", "modal-header");
    header.append("h5").attr("class", "modal-title")
          .text(`Attribute Values: ${camelCaseToTitleCase(fieldInTempObj.field)}`); 
    header.append("button").attr("type", "button").attr("class", "btn-close")
          .on("click", () => { 
              demographicsWindow.select("#attribute-values-editor-modal").remove();
          });

    var body = modalContent.append("div").attr("class", "modal-body");
    renderModalValueRows(body, fieldInTempObj);

    var footer = modalContent.append("div").attr("class", "modal-footer");
    footer.append("button").attr("type", "button").attr("class", "btn btn-secondary").text("Cancel")
          .on("click", () => {
              demographicsWindow.select("#attribute-values-editor-modal").remove();
          });
        footer.append("button").attr("type", "button").attr("class", "btn btn-primary").text("Apply")
          .on("click", () => {

              const leftoverInput = document.getElementById("new-attribute-value-input");
              if (leftoverInput) {
                  const leftoverVal = leftoverInput.value.trim();
                  if (leftoverVal) {
                      if (!fieldInTempObj.values) fieldInTempObj.values = [];
                      if (!fieldInTempObj.values.includes(leftoverVal)) {
                          fieldInTempObj.values.push(leftoverVal);
                      }
                  }
              }
              const targetFieldInMain = (mainDemographicsObject.options || []).find(f => f.field === fieldInTempObj.field);
              if (targetFieldInMain) {
                  targetFieldInMain.values = fieldInTempObj.values ? fieldInTempObj.values.slice() : []; 
              }
              tempDemoObj = structuredClone(mainDemographicsObject); 

              persistDemographicsObject(mainDemographicsObject);
              demographicsWindow.select("#attribute-values-editor-modal").remove();
              buildTable(d3.select(".attr-wrapper .table"), demographicsWindow, mainDemographicsObject);
          });
}

function renderModalValueRows(modalBody, fieldInTempObj) { 
    modalBody.html(""); 

    (fieldInTempObj.values || []).forEach(value => {
        const rowGroup = modalBody.append("div").attr("class", "input-group mb-2");
        rowGroup.append("input")
            .attr("type", "text").attr("class", "form-control").property("value", value)
            .attr("readonly", true); 
        rowGroup.append("button").attr("type", "button").attr("class", "btn btn-outline-danger")
            .html("×") 
            .on("click", function() {
                const indexToRemove = (fieldInTempObj.values || []).indexOf(value);
                if (indexToRemove > -1) {
                    fieldInTempObj.values.splice(indexToRemove, 1);
                }
                renderModalValueRows(modalBody, fieldInTempObj);
            });
    });

    const addValueGroup = modalBody.append("div").attr("class", "input-group mt-2");
    const newValueInput = addValueGroup.append("input")
        .attr("type", "text").attr("class", "form-control")
        .attr("id", "new-attribute-value-input")
        .attr("placeholder", "Add new value");

    function addCurrentValue() {
        const val = newValueInput.property("value").trim();
        if (val) {
            if (!fieldInTempObj.values) fieldInTempObj.values = [];
            if (!fieldInTempObj.values.includes(val)) {
                fieldInTempObj.values.push(val);
            } else {
                alert(`Value "${val}" already exists for this attribute.`);
            }
            renderModalValueRows(modalBody, fieldInTempObj);
            document.getElementById("new-attribute-value-input")?.focus();
        }
    }

    addValueGroup.append("button").attr("type", "button").attr("class", "btn btn-outline-success")
        .text("+ Add")
        .on("click", addCurrentValue);

    newValueInput.node().addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
            event.preventDefault();
            addCurrentValue();
        }
    });
}
function cancelChanges(demographicsObject) {
    demographicsObject.options.forEach(option => {
        var tempField = tempDemoObj.options.find((f) => f.field === option.field);
        option.values = tempField.values.slice();
    })
}

function saveChanges(demographicsObject) {
    tempDemoObj = structuredClone(demographicsObject);
    const projectId = localStorage.getItem("currentProjectId");
    const demoKey = projectId ? `demographicsObject_${projectId}` : "demographicsObject";
    localStorage.setItem(demoKey, JSON.stringify(demographicsObject));
    editAttributes(demographicsObject)
}
function removeValue(demographicsObject, row, selection, field, value) {
    row.remove();
    var values = demographicsObject.options.find((f) => f.field === field.field).values
    values.splice(values.indexOf(value), 1);
    const projectId = localStorage.getItem("currentProjectId");
    const demoKey = projectId ? `demographicsObject_${projectId}` : "demographicsObject";
    localStorage.setItem(demoKey, JSON.stringify(demographicsObject));
}

function addTrashcan(demographicsObject, row, selection, field, value) {
    var svg =
        selection.append("button").attr("type", "button").on("click", () => { removeValue(demographicsObject, row, selection, field, value) })
            .append("svg")
            .attr("width", "18")
            .attr("height", "20")
            .attr("viewBox", "0 0 18 20")
            .attr("fill", "none");
    svg.append("path")
        .attr("stroke", "black")
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("d", "M15.6667 4.11111L15.1156 13.0222C14.9751 15.2987 14.9049 16.4373 14.3333 17.256C14.0512 17.6606 13.6879 18.0021 13.2667 18.2587C12.416 18.7778 11.2756 18.7778 8.99467 18.7778C6.71022 18.7778 5.568 18.7778 4.71556 18.2578C4.29412 18.0006 3.93086 17.6586 3.64889 17.2533C3.07822 16.4338 3.00889 15.2933 2.872 13.0133L2.33333 4.11111M1 4.11111H17M12.6053 4.11111L11.9982 2.85956C11.5956 2.02756 11.3938 1.61244 11.0462 1.35289C10.969 1.29539 10.8873 1.24426 10.8018 1.2C10.4169 1 9.95467 1 9.03111 1C8.08356 1 7.60978 1 7.21778 1.208C7.13113 1.25441 7.04847 1.30793 6.97067 1.368C6.61956 1.63733 6.42311 2.06844 6.03022 2.92978L5.49156 4.11111");
}

function camelCaseToTitleCase(text) {
    return text.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase())
}

function getUniqueValues(field, data = Storedtranscript) {
    if (!data || typeof data !== 'object') {
        console.warn(`Invalid or missing data for field "${field}"`);
        return [];
    }

    const uniqueValues = new Set();

    Object.keys(data).forEach(participant => {
        const participantData = data[participantKey];
        if (participantData && participantData.hasOwnProperty(fieldObject.field)) {
            const val = participantData[fieldObject.field];
            if (val !== undefined && val !== null && String(val).trim() !== '') {
                uniqueValues.add(String(val));
            }
        }
    });

    return Array.from(uniqueValues);
}
