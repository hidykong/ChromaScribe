import { 
    graphWidthObject, xObject, yObject, svgObject, kObject,
    interviewLengthsObject, xTimeObject, currentDisplayObject
} from "../../../static/chromascribe-main.js";
import {
    getParticipantTimelineDurationSeconds,
    timeStringToSeconds
} from "./timeNormalization.js";

export function graphAxes(activeParticipants, view){
    console.log("graphAxes: Initializing for participants:", activeParticipants);
    
    // This now targets the <svg> element directly
    const graphSvg = d3.select("#graph");
    
    // Set margins/dimensions of the graph
    var margin = {top: 50, right: 30, bottom: 30, left: 60};
    var height = 94 * activeParticipants.length;
    
    // Set the height of the SVG container
    graphSvg.style("height", height + margin.top + margin.bottom);

    // Append the main <g> element for drawing, and clear any old content
    graphSvg.selectAll("g").remove();
    svgObject.svg = graphSvg.append("g")
        .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    let maxDurationSeconds = 0;
    if (view === 'timeline') {
        for (const pId of activeParticipants) {
            const timeStr = interviewLengthsObject.interviewLengths[pId];
            const duration = timeStringToSeconds(timeStr);
            if (duration > maxDurationSeconds) {
                maxDurationSeconds = duration;
            }
        }
    } else { // 'question' view
        currentDisplayObject.currentDisplay.forEach(participant => {
            if (participant.transcript && participant.transcript.length > 0) {
                const duration = getParticipantTimelineDurationSeconds(participant.transcript);
                if (duration > maxDurationSeconds) maxDurationSeconds = duration;
            }
        });
    }

    if (maxDurationSeconds === 0) maxDurationSeconds = 50 * 60; 
    console.log(`Max interview duration for X-axis: ${maxDurationSeconds} seconds.`);
         
    // --- SETUP X-AXIS SCALES ---
    xObject.x = d3.scaleLinear()
        .domain([0, maxDurationSeconds]) 
        .range([0, graphWidthObject.graphWidth * kObject.k]);

    xTimeObject.xTime = d3.scaleTime()
        .domain([ new Date(0).setSeconds(0), new Date(0).setSeconds(maxDurationSeconds) ])
        .range([0, graphWidthObject.graphWidth * kObject.k]);
    
    // --- Y-axis setup ---
    yObject.y = d3.scaleBand()
        .range([0, height])
        .domain(activeParticipants)
        .padding(.25);
    
    // --- CRITICAL FIX for SCROLLING ---
    // Calculate the total required width of the SVG content
    const totalContentWidth = xObject.x.range()[1]; 
    // Set the SVG element's width attribute to be larger than its container
    graphSvg.attr("width", totalContentWidth + margin.left + margin.right);
    // This will trigger the scrollbar on #graph-holder

    console.log("graphAxes: Scales configured. SVG width set for scrolling.");
}
