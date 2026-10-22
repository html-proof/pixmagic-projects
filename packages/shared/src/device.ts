// Which device and browser a session was signed in from, in words, for Settings → Security (the
// device list and the sign-in activity). Read from the browser's User-Agent and, where Chromium
// sends them, its client hints (Sec-CH-UA-Platform-Version and Sec-CH-UA-Model, which the
// Accept-CH header in apps/web/public/_headers asks for). A description for people to recognise
// their devices by, never something to decide on: every part of it is whatever the browser says.
//
// Imported by the UI through `@app/shared/device`: relative imports stay extensionless.

/** What the API keeps of the browser a session was signed in from (user_sessions.device, auth_events.metadata.device). */
export interface DeviceInfo {
  ua?: string;
  /** Sec-CH-UA-Platform, e.g. "Windows". */
  platform?: string;
  /** Sec-CH-UA-Platform-Version, e.g. "15.0.0" (Windows 11). */
  platformVersion?: string;
  /** Sec-CH-UA-Model, e.g. "SM-S911B" (phones and tablets only). */
  model?: string;
}

/** Which picture the device gets. */
export type DeviceKind = "phone" | "tablet" | "laptop" | "desktop" | "unknown";

export interface DeviceDescription {
  kind: DeviceKind;
  /** "Windows PC", "iPhone", "Samsung SM-S911B", "Mac". */
  name: string;
  /** "Chrome 155.0.0.0"; null when the browser can't be told. */
  browser: string | null;
  /** "Windows 11", "iOS 17.2", "macOS 14.6"; null when unknown. */
  os: string | null;
}

/** The longest User-Agent kept: real ones are a few hundred characters. */
export const DEVICE_UA_MAX = 512;

/** A client hint's value: a quoted string ("\"Windows\"") or, from older browsers, a bare one. */
export function clientHint(value: string | null | undefined, max = 64): string | undefined {
  const v = value?.trim().replace(/^"(.*)"$/, "$1").trim();
  return v ? v.slice(0, max) : undefined;
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  // Before Chrome: these say "Chrome/" too.
  [/\bEdg(?:A|iOS)?\/([\d.]+)/, "Edge"],
  [/\bOPR\/([\d.]+)/, "Opera"],
  [/\bSamsungBrowser\/([\d.]+)/, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\/([\d.]+)/, "Firefox"],
  [/\bCriOS\/([\d.]+)/, "Chrome"],
  [/(?:\b|Headless)Chrome\/([\d.]+)/, "Chrome"],
  [/\bVersion\/([\d.]+)(?: Mobile\/\w+)? Safari\//, "Safari"],
];

function browserOf(ua: string): string | null {
  for (const [re, name] of BROWSERS) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return /AppleWebKit/.test(ua) && /Safari\//.test(ua) ? "Safari" : null;
}

/** "14.6.0" → "14.6", "15.0.0" → "15". */
const shortVersion = (v: string) => v.split(".").slice(0, 2).join(".").replace(/\.0$/, "");

/** Windows reports 1-10 for Windows 10 and 13 or more for Windows 11 (Microsoft's guidance for Sec-CH-UA-Platform-Version). */
function windowsName(platformVersion: string | undefined) {
  const major = Number(platformVersion?.split(".")[0]);
  if (!platformVersion || !Number.isFinite(major) || major < 1) return "Windows";
  return major >= 13 ? "Windows 11" : "Windows 10";
}

/** "SM-S911B" says Samsung only to those who know it. */
const modelName = (model: string) => (/^SM-/i.test(model) ? `Samsung ${model}` : model);

/** The phone or tablet model an Android User-Agent still names ("K" since Chrome reduced it). */
function androidModel(ua: string): string | undefined {
  const m = /Android [\d.]+;(?: [a-z]{2}[-_][a-z]{2};)? ([^;)]+?)(?: Build\/[^;)]*)?\)/i.exec(ua);
  const model = m?.[1]?.trim();
  return model && model !== "K" && !/^(?:Mobile|Tablet|wv)$/i.test(model) ? model : undefined;
}

export function describeDevice(info: DeviceInfo | null | undefined): DeviceDescription {
  const ua = info?.ua ?? "";
  const platform = info?.platform?.toLowerCase();
  const browser = ua ? browserOf(ua) : null;

  if (/\biPhone\b|\biPod\b/.test(ua)) {
    const v = /\bOS (\d+)_(\d+)/.exec(ua);
    return { kind: "phone", name: /\biPod\b/.test(ua) ? "iPod" : "iPhone", browser, os: v ? `iOS ${v[1]}.${v[2]}` : "iOS" };
  }
  if (/\biPad\b/.test(ua)) {
    const v = /\bOS (\d+)_(\d+)/.exec(ua);
    return { kind: "tablet", name: "iPad", browser, os: v ? `iPadOS ${v[1]}.${v[2]}` : "iPadOS" };
  }
  if (/\bAndroid\b/.test(ua) || platform === "android") {
    const v = /\bAndroid (\d+(?:\.\d+)?)/.exec(ua);
    const phone = /\bMobile\b/.test(ua) || (!ua && platform === "android");
    const model = info?.model || androidModel(ua);
    return { kind: phone ? "phone" : "tablet", name: model ? modelName(model) : phone ? "Android phone" : "Android tablet", browser, os: v ? `Android ${v[1]}` : "Android" };
  }
  if (/\bWindows (?:NT|Phone)\b/.test(ua) || platform === "windows") {
    return { kind: "laptop", name: "Windows PC", browser, os: windowsName(info?.platformVersion) };
  }
  if (/\bCrOS\b/.test(ua) || platform === "chrome os" || platform === "chromeos") {
    return { kind: "laptop", name: "Chromebook", browser, os: "ChromeOS" };
  }
  if (/\bMacintosh\b|\bMac OS X\b/.test(ua) || platform === "macos") {
    // Safari and Chrome both freeze the version in the User-Agent at 10.15.7: only the hint is real.
    return { kind: "desktop", name: "Mac", browser, os: info?.platformVersion ? `macOS ${shortVersion(info.platformVersion)}` : "macOS" };
  }
  if (/\bLinux\b|\bX11\b/.test(ua) || platform === "linux") {
    return { kind: "desktop", name: "Linux PC", browser, os: "Linux" };
  }
  return { kind: "unknown", name: browser ? "Web browser" : "Unknown device", browser, os: null };
}

/** auth_events types of the sign-in activity Settings → Security lists (kept for SIGN_IN_ACTIVITY_DAYS). */
export const SIGN_IN_EVENT = "signed_in";
export const SIGN_IN_FAILED_EVENT = "sign_in_failed";
export const SIGN_IN_ACTIVITY_DAYS = 90;
