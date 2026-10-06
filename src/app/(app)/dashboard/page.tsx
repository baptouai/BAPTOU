"use client";

import { useAuth } from "@/lib/auth-context";
import { UsageMeter } from "@/components/UsageMeter";
import { RepliesPanel } from "@/components/Replies";
import { GettingStarted } from "@/components/GettingStarted";

export default function Dashboard() {
  const { user } = useAuth();
  return (
    <div>
      <h1 className="text-2xl font-semibold">Hi {user?.displayName?.split(" ")[0]} 👋</h1>
      <GettingStarted />
      <RepliesPanel />
      <div className="mt-6">
        <UsageMeter />
      </div>
    </div>
  );
}
