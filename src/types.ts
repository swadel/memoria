export type ProcessingStatus =
  | "queued"
  | "downloading"
  | "downloaded"
  | "metadata_extracted"
  | "date_review_pending"
  | "date_verified"
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
