//
// Configuration
//

const handleFullscreen      = readConfig("handleFullscreen", true);
const handleMaximized       = readConfig("handleMaximized", true);
const moveToLast            = readConfig("moveToLast", false);
const enableIfOnlyOne       = readConfig("enableIfOnlyOne", false);
const enablePanelVisibility = readConfig("enablePanelVisibility", false);
const exclusiveDesktops     = readConfig("exclusiveDesktops", true);
const useAbsoluteEnds      = readConfig("useAbsoluteEnds", false);
const smoothAnimationTime   = readConfig("smoothAnimationTime", 700);
const debugMode             = readConfig("debugMode", false);


//
// Globals
//

let lastPanelMode = "";
let panelVisibilityLock = 0;

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
const pendingDesktopRemovals = new Set();

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
    .replace(/\r?\n/g, ",")
    .split(/\s*,\s*/)
    .filter(s => s.length > 0);

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

            dedicatedDesktop: null,

            moveGeneration: 0,

            transitioning: false,

            needsEvaluation: false
        });
    }

    return savedData.get(id);
}

function findState(window)
{
    if (!window)
        return null;

    return savedData.get(window.internalId) || null;
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
    const state = findState(window);

    return state !== null && state.dedicatedDesktop !== null;
}

function beginDesktopTransition(state)
{
    if (state.transitioning)
    {
        state.needsEvaluation = true;
        return false;
    }

    state.transitioning = true;
    return true;
}

