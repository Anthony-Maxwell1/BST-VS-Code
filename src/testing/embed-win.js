import psList from "ps-list";
import koffi from "koffi";
const processes = await psList();
const studio = processes.find((p) => p.name === "RobloxStudioBeta.exe");
if (!studio) {
    console.log("Studio not running");
    process.exit(1);
}
console.log("Found Studio process:", studio);
// Load user32.dll directly via koffi
const user32 = koffi.load("user32.dll");
// Define the callback prototype using koffi's own system
export const WNDENUMPROC = koffi.proto("int __stdcall WNDENUMPROC(void *hwnd, intptr_t lParam)");
// Define EnumWindows using koffi
const EnumWindows = user32.func("int __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)");
// Define GetWindowThreadProcessId to filter by PID
const GetWindowThreadProcessId = user32.func("uint __stdcall GetWindowThreadProcessId(void *hWnd, uint *lpdwProcessId)");
// Define IsWindowVisible to skip hidden windows
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void *hWnd)");
const studioWindows = [];
const enumProc = koffi.register((hwnd, _lParam) => {
    const pid = Buffer.alloc(4); // DWORD = 4 bytes
    GetWindowThreadProcessId(hwnd, pid);
    const pidValue = pid.readUInt32LE(0);
    if (pidValue === studio.pid && IsWindowVisible(hwnd)) {
        studioWindows.push(hwnd);
    }
    return 1;
}, koffi.pointer(WNDENUMPROC));
EnumWindows(enumProc, 0);
koffi.unregister(enumProc);
const finalWindows = [];
for (const hwnd of studioWindows) {
    finalWindows.push(koffi.address(hwnd).toString(16));
}
console.log("Studio windows:", finalWindows);
if (studioWindows.length === 0) {
    console.log("No Studio windows found");
    process.exit(1);
}
const HWND = studioWindows[0];
// SetWindowPos
const SetWindowPos = user32.func("bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)");
// FindWindowW (to get VS Code main window)
const FindWindowW = user32.func("void* __stdcall FindWindowW(const wchar_t* lpClassName, const wchar_t* lpWindowName)");
// GetWindowRect (optional but useful)
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(void* hWnd, void* lpRect)");
const HWND_TOP = BigInt(-0x1);
const HWND_BOTTOM = BigInt(1);
const HWND_TOPMOST = BigInt(-0x1);
const HWND_NOTOPMOST = BigInt(-0x2);
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
import readline from "readline";
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});
console.log("Commands: ABOVE | BELOW | POSITION x y width height");
rl.on("line", (input) => {
    const parts = input.trim().split(" ");
    const cmd = parts[0]?.toUpperCase();
    if (cmd === "ABOVE") {
        SetWindowPos(HWND, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        console.log("Studio moved ABOVE.");
    }
    else if (cmd === "BELOW") {
        SetWindowPos(HWND, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        console.log("Studio moved BELOW.");
    }
    else if (cmd === "POSITION") {
        if (parts.length !== 5) {
            console.log("Usage: POSITION x y width height");
            return;
        }
        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);
        const w = parseInt(parts[3]);
        const h = parseInt(parts[4]);
        SetWindowPos(HWND, HWND_TOP, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        console.log(`Studio positioned at ${x},${y} size ${w}x${h}`);
    }
    else {
        console.log("Unknown command.");
    }
});
//# sourceMappingURL=embed-win.js.map