function log(msg) {
    // print("MACsimize6: " + msg);
}

var handleFullscreen = readConfig("handleFullscreen", true);
var handleMaximized = readConfig("handleMaximized", true);
var moveToLast = readConfig("moveToLast", false);
var enableIfOnlyOne = readConfig("enableIfOnlyOne", false);
var enablePanelVisibility = readConfig("enablePanelVisibility", false);
var exclusiveDesktops = readConfig("exclusiveDesktops", true)

const savedDesktops = {};
const savedModes = {};
const savedHandlers = {};

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
    log(`Handled: ${windowClass}`);
    return false;
}

function getNextDesktopNumber() {
    log("Getting next desktop number " + workspace.currentDesktop);
    for (i = 0; i < workspace.desktops.length; i++) {
        desktop = workspace.desktops[i];
        if (desktop == workspace.currentDesktop) {
            log("Found: " + desktop.name + " Number: " + i);
            return i + 1;
        }
    }
}

function moveToNewDesktop(window) {
    let windowName = window.caption.toString();
    let windowId = window.internalId.toString();
    let numMonitors = workspace.screens.length;

    log("enableIfOnlyOne: " + enableIfOnlyOne);
    if (enableIfOnlyOne && numMonitors > 1) {
        log("enableIfOnlyOne: " + enableIfOnlyOne);
        log("Detected " + numMonitors + " Monitors");
        return;
    } else if (windowId in savedDesktops) {
        log("Window: " + windowId + " is already on separate desktop");
        return;
    } else {
        log("Creating new desktop with name : " | windowName);
        let newDesktopNumber = -1;
        if (moveToLast) {
            newDesktopNumber = workspace.desktops.length;
        } else {
            newDesktopNumber = getNextDesktopNumber();
        }
        workspace.createDesktop(newDesktopNumber, windowName);
        newDesktop = workspace.desktops[newDesktopNumber];
        // Always save the main desktop (first desktop) for restoration
        savedDesktops[windowId] = [workspace.desktops[0]];
        log("Saved desktops for window " + windowId + ": " + JSON.stringify(savedDesktops[windowId]))
        ds = [newDesktop]
        window.desktops = ds
        workspace.currentDesktop = newDesktop;
    }
}

function sanitizeDesktops(desktops) {
    log("Sanitizing desktops: " + JSON.stringify(desktops))
    let sanitizedDesktops = desktops.filter(value => Object.keys(value).length !== 0);
    log("Sanitized Desktops: " + JSON.stringify(sanitizedDesktops))
    if (sanitizedDesktops.length < 1) {
        sanitizedDesktops = [workspace.desktops[0]];
    }
    return sanitizedDesktops
}

function cleanDesktop(desktop) {
    log("Cleaning desktop: " + JSON.stringify(desktop));
    for (var i in workspace.windowList()) {
        let window = workspace.windowList()[i];
        if (window.desktops.includes(desktop) && !window.skipTaskbar) {
            let windowName = window.resourceName;
            log ("Window: " + windowName + " is on the desktop");
            window.desktops = window.desktops.filter(item => item.id !== desktop.id);
            if (window.desktops.length < 1) {
                window.desktops = [workspace.desktops[0]];
            }
            log("Window " + windowName + ": " + JSON.stringify(window.desktops));
        }
    }
}

function restoreDesktop(window) {
    let windowId = window.internalId.toString();
    log("Restoring desktops for " + windowId);
    let currentDesktop = window.desktops[0];
    log("Current desktop: " + JSON.stringify(currentDesktop));
    if (windowId in savedDesktops ) {
        log("Found saved desktops for: " + windowId);
        let desktops = sanitizeDesktops(savedDesktops[windowId]);
        log("Saved desktops for window: " + windowId + ": " + JSON.stringify(savedDesktops[windowId]) + " before restore");
        delete savedDesktops[windowId];
        window.desktops = desktops;
        cleanDesktop(currentDesktop);
        workspace.currentDesktop = window.desktops[0];
        workspace.removeDesktop(currentDesktop);
    } else {
        log(windowId + " has no saved desktops. Not restoring")
    }

}

