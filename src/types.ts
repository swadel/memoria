export type ProcessingStatus =
  | "queued"
  | "downloading"
  | "downloaded"
  | "metadata_extracted"
  | "classified"
  | "date_verified"
  | "grouped"
  | "filed"
  | "error";

export interface DashboardStats {
  total: number;
  downloading: number;
  review: number;
  legitimate: number;
  dateNeedsReview: number;
  grouped: number;
  filed: number;
  errors: number;
}

export interface MediaItem {
  id: number;
  filename: string;
  currentPath: string;
  classification: "legitimate" | "review" | "deleted" | null;
  reviewReason: string | null;
  reviewReasonDetails: string | null;
  duplicateClusterId: string | null;
  status: ProcessingStatus;
  dateTaken: string | null;
  dateNeedsReview: boolean;
  aiConfidence: number | null;
  eventGroupId: number | null;
}

export interface EventGroup {
  id: number;
  year: number;
  name: string;
  folderName: string;
  itemCount: number;
  userApproved: boolean;
}

export interface DateEstimate {
  mediaItemId: number;
  filename: string;
  currentDate: string | null;
  aiDate: string | null;
  confidence: number;
  reasoning: string;
}
