"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Master's searches moved into Applications (choose "A master's programme" when creating a search).
export default function UniversitiesRedirect() {
  const router = useRouter();
  useEffect(() => router.replace("/applications"), [router]);
  return null;
}