function fullScreenChanged(window) {
    let windowId = window.internalId.toString();
    log("Window : " + windowId + " full-screen : " + window.fullScreen);
    if (window.fullScreen) {
        moveToNewDesktop(window);
    } else if (windowId in savedModes && savedModes[windowId] == 3){
        log("window: " + windowId + "is still maximized.");
        return;
    } else {
        restoreDesktop(window);
        workspace.raiseWindow(window);
    }
}

function maximizedStateChanged(window, mode) {
    let windowId = window.internalId.toString();
    savedModes[windowId] = mode;
    log("Window : " + windowId + " maximized mode : " + mode);
    if (mode == 3) {
        moveToNewDesktop(window);
    } else {
        restoreDesktop(window);
        workspace.raiseWindow(window);
    }
}

function minimizedStateChanged(window) {
    let windowId = window.internalId.toString();
    if (window.minimized) {
        log("window: " + windowId + " is minimized. Restoring desktops");
        restoreDesktop(window);
    } else if (windowId in savedModes && savedModes[windowId] == 3) {
        log("window: " + windowId + " is un-minimized and was maximized before.");
        moveToNewDesktop(window);
    } else {
        log("Nothing to do for window " + windowId);
        return;
    }
}

function windowCaptionChanged(window) {
    let windowId = window.internalId.toString();
    let windowName = window.caption.toString();
    if (windowId in savedDesktops ) {
        log("Updating desktop name for " + windowId);
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

function installWindowHandlers(window) {
    // Check if the window is normal and can be maximized and full-screened.
    if (window !== null && window.normalWindow && ! window.skipTaskbar && ! window.splash && ( window.fullScreenable || window.maximizable ) ){
        let windowId = window.internalId.toString();
        if (windowId in savedHandlers) {
            log(windowId + " is already being tracked");
            return;
        } else {
            savedHandlers[windowId] = window.resourceName ;
        }
        log("Installing handles for " + windowId);
        if (handleMaximized && window.maximizable) {
            window.maximizedAboutToChange.connect(function (mode) {
                log(windowId + ": maximized changed");
                maximizedStateChanged(window, mode);
            });
            window.minimizedChanged.connect(function () {
                log(windowId + ": minimized changed");
                minimizedStateChanged(window);
            });
        }
        if (handleFullscreen && window.fullScreenable) {
            window.fullScreenChanged.connect(function () {
                log(windowId + ": full-screen changed");
                fullScreenChanged(window);
            });
        }
        if ((handleFullscreen && window.fullScreenable) || (handleMaximized && window.maximizable)) {
            window.captionChanged.connect(function () {
                log(windowId + ": Caption changed");
                windowCaptionChanged(window);
            });
        }

        window.closed.connect(function () {
            log(windowId + ": closed");
            restoreDesktop(window);
            delete savedHandlers[windowId];
            delete savedModes[windowId];
        });
    }
}

function install() {
    log("Installing handler for workspace to track activated windows");
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
            let parentId = parentWindow.internalId.toString();
            log("Transient window detected. Parent: " + parentId);
            
            // If parent is on a dedicated desktop, move this transient window there too
            if (parentId in savedDesktops) {
                log("Moving transient window to parent's desktop");
                window.desktops = parentWindow.desktops;
                return; // Don't process further for transient windows
            }
        }
        
        // Handle popup menus and context menus (like Dolphin's context menu)
        // These should stay on the current desktop to avoid KWin crashes
        if (window.popupWindow || window.dropdownMenu || window.popupMenu || window.tooltip || window.comboBox) {
            log("Popup/menu window detected. Skipping desktop management to avoid crashes.");
            return;
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
            if (workspace.currentDesktop !== mainDesktop  && exclusiveDesktops) {
                log("New non-maximized window opened on non-main desktop. Moving to main desktop and switching.");
                window.desktops = [mainDesktop];
                workspace.currentDesktop = mainDesktop;
            }
        }
    });

    if (enablePanelVisibility) {
        workspace.currentDesktopChanged.connect(togglePanelVisibility)
    }
    log("Workspace handler installed");
}

log("Initializing...");
install();
