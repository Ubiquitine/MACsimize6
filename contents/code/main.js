var handleFullscreen = readConfig("handleFullscreen", true);
var handleMaximized = readConfig("handleMaximized", true);
var moveToLast = readConfig("moveToLast", false);
var enableIfOnlyOne = readConfig("enableIfOnlyOne", false);
var enablePanelVisibility = readConfig("enablePanelVisibility", false);
var exclusiveDesktops = readConfig("exclusiveDesktops", true)
var debugMode = readConfig("debugMode", false)

function log(msg) {
    if (debugMode) {
        print(`MACsimize6: ${msg}`);
    }
}

const savedData = new Map();
const managedDesktops = [];

const systemSkippedWindows = [
    'kwin',
    'kwin_wayland',
    'ksmserver-logout-greeter',
    'ksmserver',
    'kscreenlocker_greet',
    'ksplash',
    'ksplashqml',
    'plasmashell',
    'org.kde.plasmashell',
    'krunner'
    ];
var configSkippedWindows = readConfig("SkipWindows", "lattedock, latte-dock, org.kde.spectacle, org.kde.yakuake").toString().toLowerCase().split(/,\s*/);
var alwaysSkippedWindows = systemSkippedWindows.concat(configSkippedWindows)

function shouldSkip(window) {
    const windowClass = (window.resourceClass.toString() || "").toLowerCase();

    // If the window is not a normal window it should be skipped
    if (window.desktopWindow ||
        window.dock ||
        window.toolbar ||
        window.menu ||
        window.dialog ||
        window.splash ||
        window.utility ||
        window.dropdownMenu ||
        window.popupMenu ||
        window.tooltip ||
        window.notification ||
        window.criticalNotification ||
        window.appletPopup ||
        window.onScreenDisplay ||
        window.comboBox ||
        window.popupWindow ||
        window.specialWindow ||
        window.inputMethod) {

        log("Skipped: Special window");
        return true;
    }

    // Windows with empty class should be skipped
    if (!windowClass) {
        log(`Skipped: Null`);
        return true;
    }

    // Some system and user defined windows should be skipped
    if (alwaysSkippedWindows.indexOf(windowClass) != -1) {
        log(`Skipped: ${windowClass}`);
        return true;
    }

    log(`Check passed for: ${windowClass}`);
    return false;
}

function getNextDesktopNumber() {
    log(`Getting next desktop number ${workspace.currentDesktop}`);

    for (i = 0; i < workspace.desktops.length; i++) {
        desktop = workspace.desktops[i];

        if (desktop == workspace.currentDesktop) {
            log(`Found: ${desktop.name} Number: ${i}`);
            return i + 1;
        }
    }
}

// Functions to updated and delete saved data
function updateSavedData(windowId, patch) {
    const prev = savedData.get(windowId) || {};
    const merged = Object.assign({}, prev, patch);
    savedData.set(windowId, merged);
}

function deleteSavedData(windowId, field) {
    const data = savedData.get(windowId);

    if (!data) return;

    if (field in data) {
        delete data[field];
    }
}

function moveToNewDesktop(window) {
    let windowName = window.caption.toString();
    let windowId = window.internalId;
    const data = savedData.get(windowId);
    let numMonitors = workspace.screens.length;
    log(`enableIfOnlyOne: ${enableIfOnlyOne}`);

    if (enableIfOnlyOne && numMonitors > 1) {
        log(`Detected ${numMonitors} monitors`);
        return;
    } else if (data && data.macsimized) {
        log(`Window: ${windowId} is already on separate desktop`);
        return;
    } else {
        log(`Creating new desktop with name: ${windowName}`);
        let newDesktopNumber = -1;

        if (moveToLast) {
            newDesktopNumber = workspace.desktops.length;
        } else {
            newDesktopNumber = getNextDesktopNumber();
        }

        // Mapping data for the MACsimized window
        updateSavedData(windowId, {
            resourceClass: window.resourceClass.toString(),
            desktops: window.desktops,
            macsimized: true
        });

        // Creating a new desktop
        workspace.createDesktop(newDesktopNumber, windowName);
        newDesktop = workspace.desktops[newDesktopNumber];

        if (!managedDesktops.includes(newDesktop)) {
            managedDesktops.push(newDesktop);
        }

        log(`Saved desktops for window ${windowId} : ${JSON.stringify(savedData.get(windowId))}`);
        ds = [newDesktop];
        // Moving window to the new desktop
        window.desktops = ds;
        // Switching to the new desktop
        workspace.currentDesktop = newDesktop;
    }
}

