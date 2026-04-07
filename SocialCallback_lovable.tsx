// ─────────────────────────────────────────────────────────────────────────────
// LOVABLE: Paste this as src/pages/SocialCallback.tsx
// This page receives the Meta OAuth redirect with ?code=... and ?state=...
// It calls Railway /meta-oauth-exchange to do the full token flow server-side.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

const RAILWAY_URL = "https://maroa-api-production.up.railway.app";
const REDIRECT_URI = "https://maroa-ai-marketing-automator.lovable.app/social-callback";

export default function SocialCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"processing" | "success" | "error">("processing");
  const [message, setMessage] = useState("Connecting your accounts...");

  useEffect(() => {
    handleOAuthCallback();
  }, []);

  async function handleOAuthCallback() {
    const code  = searchParams.get("code");
    const error = searchParams.get("error");
    const state = searchParams.get("state");   // we encode business_id here

    // ── Handle denial ────────────────────────────────────────────────────────
    if (error) {
      setStatus("error");
      setMessage(`Connection denied: ${searchParams.get("error_description") || error}`);
      setTimeout(() => navigate("/dashboard"), 3000);
      return;
    }

    if (!code) {
      setStatus("error");
      setMessage("No authorization code received.");
      setTimeout(() => navigate("/dashboard"), 3000);
      return;
    }

    try {
      // ── Get current user's business_id ───────────────────────────────────
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not logged in");

      const { data: biz } = await supabase
        .from("businesses")
        .select("id")
        .eq("user_id", user.id)
        .single();

      if (!biz?.id) throw new Error("Business not found for this user");

      const business_id = biz.id;
      setMessage("Exchanging tokens with Facebook...");

      // ── Call Railway to do the full exchange ─────────────────────────────
      const resp = await fetch(`${RAILWAY_URL}/meta-oauth-exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          business_id,
          redirect_uri: REDIRECT_URI,
        }),
      });

      const result = await resp.json();

      if (!resp.ok || !result.success) {
        throw new Error(result.error || "OAuth exchange failed");
      }

      setStatus("success");
      setMessage(result.message || "Facebook & Instagram connected!");

      // ── Redirect to dashboard after 2s ───────────────────────────────────
      setTimeout(() => navigate("/dashboard?connected=meta"), 2000);

    } catch (err: any) {
      console.error("[SocialCallback]", err);
      setStatus("error");
      setMessage(err.message || "Something went wrong connecting your account.");
      setTimeout(() => navigate("/dashboard"), 4000);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
      <div className="bg-white rounded-2xl shadow-lg p-10 max-w-md w-full text-center space-y-6">

        {status === "processing" && (
          <>
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <h2 className="text-xl font-semibold text-gray-800">Connecting...</h2>
            <p className="text-gray-500">{message}</p>
          </>
        )}

        {status === "success" && (
          <>
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-800">Connected!</h2>
            <p className="text-gray-500">{message}</p>
            <p className="text-sm text-gray-400">Redirecting to dashboard...</p>
          </>
        )}

        {status === "error" && (
          <>
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-800">Connection Failed</h2>
            <p className="text-gray-500">{message}</p>
            <p className="text-sm text-gray-400">Redirecting to dashboard...</p>
          </>
        )}

      </div>
    </div>
  );
}
