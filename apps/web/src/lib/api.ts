"use client";
// Compatibility facade. New code can import transport, hooks, or formatting directly.
export { api, ApiError, isSignedOut, isTransient, friendlyError, actionError } from "./apiClient";
export { useApi, useLiveApi, keepRetrying } from "@/hooks/useApi";
export { fmtMoney, fmtPct, fmtNum } from "./format";
