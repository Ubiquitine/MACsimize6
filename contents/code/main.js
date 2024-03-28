function log(msg) {
    // print("MACsimize6: " + msg);
}

var handleFullscreen = readConfig("handleFullscreen", true);
var handleMaximized = readConfig("handleMaximized", true);

const savedDesktops = {};
const savedModes = {};

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
    let windowName = window.resourceName.toString();
    let windowId = window.internalId.toString();
    if (windowId in savedDesktops) {
        log("Window: " + windowId + " is already on separate desktop");
        return ;
    } else {
        log("Creating new desktop with name : " | windowName);
        let newDesktopNumber = getNextDesktopNumber();
        workspace.createDesktop(newDesktopNumber, windowName);
        newDesktop = workspace.desktops[newDesktopNumber];
        savedDesktops[windowId] = window.desktops;
        log("Saved desktops fot window " + windowId + ": " + JSON.stringify(savedDesktops[windowId]))
        ds = [newDesktop]
        window.desktops = ds
        workspace.currentDesktop = newDesktop;
    }
}

function sanitizeDesktops(desktops) {
    log("Sanitizing desktops: " + JSON.stringify(desktops))
    let sanitizedDesktops = desktops.filter(value => Object.keys(value).length !== 0);
    log("sanitized Desktops: " + JSON.stringify(sanitizedDesktops))
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
    log(currentDesktop);
    if (windowId in savedDesktops ) {
        log("Found saved desktops for: " + windowId);
        let desktops = sanitizeDesktops(savedDesktops[windowId]);
        log("Saved desktops for window: " + windowId + ": " + JSON.stringify(savedDesktops[windowId]) + " before restore");
        delete savedDesktops[windowId];
        delete savedModes[windowId];
        window.desktops = desktops;
        cleanDesktop(currentDesktop);
        workspace.currentDesktop = window.desktops[0];
        workspace.removeDesktop(currentDesktop);
        workspace.raiseWindow(window);
        log("Saved desktops for window: " + windowId + ": " + JSON.stringify(savedDesktops[windowId]) + " after restore");
    } else {
        log(windowId + " has no saved desktops. Not restoring")
    }

}

function fullScreenChanged(window) {
    let windowId = window.internalId.toString();
    log("Window : " + windowId + " fullscreen : " + window.fullScreen);
    if (window.fullScreen) {
        moveToNewDesktop(window);
    } else if (windowId in savedModes && savedModes[windowId] == 3){
        log("window: " + windowId + "is still maximized.");
        return;
    } else {
        restoreDesktop(window);
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
    }
}

function install() {
    log("Installing handler for workspace windowActivated");
    workspace.windowActivated.connect(window => {
        // Check if the window is normal
        let windowId = window.internalId.toString();
        if (window.normalWindow && window.fullScreenable && window.maximizable){
            log("Installing handles for " + windowId);
            if (handleMaximized) {
                window.maximizedAboutToChange.connect(function (mode) {
                    log(windowId + ": maximized changed");
                    maximizedStateChanged(window, mode);
                });
            }
            if (handleFullscreen) {
                window.fullScreenChanged.connect(function () {
                    log(windowId + ": fullscreen changed");
                    fullScreenChanged(window);
                });
            }
            window.closed.connect(function () {
                log(windowId + ": closed");
                restoreDesktop(window);
            });
        }
    });
    log("Workspacke handler installed");
}


log("Initializing...");
install();
