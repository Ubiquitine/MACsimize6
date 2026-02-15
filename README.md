# MACsimize6

A re-implementation of the original MACsimize script for Plasma 6.

Imitates the way macOS handles maximized and full-screened windows.

## Functionality

### Core Features:
* **Smart Virtual Desktop Creation**: The script intelligently manages virtual desktops based on window count. If a window is alone on its desktop, it maximizes in place. If multiple windows exist, the maximized window moves to a new virtual desktop, preventing empty desktops.
* **Desktop Restoration**: When a window is restored to regular state (not full-screened and not fully maximized), the script returns it to the main desktop and removes the temporary virtual desktop.
* **Main Desktop Focus**: New non-maximized windows opened while on a full-screen application's desktop are automatically moved to and opened on the main desktop.
* **Dialog & Toolbar Support**: Related windows (dialogs, toolbars, etc.) are automatically moved to the same desktop as their parent window.
* **Context Menu Safety**: Popup menus and context menus (e.g., Dolphin's right-click menu) stay on their current desktop to prevent KWin crashes.
* **Skip List Support**: Applications in the skip list are exempt from all rules and can open freely on any desktop.

### Behavior Logic:
1. Initial state has only one virtual desktop (main desktop)
2. When a window is maximized:
   - If it's the **only window** on the current desktop, it maximizes in place (no new desktop created)
   - If there are **other windows** on the desktop, a new virtual desktop is created and the window is moved to it
3. The new virtual desktop (if created) displays only that maximized window and its related dialogs/toolbars
4. When a window is un-maximized, its virtual desktop is deleted (if applicable) and the window returns to the main desktop
5. When on a non-main desktop (full-screen app), opening a new non-maximized app forces it to open on the main desktop and switches to it

## Configuration

You can configure MACsimize6 in **System Settings** → **Window Management** → **KWin Scripts** → **MACsimize6** → **Configure**

### Available Options:

- **Handle Fullscreen**: Enable/disable fullscreen window management
- **Handle Maximized**: Enable/disable maximized window management
- **Move to Last**: Create new desktops at the end instead of next to current desktop
- **Enable if Only One**: Only enable script when using a single monitor
- **Enable Panel Visibility**: Auto-hide panel on non-main desktops
- **Exclusive Desktops**: Force new windows to open on main desktop when on a fullscreen app
- **Prevent Empty Desktop**: When enabled, maximizing the only window on a desktop keeps it in place instead of creating a new desktop (default: enabled)
- **Debug Mode**: Enable debug logging
- **Skip Windows**: Comma-separated list of applications to exclude from all rules

### Preview:
![Macsimize6](https://github.com/Ubiquitine/MACsimize6/assets/3274951/354014b3-5ea0-49ff-b2a2-5aab27471845)
