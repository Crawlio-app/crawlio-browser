// Device profiles for viewport & device emulation

export interface DeviceProfile {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
}

// Profiles sourced from Chrome DevTools device catalog + standard desktop resolutions
export const DEVICE_PROFILES: Record<string, DeviceProfile> = {
  "iPhone 14": {
    name: "iPhone 14",
    width: 390,
    height: 664,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  },
  "iPhone 14 Pro Max": {
    name: "iPhone 14 Pro Max",
    width: 430,
    height: 740,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  },
  "iPhone SE": {
    name: "iPhone SE",
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/26.0 Mobile/19E241 Safari/602.1",
  },
  "iPad Pro 11": {
    name: "iPad Pro 11",
    width: 834,
    height: 1194,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  },
  "iPad Mini": {
    name: "iPad Mini",
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  },
  "Pixel 7": {
    name: "Pixel 7",
    width: 412,
    height: 839,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Mobile Safari/537.36",
  },
  "Galaxy S24": {
    name: "Galaxy S24",
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Mobile Safari/537.36",
  },
  "Desktop 1920x1080": {
    name: "Desktop 1920x1080",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
    userAgent: "",
  },
  "Desktop 1440x900": {
    name: "Desktop 1440x900",
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
    userAgent: "",
  },
  "Desktop 1366x768": {
    name: "Desktop 1366x768",
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
    userAgent: "",
  },
};
