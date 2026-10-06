import type { Timestamp } from "firebase/firestore";

// Firestore layout (all private to the owner, see firestore.rules):
//   users/{uid}                          -> UserProfile
//   users/{uid}/documents/{docId}        -> UploadedDocument (file lives in Storage)
//   users/{uid}/applications/{appId}     -> Application
//   users/{uid}/applications/{appId}/letterVersions/{v} -> LetterVersion
//   private/{uid}                        -> server-only (Gmail tokens, usage). No client access.

export type DocumentKind = "cv" | "transcript" | "motivation_letter" | "diploma" | "other";

export type UploadedDocument = {
  kind: DocumentKind;
  fileName: string;
  storagePath: string;
  contentType: string;
  size: number;
  uploadedAt: Timestamp;
};

export type ApplicationType = "internship" | "job" | "alternance" | "masters";

export type ApplicationStatus =
  | "suggested" // created by BAPTOU, not reviewed yet
  | "interested" // the user said they're interested
  | "editing" // user is working on it
  | "approved" // letter/email approved by the user
  | "applied"
  | "rejected"
  | "dismissed";

export type Application = {
  type: ApplicationType;
  status: ApplicationStatus;
  organization: string; // company or university
  title: string; // job title or programme name
  country?: string;
  applyUrl?: string;
  deadline?: Timestamp;
  matchReason?: string; // why BAPTOU suggests it
  matchScore?: number; // 0-100
  location?: string;
  startDate?: string; // as stated in the posting (or the programme's intake)
  duration?: string;
  contractType?: string; // jobs and alternances
  salary?: string;
  rhythm?: string; // alternances
  school?: string; // alternances: partner school named in the posting
  searchId?: string; // the search that found it
  batchAt?: Timestamp; // when the search run that found it happened
  source?: "manual"; // added by the user from a link
  postingClosedAt?: Timestamp; // the posting's page is gone or says it's closed (checked daily)
  postingClosedReason?: string;
  lastReply?: { kind: "received" | "interview" | "rejection" | "offer" | "request" | "other"; at: Timestamp; messageId: string };
  dismissReason?: string; // why the user turned it down; future searches learn from it
  fitVerdict?: FitVerdict; // BAPTOU's latest answer to "is this for me?"
  fitVerdictReason?: string;
  applicationForm?: ApplicationForm; // the real form's layout, prepared by prepareApplication
  applicationFormStatus?: "preparing" | "ready" | "error"; // set by prepareApplication
  applicationFormError?: string;
  research?: string; // company/university research summary
  approachNote?: string; // why the letter takes this angle
  letter: string; // current editable motivation letter
  emailDraft?: { to: string; subject: string; body: string };
  emailApprovedAt?: Timestamp;
  emailSentAt?: Timestamp; // set by the server only
  packFields?: { label: string; value: string }[]; // ready-to-copy answers
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type LetterVersion = {
  text: string;
  author: "baptou" | "user";
  createdAt: Timestamp;
};

// Written by the `buildProfile` Cloud Function (see functions/src/profile.ts for the schema).
export type Profile = {
  fullName: string;
  headline: string;
  education: {
    degree: string; field: string; institution: string; country: string;
    startYear: string; endYear: string; grade: string; highlights: string[];
  }[];
  experience: { role: string; organization: string; country: string; period: string; achievements: string[] }[];
  skills: string[];
  languages: { language: string; level: string }[];
  interests: string[];
  strengths: string[];
  gaps: string[];
  writingStyle: string;
  suggestedTargets: { internshipRoles: string[]; mastersFields: string[] };
};

// users/{uid}/searches/{searchId}. Created by the user; the daily job only runs "active" ones.
export type SearchStatus = "active" | "paused" | "stopped" | "ended";

export type SearchKind = ApplicationType;

export type Search = {
  kind?: SearchKind; // missing = internship (searches created before master's searches)
  name: string;
  roles: string;
  locations: string;
  workMode: "any" | "onsite" | "hybrid" | "remote";
  duration: string;
  startDate: string;
  industries: string;
  languages: string;
  notes: string;
  tuitionBudget?: string; // master's searches
  contractType?: string; // jobs: permanent / fixed-term; alternances: apprentissage / professionnalisation
  salaryMin?: string; // jobs
  rhythm?: string; // alternances, e.g. "3 weeks company / 1 week school"
  school?: string; // alternances: the student's school, empty if they still need one
  maxPerRun: number;
  status: SearchStatus;
  endsAt: Timestamp | null; // null = until the user stops it
  runState?: "idle" | "queued" | "running" | "error";
  lastRunAt?: Timestamp;
  lastRunSummary?: string;
  lastBatchAt?: Timestamp; // the last run; its offers carry the same batchAt
  lastRunCreated?: number; // offers that run added
  lastRunCostUsd?: number;
  frequencyDays?: number; // 1, 3 or 7; missing = every day
  nextRunAt?: Timestamp | null; // the daily job skips the search until then (backs off after empty runs)
  lastError?: string;
  totalFound?: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type FitVerdict = "good_fit" | "uncertain" | "poor_fit";

// users/{uid}/applications/{appId}/chat/{messageId}, written by the askAboutOffer function.
export type ChatMessage = {
  role: "user" | "baptou";
  text: string;
  verdict?: FitVerdict;
  verdictReason?: string;
  followUpQuestions?: string[];
  createdAt: Timestamp;
};

// Mirrors FormSchema in functions/src/form.ts.
export type FormEntry = {
  title: string; organization: string; location: string; startDate: string; endDate: string; description: string;
};

export type FormField = {
  label: string;
  kind: "file" | "short_text" | "long_text" | "choice" | "yes_no" | "entries" | "checkbox";
  required: boolean;
  charLimit: number; // 0 = no limit
  options: string[];
  value: string;
  suggestedDocument: DocumentKind | "none";
  entries: FormEntry[];
  needsUser: boolean;
  note: string;
  isCoverLetter?: boolean; // missing on forms prepared before this flag existed
  worthPreparing?: boolean; // needs real work (documents, education, experience, written answers); missing on older forms
};

export type ApplicationForm = {
  platform: string;
  formUrl: string;
  seenOnForm: boolean;
  loginRequired?: boolean; // the careers site asks to sign in / verify an email before showing the form
  source?: "read" | "inferred" | "pasted"; // how BAPTOU got the fields
  notes: string;
  sections: { title: string; fields: FormField[] }[];
  preparedAt?: Timestamp;
};

// users/{uid}.gmail, written by the Gmail OAuth callback (the token itself is server-only).
export type GmailConnection = {
  email?: string;
  canRead?: boolean;
  canSend?: boolean;
  needsReconnect?: boolean;
  connectedAt?: Timestamp;
};

// users/{uid}/contacts/{id}: people from the mailbox who could help, written by findContacts.
export type Contact = {
  name: string;
  email: string;
  organization: string;
  role: string;
  relationship: "recruiter" | "manager" | "colleague" | "professor" | "alumni" | "classmate" | "friend" | "other";
  lastContactDate: string;
  history: string;
  whyContact: string;
  threadId: string;
  replyInThread: boolean;
  draft: { to: string; subject: string; body: string };
  draftEditedByUser?: boolean;
  status: "suggested" | "sent" | "dismissed";
  applicationIds?: string[];
  sentAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
