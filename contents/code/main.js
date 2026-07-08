//
// Configuration
//

const handleFullscreen      = readConfig("handleFullscreen", true);
const handleMaximized       = readConfig("handleMaximized", true);
const moveToLast            = readConfig("moveToLast", false);
const enableIfOnlyOne       = readConfig("enableIfOnlyOne", false);
const enablePanelVisibility = readConfig("enablePanelVisibility", false);
const exclusiveDesktops     = readConfig("exclusiveDesktops", true);
const debugMode             = readConfig("debugMode", false);

var lastPanelMode = "";
var panelTimer = new QTimer();

panelTimer.interval = 100;

panelTimer.timeout.connect(function() {
    updatePanelVisibility();
});

//
// Constants
//

const MAXIMIZED = 3;

//
// Logging
//

function log(message)
{
    if (debugMode)
        print("MACsimize6: " + message);
}

function logWindow(window, message)
{
    if (!window)
        return;

    log("[" + window.internalId + "] " + message);
}

//
// Global state
//

const savedData = new Map();

const managedDesktops = [];

//
// Windows to ignore
//

const systemSkippedWindows = [
    "kwin",
    "kwin_wayland",
    "ksmserver-logout-greeter",
    "ksmserver",
    "kscreenlocker_greet",
    "ksplash",
    "ksplashqml",
    "plasmashell",
    "org.kde.plasmashell",
    "krunner"
];

const configSkippedWindows =
    readConfig(
        "SkipWindows",
        "lattedock, latte-dock, org.kde.spectacle, spectacle, org.kde.yakuake"
    )
    .toString()
    .toLowerCase()
    .split(/,\s*/);

const alwaysSkippedWindows =
    systemSkippedWindows.concat(configSkippedWindows);

//
// Window state
//

function getState(window)
{
    const id = window.internalId;

    if (!savedData.has(id))
    {
        savedData.set(id, {

            tracked: false,

            maximizedMode: 0,

            resourceClass: "",

            dedicatedDesktop: null
        });
    }

    return savedData.get(id);
}

function purgeState(window)
{
    savedData.delete(window.internalId);
}

function isTracked(window)
{
    return getState(window).tracked;
}

function isManaged(window)
{
    return getState(window).dedicatedDesktop !== null;
}

function setTracked(window, tracked)
{
    getState(window).tracked = tracked;
}

function setMaximizedMode(window, mode)
{
    getState(window).maximizedMode = mode;
}

function isWindowMaximized(window)
{
    const area = workspace.clientArea(KWin.MaximizeArea, window);

    return window.width + 1 >= area.width &&
           window.height + 1 >= area.height;
}
//
// Helpers
//

function getWindowClass(window)
{
    if (!window || !window.resourceClass)
        return "";

    return window.resourceClass.toString().toLowerCase();
}

function getNextDesktopNumber()
{
    for (let i = 0; i < workspace.desktops.length; ++i)
    {
        if (workspace.desktops[i] === workspace.currentDesktop)
            return i + 1;
    }

    return workspace.desktops.length;
}

function createManagedDesktop(name)
{
    const index =
        moveToLast
            ? workspace.desktops.length
            : getNextDesktopNumber();

    workspace.createDesktop(index, name);

    const desktop = workspace.desktops[index];

    managedDesktops.push(desktop);

    return desktop;
}

function removeManagedDesktop(desktop)
{
    const index = managedDesktops.indexOf(desktop);

    if (index >= 0)
        managedDesktops.splice(index, 1);

    workspace.removeDesktop(desktop);
}

//
// Window filtering
//

function shouldSkip(window)
{
    if (!window ||
        window.appletPopup ||
        window.comboBox ||
        window.criticalNotification ||
        window.desktopWindow ||
        window.dialog ||
        window.dndIcon ||
        window.dock ||
        window.dropdownMenu ||
        window.hidden ||
        window.inputMethod ||
        window.menu ||
        window.notification ||
        window.onScreenDisplay ||
        window.popupMenu ||
        window.popupWindow ||
        window.specialWindow ||
        window.splash ||
        window.toolbar ||
        window.tooltip ||
        window.utility )
    {
        log("Skipped special window");
        return true;
    }

    const windowClass = getWindowClass(window);

    if (!windowClass)
    {
        log("Skipped window with empty class");
        return true;
    }

    if (alwaysSkippedWindows.includes(windowClass))
    {
        log("Skipped " + windowClass);
        return true;
    }

    return false;
}

