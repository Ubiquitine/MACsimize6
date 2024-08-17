function log(msg) {
    // print("MACsimize6: " + msg);
}

var handleFullscreen = readConfig("handleFullscreen", true);
var handleMaximized = readConfig("handleMaximized", true);
var moveToLast = readConfig("moveToLast", false);

const savedDesktops = {};
const savedModes = {};
const savedHandlers = {};

const systemSkippedWindows = ['kwin_wayland', 'ksmserver-logout-greeter', 'ksmserver',
    'kscreenlocker_greet', 'plasmashell', 'org.kde.plasmashell', 'krunner'];
var configSkippedWindows = readConfig("SkipWindows", "lattedock, latte-dock, org.kde.spectacle").toString().toLowerCase().split(/,\s*/);
var alwaysSkippedWindows = systemSkippedWindows.concat(configSkippedWindows)

function shouldSkip(window) {
    const windowClass = window.resourceClass.toString();
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
    if (windowId in savedDesktops) {
        log("Window: " + windowId + " is already on separate desktop");
        return ;
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
        savedDesktops[windowId] = window.desktops;
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

function installWindowHandlers(window) {
    // Check if the window is normal and can be maximized and full-screened.
    if (window !== null && window.normalWindow && ( window.fullScreenable || window.maximizable ) ){
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
        if (shouldSkip(window)) {
            return;
        }
        installWindowHandlers(window);
        // Get worksace area or maximized windows
        var area = workspace.clientArea(KWin.MaximizeArea, window);
        // If window is "maximized" move it a new desktop right away
        if(window.width + 1 >= area.width && window.height + 1 >= area.height && handleMaximized) {
            moveToNewDesktop(window);
        }
    });
    log("Workspace handler installed");
}


log("Initializing...");
install();
