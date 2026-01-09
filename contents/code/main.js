
var handleFullscreen = readConfig("handleFullscreen", true);
var handleMaximized = readConfig("handleMaximized", true);
var moveToLast = readConfig("moveToLast", false);
var enableIfOnlyOne = readConfig("enableIfOnlyOne", false);
var enablePanelVisibility = readConfig("enablePanelVisibility", false);
var exclusiveDesktops = readConfig("exclusiveDesktops", true)
var debugMode = readConfig("debugMode", false)

function log(msg) {
    if(debugMode){
         print(`MACsimize6: ${msg}`);
    }
}

const savedData = new Map();
const managedDesktops = [];

const systemSkippedWindows = ['kwin', 'kwin_wayland', 'ksmserver-logout-greeter', 'ksmserver',
'kscreenlocker_greet', 'ksplash', 'ksplashqml', 'plasmashell', 'org.kde.plasmashell', 'krunner'];
var configSkippedWindows = readConfig("SkipWindows", "lattedock, latte-dock, org.kde.spectacle, org.kde.yakuake").toString().toLowerCase().split(/,\s*/);
var alwaysSkippedWindows = systemSkippedWindows.concat(configSkippedWindows)

function shouldSkip(window) {
    const windowClass = (window.resourceClass.toString() || "").toLowerCase();
    if (!windowClass) {
        log(`Skipped: Null`);
        return true;
    }

    if (alwaysSkippedWindows.indexOf(windowClass) != -1) {
        log(`Skipped: ${windowClass}`);
        return true;
    }
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
        window.inputMethod ) {
        log("Special window detected. Skipping desktop management to avoid crashes.");
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
        workspace.createDesktop(newDesktopNumber, windowName);
        newDesktop = workspace.desktops[newDesktopNumber];
        if (!managedDesktops.includes(newDesktop)) {
            managedDesktops.push(newDesktop);
        }

        updateSavedData(windowId, {
            resourceClass: window.resourceClass.toString(),
            desktops: window.desktops,
            macsimized: true
        });
        log(`Saved desktops for window ${windowId} : ${JSON.stringify(savedData.get(windowId))}`);
        ds = [newDesktop];
        window.desktops = ds;
        workspace.currentDesktop = newDesktop;
    }
}