function cleanDesktop(desktop) {
    log(`Cleaning desktop: ${JSON.stringify(desktop)}`);

    // Going through the list of all windows
    for (var i in workspace.windowList()) {
        let window = workspace.windowList()[i];

        // If a window is assigned the desktop - remove the desktop from the list of desktops
        if (window.desktops.includes(desktop) && !window.skipTaskbar) {
            let windowName = window.resourceName;
            log(`Window: ${windowName} is on the desktop`);
            window.desktops = window.desktops.filter(item => item.id !== desktop.id);

            // If it was a single dektop for this window - move it to the main desktop
            if (window.desktops.length < 1) {
                window.desktops = [workspace.desktops[0]];
            }

            log(`Window ${windowName}: ${JSON.stringify(window.desktops)}`);
        }
    }
}

function restoreDesktop(window) {
    let windowId = window.internalId;
    const data = savedData.get(windowId);
    log(`Restoring desktops for ${windowId}`);
    log(`Saved data: ${JSON.stringify(data)}`)
    let windowDesktop = window.desktops[0];
    log(`Current desktop: ${JSON.stringify(windowDesktop)}`);

    // Only move window that has been MACsimized
    if (data && data.macsimized) {
        log(`Restoring window ${windowId} to the main desktops`);

        // Remove MACsimized indicator for the window
        deleteSavedData(windowId, "macsimized");

        // Delete the window's desktop and move the window to the main desktop
        window.desktops = [workspace.desktops[0]];
        cleanDesktop(windowDesktop);
        workspace.currentDesktop = window.desktops[0];
        workspace.removeDesktop(windowDesktop);

        // Update saved data for managed desktops
        let idx = managedDesktops.indexOf(windowDesktop);

        if (idx !== -1) {
            managedDesktops.splice(idx, 1);
        }

    } else {
        log(`${windowId} is not MACSimized. Not restoring.`)
    }
}

function fullScreenChanged(window) {
    let windowId = window.internalId;
    const data = savedData.get(windowId);
    log(`Window : ${windowId} full-screen : ${window.fullScreen}`);

    // Move full-screened window to its new desktop
    // Restore un-full-screened window to the main desktop
    // If the window is still maximized - leave it where it is
    if (window.fullScreen) {
        moveToNewDesktop(window);
    } else if (data && data.macsimized && data.windowMode === 3) {
        log(`Window: ${windowId} is still maximized.`);
        return;
    } else {
        restoreDesktop(window);
        workspace.raiseWindow(window);
    }
}

function maximizedStateChanged(window, mode) {
    let windowId = window.internalId;

    // Save the window mode
    updateSavedData(windowId, {
        windowMode: mode
    });

    log(`Window : ${windowId} maximized mode : ${mode}`);

    // If window is maximized - move it to it's new desktop
    // If window is un-maximized - restore it to the main desktop
    if (mode == 3) {
        moveToNewDesktop(window);
    } else {
        restoreDesktop(window);
        workspace.raiseWindow(window);
    }
}

function minimizedStateChanged(window) {
    let windowId = window.internalId;
    const data = savedData.get(windowId);

    // If window is minimized resore it to the main desktop
    // If unminimized, create a new desktop for it
    // Only do it for MACsimized windows
    if (window.minimized && data && data.macsimized) {
        log(`window: ${windowId} is minimized. Restoring desktops`);
        updateSavedData(windowId, {
            minimized: true
        });
        restoreDesktop(window);
    } else if (data && data.minimized && data.windowMode === 3) {
        log(`Window: ${windowId} is un-minimized and was maximized before.`);
        deleteSavedData(windowId, "minimized");
        moveToNewDesktop(window);
    } else {
        log(`Nothing to do for window ${windowId}`);
        return;
    }
}

function windowCaptionChanged(window) {
    let windowId = window.internalId;
    let windowName = window.caption.toString();
    const data = savedData.get(windowId);

    // Update the name of the MACsimized window desktop
    if (data && data.macsimized) {
        log(`Updating desktop name for ${windowId}`);
        window.desktops[0].name = windowName;
    }
}

function togglePanelVisibility() {
    let defaultDesktop = workspace.desktops[0];
    // Default panel visibility
    let panelVisibility = 'none';

    // If we are not on the main desktop, set panel visibility to DodgeWindows
    if (workspace.currentDesktop !== defaultDesktop) {
        panelVisibility = 'dodgewindows';
    }

    // Script to go theough all panels and set visibility
    var script = `
    for (let id of panelIds) {
        let p = panelById(id);
        p.hiding = "${panelVisibility}";
    }
    `;

    // Call DBus and execute the script
    callDBus(
        "org.kde.plasmashell",
        "/PlasmaShell",
        "org.kde.PlasmaShell",
        "evaluateScript",
        script
    );
}

