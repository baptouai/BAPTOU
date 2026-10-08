"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getDownloadURL, ref } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

// users/{uid}.letterContact and .signaturePath, entered on the Profile page ("For your letters").
export type LetterContact = { address?: string; phone?: string; email?: string };

export type LetterSender = {
  name: string;
  lines: string[]; // address lines, phone, email: the sender block at the top of a letter
  signatureUrl?: string;
  missing: ("address" | "phone" | "signature")[];
};

/** The student's details for the top and bottom of their letters. */
export function useLetterSender(): LetterSender | null {
  const { user } = useAuth();
  const [data, setData] = useState<{ name: string; contact: LetterContact; signaturePath?: string } | null>(null);
  const [signatureUrl, setSignatureUrl] = useState<string>();

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) =>
      setData({
        name: (snap.get("profile.fullName") as string | undefined) || user.displayName || "",
        contact: (snap.get("letterContact") as LetterContact | undefined) ?? {},
        signaturePath: snap.get("signaturePath") as string | undefined,
      }),
    );
  }, [user]);

  const path = data?.signaturePath;
  useEffect(() => {
    if (!path) return;
    let live = true;
    getDownloadURL(ref(storage, path))
      .then((url) => live && setSignatureUrl(url))
      .catch(() => live && setSignatureUrl(undefined));
    return () => {
      live = false;
    };
  }, [path]);

  if (!data || !user) return null;
  const c = data.contact;
  const address = (c.address ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const email = c.email?.trim() || user.email || "";
  return {
    name: data.name,
    lines: [...address, c.phone?.trim() ?? "", email].filter(Boolean),
    signatureUrl: path ? signatureUrl : undefined,
    missing: [
      ...(address.length ? [] : (["address"] as const)),
      ...(c.phone?.trim() ? [] : (["phone"] as const)),
      ...(path ? [] : (["signature"] as const)),
    ],
  };
}
