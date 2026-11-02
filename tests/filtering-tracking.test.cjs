// Run with: node --test --test-isolation=none tests/filtering-tracking.test.cjs
//
// Covers window filtering, transient-window routing and desktop naming:
//   5. shouldSkip() and the skip list
//   6. moveTransientToParentDesktop() transient dialogs/toolbars
//   7. updateDedicatedDesktopName()/createManagedDesktop() desktop naming
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

function setup(config = {}, animationTime = 0)
{
    const timers = [], windows = [], deleted = new Set(), panelCalls = [];
    let nextId = 0;
    let currentDesktop;
    const workspace = {
        desktops: [], screens: [{}], windowAdded: signal(), windowActivated: signal(),
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

    // The default property values match what installWindowHandlers expects
    // for a normal, tracked window. `overrides` lets a test flip specific
    // flags (dialog, toolbar, transientFor, resourceClass, etc.).
    function addWindow(id, overrides = {})
    {
        let desktops = [workspace.currentDesktop], closed = false;
        let maximizedMode = 0, fullScreen = false;
        const base = {
            internalId: id, caption: id, resourceClass: id, normalWindow: true,
            maximizable: true, fullScreenable: true, width: 800, height: 600,
            minimized: false, skipTaskbar: false
        };
        const window = Object.assign({
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
                assert.ok(value.every(d => workspace.desktops.includes(d)), "Invalid destination desktop");
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
        }, base, overrides);
        windows.push(window);
        workspace.windowAdded.emit(window);
        return window;
    }
    return {
        workspace, addWindow, panelCalls,
        desktopName(index) { return workspace.desktops[index].name; },
        flush() { while (timers.length) timers.shift()(); }
    };
}

//
// 5) shouldSkip() window filtering
//

// Each of these flags should cause the window to be exempt from tracking
// so that maximizing it never creates a dedicated desktop.
const SPECIAL_FLAGS = [
    "skipTaskbar", "appletPopup", "comboBox", "criticalNotification", "desktopWindow",
    "dialog", "dndIcon", "dock", "dropdownMenu", "hidden", "inputMethod", "menu",
    "notification", "onScreenDisplay", "popupMenu", "popupWindow", "specialWindow",
    "splash", "toolbar", "tooltip", "utility"
];

for (const flag of SPECIAL_FLAGS)
{
    test(`a ${flag} window is not managed and never creates a desktop`, () => {
        const h = setup();
        const regular = h.workspace.currentDesktop;
        const w = h.addWindow("app", { [flag]: true });
        w.setMaximize(true, true);
        h.flush();
        assert.equal(h.workspace.desktops.length, 1, "Flagged window must stay unmanaged");
        assert.equal(w.desktops[0], regular);
    });
}

test("a window with an empty resourceClass is not managed", () => {
    const h = setup();
    const regular = h.workspace.currentDesktop;
    const w = h.addWindow("app", { resourceClass: "" });
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1);
    assert.equal(w.desktops[0], regular);
});

test("a window on the config SkipWindows list is not managed", () => {
    const h = setup({ SkipWindows: "myapp, other-app" });
    const regular = h.workspace.currentDesktop;
    const w = h.addWindow("myapp");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1);
    assert.equal(w.desktops[0], regular);
});

test("the built-in system skip list is respected", () => {
    const h = setup();
    const regular = h.workspace.currentDesktop;
    // "plasmashell" is a system-skipped window independent of config.
    const w = h.addWindow("plasmashell");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1);
    assert.equal(w.desktops[0], regular);
});

test("a non-skipped window is still managed when others are skipped", () => {
    const h = setup({ SkipWindows: "skipped" });
    const skipped = h.addWindow("skipped");
    const normal = h.addWindow("normal");
    skipped.setMaximize(true, true);
    normal.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 2, "Only the normal window gets a desktop");
    assert.equal(skipped.desktops[0], h.workspace.desktops[0]);
    assert.notEqual(normal.desktops[0], h.workspace.desktops[0]);
});

//
// 6) moveTransientToParentDesktop() transient routing
//

test("a transient dialog follows its managed parent's desktop", () => {
    const h = setup();
    const parent = h.addWindow("parent");
    parent.setMaximize(true, true);
    h.flush();
    const dedicated = parent.desktops[0];
    // Move to a different unmanaged desktop so the transient would only reach
    // the parent's desktop through moveTransientToParentDesktop.
    h.workspace.createDesktop(1, "Spare");
    h.workspace.currentDesktop = h.workspace.desktops[1];
    const dialog = h.addWindow("dialog", { dialog: true, transientFor: parent });
    assert.notEqual(h.workspace.currentDesktop, dedicated);
    assert.equal(dialog.desktops[0], dedicated, "Transient lands on the parent's dedicated desktop");
    assert.equal(dialog.desktops.length, 1);
});

test("a transient of an unmanaged parent is not routed", () => {
    const h = setup();
    const parent = h.addWindow("parent"); // never maximized -> unmanaged
    h.workspace.createDesktop(1, "Spare");
    h.workspace.currentDesktop = h.workspace.desktops[1];
    const dialog = h.addWindow("dialog", { dialog: true, transientFor: parent });
    // The parent is unmanaged, so the transient branch does not run; the dialog
    // stays on the current desktop rather than jumping to some managed one.
    assert.equal(dialog.desktops[0], h.workspace.currentDesktop);
    assert.equal(dialog.desktops.length, 1);
});

test("a window with no transient parent is routed through normal tracking", () => {
    const h = setup();
    const w = h.addWindow("app");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.workspace.desktops.length, 2);
    assert.notEqual(w.desktops[0], h.workspace.desktops[0]);
});

//
// 7) updateDedicatedDesktopName() / createManagedDesktop() naming
//

test("a new dedicated desktop is named after the window", () => {
    const h = setup();
    const w = h.addWindow("My App");
    w.setMaximize(true, true);
    h.flush();
    assert.equal(h.desktopName(h.workspace.desktops.indexOf(w.desktops[0])), "My App");
    // The source desktop keeps its own name.
    assert.equal(h.desktopName(0), "User desktop");
});

test("a caption change renames the dedicated desktop", () => {
    const h = setup();
    const w = h.addWindow("old-name");
    w.setMaximize(true, true);
    h.flush();
    const dedicatedIndex = h.workspace.desktops.indexOf(w.desktops[0]);
    assert.equal(h.desktopName(dedicatedIndex), "old-name");
    w.caption = "new-name";
    w.captionChanged.emit();
    assert.equal(h.desktopName(dedicatedIndex), "new-name");
});

test("a caption change on an unmanaged window leaves desktops untouched", () => {
    const h = setup();
    const w = h.addWindow("app"); // not maximized -> no dedicated desktop
    const namesBefore = h.workspace.desktops.map(d => d.name);
    w.caption = "changed";
    w.captionChanged.emit();
    assert.deepEqual(h.workspace.desktops.map(d => d.name), namesBefore);
});

test("the dedicated desktop is renamed while the window is maximized then cleaned up on close", () => {
    const h = setup();
    const w = h.addWindow("name-1");
    w.setMaximize(true, true);
    h.flush();
    w.caption = "name-2";
    w.captionChanged.emit();
    const dedicated = w.desktops[0];
    assert.equal(dedicated.name, "name-2");
    w.close();
    h.flush();
    assert.equal(h.workspace.desktops.length, 1, "Closing removes the dedicated desktop");
});