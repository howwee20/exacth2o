import { type FormEvent, useState } from "react";
import { demoAccountEmail, demoHandoffKey, rememberEmailKey } from "./portalConstants";
import { errorMessage, functionErrorMessage } from "./portalFormat";
import { stripAuthQuery } from "./portalRoute";
import type { AuthMode, InviteAcceptResponse } from "./portalTypes";
import { softwareTermsVersion } from "./softwareTerms";
// The offline demos replace this exact module specifier.
import { supabase } from "./supabase";

function inviteTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("invite") ?? params.get("token") ?? "";
}

function initialEmail() {
  const params = new URLSearchParams(window.location.search);
  return params.get("email") ?? "";
}

function initialAuthMode(): AuthMode {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const authType = params.get("type") ?? hashParams.get("type");

  if (inviteTokenFromUrl()) return "accept-invite";
  if (authType === "recovery") return "set-password";
  return "sign-in";
}


/** Login, invite acceptance and account recovery form state. */
export function usePortalAuth({ setLoading, clearError, resetPortalSessionUi, setSessionReady }: {
  setLoading: (loading: boolean) => void;
  clearError: () => void;
  resetPortalSessionUi: () => void;
  setSessionReady: (ready: boolean) => void;
}) {
  const [email, setEmail] = useState(() => initialEmail());
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>(() => initialAuthMode());
  const [inviteToken] = useState(() => inviteTokenFromUrl());
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(() => new URLSearchParams(window.location.hash.slice(1)).has("error") ? "This access link has expired or is invalid. Request a fresh password reset below." : null);

  async function signIn(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (
      email.trim().toLowerCase() === demoAccountEmail &&
      !window.location.pathname.startsWith("/demo")
    ) {
      window.sessionStorage.setItem(demoHandoffKey, JSON.stringify({ email: email.trim().toLowerCase(), password }));
      window.location.assign("/demo");
      return;
    }
    setLoading(true);
    clearError();
    setLoginError(null);
    setAuthNotice(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (signInError) {
      setLoginError(errorMessage(signInError));
      return;
    }
    if (rememberDevice) {
      window.localStorage.setItem(rememberEmailKey, email);
    } else {
      window.localStorage.removeItem(rememberEmailKey);
    }
    resetPortalSessionUi();
    setPassword("");
    setSessionReady(true);
  }

  async function acceptInvite(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setLoading(true);
    clearError();
    setLoginError(null);
    setAuthNotice(null);

    if (!inviteToken) {
      setLoading(false);
      setLoginError("Use a valid invite link to create an account.");
      return;
    }

    if (password.length < 8) {
      setLoading(false);
      setLoginError("Use at least 8 characters.");
      return;
    }

    if (!termsAccepted) {
      setLoading(false);
      setLoginError("Review and accept the Software Access Terms to continue.");
      return;
    }

    const { data: inviteData, error: inviteError } =
      await supabase.functions.invoke<InviteAcceptResponse>("accept-invite", {
        body: {
          token: inviteToken,
          email,
          password,
          termsAccepted: true,
          termsVersion: softwareTermsVersion,
        },
      });

    if (inviteError) {
      setLoading(false);
      setLoginError(await functionErrorMessage(inviteError));
      return;
    }

    const session = inviteData?.session;
    if (!session?.access_token || !session.refresh_token) {
      setLoading(false);
      setLoginError("Invite accepted, but sign-in did not complete.");
      return;
    }

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });

    setLoading(false);

    if (sessionError) {
      setLoginError(errorMessage(sessionError));
      return;
    }

    if (rememberDevice) {
      window.localStorage.setItem(rememberEmailKey, email);
    } else {
      window.localStorage.removeItem(rememberEmailKey);
    }

    stripAuthQuery();
    resetPortalSessionUi();
    setPassword("");
    setAuthMode("sign-in");
    setSessionReady(true);
  }

  async function requestPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setLoginError(null); setAuthNotice(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {redirectTo: `${window.location.origin}/portal?type=recovery`});
    setLoading(false);
    if (resetError) { setLoginError("The reset email could not be requested. Please try again or contact support."); return; }
    setAuthNotice("If an account exists for this email, a password reset link is on its way. Check your inbox and spam folder.");
  }

  async function setAccountPassword(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setLoading(true);
    clearError();
    setLoginError(null);
    setAuthNotice(null);

    if (password.length < 8) {
      setLoading(false);
      setLoginError("Use at least 8 characters.");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setLoginError(errorMessage(updateError));
      return;
    }

    stripAuthQuery();
    resetPortalSessionUi();
    setPassword("");
    setAuthMode("sign-in");
    setSessionReady(true);
  }

  function switchAuthMode(nextMode: AuthMode) {
    setAuthMode(nextMode);
    setLoginError(null);
    setAuthNotice(null);
    if (nextMode !== "set-password") stripAuthQuery();
  }

  return {
    authMode, email, password, rememberDevice, termsOpen, termsAccepted, authNotice, loginError,
    setEmail, setPassword, setRememberDevice, setTermsOpen, setTermsAccepted,
    setAuthMode, setAuthNotice, setLoginError,
    switchAuthMode, requestPasswordReset, setAccountPassword, acceptInvite, signIn,
  };
}
