import { describe, expect, it, vi } from "vitest";

import {
  ViewerFramePicker,
  type ViewerAnimationFrameScheduler,
} from "../apps/viewer/src/viewer-frame-picker.js";

class FakeAnimationFrames implements ViewerAnimationFrameScheduler {
  private nextHandle = 1;
  public readonly callbacks = new Map<
    number,
    (timestamp: number) => void
  >();
  public readonly cancelled: number[] = [];

  public request(callback: (timestamp: number) => void): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  public cancel(handle: number): void {
    this.cancelled.push(handle);
    this.callbacks.delete(handle);
  }

  public frame(timestamp = 0): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(timestamp));
  }
}

describe("viewer frame picker", () => {
  it("coalesces pointer requests to the newest request in one frame", () => {
    const frames = new FakeAnimationFrames();
    const pick = vi.fn((value: number) => value * 2);
    const consume = vi.fn();
    const picker = new ViewerFramePicker(pick, consume, frames);

    picker.request(1);
    picker.request(2);
    picker.request(3);
    expect(frames.callbacks.size).toBe(1);
    expect(picker.hasPendingRequest).toBe(true);

    frames.frame(16);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick).toHaveBeenCalledWith(3);
    expect(consume).toHaveBeenCalledWith(6, 3);
    expect(picker.hasPendingRequest).toBe(false);

    picker.request(4);
    frames.frame(32);
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it("flushes immediately and invalidates a stale scheduled callback", () => {
    const frames = new FakeAnimationFrames();
    const results: number[] = [];
    const picker = new ViewerFramePicker(
      (value: number) => value,
      (result) => results.push(result),
      frames,
    );

    picker.request(7);
    const stale = [...frames.callbacks.values()][0]!;
    expect(picker.flush()).toBe(true);
    expect(results).toEqual([7]);
    expect(frames.cancelled).toEqual([1]);
    stale(16);
    expect(results).toEqual([7]);
    expect(picker.flush()).toBe(false);
  });

  it("cancels pending work idempotently", () => {
    const frames = new FakeAnimationFrames();
    const pick = vi.fn();
    const picker = new ViewerFramePicker(pick, vi.fn(), frames);

    picker.request("pointer");
    expect(picker.cancel()).toBe(true);
    expect(picker.cancel()).toBe(false);
    frames.frame();
    expect(pick).not.toHaveBeenCalled();
  });

  it("disposes idempotently and rejects new requests", () => {
    const frames = new FakeAnimationFrames();
    const pick = vi.fn();
    const picker = new ViewerFramePicker(pick, vi.fn(), frames);

    picker.request("pointer");
    picker.dispose();
    picker.dispose();
    frames.frame();
    expect(pick).not.toHaveBeenCalled();
    expect(picker.hasPendingRequest).toBe(false);
    expect(() => picker.request("late")).toThrow(/disposed/u);
    expect(picker.flush()).toBe(false);
    expect(picker.cancel()).toBe(false);
  });

  it("allows a consumer to schedule work for the following frame", () => {
    const frames = new FakeAnimationFrames();
    const results: number[] = [];
    let picker: ViewerFramePicker<number, number>;
    picker = new ViewerFramePicker(
      (value) => value,
      (result) => {
        results.push(result);
        if (result === 1) picker.request(2);
      },
      frames,
    );

    picker.request(1);
    frames.frame(16);
    expect(results).toEqual([1]);
    expect(frames.callbacks.size).toBe(1);
    frames.frame(32);
    expect(results).toEqual([1, 2]);
  });
});
