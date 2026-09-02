(function () {
  function $(id) {
    return document.getElementById(id);
  }

  // ---------------- Tab switching ----------------
  function switchTab(name) {
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
    document
      .querySelectorAll(".pipeline-steps li")
      .forEach((li) => li.classList.toggle("active", li.dataset.step === name));

    if (name === "design" && window.TabDesign?.onActivate)
      window.TabDesign.onActivate();
    if (name === "screening" && window.TabScreening?.refresh)
      window.TabScreening.refresh();
    if (name === "construct" && window.TabConstruct?.onActivate)
      window.TabConstruct.onActivate();
  }

  function wireTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  // ---------------- Stage progress -> progress bars / badges ----------------
  function wireProgress() {
    window.api.onStageProgress(({ stage, percent, status, message }) => {
      const bar = $(`pg-${stage}`);
      if (bar) {
        bar.style.width = `${percent}%`;
        bar.classList.toggle("done", status === "done");
        bar.classList.toggle("error", status === "error");
      }
      const pct = $(`pg-${stage}-pct`);
      if (pct) pct.textContent = `${percent}%`;
      const statusEl = $(`pg-${stage}-status`);
      if (statusEl) statusEl.textContent = message || "";
    });
  }

  // ---------------- OS / WSL detection ----------------
  async function refreshPlatformInfo() {
    try {
      const info = await window.api.getPlatformInfo();
      $("mon-detected-os").textContent = info.label;
    } catch (e) {
      $("mon-detected-os").textContent = "error";
    }
  }

  // ---------------- GPU badge + system monitor ----------------
  async function refreshGpuStatus() {
    try {
      const status = await window.api.checkGpu();
      const badge = $("gpu-badge");
      if (status.cudaAvailable) {
        badge.textContent = `🟢 GPU: ${status.gpuName || "detected"}`;
        badge.className = "badge badge-ok";
        badge.title = "";
      } else {
        badge.textContent = "🔴 GPU: not detected";
        badge.className = "badge badge-error";
        badge.title =
          "Have an NVIDIA GPU? Install nvidia-container-toolkit and " +
          "restart Docker, or click to force it on in Settings.";
      }
      $("mon-gpu").textContent = status.cudaAvailable
        ? status.gpuName || "Yes"
        : "Not detected";
      $("mon-vram").textContent = status.vramTotalGb
        ? `${status.vramTotalGb} GB`
        : "-";
    } catch (e) {
      $("gpu-badge").textContent = "🔴 GPU: error";
    }
  }

  async function refreshMonitorSettings() {
    const s = await window.api.getSettings();
    $("mon-tools-env").textContent = s.toolsEnv;
    $("mon-discotope-env").textContent = s.discotopeEnv;
    $("mon-rfab").textContent = s.rfantibodyDir ? "✓ configured" : "⚠ not set";
    $("mon-execmode").textContent = s.rfantibodyExecMode;
    return s;
  }

  // ---------------- Settings modal ----------------
  async function openSettingsModal() {
    const s = await window.api.getSettings();
    $("set-condaExe").value = s.condaExe;
    $("set-toolsEnv").value = s.toolsEnv;
    $("set-discotopeEnv").value = s.discotopeEnv;
    $("set-discotopeRepoDir").value = s.discotopeRepoDir;
    $("set-rfantibodyDir").value = s.rfantibodyDir;
    $("set-rfantibodyExecMode").value = s.rfantibodyExecMode;
    $("set-wslDistro").value = s.wslDistro;
    $("set-dockerImage").value = s.dockerImage;
    $("set-gpuOverride").value = s.gpuOverride;
    $("settings-modal").classList.remove("hidden");
  }

  function wireSettingsModal() {
    $("btn-settings").addEventListener("click", openSettingsModal);
    $("gpu-badge").addEventListener("click", async () => {
      await openSettingsModal();
      const field = $("set-gpuOverride");
      field.scrollIntoView({ block: "center" });
      field.focus();
    });
    $("btn-settings-close").addEventListener("click", () =>
      $("settings-modal").classList.add("hidden"),
    );
    $("btn-test-gpu").addEventListener("click", async () => {
      const btn = $("btn-test-gpu");
      const status = $("gpu-test-status");
      btn.disabled = true;
      status.textContent = "Testing...";
      status.className = "";
      try {
        const res = await window.api.testGpuDocker();
        if (res.success) {
          const name = res.message.match(/^\|\s+\d+\s+(.+?)\s{2,}/m)?.[1];
          status.textContent = `✓ Docker can reach your GPU${name ? `: ${name}` : ""}.`;
          status.className = "status-pass";
          window.ConsolePanel.log(
            "ok",
            `GPU access verified via Docker.\n${res.message}`,
            "gpu-check",
          );
        } else {
          status.textContent =
            "✗ Docker cannot reach a GPU (see Live Console).";
          status.className = "status-fail";
          window.ConsolePanel.log(
            "error",
            `Docker GPU test failed: ${res.message}`,
            "gpu-check",
          );
        }
      } finally {
        btn.disabled = false;
      }
    });
    $("btn-build-docker").addEventListener("click", async () => {
      const btn = $("btn-build-docker");
      const status = $("docker-build-status");
      btn.disabled = true;
      status.textContent = "Downloading... see Live Console for progress.";
      window.ConsolePanel.log(
        "info",
        "Downloading the pre-built tools image from Docker Hub.",
        "install",
      );
      try {
        await window.api.pullDockerImage();
        status.textContent = "✓ Tools image ready.";
        window.ConsolePanel.log("ok", "Tools image downloaded.", "install");
        refreshMonitorSettings();
      } catch (e) {
        status.textContent = "✗ Download failed.";
        window.ConsolePanel.log(
          "error",
          `Docker pull failed: ${e.message}`,
          "install",
        );
      } finally {
        btn.disabled = false;
      }
    });
    $("btn-build-docker-source").addEventListener("click", async () => {
      const btn = $("btn-build-docker-source");
      const status = $("docker-build-status");
      btn.disabled = true;
      status.textContent = "Building... see Live Console for progress.";
      window.ConsolePanel.log(
        "info",
        "Building the tools image from source (this can take 20-30 min).",
        "install",
      );
      try {
        await window.api.runDockerBuild();
        status.textContent = "✓ Build complete.";
        window.ConsolePanel.log(
          "ok",
          "Docker image build complete.",
          "install",
        );
        refreshMonitorSettings();
      } catch (e) {
        status.textContent = "✗ Build failed.";
        window.ConsolePanel.log(
          "error",
          `Docker build failed: ${e.message}`,
          "install",
        );
      } finally {
        btn.disabled = false;
      }
    });
    $("pick-discotopeRepoDir").addEventListener("click", async () => {
      const dir = await window.api.pickDirectory();
      if (dir) $("set-discotopeRepoDir").value = dir;
    });
    $("pick-rfantibodyDir").addEventListener("click", async () => {
      const dir = await window.api.pickDirectory();
      if (dir) $("set-rfantibodyDir").value = dir;
    });
    $("btn-settings-save").addEventListener("click", async () => {
      const settings = {
        condaExe: $("set-condaExe").value,
        toolsEnv: $("set-toolsEnv").value,
        discotopeEnv: $("set-discotopeEnv").value,
        discotopeRepoDir: $("set-discotopeRepoDir").value,
        rfantibodyDir: $("set-rfantibodyDir").value,
        rfantibodyExecMode: $("set-rfantibodyExecMode").value,
        wslDistro: $("set-wslDistro").value,
        dockerImage: $("set-dockerImage").value,
        gpuOverride: $("set-gpuOverride").value,
      };
      await window.api.saveSettings(settings);
      $("settings-modal").classList.add("hidden");
      refreshMonitorSettings();
      refreshGpuStatus();
      window.ConsolePanel.log("ok", "Settings saved.", "settings");
    });
  }

  // ---------------- Save / load project ----------------
  function wireProjectButtons() {
    $("btn-save-project").addEventListener("click", async () => {
      const state = window.StateUtils.serialize();
      const res = await window.api.saveProject(state);
      window.AppState.id = res.id;
      window.ConsolePanel.log("ok", `Project saved: ${res.id}`, "project");
    });

    $("btn-load-project").addEventListener("click", async () => {
      const list = await window.api.listProjects();
      const container = $("projects-list");
      container.innerHTML = "";
      if (!list.length)
        container.innerHTML =
          '<div style="color:var(--text-dim);padding:10px">No saved projects yet.</div>';
      for (const p of list) {
        const div = document.createElement("div");
        div.className = "project-item";
        div.innerHTML = `<span>${p.name} <span style="color:var(--text-dim);font-size:11px">(${p.savedAt ? new Date(p.savedAt).toLocaleString("en-US") : ""})</span></span>`;
        const btnLoad = document.createElement("button");
        btnLoad.className = "btn btn-secondary";
        btnLoad.textContent = "Load";
        btnLoad.addEventListener("click", async () => {
          const data = await window.api.loadProject(p.id);
          window.StateUtils.applyLoaded(data);
          $("projects-modal").classList.add("hidden");
          window.TabScreening?.refresh();
          window.ConsolePanel.log(
            "ok",
            `Project "${p.name}" loaded.`,
            "project",
          );
        });
        div.appendChild(btnLoad);
        container.appendChild(div);
      }
      $("projects-modal").classList.remove("hidden");
    });

    $("btn-projects-close").addEventListener("click", () =>
      $("projects-modal").classList.add("hidden"),
    );
  }

  // ---------------- Bootstrap ----------------
  window.App = { switchTab, openSettingsModal };

  document.addEventListener("DOMContentLoaded", () => {
    window.ConsolePanel.init();
    wireTabs();
    wireProgress();
    wireSettingsModal();
    wireProjectButtons();

    window.TabTarget.init();
    window.TabDesign.init();
    window.TabScreening.init();
    window.TabConstruct.init();

    refreshGpuStatus();
    refreshMonitorSettings();
    refreshPlatformInfo();
  });
})();
