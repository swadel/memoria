export type ProcessingStatus =
  | "queued"
  | "indexed"
  | "image_reviewed"
  | "video_reviewed"
  | "date_verified"
  | "excluded"
  | "grouped"
  | "filed";

export interface DashboardStats {
  total: number;
  indexed: number;
  imageReview: number;
  imageVerified: number;
  dateReview: number;
  dateNeedsReview: number;
  dateVerified: number;
  grouped: number;
  filed: number;
  imageFlaggedPending: number;
  imagePhaseState: "pending" | "in_progress" | "complete";
  videoTotal: number;
  videoFlagged: number;
  videoExcluded: number;
  videoUnreviewedFlagged: number;
  videoPhaseState: "pending" | "in_progress" | "complete";
}

export interface EventGroup {
  id: number;
  year: number;
  name: string;
  folderName: string;
  itemCount: number;
  userApproved: boolean;
}

export interface EventGroupItem {
  id: number;
  filename: string;
  currentPath: string;
  dateTaken: string | null;
  mimeType: string;
}

export interface VideoReviewItem {
  id: number;
  filename: string;
  currentPath: string;
  dateTaken: string | null;
  mimeType: string;
  fileSizeBytes: number;
  durationSecs: number;
  videoWidth: number | null;
  videoHeight: number | null;
  videoCodec: string | null;
  status: "image_reviewed" | "excluded" | string;
}

export type ImageFlagReason =
  | "small_file"
  | "blurry"
  | "poor_exposure"
  | "burst_shot"
  | "duplicate"
  | "screenshot_or_meme";

export interface ImageReviewItem {
  id: number;
  filename: string;
  currentPath: string;
  dateTaken: string | null;
  mimeType: string;
  fileSizeBytes: number;
  sharpnessScore: number | null;
  blurScore: number | null;
  perceptualHash: string | null;
  burstGroupId: string | null;
  isBurstPrimary: boolean;
  duplicateGroupId: string | null;
  exposureMean: number | null;
  aiQualityScore: number | null;
  aiContentClass: string | null;
  imageFlags: ImageFlagReason[];
  status: "indexed" | "image_reviewed" | "excluded" | string;
}

export interface ImageReviewSettings {
  blurThreshold: number;
  blurBorderlinePct: number;
  exposureDarkPct: number;
  exposureBrightPct: number;
  burstTimeWindowSecs: number;
  burstHashDistance: number;
  duplicateHashDistance: number;
  smallFileMinBytes: number;
  screenshotHeuristicThreshold: number;
}

export interface DateEstimate {
  mediaItemId: number;
  filename: string;
  currentDate: string | null;
  aiDate: string | null;
  confidence: number;
  reasoning: string;
}
