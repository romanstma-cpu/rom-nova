// ROM Nova desktop shell. The web build is the app — this window serves the
// exact same static export over a private app:// scheme (stable origin, so
// the visitor's workspace persists in localStorage across launches, same as
// the browser) and adds nothing but a frame, an icon, and auto-update.

const { app, BrowserWindow, protocol, shell, net, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// The static export is built with basePath /nova (identical to the deployment
// at romapps.xyz/nova) — the protocol handler strips the prefix.
const BASE = "/nova";
const ORIGIN_HOST = "rom-nova";

const staticRoot = app.isPackaged
  ? path.join(process.resourcesPath, "static")
  : path.join(__dirname, "..", "out");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

function resolveStatic(pathname) {
  if (pathname === "/" || pathname === BASE) return path.join(staticRoot, "index.html");
  if (!pathname.startsWith(BASE + "/")) return null;
  let rel = decodeURIComponent(pathname.slice(BASE.length));
  if (rel.includes("..")) return null;
  let file = path.join(staticRoot, rel);
  if (rel.endsWith("/")) file = path.join(file, "index.html");
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  if (fs.existsSync(file + ".html")) return file + ".html";
  const notFound = path.join(staticRoot, "404.html");
  return fs.existsSync(notFound) ? notFound : null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: "#04060a",
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // external links (romapps.xyz, GitHub, …) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://")) {
      e.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    }
  });

  // F11 fullscreen without carrying a menu bar around
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });

  win.loadURL(`app://${ORIGIN_HOST}${BASE}/`);
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  protocol.handle("app", (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== ORIGIN_HOST) return new Response("not found", { status: 404 });
    const file = resolveStatic(pathname);
    if (!file) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  createWindow();

  // auto-update against the rom-nova releases; failures stay silent —
  // an unreachable update feed must never bother the user
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.autoDownload = true;
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch {
      /* updater unavailable — fine */
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
