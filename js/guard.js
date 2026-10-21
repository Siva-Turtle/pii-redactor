// Classic (non-module) script on purpose: unlike js/app.js it still loads when
// index.html is double-clicked (file://), so it can tell people what to do
// instead of leaving a dead page.
(function () {
  var banner = document.getElementById("banner");
  var drop = document.getElementById("drop");
  function show(text) {
    if (banner) {
      banner.textContent = text;
      banner.hidden = false;
    }
    if (drop) drop.hidden = true;
  }
  if (location.protocol === "file:") {
    show(
      "This page can't run when opened directly. Close this tab, then double-click the start file in the folder " +
        "(Windows: Start-Windows.bat, Mac: Start-Mac.command) — or use the link your team shared.",
    );
    // Never let the browser open a dropped file itself (it would show it unredacted).
    ["dragover", "drop"].forEach(function (ev) {
      window.addEventListener(ev, function (e) {
        e.preventDefault();
      });
    });
    return;
  }
  // If the app has not started after a few seconds, the browser is too old or blocked something.
  setTimeout(function () {
    if (!window.__appLoaded)
      show("This browser couldn't start the tool. Please use a recent version of Chrome, Edge, Firefox or Safari.");
  }, 4000);
})();
