// The bridge between BAPTOU Admin's window and its commands (main.mjs). The page only gets these two calls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("baptou", {
  /** Runs a command from commands.mjs; rejects with its plain error message. */
  api: (name, body) =>
    ipcRenderer.invoke("api", name, body).catch((e) => {
      throw new Error(String(e?.message ?? e).replace(/^Error invoking remote method 'api': (Error: )?/, ""));
    }),
  /** Opens a web address in the normal browser. */
  open: (url) => ipcRenderer.invoke("open", url),
});
