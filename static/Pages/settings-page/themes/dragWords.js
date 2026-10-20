/*
import { makeThemeBoxes } from "./makeThemeBoxes.js";
import { makeWordClouds } from "./makeWordClouds.js";
import { wordCloudShapeObject, wordSelectedAlreadyObject, themesObject, selectedThemeBoxObject, 
	tempThemesObject, mouseOverDeleteWordObject, currentBoxHeightObject, currentBoxWidthObject, showingStemmedWordsInstructionsObject, mouseOverDeleteStemmedWordObject } from "../../chromascribe-main.js";
import { showStemmedWords } from "./makeThemeBoxes.js";

export var dragWord = d3.drag()
	.on("start", onStartDragWord)
	.on("drag", onDragWord)
	.on("end", onEndDragWord);

var startClickTime, endClickTime;
var stemClick1 = 0, stemClick2 = 0;
export function onStartDragWord() {
	startClickTime = Date.now();
	if (this.parentNode.parentNode.parentNode.id.substring(9) === selectedThemeBoxObject.selectedThemeBox && currentBoxHeightObject.currentBoxHeight===280){
		d3.select("#deleteWord").remove();
		d3.select(this).raise().classed("active", true);
		d3.select(this).style("position", "absolute")
			.style("top", d3.event.y + this.parentNode.offsetTop - this.offsetHeight/2 - d3.select("#themeList").node().scrollTop)
			.style("left", d3.event.x + this.parentNode.offsetLeft - this.offsetWidth/2);
	}
	else if (showingStemmedWordsInstructionsObject.showingStemmedWordsInstructions && !mouseOverDeleteWordObject.mouseOverDeleteWord){
		if (stemClick1===0)
			stemClick1 = startClickTime;
		else {
			stemClick2 = startClickTime;
			if (stemClick2-stemClick1 <= 500)
				showStemmedWords(this, this.parentNode.id, this.id)
			stemClick1 = 0;
			stemClick2 = 0;
		}
	}
	else if (currentBoxHeightObject.currentBoxHeight!=280 && mouseOverDeleteWordObject.mouseOverDeleteWord){
		mouseOverDeleteWordObject.mouseOverDeleteWord = false;
		var index;
		for (var j=0; j<themesObject.themes.length; j++){
			if (themesObject.themes[j].themeName === selectedThemeBoxObject.selectedThemeBox)
				index = j;
		}
		tempThemesObject.tempThemes[index].words.push(themesObject.themes[index].words[this.id]);
		themesObject.themes[index].words.splice(this.id, 1);
		makeThemeBoxes(currentBoxHeightObject.currentBoxHeight, currentBoxWidthObject.currentBoxWidth);
		makeWordClouds();
		wordSelectedAlreadyObject.wordSelectedAlready = false;
	}
	else if (mouseOverDeleteStemmedWordObject.mouseOverDeleteStemmedWord){
		for (var i=0; i<themesObject.themes.length; i++){
			if (themesObject.themes[i].themeName === selectedThemeBoxObject.selectedThemeBox){
				themesObject.themes[i].words[this.parentNode.parentNode.id].stemmedWords.splice(this.id,1);
				d3.select(this).remove();
				mouseOverDeleteStemmedWordObject.mouseOverDeleteStemmedWord = false;
				var node = d3.select("#stemmedListBox").node().parentNode;
				showStemmedWords(node, node.parentNode.id, node.id)
			}
		}
	}
}

var dragToBox;
export function onDragWord() {
	if (this.parentNode.parentNode.parentNode.id.substring(9) === selectedThemeBoxObject.selectedThemeBox && currentBoxHeightObject.currentBoxHeight===280){
		dragToBox = "";
		d3.select(this).style("position", "absolute")
			.style("top", d3.event.y + this.parentNode.offsetTop - this.offsetHeight/2 - d3.select("#themeList").node().scrollTop)
			.style("left", d3.event.x + this.parentNode.offsetLeft - this.offsetWidth/2);
		for (var i=0; i < themesObject.themes.length; i++){
			if (d3.select(this).node().offsetLeft >= d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetLeft && 
			d3.select(this).node().offsetLeft <= d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetLeft+d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetWidth && 
			d3.select(this).node().offsetTop >= d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetTop - d3.select("#themeList").node().scrollTop && 
			d3.select(this).node().offsetTop <= d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetTop+d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetHeight - d3.select("#themeList").node().scrollTop){
				d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).style("background", "#d9d9d9");
				dragToBox = "themeBox_"+themesObject.themes[i].themeName.toLowerCase();
			}
			else
				d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).style("background", "none");
		}
	}
}

export function onEndDragWord() {
	endClickTime = Date.now();
	d3.select(this).classed("active", false);
	if (endClickTime-startClickTime < 200 && currentBoxHeightObject.currentBoxHeight===280){
		if (mouseOverDeleteWordObject.mouseOverDeleteWord){
			mouseOverDeleteWordObject.mouseOverDeleteWord = false;
			var index;
			for (var j=0; j<themesObject.themes.length; j++){
				if (themesObject.themes[j].themeName === selectedThemeBoxObject.selectedThemeBox)
					index = j;
			}
			tempThemesObject.tempThemes[index].words.push(themesObject.themes[index].words[this.id]);
			themesObject.themes[index].words.splice(this.id, 1);
			makeThemeBoxes(currentBoxHeightObject.currentBoxHeight, currentBoxWidthObject.currentBoxWidth);
			makeWordClouds();
			wordSelectedAlreadyObject.wordSelectedAlready = false;
		}
		else {
			makeThemeBoxes(currentBoxHeightObject.currentBoxHeight, currentBoxWidthObject.currentBoxWidth);
			makeWordClouds();
		}
		
	}
	else if (currentBoxHeightObject.currentBoxHeight===280 && this.parentNode.parentNode.parentNode.id.substring(9) === selectedThemeBoxObject.selectedThemeBox){
		if (dragToBox != ""){
			d3.select("#"+dragToBox).style("background", "none");
			if (d3.select(this).node().offsetLeft >= d3.select("#"+dragToBox).node().offsetLeft && 
			d3.select(this).node().offsetLeft <= d3.select("#"+dragToBox).node().offsetLeft+d3.select("#"+dragToBox).node().offsetWidth && 
			d3.select(this).node().offsetTop >= d3.select("#"+dragToBox).node().offsetTop - d3.select("#themeList").node().scrollTop && 
			d3.select(this).node().offsetTop <= d3.select("#"+dragToBox).node().offsetTop+d3.select("#"+dragToBox).node().offsetHeight - d3.select("#themeList").node().scrollTop){
				for (var i=0; i < themesObject.themes.length; i++){
					if (themesObject.themes[i].themeName === dragToBox.substring(9)){
						var originalIndex = 0;
						for (var j=0; j<themesObject.themes.length; j++){
							if (themesObject.themes[j].themeName === selectedThemeBoxObject.selectedThemeBox)
								originalIndex = j;
						}
						themesObject.themes[i].words.push(themesObject.themes[originalIndex].words[this.id]);
						themesObject.themes[originalIndex].words.splice(this.id, 1);
						selectedThemeBoxObject.selectedThemeBox = dragToBox.substring(9);
						d3.select(this).remove();
						makeThemeBoxes(280, 260);
						makeWordClouds();
					}
				}
			}
		}
		else 
			makeThemeBoxes(280, 260);
	}
	else if (currentBoxHeightObject.currentBoxHeight===280)
		makeThemeBoxes(currentBoxHeightObject.currentBoxHeight, currentBoxWidthObject.currentBoxWidth);
}

export var dragWordFromCloud = d3.drag()
	.on("start", onStartDragWordFromCloud)
	.on("drag", onDragWordFromCloud)
	.on("end", onEndDragWordFromCloud);

export function onStartDragWordFromCloud() {
	startClickTime = Date.now();
	d3.select(this).raise().classed("active", true);
	d3.select(this).style("position", "absolute")
		.style("top", d3.event.y + wordCloudShapeObject.wordCloudShape.node().offsetTop - this.offsetHeight/2)
		.style("left", d3.event.x + d3.select("#themeList").node().offsetWidth + d3.select("#settingsTabs").node().offsetWidth);
}

export function onDragWordFromCloud() {
	dragToBox = "";
	d3.select(this).style("position", "absolute")
		.style("top", d3.event.y + wordCloudShapeObject.wordCloudShape.node().offsetTop - this.offsetHeight/2)
		.style("left", d3.event.x + d3.select("#themeList").node().offsetWidth + d3.select("#settingsTabs").node().offsetWidth);
	for (var i=0; i < themesObject.themes.length; i++){
		if (d3.select(this).node().offsetLeft >= d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetLeft && 
		d3.select(this).node().offsetLeft <= d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetLeft+d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetWidth && 
		d3.select(this).node().offsetTop >= d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetTop - d3.select("#themeList").node().scrollTop && 
		d3.select(this).node().offsetTop <= d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetTop+d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).node().offsetHeight - d3.select("#themeList").node().scrollTop){
			d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).style("background", "#d9d9d9");
			dragToBox = "themeBox_"+themesObject.themes[i].themeName.toLowerCase();
		}
		else
			d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).style("background", "#f4f4f4");
	}
}

export function onEndDragWordFromCloud() {
	endClickTime = Date.now();
	d3.select(this).classed("active", false);
	if (endClickTime-startClickTime < 200){
		var themeIndex;
		for (var i=0; i<themesObject.themes.length; i++){
			if (themesObject.themes[i].themeName === selectedThemeBoxObject.selectedThemeBox)
				themeIndex = i;
		}
		themesObject.themes[themeIndex].words.push(tempThemesObject.tempThemes[themeIndex].words[this.id]);
		tempThemesObject.tempThemes[themeIndex].words.splice(this.id, 1);
	}
	else if (dragToBox != ""){
		d3.select("#"+dragToBox).style("background", "#f4f4f4");
		if (d3.select(this).node().offsetLeft >= d3.select("#"+dragToBox).node().offsetLeft && 
		d3.select(this).node().offsetLeft <= d3.select("#"+dragToBox).node().offsetLeft+d3.select("#"+dragToBox).node().offsetWidth && 
		d3.select(this).node().offsetTop >= d3.select("#"+dragToBox).node().offsetTop - d3.select("#themeList").node().scrollTop && 
		d3.select(this).node().offsetTop <= d3.select("#"+dragToBox).node().offsetTop+d3.select("#"+dragToBox).node().offsetHeight - d3.select("#themeList").node().scrollTop){
			for (var i=0; i < themesObject.themes.length; i++){
				d3.select("#themeBox_"+themesObject.themes[i].themeName.toLowerCase()).style("background", "#f4f4f4");
				if (themesObject.themes[i].themeName === dragToBox.substring(9)){
					var originalIndex;
					for (var j=0; j<tempThemesObject.tempThemes.length; j++){
						if (tempThemesObject.tempThemes[j].themeName === selectedThemeBoxObject.selectedThemeBox)
							originalIndex = j;
					}
					themesObject.themes[i].words.push(tempThemesObject.tempThemes[originalIndex].words[this.id]);
					tempThemesObject.tempThemes[originalIndex].words.splice(this.id, 1)
					selectedThemeBoxObject.selectedThemeBox = dragToBox.substring(9);
					d3.select(this).remove();
					makeThemeBoxes(280, 260);
					makeWordClouds();
				}
			}
		}
		else
			makeWordClouds();
	}
	d3.select(this).remove();
	makeThemeBoxes(280, 260);
	makeWordClouds();
}
*/
import { makeThemeBoxes } from "./makeThemeBoxes.js?v=20260620b";
import { makeWordClouds } from "./makeWordClouds.js?v=20260602a";
import {
  themesObject,
  selectedThemeBoxObject,
  multiSelectedWordsObject,
  tempThemesObject,
  wordSelectedAlreadyObject,
  currentBoxHeightObject,
  currentBoxWidthObject,
  mouseOverDeleteWordObject
} from "../../../chromascribe-main.js";

