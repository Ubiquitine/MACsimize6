// Run with: node --test --test-isolation=none tests/config-changes.test.cjs
//
// Covers configuration-driven behavior that the desktop-removal tests only
// exercise at their defaults:
//   1. handleMaximized / handleFullscreen toggles
//   2. moveToLast desktop positioning
//   3. enableIfOnlyOne multi-monitor skip
//   4. exclusiveDesktops unrelated-window relocation
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(`${__dirname}/../contents/code/main.js`, "utf8");

function signal()
{
    const handlers = [];
    return {
        connect(fn) { handlers.push(fn); },
        emit(...args) { handlers.forEach(fn => fn(...args)); }
    };
}

// config keys are read from `config`; smoothAnimationTime is always honored;
// screenCount controls workspace.screens.length.
function setup(config = {}, animationTime = 700)
{
    const timers = [], windows = [], deleted = new Set(), panelCalls = [];
    const screenCount = config.screenCount ?? 1;
    let nextId = 0;
    let currentDesktop;
    const workspace = {
        desktops: [], screens: Array.from({ length: screenCount }, () => ({})),
        windowAdded: signal(), windowActivated: signal(),
        desktopsChanged: signal(), currentDesktopChanged: signal(),
        get currentDesktop() { return currentDesktop; },
        set currentDesktop(desktop) {
            assert.ok(this.desktops.includes(desktop), "Invalid current desktop");
            if (desktop === currentDesktop) return;
            const previous = currentDesktop;
            currentDesktop = desktop;
            this.currentDesktopChanged.emit(previous);
        },
        windowList() { return windows; },
        clientArea() { return { width: 1920, height: 1080 }; },
        raiseWindow() {},
        createDesktop(index, name) {
            if (this.desktops.length >= (config.desktopLimit ?? Infinity)) return;
            const desktop = new Proxy({
                id: `desktop-${++nextId}`, name,
                get x11DesktopNumber() { return workspace.desktops.indexOf(desktop) + 1; }
            }, {
                get(target, key) {
                    assert.ok(!deleted.has(desktop), "Read from a deleted desktop");
                    return target[key];
                },
                set(target, key, value) {
                    assert.ok(!deleted.has(desktop), "Write to a deleted desktop");
                    target[key] = value;
                    return true;
                }
            });
            this.desktops.splice(index, 0, desktop);
            this.desktopsChanged.emit();
        },
        removeDesktop(desktop) {
            const index = this.desktops.indexOf(desktop);
            assert.ok(index >= 0, "Removing an already deleted desktop");
            if (this.desktops.length === 1) return;
            this.desktops.splice(index, 1);
            const fallback = this.desktops[Math.min(index, this.desktops.length - 1)];
            if (this.currentDesktop === desktop) this.currentDesktop = fallback;
            for (const window of windows) {
                if (window.desktops.includes(desktop)) window.desktops = [fallback];
            }
            this.desktopsChanged.emit();
            deleted.add(desktop);
        }
    };
    workspace.createDesktop(0, "User desktop");
    workspace.currentDesktop = workspace.desktops[0];
    const context = vm.createContext({
        workspace, KWin: { MaximizeArea: 0 }, print() {},
        callDBus(...args) { panelCalls.push(args); },
        readConfig(key, fallback) {
            return key === "smoothAnimationTime" ? animationTime : (config[key] ?? fallback);
        },
        QTimer: class {
            constructor() { this.timeout = signal(); }
            start() { timers.push(() => this.timeout.emit()); }
        }
    });
    vm.runInContext(source, context);
    function addWindow(id, skipTaskbar = false)
    {
        let desktops = [workspace.currentDesktop], closed = false;
        let maximizedMode = 0, fullScreen = false;
        const window = {
            internalId: id, caption: id, resourceClass: id, normalWindow: true,
            maximizable: true, fullScreenable: true, width: 800, height: 600,
            minimized: false, skipTaskbar,
            get maximizeMode() { return maximizedMode; },
            setMaximize(vertically, horizontally) {
                const mode = (vertically ? 1 : 0) | (horizontally ? 2 : 0);
                if (mode === maximizedMode) return;
                this.maximizedAboutToChange.emit(mode);
                maximizedMode = mode;
            },
            get fullScreen() { return fullScreen; },
            set fullScreen(value) {
                if (fullScreen === value) return;
                fullScreen = value;
                this.fullScreenChanged.emit();
            },
            maximizedAboutToChange: signal(), minimizedChanged: signal(),
            fullScreenChanged: signal(), captionChanged: signal(), closed: signal(),
            get desktops() { return desktops; },
            set desktops(value) {
                assert.ok(!closed, "Moving a closed window");
                assert.ok(value.every(desktop => workspace.desktops.includes(desktop)), "Invalid destination desktop");
                desktops = Array.from(value);
            },
            get onAllDesktops() { return desktops.length === 0; },
            set onAllDesktops(value) {
                assert.ok(!closed, "Changing a closed window");
                if (value) desktops = [];
                else if (desktops.length === 0) desktops = [workspace.currentDesktop];
            },
            close() {
                this.closed.emit();
                windows.splice(windows.indexOf(this), 1);
                closed = true;
            }
        };
        windows.push(window);
        workspace.windowAdded.emit(window);
        return window;
    }
    return {
        workspace, addWindow, panelCalls,
        step() { assert.ok(timers.length); timers.shift()(); },
        flush() { while (timers.length) timers.shift()(); }
    };
}

