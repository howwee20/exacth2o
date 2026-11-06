import type { FormEvent } from "react";
import type { AuthMode } from "../portalTypes";
import exactH2OLogo from "../assets/exacth2o-logo.jpeg";
import { SoftwareTermsModal } from "./SoftwareTermsModal";
import { supportEmail } from "../softwareTerms";

type Props = {
  authMode: AuthMode;
  email: string;
  password: string;
  rememberDevice: boolean;
  termsOpen: boolean;
  termsAccepted: boolean;
  loading: boolean;
  authNotice: string | null;
  loginError: string | null;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  setRememberDevice: (value: boolean) => void;
  setTermsOpen: (value: boolean) => void;
  setTermsAccepted: (value: boolean) => void;
  switchAuthMode: (mode: AuthMode) => void;
  requestPasswordReset: (event: FormEvent<HTMLFormElement>) => void;
  setAccountPassword: (event?: FormEvent<HTMLFormElement>) => void;
  acceptInvite: (event?: FormEvent<HTMLFormElement>) => void;
  signIn: (event?: FormEvent<HTMLFormElement>) => void;
};

export function AuthScreen({ authMode, email, password, rememberDevice, termsOpen, termsAccepted, loading, authNotice, loginError, setEmail, setPassword, setRememberDevice, setTermsOpen, setTermsAccepted, switchAuthMode, requestPasswordReset, setAccountPassword, acceptInvite, signIn }: Props) {
    const isInviteAccept = authMode === "accept-invite";
    const isPasswordSetup = authMode === "set-password";
    const isRecovery = authMode === "recover";
    const showTermsAgreement = isInviteAccept;
    const termsRequired = isInviteAccept;
    const authTitle = isRecovery ? "Reset your password" : isPasswordSetup ? "Set Password" : isInviteAccept ? "Accept Invite" : "Sign in";
    const authNote = isRecovery ? "Enter your account email. We’ll send a secure reset link." : isPasswordSetup
      ? "Choose a password for this exactH2O account."
      : isInviteAccept
        ? "Use the invited email and choose a password."
        : null;
    const authSubmitText = isRecovery ? (loading ? "Sending…" : "Send reset link") : loading
      ? isPasswordSetup
        ? "Saving..."
        : isInviteAccept
          ? "Accepting..."
          : "Signing in..."
      : isPasswordSetup
        ? "Save Password"
        : isInviteAccept
          ? "Accept Invite"
          : "Sign in";

    return (
      <main className="portal-login-shell">
        <header className="portal-topbar">
          <a href="/" className="portal-logo" aria-label="ExactH2O website home">
            <img src={exactH2OLogo} alt="ExactH2O" />
          </a>
          <div className="portal-top-links">
            <a href="/support">Support</a>
          </div>
        </header>

        <section className="portal-login-panel" aria-label="Portal sign in">
          <div className="portal-login-card">
            <h2>{authTitle}</h2>
            {authNote ? <p className="portal-login-note">{authNote}</p> : null}

            <form onSubmit={isRecovery ? requestPasswordReset : isPasswordSetup ? setAccountPassword : isInviteAccept ? acceptInvite : signIn}>
              {!isPasswordSetup ? (
                <div className="portal-form-group">
                  <label htmlFor="portalEmail">Email</label>
                  <input
                    id="portalEmail"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="username"
                    required
                  />
                </div>
              ) : null}
              {!isRecovery ? <div className="portal-form-group">
                <label htmlFor="portalPassword">Password</label>
                <input
                  id="portalPassword"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={isInviteAccept || isPasswordSetup ? "new-password" : "current-password"}
                  required
                />
              </div> : null}
              <div className="portal-form-row">
                {!isPasswordSetup && !isRecovery ? (
                  <label className="portal-check">
                    <input
                      type="checkbox"
                      name="remember"
                      checked={rememberDevice}
                      onChange={(event) => setRememberDevice(event.target.checked)}
                    />
                    <span>Remember email</span>
                  </label>
                ) : (
                  <span />
                )}
                {isInviteAccept || isPasswordSetup || isRecovery ? (
                  <button
                    className="portal-inline-action"
                    type="button"
                    onClick={() => switchAuthMode("sign-in")}
                  >
                    Sign in
                  </button>
                ) : (
                  <button className="portal-inline-action" type="button" onClick={() => switchAuthMode("recover")}>Forgot password?</button>
                )}
              </div>
              {showTermsAgreement ? (
                <div className="portal-terms-prompt">
                  <label className="portal-check portal-terms-check">
                    <input
                      type="checkbox"
                      name="terms"
                      checked={termsAccepted}
                      onChange={(event) => {
                        if (event.target.checked) {
                          setTermsOpen(true);
                          return;
                        }
                        setTermsAccepted(false);
                      }}
                    />
                    <span>
                      I agree to the{" "}
                      <button
                        type="button"
                        className="portal-inline-action"
                        onClick={() => setTermsOpen(true)}
                      >
                        Software Access Terms
                      </button>
                      .
                    </span>
                  </label>
                  <p>
                    {termsRequired
                      ? "Required before accepting this invite."
                      : "Invite users will review and accept these terms before access."}
                  </p>
                </div>
              ) : null}
              <button
                className="portal-submit-btn"
                type="submit"
                disabled={loading || (!isPasswordSetup && !email) || (!isRecovery && !password) || (termsRequired && !termsAccepted)}
              >
                {authSubmitText}
              </button>
              {authNotice ? <p className="portal-success-line" role="status">{authNotice}</p> : null}
              {loginError ? <p className="portal-error-line" role="alert">{loginError}</p> : null}
            </form>

            <div className="portal-support-line">
              Need access? Ask for an invite or contact{" "}
              <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
            </div>
          </div>
        </section>
        <SoftwareTermsModal
          open={termsOpen}
          accepted={termsAccepted}
          onAgree={() => setTermsAccepted(true)}
          onClose={() => setTermsOpen(false)}
        />
      </main>
    );
}
