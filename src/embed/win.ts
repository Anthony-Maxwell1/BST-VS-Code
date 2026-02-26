import psList from "ps-list";
import koffi from "koffi";

const user32 = koffi.load("user32.dll");

export const WNDENUMPROC = koffi.proto(
  "int __stdcall WNDENUMPROC(void *hwnd, intptr_t lParam)",
);

// Win32 bindings
const EnumWindows = user32.func(
  "int __stdcall EnumWindows(void* lpEnumFunc, intptr_t lParam)",
);

const GetWindowThreadProcessId = user32.func(
  "uint __stdcall GetWindowThreadProcessId(void *hWnd, uint *lpdwProcessId)",
);

const IsWindowVisible = user32.func(
  "bool __stdcall IsWindowVisible(void *hWnd)",
);

const SetWindowPos = user32.func(
  "bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)",
);

// Constants
const HWND_TOP = BigInt(-1);
const HWND_BOTTOM = BigInt(1);

const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

let studioHwnd: bigint | null = null;
let vscodeHwnd: bigint | null = null;

async function findProcessWindow(processName: string): Promise<bigint | null> {
  const processes = await psList();
  const proc = processes.find((p) => p.name === processName);
  if (!proc) return null;

  const results: bigint[] = [];

  const enumProc = koffi.register((hwnd: bigint) => {
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

export async function init() {
  studioHwnd = await findProcessWindow("RobloxStudioBeta.exe");
  vscodeHwnd = await findProcessWindow("Code.exe");

  if (!studioHwnd) throw new Error("Roblox Studio not found");
  if (!vscodeHwnd) throw new Error("VS Code not found");

  console.log("Initialized HWNDs");
}

function ensureStudioAlive() {
  if (!studioHwnd) throw new Error("Studio HWND missing");
}

export function above() {
  ensureStudioAlive();
  SetWindowPos(
    studioHwnd,
    HWND_TOP,
    0,
    0,
    0,
    0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
  );
}

export function below() {
  ensureStudioAlive();
  SetWindowPos(
    studioHwnd,
    HWND_BOTTOM,
    0,
    0,
    0,
    0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
  );
}

export function position(x: number, y: number, w: number, h: number) {
  ensureStudioAlive();
  SetWindowPos(
    studioHwnd,
    HWND_TOP,
    x,
    y,
    w,
    h,
    SWP_NOACTIVATE | SWP_SHOWWINDOW,
  );
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const GetWindowRect = user32.func(
  "bool __stdcall GetWindowRect(void* hWnd, void* lpRect)",
);

function getWindowRect(hwnd: bigint): Rect {
  const buf = Buffer.alloc(16); // RECT = 4 ints
  const ok = GetWindowRect(hwnd, buf);
  if (!ok) throw new Error("GetWindowRect failed");

  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12),
  };
}

export function alignStudioToEditor() {
  if (!studioHwnd || !vscodeHwnd) throw new Error("Not initialized");

  const rect = getWindowRect(vscodeHwnd);

  const windowWidth = rect.right - rect.left;
  const windowHeight = rect.bottom - rect.top;

  // --- VS Code UI Offsets (approximate defaults) ---
  const TITLEBAR_HEIGHT = 30; // draggable region
  const TABBAR_HEIGHT = 35; // file tabs
  const STATUSBAR_HEIGHT = 22; // bottom bar
  const ACTIVITYBAR_WIDTH = 48; // left icons
  const SIDEBAR_WIDTH = 300; // explorer panel (if visible)

  // You may want to detect sidebar visibility later.
  const editorX = rect.left + ACTIVITYBAR_WIDTH + SIDEBAR_WIDTH;
  const editorY = rect.top + TITLEBAR_HEIGHT + TABBAR_HEIGHT;

  const editorWidth = windowWidth - ACTIVITYBAR_WIDTH - SIDEBAR_WIDTH;

  const editorHeight =
    windowHeight - TITLEBAR_HEIGHT - TABBAR_HEIGHT - STATUSBAR_HEIGHT;

  position(editorX, editorY, editorWidth, editorHeight);
}
