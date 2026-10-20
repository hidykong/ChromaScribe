import { startThemeEditing } from "./themes/startThemeEditing.js";
import { startImport } from "./import/startImport.js";
import { showMenu } from "../main-page/demographicFiltering.js";
import { navigateWithWaitingScreen } from "../pageTransitionOverlay.js?v=20260901a";

let isCollapsed = false;         // manual collapse state (via button)
let autoCollapsed = false;       // auto-collapse state (via resize threshold)
const EXPANDED_WIDTH = 220;      // px; smaller than old "16%" for consistency
const COLLAPSED_WIDTH = 72;      // px; icon rail
const LABEL_MIN_WIDTH = 180;     // px; below this we auto-collapse
const SMALL_FONT = "16px";       // uniform smaller font across sidebar
const LOGO_FONT = "24px";        // smaller logo font

const TAB_ROW_MARGIN_EXPANDED = "14px 20px";
const TAB_ROW_PADDING = "10px 12px";
const TAB_ICON_SIZE_EXPANDED = 18;
const TAB_ICON_SIZE_COLLAPSED = 20;

fetch('/api/session_context', { cache: "no-store" })
    .then(r => r.json())
    .then(data => {
      const currentProjectId = String(data?.currentProjectId || "").trim();
      if (currentProjectId) {
        localStorage.setItem("currentProjectId", currentProjectId);
      }
    })
    .catch(() => {});

