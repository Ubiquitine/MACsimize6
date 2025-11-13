# MACsimize6

A re-implementation of the original MACsimize script for Plasma 6.

Imitates the way macOS handles maximized and full-screened windows.

## Functionality

### Core Features:
* **Automatic Virtual Desktop Creation**: The script moves full-screened and/or (fully) maximized windows to a new virtual desktop.
* **Desktop Restoration**: When a window is restored to regular state (not full-screened and not fully maximized), the script returns it to the main desktop and removes the temporary virtual desktop.
* **Main Desktop Focus**: New non-maximized windows opened while on a full-screen application's desktop are automatically moved to and opened on the main desktop.
* **Dialog & Toolbar Support**: Related windows (dialogs, toolbars, etc.) are automatically moved to the same desktop as their parent window.
* **Context Menu Safety**: Popup menus and context menus (e.g., Dolphin's right-click menu) stay on their current desktop to prevent KWin crashes.
* **Skip List Support**: Applications in the skip list are exempt from all rules and can open freely on any desktop.

### Behavior Logic:
1. Initial state has only one virtual desktop (main desktop)
2. When a window is maximized, a new virtual desktop is created after all existing ones, and the window is moved to it
3. The new virtual desktop displays only that maximized window and its related dialogs/toolbars
4. When a window is un-maximized, its virtual desktop is deleted and the window returns to the main desktop
5. When on a non-main desktop (full-screen app), opening a new non-maximized app forces it to open on the main desktop and switches to it

### Preview:
![Macsimize6](https://github.com/Ubiquitine/MACsimize6/assets/3274951/354014b3-5ea0-49ff-b2a2-5aab27471845)
