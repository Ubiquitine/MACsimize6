// Run with: node --test --test-isolation=none tests/desktop-removal.test.cjs
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

function setup(animationTime = 700, asyncFullscreen = false, config = {})
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
            // KWin emits the list change before destroying the removed QObject.
            this.desktopsChanged.emit();
            deleted.add(desktop);
        },
        setDesktopCount(count) {
            assert.ok(count >= 1 && count < this.desktops.length);
            // KWin truncates the full list before emitting individual removals.
            const removed = this.desktops.splice(count);
            if (removed.includes(this.currentDesktop)) this.currentDesktop = this.desktops.at(-1);
            for (const desktop of removed) {
                for (const window of windows) {
                    if (window.desktops.includes(desktop)) {
                        const index = Math.min(this.desktops.length - 1, count + removed.indexOf(desktop));
                        window.desktops = [this.desktops[index]];
                    }
                }
                this.desktopsChanged.emit();
                deleted.add(desktop);
            }
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
                const apply = () => {
                    if (fullScreen === value) return;
                    fullScreen = value;
                    this.fullScreenChanged.emit();
                };
                if (asyncFullscreen) timers.push(apply);
                else apply();
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
        get locked() { return vm.runInContext("Boolean(panelVisibilityLock)", context); },
        step() { assert.ok(timers.length); timers.shift()(); },
        flush() { while (timers.length) timers.shift()(); }
    };
}

for (const delay of [0, 700])
{
    test(`skipTaskbar windows stay on the current dedicated desktop without being managed (${delay} ms)`, () => {
        const h = setup(delay), owner = h.addWindow("owner");
        owner.setMaximize(true, true);
        h.flush();
        const dedicated = h.workspace.currentDesktop;
        const overlay = h.addWindow("overlay", true);
        h.workspace.windowActivated.emit(overlay);
        overlay.setMaximize(true, true);
        overlay.fullScreen = true;
        h.flush();
        assert.equal(h.workspace.currentDesktop, dedicated);
        assert.equal(overlay.desktops[0], dedicated);
        assert.equal(owner.desktops[0], dedicated);
        assert.equal(h.workspace.desktops.length, 2);
        overlay.close();
        assert.equal(h.workspace.desktops.length, 2);
    });

    test(`manual removal unmaximizes its window and permits later maximize (${delay} ms)`, () => {
        const h = setup(delay), w = h.addWindow("first");
        w.setMaximize(true, true);
        h.flush();
        h.workspace.removeDesktop(h.workspace.currentDesktop);
        assert.equal(h.workspace.desktops.length, 1);
        w.captionChanged.emit();
        assert.equal(w.maximizeMode, 0, "Removing the desktop must unmaximize its window");
        w.setMaximize(true, true);
        h.flush();
        assert.equal(h.workspace.desktops.length, 2);
        assert.equal(w.desktops[0], h.workspace.currentDesktop);
        w.close();
        assert.equal(h.workspace.desktops.length, 1);
    });
}

test("desktop creation failure never restores onto another app's desktop", () => {
    const config = {};
    const h = setup(0, false, config), first = h.addWindow("first"), second = h.addWindow("second");
    const regular = h.workspace.currentDesktop;
    first.setMaximize(true, true);
    const dedicated = h.workspace.currentDesktop;
    second.setMaximize(true, true);
    const other = h.workspace.currentDesktop;
    h.workspace.removeDesktop(regular);
    config.desktopLimit = h.workspace.desktops.length;
    h.workspace.currentDesktop = dedicated;
    assert.throws(() => first.setMaximize(false, false), /Cannot create an unmanaged desktop/);
    assert.equal(first.desktops[0], dedicated);
    assert.equal(h.workspace.currentDesktop, dedicated);
    assert.equal(second.desktops[0], other);
    assert.equal(second.maximizeMode, 3);
    first.close();
    assert.equal(h.workspace.desktops.length, 2, "Closing the source frees capacity for a regular desktop");
    assert.notEqual(h.workspace.currentDesktop, other);
    assert.equal(second.maximizeMode, 3);
});

test("manual removal during animation finishes on a surviving desktop", () => {
    const h = setup(), w = h.addWindow("first");
    w.setMaximize(true, true);
    h.workspace.removeDesktop(h.workspace.currentDesktop);
    h.flush();
    assert.equal(w.maximizeMode, 0);
    assert.equal(w.onAllDesktops, false);
    assert.equal(w.desktops[0], h.workspace.currentDesktop);
    assert.equal(h.workspace.desktops.length, 1);
});

