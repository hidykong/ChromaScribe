import { selectedGraphObject,kObject } from "../../chromascribe-main.js";
import { calculateTime } from "../../calculateTime.js";

var audioCount = 0, audioParticipant;
export function readAudio(data1){
	var audioData = d3.csvParse(data1);
	selectedGraphObject.selectedGraph = [];
	audioCount = 0;
	var frequencies = [], graph = [], times = [], volumes = [];
	// Count the number of seconds and create volumes/frequencies array, check participant
	for (var key in audioData){
		if (audioCount===0)
			audioParticipant = audioData[key].Volume;
		else {
			volumes.push(parseFloat(Math.abs(audioData[key].Volume)));
			if (kObject.k < 5)
				frequencies.push(0);
			else
				frequencies.push(parseFloat(audioData[key].Frequency));
		}
		audioCount++;
	}
	//secondsAudio = (audioData.length-1)/10; // 10 samples per second

	// set NaN values to zero
	for (var i=0; i<volumes.length; i++){
		if (isNaN(volumes[i]))
			volumes[i] = 0;
	}
	for (var i=0; i<frequencies.length; i++){
		if (isNaN(frequencies[i]))
			frequencies[i] = 0;
	}
	// times array for x-axis
	var secondCount = -1;
	for (var i=0; i<audioData.length-1; i++){
		if (i%10===0){
			secondCount++;
			times.push(calculateTime(secondCount)+":000");
		}
		else
			times.push(calculateTime(secondCount)+":"+(i%10)*100);
	}
	// Check for unusual frequencies
	for (var i=0; i<frequencies.length; i++){
		if (frequencies[i]>20000){
			if(i!=frequencies.length-1)
				frequencies[i] = frequencies[i+1];
			else
				frequencies[i] = frequencies[i-1];
		}
	}
	// Store all data in one structure
	var currentValue = frequencies[0]; 
	for (var i=0; i<audioData.length-1; i++){
		if (kObject.k >= 10){
			if (i===0 || Math.abs(currentValue-frequencies[i]) > 100){
				currentValue = frequencies[i];
				graph.push({time: times[i], 
					frequency: frequencies[i],
					volume: volumes[i],
					participant: audioParticipant});
			}
		}
		else {
			graph.push({time: times[i], 
				frequency: frequencies[i],
				volume: volumes[i],
				participant: audioParticipant});
		}
	}
	
	if (kObject.k<5){
		for (var i=0; i<graph.length; i++){
			if (i%50===0)
				selectedGraphObject.selectedGraph.push(graph[i]);
		}
	}
	else if (kObject.k >= 5 && kObject.k < 10){
		for (var i=0; i<graph.length; i++){
			if (i%10===0)
				selectedGraphObject.selectedGraph.push(graph[i]);
		}
	}
	else
		selectedGraphObject.selectedGraph = graph;
}