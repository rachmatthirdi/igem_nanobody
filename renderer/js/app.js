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
    refreshDockerStorageMonitor();
  }

  // Shown in the sidebar regardless of install status (unlike the install
  // banner, which hides itself once installMode === "docker") - this is the
  // one place in the UI to always check where the ~19GB image actually
  // lives, since that's Docker's own managed storage, not this app's folder.
  async function refreshDockerStorageMonitor() {
    const info = await window.api.getDockerStorageInfo();
    const imgEl = $("mon-docker-image");
    const storageEl = $("mon-docker-storage");
    imgEl.textContent = info.dockerImage || "-";
    imgEl.title = info.dockerImage || "";
    storageEl.textContent = info.dockerRootDir || "not detected";
    storageEl.title = info.dockerRootDir || "Docker not running or not found";
  }

  // ---------------- Install banner (Docker tools image) ----------------
  let installBannerDismissed = false;

  async function refreshInstallBanner() {
    if (installBannerDismissed) return;
    const settings = await window.api.getSettings();
    if (settings.installMode === "docker") {
      $("install-banner").style.display = "none";
      return;
    }

    const docker = await window.api.checkDocker();
    $("install-banner").style.display = "";
    $("install-no-docker").style.display = docker.available ? "none" : "";
    $("install-ready").style.display = docker.available ? "" : "none";
    if (!docker.available) return;

    const info = await window.api.getDockerStorageInfo();
    $("install-storage-path").textContent =
      info.dockerRootDir || "unknown (docker info failed)";
    $("install-image-name").textContent = info.dockerImage;
  }

  function dismissInstallBanner() {
    installBannerDismissed = true;
    $("install-banner").style.display = "none";
  }

  function wireInstallBanner() {
    $("btn-install-dismiss-nodocker").addEventListener(
      "click",
      dismissInstallBanner,
    );
    $("btn-install-dismiss").addEventListener("click", dismissInstallBanner);

    $("btn-install-download").addEventListener("click", async () => {
      const dlBtn = $("btn-install-download");
      const cancelBtn = $("btn-install-cancel");
      dlBtn.disabled = true;
      cancelBtn.disabled = false;
      window.ConsolePanel.log(
        "info",
        "Downloading the pre-built tools image from Docker Hub.",
        "install",
      );
      try {
        await window.api.pullDockerImage();
        window.ConsolePanel.log("ok", "Tools image downloaded.", "install");
        $("install-banner").style.display = "none";
        refreshMonitorSettings();
      } catch (e) {
        const cancelled = e.message === "Cancelled by user.";
        window.ConsolePanel.log(
          cancelled ? "warn" : "error",
          cancelled
            ? "Docker pull cancelled."
            : `Docker pull failed: ${e.message}`,
          "install",
        );
      } finally {
        dlBtn.disabled = false;
        cancelBtn.disabled = true;
      }
    });

    $("btn-install-cancel").addEventListener("click", async () => {
      $("btn-install-cancel").disabled = true;
      await window.api.cancelDockerPull();
    });

    $("btn-install-build-source").addEventListener("click", async () => {
      const btn = $("btn-install-build-source");
      btn.disabled = true;
      window.ConsolePanel.log(
        "info",
        "Building the tools image from source (this can take 20-30 min).",
        "install",
      );
      try {
        await window.api.runDockerBuild();
        window.ConsolePanel.log(
          "ok",
          "Docker image build complete.",
          "install",
        );
        $("install-banner").style.display = "none";
        refreshMonitorSettings();
      } catch (e) {
        window.ConsolePanel.log(
          "error",
          `Docker build failed: ${e.message}`,
          "install",
        );
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------------- Settings modal ----------------
  async function openSettingsModal() {
    const s = await window.api.getSettings();
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
    $("btn-settings-save").addEventListener("click", async () => {
      const settings = {
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
          window.TabConstruct?.refreshCandidateOptions?.();
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
    wireInstallBanner();

    window.TabTarget.init();
    window.TabDesign.init();
    window.TabScreening.init();
    window.TabConstruct.init();

    refreshGpuStatus();
    refreshMonitorSettings();
    refreshPlatformInfo();
    refreshInstallBanner();
  });
})();