test("an old move cannot override a replacement created before its timer fires", () => {
    const h = setup(), w = h.addWindow("first");
    w.setMaximize(true, true);
    h.workspace.removeDesktop(h.workspace.currentDesktop);
    w.setMaximize(true, true);
    const replacement = h.workspace.currentDesktop;
    h.flush();
    assert.equal(h.workspace.desktops.length, 2);
    assert.equal(w.desktops[0], replacement);
});

test("removal during restore does not remove the same desktop twice", () => {
    const h = setup(), w = h.addWindow("first");
    w.setMaximize(true, true);
    h.flush();
    const dedicated = h.workspace.currentDesktop;
    w.setMaximize(false, false);
    h.workspace.removeDesktop(dedicated);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1);
});

test("closing during animation leaves no callback touching the closed window", () => {
    const h = setup(), w = h.addWindow("first");
    w.setMaximize(true, true);
    w.close();
    h.flush();
    assert.equal(h.workspace.desktops.length, 1);
});

test("normal maximize and restore still clean up", () => {
    const h = setup(), w = h.addWindow("first");
    w.setMaximize(true, true);
    h.flush();
    w.setMaximize(false, false);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1);
    assert.equal(w.desktops[0], h.workspace.currentDesktop);
});

test("superseding a restore still cleans up its old dedicated desktop", () => {
    const h = setup(), w = h.addWindow("first");
    w.setMaximize(true, true);
    w.setMaximize(false, false);
    w.setMaximize(true, true);
    const replacement = h.workspace.currentDesktop;
    h.flush();
    assert.equal(h.workspace.desktops.length, 2);
    assert.equal(w.desktops[0], replacement);
});

test("removing one managed desktop leaves other managed windows working", () => {
    const h = setup(), first = h.addWindow("first");
    first.setMaximize(true, true);
    h.flush();
    const removed = h.workspace.currentDesktop;
    const second = h.addWindow("second");
    second.setMaximize(true, true);
    h.flush();
    const remaining = h.workspace.currentDesktop;
    h.workspace.removeDesktop(removed);
    first.captionChanged.emit();
    second.captionChanged.emit();
    assert.equal(first.maximizeMode, 0);
    assert.equal(second.maximizeMode, 3);
    assert.equal(second.desktops[0], remaining);
    assert.equal(first.desktops[0], h.workspace.desktops[0], "Restored windows belong on a regular desktop");
    assert.notEqual(first.desktops[0], remaining, "The other app's dedicated desktop must remain exclusive");
    second.setMaximize(false, false);
    h.flush();
    assert.equal(h.workspace.desktops.length, 1);
});

test("deleting the last managed desktop restores onto a regular desktop, not its managed neighbor", () => {
    const h = setup(), first = h.addWindow("first");
    const regular = h.workspace.currentDesktop;
    first.setMaximize(true, true);
    h.flush();
    const firstDesktop = h.workspace.currentDesktop;
    const second = h.addWindow("second");
    second.setMaximize(true, true);
    h.flush();
    h.workspace.removeDesktop(h.workspace.currentDesktop);
    h.flush();
    assert.equal(second.maximizeMode, 0);
    assert.equal(second.desktops[0], regular);
    assert.equal(h.workspace.currentDesktop, regular);
    assert.equal(first.maximizeMode, 3);
    assert.equal(first.desktops[0], firstDesktop);
    assert.equal(h.workspace.desktops.length, 2);
});

test("fullscreen management resumes after manual desktop removal", () => {
    const h = setup(), w = h.addWindow("first");
    w.fullScreen = true;
    h.flush();
    h.workspace.removeDesktop(h.workspace.currentDesktop);
    assert.equal(w.fullScreen, false);
    w.fullScreen = true;
    h.flush();
    assert.equal(h.workspace.desktops.length, 2);
    w.close();
    assert.equal(h.workspace.desktops.length, 1);
});

test("removing a fullscreen maximized desktop does not recreate it during restoration", () => {
    const h = setup(), w = h.addWindow("first");
    w.setMaximize(true, true);
    h.flush();
    w.fullScreen = true;
    h.workspace.removeDesktop(h.workspace.currentDesktop);
    h.flush();
    assert.equal(w.fullScreen, false);
    assert.equal(w.maximizeMode, 0);
    assert.equal(h.workspace.desktops.length, 1);
});

