import { nameProject } from "./nameProject.js?v=20260601d";

export function startImport() {
    var mainEditWindow = d3.select("#main-edit-window");
	mainEditWindow.selectAll("*")
    .filter(function() { return this.id !== "themeCloudCode"; })
    .remove();
	mainEditWindow.style("flex-direction", "column")
		.style("align-items", "center");
	var text = mainEditWindow.append("div")
		.style("position", "absolute")
		.style("top", "35%")
		.style("text-align", "center")
		.style("width", "900px")
		.style("font-family", "Inter")
		.style("font-size", "34px")
		.style("font-weight", 700)
		.text("Welcome");
	var projectOptions = text.append("div")
		.style("flex-direction", "row")
		.style("margin-top", "30px")
		.style("font-family", "Nunito")
		.style("font-size", "20px");
	var continueProject = projectOptions.append("button")
		.style("margin-right", "30px")
		.style("border-radius", "10px")
		.style("width", "290px")
		.style("height", "250px")
		.text("Continue Project")
		.on("click", function() {
			mainEditWindow.selectAll("*").remove();
			mainEditWindow.style("flex-direction", "row")
				.style("align-items", "normal")
				.style("justify-content", "start");
			var backButton = mainEditWindow.append("button")
				.style("position", "absolute")
				.style("border-radius", "10px")
				.style("background", "#ececf0")
				.style("bottom", "28px")
				.style("margin-left", "36px")
				.style("padding", "12px 20px 12px 20px")
				.style("font-family", "Inter")
				.style("font-size", "16px")
				.style("font-weight", 700)
				.text("Back")
				.on("click", startImport);
		})
	var startNew = projectOptions.append("button")
		.style("border-radius", "10px")
		.style("width", "290px")
		.style("height", "250px")
		.text("Start New")
		.on("click", nameProject);
}
