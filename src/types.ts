export type ProcessingStatus =
  | "queued"
  | "downloading"
  | "downloaded"
  | "metadata_extracted"
  | "date_review_pending"
  | "date_verified"
  | "excluded"
  | "grouped"
  | "filed"
  | "error";

export interface DashboardStats {
  total: number;
  downloading: number;
  indexed: number;
  dateNeedsReview: number;
  dateVerified: number;
  grouped: number;
  filed: number;
  errors: number;
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
  status: "date_verified" | "excluded" | string;
}

export interface DateEstimate {
  mediaItemId: number;
  filename: string;
  currentDate: string | null;
  aiDate: string | null;
  confidence: number;
  reasoning: string;
}
