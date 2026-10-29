const OVERLAY_ID = "app-waiting-overlay";
const STYLE_ID = "app-waiting-overlay-style";

function ensureWaitingScreenStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
@keyframes app-waiting-dot-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-4px); }
}
#${OVERLAY_ID} .app-waiting-dot {
  animation: app-waiting-dot-bounce 1s infinite;
}
@media (prefers-reduced-motion: reduce) {
  #${OVERLAY_ID} .app-waiting-dot { animation: none !important; }
}
`;
  document.head.appendChild(style);
}

export function scopeAppPath(path) {
  const rawPath = String(path || "/").trim() || "/";
  if (/^(?:https?:)?\/\//i.test(rawPath) || rawPath.startsWith("#")) return rawPath;
  const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (normalized === "/demo" || normalized.startsWith("/demo/")) return normalized;
  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  return pathname === "/demo" || pathname.startsWith("/demo/")
    ? `/demo${normalized}`
    : normalized;
}

export function hideWaitingScreen() {
  document.getElementById(OVERLAY_ID)?.remove();
  document.documentElement.removeAttribute("aria-busy");
}

export function showWaitingScreen({
  title = "Please wait",
  message = "Loading the next page...",
} = {}) {
  ensureWaitingScreenStyles();
  hideWaitingScreen();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.setAttribute("aria-atomic", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(229, 229, 229, 0.58)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    zIndex: "99999",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "wait",
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    background: "#ffffff",
    borderRadius: "14px",
    width: "420px",
    maxWidth: "calc(100vw - 40px)",
    padding: "26px 24px",
    boxShadow: "0 8px 28px rgba(0, 0, 0, 0.16)",
    fontFamily: "Inter, sans-serif",
    textAlign: "center",
  });

  const titleNode = document.createElement("div");
  titleNode.className = "app-waiting-title";
  titleNode.textContent = title;
  Object.assign(titleNode.style, {
    fontSize: "22px",
    fontWeight: "700",
    color: "#111827",
  });

  const messageNode = document.createElement("div");
  messageNode.className = "app-waiting-message";
  messageNode.textContent = message;
  Object.assign(messageNode.style, {
    fontSize: "14px",
    lineHeight: "1.45",
    marginTop: "10px",
    color: "#4b5563",
  });

  const dots = document.createElement("div");
  Object.assign(dots.style, {
    display: "flex",
    gap: "8px",
    justifyContent: "center",
    alignItems: "center",
    marginTop: "16px",
  });
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.className = "app-waiting-dot";
    Object.assign(dot.style, {
      width: "10px",
      height: "10px",
      borderRadius: "50%",
      background: "#3A61DD",
      display: "inline-block",
      animationDelay: `${index * 0.16}s`,
    });
    dots.appendChild(dot);
  }

  panel.append(titleNode, messageNode, dots);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.documentElement.setAttribute("aria-busy", "true");
  return overlay;
}

function waitForOverlayPaint() {
  if (typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

export async function navigateWithWaitingScreen(path, options = {}) {
  const destination = scopeAppPath(path);
  showWaitingScreen(options);
  await waitForOverlayPaint();
  window.location.assign(destination);
}

if (typeof window !== "undefined") {
  window.addEventListener("pageshow", hideWaitingScreen);
}