function finishDesktopTransition(window, state)
{
    if (findState(window) !== state)
        return;

    state.transitioning = false;

    if (!state.needsEvaluation)
        return;

    state.needsEvaluation = false;
    evaluateWindow(window);
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

function getUnmanagedDesktopNumber()
{
    if (!useAbsoluteEnds)
    {
        for (let i = workspace.currentDesktop.x11DesktopNumber - 2; i >= 0; i--)
        {
            if (!isManagedDesktop(workspace.desktops[i]))
                return i;
        }
    }

    const index = workspace.desktops.findIndex(desktop => !isManagedDesktop(desktop));

    if (index >= 0)
        return index;

    workspace.createDesktop(0, "");
    if (isManagedDesktop(workspace.desktops[0]))
        throw new Error("Cannot create an unmanaged desktop");

    return 0;
}

function getNextDesktopNumber()
{
    if (moveToLast)
    {
        if (!useAbsoluteEnds)
        {
            // Try to find the end of the current block of managed desktops
            for (let i = workspace.currentDesktop.x11DesktopNumber; i < workspace.desktops.length; ++i)
            {
                if (!isManagedDesktop(workspace.desktops[i]))
                    return i;
            }
        }

        return workspace.desktops.length;
    }
    else
    {
        // The X11 Desktop Number is 1-indexed, the return value
        // is 0-indexed, so one is already added.
        return workspace.currentDesktop.x11DesktopNumber;
    }
}

//
// Window filtering
//

function shouldSkip(window)
{
    // Windows without a taskbar entry (layer-shell popups such as fuzzel, recording overlays such as
    // Handy's, OSDs) are not app windows: KWin reports some as normal windows, and moving them to
    // another desktop switches the screen away from the app they serve.
    if (!window ||
        window.skipTaskbar ||
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

function delayedCall(delay, fn)
{
    if (delay)
    {
        let timer = new QTimer();
        timer.interval = delay;
        timer.singleShot = true;
        timer.timeout.connect(fn);
        timer.start();
    }
    else
    {
        fn();
    }
}

//
// Desktop management
//

function isManagedDesktop(desktop)
{
    if (!desktop)
        return false;

    if (pendingDesktopRemovals.has(desktop.id))
        return true;

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
    const index = getNextDesktopNumber();

    workspace.createDesktop(index, window.caption.toString());

    return workspace.desktops[index];
}

function removeManagedDesktop(desktop)
{
    if (!desktop)
        return;

    workspace.removeDesktop(desktop);
}

function moveToDesktop(window, newDesktop, oldDesktop) {
    const windowId = window.internalId;
    const state = getState(window);
    const generation = ++state.moveGeneration;
    const newDesktopId = newDesktop.id;
    const oldDesktopId = oldDesktop ? oldDesktop.id : null;

    if (oldDesktopId)
        pendingDesktopRemovals.add(oldDesktopId);

    // Changing panel visibility interrupts the maximize
    // animation, but the un-maximize animation is fine.
    if (!oldDesktop)
        ++panelVisibilityLock;

    if (smoothAnimationTime)
        window.onAllDesktops = true;

    workspace.currentDesktop = newDesktop;

    delayedCall(smoothAnimationTime, function() {

        if (state.moveGeneration === generation)
        {
            // Desktop QObjects may have been destroyed during the animation.
            let destination = workspace.desktops.find(desktop => desktop.id === newDesktopId);

            if (savedData.get(windowId) === state)
            {
                if (!destination)
                {
                    // The retired source must not be selected as the replacement.
                    const source = workspace.desktops.find(desktop => desktop.id === oldDesktopId);
                    if (source)
                        removeManagedDesktop(source);

                    destination = workspace.desktops[getUnmanagedDesktopNumber()];
                }

                window.onAllDesktops = false;
                window.desktops = [destination];
            }
        }

        if (!oldDesktop)
            --panelVisibilityLock;

        if (enablePanelVisibility)
            updatePanelVisibility();

        const source = workspace.desktops.find(desktop => desktop.id === oldDesktopId);

        if (source)
            removeManagedDesktop(source);

        pendingDesktopRemovals.delete(oldDesktopId);

    });
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

    if (!beginDesktopTransition(state))
        return;

    logWindow(window, "Creating dedicated desktop.");

    try
    {
        state.resourceClass = getWindowClass(window);

        const desktop = createManagedDesktop(window);

        state.dedicatedDesktop = desktop;

        moveToDesktop(window, desktop);
    }
    finally
    {
        finishDesktopTransition(window, state);
    }
}

function restoreDesktop(window)
{
    const state = getState(window);

    if (!state.dedicatedDesktop)
    {
        logWindow(window, "Window is not managed.");
        return;
    }

    if (!beginDesktopTransition(state))
        return;

    const currentDesktop = state.dedicatedDesktop;

    logWindow(window, "Restoring to unmanaged desktop.");

    try
    {
        const desktop = workspace.desktops[getUnmanagedDesktopNumber()];

        //
        // Clear our state first so recursive events
        // don't think we're still managed.
        //
        state.dedicatedDesktop = null;

        moveToDesktop(window, desktop, currentDesktop);
    }
    finally
    {
        finishDesktopTransition(window, state);
    }
}

function cleanupClosedWindow(window)
{
    const state = findState(window);

    if (!state)
        return;

    const desktop = state.dedicatedDesktop;
    const wasCurrent = desktop && workspace.currentDesktop === desktop;

    // The window is already being destroyed, so do not assign any of its
    // properties. Only return the workspace to a valid desktop and remove
    // the dedicated desktop that belonged to this window.
    state.dedicatedDesktop = null;
    state.needsEvaluation = false;

    if (desktop)
    {
        removeManagedDesktop(desktop);

        if (wasCurrent)
            workspace.currentDesktop = workspace.desktops[getUnmanagedDesktopNumber()];
    }

    purgeState(window);
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

function moveTransientToParentDesktop(window)
{
    if (!window || !window.transientFor)
        return false;

    const parent = window.transientFor;

    if (!parent || !isManaged(parent))
        return false;

    logWindow(window, "Moving transient window to parent's desktop.");

    window.desktops = parent.desktops;
    return true;
}

//
// Window evaluation
//

function evaluateWindow(window)
{
    const state = getState(window);

    if (state.transitioning)
    {
        state.needsEvaluation = true;
        return;
    }

    //
    // Minimized windows are always restored to an unmanaged desktop.
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

        cleanupClosedWindow(window);

    });
}

//
// Panel visibility
//

function updatePanelVisibility()
{
    if (panelVisibilityLock)
        return;

    let panelVisibility =
    isManagedDesktop(workspace.currentDesktop)
        ? "dodgewindows"
        : "none";

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

    let currentDesktopId = workspace.currentDesktop.id;

    // Removing a dedicated desktop restores its window on an unmanaged desktop.
    workspace.desktopsChanged.connect(function() {

        const previousDesktopId = currentDesktopId;

        for (const [windowId, state] of [...savedData])
        {
            if (!state.dedicatedDesktop ||
                workspace.desktops.some(desktop => desktop.id === state.dedicatedDesktop.id))
                continue;

            const wasCurrent = state.dedicatedDesktop.id === previousDesktopId;
            state.dedicatedDesktop = null;
            state.maximizedMode = 0;
            ++state.moveGeneration;

            const window = workspace.windowList().find(window => window.internalId === windowId);

            if (window)
            {
                // Wayland may still report fullscreen while restore signals arrive.
                state.transitioning = true;
                try
                {
                    const desktop = workspace.desktops[getUnmanagedDesktopNumber()];
                    window.onAllDesktops = false;
                    window.desktops = [desktop];
                    if (wasCurrent)
                        workspace.currentDesktop = desktop;
                    window.fullScreen = false;
                    window.setMaximize(false, false);
                }
                finally
                {
                    state.transitioning = false;
                    state.needsEvaluation = false;
                }
            }

            if (enablePanelVisibility)
                updatePanelVisibility();
        }

        // Nested desktop creation must still see the original active owner.
        currentDesktopId = workspace.currentDesktop.id;

    });

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

        // Handle transient dialogs, toolbars, and other special windows
        // before filtering them out of normal window tracking.
        if (moveTransientToParentDesktop(window))
            return;

        if (shouldSkip(window))
            return;

        installWindowHandlers(window);

        //
        // Move unrelated windows from the
        // dedicated desktop to an unmanaged desktop.
        //
        if (isManagedDesktop(workspace.currentDesktop) &&
            !sameClassDesktop(window) &&
            exclusiveDesktops)
        {
            logWindow(window,
                "Moving unrelated window to unmanaged desktop.");

            const newDesktop = workspace.desktops[getUnmanagedDesktopNumber()];
            window.desktops = [newDesktop];

            workspace.currentDesktop = newDesktop;
        }

        // installWindowHandlers can reject windows that should not be
        // tracked. Do not allocate state for them because they have no
        // closed handler to purge it.
        const state = findState(window);

        if (!state || !state.tracked)
            return;

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

    workspace.currentDesktopChanged.connect(function() {

        // Keep the removed desktop's id until desktopsChanged handles its owner.
        if (workspace.desktops.some(desktop => desktop.id === currentDesktopId))
            currentDesktopId = workspace.currentDesktop.id;

        if (enablePanelVisibility)
            updatePanelVisibility();

    });

    log("Workspace handlers installed.");
}

log("Initializing...");

install();
