import { describe, expect, it } from "vitest";
import {
  MIN_ITEM_WIDTH,
  calculateColumnCount,
  calculateEmptySlotsInRow,
  calculateRowCount
} from "./responsiveGrid";

describe("responsiveGrid helpers", () => {
  it("calculates column counts for required breakpoints", () => {
    expect(MIN_ITEM_WIDTH).toBe(180);
    expect(calculateColumnCount(800)).toBe(4);
    expect(calculateColumnCount(1280)).toBe(7);
    expect(calculateColumnCount(1440)).toBe(8);
    expect(calculateColumnCount(1920)).toBe(10);
  });

  it("recalculates row count as columns change", () => {
    const itemCount = 21;
    expect(calculateRowCount(itemCount, 4)).toBe(6);
    expect(calculateRowCount(itemCount, 7)).toBe(3);
    expect(calculateRowCount(itemCount, 8)).toBe(3);
    expect(calculateRowCount(itemCount, 10)).toBe(3);
  });

  it("reports empty slots for final row padding", () => {
    expect(calculateEmptySlotsInRow(2, 4)).toBe(2);
    expect(calculateEmptySlotsInRow(7, 7)).toBe(0);
    expect(calculateEmptySlotsInRow(1, 10)).toBe(9);
  });
});