//
// Desktop management
//

function isManagedDesktop(desktop)
{
    if (!desktop)
        return false;

    for (const state of savedData.values())
    {
        if (!state.dedicatedDesktop)
            continue;

        if (state.dedicatedDesktop.id === desktop.id)
            return true;
    }

    return false;
}

function createManagedDesktop(window)
{
    const index = moveToLast
        ? workspace.desktops.length
        : getNextDesktopNumber();

    workspace.createDesktop(index, window.caption.toString());

    return workspace.desktops[index];
}

function removeManagedDesktop(desktop)
{
    if (!desktop)
        return;

    workspace.removeDesktop(desktop);
}

function moveToNewDesktop(window)
{
    if (enableIfOnlyOne &&
        workspace.screens.length > 1)
    {
        logWindow(window, "Skipping because multiple monitors are connected.");
        return;
    }

    const state = getState(window);

    if (state.dedicatedDesktop)
    {
        logWindow(window, "Already on a dedicated desktop.");
        return;
    }

    logWindow(window, "Creating dedicated desktop.");

    state.resourceClass = getWindowClass(window);

    const desktop = createManagedDesktop(window);

    state.dedicatedDesktop = desktop;

    window.desktops = [desktop];
    workspace.currentDesktop = desktop;
}

function restoreDesktop(window)
{
    const state = getState(window);

    if (!state.dedicatedDesktop)
    {
        logWindow(window, "Window is not managed.");
        return;
    }

    const desktop = state.dedicatedDesktop;

    logWindow(window, "Restoring to the main desktop.");

    //
    // Clear our state first so recursive events
    // don't think we're still managed.
    //
    state.dedicatedDesktop = null;

    window.desktops = [workspace.desktops[0]];

    workspace.currentDesktop = workspace.desktops[0];

    removeManagedDesktop(desktop);
}

function updateDedicatedDesktopName(window)
{
    const state = getState(window);

    if (!state.dedicatedDesktop)
        return;

    state.dedicatedDesktop.name = window.caption.toString();
}

//
// Returns true if the current desktop already
// belongs to a managed window of the same class.
//
function sameClassDesktop(window)
{
    const windowClass = getWindowClass(window);
    const currentDesktop = workspace.currentDesktop;

    for (const state of savedData.values())
    {
        if (!state.dedicatedDesktop)
            continue;

        if (state.resourceClass !== windowClass)
            continue;

        if (state.dedicatedDesktop.id === currentDesktop.id)
            return true;
    }

    return false;
}

//
// Window evaluation
//

function evaluateWindow(window)
{
    const state = getState(window);

    //
    // Minimized windows are always restored to the main desktop.
    //
    if (window.minimized)
    {
        if (isManaged(window))
            restoreDesktop(window);

        return;
    }

    //
    // Fullscreen has highest priority.
    //
    if (handleFullscreen && window.fullScreen)
    {
        moveToNewDesktop(window);
        return;
    }

    //
    // Maximized windows should live on dedicated desktops.
    //
    if (handleMaximized &&
        state.maximizedMode === MAXIMIZED)
    {
        moveToNewDesktop(window);
        return;
    }

    //
    // Otherwise restore the window.
    //
    if (isManaged(window))
    {
        restoreDesktop(window);
        workspace.raiseWindow(window);
    }

}

//
// State change handlers
//

function maximizedStateChanged(window, mode)
{
    setMaximizedMode(window, mode);

    logWindow(window, "Maximized mode: " + mode);

    evaluateWindow(window);
}

function fullScreenChanged(window)
{
    logWindow(window,
        "Fullscreen: " + window.fullScreen);

    evaluateWindow(window);
}

function minimizedStateChanged(window)
{
    logWindow(window,
        "Minimized: " + window.minimized);

    evaluateWindow(window);
}

