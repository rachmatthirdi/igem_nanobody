(function () {
  const lines = [];

  function renderLine(entry) {
    const body = document.getElementById("console-body");
    const div = document.createElement("div");
    div.className = `console-line level-${entry.level}`;
    const time = new Date(entry.ts).toLocaleTimeString("id-ID", {
      hour12: false,
    });
    div.innerHTML = `<span class="src">[${time}] [${entry.source || "-"}]</span> ${escapeHtml(entry.text)}`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
    );
  }

  window.ConsolePanel = {
    init() {
      window.api.onConsoleLog((entry) => {
        lines.push(entry);
        renderLine(entry);
      });

      document
        .getElementById("console-header")
        .addEventListener("click", (e) => {
          if (e.target.closest(".console-header-actions")) return;
          document
            .getElementById("console-footer")
            .classList.toggle("collapsed");
        });

      document
        .getElementById("btn-console-toggle")
        .addEventListener("click", () => {
          document
            .getElementById("console-footer")
            .classList.toggle("collapsed");
        });

      document
        .getElementById("btn-console-clear")
        .addEventListener("click", () => {
          lines.length = 0;
          document.getElementById("console-body").innerHTML = "";
        });

      document
        .getElementById("btn-console-export")
        .addEventListener("click", () => {
          const text = lines
            .map(
              (l) =>
                `[${new Date(l.ts).toISOString()}] [${l.level}] [${l.source || "-"}] ${l.text}`,
            )
            .join("\n");
          const blob = new Blob([text], { type: "text/plain" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `console-log-${Date.now()}.txt`;
          a.click();
          URL.revokeObjectURL(url);
        });
    },

    log(level, text, source) {
      const entry = { level, text, source, ts: Date.now() };
      lines.push(entry);
      renderLine(entry);
    },
  };
})();
