import { xObject,kObject,yObject,interviewLengthsObject,selectedGraphObject,
    selectedParticipantObject,svgObject, participants, yAxisObject } from "../chromascribe-main.js";

var volumeOffset = function(volume) {
	if (volume===0)
		return 0;
	return Math.log(volume/1000); 
}

var yAudio = d3.scaleLinear()
			.range([50, 0])
			.domain([0, 500]);

var xAudio;
export function graphAudio(participant) {
	var timeScale = [], graph = [];
	//console.log(participant)
	//console.log(kObject)
	if (participant!=""){
		graph = selectedGraphObject.selectedGraph;
		for (var i=0; i<graph.length; i++)
			timeScale.push(graph[i].time);

		xAudio = d3.scaleBand()
			.range([0,xObject.x(interviewLengthsObject.interviewLengths[participant])*kObject.k]) 
			.domain(timeScale);
			
		
		// Draw path
		if (kObject.k < 5){
			//console.log(yAxisObject)
			svgObject.svg.selectAll()
			.data(graph)
			.enter()
			.append("rect")
			.attr("id", "audio-line")
			.attr("stroke", "steelblue")
			.attr("fill", "steelblue")
			.style("x", function(d) {return xAudio(d.time);})
			.style("width", function(d) {
				var index = graph.indexOf(d), nextAudio = graph[index];
				if (index < graph.length-1)
					nextAudio = graph[index+1];
				return xAudio(nextAudio.time)-xAudio(d.time);
			})
			.style("height", function(d) {return yAudio(d.volume);})
			.style("y", function(d) {return yObject.y(d.participant)+35-yAudio(d.volume)/2-15;})
			.style("ry", 5);
		}
		else {
			console.log("hi")
			svgObject.svg.selectAll()
			.data(graph)
			.enter()
			.append("path")
			.attr("id", "audio-line")
			.attr("stroke", function(d) {
				if (d.volume===0)
					return 'crimson';
				return 'steelblue';
			})
			.attr("fill", function(d) {
				if (d.volume===0)
					return 'crimson';
				return 'steelblue';
			})
			.attr("d", function(d) {
				// Move
				var move = "M " + (xAudio(d.time)-volumeOffset(d.volume)).toString() + "," +
						(yAudio(d.frequency)+yObject.y(d.participant)-30/2).toString() + ", ";
				// Lines
				var line1 = "L " + (xAudio(d.time)+volumeOffset(d.volume)).toString() + "," +
						(yAudio(d.frequency)+yObject.y(d.participant)-30/2).toString() + ", ";
				var index = graph.indexOf(d), nextAudio = graph[index];
				if (index < graph.length-1)
					nextAudio = graph[index+1];
				var line2 = "L " + (xAudio(nextAudio.time)+volumeOffset(nextAudio.volume)).toString() + "," +
						(yAudio(nextAudio.frequency)+yObject.y(d.participant)-30/2).toString() + ", ";
				var line3 = "L " + (xAudio(nextAudio.time)-volumeOffset(nextAudio.volume)).toString() + "," +
						(yAudio(nextAudio.frequency)+yObject.y(d.participant)-30/2).toString();
				// Close
				var close = " Z"
				return move + line1 + line2 + line3 + close;
			});
		}
	}
}

export function scaleAudio(){
	var graph = selectedGraphObject.selectedGraph;

	var times = [];
	for (var i=0; i<graph.length; i++)
		times.push(graph[i].time);

	var xAudioNew = d3.scaleBand()
		.range([0,xObject.x(interviewLengthsObject.interviewLengths[selectedParticipantObject.selectedParticipant])*kObject.k]) 
		.domain(times);
	
	if (kObject.k < 5){
		svgObject.svg.selectAll("#audio-line")
			.style("x", function(d) {return xAudioNew(d.time);})
			.style("width", function(d) {
				var index = graph.indexOf(d), nextAudio = graph[index];
				if (index < graph.length-1)
					nextAudio = graph[index+1];
				return xAudioNew(nextAudio.time)-xAudioNew(d.time);
			});
	}
	else {
		svgObject.svg.selectAll("#audio-line")
			.attr("d", function(d) {
				// Move
				var move = "M " + (xAudioNew(d.time)-volumeOffset(d.volume)).toString() + "," +
						(yAudio(d.frequency)+yObject.y(d.participant)-30/2).toString() + ", ";
				// Lines
				var line1 = "L " + (xAudioNew(d.time)+volumeOffset(d.volume)).toString() + "," +
						(yAudio(d.frequency)+yObject.y(d.participant)-30/2).toString() + ", ";
				var index = graph.indexOf(d), nextAudio = graph[index];
				if (index < graph.length-1)
					nextAudio = graph[index+1];
				var line2 = "L " + (xAudioNew(nextAudio.time)+volumeOffset(nextAudio.volume)).toString() + "," +
						(yAudio(nextAudio.frequency)+yObject.y(d.participant)-30/2).toString() + ", ";
				var line3 = "L " + (xAudioNew(nextAudio.time)-volumeOffset(nextAudio.volume)).toString() + "," +
						(yAudio(nextAudio.frequency)+yObject.y(d.participant)-30/2).toString();
				// Close
				var close = " Z";
				return move + line1 + line2 + line3 + close;
			});
	}
}