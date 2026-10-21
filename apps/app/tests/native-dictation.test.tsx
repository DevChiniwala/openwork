import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { dictationPlatform, useNativeDictation } = await import("../../../packages/ui/src/react/native-dictation");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

test("system dictation uses the matching platform and keeps iPad desktop mode on its keyboard", () => {
  expect(dictationPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
  expect(dictationPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
  expect(dictationPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("unsupported");
  expect(dictationPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("mobile");
  expect(dictationPlatform("Mozilla/5.0 (Linux; Android 15)")).toBe("mobile");
});

test("revoking dictation during a native handoff cannot reopen help or change the draft", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let controller: ReturnType<typeof useNativeDictation> | undefined;
  let complete: ((result: { ok: false; reason: "failed" }) => void) | undefined;
  let launches = 0;
  let signal: AbortSignal | undefined;
  let focused = 0;
  const agent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
  function Harness({ enabled, text = "Existing draft" }: { enabled: boolean; text?: string }) {
    controller = useNativeDictation({ enabled, text, focusInput: () => focused++, startNative: input => {
      signal = input;
      launches++;
      return new Promise(resolve => { complete = resolve });
    } });
    return <output>{text}</output>;
  }
  try {
    await act(async () => { root.render(<Harness enabled />) });
    let handoff: Promise<void> | undefined;
    await act(async () => { handoff = controller?.start(); void controller?.start() });
    expect(launches).toBe(1);
    expect(focused).toBe(1);
    expect(controller?.reviewRequired).toBe(true);
    await act(async () => { root.render(<Harness enabled={false} />) });
    expect(signal?.aborted).toBe(true);
    await act(async () => { complete?.({ ok: false, reason: "failed" }); await handoff });
    expect(controller?.helpOpen).toBe(false);
    expect(controller?.reviewRequired).toBe(false);
    expect(controller?.starting).toBe(false);
    expect(container.textContent).toBe("Existing draft");
    await act(async () => { await controller?.start() });
    expect(launches).toBe(1);
  } finally {
    await act(async () => { root.unmount() });
    container.remove();
    if (agent) Object.defineProperty(window.navigator, "userAgent", agent);
    else Reflect.deleteProperty(window.navigator, "userAgent");
  }
});