function cleanDesktop(desktop) {
    log(`Cleaning desktop: ${JSON.stringify(desktop)}`);
    for (var i in workspace.windowList()) {
        let window = workspace.windowList()[i];
        if (window.desktops.includes(desktop) && !window.skipTaskbar) {
            let windowName = window.resourceName;
            log (`Window: ${windowName} is on the desktop"`);
            window.desktops = window.desktops.filter(item => item.id !== desktop.id);
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
    let currentDesktop = window.desktops[0];
    log(`Current desktop: ${JSON.stringify(currentDesktop)}`);
    if (data && data.macsimized) {
        log(`Restoring window ${windowId} to the main desktops`);
        deleteSavedData(windowId, "macsimized");
        window.desktops = [workspace.desktops[0]];
        cleanDesktop(currentDesktop);
        workspace.currentDesktop = window.desktops[0];
        workspace.removeDesktop(currentDesktop);

        let idx = managedDesktops.indexOf(currentDesktop);
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
    if (window.fullScreen) {
        moveToNewDesktop(window);
    } else if (data && data.macsimized && data.windowMode === 3){
        log(`Window: ${windowId} is still maximized.`);
        return;
    } else {
        restoreDesktop(window);
        workspace.raiseWindow(window);
    }
}

function maximizedStateChanged(window, mode) {
    let windowId = window.internalId;
    updateSavedData(windowId, {
        windowMode: mode
    });
    log(`Window : ${windowId} maximized mode : ${mode}`);
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
    if (window.minimized) {
        log(`window: ${windowId} is minimized. Restoring desktops`);
        restoreDesktop(window);
    } else if (data && data.macsimized && data.windowMode === 3) {
        log(`Window: ${windowId} is un-minimized and was maximized before.`);
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
    if (data && data.macsimized) {
        log(`Updating desktop name for ${windowId}`);
        window.desktops[0].name = windowName;
    }
}

function togglePanelVisibility() {
    let defaultDesktop = workspace.desktops[0];
    let panelVisibility = 'none';
    if ( workspace.currentDesktop !== defaultDesktop) {
        panelVisibility = 'dodgewindows';
    }
    var script = `
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

function sameClassDesktop(window) {
    const windowClass = window.resourceClass.toString();
    const currentDesktopId = workspace.currentDesktop;
    log(`Checking ${window.internalId} - ${windowClass} for same-class desktop`);

    if (savedData.size === 0) {
        log(`saved Desktops is empty`);
        return false;
    }

    for (const [windowId, saved] of savedData) {
        log(`Testing saved entry for windowId: ${windowId}, ${saved.resourceClass}`);

        if (saved.resourceClass !== windowClass) continue;

        if (saved.desktops.includes(currentDesktopId)) {
            log(`Match found for class ${windowClass} on current desktop`);
            return true;
        }
    }

    log(`No matches found for ${windowClass} in saved desktops`);
    return false;
}

function installWindowHandlers(window) {
    // Check if the window is normal and can be maximized and full-screened.
    log(`Cheking window ${window.resourceClass.toString()} before installing handler`);
    if (window !== null && window.normalWindow && ! window.skipTaskbar && ! window.splash && ( window.fullScreenable || window.maximizable ) ){
        log(`Window is good: ${window.resourceClass.toString()}`);
        let windowId = window.internalId;
        const data = savedData.get(windowId);
        if (data && data.tracked) {
            log(`${windowId} is already being tracked`);
            return;
        }
        log(`Now tracking ${windowId}`);
        updateSavedData(windowId, {
            tracked: true
        });
        log(`Installing handles for ${windowId}`);
        if (handleMaximized && window.maximizable) {
            window.maximizedAboutToChange.connect(function (mode) {
                log(`${windowId}: maximized changed`);
                maximizedStateChanged(window, mode);
            });
            window.minimizedChanged.connect(function () {
                log(`${windowId}: minimized changed`);
                minimizedStateChanged(window);
            });
        }
        if (handleFullscreen && window.fullScreenable) {
            window.fullScreenChanged.connect(function () {
                log(`${windowId}: full-screem changed`);
                fullScreenChanged(window);
            });
        }
        if ((handleFullscreen && window.fullScreenable) || (handleMaximized && window.maximizable)) {
            window.captionChanged.connect(function () {
                log(`${windowId}: caption changed`);
                windowCaptionChanged(window);
            });
        }

        window.closed.connect(function () {
            log(`${windowId}: closed`);
            restoreDesktop(window);
            savedData.delete(windowId);
        });
    }
}

function install() {
    log(`Installing handler for workspace to track activated windows`);
    workspace.windowActivated.connect(window => {
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
        if(window.width + 1 >= area.width && window.height + 1 >= area.height && handleMaximized) {
            moveToNewDesktop(window);
        } else {
            // If we're on a non-main desktop and the new window is not maximized,
            // force it to open on the main desktop and switch to main desktop (logic requirement #5)
            let mainDesktop = workspace.desktops[0];
            if (workspace.currentDesktop !== mainDesktop  &&
                managedDesktops.includes(workspace.currentDesktop) &&
                ! sameClassDesktop(window) &&
                exclusiveDesktops) {
                log(`New non-maximized window opened on non-main desktop. Moving to main desktop and switching.`);
            window.desktops = [mainDesktop];
            workspace.currentDesktop = mainDesktop;
                }
        }
    });

    if (enablePanelVisibility) {
        workspace.currentDesktopChanged.connect(togglePanelVisibility)
    }
    log(`Workspace handler installed`);
}

log(`Initializing...`);
install();
