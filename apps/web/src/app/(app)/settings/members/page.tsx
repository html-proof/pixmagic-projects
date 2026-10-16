"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Members & roles moved to Team & Access (/team); old links and bookmarks land there. */
export default function MembersMoved() {
  const router = useRouter();
  useEffect(() => router.replace("/team"), [router]);
  return null;
}
