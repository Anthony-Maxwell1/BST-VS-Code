import psList from "ps-list";
import koffi from "koffi";
const user32 = koffi.load("user32.dll");
export const WNDENUMPROC = koffi.proto("int __stdcall WNDENUMPROC(void *hwnd, intptr_t lParam)");
// Win32 bindings
const EnumWindows = user32.func("int __stdcall EnumWindows(void* lpEnumFunc, intptr_t lParam)");
const GetWindowThreadProcessId = user32.func("uint __stdcall GetWindowThreadProcessId(void *hWnd, uint *lpdwProcessId)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void *hWnd)");
// const SetWindowPos = user32.func(
//   "bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)",
// );
// // Constants
// const HWND_TOP = BigInt(-1);
// const HWND_BOTTOM = BigInt(1);
// const SWP_NOMOVE = 0x0002;
// const SWP_NOSIZE = 0x0001;
// const SWP_NOACTIVATE = 0x0010;
// const SWP_SHOWWINDOW = 0x0040;
// let studioHwnd: bigint | null = null;
// let vscodeHwnd: bigint | null = null;
async function findProcessWindow(processName) {
    const processes = await psList();
    const proc = processes.find((p) => p.name === processName);
    if (!proc) {
        return null;
    }
    const results = [];
    const enumProc = koffi.register((hwnd) => {
        const pidBuf = Buffer.alloc(4);
        GetWindowThreadProcessId(hwnd, pidBuf);
        const pid = pidBuf.readUInt32LE(0);
        if (pid === proc.pid && IsWindowVisible(hwnd)) {
            results.push(hwnd);
        }
        return 1;
    }, koffi.pointer(WNDENUMPROC));
    EnumWindows(enumProc, 0);
    koffi.unregister(enumProc);
    return results[0] ?? null;
}
export async function getRobloxHwnd() {
    return await findProcessWindow("RobloxStudioBeta.exe");
}
// export function above() {
//   ensureStudioAlive();
//   SetWindowPos(
//     studioHwnd,
//     HWND_TOP,
//     0,
//     0,
//     0,
//     0,
//     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
//   );
// }
// export function below() {
//   ensureStudioAlive();
//   SetWindowPos(
//     studioHwnd,
//     HWND_BOTTOM,
//     0,
//     0,
//     0,
//     0,
//     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
//   );
// }
// export function position(x: number, y: number, w: number, h: number) {
//   ensureStudioAlive();
//   SetWindowPos(
//     studioHwnd,
//     HWND_TOP,
//     x,
//     y,
//     w,
//     h,
//     SWP_NOACTIVATE | SWP_SHOWWINDOW,
//   );
// }
// interface Rect {
//   left: number;
//   top: number;
//   right: number;
//   bottom: number;
// }
// const GetWindowRect = user32.func(
//   "bool __stdcall GetWindowRect(void* hWnd, void* lpRect)",
// );
// function getWindowRect(hwnd: bigint): Rect {
//   const buf = Buffer.alloc(16); // RECT = 4 ints
//   const ok = GetWindowRect(hwnd, buf);
//   if (!ok) throw new Error("GetWindowRect failed");
//   return {
//     left: buf.readInt32LE(0),
//     top: buf.readInt32LE(4),
//     right: buf.readInt32LE(8),
//     bottom: buf.readInt32LE(12),
//   };
// }
// export function alignStudioToEditor() {
//   // editorX: number,
//   // editorY: number,
//   // editorWidth: number,
//   // editorHeight: number,
//   if (!studioHwnd || !vscodeHwnd) throw new Error("Not initialized");
//   const rect = getWindowRect(vscodeHwnd);
//   const windowWidth = rect.right - rect.left;
//   const windowHeight = rect.bottom - rect.top;
//   // --- VS Code UI Offsets (approximate defaults) ---
//   const TITLEBAR_HEIGHT = 30; // draggable region
//   const TABBAR_HEIGHT = 55; // file tabs
//   const STATUSBAR_HEIGHT = 24; // bottom bar
//   const ACTIVITYBAR_WIDTH = 48; // left icons
//   const SIDEBAR_WIDTH = 295; // explorer panel (if visible)
//   // You may want to detect sidebar visibility later.
//   const editorX = rect.left + ACTIVITYBAR_WIDTH + SIDEBAR_WIDTH;
//   const editorY = rect.top + TITLEBAR_HEIGHT + TABBAR_HEIGHT;
//   const editorWidth = windowWidth - ACTIVITYBAR_WIDTH - SIDEBAR_WIDTH;
//   const editorHeight =
//     windowHeight - TITLEBAR_HEIGHT - TABBAR_HEIGHT - STATUSBAR_HEIGHT;
//   position(editorX, editorY, editorWidth, editorHeight);
// }
const lib = koffi.load("C:\\Users\\anthony.maxwell\\BST-VS-Code\\src\\embed\\capture-addon.dll");
const init_capture_raw = lib.func("void* init_capture(void*)");
export function init_capture(hwnd) {
    if (hwnd === null) {
        throw new Error("Invalid window handle");
    }
    console.log("Attempting to initialize capture for hwnd:", hwnd);
    console.log(typeof hwnd);
    if (typeof hwnd !== "bigint") {
        throw new TypeError("Expected window handle as bigint");
    }
    return init_capture_raw(hwnd);
}
export const get_frame = lib.func("bool get_frame(void*, uint8_t*, uint*, uint*)");
export const release_capture = lib.func("void release_capture(void*)");
//# sourceMappingURL=win.js.map