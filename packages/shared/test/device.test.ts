import { describe, expect, it } from "vitest";
import { clientHint, describeDevice } from "../src/device.js";

const UA = {
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.3000.12",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  safariIpad: "Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  chromeAndroidReduced: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
  samsungAndroid: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
};

describe("describeDevice", () => {
  it("names the device, the browser with its version, and the system", () => {
    expect(describeDevice({ ua: UA.chromeWindows })).toEqual({ kind: "laptop", name: "Windows PC", browser: "Chrome 155.0.0.0", os: "Windows" });
    expect(describeDevice({ ua: UA.edgeWindows }).browser).toBe("Edge 154.0.3000.12");
    expect(describeDevice({ ua: UA.safariIphone })).toEqual({ kind: "phone", name: "iPhone", browser: "Safari 17.2", os: "iOS 17.2" });
    expect(describeDevice({ ua: UA.chromeIphone }).browser).toBe("Chrome 120.0.6099.119");
    expect(describeDevice({ ua: UA.chromeWindows.replace("Chrome/", "HeadlessChrome/") }).browser).toBe("Chrome 155.0.0.0");
    expect(describeDevice({ ua: UA.safariIpad })).toEqual({ kind: "tablet", name: "iPad", browser: "Safari 17.1", os: "iPadOS 17.1" });
    expect(describeDevice({ ua: UA.samsungAndroid })).toEqual({ kind: "phone", name: "Samsung SM-S911B", browser: "Samsung Internet 25.0", os: "Android 14" });
    expect(describeDevice({ ua: UA.chromeMac })).toEqual({ kind: "desktop", name: "Mac", browser: "Chrome 154.0.0.0", os: "macOS" });
    expect(describeDevice({ ua: UA.safariMac }).browser).toBe("Safari 18.1");
    expect(describeDevice({ ua: UA.firefoxLinux })).toEqual({ kind: "desktop", name: "Linux PC", browser: "Firefox 131.0", os: "Linux" });
    expect(describeDevice({ ua: UA.chromebook })).toMatchObject({ kind: "laptop", name: "Chromebook", os: "ChromeOS" });
  });

  it("uses the client hints where the User-Agent was reduced", () => {
    expect(describeDevice({ ua: UA.chromeWindows, platform: "Windows", platformVersion: "15.0.0" }).os).toBe("Windows 11");
    expect(describeDevice({ ua: UA.chromeWindows, platform: "Windows", platformVersion: "10.0.0" }).os).toBe("Windows 10");
    expect(describeDevice({ ua: UA.chromeMac, platform: "macOS", platformVersion: "14.6.0" }).os).toBe("macOS 14.6");
    expect(describeDevice({ ua: UA.chromeMac, platform: "macOS", platformVersion: "15.0.0" }).os).toBe("macOS 15");
    expect(describeDevice({ ua: UA.chromeAndroidReduced })).toMatchObject({ kind: "phone", name: "Android phone", os: "Android 10" });
    expect(describeDevice({ ua: UA.chromeAndroidReduced, model: "Pixel 8" }).name).toBe("Pixel 8");
    expect(describeDevice({ ua: UA.androidTablet })).toMatchObject({ kind: "tablet", name: "Android tablet" });
  });

  it("says so when it can't tell", () => {
    expect(describeDevice(null)).toEqual({ kind: "unknown", name: "Unknown device", browser: null, os: null });
    expect(describeDevice({ ua: "curl/8.4.0" })).toEqual({ kind: "unknown", name: "Unknown device", browser: null, os: null });
  });
});

describe("clientHint", () => {
  it("reads a quoted or bare value, and nothing from an empty one", () => {
    expect(clientHint('"Windows"')).toBe("Windows");
    expect(clientHint("15.0.0")).toBe("15.0.0");
    expect(clientHint('""')).toBeUndefined();
    expect(clientHint(undefined)).toBeUndefined();
    expect(clientHint(`"${"x".repeat(100)}"`)).toHaveLength(64);
  });
});