let selectedWord = null;
let selectedWordIndex = null;
let selectedWordSource = null; // "theme" or "cloud"

/** Handles word click from either theme box or cloud */
export function onWordClick(event) {
	const wordId = +this.id;
	const parentId = this.parentNode?.parentNode?.parentNode?.id || "";
	const isInThemeBox = parentId.startsWith("themeBox_");
	const source = isInThemeBox ? "theme" : "cloud";
  
	const alreadySelected = multiSelectedWordsObject.selectedWords.find(w => w.word === this);
	
	if (alreadySelected) {
	  // Deselect if already selected
	  d3.select(this).classed("selected", false);
	  multiSelectedWordsObject.selectedWords = multiSelectedWordsObject.selectedWords.filter(w => w.word !== this);
	} else {
	  // Add to multi-selection
	  d3.select(this).classed("selected", true);
	  multiSelectedWordsObject.selectedWords.push({
		word: this,
		index: wordId,
		source: source,
	  });
	}
  }
  

/** Handles theme box click to move selected word into the clicked theme */
export function onThemeBoxClick() {
const targetTheme = this.id.substring(9);
const targetIndex = themesObject.themes.findIndex(t => t.themeName === targetTheme);
const currentTheme = selectedThemeBoxObject.selectedThemeBox;
console.log(multiSelectedWordsObject)
if (!multiSelectedWordsObject.selectedWords.length) return;

for (const item of multiSelectedWordsObject.selectedWords) {
	const { word, index, source } = item;

	console.log(item)

	if (source === "theme") {
		const currentIndex = themesObject.themes.findIndex(t => t.themeName === currentTheme);
		if (currentIndex !== -1 && targetIndex !== -1 && currentIndex !== targetIndex) {
			themesObject.themes[targetIndex].words.push(themesObject.themes[currentIndex].words[index]);
			themesObject.themes[currentIndex].words.splice(index, 1);
		}
	} else if (source === "cloud") {
		const cloudIndex = tempThemesObject.tempThemes.findIndex(t => t.themeName === currentTheme);
		if (cloudIndex !== -1 && targetIndex !== -1) {
			themesObject.themes[targetIndex].words.push(tempThemesObject.tempThemes[cloudIndex].words[index]);
			tempThemesObject.tempThemes[cloudIndex].words.splice(index, 1);
			console.log("temp obj" +  tempThemesObject)
			console.log("item" + item)
		}
	}
	console.log(item)
	
	// makeThemeBoxes(currentBoxHeightObject.currentBoxHeight, currentBoxWidthObject.currentBoxWidth);
	// makeWordClouds();
}

// // Clear selection
// multiSelectedWordsObject.selectedWords = [];
// selectedThemeBoxObject.selectedThemeBox = targetTheme;

makeThemeBoxes(currentBoxHeightObject.currentBoxHeight, currentBoxWidthObject.currentBoxWidth);
makeWordClouds();
}