//
// 1) handleMaximized / handleFullscreen toggles
//

test("handleMaximized=false leaves maximized windows on a regular desktop", () => {
    const h = setup({ handleMaximized: false });
    const regular = h.workspace.currentDesktop;
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1, "No dedicated desktop may be created");
    assert.equal(w.desktops[0], regular);
    assert.equal(w.desktops.length, 1);
});

test("handleFullscreen=false leaves fullscreen windows on a regular desktop", () => {
    const h = setup({ handleFullscreen: false });
    const regular = h.workspace.currentDesktop;
    const w = h.addWindow("app");
    w.fullScreen = true;
    h.flush();
    assert.equal(h.workspace.desktops.length, 1, "No dedicated desktop may be created");
    assert.equal(w.desktops[0], regular);
    assert.equal(w.fullScreen, true);
});

test("handleMaximized=false keeps fullscreen handling enabled", () => {
    const h = setup({ handleMaximized: false });
    const w = h.addWindow("app");
    w.fullScreen = true;
    h.flush();
    assert.equal(h.workspace.desktops.length, 2, "Fullscreen still creates a dedicated desktop");
    assert.notEqual(w.desktops[0], h.workspace.desktops[0]);
});

test("handleFullscreen=false keeps maximized handling enabled", () => {
    const h = setup({ handleFullscreen: false });
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 2, "Maximize still creates a dedicated desktop");
    assert.notEqual(w.desktops[0], h.workspace.desktops[0]);
});

test("both disabled means a maximized fullscreen window never moves", () => {
    const h = setup({ handleFullscreen: false, handleMaximized: false });
    const regular = h.workspace.currentDesktop;
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1);
    assert.equal(w.desktops[0], regular);
});

//
// 2) moveToLast desktop positioning
//

test("moveToLast=false inserts the dedicated desktop right after the current one", () => {
    const h = setup({ moveToLast: false });
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    // The new desktop sits at index 1, immediately after the source.
    assert.equal(h.workspace.desktops.length, 2);
    assert.equal(w.desktops[0], h.workspace.desktops[1]);
});

test("moveToLast=true appends the dedicated desktop at the end", () => {
    const h = setup({ moveToLast: true });
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 2);
    assert.equal(w.desktops[0], h.workspace.desktops.at(-1));
});

test("moveToLast=true keeps an earlier maximized window on its desktop for a later maximize", () => {
    const h = setup({ moveToLast: true });
    const first = h.addWindow("first");
    first.setMaximize(true, true);
    h.flush();
    const firstDesktop = first.desktops[0];
    const last = h.addWindow("last");
    last.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 3);
    assert.equal(first.desktops[0], firstDesktop, "Earlier window stays put");
    assert.equal(last.desktops[0], h.workspace.desktops.at(-1), "Newest maximize lands at the end");
});

test("moveToLast=true restores normally and cleans up its appended desktop", () => {
    const h = setup({ moveToLast: true });
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 2);
    w.setMaximize(false, false);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1);
    assert.equal(w.desktops[0], h.workspace.desktops[0]);
});

//
// 3) enableIfOnlyOne multi-monitor skip
//

test("enableIfOnlyOne=true with one screen still moves the window", () => {
    const h = setup({ enableIfOnlyOne: true, screenCount: 1 });
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 2);
    assert.notEqual(w.desktops[0], h.workspace.desktops[0]);
});

test("enableIfOnlyOne=true with multiple screens keeps the window in place", () => {
    const h = setup({ enableIfOnlyOne: true, screenCount: 2 });
    const regular = h.workspace.currentDesktop;
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1, "No dedicated desktop on multiple monitors");
    assert.equal(w.desktops[0], regular);
    assert.equal(w.desktops.length, 1);
});

test("enableIfOnlyOne=false ignores the monitor count", () => {
    const h = setup({ enableIfOnlyOne: false, screenCount: 2 });
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 2, "Dedicated desktop created regardless of screens");
});

//
// 4) exclusiveDesktops unrelated-window relocation
//

test("exclusiveDesktops=true evicts an unrelated window from a dedicated desktop", () => {
    const h = setup();
    const owner = h.addWindow("owner");
    owner.setMaximize(true, true);
    h.flush();
    const dedicated = h.workspace.currentDesktop;
    const other = h.addWindow("other");
    assert.notEqual(other.desktops[0], dedicated, "Unrelated window is evicted");
    assert.equal(other.desktops[0], h.workspace.desktops[0]);
});

test("exclusiveDesktops=false lets an unrelated window share the dedicated desktop", () => {
    const h = setup({ exclusiveDesktops: false });
    const owner = h.addWindow("owner");
    owner.setMaximize(true, true);
    h.flush();
    const dedicated = h.workspace.currentDesktop;
    const other = h.addWindow("other");
    assert.equal(other.desktops[0], dedicated, "Unrelated window stays by default when not exclusive");
});