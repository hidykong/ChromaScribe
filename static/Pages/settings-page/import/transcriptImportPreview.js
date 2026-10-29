export function appendTranscriptImportPreview(container, entry, onChange) {
  const summary = entry.importSummary;
  if (!summary) return;

  const speakers = Array.isArray(summary.speakers) ? summary.speakers : [];
  const timing = summary.hasTimestamps ? "Timestamps available" : "No timestamps";
  const details = container.append("details")
    .attr("class", "transcript-import-preview")
    .style("flex-basis", "100%")
    .style("margin-top", "10px")
    .style("white-space", "normal");
  details.append("summary")
    .style("cursor", "pointer")
    .text(`Review import: ${summary.segmentCount} segments · ${speakers.length} speakers · ${timing}`);

  if (!summary.hasTimestamps) {
    details.append("p")
      .text("You can still tag questions and generate codes. Audio seeking is unavailable for segments without timestamps.");
  }
  for (const warning of summary.warnings || []) {
    details.append("p").style("color", "#854d0e").text(warning);
  }

  if (speakers.length > 0) {
    details.append("p").text("Check who is asking and answering questions. Change any incorrect speaker roles below.");
  }
  for (const speaker of speakers) {
    const label = details.append("label")
      .style("display", "flex")
      .style("align-items", "center")
      .style("flex-wrap", "wrap")
      .style("gap", "8px")
      .style("margin", "8px 0");
    label.append("span").text(speaker.label || "Unlabelled speaker");
    const select = label.append("select")
      .attr("aria-label", `Role for ${speaker.label || "unlabelled speaker"}`);
    const roles = [
      ["unknown", "Not sure"],
      ["interviewer", "Interviewer"],
      ["participant", "Participant"]
    ];
    for (const [value, title] of roles) {
      select.append("option").attr("value", value).text(title);
    }
    select.property("value", entry.speakerRoles?.[speaker.label] || speaker.role || "unknown")
      .on("change", function() {
        entry.speakerRoles = { ...entry.speakerRoles, [speaker.label]: this.value };
        onChange();
      });
  }

  details.append("p").text("Transcript preview (first 8 segments):");
  const preview = details.append("div")
    .style("max-height", "260px")
    .style("overflow-y", "auto")
    .style("padding", "12px")
    .style("background", "white")
    .style("border", "1px solid #d1d5db")
    .style("border-radius", "6px");
  for (const segment of entry.preview || []) {
    const paragraph = preview.append("p").style("white-space", "pre-wrap");
    const speaker = segment.speakerLabel || "Unlabelled speaker";
    paragraph.append("strong").text(`${segment.timestamp || "No timestamp"} · ${speaker}: `);
    paragraph.append("span").text(segment.script);
  }
}
