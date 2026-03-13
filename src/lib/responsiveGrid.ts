export const MIN_ITEM_WIDTH = 180;
export const THUMBNAIL_SIZE = 180;
export const CARD_LABEL_HEIGHT = 48;
export const CARD_BUTTON_HEIGHT = 40;
export const CARD_GAP = 12;
export const ITEM_HEIGHT = THUMBNAIL_SIZE + CARD_LABEL_HEIGHT + CARD_BUTTON_HEIGHT + CARD_GAP;

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
