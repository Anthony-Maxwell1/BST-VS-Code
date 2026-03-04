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
#include <winrt/Windows.Graphics.DirectX.h>
#include <string>
#include <sstream>

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using namespace Microsoft::WRL;
using namespace winrt::Windows::Graphics::DirectX;

// Correct UUID from Microsoft's own capture samples
struct __declspec(uuid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"))
IDirect3DDxgiInterfaceAccess : ::IUnknown {
    virtual HRESULT __stdcall GetInterface(GUID const& id, void** object) = 0;
};

inline void log(const std::string& msg) {
    OutputDebugStringA((msg + "\n").c_str());
}

struct CaptureState {
    GraphicsCaptureItem item{ nullptr };
    ID3D11Device* device{ nullptr };
    ID3D11DeviceContext* context{ nullptr };
    Direct3D11CaptureFramePool framePool{ nullptr };
    GraphicsCaptureSession session{ nullptr };
    com_ptr<ID3D11Texture2D> stagingTexture;
    int width{ 0 };
    int height{ 0 };
};

extern "C" {

__declspec(dllexport) CaptureState* init_capture(HWND hwnd) {
    try {
        init_apartment(apartment_type::multi_threaded);
    } catch (...) {
        // Already initialized on this thread — not fatal
    }
    log("init_capture: Starting");

    try {
        CaptureState* state = new CaptureState();
        log("init_capture: Created CaptureState");

        log("init_capture: Creating GraphicsCaptureItem");
        auto factory = get_activation_factory<GraphicsCaptureItem>();
        auto interop = factory.as<IGraphicsCaptureItemInterop>();
        GraphicsCaptureItem item{ nullptr };
        HRESULT hr = interop->CreateForWindow(hwnd, guid_of<GraphicsCaptureItem>(), put_abi(item));
        if (FAILED(hr)) {
            log("init_capture: CreateForWindow FAILED hr=" + std::to_string(hr));
            delete state;
            return nullptr;
        }
        state->item = item;
        log("init_capture: GraphicsCaptureItem created");

        log("init_capture: Creating D3D11 device");
        D3D_FEATURE_LEVEL featureLevel = D3D_FEATURE_LEVEL_11_0;
        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        hr = D3D11CreateDevice(
            nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
            flags, &featureLevel, 1, D3D11_SDK_VERSION,
            &state->device, nullptr, &state->context
        );
        if (FAILED(hr)) {
            log("init_capture: D3D11CreateDevice FAILED hr=" + std::to_string(hr));
            delete state;
            return nullptr;
        }
        log("init_capture: D3D11 device created");

        log("init_capture: Wrapping device for WinRT");
        com_ptr<IDXGIDevice> dxgiDevice;
        hr = state->device->QueryInterface(__uuidof(IDXGIDevice), dxgiDevice.put_void());
        if (FAILED(hr)) {
            log("init_capture: QueryInterface IDXGIDevice FAILED hr=" + std::to_string(hr));
            delete state;
            return nullptr;
        }

        com_ptr<IInspectable> inspectable;
        hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put());
        if (FAILED(hr)) {
            log("init_capture: CreateDirect3D11DeviceFromDXGIDevice FAILED hr=" + std::to_string(hr));
            delete state;
            return nullptr;
        }
        auto winrtDevice = inspectable.as<IDirect3DDevice>();
        log("init_capture: WinRT device wrapped");

        RECT rc;
        GetClientRect(hwnd, &rc);
        state->width = rc.right - rc.left;
        state->height = rc.bottom - rc.top;
        log("init_capture: Window size = " + std::to_string(state->width) + "x" + std::to_string(state->height));

        log("init_capture: Creating frame pool");
        try {
            state->framePool = Direct3D11CaptureFramePool::Create(
                winrtDevice,
                DirectXPixelFormat::R8G8B8A8UIntNormalized,  // RGBA — no swizzle needed
                2,
                state->item.Size()
            );
        } catch (const hresult_error& e) {
            log("init_capture: FramePool creation FAILED: " + std::string(to_string(e.message())));
            delete state;
            return nullptr;
        }
        log("init_capture: Frame pool created");

        log("init_capture: Creating capture session");
        state->session = state->framePool.CreateCaptureSession(state->item);
        
        state->session.StartCapture();
        log("init_capture: Capture session started");

        return state;

    } catch (const hresult_error& e) {
        log("init_capture: hresult_error: " + std::string(to_string(e.message())));
    } catch (const std::exception& e) {
        log("init_capture: std::exception: " + std::string(e.what()));
    } catch (...) {
        log("init_capture: Unknown exception");
    }

    return nullptr;
}

__declspec(dllexport) bool get_frame(CaptureState* state, uint8_t* buffer, int* width, int* height) {
    if (!state) {
        log("get_frame: state is null");
        return false;
    }

    try {
        auto frame = state->framePool.TryGetNextFrame();
        if (!frame) {
            return false;
        }
        log("get_frame: Got frame");

        auto surface = frame.Surface();

        // Use .as<>() with the correctly UUID'd interface defined above
        auto dxgiAccess = surface.as<IDirect3DDxgiInterfaceAccess>();

        com_ptr<ID3D11Texture2D> texture;
        HRESULT hr = dxgiAccess->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void());
        if (FAILED(hr)) {
            log("get_frame: GetInterface ID3D11Texture2D FAILED hr=" + std::to_string(hr));
            return false;
        }

        D3D11_TEXTURE2D_DESC desc;
        texture->GetDesc(&desc);
        log("get_frame: texture size=" + std::to_string(desc.Width) + "x" + std::to_string(desc.Height));

        // Recreate staging texture if size changed
        if (state->stagingTexture) {
            D3D11_TEXTURE2D_DESC existingDesc;
            state->stagingTexture->GetDesc(&existingDesc);
            if (existingDesc.Width != desc.Width || existingDesc.Height != desc.Height) {
                state->stagingTexture = nullptr;
            }
        }

        if (!state->stagingTexture) {
            D3D11_TEXTURE2D_DESC stagingDesc = desc;
            stagingDesc.Usage = D3D11_USAGE_STAGING;
            stagingDesc.BindFlags = 0;
            stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            stagingDesc.MiscFlags = 0;
            hr = state->device->CreateTexture2D(&stagingDesc, nullptr, state->stagingTexture.put());
            if (FAILED(hr)) {
                log("get_frame: CreateTexture2D FAILED hr=" + std::to_string(hr));
                return false;
            }
            log("get_frame: staging texture created");
        }

        state->context->CopyResource(state->stagingTexture.get(), texture.get());

        D3D11_MAPPED_SUBRESOURCE mapped;
        hr = state->context->Map(state->stagingTexture.get(), 0, D3D11_MAP_READ, 0, &mapped);
        if (FAILED(hr)) {
            log("get_frame: Map FAILED hr=" + std::to_string(hr));
            return false;
        }

        *width = (int)desc.Width;
        *height = (int)desc.Height;

        // Just copy each row with memcpy
        if (mapped.RowPitch == desc.Width * 4) {
            memcpy(buffer, mapped.pData, desc.Width * desc.Height * 4);
        } else {
            for (UINT y = 0; y < desc.Height; y++) {
                memcpy(buffer + y * desc.Width * 4,
                    (uint8_t*)mapped.pData + y * mapped.RowPitch,
                    desc.Width * 4);
            }
        }

        state->context->Unmap(state->stagingTexture.get(), 0);
        log("get_frame: frame copied ok");
        return true;

    } catch (const hresult_error& e) {
        log("get_frame: hresult_error: " + std::string(to_string(e.message())));
    } catch (const std::exception& e) {
        log("get_frame: std::exception: " + std::string(e.what()));
    } catch (...) {
        log("get_frame: unknown exception");
    }

    return false;
}

__declspec(dllexport) void release_capture(CaptureState* state) {
    if (!state) return;
    log("release_capture: Releasing resources");

    if (state->session) {
        state->session.Close();
        log("release_capture: session closed");
    }
    if (state->framePool) {
        state->framePool.Close();
        log("release_capture: frame pool closed");
    }
    if (state->context) {
        state->context->Release();
        log("release_capture: context released");
    }
    if (state->device) {
        state->device->Release();
        log("release_capture: device released");
    }

    delete state;
    log("release_capture: done");
}

} // extern "C"