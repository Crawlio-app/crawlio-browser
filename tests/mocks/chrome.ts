// Mock chrome.* APIs for unit testing
export const mockChrome = {
  debugger: {
    sendCommand: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
    onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      getBytesInUse: vi.fn().mockResolvedValue(0),
      QUOTA_BYTES: 10 * 1024 * 1024,
    },
  },
  tabs: {
    get: vi.fn(),
    query: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
    onRemoved: { addListener: vi.fn() },
    onReplaced: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onActivated: { addListener: vi.fn() },
  },
  runtime: {
    sendMessage: vi.fn(),
    connect: vi.fn(),
    onConnect: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
    lastError: null,
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
    setIcon: vi.fn().mockResolvedValue(undefined),
  },
};
