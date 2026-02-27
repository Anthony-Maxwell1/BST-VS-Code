// capture-addon.cpp
#include <windows.h>
#include <wrl.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <windows.graphics.capture.interop.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Foundation.h>


using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using namespace Microsoft::WRL;

// Simple struct to hold capture state
struct CaptureState {
    GraphicsCaptureItem item{ nullptr };
    ID3D11Device* device{ nullptr };
    ID3D11DeviceContext* context{ nullptr };
    int width{ 0 };
    int height{ 0 };
    // TODO: add FramePool / Session if needed
};

extern "C" {

// Initialize capture for given HWND
__declspec(dllexport) CaptureState* init_capture(HWND hwnd) {
    init_apartment(); // Initialize WinRT

    try {
        CaptureState* state = new CaptureState();

        // Create GraphicsCaptureItem from HWND
        auto factory = get_activation_factory<GraphicsCaptureItem>();
        auto interop = factory.as<IGraphicsCaptureItemInterop>();
        GraphicsCaptureItem item{ nullptr };
        interop->CreateForWindow(hwnd, guid_of<GraphicsCaptureItem>(), put_abi(item));
        state->item = item;

        // Create D3D11 device
        D3D_FEATURE_LEVEL featureLevel = D3D_FEATURE_LEVEL_11_0;
        D3D11CreateDevice(
            nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            &featureLevel, 1, D3D11_SDK_VERSION, &state->device, nullptr, &state->context
        );

        // Get window size
        RECT rc;
        GetClientRect(hwnd, &rc);
        state->width = rc.right - rc.left;
        state->height = rc.bottom - rc.top;

        return state;
    }
    catch (...) {
        return nullptr;
    }
}

// Dummy frame function (for now just returns true)
__declspec(dllexport) bool get_frame(CaptureState* state, uint8_t* buffer, int* width, int* height) {
    if (!state) return false;
    *width = state->width;
    *height = state->height;

    // TODO: capture frame and copy to buffer
    // For now fill black
    memset(buffer, 0, (*width) * (*height) * 4);
    return true;
}

// Release capture
__declspec(dllexport) void release_capture(CaptureState* state) {
    if (!state) return;
    if (state->context) state->context->Release();
    if (state->device) state->device->Release();
    delete state;
}

} // extern "C"