export function showSettings() {
  // Reset and show settings
  d3.select("#settingsTabs").selectAll("*").remove();
  const settings = d3.select("#settingsTabs");

  d3.select("#main-page").style("display", "none");
  d3.select("#settings-page").style("display", "flex");
  d3.select("#settingsTabs").style("display", "block");

  // Make the sidebar visually distinct and full height
  settings
    .style("position", "relative")
    .style("height", "100vh")        // full height to the bottom of the screen
    .style("min-height", "100vh")
    .style("background", "#ffffff")
    // >>> UPDATED: bold, black divider line that runs to the bottom
    .style("border-right", "1px solid #000000")
    .style("overflow-y", "auto")
    .style("overflow-x", "hidden")
    .style("z-index", "3");          // keep border visible over bottom bar overlays

  // Start with expanded width; resize handler may auto-collapse below
  settings.style("width", EXPANDED_WIDTH + "px");

  // --- Header / Logo ---
  settings.append("div")
    .attr("id", "logo")
    .style("padding", "16px 20px")
    .style("font-size", LOGO_FONT)
    .style("font-family", "Nunito")
    .style("font-weight", "700")
    .text("ChromaScribe")
    .on("click", () => { window.location.href = "/"; });

  // --- Collapse toggle (acts as manual override) ---
  const collapse = settings.append("div")
    .attr("id", "collapse-tab")
    .attr("class", "tabs")
    .style("cursor", "pointer")
    .on("click", () => {
      isCollapsed = !isCollapsed;
      applyCollapse(isCollapsed);
    });

  const collapseInner = collapse.append("div")
    .attr("class", "tab-inner")
    .style("display", "flex")
    .style("align-items", "center")
    .style("gap", "8px")
    .style("white-space", "nowrap")
    .style("margin", TAB_ROW_MARGIN_EXPANDED)
    .style("width", `${EXPANDED_WIDTH - 40}px`)
    .style("font-size", SMALL_FONT)
    .style("border-radius", "10px")
    .style("padding", TAB_ROW_PADDING);

  collapseInner.append("img")
    .attr("class", "tab-icon collapse-icon")
    .attr("src", "/static/images/Collapse.png")
    .attr("alt", "Collapse");

  collapseInner.append("span")
    .attr("class", "tab-label")
    .text("Collapse");

  // --- Tabs container ---
  const tabs = settings.append("div")
    .attr("id", "tabs")
    .style("margin-top", "10px");

  // Helper to add one tab row
  function addTab(id, label, icon, clickHandler) {
    const row = tabs.append("div")
      .attr("id", id)
      .attr("class", "tabs")
      .style("cursor", "pointer")
      .on("click", function () {
        clickTab(this);
        clickHandler();
      });

    const inner = row.append("div")
      .attr("class", "tab-inner")
      .style("display", "flex")
      .style("align-items", "center")
      .style("gap", "8px")
      .style("white-space", "nowrap")
      .style("width", `${EXPANDED_WIDTH - 40}px`)
      .style("margin", TAB_ROW_MARGIN_EXPANDED)
      .style("font-size", SMALL_FONT)   // smaller font overall
      .style("border-radius", "10px")
      .style("padding", TAB_ROW_PADDING);

    inner.append("img")
      .attr("class", "tab-icon")
      .attr("src", icon)
      .attr("alt", `${label} icon`);

    inner.append("span")
      .attr("class", "tab-label")
      .text(label);

    return row;
  }

  // Tabs
  addTab("import-tab", "File Manager", "/static/images/Disable_Filesmanager.png", () => {
    void navigateWithWaitingScreen("/fileManager", {
      title: "Loading File Manager",
      message: "Preparing your project files...",
    });
  });

  addTab("themes-tab", "Codes", "/static/images/Disable_Themes.png", () => {
    void navigateWithWaitingScreen("/themes", {
      title: "Loading Codes Manager",
      message: "Preparing your codes and archived items...",
    });
  });

  addTab("visualization-tab", "Visualization", "/static/images/Disable_Visualization.png", () => {
    void navigateWithWaitingScreen("/visualization", {
      title: "Loading Visualization",
      message: "Preparing the visualization panel...",
    });
  });

  addTab("transcript-tab", "Transcript", "/static/images/Disable_editor.png", () => {
    void navigateWithWaitingScreen("/transcriptmode", {
      title: "Loading Transcript",
      message: "Preparing transcript data and codes...",
    });
  });

  addTab("demographics-tab", "Demographics", "/static/images/Disable_Demographics.png", () => {
    void navigateWithWaitingScreen("/demographics", {
      title: "Loading Demographics",
      message: "Preparing participant attributes...",
    });
  });

  // Tooltips (tippy) – optional, unchanged ids
  tippy('#import-tab', { content: 'File Manager', placement: 'right', theme: 'blue-theme', trigger: 'mouseenter focus' });
  tippy('#themes-tab', { content: 'Codes', placement: 'right', theme: 'blue-theme' });
  tippy('#demographics-tab', { content: 'Demographics', placement: 'right', theme: 'blue-theme' });
  tippy('#visualization-tab', { content: 'Visualization', placement: 'right', theme: 'blue-theme' });
  tippy('#transcript-tab', { content: 'Transcript', placement: 'right', theme: 'blue-theme' });

  // Initial paint: collapsed look (icons only) OFF, then auto-adjust by width
  applyCollapse(false);
  setupAutoCollapse();
}
/* ------------ Collapse / Expand styles ------------ */
function applyCollapse(collapsed) {
  const settings = d3.select("#settingsTabs");

  if (collapsed) {
    settings.style("width", COLLAPSED_WIDTH + "px");

    d3.selectAll("#settingsTabs .tab-inner")
      .style("margin", "14px auto")
      .style("width", "40px")
      .style("justify-content", "center");

    d3.selectAll("#settingsTabs .tab-icon")
      .style("width", `${TAB_ICON_SIZE_COLLAPSED}px`)
      .style("height", `${TAB_ICON_SIZE_COLLAPSED}px`);

    d3.selectAll("#settingsTabs .tab-label")
      .style("display", "none");

    d3.select("#collapse-tab .collapse-icon")
      .style("transform", "rotate(180deg)");

    d3.select("#logo").html('<img src="/static/images/ChromascribeLogo.png" style="width: 36px; height: 36px; vertical-align: middle;" alt="Icon"/>');

  } else {
    settings.style("width", EXPANDED_WIDTH + "px");

    d3.selectAll("#settingsTabs .tab-inner")
      .style("margin", TAB_ROW_MARGIN_EXPANDED)
      .style("width", `${EXPANDED_WIDTH - 40}px`)
      .style("justify-content", "flex-start");

    d3.selectAll("#settingsTabs .tab-icon")
      .style("width", `${TAB_ICON_SIZE_EXPANDED}px`)
      .style("height", `${TAB_ICON_SIZE_EXPANDED}px`);

    d3.selectAll("#settingsTabs .tab-label")
      .style("display", "inline");

    d3.select("#collapse-tab .collapse-icon")
      .style("transform", "rotate(0deg)");
    
    d3.select("#logo")
      .text("ChromaScribe")
      .style("font-size", LOGO_FONT);
  }
}