test("Wayland fullscreen restoration waits for the client without recreating a desktop", () => {
    const h = setup(700, true), w = h.addWindow("first");
    w.setMaximize(true, true);
    h.flush();
    w.fullScreen = true;
    h.flush();
    h.workspace.removeDesktop(h.workspace.currentDesktop);
    assert.equal(w.fullScreen, true, "Fullscreen is still reported until the client commits");
    assert.equal(h.workspace.desktops.length, 1);
    h.flush();
    assert.equal(w.fullScreen, false);
    assert.equal(w.maximizeMode, 0);
    assert.equal(h.workspace.desktops.length, 1);
});

test("a cancelled animation cannot move the restored window after the user switches desktops", () => {
    const h = setup(), w = h.addWindow("first");
    w.setMaximize(true, true);
    h.workspace.removeDesktop(h.workspace.currentDesktop);
    assert.equal(w.onAllDesktops, false);
    const survivor = w.desktops[0];
    h.workspace.createDesktop(1, "Another desktop");
    h.workspace.currentDesktop = h.workspace.desktops[1];
    h.flush();
    assert.equal(w.desktops[0], survivor);
    assert.equal(w.maximizeMode, 0);
});

for (const delay of [0, 700])
{
    test(`background removal preserves the active managed desktop (${delay} ms)`, () => {
        const h = setup(delay), first = h.addWindow("first");
        const regular = h.workspace.currentDesktop;
        first.setMaximize(true, true);
        h.flush();
        const removed = h.workspace.currentDesktop;
        const second = h.addWindow("second");
        second.setMaximize(true, true);
        h.flush();
        const active = h.workspace.currentDesktop;
        h.workspace.removeDesktop(removed);
        h.flush();
        assert.equal(h.workspace.currentDesktop, active);
        assert.equal(first.maximizeMode, 0);
        assert.equal(first.desktops[0], regular);
        assert.equal(second.maximizeMode, 3);
        assert.equal(second.desktops[0], active);
    });

    for (const useAbsoluteEnds of [false, true])
    {
        test(`removal creates a regular desktop when all survivors are managed (${delay} ms, absolute=${useAbsoluteEnds})`, () => {
            const h = setup(delay, false, { useAbsoluteEnds });
            const regular = h.workspace.currentDesktop;
            const first = h.addWindow("first"), second = h.addWindow("second");
            first.setMaximize(true, true);
            h.flush();
            const active = h.workspace.currentDesktop;
            second.setMaximize(true, true);
            h.flush();
            const removed = h.workspace.currentDesktop;
            h.workspace.removeDesktop(regular);
            h.workspace.currentDesktop = active;
            h.workspace.removeDesktop(removed);
            h.flush();
            assert.equal(h.workspace.currentDesktop, active);
            assert.equal(second.maximizeMode, 0);
            assert.notEqual(second.desktops[0], active);
            assert.equal(h.workspace.desktops.length, 2);
            assert.equal(first.maximizeMode, 3);
            assert.equal(first.desktops[0], active);
        });

        test(`normal restore creates a regular desktop rather than reusing its source (${delay} ms, absolute=${useAbsoluteEnds})`, () => {
            const h = setup(delay, false, { useAbsoluteEnds });
            const regular = h.workspace.currentDesktop;
            const first = h.addWindow("first"), second = h.addWindow("second");
            first.setMaximize(true, true);
            h.flush();
            const dedicated = h.workspace.currentDesktop;
            second.setMaximize(true, true);
            h.flush();
            const other = h.workspace.currentDesktop;
            h.workspace.removeDesktop(regular);
            h.workspace.currentDesktop = dedicated;
            first.setMaximize(false, false);
            h.flush();
            assert.equal(first.maximizeMode, 0);
            assert.notEqual(first.desktops[0], other);
            assert.equal(first.desktops[0], h.workspace.currentDesktop);
            assert.equal(second.desktops[0], other);
            assert.equal(second.maximizeMode, 3);
            assert.equal(h.workspace.desktops.length, 2);
        });
    }

    test(`panel updates stay locked during another window's maximize (${delay} ms)`, () => {
        const h = setup(delay, false, { enablePanelVisibility: true });
        const first = h.addWindow("first"), second = h.addWindow("second");
        first.setMaximize(true, true);
        const removed = h.workspace.currentDesktop;
        second.setMaximize(true, true);
        const active = h.workspace.currentDesktop;
        h.workspace.removeDesktop(removed);
        const calls = h.panelCalls.length;
        if (delay) {
            assert.equal(h.locked, true);
            h.step(); // Cancelled first animation must not unlock the second.
            assert.equal(h.locked, true);
            assert.equal(h.panelCalls.length, calls);
        }
        h.flush();
        assert.equal(h.locked, false);
        assert.equal(h.workspace.currentDesktop, active);
        assert.equal(second.desktops[0], active);
        assert.match(h.panelCalls.at(-1).at(-1), /dodgewindows/);
    });
}

