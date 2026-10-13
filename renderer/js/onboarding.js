// First-run welcome dialog + guided tour.
//
// UX layer only: nothing here starts a pipeline, clicks app controls on the
// user's behalf, or touches project data. Completion is remembered with two
// boolean flags in settings.json (via the existing save-settings IPC, which
// merges keys), so no main-process or preload change is needed.
(function () {
  function $(id) {
    return document.getElementById(id);
  }

  const SEEN_KEY = "onboardingSeen"; // welcome dialog handled (any choice)
  const TOUR_KEY = "tourSeen"; // tour finished or skipped

  async function remember(key) {
    try {
      await window.api.saveSettings({ [key]: true });
    } catch (e) {
      // Non-fatal: worst case the welcome dialog shows once more.
      window.ConsolePanel?.log("warn", `Could not save ${key}: ${e.message}`, "onboarding");
    }
  }

  // Keep Tab inside a container (dialogs are modal; the tour must never let
  // keyboard focus reach - and activate - the controls underneath it).
  function trapTab(e, container) {
    if (e.key !== "Tab") return;
    const items = [...container.querySelectorAll("button, [href], input, select")].filter(
      (el) => !el.disabled && el.getClientRects().length > 0,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!container.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  // ---------------- Welcome dialog ----------------
  let welcomeReturnFocus = null;

  function onWelcomeKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      dismissWelcome();
    } else {
      trapTab(e, document.querySelector("#welcome-modal .modal-content"));
    }
  }

  function showWelcome() {
    welcomeReturnFocus = document.activeElement;
    $("welcome-modal").classList.remove("hidden");
    document.addEventListener("keydown", onWelcomeKey);
    $("btn-welcome-new").focus();
  }

  function hideWelcome({ restoreFocus = true } = {}) {
    $("welcome-modal").classList.add("hidden");
    document.removeEventListener("keydown", onWelcomeKey);
    if (restoreFocus && welcomeReturnFocus && document.contains(welcomeReturnFocus)) {
      welcomeReturnFocus.focus();
    }
    welcomeReturnFocus = null;
  }

  function dismissWelcome(opts) {
    hideWelcome(opts);
    remember(SEEN_KEY);
  }

  // There is no separate "new project" action in the app: Analyze on the
  // Target tab already calls StateUtils.reset() and starts a fresh project, so
  // Create New just takes the user there. It deliberately does NOT reset state
  // itself - if a project is somehow already open, it is left untouched.
  function createNew() {
    const st = window.AppState || {};
    const hasWork = !!(st.id || st.pdbId || (st.candidates && st.candidates.length));
    dismissWelcome({ restoreFocus: false });
    if (hasWork) {
      window.ConsolePanel?.log(
        "info",
        "A project is already open, so nothing was changed. Run Analyze on the Target tab to start a new one.",
        "onboarding",
      );
      return;
    }
    window.App.switchTab("target");
    $("pdb-id-input")?.focus();
  }

  // Reuses the existing Load Project handler (list + modal + load logic).
  function loadExisting() {
    dismissWelcome({ restoreFocus: false });
    $("btn-load-project").click();
  }

  function tourFromWelcome() {
    dismissWelcome({ restoreFocus: false });
    startTour();
  }

  // ---------------- Guided tour ----------------
  const STEPS = [
    {
      sel: "#pipeline-nav",
      title: "Pipeline navigation",
      text: "Move through the four stages here: Target, Design, Screening and Construct. Click a stage to open it; the highlighted one is where you are now.",
      place: "bottom",
    },
    {
      sel: "#main-content",
      title: "Main workspace",
      text: "The selected stage's inputs and results appear here: choose a target, set up a design run, review candidates, then build your construct.",
      place: "left",
    },
    {
      sel: "#console-footer",
      title: "Live console",
      text: "Progress, diagnostic messages and execution logs stream here while tools run. Click its header to collapse or expand it.",
      place: "top",
    },
  ];

  const MARGIN = 12; // minimum gap between tooltip and viewport edge
  const GAP = 14; // gap between target and tooltip
  const PAD = 6; // spotlight padding around the target

  let steps = [];
  let idx = 0;
  let tourReturnFocus = null;

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.getClientRects().length > 0;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  function positionTip(tip, r, preferred) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const fits = {
      right: r.right + GAP + tw <= vw - MARGIN,
      left: r.left - GAP - tw >= MARGIN,
      top: r.top - GAP - th >= MARGIN,
      bottom: r.bottom + GAP + th <= vh - MARGIN,
    };
    const order = [preferred, "right", "bottom", "top", "left"].filter(
      (p, i, a) => a.indexOf(p) === i,
    );
    const side = order.find((p) => fits[p]);
    let x;
    let y;
    if (side === "right") {
      x = r.right + GAP;
      y = r.top;
    } else if (side === "left") {
      x = r.left - GAP - tw;
      y = r.top;
    } else if (side === "top") {
      x = r.left;
      y = r.top - GAP - th;
    } else if (side === "bottom") {
      x = r.left;
      y = r.bottom + GAP;
    } else {
      // No side has room (e.g. the target fills the window): sit inside it.
      x = r.left + (r.width - tw) / 2;
      y = r.bottom - th - 24;
    }
    tip.style.left = `${clamp(x, MARGIN, Math.max(MARGIN, vw - tw - MARGIN))}px`;
    tip.style.top = `${clamp(y, MARGIN, Math.max(MARGIN, vh - th - MARGIN))}px`;
  }

  function render({ focus = true } = {}) {
    // Drop steps whose target is missing or hidden right now.
    let el = null;
    while (steps.length) {
      el = document.querySelector(steps[idx].sel);
      if (isVisible(el)) break;
      steps.splice(idx, 1);
      idx = Math.min(idx, steps.length - 1);
      el = null;
    }
    if (!steps.length) {
      endTour(false);
      return;
    }

    const step = steps[idx];
    const r = el.getBoundingClientRect();
    const spot = document.querySelector("#tour .tour-spotlight");
    spot.style.left = `${r.left - PAD}px`;
    spot.style.top = `${r.top - PAD}px`;
    spot.style.width = `${r.width + PAD * 2}px`;
    spot.style.height = `${r.height + PAD * 2}px`;

    const last = idx === steps.length - 1;
    $("tour-progress").textContent = `Step ${idx + 1} of ${steps.length}`;
    $("tour-title").textContent = step.title;
    $("tour-text").textContent = step.text;
    $("btn-tour-back").hidden = idx === 0;
    $("btn-tour-skip").hidden = last;
    $("btn-tour-next").textContent = last ? "Finish" : "Next";

    positionTip($("tour-tip"), r, step.place);
    if (focus) $("btn-tour-next").focus();
  }

  function onTourKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      endTour(true);
    } else {
      trapTab(e, $("tour-tip"));
    }
  }

  function onTourResize() {
    render({ focus: false });
  }

  function startTour() {
    steps = STEPS.filter((s) => isVisible(document.querySelector(s.sel)));
    if (!steps.length) {
      window.ConsolePanel?.log("info", "The guided tour is unavailable right now.", "onboarding");
      return;
    }
    idx = 0;
    tourReturnFocus = document.activeElement;
    $("tour").classList.remove("hidden");
    $("tour").setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onTourKey);
    window.addEventListener("resize", onTourResize);
    render();
  }

  function endTour(remembered) {
    $("tour").classList.add("hidden");
    $("tour").setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", onTourKey);
    window.removeEventListener("resize", onTourResize);
    if (remembered) remember(TOUR_KEY);
    if (tourReturnFocus && document.contains(tourReturnFocus)) tourReturnFocus.focus();
    tourReturnFocus = null;
  }

  function wire() {
    $("btn-welcome-new").addEventListener("click", createNew);
    $("btn-welcome-load").addEventListener("click", loadExisting);
    $("btn-welcome-tour").addEventListener("click", tourFromWelcome);
    $("btn-welcome-skip").addEventListener("click", () => dismissWelcome());

    $("btn-tour-next").addEventListener("click", () => {
      if (idx >= steps.length - 1) {
        endTour(true);
      } else {
        idx += 1;
        render();
      }
    });
    $("btn-tour-back").addEventListener("click", () => {
      if (idx > 0) {
        idx -= 1;
        render();
      }
    });
    $("btn-tour-skip").addEventListener("click", () => endTour(true));
    $("btn-tour-close").addEventListener("click", () => endTour(true));
  }

  async function init() {
    wire();
    try {
      const settings = await window.api.getSettings();
      if (!settings[SEEN_KEY]) showWelcome();
    } catch (e) {
      // If settings can't be read, skip the welcome rather than nag.
    }
  }

  // Exposed so the tour/welcome can be reopened later (e.g. a future
  // "Replay tour" entry in Settings or a header help button).
  window.Onboarding = { showWelcome, startTour };

  document.addEventListener("DOMContentLoaded", init);
})();
