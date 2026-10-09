import { readAudio } from "./readAudio.js";
import { 
    kObject, 
    lastKObject, 
    graphWidthObject, 
    xObject, 
    xTimeObject, 
    svgObject, 
    currentDisplayObject,} from "../../chromascribe-main.js";

import { calculateTime } from "../../calculateTime.js";
import { drag } from "./dragRedPlayBar.js";
import { barObject } from "./dragRedPlayBar.js";
//import { graphAudio, scaleAudio } from "./graphAudio.js";
import { drawVisualization } from "./drawVisualization.js?v=20260901b";
import { drawVisualization2 } from "./drawVisualization2.js?v=20260901b";

export function semanticZoom(kValue,view){
	
	// Step 1: Update the global zoom level state
    kObject.k = Number(kValue); // Ensure it's a number

	 // Step 2: Update the RANGE of our existing linear scales. The domain (in seconds) does not change.
    if (xObject.x && xTimeObject.xTime && graphWidthObject.graphWidth > 0) {
        const newRangeWidth = graphWidthObject.graphWidth * kObject.k;
        xObject.x.range([0, newRangeWidth]);
        xTimeObject.xTime.range([0, newRangeWidth]);
    } else {
        console.error("Cannot perform zoom: one or more required objects (xObject.x, xTimeObject.xTime, graphWidthObject) are not initialized.");
        return;
    }

	// Step 3: Call the appropriate main drawing function.
	if(view=="timeline"){
		drawVisualization(currentDisplayObject.currentDisplay)
	}else{
		drawVisualization2(currentDisplayObject.currentDisplay)
	}
	
	
	// Step 4: Update the UI for the zoom slider itself (the visual feedback)
	const zoomSlider = document.getElementById('zoom-slider');
    // The zoom-value element is optional, but if it exists, update it.
    const zoomValueDisplay = document.getElementById('zoom-value'); 

	  if (zoomSlider) {
        if (zoomValueDisplay) {
            // Your original code used this, if you add an element with id="zoom-value", it will work.
            zoomValueDisplay.textContent = `${Math.round(kObject.k * 10)}%`; 
        }

        // Update the slider's background fill
		const percentage = (kObject.k - zoomSlider.min) / (zoomSlider.max - zoomSlider.min) * 100;
		zoomSlider.style.background = `linear-gradient(to right, #0915ff ${percentage}%, #d3d3d3 ${percentage}%)`;
    }
	
	lastKObject.lastK = kObject.k; // Keep track of last zoom level if needed for other logic
}
// --- END OF FILE semanticZoom.js ---
