// ROM Nova desktop shell. The web build is the app — this window serves the
// exact same static export over a private app:// scheme (stable origin, so
// the visitor's workspace persists in localStorage across launches, same as
// the browser) and adds nothing but a frame, an icon, auto-update, and the
// things an installed app is expected to remember: where its window was, how
// far it was zoomed, and which version it is.

const { app, BrowserWindow, protocol, shell, net, Menu, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { isRpcRequest, handleRpc } = require("./rpc-proxy");
const { isBridgeRequest, createBridge } = require("./bridge");
const windowState = require("./window-state");

// The static export is built with basePath /nova (identical to the deployment
// at romapps.xyz/nova) — the protocol handler strips the prefix.
const BASE = "/nova";
const ORIGIN_HOST = "rom-nova";

/** How often a window left open asks the release feed again. */
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

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

/**
 * electron-updater, when this is the installed app. The unpackaged shell
 * (`npm start` over ../out) has no release feed, and the bridge says so.
 */
function loadUpdater() {
  if (!app.isPackaged) return null;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    return autoUpdater;
  } catch {
    return null;
  }
}

const updater = loadUpdater();
const bridge = createBridge({
  version: () => app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  versions: process.versions,
  updater,
});

function createWindow() {
  // Where it was left, checked against the displays present right now.
  const stateFile = windowState.stateFile(app.getPath("userData"));
  const saved = windowState.fitToDisplays(windowState.readState(stateFile), screen.getAllDisplays());
  let zoom = saved.zoom;

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: windowState.MIN_BOUNDS.width,
    minHeight: windowState.MIN_BOUNDS.height,
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
  if (saved.maximized) win.maximize();

  // Remember it. Debounced, because a drag fires "move" dozens of times a
  // second; written once more, synchronously, as the window closes.
  let saveTimer = null;
  const save = () => windowState.writeState(stateFile, windowState.captureState(win, zoom));
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"]) win.on(event, saveSoon);
  win.on("close", () => {
    clearTimeout(saveTimer);
    save();
  });

  // The zoom level is ours to remember: applied on every load, so the file
  // and the window never disagree.
  const setZoom = (level) => {
    zoom = level;
    win.webContents.setZoomLevel(level);
    saveSoon();
  };
  win.webContents.on("did-finish-load", () => win.webContents.setZoomLevel(zoom));

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

  // The keys a menu bar would have carried, without the menu bar: F11
  // fullscreen, F5 / Ctrl+R reload, F12 devtools, Ctrl with + - 0 for zoom.
  win.webContents.on("before-input-event", (e, input) => {
    const action = windowState.shellActionFor(input);
    if (!action) return;
    e.preventDefault();
    if (action === "fullscreen") win.setFullScreen(!win.isFullScreen());
    else if (action === "reload") win.webContents.reload();
    else if (action === "devtools") win.webContents.toggleDevTools();
    else if (action === "zoom-in") setZoom(windowState.nextZoom(zoom, 1));
    else if (action === "zoom-out") setZoom(windowState.nextZoom(zoom, -1));
    else if (action === "zoom-reset") setZoom(0);
  });

  win.loadURL(`app://${ORIGIN_HOST}${BASE}/`);
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  protocol.handle("app", (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== ORIGIN_HOST) return new Response("not found", { status: 404 });
    // Checked before the static resolver, which would otherwise 404 them:
    // neither path is a file. One is the renderer reaching Solana through the
    // main process so the request carries no Origin (rpc-proxy.js); the other
    // is the renderer asking the shell which version it is and whether an
    // update is waiting (bridge.js).
    if (isRpcRequest(pathname)) return handleRpc(request);
    if (isBridgeRequest(pathname)) return bridge.handle(request);
    const file = resolveStatic(pathname);
    if (!file) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  createWindow();

  // auto-update against the rom-nova releases: once now, then every six
  // hours for a window left open, since a reader who never quits would
  // otherwise never learn. Failures stay silent here — an unreachable feed
  // must never bother the user with a dialog — and are readable on the
  // Settings page through the bridge.
  if (updater) {
    const check = () => {
      if (bridge.shouldCheck()) updater.checkForUpdatesAndNotify().catch(() => {});
    };
    check();
    setInterval(check, UPDATE_CHECK_MS);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