function sameClassDesktop(window) {
    const windowClass = window.resourceClass.toString();
    const currentDesktop = workspace.currentDesktop;
    log(`Checking ${window.internalId} - ${windowClass} for same-class desktop`);

    if (savedData.size === 0) {
        log(`saved Desktops is empty`);
        return false;
    }

    // Go though tracked windows
    for (const [windowId, saved] of savedData) {
        log(`Testing saved entry for windowId: ${windowId}, ${saved.resourceClass}`);

        // Skip non macsimized and windows that don't match the class
        if (!saved.macsimized) continue;
        if (saved.resourceClass !== windowClass) continue;

        // If macsimized window with the same class is on the current desktop
        if (saved.desktops.includes(currentDesktop)) {
            log(`Match found for class ${windowClass} on current desktop`);
            // Yes the window has the same class as the macsimized window on the current desktop
            return true;
        }
    }

    log(`No matches found for ${windowClass} in saved data`);
    return false;
}

function installWindowHandlers(window) {
    log(`Cheking window ${window.resourceClass.toString()} before installing handler`);

    // Check if the window is normal and can be maximized and full-screened.
    if (window !== null &&
        window.normalWindow &&
        !window.skipTaskbar &&
        !window.splash &&
        (window.fullScreenable || window.maximizable)) {

        log(`Window is good: ${window.resourceClass.toString()}`);
        let windowId = window.internalId;
        const data = savedData.get(windowId);

        // Skipt if the window s already being tracked
        if (data && data.tracked) {
            log(`${windowId} is already being tracked`);
            return;
        }

        log(`Now tracking ${windowId}`);

        // Mark window as tracked
        updateSavedData(windowId, {
            tracked: true
        });

        log(`Installing handles for ${windowId}`);

        // Install handlers for maximized state if enabled
        if (handleMaximized && window.maximizable) {
            window.maximizedAboutToChange.connect(function(mode) {
                log(`${windowId}: maximized changed`);
                maximizedStateChanged(window, mode);
            });
            window.minimizedChanged.connect(function() {
                log(`${windowId}: minimized changed`);
                minimizedStateChanged(window);
            });
        }

        // Install handlers for full-screen state if enabled
        if (handleFullscreen && window.fullScreenable) {
            window.fullScreenChanged.connect(function() {
                log(`${windowId}: full-screem changed`);
                fullScreenChanged(window);
            });
        }

        // Install handlers for window caption chage
        if ((handleFullscreen && window.fullScreenable) || (handleMaximized && window.maximizable)) {
            window.captionChanged.connect(function() {
                log(`${windowId}: caption changed`);
                windowCaptionChanged(window);
            });
        }

        // Restore desktop and purge data for closed windows
        window.closed.connect(function() {
            log(`${windowId}: closed`);
            restoreDesktop(window);
            savedData.delete(windowId);
        });
    }
}

function install() {
    log(`Installing handler for workspace to track activated windows`);
    workspace.windowActivated.connect(window => {
        // Check if window should be skipped (ignored list)
        if (shouldSkip(window)) {
            return;
        }

        installWindowHandlers(window)
    });
    workspace.windowAdded.connect(window => {
        // Check if window should be skipped (ignored list)
        if (shouldSkip(window)) {
            return; // Skipped windows can open anywhere without restrictions
        }

        // Handle transient windows (dialogs, toolbars, etc.) - logic requirement #3
        // Move them to the same desktop as their parent window
        if (window.transient && window.transientFor) {
            let parentWindow = window.transientFor;
            let parentId = parentWindow.internalId;
            log(`Transient window detected. Parent: ${parentId}`);

            // If parent is on a dedicated desktop, move this transient window there too
            if (savedData.get(parentId).macsimized) {
                log(`Moving transient window to parent's desktop`);
                window.desktops = parentWindow.desktops;
                return; // Don't process further for transient windows
            }
        }

        installWindowHandlers(window);
        // Get workspace area for maximized windows
        var area = workspace.clientArea(KWin.MaximizeArea, window);

        // If window is "maximized" move it to a new desktop right away
        if (window.width + 1 >= area.width && window.height + 1 >= area.height && handleMaximized) {
            moveToNewDesktop(window);
        } else {
            // If we're on a non-main desktop and the new window is not maximized,
            // force it to open on the main desktop and switch to main desktop (logic requirement #5)
            let mainDesktop = workspace.desktops[0];

            if (workspace.currentDesktop !== mainDesktop &&
                managedDesktops.includes(workspace.currentDesktop) &&
                !sameClassDesktop(window) &&
                exclusiveDesktops) {
                log(`New non-maximized window opened on non-main desktop. Moving to main desktop and switching.`);
                window.desktops = [mainDesktop];
                workspace.currentDesktop = mainDesktop;
            }
        }
    });

    // Install handler for panel visibility if enabled
    if (enablePanelVisibility) {
        workspace.currentDesktopChanged.connect(togglePanelVisibility)
    }

    log(`Workspace handler installed`);
}

log(`Initializing...`);
install();
