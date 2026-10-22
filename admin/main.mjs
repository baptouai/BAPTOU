// BAPTOU Admin, the desktop app (Electron). One window; closing it quits the app. The window asks for data
// through preload.cjs; the work is done by commands.mjs with the Firebase CLI login.
// Changes apply without restarting: a new index.html reloads the window, a new commands.mjs is imported
// again, and a new main.mjs or preload.cjs relaunches the app by itself.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
app.setAppUserModelId("com.baptou.admin"); // its own taskbar icon and grouping, not Electron's

let win = null;
let commands = {};
async function loadCommands() {
  // A fresh URL each time, so Node imports the current file rather than its cached copy.
  commands = (await import(`${pathToFileURL(join(here, "commands.mjs")).href}?v=${Date.now()}`)).default;
}

ipcMain.handle("api", async (_event, name, body) => {
  const command = commands[name];
  if (!command) throw new Error(`Unknown command: ${name}`);
  return (await command(body ?? {})) ?? { ok: true };
});
ipcMain.handle("open", (_event, url) => {
  if (/^https:\/\//.test(String(url))) shell.openExternal(String(url));
});

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: "BAPTOU Admin",
    icon: join(here, "baptou.ico"),
    backgroundColor: "#f5f4ff",
    autoHideMenuBar: true,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.loadFile(join(here, "index.html"));
  // Links (feedback offers, Google's consent page) open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) {
      event.preventDefault();
      if (/^https:\/\//.test(url)) shell.openExternal(url);
    }
  });
  win.on("closed", () => (win = null));
  // For checking the layout: BAPTOU_ADMIN_SNAPSHOT=<file.png> saves the window once loaded, then quits.
  if (process.env.BAPTOU_ADMIN_SNAPSHOT) {
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(process.env.BAPTOU_ADMIN_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
        app.exit(0);
      }, 6000),
    );
  }
}

// Live reload when the app's own files change.
let timer = null;
const changed = new Set();
watch(here, (_event, file) => {
  if (!file || file.startsWith("node_modules")) return;
  changed.add(String(file));
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const files = [...changed];
    changed.clear();
    if (files.some((f) => f === "main.mjs" || f === "preload.cjs")) {
      app.relaunch();
      app.exit(0);
      return;
    }
    if (files.includes("commands.mjs")) await loadCommands().catch((e) => console.error(e));
    if (files.some((f) => /^(index\.html|commands\.mjs)$/.test(f))) win?.webContents.reloadIgnoringCache();
  }, 250);
});

// One instance: opening the shortcut again brings the existing window to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(async () => {
    await loadCommands();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
