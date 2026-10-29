import { xObject,transcriptsObject,firstClickObject,interviewLengthsObject,kObject,
    selectedParticipantObject,playObject, svgObject } from "../../chromascribe-main.js";
import { calculateTime } from "../../calculateTime.js";
import { barObject } from "./dragRedPlayBar.js";
import { semanticZoom } from "./semanticZoom.js";
import { setPlaybarAudioSource } from "./audioPlayBar.js";

var fullAudio = d3.select("#full-audiofile"), fullSlider = d3.select("#full-slider"), 
    fullTimestamp = d3.select("#full-current-time"), transcript = d3.select("#transcript");

export function playBarFromResult(d,view){
    svgObject.svg.selectAll("#bar").remove();
	console.log(firstClickObject.firstClick)
	fullAudio.node().pause();
				playObject.play=true;
				d3.select("#full-play-pause-holder")
				.attr("class","play");
				d3.select("#full-play-pause")
				.attr("src","../static/images/play-button.png");
	firstClickObject.firstClick
		if (!setPlaybarAudioSource(d.fullAudio)) return;
		var fullDuration = interviewLengthsObject.interviewLengths["P"+(d.fullAudio.substring(30, 32)*1).toString()];
		var durationInSeconds = fullDuration.substring(0,2)*1*60+fullDuration.substring(3)*1;
		fullSlider.attr("max", durationInSeconds);
		d3.select("#full-duration").text(fullDuration);
		fullSlider.property("value", d.timestamp.substring(0,2)*1*60+d.timestamp.substring(3)*1);
		fullTimestamp.text(d.timestamp);
		fullAudio.node().currentTime = d.timestamp.substring(0,2)*1*60+d.timestamp.substring(3)*1;
		barObject.bar.attr("x", xObject.x(d.timestamp)*kObject.k).raise();
		d3.select("#full-play-button").on("click", function(){
			barObject.bar.raise();
			fullSlider.property("value", Math.floor(fullAudio.node().currentTime));
			fullTimestamp.text(calculateTime(fullAudio.node().currentTime));
			if (playObject.play && selectedParticipantObject.selectedParticipant!=""){
				fullAudio.node().play();
				playObject.play=false;
				d3.select("#full-play-pause-holder")
				.attr("class", "pause");
				d3.select("#full-play-pause")
				.attr("src","../static/images/pause-button.png");
			}
			else {
				fullAudio.node().pause();
				playObject.play=true;
				d3.select("#full-play-pause-holder")
				.attr("class","play");
				d3.select("#full-play-pause")
				.attr("src","../static/images/play-button.png");
			}
		})
        


    //adjust the place in the audio when the user changes the slider value
fullSlider.on("input", function() {
	barObject.bar.raise();
	fullSlider.property("value", this.value);
	fullTimestamp.text(calculateTime(this.value));
	fullAudio.node().currentTime = this.value;
	d3.selectAll(".speech").style("opacity", 0.5);
	var participant = "P"+fullAudio.node().src.split(".mp3")[0].slice(-2)*1;
	var interview = transcriptsObject.transcripts[participant];
	var topOfSpeech, topOfPreviousSpeech = 0, topOfScroll = 10;
	//var time = calculateTime(this.value);
    console.log(interview)
	for (var i=0; i<interview.length; i++){
        
		if (this.value >= interview[i].timestamp.substring(0,2)*60+interview[i].timestamp.substring(3)*1){
			if (i!=interview.length-1){
				if (this.value < interview[i+1].timestamp.substring(0,2)*60+interview[i+1].timestamp.substring(3)*1){
					d3.select("#_"+i).style("opacity", 1);
					topOfSpeech = d3.select("#_"+i).node().offsetTop;
					if (topOfSpeech-topOfPreviousSpeech >= transcript.node().offsetHeight)
						topOfScroll = topOfSpeech - transcript.node().offsetHeight/2 + 100;
					else
						topOfScroll = topOfPreviousSpeech - 10;
					transcript.node().scrollTop = topOfScroll;
				}
			}
			else {
				d3.select("#_"+i).style("opacity", 1);
				transcript.node().scrollTop = 0;
			}
		}
		topOfPreviousSpeech = d3.select("#_"+i).node().offsetTop;
	}
});

//change the slider and timestamp as the audio plays
fullAudio.on("timeupdate", () => {
	barObject.bar.raise();
	fullSlider.property("value", Math.floor(fullAudio.node().currentTime));
	barObject.bar.attr("x", xObject.x(calculateTime(Math.floor(fullAudio.node().currentTime)))*kObject.k);
	fullTimestamp.text(calculateTime(fullAudio.node().currentTime));
	var participant = "P"+fullAudio.node().src.split(".mp3")[0].slice(-2)*1;
	var interview = transcriptsObject.transcripts[participant];
	var topOfSpeech, topOfPreviousSpeech = 0, topOfScroll = 10;
	var time = calculateTime(Math.floor(fullAudio.node().currentTime));
	if (fullAudio.node().ended){
		fullAudio.node().pause();
		fullAudio.node().currentTime = 0;
		playObject.play=true;
		d3.select("#full-play-pause-holder")
		.attr("class","play");
		d3.select("#full-play-pause")
		.attr("src","../static/images/play-button.png");
		fullSlider.property("value", 0);
		barObject.bar.attr("x", xObject.x("00:00"));
		fullTimestamp.text("00:00");
		d3.selectAll(".speech").style("opacity", 0.5);
		transcript.node().scrollTop = 0;
	}
	svgObject.svg.selectAll("#speech").each(function(d) {
		if (d.participant === participant && time >= d.timestamp && time < calculateTime(d.timestamp.substring(0,2)*60+d.timestamp.substring(3)*1+d.duration.substring(0,2)*60+d.duration.substring(3)*1) && selectedParticipantObject.selectedParticipant != ""){
			d3.selectAll("#speech").style("stroke", "none");
			d3.select(this).style("stroke", "black");
		}
	});
});
console.log(view)
semanticZoom(1,view)

	}
	
