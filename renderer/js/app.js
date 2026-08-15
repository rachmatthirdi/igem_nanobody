(function () {
  function $(id) { return document.getElementById(id); }

  // ---------------- Tab switching ----------------
  function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    document.querySelectorAll('.pipeline-steps li').forEach((li) => li.classList.toggle('active', li.dataset.step === name));

    if (name === 'design' && window.TabDesign?.onActivate) window.TabDesign.onActivate();
    if (name === 'screening' && window.TabScreening?.refresh) window.TabScreening.refresh();
    if (name === 'construct' && window.TabConstruct?.onActivate) window.TabConstruct.onActivate();
  }

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  // ---------------- Stage progress -> progress bars / badges ----------------
  function wireProgress() {
    window.api.onStageProgress(({ stage, percent, status, message }) => {
      const bar = $(`pg-${stage}`);
      if (bar) {
        bar.style.width = `${percent}%`;
        bar.classList.toggle('done', status === 'done');
        bar.classList.toggle('error', status === 'error');
      }
      const pct = $(`pg-${stage}-pct`);
      if (pct) pct.textContent = `${percent}%`;
      const statusEl = $(`pg-${stage}-status`);
      if (statusEl) statusEl.textContent = message || '';
    });
  }

  // ---------------- GPU badge + system monitor ----------------
  async function refreshGpuStatus() {
    try {
      const status = await window.api.checkGpu();
      const badge = $('gpu-badge');
      if (status.cudaAvailable) {
        badge.textContent = `🟢 GPU: ${status.gpuName || 'terdeteksi'}`;
        badge.className = 'badge badge-ok';
      } else {
        badge.textContent = '🔴 GPU: tidak terdeteksi';
        badge.className = 'badge badge-error';
      }
      $('mon-gpu').textContent = status.cudaAvailable ? (status.gpuName || 'Ya') : 'Tidak terdeteksi';
      $('mon-vram').textContent = status.vramTotalGb ? `${status.vramTotalGb} GB` : '-';
    } catch (e) {
      $('gpu-badge').textContent = '🔴 GPU: error';
    }
  }

  async function refreshMonitorSettings() {
    const s = await window.api.getSettings();
    $('mon-tools-env').textContent = s.toolsEnv;
    $('mon-discotope-env').textContent = s.discotopeEnv;
    $('mon-rfab').textContent = s.rfantibodyDir ? '✓ dikonfigurasi' : '⚠ belum diatur';
    $('mon-execmode').textContent = s.rfantibodyExecMode;
    return s;
  }

  // ---------------- Settings modal ----------------
  async function openSettingsModal() {
    const s = await window.api.getSettings();
    $('set-condaExe').value = s.condaExe;
    $('set-toolsEnv').value = s.toolsEnv;
    $('set-discotopeEnv').value = s.discotopeEnv;
    $('set-discotopeRepoDir').value = s.discotopeRepoDir;
    $('set-rfantibodyDir').value = s.rfantibodyDir;
    $('set-rfantibodyExecMode').value = s.rfantibodyExecMode;
    $('set-wslDistro').value = s.wslDistro;
    $('set-dockerImage').value = s.dockerImage;
    $('settings-modal').classList.remove('hidden');
  }

  function wireSettingsModal() {
    $('btn-settings').addEventListener('click', openSettingsModal);
    $('btn-settings-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
    $('pick-discotopeRepoDir').addEventListener('click', async () => {
      const dir = await window.api.pickDirectory();
      if (dir) $('set-discotopeRepoDir').value = dir;
    });
    $('pick-rfantibodyDir').addEventListener('click', async () => {
      const dir = await window.api.pickDirectory();
      if (dir) $('set-rfantibodyDir').value = dir;
    });
    $('btn-settings-save').addEventListener('click', async () => {
      const settings = {
        condaExe: $('set-condaExe').value,
        toolsEnv: $('set-toolsEnv').value,
        discotopeEnv: $('set-discotopeEnv').value,
        discotopeRepoDir: $('set-discotopeRepoDir').value,
        rfantibodyDir: $('set-rfantibodyDir').value,
        rfantibodyExecMode: $('set-rfantibodyExecMode').value,
        wslDistro: $('set-wslDistro').value,
        dockerImage: $('set-dockerImage').value,
      };
      await window.api.saveSettings(settings);
      $('settings-modal').classList.add('hidden');
      refreshMonitorSettings();
      window.ConsolePanel.log('ok', 'Pengaturan disimpan.', 'settings');
    });
  }

  // ---------------- Save / load project ----------------
  function wireProjectButtons() {
    $('btn-save-project').addEventListener('click', async () => {
      const state = window.StateUtils.serialize();
      const res = await window.api.saveProject(state);
      window.AppState.id = res.id;
      window.ConsolePanel.log('ok', `Proyek disimpan: ${res.id}`, 'project');
    });

    $('btn-load-project').addEventListener('click', async () => {
      const list = await window.api.listProjects();
      const container = $('projects-list');
      container.innerHTML = '';
      if (!list.length) container.innerHTML = '<div style="color:var(--text-dim);padding:10px">Belum ada proyek tersimpan.</div>';
      for (const p of list) {
        const div = document.createElement('div');
        div.className = 'project-item';
        div.innerHTML = `<span>${p.name} <span style="color:var(--text-dim);font-size:11px">(${p.savedAt ? new Date(p.savedAt).toLocaleString('id-ID') : ''})</span></span>`;
        const btnLoad = document.createElement('button');
        btnLoad.className = 'btn btn-secondary';
        btnLoad.textContent = 'Muat';
        btnLoad.addEventListener('click', async () => {
          const data = await window.api.loadProject(p.id);
          window.StateUtils.applyLoaded(data);
          $('projects-modal').classList.add('hidden');
          window.TabScreening?.refresh();
          window.ConsolePanel.log('ok', `Proyek "${p.name}" dimuat.`, 'project');
        });
        div.appendChild(btnLoad);
        container.appendChild(div);
      }
      $('projects-modal').classList.remove('hidden');
    });

    $('btn-projects-close').addEventListener('click', () => $('projects-modal').classList.add('hidden'));
  }

  // ---------------- Bootstrap ----------------
  window.App = { switchTab };

  document.addEventListener('DOMContentLoaded', () => {
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
  });
})();