function windowCaptionChanged(window)
{
    updateDedicatedDesktopName(window);
}

//
// Window signal installation
//

function installWindowHandlers(window)
{
    if (!window)
        return;

    if (!window.normalWindow)
        return;

    if (window.skipTaskbar)
        return;

    if (window.splash)
        return;

    if (!window.fullScreenable &&
        !window.maximizable)
    {
        return;
    }

    if (isTracked(window))
    {
        logWindow(window, "Already tracked.");
        return;
    }

    logWindow(window, "Installing handlers.");

    setTracked(window, true);

    //
    // Maximization
    //
    if (handleMaximized &&
        window.maximizable)
    {
        window.maximizedAboutToChange.connect(function(mode) {

            logWindow(window,
                "maximizedAboutToChange(" + mode + ")");

            maximizedStateChanged(window, mode);

        });

        window.minimizedChanged.connect(function() {

            minimizedStateChanged(window);

        });
    }

    //
    // Fullscreen
    //
    if (handleFullscreen &&
        window.fullScreenable)
    {
        window.fullScreenChanged.connect(function() {

            fullScreenChanged(window);

        });
    }

    //
    // Caption changes
    //
    if ((handleFullscreen && window.fullScreenable) ||
        (handleMaximized && window.maximizable))
    {
        window.captionChanged.connect(function() {

            windowCaptionChanged(window);

        });
    }

    //
    // Window closed
    //
    window.closed.connect(function() {

        logWindow(window, "Closed.");

        restoreDesktop(window);

        purgeState(window);

    });
}

//
// Panel visibility
//

function updatePanelVisibility()
{
    let panelVisibility =
    workspace.currentDesktop === workspace.desktops[0]
        ? "none"
        : "dodgewindows";

    if (panelVisibility === lastPanelMode)
        return;

    lastPanelMode = panelVisibility;

    const script = `
        for (let id of panelIds) {
            let p = panelById(id);
            p.hiding = "${panelVisibility}";
        }
    `;

    callDBus(
        "org.kde.plasmashell",
        "/PlasmaShell",
        "org.kde.PlasmaShell",
        "evaluateScript",
        script
    );
}

//
// Main installation
//

function install()
{
    log("Installing workspace handlers.");

    //
    // Existing windows
    //
    for (const window of workspace.windowList())
    {
        if (shouldSkip(window))
            continue;

        installWindowHandlers(window);
    }

    //
    // Activated windows
    //
    workspace.windowActivated.connect(function(window) {

        if (shouldSkip(window))
            return;

        installWindowHandlers(window);

    });

    //
    // New windows
    //
    workspace.windowAdded.connect(function(window) {


        if (shouldSkip(window))
            return;

        //
        // Transient windows inherit the parent's desktop.
        //
        if (window.transientFor)
        {
            const parent = window.transientFor;

            if (parent && isManaged(parent))
            {
                logWindow(window,
                    "Moving transient window to parent's desktop.");

                window.desktops = parent.desktops;

                return;
            }
        }

        installWindowHandlers(window);

        const mainDesktop = workspace.desktops[0];

        if (workspace.currentDesktop !== mainDesktop &&
            isManagedDesktop(workspace.currentDesktop) &&
            !sameClassDesktop(window) &&
            exclusiveDesktops)
        {
            logWindow(window,
                "Moving unrelated window to main desktop.");

            window.desktops = [mainDesktop];

            workspace.currentDesktop = mainDesktop;
        }

        //
        // Initialize maximize state for windows that
        // are already maximized when created.
        //
        if (handleMaximized && isWindowMaximized(window))
        {
            setMaximizedMode(window, MAXIMIZED);
        }
        else
        {
            setMaximizedMode(window, 0);
        }

        //
        // Newly-created fullscreen windows don't emit
        // fullScreenChanged either, so simply evaluate.
        //
        evaluateWindow(window);

    });

    if (enablePanelVisibility)
    {
       workspace.currentDesktopChanged.connect(function() {

            panelTimer.stop();
            panelTimer.start();

        });
    }

    log("Workspace handlers installed.");
}

log("Initializing...");

install();
