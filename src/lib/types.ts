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

export type ApplicationType = "internship" | "masters";

export type ApplicationStatus =
  | "suggested" // created by BAPTOU, not reviewed yet
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
