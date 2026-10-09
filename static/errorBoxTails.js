// Draws a tail/arrow to an error message
export function addTail(errorBox, left){
	var tail = errorBox.append("svg")
		.style("position", "absolute")
		.style("width", "20px")
		.style("height", "15px")
		.style("margin-top", 31)
		.style("left", left)
		.append("path")
		.style("z-index", 6)
		.attr("stroke", "#e14947")
		.attr("stroke-width", "3px")
		.attr("fill", "#ffa3a3")
		.attr("d", "M 0,0, L 8,12, C 8 12, 10 15, 12 12, L 20,0 Z");
	var cover = errorBox.append("svg")
		.style("position", "absolute")
		.style("width", 22)
		.style("height", 4.5)
		.style("margin-top", 30)
		.style("left", left)
		.append("rect")
		.attr("width", "100%")
		.attr("height", "100%")
		.attr("fill", "#ffa3a3");
}