for (const noRegularDesktop of [false, true])
{
    test(`a deleted restore destination resolves a regular desktop (create=${noRegularDesktop})`, () => {
        const h = setup(), first = h.addWindow("first"), second = h.addWindow("second");
        const regular = h.workspace.currentDesktop;
        first.setMaximize(true, true);
        h.flush();
        const dedicated = h.workspace.currentDesktop;
        second.setMaximize(true, true);
        h.flush();
        const other = h.workspace.currentDesktop;
        h.workspace.currentDesktop = dedicated;
        first.setMaximize(false, false);
        if (!noRegularDesktop) h.workspace.createDesktop(h.workspace.desktops.length, "Spare regular");
        h.workspace.removeDesktop(regular);
        h.workspace.currentDesktop = other;
        h.flush();
        assert.equal(h.workspace.currentDesktop, other, "A late restore must not steal focus");
        assert.notEqual(first.desktops[0], other);
        assert.equal(first.desktops.length, 1);
        assert.equal(second.desktops[0], other);
        assert.equal(second.maximizeMode, 3);
        assert.equal(h.workspace.desktops.length, 2);
    });
}

test("a restore starting during another maximize does not release its panel lock", () => {
    const h = setup(700, false, { enablePanelVisibility: true });
    const first = h.addWindow("first"), second = h.addWindow("second");
    first.setMaximize(true, true);
    h.flush();
    second.setMaximize(true, true);
    const calls = h.panelCalls.length;
    first.setMaximize(false, false);
    assert.equal(h.locked, true);
    assert.equal(h.panelCalls.length, calls);
    h.flush();
    assert.equal(h.locked, false);
});

test("an earlier animation finishing cannot release a newer animation's panel lock", () => {
    const h = setup(700, false, { enablePanelVisibility: true });
    const first = h.addWindow("first"), second = h.addWindow("second");
    first.setMaximize(true, true);
    second.setMaximize(true, true);
    const calls = h.panelCalls.length;
    h.step();
    assert.equal(h.locked, true);
    assert.equal(h.panelCalls.length, calls);
    h.flush();
    assert.equal(h.locked, false);
});

test("concurrent restores cannot select each other's retiring desktops as replacements", () => {
    const h = setup();
    const first = h.addWindow("first"), second = h.addWindow("second"), third = h.addWindow("third");
    const regular = h.workspace.currentDesktop;
    first.setMaximize(true, true);
    h.flush();
    const firstDesktop = h.workspace.currentDesktop;
    second.setMaximize(true, true);
    h.flush();
    const secondDesktop = h.workspace.currentDesktop;
    third.setMaximize(true, true);
    h.flush();
    const active = h.workspace.currentDesktop;
    h.workspace.currentDesktop = firstDesktop;
    first.setMaximize(false, false);
    h.workspace.currentDesktop = secondDesktop;
    second.setMaximize(false, false);
    h.workspace.removeDesktop(regular);
    h.workspace.currentDesktop = active;
    h.flush();
    assert.equal(h.workspace.currentDesktop, active);
    assert.equal(first.desktops[0], second.desktops[0]);
    assert.notEqual(first.desktops[0], active);
    assert.equal(third.maximizeMode, 3);
    assert.equal(third.desktops[0], active);
    assert.equal(h.workspace.desktops.length, 2);
});

test("nested desktop creation during removal must not restore an unrelated app", () => {
    const h = setup(), first = h.addWindow("first"), second = h.addWindow("second");
    first.setMaximize(true, true);
    h.flush();
    first.maximizedAboutToChange.connect(mode => {
        if (mode === 0) second.setMaximize(true, true);
    });
    h.workspace.removeDesktop(h.workspace.currentDesktop);
    h.flush();
    assert.equal(first.maximizeMode, 0);
    assert.equal(second.maximizeMode, 3);
    assert.equal(h.workspace.desktops.length, 2);
    assert.equal(second.desktops[0], h.workspace.desktops[1]);
});

