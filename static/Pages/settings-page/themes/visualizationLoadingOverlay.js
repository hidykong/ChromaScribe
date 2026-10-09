import {
  hideWaitingScreen,
  navigateWithWaitingScreen,
  showWaitingScreen,
} from "../../pageTransitionOverlay.js?v=20260901a";

export function hideVisualizationLoadingOverlay() {
  hideWaitingScreen();
}

export function showVisualizationLoadingOverlay(message = "Applying selected codes") {
  return showWaitingScreen({
    title: "Loading visualization",
    message,
  });
}

export function navigateToVisualizationWithOverlay(message = "Applying selected codes") {
  return navigateWithWaitingScreen("/visualization", {
    title: "Loading visualization",
    message,
  });
}
