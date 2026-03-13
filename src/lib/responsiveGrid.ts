export const MIN_ITEM_WIDTH = 180;

export function calculateColumnCount(containerWidth: number, minItemWidth = MIN_ITEM_WIDTH): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor(containerWidth / minItemWidth));
}

export function calculateRowCount(itemCount: number, columnCount: number): number {
  if (itemCount <= 0 || columnCount <= 0) {
    return 0;
  }
  return Math.ceil(itemCount / columnCount);
}

export function calculateEmptySlotsInRow(rowItemCount: number, columnCount: number): number {
  if (columnCount <= 0 || rowItemCount >= columnCount) {
    return 0;
  }
  return columnCount - rowItemCount;
}