test("closing one animated window leaves the other window's panel lock intact", () => {
    const h = setup(700, false, { enablePanelVisibility: true });
    const first = h.addWindow("first"), second = h.addWindow("second");
    first.setMaximize(true, true);
    second.setMaximize(true, true);
    first.close();
    const calls = h.panelCalls.length;
    h.step();
    assert.equal(h.locked, true);
    assert.equal(h.panelCalls.length, calls);
    h.flush();
    assert.equal(h.locked, false);
});

for (const delay of [0, 700])
{
    test(`closing the active managed window with no regular desktop keeps its neighbor exclusive (${delay} ms)`, () => {
        const h = setup(delay), first = h.addWindow("first"), second = h.addWindow("second");
        const regular = h.workspace.currentDesktop;
        first.setMaximize(true, true);
        h.flush();
        const other = h.workspace.currentDesktop;
        second.setMaximize(true, true);
        h.flush();
        h.workspace.removeDesktop(regular);
        second.close();
        h.flush();
        assert.equal(first.maximizeMode, 3);
        assert.equal(first.desktops[0], other);
        assert.notEqual(h.workspace.currentDesktop, other);
        assert.equal(h.workspace.desktops.length, 2);
    });
}

for (const delay of [0, 700])
{
    for (const keepRegular of [false, true])
    {
        for (const activeRemoved of [false, true])
        {
            test(`batch removal preserves the active owner through nested desktop creation (${delay} ms, regular=${keepRegular}, activeRemoved=${activeRemoved})`, () => {
                const h = setup(delay, false, { enablePanelVisibility: true });
                const regular = h.workspace.currentDesktop;
                const survivor = h.addWindow("survivor");
                const first = h.addWindow("first"), last = h.addWindow("last");
                survivor.setMaximize(true, true);
                h.flush();
                const survivorDesktop = h.workspace.currentDesktop;
                first.setMaximize(true, true);
                h.flush();
                last.setMaximize(true, true);
                h.flush();
                if (!keepRegular) h.workspace.removeDesktop(regular);
                if (!activeRemoved) h.workspace.currentDesktop = survivorDesktop;
                let creationEvents = 0;
                const desktopIds = new Set(h.workspace.desktops.map(desktop => desktop.id));
                h.workspace.desktopsChanged.connect(() => {
                    for (const desktop of h.workspace.desktops) {
                        if (!desktopIds.has(desktop.id)) ++creationEvents;
                        desktopIds.add(desktop.id);
                    }
                });
                h.workspace.setDesktopCount(keepRegular ? 2 : 1);
                h.flush();
                assert.equal(first.maximizeMode, 0);
                assert.equal(last.maximizeMode, 0);
                assert.equal(first.desktops[0], last.desktops[0]);
                assert.notEqual(last.desktops[0], survivorDesktop);
                assert.equal(h.workspace.currentDesktop, activeRemoved ? last.desktops[0] : survivorDesktop);
                assert.equal(survivor.maximizeMode, 3);
                assert.equal(survivor.desktops[0], survivorDesktop);
                assert.equal(h.workspace.desktops.length, 2);
                assert.equal(h.locked, false);
                if (!keepRegular) assert.ok(creationEvents > 0, "The regular replacement is created reentrantly");
                last.captionChanged.emit();
                last.setMaximize(true, true);
                h.flush();
                last.close();
                h.flush();
                assert.equal(h.workspace.desktops.length, 2);
            });
        }
    }

    test(`known limitation: removing the last regular desktop evacuates ordinary windows onto a dedicated desktop (${delay} ms)`, () => {
        const h = setup(delay);
        const regular = h.workspace.currentDesktop;
        const ordinary = h.addWindow("ordinary"), owner = h.addWindow("owner");
        owner.setMaximize(true, true);
        h.flush();
        const dedicated = h.workspace.currentDesktop;
        h.workspace.currentDesktop = regular;
        h.workspace.removeDesktop(regular);
        h.flush();
        assert.equal(owner.maximizeMode, 3);
        assert.equal(ordinary.maximizeMode, 0);
        assert.equal(owner.desktops[0], dedicated);
        assert.equal(ordinary.desktops[0], dedicated);
        assert.equal(h.workspace.desktops.length, 1);
    });
}
