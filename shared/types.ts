export interface Misconception {
  id: string;
  text: string;
  section: string;
  subsection?: string;
  category: string;
  source: string;
  order: number;
  active: boolean;
  reviewed: boolean;
}

export type DailyMisconceptionStatus = "draft" | "published" | "sent";

export interface DailyMisconception {
  date: string;
  misconceptionId: string;
  order: number;
  status: DailyMisconceptionStatus;
}