// Add a viewport-based breakpoint for auto-collapse
const VIEWPORT_BREAKPOINT = 900; // px — tweak to taste

/* ------------ Auto-collapse when viewport is small; restore when large ------------ */
function setupAutoCollapse() {
  function autoCollapseAccordingToWidth() {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const shouldAutoCollapse = vw < VIEWPORT_BREAKPOINT;

    // Go to collapsed (auto) when viewport is small
    if (shouldAutoCollapse && !autoCollapsed) {
      autoCollapsed = true;
      applyCollapse(true);
    }

    // Come back to expanded when viewport is large,
    // but don't override a user’s manual collapse.
    if (!shouldAutoCollapse && autoCollapsed && !isCollapsed) {
      autoCollapsed = false;
      applyCollapse(false);
    }
  }

  // Initial evaluation
  autoCollapseAccordingToWidth();

  // Re-bind listener (avoid stacking)
  window.removeEventListener("resize", autoCollapseAccordingToWidth);
  window.addEventListener("resize", autoCollapseAccordingToWidth, { passive: true });

  // (Optional) handle device rotation on mobile/tablet
  window.removeEventListener("orientationchange", autoCollapseAccordingToWidth);
  window.addEventListener("orientationchange", autoCollapseAccordingToWidth);
}

/* ------------ Helpers (unchanged) ------------ */
export function toggleCollapse(forceCollapsed) {
  isCollapsed = !!forceCollapsed;
  applyCollapse(isCollapsed);
}

function clickTab(element) {
  d3.selectAll("#settingsTabs .tabs .tab-inner").style("background", "#ffffff");
  d3.select(element).select(".tab-inner").style("background", "#3A61DD1F");
}

/* ------------ Filter panel (kept, with width constants) ------------ */
export function showFilterSettings() {
  if (!d3.select("#filterPanel").empty()) return;

  const settings = d3.select("#settingsTabs");

  settings.style("width", Math.max(EXPANDED_WIDTH, 250) + "px");
  d3.select("#vis-holder").classed("shifted", true);

  settings.select("#tabs").style("display", "none");
  settings.select("#logo").style("display", "none");
  settings.select("#collapse-tab").style("display", "none");

  const filterPanel = settings.append("div").attr("id", "filterPanel");

  filterPanel.append("div")
    .attr("class", "tabs")
    .style("cursor", "pointer")
    .on("click", () => {
      d3.select("#filterPanel").remove();
      settings.select("#tabs").style("display", "block");
      settings.select("#logo").style("display", "block");
      settings.select("#collapse-tab").style("display", "block");
      settings.style("width", (isCollapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH) + "px");
      d3.select("#vis-holder").classed("shifted", false);
      applyCollapse(isCollapsed);
    })
    .append("div")
    .style("width", EXPANDED_WIDTH + "px")
    .style("margin", "14px 20px")
    .style("font-size", SMALL_FONT)
    .style("border-radius", "10px")
    .style("padding", "10px 12px")
    .html('<span style="font-size: 20px; line-height: 0; vertical-align: middle;">←</span> Back to Menu');

  const filterContainer = filterPanel.append("div")
    .attr("id", "filter-ui-container")
    .style("padding", "0 20px");

  showMenu(filterContainer);
}

export function toggleFilterView() {
  if (d3.select("#filterPanel").empty()) {
    showFilterSettings();
  } else {
    d3.select("#filterPanel").remove();
    d3.select("#vis-holder").classed("shifted", false);
    showSettings();
    toggleCollapse(true);
  }
}
