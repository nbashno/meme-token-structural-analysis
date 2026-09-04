import { describe, it, expect } from "vitest";
import { detectCapability, detectFromWindow } from "../../src/experience/capability.js";

describe("experience capability — real detection, no premature claims", () => {
  it("chooses webgpu only when navigator.gpu is actually present", () => {
    const cap = detectCapability({ hasNavigatorGpu: true, canGetWebgl2: () => true, devicePixelRatio: 2 });
    expect(cap.backend).toBe("webgpu");
    expect(cap.webgpuDetected).toBe(true);
  });

  it("never claims webgpu without navigator.gpu — falls back to webgl2", () => {
    const cap = detectCapability({ hasNavigatorGpu: false, canGetWebgl2: () => true, devicePixelRatio: 1 });
    expect(cap.backend).toBe("webgl2");
    expect(cap.webgpuDetected).toBe(false);
    expect(cap.webgl2Detected).toBe(true);
  });

  it("reports unavailable when neither backend exists (headless)", () => {
    const cap = detectCapability({ hasNavigatorGpu: false, canGetWebgl2: () => false, devicePixelRatio: 1 });
    expect(cap.backend).toBe("unavailable");
    expect(cap.webgpuDetected).toBe(false);
    expect(cap.webgl2Detected).toBe(false);
  });

  it("caps devicePixelRatio at 2 and floors invalid values to 1", () => {
    expect(detectCapability({ hasNavigatorGpu: false, canGetWebgl2: () => false, devicePixelRatio: 5 }).devicePixelRatio).toBe(2);
    expect(detectCapability({ hasNavigatorGpu: false, canGetWebgl2: () => false, devicePixelRatio: 0 }).devicePixelRatio).toBe(1);
    expect(detectCapability({ hasNavigatorGpu: false, canGetWebgl2: () => false, devicePixelRatio: NaN }).devicePixelRatio).toBe(1);
  });

  it("detectFromWindow is safe in Node (no globals) → unavailable, no throw", () => {
    const cap = detectFromWindow();
    expect(cap.backend).toBe("unavailable");
  });
});
